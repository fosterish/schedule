use std::time::Duration;

use argon2::password_hash::{
    rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
};
use argon2::Argon2;
use axum::extract::{FromRef, FromRequestParts};
use axum::http::request::Parts;
use axum_extra::extract::cookie::{Cookie, Key, SameSite, SignedCookieJar};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::types::common::UserId;

pub const COOKIE_NAME: &str = "schedule_session";
pub const SESSION_TTL_DAYS: i64 = 30;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionPayload {
    /// UUID, hyphenated.
    pub user_id: String,
    /// Login name, carried so requests can be logged without a DB lookup.
    #[serde(default)]
    pub username: String,
    /// Unix-seconds expiry timestamp.
    pub exp: i64,
}

impl SessionPayload {
    pub fn new(user_id: UserId, username: String) -> Self {
        let exp =
            (OffsetDateTime::now_utc() + time::Duration::days(SESSION_TTL_DAYS)).unix_timestamp();
        Self {
            user_id: user_id.0.to_string(),
            username,
            exp,
        }
    }

    pub fn is_expired(&self) -> bool {
        self.exp < OffsetDateTime::now_utc().unix_timestamp()
    }
}

pub fn make_cookie<'a>(value: String) -> Cookie<'a> {
    let mut c = Cookie::new(COOKIE_NAME, value);
    c.set_path("/");
    c.set_http_only(true);
    c.set_same_site(SameSite::Lax);
    c.set_max_age(cookie::time::Duration::days(SESSION_TTL_DAYS));
    c
}

pub fn clear_cookie<'a>() -> Cookie<'a> {
    let mut c = Cookie::new(COOKIE_NAME, "");
    c.set_path("/");
    c.set_http_only(true);
    c.set_same_site(SameSite::Lax);
    c.set_max_age(cookie::time::Duration::seconds(0));
    c
}

pub fn encode_session(payload: &SessionPayload) -> String {
    serde_json::to_string(payload).expect("session payload encodes")
}

pub fn decode_session(s: &str) -> Option<SessionPayload> {
    serde_json::from_str(s).ok()
}

pub fn hash_password(password: &str) -> anyhow::Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    Ok(argon2
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("argon2 hash: {e}"))?
        .to_string())
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// Axum extractor that requires an authenticated, non-expired session.
/// Carries the user id and the (cookie-supplied) username for logging.
#[derive(Debug, Clone)]
pub struct AuthUser(pub UserId, pub String);

impl<S> FromRequestParts<S> for AuthUser
where
    S: Send + Sync,
    Key: FromRef<S>,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let jar = SignedCookieJar::<Key>::from_request_parts(parts, state)
            .await
            .map_err(|_| AppError::Unauthorized)?;
        let cookie = jar.get(COOKIE_NAME).ok_or(AppError::Unauthorized)?;
        let payload = decode_session(cookie.value()).ok_or(AppError::Unauthorized)?;
        if payload.is_expired() {
            return Err(AppError::Unauthorized);
        }
        let id = Uuid::parse_str(&payload.user_id).map_err(|_| AppError::Unauthorized)?;
        Ok(AuthUser(UserId(id), payload.username))
    }
}

/// Builds a fresh cookie with a refreshed session; callers add it to the returned jar.
pub fn refresh_cookie<'a>(user_id: UserId, username: &str) -> Cookie<'a> {
    make_cookie(encode_session(&SessionPayload::new(
        user_id,
        username.to_string(),
    )))
}

pub async fn authenticate(
    pool: &sqlx::SqlitePool,
    username: &str,
    password: &str,
) -> AppResult<UserId> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT id, password_hash FROM users WHERE username = ?")
            .bind(username)
            .fetch_optional(pool)
            .await?;
    let Some((id, password_hash)) = row else {
        return Err(AppError::Unauthorized);
    };
    if !verify_password(password, &password_hash) {
        return Err(AppError::Unauthorized);
    }
    let id = Uuid::parse_str(&id).map_err(|_| AppError::Unauthorized)?;
    Ok(UserId(id))
}

#[allow(dead_code)]
pub const SLOW_HASH_DELAY: Duration = Duration::from_millis(0);
