use std::{
    env,
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdout, Command},
    sync::{OwnedSemaphorePermit, Semaphore},
    time::timeout,
};
use tokio_util::sync::CancellationToken;

use crate::model::{Failure, Result};

pub const OUTPUT_LIMIT: usize = 4 * 1024 * 1024;
pub const READ_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Clone, Copy)]
pub enum WriteMode {
    Local,
    Network { ignore_no_proxy: bool },
}

pub struct Git {
    executable: PathBuf,
    slots: Arc<Semaphore>,
    history_slots: Arc<Semaphore>,
}

pub struct HistoryProcess {
    pub child: Child,
    pub stdout: BufReader<ChildStdout>,
    _slot: OwnedSemaphorePermit,
}

impl Git {
    pub async fn discover(configured: Option<&Path>, cancel: &CancellationToken) -> Result<Self> {
        let known = [
            "/opt/homebrew/bin/git",
            "/usr/local/bin/git",
            "/usr/bin/git",
        ];
        let mut candidates: Vec<PathBuf> = configured.into_iter().map(Path::to_path_buf).collect();
        candidates.extend(known.into_iter().map(PathBuf::from));
        if let Some(path) = env::var_os("PATH") {
            candidates.extend(
                env::split_paths(&path)
                    .filter(|path| path.is_absolute())
                    .map(|path| path.join("git")),
            );
        }

        for executable in candidates {
            if !executable.is_absolute() || !executable.is_file() {
                continue;
            }
            let git = Self {
                executable,
                slots: Arc::new(Semaphore::new(4)),
                history_slots: Arc::new(Semaphore::new(1)),
            };
            match git.run(None, &["--version"], cancel).await {
                Ok(output) if output.starts_with(b"git version ") => return Ok(git),
                Err(error) if error.code == "CANCELLED" => return Err(error),
                _ => {}
            }
        }

        Err(Failure::new(
            "GIT_NOT_FOUND",
            "Git is unavailable. Install the macOS Command Line Tools or Git, then reopen GitDesk.",
        ))
    }

