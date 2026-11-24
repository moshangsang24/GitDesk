use super::*;
use std::{fs, os::unix::fs::PermissionsExt, process::Command, time::Duration};

fn cli(path: &Path, args: &[&str]) -> String {
    let result = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap().trim().to_owned()
}

fn author(path: &Path) {
    cli(path, &["config", "user.name", "GitDesk Test"]);
    cli(path, &["config", "user.email", "gitdesk@example.invalid"]);
}

fn commit(path: &Path, filename: &str) -> String {
    fs::write(path.join(filename), format!("{filename}\n")).unwrap();
    cli(path, &["add", "--", filename]);
    cli(
        path,
        &["-c", "commit.gpgSign=false", "commit", "-m", filename],
    );
    cli(path, &["rev-parse", "HEAD"])
}

struct Fixture {
    _root: tempfile::TempDir,
    path: PathBuf,
    common: PathBuf,
    peer: PathBuf,
    remote: PathBuf,
    git: Git,
    token: CancellationToken,
}

impl Fixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let parent = fs::canonicalize(root.path()).unwrap();
        let path = parent.join("worktree");
        let remote = parent.join("remote.git");
        let peer = parent.join("peer");
        let token = CancellationToken::new();
        let git = Git::discover(None, &token).await.unwrap();
        cli(
            &parent,
            &["init", "--bare", "-b", "main", remote.to_str().unwrap()],
        );
        cli(&parent, &["init", "-b", "main", path.to_str().unwrap()]);
        author(&path);
        commit(&path, "base.txt");
        cli(
            &path,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        cli(&path, &["push", "-u", "origin", "main"]);
        cli(
            &parent,
            &["clone", remote.to_str().unwrap(), peer.to_str().unwrap()],
        );
        author(&peer);
        Self {
            _root: root,
            common: path.join(".git"),
            path,
            peer,
            remote,
            git,
            token,
        }
    }

    async fn plan(&self, action: &Action) -> Result<Plan> {
        let state =
            repository::write_status(&self.git, &self.path, &self.common, &self.token).await?;
        let expected = Head {
            branch: state.branch,
            head: state.head,
        };
        prepare(
            &self.git,
            self.path.clone(),
            &self.common,
            false,
            action,
            &expected,
            &self.token,
        )
        .await
    }

    async fn run(&self, action: &Action) -> Result<()> {
        execute(
            &self.git,
            &self.common,
            &self.plan(action).await?,
            &self.token,
        )
        .await
    }

    async fn fetch(&self) -> Result<()> {
        self.run(&Action::Fetch {
            remote: "origin".into(),
        })
        .await
    }
}

#[tokio::test]
async fn creates_and_switches_local_branches_with_worktree_guards() {
    let repo = Fixture::new().await;
    let initial = cli(&repo.path, &["rev-parse", "HEAD"]);
    let action = Action::Create {
        name: "topic/review".into(),
    };
    let preview = repo.plan(&action).await.unwrap();
    repo.run(&action).await.unwrap();
    assert_eq!(cli(&repo.path, &["branch", "--show-current"]), "main");
    assert_eq!(cli(&repo.path, &["rev-parse", "topic/review"]), initial);
    assert_eq!(repo.plan(&action).await.unwrap_err().code, "INVALID_INPUT");
    assert!(repo
        .plan(&Action::Create {
            name: "@{-1}".into()
        })
        .await
        .is_err());

    let next = Action::Switch {
        name: "topic/review".into(),
    };
    fs::write(repo.path.join("untracked.txt"), "keep this").unwrap();
    assert_eq!(repo.plan(&next).await.unwrap_err().code, "DIRTY");
    fs::remove_file(repo.path.join("untracked.txt")).unwrap();
    let link = repo.path.with_file_name("linked");
    cli(
        &repo.path,
        &["worktree", "add", link.to_str().unwrap(), "topic/review"],
    );
    assert_eq!(repo.plan(&next).await.unwrap_err().code, "BRANCH_IN_USE");
    cli(&repo.path, &["worktree", "remove", link.to_str().unwrap()]);
    fs::write(repo.common.join("CHERRY_PICK_HEAD"), &initial).unwrap();
    assert_eq!(repo.plan(&next).await.unwrap_err().code, "BUSY");
    fs::remove_file(repo.common.join("CHERRY_PICK_HEAD")).unwrap();

    repo.run(&next).await.unwrap();
    assert_eq!(
        cli(&repo.path, &["branch", "--show-current"]),
        "topic/review"
    );
    let now = Action::Create { name: "new".into() };
    assert_eq!(
        prepare(
            &repo.git,
            repo.path.clone(),
            &repo.common,
            false,
            &now,
            &preview.head,
            &repo.token
        )
        .await
        .unwrap_err()
        .code,
        "STALE"
    );
    assert_eq!(
        repo.plan(&Action::Push).await.unwrap_err().code,
        "NO_UPSTREAM"
    );
}

