//! One runner connection's frames: statements, batches, pinned clients,
//! operation IDs.
//!
//! A frame is `{pass, r, c, s, p, op, seq}` for one statement, `{pass, r, b:[…]}`
//! for a batch, `{pass, r, c, rel:true}` to release a pinned client, or
//! `{ctl}` (health, stats). `c` 0 runs on any pooled connection; `c` > 0 is a
//! client (node-pg's pool.connect()) holding one connection until it is
//! released or this runner connection closes, when an open transaction is
//! rolled back (the connection is closed, never handed on).
//!
//! OPERATION IDS. A request the gate may retry carries an ID; every statement
//! of it carries the ID and its sequence number. Each such statement's result
//! is stored in the database's `_ops` table in the same transaction as the
//! statement, and a statement asked again with the same (op, seq) gets the
//! stored result instead of running. Reads are stored too, so a retried
//! request sees what the first attempt saw up to where it stopped, and gives
//! the same answer. `_ops` is created on first use and keeps a day.

use crate::pool::{Held, Pools};
use crate::sql::{self, TxControl};
use serde::Deserialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering::Relaxed;
use std::sync::{Arc, Mutex};
use wasm_common::pass::{now_s, Pass, PassKey};
use wasm_common::{is_twin_db, log};

#[derive(Deserialize)]
pub struct Req {
    pub pass: String,
    #[serde(default)]
    pub r: u64,
    #[serde(default)]
    pub c: u32,
    #[serde(default)]
    pub s: Option<String>,
    #[serde(default)]
    pub p: Vec<Option<String>>,
    #[serde(default)]
    pub op: Option<String>,
    #[serde(default)]
    pub seq: u32,
    #[serde(default)]
    pub b: Option<Vec<Item>>,
    #[serde(default)]
    pub rel: bool,
}

#[derive(Deserialize)]
pub struct Item {
    pub s: String,
    #[serde(default)]
    pub p: Vec<Option<String>>,
    #[serde(default)]
    pub op: Option<String>,
    #[serde(default)]
    pub seq: u32,
}

const OPS_TABLE: &str = "CREATE TABLE IF NOT EXISTS _ops (
  op TEXT NOT NULL,
  seq INTEGER NOT NULL,
  reply TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (op, seq)
)";
const OPS_PRUNE: &str = "DELETE FROM _ops WHERE at < now() - interval '1 day'";
const OPS_GET: &str = "SELECT reply FROM _ops WHERE op = $1 AND seq = $2";
const OPS_PUT: &str = "INSERT INTO _ops (op, seq, reply) VALUES ($1, $2, $3) ON CONFLICT (op, seq) DO NOTHING";

pub struct Service {
    key: PassKey,
    pub pools: Arc<Pools>,
    passes: Mutex<HashMap<String, Pass>>,
    ops_ready: Mutex<HashSet<String>>,
}

fn err(e: impl std::fmt::Display) -> String {
    json!({ "e": e.to_string() }).to_string()
}

impl Service {
    pub fn new(key: PassKey, pools: Arc<Pools>) -> Self {
        Service { key, pools, passes: Mutex::new(HashMap::new()), ops_ready: Mutex::new(HashSet::new()) }
    }

    /// The pass's claims, remembered until it expires (a check costs ~44 µs).
    fn check(&self, pass: &str) -> Result<Pass, String> {
        let now = now_s();
        if let Some(p) = self.passes.lock().unwrap().get(pass) {
            if p.exp >= now {
                return Ok(p.clone());
            }
        }
        let p = self.key.verify(pass, now).map_err(|e| e.to_string())?;
        if !is_twin_db(&p.db) {
            log::warn("pass refused", json!({ "reason": "not a twin database", "app": p.app, "ses": p.ses, "db": p.db }));
            return Err("pass refused: its database is not a twin database".into());
        }
        let mut m = self.passes.lock().unwrap();
        if m.len() > 50_000 {
            m.retain(|_, p| p.exp >= now);
        }
        m.insert(pass.to_string(), p.clone());
        Ok(p)
    }

