//! The guest's host calls ('C' frames), answered as one 'A' frame.
//!
//! Waiting calls are run concurrently: the pool's queries as one batch to
//! the data service, each pinned client's statements in order on its own
//! connection, outside calls (fetch) at once. Calls that never wait (a file,
//! a token, random bytes, a digest) are answered on the spot.

use crate::data::DataClient;
use crate::fetch::{FetchCall, Fetcher};
use crate::identity::Identity;
use crate::modules::Files;
use bytes::Bytes;
use ring::{digest, hmac, rand::SecureRandom};
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;
use tokio::net::TcpStream;
use wasm_common::log;

/// What one request's host calls need, and what they counted.
pub struct Calls {
    pub pass_raw: String,
    pub rid: u64,
    pub op: Option<String>,
    seq: u32,
    pub data: Arc<DataClient>,
    pinned: HashMap<u32, TcpStream>,
    tx_open: HashSet<u32>,
    pub fetcher: Arc<Fetcher>,
    pub identity: Arc<Identity>,
    pub files: Arc<Files>,
    pub queries: u32,
    pub fetches: u32,
    pub kill_after_commit: bool,
    pub deadline: Instant,
}

impl Calls {
    #[allow(clippy::too_many_arguments)]
    pub fn new(pass_raw: String, rid: u64, op: Option<String>, data: Arc<DataClient>, fetcher: Arc<Fetcher>, identity: Arc<Identity>, files: Arc<Files>, deadline: Instant) -> Self {
        Calls {
            pass_raw,
            rid,
            op,
            seq: 0,
            data,
            pinned: HashMap::new(),
            tx_open: HashSet::new(),
            fetcher,
            identity,
            files,
            queries: 0,
            fetches: 0,
            kill_after_commit: false,
            deadline,
        }
    }
}

#[derive(Deserialize)]
struct Head {
    calls: Vec<Value>,
}

/// The first SQL keyword, uppercased, after comments.
fn first_word(sql: &str) -> String {
    let mut s = sql.trim_start();
    loop {
        if let Some(r) = s.strip_prefix("--") {
            s = r.find('\n').map(|i| &r[i + 1..]).unwrap_or("").trim_start();
        } else if let Some(r) = s.strip_prefix("/*") {
            s = r.find("*/").map(|i| &r[i + 2..]).unwrap_or("").trim_start();
        } else {
            break;
        }
    }
    s.chars().take_while(|c| c.is_ascii_alphabetic()).collect::<String>().to_ascii_uppercase()
}
/// Whether a statement only reads (may run again, may run beside others).
pub fn is_read(sql: &str) -> bool {
    let w = first_word(sql);
    let u = sql.to_ascii_uppercase();
    matches!(w.as_str(), "SELECT" | "WITH" | "SHOW" | "VALUES" | "TABLE" | "EXPLAIN")
        && !["INSERT ", "UPDATE ", "DELETE ", "MERGE ", " FOR UPDATE", " FOR SHARE", " FOR NO KEY", "NEXTVAL(", "SETVAL(", "PG_ADVISORY"].iter().any(|x| u.contains(x))
}

fn kill_now(what: &str) -> ! {
    let what: String = what.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(80).collect();
    log::warn("test hook: exiting after a commit", json!({ "after": what }));
    std::process::exit(137)
}

fn error_json(e: impl std::fmt::Display) -> String {
    json!({ "e": format!("data service: {e}") }).to_string()
}

/// A pool query: its place in the frame, the statement, its values, its sequence number.
type PoolQuery = (usize, String, Vec<Option<String>>, Option<u32>);

enum ClientStep {
    Query { idx: usize, sql: String, params: Vec<Option<String>>, seq: Option<u32> },
    Release { idx: usize },
}

