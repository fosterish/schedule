pub mod auth;
pub mod db;
pub mod error;
pub mod fractional;
pub mod history;
pub mod models;
pub mod resolve;
pub mod routes;

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::FromRef;
use axum_extra::extract::cookie::Key;

// Load a .env from the working directory or any parent; returns its path when found. Set vars always win.
pub fn load_env() -> Option<PathBuf> {
    dotenvy::dotenv().ok()
}

#[derive(Clone)]
pub struct AppState {
    pub pool: sqlx::SqlitePool,
    pub cookie_key: Key,
    pub frontend_dir: Arc<PathBuf>,
}

impl FromRef<AppState> for Key {
    fn from_ref(state: &AppState) -> Key {
        state.cookie_key.clone()
    }
}
