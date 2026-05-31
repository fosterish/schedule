use axum::extract::{Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use time::macros::format_description;
use time::{Date, Duration, OffsetDateTime};

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::models::schedule::ScheduleItem;
use crate::resolve::{compute_layout, pick_schedule, resolve_day, DayView, ScheduleSource};
use crate::routes::schedules::{load_items_tx, load_schedule, load_schedule_tx};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/day", get(get_day))
        .route("/day/today/play", post(today_play))
        .route("/day/today/stop", post(today_stop))
        .route("/day/today/skip", post(today_skip))
}

/// Cursor minute the action runs at (0..=2879), plus the client's local clock (the
/// server's wall clock has no usable timezone in a multi-threaded process).
#[derive(Debug, Deserialize, Default)]
pub struct RunQuery {
    pub at_min: Option<i64>,
    pub today: Option<String>,
    pub now_min: Option<i64>,
}

/// `date` is the day being viewed; `today`/`now_min` carry the client's local clock,
/// since the server can't know the user's timezone (see today_local / current_minute_of_day).
#[derive(Debug, Deserialize)]
pub struct DayQuery {
    pub date: Option<String>,
    pub today: Option<String>,
    pub now_min: Option<i64>,
}

async fn get_day(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<DayQuery>,
) -> AppResult<Json<DayView>> {
    let today = resolve_today(&q.today)?;
    let now_min = resolve_now_min(q.now_min)?;
    let date = match q.date {
        Some(s) => parse_date(&s)?,
        None => today,
    };
    if date == today {
        let (view, _picked_date, _yesterday_overflow) =
            pick_today_view(&state.pool, user.0, today, now_min).await?;
        return Ok(Json(view));
    }
    let view = resolve_day(&state.pool, user.0, date).await?;
    Ok(Json(view))
}

/// Pick the Today schedule: started override, else yesterday overflow, else idle override, else empty state with weekday template.
pub async fn pick_today_view(
    pool: &sqlx::SqlitePool,
    user_id: i64,
    today: Date,
    now_min: i64,
) -> AppResult<(DayView, Date, bool)> {
    let yesterday = today - Duration::days(1);

    // Today counts only a date override; weekday template is empty-state metadata only.
    let today_override_sid: Option<(i64,)> = sqlx::query_as(
        "SELECT schedule_id FROM calendar_date_overrides
           WHERE user_id = ? AND date = ?",
    )
    .bind(user_id)
    .bind(today)
    .fetch_optional(pool)
    .await?;

    if let Some((_sid,)) = today_override_sid {
        // resolve_day picks the override first, returning the override-bound view.
        let mut today_view = resolve_day(pool, user_id, today).await?;
        let today_started = today_view
            .schedule
            .as_ref()
            .map(|s| now_min >= s.start_min)
            .unwrap_or(false);

        if today_started {
            today_view.now_min = Some(now_min);
            return Ok((today_view, today, false));
        }

        // Today hasn't started yet — yesterday overflow wins over an idle today.
        let (y_sched, _) = pick_schedule(pool, user_id, yesterday).await?;
        if let Some(s) = &y_sched {
            let shifted_now = now_min + 1440;
            if shifted_now < s.end_min {
                let mut y_view = resolve_day(pool, user_id, yesterday).await?;
                y_view.now_min = Some(shifted_now);
                return Ok((y_view, yesterday, true));
            }
        }

        today_view.now_min = Some(now_min);
        return Ok((today_view, today, false));
    }

    // No today override: check yesterday overflow (override or template; editing gated upstream).
    let (y_sched, _) = pick_schedule(pool, user_id, yesterday).await?;
    if let Some(s) = &y_sched {
        let shifted_now = now_min + 1440;
        if shifted_now < s.end_min {
            let mut y_view = resolve_day(pool, user_id, yesterday).await?;
            y_view.now_min = Some(shifted_now);
            return Ok((y_view, yesterday, true));
        }
    }

    // Empty state: surface weekday template so client picks fork vs blank.
    let weekday = today.weekday().number_days_from_monday() as i64;
    let wd_row: Option<(Option<i64>,)> = sqlx::query_as(
        "SELECT schedule_id FROM calendar_weekday_bindings
           WHERE user_id = ? AND weekday = ?",
    )
    .bind(user_id)
    .bind(weekday)
    .fetch_optional(pool)
    .await?;
    let weekday_template = match wd_row.and_then(|(s,)| s) {
        Some(sid) => Some(load_schedule(pool, user_id, sid).await?),
        None => None,
    };

    let today_str = format!(
        "{}-{:02}-{:02}",
        today.year(),
        u8::from(today.month()),
        today.day()
    );
    let view = DayView {
        date: today_str,
        schedule: None,
        source: ScheduleSource::None,
        items: vec![],
        now_min: Some(now_min),
        errors: vec![],
        weekday_template,
    };
    Ok((view, today, false))
}