impl Calls {
    /// Answers one 'C' frame payload (kind byte included) with an 'A' frame payload.
    pub async fn execute(&mut self, payload: &[u8]) -> Vec<u8> {
        let nl = payload.iter().position(|&b| b == b'\n');
        let head_bytes = &payload[1..nl.unwrap_or(payload.len())];
        let mut body_in: &[u8] = nl.map(|i| &payload[i + 1..]).unwrap_or(&[]);
        let calls = match serde_json::from_slice::<Head>(head_bytes) {
            Ok(h) => h.calls,
            Err(e) => return answer(vec![json!({ "e": format!("bad call frame: {e}") }).to_string()], vec![]),
        };
        let n = calls.len();
        let mut rs: Vec<Option<String>> = vec![None; n];
        let mut bodies: Vec<Option<Bytes>> = vec![None; n];
        let mut pool_q: Vec<PoolQuery> = vec![];
        let mut clients: BTreeMap<u32, Vec<ClientStep>> = BTreeMap::new();
        let mut fetches: Vec<(usize, FetchCall, Option<Bytes>)> = vec![];

        for (idx, call) in calls.into_iter().enumerate() {
            let mut body: Option<&[u8]> = None;
            if let Some(bl) = call.get("bl").and_then(Value::as_u64) {
                let bl = (bl as usize).min(body_in.len());
                body = Some(&body_in[..bl]);
                body_in = &body_in[bl..];
            }
            let kind = call.get("k").and_then(Value::as_str).unwrap_or("");
            match kind {
                "q" => {
                    let sql = call.get("s").and_then(Value::as_str).unwrap_or("").to_string();
                    let params: Vec<Option<String>> = call.get("p").and_then(|p| serde_json::from_value(p.clone()).ok()).unwrap_or_default();
                    let c = call.get("c").and_then(Value::as_u64).unwrap_or(0) as u32;
                    self.queries += 1;
                    let seq = self.op.as_ref().map(|_| {
                        self.seq += 1;
                        self.seq
                    });
                    if c == 0 {
                        pool_q.push((idx, sql, params, seq));
                    } else {
                        clients.entry(c).or_default().push(ClientStep::Query { idx, sql, params, seq });
                    }
                }
                "rel" => {
                    let c = call.get("c").and_then(Value::as_u64).unwrap_or(0) as u32;
                    clients.entry(c).or_default().push(ClientStep::Release { idx });
                }
                "f" => match serde_json::from_value::<FetchCall>(call.clone()) {
                    Ok(f) => {
                        self.fetches += 1;
                        fetches.push((idx, f, body.map(Bytes::copy_from_slice)));
                    }
                    Err(e) => rs[idx] = Some(json!({ "e": format!("bad fetch call: {e}") }).to_string()),
                },
                _ => {
                    let (r, b) = self.sync_call(kind, &call, body.unwrap_or(&[]));
                    rs[idx] = Some(r);
                    bodies[idx] = b;
                }
            }
        }

        // The waiting calls, all at once.
        let pass = self.pass_raw.clone();
        let rid = self.rid;
        let op = self.op.clone();
        let kill = self.kill_after_commit;
        let data = self.data.clone();
        let pool_fut = run_pool(data.clone(), pass.clone(), rid, op.clone(), pool_q, kill);
        let client_futs: Vec<_> = clients
            .into_iter()
            .map(|(c, steps)| {
                let stream = self.pinned.remove(&c);
                let open = self.tx_open.contains(&c);
                run_client(data.clone(), pass.clone(), rid, op.clone(), c, steps, stream, open, kill)
            })
            .collect();
        let left = self.deadline.saturating_duration_since(Instant::now());
        let fetch_futs: Vec<_> = fetches
            .into_iter()
            .map(|(idx, f, body)| {
                let fetcher = self.fetcher.clone();
                async move { (idx, fetcher.fetch(f, body, left).await) }
            })
            .collect();
        let (pool_out, client_out, fetch_out) = futures::join!(pool_fut, futures::future::join_all(client_futs), futures::future::join_all(fetch_futs));

        for (idx, r) in pool_out {
            rs[idx] = Some(r);
        }
        for (c, out, stream, open) in client_out {
            for (idx, r) in out {
                rs[idx] = Some(r);
            }
            if let Some(s) = stream {
                self.pinned.insert(c, s);
            }
            if open {
                self.tx_open.insert(c);
            } else {
                self.tx_open.remove(&c);
            }
        }
        for (idx, r) in fetch_out {
            match r {
                Ok(f) => {
                    rs[idx] = Some(
                        json!({ "s": f.status, "st": f.status_text, "h": f.headers, "u": f.url, "rd": f.redirected, "bl": f.body.len() }).to_string(),
                    );
                    bodies[idx] = Some(f.body);
                }
                Err((e, timeout)) => rs[idx] = Some(json!({ "e": e, "timeout": timeout }).to_string()),
            }
        }
        answer(rs.into_iter().map(|r| r.unwrap_or_else(|| "{\"e\":\"no answer\"}".into())).collect(), bodies.into_iter().flatten().collect())
    }

