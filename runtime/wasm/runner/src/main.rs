//! The Wasm runner: runs app modules for previews, a fresh instance per
//! request, and builds them from source.
//!
//!   GET  /health        200 (a request without a pass)
//!   POST /_wasm/build   bearer WASM_RUNNER_TOKEN, a gzip tar: the module, or 422 with the reason
//!   POST /_wasm/setup   bearer + a `setup` pass: the module's top-level code once, queries allowed
//!   anything else       with x-usernode-pass: the app's request
//!
//! A request runs in a fresh instance, or with WASM_WARM=N in a warm instance
//! of its app (warm.rs).
//!
//! See ../README.md for the contract and configuration.

mod bundle;
mod calls;
mod config;
mod data;
mod engine;
mod fetch;
mod identity;
mod modules;
mod warm;

use anyhow::Result;
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::header::{HeaderName, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use serde_json::{json, Map, Value};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};
use wasm_common::log;
use wasm_common::pass::{now_s, Pass, PassKey, Scope};

const MAX_REQUEST_BODY: usize = 10 << 20;
const MAX_SOURCE: usize = 20 << 20;

struct State {
    cfg: config::Config,
    passes: PassKey,
    runtime: engine::Runtime,
    modules: modules::Store,
    builder: bundle::Builder,
    data: Arc<data::DataClient>,
    fetcher: Arc<fetch::Fetcher>,
    identity: Arc<identity::Identity>,
    rid: AtomicU64,
    warm: warm::Pool<WarmHandle>,
}

/// A warm instance: where its requests go, and how it is let go.
#[derive(Clone)]
struct WarmHandle {
    jobs: mpsc::Sender<engine::Job>,
    task: tokio::task::AbortHandle,
}
impl WarmHandle {
    fn retire(&self) {
        self.task.abort();
    }
}

type Res = Response<Full<Bytes>>;

fn reply(status: StatusCode, content_type: &str, body: impl Into<Bytes>) -> Res {
    Response::builder().status(status).header("content-type", content_type).body(Full::new(body.into())).unwrap()
}
fn json_reply(status: StatusCode, v: Value) -> Res {
    reply(status, "application/json; charset=utf-8", v.to_string())
}
fn refuse(status: StatusCode, why: &str) -> Res {
    json_reply(status, json!({ "error": why }))
}

fn main() -> Result<()> {
    let cfg = config::Config::from_env()?;
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(cfg.workers).enable_all().build()?;
    rt.block_on(serve(cfg))
}

