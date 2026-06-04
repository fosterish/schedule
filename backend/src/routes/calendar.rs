use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::{Sqlite, Transaction};
use time::macros::format_description;
use time::Date;

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::history::{record_history, snapshot_item, snapshot_schedule, SubOp, CTX_SCHEDULE};
use crate::models::schedule::{Schedule, DEFAULT_END_MIN, DEFAULT_START_MIN};
use crate::routes::schedules::{load_items_tx, load_schedule, load_schedule_tx};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/calendar/templates",
            get(list_templates).post(create_template),
        )
        .route("/calendar/days", get(list_days_range))
        .route("/calendar/days/{date}", get(get_day))
        .route("/calendar/days/{date}/create", post(create_day))
        .route(
            "/calendar/days/{date}/fork/{template_id}",
            post(fork_template),
        )
}

#[derive(Debug, Serialize)]
struct DayRow {
    date: String,
    schedule: Schedule,
}

async fn list_templates(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<Schedule>>> {
    let rows: Vec<Schedule> = sqlx::query_as::<_, Schedule>(
        "SELECT s.id, s.user_id, s.name, s.start_min, s.end_min
           FROM schedules s
           JOIN schedule_templates t ON t.schedule_id = s.id
          WHERE t.user_id = ?
          ORDER BY s.name ASC, s.id ASC",
    )
    .bind(user.0)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

const NEW_TEMPLATE_NAME: &str = "New schedule template";

async fn create_template(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<(StatusCode, Json<Schedule>)> {
    let mut tx = state.pool.begin().await?;
    let row: (i64,) = sqlx::query_as(
        "INSERT INTO schedules (user_id, name, start_min, end_min)
         VALUES (?, ?, ?, ?) RETURNING id",
    )
    .bind(user.0)
    .bind(NEW_TEMPLATE_NAME)
    .bind(DEFAULT_START_MIN)
    .bind(DEFAULT_END_MIN)
    .fetch_one(&mut *tx)
    .await?;
    let sid = row.0;
    sqlx::query("INSERT INTO schedule_templates (user_id, schedule_id) VALUES (?, ?)")
        .bind(user.0)
        .bind(sid)
        .execute(&mut *tx)
        .await?;
    let sched = load_schedule_tx(&mut tx, user.0, sid).await?;

    // Pair schedule insert with the template binding so undo wipes both atomically.
    let snap = snapshot_schedule(&mut tx, user.0, sid)
        .await?
        .expect("just inserted");
    record_history(
        &mut tx,
        user.0,
        CTX_SCHEDULE,
        "create_template",
        &[
            SubOp::InsertSchedule { row: snap },
            SubOp::InsertTemplate { schedule_id: sid },
        ],
        &[
            SubOp::DeleteTemplate { schedule_id: sid },
            SubOp::DeleteSchedule { id: sid },
        ],
    )
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(sched)))
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

/// Batch fetch all daily schedules in `[start, end]` so a month loads in one request.
async fn list_days_range(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<RangeQuery>,
) -> AppResult<Json<Vec<DayRow>>> {
    let start = parse_date(&q.start)?;
    let end = parse_date(&q.end)?;
    if end < start {
        return Err(AppError::validation("end must be on or after start"));
    }
    let rows: Vec<(Date, i64)> = sqlx::query_as(
        "SELECT date, schedule_id
           FROM daily_schedules
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
        out.push(DayRow {
            date: format_date(date),
            schedule: sched,
        });
    }
    Ok(Json(out))
}

async fn get_day(
    State(state): State<AppState>,
    user: AuthUser,
    Path(date_str): Path<String>,
) -> AppResult<Json<Option<DayRow>>> {
    let date = parse_date(&date_str)?;
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT schedule_id FROM daily_schedules WHERE user_id = ? AND date = ?")
            .bind(user.0)
            .bind(date)
            .fetch_optional(&state.pool)
            .await?;
    let Some((sid,)) = row else {
        return Ok(Json(None));
    };
    let sched = load_schedule(&state.pool, user.0, sid).await?;
    Ok(Json(Some(DayRow {
        date: format_date(date),
        schedule: sched,
    })))
}

async fn create_day(
    State(state): State<AppState>,
    user: AuthUser,
    Path(date_str): Path<String>,
) -> AppResult<Json<DayRow>> {
    let date = parse_date(&date_str)?;
    let mut tx = state.pool.begin().await?;
    let existing: Option<(i64,)> =
        sqlx::query_as("SELECT schedule_id FROM daily_schedules WHERE user_id = ? AND date = ?")
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
                "INSERT INTO daily_schedules (user_id, date, schedule_id) VALUES (?, ?, ?)",
            )
            .bind(user.0)
            .bind(date)
            .bind(row.0)
            .execute(&mut *tx)
            .await?;
            let sched = load_schedule_tx(&mut tx, user.0, row.0).await?;
            // Pair schedule + daily binding so undo wipes both, leaving no dangling row.
            let snap = snapshot_schedule(&mut tx, user.0, row.0)
                .await?
                .expect("just inserted");
            let date_s = format_date(date);
            record_history(
                &mut tx,
                user.0,
                CTX_SCHEDULE,
                "create_day",
                &[
                    SubOp::InsertSchedule { row: snap },
                    SubOp::InsertDailySchedule {
                        date: date_s.clone(),
                        schedule_id: row.0,
                    },
                ],
                &[
                    SubOp::DeleteDailySchedule { date: date_s },
                    SubOp::DeleteSchedule { id: row.0 },
                ],
            )
            .await?;
            sched
        }
    };
    tx.commit().await?;
    Ok(Json(DayRow {
        date: format_date(date),
        schedule: sched,
    }))
}

