//! Per-user undo/redo log storing forward/backward `SubOp` lists; `context` is a per-tab redo stack, the cap a global ring.

use serde::{Deserialize, Serialize};
use sqlx::{Sqlite, Transaction};

use crate::error::{AppError, AppResult};
use crate::models::history::HISTORY_CAP;

/// Context tags; must match the `history.context` CHECK in `0001_init.sql`.
pub const CTX_SCHEDULE: &str = "schedule";
pub const CTX_PROJECT: &str = "project";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SubOp {
    // ----- schedule context -----
    PatchItem {
        id: i64,
        fields: serde_json::Value,
    },
    InsertItem {
        row: serde_json::Value,
    },
    DeleteItem {
        id: i64,
    },
    PatchSchedule {
        id: i64,
        fields: serde_json::Value,
    },
    InsertDailySchedule {
        date: String,
        schedule_id: i64,
    },
    DeleteDailySchedule {
        date: String,
    },
    /// Re-insert a schedule with its original id so bindings and items reattach on undo; missing keys use defaults.
    InsertSchedule {
        row: serde_json::Value,
    },
    /// Delete a schedule; its daily/template bindings cascade, so pair with the matching Insert ops for undo.
    DeleteSchedule {
        id: i64,
    },
    /// Mark a schedule as a template (ON CONFLICT no-op); restores a template binding on undo.
    InsertTemplate {
        schedule_id: i64,
    },
    /// Drop a template binding row; pair with `DeleteSchedule` to wipe both.
    DeleteTemplate {
        schedule_id: i64,
    },

    // ----- project context -----
    /// Re-insert a project with its original id/created_at so referencing rows round-trip cleanly.
    InsertProject {
        row: serde_json::Value,
    },
    /// Patch selected project columns; like `PatchItem`, only keys present in `fields` are written.
    PatchProject {
        id: i64,
        fields: serde_json::Value,
    },
    /// Delete a project; the cascade wipes tasks and deps, so undo pairs explicit Insert{Project,Task,TaskDep} backward ops.
    DeleteProject {
        id: i64,
    },
    InsertTask {
        row: serde_json::Value,
    },
    PatchTask {
        id: i64,
        fields: serde_json::Value,
    },
    DeleteTask {
        id: i64,
    },
    InsertTaskDep {
        blocked_id: i64,
        blocker_id: i64,
    },
    DeleteTaskDep {
        blocked_id: i64,
        blocker_id: i64,
    },
}

/// Snapshot of a schedule_items row, used to round-trip InsertItem.
pub async fn snapshot_item(
    tx: &mut Transaction<'_, Sqlite>,
    user_id: i64,
    id: i64,
) -> AppResult<Option<serde_json::Value>> {
    let row: Option<(
        i64,
        i64,
        f64,
        Option<i64>,
        Option<i64>,
        i64,
        bool,
        Option<String>,
        Option<String>,
        String,
        Option<i64>,
        i64,
        Option<i64>,
        i64,
    )> = sqlx::query_as(
        "SELECT si.id, si.schedule_id, si.position, si.start_min, si.end_min,
                si.duration_target, si.use_inline,
                si.inline_label, si.inline_description, si.color,
                si.project_id, si.project_rank, si.task_id, si.task_rank
         FROM schedule_items si
         JOIN schedules s ON s.id = si.schedule_id
         WHERE si.id = ? AND s.user_id = ?",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row.map(|r| {
        serde_json::json!({
            "id": r.0,
            "schedule_id": r.1,
            "position": r.2,
            "start_min": r.3,
            "end_min": r.4,
            "duration_target": r.5,
            "use_inline": r.6,
            "inline_label": r.7,
            "inline_description": r.8,
            "color": r.9,
            "project_id": r.10,
            "project_rank": r.11,
            "task_id": r.12,
            "task_rank": r.13,
        })
    }))
}

/// Full snapshot of a schedule row; `delete_schedule` round-trips it (with item snapshots) so undo restores the original id.
pub async fn snapshot_schedule(
    tx: &mut Transaction<'_, Sqlite>,
    user_id: i64,
    id: i64,
) -> AppResult<Option<serde_json::Value>> {
    let row: Option<(i64, i64, String, i64, i64)> = sqlx::query_as(
        "SELECT id, user_id, name, start_min, end_min
           FROM schedules WHERE id = ? AND user_id = ?",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row.map(|r| {
        serde_json::json!({
            "id": r.0,
            "user_id": r.1,
            "name": r.2,
            "start_min": r.3,
            "end_min": r.4,
        })
    }))
}

/// Snapshot the per-row schedule fields we mutate (start_min, end_min).
pub async fn snapshot_schedule_bounds(
    tx: &mut Transaction<'_, Sqlite>,
    user_id: i64,
    id: i64,
) -> AppResult<Option<serde_json::Value>> {
    let row: Option<(i64, i64)> =
        sqlx::query_as("SELECT start_min, end_min FROM schedules WHERE id = ? AND user_id = ?")
            .bind(id)
            .bind(user_id)
            .fetch_optional(&mut **tx)
            .await?;
    Ok(row.map(|r| serde_json::json!({ "start_min": r.0, "end_min": r.1 })))
}

/// Snapshot a project row; datetimes serialize as RFC3339 strings so JSON round-trips, parsed back by `apply_ops`.
pub async fn snapshot_project(
    tx: &mut Transaction<'_, Sqlite>,
    user_id: i64,
    id: i64,
) -> AppResult<Option<serde_json::Value>> {
    let row: Option<(
        i64,
        i64,
        String,
        f64,
        f64,
        String,
        Option<time::OffsetDateTime>,
        time::OffsetDateTime,
    )> = sqlx::query_as(
        "SELECT id, user_id, name, value, time_cost, color, archived_at, created_at
           FROM projects WHERE id = ? AND user_id = ?",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row.map(|r| {
        serde_json::json!({
            "id": r.0,
            "user_id": r.1,
            "name": r.2,
            "value": r.3,
            "time_cost": r.4,
            "color": r.5,
            "archived_at": r.6.map(format_dt),
            "created_at": format_dt(r.7),
        })
    }))
}

/// Snapshot a task row; same datetime convention as `snapshot_project`.
pub async fn snapshot_task(
    tx: &mut Transaction<'_, Sqlite>,
    user_id: i64,
    id: i64,
) -> AppResult<Option<serde_json::Value>> {
    let row: Option<(
        i64,
        i64,
        String,
        Option<String>,
        f64,
        Option<time::OffsetDateTime>,
        time::OffsetDateTime,
    )> = sqlx::query_as(
        "SELECT t.id, t.project_id, t.name, t.description, t.list_order,
                t.completed_at, t.created_at
           FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE t.id = ? AND p.user_id = ?",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row.map(|r| {
        serde_json::json!({
            "id": r.0,
            "project_id": r.1,
            "name": r.2,
            "description": r.3,
            "list_order": r.4,
            "completed_at": r.5.map(format_dt),
            "created_at": format_dt(r.6),
        })
    }))
}

/// All task ids for a `user_id`-owned `project_id`; used to snapshot the cascade for undo.
pub async fn task_ids_for_project(
    tx: &mut Transaction<'_, Sqlite>,
    user_id: i64,
    project_id: i64,
) -> AppResult<Vec<i64>> {
    let rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE t.project_id = ? AND p.user_id = ?
          ORDER BY t.id ASC",
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows.into_iter().map(|(i,)| i).collect())
}

/// All `task_dependencies` touching `task_ids` on either side, so undo restores the full graph.
pub async fn task_dependencies_for(
    tx: &mut Transaction<'_, Sqlite>,
    task_ids: &[i64],
) -> AppResult<Vec<(i64, i64)>> {
    if task_ids.is_empty() {
        return Ok(Vec::new());
    }
    // sqlx doesn't expand a slice, so build a static `IN (?, ?, …)` placeholder list.
    let placeholders = (0..task_ids.len())
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT blocked_id, blocker_id FROM task_dependencies
           WHERE blocked_id IN ({0}) OR blocker_id IN ({0})",
        placeholders
    );
    // SQL uses only `?` placeholders, no user input, so `AssertSqlSafe` is sound here.
    let mut q = sqlx::query_as::<_, (i64, i64)>(sqlx::AssertSqlSafe(sql));
    for &id in task_ids {
        q = q.bind(id);
    }
    for &id in task_ids {
        q = q.bind(id);
    }
    let rows = q.fetch_all(&mut **tx).await?;
    // Dedup: an A↔B edge may appear once per side of the IN clause.
    let mut seen: std::collections::HashSet<(i64, i64)> = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        if seen.insert(r) {
            out.push(r);
        }
    }
    Ok(out)
}

