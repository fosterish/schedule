use sqlx::{FromRow, SqliteConnection};
use uuid::Uuid;

use super::{parse_color, parse_uuid};
use crate::error::AppResult;
use crate::types::common::{OrderKey, ProjectId, Revision, Revisions, TaskId, UserId};
use crate::types::project::{Dependency, Project, Task};

#[derive(FromRow)]
struct ProjectRow {
    id: String,
    user_id: String,
    name: String,
    value: f64,
    time_cost: f64,
    color: String,
    archived_at: Option<i64>,
    created_at: i64,
    updated_rev: i64,
    deleted_rev: Option<i64>,
}

impl ProjectRow {
    fn into_type(self) -> AppResult<Project> {
        Ok(Project {
            id: ProjectId(parse_uuid(&self.id)?),
            user_id: UserId(parse_uuid(&self.user_id)?),
            name: self.name,
            value: self.value,
            time: self.time_cost,
            color: parse_color(&self.color)?,
            archived_at: self.archived_at,
            created_at: self.created_at,
            rev: Revisions {
                updated: self.updated_rev,
                deleted: self.deleted_rev,
            },
        })
    }
}

#[derive(FromRow)]
struct TaskRow {
    id: String,
    project_id: String,
    name: String,
    description: Option<String>,
    list_order: String,
    completed_at: Option<i64>,
    created_at: i64,
    updated_rev: i64,
    deleted_rev: Option<i64>,
}

impl TaskRow {
    fn into_type(self) -> AppResult<Task> {
        Ok(Task {
            id: TaskId(parse_uuid(&self.id)?),
            project_id: ProjectId(parse_uuid(&self.project_id)?),
            name: self.name,
            description: self.description,
            list_order: OrderKey(self.list_order),
            completed_at: self.completed_at,
            created_at: self.created_at,
            rev: Revisions {
                updated: self.updated_rev,
                deleted: self.deleted_rev,
            },
        })
    }
}

#[derive(FromRow)]
struct DependencyRow {
    blocked_id: String,
    blocker_id: String,
    updated_rev: i64,
    deleted_rev: Option<i64>,
}

impl DependencyRow {
    fn into_type(self) -> AppResult<Dependency> {
        Ok(Dependency {
            blocked_id: TaskId(parse_uuid(&self.blocked_id)?),
            blocker_id: TaskId(parse_uuid(&self.blocker_id)?),
            rev: Revisions {
                updated: self.updated_rev,
                deleted: self.deleted_rev,
            },
        })
    }
}

// --- selects (full = live rows; delta = updated_rev > since, incl. tombstones) ---

pub async fn select_projects(
    conn: &mut SqliteConnection,
    user: Uuid,
    since: Option<Revision>,
) -> AppResult<Vec<Project>> {
    let rows: Vec<ProjectRow> = match since {
        None => {
            sqlx::query_as("SELECT * FROM projects WHERE user_id = ? AND deleted_rev IS NULL")
                .bind(user.to_string())
                .fetch_all(&mut *conn)
                .await?
        }
        Some(v) => {
            sqlx::query_as("SELECT * FROM projects WHERE user_id = ? AND updated_rev > ?")
                .bind(user.to_string())
                .bind(v)
                .fetch_all(&mut *conn)
                .await?
        }
    };
    rows.into_iter().map(ProjectRow::into_type).collect()
}

pub async fn select_tasks(
    conn: &mut SqliteConnection,
    user: Uuid,
    since: Option<Revision>,
) -> AppResult<Vec<Task>> {
    let rows: Vec<TaskRow> = match since {
        None => {
            sqlx::query_as(
                "SELECT t.* FROM tasks t JOIN projects p ON t.project_id = p.id \
             WHERE p.user_id = ? AND t.deleted_rev IS NULL",
            )
            .bind(user.to_string())
            .fetch_all(&mut *conn)
            .await?
        }
        Some(v) => {
            sqlx::query_as(
                "SELECT t.* FROM tasks t JOIN projects p ON t.project_id = p.id \
             WHERE p.user_id = ? AND t.updated_rev > ?",
            )
            .bind(user.to_string())
            .bind(v)
            .fetch_all(&mut *conn)
            .await?
        }
    };
    rows.into_iter().map(TaskRow::into_type).collect()
}

pub async fn select_dependencies(
    conn: &mut SqliteConnection,
    user: Uuid,
    since: Option<Revision>,
) -> AppResult<Vec<Dependency>> {
    let rows: Vec<DependencyRow> = match since {
        None => {
            sqlx::query_as(
                "SELECT d.* FROM task_dependencies d \
             JOIN tasks t ON d.blocked_id = t.id \
             JOIN projects p ON t.project_id = p.id \
             WHERE p.user_id = ? AND d.deleted_rev IS NULL",
            )
            .bind(user.to_string())
            .fetch_all(&mut *conn)
            .await?
        }
        Some(v) => {
            sqlx::query_as(
                "SELECT d.* FROM task_dependencies d \
             JOIN tasks t ON d.blocked_id = t.id \
             JOIN projects p ON t.project_id = p.id \
             WHERE p.user_id = ? AND d.updated_rev > ?",
            )
            .bind(user.to_string())
            .bind(v)
            .fetch_all(&mut *conn)
            .await?
        }
    };
    rows.into_iter().map(DependencyRow::into_type).collect()
}

