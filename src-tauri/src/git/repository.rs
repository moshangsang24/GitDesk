use super::{
    executor::Git,
    history::{shallow_stamp, HistoryInput},
    parse,
};
use crate::model::{
    display_name, path_id, Failure, GitRef, Repository, Result, Snapshot, Status, Worktree,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    os::unix::ffi::OsStrExt,
    path::{Component, Path, PathBuf},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub common_dir: PathBuf,
    pub anchor: PathBuf,
    pub primary: PathBuf,
    pub bare: bool,
}

impl Location {
    pub fn id(&self) -> String {
        path_id("repo", &self.common_dir)
    }

    pub fn seed(&self) -> Repository {
        let primary = self.primary.to_string_lossy().into_owned();
        let primary_worktree_id = path_id("tree", &self.primary);
        Repository {
            id: self.id(),
            name: display_name(&self.primary),
            worktrees: vec![Worktree {
                id: primary_worktree_id.clone(),
                path: primary,
                branch: None,
                head: None,
                external: false,
                locked: false,
                prunable: false,
                bare: self.bare,
                status: Status::unknown("Waiting for the first status read."),
            }],
            primary_worktree_id,
            bare: self.bare,
        }
    }
}

fn canonical(path: &Path, message: &str) -> Result<PathBuf> {
    let path = fs::canonicalize(path).map_err(|_| Failure::new("PATH_UNAVAILABLE", message))?;
    if path.to_str().is_none() {
        return Err(Failure::new(
            "UNSUPPORTED",
            "This directory path is not valid UTF-8.",
        ));
    }
    Ok(path)
}

pub async fn common_dir(git: &Git, root: &Path, cancel: &CancellationToken) -> Result<PathBuf> {
    let output = git
        .run(
            Some(root),
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            cancel,
        )
        .await?;
    canonical(
        &parse::path_output(&output)?,
        "The Git common directory is unavailable.",
    )
}

async fn list_trees(
    git: &Git,
    root: &Path,
    common: &Path,
    cancel: &CancellationToken,
) -> Result<Vec<parse::ListedTree>> {
    let data = git
        .run(
            Some(root),
            &["worktree", "list", "--porcelain", "-z"],
            cancel,
        )
        .await?;
    let mut entries = parse::worktrees(&data)?;
    if let Some(first) = entries.first_mut() {
        // Submodules can list their metadata directory as the primary path.
        if !first.bare && fs::canonicalize(&first.path).ok().as_deref() == Some(common) {
            let git_dir = parse::path_output(
                &git.run(Some(root), &["rev-parse", "--absolute-git-dir"], cancel)
                    .await?,
            )?;
            if fs::canonicalize(git_dir).ok().as_deref() == Some(common) {
                first.path = root.to_path_buf();
            }
        }
    }
    Ok(entries)
}

pub async fn probe(
    git: &Git,
    root: &Path,
    scan_boundary: Option<&Path>,
    cancel: &CancellationToken,
) -> Result<Location> {
    let anchor = canonical(root, "The repository directory is unavailable.")?;
    if scan_boundary.is_some_and(|boundary| anchor != root || !anchor.starts_with(boundary)) {
        return Err(Failure::new(
            "PATH_UNAVAILABLE",
            "A directory changed during scanning.",
        ));
    }
    let flag = git
        .run(
            Some(&anchor),
            &["rev-parse", "--is-bare-repository"],
            cancel,
        )
        .await
        .map_err(|err| {
            if err.code == "GIT_FAILED" {
                Failure::new(
                    "NOT_REPO",
                    "The selected directory is not a readable Git repository.",
                )
            } else {
                err
            }
        })?;
    let bare = flag == b"true\n";
    if !bare {
        let output = git
            .run(Some(&anchor), &["rev-parse", "--show-toplevel"], cancel)
            .await?;
        let top = canonical(
            &parse::path_output(&output)?,
            "The Git working directory is unavailable.",
        )?;
        if top != anchor {
            return Err(Failure::new(
                "NOT_REPO",
                "Select the repository's root directory.",
            ));
        }
    }
    let common_dir = common_dir(git, &anchor, cancel).await?;
    let first = list_trees(git, &anchor, &common_dir, cancel)
        .await?
        .into_iter()
        .next();
    let primary_bare = first.as_ref().map_or(bare, |tree| tree.bare);
    let primary = first.map_or_else(|| anchor.clone(), |tree| tree.path);
    let primary = canonical(&primary, "The primary worktree is unavailable.").unwrap_or(primary);
    if primary.to_str().is_none() {
        return Err(Failure::new(
            "UNSUPPORTED",
            "The primary worktree path is not valid UTF-8.",
        ));
    }
    Ok(Location {
        common_dir,
        anchor,
        primary,
        bare: primary_bare,
    })
}