async fn serve(mut cfg: config::Config) -> Result<()> {
    let passes = PassKey::from_base64(&cfg.pass_pubkey)?;
    if cfg.warm > 0 {
        // Warm instances hold their slots: leave room for fresh ones beside them.
        cfg.slots = cfg.slots.max(cfg.warm_max as u32 + 64);
    }
    let runtime = engine::Runtime::new(&cfg.plugin, cfg.slots, cfg.memory_bytes, cfg.epoch)?;
    let modules = modules::Store::new(runtime.engine.clone(), runtime.engine_id.clone(), cfg.module_url.clone(), cfg.runner_token.clone(), cfg.module_cache_bytes)?;
    let builder = bundle::Builder::new(
        cfg.guest_dir.clone(),
        cfg.plugin.clone(),
        cfg.javy.clone(),
        cfg.esbuild.clone(),
        cfg.build_dir.clone(),
        cfg.build_timeout,
        runtime.engine_id.clone(),
        cfg.build_concurrency,
    )?;
    if cfg.jwt_public_key.is_none() {
        log::warn("USERNODE_JWT_PUBLIC_KEY is not set: every request reaches the app signed out", json!({}));
    }
    let identity = Arc::new(identity::Identity::new(cfg.jwt_public_key.clone(), cfg.guest_jwt_public_key.clone())?);
    let fetcher = fetch::Fetcher::new(cfg.fetch_allow_private, cfg.fetch_timeout, cfg.fetch_extra_ca.as_deref())?;
    if cfg.fetch_extra_ca.is_some() {
        log::warn("WASM_FETCH_EXTRA_CA is set: apps' outside calls trust an extra certificate authority (tests only)", json!({}));
    }
    let data = Arc::new(data::DataClient::new(cfg.data_addr.clone()));
    // Request numbers start at random, so two runners never share one at the data service.
    let rid0 = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos() as u64) ^ ((std::process::id() as u64) << 40);
    let port = cfg.port;
    let started = json!({ "port": port, "engine": runtime.engine_id, "workers": cfg.workers, "slots": cfg.slots, "test_hooks": cfg.test_hooks, "module_url": cfg.module_url.is_some(), "warm": cfg.warm });
    let warm = warm::Pool::new(warm::Config { recycle_after: cfg.warm.max(1), idle: cfg.warm_idle, max: cfg.warm_max, per_module: cfg.warm_per_module });
    let state = Arc::new(State { cfg, passes, runtime, modules, builder, data, fetcher, identity, rid: AtomicU64::new(rid0), warm });
    if state.cfg.warm > 0 {
        let st = state.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                for h in st.warm.reap(Instant::now()) {
                    h.retire();
                }
            }
        });
    }

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    log::info("runner listening", started);
    loop {
        let (sock, peer) = match listener.accept().await {
            Ok(x) => x,
            Err(e) => {
                log::warn("accept failed", json!({ "error": e.to_string() }));
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        let _ = sock.set_nodelay(true);
        let state = state.clone();
        tokio::spawn(async move {
            let svc = hyper::service::service_fn(move |req| {
                let state = state.clone();
                async move { Ok::<_, std::convert::Infallible>(route(state, req, peer).await) }
            });
            let _ = hyper::server::conn::http1::Builder::new().serve_connection(hyper_util::rt::TokioIo::new(sock), svc).await;
        });
    }
}

async fn route(state: Arc<State>, req: Request<hyper::body::Incoming>, peer: SocketAddr) -> Res {
    let path = req.uri().path();
    let has_pass = req.headers().contains_key("x-usernode-pass");
    match (req.method(), path) {
        (&Method::GET, "/health") if !has_pass => {
            let (n, bytes) = state.modules.stats();
            let (warm, busy) = state.warm.counts();
            json_reply(StatusCode::OK, json!({ "ok": true, "engine": state.runtime.engine_id, "modules": n, "module_bytes": bytes, "warm": warm, "warm_busy": busy }))
        }
        (&Method::POST, "/_wasm/build") => build(state, req).await,
        (&Method::POST, "/_wasm/setup") => setup(state, req).await,
        (_, p) if p.starts_with("/_wasm/") => refuse(StatusCode::NOT_FOUND, "no such runner endpoint"),
        _ => app_request(state, req, peer).await,
    }
}

fn bearer_ok(state: &State, req: &Request<hyper::body::Incoming>) -> bool {
    let got = req.headers().get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).unwrap_or("");
    // Compared as digests, so the time taken says nothing about the token.
    let a = ring::digest::digest(&ring::digest::SHA256, got.as_bytes());
    let b = ring::digest::digest(&ring::digest::SHA256, state.cfg.runner_token.as_bytes());
    a.as_ref().iter().zip(b.as_ref()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn body_of(req: Request<hyper::body::Incoming>, limit: usize) -> Result<Bytes, Res> {
    match Limited::new(req.into_body(), limit).collect().await {
        Ok(b) => Ok(b.to_bytes()),
        Err(e) if e.downcast_ref::<http_body_util::LengthLimitError>().is_some() => Err(refuse(StatusCode::PAYLOAD_TOO_LARGE, "the body is too large")),
        Err(_) => Err(refuse(StatusCode::BAD_REQUEST, "the body could not be read")),
    }
}

fn round(ms: f64) -> f64 {
    (ms * 10.0).round() / 10.0
}
fn short(sha: &str) -> &str {
    &sha[..sha.len().min(12)]
}

// ---------------------------------------------------------------- build

async fn build(state: Arc<State>, req: Request<hyper::body::Incoming>) -> Res {
    if !bearer_ok(&state, &req) {
        return refuse(StatusCode::UNAUTHORIZED, "the runner token is required");
    }
    let body = match body_of(req, MAX_SOURCE).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let source_bytes = body.len();
    match state.builder.build(body, &state.modules).await {
        Ok(b) => {
            log::info(
                "built",
                json!({ "mod": b.sha, "ms": round(b.ms), "bytes": b.wasm.len(), "bundle_bytes": b.bundle_bytes, "files_bytes": b.files_bytes, "source_bytes": source_bytes }),
            );
            Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "application/wasm")
                .header("x-module-sha256", &b.sha)
                .header("x-build-ms", format!("{:.0}", b.ms))
                .header("x-bundle-bytes", b.bundle_bytes.to_string())
                .header("x-files-bytes", b.files_bytes.to_string())
                .body(Full::new(Bytes::from(b.wasm)))
                .unwrap()
        }
        Err(bundle::BuildError::Refused(why)) => {
            log::info("build refused", json!({ "reason": why, "source_bytes": source_bytes }));
            refuse(StatusCode::UNPROCESSABLE_ENTITY, &why)
        }
        Err(bundle::BuildError::Failed(why)) => {
            log::error("build failed", json!({ "error": why }));
            refuse(StatusCode::INTERNAL_SERVER_ERROR, &why)
        }
    }
}

// ---------------------------------------------------------------- the app's environment

/// What the app finds in process.env: the platform's names, as a container gets them.
fn app_env(state: &State, pass: &Pass) -> Map<String, Value> {
    let mut env = Map::new();
    if let Some(extra) = &pass.env {
        for (k, v) in extra {
            let ok = !k.is_empty() && k.len() <= 64 && k.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_') && v.len() <= 4096;
            if ok {
                env.insert(k.clone(), Value::String(v.clone()));
            }
        }
    }
    env.entry("USERNODE_ENV").or_insert_with(|| Value::String(state.cfg.app_env.clone()));
    env.insert("USERNODE_APP_ID".into(), Value::String(pass.app.to_string()));
    env.insert("PORT".into(), Value::String("3000".into()));
    env.insert("DATABASE_URL".into(), Value::String(format!("postgres://data-service/{}", pass.db)));
    if let Some(p) = &state.identity.user_pem {
        env.insert("USERNODE_JWT_PUBLIC_KEY".into(), Value::String(p.clone()));
    }
    if let Some(p) = &state.identity.guest_pem {
        env.insert("USERNODE_GUEST_JWT_PUBLIC_KEY".into(), Value::String(p.clone()));
    }
    env
}

fn pass_of(state: &State, req: &Request<hyper::body::Incoming>, scope: Scope) -> Result<(Pass, String), String> {
    let raw = req.headers().get("x-usernode-pass").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let pass = state.passes.verify(&raw, now_s()).map_err(|e| e.to_string())?;
    if pass.scope != scope {
        return Err(format!("pass refused: its scope is not {}", if scope == Scope::Req { "req" } else { "setup" }));
    }
    Ok((pass, raw))
}

/// A 'Q' frame payload: 'Q' + JSON head + "\n" + the body.
fn request_frame(head: &Value, body: &[u8]) -> Vec<u8> {
    let h = head.to_string();
    let mut f = Vec::with_capacity(2 + h.len() + body.len());
    f.push(b'Q');
    f.extend_from_slice(h.as_bytes());
    f.push(b'\n');
    f.extend_from_slice(body);
    f
}

// ---------------------------------------------------------------- setup

async fn setup(state: Arc<State>, req: Request<hyper::body::Incoming>) -> Res {
    if !bearer_ok(&state, &req) {
        return refuse(StatusCode::UNAUTHORIZED, "the runner token is required");
    }
    let (pass, raw) = match pass_of(&state, &req, Scope::Setup) {
        Ok(p) => p,
        Err(e) => return refuse(StatusCode::BAD_GATEWAY, &e),
    };
    let module = match state.modules.get(&pass.module).await {
        Ok(m) => m,
        Err(e) => return refuse(StatusCode::BAD_GATEWAY, &e.to_string()),
    };
    let t0 = Instant::now();
    let head = json!({ "m": "SETUP", "u": "/", "h": [], "env": app_env(&state, &pass), "setup": true });
    let input = request_frame(&head, &[]);
    let calls = Box::new(calls::Calls::new(
        raw,
        state.rid.fetch_add(1, Relaxed),
        None,
        state.data.clone(),
        state.fetcher.clone(),
        state.identity.clone(),
        module.files.clone(),
        t0 + state.cfg.setup_timeout,
    ));
    let (tx, rx) = oneshot::channel();
    let st = state.clone();
    let m2 = module.clone();
    let task = tokio::spawn(async move { st.runtime.run(&m2, &input, calls, st.cfg.setup_cpu_limit, st.cfg.memory_bytes, tx).await });
    let abort = task.abort_handle();
    let outcome = match tokio::time::timeout(state.cfg.setup_timeout, task).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return refuse(StatusCode::INTERNAL_SERVER_ERROR, &format!("the setup run failed: {e}")),
        Err(_) => {
            abort.abort();
            return json_reply(StatusCode::OK, json!({ "ok": false, "statements": null, "ms": round(t0.elapsed().as_secs_f64() * 1e3), "error": "the setup run took too long" }));
        }
    };
    let ms = round(t0.elapsed().as_secs_f64() * 1e3);
    let said: Option<Value> = rx.await.ok().and_then(|r| serde_json::from_slice(&r.body).ok());
    let error = outcome.error.clone().or_else(|| said.as_ref().and_then(|v| v.get("error")).and_then(|e| e.as_str()).map(str::to_string));
    let ok = error.is_none() && said.as_ref().and_then(|v| v.get("ok")).and_then(Value::as_bool).unwrap_or(false);
    let statements = outcome.calls.queries;
    let console: String = outcome.stderr.chars().take(4000).collect();
    log::info(
        "setup",
        json!({ "app": pass.app, "ses": pass.ses, "mod": short(&pass.module), "ok": ok, "statements": statements, "ms": ms, "error": error, "console": console }),
    );
    let mut v = json!({ "ok": ok, "statements": statements, "ms": ms });
    if let Some(e) = error {
        v["error"] = Value::String(e);
    }
    if !console.is_empty() {
        v["log"] = Value::String(console);
    }
    json_reply(StatusCode::OK, v)
}

