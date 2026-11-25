use super::{
    config::Config,
    review::{anchor, Request},
    WorkspaceState,
};
use crate::{
    git::{
        diff,
        release::{
            self, Candidates, CommitLink, Evaluation, Observation, ReleaseData, Targets, Task,
            TaskFields, MAX_LINKS, MAX_TASKS,
        },
        repository,
    },
    model::{Failure, Result},
};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    target_revision: u64,
    targets: Targets,
    tasks: Vec<Task>,
}

fn overview(data: &ReleaseData) -> Overview {
    let mut tasks = data.tasks.clone();
    for task in &mut tasks {
        task.revisions.clear();
    }
    Overview {
        target_revision: data.target_revision,
        targets: data.targets.clone(),
        tasks,
    }
}

fn stale() -> Failure {
    Failure::new(
        "STALE",
        "The release targets or task changed. Reload and try again.",
    )
}

fn registered(config: &Config, repo_id: &str) -> Result<()> {
    if config
        .workspaces
        .iter()
        .flat_map(|workspace| workspace.locations())
        .any(|location| location.id() == repo_id)
    {
        Ok(())
    } else {
        Err(Failure::invalid("This repository is no longer registered."))
    }
}

#[tauri::command]
pub fn get_release_overview(state: State<'_, WorkspaceState>, repo_id: String) -> Result<Overview> {
    let store = state.configuration.lock().unwrap();
    registered(&store.value, &repo_id)?;
    Ok(overview(
        store
            .value
            .releases
            .get(&repo_id)
            .unwrap_or(&ReleaseData::default()),
    ))
}

