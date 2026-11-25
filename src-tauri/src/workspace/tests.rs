use super::*;
use crate::git::diff;
use std::{
    fs,
    io::Write,
    process::{Command, Stdio},
};

fn fixture_git(path: &Path, arguments: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args([
            "-c",
            "user.name=GitDesk fixture",
            "-c",
            "user.email=gitdesk@example.invalid",
            "-c",
            "commit.gpgSign=false",
        ])
        .args(arguments)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{arguments:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().into()
}

fn init(path: &Path, commit: bool) {
    fs::create_dir_all(path).unwrap();
    fixture_git(path, &["init", "-b", "main"]);
    if commit {
        fs::write(path.join("旧文件.txt"), "original\n").unwrap();
        fixture_git(path, &["add", "--", "旧文件.txt"]);
        fixture_git(path, &["commit", "-m", "initial"]);
    }
}

fn path_string(path: &Path) -> &str {
    path.to_str().unwrap()
}

async fn start_history(
    git: &Git,
    sessions: &HistorySessions,
    path: &Path,
    id: &str,
    scope: HistoryScope,
    ref_name: Option<&str>,
) -> (CancellationToken, OpenHistory) {
    let (cancel, receiver) = sessions.start(id).unwrap();
    let location = repository::probe(git, path, None, &cancel).await.unwrap();
    let tree_id = path_id("tree", &fs::canonicalize(path).unwrap());
    let input = repository::history_input(git, &location, &tree_id, &cancel)
        .await
        .unwrap();
    let opened = history::open(git, input, scope, ref_name, None, cancel.clone(), receiver)
        .await
        .unwrap();
    (cancel, opened)
}

#[tokio::test]
async fn compares_selected_worktree_to_release_targets_after_fetch() {
    use crate::git::comparison::{self, Answer, Count, Direction, Query};

    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let remote = temp.path().join("origin.git");
    let peer = temp.path().join("peer");
    let linked = temp.path().join("linked");
    init(&repo, true);
    fixture_git(&repo, &["branch", "-m", "master"]);
    fixture_git(temp.path(), &["init", "--bare", path_string(&remote)]);
    fixture_git(&repo, &["remote", "add", "origin", path_string(&remote)]);
    fixture_git(&repo, &["push", "origin", "master"]);
    fixture_git(
        temp.path(),
        &[
            "clone",
            "-b",
            "master",
            path_string(&remote),
            path_string(&peer),
        ],
    );
    fixture_git(
        &repo,
        &[
            "worktree",
            "add",
            "-b",
            "fix/42-snapshot",
            path_string(&linked),
        ],
    );
    fixture_git(&linked, &["commit", "--allow-empty", "-m", "My task"]);
    let task_head = fixture_git(&linked, &["rev-parse", "HEAD"]);
    fixture_git(
        &repo,
        &["update-ref", "refs/remotes/origin/release-test", &task_head],
    );

    let cancel = CancellationToken::new();
    let git = Git::discover(None, &cancel).await.unwrap();
    let location = repository::probe(&git, &repo, None, &cancel).await.unwrap();
    let tree_id = path_id("tree", &fs::canonicalize(&linked).unwrap());
    let targets = [
        Some("refs/remotes/origin/release-test".into()),
        Some("refs/remotes/origin/staging-missing".into()),
        Some("refs/remotes/origin/master".into()),
    ];
    let snapshot = |input: &history::HistoryInput| {
        comparison::Comparison::new(input, 9, targets.clone(), None)
    };
    let before = repository::history_input(&git, &location, &tree_id, &cancel)
        .await
        .unwrap();
    let count = comparison::read(&git, &linked, &snapshot(&before), Query::Summary, &cancel)
        .await
        .unwrap();
    assert!(matches!(
        count,
        Answer::Summary {
            stages: [
                Some(Count::Ready {
                    ahead: 0,
                    behind: 0
                }),
                None,
                Some(Count::Ready {
                    ahead: 1,
                    behind: 0
                })
            ]
        }
    ));

    fixture_git(&peer, &["commit", "--allow-empty", "-m", "Master one"]);
    fixture_git(&peer, &["commit", "--allow-empty", "-m", "Master two"]);
    fixture_git(&peer, &["push", "origin", "master"]);
    fixture_git(&repo, &["fetch", "origin"]);
    let mut after = repository::history_input(&git, &location, &tree_id, &cancel)
        .await
        .unwrap();
    let comparison = snapshot(&after);
    assert_ne!(comparison, snapshot(&before));
    let count = comparison::read(&git, &linked, &comparison, Query::Summary, &cancel)
        .await
        .unwrap();
    assert!(matches!(
        count,
        Answer::Summary {
            stages: [
                _,
                None,
                Some(Count::Ready {
                    ahead: 1,
                    behind: 2
                })
            ]
        }
    ));
    let answer = comparison::read(
        &git,
        &linked,
        &comparison,
        Query::Commits {
            stage: 2,
            direction: Direction::Target,
            offset: 0,
        },
        &cancel,
    )
    .await
    .unwrap();
    let Answer::Commits {
        commits,
        has_more: false,
        ..
    } = answer
    else {
        panic!("expected complete difference page");
    };
    assert_eq!(
        commits
            .iter()
            .map(|commit| commit.subject.as_str())
            .collect::<Vec<_>>(),
        ["Master two", "Master one"]
    );

    let sessions = HistorySessions::default();
    let (token, receiver) = sessions.start("comparison").unwrap();
    after.comparison = Some(comparison);
    let graph = history::open(
        &git,
        after,
        HistoryScope::ReleaseTargets,
        None,
        None,
        token,
        receiver,
    )
    .await
    .unwrap();
    assert_eq!(graph.head.as_deref(), Some(task_head.as_str()));
    assert_eq!(graph.page.commits.len(), 4);
    assert!(commits.iter().all(|entry| graph
        .page
        .commits
        .iter()
        .any(|commit| commit.oid == entry.oid)));
    for entry in graph.page.commits {
        assert_eq!(
            entry.parents,
            fixture_git(&repo, &["show", "-s", "--format=%P", &entry.oid])
                .split_whitespace()
                .collect::<Vec<_>>()
        );
    }
}

#[tokio::test]
async fn reads_real_merge_parents_and_respects_local_remote_and_exact_ref_scopes() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("merge");
    init(&path, true);
    fixture_git(&path, &["switch", "-c", "feature/router"]);
    fixture_git(&path, &["commit", "--allow-empty", "-m", "Feature"]);
    fixture_git(&path, &["switch", "main"]);
    fixture_git(&path, &["commit", "--allow-empty", "-m", "Main"]);
    fixture_git(
        &path,
        &["merge", "--no-ff", "feature/router", "-m", "Merge feature"],
    );
    fixture_git(&path, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    fixture_git(&path, &["tag", "-a", "v0.1", "-m", "release", "HEAD"]);
    fixture_git(&path, &["switch", "--detach"]);
    fixture_git(&path, &["commit", "--allow-empty", "-m", "Remote only"]);
    fixture_git(
        &path,
        &["update-ref", "refs/remotes/upstream/other", "HEAD"],
    );
    fixture_git(&path, &["switch", "main"]);

    let cancel = CancellationToken::new();
    let git = Git::discover(None, &cancel).await.unwrap();
    let sessions = HistorySessions::default();
    let (_, all) = start_history(&git, &sessions, &path, "all", HistoryScope::All, None).await;
    let (_, local) =
        start_history(&git, &sessions, &path, "local", HistoryScope::Local, None).await;
    let (_, remote) = start_history(
        &git,
        &sessions,
        &path,
        "remote",
        HistoryScope::Ref,
        Some("refs/remotes/upstream/other"),
    )
    .await;
    let merge = all
        .page
        .commits
        .iter()
        .find(|commit| commit.subject == "Merge feature")
        .unwrap();
    let parents = git
        .run(
            Some(&path),
            &["show", "-s", "--format=%P", &merge.oid],
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(
        merge.parents,
        String::from_utf8(parents)
            .unwrap()
            .split_whitespace()
            .collect::<Vec<_>>()
    );
    assert_eq!(merge.parents.len(), 2);
    assert!(all
        .refs
        .iter()
        .any(|item| item.full_name == "refs/tags/v0.1" && item.target_oid == merge.oid));
    assert!(all
        .refs
        .iter()
        .any(|item| item.full_name == "refs/remotes/origin/main" && item.target_oid == merge.oid));
    assert_eq!(all.page.commits.len(), 5);
    assert_eq!(local.page.commits.len(), 4);
    assert_eq!(remote.page.commits[0].subject, "Remote only");
    assert_eq!(remote.page.commits.len(), 5);
}

#[tokio::test]
async fn reads_all_parents_of_an_octopus_merge() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path();
    init(path, true);
    for branch in ["one", "two"] {
        fixture_git(path, &["switch", "-c", branch, "main"]);
        fixture_git(path, &["commit", "--allow-empty", "-m", branch]);
    }
    fixture_git(path, &["switch", "main"]);
    fixture_git(path, &["commit", "--allow-empty", "-m", "Main"]);
    fixture_git(path, &["merge", "--no-ff", "one", "two", "-m", "Octopus"]);
    let cancel = CancellationToken::new();
    let git = Git::discover(None, &cancel).await.unwrap();
    let (_, history) = start_history(
        &git,
        &HistorySessions::default(),
        path,
        "octopus",
        HistoryScope::All,
        None,
    )
    .await;
    let [merge, ancestors @ ..] = history.page.commits.as_slice() else {
        panic!("Missing octopus merge")
    };
    assert_eq!(merge.subject, "Octopus");
    assert_eq!(merge.parents.len(), 3);
    assert!(merge
        .parents
        .iter()
        .all(|oid| ancestors.iter().any(|commit| &commit.oid == oid)));
}

#[tokio::test]
async fn emits_invalidation_when_a_remote_tracking_ref_moves() {
    let temp = tempfile::tempdir().unwrap();
    let path = fs::canonicalize(temp.path()).unwrap();
    init(&path, true);
    fixture_git(&path, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    fixture_git(&path, &["commit", "--allow-empty", "-m", "New tip"]);
    let git_dir = path.join(".git");
    let (send, mut receive) = tokio::sync::mpsc::channel(1);
    let _watch = watch::watch(path.clone(), git_dir.clone(), git_dir, false, move || {
        let _ = send.try_send(());
    })
    .unwrap();
    fixture_git(&path, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(6), receive.recv())
            .await
            .unwrap(),
        Some(())
    );
}

fn import_linear_history(path: &Path, count: usize) {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["fast-import", "--quiet"])
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    for number in 0..count {
        let subject = format!("History item {number}");
        writeln!(input, "commit refs/heads/long\ncommitter Test <test@example.invalid> {} +0000\ndata {}\n{subject}\n", 1_700_000_000 + number, subject.len()).unwrap();
    }
    drop(input);
    assert!(child.wait().unwrap().success());
}