    pub async fn run(
        &self,
        directory: Option<&Path>,
        args: &[&str],
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>> {
        self.run_with_input(directory, args, None, cancel).await
    }

    pub async fn run_with_input(
        &self,
        directory: Option<&Path>,
        args: &[&str],
        input: Option<&[u8]>,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>> {
        let operation = async {
            let _slot = self
                .slots
                .acquire()
                .await
                .map_err(|_| Failure::new("IO_ERROR", "Git executor closed."))?;
            let mut command = self.read_command(directory, args);
            if input.is_some() {
                command.stdin(Stdio::piped());
            }
            let mut child = command
                .spawn()
                .map_err(|_| Failure::new("IO_ERROR", "Could not start Git."))?;
            let stdout = child.stdout.take().expect("Git stdout is piped");
            let stdin = child.stdin.take();
            // Read stdout while waiting. On an overflow/cancel/timeout the child is killed.
            let (output, status, ()) = tokio::try_join!(
                read_limited(stdout, OUTPUT_LIMIT),
                async {
                    child
                        .wait()
                        .await
                        .map_err(|_| Failure::new("IO_ERROR", "Could not wait for Git."))
                },
                async move {
                    if let (Some(mut stdin), Some(input)) = (stdin, input) {
                        stdin.write_all(input).await.map_err(|_| {
                            Failure::new("IO_ERROR", "Git could not read its input.")
                        })?;
                    }
                    Ok(())
                }
            )?;
            if !status.success() {
                let mut error = Failure::new("GIT_FAILED", "Git could not read this repository.");
                error.exit_code = status.code();
                return Err(error);
            }
            Ok(output)
        };

        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(Failure::cancelled()),
            result = timeout(READ_TIMEOUT, operation) => result.unwrap_or_else(|_| Err(Failure::new("TIMEOUT", "Git timed out while reading the repository."))),
        }
    }

    pub async fn revision_log(
        &self,
        directory: &Path,
        roots: &[String],
        options: &[&str],
        cancel: &CancellationToken,
    ) -> Result<HistoryProcess> {
        self.open_log(&self.slots, directory, roots, options, cancel)
            .await
    }

    pub async fn history_log(
        &self,
        directory: &Path,
        roots: &[String],
        options: &[&str],
        cancel: &CancellationToken,
    ) -> Result<HistoryProcess> {
        self.open_log(&self.history_slots, directory, roots, options, cancel)
            .await
    }

    async fn open_log(
        &self,
        slots: &Arc<Semaphore>,
        directory: &Path,
        roots: &[String],
        options: &[&str],
        cancel: &CancellationToken,
    ) -> Result<HistoryProcess> {
        let operation = async {
            let slot = slots
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| Failure::new("IO_ERROR", "Git executor closed."))?;
            let mut args = vec![
                "log",
                "--topo-order",
                "--stdin",
                "--no-color",
                "--no-show-signature",
                "--no-notes",
                "--no-decorate",
                "--no-patch",
                "--encoding=UTF-8",
                "-z",
            ];
            args.extend_from_slice(options);
            args.push("--");
            let mut child = self
                .read_command(Some(directory), &args)
                .stdin(Stdio::piped())
                .spawn()
                .map_err(|_| Failure::new("IO_ERROR", "Could not start Git history."))?;
            let stdout = BufReader::new(child.stdout.take().expect("Git stdout is piped"));
            let mut input = child.stdin.take().expect("Git stdin is piped");
            input
                .write_all(roots.join("\n").as_bytes())
                .await
                .map_err(|_| Failure::new("GIT_FAILED", "Git could not read the history roots."))?;
            input
                .write_all(b"\n")
                .await
                .map_err(|_| Failure::new("GIT_FAILED", "Git could not read the history roots."))?;
            drop(input);
            Ok(HistoryProcess {
                child,
                stdout,
                _slot: slot,
            })
        };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(Failure::cancelled()),
            result = timeout(READ_TIMEOUT, operation) => result.unwrap_or_else(|_| Err(Failure::new("TIMEOUT", "Git timed out while opening history."))),
        }
    }

    pub async fn worktree_read(
        &self,
        directory: Option<&Path>,
        args: &[&str],
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>> {
        Ok(self
            .worktree_read_with_filters(directory, args, cancel)
            .await?
            .0)
    }

    pub async fn worktree_read_with_filters(
        &self,
        directory: Option<&Path>,
        args: &[&str],
        cancel: &CancellationToken,
    ) -> Result<(Vec<u8>, Vec<String>)> {
        // Worktree comparisons may apply attribute filters before comparing file bytes.
        let filters = match self
            .run(
                directory,
                &[
                    "config",
                    "--null",
                    "--name-only",
                    "--get-regexp",
                    r"^filter\..*\.(clean|process|required)$",
                ],
                cancel,
            )
            .await
        {
            Ok(bytes) => bytes,
            Err(error) if error.exit_code == Some(1) => Vec::new(),
            Err(error) => return Err(error),
        };
        let keys = std::str::from_utf8(&filters)
            .map_err(|_| Failure::invalid("Unsupported Git filter configuration."))?;
        let mut overrides = Vec::new();
        let mut drivers = Vec::new();
        for key in keys
            .trim_end_matches('\0')
            .split('\0')
            .filter(|key| !key.is_empty())
        {
            if key.contains('=') || overrides.len() >= 256 {
                return Err(Failure::invalid("Unsupported Git filter configuration."));
            }
            let value = if key.ends_with(".required") {
                "false"
            } else {
                ""
            };
            overrides.push(format!("{key}={value}"));
            if let Some((driver, _)) = key
                .strip_prefix("filter.")
                .and_then(|name| name.rsplit_once('.'))
            {
                drivers.push(driver.to_owned());
            }
        }
        let mut arguments = Vec::new();
        for setting in &overrides {
            arguments.extend(["-c", setting.as_str()]);
        }
        arguments.extend_from_slice(args);
        Ok((self.run(directory, &arguments, cancel).await?, drivers))
    }

    pub async fn write(
        &self,
        directory: &Path,
        args: &[&str],
        mode: WriteMode,
        cancel: &CancellationToken,
    ) -> Result<()> {
        if cancel.is_cancelled() {
            return Err(Failure::cancelled());
        }
        let mut command = self.read_command(Some(directory), args);
        command
            .process_group(0)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .env("GIT_ASKPASS", "/usr/bin/false")
            .env_remove("SSH_ASKPASS")
            .env("SSH_ASKPASS_REQUIRE", "never")
            .env("GCM_INTERACTIVE", "Never");
        if let WriteMode::Network { ignore_no_proxy } = mode {
            command.env("GIT_ALLOW_PROTOCOL", "file:git:http:https:ssh");
            if ignore_no_proxy {
                command.env_remove("NO_PROXY").env_remove("no_proxy");
            }
        }
        let mut child = command
            .spawn()
            .map_err(|_| Failure::new("IO_ERROR", "Could not start Git."))?;
        let group = child
            .id()
            .and_then(|id| rustix::process::Pid::from_raw(id as i32));
        let mut stderr = child.stderr.take().expect("Git stderr is piped");
        let operation = async {
            let diagnostics = async {
                // Drain the pipe so a verbose hook cannot block Git. Never expose its raw output.
                let mut saved = Vec::new();
                let mut buffer = [0_u8; 4096];
                loop {
                    let count = stderr.read(&mut buffer).await?;
                    if count == 0 {
                        break;
                    }
                    let keep = count.min((64 * 1024_usize).saturating_sub(saved.len()));
                    saved.extend_from_slice(&buffer[..keep]);
                }
                Ok::<_, std::io::Error>(saved)
            };
            let (status, diagnostics) =
                tokio::try_join!(child.wait(), diagnostics).map_err(|_| {
                    Failure::new("IO_ERROR", "Could not read the Git operation result.")
                })?;
            if status.success() {
                return Ok(());
            }
            let output = String::from_utf8_lossy(&diagnostics).to_ascii_lowercase();
            let mut failure = write_failure(&output);
            failure.exit_code = status.code();
            Err(failure)
        };
        let duration = Duration::from_secs(if matches!(mode, WriteMode::Network { .. }) {
            180
        } else {
            45
        });
        let interruption = tokio::select! {
            biased;
            result = timeout(duration, operation) => match result {
                Ok(result) => return result,
                Err(_) => Failure::new("TIMEOUT", "Git timed out. Check the refreshed repository before retrying."),
            },
            _ = cancel.cancelled() => Failure::new("CANCELLED", "The Git operation was cancelled. Check the refreshed repository before retrying."),
        };
        if let Some(group) = group {
            let _ = rustix::process::kill_process_group(group, rustix::process::Signal::TERM);
            if timeout(Duration::from_secs(2), child.wait()).await.is_err() {
                let _ = rustix::process::kill_process_group(group, rustix::process::Signal::KILL);
            }
        }
        let _ = child.kill().await;
        Err(interruption)
    }

    fn read_command(&self, directory: Option<&Path>, args: &[&str]) -> Command {
        let mut command = Command::new(&self.executable);
        command
            .args(read_arguments(directory, args))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for (key, _) in env::vars_os() {
            if key.to_string_lossy().starts_with("GIT_") {
                command.env_remove(key);
            }
        }
        command
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_NO_REPLACE_OBJECTS", "1")
            .env("GIT_GRAFT_FILE", "/dev/null")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_ALLOW_PROTOCOL", "")
            .env("LC_ALL", "C");
        command
    }
}

