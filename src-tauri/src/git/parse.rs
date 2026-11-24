use crate::model::{Failure, GitRef, Result, Status};
use std::path::PathBuf;

fn invalid_output() -> Failure {
    Failure::new(
        "INVALID_GIT_OUTPUT",
        "Git returned an unexpected read result.",
    )
}

fn text(bytes: &[u8]) -> Result<String> {
    String::from_utf8(bytes.to_vec()).map_err(|_| {
        Failure::new(
            "UNSUPPORTED",
            "This Git path or reference is not valid UTF-8.",
        )
    })
}

pub fn path_output(bytes: &[u8]) -> Result<PathBuf> {
    absolute_path(bytes.strip_suffix(b"\n").unwrap_or(bytes))
}

fn absolute_path(bytes: &[u8]) -> Result<PathBuf> {
    let path = PathBuf::from(text(bytes)?);
    if !path.is_absolute() {
        return Err(invalid_output());
    }
    Ok(path)
}

pub fn oid(value: &[u8]) -> Option<String> {
    (!value.is_empty()
        && value.iter().all(u8::is_ascii_hexdigit)
        && value.iter().any(|byte| *byte != b'0'))
    .then(|| String::from_utf8_lossy(value).into_owned())
}

#[derive(Default)]
pub struct ListedTree {
    pub path: PathBuf,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub locked: bool,
    pub prunable: bool,
    pub bare: bool,
}

pub fn worktrees(output: &[u8]) -> Result<Vec<ListedTree>> {
    output
        .split(|byte| *byte == 0)
        .collect::<Vec<_>>()
        .split(|record| record.is_empty())
        .filter(|item| !item.is_empty())
        .map(|item| {
            let path = item[0]
                .strip_prefix(b"worktree ")
                .ok_or_else(invalid_output)?;
            let mut tree = ListedTree {
                path: absolute_path(path)?,
                ..ListedTree::default()
            };
            for line in &item[1..] {
                if let Some(value) = line.strip_prefix(b"HEAD ") {
                    tree.head = oid(value);
                } else if let Some(value) = line.strip_prefix(b"branch ") {
                    tree.branch =
                        std::str::from_utf8(value.strip_prefix(b"refs/heads/").unwrap_or(value))
                            .ok()
                            .map(str::to_owned);
                } else if *line == b"bare" {
                    tree.bare = true;
                } else if *line == b"locked" || line.starts_with(b"locked ") {
                    tree.locked = true;
                } else if *line == b"prunable" || line.starts_with(b"prunable ") {
                    tree.prunable = true;
                }
            }
            Ok(tree)
        })
        .collect()
}

pub struct ParsedStatus {
    pub branch: Option<String>,
    pub head: Option<String>,
    pub status: Status,
    pub unstaged_paths: Vec<Vec<u8>>,
}

pub fn status(output: &[u8], operation: &'static str) -> Result<ParsedStatus> {
    let mut parsed = ParsedStatus {
        branch: None,
        head: None,
        status: Status::unknown(""),
        unstaged_paths: Vec::new(),
    };
    let status = &mut parsed.status;
    status.detail = None;
    status.operation = operation;
    let mut saw_head = false;
    let mut records = output
        .strip_suffix(&[0])
        .unwrap_or(output)
        .split(|byte| *byte == 0);
    while let Some(record) = records.next() {
        if let Some(value) = record.strip_prefix(b"# branch.head ") {
            saw_head = true;
            if value != b"(detached)" {
                parsed.branch = std::str::from_utf8(value).ok().map(str::to_owned);
                status.branch_name_unavailable = parsed.branch.is_none();
            }
        } else if let Some(value) = record.strip_prefix(b"# branch.oid ") {
            parsed.head = oid(value);
        } else if let Some(value) = record.strip_prefix(b"# branch.upstream ") {
            status.upstream = std::str::from_utf8(value).ok().map(str::to_owned);
        } else if let Some(value) = record.strip_prefix(b"# branch.ab ") {
            let value = text(value)?;
            let (ahead, behind) = value.split_once(' ').ok_or_else(invalid_output)?;
            status.ahead = ahead.strip_prefix('+').and_then(|n| n.parse().ok());
            status.behind = behind.strip_prefix('-').and_then(|n| n.parse().ok());
        } else if record.starts_with(b"# ") || record.starts_with(b"! ") {
            // Additional porcelain headers and ignored paths have no effect here.
        } else if record.starts_with(b"? ") {
            status.untracked += 1;
            status.changes += 1;
        } else if record.starts_with(b"u ") {
            status.conflicts += 1;
            status.changes += 1;
        } else if matches!(record.first(), Some(b'1' | b'2')) {
            let xy = record.get(2..4).ok_or_else(invalid_output)?;
            status.staged += usize::from(xy[0] != b'.');
            let unstaged = xy[1] != b'.';
            status.unstaged += usize::from(unstaged);
            status.changes += 1;
            if unstaged {
                let field_count = if record[0] == b'2' { 10 } else { 9 };
                if let Some(path) = record
                    .splitn(field_count, |byte| *byte == b' ')
                    .nth(field_count - 1)
                {
                    parsed.unstaged_paths.push(path.to_vec());
                }
            }
            if record[0] == b'2' {
                // A rename includes a second raw path. It is never a status record.
                records.next().ok_or_else(invalid_output)?;
            }
        } else {
            return Err(invalid_output());
        }
    }
    if !saw_head {
        return Err(invalid_output());
    }
    status.kind = if status.conflicts > 0 {
        "conflict"
    } else if status.changes > 0 {
        "dirty"
    } else {
        "clean"
    };
    Ok(parsed)
}