    /// Calls that never wait.
    fn sync_call(&self, kind: &str, call: &Value, body: &[u8]) -> (String, Option<Bytes>) {
        let s = |k: &str| call.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        match kind {
            "jwt" => match self.identity.verify_signature(&s("t")) {
                Ok((payload, alg)) => (json!({ "payload": payload, "alg": alg }).to_string(), None),
                Err(e) => (json!({ "e": e }).to_string(), None),
            },
            "file" => match self.files.get(&s("p")) {
                Some(b) => (json!({ "bl": b.len() }).to_string(), Some(b)),
                None => (json!({ "e": "ENOENT", "code": "ENOENT" }).to_string(), None),
            },
            "stat" => match self.files.stat(&s("p")) {
                Some(("f", z)) => (json!({ "t": "f", "z": z }).to_string(), None),
                Some(_) => (json!({ "t": "d" }).to_string(), None),
                None => ("{}".into(), None),
            },
            "ls" => match self.files.list(&s("p")) {
                Some(names) => (json!({ "n": names }).to_string(), None),
                None => ("{}".into(), None),
            },
            "rand" => {
                let n = call.get("n").and_then(Value::as_u64).unwrap_or(0).min(1 << 20) as usize;
                let mut b = vec![0u8; n];
                let _ = ring::rand::SystemRandom::new().fill(&mut b);
                (json!({ "bl": n }).to_string(), Some(Bytes::from(b)))
            }
            "hash" => {
                let alg = match s("a").as_str() {
                    "sha1" => &digest::SHA1_FOR_LEGACY_USE_ONLY,
                    "sha256" => &digest::SHA256,
                    "sha384" => &digest::SHA384,
                    "sha512" => &digest::SHA512,
                    _ => return (json!({ "e": "Digest method not supported" }).to_string(), None),
                };
                let d = digest::digest(alg, body);
                (json!({ "bl": d.as_ref().len() }).to_string(), Some(Bytes::copy_from_slice(d.as_ref())))
            }
            "hmac" => {
                let alg = match s("a").as_str() {
                    "sha1" => hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY,
                    "sha256" => hmac::HMAC_SHA256,
                    "sha384" => hmac::HMAC_SHA384,
                    "sha512" => hmac::HMAC_SHA512,
                    _ => return (json!({ "e": "Invalid digest" }).to_string(), None),
                };
                let kl = (call.get("kl").and_then(Value::as_u64).unwrap_or(0) as usize).min(body.len());
                let tag = hmac::sign(&hmac::Key::new(alg, &body[..kl]), &body[kl..]);
                (json!({ "bl": tag.as_ref().len() }).to_string(), Some(Bytes::copy_from_slice(tag.as_ref())))
            }
            other => (json!({ "e": format!("unknown host call {other:?}") }).to_string(), None),
        }
    }
}

/// The pool's queries: one frame (a batch when several).
async fn run_pool(data: Arc<DataClient>, pass: String, rid: u64, op: Option<String>, qs: Vec<PoolQuery>, kill: bool) -> Vec<(usize, String)> {
    if qs.is_empty() {
        return vec![];
    }
    let all_read = qs.iter().all(|q| is_read(&q.1));
    let retry_ok = all_read || op.is_some();
    if qs.len() == 1 {
        let (idx, sql, params, seq) = &qs[0];
        let frame = json!({ "pass": pass, "r": rid, "c": 0, "s": sql, "p": params, "op": op, "seq": seq.unwrap_or(0) }).to_string();
        let r = match data.call(frame.as_bytes(), retry_ok).await {
            Ok(s) => s,
            Err(e) => error_json(e),
        };
        if kill && !is_read(sql) && !r.starts_with("{\"e\"") {
            kill_now(sql);
        }
        return vec![(*idx, r)];
    }
    let items: Vec<Value> = qs.iter().map(|(_, s, p, seq)| json!({ "s": s, "p": p, "op": op, "seq": seq.unwrap_or(0) })).collect();
    let frame = json!({ "pass": pass, "r": rid, "c": 0, "b": items }).to_string();
    let answers: Vec<String> = match data.call(frame.as_bytes(), retry_ok).await {
        Ok(s) => match serde_json::from_str::<BatchAnswer>(&s) {
            Ok(b) if b.rs.len() == qs.len() => b.rs.into_iter().map(|r| r.get().to_string()).collect(),
            // The service refused the whole frame (a bad pass): every query gets its answer.
            _ => vec![s; qs.len()],
        },
        Err(e) => vec![error_json(e); qs.len()],
    };
    if kill && !all_read && answers.iter().any(|r| !r.starts_with("{\"e\"")) {
        kill_now("a batch with a write");
    }
    qs.iter().map(|q| q.0).zip(answers).collect()
}