#[tokio::test]
async fn pages_through_the_frozen_tip_after_a_ref_changes() {
    let temp = tempfile::tempdir().unwrap();
    init(temp.path(), true);
    import_linear_history(temp.path(), 510);
    let cancel = CancellationToken::new();
    let git = Git::discover(None, &cancel).await.unwrap();
    let sessions = HistorySessions::default();
    let (_, open) = start_history(
        &git,
        &sessions,
        temp.path(),
        "long",
        HistoryScope::Ref,
        Some("refs/heads/long"),
    )
    .await;
    assert!(open.page.has_more);
    assert_eq!(open.page.commits.len(), 500);
    let next_oid = open.page.commits.last().unwrap().parents[0].clone();
    fixture_git(temp.path(), &["update-ref", "refs/heads/long", "HEAD"]);
    assert_eq!(sessions.page("long", 2).await.unwrap_err().code, "STALE");
    let next = sessions.page("long", 1).await.unwrap();
    assert_eq!(next.commits.len(), 10);
    assert_eq!(next.commits[0].oid, next_oid);
    assert!(!next.has_more);

    let (token, _receiver) = sessions.start("closing").unwrap();
    sessions.close("closing");
    assert!(token.is_cancelled());
    assert_eq!(sessions.page("closing", 1).await.unwrap_err().code, "STALE");
}

