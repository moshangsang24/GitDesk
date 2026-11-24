use crate::{
    git::{
        executor::Git,
        repository::{probe, Location},
    },
    model::{Failure, Result},
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio_util::sync::CancellationToken;

const MAX_DEPTH: usize = 12;
const MAX_ENTRIES: usize = 250_000;
const MAX_REPOSITORIES: usize = 2_000;
const IGNORED: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    ".venv",
    ".cache",
    ".next",
    "target",
    "dist",
    "build",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub directories: usize,
    pub repositories: usize,
}

pub struct Scan {
    pub root: PathBuf,
    pub locations: Vec<Location>,
    pub warning: Option<String>,
}

async fn contains_git_marker(path: &Path) -> bool {
    fs::symlink_metadata(path.join(".git"))
        .await
        .is_ok_and(|meta| meta.is_file() || meta.is_dir())
}

pub fn ignored(name: &std::ffi::OsStr) -> bool {
    IGNORED.iter().any(|entry| name == *entry)
}

pub async fn scan(
    git: &Git,
    path: &Path,
    registered: bool,
    cancel: &CancellationToken,
    mut report: impl FnMut(Progress),
) -> Result<Scan> {
    let root = fs::canonicalize(path)
        .await
        .map_err(|_| Failure::new("PATH_UNAVAILABLE", "The workspace folder is unavailable."))?;
    if registered && root != path {
        return Err(Failure::new("PATH_UNAVAILABLE", "The workspace folder now points to a different location. Choose the new folder explicitly."));
    }
    if !root.is_dir() || root.to_str().is_none() {
        return Err(Failure::new(
            "UNSUPPORTED",
            "Choose an accessible directory with a UTF-8 path.",
        ));
    }
    let mut todo = vec![(root.clone(), 0)];
    let mut candidates = Vec::new();
    let mut progress = Progress {
        directories: 0,
        repositories: 0,
    };
    let mut entries = 0;
    let mut unreadable = 0;
    let mut limited = false;
    report(progress.clone());
    'traversal: while let Some((dir, depth)) = todo.pop() {
        if cancel.is_cancelled() {
            return Err(Failure::cancelled());
        }
        if depth > 0
            && fs::canonicalize(&dir)
                .await
                .map_or(true, |resolved| resolved != dir)
        {
            unreadable += 1;
            continue;
        }
        progress.directories += 1;
        if progress.directories.is_multiple_of(64) {
            report(progress.clone());
        }

        let is_bare_root = depth == 0
            && dir.join("HEAD").is_file()
            && dir.join("objects").is_dir()
            && dir.join("refs").is_dir();
        if is_bare_root || contains_git_marker(&dir).await {
            candidates.push(dir.clone());
            if candidates.len() >= MAX_REPOSITORIES {
                limited = true;
                break;
            }
        }
        if is_bare_root {
            continue;
        }
        if depth == MAX_DEPTH {
            limited = true;
            continue;
        }
        let mut listing = match fs::read_dir(&dir).await {
            Ok(listing) => listing,
            Err(_) if depth == 0 => {
                return Err(Failure::new(
                    "PATH_UNAVAILABLE",
                    "Could not read the workspace folder.",
                ))
            }
            Err(_) => {
                unreadable += 1;
                continue;
            }
        };
        loop {
            if cancel.is_cancelled() {
                return Err(Failure::cancelled());
            }
            let child = match listing.next_entry().await {
                Ok(Some(child)) => child,
                Ok(None) => break,
                Err(_) => {
                    unreadable += 1;
                    break;
                }
            };
            entries += 1;
            if entries >= MAX_ENTRIES {
                limited = true;
                break 'traversal;
            }
            if ignored(&child.file_name()) {
                continue;
            }
            match child.file_type().await {
                Ok(kind) if kind.is_dir() => todo.push((child.path(), depth + 1)),
                Err(_) => unreadable += 1,
                _ => {}
            }
        }
    }

    candidates.sort();
    let mut locations = Vec::new();
    for pair in candidates.chunks(2) {
        let (first, second) = tokio::join!(probe(git, &pair[0], Some(&root), cancel), async {
            match pair.get(1) {
                Some(path) => Some(probe(git, path, Some(&root), cancel).await),
                None => None,
            }
        });
        for result in [Some(first), second].into_iter().flatten() {
            match result {
                Ok(location) => locations.push(location),
                Err(error) if error.code == "CANCELLED" => return Err(error),
                Err(_) => unreadable += 1,
            }
        }
        progress.repositories = locations.len();
        if progress.repositories % 16 <= 1 {
            report(progress.clone());
        }
    }
    if cancel.is_cancelled() {
        return Err(Failure::cancelled());
    }
    report(progress);

    let warning = if limited {
        Some(
            "The scan reached a traversal limit. Repositories already registered were retained."
                .into(),
        )
    } else if unreadable > 0 {
        Some(format!("{unreadable} folders or Git repositories could not be read. Repositories already registered were retained."))
    } else {
        None
    };
    Ok(Scan {
        root,
        locations,
        warning,
    })
}
