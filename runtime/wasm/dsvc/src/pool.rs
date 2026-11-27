//! Connections to the preview Postgres: a pool per twin database, under one
//! cap for the whole replica.
//!
//! Each twin database has its own owner login (`<db>_owner`, password
//! `hex(HMAC-SHA256(WASM_DB_SECRET, db))`), so a connection belongs to one
//! database and is never lent to another. When the cap is reached, the least
//! recently used idle connection of another database is closed to make room;
//! when none is idle, the caller waits (up to 10 s). Idle connections close
//! after IDLE_MS. The server's address is looked up once and kept (a lookup
//! per connection cost 36 ms across sites in the validation run), and looked
//! up again only after a connection fails.

use anyhow::{anyhow, bail, Result};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio_postgres::{Client, NoTls, Statement};
use wasm_common::log;

/// Prepared statements kept per connection; past this the cache starts over.
const STATEMENTS_PER_CONN: usize = 256;

pub struct Conn {
    pub client: Client,
    statements: HashMap<String, Statement>,
    last: Instant,
    /// Whether a transaction is open on it (tracked from what ran).
    pub in_tx: bool,
}

impl Conn {
    pub async fn prepare(&mut self, sql: &str) -> Result<Statement, tokio_postgres::Error> {
        if let Some(s) = self.statements.get(sql) {
            return Ok(s.clone());
        }
        let s = self.client.prepare(sql).await?;
        if self.statements.len() >= STATEMENTS_PER_CONN {
            self.statements.clear();
        }
        self.statements.insert(sql.to_string(), s.clone());
        Ok(s)
    }
    pub fn forget(&mut self, sql: &str) {
        self.statements.remove(sql);
    }
}

#[derive(Default)]
struct DbPool {
    idle: Vec<Conn>,
    open: usize,
}

#[derive(Default)]
struct Inner {
    dbs: HashMap<String, DbPool>,
    open: usize,
    peak: usize,
}

#[derive(Default)]
pub struct Stats {
    pub opens: AtomicU64,
    pub open_failures: AtomicU64,
    pub evictions: AtomicU64,
    pub idle_closed: AtomicU64,
    pub waits: AtomicU64,
    pub statements: AtomicU64,
    pub replays: AtomicU64,
    pub errors: AtomicU64,
    pub refused: AtomicU64,
}

pub struct PoolConfig {
    pub host: String,
    pub port: u16,
    pub secret: String,
    pub cap: usize,
    pub per_db: usize,
    pub idle: Duration,
    pub statement_timeout_ms: u64,
    pub idle_tx_timeout_ms: u64,
}

pub struct Pools {
    m: Mutex<Inner>,
    cfg: PoolConfig,
    notify: tokio::sync::Notify,
    addr: Mutex<Option<IpAddr>>,
    pub stats: Stats,
}

/// A connection taken from the pool; back to it (or closed) when dropped.
pub struct Held {
    conn: Option<Conn>,
    db: String,
    pools: Arc<Pools>,
}

impl Held {
    pub fn conn(&mut self) -> &mut Conn {
        self.conn.as_mut().expect("a held connection")
    }
    pub fn db(&self) -> &str {
        &self.db
    }
    /// Closes it instead of handing it back (a transaction a runner left open).
    pub fn discard(mut self) {
        drop(self.conn.take());
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        let mut guard = self.pools.m.lock().unwrap();
        let g = &mut *guard;
        let p = g.dbs.entry(self.db.clone()).or_default();
        match self.conn.take() {
            Some(mut c) if !c.client.is_closed() && !c.in_tx => {
                c.last = Instant::now();
                p.idle.push(c);
            }
            _ => {
                p.open -= 1;
                g.open -= 1;
            }
        }
        drop(guard);
        self.pools.notify.notify_waiters();
    }
}

impl Pools {
    pub fn new(cfg: PoolConfig) -> Arc<Self> {
        Arc::new(Pools { m: Mutex::new(Inner::default()), cfg, notify: tokio::sync::Notify::new(), addr: Mutex::new(None), stats: Stats::default() })
    }

    async fn address(&self) -> Result<IpAddr> {
        if let Some(a) = *self.addr.lock().unwrap() {
            return Ok(a);
        }
        let host = self.cfg.host.clone();
        let a = match host.parse::<IpAddr>() {
            Ok(ip) => ip,
            Err(_) => tokio::net::lookup_host((host.as_str(), self.cfg.port))
                .await?
                .next()
                .map(|s| s.ip())
                .ok_or_else(|| anyhow!("{host} has no address"))?,
        };
        *self.addr.lock().unwrap() = Some(a);
        Ok(a)
    }

