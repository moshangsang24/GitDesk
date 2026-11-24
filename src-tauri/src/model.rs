use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

pub type Result<T> = std::result::Result<T, Failure>;

impl Failure {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            exit_code: None,
        }
    }

    pub fn cancelled() -> Self {
        Self::new("CANCELLED", "The operation was cancelled.")
    }

    pub fn invalid(message: &str) -> Self {
        Self::new("INVALID_INPUT", message)
    }
}

// Paths themselves stay in the registry. IPC callers cannot use IDs as paths.
pub fn path_id(kind: &str, path: &Path) -> String {
    use std::fmt::Write;
    let mut id = format!("{kind}-");
    for byte in path.as_os_str().as_encoded_bytes() {
        let _ = write!(id, "{byte:02x}");
    }
    id
}

pub fn display_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or(path.as_os_str())
        .to_string_lossy()
        .into_owned()
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub repo_id: String,
    pub worktree_id: String,
    pub page: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub workspaces: Vec<Workspace>,
    pub repositories: BTreeMap<String, Repository>,
    pub selection: Option<Selection>,
    pub warning: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub repository_ids: Vec<String>,
    pub missing: bool,
    pub warning: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub id: String,
    pub name: String,
    pub worktrees: Vec<Worktree>,
    pub primary_worktree_id: String,
    pub bare: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub id: String,
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub external: bool,
    pub locked: bool,
    pub prunable: bool,
    pub bare: bool,
    pub status: Status,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub kind: &'static str,
    pub changes: usize,
    pub staged: usize,
    pub unstaged: usize,
    pub untracked: usize,
    pub conflicts: usize,
    pub upstream: Option<String>,
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
    pub operation: &'static str,
    pub detail: Option<String>,
    pub filter_limited: bool,
    pub branch_name_unavailable: bool,
}

impl Status {
    pub fn unknown(detail: impl Into<String>) -> Self {
        Self {
            kind: "unknown",
            changes: 0,
            staged: 0,
            unstaged: 0,
            untracked: 0,
            conflicts: 0,
            upstream: None,
            ahead: None,
            behind: None,
            operation: "unknown",
            detail: Some(detail.into()),
            filter_limited: false,
            branch_name_unavailable: false,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRef {
    pub full_name: String,
    pub kind: &'static str,
    pub target_oid: String,
    pub symbolic_target: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub repository: Repository,
    pub refs: Vec<GitRef>,
    pub shallow_stamp: Option<String>,
}