pub fn parse_date(s: &str) -> AppResult<Date> {
    let fmt = format_description!("[year]-[month]-[day]");
    Date::parse(s, fmt).map_err(|_| AppError::bad_request("invalid date; expected YYYY-MM-DD"))
}

/// Client-supplied local date, else the server clock. now_local() can't read an offset
/// in a multi-threaded process, so the fallback is UTC and only approximate.
fn resolve_today(param: &Option<String>) -> AppResult<Date> {
    match param {
        Some(s) => parse_date(s),
        None => today_local(),
    }
}

/// Client-supplied local minute-of-day [0,1439], else the (UTC-approximate) server clock.
fn resolve_now_min(param: Option<i64>) -> AppResult<i64> {
    match param {
        Some(v) => {
            if !(0..=1439).contains(&v) {
                return Err(AppError::bad_request("now_min must be in [0, 1439]"));
            }
            Ok(v)
        }
        None => current_minute_of_day(),
    }
}

/// Server-clock fallback only. Returns UTC in a multi-threaded process (now_local fails),
/// so callers should prefer a client-supplied date.
pub fn today_local() -> AppResult<Date> {
    OffsetDateTime::now_local()
        .map(|odt| odt.date())
        .or_else(|_| Ok::<_, AppError>(OffsetDateTime::now_utc().date()))
}

/// Server-clock fallback only; UTC in a multi-threaded process. Prefer a client value.
pub fn current_minute_of_day() -> AppResult<i64> {
    let now = OffsetDateTime::now_local().unwrap_or_else(|_| OffsetDateTime::now_utc());
    Ok(now.hour() as i64 * 60 + now.minute() as i64)
}

// ============================================================================
// Schedule running: play / stop / skip endpoints.
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunAction {
    Play,
    Stop,
    Skip,
}

async fn today_play(
    state: State<AppState>,
    user: AuthUser,
    Query(q): Query<RunQuery>,
) -> AppResult<Json<DayView>> {
    run_today(state, user, RunAction::Play, q).await
}
async fn today_stop(
    state: State<AppState>,
    user: AuthUser,
    Query(q): Query<RunQuery>,
) -> AppResult<Json<DayView>> {
    run_today(state, user, RunAction::Stop, q).await
}
async fn today_skip(
    state: State<AppState>,
    user: AuthUser,
    Query(q): Query<RunQuery>,
) -> AppResult<Json<DayView>> {
    run_today(state, user, RunAction::Skip, q).await
}

