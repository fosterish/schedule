pub mod auth;
pub mod db;
pub mod error;
pub mod models;
pub mod rev;
pub mod routes;
pub mod sync;
pub mod types;

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
