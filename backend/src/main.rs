use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::{routing::get, Router};
use axum_extra::extract::cookie::Key;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

use schedule::{db, routes, AppState};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "schedule=debug,tower_http=info".into()),
        )
        .init();

    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "sqlite://schedule.db?mode=rwc".to_string());
    let pool = db::connect(&database_url).await?;
    db::migrate(&pool).await?;

    let cookie_key = load_or_generate_cookie_key()?;
    let frontend_dir = std::env::var("FRONTEND_DIR").unwrap_or_else(|_| "../frontend".to_string());
    let frontend_dir = PathBuf::from(frontend_dir);

    if !frontend_dir.exists() {
        anyhow::bail!("frontend directory not found: {}", frontend_dir.display());
    }

    let state = AppState {
        pool,
        cookie_key,
        frontend_dir: Arc::new(frontend_dir.clone()),
    };

    let index = frontend_dir.join("index.html");
    let static_service = ServeDir::new(&frontend_dir).fallback(ServeFile::new(index));

    let api = Router::new()
        .route("/health", get(|| async { "ok" }))
        .merge(routes::auth_routes())
        .merge(routes::projects_routes())
        .merge(routes::tasks_routes())
        .merge(routes::schedules_routes())
        .merge(routes::calendar_routes())
        .merge(routes::day_routes())
        .merge(routes::history_routes())
        .with_state(state.clone());

    let app = Router::new()
        .nest("/api", api)
        .fallback_service(static_service)
        .layer(TraceLayer::new_for_http());

    let addr: SocketAddr = std::env::var("BIND_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:3000".to_string())
        .parse()?;

    tracing::info!("listening on http://{}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

// Resolves on SIGTERM (e.g. `docker stop`) or SIGINT (Ctrl+C) so the server stops
// accepting connections and drains in-flight requests instead of being SIGKILLed
// after the container stop timeout. As PID 1 in the container the process gets no
// default signal handling, so this handler is what makes shutdown prompt.
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    tracing::info!("signal received, starting graceful shutdown");
}

fn load_or_generate_cookie_key() -> anyhow::Result<Key> {
    match std::env::var("APP_SECRET") {
        Ok(s) => {
            let raw = if s.len() == 128 {
                hex::decode(&s).map_err(|e| anyhow::anyhow!("APP_SECRET hex decode: {e}"))?
            } else {
                s.into_bytes()
            };
            if raw.len() < 64 {
                anyhow::bail!("APP_SECRET must be at least 64 bytes (128 hex chars)");
            }
            Ok(Key::from(&raw))
        }
        Err(_) => {
            tracing::warn!(
                "APP_SECRET is not set; generating an ephemeral key. Sessions will not survive a restart."
            );
            Ok(Key::generate())
        }
    }
}