async fn run_today(
    State(state): State<AppState>,
    user: AuthUser,
    action: RunAction,
    q: RunQuery,
) -> AppResult<Json<DayView>> {
    let today = resolve_today(&q.today)?;
    let clock_now = resolve_now_min(q.now_min)?;
    // Targets the active schedule (today or yesterday overflow); requires an existing override, else the 409 fires.
    let (_, target_date, yesterday_overflow) =
        pick_today_view(&state.pool, user.0, today, clock_now).await?;
    let fallback_now_min = if yesterday_overflow {
        clock_now + 1440
    } else {
        clock_now
    };
    // The cursor minute the user acted at; clamp to a two-day band against buggy clients.
    let now_min = match q.at_min {
        None => fallback_now_min,
        Some(v) => {
            if !(0..=2879).contains(&v) {
                return Err(AppError::bad_request(
                    "at_min must be in [0, 2879]",
                ));
            }
            v
        }
    };

    let mut tx = state.pool.begin().await?;
    let override_sid: Option<(i64,)> = sqlx::query_as(
        "SELECT schedule_id FROM calendar_date_overrides WHERE user_id = ? AND date = ?",
    )
    .bind(user.0)
    .bind(target_date)
    .fetch_optional(&mut *tx)
    .await?;
    let sched_id = match override_sid {
        Some((sid,)) => sid,
        None => {
            return Err(AppError::conflict(
                "no schedule for today — create one first",
            ));
        }
    };

    let sched = load_schedule_tx(&mut tx, user.0, sched_id).await?;
    let items = load_items_tx(&mut tx, sched_id).await?;
    let layout = compute_layout(&sched, &items);

    let mut sched_mut = sched.clone();
    let mut items_mut = items.clone();
    let assigned: Vec<(i64, i64)> = layout
        .items
        .iter()
        .map(|li| (li.assigned_start, li.assigned_end))
        .collect();

    apply_action(action, now_min, &mut sched_mut, &mut items_mut, &assigned)?;

    let mut forward: Vec<crate::history::SubOp> = Vec::new();
    let mut backward: Vec<crate::history::SubOp> = Vec::new();
    if sched.start_min != sched_mut.start_min || sched.end_min != sched_mut.end_min {
        forward.push(crate::history::SubOp::PatchSchedule {
            id: sched.id,
            fields: serde_json::json!({
                "start_min": sched_mut.start_min,
                "end_min": sched_mut.end_min
            }),
        });
        backward.push(crate::history::SubOp::PatchSchedule {
            id: sched.id,
            fields: serde_json::json!({
                "start_min": sched.start_min,
                "end_min": sched.end_min
            }),
        });
    }
    for it in items_mut.iter() {
        if it.id < 0 {
            let real_id = -it.id;
            let snap = crate::history::snapshot_item(&mut tx, user.0, real_id)
                .await?
                .expect("item exists pre-delete");
            forward.push(crate::history::SubOp::DeleteItem { id: real_id });
            backward.push(crate::history::SubOp::InsertItem { row: snap });
        } else {
            let orig = items.iter().find(|x| x.id == it.id).unwrap();
            if orig.start_min == it.start_min && orig.end_min == it.end_min {
                continue;
            }
            forward.push(crate::history::SubOp::PatchItem {
                id: it.id,
                fields: serde_json::json!({
                    "start_min": it.start_min,
                    "end_min": it.end_min
                }),
            });
            backward.push(crate::history::SubOp::PatchItem {
                id: it.id,
                fields: serde_json::json!({
                    "start_min": orig.start_min,
                    "end_min": orig.end_min
                }),
            });
        }
    }

    sqlx::query("UPDATE schedules SET start_min = ?, end_min = ? WHERE id = ?")
        .bind(sched_mut.start_min)
        .bind(sched_mut.end_min)
        .bind(sched_id)
        .execute(&mut *tx)
        .await?;
    for it in items_mut.iter() {
        if it.id < 0 {
            let real_id = -it.id;
            sqlx::query("DELETE FROM schedule_items WHERE id = ?")
                .bind(real_id)
                .execute(&mut *tx)
                .await?;
        } else {
            sqlx::query(
                "UPDATE schedule_items SET start_min = ?, end_min = ? WHERE id = ?",
            )
            .bind(it.start_min)
            .bind(it.end_min)
            .bind(it.id)
            .execute(&mut *tx)
            .await?;
        }
    }

    // Backward must run in reverse order to undo composite changes.
    if !forward.is_empty() {
        let kind = match action {
            RunAction::Play => "run_play",
            RunAction::Stop => "run_stop",
            RunAction::Skip => "run_skip",
        };
        let mut backward_reversed = backward.clone();
        backward_reversed.reverse();
        crate::history::record_history(
            &mut tx,
            user.0,
            crate::history::CTX_SCHEDULE,
            kind,
            &forward,
            &backward_reversed,
        )
        .await?;
    }

    tx.commit().await?;

    // Re-pick the active view so the response matches GET /day's selection.
    let (view, _, _) = pick_today_view(&state.pool, user.0, today, clock_now).await?;
    Ok(Json(view))
}

