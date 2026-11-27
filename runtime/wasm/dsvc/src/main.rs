//! The data service: a Wasm app's only way to its database.
//!
//! Runners connect over TCP (PORT, default 3000) and send frames (u32 LE
//! length + JSON). Every frame but `ctl` carries the request's pass, signed
//! by the platform; the database is the pass's, and must be a twin database.
//! The service logs in as that database's owner with a password derived from
//! the database's name and WASM_DB_SECRET, so it holds no list of databases
//! and runners never see a password. Health: the platform probes the TCP
//! port; a `{"ctl":"health"}` or `{"ctl":"stats"}` frame answers too.
//!
//! Env: PORT, WASM_PASS_PUBKEY, WASM_DB_SECRET, WASM_PG_HOST, WASM_PG_PORT,
//! CAP (connections per replica, 20), PER_APP (per database, 4), IDLE_MS
//! (5000), WORKERS (threads), WASM_STATEMENT_TIMEOUT_MS (30000),
//! WASM_IDLE_TX_TIMEOUT_MS (15000: a transaction left idle longer is ended
//! by Postgres).

mod pool;
mod service;
mod sql;
mod values;

use anyhow::{Context, Result};
use pool::{PoolConfig, Pools};
use serde_json::json;
use service::{Req, Service};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use wasm_common::{frame, log, pass::PassKey};

fn env_or<T: std::str::FromStr>(k: &str, d: T) -> T {
    std::env::var(k).ok().and_then(|v| v.trim().parse().ok()).unwrap_or(d)
}
fn required(k: &str) -> Result<String> {
    std::env::var(k).ok().filter(|v| !v.trim().is_empty()).with_context(|| format!("{k} is not set"))
}

#[derive(serde::Deserialize)]
struct Ctl {
    ctl: String,
}

fn main() -> Result<()> {
    let workers = env_or("WORKERS", std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2));
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(workers.max(1)).enable_all().build()?;
    rt.block_on(serve())
}

async fn serve() -> Result<()> {
    let key = PassKey::from_base64(&required("WASM_PASS_PUBKEY")?)?;
    let secret = required("WASM_DB_SECRET")?;
    let cfg = PoolConfig {
        host: required("WASM_PG_HOST")?,
        port: env_or("WASM_PG_PORT", 5432u16),
        secret,
        cap: env_or("CAP", 20usize).max(1),
        per_db: env_or("PER_APP", 4usize).max(1),
        idle: Duration::from_millis(env_or("IDLE_MS", 5000u64)),
        statement_timeout_ms: env_or("WASM_STATEMENT_TIMEOUT_MS", 30_000u64),
        idle_tx_timeout_ms: env_or("WASM_IDLE_TX_TIMEOUT_MS", 15_000u64),
    };
    let port: u16 = env_or("PORT", 3000u16);
    let started = json!({ "port": port, "pg": format!("{}:{}", cfg.host, cfg.port), "cap": cfg.cap, "per_app": cfg.per_db, "idle_ms": cfg.idle.as_millis() as u64 });
    let pools = Pools::new(cfg);
    let svc = Arc::new(Service::new(key, pools.clone()));

    // Idle connections close after IDLE_MS; a stats line each minute something changed.
    let p2 = pools.clone();
    tokio::spawn(async move {
        let mut last = String::new();
        let mut tick = 0u32;
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            p2.reap();
            tick += 1;
            if tick.is_multiple_of(240) {
                let snap = p2.snapshot();
                let s = snap.to_string();
                if s != last {
                    log::info("stats", snap);
                    last = s;
                }
            }
        }
    });

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.with_context(|| format!("listening on {port}"))?;
    log::info("data service listening", started);
    loop {
        let (mut sock, _) = match listener.accept().await {
            Ok(x) => x,
            Err(e) => {
                log::warn("accept failed", json!({ "error": e.to_string() }));
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        let _ = sock.set_nodelay(true);
        let svc = svc.clone();
        tokio::spawn(async move {
            // This runner connection's pinned clients: closed (an open
            // transaction rolled back) if the connection goes before they are released.
            let mut held: HashMap<(u64, u32), pool::Held> = HashMap::new();
            while let Ok(b) = frame::read(&mut sock).await {
                let out = if let Ok(c) = serde_json::from_slice::<Ctl>(&b) {
                    match c.ctl.as_str() {
                        "health" => "{\"ok\":true}".to_string(),
                        "stats" => svc.pools.snapshot().to_string(),
                        _ => "{\"e\":\"unknown ctl\"}".to_string(),
                    }
                } else {
                    match serde_json::from_slice::<Req>(&b) {
                        Ok(q) => svc.handle(q, &mut held).await,
                        Err(e) => json!({ "e": format!("bad frame: {e}") }).to_string(),
                    }
                };
                if frame::write(&mut sock, out.as_bytes()).await.is_err() {
                    break;
                }
            }
            // Whatever a vanished runner left is closed, never handed on.
            for (_, h) in held.drain() {
                h.discard();
            }
        });
    }
}
