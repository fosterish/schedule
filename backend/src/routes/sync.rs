use axum::extract::{Query, State};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::extract::cookie::{Key, SignedCookieJar};
use serde::Deserialize;

use crate::auth::{refresh_cookie, AuthUser};
use crate::error::AppResult;
use crate::{sync, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/snapshot", get(snapshot))
        .route("/sync", post(sync_post))
}

#[derive(Debug, Deserialize)]
struct SnapshotQuery {
    since: Option<i64>,
}

async fn snapshot(
    State(state): State<AppState>,
    user: AuthUser,
    jar: SignedCookieJar<Key>,
    Query(q): Query<SnapshotQuery>,
) -> AppResult<impl IntoResponse> {
    tracing::debug!(username = %user.1, since = ?q.since, "GET /snapshot");
    // Omitted or 0 ⇒ full dataset; otherwise a delta since that version.
    let since = q.since.filter(|v| *v > 0);
    let mut tx = state.pool.begin().await?;
    let snap = sync::snapshot(&mut tx, user.0 .0, since).await?;
    tx.commit().await?;
    let jar = jar.add(refresh_cookie(user.0, &user.1));
    Ok((jar, Json(snap)))
}

async fn sync_post(
    State(state): State<AppState>,
    user: AuthUser,
    jar: SignedCookieJar<Key>,
    Json(body): Json<crate::types::ops::SyncOps>,
) -> AppResult<impl IntoResponse> {
    tracing::debug!(username = %user.1, ops = body.ops.len(), "POST /sync");
    let mut tx = state.pool.begin().await?;
    let result = sync::apply_batch(&mut tx, user.0 .0, body).await?;
    tx.commit().await?;
    let jar = jar.add(refresh_cookie(user.0, &user.1));
    Ok((jar, Json(result)))
}
