use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sqlx::SqlitePool;
use tokio::sync::broadcast;
use web_push::{
    ContentEncoding, HyperWebPushClient, SubscriptionInfo, VapidSignatureBuilder, WebPushClient,
    WebPushError, WebPushMessageBuilder,
};

const SCAN_INTERVAL: Duration = Duration::from_secs(10);
const PRUNE_INTERVAL: Duration = Duration::from_secs(3600);
// A device that hasn't subscribed or uploaded in this long is dropped.
const DEVICE_TTL_MS: i64 = 3 * 24 * 60 * 60 * 1000;
// Push-service retention, so a reminder isn't delivered long after it's stale.
const REMINDER_TTL_SECS: u32 = 600;
// Keep retrying a transiently-failed reminder until this long past its fire time.
const RETRY_WINDOW_MS: i64 = 30 * 60 * 1000;
const SEND_TIMEOUT: Duration = Duration::from_secs(30);

/// VAPID material; absence disables push entirely.
pub struct PushConfig {
    pub public_key: String,
    private_key: String,
    subject: String,
}

impl PushConfig {
    pub fn from_env() -> Option<Self> {
        let public_key = nonempty("VAPID_PUBLIC_KEY")?;
        let private_key = nonempty("VAPID_PRIVATE_KEY")?;
        let subject = nonempty("VAPID_SUBJECT")?;
        Some(Self {
            public_key,
            private_key,
            subject,
        })
    }
}

fn nonempty(var: &str) -> Option<String> {
    std::env::var(var).ok().filter(|s| !s.is_empty())
}

/// Scan for due reminders and fan them out; sweep stale devices hourly. Stops
/// when the shutdown signal fires.
pub async fn run(pool: SqlitePool, config: Arc<PushConfig>, mut shutdown: broadcast::Receiver<()>) {
    let client = HyperWebPushClient::new();
    let mut scan = tokio::time::interval(SCAN_INTERVAL);
    let mut since_prune = Duration::ZERO;
    tracing::debug!(scan_secs = SCAN_INTERVAL.as_secs(), "push sender started");
    loop {
        tokio::select! {
            _ = shutdown.recv() => break,
            _ = scan.tick() => {
                if let Err(e) = fire_due(&pool, &config, &client).await {
                    tracing::error!("push: scan failed: {e:?}");
                }
                since_prune += SCAN_INTERVAL;
                if since_prune >= PRUNE_INTERVAL {
                    since_prune = Duration::ZERO;
                    if let Err(e) = prune_stale(&pool).await {
                        tracing::error!("push: prune failed: {e:?}");
                    }
                }
            }
        }
    }
    tracing::info!("push sender stopped");
}

async fn fire_due(
    pool: &SqlitePool,
    config: &PushConfig,
    client: &HyperWebPushClient,
) -> sqlx::Result<()> {
    let now = now_ms();
    let due: Vec<(i64, String, String, i64, String)> = sqlx::query_as(
        "SELECT r.id, r.user_id, u.username, r.fire_at_ms, r.payload
         FROM push_reminders r JOIN users u ON u.id = r.user_id
         WHERE r.fire_at_ms <= ? ORDER BY r.fire_at_ms",
    )
    .bind(now)
    .fetch_all(pool)
    .await?;

    if !due.is_empty() {
        tracing::debug!(count = due.len(), "push: firing due reminder(s)");
    }

    for (id, user_id, username, fire_at_ms, payload) in due {
        let subs: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?",
        )
        .bind(&user_id)
        .fetch_all(pool)
        .await?;

        let devices = subs.len();
        let mut sent = 0usize;
        let mut transient = false;
        for (endpoint, p256dh, auth) in subs {
            match send(config, client, &endpoint, &p256dh, &auth, payload.as_bytes()).await {
                Ok(()) => sent += 1,
                Err(SendOutcome::Gone) => {
                    tracing::debug!(host = endpoint_host(&endpoint), "push: endpoint gone, dropping subscription");
                    sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = ?")
                        .bind(&endpoint)
                        .execute(pool)
                        .await?;
                }
                Err(SendOutcome::Transient(msg)) => {
                    transient = true;
                    tracing::warn!(host = endpoint_host(&endpoint), "push: transient send failure: {msg}");
                }
            }
        }

        tracing::debug!(
            reminder = id,
            username = %username,
            sent,
            devices,
            "push: delivered notification to {sent}/{devices} device(s)",
        );

        // One-shot once delivered; a transient failure keeps it for retry until
        // the window passes, so a brief push-service blip doesn't drop reminders.
        if !transient || now - fire_at_ms > RETRY_WINDOW_MS {
            sqlx::query("DELETE FROM push_reminders WHERE id = ?")
                .bind(id)
                .execute(pool)
                .await?;
        }
    }
    Ok(())
}

enum SendOutcome {
    /// The push service reports the endpoint is permanently dead (404/410).
    Gone,
    Transient(String),
}

async fn send(
    config: &PushConfig,
    client: &HyperWebPushClient,
    endpoint: &str,
    p256dh: &str,
    auth: &str,
    content: &[u8],
) -> Result<(), SendOutcome> {
    let info = SubscriptionInfo::new(endpoint, p256dh, auth);
    let mut sig = VapidSignatureBuilder::from_base64(&config.private_key, &info)
        .map_err(|e| SendOutcome::Transient(format!("vapid: {e}")))?;
    sig.add_claim("sub", config.subject.as_str());
    let signature = sig
        .build()
        .map_err(|e| SendOutcome::Transient(format!("vapid build: {e}")))?;

    let mut builder = WebPushMessageBuilder::new(&info);
    builder.set_payload(ContentEncoding::Aes128Gcm, content);
    builder.set_ttl(REMINDER_TTL_SECS);
    builder.set_vapid_signature(signature);
    let message = builder
        .build()
        .map_err(|e| SendOutcome::Transient(format!("build: {e}")))?;

    match tokio::time::timeout(SEND_TIMEOUT, client.send(message)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(WebPushError::EndpointNotFound(_) | WebPushError::EndpointNotValid(_))) => {
            Err(SendOutcome::Gone)
        }
        Ok(Err(e)) => Err(SendOutcome::Transient(e.to_string())),
        Err(_) => Err(SendOutcome::Transient("send timed out".into())),
    }
}

async fn prune_stale(pool: &SqlitePool) -> sqlx::Result<()> {
    let cutoff = now_ms() - DEVICE_TTL_MS;
    let pruned = sqlx::query("DELETE FROM push_subscriptions WHERE last_seen_ms < ?")
        .bind(cutoff)
        .execute(pool)
        .await?
        .rows_affected();
    if pruned > 0 {
        tracing::info!("push: pruned {pruned} stale subscription(s)");
    }
    Ok(())
}

/// The host of a push endpoint URL; full endpoints are long and noisy in logs.
pub fn endpoint_host(endpoint: &str) -> &str {
    endpoint
        .split_once("://")
        .map_or(endpoint, |(_, rest)| rest)
        .split('/')
        .next()
        .unwrap_or(endpoint)
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