#[tokio::test]
#[ignore = "synthetic history benchmark"]
async fn benchmark_one_hundred_thousand_commits() {
    let temp = tempfile::tempdir().unwrap();
    init(temp.path(), true);
    import_linear_history(temp.path(), 100_001);
    let cancel = CancellationToken::new();
    let git = Git::discover(None, &cancel).await.unwrap();
    let sessions = HistorySessions::default();
    let start = std::time::Instant::now();
    let (_, open) = start_history(
        &git,
        &sessions,
        temp.path(),
        "benchmark",
        HistoryScope::Ref,
        Some("refs/heads/long"),
    )
    .await;
    let first_page = start.elapsed();
    let mut page = open.page;
    let mut count = page.commits.len();
    while page.has_more {
        page = sessions.page("benchmark", page.sequence + 1).await.unwrap();
        count += page.commits.len();
    }
    assert_eq!(count, 100_000);
    assert!(page.truncated);
    eprintln!(
        "{count} commits: first 500 in {first_page:?}, all pages in {:?}",
        start.elapsed()
    );
}

#[tokio::test]
async fn distinguishes_empty_and_shallow_worktree_history() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let clone = temp.path().join("shallow");
    let empty = temp.path().join("empty");
    init(&source, true);
    init(&empty, false);
    fixture_git(&source, &["commit", "--allow-empty", "-m", "Middle"]);
    fixture_git(&source, &["commit", "--allow-empty", "-m", "Tip"]);
    let url = format!("file://{}", source.display());
    fixture_git(
        temp.path(),
        &["clone", "--depth", "2", &url, path_string(&clone)],
    );
    let cancel = CancellationToken::new();
    let git = Git::discover(None, &cancel).await.unwrap();
    let sessions = HistorySessions::default();
    let (_, shallow) = start_history(
        &git,
        &sessions,
        &clone,
        "shallow",
        HistoryScope::Current,
        None,
    )
    .await;
    assert_eq!(shallow.head.as_ref(), Some(&shallow.page.commits[0].oid));
    assert_eq!(shallow.page.commits.len(), 2);
    assert_eq!(shallow.page.commits[1].subject, "Middle");
    assert!(shallow.page.commits[1].shallow_boundary && shallow.page.commits[1].parents.is_empty());
    let (_, unborn) =
        start_history(&git, &sessions, &empty, "empty", HistoryScope::All, None).await;
    assert!(unborn.page.commits.is_empty() && unborn.head.is_none());
}

#[tokio::test]
async fn discovers_nested_repositories_and_deduplicates_linked_worktrees() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("workspace");
    let main = root.join("api project");
    let nested = main.join("nested");
    let linked = root.join("api-linked");
    let external = temp.path().join("外部 worktree");
    let skipped = root.join("node_modules").join("ignored");
    init(&main, true);
    init(&nested, false);
    init(&skipped, false);
    fixture_git(
        &main,
        &["worktree", "add", "-b", "task/one", path_string(&linked)],
    );
    fixture_git(
        &main,
        &[
            "worktree",
            "add",
            "--detach",
            path_string(&external),
            "HEAD",
        ],
    );
    fixture_git(&main, &["worktree", "lock", path_string(&external)]);
    #[cfg(unix)]
    std::os::unix::fs::symlink(&skipped, root.join("symlinked-repo")).unwrap();

    fixture_git(&main, &["tag", "-a", "v0.1", "-m", "tag"]);
    fixture_git(
        &main,
        &["tag", "-a", "v0.1-alias", "-m", "nested tag", "v0.1"],
    );
    fixture_git(&main, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    fixture_git(
        &main,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
        ],
    );
    fixture_git(&main, &["mv", "--", "旧文件.txt", "新文件.txt"]);
    fs::write(
        linked.join("未跟踪.txt"),
        "changes in linked worktree only\n",
    )
    .unwrap();
    let index = fs::read(main.join(".git").join("index")).unwrap();

    let config = temp.path().join("config").join("workspaces.json");
    let state = WorkspaceState::new(config.clone());
    let cancel = CancellationToken::new();
    let git = state.git(&cancel).await.unwrap();
    let discovery = scan::scan(git, &root, false, &cancel, |_| {})
        .await
        .unwrap();
    assert_eq!(discovery.locations.len(), 3);
    assert!(discovery.warning.is_none());
    state
        .configuration
        .lock()
        .unwrap()
        .update(|settings| {
            settings.workspaces.push(SavedWorkspace {
                root: discovery.root,
                discovered: discovery.locations,
                manual: Vec::new(),
                excluded: BTreeSet::new(),
                warning: None,
            });
            Ok(())
        })
        .unwrap();
    let catalog = state.catalog();
    assert_eq!(catalog.repositories.len(), 2);
    let api = catalog
        .repositories
        .values()
        .find(|repo| repo.name == "api project")
        .unwrap();
    let view = state.snapshot(&api.id).await.unwrap();
    assert_eq!(view.repository.worktrees.len(), 3);
    let primary = &view.repository.worktrees[0];
    assert_eq!(primary.branch.as_deref(), Some("main"));
    assert_eq!(
        (
            primary.status.changes,
            primary.status.staged,
            primary.status.untracked
        ),
        (2, 1, 1)
    );
    let task = view
        .repository
        .worktrees
        .iter()
        .find(|tree| tree.branch.as_deref() == Some("task/one"))
        .unwrap();
    assert_eq!((task.status.staged, task.status.untracked), (0, 1));
    let detached = view
        .repository
        .worktrees
        .iter()
        .find(|tree| tree.external)
        .unwrap();
    assert!(detached.locked && detached.branch.is_none() && detached.head.is_some());
    assert!(view
        .refs
        .iter()
        .any(|reference| reference.full_name == "refs/tags/v0.1"
            && reference.target_oid == *primary.head.as_ref().unwrap()));
    assert!(view
        .refs
        .iter()
        .any(|reference| reference.symbolic_target.as_deref() == Some("refs/remotes/origin/main")));
    assert!(view
        .refs
        .iter()
        .any(|reference| reference.full_name == "refs/tags/v0.1-alias"
            && reference.target_oid == *primary.head.as_ref().unwrap()));
    assert_eq!(fs::read(main.join(".git").join("index")).unwrap(), index);

    let nested = catalog
        .repositories
        .values()
        .find(|repo| repo.name == "nested")
        .unwrap();
    let nested = state.snapshot(&nested.id).await.unwrap();
    assert!(nested.repository.worktrees[0].head.is_none());
    assert_eq!(
        nested.repository.worktrees[0].branch.as_deref(),
        Some("main")
    );
    assert!(nested.refs.is_empty());

    let reloaded = WorkspaceState::new(config);
    assert_eq!(reloaded.catalog().repositories.len(), 2);
    fs::rename(&root, temp.path().join("moved-workspace")).unwrap();
    assert!(reloaded.catalog().workspaces[0].missing);
    assert_eq!(
        reloaded.snapshot(&api.id).await.unwrap_err().code,
        "PATH_UNAVAILABLE"
    );
}