// ---------------------------------------------------------------- the app's requests

fn query_param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        (k == name).then(|| percent_decode(&v.replace('+', " ")))
    })
}
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn valid_op(op: &str) -> bool {
    !op.is_empty() && op.len() <= 128 && op.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':'))
}

const HOP_BY_HOP: &[&str] = &["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "content-length"];
const RUNNER_ONLY: &[&str] = &["x-usernode-pass", "x-usernode-op", "x-usernode-test"];

async fn app_request(state: Arc<State>, req: Request<hyper::body::Incoming>, peer: SocketAddr) -> Res {
    let t0 = Instant::now();
    let (pass, raw) = match pass_of(&state, &req, Scope::Req) {
        Ok(p) => p,
        Err(e) => {
            log::warn("request refused", json!({ "reason": e, "path": req.uri().path() }));
            return refuse(StatusCode::BAD_GATEWAY, &e);
        }
    };
    let module = match state.modules.get(&pass.module).await {
        Ok(m) => m,
        Err(e) => {
            log::warn("request refused", json!({ "app": pass.app, "ses": pass.ses, "reason": e.to_string() }));
            return refuse(StatusCode::BAD_GATEWAY, &e.to_string());
        }
    };
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();
    let url = req.uri().path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| "/".into());
    let headers = req.headers();

    // Who is asking: the token the app itself would read (?token= first, then the header).
    let token = query_param(&query, "token").filter(|t| !t.is_empty()).or_else(|| headers.get("x-usernode-token").and_then(|v| v.to_str().ok()).map(str::to_string));
    let claims = token.as_deref().and_then(|t| state.identity.check_request(t, pass.app));
    let user_id = claims.as_ref().and_then(|c| c.get("id")).cloned();
    let op = headers.get("x-usernode-op").and_then(|v| v.to_str().ok()).filter(|o| valid_op(o)).map(str::to_string);
    let kill = state.cfg.test_hooks && headers.get("x-usernode-test").and_then(|v| v.to_str().ok()) == Some("kill-after-commit");
    let ip = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| peer.ip().to_string());
    let hs: Vec<(String, String)> = headers
        .iter()
        .filter(|(k, _)| !RUNNER_ONLY.contains(&k.as_str()))
        .map(|(k, v)| (k.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
        .collect();
    let body = match body_of(req, MAX_REQUEST_BODY).await {
        Ok(b) => b,
        Err(r) => return r,
    };

    // A warm instance of this app (WASM_WARM), or a fresh one.
    let mut target: Option<(u64, WarmHandle)> = None;
    if state.cfg.warm > 0 {
        let key = warm::Key::new(&pass.module, pass.app, &pass.db, &pass.env);
        match state.warm.take(&key, Instant::now()) {
            warm::Take::Warm(id, h) => target = Some((id, h)),
            warm::Take::New(id, evicted) => {
                for h in evicted {
                    h.retire();
                }
                let (jobs, rx) = mpsc::channel(1);
                let st = state.clone();
                let m2 = module.clone();
                let task = tokio::spawn(async move { st.runtime.run_warm(&m2, st.cfg.cpu_limit, st.cfg.memory_bytes, rx).await });
                let h = WarmHandle { jobs, task: task.abort_handle() };
                state.warm.attach(id, h.clone());
                target = Some((id, h));
            }
            warm::Take::Fresh => {}
        }
    }

    let mut head = json!({ "m": method.as_str(), "u": url, "h": hs, "ip": ip, "env": app_env(&state, &pass) });
    if let (Some(t), Some(c)) = (&token, &claims) {
        head["tok"] = Value::String(t.clone());
        head["claims"] = c.clone();
        head["alg"] = Value::String("RS256".into());
    }
    let mut calls = Box::new(calls::Calls::new(
        raw,
        state.rid.fetch_add(1, Relaxed),
        op,
        state.data.clone(),
        state.fetcher.clone(),
        state.identity.clone(),
        module.files.clone(),
        t0 + state.cfg.request_timeout,
    ));
    calls.kill_after_commit = kill;
    let log_base = json!({
        "app": pass.app, "ses": pass.ses, "mod": short(&pass.module), "m": method.as_str(), "path": path, "user": user_id,
    });

    // The answer comes on `rx`; when there is none, `ended` says why.
    let (tx, rx) = oneshot::channel();
    let ended: oneshot::Receiver<Option<String>>;
    let mut warm_id = None;
    let mut fresh_job: Option<(Vec<u8>, Box<calls::Calls>, oneshot::Sender<engine::Reply>)> = None;
    if let Some((id, h)) = target {
        head["warm"] = Value::Bool(true);
        let (done_tx, done_rx) = oneshot::channel();
        let job = engine::Job { input: request_frame(&head, &body), calls, cpu: state.cfg.cpu_limit, reply: tx, done: done_tx };
        match h.jobs.try_send(job) {
            Ok(()) => {
                warm_id = Some(id);
                let (err_tx, err_rx) = oneshot::channel();
                ended = err_rx;
                let st = state.clone();
                let log_base = log_base.clone();
                tokio::spawn(async move {
                    let err = match done_rx.await {
                        Ok(o) => {
                            // Sound, and its heap still under the line (it is never collected, only let go).
                            let sound = o.error.is_none() && !o.discard && o.memory < st.cfg.warm_memory_bytes;
                            log_request(log_base, t0, &o, Some(id));
                            if let Some(gone) = st.warm.give_back(id, sound, Instant::now()) {
                                gone.retire();
                            }
                            o.error
                        }
                        Err(_) => {
                            // The instance went before it reported (let go after a timeout).
                            if let Some(gone) = st.warm.remove(id) {
                                gone.retire();
                            }
                            Some("the app's instance stopped".into())
                        }
                    };
                    let _ = err_tx.send(err);
                });
            }
            Err(e) => {
                // The instance is gone: this request runs fresh.
                if let Some(gone) = state.warm.remove(id) {
                    gone.retire();
                }
                let job = match e {
                    mpsc::error::TrySendError::Full(j) | mpsc::error::TrySendError::Closed(j) => j,
                };
                head["warm"] = Value::Bool(false);
                fresh_job = Some((request_frame(&head, &body), job.calls, job.reply));
                ended = oneshot::channel().1;
            }
        }
    } else {
        fresh_job = Some((request_frame(&head, &body), calls, tx));
        ended = oneshot::channel().1;
    }
    let mut fresh_task = None;
    let ended = if let Some((input, calls, tx)) = fresh_job {
        let st = state.clone();
        let m2 = module.clone();
        let task = tokio::spawn(async move {
            let o = st.runtime.run(&m2, &input, calls, st.cfg.cpu_limit, st.cfg.memory_bytes, tx).await;
            log_request(log_base, t0, &o, None);
            o.error
        });
        fresh_task = Some(task.abort_handle());
        Ended::Task(task)
    } else {
        Ended::Rx(ended)
    };

    let r = match tokio::time::timeout(state.cfg.request_timeout, rx).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => {
            // The run ended without an answer: say why.
            let why = ended.wait().await.unwrap_or_else(|| "the app finished without answering".into());
            return refuse(StatusCode::INTERNAL_SERVER_ERROR, &why);
        }
        Err(_) => {
            if let Some(t) = fresh_task {
                t.abort();
            }
            if let Some(id) = warm_id {
                if let Some(gone) = state.warm.remove(id) {
                    gone.retire();
                }
            }
            log::warn("request timed out", json!({ "app": pass.app, "ses": pass.ses, "path": path }));
            return refuse(StatusCode::GATEWAY_TIMEOUT, "the app did not answer in time");
        }
    };
    let status = StatusCode::from_u16(r.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut res = Response::builder().status(status);
    for (k, v) in &r.headers {
        let lk = k.to_ascii_lowercase();
        if HOP_BY_HOP.contains(&lk.as_str()) {
            continue;
        }
        if let (Ok(n), Ok(v)) = (HeaderName::from_bytes(lk.as_bytes()), HeaderValue::from_str(v)) {
            res = res.header(n, v);
        }
    }
    let body = if method == Method::HEAD || status == StatusCode::NO_CONTENT || status == StatusCode::NOT_MODIFIED { Bytes::new() } else { r.body };
    res.body(Full::new(body)).unwrap_or_else(|_| refuse(StatusCode::INTERNAL_SERVER_ERROR, "the app's answer was not valid HTTP"))
}

/// How a request's run ended, for when it gave no answer.
enum Ended {
    Task(tokio::task::JoinHandle<Option<String>>),
    Rx(oneshot::Receiver<Option<String>>),
}
impl Ended {
    async fn wait(self) -> Option<String> {
        match self {
            Ended::Task(t) => t.await.ok().flatten(),
            Ended::Rx(r) => r.await.ok().flatten(),
        }
    }
}

/// One JSON line per request (fresh or warm).
fn log_request(mut line: Value, t0: Instant, o: &engine::Outcome, warm: Option<u64>) {
    line["status"] = json!(o.status);
    line["ms"] = json!(round(t0.elapsed().as_secs_f64() * 1e3));
    line["queries"] = json!(o.calls.queries);
    line["fetches"] = json!(o.calls.fetches);
    if let Some(op) = &o.calls.op {
        line["op"] = Value::String(op.clone());
    }
    if let Some(id) = warm {
        line["warm"] = json!(id);
        line["memory_mb"] = json!(round(o.memory as f64 / 1048576.0));
        if o.discard {
            line["discarded"] = Value::Bool(true);
        }
    }
    if let Some(e) = &o.error {
        line["error"] = Value::String(e.clone());
    }
    if !o.stderr.is_empty() {
        line["console"] = Value::String(o.stderr.chars().take(2000).collect());
    }
    log::line(if o.error.is_some() { "warn" } else { "info" }, "request", line);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_and_ops() {
        assert_eq!(query_param("a=1&token=x%2By&b=2", "token").as_deref(), Some("x+y"));
        assert_eq!(query_param("token=a+b", "token").as_deref(), Some("a b"));
        assert_eq!(query_param("a=1", "token"), None);
        assert_eq!(percent_decode("%zz%41"), "%zzA");
        assert!(valid_op("op_123-abc.def:1"));
        assert!(!valid_op(""));
        assert!(!valid_op("a b"));
        assert!(!valid_op(&"x".repeat(129)));
    }
}
