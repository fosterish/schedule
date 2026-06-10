use sqlx::{FromRow, SqliteConnection};
use uuid::Uuid;

use super::{parse_color, parse_uuid};
use crate::error::AppResult;
use crate::types::common::{
    OrderKey, ProjectId, Revision, Revisions, ScheduleId, ScheduleItemId, TaskId, UserId,
};
use crate::types::schedule::{ItemBounds, Schedule, ScheduleBinding, ScheduleItem, Template};

#[derive(FromRow)]
struct ScheduleRow {
    id: String,
    user_id: String,
    name: String,
    start_minute: i64,
    end_minute: i64,
    updated_rev: i64,
    deleted_rev: Option<i64>,
}

impl ScheduleRow {
    fn into_type(self) -> AppResult<Schedule> {
        Ok(Schedule {
            id: ScheduleId(parse_uuid(&self.id)?),
            user_id: UserId(parse_uuid(&self.user_id)?),
            name: self.name,
            start: self.start_minute,
            end: self.end_minute,
            rev: Revisions {
                updated: self.updated_rev,
                deleted: self.deleted_rev,
            },
        })
    }
}

#[derive(FromRow)]
struct ScheduleItemRow {
    id: String,
    schedule_id: String,
    position: String,
    start_minute: Option<i64>,
    end_minute: Option<i64>,
    fixed_duration: Option<i64>,
    duration_target: i64,
    use_inline: bool,
    inline_label: Option<String>,
    inline_description: Option<String>,
    inline_color: String,
    project_id: Option<String>,
    project_rank: i64,
    task_id: Option<String>,
    task_rank: i64,
    updated_rev: i64,
    deleted_rev: Option<i64>,
}

impl ScheduleItemRow {
    fn into_type(self) -> AppResult<ScheduleItem> {
        let project_id = self.project_id.as_deref().map(parse_uuid).transpose()?;
        let task_id = self.task_id.as_deref().map(parse_uuid).transpose()?;
        Ok(ScheduleItem {
            id: ScheduleItemId(parse_uuid(&self.id)?),
            schedule_id: ScheduleId(parse_uuid(&self.schedule_id)?),
            position: OrderKey(self.position),
            bounds: ItemBounds {
                start: self.start_minute,
                end: self.end_minute,
                fixed_duration: self.fixed_duration,
                duration_target: self.duration_target,
            },
            use_inline: self.use_inline,
            inline_label: self.inline_label,
            inline_description: self.inline_description,
            inline_color: parse_color(&self.inline_color)?,
            project_id: project_id.map(ProjectId),
            project_rank: self.project_rank,
            task_id: task_id.map(TaskId),
            task_rank: self.task_rank,
            rev: Revisions {
                updated: self.updated_rev,
                deleted: self.deleted_rev,
            },
        })
    }
}

#[derive(FromRow)]
struct ScheduleBindingRow {
    user_id: String,
    date: String,
    schedule_id: String,
    updated_rev: i64,
    deleted_rev: Option<i64>,
}

impl ScheduleBindingRow {
    fn into_type(self) -> AppResult<ScheduleBinding> {
        Ok(ScheduleBinding {
            user_id: UserId(parse_uuid(&self.user_id)?),
            date: self.date,
            schedule_id: ScheduleId(parse_uuid(&self.schedule_id)?),
            rev: Revisions {
                updated: self.updated_rev,
                deleted: self.deleted_rev,
            },
        })
    }
}

#[derive(FromRow)]
struct TemplateRow {
    schedule_id: String,
    user_id: String,
    updated_rev: i64,
    deleted_rev: Option<i64>,
}

impl TemplateRow {
    fn into_type(self) -> AppResult<Template> {
        Ok(Template {
            user_id: UserId(parse_uuid(&self.user_id)?),
            schedule_id: ScheduleId(parse_uuid(&self.schedule_id)?),
            rev: Revisions {
                updated: self.updated_rev,
                deleted: self.deleted_rev,
            },
        })
    }
}

// --- selects ---