#[tokio::test]
async fn reads_a_real_merge_conflict_and_a_selected_bare_repository() {
    let temp = tempfile::tempdir().unwrap();
    let tree = temp.path().join("conflict");
    init(&tree, true);
    fixture_git(&tree, &["switch", "-c", "other"]);
    fs::write(tree.join("旧文件.txt"), "other\n").unwrap();
    fixture_git(&tree, &["commit", "-am", "other"]);
    fixture_git(&tree, &["switch", "main"]);
    fs::write(tree.join("旧文件.txt"), "main\n").unwrap();
    fixture_git(&tree, &["commit", "-am", "main"]);
    let merge = Command::new("git")
        .arg("-C")
        .arg(&tree)
        .args(["merge", "other"])
        .output()
        .unwrap();
    assert_eq!(merge.status.code(), Some(1));

    let cancel = CancellationToken::new();
    let git = Git::discover(None, &cancel).await.unwrap();
    let location = repository::probe(&git, &tree, None, &cancel).await.unwrap();
    let view = repository::snapshot(&git, &location, &[temp.path().to_path_buf()], &cancel)
        .await
        .unwrap();
    assert_eq!(view.repository.worktrees[0].status.kind, "conflict");
    assert_eq!(view.repository.worktrees[0].status.conflicts, 1);
    assert_eq!(view.repository.worktrees[0].status.operation, "merge");
    let files = crate::git::diff::changes(&git, &tree, &cancel)
        .await
        .unwrap();
    let entries = serde_json::to_value(files).unwrap();
    assert_eq!(entries.as_array().unwrap().len(), 1);
    assert_eq!(entries[0]["group"], "Conflicts");
    let preview = crate::git::diff::preview(
        &git,
        &tree,
        &location.common_dir,
        crate::git::diff::Source::Changes {
            group: crate::git::diff::Group::Conflicts,
        },
        entries[0]["id"].as_str().unwrap(),
        &cancel,
    )
    .await
    .unwrap();
    assert_eq!(serde_json::to_value(preview).unwrap()["kind"], "text");

    let bare = temp.path().join("bare.git");
    fs::create_dir_all(&bare).unwrap();
    fixture_git(&bare, &["init", "--bare"]);
    let scan = scan::scan(&git, &bare, false, &cancel, |_| {})
        .await
        .unwrap();
    assert_eq!(scan.locations.len(), 1);
    let repo = repository::snapshot(&git, &scan.locations[0], &[scan.root], &cancel)
        .await
        .unwrap();
    assert!(repo.repository.bare && repo.repository.worktrees[0].bare);
    assert_eq!(repo.repository.worktrees[0].status.kind, "unknown");
}

#[tokio::test]
async fn scan_is_cancelled_without_returning_partial_registrations() {
    let temp = tempfile::tempdir().unwrap();
    init(&temp.path().join("sample"), false);
    let cancel = CancellationToken::new();
    let git = Git::discover(None, &cancel).await.unwrap();
    let result = scan::scan(&git, temp.path(), false, &cancel, |_| cancel.cancel()).await;
    assert_eq!(result.err().unwrap().code, "CANCELLED");
}

#[tokio::test]
async fn recognizes_a_submodule_with_a_git_file() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("workspace");
    let superproject = root.join("superproject");
    let source = temp.path().join("local-origin");
    init(&superproject, true);
    init(&source, true);
    fixture_git(
        &superproject,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            path_string(&source),
            "vendor/library",
        ],
    );
    assert!(superproject.join("vendor/library/.git").is_file());

    let cancel = CancellationToken::new();
    let git = Git::discover(None, &cancel).await.unwrap();
    let result = scan::scan(&git, &root, false, &cancel, |_| {})
        .await
        .unwrap();
    assert_eq!(result.locations.len(), 2);
    let submodule = result
        .locations
        .iter()
        .find(|location| location.anchor.ends_with("vendor/library"))
        .unwrap();
    assert!(submodule
        .common_dir
        .ends_with(".git/modules/vendor/library"));
    let view = repository::snapshot(&git, submodule, &[result.root], &cancel)
        .await
        .unwrap();
    assert_eq!(view.repository.worktrees[0].status.kind, "clean");
}

#[cfg(unix)]
#[tokio::test]
async fn rescanning_a_replaced_root_does_not_follow_its_symlink() {
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap().join("workspace");
    let destination = temp.path().join("outside");
    init(&destination, false);
    std::os::unix::fs::symlink(&destination, &root).unwrap();

    let cancel = CancellationToken::new();
    let git = Git::discover(None, &cancel).await.unwrap();
    let result = scan::scan(&git, &root, true, &cancel, |_| {
        panic!("Do not start an unauthorized scan")
    })
    .await;
    assert_eq!(result.err().unwrap().code, "PATH_UNAVAILABLE");
}

