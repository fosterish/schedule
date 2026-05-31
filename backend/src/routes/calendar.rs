use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::{Sqlite, Transaction};
use time::macros::format_description;
use time::Date;

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::history::{
    record_history, snapshot_item, snapshot_schedule, SubOp, CTX_SCHEDULE,
};
use crate::models::schedule::{Schedule, DEFAULT_END_MIN, DEFAULT_START_MIN};
use crate::routes::schedules::{load_items_tx, load_schedule, load_schedule_tx};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/calendar/weekdays",
            get(list_weekdays).put(put_weekdays),
        )
        .route("/calendar/weekdays/{weekday}", get(get_weekday))
        .route(
            "/calendar/weekdays/{weekday}/create",
            post(create_weekday_template),
        )
        .route("/calendar/overrides", get(list_overrides_range))
        .route(
            "/calendar/overrides/{date}",
            get(get_override).post(put_override).delete(delete_override),
        )
        .route(
            "/calendar/overrides/{date}/create",
            post(create_override),
        )
        .route(
            "/calendar/overrides/{date}/fork-weekday-template",
            post(fork_weekday_template),
        )
}

#[derive(Debug, Serialize)]
struct WeekdayRow {
    weekday: i64,
    schedule: Option<Schedule>,
}

#[derive(Debug, Serialize)]
struct OverrideRow {
    date: String,
    schedule: Schedule,
}

