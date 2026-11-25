use super::{
    executor::Git,
    history::{read_commit, HistoryCommit, HistoryInput},
    release::{remote_target, Targets},
};
use crate::model::{Failure, Result};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::Path};
use tokio::io::BufReader;
use tokio_util::sync::CancellationToken;

const PAGE_SIZE: usize = 50;
const MAX_DIFFERENCES: usize = 100_000;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub head: Option<String>,
    pub target_revision: u64,
    pub targets: Targets,
    pub tips: Targets,
    pub shallow_stamp: Option<String>,
}

impl Comparison {
    pub fn new(
        input: &HistoryInput,
        target_revision: u64,
        targets: Targets,
        shallow_stamp: Option<String>,
    ) -> Self {
        let tips = targets.each_ref().map(|name| {
            name.as_deref()
                .and_then(|name| remote_target(&input.refs, name))
                .map(|reference| reference.target_oid.clone())
        });
        Self {
            head: input.head.clone(),
            target_revision,
            targets,
            tips,
            shallow_stamp,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Current,
    Target,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Query {
    Summary,
    Commits {
        stage: usize,
        direction: Direction,
        offset: usize,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Count {
    Ready { ahead: u64, behind: u64 },
    Unknown { reason: String },
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Answer {
    Summary {
        stages: [Option<Count>; 3],
    },
    Commits {
        commits: Vec<HistoryCommit>,
        has_more: bool,
        truncated: bool,
    },
}

async fn count(git: &Git, path: &Path, range: &str, cancel: &CancellationToken) -> Result<Count> {
    let output = git
        .run(
            Some(path),
            &["rev-list", "--left-right", "--count", range, "--"],
            cancel,
        )
        .await?;
    let counts = std::str::from_utf8(&output)
        .unwrap_or("")
        .split_whitespace();
    let mut counts = counts.map(str::parse::<u64>);
    match (counts.next(), counts.next(), counts.next()) {
        (Some(Ok(ahead)), Some(Ok(behind)), None) => Ok(Count::Ready { ahead, behind }),
        _ => Err(Failure::new(
            "GIT_FAILED",
            "Git returned invalid comparison counts.",
        )),
    }
}

pub async fn read(
    git: &Git,
    path: &Path,
    comparison: &Comparison,
    query: Query,
    cancel: &CancellationToken,
) -> Result<Answer> {
    let incomplete = "This shallow clone does not contain enough history to compare branches.";
    match query {
        Query::Summary => {
            let mut stages: [Option<Count>; 3] = Default::default();
            for (index, tip) in comparison.tips.iter().enumerate() {
                let (Some(head), Some(tip)) = (&comparison.head, tip) else {
                    continue;
                };
                let result = if comparison.shallow_stamp.is_some() && head != tip {
                    Count::Unknown {
                        reason: incomplete.into(),
                    }
                } else if let Some(previous) = comparison.tips[..index]
                    .iter()
                    .position(|value| value.as_ref() == Some(tip))
                {
                    stages[previous]
                        .clone()
                        .ok_or_else(|| Failure::invalid("Invalid comparison target."))?
                } else {
                    match count(git, path, &format!("{head}...{tip}"), cancel).await {
                        Ok(result) => result,
                        Err(error) if error.code == "CANCELLED" => return Err(error),
                        Err(error) => Count::Unknown {
                            reason: error.message,
                        },
                    }
                };
                stages[index] = Some(result);
            }
            Ok(Answer::Summary { stages })
        }
        Query::Commits {
            stage,
            direction,
            offset,
        } => {
            if offset >= MAX_DIFFERENCES || offset % PAGE_SIZE != 0 {
                return Err(Failure::invalid("Invalid comparison page."));
            }
            let head = comparison
                .head
                .as_deref()
                .ok_or_else(|| Failure::invalid("This worktree has no HEAD commit."))?;
            let tip = comparison
                .tips
                .get(stage)
                .and_then(Option::as_deref)
                .ok_or_else(|| Failure::invalid("The comparison target is unavailable."))?;
            if comparison.shallow_stamp.is_some() && head != tip {
                return Err(Failure::invalid(incomplete));
            }
            let side = match direction {
                Direction::Current => "--left-only",
                Direction::Target => "--right-only",
            };
            let output = git
                .run(
                    Some(path),
                    &[
                        "log",
                        "--topo-order",
                        side,
                        &format!("--skip={offset}"),
                        &format!("--max-count={}", PAGE_SIZE + 1),
                        "--no-show-signature",
                        "--encoding=UTF-8",
                        "-z",
                        "--format=%H%x00%P%x00%an%x00%at%x00%s",
                        &format!("{head}...{tip}"),
                        "--",
                    ],
                    cancel,
                )
                .await?;
            let mut reader = BufReader::new(output.as_slice());
            let mut budget = output.len() + 1;
            let shallow = HashSet::new();
            let mut commits = Vec::new();
            while let Some(commit) = read_commit(&mut reader, &shallow, &mut budget).await? {
                commits.push(commit);
            }
            let has_more = commits.len() > PAGE_SIZE;
            commits.truncate(PAGE_SIZE);
            let truncated = has_more && offset + commits.len() >= MAX_DIFFERENCES;
            Ok(Answer::Commits {
                commits,
                has_more: has_more && !truncated,
                truncated,
            })
        }
    }
}
