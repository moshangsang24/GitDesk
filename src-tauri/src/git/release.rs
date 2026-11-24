use super::{
    diff::{require_commit, validate_oid},
    executor::Git,
    history::{read_commit, shallow_stamp},
    repository,
};
use crate::model::{Failure, GitRef, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::io::BufReader;
use tokio_util::sync::CancellationToken;

pub const MAX_COMMITS: usize = 200;
pub const MAX_TASKS: usize = 100;
pub type Targets = [Option<String>; 3];

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseData {
    pub target_revision: u64,
    pub targets: Targets,
    pub tasks: Vec<Task>,
    #[serde(default)]
    pub observations: Vec<Observation>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskFields {
    pub title: String,
    pub issue: String,
    pub source: String,
    pub commit_oids: Vec<String>,
    pub base_oid: Option<String>,
    pub head_oid: Option<String>,
    pub archived: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub revision: u64,
    pub fields: TaskFields,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub revisions: Vec<TaskFields>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StageState {
    Ready,
    Unconfigured,
    Missing,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Inclusion {
    Included,
    NotContained,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub oid: String,
    pub status: Inclusion,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub target: Option<String>,
    pub tip: Option<String>,
    pub state: StageState,
    pub observed_at: u64,
    pub reason: Option<String>,
    pub evidence: Vec<Evidence>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub task_id: String,
    pub task_revision: u64,
    pub target_revision: u64,
    pub stage: usize,
    pub snapshot: Snapshot,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Evaluation {
    pub target_revision: u64,
    pub task_revision: Option<u64>,
    pub stages: Vec<Snapshot>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidates {
    pub commits: Vec<super::history::HistoryCommit>,
    pub truncated: bool,
    pub base_oid: String,
    pub head_oid: String,
}

pub fn normalize_oids(oids: &mut Vec<String>) -> Result<()> {
    if oids.is_empty() || oids.len() > MAX_COMMITS {
        return Err(Failure::invalid("Select between 1 and 200 commits."));
    }
    let mut seen = HashSet::new();
    for oid in oids.iter_mut() {
        validate_oid(oid)?;
        oid.make_ascii_lowercase();
    }
    oids.retain(|oid| seen.insert(oid.clone()));
    Ok(())
}

impl TaskFields {
    pub fn normalize(&mut self) -> Result<()> {
        self.title = self.title.trim().into();
        if self.title.is_empty()
            || self.title.len() > 240
            || self.issue.len() > 120
            || self.source.len() > 2048
        {
            return Err(Failure::invalid(
                "Enter a task title and shorten any overly long fields.",
            ));
        }
        for oid in [&self.base_oid, &self.head_oid].into_iter().flatten() {
            validate_oid(oid)?;
        }
        normalize_oids(&mut self.commit_oids)
    }
}

pub fn remote_target<'a>(refs: &'a [GitRef], name: &str) -> Option<&'a GitRef> {
    refs.iter().find(|item| {
        item.kind == "remote" && item.symbolic_target.is_none() && item.full_name == name
    })
}

pub async fn candidates(
    git: &Git,
    path: &Path,
    base: String,
    head: String,
    cancel: &CancellationToken,
) -> Result<Candidates> {
    require_commit(git, path, &base, cancel).await?;
    require_commit(git, path, &head, cancel).await?;
    let range = format!("{base}..{head}");
    let output = git
        .run(
            Some(path),
            &[
                "log",
                "--topo-order",
                "--no-merges",
                "--max-count=201",
                "--no-patch",
                "--no-color",
                "--no-notes",
                "--no-show-signature",
                "--encoding=UTF-8",
                "-z",
                "--format=%H%x00%P%x00%an%x00%at%x00%s",
                &range,
                "--",
            ],
            cancel,
        )
        .await?;
    let mut reader = BufReader::new(output.as_slice());
    let mut budget = output.len() + 1;
    let empty = HashSet::new();
    let mut commits = Vec::new();
    while let Some(commit) = read_commit(&mut reader, &empty, &mut budget).await? {
        commits.push(commit);
    }
    let truncated = commits.len() > MAX_COMMITS;
    commits.truncate(MAX_COMMITS);
    Ok(Candidates {
        commits,
        truncated,
        base_oid: base,
        head_oid: head,
    })
}

struct Evaluator<'a> {
    git: &'a Git,
    path: &'a Path,
    cancel: &'a CancellationToken,
    uncertain_negative: bool,
    available: HashMap<String, bool>,
    by_tip: HashMap<String, Vec<Evidence>>,
}

impl Evaluator<'_> {
    async fn contains(&mut self, oid: &str, tip: &str) -> Result<Evidence> {
        if self.cancel.is_cancelled() {
            return Err(Failure::cancelled());
        }
        let available = match self.available.get(oid) {
            Some(&value) => value,
            None => {
                let result = require_commit(self.git, self.path, oid, self.cancel).await;
                if let Err(error) = &result {
                    if error.code == "CANCELLED" {
                        return Err(error.clone());
                    }
                }
                self.available.insert(oid.to_owned(), result.is_ok());
                result.is_ok()
            }
        };
        let (status, reason) = if available {
            match self
                .git
                .run(
                    Some(self.path),
                    &["merge-base", "--is-ancestor", oid, tip],
                    self.cancel,
                )
                .await
            {
                Ok(_) => (Inclusion::Included, None),
                Err(error) if error.exit_code == Some(1) && !self.uncertain_negative => {
                    (Inclusion::NotContained, None)
                }
                Err(error) if error.exit_code == Some(1) => (
                    Inclusion::Unknown,
                    Some("The history is shallow or partial."),
                ),
                Err(error) if error.code == "CANCELLED" => return Err(error),
                Err(_) => (
                    Inclusion::Unknown,
                    Some("Git could not establish ancestry."),
                ),
            }
        } else {
            (
                Inclusion::Unknown,
                Some("The commit object could not be read."),
            )
        };
        Ok(Evidence {
            oid: oid.into(),
            status,
            reason: reason.map(str::to_owned),
        })
    }

    async fn check(&mut self, tip: &str, oids: &[String]) -> Result<Vec<Evidence>> {
        if let Some(result) = self.by_tip.get(tip) {
            return Ok(result.clone());
        }
        // One revision walk proves inclusion for a batch, with exact queries for unvisited OIDs.
        let walk = if oids.len() >= 10 {
            match self
                .git
                .run(
                    Some(self.path),
                    &["rev-list", "--max-count=20000", tip, "--"],
                    self.cancel,
                )
                .await
            {
                Ok(bytes) => bytes,
                Err(error) if error.code == "CANCELLED" => return Err(error),
                Err(_) => Vec::new(),
            }
        } else {
            Vec::new()
        };
        let visited: HashSet<_> = walk
            .split(|byte| *byte == b'\n')
            .filter(|oid| !oid.is_empty())
            .collect();
        let mut result = Vec::with_capacity(oids.len());
        for oid in oids {
            if visited.contains(oid.as_bytes()) {
                result.push(Evidence {
                    oid: oid.clone(),
                    status: Inclusion::Included,
                    reason: None,
                });
            } else {
                result.push(self.contains(oid, tip).await?);
            }
        }
        self.by_tip.insert(tip.to_owned(), result.clone());
        Ok(result)
    }
}

impl Snapshot {
    fn from_tip(target: Option<String>, tip: Option<String>) -> Self {
        let state = if target.is_none() {
            StageState::Unconfigured
        } else if tip.is_none() {
            StageState::Missing
        } else {
            StageState::Ready
        };
        let observed_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        Self {
            target,
            tip,
            state,
            observed_at,
            reason: None,
            evidence: Vec::new(),
        }
    }
    fn invalidate(&mut self) {
        self.state = StageState::Unknown;
        self.reason = Some(
            "The target or shallow boundary changed during this read. Refresh to retry.".into(),
        );
        self.evidence.clear();
    }
}

pub async fn evaluate(
    git: &Git,
    path: &Path,
    common: &Path,
    targets: &Targets,
    oids: &[String],
    cancel: &CancellationToken,
) -> Result<Vec<Snapshot>> {
    if targets.iter().all(Option::is_none) {
        return Ok(targets
            .iter()
            .map(|_| Snapshot::from_tip(None, None))
            .collect());
    }
    let shallow = shallow_stamp(common)?;
    let partial = match git
        .run(
            Some(path),
            &[
                "config",
                "--get-regexp",
                r"^(extensions\.partialclone|remote\..*\.promisor)$",
            ],
            cancel,
        )
        .await
    {
        Ok(_) => true,
        Err(error) if error.code == "CANCELLED" => return Err(error),
        Err(error) => error.exit_code != Some(1),
    };
    let mut evaluator = Evaluator {
        git,
        path,
        cancel,
        uncertain_negative: shallow.is_some() || partial,
        available: HashMap::new(),
        by_tip: HashMap::new(),
    };
    let mut refs = repository::read_refs(git, path, cancel).await?;
    let mut stages = Vec::with_capacity(targets.len());
    for target in targets {
        let tip = |refs: &[GitRef]| {
            target
                .as_deref()
                .and_then(|name| remote_target(refs, name))
                .map(|item| item.target_oid.clone())
        };
        let mut snap = Snapshot::from_tip(target.clone(), tip(&refs));
        if target.is_some() {
            for attempt in 0..2 {
                if let Some(oid) = &snap.tip {
                    snap.evidence = evaluator.check(oid, oids).await?;
                }
                let latest = repository::read_refs(git, path, cancel).await?;
                let head = tip(&latest);
                refs = latest;
                if snap.tip == head {
                    break;
                }
                if attempt == 0 {
                    snap = Snapshot::from_tip(target.clone(), head);
                } else {
                    snap.invalidate();
                }
            }
        }
        stages.push(snap);
    }
    let final_refs = repository::read_refs(git, path, cancel).await?;
    let boundary_changed = shallow_stamp(common)? != shallow;
    for snap in &mut stages {
        if let Some(target) = &snap.target {
            if boundary_changed
                || snap.tip.as_deref()
                    != remote_target(&final_refs, target).map(|ref_| ref_.target_oid.as_str())
            {
                snap.invalidate();
            }
        }
    }
    Ok(stages)
}

impl ReleaseData {
    pub fn record(&mut self, task: &Task, stages: &[Snapshot]) -> bool {
        let mut changed = false;
        for (stage, snapshot) in stages.iter().enumerate() {
            if snapshot.state == StageState::Unknown || snapshot.state == StageState::Unconfigured {
                continue;
            }
            let last = self
                .observations
                .iter()
                .rev()
                .find(|entry| entry.task_id == task.id && entry.stage == stage);
            if last.is_some_and(|entry| {
                entry.task_revision == task.revision
                    && entry.target_revision == self.target_revision
                    && entry.snapshot.tip == snapshot.tip
                    && entry.snapshot.target == snapshot.target
                    && entry.snapshot.evidence == snapshot.evidence
                    && entry.snapshot.state == snapshot.state
            }) {
                continue;
            }

            self.observations.push(Observation {
                task_id: task.id.clone(),
                task_revision: task.revision,
                target_revision: self.target_revision,
                stage,
                snapshot: snapshot.clone(),
            });
            let count = self
                .observations
                .iter()
                .filter(|entry| entry.task_id == task.id && entry.stage == stage)
                .count();
            if count > 50 {
                if let Some(oldest) = self
                    .observations
                    .iter()
                    .position(|entry| entry.task_id == task.id && entry.stage == stage)
                {
                    self.observations.remove(oldest);
                }
            }
            changed = true;
        }
        if self.observations.len() > 750 {
            self.observations.drain(..self.observations.len() - 750);
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_distinct_target_and_task_versions_and_limits_observations() {
        let mut config = ReleaseData::default();
        let mut task = Task {
            id: "ticket".into(),
            revision: 1,
            revisions: Vec::new(),
            fields: TaskFields {
                title: "Task".into(),
                issue: String::new(),
                source: String::new(),
                commit_oids: vec!["a".repeat(40)],
                base_oid: None,
                head_oid: None,
                archived: false,
            },
        };
        let first = Snapshot::from_tip(
            Some("refs/remotes/origin/test/current".into()),
            Some("b".repeat(40)),
        );
        assert!(config.record(&task, std::slice::from_ref(&first)));
        assert!(!config.record(&task, std::slice::from_ref(&first)));
        config.target_revision += 1;
        let second = Snapshot::from_tip(
            Some("refs/remotes/origin/test/next".into()),
            Some("a".repeat(40)),
        );
        assert!(config.record(&task, std::slice::from_ref(&second)));
        assert_eq!(config.observations[0].snapshot.target, first.target);
        assert_eq!(config.observations[1].target_revision, 1);
        task.revision += 1;
        assert!(config.record(&task, std::slice::from_ref(&second)));
        for number in 0..52 {
            let snapshot =
                Snapshot::from_tip(second.target.clone(), Some(format!("{number:040x}")));
            assert!(config.record(&task, &[snapshot]));
        }
        assert_eq!(config.observations.len(), 50);
        assert!(config
            .observations
            .iter()
            .all(|entry| entry.target_revision == 1 && entry.task_revision == 2));
    }
}
