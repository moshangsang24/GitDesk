mod config;
pub mod operations;
pub mod releases;
pub mod review;
mod scan;
#[cfg(test)]
mod tests;
mod watch;

use crate::{
    git::{
        executor::Git,
        history::{self, HistoryPage, HistoryScope, HistorySessions, OpenHistory},
        my_branches::{self, AuthorFilter, CommitAuthor},
        repository::{self, Location},
    },
    model::{
        display_name, path_id, Catalog, Failure, Repository, Result, Selection, Snapshot, Status,
        Workspace,
    },
};
use config::{ConfigStore, SavedWorkspace};
use serde::Serialize;
use std::{
    collections::{BTreeSet, HashMap},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, Weak,
    },
};
use tauri::{ipc::Channel, AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::{oneshot, OnceCell};
use tokio_util::sync::CancellationToken;

type SnapshotRead = OnceCell<Result<Snapshot>>;

pub struct WorkspaceState {
    configuration: Mutex<ConfigStore>,
    observed: Mutex<HashMap<String, (u64, Repository)>>,
    git: OnceCell<Git>,
    reading: AtomicU64,
    snapshots: Mutex<HashMap<String, Weak<SnapshotRead>>>,
    scan: Mutex<Option<(String, CancellationToken)>>,
    watching: AtomicU64,
    watcher: Mutex<Option<watch::Watch>>,
    history: HistorySessions,
    operations: operations::Operations,
    requests: Mutex<HashMap<String, CancellationToken>>,
}

impl WorkspaceState {
    pub fn new(config_path: PathBuf) -> Self {
        Self {
            configuration: Mutex::new(ConfigStore::open(config_path)),
            observed: Mutex::new(HashMap::new()),
            git: OnceCell::new(),
            reading: AtomicU64::new(0),
            snapshots: Mutex::new(HashMap::new()),
            scan: Mutex::new(None),
            watching: AtomicU64::new(0),
            watcher: Mutex::new(None),
            history: HistorySessions::default(),
            operations: operations::Operations::default(),
            requests: Mutex::new(HashMap::new()),
        }
    }

    async fn git(&self, cancel: &CancellationToken) -> Result<&Git> {
        let configured = self.configuration.lock().unwrap().value.git_path.clone();
        self.git
            .get_or_try_init(|| Git::discover(configured.as_deref(), cancel))
            .await
    }

    pub fn catalog(&self) -> Catalog {
        let store = self.configuration.lock().unwrap();
        let observed = self.observed.lock().unwrap();
        let mut catalog = Catalog {
            selection: store.value.selection.clone(),
            warning: store.warning.clone(),
            ..Catalog::default()
        };
        for saved in &store.value.workspaces {
            let mut ids = Vec::new();
            let mut seen = BTreeSet::new();
            for location in saved.locations() {
                let id = location.id();
                catalog.repositories.entry(id.clone()).or_insert_with(|| {
                    observed
                        .get(&id)
                        .map_or_else(|| location.seed(), |(_, repository)| repository.clone())
                });
                if seen.insert(id.clone()) {
                    ids.push(id);
                }
            }
            ids.sort_by(|a, b| {
                catalog.repositories[a]
                    .name
                    .to_lowercase()
                    .cmp(&catalog.repositories[b].name.to_lowercase())
                    .then(a.cmp(b))
            });
            catalog.workspaces.push(Workspace {
                id: path_id("workspace", &saved.root),
                name: display_name(&saved.root),
                root_path: saved.root.to_string_lossy().into_owned(),
                repository_ids: ids,
                missing: !saved.root.is_dir(),
                warning: saved.warning.clone(),
            });
        }
        catalog
    }

    fn locations(&self, repo_id: &str) -> Result<(Vec<Location>, Vec<PathBuf>)> {
        let store = self.configuration.lock().unwrap();
        let mut anchors = BTreeSet::new();
        let mut locations = Vec::new();
        let mut roots = Vec::new();
        for workspace in &store.value.workspaces {
            let mut contains_repo = false;
            for location in workspace
                .locations()
                .filter(|location| location.id() == repo_id)
            {
                contains_repo = true;
                if anchors.insert(location.anchor.clone()) {
                    locations.push(location.clone());
                }
            }
            if contains_repo {
                roots.push(workspace.root.clone());
            }
        }
        if locations.is_empty() {
            return Err(Failure::invalid("This repository is no longer registered."));
        }
        Ok((locations, roots))
    }

    fn snapshot_reader(&self, repo_id: &str) -> Arc<SnapshotRead> {
        let mut readers = self.snapshots.lock().unwrap();
        readers.retain(|_, reader| reader.strong_count() > 0);
        if let Some(reader) = readers.get(repo_id).and_then(Weak::upgrade) {
            if !reader.initialized() {
                return reader;
            }
        }
        let reader = Arc::new(OnceCell::new());
        readers.insert(repo_id.into(), Arc::downgrade(&reader));
        reader
    }

    pub async fn snapshot(&self, repo_id: &str) -> Result<Snapshot> {
        let revision = self.reading.fetch_add(1, Ordering::Relaxed);
        let (locations, roots) = self.locations(repo_id)?;
        let cancel = CancellationToken::new();
        let git = self.git(&cancel).await?;
        let mut failure = Failure::new("PATH_UNAVAILABLE", "The repository is unavailable.");
        // A registered linked checkout can still be readable when another anchor disappears.
        for location in &locations {
            match repository::snapshot(git, location, &roots, &cancel).await {
                Ok(snapshot) => {
                    self.observe(snapshot.repository.clone(), revision);
                    return Ok(snapshot);
                }
                Err(error) => failure = error,
            }
        }
        let mut unavailable = self
            .observed
            .lock()
            .unwrap()
            .get(repo_id)
            .map_or_else(|| locations[0].seed(), |(_, repository)| repository.clone());
        for tree in &mut unavailable.worktrees {
            tree.status = Status::unknown(failure.message.clone());
        }
        self.observe(unavailable, revision);
        Err(failure)
    }

    fn observe(&self, repository: Repository, revision: u64) {
        let mut observed = self.observed.lock().unwrap();
        if observed
            .get(&repository.id)
            .is_none_or(|(saved, _)| *saved < revision)
        {
            observed.insert(repository.id.clone(), (revision, repository));
        }
    }

    fn root(&self, workspace_id: &str) -> Result<PathBuf> {
        self.configuration
            .lock()
            .unwrap()
            .value
            .workspaces
            .iter()
            .find(|workspace| path_id("workspace", &workspace.root) == workspace_id)
            .map(|workspace| workspace.root.clone())
            .ok_or_else(|| Failure::invalid("This workspace is no longer registered."))
    }

    fn start_scan(&self, id: String) -> Result<ScanGuard<'_>> {
        let mut active = self.scan.lock().unwrap();
        if active.is_some() {
            return Err(Failure::new(
                "BUSY",
                "A folder selection or workspace scan is already in progress.",
            ));
        }
        let token = CancellationToken::new();
        *active = Some((id, token.clone()));
        Ok(ScanGuard { state: self, token })
    }

    async fn scan_root(
        &self,
        root: &Path,
        existing: bool,
        guard: &ScanGuard<'_>,
        progress: Channel<scan::Progress>,
    ) -> Result<Catalog> {
        let git = self.git(&guard.token).await?;
        let result = scan::scan(git, root, existing, &guard.token, |event| {
            let _ = progress.send(event);
        })
        .await?;
        self.configuration.lock().unwrap().update(|config| {
            if guard.token.is_cancelled() {
                return Err(Failure::cancelled());
            }
            if let Some(workspace) = config
                .workspaces
                .iter_mut()
                .find(|item| item.root == result.root)
            {
                let mut locations = result.locations;
                if result.warning.is_some() {
                    let anchors: BTreeSet<_> =
                        locations.iter().map(|item| item.anchor.clone()).collect();
                    locations.extend(
                        workspace
                            .discovered
                            .iter()
                            .filter(|item| !anchors.contains(&item.anchor))
                            .cloned(),
                    );
                }
                workspace.discovered = locations;
                workspace.warning = result.warning;
            } else if existing {
                return Err(Failure::invalid(
                    "This workspace was removed or its path changed during the scan.",
                ));
            } else {
                config.workspaces.push(SavedWorkspace {
                    root: result.root,
                    discovered: result.locations,
                    manual: Vec::new(),
                    excluded: BTreeSet::new(),
                    warning: result.warning,
                });
            }
            Ok(())
        })?;
        Ok(self.catalog())
    }

    fn remove_repository(&self, workspace_id: &str, repo_id: &str) -> Result<Catalog> {
        self.configuration.lock().unwrap().update(|config| {
            let workspace = config
                .workspaces
                .iter_mut()
                .find(|item| path_id("workspace", &item.root) == workspace_id)
                .ok_or_else(|| Failure::invalid("This workspace is no longer registered."))?;
            workspace.remove_repository(repo_id);
            config.clear_unregistered_selection();
            Ok(())
        })?;
        Ok(self.catalog())
    }
}

