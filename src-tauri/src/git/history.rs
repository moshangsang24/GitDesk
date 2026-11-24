use super::{
    executor::{read_limited, Git, HistoryProcess, OUTPUT_LIMIT, READ_TIMEOUT},
    my_branches::{self, AuthorFilter},
};
use crate::model::{Failure, GitRef, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt},
    sync::{mpsc, oneshot},
    time::timeout,
};
use tokio_util::sync::CancellationToken;

const PAGE_SIZE: usize = 500;
const MAX_COMMITS: usize = 100_000;
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HistoryScope {
    All,
    Current,
    Local,
    Ref,
    Mine,
}

pub struct HistoryInput {
    pub path: PathBuf,
    pub common_dir: PathBuf,
    pub head: Option<String>,
    pub refs: Vec<GitRef>,
}

impl HistoryInput {
    fn roots(
        &self,
        scope: HistoryScope,
        ref_name: Option<&str>,
        mine: Option<&BTreeSet<String>>,
    ) -> Result<Vec<String>> {
        let mut roots = Vec::new();
        if matches!(scope, HistoryScope::Current | HistoryScope::All) {
            roots.extend(self.head.iter().cloned());
        }
        match scope {
            HistoryScope::All => roots.extend(self.refs.iter().map(|item| item.target_oid.clone())),
            HistoryScope::Local => roots.extend(
                self.refs
                    .iter()
                    .filter(|item| item.kind == "local")
                    .map(|item| item.target_oid.clone()),
            ),
            HistoryScope::Ref => {
                let target = self
                    .refs
                    .iter()
                    .find(|item| Some(item.full_name.as_str()) == ref_name)
                    .ok_or_else(|| {
                        Failure::new(
                            "REF_MISSING",
                            "The focused reference no longer exists. Choose another history scope.",
                        )
                    })?;
                roots.push(target.target_oid.clone());
            }
            HistoryScope::Mine => {
                let names = mine
                    .ok_or_else(|| Failure::invalid("Choose a commit author and a base branch."))?;
                roots.extend(
                    self.refs
                        .iter()
                        .filter(|item| names.contains(&item.full_name))
                        .map(|item| item.target_oid.clone()),
                );
            }
            HistoryScope::Current => {}
        }
        let mut seen = HashSet::new();
        roots.retain(|oid| seen.insert(oid.clone()));
        if roots.iter().any(|oid| !full_oid(oid.as_bytes())) {
            return Err(invalid_history());
        }
        Ok(roots)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCommit {
    pub oid: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_time: i64,
    pub subject: String,
    pub shallow_boundary: bool,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub sequence: u32,
    pub commits: Vec<HistoryCommit>,
    pub has_more: bool,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenHistory {
    pub page: HistoryPage,
    pub head: Option<String>,
    pub refs: Vec<GitRef>,
    pub shallow_stamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub my_branch_refs: Option<BTreeSet<String>>,
}

pub struct PageRequest {
    sequence: u32,
    reply: oneshot::Sender<Result<HistoryPage>>,
}

#[derive(Default)]
pub struct HistorySessions {
    entries: Mutex<HashMap<String, (CancellationToken, mpsc::Sender<PageRequest>)>>,
}

impl HistorySessions {
    pub fn start(&self, id: &str) -> Result<(CancellationToken, mpsc::Receiver<PageRequest>)> {
        if id.is_empty()
            || id.len() > 64
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(Failure::invalid("Invalid history session ID."));
        }
        let mut entries = self.entries.lock().unwrap();
        if entries
            .get(id)
            .is_some_and(|(_, sender)| !sender.is_closed())
        {
            return Err(Failure::new(
                "BUSY",
                "Another history request is still closing. Refresh to try again.",
            ));
        }
        // The desktop has a single History view. A new session also replaces a
        // stream left behind by a reloaded WebView.
        for (_, (token, _)) in entries.drain() {
            token.cancel();
        }
        let (sender, receiver) = mpsc::channel(1);
        let cancel = CancellationToken::new();
        entries.insert(id.into(), (cancel.clone(), sender));
        Ok((cancel, receiver))
    }

    pub fn close(&self, id: &str) {
        if let Some((cancel, _)) = self.entries.lock().unwrap().remove(id) {
            cancel.cancel();
        }
    }

    pub async fn page(&self, id: &str, sequence: u32) -> Result<HistoryPage> {
        let sender = self
            .entries
            .lock()
            .unwrap()
            .get(id)
            .map(|(_, sender)| sender.clone())
            .ok_or_else(expired)?;
        let (reply, result) = oneshot::channel();
        sender
            .try_send(PageRequest { sequence, reply })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => {
                    Failure::new("BUSY", "A page of history is already being read.")
                }
                mpsc::error::TrySendError::Closed(_) => expired(),
            })?;
        result.await.map_err(|_| expired())?
    }
}

