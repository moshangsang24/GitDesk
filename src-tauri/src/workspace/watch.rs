use super::scan::ignored;
use crate::model::{Failure, Result};
use notify::{Event, EventKind, RecursiveMode, Watcher};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::sync::mpsc;

pub struct Watch {
    _watcher: notify::RecommendedWatcher,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl Drop for Watch {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn relevant(path: &Path, tree: &Path, metadata: &[PathBuf]) -> bool {
    for root in metadata {
        if let Ok(relative) = path.strip_prefix(root) {
            return relative.components().next().is_none_or(|part| {
                !matches!(
                    part.as_os_str().to_str(),
                    Some("objects" | "logs" | "hooks")
                )
            });
        }
    }
    path.strip_prefix(tree)
        .is_ok_and(|relative| !relative.components().any(|part| ignored(part.as_os_str())))
}

pub fn watch(
    tree: PathBuf,
    git_dir: PathBuf,
    common: PathBuf,
    bare: bool,
    emit: impl Fn() + Send + 'static,
) -> Result<Watch> {
    let mut metadata = vec![common];
    if git_dir != metadata[0] {
        metadata.insert(0, git_dir);
    }
    let (send, mut receive) = mpsc::channel(1);
    let handler_tree = tree.clone();
    let handler_metadata = metadata.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        let changed = match result {
            Ok(event) => {
                !matches!(event.kind, EventKind::Access(_))
                    && (event.paths.is_empty()
                        || event
                            .paths
                            .iter()
                            .any(|path| relevant(path, &handler_tree, &handler_metadata)))
            }
            Err(_) => true,
        };
        if changed {
            let _ = send.try_send(());
        }
    })
    .map_err(|_| {
        Failure::new(
            "WATCH_UNAVAILABLE",
            "File watching is unavailable. Periodic refresh is still enabled.",
        )
    })?;

    let mut watched = false;
    if !bare {
        watched |= watcher.watch(&tree, RecursiveMode::Recursive).is_ok();
    }
    for directory in metadata {
        watched |= watcher.watch(&directory, RecursiveMode::Recursive).is_ok();
    }
    if !watched {
        return Err(Failure::new(
            "WATCH_UNAVAILABLE",
            "File watching is unavailable. Periodic refresh is still enabled.",
        ));
    }

    let task = tauri::async_runtime::spawn(async move {
        while receive.recv().await.is_some() {
            tokio::time::sleep(Duration::from_millis(425)).await;
            while receive.try_recv().is_ok() {}
            emit();
        }
    });
    Ok(Watch {
        _watcher: watcher,
        task,
    })
}