    /// Answers one frame of a runner connection; `held` is that connection's pinned clients.
    pub async fn handle(&self, q: Req, held: &mut HashMap<(u64, u32), Held>) -> String {
        let pass = match self.check(&q.pass) {
            Ok(p) => p,
            Err(e) => {
                self.pools.stats.refused.fetch_add(1, Relaxed);
                if !e.contains("twin") {
                    log::warn("pass refused", json!({ "reason": e }));
                }
                return json!({ "e": e, "code": "pass" }).to_string();
            }
        };
        let db = pass.db.clone();
        if q.rel {
            return self.release(held, (q.r, q.c)).await;
        }
        if let Some(items) = q.b {
            return self.batch(&db, items).await;
        }
        let Some(sql) = q.s else { return err("no statement") };
        let op = q.op.filter(|o| !o.is_empty() && o.len() <= 128);
        self.pools.stats.statements.fetch_add(1, Relaxed);
        let out = if q.c == 0 {
            match self.pools.get(&db).await {
                Ok(mut h) => self.statement(&mut h, &sql, &q.p, op.as_deref(), q.seq).await,
                Err(e) => {
                    self.pools.log_failure(&db, &e);
                    Err(err(e))
                }
            }
        } else {
            let h = match held.entry((q.r, q.c)) {
                std::collections::hash_map::Entry::Occupied(o) => o.into_mut(),
                std::collections::hash_map::Entry::Vacant(v) => match self.pools.get(&db).await {
                    Ok(h) => v.insert(h),
                    Err(e) => {
                        self.pools.log_failure(&db, &e);
                        return err(e);
                    }
                },
            };
            if h.db() != db {
                return err("this client belongs to another database");
            }
            self.statement(h, &sql, &q.p, op.as_deref(), q.seq).await
        };
        match out {
            Ok(s) => s,
            Err(e) => {
                self.pools.stats.errors.fetch_add(1, Relaxed);
                e
            }
        }
    }

    async fn release(&self, held: &mut HashMap<(u64, u32), Held>, key: (u64, u32)) -> String {
        if let Some(mut h) = held.remove(&key) {
            if h.conn().in_tx {
                // Released with its transaction open: roll it back, as a pool
                // would never hand on a connection mid-transaction.
                if h.conn().client.batch_execute("ROLLBACK").await.is_err() {
                    h.discard();
                    return "{\"ok\":true}".into();
                }
                h.conn().in_tx = false;
            }
        }
        "{\"ok\":true}".into()
    }

    /// Queries started together: reads with no operation ID run at once on one
    /// connection (pipelined); anything else one after another, in order.
    async fn batch(&self, db: &str, items: Vec<Item>) -> String {
        self.pools.stats.statements.fetch_add(items.len() as u64, Relaxed);
        let mut h = match self.pools.get(db).await {
            Ok(h) => h,
            Err(e) => {
                self.pools.log_failure(db, &e);
                let one = err(e);
                return format!("{{\"rs\":[{}]}}", vec![one; items.len()].join(","));
            }
        };
        let pipelined = items.iter().all(|i| sql::is_read(&i.s) && i.op.as_deref().is_none_or(str::is_empty));
        let mut out = Vec::with_capacity(items.len());
        if pipelined {
            // Prepare each first (cached after the first time), then run them together.
            let conn = h.conn();
            let mut statements = vec![];
            for i in &items {
                match conn.prepare(&i.s).await {
                    Ok(s) => statements.push(Ok(s)),
                    Err(e) => statements.push(Err(sql::error_json(&e).to_string())),
                }
            }
            let client = &conn.client;
            let futs = items.iter().zip(statements.iter()).map(|(i, st)| async move {
                let st = match st {
                    Ok(s) => s,
                    Err(e) => return e.clone(),
                };
                let args: Vec<sql::Text> = i.p.iter().cloned().map(sql::Text).collect();
                match client.query(st, &args.iter().map(|a| a as &(dyn tokio_postgres::types::ToSql + Sync)).collect::<Vec<_>>()).await {
                    Ok(rows) => crate::values::result_json(st.columns(), &rows, None, &crate::values::command_of(&i.s)),
                    Err(e) => sql::error_json(&e).to_string(),
                }
            });
            out = futures::future::join_all(futs).await;
        } else {
            for i in items {
                let op = i.op.filter(|o| !o.is_empty() && o.len() <= 128);
                out.push(match self.statement(&mut h, &i.s, &i.p, op.as_deref(), i.seq).await {
                    Ok(s) | Err(s) => s,
                });
            }
        }
        format!("{{\"rs\":[{}]}}", out.join(","))
    }