impl Drop for HistorySessions {
    fn drop(&mut self) {
        if let Ok(entries) = self.entries.get_mut() {
            for (cancel, _) in entries.values() {
                cancel.cancel();
            }
        }
    }
}

pub async fn open(
    git: &Git,
    input: HistoryInput,
    scope: HistoryScope,
    ref_name: Option<&str>,
    author_filter: Option<&AuthorFilter>,
    cancel: CancellationToken,
    receiver: mpsc::Receiver<PageRequest>,
) -> Result<OpenHistory> {
    let stamp = shallow_stamp(&input.common_dir)?;
    let my_branch_refs = if matches!(scope, HistoryScope::Mine) {
        let filter = author_filter
            .ok_or_else(|| Failure::invalid("Choose a commit author and a base branch."))?;
        Some(my_branches::matching_refs(git, &input, filter, &cancel).await?)
    } else {
        None
    };
    let roots = input.roots(scope, ref_name, my_branch_refs.as_ref())?;
    let page = if roots.is_empty() {
        HistoryPage::default()
    } else {
        let shallow = read_shallow(input.common_dir.join("shallow")).await?;
        let process = git
            .history_log(
                &input.path,
                &roots,
                &["--format=%H%x00%P%x00%an%x00%at%x00%s"],
                &cancel,
            )
            .await?;
        let mut stream = HistoryStream {
            process,
            shallow,
            next: None,
            count: 0,
        };
        let page = stream.read_page(0, &cancel).await?;
        if stamp != shallow_stamp(&input.common_dir)? {
            return Err(Failure::new(
                "STALE",
                "The shallow history boundary changed. Refresh history.",
            ));
        }
        if page.has_more {
            tokio::spawn(stream.serve(receiver, cancel));
        }
        page
    };
    Ok(OpenHistory {
        page,
        head: input.head,
        refs: input.refs,
        shallow_stamp: stamp,
        my_branch_refs,
    })
}

pub fn shallow_stamp(common_dir: &Path) -> Result<Option<String>> {
    let metadata = match std::fs::symlink_metadata(common_dir.join("shallow")) {
        Ok(value) if value.is_file() => value,
        Ok(_) => return Err(invalid_history()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(io_error()),
    };
    let time = metadata.modified().map_err(|_| io_error())?;
    let stamp = match time.duration_since(UNIX_EPOCH) {
        Ok(past) => past.as_nanos().to_string(),
        Err(future) => format!("-{}", future.duration().as_nanos()),
    };
    Ok(Some(format!("{stamp}:{}", metadata.len())))
}

struct HistoryStream {
    process: HistoryProcess,
    shallow: HashSet<String>,
    next: Option<HistoryCommit>,
    count: usize,
}

impl HistoryStream {
    async fn serve(mut self, mut requests: mpsc::Receiver<PageRequest>, cancel: CancellationToken) {
        let mut sequence = 1;
        loop {
            let request = tokio::select! {
                biased;
                _ = cancel.cancelled() => return,
                result = timeout(IDLE_TIMEOUT, requests.recv()) => result.ok().flatten(),
            };
            let Some(request) = request else { return };
            if request.sequence != sequence {
                let _ = request.reply.send(Err(Failure::new(
                    "STALE",
                    "History pages arrived out of sequence. Refresh history.",
                )));
                continue;
            }
            let page = self.read_page(sequence, &cancel).await;
            let has_more = page.as_ref().is_ok_and(|page| page.has_more);
            if request.reply.send(page).is_err() || !has_more {
                return;
            }
            sequence += 1;
        }
    }

    async fn read_page(
        &mut self,
        sequence: u32,
        cancel: &CancellationToken,
    ) -> Result<HistoryPage> {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(Failure::cancelled()),
            result = timeout(READ_TIMEOUT, self.take_page(sequence)) => result.unwrap_or_else(|_| Err(Failure::new("TIMEOUT", "Git timed out while reading history."))),
        }
    }

    async fn take_page(&mut self, sequence: u32) -> Result<HistoryPage> {
        let size = PAGE_SIZE.min(MAX_COMMITS - self.count);
        let mut commits = Vec::with_capacity(size);
        let mut budget = OUTPUT_LIMIT;
        if let Some(first) = self.next.take() {
            commits.push(first);
        }
        while commits.len() < size {
            let Some(commit) =
                read_commit(&mut self.process.stdout, &self.shallow, &mut budget).await?
            else {
                break;
            };
            commits.push(commit);
        }
        if commits.len() == size {
            self.next = read_commit(&mut self.process.stdout, &self.shallow, &mut budget).await?;
        }
        if self.next.is_none() {
            let status = self.process.child.wait().await.map_err(|_| io_error())?;
            if !status.success() {
                let mut failure = Failure::new(
                    "GIT_FAILED",
                    "Git could not read the complete commit history.",
                );
                failure.exit_code = status.code();
                return Err(failure);
            }
        }
        self.count += commits.len();
        let truncated = self.next.is_some() && self.count == MAX_COMMITS;
        Ok(HistoryPage {
            sequence,
            commits,
            has_more: self.next.is_some() && !truncated,
            truncated,
        })
    }
}

