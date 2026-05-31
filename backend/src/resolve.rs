//! Day resolution + layout: [`compute_layout`] lays out items; [`resolve_day`] picks the schedule and resolves payloads.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use sqlx::SqlitePool;
use time::Date;

use crate::error::AppResult;
use crate::models::project::Project;
use crate::models::schedule::{Schedule, ScheduleItem};
use crate::models::task::Task;

pub const MIN_DURATION: i64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayoutErrorKind {
    BelowMinDuration,
    OutOfBounds,
    AnchorNonMonotonic,
    OverflowSegment,
}

#[derive(Debug, Clone)]
pub struct LaidOutItem {
    pub id: i64,
    pub assigned_start: i64,
    pub assigned_end: i64,
    pub flags: ItemFlags,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct ItemFlags {
    pub overflow: bool,
    pub out_of_bounds: bool,
    pub below_min: bool,
}

#[derive(Debug, Clone)]
pub struct LayoutResult {
    pub items: Vec<LaidOutItem>,
    pub errors: Vec<LayoutErrorKind>,
}

/// Pure layout over `items` (must be in `position` order); returns assigned start/end plus layout errors.
pub fn compute_layout(schedule: &Schedule, items: &[ScheduleItem]) -> LayoutResult {
    let mut errors: Vec<LayoutErrorKind> = Vec::new();
    let mut out: Vec<LaidOutItem> = Vec::with_capacity(items.len());

    for it in items {
        let mut oob = false;
        if let Some(s) = it.start_min {
            if s < schedule.start_min || s > schedule.end_min {
                oob = true;
            }
        }
        if let Some(e) = it.end_min {
            if e < schedule.start_min || e > schedule.end_min {
                oob = true;
            }
        }
        if oob {
            errors.push(LayoutErrorKind::OutOfBounds);
        }
        out.push(LaidOutItem {
            id: it.id,
            assigned_start: 0,
            assigned_end: 0,
            flags: ItemFlags {
                out_of_bounds: oob,
                ..Default::default()
            },
        });
    }

    if items.is_empty() {
        return LayoutResult { items: out, errors };
    }

    // Fixed starts must be >= the previous item's fixed end; the DB CHECK already guards start < end.
    let mut prev_fixed_end: Option<i64> = None;
    for it in items {
        if let Some(s) = it.start_min {
            if let Some(pe) = prev_fixed_end {
                if s < pe {
                    errors.push(LayoutErrorKind::AnchorNonMonotonic);
                }
            }
        }
        if let Some(e) = it.end_min {
            prev_fixed_end = Some(e);
        } else if let Some(s) = it.start_min {
            // dynamic end - don't lock prev_fixed_end yet
            prev_fixed_end = Some(s);
        }
    }

    // A segment is a maximal run between anchors; slack is shared proportionally among items whose end_min is null.
    let n = items.len();
    let mut cursor: i64 = schedule.start_min;
    let mut i = 0usize;
    while i < n {
        // A fixed start jumps the cursor forward, leaving a visible gap that the resolver treats as un-allocated.
        if let Some(s) = items[i].start_min {
            cursor = s;
        }
        // Segment ends at the first item with a fixed end, the next fixed start, or the list end.
        let mut j = i;
        while j < n {
            if items[j].end_min.is_some() {
                break;
            }
            if j + 1 < n && items[j + 1].start_min.is_some() {
                break;
            }
            j += 1;
        }

        let right_boundary: i64 = if j < n && items[j].end_min.is_some() {
            items[j].end_min.unwrap()
        } else if j + 1 < n && items[j + 1].start_min.is_some() {
            items[j + 1].start_min.unwrap()
        } else {
            schedule.end_min
        };

        let segment_start = cursor;
        let segment_end_inclusive_idx = if j < n && items[j].end_min.is_some() {
            j
        } else {
            // j has no fixed end here; the boundary is exclusive of it.
            j
        };

        let last = segment_end_inclusive_idx.min(n.saturating_sub(1));
        let seg = &items[i..=last];

        // Only the last item in a segment may have a fixed end; earlier items all have end_min == NULL.
        let total_weight: i64 = seg.iter().map(|it| it.duration_target.max(1)).sum();
        let available = right_boundary - segment_start;

        if available < seg.len() as i64 * MIN_DURATION {
            // Not enough room to give every item the 1-minute minimum.
            errors.push(LayoutErrorKind::BelowMinDuration);
        }

        if seg.len() == 1 && seg[0].end_min.is_some() {
            let s = segment_start;
            let e = right_boundary;
            let idx = i; // == last
            out[idx].assigned_start = s;
            out[idx].assigned_end = e;
            if e - s < MIN_DURATION {
                out[idx].flags.below_min = true;
            }
        } else {
            // Floor each share proportional to duration_target, then hand out leftover minutes by largest fractional remainder.
            let mut shares: Vec<i64> = Vec::with_capacity(seg.len());
            let mut remainders: Vec<f64> = Vec::with_capacity(seg.len());
            let mut sum_assigned = 0i64;
            for it in seg {
                let w = it.duration_target.max(1) as f64;
                let raw = (available as f64) * w / (total_weight as f64);
                let floor = raw.floor().max(MIN_DURATION as f64) as i64;
                shares.push(floor);
                remainders.push(raw - raw.floor());
                sum_assigned += floor;
            }
            // Reconcile to fill exactly `available` minutes.
            let mut diff = available - sum_assigned;
            // diff > 0 adds minutes; diff < 0 means we over-floored at MIN_DURATION and must reclaim, else over-constrained.
            if diff > 0 {
                let mut order: Vec<usize> = (0..seg.len()).collect();
                order.sort_by(|&a, &b| {
                    remainders[b]
                        .partial_cmp(&remainders[a])
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                let mut k = 0usize;
                while diff > 0 && !order.is_empty() {
                    shares[order[k % order.len()]] += 1;
                    diff -= 1;
                    k += 1;
                }
            } else if diff < 0 {
                let mut k = 0usize;
                let mut guard = 0;
                while diff < 0 && guard < 100_000 {
                    let idx = k % seg.len();
                    if shares[idx] > MIN_DURATION {
                        shares[idx] -= 1;
                        diff += 1;
                    }
                    k += 1;
                    guard += 1;
                    // If we've fully circled and no progress, break.
                    if k > seg.len() * 4 && shares.iter().all(|&s| s == MIN_DURATION) {
                        break;
                    }
                }
                if diff < 0 {
                    errors.push(LayoutErrorKind::OverflowSegment);
                }
            }

            let mut c = segment_start;
            for (k, it) in seg.iter().enumerate() {
                let dur = shares[k];
                let s = c;
                let e = c + dur;
                let idx = i + k;
                out[idx].assigned_start = s;
                out[idx].assigned_end = e;
                if e - s < MIN_DURATION {
                    out[idx].flags.below_min = true;
                }
                c = e;
                let _ = it;
            }
            // If the last item has a fixed end_min, force its end exactly.
            if seg.last().is_some_and(|x| x.end_min.is_some()) {
                let idx = i + seg.len() - 1;
                out[idx].assigned_end = right_boundary;
                if out[idx].assigned_end - out[idx].assigned_start < MIN_DURATION {
                    out[idx].flags.below_min = true;
                }
            }
        }

        cursor = out[i + seg.len() - 1].assigned_end;
        i = i + seg.len();
    }

    LayoutResult { items: out, errors }
}

// Day resolver: picks the schedule for a date, resolves payloads, and lays out.

#[derive(Debug, Clone, Serialize)]
pub struct DayView {
    pub date: String, // YYYY-MM-DD
    pub schedule: Option<Schedule>,
    pub source: ScheduleSource,
    pub items: Vec<DayItem>,
    /// Server's "now" in the rendered frame (frame-shifted +1440 for yesterday overflow); `None` except `/api/day` for today.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub now_min: Option<i64>,
    pub errors: Vec<String>,
    /// Weekday template for today, populated only in the empty-today state so the UI can offer "Fork the template".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weekday_template: Option<Schedule>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleSource {
    None,
    WeekdayTemplate,
    DateOverride,
}

#[derive(Debug, Clone, Serialize)]
pub struct DayItem {
    pub id: i64,
    pub position: f64,
    pub start_min: Option<i64>,
    pub end_min: Option<i64>,
    pub duration_target: i64,
    pub assigned_start: i64,
    pub assigned_end: i64,
    pub flags: ItemFlags,
    /// Item's own palette key; authoritative for `Inline`, but `Task`/`Empty` payloads should prefer the project color.
    pub color: String,
    pub payload: ResolvedPayload,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResolvedPayload {
    Inline {
        label: String,
        description: Option<String>,
    },
    Task {
        task_id: i64,
        task_name: String,
        project_id: i64,
        project_name: String,
        task_description: Option<String>,
        rank_indicator: Option<RankIndicator>,
        /// Bound project's palette key, surfaced so the timeline paints Project-mode items without a client-side project lookup.
        color: String,
    },
    Empty {
        reason: String,
        rank_indicator: Option<RankIndicator>,
        /// Project name when the project resolved but no task did; `None` is treated as project-missing.
        project_name: Option<String>,
        /// Project color when resolved; `None` makes the UI fall back to the item's row color or gray.
        project_color: Option<String>,
        /// True if the resolved project has any subtask (any state); the UI suppresses the "no subtask" suffix when false.
        project_has_tasks: bool,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct RankIndicator {
    pub project_rank: Option<i64>,
    pub task_rank: Option<i64>,
}

/// Resolve a date into a fully-laid-out DayView.
pub async fn resolve_day(pool: &SqlitePool, user_id: i64, date: Date) -> AppResult<DayView> {
    let (schedule, source) = pick_schedule(pool, user_id, date).await?;
    let date_str = format!(
        "{}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    );

    let Some(schedule) = schedule else {
        return Ok(DayView {
            date: date_str,
            schedule: None,
            source,
            items: vec![],
            now_min: None,
            errors: vec![],
            weekday_template: None,
        });
    };
    let items = crate::routes::schedules::load_items(pool, schedule.id).await?;
    let layout = compute_layout(&schedule, &items);
    let mut day_items = Vec::with_capacity(items.len());
    for (it, lo) in items.iter().zip(layout.items.iter()) {
        let payload = resolve_payload(pool, user_id, it).await?;
        day_items.push(DayItem {
            id: it.id,
            position: it.position,
            start_min: it.start_min,
            end_min: it.end_min,
            duration_target: it.duration_target,
            assigned_start: lo.assigned_start,
            assigned_end: lo.assigned_end,
            flags: lo.flags.clone(),
            color: it.color.clone(),
            payload,
        });
    }
    let errors = layout.errors.iter().map(|e| format!("{:?}", e)).collect();
    Ok(DayView {
        date: date_str,
        schedule: Some(schedule),
        source,
        items: day_items,
        now_min: None,
        errors,
        weekday_template: None,
    })
}

pub async fn pick_schedule(
    pool: &SqlitePool,
    user_id: i64,
    date: Date,
) -> AppResult<(Option<Schedule>, ScheduleSource)> {
    let override_sid: Option<(i64,)> = sqlx::query_as(
        "SELECT schedule_id FROM calendar_date_overrides WHERE user_id = ? AND date = ?",
    )
    .bind(user_id)
    .bind(date)
    .fetch_optional(pool)
    .await?;
    if let Some((sid,)) = override_sid {
        let s = crate::routes::schedules::load_schedule(pool, user_id, sid).await?;
        return Ok((Some(s), ScheduleSource::DateOverride));
    }
    let weekday = date.weekday().number_days_from_monday() as i64;
    let wd: Option<(Option<i64>,)> = sqlx::query_as(
        "SELECT schedule_id FROM calendar_weekday_bindings WHERE user_id = ? AND weekday = ?",
    )
    .bind(user_id)
    .bind(weekday)
    .fetch_optional(pool)
    .await?;
    if let Some((Some(sid),)) = wd {
        let s = crate::routes::schedules::load_schedule(pool, user_id, sid).await?;
        return Ok((Some(s), ScheduleSource::WeekdayTemplate));
    }
    Ok((None, ScheduleSource::None))
}

pub(crate) async fn resolve_payload(
    pool: &SqlitePool,
    user_id: i64,
    item: &ScheduleItem,
) -> AppResult<ResolvedPayload> {
    // `use_inline` is the Task-vs-Project discriminator; render inline even when `inline_label` is None.
    if item.use_inline {
        return Ok(ResolvedPayload::Inline {
            label: item.inline_label.clone().unwrap_or_default(),
            description: item.inline_description.clone(),
        });
    }
    // Project mode: walk the specific-task / specific-project / ranked-project chain, ignoring any `inline_label`.
    if let Some(tid) = item.task_id {
        match load_task_full(pool, user_id, tid).await? {
            Some(task) if task.completed_at.is_none() => {
                return Ok(ResolvedPayload::Task {
                    task_id: task.id,
                    task_name: task.name,
                    project_id: task.project_id,
                    project_name: task.project_name,
                    task_description: task.description,
                    rank_indicator: None,
                    color: task.project_color,
                });
            }
            // Task exists but is completed; surface the project name and report `project_has_tasks: true`.
            Some(task) => {
                return Ok(ResolvedPayload::Empty {
                    reason: "specific task is completed".into(),
                    rank_indicator: None,
                    project_name: Some(task.project_name),
                    project_color: Some(task.project_color),
                    project_has_tasks: true,
                });
            }
            None => {
                return Ok(ResolvedPayload::Empty {
                    reason: "specific task is missing".into(),
                    rank_indicator: None,
                    project_name: None,
                    project_color: None,
                    project_has_tasks: false,
                });
            }
        }
    }
    if let Some(pid) = item.project_id {
        match pick_task_in_project(pool, user_id, pid, item.task_rank).await? {
            Some(task) => {
                return Ok(ResolvedPayload::Task {
                    task_id: task.id,
                    task_name: task.name,
                    project_id: pid,
                    project_name: task.project_name,
                    task_description: task.description,
                    rank_indicator: Some(RankIndicator {
                        project_rank: None,
                        task_rank: Some(item.task_rank),
                    }),
                    color: task.project_color,
                });
            }
            None => {
                // Project is picked, so surface its name/color/has-tasks even when no task slots into the rank.
                let project = load_project_brief(pool, user_id, pid).await?;
                let (project_name, project_color, project_has_tasks) = match project {
                    Some((name, color, has)) => (Some(name), Some(color), has),
                    None => (None, None, false),
                };
                return Ok(ResolvedPayload::Empty {
                    reason: "no eligible task in project".into(),
                    rank_indicator: Some(RankIndicator {
                        project_rank: None,
                        task_rank: Some(item.task_rank),
                    }),
                    project_name,
                    project_color,
                    project_has_tasks,
                });
            }
        }
    }
    let project_id = pick_project_by_rank(pool, user_id, item.project_rank).await?;
    match project_id {
        Some(pid) => match pick_task_in_project(pool, user_id, pid, item.task_rank).await? {
            Some(task) => Ok(ResolvedPayload::Task {
                task_id: task.id,
                task_name: task.name,
                project_id: pid,
                project_name: task.project_name,
                task_description: task.description,
                rank_indicator: Some(RankIndicator {
                    project_rank: Some(item.project_rank),
                    task_rank: Some(item.task_rank),
                }),
                color: task.project_color,
            }),
            None => {
                let project = load_project_brief(pool, user_id, pid).await?;
                let (project_name, project_color, project_has_tasks) = match project {
                    Some((name, color, has)) => (Some(name), Some(color), has),
                    None => (None, None, false),
                };
                Ok(ResolvedPayload::Empty {
                    reason: "no eligible task in ranked project".into(),
                    rank_indicator: Some(RankIndicator {
                        project_rank: Some(item.project_rank),
                        task_rank: Some(item.task_rank),
                    }),
                    project_name,
                    project_color,
                    project_has_tasks,
                })
            }
        },
        None => Ok(ResolvedPayload::Empty {
            reason: "no project at this rank".into(),
            rank_indicator: Some(RankIndicator {
                project_rank: Some(item.project_rank),
                task_rank: Some(item.task_rank),
            }),
            project_name: None,
            project_color: None,
            project_has_tasks: false,
        }),
    }
}

// Batch resolver: load a user's projects/tasks/deps once, then resolve every item in memory (avoids per-item DB round-trips).

/// Per-user resolver snapshot built once via `load`; it's point-in-time, so don't cache it across requests.
pub struct UserResolveContext {
    projects_by_id: HashMap<i64, Project>,
    tasks_by_id: HashMap<i64, Task>,
    /// Task ids per project, pre-sorted `(list_order ASC, id ASC)` to match `pick_task_in_project`.
    tasks_by_project: HashMap<i64, Vec<i64>>,
    /// `blocked_id -> [blocker_id]`. Missing keys mean "no blockers".
    blockers_by_blocked: HashMap<i64, Vec<i64>>,
    /// Non-archived project ids sorted `(value/time_cost) DESC, created_at ASC, id ASC`; zero-cost sorts last, task-less projects still included.
    ranked_project_ids: Vec<i64>,
}

impl UserResolveContext {
    pub async fn load(pool: &SqlitePool, user_id: i64) -> AppResult<Self> {
        let projects: Vec<Project> = sqlx::query_as::<_, Project>(
            "SELECT id, user_id, name, value, time_cost, color, archived_at, created_at
               FROM projects WHERE user_id = ?",
        )
        .bind(user_id)
        .fetch_all(pool)
        .await?;
        let tasks: Vec<Task> = sqlx::query_as::<_, Task>(
            "SELECT t.id, t.project_id, t.name, t.description, t.list_order,
                    t.completed_at, t.created_at
               FROM tasks t JOIN projects p ON p.id = t.project_id
              WHERE p.user_id = ?",
        )
        .bind(user_id)
        .fetch_all(pool)
        .await?;
        let deps: Vec<(i64, i64)> = sqlx::query_as(
            "SELECT td.blocked_id, td.blocker_id
               FROM task_dependencies td
               JOIN tasks t ON t.id = td.blocked_id
               JOIN projects p ON p.id = t.project_id
              WHERE p.user_id = ?",
        )
        .bind(user_id)
        .fetch_all(pool)
        .await?;

        let mut projects_by_id: HashMap<i64, Project> = HashMap::with_capacity(projects.len());
        for p in projects {
            projects_by_id.insert(p.id, p);
        }

        let mut tasks_by_id: HashMap<i64, Task> = HashMap::with_capacity(tasks.len());
        let mut tasks_by_project: HashMap<i64, Vec<i64>> = HashMap::new();
        for t in tasks {
            tasks_by_project.entry(t.project_id).or_default().push(t.id);
            tasks_by_id.insert(t.id, t);
        }
        for ids in tasks_by_project.values_mut() {
            ids.sort_by(|a, b| {
                let ta = &tasks_by_id[a];
                let tb = &tasks_by_id[b];
                ta.list_order
                    .partial_cmp(&tb.list_order)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| a.cmp(b))
            });
        }

        let mut blockers_by_blocked: HashMap<i64, Vec<i64>> = HashMap::new();
        for (blocked, blocker) in deps {
            blockers_by_blocked
                .entry(blocked)
                .or_default()
                .push(blocker);
        }

        // Rank like `pick_project_by_rank`: non-archived, `(value/time_cost) DESC, created_at, id`; task-less projects stay in, time_cost==0 sorts last.
        let mut ranked: Vec<i64> = projects_by_id
            .values()
            .filter(|p| p.archived_at.is_none())
            .map(|p| p.id)
            .collect();
        ranked.sort_by(|a, b| {
            let pa = &projects_by_id[a];
            let pb = &projects_by_id[b];
            let ra = if pa.time_cost == 0.0 {
                None
            } else {
                Some(pa.value / pa.time_cost)
            };
            let rb = if pb.time_cost == 0.0 {
                None
            } else {
                Some(pb.value / pb.time_cost)
            };
            // DESC on priority — bigger first, NULLs last.
            let primary = match (ra, rb) {
                (Some(x), Some(y)) => y.partial_cmp(&x).unwrap_or(std::cmp::Ordering::Equal),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            };
            primary
                .then_with(|| pa.created_at.cmp(&pb.created_at))
                .then_with(|| a.cmp(b))
        });

        Ok(Self {
            projects_by_id,
            tasks_by_id,
            tasks_by_project,
            blockers_by_blocked,
            ranked_project_ids: ranked,
        })
    }

    /// Resolve one item against the snapshot; kept at parity with [`resolve_payload`] by tests.
    pub fn resolve(&self, item: &ScheduleItem) -> ResolvedPayload {
        if item.use_inline {
            return ResolvedPayload::Inline {
                label: item.inline_label.clone().unwrap_or_default(),
                description: item.inline_description.clone(),
            };
        }
        if let Some(tid) = item.task_id {
            return match self.tasks_by_id.get(&tid) {
                Some(t) if t.completed_at.is_none() => match self.projects_by_id.get(&t.project_id)
                {
                    Some(p) => ResolvedPayload::Task {
                        task_id: t.id,
                        task_name: t.name.clone(),
                        project_id: t.project_id,
                        project_name: p.name.clone(),
                        task_description: t.description.clone(),
                        rank_indicator: None,
                        color: p.color.clone(),
                    },
                    // Task without a project shouldn't happen under our FK; degrade gracefully.
                    None => ResolvedPayload::Empty {
                        reason: "specific task is missing".into(),
                        rank_indicator: None,
                        project_name: None,
                        project_color: None,
                        project_has_tasks: false,
                    },
                },
                Some(t) => {
                    let project = self.projects_by_id.get(&t.project_id);
                    let (project_name, project_color) = match project {
                        Some(p) => (Some(p.name.clone()), Some(p.color.clone())),
                        None => (None, None),
                    };
                    // Completed-task branch: project has at least the matched task, so `project_has_tasks` is true.
                    ResolvedPayload::Empty {
                        reason: "specific task is completed".into(),
                        rank_indicator: None,
                        project_name,
                        project_color,
                        project_has_tasks: true,
                    }
                }
                None => ResolvedPayload::Empty {
                    reason: "specific task is missing".into(),
                    rank_indicator: None,
                    project_name: None,
                    project_color: None,
                    project_has_tasks: false,
                },
            };
        }
        if let Some(pid) = item.project_id {
            return match self.pick_task_in_project(pid, item.task_rank) {
                Some(task) => {
                    let project = self.projects_by_id.get(&pid);
                    let (project_name, color) = match project {
                        Some(p) => (p.name.clone(), p.color.clone()),
                        None => (String::new(), String::new()),
                    };
                    ResolvedPayload::Task {
                        task_id: task.id,
                        task_name: task.name.clone(),
                        project_id: pid,
                        project_name,
                        task_description: task.description.clone(),
                        rank_indicator: Some(RankIndicator {
                            project_rank: None,
                            task_rank: Some(item.task_rank),
                        }),
                        color,
                    }
                }
                None => {
                    let (project_name, project_color) = match self.projects_by_id.get(&pid) {
                        Some(p) => (Some(p.name.clone()), Some(p.color.clone())),
                        None => (None, None),
                    };
                    let project_has_tasks = self
                        .tasks_by_project
                        .get(&pid)
                        .is_some_and(|ids| !ids.is_empty());
                    ResolvedPayload::Empty {
                        reason: "no eligible task in project".into(),
                        rank_indicator: Some(RankIndicator {
                            project_rank: None,
                            task_rank: Some(item.task_rank),
                        }),
                        project_name,
                        project_color,
                        project_has_tasks,
                    }
                }
            };
        }
        match self.pick_project_by_rank(item.project_rank) {
            Some(pid) => match self.pick_task_in_project(pid, item.task_rank) {
                Some(task) => {
                    let project = self.projects_by_id.get(&pid);
                    let (project_name, color) = match project {
                        Some(p) => (p.name.clone(), p.color.clone()),
                        None => (String::new(), String::new()),
                    };
                    ResolvedPayload::Task {
                        task_id: task.id,
                        task_name: task.name.clone(),
                        project_id: pid,
                        project_name,
                        task_description: task.description.clone(),
                        rank_indicator: Some(RankIndicator {
                            project_rank: Some(item.project_rank),
                            task_rank: Some(item.task_rank),
                        }),
                        color,
                    }
                }
                None => {
                    let (project_name, project_color) = match self.projects_by_id.get(&pid) {
                        Some(p) => (Some(p.name.clone()), Some(p.color.clone())),
                        None => (None, None),
                    };
                    let project_has_tasks = self
                        .tasks_by_project
                        .get(&pid)
                        .is_some_and(|ids| !ids.is_empty());
                    ResolvedPayload::Empty {
                        reason: "no eligible task in ranked project".into(),
                        rank_indicator: Some(RankIndicator {
                            project_rank: Some(item.project_rank),
                            task_rank: Some(item.task_rank),
                        }),
                        project_name,
                        project_color,
                        project_has_tasks,
                    }
                }
            },
            None => ResolvedPayload::Empty {
                reason: "no project at this rank".into(),
                rank_indicator: Some(RankIndicator {
                    project_rank: Some(item.project_rank),
                    task_rank: Some(item.task_rank),
                }),
                project_name: None,
                project_color: None,
                project_has_tasks: false,
            },
        }
    }

    fn pick_project_by_rank(&self, rank: i64) -> Option<i64> {
        if rank < 1 {
            return None;
        }
        self.ranked_project_ids.get((rank - 1) as usize).copied()
    }

    fn pick_task_in_project(&self, project_id: i64, rank: i64) -> Option<&Task> {
        if rank < 1 {
            return None;
        }
        let ids = self.tasks_by_project.get(&project_id)?;
        let completed: HashSet<i64> = ids
            .iter()
            .filter(|id| {
                self.tasks_by_id
                    .get(id)
                    .is_some_and(|t| t.completed_at.is_some())
            })
            .copied()
            .collect();
        let mut count: i64 = 0;
        for tid in ids {
            let task = self.tasks_by_id.get(tid)?;
            if task.completed_at.is_some() {
                continue;
            }
            let blockers = self.blockers_by_blocked.get(tid);
            let all_done = blockers
                .map(|bs| bs.iter().all(|b| completed.contains(b)))
                .unwrap_or(true);
            if all_done {
                count += 1;
                if count == rank {
                    return Some(task);
                }
            }
        }
        None
    }
}

/// Returns `(name, color, has_tasks)` for an owned project; used by `Empty` branches to surface project identity.
async fn load_project_brief(
    pool: &SqlitePool,
    user_id: i64,
    project_id: i64,
) -> AppResult<Option<(String, String, bool)>> {
    let row: Option<(String, String, i64)> = sqlx::query_as(
        "SELECT p.name, p.color,
                EXISTS(SELECT 1 FROM tasks t WHERE t.project_id = p.id)
           FROM projects p WHERE p.id = ? AND p.user_id = ?",
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(name, color, has)| (name, color, has != 0)))
}

struct LoadedTask {
    id: i64,
    project_id: i64,
    project_name: String,
    /// Owning project's palette key, propagated into the `Task` payload so the timeline paints without a frontend lookup.
    project_color: String,
    name: String,
    description: Option<String>,
    completed_at: Option<time::OffsetDateTime>,
}

async fn load_task_full(
    pool: &SqlitePool,
    user_id: i64,
    task_id: i64,
) -> AppResult<Option<LoadedTask>> {
    let row: Option<(
        i64,
        i64,
        String,
        String,
        String,
        Option<String>,
        Option<time::OffsetDateTime>,
    )> = sqlx::query_as(
        "SELECT t.id, t.project_id, p.name, p.color, t.name, t.description, t.completed_at
           FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE t.id = ? AND p.user_id = ?",
    )
    .bind(task_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(id, pid, pname, pcolor, n, d, c)| LoadedTask {
        id,
        project_id: pid,
        project_name: pname,
        project_color: pcolor,
        name: n,
        description: d,
        completed_at: c,
    }))
}

async fn pick_project_by_rank(
    pool: &SqlitePool,
    user_id: i64,
    rank: i64,
) -> AppResult<Option<i64>> {
    if rank < 1 {
        return Ok(None);
    }
    // Non-archived projects by priority DESC, created_at, id; task-less ones stay in so sentinel ranks don't flicker or skip.
    let rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT p.id FROM projects p
          WHERE p.user_id = ? AND p.archived_at IS NULL
          ORDER BY (p.value / p.time_cost) DESC, p.created_at ASC, p.id ASC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.get((rank - 1) as usize).map(|(id,)| *id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::schedule::Schedule;
    use serde_json::Value;
    use sqlx::sqlite::SqlitePoolOptions;
    use std::fs;
    use std::path::Path;

    /// In-memory pool with schema + one seeded user; each call is isolated.
    async fn fresh_pool() -> (sqlx::SqlitePool, i64) {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect in-memory sqlite");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("apply migrations");
        let row: (i64,) = sqlx::query_as(
            "INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id",
        )
        .bind("alice")
        .bind("hash")
        .fetch_one(&pool)
        .await
        .expect("seed user");
        (pool, row.0)
    }

    fn project_item(project_id: i64) -> ScheduleItem {
        ScheduleItem {
            id: 0,
            schedule_id: 0,
            position: 1.0,
            start_min: None,
            end_min: None,
            duration_target: 60,
            // Item color is a deliberately contrasting key so tests catch a leaked item color.
            use_inline: false,
            inline_label: None,
            inline_description: None,
            color: "blue".to_string(),
            project_id: Some(project_id),
            project_rank: 1,
            task_id: None,
            task_rank: 1,
        }
    }

    /// Project-bound item must surface the project's color on the `Task` payload, not the item's own.
    #[tokio::test]
    async fn resolve_payload_task_carries_project_color() {
        let (pool, user_id) = fresh_pool().await;
        let (project_id,): (i64,) = sqlx::query_as(
            "INSERT INTO projects (user_id, name, value, time_cost, color)
             VALUES (?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(user_id)
        .bind("Magenta proj")
        .bind(1.0)
        .bind(60.0)
        .bind("magenta")
        .fetch_one(&pool)
        .await
        .unwrap();
        let (_task_id,): (i64,) = sqlx::query_as(
            "INSERT INTO tasks (project_id, name, list_order) VALUES (?, ?, ?) RETURNING id",
        )
        .bind(project_id)
        .bind("T1")
        .bind(1.0)
        .fetch_one(&pool)
        .await
        .unwrap();

        let item = project_item(project_id);
        let payload = resolve_payload(&pool, user_id, &item).await.unwrap();
        match payload {
            ResolvedPayload::Task {
                color,
                project_name,
                ..
            } => {
                assert_eq!(color, "magenta", "Task payload uses project color");
                assert_eq!(project_name, "Magenta proj");
            }
            other => panic!("expected Task payload, got {:?}", other),
        }
    }

    /// `UserResolveContext::resolve` must match `resolve_payload`'s `Task` payload (including project color) for a project-bound item.
    #[tokio::test]
    async fn user_context_resolves_task_with_project_color() {
        let (pool, user_id) = fresh_pool().await;
        let (project_id,): (i64,) = sqlx::query_as(
            "INSERT INTO projects (user_id, name, value, time_cost, color)
             VALUES (?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(user_id)
        .bind("Magenta proj")
        .bind(1.0)
        .bind(60.0)
        .bind("magenta")
        .fetch_one(&pool)
        .await
        .unwrap();
        let (_task_id,): (i64,) = sqlx::query_as(
            "INSERT INTO tasks (project_id, name, list_order) VALUES (?, ?, ?) RETURNING id",
        )
        .bind(project_id)
        .bind("T1")
        .bind(1.0)
        .fetch_one(&pool)
        .await
        .unwrap();
        let ctx = UserResolveContext::load(&pool, user_id).await.unwrap();
        let item = project_item(project_id);
        match ctx.resolve(&item) {
            ResolvedPayload::Task {
                color,
                project_name,
                task_name,
                ..
            } => {
                assert_eq!(color, "magenta", "Task payload uses project color");
                assert_eq!(project_name, "Magenta proj");
                assert_eq!(task_name, "T1");
            }
            other => panic!("expected Task payload, got {:?}", other),
        }
    }

    /// Sentinel-rank item (`project_id` None, rank 1) must resolve to the user's highest-priority project.
    #[tokio::test]
    async fn user_context_resolves_sentinel_rank_project() {
        let (pool, user_id) = fresh_pool().await;
        // Two projects: Hi priority 10.0, Lo priority 1.0.
        let (hi_id,): (i64,) = sqlx::query_as(
            "INSERT INTO projects (user_id, name, value, time_cost, color)
             VALUES (?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(user_id)
        .bind("Hi")
        .bind(10.0)
        .bind(1.0)
        .bind("orange")
        .fetch_one(&pool)
        .await
        .unwrap();
        let (lo_id,): (i64,) = sqlx::query_as(
            "INSERT INTO projects (user_id, name, value, time_cost, color)
             VALUES (?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(user_id)
        .bind("Lo")
        .bind(1.0)
        .bind(1.0)
        .bind("lime")
        .fetch_one(&pool)
        .await
        .unwrap();
        // Both projects need at least one uncompleted task to be eligible.
        for pid in [hi_id, lo_id] {
            sqlx::query("INSERT INTO tasks (project_id, name, list_order) VALUES (?, ?, ?)")
                .bind(pid)
                .bind("T")
                .bind(1.0)
                .execute(&pool)
                .await
                .unwrap();
        }
        let ctx = UserResolveContext::load(&pool, user_id).await.unwrap();
        let item = ScheduleItem {
            id: 0,
            schedule_id: 0,
            position: 1.0,
            start_min: None,
            end_min: None,
            duration_target: 60,
            use_inline: false,
            inline_label: None,
            inline_description: None,
            color: "blue".to_string(),
            project_id: None,
            project_rank: 1,
            task_id: None,
            task_rank: 1,
        };
        match ctx.resolve(&item) {
            ResolvedPayload::Task {
                project_id, color, ..
            } => {
                assert_eq!(
                    project_id, hi_id,
                    "rank=1 must pick higher-priority project"
                );
                assert_eq!(color, "orange");
            }
            other => panic!("expected Task payload, got {:?}", other),
        }
        let mut item2 = item.clone();
        item2.project_rank = 2;
        match ctx.resolve(&item2) {
            ResolvedPayload::Task { project_id, .. } => {
                assert_eq!(project_id, lo_id, "rank=2 picks second-priority project");
            }
            other => panic!("expected Task payload, got {:?}", other),
        }
    }

    /// `Empty` payloads must also carry the project's color when the project resolved but no task did.
    #[tokio::test]
    async fn resolve_payload_empty_carries_project_color() {
        let (pool, user_id) = fresh_pool().await;
        let (project_id,): (i64,) = sqlx::query_as(
            "INSERT INTO projects (user_id, name, value, time_cost, color)
             VALUES (?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(user_id)
        .bind("Yellow proj")
        .bind(1.0)
        .bind(60.0)
        .bind("yellow")
        .fetch_one(&pool)
        .await
        .unwrap();
        // Zero tasks → `project_has_tasks` false, which the UI uses to suppress the "no subtask" suffix.
        let item = project_item(project_id);
        let payload = resolve_payload(&pool, user_id, &item).await.unwrap();
        match payload {
            ResolvedPayload::Empty {
                project_color,
                project_name,
                project_has_tasks,
                ..
            } => {
                assert_eq!(project_color.as_deref(), Some("yellow"));
                assert_eq!(project_name.as_deref(), Some("Yellow proj"));
                assert!(
                    !project_has_tasks,
                    "project with zero tasks should report false"
                );
            }
            other => panic!("expected Empty payload, got {:?}", other),
        }
    }

    /// A project with subtasks but none at the rank must report `project_has_tasks: true`; checks both paths.
    #[tokio::test]
    async fn resolve_payload_empty_with_tasks_reports_true() {
        let (pool, user_id) = fresh_pool().await;
        let (project_id,): (i64,) = sqlx::query_as(
            "INSERT INTO projects (user_id, name, value, time_cost, color)
             VALUES (?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(user_id)
        .bind("Has-tasks proj")
        .bind(1.0)
        .bind(60.0)
        .bind("yellow")
        .fetch_one(&pool)
        .await
        .unwrap();
        // One completed task: the rank-1 pick fails while the project still has a task on the books.
        sqlx::query(
            "INSERT INTO tasks (project_id, name, list_order, completed_at)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
        )
        .bind(project_id)
        .bind("Done")
        .bind(1.0)
        .execute(&pool)
        .await
        .unwrap();

        let item = project_item(project_id);
        let payload = resolve_payload(&pool, user_id, &item).await.unwrap();
        match payload {
            ResolvedPayload::Empty {
                project_has_tasks, ..
            } => {
                assert!(
                    project_has_tasks,
                    "async path: project with one completed task should report true"
                );
            }
            other => panic!("expected Empty payload, got {:?}", other),
        }
        let ctx = UserResolveContext::load(&pool, user_id).await.unwrap();
        match ctx.resolve(&item) {
            ResolvedPayload::Empty {
                project_has_tasks, ..
            } => {
                assert!(
                    project_has_tasks,
                    "sync path: project with one completed task should report true"
                );
            }
            other => panic!("expected Empty payload, got {:?}", other),
        }
    }

    /// Parity guard: `resolve_payload` and `UserResolveContext::resolve` must pick the same project for sentinel-rank items.
    #[tokio::test]
    async fn sentinel_rank_paths_agree() {
        let (pool, user_id) = fresh_pool().await;
        // Three projects with distinct priority ratios so tiebreakers never matter.
        let pids: Vec<i64> = {
            let mut v = Vec::new();
            for (name, color, value, time_cost) in [
                ("Mid", "violet", 5.0, 1.0),
                ("Hi", "orange", 10.0, 1.0),
                ("Lo", "lime", 1.0, 1.0),
            ] {
                let (id,): (i64,) = sqlx::query_as(
                    "INSERT INTO projects (user_id, name, value, time_cost, color)
                     VALUES (?, ?, ?, ?, ?) RETURNING id",
                )
                .bind(user_id)
                .bind(name)
                .bind(value)
                .bind(time_cost)
                .bind(color)
                .fetch_one(&pool)
                .await
                .unwrap();
                sqlx::query("INSERT INTO tasks (project_id, name, list_order) VALUES (?, ?, ?)")
                    .bind(id)
                    .bind("T")
                    .bind(1.0)
                    .execute(&pool)
                    .await
                    .unwrap();
                v.push(id);
            }
            v
        };
        let mid = pids[0];
        let hi = pids[1];
        let lo = pids[2];

        let mut sentinel = ScheduleItem {
            id: 0,
            schedule_id: 0,
            position: 1.0,
            start_min: None,
            end_min: None,
            duration_target: 60,
            use_inline: false,
            inline_label: None,
            inline_description: None,
            color: "blue".to_string(),
            project_id: None,
            project_rank: 1,
            task_id: None,
            task_rank: 1,
        };
        let ctx = UserResolveContext::load(&pool, user_id).await.unwrap();

        for (rank, expected_pid) in [(1, hi), (2, mid), (3, lo)] {
            sentinel.project_rank = rank;
            let async_payload = resolve_payload(&pool, user_id, &sentinel).await.unwrap();
            let sync_payload = ctx.resolve(&sentinel);
            let async_pid = match &async_payload {
                ResolvedPayload::Task { project_id, .. } => Some(*project_id),
                _ => None,
            };
            let sync_pid = match &sync_payload {
                ResolvedPayload::Task { project_id, .. } => Some(*project_id),
                _ => None,
            };
            assert_eq!(
                async_pid,
                Some(expected_pid),
                "async path: rank={} expected pid {} got {:?} ({:?})",
                rank,
                expected_pid,
                async_pid,
                async_payload
            );
            assert_eq!(
                sync_pid,
                Some(expected_pid),
                "sync path: rank={} expected pid {} got {:?} ({:?})",
                rank,
                expected_pid,
                sync_pid,
                sync_payload
            );
            assert_eq!(async_pid, sync_pid, "rank={} async/sync disagree", rank);
        }
    }

    /// After the rank-1 project is deleted, a sentinel item must fall through to the new rank-1, even task-less.
    #[tokio::test]
    async fn sentinel_falls_through_when_rank1_deleted() {
        let (pool, user_id) = fresh_pool().await;
        // Two projects: Hi (ratio 10, has a task) and Lo (ratio 1, task-less).
        let (hi_id,): (i64,) = sqlx::query_as(
            "INSERT INTO projects (user_id, name, value, time_cost, color)
             VALUES (?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(user_id)
        .bind("Hi")
        .bind(10.0)
        .bind(1.0)
        .bind("orange")
        .fetch_one(&pool)
        .await
        .unwrap();
        let (_lo_id,): (i64,) = sqlx::query_as(
            "INSERT INTO projects (user_id, name, value, time_cost, color)
             VALUES (?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(user_id)
        .bind("Lo")
        .bind(1.0)
        .bind(1.0)
        .bind("lime")
        .fetch_one(&pool)
        .await
        .unwrap();
        // Lo intentionally has no task to exercise the zero-task ranking branch.
        sqlx::query("INSERT INTO tasks (project_id, name, list_order) VALUES (?, ?, ?)")
            .bind(hi_id)
            .bind("T")
            .bind(1.0)
            .execute(&pool)
            .await
            .unwrap();

        let sentinel = ScheduleItem {
            id: 0,
            schedule_id: 0,
            position: 1.0,
            start_min: None,
            end_min: None,
            duration_target: 60,
            use_inline: false,
            inline_label: None,
            inline_description: None,
            color: "blue".to_string(),
            project_id: None,
            project_rank: 1,
            task_id: None,
            task_rank: 1,
        };

        // Sanity: pre-delete rank-1 resolves to Hi.
        let ctx = UserResolveContext::load(&pool, user_id).await.unwrap();
        let payload = ctx.resolve(&sentinel);
        let pre_pid = match &payload {
            ResolvedPayload::Task { project_id, .. } => Some(*project_id),
            _ => None,
        };
        assert_eq!(pre_pid, Some(hi_id), "pre-delete rank-1 should be Hi");

        // Delete Hi; its task cascades, and the sentinel's NULL `project_id` makes ON DELETE SET NULL a no-op.
        sqlx::query("DELETE FROM projects WHERE id = ?")
            .bind(hi_id)
            .execute(&pool)
            .await
            .unwrap();

        // Re-load both contexts; Lo has no tasks so the resolver returns `Empty` but must surface Lo's name/color.
        let ctx2 = UserResolveContext::load(&pool, user_id).await.unwrap();
        let async_payload = resolve_payload(&pool, user_id, &sentinel).await.unwrap();
        let sync_payload = ctx2.resolve(&sentinel);
        for (label, payload) in [("async", &async_payload), ("sync", &sync_payload)] {
            match payload {
                ResolvedPayload::Empty {
                    project_name,
                    project_color,
                    project_has_tasks,
                    rank_indicator,
                    ..
                } => {
                    assert_eq!(
                        project_name.as_deref(),
                        Some("Lo"),
                        "{}: rank-1 should fall through to Lo after Hi delete (got payload {:?})",
                        label,
                        payload
                    );
                    assert_eq!(
                        project_color.as_deref(),
                        Some("lime"),
                        "{}: Lo's color must surface so the block paints correctly",
                        label
                    );
                    assert!(
                        !*project_has_tasks,
                        "{}: Lo has zero tasks so project_has_tasks must be false",
                        label
                    );
                    assert_eq!(
                        rank_indicator.as_ref().and_then(|r| r.project_rank),
                        Some(1),
                        "{}: rank indicator must reflect rank-1 resolution",
                        label
                    );
                }
                other => panic!(
                    "{}: expected Empty payload pointing at Lo, got {:?}",
                    label, other
                ),
            }
        }
    }

    /// A project with zero uncompleted tasks must still rank, resolving to its `Empty` payload not "no project at this rank".
    #[tokio::test]
    async fn zero_task_project_still_ranks() {
        let (pool, user_id) = fresh_pool().await;
        let (pid,): (i64,) = sqlx::query_as(
            "INSERT INTO projects (user_id, name, value, time_cost, color)
             VALUES (?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(user_id)
        .bind("Solo")
        .bind(1.0)
        .bind(1.0)
        .bind("magenta")
        .fetch_one(&pool)
        .await
        .unwrap();

        let sentinel = ScheduleItem {
            id: 0,
            schedule_id: 0,
            position: 1.0,
            start_min: None,
            end_min: None,
            duration_target: 60,
            use_inline: false,
            inline_label: None,
            inline_description: None,
            color: "blue".to_string(),
            project_id: None,
            project_rank: 1,
            task_id: None,
            task_rank: 1,
        };

        let ctx = UserResolveContext::load(&pool, user_id).await.unwrap();
        let async_payload = resolve_payload(&pool, user_id, &sentinel).await.unwrap();
        let sync_payload = ctx.resolve(&sentinel);

        for (label, payload) in [("async", &async_payload), ("sync", &sync_payload)] {
            match payload {
                ResolvedPayload::Empty {
                    project_name,
                    project_color,
                    project_has_tasks,
                    ..
                } => {
                    assert_eq!(
                        project_name.as_deref(),
                        Some("Solo"),
                        "{}: empty rank-1 should still surface Solo's name",
                        label
                    );
                    assert_eq!(
                        project_color.as_deref(),
                        Some("magenta"),
                        "{}: Solo's color must surface",
                        label
                    );
                    assert!(
                        !*project_has_tasks,
                        "{}: Solo has zero tasks → project_has_tasks must be false",
                        label
                    );
                }
                other => panic!(
                    "{}: expected Empty payload pointing at Solo, got {:?}",
                    label, other
                ),
            }
            assert_eq!(
                match payload {
                    ResolvedPayload::Empty { rank_indicator, .. } =>
                        rank_indicator.as_ref().and_then(|r| r.project_rank),
                    _ => None,
                },
                Some(1),
                "{}: rank indicator should still report rank-1",
                label
            );
            let _ = pid;
        }
    }

    /// A project whose only task is completed must still rank, yielding `Empty { project_has_tasks: true }`.
    #[tokio::test]
    async fn all_completed_project_still_ranks() {
        let (pool, user_id) = fresh_pool().await;
        let (pid,): (i64,) = sqlx::query_as(
            "INSERT INTO projects (user_id, name, value, time_cost, color)
             VALUES (?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(user_id)
        .bind("AllDone")
        .bind(1.0)
        .bind(1.0)
        .bind("seafoam")
        .fetch_one(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO tasks (project_id, name, list_order, completed_at)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
        )
        .bind(pid)
        .bind("done")
        .bind(1.0)
        .execute(&pool)
        .await
        .unwrap();

        let sentinel = ScheduleItem {
            id: 0,
            schedule_id: 0,
            position: 1.0,
            start_min: None,
            end_min: None,
            duration_target: 60,
            use_inline: false,
            inline_label: None,
            inline_description: None,
            color: "blue".to_string(),
            project_id: None,
            project_rank: 1,
            task_id: None,
            task_rank: 1,
        };

        let ctx = UserResolveContext::load(&pool, user_id).await.unwrap();
        let async_payload = resolve_payload(&pool, user_id, &sentinel).await.unwrap();
        let sync_payload = ctx.resolve(&sentinel);

        for (label, payload) in [("async", &async_payload), ("sync", &sync_payload)] {
            match payload {
                ResolvedPayload::Empty {
                    project_name,
                    project_has_tasks,
                    ..
                } => {
                    assert_eq!(
                        project_name.as_deref(),
                        Some("AllDone"),
                        "{}: empty rank-1 should still surface AllDone's name",
                        label
                    );
                    assert!(
                        *project_has_tasks,
                        "{}: AllDone has one (completed) task → project_has_tasks true",
                        label
                    );
                }
                other => panic!(
                    "{}: expected Empty payload pointing at AllDone, got {:?}",
                    label, other
                ),
            }
        }
    }

    /// Archived projects never rank; a sentinel with only an archived project resolves to "no project at this rank".
    #[tokio::test]
    async fn archived_project_excluded_from_rank() {
        let (pool, user_id) = fresh_pool().await;
        let (_pid,): (i64,) = sqlx::query_as(
            "INSERT INTO projects (user_id, name, value, time_cost, color, archived_at)
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) RETURNING id",
        )
        .bind(user_id)
        .bind("Stale")
        .bind(1.0)
        .bind(1.0)
        .bind("violet")
        .fetch_one(&pool)
        .await
        .unwrap();

        let sentinel = ScheduleItem {
            id: 0,
            schedule_id: 0,
            position: 1.0,
            start_min: None,
            end_min: None,
            duration_target: 60,
            use_inline: false,
            inline_label: None,
            inline_description: None,
            color: "blue".to_string(),
            project_id: None,
            project_rank: 1,
            task_id: None,
            task_rank: 1,
        };

        let ctx = UserResolveContext::load(&pool, user_id).await.unwrap();
        let async_payload = resolve_payload(&pool, user_id, &sentinel).await.unwrap();
        let sync_payload = ctx.resolve(&sentinel);

        for (label, payload) in [("async", &async_payload), ("sync", &sync_payload)] {
            match payload {
                ResolvedPayload::Empty {
                    project_name,
                    reason,
                    ..
                } => {
                    assert!(
                        project_name.is_none(),
                        "{}: archived project must not surface as the resolved project (got name {:?})",
                        label,
                        project_name
                    );
                    assert_eq!(
                        reason, "no project at this rank",
                        "{}: archived-only state should report 'no project at this rank'",
                        label
                    );
                }
                other => panic!(
                    "{}: expected Empty payload (archived-only), got {:?}",
                    label, other
                ),
            }
        }
    }

    /// Sync mirror of the zero-task case: a task-less project must produce `project_has_tasks: false`.
    #[tokio::test]
    async fn user_context_resolves_empty_with_no_tasks_reports_false() {
        let (pool, user_id) = fresh_pool().await;
        let (project_id,): (i64,) = sqlx::query_as(
            "INSERT INTO projects (user_id, name, value, time_cost, color)
             VALUES (?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(user_id)
        .bind("Empty proj")
        .bind(1.0)
        .bind(60.0)
        .bind("yellow")
        .fetch_one(&pool)
        .await
        .unwrap();
        let ctx = UserResolveContext::load(&pool, user_id).await.unwrap();
        let item = project_item(project_id);
        match ctx.resolve(&item) {
            ResolvedPayload::Empty {
                project_name,
                project_has_tasks,
                ..
            } => {
                assert_eq!(project_name.as_deref(), Some("Empty proj"));
                assert!(
                    !project_has_tasks,
                    "project with zero tasks should report false"
                );
            }
            other => panic!("expected Empty payload, got {:?}", other),
        }
    }

    fn schedule_from(value: &Value) -> Schedule {
        Schedule {
            id: 0,
            user_id: 0,
            name: "test".into(),
            start_min: value["start_min"].as_i64().unwrap(),
            end_min: value["end_min"].as_i64().unwrap(),
        }
    }

    fn items_from(value: &Value) -> Vec<ScheduleItem> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|v| ScheduleItem {
                id: v["id"].as_i64().unwrap(),
                schedule_id: 0,
                position: v["position"].as_f64().unwrap(),
                start_min: v["start_min"].as_i64(),
                end_min: v["end_min"].as_i64(),
                duration_target: v["duration_target"].as_i64().unwrap(),
                use_inline: true,
                inline_label: None,
                inline_description: None,
                color: "blue".to_string(),
                project_id: None,
                project_rank: 1,
                task_id: None,
                task_rank: 1,
            })
            .collect()
    }

    #[test]
    fn golden_corpus() {
        let corpus_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("tests/layout");
        let entries: Vec<_> = fs::read_dir(&corpus_dir)
            .expect("read tests/layout")
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("json"))
            .collect();
        let mut sorted = entries;
        sorted.sort();
        assert!(
            !sorted.is_empty(),
            "no .json files in {}",
            corpus_dir.display()
        );

        for path in sorted {
            let raw = fs::read_to_string(&path).unwrap();
            let case: Value = serde_json::from_str(&raw).unwrap();
            let name = case["name"].as_str().unwrap_or("(unnamed)");
            let sched = schedule_from(&case["schedule"]);
            let items = items_from(&case["items"]);
            let result = compute_layout(&sched, &items);

            if let Some(expected_items) = case.get("expected").and_then(|e| e.get("items")) {
                let expected = expected_items.as_array().unwrap();
                assert_eq!(
                    result.items.len(),
                    expected.len(),
                    "[{}] item count mismatch",
                    name
                );
                for (i, ei) in expected.iter().enumerate() {
                    let r = &result.items[i];
                    assert_eq!(
                        r.id,
                        ei["id"].as_i64().unwrap(),
                        "[{}] id mismatch at {}",
                        name,
                        i
                    );
                    assert_eq!(
                        r.assigned_start,
                        ei["assigned_start"].as_i64().unwrap(),
                        "[{}] assigned_start mismatch at item {}",
                        name,
                        i
                    );
                    assert_eq!(
                        r.assigned_end,
                        ei["assigned_end"].as_i64().unwrap(),
                        "[{}] assigned_end mismatch at item {}",
                        name,
                        i
                    );
                    let f = &ei["flags"];
                    assert_eq!(
                        r.flags.overflow,
                        f["overflow"].as_bool().unwrap(),
                        "[{}] overflow mismatch at item {}",
                        name,
                        i
                    );
                    assert_eq!(
                        r.flags.out_of_bounds,
                        f["out_of_bounds"].as_bool().unwrap(),
                        "[{}] out_of_bounds mismatch at item {}",
                        name,
                        i
                    );
                    assert_eq!(
                        r.flags.below_min,
                        f["below_min"].as_bool().unwrap(),
                        "[{}] below_min mismatch at item {}",
                        name,
                        i
                    );
                }
            }
            if let Some(must_contain) = case.get("expected_errors_contain") {
                let need: Vec<String> = must_contain
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap().to_string())
                    .collect();
                let actual_names: Vec<String> =
                    result.errors.iter().map(|e| format!("{:?}", e)).collect();
                for n in need {
                    assert!(
                        actual_names.iter().any(|a| a == &n),
                        "[{}] expected error {} not present in {:?}",
                        name,
                        n,
                        actual_names
                    );
                }
            }
        }
    }
}

async fn pick_task_in_project(
    pool: &SqlitePool,
    user_id: i64,
    project_id: i64,
    rank: i64,
) -> AppResult<Option<LoadedTask>> {
    if rank < 1 {
        return Ok(None);
    }
    // Pick the rank-th uncompleted task in list_order whose blockers are all completed.
    let tasks: Vec<(
        i64,
        i64,
        String,
        String,
        String,
        Option<String>,
        Option<time::OffsetDateTime>,
    )> = sqlx::query_as(
        "SELECT t.id, t.project_id, p.name, p.color, t.name, t.description, t.completed_at
           FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE t.project_id = ? AND p.user_id = ?
          ORDER BY t.list_order ASC, t.id ASC",
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    let completed: std::collections::HashSet<i64> = tasks
        .iter()
        .filter_map(|(id, _, _, _, _, _, c)| c.as_ref().map(|_| *id))
        .collect();
    let mut eligible: Vec<LoadedTask> = Vec::new();
    for (id, pid, pname, pcolor, name, desc, comp) in tasks.into_iter() {
        if comp.is_some() {
            continue;
        }
        let deps: Vec<(i64,)> =
            sqlx::query_as("SELECT blocker_id FROM task_dependencies WHERE blocked_id = ?")
                .bind(id)
                .fetch_all(pool)
                .await?;
        let all_blockers_done = deps.iter().all(|(b,)| completed.contains(b));
        if all_blockers_done {
            eligible.push(LoadedTask {
                id,
                project_id: pid,
                project_name: pname,
                project_color: pcolor,
                name,
                description: desc,
                completed_at: None,
            });
        }
    }
    Ok(eligible.into_iter().nth((rank - 1) as usize))
}
