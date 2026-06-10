use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::common::{
    Color, OrderKey, ProjectId, Revisions, ScheduleId, ScheduleItemId, TaskId, UserId,
};

/// Three-variable geometry (`start + duration = end`): each bound is fixed when
/// `Some`; `duration_target` is the elastic weight.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ItemBounds {
    pub start: Option<i64>,
    pub end: Option<i64>,
    pub fixed_duration: Option<i64>,
    pub duration_target: i64,
}

/// Hard bounds: `start`/`end` are the schedule's fixed extent in minutes (the
/// implicit first-start / last-end that items lay out between).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Schedule {
    pub id: ScheduleId,
    pub user_id: UserId,
    pub name: String,
    pub start: i64,
    pub end: i64,
    pub rev: Revisions,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScheduleItem {
    pub id: ScheduleItemId,
    pub schedule_id: ScheduleId,
    pub position: OrderKey,
    pub bounds: ItemBounds,
    pub use_inline: bool,
    pub inline_label: Option<String>,
    pub inline_description: Option<String>,
    pub inline_color: Color,
    pub project_id: Option<ProjectId>,
    pub project_rank: i64,
    pub task_id: Option<TaskId>,
    pub task_rank: i64,
    pub rev: Revisions,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScheduleBinding {
    pub user_id: UserId,
    /// `YYYY-MM-DD`.
    pub date: String,
    pub schedule_id: ScheduleId,
    pub rev: Revisions,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Template {
    pub user_id: UserId,
    pub schedule_id: ScheduleId,
    pub rev: Revisions,
}
