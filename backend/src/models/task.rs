use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use time::OffsetDateTime;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct Task {
    pub id: i64,
    pub project_id: i64,
    pub name: String,
    pub description: Option<String>,
    pub list_order: f64,
    #[serde(with = "time::serde::rfc3339::option")]
    pub completed_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

#[derive(Debug, Deserialize)]
pub struct NewTask {
    pub name: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PatchTask {
    pub name: Option<String>,
    pub description: Option<Option<String>>,
}

#[derive(Debug, Deserialize)]
pub struct ReorderTask {
    pub after_task_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct AddDependency {
    pub blocker_id: i64,
}