async fn list_weekdays(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<WeekdayRow>>> {
    let mut out = Vec::with_capacity(7);
    for w in 0..7i64 {
        let row: Option<(Option<i64>,)> = sqlx::query_as(
            "SELECT schedule_id FROM calendar_weekday_bindings WHERE user_id = ? AND weekday = ?",
        )
        .bind(user.0)
        .bind(w)
        .fetch_optional(&state.pool)
        .await?;
        let sched = match row.and_then(|(s,)| s) {
            Some(sid) => Some(load_schedule(&state.pool, user.0, sid).await?),
            None => None,
        };
        out.push(WeekdayRow { weekday: w, schedule: sched });
    }
    Ok(Json(out))
}

#[derive(Debug, serde::Deserialize)]
struct PutWeekdaysBody {
    bindings: Vec<WeekdayInput>,
}
#[derive(Debug, serde::Deserialize)]
struct WeekdayInput {
    weekday: i64,
    schedule_id: Option<i64>,
}

async fn put_weekdays(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<PutWeekdaysBody>,
) -> AppResult<Json<Vec<WeekdayRow>>> {
    let mut tx = state.pool.begin().await?;
    for b in body.bindings {
        if !(0..7).contains(&b.weekday) {
            return Err(AppError::validation("weekday must be 0..=6"));
        }
        if let Some(sid) = b.schedule_id {
            load_schedule_tx(&mut tx, user.0, sid).await?;
        }
        sqlx::query(
            "INSERT INTO calendar_weekday_bindings (user_id, weekday, schedule_id)
             VALUES (?, ?, ?)
             ON CONFLICT(user_id, weekday) DO UPDATE SET schedule_id = excluded.schedule_id",
        )
        .bind(user.0)
        .bind(b.weekday)
        .bind(b.schedule_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    list_weekdays(State(state), user).await
}

async fn get_weekday(
    State(state): State<AppState>,
    user: AuthUser,
    Path(weekday): Path<i64>,
) -> AppResult<Json<WeekdayRow>> {
    if !(0..7).contains(&weekday) {
        return Err(AppError::validation("weekday must be 0..=6"));
    }
    let row: Option<(Option<i64>,)> = sqlx::query_as(
        "SELECT schedule_id FROM calendar_weekday_bindings WHERE user_id = ? AND weekday = ?",
    )
    .bind(user.0)
    .bind(weekday)
    .fetch_optional(&state.pool)
    .await?;
    let sched = match row.and_then(|(s,)| s) {
        Some(sid) => Some(load_schedule(&state.pool, user.0, sid).await?),
        None => None,
    };
    Ok(Json(WeekdayRow { weekday, schedule: sched }))
}

async fn create_weekday_template(
    State(state): State<AppState>,
    user: AuthUser,
    Path(weekday): Path<i64>,
) -> AppResult<Json<WeekdayRow>> {
    if !(0..7).contains(&weekday) {
        return Err(AppError::validation("weekday must be 0..=6"));
    }
    let mut tx = state.pool.begin().await?;
    let existing: Option<(Option<i64>,)> = sqlx::query_as(
        "SELECT schedule_id FROM calendar_weekday_bindings WHERE user_id = ? AND weekday = ?",
    )
    .bind(user.0)
    .bind(weekday)
    .fetch_optional(&mut *tx)
    .await?;
    let sched = match existing.and_then(|(s,)| s) {
        Some(sid) => load_schedule_tx(&mut tx, user.0, sid).await?,
        None => {
            let name = WEEKDAY_NAMES[weekday as usize].to_string();
            let row: (i64,) = sqlx::query_as(
                "INSERT INTO schedules (user_id, name, start_min, end_min)
                 VALUES (?, ?, ?, ?) RETURNING id",
            )
            .bind(user.0)
            .bind(&name)
            .bind(DEFAULT_START_MIN)
            .bind(DEFAULT_END_MIN)
            .fetch_one(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT INTO calendar_weekday_bindings (user_id, weekday, schedule_id)
                 VALUES (?, ?, ?)
                 ON CONFLICT(user_id, weekday) DO UPDATE SET schedule_id = excluded.schedule_id",
            )
            .bind(user.0)
            .bind(weekday)
            .bind(row.0)
            .execute(&mut *tx)
            .await?;
            let sched = load_schedule_tx(&mut tx, user.0, row.0).await?;
            // Pair schedule insert with weekday binding so undo wipes both atomically.
            let snap = snapshot_schedule(&mut tx, user.0, row.0)
                .await?
                .expect("just inserted");
            record_history(
                &mut tx,
                user.0,
                CTX_SCHEDULE,
                "create_weekday_template",
                &[
                    SubOp::InsertSchedule { row: snap },
                    SubOp::InsertWeekdayBinding {
                        weekday,
                        schedule_id: row.0,
                    },
                ],
                &[
                    SubOp::DeleteWeekdayBinding { weekday },
                    SubOp::DeleteSchedule { id: row.0 },
                ],
            )
            .await?;
            sched
        }
    };
    tx.commit().await?;
    Ok(Json(WeekdayRow { weekday, schedule: Some(sched) }))
}

fn parse_date(s: &str) -> AppResult<Date> {
    let fmt = format_description!("[year]-[month]-[day]");
    Date::parse(s, fmt).map_err(|_| AppError::bad_request("invalid date; expected YYYY-MM-DD"))
}

fn format_date(d: Date) -> String {
    let fmt = format_description!("[year]-[month]-[day]");
    d.format(fmt).unwrap_or_default()
}

#[derive(Debug, Deserialize)]
struct RangeQuery {
    start: String,
    end: String,
}

/// Batch fetch all date overrides in `[start, end]` so a month loads in one request.
async fn list_overrides_range(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<RangeQuery>,
) -> AppResult<Json<Vec<OverrideRow>>> {
    let start = parse_date(&q.start)?;
    let end = parse_date(&q.end)?;
    if end < start {
        return Err(AppError::validation("end must be on or after start"));
    }
    let rows: Vec<(Date, i64)> = sqlx::query_as(
        "SELECT date, schedule_id
           FROM calendar_date_overrides
          WHERE user_id = ? AND date >= ? AND date <= ?
          ORDER BY date ASC",
    )
    .bind(user.0)
    .bind(start)
    .bind(end)
    .fetch_all(&state.pool)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for (date, sid) in rows {
        let sched = load_schedule(&state.pool, user.0, sid).await?;
        out.push(OverrideRow {
            date: format_date(date),
            schedule: sched,
        });
    }
    Ok(Json(out))
}

async fn get_override(
    State(state): State<AppState>,
    user: AuthUser,
    Path(date_str): Path<String>,
) -> AppResult<Json<Option<OverrideRow>>> {
    let date = parse_date(&date_str)?;
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT schedule_id FROM calendar_date_overrides WHERE user_id = ? AND date = ?",
    )
    .bind(user.0)
    .bind(date)
    .fetch_optional(&state.pool)
    .await?;
    let Some((sid,)) = row else {
        return Ok(Json(None));
    };
    let sched = load_schedule(&state.pool, user.0, sid).await?;
    Ok(Json(Some(OverrideRow {
        date: format_date(date),
        schedule: sched,
    })))
}

#[derive(Debug, serde::Deserialize)]
struct PutOverrideBody {
    schedule_id: i64,
}

async fn put_override(
    State(state): State<AppState>,
    user: AuthUser,
    Path(date_str): Path<String>,
    Json(body): Json<PutOverrideBody>,
) -> AppResult<Json<OverrideRow>> {
    let date = parse_date(&date_str)?;
    let mut tx = state.pool.begin().await?;
    let sched = load_schedule_tx(&mut tx, user.0, body.schedule_id).await?;
    sqlx::query(
        "INSERT INTO calendar_date_overrides (user_id, date, schedule_id) VALUES (?, ?, ?)
         ON CONFLICT(user_id, date) DO UPDATE SET schedule_id = excluded.schedule_id",
    )
    .bind(user.0)
    .bind(date)
    .bind(body.schedule_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(OverrideRow {
        date: format_date(date),
        schedule: sched,
    }))
}

async fn delete_override(
    State(state): State<AppState>,
    user: AuthUser,
    Path(date_str): Path<String>,
) -> AppResult<impl IntoResponse> {
    let date = parse_date(&date_str)?;
    sqlx::query("DELETE FROM calendar_date_overrides WHERE user_id = ? AND date = ?")
        .bind(user.0)
        .bind(date)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn create_override(
    State(state): State<AppState>,
    user: AuthUser,
    Path(date_str): Path<String>,
) -> AppResult<Json<OverrideRow>> {
    let date = parse_date(&date_str)?;
    let mut tx = state.pool.begin().await?;
    let existing: Option<(i64,)> = sqlx::query_as(
        "SELECT schedule_id FROM calendar_date_overrides WHERE user_id = ? AND date = ?",
    )
    .bind(user.0)
    .bind(date)
    .fetch_optional(&mut *tx)
    .await?;
    let sched = match existing {
        Some((sid,)) => load_schedule_tx(&mut tx, user.0, sid).await?,
        None => {
            let row: (i64,) = sqlx::query_as(
                "INSERT INTO schedules (user_id, name, start_min, end_min)
                 VALUES (?, ?, ?, ?) RETURNING id",
            )
            .bind(user.0)
            .bind(format_date(date))
            .bind(DEFAULT_START_MIN)
            .bind(DEFAULT_END_MIN)
            .fetch_one(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT INTO calendar_date_overrides (user_id, date, schedule_id)
                 VALUES (?, ?, ?)",
            )
            .bind(user.0)
            .bind(date)
            .bind(row.0)
            .execute(&mut *tx)
            .await?;
            let sched = load_schedule_tx(&mut tx, user.0, row.0).await?;
            // Pair schedule + override binding so undo wipes both, leaving no dangling override.
            let snap = snapshot_schedule(&mut tx, user.0, row.0)
                .await?
                .expect("just inserted");
            let date_s = format_date(date);
            record_history(
                &mut tx,
                user.0,
                CTX_SCHEDULE,
                "create_override",
                &[
                    SubOp::InsertSchedule { row: snap },
                    SubOp::InsertOverride {
                        date: date_s.clone(),
                        schedule_id: row.0,
                    },
                ],
                &[
                    SubOp::DeleteOverride { date: date_s },
                    SubOp::DeleteSchedule { id: row.0 },
                ],
            )
            .await?;
            sched
        }
    };
    tx.commit().await?;
    Ok(Json(OverrideRow {
        date: format_date(date),
        schedule: sched,
    }))
}

async fn fork_weekday_template(
    State(state): State<AppState>,
    user: AuthUser,
    Path(date_str): Path<String>,
) -> AppResult<Json<OverrideRow>> {
    let date = parse_date(&date_str)?;
    let mut tx = state.pool.begin().await?;

    // Idempotent: existing override returned as-is, no history recorded.
    let existing: Option<(i64,)> = sqlx::query_as(
        "SELECT schedule_id FROM calendar_date_overrides WHERE user_id = ? AND date = ?",
    )
    .bind(user.0)
    .bind(date)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((sid,)) = existing {
        let sched = load_schedule_tx(&mut tx, user.0, sid).await?;
        tx.commit().await?;
        return Ok(Json(OverrideRow {
            date: format_date(date),
            schedule: sched,
        }));
    }

    let weekday = (date.weekday().number_days_from_monday()) as i64;
    let template_sid: Option<(Option<i64>,)> = sqlx::query_as(
        "SELECT schedule_id FROM calendar_weekday_bindings WHERE user_id = ? AND weekday = ?",
    )
    .bind(user.0)
    .bind(weekday)
    .fetch_optional(&mut *tx)
    .await?;
    let template_sid: Option<i64> = template_sid.and_then(|(s,)| s);

    let new_sched_id = match template_sid {
        Some(tid) => clone_schedule(&mut tx, user.0, tid, &format_date(date)).await?,
        None => {
            let row: (i64,) = sqlx::query_as(
                "INSERT INTO schedules (user_id, name, start_min, end_min)
                 VALUES (?, ?, ?, ?) RETURNING id",
            )
            .bind(user.0)
            .bind(format_date(date))
            .bind(DEFAULT_START_MIN)
            .bind(DEFAULT_END_MIN)
            .fetch_one(&mut *tx)
            .await?;
            row.0
        }
    };
    sqlx::query(
        "INSERT INTO calendar_date_overrides (user_id, date, schedule_id) VALUES (?, ?, ?)",
    )
    .bind(user.0)
    .bind(date)
    .bind(new_sched_id)
    .execute(&mut *tx)
    .await?;
    let sched = load_schedule_tx(&mut tx, user.0, new_sched_id).await?;

    // Pack schedule + cloned items + override into one entry; items keep fresh ids so redo re-inserts them.
    let snap = snapshot_schedule(&mut tx, user.0, new_sched_id)
        .await?
        .expect("just inserted");
    let items = load_items_tx(&mut tx, new_sched_id).await?;
    let mut forward: Vec<SubOp> = Vec::with_capacity(2 + items.len());
    forward.push(SubOp::InsertSchedule { row: snap });
    for it in &items {
        let item_snap = snapshot_item(&mut tx, user.0, it.id)
            .await?
            .expect("just inserted");
        forward.push(SubOp::InsertItem { row: item_snap });
    }
    let date_s = format_date(date);
    forward.push(SubOp::InsertOverride {
        date: date_s.clone(),
        schedule_id: new_sched_id,
    });
    let backward = vec![
        SubOp::DeleteOverride { date: date_s },
        // DeleteSchedule cascades to schedule_items; no per-item Delete ops needed.
        SubOp::DeleteSchedule { id: new_sched_id },
    ];
    record_history(
        &mut tx,
        user.0,
        CTX_SCHEDULE,
        "fork_weekday_template",
        &forward,
        &backward,
    )
    .await?;

    tx.commit().await?;
    Ok(Json(OverrideRow {
        date: format_date(date),
        schedule: sched,
    }))
}

pub(crate) async fn clone_schedule(
    tx: &mut Transaction<'_, Sqlite>,
    user_id: i64,
    source_id: i64,
    new_name: &str,
) -> AppResult<i64> {
    let source = load_schedule_tx(tx, user_id, source_id).await?;
    let row: (i64,) = sqlx::query_as(
        "INSERT INTO schedules (user_id, name, start_min, end_min)
         VALUES (?, ?, ?, ?) RETURNING id",
    )
    .bind(user_id)
    .bind(new_name)
    .bind(source.start_min)
    .bind(source.end_min)
    .fetch_one(&mut **tx)
    .await?;
    let new_sid = row.0;
    sqlx::query(
        "INSERT INTO schedule_items (
            schedule_id, position, start_min, end_min, duration_target,
            use_inline, inline_label, inline_description, color,
            project_id, project_rank, task_id, task_rank
         )
         SELECT ?, position, start_min, end_min, duration_target,
                use_inline, inline_label, inline_description, color,
                project_id, project_rank, task_id, task_rank
           FROM schedule_items WHERE schedule_id = ?",
    )
    .bind(new_sid)
    .bind(source_id)
    .execute(&mut **tx)
    .await?;
    Ok(new_sid)
}

const WEEKDAY_NAMES: [&str; 7] = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
];