pub async fn select_schedules(
    conn: &mut SqliteConnection,
    user: Uuid,
    since: Option<Revision>,
) -> AppResult<Vec<Schedule>> {
    let rows: Vec<ScheduleRow> = match since {
        None => {
            sqlx::query_as("SELECT * FROM schedules WHERE user_id = ? AND deleted_rev IS NULL")
                .bind(user.to_string())
                .fetch_all(&mut *conn)
                .await?
        }
        Some(v) => {
            sqlx::query_as("SELECT * FROM schedules WHERE user_id = ? AND updated_rev > ?")
                .bind(user.to_string())
                .bind(v)
                .fetch_all(&mut *conn)
                .await?
        }
    };
    rows.into_iter().map(ScheduleRow::into_type).collect()
}

pub async fn select_items(
    conn: &mut SqliteConnection,
    user: Uuid,
    since: Option<Revision>,
) -> AppResult<Vec<ScheduleItem>> {
    let rows: Vec<ScheduleItemRow> = match since {
        None => {
            sqlx::query_as(
                "SELECT i.* FROM schedule_items i JOIN schedules s ON i.schedule_id = s.id \
             WHERE s.user_id = ? AND i.deleted_rev IS NULL",
            )
            .bind(user.to_string())
            .fetch_all(&mut *conn)
            .await?
        }
        Some(v) => {
            sqlx::query_as(
                "SELECT i.* FROM schedule_items i JOIN schedules s ON i.schedule_id = s.id \
             WHERE s.user_id = ? AND i.updated_rev > ?",
            )
            .bind(user.to_string())
            .bind(v)
            .fetch_all(&mut *conn)
            .await?
        }
    };
    rows.into_iter().map(ScheduleItemRow::into_type).collect()
}

pub async fn select_bindings(
    conn: &mut SqliteConnection,
    user: Uuid,
    since: Option<Revision>,
) -> AppResult<Vec<ScheduleBinding>> {
    let rows: Vec<ScheduleBindingRow> = match since {
        None => {
            sqlx::query_as(
                "SELECT * FROM schedule_bindings WHERE user_id = ? AND deleted_rev IS NULL",
            )
            .bind(user.to_string())
            .fetch_all(&mut *conn)
            .await?
        }
        Some(v) => {
            sqlx::query_as("SELECT * FROM schedule_bindings WHERE user_id = ? AND updated_rev > ?")
                .bind(user.to_string())
                .bind(v)
                .fetch_all(&mut *conn)
                .await?
        }
    };
    rows.into_iter()
        .map(ScheduleBindingRow::into_type)
        .collect()
}

pub async fn select_templates(
    conn: &mut SqliteConnection,
    user: Uuid,
    since: Option<Revision>,
) -> AppResult<Vec<Template>> {
    let rows: Vec<TemplateRow> = match since {
        None => {
            sqlx::query_as("SELECT * FROM templates WHERE user_id = ? AND deleted_rev IS NULL")
                .bind(user.to_string())
                .fetch_all(&mut *conn)
                .await?
        }
        Some(v) => {
            sqlx::query_as("SELECT * FROM templates WHERE user_id = ? AND updated_rev > ?")
                .bind(user.to_string())
                .bind(v)
                .fetch_all(&mut *conn)
                .await?
        }
    };
    rows.into_iter().map(TemplateRow::into_type).collect()
}

// --- ownership ---

pub async fn owns_schedule(
    conn: &mut SqliteConnection,
    user: Uuid,
    id: ScheduleId,
) -> AppResult<bool> {
    let found: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM schedules WHERE id = ? AND user_id = ?")
            .bind(id.0.to_string())
            .bind(user.to_string())
            .fetch_optional(&mut *conn)
            .await?;
    Ok(found.is_some())
}

// --- writes ---