#[tokio::test]
async fn repository_removal_survives_rescan_and_is_scoped_to_its_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let checkout = workspace.join("api");
    let second = fs::canonicalize(temp.path()).unwrap().join("second");
    init(&checkout, true);
    fs::create_dir_all(&second).unwrap();

    let cancel = CancellationToken::new();
    let state = WorkspaceState::new(temp.path().join("settings.json"));
    let git = state.git(&cancel).await.unwrap();
    let scan = scan::scan(git, &workspace, false, &cancel, |_| {})
        .await
        .unwrap();
    let location = scan.locations[0].clone();
    let repo_id = location.id();
    let first_id = path_id("workspace", &scan.root);
    let second_id = path_id("workspace", &second);
    state
        .configuration
        .lock()
        .unwrap()
        .update(|config| {
            config.workspaces.extend([
                SavedWorkspace {
                    root: scan.root.clone(),
                    discovered: scan.locations,
                    manual: Vec::new(),
                    excluded: BTreeSet::new(),
                    warning: None,
                },
                SavedWorkspace {
                    root: second,
                    discovered: Vec::new(),
                    manual: vec![location.clone()],
                    excluded: BTreeSet::new(),
                    warning: None,
                },
            ]);
            let repository = location.seed();
            config.selection = Some(Selection {
                repo_id: repo_id.clone(),
                worktree_id: repository.primary_worktree_id,
                page: "refs".into(),
            });
            Ok(())
        })
        .unwrap();

    let catalog = state.remove_repository(&first_id, &repo_id).unwrap();
    assert!(catalog.workspaces[0].repository_ids.is_empty());
    assert_eq!(catalog.workspaces[1].repository_ids, vec![repo_id.clone()]);
    assert!(catalog.selection.is_some());

    let rescanned = scan::scan(git, &scan.root, true, &cancel, |_| {})
        .await
        .unwrap();
    state
        .configuration
        .lock()
        .unwrap()
        .update(|config| {
            config.workspaces[0].discovered = rescanned.locations;
            Ok(())
        })
        .unwrap();
    let restarted = WorkspaceState::new(temp.path().join("settings.json"));
    assert!(restarted.catalog().workspaces[0].repository_ids.is_empty());

    let catalog = restarted.remove_repository(&second_id, &repo_id).unwrap();
    assert!(catalog.repositories.is_empty() && catalog.selection.is_none());
    assert!(checkout.join(".git").is_dir());
    assert_eq!(
        fs::read_to_string(checkout.join("旧文件.txt")).unwrap(),
        "original\n"
    );

    restarted
        .configuration
        .lock()
        .unwrap()
        .update(|config| {
            config.workspaces[0].add_manually(location);
            Ok(())
        })
        .unwrap();
    let restored = restarted.catalog();
    assert_eq!(restored.workspaces[0].repository_ids, vec![repo_id]);
    assert!(restored.workspaces[1].repository_ids.is_empty());
}

