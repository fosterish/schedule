use std::collections::HashSet;

use sqlx::SqliteConnection;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::{project, schedule, settings};
use crate::rev;
use crate::types::common::Revision;
use crate::types::ops::{Model, ModelRef, Operation, Rejection, Snapshot, SyncOps, SyncResult};

/// Reconcile pull. `since = None` ⇒ full live dataset; `Some(v)` ⇒ delta
/// (rows with `updated_rev > v`, including tombstones).
pub async fn snapshot(
    conn: &mut SqliteConnection,
    user: Uuid,
    since: Option<Revision>,
) -> AppResult<Snapshot> {
    Ok(Snapshot {
        version: rev::current_rev(conn, user).await?,
        projects: project::select_projects(conn, user, since).await?,
        tasks: project::select_tasks(conn, user, since).await?,
        dependencies: project::select_dependencies(conn, user, since).await?,
        schedules: schedule::select_schedules(conn, user, since).await?,
        items: schedule::select_items(conn, user, since).await?,
        bindings: schedule::select_bindings(conn, user, since).await?,
        templates: schedule::select_templates(conn, user, since).await?,
        settings: settings::select_settings(conn, user, since).await?,
    })
}

/// Apply a batch in order; each op is authorized + LWW-gated independently.
pub async fn apply_batch(
    conn: &mut SqliteConnection,
    user: Uuid,
    body: SyncOps,
) -> AppResult<SyncResult> {
    let mut applied = Vec::new();
    let mut rejected = Vec::new();
    let mut written: HashSet<String> = HashSet::new();

    for op in &body.ops {
        let target = op_ref(op);
        let key = ref_key(&target);

        // LWW gate + hijack guard: probe the existing row (if any).
        if let Some((stored_rev, owned)) = probe(conn, user, &target).await? {
            if !owned {
                return Err(AppError::Forbidden);
            }
            // Stale unless this batch already wrote the row earlier.
            if stored_rev > body.since && !written.contains(&key) {
                rejected.push(Rejection { target, stored_rev });
                continue;
            }
        }

        let new_rev = rev::next_rev(conn, user).await?;
        match op {
            Operation::Upsert { model } => upsert(conn, user, model, new_rev).await?,
            Operation::Delete { target } => delete(conn, user, target, new_rev).await?,
        }
        written.insert(key);
        applied.push(target);
    }

    Ok(SyncResult {
        version: rev::current_rev(conn, user).await?,
        applied,
        rejected,
    })
}

async fn upsert(
    conn: &mut SqliteConnection,
    user: Uuid,
    model: &Model,
    new_rev: Revision,
) -> AppResult<()> {
    match model {
        Model::Project(p) => project::upsert_project(conn, user, p, new_rev).await,
        Model::Task(t) => {
            require(project::owns_project(conn, user, t.project_id).await?)?;
            project::upsert_task(conn, t, new_rev).await
        }
        Model::Dependency(d) => {
            require(project::owns_task(conn, user, d.blocked_id).await?)?;
            require(project::owns_task(conn, user, d.blocker_id).await?)?;
            project::upsert_dependency(conn, d, new_rev).await
        }
        Model::Schedule(s) => schedule::upsert_schedule(conn, user, s, new_rev).await,
        Model::ScheduleItem(i) => {
            require(schedule::owns_schedule(conn, user, i.schedule_id).await?)?;
            if let Some(pid) = i.project_id {
                require(project::owns_project(conn, user, pid).await?)?;
            }
            if let Some(tid) = i.task_id {
                require(project::owns_task(conn, user, tid).await?)?;
            }
            schedule::upsert_item(conn, i, new_rev).await
        }
        Model::ScheduleBinding(b) => {
            require(schedule::owns_schedule(conn, user, b.schedule_id).await?)?;
            schedule::upsert_binding(conn, user, b, new_rev).await
        }
        Model::Template(t) => {
            require(schedule::owns_schedule(conn, user, t.schedule_id).await?)?;
            schedule::upsert_template(conn, user, t, new_rev).await
        }
        Model::Settings(s) => settings::upsert_settings(conn, user, s, new_rev).await,
    }
}

async fn delete(
    conn: &mut SqliteConnection,
    user: Uuid,
    target: &ModelRef,
    new_rev: Revision,
) -> AppResult<()> {
    // Ownership of the target was already verified by `probe` (foreign ⇒ Forbidden;
    // absent ⇒ the UPDATE is a harmless no-op).
    match target {
        ModelRef::Project(id) => project::tombstone_project(conn, user, *id, new_rev).await,
        ModelRef::Task(id) => project::tombstone_task(conn, *id, new_rev).await,
        ModelRef::Dependency { blocked, blocker } => {
            project::tombstone_dependency(conn, *blocked, *blocker, new_rev).await
        }
        ModelRef::Schedule(id) => schedule::tombstone_schedule(conn, user, *id, new_rev).await,
        ModelRef::ScheduleItem(id) => schedule::tombstone_item(conn, *id, new_rev).await,
        ModelRef::ScheduleBinding(date) => {
            schedule::tombstone_binding(conn, user, date, new_rev).await
        }
        ModelRef::Template(id) => schedule::tombstone_template(conn, user, *id, new_rev).await,
        ModelRef::Settings(_) => settings::tombstone_settings(conn, user, new_rev).await,
    }
}

