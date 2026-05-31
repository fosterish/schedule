use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use sqlx::{Sqlite, Transaction};

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::history::{
    record_history, snapshot_project, snapshot_task, task_dependencies_for, task_ids_for_project,
    SubOp, CTX_PROJECT,
};
use crate::models::project::{NewProject, PatchProject, Project, ProjectListItem};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/projects", get(list_projects).post(create_project))
        .route(
            "/projects/{id}",
            get(get_project).patch(patch_project).delete(delete_project),
        )
        .route("/projects/{id}/archive", post(archive_project))
}

async fn list_projects(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<ProjectListItem>>> {
    // LEFT JOIN + COALESCE returns completed/total counts per row; projects with no tasks land at 0/0.
    let rows: Vec<ProjectListItem> = sqlx::query_as::<_, ProjectListItem>(
        "SELECT p.id, p.user_id, p.name, p.value, p.time_cost, p.color,
                p.archived_at, p.created_at,
                COALESCE(SUM(CASE WHEN t.completed_at IS NOT NULL THEN 1 ELSE 0 END), 0)
                  AS completed_tasks,
                COUNT(t.id) AS total_tasks
           FROM projects p
           LEFT JOIN tasks t ON t.project_id = p.id
          WHERE p.user_id = ?
          GROUP BY p.id
          ORDER BY (p.value / p.time_cost) DESC, p.created_at ASC, p.id ASC",
    )
    .bind(user.0)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

async fn get_project(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Project>> {
    let project = load_project(&state.pool, user.0, id).await?;
    Ok(Json(project))
}

async fn create_project(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<NewProject>,
) -> AppResult<(StatusCode, Json<Project>)> {
    let name = body.name.unwrap_or_else(|| "Untitled project".to_string());
    let value = body.value.unwrap_or(1.0);
    let time_cost = body.time_cost.unwrap_or(1.0);
    if !time_cost.is_finite() || time_cost <= 0.0 {
        return Err(AppError::validation("time_cost must be > 0"));
    }
    if !value.is_finite() {
        return Err(AppError::validation("value must be finite"));
    }
    // Default "orange" so projects stand out; binding it keeps the inserted row deterministic.
    let color = body.color.unwrap_or_else(|| "orange".to_string());
    let mut tx = state.pool.begin().await?;
    let row: (i64,) = sqlx::query_as(
        "INSERT INTO projects (user_id, name, value, time_cost, color)
         VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(user.0)
    .bind(&name)
    .bind(value)
    .bind(time_cost)
    .bind(&color)
    .fetch_one(&mut *tx)
    .await?;

    // Forward re-inserts the project with same id/created_at; backward deletes it (no tasks yet).
    let snap = snapshot_project(&mut tx, user.0, row.0)
        .await?
        .expect("just inserted");
    record_history(
        &mut tx,
        user.0,
        CTX_PROJECT,
        "create_project",
        &[SubOp::InsertProject { row: snap }],
        &[SubOp::DeleteProject { id: row.0 }],
    )
    .await?;

    tx.commit().await?;
    let project = load_project(&state.pool, user.0, row.0).await?;
    Ok((StatusCode::CREATED, Json(project)))
}

async fn patch_project(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(body): Json<PatchProject>,
) -> AppResult<Json<Project>> {
    let mut tx = state.pool.begin().await?;
    let existing = load_project_tx(&mut tx, user.0, id).await?;

    // Build forward and inverse-backward patches in lockstep so undo restores exactly the mutated fields.
    let mut forward = serde_json::Map::new();
    let mut backward = serde_json::Map::new();

    if let Some(ref name) = body.name {
        if name != &existing.name {
            sqlx::query("UPDATE projects SET name = ? WHERE id = ? AND user_id = ?")
                .bind(name)
                .bind(id)
                .bind(user.0)
                .execute(&mut *tx)
                .await?;
            forward.insert("name".into(), serde_json::json!(name));
            backward.insert("name".into(), serde_json::json!(existing.name));
        }
    }
    if let Some(value) = body.value {
        if !value.is_finite() {
            return Err(AppError::validation("value must be finite"));
        }
        if (value - existing.value).abs() > 0.0 {
            sqlx::query("UPDATE projects SET value = ? WHERE id = ? AND user_id = ?")
                .bind(value)
                .bind(id)
                .bind(user.0)
                .execute(&mut *tx)
                .await?;
            forward.insert("value".into(), serde_json::json!(value));
            backward.insert("value".into(), serde_json::json!(existing.value));
        }
    }
    if let Some(time_cost) = body.time_cost {
        if !time_cost.is_finite() || time_cost <= 0.0 {
            return Err(AppError::validation("time_cost must be > 0"));
        }
        if (time_cost - existing.time_cost).abs() > 0.0 {
            sqlx::query("UPDATE projects SET time_cost = ? WHERE id = ? AND user_id = ?")
                .bind(time_cost)
                .bind(id)
                .bind(user.0)
                .execute(&mut *tx)
                .await?;
            forward.insert("time_cost".into(), serde_json::json!(time_cost));
            backward.insert("time_cost".into(), serde_json::json!(existing.time_cost));
        }
    }
    if let Some(ref color) = body.color {
        if color != &existing.color {
            // Color validation deferred to the DB CHECK; bad values surface as a 400.
            sqlx::query("UPDATE projects SET color = ? WHERE id = ? AND user_id = ?")
                .bind(color)
                .bind(id)
                .bind(user.0)
                .execute(&mut *tx)
                .await?;
            forward.insert("color".into(), serde_json::json!(color));
            backward.insert("color".into(), serde_json::json!(existing.color));
        }
    }

    if !forward.is_empty() {
        record_history(
            &mut tx,
            user.0,
            CTX_PROJECT,
            "patch_project",
            &[SubOp::PatchProject {
                id,
                fields: serde_json::Value::Object(forward),
            }],
            &[SubOp::PatchProject {
                id,
                fields: serde_json::Value::Object(backward),
            }],
        )
        .await?;
    }
    tx.commit().await?;
    let project = load_project(&state.pool, user.0, id).await?;
    Ok(Json(project))
}

async fn archive_project(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(body): Json<ArchiveBody>,
) -> AppResult<Json<Project>> {
    let mut tx = state.pool.begin().await?;
    let existing = load_project_tx(&mut tx, user.0, id).await?;
    let archived = body.archived.unwrap_or(true);

    // Forward records the exact new timestamp; capturing the previous one lets undo restore an earlier archive.
    let prev = existing.archived_at;
    let new_ts: Option<time::OffsetDateTime> = if archived {
        Some(time::OffsetDateTime::now_utc())
    } else {
        None
    };
    if prev == new_ts {
        // No-op: skip history for a redundant request.
        tx.commit().await?;
        let project = load_project(&state.pool, user.0, id).await?;
        return Ok(Json(project));
    }
    if archived {
        sqlx::query(
            "UPDATE projects SET archived_at = ? WHERE id = ? AND user_id = ?",
        )
        .bind(new_ts)
        .bind(id)
        .bind(user.0)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query("UPDATE projects SET archived_at = NULL WHERE id = ? AND user_id = ?")
            .bind(id)
            .bind(user.0)
            .execute(&mut *tx)
            .await?;
    }

    let forward_val = new_ts
        .map(|dt| serde_json::json!(format_dt(dt)))
        .unwrap_or(serde_json::Value::Null);
    let backward_val = prev
        .map(|dt| serde_json::json!(format_dt(dt)))
        .unwrap_or(serde_json::Value::Null);
    record_history(
        &mut tx,
        user.0,
        CTX_PROJECT,
        if archived { "archive_project" } else { "unarchive_project" },
        &[SubOp::PatchProject {
            id,
            fields: serde_json::json!({ "archived_at": forward_val }),
        }],
        &[SubOp::PatchProject {
            id,
            fields: serde_json::json!({ "archived_at": backward_val }),
        }],
    )
    .await?;
    tx.commit().await?;
    let project = load_project(&state.pool, user.0, id).await?;
    Ok(Json(project))
}

#[derive(Debug, Deserialize, Default)]
struct ArchiveBody {
    archived: Option<bool>,
}

async fn delete_project(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<impl IntoResponse> {
    let mut tx = state.pool.begin().await?;
    let _existing = load_project_tx(&mut tx, user.0, id).await?;

    // Snapshot project, tasks, and dep edges before cascade; undo re-inserts in that order for FK safety.
    let project_snap = snapshot_project(&mut tx, user.0, id)
        .await?
        .expect("project exists");
    let task_ids = task_ids_for_project(&mut tx, user.0, id).await?;
    let mut task_snaps: Vec<serde_json::Value> = Vec::with_capacity(task_ids.len());
    for tid in &task_ids {
        if let Some(snap) = snapshot_task(&mut tx, user.0, *tid).await? {
            task_snaps.push(snap);
        }
    }
    let deps = task_dependencies_for(&mut tx, &task_ids).await?;

    sqlx::query("DELETE FROM projects WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user.0)
        .execute(&mut *tx)
        .await?;

    // Backward order: project, then tasks, then dep edges (FK order matters).
    let mut backward: Vec<SubOp> = Vec::with_capacity(2 + task_snaps.len() + deps.len());
    backward.push(SubOp::InsertProject { row: project_snap });
    for snap in task_snaps {
        backward.push(SubOp::InsertTask { row: snap });
    }
    for (blocked_id, blocker_id) in deps {
        backward.push(SubOp::InsertTaskDep { blocked_id, blocker_id });
    }
    record_history(
        &mut tx,
        user.0,
        CTX_PROJECT,
        "delete_project",
        &[SubOp::DeleteProject { id }],
        &backward,
    )
    .await?;

    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn load_project(pool: &sqlx::SqlitePool, user_id: i64, id: i64) -> AppResult<Project> {
    let row: Option<Project> = sqlx::query_as::<_, Project>(
        "SELECT id, user_id, name, value, time_cost, color, archived_at, created_at
           FROM projects WHERE id = ? AND user_id = ?",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    row.ok_or(AppError::NotFound)
}

pub async fn load_project_tx(
    tx: &mut Transaction<'_, Sqlite>,
    user_id: i64,
    id: i64,
) -> AppResult<Project> {
    let row: Option<Project> = sqlx::query_as::<_, Project>(
        "SELECT id, user_id, name, value, time_cost, color, archived_at, created_at
           FROM projects WHERE id = ? AND user_id = ?",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?;
    row.ok_or(AppError::NotFound)
}

fn format_dt(dt: time::OffsetDateTime) -> String {
    dt.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}
