use super::WorkspaceState;
use crate::{
    git::{
        diff::{self, CommitDetail, Diff, FileEntry, Source},
        executor::Git,
        repository::{self, Location},
    },
    model::{Failure, Result},
};
use serde::Deserialize;
use std::path::PathBuf;
use tauri::State;
use tokio_util::sync::CancellationToken;

pub(super) struct Request<'a> {
    state: &'a WorkspaceState,
    id: String,
    pub token: CancellationToken,
}

impl<'a> Request<'a> {
    pub fn start(state: &'a WorkspaceState, id: String) -> Result<Self> {
        if id.is_empty()
            || id.len() > 64
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(Failure::invalid("Invalid request ID."));
        }
        let mut requests = state.requests.lock().unwrap();
        if requests.len() >= 8 || requests.contains_key(&id) {
            return Err(Failure::new(
                "BUSY",
                "Other repository reads are in progress. Try again.",
            ));
        }
        let token = CancellationToken::new();
        requests.insert(id.clone(), token.clone());
        Ok(Self { state, id, token })
    }
}

impl Drop for Request<'_> {
    fn drop(&mut self) {
        self.state.requests.lock().unwrap().remove(&self.id);
    }
}

pub(super) async fn anchor(
    state: &WorkspaceState,
    git: &Git,
    repo_id: &str,
    cancel: &CancellationToken,
) -> Result<Location> {
    let (locations, _) = state.locations(repo_id)?;
    for location in locations {
        match repository::common_dir(git, &location.anchor, cancel).await {
            Ok(common) if common == location.common_dir => return Ok(location),
            Err(error) if error.code == "CANCELLED" => return Err(error),
            _ => {}
        }
    }
    Err(Failure::new(
        "STALE",
        "The repository path changed. Rescan its workspace.",
    ))
}

async fn worktree(
    state: &WorkspaceState,
    git: &Git,
    repo_id: &str,
    worktree_id: &str,
    cancel: &CancellationToken,
) -> Result<(PathBuf, Location)> {
    let location = anchor(state, git, repo_id, cancel).await?;
    let (path, bare) = repository::resolve_worktree(git, &location, worktree_id, cancel).await?;
    if bare {
        return Err(Failure::invalid(
            "This bare repository has no working files.",
        ));
    }
    Ok((path, location))
}

#[tauri::command]
pub async fn get_commit_detail(
    state: State<'_, WorkspaceState>,
    repo_id: String,
    oid: String,
    parent_oid: Option<String>,
    request_id: String,
) -> Result<CommitDetail> {
    let request = Request::start(&state, request_id)?;
    let git = state.git(&request.token).await?;
    let location = anchor(&state, git, &repo_id, &request.token).await?;
    diff::commit_detail(
        git,
        &location.anchor,
        &location.common_dir,
        &oid,
        parent_oid.as_deref(),
        &request.token,
    )
    .await
}

#[tauri::command]
pub async fn list_worktree_changes(
    state: State<'_, WorkspaceState>,
    repo_id: String,
    worktree_id: String,
    request_id: String,
) -> Result<Vec<FileEntry>> {
    let request = Request::start(&state, request_id)?;
    let git = state.git(&request.token).await?;
    let (path, _) = worktree(&state, git, &repo_id, &worktree_id, &request.token).await?;
    diff::changes_with_revisions(git, &path, &request.token).await
}

#[tauri::command]
pub async fn get_file_preview(
    state: State<'_, WorkspaceState>,
    repo_id: String,
    worktree_id: String,
    source: Source,
    file_id: String,
    request_id: String,
) -> Result<Diff> {
    if file_id.len() > 8192 {
        return Err(Failure::invalid("Invalid file ID."));
    }
    let request = Request::start(&state, request_id)?;
    let git = state.git(&request.token).await?;
    let (path, location) = match source {
        Source::Commit { .. } => {
            let location = anchor(&state, git, &repo_id, &request.token).await?;
            (location.anchor.clone(), location)
        }
        Source::Changes { .. } => {
            worktree(&state, git, &repo_id, &worktree_id, &request.token).await?
        }
    };
    diff::preview(
        git,
        &path,
        &location.common_dir,
        source,
        &file_id,
        &request.token,
    )
    .await
}

#[tauri::command]
pub fn cancel_review(state: State<'_, WorkspaceState>, request_id: String) {
    if let Some(token) = state.requests.lock().unwrap().get(&request_id) {
        token.cancel();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenIn {
    Finder,
    Terminal,
}

#[tauri::command]
pub async fn open_worktree_location(
    state: State<'_, WorkspaceState>,
    repo_id: String,
    worktree_id: String,
    destination: OpenIn,
) -> Result<()> {
    let cancel = CancellationToken::new();
    let git = state.git(&cancel).await?;
    let location = anchor(&state, git, &repo_id, &cancel).await?;
    let (path, _) = repository::resolve_worktree(git, &location, &worktree_id, &cancel).await?;
    let application = match destination {
        OpenIn::Finder => "Finder",
        OpenIn::Terminal => "Terminal",
    };
    let status = tokio::process::Command::new("/usr/bin/open")
        .args(["-a", application, "--"])
        .arg(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .map_err(|_| Failure::new("OPEN_FAILED", "Could not open the registered worktree."))?;
    if status.success() {
        Ok(())
    } else {
        Err(Failure::new(
            "OPEN_FAILED",
            "Could not open the registered worktree.",
        ))
    }
}
