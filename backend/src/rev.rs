use sqlx::SqliteConnection;
use uuid::Uuid;

use crate::error::AppResult;
use crate::types::common::Revision;

/// Bump and return the user's revision counter; stamps each row in a batch.
/// Runs inside the sync transaction.
pub async fn next_rev(conn: &mut SqliteConnection, user: Uuid) -> AppResult<Revision> {
    let rev: i64 = sqlx::query_scalar("UPDATE users SET rev = rev + 1 WHERE id = ? RETURNING rev")
        .bind(user.to_string())
        .fetch_one(&mut *conn)
        .await?;
    Ok(rev)
}

/// The user's current revision; the `version` cursor returned to clients.
pub async fn current_rev(conn: &mut SqliteConnection, user: Uuid) -> AppResult<Revision> {
    let rev: i64 = sqlx::query_scalar("SELECT rev FROM users WHERE id = ?")
        .bind(user.to_string())
        .fetch_one(&mut *conn)
        .await?;
    Ok(rev)
}
