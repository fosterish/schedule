use axum::extract::{Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::history::{apply_ops, SubOp};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/history/state", get(get_state))
        .route("/history/undo", post(undo))
        .route("/history/redo", post(redo))
}

/// Required ?context= param; no default so a client bug can't undo in the wrong tab.
#[derive(Debug, Deserialize)]
struct ContextQuery {
    context: Option<String>,
}

fn require_context(q: &ContextQuery) -> AppResult<&str> {
    let s = q
        .context
        .as_deref()
        .ok_or_else(|| AppError::bad_request("context query param required"))?;
    // Pre-validate so we return 400 instead of a generic DB error.
    match s {
        "schedule" | "project" | "calendar" => Ok(s),
        _ => Err(AppError::bad_request(format!(
            "unknown context: {s} (expected schedule | project | calendar)"
        ))),
    }
}

async fn get_state(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ContextQuery>,
) -> AppResult<Json<Value>> {
    let context = require_context(&q)?;
    let can_undo: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM history
          WHERE user_id = ? AND context = ? AND undone = 0",
    )
    .bind(user.0)
    .bind(context)
    .fetch_one(&state.pool)
    .await?;
    let can_redo: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM history
          WHERE user_id = ? AND context = ? AND undone = 1",
    )
    .bind(user.0)
    .bind(context)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(json!({
        "context": context,
        "can_undo": can_undo.0 > 0,
        "can_redo": can_redo.0 > 0,
    })))
}

async fn undo(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ContextQuery>,
) -> AppResult<Json<Value>> {
    let context = require_context(&q)?;
    let mut tx = state.pool.begin().await?;
    // Context filter keeps a Schedule undo out of the Projects stack.
    let row: Option<(i64, String)> = sqlx::query_as(
        "SELECT id, backward FROM history
          WHERE user_id = ? AND context = ? AND undone = 0
          ORDER BY id DESC LIMIT 1",
    )
    .bind(user.0)
    .bind(context)
    .fetch_optional(&mut *tx)
    .await?;
    let (hid, backward) = row.ok_or_else(|| AppError::conflict("nothing to undo"))?;
    let ops: Vec<SubOp> = serde_json::from_str(&backward)
        .map_err(|e| AppError::internal(format!("history decode: {e}")))?;
    apply_ops(&mut tx, user.0, &ops).await?;
    sqlx::query("UPDATE history SET undone = 1 WHERE id = ?")
        .bind(hid)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({"ok": true, "context": context})))
}

async fn redo(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ContextQuery>,
) -> AppResult<Json<Value>> {
    let context = require_context(&q)?;
    let mut tx = state.pool.begin().await?;
    let row: Option<(i64, String)> = sqlx::query_as(
        "SELECT id, forward FROM history
          WHERE user_id = ? AND context = ? AND undone = 1
          ORDER BY id ASC LIMIT 1",
    )
    .bind(user.0)
    .bind(context)
    .fetch_optional(&mut *tx)
    .await?;
    let (hid, forward) = row.ok_or_else(|| AppError::conflict("nothing to redo"))?;
    let ops: Vec<SubOp> = serde_json::from_str(&forward)
        .map_err(|e| AppError::internal(format!("history decode: {e}")))?;
    apply_ops(&mut tx, user.0, &ops).await?;
    sqlx::query("UPDATE history SET undone = 0 WHERE id = ?")
        .bind(hid)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({"ok": true, "context": context})))
}