pub fn refs(output: &[u8]) -> Result<(Vec<GitRef>, Vec<String>)> {
    let mut results = Vec::new();
    let mut nested_tags = Vec::new();
    for line in output
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let fields: Vec<_> = line.split(|byte| *byte == 0).collect();
        let [name, object, object_type, peeled, peeled_type, symbolic] = fields.as_slice() else {
            return Err(invalid_output());
        };
        let Ok(full_name) = std::str::from_utf8(name).map(str::to_owned) else {
            continue;
        };
        let kind = if full_name.starts_with("refs/heads/") {
            "local"
        } else if full_name.starts_with("refs/remotes/") {
            "remote"
        } else if full_name.starts_with("refs/tags/") {
            "tag"
        } else {
            continue;
        };
        if kind == "tag" && *peeled_type == b"tag" {
            nested_tags.push(full_name);
            continue;
        }
        let target = if *object_type == b"commit" {
            oid(object)
        } else if *peeled_type == b"commit" {
            oid(peeled)
        } else {
            None
        };
        if let Some(target_oid) = target {
            let symbolic_target = if symbolic.is_empty() {
                None
            } else {
                let Ok(target) = std::str::from_utf8(symbolic) else {
                    continue;
                };
                Some(target.to_owned())
            };
            results.push(GitRef {
                full_name,
                kind,
                target_oid,
                symbolic_target,
            });
        }
    }
    Ok((results, nested_tags))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_worktree_path_whitespace_and_detached_head() {
        let entries = worktrees(b"worktree /tmp/path with \n newline \0HEAD abcd\0detached\0locked reason\0\0worktree /tmp/bare\0bare\0\0").unwrap();
        assert_eq!(entries[0].path, PathBuf::from("/tmp/path with \n newline "));
        assert_eq!(entries[0].head.as_deref(), Some("abcd"));
        assert!(entries[0].locked && entries[0].branch.is_none());
        assert!(entries[1].bare);
    }

    #[test]
    fn counts_rename_pairs_once_and_keeps_conflicts_separate() {
        let bytes = b"# branch.oid (initial)\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -5\x002 R. N... renamed.txt\0? old-name.txt\0? new.txt\0u UU N... conflict.txt\x001 .M N... \xff.txt\0";
        let parsed = status(bytes, "merge").unwrap();
        assert!(parsed.head.is_none());
        assert_eq!(parsed.branch.as_deref(), Some("main"));
        assert_eq!(parsed.status.changes, 4);
        assert_eq!((parsed.status.staged, parsed.status.unstaged), (1, 1));
        assert_eq!(parsed.status.kind, "conflict");
        assert_eq!((parsed.status.untracked, parsed.status.conflicts), (1, 1));
        assert_eq!(
            (parsed.status.ahead, parsed.status.behind),
            (Some(2), Some(5))
        );
    }
}