fn format_dt(dt: time::OffsetDateTime) -> String {
    dt.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

fn parse_dt(s: &str) -> AppResult<time::OffsetDateTime> {
    time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339)
        .map_err(|e| AppError::internal(format!("history: parse datetime {s}: {e}")))
}

pub async fn apply_ops(
    tx: &mut Transaction<'_, Sqlite>,
    user_id: i64,
    ops: &[SubOp],
) -> AppResult<()> {
    for op in ops {
        match op {
            SubOp::PatchItem { id, fields } => {
                let cur = snapshot_item(tx, user_id, *id).await?;
                if cur.is_none() {
                    return Err(AppError::not_found("schedule_item"));
                }
                if let Some(v) = fields.get("position") {
                    sqlx::query("UPDATE schedule_items SET position = ? WHERE id = ?")
                        .bind(v.as_f64().unwrap_or(0.0))
                        .bind(*id)
                        .execute(&mut **tx)
                        .await?;
                }
                // Write start_min and end_min together: the per-row CHECK fires per statement, so two UPDATEs would fail on reorder.
                let has_start = fields.get("start_min").is_some();
                let has_end = fields.get("end_min").is_some();
                if has_start && has_end {
                    sqlx::query(
                        "UPDATE schedule_items SET start_min = ?, end_min = ? WHERE id = ?",
                    )
                    .bind(fields.get("start_min").unwrap().as_i64())
                    .bind(fields.get("end_min").unwrap().as_i64())
                    .bind(*id)
                    .execute(&mut **tx)
                    .await?;
                } else if has_start {
                    sqlx::query("UPDATE schedule_items SET start_min = ? WHERE id = ?")
                        .bind(fields.get("start_min").unwrap().as_i64())
                        .bind(*id)
                        .execute(&mut **tx)
                        .await?;
                } else if has_end {
                    sqlx::query("UPDATE schedule_items SET end_min = ? WHERE id = ?")
                        .bind(fields.get("end_min").unwrap().as_i64())
                        .bind(*id)
                        .execute(&mut **tx)
                        .await?;
                }
                if let Some(v) = fields.get("duration_target") {
                    sqlx::query("UPDATE schedule_items SET duration_target = ? WHERE id = ?")
                        .bind(v.as_i64().unwrap_or(0))
                        .bind(*id)
                        .execute(&mut **tx)
                        .await?;
                }
                if let Some(v) = fields.get("use_inline") {
                    sqlx::query("UPDATE schedule_items SET use_inline = ? WHERE id = ?")
                        .bind(v.as_bool().unwrap_or(true))
                        .bind(*id)
                        .execute(&mut **tx)
                        .await?;
                }
                if fields.get("inline_label").is_some() {
                    let v = fields.get("inline_label").unwrap();
                    sqlx::query("UPDATE schedule_items SET inline_label = ? WHERE id = ?")
                        .bind(v.as_str())
                        .bind(*id)
                        .execute(&mut **tx)
                        .await?;
                }
                if fields.get("inline_description").is_some() {
                    let v = fields.get("inline_description").unwrap();
                    sqlx::query("UPDATE schedule_items SET inline_description = ? WHERE id = ?")
                        .bind(v.as_str())
                        .bind(*id)
                        .execute(&mut **tx)
                        .await?;
                }
                if let Some(v) = fields.get("color") {
                    // `as_str()` returns None for non-strings; bind the empty sentinel so the DB CHECK rejects it loudly.
                    let s = v.as_str().unwrap_or("");
                    sqlx::query("UPDATE schedule_items SET color = ? WHERE id = ?")
                        .bind(s)
                        .bind(*id)
                        .execute(&mut **tx)
                        .await?;
                }
                if fields.get("project_id").is_some() {
                    let v = fields.get("project_id").unwrap();
                    sqlx::query("UPDATE schedule_items SET project_id = ? WHERE id = ?")
                        .bind(v.as_i64())
                        .bind(*id)
                        .execute(&mut **tx)
                        .await?;
                }
                if fields.get("project_rank").is_some() {
                    let v = fields.get("project_rank").unwrap();
                    sqlx::query("UPDATE schedule_items SET project_rank = ? WHERE id = ?")
                        .bind(v.as_i64().unwrap_or(1))
                        .bind(*id)
                        .execute(&mut **tx)
                        .await?;
                }
                if fields.get("task_id").is_some() {
                    let v = fields.get("task_id").unwrap();
                    sqlx::query("UPDATE schedule_items SET task_id = ? WHERE id = ?")
                        .bind(v.as_i64())
                        .bind(*id)
                        .execute(&mut **tx)
                        .await?;
                }
                if fields.get("task_rank").is_some() {
                    let v = fields.get("task_rank").unwrap();
                    sqlx::query("UPDATE schedule_items SET task_rank = ? WHERE id = ?")
                        .bind(v.as_i64().unwrap_or(1))
                        .bind(*id)
                        .execute(&mut **tx)
                        .await?;
                }
            }
            SubOp::InsertItem { row } => {
                // Re-insert with the original id; default color to "blue" when a snapshot lacks it so the CHECK passes.
                let color = row.get("color").and_then(|v| v.as_str()).unwrap_or("blue");
                sqlx::query(
                    "INSERT INTO schedule_items
                     (id, schedule_id, position, start_min, end_min, duration_target,
                      use_inline, inline_label, inline_description, color,
                      project_id, project_rank, task_id, task_rank)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(row.get("id").and_then(|v| v.as_i64()))
                .bind(row.get("schedule_id").and_then(|v| v.as_i64()))
                .bind(row.get("position").and_then(|v| v.as_f64()))
                .bind(row.get("start_min").and_then(|v| v.as_i64()))
                .bind(row.get("end_min").and_then(|v| v.as_i64()))
                .bind(
                    row.get("duration_target")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                )
                .bind(
                    row.get("use_inline")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true),
                )
                .bind(row.get("inline_label").and_then(|v| v.as_str()))
                .bind(row.get("inline_description").and_then(|v| v.as_str()))
                .bind(color)
                .bind(row.get("project_id").and_then(|v| v.as_i64()))
                .bind(
                    row.get("project_rank")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(1),
                )
                .bind(row.get("task_id").and_then(|v| v.as_i64()))
                .bind(row.get("task_rank").and_then(|v| v.as_i64()).unwrap_or(1))
                .execute(&mut **tx)
                .await?;
            }
            SubOp::DeleteItem { id } => {
                let n = sqlx::query(
                    "DELETE FROM schedule_items WHERE id = ? AND schedule_id IN
                     (SELECT id FROM schedules WHERE user_id = ?)",
                )
                .bind(*id)
                .bind(user_id)
                .execute(&mut **tx)
                .await?
                .rows_affected();
                if n == 0 {
                    return Err(AppError::not_found("schedule_item"));
                }
            }
            SubOp::PatchSchedule { id, fields } => {
                if fields.get("start_min").is_some() {
                    sqlx::query("UPDATE schedules SET start_min = ? WHERE id = ? AND user_id = ?")
                        .bind(fields.get("start_min").unwrap().as_i64())
                        .bind(*id)
                        .bind(user_id)
                        .execute(&mut **tx)
                        .await?;
                }
                if fields.get("end_min").is_some() {
                    sqlx::query("UPDATE schedules SET end_min = ? WHERE id = ? AND user_id = ?")
                        .bind(fields.get("end_min").unwrap().as_i64())
                        .bind(*id)
                        .bind(user_id)
                        .execute(&mut **tx)
                        .await?;
                }
            }
            SubOp::InsertDailySchedule { date, schedule_id } => {
                let d = time::Date::parse(
                    date,
                    time::macros::format_description!("[year]-[month]-[day]"),
                )
                .map_err(|_| AppError::bad_request("bad date"))?;
                sqlx::query(
                    "INSERT OR REPLACE INTO daily_schedules
                     (user_id, date, schedule_id) VALUES (?, ?, ?)",
                )
                .bind(user_id)
                .bind(d)
                .bind(*schedule_id)
                .execute(&mut **tx)
                .await?;
            }
            SubOp::DeleteDailySchedule { date } => {
                let d = time::Date::parse(
                    date,
                    time::macros::format_description!("[year]-[month]-[day]"),
                )
                .map_err(|_| AppError::bad_request("bad date"))?;
                sqlx::query("DELETE FROM daily_schedules WHERE user_id = ? AND date = ?")
                    .bind(user_id)
                    .bind(d)
                    .execute(&mut **tx)
                    .await?;
            }
            SubOp::InsertSchedule { row } => {
                // Re-insert with original id/user_id so bindings and items reattach; missing fields fall back to create-time defaults.
                let id = row.get("id").and_then(|v| v.as_i64());
                let name = row
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Untitled schedule");
                let start_min = row
                    .get("start_min")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(crate::models::schedule::DEFAULT_START_MIN);
                let end_min = row
                    .get("end_min")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(crate::models::schedule::DEFAULT_END_MIN);
                sqlx::query(
                    "INSERT INTO schedules (id, user_id, name, start_min, end_min)
                     VALUES (?, ?, ?, ?, ?)",
                )
                .bind(id)
                .bind(user_id)
                .bind(name)
                .bind(start_min)
                .bind(end_min)
                .execute(&mut **tx)
                .await?;
            }
            SubOp::DeleteSchedule { id } => {
                let n = sqlx::query("DELETE FROM schedules WHERE id = ? AND user_id = ?")
                    .bind(*id)
                    .bind(user_id)
                    .execute(&mut **tx)
                    .await?
                    .rows_affected();
                if n == 0 {
                    return Err(AppError::not_found("schedule"));
                }
            }
            SubOp::InsertTemplate { schedule_id } => {
                // INSERT OR IGNORE so re-asserting an existing template binding is a no-op.
                sqlx::query(
                    "INSERT OR IGNORE INTO schedule_templates
                       (user_id, schedule_id) VALUES (?, ?)",
                )
                .bind(user_id)
                .bind(*schedule_id)
                .execute(&mut **tx)
                .await?;
            }
            SubOp::DeleteTemplate { schedule_id } => {
                sqlx::query(
                    "DELETE FROM schedule_templates
                       WHERE user_id = ? AND schedule_id = ?",
                )
                .bind(user_id)
                .bind(*schedule_id)
                .execute(&mut **tx)
                .await?;
            }
            SubOp::InsertProject { row } => {
                // Re-insert with original id/created_at so referencing rows reattach on undo; missing fields fall back to defaults.
                let archived_at: Option<time::OffsetDateTime> = match row.get("archived_at") {
                    Some(v) if v.is_null() => None,
                    Some(v) => v.as_str().map(parse_dt).transpose()?,
                    None => None,
                };
                let created_at: Option<time::OffsetDateTime> = match row.get("created_at") {
                    Some(v) if v.is_null() => None,
                    Some(v) => v.as_str().map(parse_dt).transpose()?,
                    None => None,
                };
                let color = row
                    .get("color")
                    .and_then(|v| v.as_str())
                    .unwrap_or("orange");
                let name = row
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Untitled project");
                let value = row.get("value").and_then(|v| v.as_f64()).unwrap_or(1.0);
                let time_cost = row.get("time_cost").and_then(|v| v.as_f64()).unwrap_or(1.0);
                let id = row.get("id").and_then(|v| v.as_i64());
                // Omit created_at when None so the column DEFAULT fires for snapshots that lack it.
                if let Some(ca) = created_at {
                    sqlx::query(
                        "INSERT INTO projects (id, user_id, name, value, time_cost, color,
                                               archived_at, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    )
                    .bind(id)
                    .bind(user_id)
                    .bind(name)
                    .bind(value)
                    .bind(time_cost)
                    .bind(color)
                    .bind(archived_at)
                    .bind(ca)
                    .execute(&mut **tx)
                    .await?;
                } else {
                    sqlx::query(
                        "INSERT INTO projects (id, user_id, name, value, time_cost, color,
                                               archived_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?)",
                    )
                    .bind(id)
                    .bind(user_id)
                    .bind(name)
                    .bind(value)
                    .bind(time_cost)
                    .bind(color)
                    .bind(archived_at)
                    .execute(&mut **tx)
                    .await?;
                }
            }
            SubOp::PatchProject { id, fields } => {
                if let Some(v) = fields.get("name") {
                    sqlx::query("UPDATE projects SET name = ? WHERE id = ? AND user_id = ?")
                        .bind(v.as_str().unwrap_or(""))
                        .bind(*id)
                        .bind(user_id)
                        .execute(&mut **tx)
                        .await?;
                }
                if let Some(v) = fields.get("value") {
                    sqlx::query("UPDATE projects SET value = ? WHERE id = ? AND user_id = ?")
                        .bind(v.as_f64().unwrap_or(0.0))
                        .bind(*id)
                        .bind(user_id)
                        .execute(&mut **tx)
                        .await?;
                }
                if let Some(v) = fields.get("time_cost") {
                    sqlx::query("UPDATE projects SET time_cost = ? WHERE id = ? AND user_id = ?")
                        .bind(v.as_f64().unwrap_or(1.0))
                        .bind(*id)
                        .bind(user_id)
                        .execute(&mut **tx)
                        .await?;
                }
                if let Some(v) = fields.get("color") {
                    sqlx::query("UPDATE projects SET color = ? WHERE id = ? AND user_id = ?")
                        .bind(v.as_str().unwrap_or("orange"))
                        .bind(*id)
                        .bind(user_id)
                        .execute(&mut **tx)
                        .await?;
                }
                if fields.get("archived_at").is_some() {
                    // Explicit null clears archived_at; an RFC3339 string sets it; a missing key leaves it unchanged.
                    let v = fields.get("archived_at").unwrap();
                    if v.is_null() {
                        sqlx::query(
                            "UPDATE projects SET archived_at = NULL
                                WHERE id = ? AND user_id = ?",
                        )
                        .bind(*id)
                        .bind(user_id)
                        .execute(&mut **tx)
                        .await?;
                    } else if let Some(s) = v.as_str() {
                        let dt = parse_dt(s)?;
                        sqlx::query(
                            "UPDATE projects SET archived_at = ?
                                WHERE id = ? AND user_id = ?",
                        )
                        .bind(dt)
                        .bind(*id)
                        .bind(user_id)
                        .execute(&mut **tx)
                        .await?;
                    }
                }
            }
            SubOp::DeleteProject { id } => {
                let n = sqlx::query("DELETE FROM projects WHERE id = ? AND user_id = ?")
                    .bind(*id)
                    .bind(user_id)
                    .execute(&mut **tx)
                    .await?
                    .rows_affected();
                if n == 0 {
                    return Err(AppError::not_found("project"));
                }
            }
            SubOp::InsertTask { row } => {
                let completed_at: Option<time::OffsetDateTime> = match row.get("completed_at") {
                    Some(v) if v.is_null() => None,
                    Some(v) => v.as_str().map(parse_dt).transpose()?,
                    None => None,
                };
                let created_at: Option<time::OffsetDateTime> = match row.get("created_at") {
                    Some(v) if v.is_null() => None,
                    Some(v) => v.as_str().map(parse_dt).transpose()?,
                    None => None,
                };
                let id = row.get("id").and_then(|v| v.as_i64());
                let project_id = row.get("project_id").and_then(|v| v.as_i64());
                let name = row
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("New task");
                let description = row.get("description").and_then(|v| v.as_str());
                let list_order = row
                    .get("list_order")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(1.0);
                if let Some(ca) = created_at {
                    sqlx::query(
                        "INSERT INTO tasks (id, project_id, name, description,
                                            list_order, completed_at, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?)",
                    )
                    .bind(id)
                    .bind(project_id)
                    .bind(name)
                    .bind(description)
                    .bind(list_order)
                    .bind(completed_at)
                    .bind(ca)
                    .execute(&mut **tx)
                    .await?;
                } else {
                    sqlx::query(
                        "INSERT INTO tasks (id, project_id, name, description,
                                            list_order, completed_at)
                         VALUES (?, ?, ?, ?, ?, ?)",
                    )
                    .bind(id)
                    .bind(project_id)
                    .bind(name)
                    .bind(description)
                    .bind(list_order)
                    .bind(completed_at)
                    .execute(&mut **tx)
                    .await?;
                }
            }
            SubOp::PatchTask { id, fields } => {
                if let Some(v) = fields.get("name") {
                    sqlx::query(
                        "UPDATE tasks SET name = ? WHERE id = ? AND project_id IN
                            (SELECT id FROM projects WHERE user_id = ?)",
                    )
                    .bind(v.as_str().unwrap_or(""))
                    .bind(*id)
                    .bind(user_id)
                    .execute(&mut **tx)
                    .await?;
                }
                if fields.get("description").is_some() {
                    // Explicit null clears, string sets, missing = unchanged.
                    let v = fields.get("description").unwrap();
                    sqlx::query(
                        "UPDATE tasks SET description = ? WHERE id = ? AND project_id IN
                            (SELECT id FROM projects WHERE user_id = ?)",
                    )
                    .bind(v.as_str())
                    .bind(*id)
                    .bind(user_id)
                    .execute(&mut **tx)
                    .await?;
                }
                if let Some(v) = fields.get("list_order") {
                    sqlx::query(
                        "UPDATE tasks SET list_order = ? WHERE id = ? AND project_id IN
                            (SELECT id FROM projects WHERE user_id = ?)",
                    )
                    .bind(v.as_f64().unwrap_or(1.0))
                    .bind(*id)
                    .bind(user_id)
                    .execute(&mut **tx)
                    .await?;
                }
                if fields.get("completed_at").is_some() {
                    let v = fields.get("completed_at").unwrap();
                    if v.is_null() {
                        sqlx::query(
                            "UPDATE tasks SET completed_at = NULL WHERE id = ? AND project_id IN
                                (SELECT id FROM projects WHERE user_id = ?)",
                        )
                        .bind(*id)
                        .bind(user_id)
                        .execute(&mut **tx)
                        .await?;
                    } else if let Some(s) = v.as_str() {
                        let dt = parse_dt(s)?;
                        sqlx::query(
                            "UPDATE tasks SET completed_at = ? WHERE id = ? AND project_id IN
                                (SELECT id FROM projects WHERE user_id = ?)",
                        )
                        .bind(dt)
                        .bind(*id)
                        .bind(user_id)
                        .execute(&mut **tx)
                        .await?;
                    }
                }
            }
            SubOp::DeleteTask { id } => {
                let n = sqlx::query(
                    "DELETE FROM tasks WHERE id = ? AND project_id IN
                        (SELECT id FROM projects WHERE user_id = ?)",
                )
                .bind(*id)
                .bind(user_id)
                .execute(&mut **tx)
                .await?
                .rows_affected();
                if n == 0 {
                    return Err(AppError::not_found("task"));
                }
            }
            SubOp::InsertTaskDep {
                blocked_id,
                blocker_id,
            } => {
                // INSERT OR IGNORE so re-asserting an already-present edge is a no-op, not an error.
                sqlx::query(
                    "INSERT OR IGNORE INTO task_dependencies (blocked_id, blocker_id)
                     VALUES (?, ?)",
                )
                .bind(*blocked_id)
                .bind(*blocker_id)
                .execute(&mut **tx)
                .await?;
            }
            SubOp::DeleteTaskDep {
                blocked_id,
                blocker_id,
            } => {
                sqlx::query(
                    "DELETE FROM task_dependencies WHERE blocked_id = ? AND blocker_id = ?",
                )
                .bind(*blocked_id)
                .bind(*blocker_id)
                .execute(&mut **tx)
                .await?;
            }
        }
    }
    Ok(())
}