pub(super) async fn read_shallow(path: PathBuf) -> Result<HashSet<String>> {
    let metadata = match tokio::fs::symlink_metadata(&path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashSet::new()),
        Err(_) => return Err(io_error()),
    };
    if !metadata.is_file() {
        return Err(invalid_history());
    }
    let file = tokio::fs::File::open(path).await.map_err(|_| io_error())?;
    let bytes = read_limited(file, OUTPUT_LIMIT).await?;
    bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(parse_oid)
        .collect()
}

pub(super) async fn read_commit(
    input: &mut (impl AsyncBufRead + Unpin),
    shallow: &HashSet<String>,
    budget: &mut usize,
) -> Result<Option<HistoryCommit>> {
    let Some([oid, parents, author, time, subject]) = read_fields(input, budget).await? else {
        return Ok(None);
    };
    let oid = parse_oid(&oid)?;
    let parents = parse_parents(&parents)?;
    let author_time: i64 = std::str::from_utf8(&time)
        .ok()
        .and_then(|time| time.parse().ok())
        .ok_or_else(invalid_history)?;
    if author_time.unsigned_abs() > 8_640_000_000_000 {
        return Err(invalid_history());
    }
    Ok(Some(HistoryCommit {
        shallow_boundary: shallow.contains(&oid),
        oid,
        parents,
        author_time,
        author_name: String::from_utf8_lossy(&author).into_owned(),
        subject: String::from_utf8_lossy(&subject).into_owned(),
    }))
}

pub(super) async fn read_fields<const N: usize>(
    input: &mut (impl AsyncBufRead + Unpin),
    budget: &mut usize,
) -> Result<Option<[Vec<u8>; N]>> {
    let mut fields: [Vec<u8>; N] = std::array::from_fn(|_| Vec::new());
    for (index, field) in fields.iter_mut().enumerate() {
        let count = (&mut *input)
            .take(*budget as u64)
            .read_until(0, field)
            .await
            .map_err(|_| io_error())?;
        if count == 0 && index == 0 && *budget != 0 {
            return Ok(None);
        }
        *budget -= count;
        if field.pop() != Some(0) {
            return Err(if *budget == 0 {
                Failure::new(
                    "OUTPUT_LIMIT",
                    "This page of Git history exceeded the output limit.",
                )
            } else {
                invalid_history()
            });
        }
    }
    Ok(Some(fields))
}

pub(super) fn parse_parents(parents: &[u8]) -> Result<Vec<String>> {
    parents
        .split(|byte| *byte == b' ')
        .filter(|part| !part.is_empty())
        .map(parse_oid)
        .collect()
}

pub(super) fn full_oid(bytes: &[u8]) -> bool {
    matches!(bytes.len(), 40 | 64)
        && bytes.iter().all(u8::is_ascii_hexdigit)
        && bytes.iter().any(|byte| *byte != b'0')
}

pub(super) fn parse_oid(bytes: &[u8]) -> Result<String> {
    if !full_oid(bytes) {
        return Err(invalid_history());
    }
    Ok(String::from_utf8_lossy(bytes).into_owned())
}

fn io_error() -> Failure {
    Failure::new("IO_ERROR", "Could not read Git history.")
}
fn invalid_history() -> Failure {
    Failure::new(
        "INVALID_GIT_OUTPUT",
        "Git returned an invalid commit history record.",
    )
}
fn expired() -> Failure {
    Failure::new(
        "STALE",
        "This history session expired. Refresh to continue.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    #[tokio::test]
    async fn parses_split_records_with_empty_fields_and_shallow_metadata() {
        let oid = "a".repeat(64);
        let shallow = HashSet::from([oid.clone()]);
        let bytes = format!("{oid}\0\0林\x000\0\0");
        let mut reader = BufReader::with_capacity(3, bytes.as_bytes());
        let mut budget = OUTPUT_LIMIT;
        let record = read_commit(&mut reader, &shallow, &mut budget)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(record.oid, oid);
        assert_eq!(record.author_name, "林");
        assert_eq!(record.author_time, 0);
        assert!(record.parents.is_empty() && record.subject.is_empty() && record.shallow_boundary);
        assert!(read_commit(&mut reader, &shallow, &mut budget)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn rejects_truncated_records_and_stops_at_the_byte_limit() {
        let oid = "a".repeat(40);
        let bytes = format!("{oid}\0\0Author\x000\0unfinished");
        let shallow = HashSet::new();
        for (mut limit, code) in [(OUTPUT_LIMIT, "INVALID_GIT_OUTPUT"), (8, "OUTPUT_LIMIT")] {
            let mut reader = BufReader::with_capacity(4, bytes.as_bytes());
            assert_eq!(
                read_commit(&mut reader, &shallow, &mut limit)
                    .await
                    .unwrap_err()
                    .code,
                code
            );
        }
    }
}
