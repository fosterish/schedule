use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::extract::cookie::{Key, SignedCookieJar};
use serde::Deserialize;

use crate::auth::{authenticate, clear_cookie, refresh_cookie, AuthUser, COOKIE_NAME};
use crate::error::{AppError, AppResult};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/me", get(me))
}

#[derive(Debug, Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
}

async fn login(
    State(state): State<AppState>,
    jar: SignedCookieJar<Key>,
    Json(req): Json<LoginRequest>,
) -> AppResult<impl IntoResponse> {
    tracing::debug!(username = %req.username, "POST /auth/login");
    let user_id = authenticate(&state.pool, &req.username, &req.password).await?;
    tracing::debug!(username = %req.username, "login ok");
    let jar = jar.add(refresh_cookie(user_id, &req.username));
    Ok((StatusCode::NO_CONTENT, jar))
}

async fn logout(jar: SignedCookieJar<Key>) -> impl IntoResponse {
    tracing::debug!("POST /auth/logout");
    let jar = jar.add(clear_cookie());
    (StatusCode::NO_CONTENT, jar)
}

#[derive(serde::Serialize)]
struct MeResponse {
    id: String,
    username: String,
}

async fn me(
    State(state): State<AppState>,
    user: AuthUser,
    jar: SignedCookieJar<Key>,
) -> AppResult<impl IntoResponse> {
    tracing::debug!(username = %user.1, "GET /auth/me");
    let row: Option<(String,)> = sqlx::query_as("SELECT username FROM users WHERE id = ?")
        .bind(user.0 .0.to_string())
        .fetch_optional(&state.pool)
        .await?;
    let Some((username,)) = row else {
        return Err(AppError::Unauthorized);
    };
    let jar = jar.add(refresh_cookie(user.0, &username));
    let _ = COOKIE_NAME;
    Ok((
        jar,
        Json(MeResponse {
            id: user.0 .0.to_string(),
            username,
        }),
    ))
}
