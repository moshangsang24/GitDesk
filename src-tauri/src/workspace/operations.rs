use super::WorkspaceState;
use crate::{
    git::{
        executor::Git,
        operations::{self, Action, Confirmation, FetchRecord, Head, Plan},
        proxy::RepositoryProxy,
        repository,
    },
    model::{Failure, Result},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::State;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct Operations(Mutex<Registry>);

#[derive(Default)]
struct Registry {
    previews: HashMap<String, Preview>,
    active: HashMap<String, Active>,
}

struct Active {
    id: String,
    fetch: bool,
    token: CancellationToken,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationInput {
    id: String,
    repo_id: String,
    worktree_id: String,
    head: Head,
    action: Action,
}

struct Preview {
    expires: Instant,
    input: OperationInput,
    common: PathBuf,
    plan: Plan,
}

struct Running<'a> {
    operations: &'a Operations,
    repo_id: String,
    token: CancellationToken,
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.operations
            .0
            .lock()
            .unwrap()
            .active
            .remove(&self.repo_id);
    }
}

fn busy() -> Failure {
    Failure::new(
        "BUSY",
        "Another Git operation is running. Wait for it to finish and review the target again.",
    )
}

impl Operations {
    fn save(&self, preview: Preview) -> Result<()> {
        let mut registry = self.0.lock().unwrap();
        registry
            .previews
            .retain(|_, record| record.expires > Instant::now());
        if registry.active.contains_key(&preview.input.repo_id)
            || registry.previews.contains_key(&preview.input.id)
            || registry.previews.len() >= 32
        {
            return Err(busy());
        }
        registry.previews.insert(preview.input.id.clone(), preview);
        Ok(())
    }

    fn start(&self, id: &str) -> Result<(Preview, Running<'_>)> {
        let mut registry = self.0.lock().unwrap();
        let preview = registry
            .previews
            .remove(id)
            .filter(|record| record.expires > Instant::now())
            .ok_or_else(operations::stale)?;
        let repo_id = preview.input.repo_id.clone();
        if registry.active.contains_key(&repo_id) || registry.active.len() >= 4 {
            return Err(busy());
        }
        let token = CancellationToken::new();
        registry.active.insert(
            repo_id.clone(),
            Active {
                id: id.to_owned(),
                fetch: matches!(preview.input.action, Action::Fetch { .. }),
                token: token.clone(),
            },
        );
        Ok((
            preview,
            Running {
                operations: self,
                repo_id,
                token,
            },
        ))
    }

    fn cancel_fetch(&self, id: &str) {
        let mut registry = self.0.lock().unwrap();
        // Also revoke a pending confirmation when the dialog closes.
        registry.previews.remove(id);
        if let Some(active) = registry
            .active
            .values()
            .find(|item| item.fetch && item.id == id)
        {
            active.token.cancel();
        }
    }
}

async fn location(
    state: &WorkspaceState,
    git: &Git,
    repo_id: &str,
    worktree_id: &str,
    cancel: &CancellationToken,
) -> Result<(PathBuf, PathBuf, bool)> {
    let (locations, _) = state.locations(repo_id)?;
    for location in locations {
        match repository::resolve_worktree(git, &location, worktree_id, cancel).await {
            Ok((path, bare)) => return Ok((path, location.common_dir, bare)),
            Err(error) if error.code == "CANCELLED" => return Err(error),
            Err(_) => {}
        }
    }
    Err(Failure::new(
        "STALE",
        "This worktree is unavailable. Rescan its workspace and try again.",
    ))
}

#[tauri::command]
pub fn get_repository_proxy(
    state: State<'_, WorkspaceState>,
    repo_id: String,
) -> Result<RepositoryProxy> {
    state.locations(&repo_id)?;
    proxy_for(&state, &repo_id).normalize()
}

fn proxy_for(state: &WorkspaceState, repo_id: &str) -> RepositoryProxy {
    state
        .configuration
        .lock()
        .unwrap()
        .value
        .repository_proxies
        .get(repo_id)
        .cloned()
        .unwrap_or_default()
}

#[tauri::command]
pub fn save_repository_proxy(
    state: State<'_, WorkspaceState>,
    repo_id: String,
    proxy: RepositoryProxy,
) -> Result<RepositoryProxy> {
    let proxy = proxy.normalize()?;
    let mut store = state.configuration.lock().unwrap();
    store.update(|config| {
        if !config
            .workspaces
            .iter()
            .flat_map(|workspace| workspace.locations())
            .any(|location| location.id() == repo_id)
        {
            return Err(Failure::invalid("This repository is no longer registered."));
        }
        if proxy == RepositoryProxy::Git {
            config.repository_proxies.remove(&repo_id);
        } else {
            config.schema_version = 3;
            config.repository_proxies.insert(repo_id, proxy.clone());
        }
        Ok(())
    })?;
    Ok(proxy)
}

#[tauri::command]
pub async fn list_operation_remotes(
    state: State<'_, WorkspaceState>,
    repo_id: String,
    worktree_id: String,
) -> Result<Vec<String>> {
    let cancel = CancellationToken::new();
    let git = state.git(&cancel).await?;
    let (path, _, _) = location(&state, git, &repo_id, &worktree_id, &cancel).await?;
    operations::remotes(git, &path, &cancel).await
}

