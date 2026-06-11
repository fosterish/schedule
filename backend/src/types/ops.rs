use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::common::{ProjectId, Revision, ScheduleId, ScheduleItemId, TaskId, UserId};
use super::project::{Dependency, Project, Task};
use super::schedule::{Schedule, ScheduleBinding, ScheduleItem, Template};
use super::settings::Settings;

/// A full row for some syncable table, each carrying `rev: Revisions`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum Model {
    Project(Project),
    Task(Task),
    Dependency(Dependency),
    Schedule(Schedule),
    ScheduleItem(ScheduleItem),
    ScheduleBinding(ScheduleBinding),
    Template(Template),
    Settings(Settings),
}

/// A typed delete target.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", content = "id", rename_all = "camelCase")]
#[ts(export)]
pub enum ModelRef {
    Project(ProjectId),
    Task(TaskId),
    Dependency {
        blocked: TaskId,
        blocker: TaskId,
    },
    Schedule(ScheduleId),
    ScheduleItem(ScheduleItemId),
    /// `YYYY-MM-DD`.
    ScheduleBinding(String),
    Template(ScheduleId),
    /// The user's singleton settings row, keyed by user id.
    Settings(UserId),
}

/// `Delete` is soft (sets `rev.deleted`).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum Operation {
    Upsert {
        model: Model,
    },
    Delete {
        #[serde(rename = "ref")]
        target: ModelRef,
    },
}

/// Full user dataset: the `GET /api/snapshot` payload and the IndexedDB seed.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Snapshot {
    pub version: Revision,
    pub projects: Vec<Project>,
    pub tasks: Vec<Task>,
    pub dependencies: Vec<Dependency>,
    pub schedules: Vec<Schedule>,
    pub items: Vec<ScheduleItem>,
    pub bindings: Vec<ScheduleBinding>,
    pub templates: Vec<Template>,
    pub settings: Vec<Settings>,
}

/// `POST /api/sync` body.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SyncOps {
    pub since: Revision,
    pub ops: Vec<Operation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SyncResult {
    pub version: Revision,
    pub applied: Vec<ModelRef>,
    pub rejected: Vec<Rejection>,
}

/// Lost the LWW race; the client re-pulls.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Rejection {
    pub target: ModelRef,
    pub stored_rev: Revision,
}