pub async fn upsert_schedule(
    conn: &mut SqliteConnection,
    user: Uuid,
    s: &Schedule,
    rev: Revision,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO schedules (id, user_id, name, start_minute, end_minute, updated_rev, deleted_rev) \
         VALUES (?, ?, ?, ?, ?, ?, NULL) \
         ON CONFLICT(id) DO UPDATE SET \
           name = excluded.name, start_minute = excluded.start_minute, \
           end_minute = excluded.end_minute, updated_rev = excluded.updated_rev, deleted_rev = NULL",
    )
    .bind(s.id.0.to_string())
    .bind(user.to_string())
    .bind(&s.name)
    .bind(s.start)
    .bind(s.end)
    .bind(rev)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn upsert_item(
    conn: &mut SqliteConnection,
    item: &ScheduleItem,
    rev: Revision,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO schedule_items \
           (id, schedule_id, position, start_minute, end_minute, fixed_duration, duration_target, \
            use_inline, inline_label, inline_description, inline_color, \
            project_id, project_rank, task_id, task_rank, updated_rev, deleted_rev) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) \
         ON CONFLICT(id) DO UPDATE SET \
           schedule_id = excluded.schedule_id, position = excluded.position, \
           start_minute = excluded.start_minute, end_minute = excluded.end_minute, \
           fixed_duration = excluded.fixed_duration, duration_target = excluded.duration_target, \
           use_inline = excluded.use_inline, inline_label = excluded.inline_label, \
           inline_description = excluded.inline_description, inline_color = excluded.inline_color, \
           project_id = excluded.project_id, project_rank = excluded.project_rank, \
           task_id = excluded.task_id, task_rank = excluded.task_rank, \
           updated_rev = excluded.updated_rev, deleted_rev = NULL",
    )
    .bind(item.id.0.to_string())
    .bind(item.schedule_id.0.to_string())
    .bind(&item.position.0)
    .bind(item.bounds.start)
    .bind(item.bounds.end)
    .bind(item.bounds.fixed_duration)
    .bind(item.bounds.duration_target)
    .bind(item.use_inline)
    .bind(&item.inline_label)
    .bind(&item.inline_description)
    .bind(item.inline_color.as_key())
    .bind(item.project_id.map(|p| p.0.to_string()))
    .bind(item.project_rank)
    .bind(item.task_id.map(|t| t.0.to_string()))
    .bind(item.task_rank)
    .bind(rev)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn upsert_binding(
    conn: &mut SqliteConnection,
    user: Uuid,
    b: &ScheduleBinding,
    rev: Revision,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO schedule_bindings (user_id, date, schedule_id, updated_rev, deleted_rev) \
         VALUES (?, ?, ?, ?, NULL) \
         ON CONFLICT(user_id, date) DO UPDATE SET \
           schedule_id = excluded.schedule_id, updated_rev = excluded.updated_rev, deleted_rev = NULL",
    )
    .bind(user.to_string())
    .bind(&b.date)
    .bind(b.schedule_id.0.to_string())
    .bind(rev)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn upsert_template(
    conn: &mut SqliteConnection,
    user: Uuid,
    t: &Template,
    rev: Revision,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO templates (schedule_id, user_id, updated_rev, deleted_rev) \
         VALUES (?, ?, ?, NULL) \
         ON CONFLICT(schedule_id) DO UPDATE SET \
           updated_rev = excluded.updated_rev, deleted_rev = NULL",
    )
    .bind(t.schedule_id.0.to_string())
    .bind(user.to_string())
    .bind(rev)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn tombstone_schedule(
    conn: &mut SqliteConnection,
    user: Uuid,
    id: ScheduleId,
    rev: Revision,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE schedules SET deleted_rev = ?, updated_rev = ? WHERE id = ? AND user_id = ?",
    )
    .bind(rev)
    .bind(rev)
    .bind(id.0.to_string())
    .bind(user.to_string())
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn tombstone_item(
    conn: &mut SqliteConnection,
    id: ScheduleItemId,
    rev: Revision,
) -> AppResult<()> {
    sqlx::query("UPDATE schedule_items SET deleted_rev = ?, updated_rev = ? WHERE id = ?")
        .bind(rev)
        .bind(rev)
        .bind(id.0.to_string())
        .execute(&mut *conn)
        .await?;
    Ok(())
}

pub async fn tombstone_binding(
    conn: &mut SqliteConnection,
    user: Uuid,
    date: &str,
    rev: Revision,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE schedule_bindings SET deleted_rev = ?, updated_rev = ? WHERE user_id = ? AND date = ?",
    )
    .bind(rev)
    .bind(rev)
    .bind(user.to_string())
    .bind(date)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn tombstone_template(
    conn: &mut SqliteConnection,
    user: Uuid,
    id: ScheduleId,
    rev: Revision,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE templates SET deleted_rev = ?, updated_rev = ? WHERE schedule_id = ? AND user_id = ?",
    )
    .bind(rev)
    .bind(rev)
    .bind(id.0.to_string())
    .bind(user.to_string())
    .execute(&mut *conn)
    .await?;
    Ok(())
}
