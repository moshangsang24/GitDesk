use super::{
    executor::{Git, READ_TIMEOUT},
    history::{full_oid, parse_oid, parse_parents, read_fields, shallow_stamp, HistoryInput},
};
use crate::model::{Failure, GitRef, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeSet, HashSet},
    path::Path,
};
use tokio::{io::BufReader, time::timeout};
use tokio_util::sync::CancellationToken;

const MAX_COMMITS: usize = 100_000;
const SCAN_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct CommitAuthor {
    pub name: String,
    pub email: String,
}

impl CommitAuthor {
    fn is_valid(&self) -> bool {
        !self.name.is_empty()
            && self.name.len() <= 1024
            && self.email.len() <= 1024
            && !self.name.contains('\0')
            && !self.email.contains('\0')
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorFilter {
    pub author: CommitAuthor,
    pub base_ref: String,
}

fn branch(reference: &GitRef) -> bool {
    matches!(reference.kind, "local" | "remote") && reference.symbolic_target.is_none()
}

pub async fn list_authors(
    git: &Git,
    directory: &Path,
    cancel: &CancellationToken,
) -> Result<Vec<CommitAuthor>> {
    let bytes = git
        .run(
            Some(directory),
            &[
                "log",
                "--branches",
                "--remotes",
                "--max-count=5000",
                "--no-patch",
                "--no-color",
                "--no-notes",
                "--no-show-signature",
                "--encoding=UTF-8",
                "-z",
                "--format=%an%x00%ae",
                "--",
            ],
            cancel,
        )
        .await?;
    let mut reader = BufReader::new(bytes.as_slice());
    let mut budget = bytes.len() + 1;
    let mut authors = BTreeSet::new();
    while let Some([name, email]) = read_fields(&mut reader, &mut budget).await? {
        if let (Ok(name), Ok(email)) = (String::from_utf8(name), String::from_utf8(email)) {
            let author = CommitAuthor { name, email };
            if author.is_valid() {
                authors.insert(author);
            }
        }
    }
    Ok(authors.into_iter().collect())
}

pub async fn matching_refs(
    git: &Git,
    input: &HistoryInput,
    filter: &AuthorFilter,
    cancel: &CancellationToken,
) -> Result<BTreeSet<String>> {
    if !filter.author.is_valid() {
        return Err(Failure::invalid(
            "Choose an author from the repository's commits.",
        ));
    }
    let base = input
        .refs
        .iter()
        .find(|item| branch(item) && item.full_name == filter.base_ref)
        .ok_or_else(|| {
            Failure::new(
                "REF_MISSING",
                "The base branch is unavailable. Choose a base branch again.",
            )
        })?;
    let boundary = shallow_stamp(&input.common_dir)?;
    if boundary.is_some() {
        return Err(Failure::new(
            "SHALLOW_HISTORY",
            "My branches needs complete history to compare the base branch.",
        ));
    }
    let mut roots: Vec<_> = input
        .refs
        .iter()
        .filter(|item| branch(item))
        .map(|item| item.target_oid.clone())
        .collect();
    roots.sort_unstable();
    roots.dedup();
    if roots.iter().any(|oid| !full_oid(oid.as_bytes())) {
        return Err(Failure::new(
            "INVALID_GIT_OUTPUT",
            "A branch tip did not contain a full commit ID.",
        ));
    }
    roots.push(format!("^{}", base.target_oid));
    let scan = async {
        let max_count = format!("--max-count={}", MAX_COMMITS + 1);
        let mut log = git
            .revision_log(
                &input.path,
                &roots,
                &["--reverse", &max_count, "--format=%H%x00%P%x00%an%x00%ae"],
                cancel,
            )
            .await?;
        let mut budget = SCAN_BYTES;
        let mut matched = HashSet::new();
        let mut count = 0;
        // Reversing topological order visits parents before their descendants.
        while let Some([oid, parents, name, email]) =
            read_fields(&mut log.stdout, &mut budget).await?
        {
            count += 1;
            if count > MAX_COMMITS {
                return Err(Failure::new(
                    "HISTORY_LIMIT",
                    "Too many commits to compare with this base branch. Choose a newer base.",
                ));
            }
            let oid = parse_oid(&oid)?;
            let parents = parse_parents(&parents)?;
            if name == filter.author.name.as_bytes() && email == filter.author.email.as_bytes()
                || parents.iter().any(|parent| matched.contains(parent))
            {
                matched.insert(oid);
            }
        }
        let status = log
            .child
            .wait()
            .await
            .map_err(|_| Failure::new("IO_ERROR", "Could not finish comparing branches."))?;
        if !status.success() {
            return Err(Failure::new(
                "GIT_FAILED",
                "Git could not read the complete history for the selected base.",
            ));
        }
        if shallow_stamp(&input.common_dir)? != boundary {
            return Err(Failure::new(
                "STALE",
                "The history boundary changed. Refresh to compare branches again.",
            ));
        }
        Ok(input
            .refs
            .iter()
            .filter(|item| branch(item) && matched.contains(&item.target_oid))
            .map(|item| item.full_name.clone())
            .collect())
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(Failure::cancelled()),
        result = timeout(READ_TIMEOUT, scan) => result.unwrap_or_else(|_| Err(Failure::new("TIMEOUT", "Git timed out comparing branches with the selected base."))),
    }
}
