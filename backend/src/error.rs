use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("not authenticated")]
    Unauthorized,
    #[error("not found")]
    NotFound,
    #[error("forbidden")]
    Forbidden,
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("validation: {0}")]
    Validation(String),
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

impl AppError {
    pub fn bad_request(msg: impl Into<String>) -> Self {
        AppError::BadRequest(msg.into())
    }
    pub fn validation(msg: impl Into<String>) -> Self {
        AppError::Validation(msg.into())
    }
    pub fn conflict(msg: impl Into<String>) -> Self {
        AppError::Conflict(msg.into())
    }
    pub fn not_found(_kind: &str) -> Self {
        AppError::NotFound
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        AppError::Other(anyhow::anyhow!(msg.into()))
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, msg) = match &self {
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".to_string()),
            AppError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "forbidden".to_string()),
            AppError::Conflict(m) => (StatusCode::CONFLICT, m.clone()),
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone()),
            AppError::Validation(m) => (StatusCode::UNPROCESSABLE_ENTITY, m.clone()),
            AppError::Sqlx(e) => match e {
                sqlx::Error::RowNotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
                other => {
                    tracing::error!("sqlx error: {:?}", other);
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "database error".to_string(),
                    )
                }
            },
            AppError::Other(e) => {
                tracing::error!("internal error: {:?}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal error".to_string(),
                )
            }
        };
        (status, Json(json!({"error": msg}))).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