fn apply_action(
    action: RunAction,
    now_min: i64,
    sched: &mut crate::models::schedule::Schedule,
    items: &mut Vec<ScheduleItem>,
    assigned: &[(i64, i64)],
) -> AppResult<()> {
    if items.is_empty() {
        return Err(AppError::conflict("no items to act on"));
    }
    // CASE 1
    if now_min < sched.start_min {
        match action {
            RunAction::Play => {
                sched.start_min = now_min;
                items[0].start_min = Some(now_min);
                normalize_zero_duration(items);
                Ok(())
            }
            _ => Err(AppError::conflict("only Play is enabled before schedule start")),
        }
    } else if now_min >= sched.end_min {
        // CASE 3
        let last_idx = items.len() - 1;
        let last_fixed_end = items[last_idx].end_min.is_some();
        match action {
            RunAction::Play => {
                if last_fixed_end {
                    return Err(AppError::conflict("Play disabled after schedule end (last item has fixed end)"));
                }
                let first = walk_back(items, last_idx);
                let n = (last_idx - first + 1) as i64;
                sched.end_min = sched.end_min.max(now_min + n);
                items[first].start_min = Some(now_min);
                normalize_zero_duration(items);
                Ok(())
            }
            RunAction::Stop => {
                if last_fixed_end {
                    items[last_idx].end_min = Some(now_min);
                    sched.end_min = now_min;
                } else {
                    let first = walk_back(items, last_idx);
                    let n = (last_idx - first + 1) as i64;
                    sched.end_min = sched.end_min.max(now_min + (1).max(n - 1));
                    items[first].end_min = Some(now_min);
                }
                normalize_zero_duration(items);
                Ok(())
            }
            RunAction::Skip => {
                if last_fixed_end {
                    return Err(AppError::conflict("Skip disabled after schedule end (last item has fixed end)"));
                }
                let first = walk_back(items, last_idx);
                if first == last_idx {
                    return Err(AppError::conflict("Skip disabled (only one item in final block)"));
                }
                let n = (last_idx - first + 1) as i64;
                sched.end_min = sched.end_min.max(now_min + (1).max(n - 1));
                items[first].end_min = Some(now_min);
                normalize_zero_duration(items);
                let remaining: Vec<&ScheduleItem> =
                    items.iter().filter(|i| i.id >= 0).collect();
                if remaining.is_empty() {
                    return Ok(());
                }
                let live: Vec<ScheduleItem> = items.iter().filter(|i| i.id >= 0).cloned().collect();
                if !live.is_empty() {
                    let last_live = live.len() - 1;
                    let first_live = walk_back(&live, last_live);
                    let new_n = (last_live - first_live + 1) as i64;
                    let target_id = live[first_live].id;
                    sched.end_min = sched.end_min.max(now_min + new_n);
                    let pos = items.iter().position(|i| i.id == target_id).unwrap();
                    items[pos].start_min = Some(now_min);
                    normalize_zero_duration(items);
                }
                Ok(())
            }
        }
    } else {
        // CASE 2: within schedule
        let containing = current_item_idx(items, assigned, now_min);
        match containing {
            Some(idx) => {
                let fully_fixed = items[idx].start_min.is_some() && items[idx].end_min.is_some();
                if fully_fixed {
                    apply_fixed_item_action(action, idx, now_min, items)?;
                } else {
                    apply_dynamic_block_action(action, idx, now_min, items)?;
                }
                normalize_zero_duration(items);
                Ok(())
            }
            None => apply_gap_action(action, now_min, items, assigned, sched),
        }
    }
}

