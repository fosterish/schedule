use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use time::OffsetDateTime;

pub const HISTORY_CAP: i64 = 100;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct HistoryEntry {
    pub id: i64,
    pub user_id: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    pub op: String,
    pub forward: String,
    pub backward: String,
    pub undone: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct HistoryAvailability {
    pub undo_available: bool,
    pub redo_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum HistoryOp {
    PatchItem {
        id: i64,
        fields: serde_json::Value,
    },
    CreateItem {
        row: serde_json::Value,
    },
    DeleteItem {
        row: serde_json::Value,
    },
    ReorderItem {
        id: i64,
        position: f64,
    },
    RunPlay {
        subops: Vec<SubOp>,
    },
    RunStop {
        subops: Vec<SubOp>,
    },
    RunSkip {
        subops: Vec<SubOp>,
    },
    ForkWithAction {
        override_date: String,
        new_schedule_id: i64,
        copied_item_ids: Vec<i64>,
        inner: Box<HistoryOp>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SubOp {
    PatchItem {
        id: i64,
        fields: serde_json::Value,
    },
    CreateItem {
        row: serde_json::Value,
    },
    DeleteItem {
        row: serde_json::Value,
    },
    PatchSchedule {
        id: i64,
        start_min: Option<i64>,
        end_min: Option<i64>,
    },
}