fn operation(git_dir: &Path) -> &'static str {
    if ["rebase-merge", "rebase-apply"]
        .iter()
        .any(|name| git_dir.join(name).exists())
    {
        "rebase"
    } else if git_dir.join("MERGE_HEAD").exists() {
        "merge"
    } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
        "cherryPick"
    } else if ["REVERT_HEAD", "BISECT_START", "sequencer"]
        .iter()
        .any(|name| git_dir.join(name).exists())
    {
        "other"
    } else {
        "none"
    }
}

async fn read_status(
    git: &Git,
    path: &Path,
    expected_common: &Path,
    cancel: &CancellationToken,
) -> Result<parse::ParsedStatus> {
    if common_dir(git, path, cancel).await? != expected_common {
        return Err(Failure::new(
            "STALE",
            "This path now points to a different repository. Rescan its workspace.",
        ));
    }
    let root = parse::path_output(
        &git.run(Some(path), &["rev-parse", "--show-toplevel"], cancel)
            .await?,
    )?;
    if canonical(&root, "The worktree directory is unavailable.")? != path {
        return Err(Failure::new(
            "STALE",
            "Git no longer recognizes this directory as a worktree root.",
        ));
    }
    let git_dir = parse::path_output(
        &git.run(Some(path), &["rev-parse", "--absolute-git-dir"], cancel)
            .await?,
    )?;
    let (bytes, drivers) = git
        .worktree_read_with_filters(
            Some(path),
            &[
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=all",
                "--ignore-submodules=dirty",
            ],
            cancel,
        )
        .await?;
    let mut parsed = parse::status(&bytes, operation(&git_dir))?;
    if !drivers.is_empty() && parsed.status.unstaged != 0 {
        let paths: Vec<_> = parsed
            .unstaged_paths
            .iter()
            .flat_map(|path| path.iter().copied().chain([0]))
            .collect();
        let attributes = git
            .run_with_input(
                Some(path),
                &["check-attr", "-z", "--stdin", "filter"],
                Some(&paths),
                cancel,
            )
            .await;
        parsed.status.filter_limited = match attributes {
            Ok(output) => output
                .split(|byte| *byte == 0)
                .skip(2)
                .step_by(3)
                .any(|value| drivers.iter().any(|driver| driver.as_bytes() == value)),
            Err(error) if error.code == "CANCELLED" => return Err(error),
            Err(_) => true,
        };
        if parsed.status.filter_limited {
            parsed.status.detail = Some(
                "Some file changes could not be verified with Git clean filters disabled.".into(),
            );
        }
    }
    Ok(parsed)
}

pub async fn write_status(
    git: &Git,
    path: &Path,
    expected_common: &Path,
    cancel: &CancellationToken,
) -> Result<parse::ParsedStatus> {
    let current = read_status(git, path, expected_common, cancel).await?;
    if current.status.kind == "clean" && current.status.operation == "none" {
        tokio::time::timeout(
            super::executor::READ_TIMEOUT,
            check_submodules(git, path, cancel),
        )
        .await
        .map_err(|_| Failure::new("TIMEOUT", "Git timed out verifying submodule worktrees."))??;
    }
    Ok(current)
}