// --- ownership ---

pub async fn owns_project(
    conn: &mut SqliteConnection,
    user: Uuid,
    id: ProjectId,
) -> AppResult<bool> {
    let found: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM projects WHERE id = ? AND user_id = ?")
            .bind(id.0.to_string())
            .bind(user.to_string())
            .fetch_optional(&mut *conn)
            .await?;
    Ok(found.is_some())
}

pub async fn owns_task(conn: &mut SqliteConnection, user: Uuid, id: TaskId) -> AppResult<bool> {
    let found: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM tasks t JOIN projects p ON t.project_id = p.id WHERE t.id = ? AND p.user_id = ?",
    )
    .bind(id.0.to_string())
    .bind(user.to_string())
    .fetch_optional(&mut *conn)
    .await?;
    Ok(found.is_some())
}

// --- writes (caller stamps `rev` from next_rev; ownership already verified) ---

pub async fn upsert_project(
    conn: &mut SqliteConnection,
    user: Uuid,
    p: &Project,
    rev: Revision,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO projects \
           (id, user_id, name, value, time_cost, color, archived_at, created_at, updated_rev, deleted_rev) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) \
         ON CONFLICT(id) DO UPDATE SET \
           name = excluded.name, value = excluded.value, time_cost = excluded.time_cost, \
           color = excluded.color, archived_at = excluded.archived_at, created_at = excluded.created_at, \
           updated_rev = excluded.updated_rev, deleted_rev = NULL",
    )
    .bind(p.id.0.to_string())
    .bind(user.to_string())
    .bind(&p.name)
    .bind(p.value)
    .bind(p.time)
    .bind(p.color.as_key())
    .bind(p.archived_at)
    .bind(p.created_at)
    .bind(rev)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn upsert_task(conn: &mut SqliteConnection, t: &Task, rev: Revision) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO tasks \
           (id, project_id, name, description, list_order, completed_at, created_at, updated_rev, deleted_rev) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL) \
         ON CONFLICT(id) DO UPDATE SET \
           project_id = excluded.project_id, name = excluded.name, description = excluded.description, \
           list_order = excluded.list_order, completed_at = excluded.completed_at, \
           created_at = excluded.created_at, updated_rev = excluded.updated_rev, deleted_rev = NULL",
    )
    .bind(t.id.0.to_string())
    .bind(t.project_id.0.to_string())
    .bind(&t.name)
    .bind(&t.description)
    .bind(&t.list_order.0)
    .bind(t.completed_at)
    .bind(t.created_at)
    .bind(rev)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn upsert_dependency(
    conn: &mut SqliteConnection,
    d: &Dependency,
    rev: Revision,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO task_dependencies (blocked_id, blocker_id, updated_rev, deleted_rev) \
         VALUES (?, ?, ?, NULL) \
         ON CONFLICT(blocked_id, blocker_id) DO UPDATE SET \
           updated_rev = excluded.updated_rev, deleted_rev = NULL",
    )
    .bind(d.blocked_id.0.to_string())
    .bind(d.blocker_id.0.to_string())
    .bind(rev)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn tombstone_project(
    conn: &mut SqliteConnection,
    user: Uuid,
    id: ProjectId,
    rev: Revision,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE projects SET deleted_rev = ?, updated_rev = ? WHERE id = ? AND user_id = ?",
    )
    .bind(rev)
    .bind(rev)
    .bind(id.0.to_string())
    .bind(user.to_string())
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn tombstone_task(
    conn: &mut SqliteConnection,
    id: TaskId,
    rev: Revision,
) -> AppResult<()> {
    sqlx::query("UPDATE tasks SET deleted_rev = ?, updated_rev = ? WHERE id = ?")
        .bind(rev)
        .bind(rev)
        .bind(id.0.to_string())
        .execute(&mut *conn)
        .await?;
    Ok(())
}

pub async fn tombstone_dependency(
    conn: &mut SqliteConnection,
    blocked: TaskId,
    blocker: TaskId,
    rev: Revision,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE task_dependencies SET deleted_rev = ?, updated_rev = ? \
         WHERE blocked_id = ? AND blocker_id = ?",
    )
    .bind(rev)
    .bind(rev)
    .bind(blocked.0.to_string())
    .bind(blocker.0.to_string())
    .execute(&mut *conn)
    .await?;
    Ok(())
}
