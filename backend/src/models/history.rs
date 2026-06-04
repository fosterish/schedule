use serde::Serialize;
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
