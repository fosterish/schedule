use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::common::{Revisions, UserId};

/// User-scoped, synced preferences (one row per user). Lead times are in minutes
/// before an item's start; `default_start`/`default_end` seed new schedules.
/// `use_24_hour` selects 24-hour clock display (default 12-hour when false).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Settings {
    pub user_id: UserId,
    pub lead_fixed_min: i64,
    pub lead_dynamic_min: i64,
    pub default_start: i64,
    pub default_end: i64,
    pub use_24_hour: bool,
    pub rev: Revisions,
}