#[tokio::test]
async fn fetch_preserves_local_branches_and_tags_and_respects_explicit_mappings() {
    let repo = Fixture::new().await;
    let base = cli(&repo.path, &["rev-parse", "HEAD"]);
    let next = commit(&repo.peer, "remote.txt");
    cli(&repo.peer, &["branch", "omit/feature"]);
    cli(&repo.peer, &["branch", "redirect"]);
    cli(&repo.peer, &["tag", "server-tag"]);
    cli(
        &repo.peer,
        &[
            "push",
            "origin",
            "main",
            "omit/feature",
            "redirect",
            "refs/tags/server-tag",
        ],
    );
    cli(&repo.path, &["config", "remote.origin.prune", "true"]);
    cli(&repo.path, &["config", "remote.origin.pruneTags", "true"]);
    cli(
        &repo.path,
        &[
            "config",
            "--add",
            "remote.origin.fetch",
            "^refs/heads/omit/*",
        ],
    );
    cli(
        &repo.path,
        &["update-ref", "refs/remotes/origin/retained", &base],
    );
    cli(
        &repo.path,
        &[
            "symbolic-ref",
            "refs/remotes/origin/redirect",
            "refs/heads/main",
        ],
    );
    fs::write(repo.path.join("base.txt"), "working edit").unwrap();
    repo.fetch().await.unwrap();
    assert_eq!(
        cli(&repo.path, &["rev-parse", "refs/remotes/origin/main"]),
        next
    );
    assert_eq!(cli(&repo.path, &["rev-parse", "HEAD"]), base);
    assert_eq!(
        cli(&repo.path, &["rev-parse", "refs/remotes/origin/retained"]),
        base
    );
    assert_eq!(cli(&repo.path, &["tag", "-l"]), "");
    assert_eq!(
        cli(&repo.path, &["for-each-ref", "refs/remotes/origin/omit"]),
        ""
    );
    assert_eq!(
        fs::read_to_string(repo.path.join("base.txt")).unwrap(),
        "working edit"
    );
    cli(
        &repo.path,
        &[
            "config",
            "--add",
            "remote.origin.fetch",
            "+refs/heads/*:refs/heads/*",
        ],
    );
    assert_eq!(repo.fetch().await.unwrap_err().code, "UNSUPPORTED");
}

#[tokio::test]
async fn pulls_only_fast_forward_and_pushes_only_the_expected_commit_and_branch() {
    let repo = Fixture::new().await;
    let remote_head = commit(&repo.peer, "first-upstream.txt");
    cli(&repo.peer, &["push", "origin", "main"]);
    cli(&repo.path, &["config", "pull.rebase", "true"]);
    cli(&repo.path, &["config", "merge.autostash", "true"]);
    cli(
        &repo.path,
        &["config", "branch.main.mergeOptions", "--squash"],
    );
    repo.run(&Action::Pull).await.unwrap();
    assert_eq!(cli(&repo.path, &["rev-parse", "HEAD"]), remote_head);
    assert_eq!(
        fs::read_to_string(repo.path.join("first-upstream.txt")).unwrap(),
        "first-upstream.txt\n"
    );
    let local_head = commit(&repo.path, "local-change.txt");
    cli(&repo.path, &["tag", "-a", "my-tag", "-m", "test tag"]);
    cli(&repo.path, &["config", "push.followTags", "true"]);
    cli(&repo.path, &["config", "push.autoSetupRemote", "true"]);
    cli(
        &repo.path,
        &["config", "remote.origin.push", "refs/tags/*:refs/tags/*"],
    );
    repo.run(&Action::Push).await.unwrap();
    assert_eq!(
        cli(&repo.remote, &["rev-parse", "refs/heads/main"]),
        local_head
    );
    assert_eq!(cli(&repo.remote, &["tag", "--list"]), "");
    cli(&repo.path, &["config", "remote.origin.mirror", "true"]);
    assert_eq!(
        repo.plan(&Action::Push).await.unwrap_err().code,
        "UNSUPPORTED"
    );
    cli(&repo.path, &["config", "--unset", "remote.origin.mirror"]);
    cli(&repo.peer, &["pull", "--ff-only"]);
    let again_remote = commit(&repo.peer, "next-upstream.txt");
    cli(&repo.peer, &["push", "origin", "main"]);
    let again_local = commit(&repo.path, "next-local.txt");
    for action in [Action::Pull, Action::Push] {
        assert_eq!(
            repo.run(&action).await.unwrap_err().code,
            "NON_FAST_FORWARD"
        );
    }
    assert_eq!(cli(&repo.path, &["rev-parse", "HEAD"]), again_local);
    assert_eq!(
        cli(&repo.remote, &["rev-parse", "refs/heads/main"]),
        again_remote
    );
    assert!(!repo.common.join("MERGE_HEAD").exists());
}