    /// One statement on a held connection, stored and replayed by operation ID.
    async fn statement(&self, h: &mut Held, sql_text: &str, params: &[Option<String>], op: Option<&str>, seq: u32) -> Result<String, String> {
        let db = h.db().to_string();
        let Some(op) = op else {
            return sql::run(h.conn(), sql_text, params).await.map_err(|e| sql::error_json(&e).to_string());
        };
        if sql::tx_control(sql_text).is_some() && params.is_empty() {
            // BEGIN, COMMIT, ROLLBACK are never stored: a retried transaction
            // begins and commits again around its replayed statements.
            let r = sql::run(h.conn(), sql_text, params).await.map_err(|e| sql::error_json(&e).to_string());
            if sql::tx_control(sql_text) == Some(TxControl::End) {
                h.conn().in_tx = false;
            }
            return r;
        }
        self.ensure_ops(h).await.map_err(err)?;
        let conn = h.conn();
        let (seq_s, op_s) = (seq.to_string(), op.to_string());
        if conn.in_tx {
            // Inside the app's transaction: stored with it, or not at all.
            if let Some(r) = stored(conn, &op_s, &seq_s).await.map_err(|e| sql::error_json(&e).to_string())? {
                self.pools.stats.replays.fetch_add(1, Relaxed);
                return Ok(r);
            }
            let r = sql::run(conn, sql_text, params).await.map_err(|e| sql::error_json(&e).to_string())?;
            let n = put(conn, &op_s, &seq_s, &r).await.map_err(|e| sql::error_json(&e).to_string())?;
            if n == 0 {
                return Err(err("this operation was already applied by another attempt"));
            }
            return Ok(r);
        }
        conn.client.batch_execute("BEGIN").await.map_err(|e| sql::error_json(&e).to_string())?;
        conn.in_tx = true;
        let result: Result<(String, bool), tokio_postgres::Error> = async {
            if let Some(r) = stored(conn, &op_s, &seq_s).await? {
                return Ok((r, true));
            }
            let r = sql::run(conn, sql_text, params).await?;
            if put(conn, &op_s, &seq_s, &r).await? == 0 {
                // Another attempt stored it first (it was waiting on our key): its result stands.
                return Ok((String::new(), false));
            }
            Ok((r, false))
        }
        .await;
        match result {
            Ok((r, replayed)) if !r.is_empty() => {
                let c = conn.client.batch_execute("COMMIT").await;
                conn.in_tx = false;
                c.map_err(|e| sql::error_json(&e).to_string())?;
                if replayed {
                    self.pools.stats.replays.fetch_add(1, Relaxed);
                }
                Ok(r)
            }
            Ok(_) => {
                let _ = conn.client.batch_execute("ROLLBACK").await;
                conn.in_tx = false;
                self.pools.stats.replays.fetch_add(1, Relaxed);
                stored(conn, &op_s, &seq_s).await.map_err(|e| sql::error_json(&e).to_string())?.ok_or_else(|| err("lost the stored result"))
            }
            Err(e) => {
                let _ = conn.client.batch_execute("ROLLBACK").await;
                conn.in_tx = false;
                let _ = &db;
                Err(sql::error_json(&e).to_string())
            }
        }
    }

    /// `_ops`, once per database per process (and a day's pruning with it).
    async fn ensure_ops(&self, h: &mut Held) -> anyhow::Result<()> {
        let db = h.db().to_string();
        if self.ops_ready.lock().unwrap().contains(&db) {
            return Ok(());
        }
        let conn = h.conn();
        if conn.in_tx {
            // Creating it inside the app's transaction would tie it to that
            // transaction; a separate connection does it on its own.
            let mut other = self.pools.get(&db).await?;
            create_ops(other.conn()).await?;
        } else {
            create_ops(conn).await?;
        }
        self.ops_ready.lock().unwrap().insert(db);
        Ok(())
    }
}

async fn create_ops(conn: &mut crate::pool::Conn) -> anyhow::Result<()> {
    for attempt in 0..2 {
        match conn.client.batch_execute(OPS_TABLE).await {
            Ok(()) => break,
            // Two replicas creating it at once: the second sees a duplicate; once more settles it.
            Err(e) if attempt == 0 && e.as_db_error().is_some_and(|d| matches!(d.code().code(), "23505" | "42P07")) => continue,
            Err(e) => return Err(anyhow::anyhow!("creating _ops: {}", sql::error_text(&e))),
        }
    }
    conn.client.batch_execute(OPS_PRUNE).await.map_err(|e| anyhow::anyhow!("pruning _ops: {}", sql::error_text(&e)))?;
    Ok(())
}

async fn stored(conn: &mut crate::pool::Conn, op: &str, seq: &str) -> Result<Option<String>, tokio_postgres::Error> {
    let st = conn.prepare(OPS_GET).await?;
    let p = [sql::Text(Some(op.into())), sql::Text(Some(seq.into()))];
    Ok(conn.client.query_opt(&st, &[&p[0], &p[1]]).await?.map(|r| r.get::<_, String>(0)))
}

async fn put(conn: &mut crate::pool::Conn, op: &str, seq: &str, reply: &str) -> Result<u64, tokio_postgres::Error> {
    let st = conn.prepare(OPS_PUT).await?;
    let p = [sql::Text(Some(op.into())), sql::Text(Some(seq.into())), sql::Text(Some(reply.into()))];
    conn.client.execute(&st, &[&p[0], &p[1], &p[2]]).await
}