fn write_failure(output: &str) -> Failure {
    let (code, message) = if [
        "could not resolve proxy",
        "failed to connect to proxy",
        "proxy connect",
        "connect tunnel failed",
        "proxy authentication",
        "failed to receive socks",
    ]
    .iter()
    .any(|value| output.contains(value))
    {
        (
            "PROXY_UNAVAILABLE",
            "Git could not connect through the proxy. Check this repository’s proxy setting.",
        )
    } else if [
        "ssl certificate problem",
        "unable to get local issuer certificate",
        "certificate verify failed",
    ]
    .iter()
    .any(|value| output.contains(value))
    {
        ("TLS_CERTIFICATE", "Git could not verify the remote’s TLS certificate. Check your organization’s Git certificate configuration.")
    } else if [
        "authentication failed",
        "could not read username",
        "permission denied (publickey",
        "terminal prompts disabled",
        "could not read password",
        "authority credentials",
    ]
    .iter()
    .any(|value| output.contains(value))
    {
        ("AUTH_REQUIRED", "Git could not authenticate. Verify your Git credentials or SSH agent in Terminal, then try again.")
    } else if [
        "non-fast-forward",
        "fetch first",
        "not possible to fast-forward",
    ]
    .iter()
    .any(|value| output.contains(value))
    {
        (
            "NON_FAST_FORWARD",
            "Git rejected a non-fast-forward update. Inspect the local and remote histories.",
        )
    } else if output.contains("already checked out") || output.contains("already used by worktree")
    {
        (
            "BRANCH_IN_USE",
            "This branch is checked out in another worktree. Open that worktree to use it.",
        )
    } else if output.contains("would be overwritten") {
        ("DIRTY", "Git stopped because the operation would overwrite working files, including ignored files.")
    } else if output.contains("cannot lock ref") || output.contains("index.lock") {
        (
            "BUSY",
            "Git could not acquire a lock. Check for another Git operation and try again.",
        )
    } else if output.contains("couldn't find remote ref") {
        (
            "MISSING_REMOTE_REF",
            "The branch is missing on the remote. Verify the upstream in Terminal.",
        )
    } else if output.contains("hook") || output.contains("remote rejected") {
        ("REJECTED", "A Git hook or remote policy rejected the operation. Check the repository or remote policy in Terminal.")
    } else if [
        "access denied",
        "repository not found",
        "host key verification failed",
        "could not resolve host",
        "could not resolve hostname",
        "connection refused",
        "failed to connect",
        "couldn't connect to server",
        "connection timed out",
        "operation timed out",
        "ssl_error_syscall",
        "does not appear to be a git repository",
    ]
    .iter()
    .any(|value| output.contains(value))
    {
        ("REMOTE_UNAVAILABLE", "Git could not reach or access the remote. Verify the remote and its access in Terminal.")
    } else {
        ("GIT_FAILED", "Git did not complete this operation. Inspect the refreshed repository and check Git in Terminal.")
    };
    Failure::new(code, message)
}

