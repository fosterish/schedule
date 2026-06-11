use sqlx::{FromRow, SqliteConnection};
use uuid::Uuid;

use super::parse_uuid;
use crate::error::AppResult;
use crate::types::common::{Revision, Revisions, UserId};
use crate::types::settings::Settings;

#[derive(FromRow)]
struct SettingsRow {
    user_id: String,
    lead_fixed_min: i64,
    lead_dynamic_min: i64,
    default_start: i64,
    default_end: i64,
    updated_rev: i64,
    deleted_rev: Option<i64>,
}

impl SettingsRow {
    fn into_type(self) -> AppResult<Settings> {
        Ok(Settings {
            user_id: UserId(parse_uuid(&self.user_id)?),
            lead_fixed_min: self.lead_fixed_min,
            lead_dynamic_min: self.lead_dynamic_min,
            default_start: self.default_start,
            default_end: self.default_end,
            rev: Revisions {
                updated: self.updated_rev,
                deleted: self.deleted_rev,
            },
        })
    }
}

pub async fn select_settings(
    conn: &mut SqliteConnection,
    user: Uuid,
    since: Option<Revision>,
) -> AppResult<Vec<Settings>> {
    let rows: Vec<SettingsRow> = match since {
        None => {
            sqlx::query_as("SELECT * FROM user_settings WHERE user_id = ? AND deleted_rev IS NULL")
                .bind(user.to_string())
                .fetch_all(&mut *conn)
                .await?
        }
        Some(v) => {
            sqlx::query_as("SELECT * FROM user_settings WHERE user_id = ? AND updated_rev > ?")
                .bind(user.to_string())
                .bind(v)
                .fetch_all(&mut *conn)
                .await?
        }
    };
    rows.into_iter().map(SettingsRow::into_type).collect()
}

pub async fn upsert_settings(
    conn: &mut SqliteConnection,
    user: Uuid,
    s: &Settings,
    rev: Revision,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO user_settings \
           (user_id, lead_fixed_min, lead_dynamic_min, default_start, default_end, updated_rev, deleted_rev) \
         VALUES (?, ?, ?, ?, ?, ?, NULL) \
         ON CONFLICT(user_id) DO UPDATE SET \
           lead_fixed_min = excluded.lead_fixed_min, lead_dynamic_min = excluded.lead_dynamic_min, \
           default_start = excluded.default_start, default_end = excluded.default_end, \
           updated_rev = excluded.updated_rev, deleted_rev = NULL",
    )
    .bind(user.to_string())
    .bind(s.lead_fixed_min)
    .bind(s.lead_dynamic_min)
    .bind(s.default_start)
    .bind(s.default_end)
    .bind(rev)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn tombstone_settings(
    conn: &mut SqliteConnection,
    user: Uuid,
    rev: Revision,
) -> AppResult<()> {
    sqlx::query("UPDATE user_settings SET deleted_rev = ?, updated_rev = ? WHERE user_id = ?")
        .bind(rev)
        .bind(rev)
        .bind(user.to_string())
        .execute(&mut *conn)
        .await?;
    Ok(())
}