async fn check_submodules(git: &Git, root: &Path, cancel: &CancellationToken) -> Result<()> {
    let mut parents = vec![(root.to_path_buf(), 0)];
    let mut examined = 0;
    let unavailable = || {
        Failure::new(
            "STATUS_UNVERIFIED",
            "A submodule worktree could not be safely verified.",
        )
    };
    while let Some((parent, depth)) = parents.pop() {
        let index = git
            .run(Some(&parent), &["ls-files", "--stage", "-z"], cancel)
            .await?;
        for link in index
            .split(|byte| *byte == 0)
            .filter(|entry| entry.starts_with(b"160000 "))
        {
            examined += 1;
            if depth >= 8 || examined > 128 {
                return Err(unavailable());
            }
            let relative = link
                .splitn(2, |byte| *byte == b'\t')
                .nth(1)
                .ok_or_else(unavailable)?;
            let relative = Path::new(std::ffi::OsStr::from_bytes(relative));
            if relative.as_os_str().is_empty()
                || relative
                    .components()
                    .any(|part| !matches!(part, Component::Normal(_)))
            {
                return Err(unavailable());
            }
            let path = parent.join(relative);
            match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.is_dir() => {}
                Ok(_) => return Err(unavailable()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err(unavailable()),
            }
            let actual = fs::canonicalize(&path).map_err(|_| unavailable())?;
            if actual != path {
                return Err(unavailable());
            }
            match fs::symlink_metadata(actual.join(".git")) {
                Ok(metadata) if metadata.file_type().is_symlink() => return Err(unavailable()),
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    // A deinitialized gitlink normally has an empty directory.
                    if fs::read_dir(&actual)
                        .map_err(|_| unavailable())?
                        .next()
                        .is_none()
                    {
                        continue;
                    }
                    return Err(unavailable());
                }
                Err(_) => return Err(unavailable()),
            }
            let common = common_dir(git, &actual, cancel).await?;
            let nested = read_status(git, &actual, &common, cancel).await?;
            if nested.status.operation != "none" {
                return Err(Failure::new(
                    "BUSY",
                    "Finish the Git operation in the submodule first.",
                ));
            }
            if nested.status.filter_limited {
                return Err(Failure::new(
                    "STATUS_UNVERIFIED",
                    "Submodule changes could not be verified with Git clean filters disabled.",
                ));
            }
            if nested.status.kind != "clean" {
                return Err(Failure::new(
                    "DIRTY",
                    "This operation requires clean submodule worktrees.",
                ));
            }
            parents.push((actual, depth + 1));
        }
    }
    Ok(())
}

pub async fn snapshot(
    git: &Git,
    location: &Location,
    roots: &[PathBuf],
    cancel: &CancellationToken,
) -> Result<Snapshot> {
    let anchor = &location.anchor;
    if !anchor.is_dir() {
        return Err(Failure::new(
            "PATH_UNAVAILABLE",
            "The repository directory is missing. Rescan its workspace to update the list.",
        ));
    }
    if common_dir(git, anchor, cancel).await? != location.common_dir {
        return Err(Failure::new(
            "STALE",
            "The repository has changed at this path. Rescan its workspace.",
        ));
    }

    let (entries, refs) = tokio::try_join!(
        list_trees(git, anchor, &location.common_dir, cancel),
        read_refs(git, anchor, cancel)
    )?;
    let mut worktrees = Vec::new();
    for entry in entries {
        let path = fs::canonicalize(&entry.path).unwrap_or(entry.path);
        let mut tree = Worktree {
            id: path_id("tree", &path),
            path: path.to_string_lossy().into_owned(),
            branch: entry.branch,
            head: entry.head,
            locked: entry.locked,
            prunable: entry.prunable,
            bare: entry.bare,
            external: !roots.iter().any(|root| path.starts_with(root)),
            status: Status::unknown("The worktree is unavailable."),
        };
        if entry.bare {
            tree.status = Status::unknown("Bare repositories have no working files.");
            tree.head = read_head(git, &path, cancel).await?;
        } else if path.is_dir() && !entry.prunable {
            match read_status(git, &path, &location.common_dir, cancel).await {
                Ok(status) => {
                    tree.branch = status.branch;
                    tree.head = status.head;
                    tree.status = status.status;
                }
                Err(error) if error.code == "CANCELLED" => return Err(error),
                Err(error) => tree.status = Status::unknown(error.message),
            }
        }
        if cancel.is_cancelled() {
            return Err(Failure::cancelled());
        }
        worktrees.push(tree);
    }

    let first = worktrees
        .first()
        .ok_or_else(|| Failure::new("INVALID_GIT_OUTPUT", "Git did not list any worktrees."))?;
    Ok(Snapshot {
        repository: Repository {
            id: location.id(),
            name: display_name(&location.primary),
            primary_worktree_id: first.id.clone(),
            bare: first.bare,
            worktrees,
        },
        refs,
        shallow_stamp: shallow_stamp(&location.common_dir).ok().flatten(),
    })
}

