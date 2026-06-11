use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::push::{endpoint_host, now_ms};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/push/vapid-public-key", get(vapid_public_key))
        .route("/push/subscribe", post(subscribe).delete(unsubscribe))
        .route("/push/reminders", put(replace_reminders))
}

#[derive(Serialize)]
struct VapidKey {
    key: String,
}

async fn vapid_public_key(
    State(state): State<AppState>,
    _user: AuthUser,
) -> AppResult<Json<VapidKey>> {
    tracing::debug!(configured = state.push.is_some(), "GET /push/vapid-public-key");
    let config = state.push.as_ref().ok_or(AppError::NotFound)?;
    Ok(Json(VapidKey {
        key: config.public_key.clone(),
    }))
}

#[derive(Deserialize)]
struct Subscription {
    endpoint: String,
    keys: SubscriptionKeys,
}

#[derive(Deserialize)]
struct SubscriptionKeys {
    p256dh: String,
    auth: String,
}

async fn subscribe(
    State(state): State<AppState>,
    user: AuthUser,
    Json(sub): Json<Subscription>,
) -> AppResult<StatusCode> {
    tracing::debug!(username = %user.1, host = endpoint_host(&sub.endpoint), "POST /push/subscribe");
    let now = now_ms();
    sqlx::query(
        "INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, last_seen_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           user_id = excluded.user_id,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           last_seen_ms = excluded.last_seen_ms",
    )
    .bind(&sub.endpoint)
    .bind(user.0 .0.to_string())
    .bind(&sub.keys.p256dh)
    .bind(&sub.keys.auth)
    .bind(now)
    .bind(now)
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct Unsubscribe {
    endpoint: String,
}

async fn unsubscribe(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Unsubscribe>,
) -> AppResult<StatusCode> {
    tracing::debug!(username = %user.1, host = endpoint_host(&body.endpoint), "DELETE /push/subscribe");
    sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?")
        .bind(&body.endpoint)
        .bind(user.0 .0.to_string())
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplaceReminders {
    endpoint: String,
    reminders: Vec<ReminderInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReminderInput {
    fire_at_ms: i64,
    payload: serde_json::Value,
}

// Replace the user's whole reminder set (last-write-wins across devices) and
// refresh the uploading device's last_seen, which doubles as its heartbeat.
async fn replace_reminders(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<ReplaceReminders>,
) -> AppResult<StatusCode> {
    tracing::debug!(
        username = %user.1,
        host = endpoint_host(&body.endpoint),
        count = body.reminders.len(),
        "PUT /push/reminders",
    );
    let user_id = user.0 .0.to_string();
    let mut tx = state.pool.begin().await?;

    sqlx::query("UPDATE push_subscriptions SET last_seen_ms = ? WHERE endpoint = ? AND user_id = ?")
        .bind(now_ms())
        .bind(&body.endpoint)
        .bind(&user_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query("DELETE FROM push_reminders WHERE user_id = ?")
        .bind(&user_id)
        .execute(&mut *tx)
        .await?;

    for r in &body.reminders {
        sqlx::query("INSERT INTO push_reminders (user_id, fire_at_ms, payload) VALUES (?, ?, ?)")
            .bind(&user_id)
            .bind(r.fire_at_ms)
            .bind(r.payload.to_string())
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
