use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Serialize;
use sqlx::{Sqlite, Transaction};

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::fractional::compute_reorder_position;
use crate::history::{record_history, snapshot_task, task_dependencies_for, SubOp, CTX_PROJECT};
use crate::models::task::{AddDependency, NewTask, PatchTask, ReorderTask, Task};
use crate::routes::projects::load_project;
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/projects/{id}/tasks", get(list_tasks).post(create_task))
        .route(
            "/projects/{id}/tasks/completed",
            delete(delete_completed_tasks),
        )
        .route(
            "/tasks/{id}",
            get(get_task).patch(patch_task).delete(delete_task),
        )
        .route("/tasks/{id}/complete", post(complete_task))
        .route("/tasks/{id}/uncomplete", post(uncomplete_task))
        .route("/tasks/{id}/reorder", post(reorder_task))
        .route(
            "/tasks/{id}/dependencies",
            get(list_dependencies).post(add_dependency),
        )
        .route(
            "/tasks/{id}/dependencies/{blocker_id}",
            delete(remove_dependency),
        )
}

async fn list_tasks(
    State(state): State<AppState>,
    user: AuthUser,
    Path(project_id): Path<i64>,
) -> AppResult<Json<Vec<Task>>> {
    let _project = load_project(&state.pool, user.0, project_id).await?;
    let rows: Vec<Task> = sqlx::query_as::<_, Task>(
        "SELECT id, project_id, name, description, list_order, completed_at, created_at
           FROM tasks WHERE project_id = ? ORDER BY list_order ASC, id ASC",
    )
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

async fn create_task(
    State(state): State<AppState>,
    user: AuthUser,
    Path(project_id): Path<i64>,
    Json(body): Json<NewTask>,
) -> AppResult<(StatusCode, Json<Task>)> {
    let _project = load_project(&state.pool, user.0, project_id).await?;
    let name = body.name.unwrap_or_else(|| "New task".to_string());

    let mut tx = state.pool.begin().await?;
    let max: Option<f64> = sqlx::query_as::<_, (Option<f64>,)>(
        "SELECT MAX(list_order) FROM tasks WHERE project_id = ?",
    )
    .bind(project_id)
    .fetch_one(&mut *tx)
    .await?
    .0;
    let pos = max.map(|m| m + 1.0).unwrap_or(1.0);
    let row: (i64,) = sqlx::query_as(
        "INSERT INTO tasks (project_id, name, description, list_order)
         VALUES (?, ?, ?, ?) RETURNING id",
    )
    .bind(project_id)
    .bind(&name)
    .bind(body.description.as_deref())
    .bind(pos)
    .fetch_one(&mut *tx)
    .await?;

    let snap = snapshot_task(&mut tx, user.0, row.0)
        .await?
        .expect("just inserted");
    record_history(
        &mut tx,
        user.0,
        CTX_PROJECT,
        "create_task",
        &[SubOp::InsertTask { row: snap }],
        &[SubOp::DeleteTask { id: row.0 }],
    )
    .await?;

    tx.commit().await?;
    let task = load_task(&state.pool, user.0, row.0).await?;
    Ok((StatusCode::CREATED, Json(task)))
}

async fn get_task(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Task>> {
    Ok(Json(load_task(&state.pool, user.0, id).await?))
}

async fn patch_task(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(body): Json<PatchTask>,
) -> AppResult<Json<Task>> {
    let mut tx = state.pool.begin().await?;
    let existing = load_task_tx(&mut tx, user.0, id).await?;
    let mut forward = serde_json::Map::new();
    let mut backward = serde_json::Map::new();

    if let Some(ref name) = body.name {
        if name != &existing.name {
            sqlx::query("UPDATE tasks SET name = ? WHERE id = ?")
                .bind(name)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            forward.insert("name".into(), serde_json::json!(name));
            backward.insert("name".into(), serde_json::json!(existing.name));
        }
    }
    if let Some(desc_opt) = body.description {
        // Option<Option<String>>: outer Some means key present; inner None means set NULL.
        let same = match (&desc_opt, &existing.description) {
            (None, None) => true,
            (Some(a), Some(b)) => a == b,
            _ => false,
        };
        if !same {
            sqlx::query("UPDATE tasks SET description = ? WHERE id = ?")
                .bind(desc_opt.as_deref())
                .bind(id)
                .execute(&mut *tx)
                .await?;
            let fwd_val = match &desc_opt {
                Some(s) => serde_json::json!(s),
                None => serde_json::Value::Null,
            };
            let bwd_val = match &existing.description {
                Some(s) => serde_json::json!(s),
                None => serde_json::Value::Null,
            };
            forward.insert("description".into(), fwd_val);
            backward.insert("description".into(), bwd_val);
        }
    }

    if !forward.is_empty() {
        record_history(
            &mut tx,
            user.0,
            CTX_PROJECT,
            "patch_task",
            &[SubOp::PatchTask {
                id,
                fields: serde_json::Value::Object(forward),
            }],
            &[SubOp::PatchTask {
                id,
                fields: serde_json::Value::Object(backward),
            }],
        )
        .await?;
    }
    tx.commit().await?;
    Ok(Json(load_task(&state.pool, user.0, id).await?))
}

async fn delete_task(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<impl IntoResponse> {
    let mut tx = state.pool.begin().await?;
    let _task = load_task_tx(&mut tx, user.0, id).await?;
    let snap = snapshot_task(&mut tx, user.0, id)
        .await?
        .expect("task exists");
    // Capture dep edges (both directions) before the cascade so undo re-creates them.
    let deps = task_dependencies_for(&mut tx, &[id]).await?;
    sqlx::query("DELETE FROM tasks WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;

    let mut backward: Vec<SubOp> = Vec::with_capacity(1 + deps.len());
    backward.push(SubOp::InsertTask { row: snap });
    for (blocked_id, blocker_id) in deps {
        backward.push(SubOp::InsertTaskDep {
            blocked_id,
            blocker_id,
        });
    }
    record_history(
        &mut tx,
        user.0,
        CTX_PROJECT,
        "delete_task",
        &[SubOp::DeleteTask { id }],
        &backward,
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Serialize)]
struct DeleteCompletedResponse {
    deleted: i64,
}

/// Bulk-delete a project's completed tasks in one transaction and one composite history entry, so one undo restores all.
async fn delete_completed_tasks(
    State(state): State<AppState>,
    user: AuthUser,
    Path(project_id): Path<i64>,
) -> AppResult<Json<DeleteCompletedResponse>> {
    // Ownership check up front (404 if not owned).
    let _project = load_project(&state.pool, user.0, project_id).await?;

    let mut tx = state.pool.begin().await?;
    // Collect completed ids inside the tx (join re-checks ownership) so snapshot and delete match.
    let completed_ids: Vec<i64> = sqlx::query_as::<_, (i64,)>(
        "SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE t.project_id = ? AND p.user_id = ? AND t.completed_at IS NOT NULL
          ORDER BY t.id ASC",
    )
    .bind(project_id)
    .bind(user.0)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .map(|(i,)| i)
    .collect();

    if completed_ids.is_empty() {
        // Nothing to delete: succeed without recording history.
        tx.commit().await?;
        return Ok(Json(DeleteCompletedResponse { deleted: 0 }));
    }

    // Snapshot tasks and dep edges before delete so undo re-inserts tasks then edges (FK order).
    let mut task_snaps: Vec<serde_json::Value> = Vec::with_capacity(completed_ids.len());
    for tid in &completed_ids {
        if let Some(snap) = snapshot_task(&mut tx, user.0, *tid).await? {
            task_snaps.push(snap);
        }
    }
    let deps = task_dependencies_for(&mut tx, &completed_ids).await?;

    // Bulk DELETE; CASCADE clears edges. The IN list uses fixed ? placeholders, no user input in SQL.
    let placeholders = (0..completed_ids.len())
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "DELETE FROM tasks WHERE id IN ({}) AND project_id IN
            (SELECT id FROM projects WHERE user_id = ?)",
        placeholders
    );
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for id in &completed_ids {
        q = q.bind(*id);
    }
    q = q.bind(user.0);
    let deleted = q.execute(&mut *tx).await?.rows_affected() as i64;

    // One composite entry: forward deletes all tasks; backward re-inserts tasks then edges.
    let forward: Vec<SubOp> = completed_ids
        .iter()
        .map(|id| SubOp::DeleteTask { id: *id })
        .collect();
    let mut backward: Vec<SubOp> = Vec::with_capacity(task_snaps.len() + deps.len());
    for snap in task_snaps {
        backward.push(SubOp::InsertTask { row: snap });
    }
    for (blocked_id, blocker_id) in deps {
        backward.push(SubOp::InsertTaskDep {
            blocked_id,
            blocker_id,
        });
    }
    record_history(
        &mut tx,
        user.0,
        CTX_PROJECT,
        "delete_completed_tasks",
        &forward,
        &backward,
    )
    .await?;

    tx.commit().await?;
    Ok(Json(DeleteCompletedResponse { deleted }))
}

async fn complete_task(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Task>> {
    let mut tx = state.pool.begin().await?;
    let existing = load_task_tx(&mut tx, user.0, id).await?;
    if existing.completed_at.is_some() {
        // Idempotent: already complete, no history recorded.
        tx.commit().await?;

        return Ok(Json(existing));
    }
    let now = time::OffsetDateTime::now_utc();
    sqlx::query("UPDATE tasks SET completed_at = ? WHERE id = ?")
        .bind(now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    record_history(
        &mut tx,
        user.0,
        CTX_PROJECT,
        "complete_task",
        &[SubOp::PatchTask {
            id,
            fields: serde_json::json!({ "completed_at": format_dt(now) }),
        }],
        &[SubOp::PatchTask {
            id,
            fields: serde_json::json!({ "completed_at": null }),
        }],
    )
    .await?;
    tx.commit().await?;
    Ok(Json(load_task(&state.pool, user.0, id).await?))
}

async fn uncomplete_task(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Task>> {
    let mut tx = state.pool.begin().await?;
    let existing = load_task_tx(&mut tx, user.0, id).await?;
    let prev = match existing.completed_at {
        Some(dt) => dt,
        None => {
            tx.commit().await?;
            return Ok(Json(existing));
        }
    };
    sqlx::query("UPDATE tasks SET completed_at = NULL WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    record_history(
        &mut tx,
        user.0,
        CTX_PROJECT,
        "uncomplete_task",
        &[SubOp::PatchTask {
            id,
            fields: serde_json::json!({ "completed_at": null }),
        }],
        &[SubOp::PatchTask {
            id,
            fields: serde_json::json!({ "completed_at": format_dt(prev) }),
        }],
    )
    .await?;
    tx.commit().await?;
    Ok(Json(load_task(&state.pool, user.0, id).await?))
}

async fn reorder_task(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(body): Json<ReorderTask>,
) -> AppResult<Json<Task>> {
    let mut tx = state.pool.begin().await?;
    let task = load_task_tx(&mut tx, user.0, id).await?;

    let rows: Vec<(i64, f64)> = sqlx::query_as(
        "SELECT id, list_order FROM tasks WHERE project_id = ? ORDER BY list_order ASC, id ASC",
    )
    .bind(task.project_id)
    .fetch_all(&mut *tx)
    .await?;

    if let Some(after) = body.after_task_id {
        let row_proj: Option<(i64,)> = sqlx::query_as("SELECT project_id FROM tasks WHERE id = ?")
            .bind(after)
            .fetch_optional(&mut *tx)
            .await?;
        let Some((pid,)) = row_proj else {
            return Err(AppError::bad_request("after_task_id not found"));
        };
        if pid != task.project_id {
            return Err(AppError::bad_request("after_task_id not in same project"));
        }
    }

    let plan = compute_reorder_position(&rows, id, body.after_task_id)?;

    // Capture every list_order we change so history restores the exact pre-reorder ordering.
    let before_orders: std::collections::HashMap<i64, f64> = rows.iter().copied().collect();
    let mut forward: Vec<SubOp> = Vec::new();
    let mut backward: Vec<SubOp> = Vec::new();

    if let Some(rebalanced) = plan.rebalance {
        for (rid, pos) in &rebalanced {
            sqlx::query("UPDATE tasks SET list_order = ? WHERE id = ?")
                .bind(*pos)
                .bind(*rid)
                .execute(&mut *tx)
                .await?;
        }
        for (rid, pos) in &rebalanced {
            let prev = before_orders.get(rid).copied().unwrap_or(*pos);
            forward.push(SubOp::PatchTask {
                id: *rid,
                fields: serde_json::json!({ "list_order": pos }),
            });
            backward.push(SubOp::PatchTask {
                id: *rid,
                fields: serde_json::json!({ "list_order": prev }),
            });
        }
    } else {
        sqlx::query("UPDATE tasks SET list_order = ? WHERE id = ?")
            .bind(plan.new_position)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let prev = before_orders.get(&id).copied().unwrap_or(task.list_order);
        forward.push(SubOp::PatchTask {
            id,
            fields: serde_json::json!({ "list_order": plan.new_position }),
        });
        backward.push(SubOp::PatchTask {
            id,
            fields: serde_json::json!({ "list_order": prev }),
        });
    }

    if !forward.is_empty() {
        // Backward order is irrelevant here (independent writes), but reversed for consistency with forward.
        backward.reverse();
        record_history(
            &mut tx,
            user.0,
            CTX_PROJECT,
            "reorder_task",
            &forward,
            &backward,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(Json(load_task(&state.pool, user.0, id).await?))
}

async fn list_dependencies(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Vec<i64>>> {
    let _task = load_task(&state.pool, user.0, id).await?;
    let rows: Vec<(i64,)> =
        sqlx::query_as("SELECT blocker_id FROM task_dependencies WHERE blocked_id = ?")
            .bind(id)
            .fetch_all(&state.pool)
            .await?;
    Ok(Json(rows.into_iter().map(|(b,)| b).collect()))
}

async fn add_dependency(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(body): Json<AddDependency>,
) -> AppResult<impl IntoResponse> {
    let mut tx = state.pool.begin().await?;
    let task = load_task_tx(&mut tx, user.0, id).await?;
    let blocker = load_task_tx(&mut tx, user.0, body.blocker_id).await?;
    if blocker.project_id != task.project_id {
        return Err(AppError::bad_request("blocker must be in same project"));
    }
    if blocker.id == task.id {
        return Err(AppError::bad_request("task cannot block itself"));
    }
    // Prevent direct cycles only; the resolver tolerates indirect cycles by stalling.
    let reverse: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM task_dependencies WHERE blocked_id = ? AND blocker_id = ?")
            .bind(blocker.id)
            .bind(task.id)
            .fetch_optional(&mut *tx)
            .await?;
    if reverse.is_some() {
        return Err(AppError::bad_request("dependency would create a cycle"));
    }
    let existing: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM task_dependencies WHERE blocked_id = ? AND blocker_id = ?")
            .bind(task.id)
            .bind(blocker.id)
            .fetch_optional(&mut *tx)
            .await?;
    if existing.is_some() {
        tx.commit().await?;
        return Ok(StatusCode::NO_CONTENT);
    }
    sqlx::query("INSERT INTO task_dependencies (blocked_id, blocker_id) VALUES (?, ?)")
        .bind(task.id)
        .bind(blocker.id)
        .execute(&mut *tx)
        .await?;
    record_history(
        &mut tx,
        user.0,
        CTX_PROJECT,
        "add_dependency",
        &[SubOp::InsertTaskDep {
            blocked_id: task.id,
            blocker_id: blocker.id,
        }],
        &[SubOp::DeleteTaskDep {
            blocked_id: task.id,
            blocker_id: blocker.id,
        }],
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_dependency(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, blocker_id)): Path<(i64, i64)>,
) -> AppResult<impl IntoResponse> {
    let mut tx = state.pool.begin().await?;
    let _task = load_task_tx(&mut tx, user.0, id).await?;
    let existing: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM task_dependencies WHERE blocked_id = ? AND blocker_id = ?")
            .bind(id)
            .bind(blocker_id)
            .fetch_optional(&mut *tx)
            .await?;
    if existing.is_none() {
        tx.commit().await?;
        return Ok(StatusCode::NO_CONTENT);
    }
    sqlx::query("DELETE FROM task_dependencies WHERE blocked_id = ? AND blocker_id = ?")
        .bind(id)
        .bind(blocker_id)
        .execute(&mut *tx)
        .await?;
    record_history(
        &mut tx,
        user.0,
        CTX_PROJECT,
        "remove_dependency",
        &[SubOp::DeleteTaskDep {
            blocked_id: id,
            blocker_id,
        }],
        &[SubOp::InsertTaskDep {
            blocked_id: id,
            blocker_id,
        }],
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Load a task, verifying it belongs to a project owned by `user_id`.
pub async fn load_task(pool: &sqlx::SqlitePool, user_id: i64, id: i64) -> AppResult<Task> {
    let row: Option<Task> = sqlx::query_as::<_, Task>(
        "SELECT t.id, t.project_id, t.name, t.description, t.list_order, t.completed_at, t.created_at
           FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE t.id = ? AND p.user_id = ?",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    row.ok_or(AppError::NotFound)
}

pub async fn load_task_tx(
    tx: &mut Transaction<'_, Sqlite>,
    user_id: i64,
    id: i64,
) -> AppResult<Task> {
    let row: Option<Task> = sqlx::query_as::<_, Task>(
        "SELECT t.id, t.project_id, t.name, t.description, t.list_order, t.completed_at, t.created_at
           FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE t.id = ? AND p.user_id = ?",
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