pub async fn read_refs(
    git: &Git,
    anchor: &Path,
    cancel: &CancellationToken,
) -> Result<Vec<GitRef>> {
    let output = git.run(Some(anchor), &[
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(symref)",
        "refs/heads", "refs/remotes", "refs/tags",
    ], cancel).await?;
    let (mut refs, nested_tags) = parse::refs(&output)?;
    for name in nested_tags {
        let revision = format!("{name}^{{commit}}");
        match git
            .run(
                Some(anchor),
                &["rev-parse", "--verify", "--end-of-options", &revision],
                cancel,
            )
            .await
        {
            Ok(output) => {
                if let Some(target_oid) = parse::oid(output.strip_suffix(b"\n").unwrap_or(&output))
                {
                    refs.push(GitRef {
                        full_name: name,
                        kind: "tag",
                        target_oid,
                        symbolic_target: None,
                    });
                }
            }
            Err(error) if error.code == "GIT_FAILED" => {} // The peeled target is not a commit.
            Err(error) => return Err(error),
        }
    }
    refs.sort_by(|left, right| left.full_name.cmp(&right.full_name));
    Ok(refs)
}

pub async fn history_input(
    git: &Git,
    location: &Location,
    worktree_id: &str,
    cancel: &CancellationToken,
) -> Result<HistoryInput> {
    let (path, entry) = worktree_path(git, location, worktree_id, cancel).await?;
    let head = if entry.bare {
        read_head(git, &path, cancel).await?
    } else {
        entry.head
    };
    let refs = read_refs(git, &path, cancel).await?;
    Ok(HistoryInput {
        path,
        common_dir: location.common_dir.clone(),
        head,
        refs,
        comparison: None,
    })
}

pub async fn resolve_worktree(
    git: &Git,
    location: &Location,
    worktree_id: &str,
    cancel: &CancellationToken,
) -> Result<(PathBuf, bool)> {
    let (path, entry) = worktree_path(git, location, worktree_id, cancel).await?;
    if !entry.bare {
        let root = parse::path_output(
            &git.run(Some(&path), &["rev-parse", "--show-toplevel"], cancel)
                .await?,
        )?;
        if canonical(&root, "The worktree directory is unavailable.")? != path {
            return Err(Failure::new(
                "STALE",
                "The selected directory is no longer a worktree root.",
            ));
        }
    }
    Ok((path, entry.bare))
}

async fn worktree_path(
    git: &Git,
    location: &Location,
    worktree_id: &str,
    cancel: &CancellationToken,
) -> Result<(PathBuf, parse::ListedTree)> {
    let anchor = &location.anchor;
    if common_dir(git, anchor, cancel).await? != location.common_dir {
        return Err(Failure::new(
            "STALE",
            "The repository has changed. Rescan its workspace.",
        ));
    }
    let (path, entry) = list_trees(git, anchor, &location.common_dir, cancel)
        .await?
        .into_iter()
        .filter(|entry| !entry.prunable)
        .filter_map(|entry| fs::canonicalize(&entry.path).ok().map(|path| (path, entry)))
        .find(|(path, _)| path_id("tree", path) == worktree_id)
        .ok_or_else(|| Failure::invalid("This worktree is no longer available."))?;
    if common_dir(git, &path, cancel).await? != location.common_dir {
        return Err(Failure::new(
            "STALE",
            "This worktree no longer matches the repository.",
        ));
    }
    Ok((path, entry))
}

async fn read_head(git: &Git, path: &Path, cancel: &CancellationToken) -> Result<Option<String>> {
    match git
        .run(
            Some(path),
            &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
            cancel,
        )
        .await
    {
        Ok(output) => Ok(parse::oid(output.strip_suffix(b"\n").unwrap_or(&output))),
        Err(error) if error.exit_code == Some(1) => Ok(None),
        Err(error) => Err(error),
    }
}

pub async fn watch_paths(
    git: &Git,
    tree: &Path,
    expected_common: &Path,
    cancel: &CancellationToken,
) -> Result<PathBuf> {
    if common_dir(git, tree, cancel).await? != expected_common {
        return Err(Failure::new(
            "STALE",
            "This worktree no longer matches the repository.",
        ));
    }
    parse::path_output(
        &git.run(Some(tree), &["rev-parse", "--absolute-git-dir"], cancel)
            .await?,
    )
}
