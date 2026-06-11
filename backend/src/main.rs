use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::http::{header, HeaderValue};
use axum::{routing::get, Router};
use axum_extra::extract::cookie::Key;
use tower::Layer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;

use schedule::push::PushConfig;
use schedule::{db, load_env, push, routes, AppState};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Before tracing init so RUST_LOG from .env reaches the EnvFilter.
    let env_path = load_env();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "schedule=debug,tower_http=info".into()),
        )
        .init();

    if let Some(path) = &env_path {
        tracing::info!("loaded environment from {}", path.display());
    }

    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "sqlite://schedule.db?mode=rwc".to_string());
    let pool = db::connect(&database_url).await?;
    db::migrate(&pool).await?;

    let cookie_key = load_or_generate_cookie_key()?;
    let frontend_dir =
        std::env::var("FRONTEND_DIR").unwrap_or_else(|_| "frontend/dist".to_string());
    let frontend_dir = PathBuf::from(frontend_dir);

    if !frontend_dir.exists() {
        anyhow::bail!("frontend directory not found: {}", frontend_dir.display());
    }

    let push_config = PushConfig::from_env().map(Arc::new);
    if push_config.is_none() {
        tracing::warn!("VAPID env vars unset; push notifications disabled");
    }

    let state = AppState {
        pool,
        cookie_key,
        frontend_dir: Arc::new(frontend_dir.clone()),
        push: push_config,
    };

    let index = frontend_dir.join("index.html");

    // `assets/` URLs are content-hashed by Vite, so cache them forever.
    // Everything else (the SPA index.html) is `no-cache` so deploys land immediately.
    let immutable = SetResponseHeaderLayer::overriding(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    let no_cache = SetResponseHeaderLayer::overriding(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache"),
    );
    let assets_service = immutable.layer(ServeDir::new(frontend_dir.join("assets")));
    let static_service =
        no_cache.layer(ServeDir::new(&frontend_dir).fallback(ServeFile::new(index)));

    let api = Router::new()
        .route(
            "/health",
            get(|| async {
                tracing::debug!("GET /health");
                "ok"
            }),
        )
        .merge(routes::auth_routes())
        .merge(routes::sync_routes())
        .merge(routes::push_routes())
        .with_state(state.clone());

    let app = Router::new()
        .nest("/api", api)
        .nest_service("/assets", assets_service)
        .fallback_service(static_service)
        .layer(TraceLayer::new_for_http());

    let addr: SocketAddr = std::env::var("BIND_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:3000".to_string())
        .parse()?;

    // Broadcast one shutdown signal to both the HTTP server and the push loop.
    let (shutdown_tx, _) = tokio::sync::broadcast::channel::<()>(1);
    {
        let tx = shutdown_tx.clone();
        tokio::spawn(async move {
            shutdown_signal().await;
            let _ = tx.send(());
        });
    }

    if let Some(config) = state.push.clone() {
        tokio::spawn(push::run(
            state.pool.clone(),
            config,
            shutdown_tx.subscribe(),
        ));
    }

    tracing::info!("listening on http://{}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let mut shutdown_rx = shutdown_tx.subscribe();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.recv().await;
        })
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
