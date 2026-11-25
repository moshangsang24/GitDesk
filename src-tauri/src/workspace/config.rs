use crate::{
    git::{
        operations::FetchRecord, proxy::RepositoryProxy, release::ReleaseData, repository::Location,
    },
    model::{Failure, Result, Selection},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedWorkspace {
    pub root: PathBuf,
    #[serde(default)]
    pub discovered: Vec<Location>,
    #[serde(default)]
    pub manual: Vec<Location>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub excluded: BTreeSet<String>,
    pub warning: Option<String>,
}

impl SavedWorkspace {
    pub fn locations(&self) -> impl Iterator<Item = &Location> {
        self.discovered
            .iter()
            .chain(&self.manual)
            .filter(|location| !self.excluded.contains(&location.id()))
    }

    pub fn add_manually(&mut self, location: Location) {
        self.excluded.remove(&location.id());
        if !self
            .manual
            .iter()
            .any(|item| item.anchor == location.anchor)
        {
            self.manual.push(location);
        }
    }

    pub fn remove_repository(&mut self, repo_id: &str) {
        if self.locations().any(|item| item.id() == repo_id) {
            self.excluded.insert(repo_id.to_owned());
            self.manual.retain(|item| item.id() != repo_id);
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub schema_version: u32,
    pub workspaces: Vec<SavedWorkspace>,
    pub selection: Option<Selection>,
    pub git_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub releases: BTreeMap<String, ReleaseData>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub fetch_activity: BTreeMap<String, BTreeMap<String, FetchRecord>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub repository_proxies: BTreeMap<String, RepositoryProxy>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            schema_version: 2,
            workspaces: Vec::new(),
            selection: None,
            git_path: None,
            releases: BTreeMap::new(),
            fetch_activity: BTreeMap::new(),
            repository_proxies: BTreeMap::new(),
        }
    }
}

impl Config {
    pub fn clear_unregistered_selection(&mut self) {
        if self.selection.as_ref().is_some_and(|selection| {
            !self
                .workspaces
                .iter()
                .flat_map(SavedWorkspace::locations)
                .any(|location| location.id() == selection.repo_id)
        }) {
            self.selection = None;
        }
    }
}

pub struct ConfigStore {
    path: PathBuf,
    pub value: Config,
    pub warning: Option<String>,
    writable: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigHeader {
    schema_version: u32,
}

impl ConfigStore {
    pub fn open(path: PathBuf) -> Self {
        let mut store = Self {
            path,
            value: Config::default(),
            warning: None,
            writable: true,
        };
        let bytes = match fs::read(&store.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return store,
            Err(_) => {
                store.writable = false;
                store.warning = Some("GitDesk could not read its workspace settings.".into());
                return store;
            }
        };

        if serde_json::from_slice::<ConfigHeader>(&bytes)
            .is_ok_and(|header| !matches!(header.schema_version, 1..=3))
        {
            store.writable = false;
            store.warning =
                Some("These workspace settings need a newer version of GitDesk.".into());
            return store;
        }

        match serde_json::from_slice::<Config>(&bytes) {
            Ok(mut value) => {
                value.schema_version = value.schema_version.max(2);
                store.value = value;
            }
            Err(_) => {
                let timestamp = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                let backup = store
                    .path
                    .with_file_name(format!("workspace.corrupt-{timestamp}.json"));
                if fs::rename(&store.path, &backup).is_ok() {
                    store.warning = Some(format!(
                        "Workspace settings were damaged. The original was saved as {}.",
                        backup.display()
                    ));
                } else {
                    store.writable = false;
                    store.warning =
                        Some("Workspace settings were damaged and could not be backed up.".into());
                }
            }
        }
        store
    }

    pub fn update(&mut self, change: impl FnOnce(&mut Config) -> Result<()>) -> Result<()> {
        if !self.writable {
            return Err(Failure::new(
                "CONFIG_UNAVAILABLE",
                "Workspace settings are unavailable for writing.",
            ));
        }
        let mut next = self.value.clone();
        change(&mut next)?;
        save(&self.path, &next)?;
        self.value = next;
        Ok(())
    }
}

fn save(path: &Path, config: &Config) -> Result<()> {
    fn write(path: &Path, config: &Config) -> io::Result<()> {
        let directory = path.parent().ok_or(io::ErrorKind::InvalidInput)?;
        fs::create_dir_all(directory)?;
        let mut staged = tempfile::NamedTempFile::new_in(directory)?;
        serde_json::to_writer_pretty(&mut staged, config)?;
        staged.write_all(b"\n")?;
        staged.as_file().sync_all()?;
        staged.persist(path).map_err(|error| error.error)?;
        Ok(())
    }

    write(path, config)
        .map_err(|_| Failure::new("CONFIG_WRITE_FAILED", "Could not save workspace settings."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_v1_without_losing_workspace_preferences() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("workspaces.json");
        fs::write(&path, br#"{"schemaVersion":1,"workspaces":[{"root":"/tmp/known","excluded":["repo-hidden"]}],"selection":{"repoId":"r","worktreeId":"t","page":"history"},"gitPath":"/usr/bin/git"}"#).unwrap();
        let mut config = ConfigStore::open(path.clone());
        assert_eq!(config.value.schema_version, 2);
        assert!(config.value.releases.is_empty());
        assert_eq!(config.value.selection.as_ref().unwrap().worktree_id, "t");
        assert!(config.value.workspaces[0].excluded.contains("repo-hidden"));
        config
            .update(|data| {
                data.releases.entry("r".into()).or_default();
                Ok(())
            })
            .unwrap();
        let reopened = ConfigStore::open(path);
        assert_eq!(
            reopened.value.git_path.as_deref(),
            Some(Path::new("/usr/bin/git"))
        );
        assert!(reopened.value.releases.contains_key("r"));
        assert!(reopened.value.workspaces[0]
            .excluded
            .contains("repo-hidden"));
    }

    #[test]
    fn keeps_legacy_task_ids_and_round_trips_overlapping_task_ids() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("workspaces.json");
        let legacy = serde_json::json!({
            "schemaVersion": 2,
            "workspaces": [],
            "releases": { "repo": {
                "targetRevision": 0,
                "targets": [null, null, null],
                "tasks": [{ "id": "first", "revision": 1, "fields": {
                    "title": "Existing task",
                    "issue": "3848",
                    "source": "fix/backend",
                    "commitOids": ["a".repeat(40)],
                    "archived": false
                }}]
            }}
        });
        fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let mut store = ConfigStore::open(path.clone());
        assert!(store.warning.is_none());
        store
            .update(|config| {
                let tasks = &mut config.releases.get_mut("repo").unwrap().tasks;
                let mut second = tasks[0].clone();
                second.id = "second".into();
                second.fields.issue = " 3848， 3745, 3848, ".into();
                second.fields.normalize()?;
                tasks.push(second);
                Ok(())
            })
            .unwrap();

        let reopened = ConfigStore::open(path);
        assert!(reopened.warning.is_none());
        assert_eq!(reopened.value.schema_version, 2);
        let tasks = &reopened.value.releases["repo"].tasks;
        assert_eq!(tasks[0].id, "first");
        assert_eq!(tasks[0].fields.issue, "3848");
        assert_eq!(tasks[1].id, "second");
        assert_eq!(tasks[1].fields.issue, "3848, 3745");
        let mut fields = tasks[1].fields.clone();
        fields.issue = "x".repeat(121);
        assert!(fields.normalize().is_err());
    }

    #[test]
    fn restores_selection_and_keeps_a_copy_of_bad_config() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("workspaces.json");
        fs::write(&path, b"invalid settings").unwrap();
        let mut store = ConfigStore::open(path.clone());
        assert!(store.warning.is_some());
        assert!(!path.exists());
        let backup = fs::read_dir(root.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(fs::read(backup).unwrap(), b"invalid settings");

        store
            .update(|config| {
                config.selection = Some(Selection {
                    repo_id: "r".into(),
                    worktree_id: "t".into(),
                    page: "worktrees".into(),
                });
                Ok(())
            })
            .unwrap();
        assert_eq!(
            ConfigStore::open(path).value.selection.unwrap().page,
            "worktrees"
        );
    }

    #[test]
    fn preserves_a_newer_configuration_with_incompatible_fields() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("workspaces.json");
        let newer = br#"{"schemaVersion":4,"workspaces":{"folders":[]},"releases":[]}"#;
        fs::write(&path, newer).unwrap();
        let mut store = ConfigStore::open(path.clone());
        assert!(store.warning.as_deref().unwrap().contains("newer version"));
        assert!(store.update(|_| Ok(())).is_err());
        assert_eq!(fs::read(path).unwrap(), newer);
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }
}