#[tauri::command]
pub async fn prepare_git_operation(
    state: State<'_, WorkspaceState>,
    input: OperationInput,
) -> Result<Confirmation> {
    if input.id.len() != 36
        || !input
            .id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        return Err(Failure::invalid("Invalid operation ID."));
    }
    let cancel = CancellationToken::new();
    let git = state.git(&cancel).await?;
    let (path, common, bare) =
        location(&state, git, &input.repo_id, &input.worktree_id, &cancel).await?;
    let plan = operations::prepare(
        git,
        path,
        &common,
        bare,
        &input.action,
        &input.head,
        &cancel,
    )
    .await?
    .with_proxy(proxy_for(&state, &input.repo_id))?;
    let confirmation = plan.confirmation();
    state.operations.save(Preview {
        expires: Instant::now() + Duration::from_secs(120),
        input,
        common,
        plan,
    })?;
    Ok(confirmation)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    error: Option<Failure>,
    warning: Option<String>,
    completed_at: u64,
}

#[tauri::command]
pub async fn execute_git_operation(
    state: State<'_, WorkspaceState>,
    id: String,
) -> Result<Outcome> {
    let (preview, running) = state.operations.start(&id)?;
    let cancel = &running.token;
    let input = &preview.input;
    let git = state.git(cancel).await?;
    let (path, common, bare) =
        location(&state, git, &input.repo_id, &input.worktree_id, cancel).await?;
    let plan = operations::prepare(git, path, &common, bare, &input.action, &input.head, cancel)
        .await?
        .with_proxy(proxy_for(&state, &input.repo_id))?;
    if common != preview.common || plan != preview.plan {
        return Err(operations::stale());
    }
    let result = operations::execute(git, &common, &plan, cancel).await;
    let completed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let mut warning = None;
    if matches!(input.action, Action::Fetch { .. }) {
        if let Some((remote, specs)) = plan.fetch_scope() {
            let mut store = state.configuration.lock().unwrap();
            let saved = store.update(|config| {
                let remotes = config
                    .fetch_activity
                    .entry(input.repo_id.clone())
                    .or_default();
                let record = remotes.entry(remote.to_owned()).or_default();
                match &result {
                    Ok(()) => {
                        *record = FetchRecord {
                            fetched_at: Some(completed_at),
                            specs: specs.to_vec(),
                            failure: None,
                        };
                    }
                    Err(failure) => record.failure = Some(failure.message.clone()),
                }
                Ok(())
            });
            if saved.is_err() {
                warning = Some("GitDesk could not save the Fetch record.".into());
            }
        }
    }
    Ok(Outcome {
        error: result.err(),
        warning,
        completed_at,
    })
}

#[tauri::command]
pub fn cancel_git_operation(state: State<'_, WorkspaceState>, id: String) {
    state.operations.cancel_fetch(&id);
}

#[tauri::command]
pub fn get_fetch_activity(
    state: State<'_, WorkspaceState>,
    repo_id: String,
) -> Result<std::collections::BTreeMap<String, FetchRecord>> {
    state.locations(&repo_id)?;
    Ok(state
        .configuration
        .lock()
        .unwrap()
        .value
        .fetch_activity
        .get(&repo_id)
        .cloned()
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn confirmations_are_single_use_and_writes_share_the_repository_gate() {
        let directory = tempfile::tempdir().unwrap();
        let path = std::fs::canonicalize(directory.path()).unwrap();
        let cancel = CancellationToken::new();
        let git = Git::discover(None, &cancel).await.unwrap();
        let status = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&path)
            .status()
            .unwrap();
        assert!(status.success());
        git.write(
            &path,
            &["remote", "add", "origin", "../local.git"],
            crate::git::executor::WriteMode::Local,
            &cancel,
        )
        .await
        .unwrap();
        let operations = Operations::default();
        let head = Head {
            branch: None,
            head: None,
        };
        let action = Action::Fetch {
            remote: "origin".into(),
        };
        let common = path.join(".git");
        let plan = operations::prepare(&git, path, &common, false, &action, &head, &cancel)
            .await
            .unwrap();
        for (id, tree) in [
            ("first", "tree-a"),
            ("second", "tree-b"),
            ("third", "tree-b"),
        ] {
            operations
                .save(Preview {
                    expires: Instant::now() + Duration::from_secs(30),
                    input: OperationInput {
                        id: id.into(),
                        repo_id: "shared".into(),
                        worktree_id: tree.into(),
                        head: head.clone(),
                        action: action.clone(),
                    },
                    common: common.clone(),
                    plan: plan.clone(),
                })
                .unwrap();
        }
        let (_, first) = operations.start("first").ok().unwrap();
        assert_eq!(operations.start("first").err().unwrap().code, "STALE");
        assert_eq!(operations.start("second").err().unwrap().code, "BUSY");
        operations.cancel_fetch("first");
        assert!(first.token.is_cancelled());
        drop(first);
        assert!(operations.start("third").is_ok());
    }
}