/// Record a history entry: clear the matching context's redo half and prune globally to the per-user cap.
pub async fn record_history(
    tx: &mut Transaction<'_, Sqlite>,
    user_id: i64,
    context: &str,
    op_kind: &str,
    forward: &[SubOp],
    backward: &[SubOp],
) -> AppResult<()> {
    // Per-context redo clear: each tab walks its own context, so one tab's edit can't invalidate another's redo.
    sqlx::query("DELETE FROM history WHERE user_id = ? AND context = ? AND undone = 1")
        .bind(user_id)
        .bind(context)
        .execute(&mut **tx)
        .await?;
    let fwd = serde_json::to_string(forward).map_err(|e| AppError::internal(e.to_string()))?;
    let bwd = serde_json::to_string(backward).map_err(|e| AppError::internal(e.to_string()))?;
    sqlx::query(
        "INSERT INTO history (user_id, context, op, forward, backward, undone)
         VALUES (?, ?, ?, ?, ?, 0)",
    )
    .bind(user_id)
    .bind(context)
    .bind(op_kind)
    .bind(fwd)
    .bind(bwd)
    .execute(&mut **tx)
    .await?;
    // Prune oldest beyond the cap: the cap is a single global ring across all contexts.
    sqlx::query(
        "DELETE FROM history WHERE id IN (
            SELECT id FROM history WHERE user_id = ?
            ORDER BY id ASC LIMIT MAX(0, (SELECT COUNT(*) FROM history WHERE user_id = ?) - ?)
         )",
    )
    .bind(user_id)
    .bind(user_id)
    .bind(HISTORY_CAP)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Round-trip tests for project-context SubOps: mutate, undo, redo through `record_history`/`apply_ops`, asserting schema state at each step.
    use super::*;
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

    async fn count(pool: &SqlitePool, sql: &'static str, user_id: i64) -> i64 {
        let row: (i64,) = sqlx::query_as(sql)
            .bind(user_id)
            .fetch_one(pool)
            .await
            .expect("count");
        row.0
    }

    async fn count2(pool: &SqlitePool, sql: &'static str, a: i64, b: i64) -> i64 {
        let row: (i64,) = sqlx::query_as(sql)
            .bind(a)
            .bind(b)
            .fetch_one(pool)
            .await
            .expect("count2");
        row.0
    }

    async fn name_of_project(pool: &SqlitePool, id: i64) -> Option<String> {
        sqlx::query_as::<_, (String,)>("SELECT name FROM projects WHERE id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await
            .expect("select")
            .map(|(n,)| n)
    }

    #[tokio::test]
    async fn create_project_undo_redo_round_trip() {
        let pool = setup_pool().await;
        let user_id = seed_user(&pool).await;

        // INSERT directly, mirroring `routes::projects::create_project`, then record history like the handler.
        let mut tx = pool.begin().await.unwrap();
        let (pid,): (i64,) = sqlx::query_as(
            "INSERT INTO projects (user_id, name, value, time_cost, color)
             VALUES (?, 'P1', 1.0, 1.0, 'orange') RETURNING id",
        )
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        let snap = snapshot_project(&mut tx, user_id, pid)
            .await
            .unwrap()
            .unwrap();
        record_history(
            &mut tx,
            user_id,
            CTX_PROJECT,
            "create_project",
            &[SubOp::InsertProject { row: snap }],
            &[SubOp::DeleteProject { id: pid }],
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            count(
                &pool,
                "SELECT COUNT(*) FROM projects WHERE user_id = ?",
                user_id
            )
            .await,
            1
        );

        // Undo: project disappears.
        let mut tx = pool.begin().await.unwrap();
        let (backward,): (String,) = sqlx::query_as(
            "SELECT backward FROM history WHERE user_id = ? AND context = ? ORDER BY id DESC LIMIT 1",
        )
        .bind(user_id)
        .bind(CTX_PROJECT)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        let ops: Vec<SubOp> = serde_json::from_str(&backward).unwrap();
        apply_ops(&mut tx, user_id, &ops).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            count(
                &pool,
                "SELECT COUNT(*) FROM projects WHERE user_id = ?",
                user_id
            )
            .await,
            0
        );

        // Redo: project comes back with the original id.
        let mut tx = pool.begin().await.unwrap();
        let (forward,): (String,) = sqlx::query_as(
            "SELECT forward FROM history WHERE user_id = ? AND context = ? ORDER BY id DESC LIMIT 1",
        )
        .bind(user_id)
        .bind(CTX_PROJECT)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        let ops: Vec<SubOp> = serde_json::from_str(&forward).unwrap();
        apply_ops(&mut tx, user_id, &ops).await.unwrap();
        tx.commit().await.unwrap();
        let (back_id,): (i64,) = sqlx::query_as("SELECT id FROM projects WHERE user_id = ?")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(back_id, pid, "redo restores the original id");
    }

    #[tokio::test]
    async fn patch_project_undo_redo_round_trip() {
        let pool = setup_pool().await;
        let user_id = seed_user(&pool).await;
        let (pid,): (i64,) = sqlx::query_as(
            "INSERT INTO projects (user_id, name, value, time_cost, color)
             VALUES (?, 'before', 1.0, 1.0, 'orange') RETURNING id",
        )
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .unwrap();

        let mut tx = pool.begin().await.unwrap();
        sqlx::query("UPDATE projects SET name = 'after', color = 'blue' WHERE id = ?")
            .bind(pid)
            .execute(&mut *tx)
            .await
            .unwrap();
        record_history(
            &mut tx,
            user_id,
            CTX_PROJECT,
            "patch_project",
            &[SubOp::PatchProject {
                id: pid,
                fields: serde_json::json!({ "name": "after", "color": "blue" }),
            }],
            &[SubOp::PatchProject {
                id: pid,
                fields: serde_json::json!({ "name": "before", "color": "orange" }),
            }],
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(name_of_project(&pool, pid).await.unwrap(), "after");

        let mut tx = pool.begin().await.unwrap();
        apply_ops(
            &mut tx,
            user_id,
            &[SubOp::PatchProject {
                id: pid,
                fields: serde_json::json!({ "name": "before", "color": "orange" }),
            }],
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(name_of_project(&pool, pid).await.unwrap(), "before");

        let mut tx = pool.begin().await.unwrap();
        apply_ops(
            &mut tx,
            user_id,
            &[SubOp::PatchProject {
                id: pid,
                fields: serde_json::json!({ "name": "after", "color": "blue" }),
            }],
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(name_of_project(&pool, pid).await.unwrap(), "after");
    }

    #[tokio::test]
    async fn patch_schedule_bounds_undo_redo_round_trip() {
        // Mirrors routes::schedules::patch_schedule: move the bounds, record history, then undo/redo the start/end.
        let pool = setup_pool().await;
        let user_id = seed_user(&pool).await;
        let sid = seed_schedule(&pool, user_id, "S").await; // seeded at 480..1320

        let mut tx = pool.begin().await.unwrap();
        sqlx::query("UPDATE schedules SET start_min = 540, end_min = 1200 WHERE id = ?")
            .bind(sid)
            .execute(&mut *tx)
            .await
            .unwrap();
        record_history(
            &mut tx,
            user_id,
            CTX_SCHEDULE,
            "patch_schedule",
            &[SubOp::PatchSchedule {
                id: sid,
                fields: serde_json::json!({ "start_min": 540, "end_min": 1200 }),
            }],
            &[SubOp::PatchSchedule {
                id: sid,
                fields: serde_json::json!({ "start_min": 480, "end_min": 1320 }),
            }],
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();

        async fn bounds(pool: &SqlitePool, id: i64) -> (i64, i64) {
            sqlx::query_as::<_, (i64, i64)>("SELECT start_min, end_min FROM schedules WHERE id = ?")
                .bind(id)
                .fetch_one(pool)
                .await
                .unwrap()
        }
        assert_eq!(bounds(&pool, sid).await, (540, 1200));

        // Undo restores the original window.
        let (backward,): (String,) = sqlx::query_as(
            "SELECT backward FROM history WHERE user_id = ? AND context = ? ORDER BY id DESC LIMIT 1",
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
        assert_eq!(bounds(&pool, sid).await, (480, 1320));

        // Redo re-applies the new window.
        let (forward,): (String,) = sqlx::query_as(
            "SELECT forward FROM history WHERE user_id = ? AND context = ? ORDER BY id DESC LIMIT 1",
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
        assert_eq!(bounds(&pool, sid).await, (540, 1200));
    }

    #[tokio::test]
    async fn delete_project_with_cascade_round_trip() {
        let pool = setup_pool().await;
        let user_id = seed_user(&pool).await;
        let (pid,): (i64,) = sqlx::query_as(
            "INSERT INTO projects (user_id, name, value, time_cost, color)
             VALUES (?, 'P', 1.0, 1.0, 'orange') RETURNING id",
        )
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        let (t1,): (i64,) = sqlx::query_as(
            "INSERT INTO tasks (project_id, name, list_order) VALUES (?, 't1', 1.0) RETURNING id",
        )
        .bind(pid)
        .fetch_one(&pool)
        .await
        .unwrap();
        let (t2,): (i64,) = sqlx::query_as(
            "INSERT INTO tasks (project_id, name, list_order) VALUES (?, 't2', 2.0) RETURNING id",
        )
        .bind(pid)
        .fetch_one(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO task_dependencies (blocked_id, blocker_id) VALUES (?, ?)")
            .bind(t1)
            .bind(t2)
            .execute(&pool)
            .await
            .unwrap();

        // Snapshot the subtree before the cascade fires, like `routes::projects::delete_project`.
        let mut tx = pool.begin().await.unwrap();
        let project_snap = snapshot_project(&mut tx, user_id, pid)
            .await
            .unwrap()
            .unwrap();
        let task_ids = task_ids_for_project(&mut tx, user_id, pid).await.unwrap();
        let mut task_snaps: Vec<serde_json::Value> = Vec::new();
        for tid in &task_ids {
            task_snaps.push(
                snapshot_task(&mut tx, user_id, *tid)
                    .await
                    .unwrap()
                    .unwrap(),
            );
        }
        let deps = task_dependencies_for(&mut tx, &task_ids).await.unwrap();
        sqlx::query("DELETE FROM projects WHERE id = ?")
            .bind(pid)
            .execute(&mut *tx)
            .await
            .unwrap();
        let mut backward: Vec<SubOp> = Vec::new();
        backward.push(SubOp::InsertProject { row: project_snap });
        for s in task_snaps {
            backward.push(SubOp::InsertTask { row: s });
        }
        for (b, br) in deps {
            backward.push(SubOp::InsertTaskDep {
                blocked_id: b,
                blocker_id: br,
            });
        }
        record_history(
            &mut tx,
            user_id,
            CTX_PROJECT,
            "delete_project",
            &[SubOp::DeleteProject { id: pid }],
            &backward,
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            count(
                &pool,
                "SELECT COUNT(*) FROM projects WHERE user_id = ?",
                user_id
            )
            .await,
            0
        );
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.user_id = ?", user_id).await, 0);

        // Undo restores project, both tasks, and the dep edge.
        let mut tx = pool.begin().await.unwrap();
        apply_ops(&mut tx, user_id, &backward).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            count2(
                &pool,
                "SELECT COUNT(*) FROM projects WHERE user_id = ? AND id = ?",
                user_id,
                pid,
            )
            .await,
            1
        );
        let n_tasks: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM tasks WHERE project_id = ?")
            .bind(pid)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n_tasks.0, 2);
        let n_deps: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM task_dependencies WHERE blocked_id = ? AND blocker_id = ?",
        )
        .bind(t1)
        .bind(t2)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(n_deps.0, 1, "dep edge restored");

        // Redo re-fires the cascade.
        let mut tx = pool.begin().await.unwrap();
        apply_ops(&mut tx, user_id, &[SubOp::DeleteProject { id: pid }])
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            count(
                &pool,
                "SELECT COUNT(*) FROM projects WHERE user_id = ?",
                user_id
            )
            .await,
            0
        );
    }

    /// Bulk-delete completed tasks in one composite entry; a single undo restores them and the referencing dependency edge.
    #[tokio::test]
    async fn delete_completed_tasks_bulk_undo_round_trip() {
        let pool = setup_pool().await;
        let user_id = seed_user(&pool).await;
        let (pid,): (i64,) = sqlx::query_as(
            "INSERT INTO projects (user_id, name, value, time_cost, color)
             VALUES (?, 'P', 1.0, 1.0, 'orange') RETURNING id",
        )
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        // Two completed tasks (c1, c2) + one incomplete (open).
        let now = "2026-01-02T03:04:05Z";
        let (c1,): (i64,) = sqlx::query_as(
            "INSERT INTO tasks (project_id, name, list_order, completed_at)
             VALUES (?, 'c1', 1.0, ?) RETURNING id",
        )
        .bind(pid)
        .bind(now)
        .fetch_one(&pool)
        .await
        .unwrap();
        let (c2,): (i64,) = sqlx::query_as(
            "INSERT INTO tasks (project_id, name, list_order, completed_at)
             VALUES (?, 'c2', 2.0, ?) RETURNING id",
        )
        .bind(pid)
        .bind(now)
        .fetch_one(&pool)
        .await
        .unwrap();
        let (open,): (i64,) = sqlx::query_as(
            "INSERT INTO tasks (project_id, name, list_order) VALUES (?, 'open', 3.0) RETURNING id",
        )
        .bind(pid)
        .fetch_one(&pool)
        .await
        .unwrap();
        // open is blocked by c1 (a completed task blocking an incomplete one).
        sqlx::query("INSERT INTO task_dependencies (blocked_id, blocker_id) VALUES (?, ?)")
            .bind(open)
            .bind(c1)
            .execute(&pool)
            .await
            .unwrap();

        // Build the composite op exactly as the handler does.
        let mut tx = pool.begin().await.unwrap();
        let completed_ids = vec![c1, c2];
        let mut task_snaps: Vec<serde_json::Value> = Vec::new();
        for tid in &completed_ids {
            task_snaps.push(
                snapshot_task(&mut tx, user_id, *tid)
                    .await
                    .unwrap()
                    .unwrap(),
            );
        }
        let deps = task_dependencies_for(&mut tx, &completed_ids)
            .await
            .unwrap();
        for tid in &completed_ids {
            sqlx::query("DELETE FROM tasks WHERE id = ?")
                .bind(*tid)
                .execute(&mut *tx)
                .await
                .unwrap();
        }
        let forward: Vec<SubOp> = completed_ids
            .iter()
            .map(|id| SubOp::DeleteTask { id: *id })
            .collect();
        let mut backward: Vec<SubOp> = Vec::new();
        for s in task_snaps {
            backward.push(SubOp::InsertTask { row: s });
        }
        for (b, br) in deps {
            backward.push(SubOp::InsertTaskDep {
                blocked_id: b,
                blocker_id: br,
            });
        }
        record_history(
            &mut tx,
            user_id,
            CTX_PROJECT,
            "delete_completed_tasks",
            &forward,
            &backward,
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();

        // Only the incomplete task remains; the dep edge cascaded away.
        let n_tasks: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM tasks WHERE project_id = ?")
            .bind(pid)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n_tasks.0, 1, "only the incomplete task survives");
        let n_deps: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM task_dependencies WHERE blocked_id = ?")
                .bind(open)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            n_deps.0, 0,
            "edge to a deleted completed task cascaded away"
        );

        // A SINGLE undo restores both completed tasks and the edge.
        let mut tx = pool.begin().await.unwrap();
        let (backward_json,): (String,) = sqlx::query_as(
            "SELECT backward FROM history WHERE user_id = ? AND context = ? ORDER BY id DESC LIMIT 1",
        )
        .bind(user_id)
        .bind(CTX_PROJECT)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        let ops: Vec<SubOp> = serde_json::from_str(&backward_json).unwrap();
        apply_ops(&mut tx, user_id, &ops).await.unwrap();
        tx.commit().await.unwrap();
        let n_tasks: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM tasks WHERE project_id = ?")
            .bind(pid)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n_tasks.0, 3, "undo restores all completed tasks");
        let n_deps: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM task_dependencies WHERE blocked_id = ? AND blocker_id = ?",
        )
        .bind(open)
        .bind(c1)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(n_deps.0, 1, "undo restores the dependency edge");
    }

    #[tokio::test]
    async fn task_insert_patch_delete_round_trip() {
        let pool = setup_pool().await;
        let user_id = seed_user(&pool).await;
        let (pid,): (i64,) = sqlx::query_as(
            "INSERT INTO projects (user_id, name, value, time_cost, color)
             VALUES (?, 'P', 1.0, 1.0, 'orange') RETURNING id",
        )
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        let (tid,): (i64,) = sqlx::query_as(
            "INSERT INTO tasks (project_id, name, list_order) VALUES (?, 'orig', 1.0) RETURNING id",
        )
        .bind(pid)
        .fetch_one(&pool)
        .await
        .unwrap();

        let mut tx = pool.begin().await.unwrap();
        let now_str = "2026-01-02T03:04:05Z";
        apply_ops(
            &mut tx,
            user_id,
            &[SubOp::PatchTask {
                id: tid,
                fields: serde_json::json!({ "name": "renamed", "completed_at": now_str }),
            }],
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        let (name, completed): (String, Option<time::OffsetDateTime>) =
            sqlx::query_as("SELECT name, completed_at FROM tasks WHERE id = ?")
                .bind(tid)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(name, "renamed");
        assert!(completed.is_some());

        let mut tx = pool.begin().await.unwrap();
        apply_ops(
            &mut tx,
            user_id,
            &[SubOp::PatchTask {
                id: tid,
                fields: serde_json::json!({ "name": "orig", "completed_at": null }),
            }],
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        let (name, completed): (String, Option<time::OffsetDateTime>) =
            sqlx::query_as("SELECT name, completed_at FROM tasks WHERE id = ?")
                .bind(tid)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(name, "orig");
        assert!(completed.is_none());

        // Delete + InsertTask round trip preserves id.
        let mut tx = pool.begin().await.unwrap();
        let snap = snapshot_task(&mut tx, user_id, tid).await.unwrap().unwrap();
        apply_ops(&mut tx, user_id, &[SubOp::DeleteTask { id: tid }])
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            count2(
                &pool,
                "SELECT COUNT(*) FROM tasks WHERE id = ?
                  AND project_id IN (SELECT id FROM projects WHERE user_id = ?)",
                tid,
                user_id,
            )
            .await,
            0
        );

        let mut tx = pool.begin().await.unwrap();
        apply_ops(&mut tx, user_id, &[SubOp::InsertTask { row: snap }])
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let (back_id,): (i64,) = sqlx::query_as("SELECT id FROM tasks WHERE project_id = ?")
            .bind(pid)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(back_id, tid);
    }

    #[tokio::test]
    async fn contexts_are_independent_stacks() {
        // A new entry clears its own context's redo stack but leaves the other context's intact.
        let pool = setup_pool().await;
        let user_id = seed_user(&pool).await;

        // One schedule entry; the body content is irrelevant to the test.
        let mut tx = pool.begin().await.unwrap();
        record_history(&mut tx, user_id, CTX_SCHEDULE, "noop_schedule", &[], &[])
            .await
            .unwrap();
        // Mark it undone (simulate the user pressed undo).
        sqlx::query("UPDATE history SET undone = 1 WHERE user_id = ? AND context = ?")
            .bind(user_id)
            .bind(CTX_SCHEDULE)
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();

        // Record a project entry; its `record_history` must clear only project-context undone rows.
        let mut tx = pool.begin().await.unwrap();
        record_history(&mut tx, user_id, CTX_PROJECT, "noop_project", &[], &[])
            .await
            .unwrap();
        tx.commit().await.unwrap();

        let schedule_redo: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM history WHERE user_id = ? AND context = ? AND undone = 1",
        )
        .bind(user_id)
        .bind(CTX_SCHEDULE)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            schedule_redo.0, 1,
            "project record_history must not clear schedule redo"
        );
        let project_rows: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM history WHERE user_id = ? AND context = ?")
                .bind(user_id)
                .bind(CTX_PROJECT)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(project_rows.0, 1);
    }

    // Schedule-context create/delete round-trips: creation and deletion are atomic entries owning the schedule and its binding.

    async fn seed_schedule(pool: &SqlitePool, user_id: i64, name: &str) -> i64 {
        let (sid,): (i64,) = sqlx::query_as(
            "INSERT INTO schedules (user_id, name, start_min, end_min)
             VALUES (?, ?, 480, 1320) RETURNING id",
        )
        .bind(user_id)
        .bind(name)
        .fetch_one(pool)
        .await
        .expect("seed schedule");
        sid
    }

    async fn seed_item(pool: &SqlitePool, schedule_id: i64, position: f64, label: &str) -> i64 {
        let (iid,): (i64,) = sqlx::query_as(
            "INSERT INTO schedule_items
               (schedule_id, position, duration_target, use_inline, inline_label, color)
             VALUES (?, ?, 30, 1, ?, 'blue') RETURNING id",
        )
        .bind(schedule_id)
        .bind(position)
        .bind(label)
        .fetch_one(pool)
        .await
        .expect("seed item");
        iid
    }

    #[tokio::test]
    async fn create_template_schedule_round_trip() {
        // One history entry inserts the schedule and its template binding; undo nukes both, redo restores both.
        let pool = setup_pool().await;
        let user_id = seed_user(&pool).await;

        let mut tx = pool.begin().await.unwrap();
        let (sid,): (i64,) = sqlx::query_as(
            "INSERT INTO schedules (user_id, name, start_min, end_min)
             VALUES (?, 'New schedule template', 480, 1320) RETURNING id",
        )
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        sqlx::query("INSERT INTO schedule_templates (user_id, schedule_id) VALUES (?, ?)")
            .bind(user_id)
            .bind(sid)
            .execute(&mut *tx)
            .await
            .unwrap();
        let snap = snapshot_schedule(&mut tx, user_id, sid)
            .await
            .unwrap()
            .unwrap();
        record_history(
            &mut tx,
            user_id,
            CTX_SCHEDULE,
            "create_template",
            &[
                SubOp::InsertSchedule { row: snap.clone() },
                SubOp::InsertTemplate { schedule_id: sid },
            ],
            &[
                SubOp::DeleteTemplate { schedule_id: sid },
                SubOp::DeleteSchedule { id: sid },
            ],
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            count(
                &pool,
                "SELECT COUNT(*) FROM schedules WHERE user_id = ?",
                user_id
            )
            .await,
            1
        );
        assert_eq!(
            count(
                &pool,
                "SELECT COUNT(*) FROM schedule_templates WHERE user_id = ?",
                user_id,
            )
            .await,
            1
        );

        let (backward,): (String,) = sqlx::query_as(
            "SELECT backward FROM history WHERE user_id = ? AND context = ?
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
        assert_eq!(
            count(
                &pool,
                "SELECT COUNT(*) FROM schedules WHERE user_id = ?",
                user_id
            )
            .await,
            0
        );
        assert_eq!(
            count(
                &pool,
                "SELECT COUNT(*) FROM schedule_templates WHERE user_id = ?",
                user_id,
            )
            .await,
            0
        );

        // Redo via the recorded forward ops; id is preserved.
        let (forward,): (String,) = sqlx::query_as(
            "SELECT forward FROM history WHERE user_id = ? AND context = ?
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
        let (back_id,): (i64,) = sqlx::query_as("SELECT id FROM schedules WHERE user_id = ?")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(back_id, sid, "redo restored the original schedule id");
        let (template_sid,): (i64,) =
            sqlx::query_as("SELECT schedule_id FROM schedule_templates WHERE user_id = ?")
                .bind(user_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            template_sid, sid,
            "template binding points at the restored schedule"
        );
    }

    #[tokio::test]
    async fn fork_template_into_daily_round_trip() {
        // Clone a template's items into a daily schedule plus date binding in one entry; undo keeps original item ids.
        let pool = setup_pool().await;
        let user_id = seed_user(&pool).await;

        let template_id = seed_schedule(&pool, user_id, "Monday template").await;
        let template_item_a = seed_item(&pool, template_id, 1.0, "A").await;
        let template_item_b = seed_item(&pool, template_id, 2.0, "B").await;

        let mut tx = pool.begin().await.unwrap();
        let (oid,): (i64,) = sqlx::query_as(
            "INSERT INTO schedules (user_id, name, start_min, end_min)
             VALUES (?, 'Monday template', 480, 1320) RETURNING id",
        )
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        let (clone_a,): (i64,) = sqlx::query_as(
            "INSERT INTO schedule_items
               (schedule_id, position, duration_target, use_inline, inline_label, color)
             VALUES (?, 1.0, 30, 1, 'A', 'blue') RETURNING id",
        )
        .bind(oid)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        let (clone_b,): (i64,) = sqlx::query_as(
            "INSERT INTO schedule_items
               (schedule_id, position, duration_target, use_inline, inline_label, color)
             VALUES (?, 2.0, 30, 1, 'B', 'blue') RETURNING id",
        )
        .bind(oid)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO daily_schedules (user_id, date, schedule_id)
             VALUES (?, '2026-05-25', ?)",
        )
        .bind(user_id)
        .bind(oid)
        .execute(&mut *tx)
        .await
        .unwrap();

        // Snapshot in forward-replay order (schedule, items, daily binding); the backward path mirrors it.
        let schedule_snap = snapshot_schedule(&mut tx, user_id, oid)
            .await
            .unwrap()
            .unwrap();
        let snap_a = snapshot_item(&mut tx, user_id, clone_a)
            .await
            .unwrap()
            .unwrap();
        let snap_b = snapshot_item(&mut tx, user_id, clone_b)
            .await
            .unwrap()
            .unwrap();
        record_history(
            &mut tx,
            user_id,
            CTX_SCHEDULE,
            "fork_template",
            &[
                SubOp::InsertSchedule {
                    row: schedule_snap.clone(),
                },
                SubOp::InsertItem {
                    row: snap_a.clone(),
                },
                SubOp::InsertItem {
                    row: snap_b.clone(),
                },
                SubOp::InsertDailySchedule {
                    date: "2026-05-25".to_string(),
                    schedule_id: oid,
                },
            ],
            &[
                SubOp::DeleteDailySchedule {
                    date: "2026-05-25".to_string(),
                },
                SubOp::DeleteSchedule { id: oid },
            ],
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();

        // Sanity: source template still has its items, daily schedule has two clones.
        let n_template_items: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM schedule_items WHERE schedule_id = ?")
                .bind(template_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(n_template_items.0, 2, "template items unaffected by fork");
        assert!(template_item_a != clone_a && template_item_b != clone_b);

        // Undo runs DeleteDailySchedule then DeleteSchedule; the schedule cascade nukes the cloned items.
        let mut tx = pool.begin().await.unwrap();
        apply_ops(
            &mut tx,
            user_id,
            &[
                SubOp::DeleteDailySchedule {
                    date: "2026-05-25".to_string(),
                },
                SubOp::DeleteSchedule { id: oid },
            ],
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            count2(
                &pool,
                "SELECT COUNT(*) FROM schedules WHERE id = ? AND user_id = ?",
                oid,
                user_id,
            )
            .await,
            0,
            "daily schedule gone after undo",
        );
        assert_eq!(
            count(
                &pool,
                "SELECT COUNT(*) FROM daily_schedules WHERE user_id = ?",
                user_id,
            )
            .await,
            0,
            "daily binding gone after undo",
        );
        let n_template_items: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM schedule_items WHERE schedule_id = ?")
                .bind(template_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            n_template_items.0, 2,
            "template items still intact after undo"
        );

        // Redo: forward = Insert schedule, items, daily binding.
        let mut tx = pool.begin().await.unwrap();
        apply_ops(
            &mut tx,
            user_id,
            &[
                SubOp::InsertSchedule { row: schedule_snap },
                SubOp::InsertItem { row: snap_a },
                SubOp::InsertItem { row: snap_b },
                SubOp::InsertDailySchedule {
                    date: "2026-05-25".to_string(),
                    schedule_id: oid,
                },
            ],
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        let (back_id,): (i64,) =
            sqlx::query_as("SELECT id FROM schedules WHERE id = ? AND user_id = ?")
                .bind(oid)
                .bind(user_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(back_id, oid, "redo restored the daily schedule id");
        let item_ids: Vec<(i64,)> =
            sqlx::query_as("SELECT id FROM schedule_items WHERE schedule_id = ? ORDER BY id ASC")
                .bind(oid)
                .fetch_all(&pool)
                .await
                .unwrap();
        let ids: Vec<i64> = item_ids.into_iter().map(|(i,)| i).collect();
        assert!(
            ids.contains(&clone_a) && ids.contains(&clone_b),
            "redo restored the original cloned item ids: {:?}",
            ids
        );
        let (bound_sid,): (Option<i64>,) = sqlx::query_as(
            "SELECT schedule_id FROM daily_schedules
              WHERE user_id = ? AND date = '2026-05-25'",
        )
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(bound_sid, Some(oid));
    }

    #[tokio::test]
    async fn delete_daily_schedule_with_items_round_trip() {
        // Delete a daily schedule: forward removes binding + schedule (items cascade); backward restores schedule, items, binding.
        let pool = setup_pool().await;
        let user_id = seed_user(&pool).await;
        let sid = seed_schedule(&pool, user_id, "daily").await;
        let i1 = seed_item(&pool, sid, 1.0, "A").await;
        let i2 = seed_item(&pool, sid, 2.0, "B").await;
        sqlx::query(
            "INSERT INTO daily_schedules (user_id, date, schedule_id)
             VALUES (?, '2026-06-01', ?)",
        )
        .bind(user_id)
        .bind(sid)
        .execute(&pool)
        .await
        .unwrap();

        let mut tx = pool.begin().await.unwrap();
        let schedule_snap = snapshot_schedule(&mut tx, user_id, sid)
            .await
            .unwrap()
            .unwrap();
        let snap_i1 = snapshot_item(&mut tx, user_id, i1).await.unwrap().unwrap();
        let snap_i2 = snapshot_item(&mut tx, user_id, i2).await.unwrap().unwrap();

        let forward = vec![
            SubOp::DeleteDailySchedule {
                date: "2026-06-01".to_string(),
            },
            SubOp::DeleteSchedule { id: sid },
        ];
        let backward = vec![
            SubOp::InsertSchedule {
                row: schedule_snap.clone(),
            },
            SubOp::InsertItem {
                row: snap_i1.clone(),
            },
            SubOp::InsertItem {
                row: snap_i2.clone(),
            },
            SubOp::InsertDailySchedule {
                date: "2026-06-01".to_string(),
                schedule_id: sid,
            },
        ];
        apply_ops(&mut tx, user_id, &forward).await.unwrap();
        record_history(
            &mut tx,
            user_id,
            CTX_SCHEDULE,
            "delete_schedule",
            &forward,
            &backward,
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(
            count(
                &pool,
                "SELECT COUNT(*) FROM schedules WHERE user_id = ?",
                user_id
            )
            .await,
            0,
            "schedule removed",
        );
        assert_eq!(
            count(
                &pool,
                "SELECT COUNT(*) FROM daily_schedules WHERE user_id = ?",
                user_id,
            )
            .await,
            0,
            "daily row removed",
        );

        // Undo restores everything with original ids.
        let mut tx = pool.begin().await.unwrap();
        apply_ops(&mut tx, user_id, &backward).await.unwrap();
        tx.commit().await.unwrap();
        let (back_id,): (i64,) = sqlx::query_as("SELECT id FROM schedules WHERE user_id = ?")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(back_id, sid);
        let item_ids: Vec<(i64,)> =
            sqlx::query_as("SELECT id FROM schedule_items WHERE schedule_id = ? ORDER BY id ASC")
                .bind(sid)
                .fetch_all(&pool)
                .await
                .unwrap();
        let ids: Vec<i64> = item_ids.into_iter().map(|(i,)| i).collect();
        assert!(
            ids.contains(&i1) && ids.contains(&i2),
            "items restored with original ids: {:?}",
            ids
        );
        let (bound_sid,): (Option<i64>,) = sqlx::query_as(
            "SELECT schedule_id FROM daily_schedules
              WHERE user_id = ? AND date = '2026-06-01'",
        )
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(bound_sid, Some(sid));

        // Redo wipes everything again.
        let mut tx = pool.begin().await.unwrap();
        apply_ops(&mut tx, user_id, &forward).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            count(
                &pool,
                "SELECT COUNT(*) FROM schedules WHERE user_id = ?",
                user_id
            )
            .await,
            0
        );
        assert_eq!(
            count(
                &pool,
                "SELECT COUNT(*) FROM daily_schedules WHERE user_id = ?",
                user_id,
            )
            .await,
            0
        );
    }

    #[tokio::test]
    async fn delete_template_schedule_round_trip() {
        // Like the daily-delete test, but `DeleteTemplate` wipes the template binding row.
        let pool = setup_pool().await;
        let user_id = seed_user(&pool).await;
        let sid = seed_schedule(&pool, user_id, "Standup template").await;
        let i1 = seed_item(&pool, sid, 1.0, "Standup").await;
        sqlx::query("INSERT INTO schedule_templates (user_id, schedule_id) VALUES (?, ?)")
            .bind(user_id)
            .bind(sid)
            .execute(&pool)
            .await
            .unwrap();

        let mut tx = pool.begin().await.unwrap();
        let schedule_snap = snapshot_schedule(&mut tx, user_id, sid)
            .await
            .unwrap()
            .unwrap();
        let snap_i1 = snapshot_item(&mut tx, user_id, i1).await.unwrap().unwrap();
        let forward = vec![
            SubOp::DeleteTemplate { schedule_id: sid },
            SubOp::DeleteSchedule { id: sid },
        ];
        let backward = vec![
            SubOp::InsertSchedule { row: schedule_snap },
            SubOp::InsertItem { row: snap_i1 },
            SubOp::InsertTemplate { schedule_id: sid },
        ];
        apply_ops(&mut tx, user_id, &forward).await.unwrap();
        record_history(
            &mut tx,
            user_id,
            CTX_SCHEDULE,
            "delete_schedule",
            &forward,
            &backward,
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(
            count(
                &pool,
                "SELECT COUNT(*) FROM schedules WHERE user_id = ?",
                user_id
            )
            .await,
            0
        );
        assert_eq!(
            count(
                &pool,
                "SELECT COUNT(*) FROM schedule_templates WHERE user_id = ?",
                user_id,
            )
            .await,
            0,
            "template binding gone after delete",
        );

        // Undo: schedule + item + binding all return.
        let mut tx = pool.begin().await.unwrap();
        apply_ops(&mut tx, user_id, &backward).await.unwrap();
        tx.commit().await.unwrap();
        let (back_id,): (i64,) = sqlx::query_as("SELECT id FROM schedules WHERE user_id = ?")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(back_id, sid);
        let (item_back,): (i64,) =
            sqlx::query_as("SELECT id FROM schedule_items WHERE schedule_id = ?")
                .bind(sid)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(item_back, i1);
        let (bound_sid,): (i64,) =
            sqlx::query_as("SELECT schedule_id FROM schedule_templates WHERE user_id = ?")
                .bind(user_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(bound_sid, sid);

        // Redo wipes again.
        let mut tx = pool.begin().await.unwrap();
        apply_ops(&mut tx, user_id, &forward).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            count(
                &pool,
                "SELECT COUNT(*) FROM schedules WHERE user_id = ?",
                user_id
            )
            .await,
            0
        );
    }
}
