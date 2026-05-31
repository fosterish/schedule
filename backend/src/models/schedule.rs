use serde::{Deserialize, Serialize};
use sqlx::FromRow;

/// Default window for newly-created schedules: 08:00 – 22:00.
pub const DEFAULT_START_MIN: i64 = 8 * 60;
pub const DEFAULT_END_MIN: i64 = 22 * 60;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct Schedule {
    pub id: i64,
    pub user_id: i64,
    pub name: String,
    pub start_min: i64,
    pub end_min: i64,
}

#[derive(Debug, Deserialize)]
pub struct NewSchedule {
    pub name: Option<String>,
    pub start_min: Option<i64>,
    pub end_min: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct PatchSchedule {
    pub name: Option<String>,
    pub start_min: Option<i64>,
    pub end_min: Option<i64>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct ScheduleItem {
    pub id: i64,
    pub schedule_id: i64,
    pub position: f64,
    pub start_min: Option<i64>,
    pub end_min: Option<i64>,
    pub duration_target: i64,
    /// Task vs Project discriminator and source of truth when both column sets are populated (`true` = inline Task).
    pub use_inline: bool,
    pub inline_label: Option<String>,
    pub inline_description: Option<String>,
    /// Palette key; authoritative in Task mode, ignored in Project mode but kept across toggles to preserve the prior pick.
    pub color: String,
    pub project_id: Option<i64>,
    pub project_rank: i64,
    pub task_id: Option<i64>,
    pub task_rank: i64,
}

#[derive(Debug, Deserialize, Default)]
pub struct NewScheduleItem {
    pub start_min: Option<i64>,
    pub end_min: Option<i64>,
    pub duration_target: Option<i64>,
    /// Optional on create; defaults to `true` (Task) so a bare `POST` yields an empty inline Task.
    pub use_inline: Option<bool>,
    pub inline_label: Option<String>,
    pub inline_description: Option<String>,
    /// Palette key (`None` accepts the column default).
    pub color: Option<String>,
    pub project_id: Option<i64>,
    pub project_rank: Option<i64>,
    pub task_id: Option<i64>,
    pub task_rank: Option<i64>,
    /// Positional hint: absent = append tail, explicit `null` = head, value = after that item id (same schedule).
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub after_item_id: Option<Option<i64>>,
}

/// Patch for a schedule item; `Option<Option<T>>` encodes absent vs null vs value, `Option<T>` for non-nullable fields.
#[derive(Debug, Deserialize, Default)]
pub struct PatchScheduleItem {
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub start_min: Option<Option<i64>>,
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub end_min: Option<Option<i64>>,
    pub duration_target: Option<i64>,
    /// Toggling Task/Project patches only this, intentionally leaving off-mode fields for round-tripping.
    pub use_inline: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub inline_label: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub inline_description: Option<Option<String>>,
    /// Palette key; `None` leaves it unchanged. Column is NOT NULL with a default, so no `Option<Option<_>>` clear-to-null.
    pub color: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub project_id: Option<Option<i64>>,
    pub project_rank: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub task_id: Option<Option<i64>>,
    pub task_rank: Option<i64>,
}

/// Atomic "Add Item" endpoint body: new row plus the solver's position plan applied in one transaction and history entry.
#[derive(Debug, Deserialize)]
pub struct InsertItemAtomicRequest {
    pub item: NewScheduleItem,
    /// Solver's position updates for pre-existing dynamic items, applied before insert so the monotonicity check sees the full set.
    #[serde(default)]
    pub reorders: Vec<PositionUpdate>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct PositionUpdate {
    pub id: i64,
    pub position: f64,
}

#[derive(Debug, Deserialize)]
pub struct ReorderScheduleItem {
    pub after_item_id: Option<i64>,
    /// Anchor (start/end) updates applied atomically with the reorder so fixed-side items stay monotonic; `Option<Option<i64>>` = unchanged/clear/set.
    #[serde(default)]
    pub anchor_updates: Vec<ReorderAnchorUpdate>,
}

#[derive(Debug, Deserialize)]
pub struct ReorderAnchorUpdate {
    pub id: i64,
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub start_min: Option<Option<i64>>,
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub end_min: Option<Option<i64>>,
}

// Explicit value (including null) -> Some, missing key -> None: opt into explicit-null-as-Some(None) semantics for Option<Option<_>>.
fn deserialize_optional_field<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: serde::Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}