/// Item containing now_min; treats now_min == prev.end_min as "no current item" so the gap branch handles post-stop.
fn current_item_idx(
    items: &[ScheduleItem],
    assigned: &[(i64, i64)],
    now_min: i64,
) -> Option<usize> {
    let raw = assigned
        .iter()
        .position(|(s, e)| now_min >= *s && now_min < *e)?;
    if raw > 0
        && items[raw - 1].end_min == Some(now_min)
        && items[raw].start_min.is_none()
    {
        return None;
    }
    Some(raw)
}

fn apply_fixed_item_action(
    action: RunAction,
    idx: usize,
    now_min: i64,
    items: &mut Vec<ScheduleItem>,
) -> AppResult<()> {
    match action {
        RunAction::Play => {
            items[idx].start_min = Some(now_min);
            Ok(())
        }
        RunAction::Stop => {
            items[idx].end_min = Some(now_min);
            Ok(())
        }
        RunAction::Skip => {
            items[idx].end_min = Some(now_min);
            if idx + 1 < items.len() {
                // Next item may be dynamic; walk_back on the new state to play it.
                normalize_zero_duration(items);
                let live: Vec<ScheduleItem> = items.iter().filter(|i| i.id >= 0).cloned().collect();
                let target_id = items[idx + 1].id;
                if items[idx + 1].id < 0 {
                    return Err(AppError::conflict("no next item to play"));
                }
                let pos_in_live = live.iter().position(|i| i.id == target_id);
                if let Some(pl) = pos_in_live {
                    let first = walk_back(&live, pl);
                    let first_id = live[first].id;
                    let pos = items.iter().position(|i| i.id == first_id).unwrap();
                    items[pos].start_min = Some(now_min);
                }
                Ok(())
            } else {
                Err(AppError::conflict("no next item to play"))
            }
        }
    }
}

fn apply_dynamic_block_action(
    action: RunAction,
    idx: usize,
    now_min: i64,
    items: &mut Vec<ScheduleItem>,
) -> AppResult<()> {
    let first = walk_back(items, idx);
    match action {
        RunAction::Play => {
            items[first].start_min = Some(now_min);
            Ok(())
        }
        RunAction::Stop => {
            items[first].end_min = Some(now_min);
            Ok(())
        }
        RunAction::Skip => {
            items[first].end_min = Some(now_min);
            normalize_zero_duration(items);
            let live: Vec<ScheduleItem> = items.iter().filter(|i| i.id >= 0).cloned().collect();
            let stopped_id = items[first].id;
            if stopped_id < 0 {
                // first was deleted; original sequence still holds the next item.
                let mut next_pos = None;
                for (i, it) in items.iter().enumerate() {
                    if i > first && it.id >= 0 {
                        next_pos = Some(i);
                        break;
                    }
                }
                if let Some(np) = next_pos {
                    let nid = items[np].id;
                    let live_idx = live.iter().position(|i| i.id == nid).unwrap();
                    let block_first = walk_back(&live, live_idx);
                    let target_id = live[block_first].id;
                    let pos = items.iter().position(|i| i.id == target_id).unwrap();
                    items[pos].start_min = Some(now_min);
                }
            } else {
                let live_idx = live.iter().position(|i| i.id == stopped_id).unwrap();
                if live_idx + 1 < live.len() {
                    let next_live = &live[live_idx + 1];
                    let block_first = walk_back(&live, live_idx + 1);
                    let target_id = live[block_first].id;
                    let pos = items.iter().position(|i| i.id == target_id).unwrap();
                    items[pos].start_min = Some(now_min);
                    let _ = next_live;
                }
            }
            Ok(())
        }
    }
}