#[derive(Deserialize)]
struct BatchAnswer {
    rs: Vec<Box<RawValue>>,
}

/// One client's steps, in order, on its own connection.
#[allow(clippy::too_many_arguments)]
async fn run_client(
    data: Arc<DataClient>,
    pass: String,
    rid: u64,
    op: Option<String>,
    c: u32,
    steps: Vec<ClientStep>,
    mut stream: Option<TcpStream>,
    mut open: bool,
    kill: bool,
) -> (u32, Vec<(usize, String)>, Option<TcpStream>, bool) {
    let mut out = vec![];
    for step in steps {
        match step {
            ClientStep::Query { idx, sql, params, seq } => {
                let frame = json!({ "pass": pass, "r": rid, "c": c, "s": sql, "p": params, "op": op, "seq": seq.unwrap_or(0) }).to_string();
                let (r, s) = data.call_pinned(stream.take(), frame.as_bytes()).await;
                stream = s;
                let r = match r {
                    Ok(r) => r,
                    Err(e) => error_json(e),
                };
                let ok = !r.starts_with("{\"e\"");
                let w = first_word(&sql);
                let committed = match w.as_str() {
                    "BEGIN" | "START" => {
                        open = ok || open;
                        false
                    }
                    "COMMIT" | "END" => {
                        let was = open;
                        open = false;
                        was && ok
                    }
                    "ROLLBACK" | "ABORT" if !sql.to_ascii_uppercase().contains(" TO ") => {
                        open = false;
                        false
                    }
                    _ => !open && ok && !is_read(&sql),
                };
                if kill && committed {
                    kill_now(&sql);
                }
                out.push((idx, r));
            }
            ClientStep::Release { idx } => {
                if let Some(s) = stream.take() {
                    let frame = json!({ "pass": pass, "r": rid, "c": c, "rel": true }).to_string();
                    let (r, s) = data.call_pinned(Some(s), frame.as_bytes()).await;
                    if let (Ok(_), Some(s)) = (&r, s) {
                        data.put_back(s);
                    }
                }
                open = false;
                out.push((idx, "{\"ok\":true}".into()));
            }
        }
    }
    (c, out, stream, open)
}

/// An 'A' frame payload: `A{"rs":[…]}` then, when there are bodies, "\n" and them in order.
fn answer(rs: Vec<String>, bodies: Vec<Bytes>) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + rs.iter().map(String::len).sum::<usize>() + bodies.iter().map(Bytes::len).sum::<usize>());
    out.extend_from_slice(b"A{\"rs\":[");
    for (i, r) in rs.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        out.extend_from_slice(r.as_bytes());
    }
    out.extend_from_slice(b"]}");
    if !bodies.is_empty() {
        out.push(b'\n');
        for b in bodies {
            out.extend_from_slice(&b);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_and_words() {
        assert!(is_read("SELECT 1"));
        assert!(is_read("  /* x */ select * from t"));
        assert!(!is_read("INSERT INTO t VALUES (1)"));
        assert!(!is_read("SELECT * FROM t WHERE id = $1 FOR UPDATE OF t"));
        assert_eq!(first_word("-- c\nCOMMIT"), "COMMIT");
    }

    #[test]
    fn answer_frame() {
        let a = answer(vec!["{\"x\":1}".into(), "{\"bl\":2}".into()], vec![Bytes::from_static(b"hi")]);
        assert_eq!(a, b"A{\"rs\":[{\"x\":1},{\"bl\":2}]}\nhi".to_vec());
        assert_eq!(answer(vec![], vec![]), b"A{\"rs\":[]}".to_vec());
    }
}