    async fn connect(&self, db: &str) -> Result<Conn> {
        let addr = self.address().await?;
        let mut c = tokio_postgres::Config::new();
        c.host(&self.cfg.host)
            .hostaddr(addr)
            .port(self.cfg.port)
            .user(format!("{db}_owner"))
            .password(wasm_common::db_password(&self.cfg.secret, db))
            .dbname(db)
            .application_name("wasm-data")
            .connect_timeout(Duration::from_secs(5))
            .options(format!(
                "-c statement_timeout={} -c idle_in_transaction_session_timeout={}",
                self.cfg.statement_timeout_ms, self.cfg.idle_tx_timeout_ms
            ));
        match c.connect(NoTls).await {
            Ok((client, connection)) => {
                tokio::spawn(async move {
                    let _ = connection.await;
                });
                self.stats.opens.fetch_add(1, Relaxed);
                Ok(Conn { client, statements: HashMap::new(), last: Instant::now(), in_tx: false })
            }
            Err(e) => {
                self.stats.open_failures.fetch_add(1, Relaxed);
                if e.as_db_error().is_none() {
                    // Not Postgres refusing: the address may have moved.
                    *self.addr.lock().unwrap() = None;
                }
                Err(anyhow!("connect to {db}: {}", crate::sql::error_text(&e)))
            }
        }
    }

    /// A connection to `db`: an idle one, a new one, or one freed by others.
    pub async fn get(self: &Arc<Self>, db: &str) -> Result<Held> {
        let t0 = Instant::now();
        let mut counted = false;
        loop {
            let notified = self.notify.notified();
            let open_new = {
                let mut g = self.m.lock().unwrap();
                let g = &mut *g;
                let p = g.dbs.entry(db.to_string()).or_default();
                while let Some(c) = p.idle.pop() {
                    if c.client.is_closed() {
                        p.open -= 1;
                        g.open -= 1;
                        continue;
                    }
                    return Ok(Held { conn: Some(c), db: db.to_string(), pools: self.clone() });
                }
                if p.open >= self.cfg.per_db {
                    false
                } else if g.open < self.cfg.cap {
                    true
                } else {
                    // Close the least recently used idle connection of another database.
                    let victim = g
                        .dbs
                        .iter()
                        .filter(|(k, p)| k.as_str() != db && !p.idle.is_empty())
                        .map(|(k, p)| (k.clone(), p.idle.iter().map(|c| c.last).min().unwrap()))
                        .min_by_key(|x| x.1)
                        .map(|x| x.0);
                    match victim {
                        Some(v) => {
                            let vp = g.dbs.get_mut(&v).unwrap();
                            let i = (0..vp.idle.len()).min_by_key(|&i| vp.idle[i].last).unwrap();
                            drop(vp.idle.swap_remove(i));
                            vp.open -= 1;
                            g.open -= 1;
                            self.stats.evictions.fetch_add(1, Relaxed);
                            true
                        }
                        None => false,
                    }
                }
            };
            if open_new {
                {
                    let mut g = self.m.lock().unwrap();
                    g.open += 1;
                    g.peak = g.peak.max(g.open);
                    g.dbs.entry(db.to_string()).or_default().open += 1;
                }
                return match self.connect(db).await {
                    Ok(c) => Ok(Held { conn: Some(c), db: db.to_string(), pools: self.clone() }),
                    Err(e) => {
                        let mut g = self.m.lock().unwrap();
                        g.open -= 1;
                        g.dbs.entry(db.to_string()).or_default().open -= 1;
                        drop(g);
                        self.notify.notify_waiters();
                        Err(e)
                    }
                };
            }
            if !counted {
                counted = true;
                self.stats.waits.fetch_add(1, Relaxed);
            }
            let left = Duration::from_secs(10).saturating_sub(t0.elapsed());
            if left.is_zero() {
                bail!("no database connection free within 10 s");
            }
            let _ = tokio::time::timeout(left, notified).await;
        }
    }

    /// Closes idle connections past IDLE_MS.
    pub fn reap(&self) {
        let mut guard = self.m.lock().unwrap();
        let g = &mut *guard;
        let mut closed = 0;
        for p in g.dbs.values_mut() {
            let before = p.idle.len();
            p.idle.retain(|c| c.last.elapsed() < self.cfg.idle && !c.client.is_closed());
            let n = before - p.idle.len();
            p.open -= n;
            closed += n;
        }
        g.open -= closed;
        g.dbs.retain(|_, p| p.open > 0);
        if closed > 0 {
            self.stats.idle_closed.fetch_add(closed as u64, Relaxed);
            drop(guard);
            self.notify.notify_waiters();
        }
    }

    pub fn snapshot(&self) -> serde_json::Value {
        let g = self.m.lock().unwrap();
        let s = &self.stats;
        serde_json::json!({
            "open": g.open, "peak": g.peak, "idle": g.dbs.values().map(|p| p.idle.len()).sum::<usize>(),
            "databases": g.dbs.len(), "cap": self.cfg.cap, "per_db": self.cfg.per_db,
            "opens": s.opens.load(Relaxed), "open_failures": s.open_failures.load(Relaxed),
            "evictions": s.evictions.load(Relaxed), "idle_closed": s.idle_closed.load(Relaxed),
            "waits": s.waits.load(Relaxed), "statements": s.statements.load(Relaxed),
            "replays": s.replays.load(Relaxed), "errors": s.errors.load(Relaxed), "refused": s.refused.load(Relaxed),
        })
    }

    pub fn log_failure(&self, db: &str, e: &anyhow::Error) {
        log::warn("database connection failed", serde_json::json!({ "db": db, "error": e.to_string() }));
    }
}