#[tokio::test]
async fn reads_root_merge_and_literal_file_patches() {
    use crate::git::diff::{self, Source};
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path();
    init(repo, true);
    let common = repo.join(".git");
    let root = fixture_git(repo, &["rev-parse", "HEAD"]);
    fixture_git(repo, &["switch", "-c", "feature"]);
    fs::write(repo.join("routing [1].txt"), "a real route\n").unwrap();
    fs::write(repo.join("routing 1.txt"), "unrelated\n").unwrap();
    fs::write(repo.join("image.bin"), b"\x00\x01\x02").unwrap();
    fixture_git(
        repo,
        &["add", "--", "routing [1].txt", "routing 1.txt", "image.bin"],
    );
    fixture_git(repo, &["commit", "-m", "Add routing"]);
    fixture_git(repo, &["switch", "main"]);
    fixture_git(repo, &["mv", "--", "旧文件.txt", "new\nname.txt"]);
    fixture_git(repo, &["commit", "-m", "Rename file"]);
    let main = fixture_git(repo, &["rev-parse", "HEAD"]);
    let feature = fixture_git(repo, &["rev-parse", "feature"]);
    fixture_git(
        repo,
        &["merge", "--no-ff", "feature", "-m", "Merge routing"],
    );
    let merge = fixture_git(repo, &["rev-parse", "HEAD"]);

    let cancel = CancellationToken::new();
    let git = Git::discover(None, &cancel).await.unwrap();
    let root_detail = serde_json::to_value(
        diff::commit_detail(&git, repo, &common, &root, None, &cancel)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(root_detail["files"][0]["status"], "A");
    assert_eq!(root_detail["files"][0]["stats"]["added"], 1);

    let first = serde_json::to_value(
        diff::commit_detail(&git, repo, &common, &merge, Some(&main), &cancel)
            .await
            .unwrap(),
    )
    .unwrap();
    let second = serde_json::to_value(
        diff::commit_detail(&git, repo, &common, &merge, Some(&feature), &cancel)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(first["files"].as_array().unwrap().len(), 3);
    assert_eq!(second["files"][0]["status"], "R");
    assert_eq!(second["files"][0]["oldPath"], "旧文件.txt");
    assert_eq!(second["files"][0]["path"], "new\nname.txt");
    assert!(
        diff::commit_detail(&git, repo, &common, &merge, Some(&root), &cancel)
            .await
            .is_err()
    );
    for (name, kind) in [("routing [1].txt", "text"), ("image.bin", "binary")] {
        let file = first["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|file| file["path"] == name)
            .unwrap();
        let preview = diff::preview(
            &git,
            repo,
            &common,
            Source::Commit {
                oid: merge.clone(),
                parent_oid: Some(main.clone()),
            },
            file["id"].as_str().unwrap(),
            &cancel,
        )
        .await
        .unwrap();
        let preview = serde_json::to_value(preview).unwrap();
        assert_eq!(preview["kind"], kind);
        if kind == "text" {
            assert_eq!(preview["hunks"][0]["lines"][0]["newLine"], 1);
            assert_eq!(preview["hunks"][0]["lines"][0]["text"], "a real route");
        }
    }
}

#[tokio::test]
async fn lists_worktree_groups_and_previews_regular_files_without_writing() {
    use crate::git::diff::{self, Group, Source};
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    init(&repo, true);
    fs::write(repo.join("旧文件.txt"), "index\n").unwrap();
    fixture_git(&repo, &["add", "--", "旧文件.txt"]);
    fs::write(repo.join("旧文件.txt"), "worktree\n").unwrap();
    fs::write(repo.join("local.txt"), "<div>local preview</div>\n").unwrap();
    fs::write(temp.path().join("outside.txt"), "outside").unwrap();
    symlink(temp.path().join("outside.txt"), repo.join("link.txt")).unwrap();
    fs::write(repo.join("large.txt"), vec![b'x'; 1_100_000]).unwrap();
    let common = repo.join(".git");
    let index = fs::read(common.join("index")).unwrap();
    let cancel = CancellationToken::new();
    let git = Git::discover(None, &cancel).await.unwrap();
    let files = serde_json::to_value(diff::changes(&git, &repo, &cancel).await.unwrap()).unwrap();
    for (name, group, label, kind, content) in [
        ("旧文件.txt", Group::Staged, "Staged", "text", "index"),
        (
            "旧文件.txt",
            Group::Unstaged,
            "Unstaged",
            "text",
            "worktree",
        ),
        (
            "local.txt",
            Group::Untracked,
            "Untracked",
            "text",
            "<div>local preview</div>",
        ),
        ("link.txt", Group::Untracked, "Untracked", "unavailable", ""),
        ("large.txt", Group::Untracked, "Untracked", "large", ""),
    ] {
        let entry = files
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["path"] == name && entry["group"] == label)
            .unwrap();
        let patch = diff::preview(
            &git,
            &repo,
            &common,
            Source::Changes { group },
            entry["id"].as_str().unwrap(),
            &cancel,
        )
        .await
        .unwrap();
        let patch = serde_json::to_value(patch).unwrap();
        assert_eq!(patch["kind"], kind);
        if !content.is_empty() {
            assert!(patch["hunks"][0]["lines"]
                .as_array()
                .unwrap()
                .iter()
                .any(|line| line["kind"] == "add" && line["text"] == content));
        }
    }
    assert_eq!(fs::read(common.join("index")).unwrap(), index);
    assert_eq!(fs::read(repo.join("旧文件.txt")).unwrap(), b"worktree\n");
    assert!(diff::preview(
        &git,
        &repo,
        &common,
        Source::Changes {
            group: Group::Untracked
        },
        "../outside.txt",
        &cancel
    )
    .await
    .is_err());
}

#[tokio::test]
async fn release_evidence_tracks_exact_commits_and_independent_refs() {
    use crate::git::release::{self, Inclusion, StageState};
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("worktree");
    init(&repo, true);
    let common = repo.join(".git");
    let base = fixture_git(&repo, &["rev-parse", "HEAD"]);
    fs::write(repo.join("task.txt"), "released change\n").unwrap();
    fixture_git(&repo, &["add", "--", "task.txt"]);
    fixture_git(&repo, &["commit", "-m", "Task first"]);
    let first = fixture_git(&repo, &["rev-parse", "HEAD"]);
    fixture_git(
        &repo,
        &["update-ref", "refs/remotes/origin/test/current", &first],
    );
    fixture_git(&repo, &["commit", "--allow-empty", "-m", "Task second"]);
    let second = fixture_git(&repo, &["rev-parse", "HEAD"]);
    fixture_git(
        &repo,
        &["update-ref", "refs/remotes/origin/production", &second],
    );
    let targets = [
        Some("refs/remotes/origin/test/current".into()),
        Some("refs/remotes/origin/staging".into()),
        Some("refs/remotes/origin/production".into()),
    ];
    let mut oids = vec![first.clone(), second.clone(), first.to_uppercase()];
    release::normalize_oids(&mut oids).unwrap();
    assert_eq!(oids.len(), 2);

    let cancel = CancellationToken::new();
    let git = Git::discover(None, &cancel).await.unwrap();
    let candidates = serde_json::to_value(
        release::candidates(&git, &repo, base.clone(), second.clone(), &cancel)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(candidates["commits"].as_array().unwrap().len(), 2);
    let observed = release::evaluate(&git, &repo, &common, &targets, &oids, &[], &cancel)
        .await
        .unwrap();
    assert_eq!(observed[0].evidence[0].status, Inclusion::Included);
    assert_eq!(observed[0].evidence[1].status, Inclusion::NotContained);
    assert_eq!(observed[1].state, StageState::Missing);
    assert!(observed[2]
        .evidence
        .iter()
        .all(|value| value.status == Inclusion::Included));
    fixture_git(
        &repo,
        &["update-ref", "refs/remotes/origin/test/next", &base],
    );
    let changed = [
        Some("refs/remotes/origin/test/next".into()),
        None,
        targets[2].clone(),
    ];
    let next = release::evaluate(&git, &repo, &common, &changed, &oids, &[], &cancel)
        .await
        .unwrap();
    assert!(next[0]
        .evidence
        .iter()
        .all(|value| value.status == Inclusion::NotContained));
    assert_eq!(next[1].state, StageState::Unconfigured);
    assert_eq!(observed[0].tip.as_deref(), Some(first.as_str()));

    fixture_git(&repo, &["switch", "-c", "rewritten", &base]);
    fixture_git(&repo, &["commit", "--allow-empty", "-m", "Separate parent"]);
    fixture_git(&repo, &["cherry-pick", &first]);
    let rewritten = fixture_git(&repo, &["rev-parse", "HEAD"]);
    fixture_git(
        &repo,
        &["update-ref", "refs/remotes/origin/staging", "HEAD"],
    );
    fixture_git(&repo, &["switch", "main"]);
    fixture_git(&repo, &["revert", "--no-edit", &first]);
    fixture_git(
        &repo,
        &["update-ref", "refs/remotes/origin/production", "HEAD"],
    );
    let linked = temp.path().join("linked");
    fixture_git(
        &repo,
        &["worktree", "add", "--detach", path_string(&linked), "HEAD"],
    );
    let main_location = repository::probe(&git, &repo, None, &cancel).await.unwrap();
    let linked_location = repository::probe(&git, &linked, None, &cancel)
        .await
        .unwrap();
    assert_eq!(main_location.id(), linked_location.id());
    let evaluated = release::evaluate(
        &git,
        &linked,
        &linked_location.common_dir,
        &targets,
        &oids,
        &[],
        &cancel,
    )
    .await
    .unwrap();
    assert_eq!(evaluated[1].evidence[0].status, Inclusion::NotContained);
    assert_eq!(evaluated[2].evidence[0].status, Inclusion::Included);
    let links = [release::CommitLink {
        source_oid: first.clone(),
        target_oid: rewritten.clone(),
    }];
    let linked_evidence = release::evaluate(
        &git,
        &linked,
        &linked_location.common_dir,
        &targets,
        &oids,
        &links,
        &cancel,
    )
    .await
    .unwrap();
    assert_eq!(linked_evidence[1].evidence[0].matched_oid, Some(rewritten));
    assert_eq!(linked_evidence[1].evidence[0].status, Inclusion::Included);
    assert_eq!(
        linked_evidence[1].evidence[1].status,
        Inclusion::NotContained
    );
    assert_eq!(linked_evidence[2].evidence[0].matched_oid, None);

    fixture_git(&repo, &["switch", "-c", "squashed", &base]);
    fixture_git(&repo, &["merge", "--squash", &second]);
    fixture_git(&repo, &["commit", "-m", "Squashed task"]);
    let squash = fixture_git(&repo, &["rev-parse", "HEAD"]);
    fixture_git(
        &repo,
        &["update-ref", "refs/remotes/origin/staging", &squash],
    );
    let links: Vec<_> = oids
        .iter()
        .map(|oid| release::CommitLink {
            source_oid: oid.clone(),
            target_oid: squash.clone(),
        })
        .collect();
    let linked_evidence = release::evaluate(&git, &repo, &common, &targets, &oids, &links, &cancel)
        .await
        .unwrap();
    assert!(linked_evidence[1].evidence.iter().all(|evidence| {
        evidence.status == Inclusion::Included && evidence.matched_oid.as_ref() == Some(&squash)
    }));
    assert_eq!(linked_evidence[0].evidence[0].matched_oid, None);
    assert_eq!(
        linked_evidence[0].evidence[1].status,
        Inclusion::NotContained
    );
}

#[tokio::test]
async fn release_evidence_treats_shallow_negative_and_missing_objects_as_unknown() {
    use crate::git::release::{self, Inclusion};
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let clone = temp.path().join("shallow");
    init(&source, true);
    fixture_git(&source, &["commit", "--allow-empty", "-m", "Tip"]);
    let tip = fixture_git(&source, &["rev-parse", "HEAD"]);
    let url = format!("file://{}", source.display());
    fixture_git(
        temp.path(),
        &["clone", "--depth", "1", &url, path_string(&clone)],
    );
    fixture_git(&clone, &["switch", "--orphan", "other"]);
    fixture_git(&clone, &["commit", "--allow-empty", "-m", "Outside"]);
    let other = fixture_git(&clone, &["rev-parse", "HEAD"]);
    let cancel = CancellationToken::new();
    let git = Git::discover(None, &cancel).await.unwrap();
    let results = release::evaluate(
        &git,
        &clone,
        &clone.join(".git"),
        &[Some("refs/remotes/origin/main".into()), None, None],
        &[tip, other, "f".repeat(40)],
        &[],
        &cancel,
    )
    .await
    .unwrap();
    assert_eq!(results[0].evidence[0].status, Inclusion::Included);
    assert_eq!(results[0].evidence[1].status, Inclusion::Unknown);
    assert_eq!(results[0].evidence[2].status, Inclusion::Unknown);
}

#[tokio::test]
async fn my_branches_uses_the_selected_author_beyond_the_base() {
    use crate::git::my_branches::{self, AuthorFilter, CommitAuthor};
    let temp = tempfile::tempdir().unwrap();
    let repo = fs::canonicalize(temp.path()).unwrap();
    init(&repo, false);
    let alice = "Alex Example <first@example.invalid>";
    let other_alex = "Alex Example <second@example.invalid>";
    fixture_git(
        &repo,
        &[
            "commit",
            "--allow-empty",
            "--author",
            alice,
            "-m",
            "Shared baseline",
        ],
    );
    fixture_git(&repo, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    fixture_git(&repo, &["switch", "-c", "feature/matching"]);
    fixture_git(
        &repo,
        &[
            "commit",
            "--allow-empty",
            "--author",
            alice,
            "-m",
            "Selected author change",
        ],
    );
    fixture_git(
        &repo,
        &["commit", "--allow-empty", "-m", "Teammate follow-up"],
    );
    fixture_git(
        &repo,
        &["update-ref", "refs/remotes/origin/feature/matching", "HEAD"],
    );
    fixture_git(
        &repo,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
        ],
    );
    fixture_git(&repo, &["tag", "build-marker", "HEAD"]);
    fixture_git(&repo, &["switch", "-c", "feature/other-person", "main"]);
    fixture_git(
        &repo,
        &[
            "commit",
            "--allow-empty",
            "--author",
            other_alex,
            "-m",
            "Same name, different author",
        ],
    );

    let cancel = CancellationToken::new();
    let git = Git::discover(None, &cancel).await.unwrap();
    let location = repository::probe(&git, &repo, None, &cancel).await.unwrap();
    let tree_id = path_id("tree", &repo);
    let filter = AuthorFilter {
        author: CommitAuthor {
            name: "Alex Example".into(),
            email: "first@example.invalid".into(),
        },
        base_ref: "refs/remotes/origin/main".into(),
    };
    let authors = my_branches::list_authors(&git, &repo, &cancel)
        .await
        .unwrap();
    assert!(authors.contains(&filter.author));
    assert!(authors
        .iter()
        .any(|item| item.email == "second@example.invalid"));

    let snapshot = repository::history_input(&git, &location, &tree_id, &cancel)
        .await
        .unwrap();
    let sessions = HistorySessions::default();
    let (token, receiver) = sessions.start("mine").unwrap();
    let opened = history::open(
        &git,
        snapshot,
        HistoryScope::Mine,
        None,
        Some(&filter),
        token,
        receiver,
    )
    .await
    .unwrap();
    let names = opened.my_branch_refs.unwrap();
    assert_eq!(
        names.into_iter().collect::<Vec<_>>(),
        [
            "refs/heads/feature/matching",
            "refs/remotes/origin/feature/matching"
        ]
    );
    assert!(opened
        .refs
        .iter()
        .any(|item| item.full_name == "refs/heads/feature/other-person"));
    let messages: Vec<_> = opened
        .page
        .commits
        .iter()
        .map(|row| row.subject.as_str())
        .collect();
    assert_eq!(
        messages,
        [
            "Teammate follow-up",
            "Selected author change",
            "Shared baseline"
        ]
    );
    assert_eq!(
        opened.page.commits[0].parents,
        [opened.page.commits[1].oid.clone()]
    );

    let snapshot = repository::history_input(&git, &location, &tree_id, &cancel)
        .await
        .unwrap();
    let invalid = AuthorFilter {
        base_ref: "refs/tags/build-marker".into(),
        ..filter
    };
    let failure = my_branches::matching_refs(&git, &snapshot, &invalid, &cancel)
        .await
        .unwrap_err();
    assert_eq!(failure.code, "REF_MISSING");
}

#[tokio::test]
async fn submodule_reads_do_not_run_filters_and_writes_verify_submodule_state() {
    use std::{fs::FileTimes, os::unix::fs::PermissionsExt, time::Duration};

    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    let parent = root.join("parent");
    let source = root.join("source");
    init(&parent, true);
    init(&source, true);
    fs::write(
        source.join(".gitattributes"),
        "*.txt filter=review-safety\n",
    )
    .unwrap();
    fs::write(source.join("data.txt"), "canonical\n").unwrap();
    fixture_git(&source, &["add", ".gitattributes", "data.txt"]);
    fixture_git(&source, &["commit", "-m", "Add filtered file"]);
    fixture_git(
        &parent,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            path_string(&source),
            "nested",
        ],
    );
    fixture_git(&parent, &["commit", "-m", "Add submodule"]);

    let marker = root.join("filter-ran");
    let script = root.join("clean-filter");
    fs::write(
        &script,
        format!(
            "#!/bin/sh\ntouch '{}'\ncat >/dev/null\nprintf '%s\\n' canonical\n",
            marker.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    let sub = parent.join("nested");
    fixture_git(
        &sub,
        &["config", "filter.review-safety.clean", path_string(&script)],
    );
    let file = sub.join("data.txt");
    fs::write(&file, "workbytes\n").unwrap();
    fs::File::open(&file)
        .unwrap()
        .set_times(
            FileTimes::new()
                .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(1_000_000_000)),
        )
        .unwrap();

    let cancel = CancellationToken::new();
    let git = Git::discover(None, &cancel).await.unwrap();
    let common = parent.join(".git");
    assert!(diff::changes(&git, &parent, &cancel)
        .await
        .unwrap()
        .is_empty());
    assert!(!marker.exists());

    let location = repository::probe(&git, &sub, None, &cancel).await.unwrap();
    let snapshot = repository::snapshot(&git, &location, &[root], &cancel)
        .await
        .unwrap();
    assert!(snapshot.repository.worktrees[0].status.filter_limited);
    assert!(!marker.exists());

    assert_eq!(
        repository::write_status(&git, &parent, &common, &cancel)
            .await
            .err()
            .unwrap()
            .code,
        "STATUS_UNVERIFIED"
    );
    assert!(!marker.exists());
    fixture_git(&sub, &["config", "--unset", "filter.review-safety.clean"]);
    assert_eq!(
        repository::write_status(&git, &parent, &common, &cancel)
            .await
            .err()
            .unwrap()
            .code,
        "DIRTY"
    );
}

#[tokio::test]
async fn skips_unreadable_ref_names_and_keeps_the_current_commit() {
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    init(&root, true);
    let head = fixture_git(&root, &["rev-parse", "HEAD"]);
    let mut packed = format!("{head} ").into_bytes();
    packed.extend(b"refs/heads/legacy-\xff\n");
    fs::write(root.join(".git/packed-refs"), packed).unwrap();
    fs::write(root.join(".git/HEAD"), b"ref: refs/heads/legacy-\xff\n").unwrap();

    let cancel = CancellationToken::new();
    let git = Git::discover(None, &cancel).await.unwrap();
    let repo = repository::probe(&git, &root, None, &cancel).await.unwrap();
    let snapshot = repository::snapshot(&git, &repo, &[root], &cancel)
        .await
        .unwrap();
    assert_eq!(snapshot.refs.len(), 1);
    assert_eq!(snapshot.refs[0].full_name, "refs/heads/main");
    let current = &snapshot.repository.worktrees[0];
    assert_eq!(current.head.as_deref(), Some(head.as_str()));
    assert!(current.status.branch_name_unavailable);
}

#[tokio::test]
async fn file_revision_changes_when_the_same_file_keeps_the_same_diff_counts() {
    let temp = tempfile::tempdir().unwrap();
    let repo = fs::canonicalize(temp.path()).unwrap();
    init(&repo, true);
    let path = repo.join("旧文件.txt");
    fs::write(&path, "edit one\n").unwrap();
    let cancel = CancellationToken::new();
    let git = Git::discover(None, &cancel).await.unwrap();
    let read = || async {
        let files = diff::changes_with_revisions(&git, &repo, &cancel)
            .await
            .unwrap();
        serde_json::to_value(files).unwrap()[0].clone()
    };
    let previous = read().await;
    assert!(previous["revision"].is_string());
    assert_eq!(previous, read().await);
    fs::write(&path, "edit two\n").unwrap();
    let next = read().await;
    assert_eq!(previous["id"], next["id"]);
    assert_eq!(previous["stats"], next["stats"]);
    assert_ne!(previous["revision"], next["revision"]);
}

#[tokio::test]
async fn opening_another_history_session_releases_orphaned_sessions() {
    let sessions = HistorySessions::default();
    let (first, _first_receiver) = sessions.start("original").unwrap();
    let (second, _second_receiver) = sessions.start("after-reload").unwrap();
    let (third, _third_receiver) = sessions.start("after-second-reload").unwrap();
    assert!(first.is_cancelled());
    assert!(second.is_cancelled());
    assert!(!third.is_cancelled());
}

#[tokio::test]
async fn snapshots_share_only_a_pending_read_for_each_repository() {
    let temp = tempfile::tempdir().unwrap();
    let state = WorkspaceState::new(temp.path().join("workspaces.json"));
    let before = state.snapshot_reader("first");
    assert!(Arc::ptr_eq(&before, &state.snapshot_reader("first")));
    assert!(!Arc::ptr_eq(&before, &state.snapshot_reader("other")));
    let _ = before
        .get_or_init(|| async { Err(Failure::cancelled()) })
        .await;
    assert!(!Arc::ptr_eq(&before, &state.snapshot_reader("first")));
}
