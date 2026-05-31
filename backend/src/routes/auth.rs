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
    let user_id = authenticate(&state.pool, &req.username, &req.password).await?;
    let jar = jar.add(refresh_cookie(user_id));
    Ok((StatusCode::NO_CONTENT, jar))
}

async fn logout(jar: SignedCookieJar<Key>) -> impl IntoResponse {
    let jar = jar.add(clear_cookie());
    (StatusCode::NO_CONTENT, jar)
}

#[derive(serde::Serialize)]
struct MeResponse {
    id: i64,
    username: String,
}

async fn me(State(state): State<AppState>, user: AuthUser, jar: SignedCookieJar<Key>) -> AppResult<impl IntoResponse> {
    let row: Option<(i64, String)> = sqlx::query_as("SELECT id, username FROM users WHERE id = ?")
        .bind(user.0)
        .fetch_optional(&state.pool)
        .await?;
    let Some((id, username)) = row else {
        return Err(AppError::Unauthorized);
    };
    let jar = jar.add(refresh_cookie(id));
    let _ = COOKIE_NAME;
    Ok((jar, Json(MeResponse { id, username })))
}