#[tauri::command]
pub async fn save_release_targets(
    state: State<'_, WorkspaceState>,
    repo_id: String,
    targets: Targets,
    revision: u64,
    request_id: String,
) -> Result<Overview> {
    let request = Request::start(&state, request_id)?;
    let git = state.git(&request.token).await?;
    let location = anchor(&state, git, &repo_id, &request.token).await?;
    let refs = repository::read_refs(git, &location.anchor, &request.token).await?;
    let mut store = state.configuration.lock().unwrap();
    registered(&store.value, &repo_id)?;
    let empty = ReleaseData::default();
    let current = store.value.releases.get(&repo_id).unwrap_or(&empty);
    if revision != current.target_revision {
        return Err(stale());
    }
    for (stage, target) in targets.iter().enumerate() {
        if let Some(target) = target {
            if target != current.targets[stage].as_deref().unwrap_or("")
                && release::remote_target(&refs, target).is_none()
            {
                return Err(Failure::invalid(
                    "Choose an existing remote-tracking branch.",
                ));
            }
        }
    }
    if targets == current.targets {
        return Ok(overview(current));
    }
    store.update(|config| {
        if request.token.is_cancelled() {
            return Err(Failure::cancelled());
        }
        let data = config.releases.entry(repo_id.clone()).or_default();
        data.targets = targets;
        data.target_revision += 1;
        Ok(())
    })?;
    Ok(overview(&store.value.releases[&repo_id]))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskEdit {
    id: String,
    revision: Option<u64>,
    fields: TaskFields,
}

#[tauri::command]
pub async fn save_release_task(
    state: State<'_, WorkspaceState>,
    repo_id: String,
    mut edit: TaskEdit,
    request_id: String,
) -> Result<Overview> {
    if edit.id.is_empty()
        || edit.id.len() > 64
        || !edit
            .id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(Failure::invalid("Invalid task ID."));
    }
    edit.fields.normalize()?;
    edit.fields.links.clear();
    let request = Request::start(&state, request_id)?;
    let git = state.git(&request.token).await?;
    let location = anchor(&state, git, &repo_id, &request.token).await?;
    let previous = {
        let store = state.configuration.lock().unwrap();
        let task = store
            .value
            .releases
            .get(&repo_id)
            .and_then(|data| data.tasks.iter().find(|task| task.id == edit.id));
        if task.map(|task| task.revision) != edit.revision {
            return Err(stale());
        }
        task.map(|task| task.fields.commit_oids.clone())
            .unwrap_or_default()
    };
    for oid in &edit.fields.commit_oids {
        if !previous.contains(oid) {
            diff::require_commit(git, &location.anchor, oid, &request.token).await?;
        }
    }
    let mut store = state.configuration.lock().unwrap();
    store.update(|config| {
        if request.token.is_cancelled() {
            return Err(Failure::cancelled());
        }
        registered(config, &repo_id)?;
        let data = config.releases.entry(repo_id.clone()).or_default();
        if let Some(task) = data.tasks.iter_mut().find(|task| task.id == edit.id) {
            if Some(task.revision) != edit.revision {
                return Err(stale());
            }
            edit.fields.links = task
                .fields
                .links
                .iter()
                .filter(|link| edit.fields.commit_oids.contains(&link.source_oid))
                .cloned()
                .collect();
            task.replace_fields(edit.fields);
        } else {
            if edit.revision.is_some() {
                return Err(stale());
            }
            if data.tasks.len() >= MAX_TASKS {
                return Err(Failure::invalid(
                    "This repository already has 100 tracked tasks.",
                ));
            }
            data.tasks.push(Task {
                id: edit.id,
                revision: 1,
                fields: edit.fields,
                revisions: Vec::new(),
            });
        }
        Ok(())
    })?;
    Ok(overview(&store.value.releases[&repo_id]))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkEdit {
    pub task_id: String,
    pub revision: u64,
    pub target_revision: u64,
    pub stage: usize,
    pub source_oids: Vec<String>,
    pub target_oid: String,
    pub expected_tip: Option<String>,
    pub remove: bool,
}

#[tauri::command]
pub async fn edit_release_links(
    state: State<'_, WorkspaceState>,
    repo_id: String,
    mut edit: LinkEdit,
    request_id: String,
) -> Result<Overview> {
    release::normalize_oids(&mut edit.source_oids)?;
    diff::validate_oid(&edit.target_oid)?;
    edit.target_oid.make_ascii_lowercase();
    if edit.source_oids.contains(&edit.target_oid) {
        return Err(Failure::invalid("Choose a different commit to associate."));
    }
    let request = Request::start(&state, request_id)?;
    let target = {
        let store = state.configuration.lock().unwrap();
        registered(&store.value, &repo_id)?;
        let data = store.value.releases.get(&repo_id).ok_or_else(stale)?;
        if data.target_revision != edit.target_revision {
            return Err(stale());
        }
        data.targets
            .get(edit.stage)
            .ok_or_else(|| Failure::invalid("Invalid release stage."))?
            .clone()
    };
    if !edit.remove {
        let target = target
            .as_deref()
            .ok_or_else(|| Failure::invalid("Configure the target branch first."))?;
        let git = state.git(&request.token).await?;
        let location = anchor(&state, git, &repo_id, &request.token).await?;
        let refs = repository::read_refs(git, &location.anchor, &request.token).await?;
        let tip = &release::remote_target(&refs, target)
            .ok_or_else(stale)?
            .target_oid;
        if edit.expected_tip.as_deref() != Some(tip) {
            return Err(stale());
        }
        diff::require_commit(git, &location.anchor, &edit.target_oid, &request.token).await?;
        match git
            .run(
                Some(&location.anchor),
                &["merge-base", "--is-ancestor", &edit.target_oid, tip],
                &request.token,
            )
            .await
        {
            Ok(_) => {}
            Err(error) if error.exit_code == Some(1) => {
                return Err(Failure::invalid(
                    "Git could not prove that this commit is in the selected target branch.",
                ));
            }
            Err(error) => return Err(error),
        }
        let latest = repository::read_refs(git, &location.anchor, &request.token).await?;
        if release::remote_target(&latest, target).map(|reference| &reference.target_oid)
            != Some(tip)
        {
            return Err(stale());
        }
    }
    let mut store = state.configuration.lock().unwrap();
    store.update(|config| {
        if request.token.is_cancelled() {
            return Err(Failure::cancelled());
        }
        registered(config, &repo_id)?;
        let data = config.releases.get_mut(&repo_id).ok_or_else(stale)?;
        if data.target_revision != edit.target_revision {
            return Err(stale());
        }
        let task = data
            .tasks
            .iter_mut()
            .find(|task| task.id == edit.task_id && task.revision == edit.revision)
            .ok_or_else(stale)?;
        if edit
            .source_oids
            .iter()
            .any(|oid| !task.fields.commit_oids.contains(oid))
        {
            return Err(Failure::invalid("Select original commits from this task."));
        }
        let mut fields = task.fields.clone();
        for source_oid in edit.source_oids {
            let link = CommitLink {
                source_oid,
                target_oid: edit.target_oid.clone(),
            };
            if edit.remove {
                fields.links.retain(|existing| existing != &link);
            } else if !fields.links.contains(&link) {
                fields.links.push(link);
            }
        }
        if fields.links.len() > MAX_LINKS {
            return Err(Failure::invalid(
                "This task has too many associated commits.",
            ));
        }
        if task.fields.links != fields.links {
            config.schema_version = 3;
            task.replace_fields(fields);
        }
        Ok(())
    })?;
    Ok(overview(&store.value.releases[&repo_id]))
}

#[tauri::command]
pub fn delete_release_task(
    state: State<'_, WorkspaceState>,
    repo_id: String,
    task_id: String,
    revision: u64,
) -> Result<Overview> {
    let mut store = state.configuration.lock().unwrap();
    store.update(|config| {
        registered(config, &repo_id)?;
        let data = config.releases.get_mut(&repo_id).ok_or_else(stale)?;
        let index = data
            .tasks
            .iter()
            .position(|task| task.id == task_id && task.revision == revision)
            .ok_or_else(stale)?;
        data.tasks.remove(index);
        data.observations.retain(|entry| entry.task_id != task_id);
        Ok(())
    })?;
    Ok(overview(&store.value.releases[&repo_id]))
}

#[tauri::command]
pub fn list_release_observations(
    state: State<'_, WorkspaceState>,
    repo_id: String,
    task_id: String,
) -> Result<Vec<Observation>> {
    let store = state.configuration.lock().unwrap();
    registered(&store.value, &repo_id)?;
    Ok(store
        .value
        .releases
        .get(&repo_id)
        .into_iter()
        .flat_map(|data| data.observations.iter().rev())
        .filter(|entry| entry.task_id == task_id)
        .cloned()
        .collect())
}

#[tauri::command]
pub async fn release_candidates(
    state: State<'_, WorkspaceState>,
    repo_id: String,
    base_oid: String,
    head_oid: String,
    request_id: String,
) -> Result<Candidates> {
    let request = Request::start(&state, request_id)?;
    let git = state.git(&request.token).await?;
    let location = anchor(&state, git, &repo_id, &request.token).await?;
    release::candidates(git, &location.anchor, base_oid, head_oid, &request.token).await
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Subject {
    Task { id: String, revision: u64 },
    Commits { oids: Vec<String> },
}

#[tauri::command]
pub async fn evaluate_release(
    state: State<'_, WorkspaceState>,
    repo_id: String,
    revision: u64,
    subject: Subject,
    request_id: String,
) -> Result<Evaluation> {
    let request = Request::start(&state, request_id)?;
    let git = state.git(&request.token).await?;
    let location = anchor(&state, git, &repo_id, &request.token).await?;
    let (targets, task) = {
        let store = state.configuration.lock().unwrap();
        let empty = ReleaseData::default();
        let data = store.value.releases.get(&repo_id).unwrap_or(&empty);
        if data.target_revision != revision {
            return Err(stale());
        }
        let task = match &subject {
            Subject::Task { id, revision } => Some(
                data.tasks
                    .iter()
                    .find(|task| &task.id == id && task.revision == *revision)
                    .ok_or_else(stale)?
                    .clone(),
            ),
            Subject::Commits { .. } => None,
        };
        (data.targets.clone(), task)
    };
    let mut oids = match subject {
        Subject::Task { .. } => task.as_ref().ok_or_else(stale)?.fields.commit_oids.clone(),
        Subject::Commits { oids } => oids,
    };
    release::normalize_oids(&mut oids)?;
    let stages = release::evaluate(
        git,
        &location.anchor,
        &location.common_dir,
        &targets,
        &oids,
        task.as_ref()
            .map_or(&[][..], |task| task.fields.links.as_slice()),
        &request.token,
    )
    .await?;
    if request.token.is_cancelled() {
        return Err(Failure::cancelled());
    }
    let mut store = state.configuration.lock().unwrap();
    registered(&store.value, &repo_id)?;
    let empty = ReleaseData::default();
    let current = store.value.releases.get(&repo_id).unwrap_or(&empty);
    if current.target_revision != revision {
        return Err(stale());
    }
    if let Some(task) = &task {
        if !current
            .tasks
            .iter()
            .any(|current| current.id == task.id && current.revision == task.revision)
        {
            return Err(stale());
        }
        let mut next = current.clone();
        if next.record(task, &stages) {
            store.update(|config| {
                config.releases.insert(repo_id, next);
                Ok(())
            })?;
        }
    }
    Ok(Evaluation {
        target_revision: revision,
        task_revision: task.map(|task| task.revision),
        stages,
    })
}