fn hook(path: &Path, content: &str) {
    fs::write(path, content).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

#[tokio::test]
async fn protects_ignored_files_and_sanitizes_hook_failures() {
    let repo = Fixture::new().await;
    cli(&repo.path, &["switch", "-c", "safe-test"]);
    commit(&repo.path, "ignored.txt");
    cli(&repo.path, &["switch", "main"]);
    fs::write(repo.common.join("info/exclude"), "ignored.txt\n").unwrap();
    fs::write(repo.path.join("ignored.txt"), "preserve").unwrap();
    let error = repo
        .run(&Action::Switch {
            name: "safe-test".into(),
        })
        .await
        .unwrap_err();
    assert_eq!(error.code, "DIRTY");
    assert_eq!(
        fs::read_to_string(repo.path.join("ignored.txt")).unwrap(),
        "preserve"
    );

    commit(&repo.path, "unpublished.txt");
    hook(
        &repo.common.join("hooks/pre-push"),
        "#!/bin/sh\nprintf '%s\\n' 'hook rejected token=example-secret' >&2\nexit 1\n",
    );
    let error = repo.run(&Action::Push).await.unwrap_err();
    assert_eq!(error.code, "REJECTED");
    assert!(!error.message.contains("example-secret"));
    assert_ne!(
        cli(&repo.remote, &["rev-parse", "HEAD"]),
        cli(&repo.path, &["rev-parse", "HEAD"])
    );
}

#[tokio::test]
async fn cancels_an_in_flight_fetch_and_releases_the_ref_lock() {
    let repo = Fixture::new().await;
    let base = cli(&repo.path, &["rev-parse", "refs/remotes/origin/main"]);
    commit(&repo.peer, "waiting.txt");
    cli(&repo.peer, &["push", "origin", "main"]);
    let marker = repo.path.join("fetch-started");
    hook(
        &repo.common.join("hooks/reference-transaction"),
        "#!/bin/sh\nif [ \"$1\" = prepared ]; then touch fetch-started; exec /bin/sleep 30; fi\n",
    );
    let plan = repo
        .plan(&Action::Fetch {
            remote: "origin".into(),
        })
        .await
        .unwrap();
    let cancel = repo.token.clone();
    let trigger = async {
        let started = tokio::time::timeout(Duration::from_secs(5), async {
            while !marker.exists() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        cancel.cancel();
        started.unwrap();
    };
    let (result, _) = tokio::join!(
        execute(&repo.git, &repo.common, &plan, &repo.token),
        trigger
    );
    assert_eq!(result.unwrap_err().code, "CANCELLED");
    assert_eq!(
        cli(&repo.path, &["rev-parse", "refs/remotes/origin/main"]),
        base
    );
    fs::remove_file(repo.common.join("hooks/reference-transaction")).unwrap();
    assert!(!repo.common.join("refs/remotes/origin/main.lock").exists());
    execute(&repo.git, &repo.common, &plan, &CancellationToken::new())
        .await
        .unwrap();
    assert_ne!(
        cli(&repo.path, &["rev-parse", "refs/remotes/origin/main"]),
        base
    );
}

#[tokio::test]
async fn stale_destinations_and_unsafe_push_refspecs_are_rejected() {
    let repo = Fixture::new().await;
    let before = repo.plan(&Action::Push).await.unwrap();
    cli(
        &repo.path,
        &["config", "branch.main.merge", "refs/heads/another"],
    );
    let after = repo.plan(&Action::Push).await.unwrap();
    assert_ne!(before, after);
    cli(
        &repo.path,
        &["config", "branch.main.merge", "refs/heads/main"],
    );
    cli(
        &repo.path,
        &[
            "symbolic-ref",
            "refs/remotes/origin/redirect",
            "refs/heads/main",
        ],
    );
    cli(
        &repo.path,
        &["config", "branch.main.merge", "refs/heads/redirect"],
    );
    assert_eq!(
        repo.plan(&Action::Push).await.unwrap_err().code,
        "UNSUPPORTED"
    );
    cli(
        &repo.path,
        &["config", "branch.main.merge", "refs/heads/main"],
    );
    cli(
        &repo.path,
        &[
            "config",
            "remote.origin.fetch",
            "+refs/heads/*:refs/heads/*",
        ],
    );
    assert_eq!(
        repo.plan(&Action::Push).await.unwrap_err().code,
        "UNSUPPORTED"
    );
}

#[test]
fn displays_only_the_transport_host() {
    assert_eq!(
        remote_host("https://person:secret@example.invalid:8443/private?key=token"),
        "example.invalid:8443"
    );
    assert_eq!(
        remote_host("git@example.invalid:private/repository"),
        "example.invalid"
    );
    assert_eq!(
        remote_host("ssh://git@[2001:db8::1]:8888/private"),
        "[2001:db8::1]:8888"
    );
    assert_eq!(remote_host("file:///private/repo"), "Local Git remote");
    assert_eq!(
        remote_host("https://person:secret"),
        "Local or configured Git remote"
    );
}