struct ScanGuard<'a> {
    state: &'a WorkspaceState,
    token: CancellationToken,
}

impl Drop for ScanGuard<'_> {
    fn drop(&mut self) {
        self.state.scan.lock().unwrap().take();
    }
}

async fn pick_folder(app: &AppHandle, title: &str) -> Result<Option<PathBuf>> {
    let (send, receive) = oneshot::channel();
    let mut dialog = app.dialog().file().set_title(title);
    if let Some(window) = tauri::Manager::get_webview_window(app, "main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.pick_folder(move |result| {
        let _ = send.send(result);
    });
    match receive
        .await
        .map_err(|_| Failure::new("IO_ERROR", "The folder picker closed unexpectedly."))?
    {
        Some(path) => path
            .into_path()
            .map(Some)
            .map_err(|_| Failure::invalid("Choose a local folder.")),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn load_workspace(state: State<'_, WorkspaceState>) -> Result<Catalog> {
    Ok(state.catalog())
}

#[tauri::command]
pub async fn add_workspace(
    app: AppHandle,
    state: State<'_, WorkspaceState>,
    request_id: String,
    progress: Channel<scan::Progress>,
) -> Result<Option<Catalog>> {
    let guard = state.start_scan(request_id)?;
    let Some(root) = pick_folder(&app, "Choose a workspace folder").await? else {
        return Ok(None);
    };
    state
        .scan_root(&root, false, &guard, progress)
        .await
        .map(Some)
}

#[tauri::command]
pub async fn rescan_workspace(
    state: State<'_, WorkspaceState>,
    workspace_id: String,
    request_id: String,
    progress: Channel<scan::Progress>,
) -> Result<Catalog> {
    let guard = state.start_scan(request_id)?;
    let root = state.root(&workspace_id)?;
    state.scan_root(&root, true, &guard, progress).await
}

#[tauri::command]
pub fn cancel_scan(state: State<'_, WorkspaceState>, request_id: String) {
    if let Some((id, token)) = state.scan.lock().unwrap().as_ref() {
        if *id == request_id {
            token.cancel();
        }
    }
}

#[tauri::command]
pub async fn add_repository(
    app: AppHandle,
    state: State<'_, WorkspaceState>,
    workspace_id: String,
    request_id: String,
) -> Result<Option<Catalog>> {
    let guard = state.start_scan(request_id)?;
    let root = state.root(&workspace_id)?;
    let Some(path) = pick_folder(&app, "Choose a Git repository folder").await? else {
        return Ok(None);
    };
    let git = state.git(&guard.token).await?;
    let location = repository::probe(git, &path, None, &guard.token).await?;
    state.configuration.lock().unwrap().update(|config| {
        if guard.token.is_cancelled() {
            return Err(Failure::cancelled());
        }
        let workspace = config
            .workspaces
            .iter_mut()
            .find(|item| item.root == root)
            .ok_or_else(|| Failure::invalid("This workspace is no longer registered."))?;
        workspace.add_manually(location);
        Ok(())
    })?;
    Ok(Some(state.catalog()))
}

#[tauri::command]
pub async fn remove_workspace(
    state: State<'_, WorkspaceState>,
    workspace_id: String,
) -> Result<Catalog> {
    state.configuration.lock().unwrap().update(|config| {
        config
            .workspaces
            .retain(|item| path_id("workspace", &item.root) != workspace_id);
        config.clear_unregistered_selection();
        Ok(())
    })?;
    Ok(state.catalog())
}

#[tauri::command]
pub async fn remove_repository(
    state: State<'_, WorkspaceState>,
    workspace_id: String,
    repo_id: String,
) -> Result<Catalog> {
    state.remove_repository(&workspace_id, &repo_id)
}

#[tauri::command]
pub async fn get_repository_snapshot(
    state: State<'_, WorkspaceState>,
    repo_id: String,
    request_id: String,
) -> Result<Snapshot> {
    let request = review::Request::start(&state, request_id)?;
    let reader = state.snapshot_reader(&repo_id);
    tokio::select! {
        biased;
        _ = request.token.cancelled() => Err(Failure::cancelled()),
        result = reader.get_or_init(|| async {
            tokio::time::timeout(std::time::Duration::from_secs(45), state.snapshot(&repo_id))
                .await
                .unwrap_or_else(|_| Err(Failure::new("TIMEOUT", "Git timed out reading the repository snapshot.")))
        }) => result.clone()
    }
}

#[tauri::command]
pub async fn open_history(
    state: State<'_, WorkspaceState>,
    session_id: String,
    repo_id: String,
    worktree_id: String,
    scope: HistoryScope,
    ref_name: Option<String>,
    author_filter: Option<AuthorFilter>,
) -> Result<OpenHistory> {
    let (locations, _) = state.locations(&repo_id)?;
    let (cancel, receiver) = state.history.start(&session_id)?;
    let result = async {
        let git = state.git(&cancel).await?;
        let mut failure = Failure::new("PATH_UNAVAILABLE", "The repository is unavailable.");
        for location in &locations {
            match repository::history_input(git, location, &worktree_id, &cancel).await {
                Ok(input) => {
                    return history::open(
                        git,
                        input,
                        scope,
                        ref_name.as_deref(),
                        author_filter.as_ref(),
                        cancel,
                        receiver,
                    )
                    .await
                }
                Err(error) if error.code == "CANCELLED" => return Err(error),
                Err(error) => failure = error,
            }
        }
        Err(failure)
    }
    .await;
    if !result.as_ref().is_ok_and(|history| history.page.has_more) {
        state.history.close(&session_id);
    }
    result
}

#[tauri::command]
pub async fn list_commit_authors(
    state: State<'_, WorkspaceState>,
    repo_id: String,
    request_id: String,
) -> Result<Vec<CommitAuthor>> {
    let request = review::Request::start(&state, request_id)?;
    let git = state.git(&request.token).await?;
    let location = review::anchor(&state, git, &repo_id, &request.token).await?;
    my_branches::list_authors(git, &location.anchor, &request.token).await
}

#[tauri::command]
pub async fn load_history_page(
    state: State<'_, WorkspaceState>,
    session_id: String,
    sequence: u32,
) -> Result<HistoryPage> {
    state.history.page(&session_id, sequence).await
}

#[tauri::command]
pub fn close_history(state: State<'_, WorkspaceState>, session_id: String) {
    state.history.close(&session_id);
}

#[tauri::command]
pub async fn save_workspace_selection(
    state: State<'_, WorkspaceState>,
    selection: Selection,
) -> Result<()> {
    if !matches!(
        selection.page.as_str(),
        "refs" | "history" | "changes" | "worktrees" | "releases"
    ) {
        return Err(Failure::invalid("Unknown repository view."));
    }
    let mut store = state.configuration.lock().unwrap();
    let Some(location) = store
        .value
        .workspaces
        .iter()
        .flat_map(SavedWorkspace::locations)
        .find(|item| item.id() == selection.repo_id)
    else {
        return Err(Failure::invalid("This repository is no longer registered."));
    };
    let observed = state.observed.lock().unwrap();
    let valid_tree = observed.get(&selection.repo_id).map_or_else(
        || path_id("tree", &location.primary) == selection.worktree_id,
        |(_, repo)| {
            repo.worktrees
                .iter()
                .any(|tree| tree.id == selection.worktree_id)
        },
    );
    drop(observed);
    if !valid_tree {
        return Err(Failure::invalid("This worktree is no longer registered."));
    }
    if store.value.selection.as_ref().is_some_and(|old| {
        old.repo_id == selection.repo_id
            && old.worktree_id == selection.worktree_id
            && old.page == selection.page
    }) {
        return Ok(());
    }
    store.update(|config| {
        config.selection = Some(selection);
        Ok(())
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Invalidation {
    repo_id: String,
    worktree_id: String,
}

#[tauri::command]
pub async fn watch_workspace_worktree(
    app: AppHandle,
    state: State<'_, WorkspaceState>,
    repo_id: String,
    worktree_id: String,
) -> Result<()> {
    let revision = {
        let mut active = state.watcher.lock().unwrap();
        let revision = state.watching.fetch_add(1, Ordering::SeqCst) + 1;
        active.take();
        revision
    };
    if repo_id.is_empty() {
        return Ok(());
    }
    let (locations, _) = state.locations(&repo_id)?;
    let catalog = state.catalog();
    let tree = catalog
        .repositories
        .get(&repo_id)
        .and_then(|repository| {
            repository
                .worktrees
                .iter()
                .find(|tree| tree.id == worktree_id)
        })
        .ok_or_else(|| Failure::invalid("This worktree is no longer registered."))?;
    let path = PathBuf::from(&tree.path);
    if !path.is_dir() || tree.prunable {
        return Ok(());
    }
    let cancel = CancellationToken::new();
    let git_dir = repository::watch_paths(
        state.git(&cancel).await?,
        &path,
        &locations[0].common_dir,
        &cancel,
    )
    .await?;
    let payload = Invalidation {
        repo_id,
        worktree_id,
    };
    let watcher = watch::watch(
        path,
        git_dir,
        locations[0].common_dir.clone(),
        tree.bare,
        move || {
            let _ = app.emit("repository-invalidated", payload.clone());
        },
    )?;
    let mut active = state.watcher.lock().unwrap();
    if state.watching.load(Ordering::SeqCst) == revision {
        *active = Some(watcher);
    }
    Ok(())
}