/// Fork a chosen template into the date's daily schedule, cloning its items.
async fn fork_template(
    State(state): State<AppState>,
    user: AuthUser,
    Path((date_str, template_id)): Path<(String, i64)>,
) -> AppResult<Json<DayRow>> {
    let date = parse_date(&date_str)?;
    let mut tx = state.pool.begin().await?;

    // Idempotent: an existing daily schedule is returned as-is, no history recorded.
    let existing: Option<(i64,)> =
        sqlx::query_as("SELECT schedule_id FROM daily_schedules WHERE user_id = ? AND date = ?")
            .bind(user.0)
            .bind(date)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some((sid,)) = existing {
        let sched = load_schedule_tx(&mut tx, user.0, sid).await?;
        tx.commit().await?;
        return Ok(Json(DayRow {
            date: format_date(date),
            schedule: sched,
        }));
    }

    // Require the source to be one of the user's templates.
    let is_template: Option<(i64,)> = sqlx::query_as(
        "SELECT schedule_id FROM schedule_templates WHERE user_id = ? AND schedule_id = ?",
    )
    .bind(user.0)
    .bind(template_id)
    .fetch_optional(&mut *tx)
    .await?;
    if is_template.is_none() {
        return Err(AppError::not_found("template"));
    }

    let new_sched_id = clone_schedule(&mut tx, user.0, template_id, &format_date(date)).await?;
    sqlx::query("INSERT INTO daily_schedules (user_id, date, schedule_id) VALUES (?, ?, ?)")
        .bind(user.0)
        .bind(date)
        .bind(new_sched_id)
        .execute(&mut *tx)
        .await?;
    let sched = load_schedule_tx(&mut tx, user.0, new_sched_id).await?;

    // Pack schedule + cloned items + daily binding into one entry; items keep fresh ids so redo re-inserts them.
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
    forward.push(SubOp::InsertDailySchedule {
        date: date_s.clone(),
        schedule_id: new_sched_id,
    });
    let backward = vec![
        SubOp::DeleteDailySchedule { date: date_s },
        // DeleteSchedule cascades to schedule_items; no per-item Delete ops needed.
        SubOp::DeleteSchedule { id: new_sched_id },
    ];
    record_history(
        &mut tx,
        user.0,
        CTX_SCHEDULE,
        "fork_template",
        &forward,
        &backward,
    )
    .await?;

    tx.commit().await?;
    Ok(Json(DayRow {
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
