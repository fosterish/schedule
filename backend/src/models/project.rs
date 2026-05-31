use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use time::OffsetDateTime;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct Project {
    pub id: i64,
    pub user_id: i64,
    pub name: String,
    pub value: f64,
    pub time_cost: f64,
    /// Palette key for items bound to this project; legal values in `0001_init.sql`'s CHECK (see `frontend/src/palette.js`).
    pub color: String,
    #[serde(with = "time::serde::rfc3339::option")]
    pub archived_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

/// Project plus aggregated task counts for the `/api/projects` listing; strict superset of `Project` so existing consumers work unchanged.
#[derive(Debug, Clone, FromRow, Serialize)]
pub struct ProjectListItem {
    pub id: i64,
    pub user_id: i64,
    pub name: String,
    pub value: f64,
    pub time_cost: f64,
    pub color: String,
    #[serde(with = "time::serde::rfc3339::option")]
    pub archived_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    pub completed_tasks: i64,
    pub total_tasks: i64,
}

#[derive(Debug, Deserialize)]
pub struct NewProject {
    pub name: Option<String>,
    pub value: Option<f64>,
    pub time_cost: Option<f64>,
    pub color: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PatchProject {
    pub name: Option<String>,
    pub value: Option<f64>,
    pub time_cost: Option<f64>,
    pub color: Option<String>,
}
