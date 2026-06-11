use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::common::{Revisions, UserId};

/// User-scoped, synced preferences (one row per user). Lead times are in minutes
/// before an item's start; `default_start`/`default_end` seed new schedules.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Settings {
    pub user_id: UserId,
    pub lead_fixed_min: i64,
    pub lead_dynamic_min: i64,
    pub default_start: i64,
    pub default_end: i64,
    pub rev: Revisions,
}
