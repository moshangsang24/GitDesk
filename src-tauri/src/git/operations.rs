use super::{
    diff,
    executor::{Git, WriteMode},
    parse,
    proxy::RepositoryProxy,
    repository,
};
use crate::model::{Failure, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    Create { name: String },
    Switch { name: String },
    Fetch { remote: String },
    Pull,
    Push,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Head {
    pub branch: Option<String>,
    pub head: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    path: PathBuf,
    pub head: Head,
    target: Target,
    proxy: RepositoryProxy,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Target {
    Create(String),
    Switch(String, String),
    Fetch(Remote),
    Pull(Upstream),
    Push(Upstream),
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Upstream {
    remote: Remote,
    source: String,
    tracking: Option<String>,
    previous_tip: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Remote {
    name: String,
    urls: Vec<String>,
    specs: Vec<Refspec>,
}

impl Remote {
    fn uses_http(&self) -> bool {
        self.urls[0].starts_with("https://") || self.urls[0].starts_with("http://")
    }

    fn proxy_override(&self, proxy: &RepositoryProxy) -> Option<String> {
        proxy
            .endpoint()
            .map(|url| format!("remote.{}.proxy={url}", self.name))
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Refspec {
    source: String,
    destination: Option<String>,
    force: bool,
}

impl Refspec {
    fn argument(&self) -> String {
        match &self.destination {
            Some(destination) => format!(
                "{}{}:{destination}",
                if self.force { "+" } else { "" },
                self.source
            ),
            None => format!("^{}", self.source),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Confirmation {
    target: String,
    remote: Option<String>,
    remote_host: Option<String>,
    proxy_mode: Option<&'static str>,
    tracked_ref: Option<String>,
    commit: Option<String>,
    pub path: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchRecord {
    pub fetched_at: Option<u64>,
    pub specs: Vec<Refspec>,
    pub failure: Option<String>,
}

impl Plan {
    pub fn with_proxy(mut self, proxy: RepositoryProxy) -> Result<Self> {
        let remote = match &self.target {
            Target::Fetch(remote) => Some(remote),
            Target::Pull(upstream) | Target::Push(upstream) => Some(&upstream.remote),
            _ => None,
        };
        if remote.is_some_and(Remote::uses_http) {
            self.proxy = proxy.normalize()?;
        }
        Ok(self)
    }

    pub fn confirmation(&self) -> Confirmation {
        let (target, remote, tracked_ref, commit) = match &self.target {
            Target::Create(name) => (name, None, None, self.head.head.clone()),
            Target::Switch(name, oid) => (name, None, None, Some(oid.clone())),
            Target::Fetch(remote) => (&remote.name, Some(remote), None, None),
            Target::Pull(upstream) => (
                &upstream.source,
                Some(&upstream.remote),
                upstream.tracking.clone(),
                None,
            ),
            Target::Push(upstream) => (
                &upstream.source,
                Some(&upstream.remote),
                upstream.tracking.clone(),
                self.head.head.clone(),
            ),
        };
        Confirmation {
            target: target.clone(),
            remote: remote.map(|remote| remote.name.clone()),
            remote_host: remote.map(|remote| remote_host(&remote.urls[0])),
            proxy_mode: remote
                .filter(|remote| remote.uses_http())
                .map(|_| self.proxy.mode()),
            tracked_ref,
            commit,
            path: self.path.to_string_lossy().into_owned(),
        }
    }

    pub fn fetch_scope(&self) -> Option<(&str, &[Refspec])> {
        match &self.target {
            Target::Fetch(remote) => Some((&remote.name, &remote.specs)),
            _ => None,
        }
    }
}

fn remote_host(url: &str) -> String {
    let authority = match url.split_once("://") {
        Some(("file", _)) => return "Local Git remote".into(),
        Some((_, rest)) => rest.split(['/', '?', '#']).next(),
        None => url
            .split_once(':')
            .and_then(|(host, _)| (!host.contains('/')).then_some(host)),
    };
    let authority = authority.map(|text| text.rsplit('@').next().unwrap_or(text));
    if let Some(authority) = authority {
        let (host, port) = if let Some(ip) = authority.strip_prefix('[') {
            ip.split_once(']')
                .map_or(("", ""), |(host, rest)| (host, rest))
        } else {
            authority
                .split_once(':')
                .map_or((authority, ""), |(host, _)| {
                    (host, &authority[host.len()..])
                })
        };
        let valid_host = !host.is_empty()
            && host.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b':')
            });
        let valid_port = port.is_empty()
            || port
                .strip_prefix(':')
                .is_some_and(|value| value.parse::<u16>().is_ok());
        if valid_host && valid_port {
            return authority.to_owned();
        }
    }
    "Local or configured Git remote".into()
}

pub fn stale() -> Failure {
    Failure::new("STALE", "HEAD, branch, upstream, or operation target changed. Refresh and review the operation again.")
}

fn unsupported(message: &str) -> Failure {
    Failure::new("UNSUPPORTED", message)
}

fn valid_remote(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('-')
        && !name
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'/' | b'-'))
}

fn lines(bytes: &[u8]) -> Result<Vec<String>> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| unsupported("This Git configuration is not valid UTF-8."))?;
    Ok(text
        .strip_suffix('\n')
        .unwrap_or(text)
        .split_terminator('\n')
        .map(str::to_owned)
        .collect())
}

async fn config(
    git: &Git,
    path: &Path,
    key: &str,
    cancel: &CancellationToken,
) -> Result<Vec<String>> {
    match git
        .run(Some(path), &["config", "--null", "--get-all", key], cancel)
        .await
    {
        Ok(bytes) => {
            let text = std::str::from_utf8(&bytes)
                .map_err(|_| unsupported("This Git configuration is not valid UTF-8."))?;
            Ok(text.split_terminator('\0').map(str::to_owned).collect())
        }
        Err(error) if error.exit_code == Some(1) => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

pub async fn remotes(git: &Git, path: &Path, cancel: &CancellationToken) -> Result<Vec<String>> {
    let bytes = git.run(Some(path), &["remote"], cancel).await?;
    Ok(lines(&bytes)?
        .into_iter()
        .filter(|name| valid_remote(name))
        .collect())
}

async fn check_ref(
    git: &Git,
    path: &Path,
    value: &str,
    pattern: bool,
    cancel: &CancellationToken,
) -> Result<()> {
    if value.len() > 1024 {
        return Err(Failure::invalid("The Git reference name is too long."));
    }
    let mut args = vec!["check-ref-format"];
    if pattern {
        args.push("--refspec-pattern");
    }
    args.push(value);
    git.run(Some(path), &args, cancel)
        .await
        .map(|_| ())
        .map_err(|error| {
            if error.code == "GIT_FAILED" {
                Failure::invalid("The Git reference format is invalid.")
            } else {
                error
            }
        })
}

async fn branch_name(git: &Git, path: &Path, name: &str, cancel: &CancellationToken) -> Result<()> {
    if name.is_empty() || name.len() > 240 || name.starts_with('-') || name.contains("@{") {
        return Err(Failure::invalid("Enter a valid local branch name."));
    }
    git.run(Some(path), &["check-ref-format", "--branch", name], cancel)
        .await
        .map(|_| ())
        .map_err(|error| {
            if error.code == "GIT_FAILED" {
                Failure::invalid("Enter a valid local branch name.")
            } else {
                error
            }
        })
}

async fn ref_oid(
    git: &Git,
    path: &Path,
    reference: &str,
    cancel: &CancellationToken,
) -> Result<Option<String>> {
    match git
        .run(
            Some(path),
            &["show-ref", "--verify", "--hash", "--", reference],
            cancel,
        )
        .await
    {
        Ok(bytes) => Ok(Some(
            parse::oid(bytes.strip_suffix(b"\n").unwrap_or(&bytes)).ok_or_else(|| {
                Failure::new(
                    "INVALID_GIT_OUTPUT",
                    "Git returned an invalid reference tip.",
                )
            })?,
        )),
        Err(error) if matches!(error.exit_code, Some(1 | 128)) => Ok(None),
        Err(error) => Err(error),
    }
}

fn capture<'a>(pattern: &str, reference: &'a str) -> Option<&'a str> {
    if let Some((prefix, suffix)) = pattern.split_once('*') {
        reference.strip_prefix(prefix)?.strip_suffix(suffix)
    } else {
        (pattern == reference).then_some("")
    }
}

fn tracking_refs(specs: &[Refspec], source: &str) -> Vec<String> {
    if specs
        .iter()
        .any(|spec| spec.destination.is_none() && capture(&spec.source, source).is_some())
    {
        return Vec::new();
    }
    let mut targets: Vec<_> = specs
        .iter()
        .filter_map(|spec| {
            let dest = spec.destination.as_ref()?;
            Some(dest.replace('*', capture(&spec.source, source)?))
        })
        .collect();
    targets.sort_unstable();
    targets.dedup();
    targets
}

fn refspec_error() -> Failure {
    unsupported("The remote has unsupported fetch mappings. GitDesk can fetch branch refs into this remote's tracking namespace.")
}

async fn fetch_specs(
    git: &Git,
    path: &Path,
    name: &str,
    required: bool,
    cancel: &CancellationToken,
) -> Result<Vec<Refspec>> {
    let prefix = format!("refs/remotes/{name}/");
    let values = config(git, path, &format!("remote.{name}.fetch"), cancel).await?;
    if values.len() > 64 {
        return Err(refspec_error());
    }
    let mut specs = Vec::new();
    for value in values {
        if let Some(source) = value.strip_prefix('^') {
            if !source.starts_with("refs/heads/") {
                return Err(refspec_error());
            }
            check_ref(git, path, source, true, cancel).await?;
            specs.push(Refspec {
                source: source.into(),
                destination: None,
                force: false,
            });
            continue;
        }
        let (force, mapping) = value
            .strip_prefix('+')
            .map_or((false, value.as_str()), |mapping| (true, mapping));
        let (source, destination) = mapping.split_once(':').ok_or_else(refspec_error)?;
        if !source.starts_with("refs/heads/")
            || !destination.starts_with(&prefix)
            || source.contains('*') != destination.contains('*')
        {
            return Err(refspec_error());
        }
        check_ref(git, path, source, true, cancel).await?;
        check_ref(git, path, destination, true, cancel).await?;
        specs.push(Refspec {
            source: source.into(),
            destination: Some(destination.into()),
            force,
        });
    }
    if !required {
        return Ok(specs);
    }
    if !specs.iter().any(|spec| spec.destination.is_some()) {
        return Err(refspec_error());
    }

    // A tracking symref can point outside this namespace. Exclude its source
    // from the fetch explicitly, including the usual refs/remotes/origin/HEAD.
    let raw = git
        .run(
            Some(path),
            &["for-each-ref", "--format=%(refname)%00%(symref)", &prefix],
            cancel,
        )
        .await?;
    for row in lines(&raw)? {
        let (reference, symbolic) = row.split_once('\0').ok_or_else(refspec_error)?;
        if symbolic.is_empty() {
            continue;
        }
        let excluded: Vec<_> = specs
            .iter()
            .filter_map(|spec| {
                let destination = spec.destination.as_ref()?;
                let source = spec.source.replace('*', capture(destination, reference)?);
                Some(Refspec {
                    source,
                    destination: None,
                    force: false,
                })
            })
            .collect();
        specs.extend(excluded);
        if specs.len() > 128 {
            return Err(refspec_error());
        }
    }
    Ok(specs)
}

async fn remote(
    git: &Git,
    path: &Path,
    name: &str,
    pushing: bool,
    cancel: &CancellationToken,
) -> Result<Remote> {
    if !valid_remote(name)
        || !remotes(git, path, cancel)
            .await?
            .iter()
            .any(|known| known == name)
    {
        return Err(Failure::invalid("Choose a configured Git remote."));
    }
    let mut args = vec!["remote", "get-url", "--all"];
    if pushing {
        args.push("--push");
        let key = format!("remote.{name}.mirror");
        match git
            .run(
                Some(path),
                &["config", "--type=bool", "--get-all", &key],
                cancel,
            )
            .await
        {
            Ok(bytes) if bytes != b"false\n" => {
                return Err(unsupported("Mirror remotes are unavailable for Push."))
            }
            Ok(_) => {}
            Err(error) if error.exit_code == Some(1) => {}
            Err(error) => return Err(error),
        }
    }
    args.extend(["--", name]);
    let urls = lines(&git.run(Some(path), &args, cancel).await?)?;
    if urls.len() != 1 || urls[0].is_empty() || urls[0].as_bytes().iter().any(u8::is_ascii_control)
    {
        return Err(unsupported(
            "This operation needs a remote with exactly one transport URL.",
        ));
    }
    if let Some((scheme, _)) = urls[0].split_once("://") {
        if !matches!(scheme, "file" | "git" | "ssh" | "http" | "https") {
            return Err(unsupported(
                "This remote uses a transport that GitDesk cannot run.",
            ));
        }
    } else if urls[0].contains("::") && !Path::new(&urls[0]).is_absolute() {
        return Err(unsupported(
            "External Git transport helpers are unavailable in GitDesk.",
        ));
    }
    let specs = fetch_specs(git, path, name, !pushing, cancel).await?;
    Ok(Remote {
        name: name.into(),
        urls,
        specs,
    })
}

async fn upstream(
    git: &Git,
    path: &Path,
    branch: &str,
    pushing: bool,
    cancel: &CancellationToken,
) -> Result<Upstream> {
    let remote_names = config(git, path, &format!("branch.{branch}.remote"), cancel).await?;
    let sources = config(git, path, &format!("branch.{branch}.merge"), cancel).await?;
    let ([name], [source]) = (remote_names.as_slice(), sources.as_slice()) else {
        return Err(Failure::new(
            "NO_UPSTREAM",
            "Configure a single upstream for this branch in Terminal, then try again.",
        ));
    };
    if !source.starts_with("refs/heads/") || name == "." {
        return Err(Failure::new(
            "NO_UPSTREAM",
            "This branch needs an upstream on a configured remote.",
        ));
    }
    check_ref(git, path, source, false, cancel).await?;
    let mut remote = remote(git, path, name, pushing, cancel).await?;
    if pushing {
        // Git may update the configured local tracking ref after a successful push.
        // The normal namespace validation also applies to this implicit write.
        for reference in tracking_refs(&remote.specs, source) {
            match git
                .run(Some(path), &["symbolic-ref", "--quiet", &reference], cancel)
                .await
            {
                Ok(_) => return Err(unsupported("Push cannot update a symbolic tracking ref.")),
                Err(error) if error.exit_code == Some(1) => {}
                Err(error) => return Err(error),
            }
        }
        return Ok(Upstream {
            remote,
            source: source.clone(),
            tracking: None,
            previous_tip: None,
        });
    }
    let targets = tracking_refs(&remote.specs, source);
    let [destination] = targets.as_slice() else {
        return Err(unsupported(
            "Pull needs a fetch mapping from the upstream branch to a single tracking ref.",
        ));
    };
    let force = remote.specs.iter().any(|spec| {
        spec.force
            && spec.destination.as_ref().is_some_and(|dest| {
                capture(&spec.source, source)
                    .is_some_and(|part| dest.replace('*', part) == *destination)
            })
    });
    remote.specs = vec![Refspec {
        source: source.clone(),
        destination: Some(destination.clone()),
        force,
    }];
    let previous_tip = ref_oid(git, path, destination, cancel).await?;
    Ok(Upstream {
        remote,
        source: source.clone(),
        tracking: Some(destination.clone()),
        previous_tip,
    })
}

async fn clean_head(
    git: &Git,
    path: &Path,
    common: &Path,
    cancel: &CancellationToken,
) -> Result<Head> {
    let status = repository::write_status(git, path, common, cancel).await?;
    if status.status.kind == "conflict" {
        return Err(Failure::new(
            "CONFLICT",
            "Resolve worktree conflicts before running this operation.",
        ));
    }
    if status.status.operation != "none" {
        return Err(Failure::new(
            "BUSY",
            "Finish the current Git operation in this worktree first.",
        ));
    }
    if status.status.branch_name_unavailable {
        return Err(unsupported(
            "GitDesk cannot safely operate on this branch name.",
        ));
    }
    if status.status.filter_limited {
        return Err(Failure::new("STATUS_UNVERIFIED", "Some file changes could not be verified with Git clean filters disabled. Check the worktree in Terminal."));
    }
    if status.status.kind != "clean" {
        return Err(Failure::new(
            "DIRTY",
            "This operation requires a clean worktree. Review Changes first.",
        ));
    }
    Ok(Head {
        branch: status.branch,
        head: status.head,
    })
}

pub async fn prepare(
    git: &Git,
    path: PathBuf,
    common: &Path,
    bare: bool,
    action: &Action,
    expected: &Head,
    cancel: &CancellationToken,
) -> Result<Plan> {
    if let Action::Fetch { remote: name } = action {
        let remote = remote(git, &path, name, false, cancel).await?;
        // Fetch is scoped to remote-tracking refs and is safe in a dirty, bare or detached worktree.
        return Ok(Plan {
            path,
            head: Head {
                branch: None,
                head: None,
            },
            target: Target::Fetch(remote),
            proxy: RepositoryProxy::default(),
        });
    }
    if bare {
        return Err(unsupported(
            "This operation requires a worktree with working files.",
        ));
    }
    let head = clean_head(git, &path, common, cancel).await?;
    if &head != expected {
        return Err(stale());
    }
    let oid = head
        .head
        .as_deref()
        .ok_or_else(|| unsupported("This worktree needs an initial commit."))?;
    diff::validate_oid(oid)?;
    let target = match action {
        Action::Create { name } => {
            branch_name(git, &path, name, cancel).await?;
            if ref_oid(git, &path, &format!("refs/heads/{name}"), cancel)
                .await?
                .is_some()
            {
                return Err(Failure::invalid(
                    "A local branch with this name already exists.",
                ));
            }
            Target::Create(name.clone())
        }
        Action::Switch { name } => {
            branch_name(git, &path, name, cancel).await?;
            if head.branch.as_ref() == Some(name) {
                return Err(Failure::invalid("This worktree is already on that branch."));
            }
            let reference = format!("refs/heads/{name}");
            let oid = ref_oid(git, &path, &reference, cancel)
                .await?
                .ok_or_else(|| Failure::invalid("Choose an existing local branch."))?;
            let entries = git
                .run(
                    Some(&path),
                    &["worktree", "list", "--porcelain", "-z"],
                    cancel,
                )
                .await?;
            if parse::worktrees(&entries)?
                .iter()
                .any(|tree| tree.branch.as_deref() == Some(name))
            {
                return Err(Failure::new(
                    "BRANCH_IN_USE",
                    "This branch is checked out in another worktree. Open that worktree to use it.",
                ));
            }
            Target::Switch(name.clone(), oid)
        }
        Action::Pull | Action::Push => {
            let branch = head.branch.as_deref().ok_or_else(|| {
                unsupported("Switch to a local branch before syncing its upstream.")
            })?;
            let pushing = matches!(action, Action::Push);
            let upstream = upstream(git, &path, branch, pushing, cancel).await?;
            if pushing {
                Target::Push(upstream)
            } else {
                Target::Pull(upstream)
            }
        }
        Action::Fetch { .. } => unreachable!(),
    };
    Ok(Plan {
        path,
        head,
        target,
        proxy: RepositoryProxy::default(),
    })
}

async fn fetch(
    git: &Git,
    path: &Path,
    remote: &Remote,
    proxy: &RepositoryProxy,
    cancel: &CancellationToken,
) -> Result<()> {
    let refspecs: Vec<_> = remote.specs.iter().map(Refspec::argument).collect();
    let proxy_override = remote.proxy_override(proxy);
    let mut args = Vec::new();
    if let Some(setting) = &proxy_override {
        args.extend(["-c", setting]);
    }
    args.extend([
        "fetch",
        "--no-all",
        "--upload-pack=git-upload-pack",
        "--atomic",
        "--no-tags",
        "--no-prune",
        "--no-prune-tags",
        "--no-recurse-submodules",
        "--no-auto-maintenance",
        "--no-write-fetch-head",
        "--no-update-shallow",
        "--no-write-commit-graph",
        "--refmap=",
        "--",
        &remote.name,
    ]);
    args.extend(refspecs.iter().map(String::as_str));
    git.write(
        path,
        &args,
        WriteMode::Network {
            ignore_no_proxy: matches!(proxy, RepositoryProxy::Custom { .. }),
        },
        cancel,
    )
    .await
}

async fn is_ancestor(
    git: &Git,
    path: &Path,
    base: &str,
    tip: &str,
    cancel: &CancellationToken,
) -> Result<bool> {
    match git
        .run(
            Some(path),
            &["merge-base", "--is-ancestor", base, tip],
            cancel,
        )
        .await
    {
        Ok(_) => Ok(true),
        Err(error) if error.exit_code == Some(1) => Ok(false),
        Err(error) => Err(error),
    }
}

pub async fn execute(
    git: &Git,
    common: &Path,
    plan: &Plan,
    cancel: &CancellationToken,
) -> Result<()> {
    let path = &plan.path;
    match &plan.target {
        Target::Fetch(remote) => fetch(git, path, remote, &plan.proxy, cancel).await,
        Target::Create(name) => {
            git.write(
                path,
                &[
                    "branch",
                    "--no-track",
                    "--",
                    name,
                    plan.head.head.as_deref().unwrap(),
                ],
                WriteMode::Local,
                cancel,
            )
            .await
        }
        Target::Switch(name, _) => {
            git.write(
                path,
                &[
                    "switch",
                    "--no-guess",
                    "--no-overwrite-ignore",
                    "--no-recurse-submodules",
                    "--",
                    name,
                ],
                WriteMode::Local,
                cancel,
            )
            .await
        }
        Target::Push(upstream) => {
            let refspec = format!("{}:{}", plan.head.head.as_deref().unwrap(), upstream.source);
            let mirror = format!("remote.{}.mirror=false", upstream.remote.name);
            let proxy_override = upstream.remote.proxy_override(&plan.proxy);
            let mut args = Vec::new();
            if let Some(setting) = &proxy_override {
                args.extend(["-c", setting]);
            }
            args.extend([
                "-c",
                &mirror,
                "push",
                "--no-follow-tags",
                "--receive-pack=git-receive-pack",
                "--no-set-upstream",
                "--no-recurse-submodules",
                "--",
                &upstream.remote.name,
                &refspec,
            ]);
            git.write(
                path,
                &args,
                WriteMode::Network {
                    ignore_no_proxy: matches!(plan.proxy, RepositoryProxy::Custom { .. }),
                },
                cancel,
            )
            .await
        }
        Target::Pull(upstream) => {
            fetch(git, path, &upstream.remote, &plan.proxy, cancel).await?;
            if clean_head(git, path, common, cancel).await? != plan.head {
                return Err(stale());
            }
            let branch = plan.head.branch.as_deref().unwrap();
            let after_fetch = self::upstream(git, path, branch, false, cancel).await?;
            if after_fetch.remote != upstream.remote
                || after_fetch.source != upstream.source
                || after_fetch.tracking != upstream.tracking
            {
                return Err(stale());
            }
            let tip = after_fetch.previous_tip.as_deref().ok_or_else(|| {
                Failure::new(
                    "MISSING_REMOTE_REF",
                    "The upstream tracking ref is missing after Fetch.",
                )
            })?;
            let head = plan.head.head.as_deref().unwrap();
            if head == tip {
                return Ok(());
            }
            if !is_ancestor(git, path, head, tip, cancel).await? {
                if is_ancestor(git, path, tip, head, cancel).await? {
                    return Ok(());
                }
                return Err(Failure::new(
                    "NON_FAST_FORWARD",
                    "Pull requires a fast-forward. Inspect the local and upstream histories.",
                ));
            }
            let options = format!("branch.{branch}.mergeOptions=");
            git.write(
                path,
                &[
                    "-c",
                    "submodule.recurse=false",
                    "-c",
                    &options,
                    "merge",
                    "--ff-only",
                    "--no-autostash",
                    "--no-overwrite-ignore",
                    "--no-edit",
                    "--",
                    tip,
                ],
                WriteMode::Local,
                cancel,
            )
            .await
        }
    }
}

#[cfg(test)]
mod tests;