fn read_arguments(directory: Option<&Path>, args: &[&str]) -> Vec<OsString> {
    let mut command: Vec<OsString> = [
        "--no-pager",
        "--no-optional-locks",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    if let Some(directory) = directory {
        command.push("-C".into());
        command.push(directory.as_os_str().into());
    }
    command.extend(args.iter().map(OsString::from));
    command
}

pub async fn read_limited(input: impl AsyncRead + Unpin, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    input
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| Failure::new("IO_ERROR", "Could not read Git output."))?;
    if bytes.len() > limit {
        return Err(Failure::new(
            "OUTPUT_LIMIT",
            "This Git read exceeded the output limit.",
        ));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_the_directory_as_one_argument_and_disables_optional_writes() {
        let path = Path::new("/tmp/a b;$(command)");
        let args = read_arguments(Some(path), &["status", "--porcelain=v2"]);
        let position = args.iter().position(|item| item == "-C").unwrap();
        assert_eq!(args[position + 1], path.as_os_str());
        assert_eq!(args[position + 2], "status");
        assert!(args.iter().any(|item| item == "--no-optional-locks"));
        assert!(args.iter().any(|item| item == "core.fsmonitor=false"));
    }

    #[tokio::test]
    async fn limits_output_before_returning_it() {
        assert_eq!(
            read_limited(&b"hello"[..], 4).await.unwrap_err().code,
            "OUTPUT_LIMIT"
        );
        assert_eq!(read_limited(&b"hello"[..], 5).await.unwrap(), b"hello");
    }

    #[test]
    fn classifies_authentication_without_exposing_credentials() {
        let failure = write_failure(
            "fatal: authentication failed for https://person:secret@example.invalid/private",
        );
        assert_eq!(failure.code, "AUTH_REQUIRED");
        assert!(!failure.message.contains("secret"));
        assert!(!failure.message.contains("example.invalid"));
    }
}
