use super::{
    executor::Git,
    history::{full_oid, read_shallow},
};
use crate::model::{path_id, Failure, Result};
use rustix::fs::{open, openat, statat, AtFlags, Mode, OFlags, Stat, CWD};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    ffi::OsStr,
    io::Read,
    os::{
        fd::{AsFd, BorrowedFd},
        unix::ffi::OsStrExt,
    },
    path::{Component, Path},
};
use tokio_util::sync::CancellationToken;

const PREVIEW_LIMIT: usize = 1024 * 1024;
const LINE_LIMIT: usize = 12_000;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum Group {
    Staged,
    Unstaged,
    Untracked,
    Conflicts,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Source {
    Commit {
        oid: String,
        parent_oid: Option<String>,
    },
    Changes {
        group: Group,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    id: String,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    old_path: Option<String>,
    status: char,
    #[serde(skip_serializing_if = "Option::is_none")]
    group: Option<Group>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stats: Option<Stats>,
    #[serde(skip_serializing_if = "Option::is_none")]
    revision: Option<String>,
    diff: Diff,
    #[serde(skip)]
    raw: Vec<u8>,
    #[serde(skip)]
    old_raw: Option<Vec<u8>>,
}

#[derive(Debug, Serialize)]
struct Stats {
    added: u32,
    deleted: u32,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Diff {
    Deferred,
    Binary,
    Empty,
    Large,
    Unavailable { reason: &'static str },
    Text { hunks: Vec<Hunk>, truncated: bool },
}

#[derive(Debug, Serialize)]
pub struct Hunk {
    header: String,
    lines: Vec<Line>,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Line {
    Context {
        text: String,
        old_line: u32,
        new_line: u32,
    },
    Add {
        text: String,
        new_line: u32,
    },
    Delete {
        text: String,
        old_line: u32,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    message: String,
    committer_name: String,
    committer_time: i64,
    files: Vec<FileEntry>,
    boundary: bool,
}

fn invalid_output() -> Failure {
    Failure::new(
        "INVALID_GIT_OUTPUT",
        "Git returned an invalid change record.",
    )
}

pub fn validate_oid(oid: &str) -> Result<()> {
    if !full_oid(oid.as_bytes()) {
        return Err(Failure::invalid("Use a full Git commit ID."));
    }
    Ok(())
}

pub async fn require_commit(
    git: &Git,
    path: &Path,
    oid: &str,
    cancel: &CancellationToken,
) -> Result<()> {
    validate_oid(oid)?;
    let revision = format!("{oid}^{{commit}}");
    let output = git
        .run(
            Some(path),
            &["rev-parse", "--verify", "--end-of-options", &revision],
            cancel,
        )
        .await?;
    let resolved = output.strip_suffix(b"\n").unwrap_or(&output);
    if !oid.as_bytes().eq_ignore_ascii_case(resolved) {
        return Err(Failure::invalid(
            "The object ID does not resolve to that exact commit.",
        ));
    }
    Ok(())
}

pub async fn commit_detail(
    git: &Git,
    path: &Path,
    common: &Path,
    oid: &str,
    parent: Option<&str>,
    cancel: &CancellationToken,
) -> Result<CommitDetail> {
    validate_oid(oid)?;
    let output = git
        .run(
            Some(path),
            &[
                "show",
                "--no-patch",
                "--no-notes",
                "--no-color",
                "--no-show-signature",
                "--encoding=UTF-8",
                "--format=%H%x00%P%x00%cn%x00%ct%x00%B",
                oid,
                "--",
            ],
            cancel,
        )
        .await?;
    let fields: Vec<_> = output.splitn(5, |byte| *byte == 0).collect();
    let [actual, parents, committer, time, message] = fields.as_slice() else {
        return Err(invalid_output());
    };
    if !oid.as_bytes().eq_ignore_ascii_case(actual) {
        return Err(Failure::invalid("The commit is unavailable."));
    }
    if let Some(parent) = parent {
        validate_oid(parent)?;
        if !parents
            .split(|byte| *byte == b' ')
            .any(|item| item.eq_ignore_ascii_case(parent.as_bytes()))
        {
            return Err(Failure::invalid("Select a parent of this commit."));
        }
    } else if !parents.is_empty() {
        return Err(Failure::invalid("Select a parent of this commit."));
    }
    let boundary = read_shallow(common.join("shallow"))
        .await?
        .contains(&oid.to_ascii_lowercase());
    let files = if boundary {
        Vec::new()
    } else {
        tracked_files(git, path, Some((oid, parent)), None, cancel).await?
    };
    let committer_time: i64 = std::str::from_utf8(time)
        .ok()
        .and_then(|time| time.parse().ok())
        .ok_or_else(invalid_output)?;
    if committer_time.unsigned_abs() > 8_640_000_000_000 {
        return Err(invalid_output());
    }
    Ok(CommitDetail {
        message: String::from_utf8_lossy(message)
            .trim_end_matches('\n')
            .into(),
        committer_name: String::from_utf8_lossy(committer).into_owned(),
        committer_time,
        files,
        boundary,
    })
}

fn file_entry(status: char, group: Option<Group>, raw: &[u8], old: Option<&[u8]>) -> FileEntry {
    let prefix = match group {
        None => "commit",
        Some(Group::Staged) => "staged",
        Some(Group::Unstaged) => "unstaged",
        Some(Group::Untracked) => "untracked",
        Some(Group::Conflicts) => "conflicts",
    };
    FileEntry {
        id: path_id(prefix, Path::new(OsStr::from_bytes(raw))),
        path: String::from_utf8_lossy(raw).into_owned(),
        old_path: old.map(|entry| String::from_utf8_lossy(entry).into_owned()),
        raw: raw.to_vec(),
        old_raw: old.map(<[u8]>::to_vec),
        status,
        group,
        stats: None,
        revision: None,
        diff: Diff::Deferred,
    }
}

fn nul_fields(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    bytes
        .strip_suffix(&[0])
        .unwrap_or(bytes)
        .split(|byte| *byte == 0)
}

fn parse_names(output: &[u8], group: Option<Group>) -> Result<Vec<FileEntry>> {
    let mut files = Vec::new();
    let mut records = nul_fields(output);
    while let Some(code) = records.next().filter(|code| !code.is_empty()) {
        let mut path = records
            .next()
            .filter(|path| !path.is_empty())
            .ok_or_else(invalid_output)?;
        let mut old = None;
        if matches!(code[0], b'R' | b'C') {
            old = Some(path);
            path = records
                .next()
                .filter(|path| !path.is_empty())
                .ok_or_else(invalid_output)?;
        }
        let status = match code[0] {
            b'A' => 'A',
            b'D' => 'D',
            b'R' | b'C' => 'R',
            b'U' => continue,
            _ => 'M',
        };
        files.push(file_entry(status, group, path, old));
    }
    Ok(files)
}

fn parse_stats(output: &[u8]) -> Result<HashMap<&[u8], Stats>> {
    let mut stats = HashMap::new();
    let mut records = nul_fields(output);
    while let Some(record) = records.next().filter(|value| !value.is_empty()) {
        let mut fields = record.splitn(3, |byte| *byte == b'\t');
        let added = fields.next().ok_or_else(invalid_output)?;
        let deleted = fields.next().ok_or_else(invalid_output)?;
        let mut path = fields.next().ok_or_else(invalid_output)?;
        if path.is_empty() {
            records.next().ok_or_else(invalid_output)?;
            path = records.next().ok_or_else(invalid_output)?;
        }
        if let (Some(added), Some(deleted)) = (number(added), number(deleted)) {
            stats.insert(path, Stats { added, deleted });
        }
    }
    Ok(stats)
}

async fn comparison(
    git: &Git,
    path: &Path,
    commit: Option<(&str, Option<&str>)>,
    group: Option<Group>,
    flags: &[&str],
    names: &[&str],
    cancel: &CancellationToken,
) -> Result<Vec<u8>> {
    let mut args = vec![
        if commit.is_some() {
            "diff-tree"
        } else {
            "diff"
        },
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-relative",
        "--ignore-submodules=dirty",
        "--submodule=short",
        "-M",
    ];
    if commit.is_some() {
        args.extend(["--no-commit-id", "-r"]);
    }
    if group == Some(Group::Staged) {
        args.push("--cached");
    }
    if group == Some(Group::Conflicts) {
        args.push("--ours");
    }
    args.extend_from_slice(flags);
    if let Some((oid, parent)) = commit {
        if let Some(parent) = parent {
            args.push(parent);
        } else {
            args.push("--root");
        }
        args.push(oid);
    }
    args.push("--");
    args.extend_from_slice(names);
    if commit.is_some() {
        git.run(Some(path), &args, cancel).await
    } else {
        git.worktree_read(Some(path), &args, cancel).await
    }
}

async fn tracked_files(
    git: &Git,
    path: &Path,
    commit: Option<(&str, Option<&str>)>,
    group: Option<Group>,
    cancel: &CancellationToken,
) -> Result<Vec<FileEntry>> {
    let (names, stats) = tokio::try_join!(
        comparison(
            git,
            path,
            commit,
            group,
            &["--name-status", "-z"],
            &[],
            cancel
        ),
        comparison(git, path, commit, group, &["--numstat", "-z"], &[], cancel),
    )?;
    let mut stats = parse_stats(&stats)?;
    let mut files = parse_names(&names, group)?;
    for file in &mut files {
        file.stats = stats.remove(file.raw.as_slice());
    }
    Ok(files)
}

pub async fn changes(git: &Git, path: &Path, cancel: &CancellationToken) -> Result<Vec<FileEntry>> {
    let (mut staged, unstaged, status) = tokio::try_join!(
        tracked_files(git, path, None, Some(Group::Staged), cancel),
        tracked_files(git, path, None, Some(Group::Unstaged), cancel),
        git.worktree_read(
            Some(path),
            &[
                "status",
                "--porcelain=v2",
                "-z",
                "--untracked-files=all",
                "--ignore-submodules=dirty"
            ],
            cancel
        ),
    )?;
    staged.extend(unstaged);
    let mut records = nul_fields(&status);
    while let Some(record) = records.next() {
        if let Some(path) = record.strip_prefix(b"? ") {
            staged.push(file_entry('A', Some(Group::Untracked), path, None));
        } else if record.starts_with(b"u ") {
            let path = record
                .splitn(11, |byte| *byte == b' ')
                .nth(10)
                .ok_or_else(invalid_output)?;
            staged.push(file_entry('U', Some(Group::Conflicts), path, None));
        } else if record.starts_with(b"2 ") {
            records.next().ok_or_else(invalid_output)?;
        }
    }
    let conflicts: std::collections::HashSet<_> = staged
        .iter()
        .filter(|file| file.group == Some(Group::Conflicts))
        .map(|file| file.raw.clone())
        .collect();
    staged.retain(|file| {
        !matches!(file.group, Some(Group::Staged | Group::Unstaged))
            || !conflicts.contains(&file.raw)
    });
    Ok(staged)
}

pub async fn changes_with_revisions(
    git: &Git,
    path: &Path,
    cancel: &CancellationToken,
) -> Result<Vec<FileEntry>> {
    let mut changes = changes(git, path, cancel).await?;
    if changes.is_empty() {
        return Ok(changes);
    }
    let index = git
        .run(
            Some(path),
            &["rev-parse", "--path-format=absolute", "--git-path", "index"],
            cancel,
        )
        .await;
    let index = match index {
        Ok(bytes) => super::parse::path_output(&bytes)
            .ok()
            .and_then(|file| statat(CWD, file, AtFlags::SYMLINK_NOFOLLOW).ok())
            .map(|stat| stamp(&stat)),
        Err(error) if error.code == "CANCELLED" => return Err(error),
        Err(_) => None,
    };
    let flags = OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::DIRECTORY;
    let Ok(root) = open(path, flags, Mode::empty()) else {
        return Ok(changes);
    };
    for file in &mut changes {
        if cancel.is_cancelled() {
            return Err(Failure::cancelled());
        }
        file.revision = match file.group {
            Some(Group::Staged) => index.clone(),
            Some(Group::Untracked) => path_stamp(root.as_fd(), &file.raw),
            _ => index.as_ref().and_then(|index| {
                let worktree = path_stamp(root.as_fd(), &file.raw)?;
                let old = match &file.old_raw {
                    Some(path) => path_stamp(root.as_fd(), path)?,
                    None => String::new(),
                };
                Some(format!("{index}/{worktree}/{old}"))
            }),
        };
    }
    Ok(changes)
}

fn stamp(stat: &Stat) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}:{}",
        stat.st_ino,
        stat.st_mode,
        stat.st_size,
        stat.st_mtime,
        stat.st_mtime_nsec,
        stat.st_ctime,
        stat.st_ctime_nsec
    )
}

fn path_stamp(root: BorrowedFd<'_>, raw: &[u8]) -> Option<String> {
    let flags = OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::DIRECTORY;
    let mut directory = None;
    let mut parts = Path::new(OsStr::from_bytes(raw)).components().peekable();
    while let Some(Component::Normal(name)) = parts.next() {
        let parent = directory.as_ref().map_or(root, AsFd::as_fd);
        if parts.peek().is_some() {
            directory = match openat(parent, name, flags, Mode::empty()) {
                Ok(next) => Some(next),
                Err(rustix::io::Errno::NOENT) => return Some("missing".into()),
                Err(_) => return None,
            };
        } else {
            return match statat(parent, name, AtFlags::SYMLINK_NOFOLLOW) {
                // A gitlink patch can change without the directory metadata changing.
                Ok(stat)
                    if rustix::fs::FileType::from_raw_mode(stat.st_mode)
                        != rustix::fs::FileType::Directory =>
                {
                    Some(stamp(&stat))
                }
                Err(rustix::io::Errno::NOENT) => Some("missing".into()),
                _ => None,
            };
        }
    }
    None
}

pub async fn preview(
    git: &Git,
    path: &Path,
    common: &Path,
    source: Source,
    id: &str,
    cancel: &CancellationToken,
) -> Result<Diff> {
    let (files, commit, group) = match &source {
        Source::Commit { oid, parent_oid } => (
            commit_detail(git, path, common, oid, parent_oid.as_deref(), cancel)
                .await?
                .files,
            Some((oid.as_str(), parent_oid.as_deref())),
            None,
        ),
        Source::Changes { group } => (changes(git, path, cancel).await?, None, Some(*group)),
    };
    let file = files
        .into_iter()
        .find(|file| file.id == id && file.group == group)
        .ok_or_else(|| {
            Failure::new(
                "STALE",
                "The file list changed. Refresh before reopening this file.",
            )
        })?;
    if group == Some(Group::Untracked) {
        let path = path.to_path_buf();
        return tokio::task::spawn_blocking(move || preview_untracked(&path, &file.raw))
            .await
            .map_err(|_| Failure::new("IO_ERROR", "Could not preview this file."))?;
    }
    let mut names = Vec::new();
    for raw in file
        .old_raw
        .as_deref()
        .into_iter()
        .chain(std::iter::once(file.raw.as_slice()))
    {
        let Ok(name) = std::str::from_utf8(raw) else {
            return Ok(Diff::Unavailable {
                reason: "This path cannot be passed to Git as UTF-8.",
            });
        };
        names.push(name);
    }
    let flags = [
        "--patch",
        "--unified=3",
        "--no-function-context",
        "--no-indent-heuristic",
        "--output-indicator-new=+",
        "--output-indicator-old=-",
        "--output-indicator-context= ",
    ];
    match comparison(git, path, commit, group, &flags, &names, cancel).await {
        Ok(bytes) => Ok(parse_patch(&bytes)),
        Err(error) if error.code == "OUTPUT_LIMIT" => Ok(Diff::Large),
        Err(error) => Err(error),
    }
}

fn preview_untracked(root: &Path, raw: &[u8]) -> Result<Diff> {
    let flags = OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::DIRECTORY;
    let mut parent = open(root, flags, Mode::empty())
        .map_err(|_| Failure::invalid("The worktree is unavailable."))?;
    let mut parts = Path::new(OsStr::from_bytes(raw)).components().peekable();
    while let Some(part) = parts.next() {
        let Component::Normal(name) = part else {
            return Err(Failure::invalid("Invalid file path."));
        };
        if parts.peek().is_some() {
            let Ok(next) = openat(&parent, name, flags, Mode::empty()) else {
                return Ok(Diff::Unavailable {
                    reason: "The file is behind a symbolic link or the directory changed.",
                });
            };
            parent = next;
            continue;
        }
        let Ok(fd) = openat(
            &parent,
            name,
            OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
            Mode::empty(),
        ) else {
            return Ok(Diff::Unavailable {
                reason: "A symbolic link or unavailable file has no content preview.",
            });
        };
        let file = std::fs::File::from(fd);
        let metadata = file
            .metadata()
            .map_err(|_| Failure::invalid("The file is unavailable."))?;
        if !metadata.is_file() {
            return Ok(Diff::Unavailable {
                reason: "Only regular files have a content preview.",
            });
        }
        if metadata.len() > PREVIEW_LIMIT as u64 {
            return Ok(Diff::Large);
        }
        let mut bytes = Vec::new();
        file.take((PREVIEW_LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| Failure::invalid("The file is unavailable."))?;
        if bytes.len() > PREVIEW_LIMIT {
            return Ok(Diff::Large);
        }
        if bytes.is_empty() {
            return Ok(Diff::Empty);
        }
        let Ok(text) = std::str::from_utf8(&bytes) else {
            return Ok(Diff::Binary);
        };
        if bytes.contains(&0) {
            return Ok(Diff::Binary);
        }
        let total = text.lines().count();
        let lines = text
            .lines()
            .take(LINE_LIMIT)
            .enumerate()
            .map(|(index, text)| Line::Add {
                text: text.into(),
                new_line: index as u32 + 1,
            })
            .collect();
        return Ok(Diff::Text {
            hunks: vec![Hunk {
                header: format!("@@ -0,0 +1,{total} @@"),
                lines,
            }],
            truncated: total > LINE_LIMIT,
        });
    }
    Err(Failure::invalid("Invalid file path."))
}

fn number(bytes: &[u8]) -> Option<u32> {
    std::str::from_utf8(bytes).ok()?.parse().ok()
}

fn parse_patch(bytes: &[u8]) -> Diff {
    let limit = bytes.len().min(PREVIEW_LIMIT);
    let mut hunks = Vec::<Hunk>::new();
    let mut old = 0_u32;
    let mut new = 0_u32;
    let mut lines = 0;
    let mut truncated = limit < bytes.len();
    let mut binary = false;
    for line in bytes[..limit].split_inclusive(|byte| *byte == b'\n') {
        if truncated && !line.ends_with(b"\n") {
            break;
        }
        let line = line.strip_suffix(b"\n").unwrap_or(line);
        if line.starts_with(b"diff --git ") {
            old = 0;
            new = 0;
        }
        if line.starts_with(b"@@ ") {
            let mut ranges = line.split(|byte| *byte == b' ').skip(1);
            let read = |value: &[u8]| number(value.get(1..)?.split(|byte| *byte == b',').next()?);
            let Some((start_old, start_new)) = ranges
                .next()
                .and_then(read)
                .zip(ranges.next().and_then(read))
            else {
                continue;
            };
            old = start_old;
            new = start_new;
            hunks.push(Hunk {
                header: String::from_utf8_lossy(line).into_owned(),
                lines: Vec::new(),
            });
            continue;
        }
        if line.starts_with(b"Binary files ") || line == b"GIT binary patch" {
            binary = true;
        }
        if old == 0 && new == 0 {
            continue;
        }
        let Some((&sign, text)) = line.split_first() else {
            continue;
        };
        let text = || String::from_utf8_lossy(text).into_owned();
        let item = match sign {
            b'+' => {
                let item = Line::Add {
                    text: text(),
                    new_line: new,
                };
                new = new.saturating_add(1);
                item
            }
            b'-' => {
                let item = Line::Delete {
                    text: text(),
                    old_line: old,
                };
                old = old.saturating_add(1);
                item
            }
            b' ' => {
                let item = Line::Context {
                    text: text(),
                    old_line: old,
                    new_line: new,
                };
                old = old.saturating_add(1);
                new = new.saturating_add(1);
                item
            }
            _ => continue,
        };
        if let Some(hunk) = hunks.last_mut() {
            hunk.lines.push(item);
        }
        lines += 1;
        if lines >= LINE_LIMIT {
            truncated = true;
            break;
        }
    }
    if !hunks.is_empty() {
        Diff::Text { hunks, truncated }
    } else if binary {
        Diff::Binary
    } else if truncated {
        Diff::Large
    } else {
        Diff::Empty
    }
}