fn apply_gap_action(
    action: RunAction,
    now_min: i64,
    items: &mut Vec<ScheduleItem>,
    assigned: &[(i64, i64)],
    _sched: &mut crate::models::schedule::Schedule,
) -> AppResult<()> {
    let prev_fixed_end_idx: Option<usize> = items
        .iter()
        .enumerate()
        .filter(|(i, it)| assigned[*i].1 <= now_min && it.end_min.is_some())
        .map(|(i, _)| i)
        .last();
    // `>=` (not `>`) finds the layout-flush next item in the post-stop pseudo-gap.
    let next_item_idx: Option<usize> = items
        .iter()
        .enumerate()
        .find(|(i, _)| assigned[*i].0 >= now_min)
        .map(|(i, _)| i);

    match action {
        RunAction::Play => match next_item_idx {
            Some(idx) => {
                items[idx].start_min = Some(now_min);
                normalize_zero_duration(items);
                Ok(())
            }
            None => Err(AppError::conflict("no next item to play")),
        },
        RunAction::Stop => match prev_fixed_end_idx {
            Some(idx) => {
                items[idx].end_min = Some(now_min);
                normalize_zero_duration(items);
                Ok(())
            }
            None => Err(AppError::conflict("no previous fixed-end item to extend")),
        },
        RunAction::Skip => {
            let pe = prev_fixed_end_idx.ok_or_else(|| AppError::conflict("Skip disabled in leading gap"))?;
            let ni = next_item_idx.ok_or_else(|| AppError::conflict("Skip disabled at end of schedule"))?;
            items[pe].end_min = Some(now_min);
            items[ni].start_min = Some(now_min);
            normalize_zero_duration(items);
            Ok(())
        }
    }
}

/// First item of the dynamic block containing starting_idx; a fixed end_min terminates the previous block, checked before fixed start_min.
pub fn walk_back(items: &[ScheduleItem], starting_idx: usize) -> usize {
    let s = &items[starting_idx];
    if s.start_min.is_some() && s.end_min.is_some() {
        return starting_idx;
    }
    if s.start_min.is_some() {
        return starting_idx;
    }
    let mut i = starting_idx;
    while i > 0 {
        i -= 1;
        // Earlier item with fixed end_min: the item after it begins our block.
        if items[i].end_min.is_some() {
            return i + 1;
        }
        // Earlier item with fixed start_min only: it is the first.
        if items[i].start_min.is_some() {
            return i;
        }
    }
    0
}