fn require(ok: bool) -> AppResult<()> {
    if ok {
        Ok(())
    } else {
        Err(AppError::Forbidden)
    }
}

/// The target row's `(updated_rev, owned-by-user)`; `None` if the row is absent.
async fn probe(
    conn: &mut SqliteConnection,
    user: Uuid,
    target: &ModelRef,
) -> AppResult<Option<(Revision, bool)>> {
    let row: Option<(i64, String)> =
        match target {
            ModelRef::Project(id) => {
                sqlx::query_as("SELECT updated_rev, user_id FROM projects WHERE id = ?")
                    .bind(id.0.to_string())
                    .fetch_optional(&mut *conn)
                    .await?
            }
            ModelRef::Task(id) => {
                sqlx::query_as(
                    "SELECT t.updated_rev, p.user_id FROM tasks t \
             JOIN projects p ON t.project_id = p.id WHERE t.id = ?",
                )
                .bind(id.0.to_string())
                .fetch_optional(&mut *conn)
                .await?
            }
            ModelRef::Dependency { blocked, blocker } => {
                sqlx::query_as(
                    "SELECT d.updated_rev, p.user_id FROM task_dependencies d \
             JOIN tasks t ON d.blocked_id = t.id \
             JOIN projects p ON t.project_id = p.id WHERE d.blocked_id = ? AND d.blocker_id = ?",
                )
                .bind(blocked.0.to_string())
                .bind(blocker.0.to_string())
                .fetch_optional(&mut *conn)
                .await?
            }
            ModelRef::Schedule(id) => {
                sqlx::query_as("SELECT updated_rev, user_id FROM schedules WHERE id = ?")
                    .bind(id.0.to_string())
                    .fetch_optional(&mut *conn)
                    .await?
            }
            ModelRef::ScheduleItem(id) => {
                sqlx::query_as(
                    "SELECT i.updated_rev, s.user_id FROM schedule_items i \
             JOIN schedules s ON i.schedule_id = s.id WHERE i.id = ?",
                )
                .bind(id.0.to_string())
                .fetch_optional(&mut *conn)
                .await?
            }
            ModelRef::ScheduleBinding(date) => sqlx::query_as(
                "SELECT updated_rev, user_id FROM schedule_bindings WHERE user_id = ? AND date = ?",
            )
            .bind(user.to_string())
            .bind(date)
            .fetch_optional(&mut *conn)
            .await?,
            ModelRef::Template(id) => {
                sqlx::query_as("SELECT updated_rev, user_id FROM templates WHERE schedule_id = ?")
                    .bind(id.0.to_string())
                    .fetch_optional(&mut *conn)
                    .await?
            }
            ModelRef::Settings(id) => {
                sqlx::query_as("SELECT updated_rev, user_id FROM user_settings WHERE user_id = ?")
                    .bind(id.0.to_string())
                    .fetch_optional(&mut *conn)
                    .await?
            }
        };
    Ok(row.map(|(r, owner)| (r, owner == user.to_string())))
}

fn op_ref(op: &Operation) -> ModelRef {
    match op {
        Operation::Delete { target } => target.clone(),
        Operation::Upsert { model } => match model {
            Model::Project(p) => ModelRef::Project(p.id),
            Model::Task(t) => ModelRef::Task(t.id),
            Model::Dependency(d) => ModelRef::Dependency {
                blocked: d.blocked_id,
                blocker: d.blocker_id,
            },
            Model::Schedule(s) => ModelRef::Schedule(s.id),
            Model::ScheduleItem(i) => ModelRef::ScheduleItem(i.id),
            Model::ScheduleBinding(b) => ModelRef::ScheduleBinding(b.date.clone()),
            Model::Template(t) => ModelRef::Template(t.schedule_id),
            Model::Settings(s) => ModelRef::Settings(s.user_id),
        },
    }
}

fn ref_key(r: &ModelRef) -> String {
    match r {
        ModelRef::Project(id) => format!("project:{}", id.0),
        ModelRef::Task(id) => format!("task:{}", id.0),
        ModelRef::Dependency { blocked, blocker } => {
            format!("dependency:{}:{}", blocked.0, blocker.0)
        }
        ModelRef::Schedule(id) => format!("schedule:{}", id.0),
        ModelRef::ScheduleItem(id) => format!("item:{}", id.0),
        ModelRef::ScheduleBinding(date) => format!("binding:{date}"),
        ModelRef::Template(id) => format!("template:{}", id.0),
        ModelRef::Settings(id) => format!("settings:{}", id.0),
    }
}
