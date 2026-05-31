use std::collections::BTreeMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::{Sqlite, Transaction};

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::fractional::compute_reorder_position;
use crate::models::schedule::{
    InsertItemAtomicRequest, NewSchedule, PatchSchedule, PatchScheduleItem, ReorderScheduleItem,
    Schedule, ScheduleItem, DEFAULT_END_MIN, DEFAULT_START_MIN,
};
use crate::resolve::{compute_layout, ResolvedPayload, UserResolveContext};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/schedules", get(list_schedules).post(create_schedule))
        .route(
            "/schedules/{id}",
            get(get_schedule)
                .patch(patch_schedule)
                .delete(delete_schedule),
        )
        .route("/schedules/{id}/items", get(list_items))
        // Atomic Add Item: insert plus solver position updates in one transaction and history entry.
        .route("/schedules/{id}/items/insert", post(insert_item_atomic))
        .route(
            "/schedule_items/{id}",
            axum::routing::patch(patch_item).delete(delete_item),
        )
        .route("/schedule_items/{id}/reorder", post(reorder_item))
        // Define this literal path before /schedules/{id}/layout so axum matches it first.
        .route("/schedules/layouts", get(get_layouts_batch))
        .route("/schedules/{id}/layout", get(get_layout))
}

async fn list_schedules(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<Schedule>>> {
    let rows: Vec<Schedule> = sqlx::query_as::<_, Schedule>(
        "SELECT id, user_id, name, start_min, end_min
           FROM schedules WHERE user_id = ? ORDER BY name ASC, id ASC",
    )
    .bind(user.0)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

async fn get_schedule(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Schedule>> {
    Ok(Json(load_schedule(&state.pool, user.0, id).await?))
}

async fn create_schedule(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<NewSchedule>,
) -> AppResult<(StatusCode, Json<Schedule>)> {
    let name = body.name.unwrap_or_else(|| "Untitled schedule".to_string());
    let start_min = body.start_min.unwrap_or(DEFAULT_START_MIN);
    let end_min = body.end_min.unwrap_or(DEFAULT_END_MIN);
    validate_schedule_bounds(start_min, end_min)?;
    let row: (i64,) = sqlx::query_as(
        "INSERT INTO schedules (user_id, name, start_min, end_min) VALUES (?, ?, ?, ?) RETURNING id",
    )
    .bind(user.0)
    .bind(&name)
    .bind(start_min)
    .bind(end_min)
    .fetch_one(&state.pool)
    .await?;
    let s = load_schedule(&state.pool, user.0, row.0).await?;
    Ok((StatusCode::CREATED, Json(s)))
}

async fn patch_schedule(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(body): Json<PatchSchedule>,
) -> AppResult<Json<Schedule>> {
    let mut tx = state.pool.begin().await?;
    let existing = load_schedule_tx(&mut tx, user.0, id).await?;
    let new_name = body.name.unwrap_or(existing.name.clone());
    let new_start = body.start_min.unwrap_or(existing.start_min);
    let new_end = body.end_min.unwrap_or(existing.end_min);
    validate_schedule_bounds(new_start, new_end)?;

    sqlx::query("UPDATE schedules SET name = ?, start_min = ?, end_min = ? WHERE id = ?")
        .bind(&new_name)
        .bind(new_start)
        .bind(new_end)
        .bind(id)
        .execute(&mut *tx)
        .await?;

    // Reject new bounds that push an existing item out-of-range or below the 1-minute floor.
    let items = load_items_tx(&mut tx, id).await?;
    let old_start = existing.start_min;
    let old_end = existing.end_min;
    let updated = Schedule {
        start_min: new_start,
        end_min: new_end,
        ..existing
    };
    validate_layout(&updated, &items)?;

    // Record an undoable entry when the bounds move; name-only edits stay outside history (apply_ops patches bounds only).
    if new_start != old_start || new_end != old_end {
        crate::history::record_history(
            &mut tx,
            user.0,
            crate::history::CTX_SCHEDULE,
            "patch_schedule",
            &[crate::history::SubOp::PatchSchedule {
                id,
                fields: serde_json::json!({ "start_min": new_start, "end_min": new_end }),
            }],
            &[crate::history::SubOp::PatchSchedule {
                id,
                fields: serde_json::json!({ "start_min": old_start, "end_min": old_end }),
            }],
        )
        .await?;
    }
    tx.commit().await?;
    Ok(Json(load_schedule(&state.pool, user.0, id).await?))
}

async fn delete_schedule(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<impl IntoResponse> {
    let mut tx = state.pool.begin().await?;
    let _existing = load_schedule_tx(&mut tx, user.0, id).await?;

    // Snapshot schedule, items, and bindings before delete so undo re-inserts them with original ids.
    let sched_snap = crate::history::snapshot_schedule(&mut tx, user.0, id)
        .await?
        .expect("schedule exists");
    let items = load_items_tx(&mut tx, id).await?;
    let mut item_snaps: Vec<serde_json::Value> = Vec::with_capacity(items.len());
    for it in &items {
        let snap = crate::history::snapshot_item(&mut tx, user.0, it.id)
            .await?
            .expect("item exists pre-delete");
        item_snaps.push(snap);
    }
    let override_date_row: Option<(time::Date,)> = sqlx::query_as(
        "SELECT date FROM calendar_date_overrides
           WHERE user_id = ? AND schedule_id = ?",
    )
    .bind(user.0)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    // A schedule may be bound to multiple weekdays; capture all so undo restores every binding.
    let weekday_rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT weekday FROM calendar_weekday_bindings
           WHERE user_id = ? AND schedule_id = ?",
    )
    .bind(user.0)
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    let weekdays: Vec<i64> = weekday_rows.into_iter().map(|(w,)| w).collect();

    // Forward drops bindings before the schedule; backward re-inserts schedule, items, then bindings (FK order).
    let mut forward: Vec<crate::history::SubOp> = Vec::new();
    let override_date_str: Option<String> = override_date_row.map(|(d,)| format_date_iso(d));
    if let Some(date) = &override_date_str {
        forward.push(crate::history::SubOp::DeleteOverride { date: date.clone() });
    }
    for wd in &weekdays {
        forward.push(crate::history::SubOp::DeleteWeekdayBinding { weekday: *wd });
    }
    forward.push(crate::history::SubOp::DeleteSchedule { id });

    let mut backward: Vec<crate::history::SubOp> = Vec::new();
    backward.push(crate::history::SubOp::InsertSchedule { row: sched_snap });
    for snap in item_snaps {
        backward.push(crate::history::SubOp::InsertItem { row: snap });
    }
    if let Some(date) = &override_date_str {
        backward.push(crate::history::SubOp::InsertOverride {
            date: date.clone(),
            schedule_id: id,
        });
    }
    for wd in &weekdays {
        backward.push(crate::history::SubOp::InsertWeekdayBinding {
            weekday: *wd,
            schedule_id: id,
        });
    }

    // Delete order mirrors the forward ops so redo reproduces this exact post-state.
    if let Some(date) = &override_date_str {
        let parsed = parse_date_iso(date)?;
        sqlx::query(
            "DELETE FROM calendar_date_overrides
               WHERE user_id = ? AND date = ?",
        )
        .bind(user.0)
        .bind(parsed)
        .execute(&mut *tx)
        .await?;
    }
    for wd in &weekdays {
        // Delete the binding outright (not via SET NULL cascade) so no dangling rows remain.
        sqlx::query(
            "DELETE FROM calendar_weekday_bindings
               WHERE user_id = ? AND weekday = ?",
        )
        .bind(user.0)
        .bind(*wd)
        .execute(&mut *tx)
        .await?;
    }
    let deleted = sqlx::query("DELETE FROM schedules WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user.0)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if deleted == 0 {
        // Concurrent delete won the race; roll back and let the client refetch.
        return Err(AppError::NotFound);
    }

    crate::history::record_history(
        &mut tx,
        user.0,
        crate::history::CTX_SCHEDULE,
        "delete_schedule",
        &forward,
        &backward,
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

fn format_date_iso(d: time::Date) -> String {
    let fmt = time::macros::format_description!("[year]-[month]-[day]");
    d.format(fmt).unwrap_or_default()
}

fn parse_date_iso(s: &str) -> AppResult<time::Date> {
    let fmt = time::macros::format_description!("[year]-[month]-[day]");
    time::Date::parse(s, fmt).map_err(|_| AppError::bad_request("bad date"))
}

async fn list_items(
    State(state): State<AppState>,
    user: AuthUser,
    Path(schedule_id): Path<i64>,
) -> AppResult<Json<Vec<ScheduleItem>>> {
    let _sched = load_schedule(&state.pool, user.0, schedule_id).await?;
    let rows: Vec<ScheduleItem> = load_items(&state.pool, schedule_id).await?;
    Ok(Json(rows))
}

/// Atomic Add Item: validate, apply solver reorders, insert at the chosen slot, validate layout, record one undoable history entry.
async fn insert_item_atomic(
    State(state): State<AppState>,
    user: AuthUser,
    Path(schedule_id): Path<i64>,
    Json(body): Json<InsertItemAtomicRequest>,
) -> AppResult<(StatusCode, Json<LayoutResponse>)> {
    let new_id = insert_item_atomic_tx(&state.pool, user.0, schedule_id, body).await?;
    let _ = new_id;
    let resp = build_layout_response(&state.pool, user.0, schedule_id).await?;
    Ok((StatusCode::CREATED, Json(resp)))
}

/// Transactional body of the atomic insert, extracted for unit tests; returns the new row id, rolls back on error.
pub async fn insert_item_atomic_tx(
    pool: &sqlx::SqlitePool,
    user_id: i64,
    schedule_id: i64,
    body: InsertItemAtomicRequest,
) -> AppResult<i64> {
    let mut tx = pool.begin().await?;
    let sched = load_schedule_tx(&mut tx, user_id, schedule_id).await?;

    let item_body = body.item;
    let duration_target = item_body.duration_target.unwrap_or(60);
    if duration_target <= 0 {
        return Err(AppError::validation("duration_target must be > 0"));
    }
    let project_rank = item_body.project_rank.unwrap_or(1);
    let task_rank = item_body.task_rank.unwrap_or(1);
    if project_rank <= 0 || task_rank <= 0 {
        return Err(AppError::validation("ranks must be > 0"));
    }
    validate_window(&sched, item_body.start_min, item_body.end_min)?;
    if let (Some(p), Some(t)) = (item_body.project_id, item_body.task_id) {
        validate_task_project_match(&mut tx, user_id, t, p).await?;
    }

    // Validate each reorders.id belongs here, capture prior positions for undo, reject duplicates.
    let mut seen_ids: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut prior_positions: std::collections::HashMap<i64, f64> = std::collections::HashMap::new();
    for upd in &body.reorders {
        if !seen_ids.insert(upd.id) {
            return Err(AppError::bad_request("reorders contains duplicate id"));
        }
        let row: Option<(i64, f64)> =
            sqlx::query_as("SELECT schedule_id, position FROM schedule_items WHERE id = ?")
                .bind(upd.id)
                .fetch_optional(&mut *tx)
                .await?;
        let Some((sid, prev)) = row else {
            return Err(AppError::bad_request("reorders id not found"));
        };
        if sid != schedule_id {
            return Err(AppError::bad_request("reorders id not in same schedule"));
        }
        prior_positions.insert(upd.id, prev);
    }

    // Apply reorders first so the new row's slot sees post-reorder neighbours; layout validity checked at the end.
    for upd in &body.reorders {
        sqlx::query("UPDATE schedule_items SET position = ? WHERE id = ?")
            .bind(upd.position)
            .bind(upd.id)
            .execute(&mut *tx)
            .await?;
    }

    // after_item_id picks the slot (tail default, head when null); helper rebalances when the gap is too small.
    let mut rebalance_changes: Vec<(i64, f64, f64)> = Vec::new();
    let pos: f64 = match item_body.after_item_id {
        None => {
            let max: Option<f64> = sqlx::query_as::<_, (Option<f64>,)>(
                "SELECT MAX(position) FROM schedule_items WHERE schedule_id = ?",
            )
            .bind(schedule_id)
            .fetch_one(&mut *tx)
            .await?
            .0;
            max.map(|m| m + 1.0).unwrap_or(1.0)
        }
        Some(after_opt) => {
            if let Some(after_id) = after_opt {
                let row: Option<(i64,)> =
                    sqlx::query_as("SELECT schedule_id FROM schedule_items WHERE id = ?")
                        .bind(after_id)
                        .fetch_optional(&mut *tx)
                        .await?;
                let Some((sid,)) = row else {
                    return Err(AppError::bad_request("after_item_id not found"));
                };
                if sid != schedule_id {
                    return Err(AppError::bad_request("after_item_id not in same schedule"));
                }
            }
            let rows: Vec<(i64, f64)> = sqlx::query_as(
                "SELECT id, position FROM schedule_items WHERE schedule_id = ? \
                   ORDER BY position ASC, id ASC",
            )
            .bind(schedule_id)
            .fetch_all(&mut *tx)
            .await?;
            // Sentinel -1: compute_reorder_position drops the moved row first, so an absent id is fine.
            let plan = compute_reorder_position(&rows, -1, after_opt)?;
            if let Some(rebalanced) = plan.rebalance {
                let prior_lookup: std::collections::HashMap<i64, f64> =
                    rows.iter().copied().collect();
                for (rid, p) in rebalanced {
                    if rid == -1 {
                        continue;
                    }
                    if let Some(&prev) = prior_lookup.get(&rid) {
                        if (prev - p).abs() > f64::EPSILON {
                            rebalance_changes.push((rid, prev, p));
                        }
                    }
                    sqlx::query("UPDATE schedule_items SET position = ? WHERE id = ?")
                        .bind(p)
                        .bind(rid)
                        .execute(&mut *tx)
                        .await?;
                }
            }
            plan.new_position
        }
    };

    let use_inline = item_body.use_inline.unwrap_or(true);
    // Default "blue" when color omitted; binding it explicitly keeps the row deterministic across UPDATEs/UNDOs.
    let color = item_body.color.unwrap_or_else(|| "blue".to_string());
    let row: (i64,) = sqlx::query_as(
        "INSERT INTO schedule_items (
            schedule_id, position, start_min, end_min, duration_target,
            use_inline, inline_label, inline_description, color,
            project_id, project_rank, task_id, task_rank
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(schedule_id)
    .bind(pos)
    .bind(item_body.start_min)
    .bind(item_body.end_min)
    .bind(duration_target)
    .bind(use_inline)
    .bind(item_body.inline_label)
    .bind(item_body.inline_description)
    .bind(&color)
    .bind(item_body.project_id)
    .bind(project_rank)
    .bind(item_body.task_id)
    .bind(task_rank)
    .fetch_one(&mut *tx)
    .await?;
    let new_id = row.0;

    let items = load_items_tx(&mut tx, schedule_id).await?;
    validate_layout(&sched, &items)?;

    // Snapshot carries the inserted row's id so redo restores it with the same id.
    let snap = crate::history::snapshot_item(&mut tx, user_id, new_id)
        .await?
        .expect("just inserted");

    // Forward: all PatchItem position updates first (so redo re-inserts into the rebalanced layout), then InsertItem.
    let mut forward: Vec<crate::history::SubOp> = Vec::new();
    for upd in &body.reorders {
        forward.push(crate::history::SubOp::PatchItem {
            id: upd.id,
            fields: serde_json::json!({ "position": upd.position }),
        });
    }
    for (rid, _prev, p) in &rebalance_changes {
        forward.push(crate::history::SubOp::PatchItem {
            id: *rid,
            fields: serde_json::json!({ "position": *p }),
        });
    }
    forward.push(crate::history::SubOp::InsertItem { row: snap });

    // Backward: delete the new row first, then revert positions in reverse to reach the pre-insert state.
    let mut backward: Vec<crate::history::SubOp> = Vec::new();
    backward.push(crate::history::SubOp::DeleteItem { id: new_id });
    for (rid, prev, _p) in rebalance_changes.iter().rev() {
        backward.push(crate::history::SubOp::PatchItem {
            id: *rid,
            fields: serde_json::json!({ "position": *prev }),
        });
    }
    for upd in body.reorders.iter().rev() {
        let prev = prior_positions
            .get(&upd.id)
            .copied()
            .expect("captured above");
        backward.push(crate::history::SubOp::PatchItem {
            id: upd.id,
            fields: serde_json::json!({ "position": prev }),
        });
    }

    crate::history::record_history(
        &mut tx,
        user_id,
        crate::history::CTX_SCHEDULE,
        "insert_item_atomic",
        &forward,
        &backward,
    )
    .await?;

    tx.commit().await?;
    Ok(new_id)
}

async fn patch_item(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(body): Json<PatchScheduleItem>,
) -> AppResult<Json<ScheduleItem>> {
    let mut tx = state.pool.begin().await?;
    let item = load_item_tx(&mut tx, user.0, id).await?;
    let sched = load_schedule_tx(&mut tx, user.0, item.schedule_id).await?;
    let before = crate::history::snapshot_item(&mut tx, user.0, id)
        .await?
        .expect("item exists");

    let new_start = if body.start_min.is_some() {
        body.start_min.unwrap()
    } else {
        item.start_min
    };
    let new_end = if body.end_min.is_some() {
        body.end_min.unwrap()
    } else {
        item.end_min
    };
    let new_duration_target = body.duration_target.unwrap_or(item.duration_target);
    if new_duration_target <= 0 {
        return Err(AppError::validation("duration_target must be > 0"));
    }
    let new_use_inline = body.use_inline.unwrap_or(item.use_inline);
    let new_inline_label = if body.inline_label.is_some() {
        body.inline_label.unwrap()
    } else {
        item.inline_label.clone()
    };
    let new_inline_description = if body.inline_description.is_some() {
        body.inline_description.unwrap()
    } else {
        item.inline_description.clone()
    };
    let new_color = body.color.clone().unwrap_or_else(|| item.color.clone());
    let new_project_id = if body.project_id.is_some() {
        body.project_id.unwrap()
    } else {
        item.project_id
    };
    let new_project_rank = body.project_rank.unwrap_or(item.project_rank);
    let new_task_id = if body.task_id.is_some() {
        body.task_id.unwrap()
    } else {
        item.task_id
    };
    let new_task_rank = body.task_rank.unwrap_or(item.task_rank);
    if new_project_rank <= 0 || new_task_rank <= 0 {
        return Err(AppError::validation("ranks must be > 0"));
    }

    // Grow the schedule to fit new fixed anchors rather than rejecting; clearing an anchor never shrinks it.
    let mut sched_new_start = sched.start_min;
    let mut sched_new_end = sched.end_min;
    if let Some(s) = new_start {
        if s < sched_new_start {
            sched_new_start = s;
        }
        if s > sched_new_end {
            sched_new_end = s;
        }
    }
    if let Some(e) = new_end {
        if e > sched_new_end {
            sched_new_end = e;
        }
        if e < sched_new_start {
            sched_new_start = e;
        }
    }
    let sched_changed = sched_new_start != sched.start_min || sched_new_end != sched.end_min;
    if sched_changed {
        validate_schedule_bounds(sched_new_start, sched_new_end)?;
        sqlx::query("UPDATE schedules SET start_min = ?, end_min = ? WHERE id = ?")
            .bind(sched_new_start)
            .bind(sched_new_end)
            .bind(sched.id)
            .execute(&mut *tx)
            .await?;
    }
    let sched_effective = crate::models::schedule::Schedule {
        start_min: sched_new_start,
        end_min: sched_new_end,
        ..sched.clone()
    };
    validate_window(&sched_effective, new_start, new_end)?;
    if let (Some(p), Some(t)) = (new_project_id, new_task_id) {
        validate_task_project_match(&mut tx, user.0, t, p).await?;
    }

    sqlx::query(
        "UPDATE schedule_items SET
            start_min = ?, end_min = ?, duration_target = ?,
            use_inline = ?,
            inline_label = ?, inline_description = ?,
            color = ?,
            project_id = ?, project_rank = ?,
            task_id = ?, task_rank = ?
         WHERE id = ?",
    )
    .bind(new_start)
    .bind(new_end)
    .bind(new_duration_target)
    .bind(new_use_inline)
    .bind(&new_inline_label)
    .bind(&new_inline_description)
    .bind(&new_color)
    .bind(new_project_id)
    .bind(new_project_rank)
    .bind(new_task_id)
    .bind(new_task_rank)
    .bind(id)
    .execute(&mut *tx)
    .await?;

    let items = load_items_tx(&mut tx, item.schedule_id).await?;
    validate_layout(&sched_effective, &items)?;
    let updated = items.iter().find(|i| i.id == id).cloned().unwrap();
    let after = crate::history::snapshot_item(&mut tx, user.0, id)
        .await?
        .expect("item exists");

    // Pair the schedule-expansion op with the item patch so undo restores both.
    let mut forward = Vec::new();
    let mut backward = Vec::new();
    if sched_changed {
        forward.push(crate::history::SubOp::PatchSchedule {
            id: sched.id,
            fields: serde_json::json!({
                "start_min": sched_new_start,
                "end_min": sched_new_end,
            }),
        });
        backward.push(crate::history::SubOp::PatchSchedule {
            id: sched.id,
            fields: serde_json::json!({
                "start_min": sched.start_min,
                "end_min": sched.end_min,
            }),
        });
    }
    forward.push(crate::history::SubOp::PatchItem { id, fields: after });
    backward.insert(0, crate::history::SubOp::PatchItem { id, fields: before });
    crate::history::record_history(
        &mut tx,
        user.0,
        crate::history::CTX_SCHEDULE,
        "patch_item",
        &forward,
        &backward,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(updated))
}

async fn delete_item(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<impl IntoResponse> {
    let mut tx = state.pool.begin().await?;
    let _item = load_item_tx(&mut tx, user.0, id).await?;
    let snap = crate::history::snapshot_item(&mut tx, user.0, id)
        .await?
        .expect("item exists");
    sqlx::query("DELETE FROM schedule_items WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    crate::history::record_history(
        &mut tx,
        user.0,
        crate::history::CTX_SCHEDULE,
        "delete_item",
        &[crate::history::SubOp::DeleteItem { id }],
        &[crate::history::SubOp::InsertItem { row: snap }],
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn reorder_item(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(body): Json<ReorderScheduleItem>,
) -> AppResult<Json<ScheduleItem>> {
    let mut tx = state.pool.begin().await?;
    let item = load_item_tx(&mut tx, user.0, id).await?;
    let sched = load_schedule_tx(&mut tx, user.0, item.schedule_id).await?;
    let before_pos = item.position;

    if let Some(after) = body.after_item_id {
        let row: Option<(i64,)> =
            sqlx::query_as("SELECT schedule_id FROM schedule_items WHERE id = ?")
                .bind(after)
                .fetch_optional(&mut *tx)
                .await?;
        let Some((sid,)) = row else {
            return Err(AppError::bad_request("after_item_id not found"));
        };
        if sid != item.schedule_id {
            return Err(AppError::bad_request("after_item_id not in same schedule"));
        }
    }

    // Auto-expand the window for new fixed anchors, mirroring patch_item, instead of failing layout validation.
    let mut sched_new_start = sched.start_min;
    let mut sched_new_end = sched.end_min;
    for upd in &body.anchor_updates {
        if let Some(Some(s)) = upd.start_min {
            if s < sched_new_start {
                sched_new_start = s;
            }
            if s > sched_new_end {
                sched_new_end = s;
            }
        }
        if let Some(Some(e)) = upd.end_min {
            if e > sched_new_end {
                sched_new_end = e;
            }
            if e < sched_new_start {
                sched_new_start = e;
            }
        }
    }
    let sched_changed = sched_new_start != sched.start_min || sched_new_end != sched.end_min;
    if sched_changed {
        validate_schedule_bounds(sched_new_start, sched_new_end)?;
        sqlx::query("UPDATE schedules SET start_min = ?, end_min = ? WHERE id = ?")
            .bind(sched_new_start)
            .bind(sched_new_end)
            .bind(sched.id)
            .execute(&mut *tx)
            .await?;
    }
    let sched_effective = crate::models::schedule::Schedule {
        start_min: sched_new_start,
        end_min: sched_new_end,
        ..sched.clone()
    };

    // Apply anchor updates first without intermediate layout validation; intermediate state may be non-monotonic.
    let mut anchor_before: Vec<crate::history::SubOp> = Vec::new();
    let mut anchor_after: Vec<crate::history::SubOp> = Vec::new();
    let mut seen_anchor_ids: std::collections::HashSet<i64> = std::collections::HashSet::new();
    for upd in &body.anchor_updates {
        if !seen_anchor_ids.insert(upd.id) {
            return Err(AppError::bad_request(
                "anchor_updates contains duplicate id",
            ));
        }
        let existing = load_item_tx(&mut tx, user.0, upd.id).await?;
        if existing.schedule_id != item.schedule_id {
            return Err(AppError::bad_request(
                "anchor_updates id not in same schedule",
            ));
        }
        if upd.start_min.is_none() && upd.end_min.is_none() {
            continue;
        }
        // Write both anchors in one UPDATE; separate writes could violate the end_min > start_min CHECK mid-statement.
        let new_start = upd.start_min.unwrap_or(existing.start_min);
        let new_end = upd.end_min.unwrap_or(existing.end_min);
        sqlx::query("UPDATE schedule_items SET start_min = ?, end_min = ? WHERE id = ?")
            .bind(new_start)
            .bind(new_end)
            .bind(upd.id)
            .execute(&mut *tx)
            .await?;
        let mut new_fields = serde_json::Map::new();
        let mut old_fields = serde_json::Map::new();
        if let Some(new_start) = upd.start_min {
            new_fields.insert("start_min".into(), serde_json::json!(new_start));
            old_fields.insert("start_min".into(), serde_json::json!(existing.start_min));
        }
        if let Some(new_end) = upd.end_min {
            new_fields.insert("end_min".into(), serde_json::json!(new_end));
            old_fields.insert("end_min".into(), serde_json::json!(existing.end_min));
        }
        anchor_after.push(crate::history::SubOp::PatchItem {
            id: upd.id,
            fields: serde_json::Value::Object(new_fields),
        });
        anchor_before.push(crate::history::SubOp::PatchItem {
            id: upd.id,
            fields: serde_json::Value::Object(old_fields),
        });
    }

    let rows: Vec<(i64, f64)> = sqlx::query_as(
        "SELECT id, position FROM schedule_items WHERE schedule_id = ? ORDER BY position ASC, id ASC",
    )
    .bind(item.schedule_id)
    .fetch_all(&mut *tx)
    .await?;
    let plan = compute_reorder_position(&rows, id, body.after_item_id)?;
    if let Some(rebalanced) = plan.rebalance {
        for (rid, pos) in rebalanced {
            sqlx::query("UPDATE schedule_items SET position = ? WHERE id = ?")
                .bind(pos)
                .bind(rid)
                .execute(&mut *tx)
                .await?;
        }
    } else {
        sqlx::query("UPDATE schedule_items SET position = ? WHERE id = ?")
            .bind(plan.new_position)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    let items = load_items_tx(&mut tx, item.schedule_id).await?;
    validate_layout(&sched_effective, &items)?;
    let updated = items.iter().find(|i| i.id == id).cloned().unwrap();
    let after_pos = updated.position;

    // Forward: expansion, anchors, position; backward is the strict reverse. Order matters for CHECK constraints.
    let mut forward = Vec::new();
    let mut backward = Vec::new();
    if sched_changed {
        forward.push(crate::history::SubOp::PatchSchedule {
            id: sched.id,
            fields: serde_json::json!({
                "start_min": sched_new_start,
                "end_min": sched_new_end,
            }),
        });
    }
    forward.extend(anchor_after);
    forward.push(crate::history::SubOp::PatchItem {
        id,
        fields: serde_json::json!({ "position": after_pos }),
    });
    backward.push(crate::history::SubOp::PatchItem {
        id,
        fields: serde_json::json!({ "position": before_pos }),
    });
    backward.extend(anchor_before.into_iter().rev());
    if sched_changed {
        backward.push(crate::history::SubOp::PatchSchedule {
            id: sched.id,
            fields: serde_json::json!({
                "start_min": sched.start_min,
                "end_min": sched.end_min,
            }),
        });
    }

    crate::history::record_history(
        &mut tx,
        user.0,
        crate::history::CTX_SCHEDULE,
        "reorder_item",
        &forward,
        &backward,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(updated))
}

#[derive(Debug, Serialize)]
pub struct LayoutResponse {
    pub schedule: Schedule,
    pub items: Vec<LayoutItem>,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct LayoutItem {
    // Flatten raw ScheduleItem columns for existing consumers; new consumers should prefer payload.
    #[serde(flatten)]
    pub item: ScheduleItem,
    pub assigned_start: i64,
    pub assigned_end: i64,
    pub flags: crate::resolve::ItemFlags,
    /// Server-resolved label/color/project info, mirroring `DayItem.payload`, so views render without client-side joins.
    pub payload: ResolvedPayload,
}

async fn get_layout(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<LayoutResponse>> {
    Ok(Json(build_layout_response(&state.pool, user.0, id).await?))
}

/// Build the `LayoutResponse` for one schedule; shared by the GET layout endpoint and atomic-insert handler.
async fn build_layout_response(
    pool: &sqlx::SqlitePool,
    user_id: i64,
    id: i64,
) -> AppResult<LayoutResponse> {
    let sched = load_schedule(pool, user_id, id).await?;
    let items = load_items(pool, id).await?;
    let layout = compute_layout(&sched, &items);
    // One projects/tasks/deps snapshot resolves every item's payload in 3 DB round-trips total.
    let ctx = UserResolveContext::load(pool, user_id).await?;
    let pairs: Vec<LayoutItem> = items
        .into_iter()
        .zip(layout.items.into_iter())
        .map(|(it, lo)| {
            let payload = ctx.resolve(&it);
            LayoutItem {
                item: it,
                assigned_start: lo.assigned_start,
                assigned_end: lo.assigned_end,
                flags: lo.flags,
                payload,
            }
        })
        .collect();
    let errors = layout
        .errors
        .iter()
        .map(|e| format!("{:?}", e))
        .collect::<Vec<_>>();
    Ok(LayoutResponse {
        schedule: sched,
        items: pairs,
        errors,
    })
}

#[derive(Debug, Deserialize)]
struct LayoutsBatchQuery {
    /// Comma-separated schedule ids.
    ids: String,
}

/// Batch layout fetch; silently omits unknown or non-owned ids so callers can pass an unvalidated id union.
async fn get_layouts_batch(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<LayoutsBatchQuery>,
) -> AppResult<Json<BTreeMap<String, LayoutResponse>>> {
    let ids: Vec<i64> = q
        .ids
        .split(',')
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse::<i64>().ok())
        .collect();
    let mut out: BTreeMap<String, LayoutResponse> = BTreeMap::new();
    if ids.is_empty() {
        return Ok(Json(out));
    }
    if ids.len() > 256 {
        return Err(AppError::validation("too many ids (max 256)"));
    }
    // Load the project/task/dep snapshot once and reuse it, avoiding an O(schedules × items × queries) blow-up.
    let ctx = UserResolveContext::load(&state.pool, user.0).await?;
    for id in ids {
        let sched = match sqlx::query_as::<_, Schedule>(
            "SELECT id, user_id, name, start_min, end_min
               FROM schedules WHERE id = ? AND user_id = ?",
        )
        .bind(id)
        .bind(user.0)
        .fetch_optional(&state.pool)
        .await?
        {
            Some(s) => s,
            None => continue,
        };
        let items = load_items(&state.pool, id).await?;
        let layout = compute_layout(&sched, &items);
        let pairs: Vec<LayoutItem> = items
            .into_iter()
            .zip(layout.items.into_iter())
            .map(|(it, lo)| {
                let payload = ctx.resolve(&it);
                LayoutItem {
                    item: it,
                    assigned_start: lo.assigned_start,
                    assigned_end: lo.assigned_end,
                    flags: lo.flags,
                    payload,
                }
            })
            .collect();
        let errors = layout
            .errors
            .iter()
            .map(|e| format!("{:?}", e))
            .collect::<Vec<_>>();
        out.insert(
            id.to_string(),
            LayoutResponse {
                schedule: sched,
                items: pairs,
                errors,
            },
        );
    }
    Ok(Json(out))
}

// ---------- helpers ----------

pub fn validate_schedule_bounds(start_min: i64, end_min: i64) -> AppResult<()> {
    if !(0..=1439).contains(&start_min) {
        return Err(AppError::validation("start_min must be in [0, 1439]"));
    }
    if end_min <= start_min || end_min > start_min + 1440 {
        return Err(AppError::validation(
            "end_min must satisfy start_min < end_min <= start_min + 1440",
        ));
    }
    Ok(())
}

pub fn validate_window(
    sched: &Schedule,
    start_min: Option<i64>,
    end_min: Option<i64>,
) -> AppResult<()> {
    if let Some(s) = start_min {
        if s < sched.start_min || s > sched.end_min {
            return Err(AppError::validation(
                "item start_min out of schedule window",
            ));
        }
    }
    if let Some(e) = end_min {
        if e < sched.start_min || e > sched.end_min {
            return Err(AppError::validation("item end_min out of schedule window"));
        }
    }
    if let (Some(s), Some(e)) = (start_min, end_min) {
        if e <= s {
            return Err(AppError::validation("end_min must be > start_min"));
        }
    }
    Ok(())
}

async fn validate_task_project_match(
    tx: &mut Transaction<'_, Sqlite>,
    user_id: i64,
    task_id: i64,
    project_id: i64,
) -> AppResult<()> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT t.project_id FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE t.id = ? AND p.user_id = ?",
    )
    .bind(task_id)
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((tp,)) = row else {
        return Err(AppError::bad_request("task_id not found"));
    };
    if tp != project_id {
        return Err(AppError::bad_request(
            "task_id does not belong to the specified project",
        ));
    }
    Ok(())
}

pub fn validate_layout(sched: &Schedule, items: &[ScheduleItem]) -> AppResult<()> {
    let layout = compute_layout(sched, items);
    for (i, item) in layout.items.iter().enumerate() {
        if item.flags.below_min {
            return Err(AppError::validation(format!(
                "item #{} would be below 1-minute minimum",
                i
            )));
        }
        if item.flags.out_of_bounds {
            return Err(AppError::validation(format!(
                "item #{} out of schedule window",
                i
            )));
        }
    }
    if layout
        .errors
        .iter()
        .any(|e| *e == crate::resolve::LayoutErrorKind::AnchorNonMonotonic)
    {
        return Err(AppError::validation(
            "fixed anchors are out of order with item position",
        ));
    }
    Ok(())
}

pub async fn load_schedule(pool: &sqlx::SqlitePool, user_id: i64, id: i64) -> AppResult<Schedule> {
    let row: Option<Schedule> = sqlx::query_as::<_, Schedule>(
        "SELECT id, user_id, name, start_min, end_min FROM schedules WHERE id = ? AND user_id = ?",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    row.ok_or(AppError::NotFound)
}

pub async fn load_schedule_tx(
    tx: &mut Transaction<'_, Sqlite>,
    user_id: i64,
    id: i64,
) -> AppResult<Schedule> {
    let row: Option<Schedule> = sqlx::query_as::<_, Schedule>(
        "SELECT id, user_id, name, start_min, end_min FROM schedules WHERE id = ? AND user_id = ?",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?;
    row.ok_or(AppError::NotFound)
}

pub async fn load_item_tx(
    tx: &mut Transaction<'_, Sqlite>,
    user_id: i64,
    id: i64,
) -> AppResult<ScheduleItem> {
    let row: Option<ScheduleItem> = sqlx::query_as::<_, ScheduleItem>(
        "SELECT si.id, si.schedule_id, si.position, si.start_min, si.end_min,
                si.duration_target, si.use_inline,
                si.inline_label, si.inline_description, si.color,
                si.project_id, si.project_rank, si.task_id, si.task_rank
           FROM schedule_items si JOIN schedules s ON s.id = si.schedule_id
          WHERE si.id = ? AND s.user_id = ?",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?;
    row.ok_or(AppError::NotFound)
}

pub async fn load_items(pool: &sqlx::SqlitePool, schedule_id: i64) -> AppResult<Vec<ScheduleItem>> {
    Ok(sqlx::query_as::<_, ScheduleItem>(
        "SELECT id, schedule_id, position, start_min, end_min, duration_target,
                use_inline, inline_label, inline_description, color,
                project_id, project_rank, task_id, task_rank
           FROM schedule_items WHERE schedule_id = ? ORDER BY position ASC, id ASC",
    )
    .bind(schedule_id)
    .fetch_all(pool)
    .await?)
}

pub async fn load_items_tx(
    tx: &mut Transaction<'_, Sqlite>,
    schedule_id: i64,
) -> AppResult<Vec<ScheduleItem>> {
    Ok(sqlx::query_as::<_, ScheduleItem>(
        "SELECT id, schedule_id, position, start_min, end_min, duration_target,
                use_inline, inline_label, inline_description, color,
                project_id, project_rank, task_id, task_rank
           FROM schedule_items WHERE schedule_id = ? ORDER BY position ASC, id ASC",
    )
    .bind(schedule_id)
    .fetch_all(&mut **tx)
    .await?)
}

#[cfg(test)]
mod insert_atomic_tests {
    //! Unit tests for insert_item_atomic_tx: bare insert, reorders, validation rollback, and undo/redo round-trip.
    use super::*;
    use crate::history::{apply_ops, SubOp, CTX_SCHEDULE};
    use crate::models::schedule::{NewScheduleItem, PositionUpdate};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::SqlitePool;
    use std::str::FromStr;

    async fn setup_pool() -> SqlitePool {
        let opts = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .expect("connect");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("migrate");
        pool
    }

    async fn seed_user(pool: &SqlitePool) -> i64 {
        let (id,): (i64,) = sqlx::query_as(
            "INSERT INTO users (username, password_hash) VALUES ('u', 'x') RETURNING id",
        )
        .fetch_one(pool)
        .await
        .expect("seed user");
        id
    }

    async fn seed_schedule(pool: &SqlitePool, user_id: i64) -> i64 {
        let (sid,): (i64,) = sqlx::query_as(
            "INSERT INTO schedules (user_id, name, start_min, end_min)
             VALUES (?, 'S', 480, 720) RETURNING id",
        )
        .bind(user_id)
        .fetch_one(pool)
        .await
        .expect("seed schedule");
        sid
    }

    async fn seed_dyn_item(pool: &SqlitePool, schedule_id: i64, pos: f64, label: &str) -> i64 {
        let (iid,): (i64,) = sqlx::query_as(
            "INSERT INTO schedule_items
               (schedule_id, position, duration_target, use_inline, inline_label, color)
             VALUES (?, ?, 60, 1, ?, 'blue') RETURNING id",
        )
        .bind(schedule_id)
        .bind(pos)
        .bind(label)
        .fetch_one(pool)
        .await
        .expect("seed item");
        iid
    }

    fn empty_item_body() -> NewScheduleItem {
        NewScheduleItem {
            start_min: None,
            end_min: None,
            duration_target: Some(60),
            use_inline: Some(true),
            inline_label: Some("new".to_string()),
            inline_description: None,
            color: Some("orange".to_string()),
            project_id: None,
            project_rank: None,
            task_id: None,
            task_rank: None,
            after_item_id: None,
        }
    }

    #[tokio::test]
    async fn insert_no_reorders_appends_and_records_history() {
        let pool = setup_pool().await;
        let user_id = seed_user(&pool).await;
        let sid = seed_schedule(&pool, user_id).await;
        let _a = seed_dyn_item(&pool, sid, 1.0, "A").await;

        let body = InsertItemAtomicRequest {
            item: empty_item_body(),
            reorders: vec![],
        };
        let new_id = insert_item_atomic_tx(&pool, user_id, sid, body)
            .await
            .expect("insert ok");

        // New item appends past the existing tail when after_item_id is omitted.
        let items: Vec<(i64, f64)> = sqlx::query_as(
            "SELECT id, position FROM schedule_items
               WHERE schedule_id = ? ORDER BY position ASC, id ASC",
        )
        .bind(sid)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(items.len(), 2, "old + new item");
        assert_eq!(items[1].0, new_id, "new row at the tail");

        let (op_kind,): (String,) = sqlx::query_as(
            "SELECT op FROM history WHERE user_id = ? AND context = ?
              ORDER BY id DESC LIMIT 1",
        )
        .bind(user_id)
        .bind(CTX_SCHEDULE)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(op_kind, "insert_item_atomic");
    }

    #[tokio::test]
    async fn insert_with_reorders_applies_both_and_history_records_both() {
        let pool = setup_pool().await;
        let user_id = seed_user(&pool).await;
        let sid = seed_schedule(&pool, user_id).await;
        let a = seed_dyn_item(&pool, sid, 1.0, "A").await;
        let b = seed_dyn_item(&pool, sid, 2.0, "B").await;

        // Swap A and B, insert the new row after the new tail (A).
        let mut item = empty_item_body();
        item.after_item_id = Some(Some(a));
        let body = InsertItemAtomicRequest {
            item,
            reorders: vec![
                PositionUpdate {
                    id: a,
                    position: 2.0,
                },
                PositionUpdate {
                    id: b,
                    position: 1.0,
                },
            ],
        };
        let new_id = insert_item_atomic_tx(&pool, user_id, sid, body)
            .await
            .expect("insert ok");

        let items: Vec<(i64, f64)> = sqlx::query_as(
            "SELECT id, position FROM schedule_items
               WHERE schedule_id = ? ORDER BY position ASC, id ASC",
        )
        .bind(sid)
        .fetch_all(&pool)
        .await
        .unwrap();
        // Final order: B (pos 1), A (pos 2), new (after A).
        assert_eq!(items[0].0, b);
        assert_eq!(items[1].0, a);
        assert_eq!(items[2].0, new_id);
        assert!(items[2].1 > items[1].1, "new row sits after A");

        let (forward, backward): (String, String) = sqlx::query_as(
            "SELECT forward, backward FROM history
               WHERE user_id = ? AND context = ?
               ORDER BY id DESC LIMIT 1",
        )
        .bind(user_id)
        .bind(CTX_SCHEDULE)
        .fetch_one(&pool)
        .await
        .unwrap();
        let fwd: Vec<SubOp> = serde_json::from_str(&forward).unwrap();
        let bwd: Vec<SubOp> = serde_json::from_str(&backward).unwrap();
        let patches = fwd
            .iter()
            .filter(|op| matches!(op, SubOp::PatchItem { .. }))
            .count();
        let inserts = fwd
            .iter()
            .filter(|op| matches!(op, SubOp::InsertItem { .. }))
            .count();
        assert_eq!(patches, 2, "forward records both position updates");
        assert_eq!(inserts, 1, "forward records the new row insert");

        match bwd.first() {
            Some(SubOp::DeleteItem { id }) => assert_eq!(*id, new_id),
            other => panic!("backward[0] = {other:?}"),
        }
    }

    #[tokio::test]
    async fn insert_validation_rolls_back_on_unknown_reorder_id() {
        let pool = setup_pool().await;
        let user_id = seed_user(&pool).await;
        let sid = seed_schedule(&pool, user_id).await;
        let _a = seed_dyn_item(&pool, sid, 1.0, "A").await;

        let body = InsertItemAtomicRequest {
            item: empty_item_body(),
            reorders: vec![PositionUpdate {
                id: 99_999,
                position: 1.5,
            }],
        };
        let err = insert_item_atomic_tx(&pool, user_id, sid, body)
            .await
            .expect_err("should fail");
        assert!(matches!(err, AppError::BadRequest(_)), "got {err:?}");

        // No new row landed (rollback held).
        let (n,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM schedule_items WHERE schedule_id = ?")
                .bind(sid)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(n, 1, "transaction rolled back on validation failure");

        let (h,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM history WHERE user_id = ? AND context = ?")
                .bind(user_id)
                .bind(CTX_SCHEDULE)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(h, 0);
    }

    #[tokio::test]
    async fn insert_validation_rejects_out_of_window_anchor() {
        // Fixed start outside the window: validate_window rejects it before any writes; transaction rolls back.
        let pool = setup_pool().await;
        let user_id = seed_user(&pool).await;
        let sid = seed_schedule(&pool, user_id).await; // window 480..720
        let a = seed_dyn_item(&pool, sid, 1.0, "A").await;

        let mut item = empty_item_body();
        item.start_min = Some(300); // before the window
        item.end_min = Some(360);
        let body = InsertItemAtomicRequest {
            item,
            reorders: vec![PositionUpdate {
                id: a,
                position: 1.5,
            }],
        };
        let err = insert_item_atomic_tx(&pool, user_id, sid, body)
            .await
            .expect_err("window rejection");
        assert!(matches!(err, AppError::Validation(_)), "got {err:?}");

        // Rollback: row count unchanged and A's position untouched.
        let items: Vec<(i64, f64)> =
            sqlx::query_as("SELECT id, position FROM schedule_items WHERE schedule_id = ?")
                .bind(sid)
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0], (a, 1.0), "A's position survived the rollback");

        let (h,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM history WHERE user_id = ? AND context = ?")
                .bind(user_id)
                .bind(CTX_SCHEDULE)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(h, 0);
    }

    #[tokio::test]
    async fn insert_undo_redo_round_trip() {
        // Drive the route sequence, then undo+redo via apply_ops; insert and position updates must reverse together.
        let pool = setup_pool().await;
        let user_id = seed_user(&pool).await;
        let sid = seed_schedule(&pool, user_id).await;
        let a = seed_dyn_item(&pool, sid, 1.0, "A").await;
        let b = seed_dyn_item(&pool, sid, 2.0, "B").await;

        let mut item = empty_item_body();
        item.after_item_id = Some(Some(a));
        let body = InsertItemAtomicRequest {
            item,
            reorders: vec![
                PositionUpdate {
                    id: a,
                    position: 2.0,
                },
                PositionUpdate {
                    id: b,
                    position: 1.0,
                },
            ],
        };
        let new_id = insert_item_atomic_tx(&pool, user_id, sid, body)
            .await
            .expect("insert");

        // ---- Undo ----
        let (backward,): (String,) = sqlx::query_as(
            "SELECT backward FROM history
               WHERE user_id = ? AND context = ?
               ORDER BY id DESC LIMIT 1",
        )
        .bind(user_id)
        .bind(CTX_SCHEDULE)
        .fetch_one(&pool)
        .await
        .unwrap();
        let ops: Vec<SubOp> = serde_json::from_str(&backward).unwrap();
        let mut tx = pool.begin().await.unwrap();
        apply_ops(&mut tx, user_id, &ops).await.unwrap();
        tx.commit().await.unwrap();

        // New row gone; A and B back at their original positions.
        let items: Vec<(i64, f64)> = sqlx::query_as(
            "SELECT id, position FROM schedule_items
               WHERE schedule_id = ? ORDER BY position ASC, id ASC",
        )
        .bind(sid)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0], (a, 1.0));
        assert_eq!(items[1], (b, 2.0));

        // ---- Redo ----
        let (forward,): (String,) = sqlx::query_as(
            "SELECT forward FROM history
               WHERE user_id = ? AND context = ?
               ORDER BY id DESC LIMIT 1",
        )
        .bind(user_id)
        .bind(CTX_SCHEDULE)
        .fetch_one(&pool)
        .await
        .unwrap();
        let ops: Vec<SubOp> = serde_json::from_str(&forward).unwrap();
        let mut tx = pool.begin().await.unwrap();
        apply_ops(&mut tx, user_id, &ops).await.unwrap();
        tx.commit().await.unwrap();

        // Back to post-insert state: B(1) < A(2) < new.
        let items: Vec<(i64, f64)> = sqlx::query_as(
            "SELECT id, position FROM schedule_items
               WHERE schedule_id = ? ORDER BY position ASC, id ASC",
        )
        .bind(sid)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].0, b);
        assert_eq!(items[1].0, a);
        assert_eq!(items[2].0, new_id, "redo restored same id");
    }
}