/// Mark zero-duration items for deletion by negating their id (sentinel); caller DELETEs them.
fn normalize_zero_duration(items: &mut [ScheduleItem]) {
    for it in items.iter_mut() {
        if let (Some(s), Some(e)) = (it.start_min, it.end_min) {
            if s == e && it.id > 0 {
                it.id = -it.id;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::schedule::Schedule;
    use crate::resolve::compute_layout;

    fn mk_sched(start_min: i64, end_min: i64) -> Schedule {
        Schedule {
            id: 1,
            user_id: 1,
            name: "test".into(),
            start_min,
            end_min,
        }
    }

    fn mk_item(id: i64, position: f64, start_min: Option<i64>, end_min: Option<i64>) -> ScheduleItem {
        ScheduleItem {
            id,
            schedule_id: 1,
            position,
            start_min,
            end_min,
            duration_target: 60,
            use_inline: true,
            inline_label: None,
            inline_description: None,
            color: "blue".to_string(),
            project_id: None,
            project_rank: 1,
            task_id: None,
            task_rank: 1,
        }
    }

    fn run(
        action: RunAction,
        now_min: i64,
        sched: &mut Schedule,
        items: &mut Vec<ScheduleItem>,
    ) {
        let layout = compute_layout(sched, items);
        let assigned: Vec<(i64, i64)> = layout
            .items
            .iter()
            .map(|li| (li.assigned_start, li.assigned_end))
            .collect();
        apply_action(action, now_min, sched, items, &assigned).expect("apply_action ok");
    }

    /// Stop then immediately Play must not delete the just-stopped item.
    #[test]
    fn stop_then_play_does_not_delete_previous() {
        let mut sched = mk_sched(480, 720);
        // A fully fixed, B fixed-start dynamic-end (running), C dynamic.
        let mut items = vec![
            mk_item(1, 1.0, Some(480), Some(540)),
            mk_item(2, 2.0, Some(540), None),
            mk_item(3, 3.0, None, None),
        ];

        run(RunAction::Stop, 600, &mut sched, &mut items);
        assert_eq!(items[1].start_min, Some(540));
        assert_eq!(items[1].end_min, Some(600));
        assert!(items.iter().all(|it| it.id > 0), "no deletions on Stop");

        run(RunAction::Play, 600, &mut sched, &mut items);
        assert!(items.iter().all(|it| it.id > 0), "no deletions on Stop→Play");
        let b = items.iter().find(|it| it.id == 2).expect("B retained");
        assert_eq!((b.start_min, b.end_min), (Some(540), Some(600)));
        let c = items.iter().find(|it| it.id == 3).expect("C retained");
        assert_eq!(c.start_min, Some(600));
        assert_eq!(c.end_min, None);
    }

    /// Skip in the post-stop pseudo-gap advances the next item's start, not deleting just-stopped B.
    #[test]
    fn stop_then_skip_advances_next_without_delete() {
        let mut sched = mk_sched(480, 720);
        let mut items = vec![
            mk_item(1, 1.0, Some(480), Some(540)),
            mk_item(2, 2.0, Some(540), None),
            mk_item(3, 3.0, None, None),
            mk_item(4, 4.0, None, None),
        ];

        run(RunAction::Stop, 600, &mut sched, &mut items);
        run(RunAction::Skip, 600, &mut sched, &mut items);

        assert!(items.iter().all(|it| it.id > 0), "no deletions on Stop→Skip");
        let b = items.iter().find(|it| it.id == 2).expect("B retained");
        assert_eq!((b.start_min, b.end_min), (Some(540), Some(600)));
        let c = items.iter().find(|it| it.id == 3).expect("C retained");
        assert_eq!(
            c.start_min,
            Some(600),
            "Skip in post-stop gap advances next item's start_min to now"
        );
        // Skip in a gap only touches prev.end and next.start; D stays dynamic.
        let d = items.iter().find(|it| it.id == 4).expect("D retained");
        assert_eq!((d.start_min, d.end_min), (None, None));
    }

    /// In a natural gap, Skip advances prev.end and next.start to now without zero-duration collapse.
    #[test]
    fn skip_in_natural_gap_advances_both_anchors() {
        let mut sched = mk_sched(480, 720);
        let mut items = vec![
            mk_item(1, 1.0, Some(480), Some(540)),
            mk_item(2, 2.0, Some(540), Some(600)),
            mk_item(3, 3.0, Some(660), None),
        ];

        run(RunAction::Skip, 630, &mut sched, &mut items);

        assert!(items.iter().all(|it| it.id > 0), "no deletions");
        let b = items.iter().find(|it| it.id == 2).expect("B retained");
        assert_eq!(b.end_min, Some(630), "prev fixed end advances to now");
        let c = items.iter().find(|it| it.id == 3).expect("C retained");
        assert_eq!(c.start_min, Some(630), "next fixed start advances to now");
    }

    /// Sanity check: plain Play/Stop/Skip on the common path with no boundary cases.
    #[test]
    fn plain_play_stop_skip_sanity() {
        let mut sched = mk_sched(480, 720);
        let mut items = vec![
            mk_item(1, 1.0, None, None),
            mk_item(2, 2.0, None, None),
            mk_item(3, 3.0, None, None),
        ];

        run(RunAction::Play, 490, &mut sched, &mut items);
        assert_eq!(items[0].start_min, Some(490));
        assert_eq!(items[0].end_min, None);

        run(RunAction::Stop, 540, &mut sched, &mut items);
        assert_eq!(items[0].start_min, Some(490));
        assert_eq!(items[0].end_min, Some(540));

        run(RunAction::Play, 545, &mut sched, &mut items);
        assert_eq!(items[1].start_min, Some(545));

        run(RunAction::Skip, 600, &mut sched, &mut items);
        assert!(items.iter().all(|it| it.id > 0), "no deletions in normal sequence");
        let it1 = &items[1];
        assert_eq!(it1.end_min, Some(600));
        let it2 = &items[2];
        assert_eq!(it2.start_min, Some(600));
    }

    /// Skip inside a non-first dynamic-block item fixes the block's first item's end and the next item's start at now_min.
    #[test]
    fn skip_inside_trailing_dynamic_item_pins_anchors() {
        // Schedule [480,720]. A fixed-start dynamic-end; B fully dynamic. now=600 inside B.
        let mut sched = mk_sched(480, 720);
        let mut items = vec![
            mk_item(1, 1.0, Some(480), None),
            mk_item(2, 2.0, None, None),
        ];
        run(RunAction::Skip, 600, &mut sched, &mut items);
        let a = items.iter().find(|it| it.id == 1).expect("A retained");
        assert_eq!((a.start_min, a.end_min), (Some(480), Some(600)));
        let b = items.iter().find(|it| it.id == 2).expect("B retained");
        assert_eq!(b.start_min, Some(600));
        assert!(items.iter().all(|it| it.id > 0), "no deletions");
    }

    /// 3-item variant: Skip with now_min inside trailing C fixes B.end and C.start at the same minute.
    #[test]
    fn skip_inside_trailing_three_item_block_pins_anchors() {
        let mut sched = mk_sched(480, 720);
        let mut items = vec![
            mk_item(1, 1.0, Some(480), Some(540)),
            mk_item(2, 2.0, Some(540), None),
            mk_item(3, 3.0, None, None),
        ];
        run(RunAction::Skip, 660, &mut sched, &mut items);
        assert!(items.iter().all(|it| it.id > 0), "no deletions");
        let b = items.iter().find(|it| it.id == 2).expect("B retained");
        assert_eq!(b.end_min, Some(660), "Skip fixes B.end = now");
        let c = items.iter().find(|it| it.id == 3).expect("C retained");
        assert_eq!(c.start_min, Some(660), "Skip fixes C.start = now");
    }

    /// at_min query param overrides the server clock; any accepted value (0..=2879) yields the same outcome as that server minute.
    #[test]
    fn apply_action_uses_supplied_now_min() {
        let mut sched = mk_sched(480, 720);
        let mut items = vec![
            mk_item(1, 1.0, None, None),
            mk_item(2, 2.0, None, None),
            mk_item(3, 3.0, None, None),
        ];

        // Cursor at 550: Play anchors the leading item's start there, ignoring the server clock.
        run(RunAction::Play, 550, &mut sched, &mut items);
        assert_eq!(items[0].start_min, Some(550));
        assert_eq!(items[0].end_min, None);

        // A later cursor Stop advances the first item's end to that minute.
        run(RunAction::Stop, 610, &mut sched, &mut items);
        assert_eq!(items[0].end_min, Some(610));
    }

    /// Cursor-driven Skip inside running block B splits B at the cursor and anchors C's start there, matching at-clock behavior.
    #[test]
    fn cursor_skip_inside_running_dynamic_block() {
        let mut sched = mk_sched(480, 720);
        let mut items = vec![
            mk_item(1, 1.0, Some(480), Some(540)),
            mk_item(2, 2.0, Some(540), None),
            mk_item(3, 3.0, None, None),
            mk_item(4, 4.0, None, None),
        ];

        // Cursor at 595, inside B's portion of the dynamic block.
        run(RunAction::Skip, 595, &mut sched, &mut items);

        let b = items.iter().find(|it| it.id == 2).expect("B retained");
        assert_eq!(b.end_min, Some(595), "Skip fixes B.end at cursor");
        let c = items.iter().find(|it| it.id == 3).expect("C retained");
        assert_eq!(c.start_min, Some(595), "Skip fixes C.start at cursor");
        assert!(items.iter().all(|it| it.id > 0), "no deletions");
    }

    /// walk_back must treat a fully-fixed item as a boundary (return i+1), not the block's first.
    #[test]
    fn walk_back_skips_past_fully_fixed_boundary() {
        let items = vec![
            mk_item(1, 1.0, Some(480), Some(540)),
            mk_item(2, 2.0, None, None),
            mk_item(3, 3.0, None, None),
        ];
        // From C (idx=2) lands on B (idx=1); A is a fully-fixed boundary.
        assert_eq!(walk_back(&items, 2), 1);
    }
}
