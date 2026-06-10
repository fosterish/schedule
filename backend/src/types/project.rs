use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::common::{Color, Millis, OrderKey, ProjectId, Revisions, TaskId, UserId};

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Project {
    pub id: ProjectId,
    pub user_id: UserId,
    pub name: String,
    pub value: f64,
    /// Maps to SQL column `time_cost` (`time` is reserved in SQL).
    pub time: f64,
    pub color: Color,
    pub archived_at: Option<Millis>,
    pub created_at: Millis,
    pub rev: Revisions,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Task {
    pub id: TaskId,
    pub project_id: ProjectId,
    pub name: String,
    pub description: Option<String>,
    pub list_order: OrderKey,
    pub completed_at: Option<Millis>,
    pub created_at: Millis,
    pub rev: Revisions,
}

/// Intra-project dependency: `blocked_id` is blocked by `blocker_id`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Dependency {
    pub blocked_id: TaskId,
    pub blocker_id: TaskId,
    pub rev: Revisions,
}
