//! Running a module: a fresh instance per request, linked to a fresh
//! instance of the shared QuickJS plugin, talking to the host through
//! stdin/stdout frames (the guest's runtime.js), with a time limit.
//!
//! The plugin imports a handful of WASI functions, implemented here and
//! nothing more: stdin is the frames the host has for the guest, stdout is
//! the frames the guest has for the host, stderr is the app's console (kept
//! for the log), there is no environment, no file system, and the clocks
//! and randomness are the host's. When the guest reads stdin with nothing
//! left to read and a call frame waiting, the host runs the calls (queries,
//! fetches) and answers; the instance waits without holding a thread.
//!
//! A warm instance (`run_warm`, WASM_WARM) is the same, kept: after each
//! request the guest writes a 'D' frame and reads again, and that read waits
//! for the next job. Each job brings its own request frame, host-call state
//! (pass, operation ID, pinned connections), reply channel and time limit.

use crate::calls::Calls;
use crate::modules::{Files, Loaded};
use anyhow::{anyhow, Result};
use bytes::Bytes;
use ring::rand::SecureRandom;
use serde::Deserialize;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};
use wasmtime::{
    Caller, Config, Engine, Extern, InstanceAllocationStrategy, InstancePre, Linker, Module, PoolingAllocationConfig, Store, StoreLimits,
    StoreLimitsBuilder, UpdateDeadline,
};

/// The app's console kept per request, for the log.
const STDERR_MAX: usize = 16 << 10;

/// The app's answer, once it has one.
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Bytes,
}

/// How a run (or one request of a warm instance) ended.
pub struct Outcome {
    /// The status the app answered with, if it did.
    pub status: Option<u16>,
    pub error: Option<String>,
    pub stderr: String,
    pub calls: Box<Calls>,
    /// A warm instance's guest says it is not sound any more (an uncaught
    /// error, process.exit, a request it did not answer).
    pub discard: bool,
    /// The instance's memory (the QuickJS heap's linear memory) when it ended.
    pub memory: usize,
}

/// One request for a warm instance.
pub struct Job {
    /// The 'Q' frame payload.
    pub input: Vec<u8>,
    pub calls: Box<Calls>,
    pub cpu: Duration,
    pub reply: oneshot::Sender<Reply>,
    pub done: oneshot::Sender<Outcome>,
}

pub struct Ctx {
    limits: StoreLimits,
    inbox: Vec<u8>,
    inpos: usize,
    outbox: Vec<u8>,
    pending: Option<Vec<u8>>,
    reply: Option<oneshot::Sender<Reply>>,
    status: Option<u16>,
    stderr: Vec<u8>,
    calls: Option<Box<Calls>>,
    ticks: u64,
    max_ticks: u64,
    files: Arc<Files>,
    epoch_ms: u64,
    /// Warm only: where the next request comes from, and where the current one reports its end.
    jobs: Option<mpsc::Receiver<Job>>,
    done: Option<oneshot::Sender<Outcome>>,
    /// The guest's memory as last seen (it only grows).
    memory: usize,
}

#[derive(Deserialize)]
struct DoneHead {
    #[serde(default)]
    discard: bool,
}

#[derive(Deserialize)]
struct ReplyHead {
    s: u16,
    #[serde(default)]
    h: Vec<(String, String)>,
    #[serde(default)]
    f: Option<String>,
}

pub struct Runtime {
    pub engine: Engine,
    plugin: InstancePre<Ctx>,
    /// The plugin's SHA-256 (16 hex): a module is only run against the plugin it was built for.
    pub engine_id: String,
    epoch: Duration,
}

fn werr(e: wasmtime::Error) -> anyhow::Error {
    anyhow!("{e:?}")
}

impl Runtime {
    pub fn new(plugin_path: &std::path::Path, slots: u32, memory_bytes: usize, epoch: Duration) -> Result<Self> {
        let mut c = Config::new();
        c.epoch_interruption(true);
        c.memory_init_cow(true);
        let mut p = PoolingAllocationConfig::default();
        p.total_core_instances(slots * 2);
        p.total_memories(slots);
        p.total_tables(slots * 2);
        p.total_stacks(slots);
        p.max_memory_size(memory_bytes);
        p.table_elements(20_000);
        p.max_unused_warm_slots(64.min(slots));
        c.allocation_strategy(InstanceAllocationStrategy::Pooling(p));
        let engine = Engine::new(&c).map_err(werr)?;

        let bytes = std::fs::read(plugin_path).map_err(|e| anyhow!("reading the plugin {}: {e}", plugin_path.display()))?;
        let engine_id = wasm_common::sha256_hex(&bytes)[..16].to_string();
        let t = Instant::now();
        let plugin = Module::new(&engine, &bytes).map_err(werr)?;
        let mut linker = Linker::new(&engine);
        wasi(&mut linker).map_err(werr)?;
        let plugin = linker.instantiate_pre(&plugin).map_err(werr)?;
        wasm_common::log::info("plugin compiled", serde_json::json!({ "engine": engine_id, "ms": t.elapsed().as_secs_f64() * 1e3 }));

        // The clock that interrupts a guest: one tick every EPOCH_MS.
        let e2 = engine.clone();
        std::thread::Builder::new().name("epoch".into()).spawn(move || loop {
            std::thread::sleep(epoch);
            e2.increment_epoch();
        })?;
        Ok(Runtime { engine, plugin, engine_id, epoch })
    }

    /// Runs `module` with `input` (a 'Q' frame payload) on stdin. The reply
    /// goes out on `reply` as soon as the guest writes it; the run goes on
    /// to its end (work after the answer) and reports how it ended.
    pub async fn run(&self, module: &Loaded, input: &[u8], calls: Box<Calls>, cpu: Duration, memory: usize, reply: oneshot::Sender<Reply>) -> Outcome {
        let mut ctx = self.ctx(module, memory);
        ctx.inbox.extend_from_slice(&(input.len() as u32).to_le_bytes());
        ctx.inbox.extend_from_slice(input);
        ctx.reply = Some(reply);
        ctx.calls = Some(calls);
        ctx.max_ticks = ticks_for(cpu, ctx.epoch_ms);
        let mut store = self.store(ctx);
        let error = match self.start(&mut store, &module.module).await {
            Ok(()) => None,
            Err(e) => Some(describe(&e)),
        };
        let ctx = store.into_data();
        Outcome {
            status: ctx.status,
            error,
            stderr: String::from_utf8_lossy(&ctx.stderr).into_owned(),
            calls: ctx.calls.expect("calls are put back after each frame"),
            discard: false,
            memory: ctx.memory,
        }
    }

    /// A warm instance: serves the jobs that come on `jobs` until the guest
    /// stops (a trap, the time limit, it let itself go) or the channel
    /// closes. A request in progress when it stops gets its outcome, with the error.
    pub async fn run_warm(&self, module: &Loaded, cpu: Duration, memory: usize, jobs: mpsc::Receiver<Job>) {
        let mut ctx = self.ctx(module, memory);
        ctx.jobs = Some(jobs);
        // What runs before the first request is read (the guest runtime's own
        // top level) gets a request's time, as it does in a fresh instance.
        ctx.max_ticks = ticks_for(cpu, ctx.epoch_ms);
        let mut store = self.store(ctx);
        let r = self.start(&mut store, &module.module).await;
        let mut ctx = store.into_data();
        if let (Some(done), Some(calls)) = (ctx.done.take(), ctx.calls.take()) {
            let error = match r {
                Err(e) => describe(&e),
                Ok(()) => "the app's instance stopped".into(),
            };
            let _ = done.send(Outcome { status: ctx.status, error: Some(error), stderr: String::from_utf8_lossy(&ctx.stderr).into_owned(), calls, discard: true, memory: ctx.memory });
        }
    }

    fn ctx(&self, module: &Loaded, memory: usize) -> Ctx {
        Ctx {
            limits: StoreLimitsBuilder::new().memory_size(memory).instances(4).build(),
            inbox: vec![],
            inpos: 0,
            outbox: vec![],
            pending: None,
            reply: None,
            status: None,
            stderr: vec![],
            calls: None,
            ticks: 0,
            max_ticks: 1,
            files: module.files.clone(),
            epoch_ms: self.epoch.as_millis().max(1) as u64,
            jobs: None,
            done: None,
            memory: 0,
        }
    }

    fn store(&self, ctx: Ctx) -> Store<Ctx> {
        let mut store = Store::new(&self.engine, ctx);
        store.limiter(|c| &mut c.limits);
        store.set_epoch_deadline(1);
        store.epoch_deadline_callback(|mut s| {
            let d = s.data_mut();
            d.ticks += 1;
            if d.ticks > d.max_ticks {
                Err(wasmtime::Error::msg("time limit"))
            } else {
                Ok(UpdateDeadline::Yield(1))
            }
        });
        store
    }

    async fn start(&self, store: &mut Store<Ctx>, module: &Module) -> Result<()> {
        let plugin = self.plugin.instantiate_async(&mut *store).await.map_err(werr)?;
        let mut imports: Vec<Extern> = vec![];
        for i in module.imports() {
            imports.push(plugin.get_export(&mut *store, i.name()).ok_or_else(|| anyhow!("the plugin has no export {}: module built for another engine", i.name()))?);
        }
        let inst = wasmtime::Instance::new_async(&mut *store, module, &imports).await.map_err(werr)?;
        let f = inst.get_typed_func::<(), ()>(&mut *store, "_start").map_err(werr)?;
        f.call_async(&mut *store, ()).await.map_err(werr)
    }
}

fn ticks_for(cpu: Duration, epoch_ms: u64) -> u64 {
    (cpu.as_millis() as u64 / epoch_ms).max(1)
}

fn describe(e: &anyhow::Error) -> String {
    let s = format!("{e}");
    if s.contains("time limit") {
        "time limit: the app ran too long".into()
    } else if let Some(i) = s.find("exit ") {
        format!("the app exited ({})", s[i..].lines().next().unwrap_or("").trim())
    } else {
        s.lines().next().unwrap_or("").to_string()
    }
}

// ---------------------------------------------------------------- WASI, the little the plugin uses

fn mem<'a>(c: &'a mut Caller<'_, Ctx>) -> wasmtime::Result<(&'a mut [u8], &'a mut Ctx)> {
    let m = c.get_export("memory").and_then(|e| e.into_memory()).ok_or_else(|| wasmtime::Error::msg("no memory"))?;
    Ok(m.data_and_store_mut(c))
}
fn rd32(d: &[u8], p: usize) -> wasmtime::Result<usize> {
    Ok(u32::from_le_bytes(d.get(p..p + 4).ok_or_else(|| wasmtime::Error::msg("out of bounds"))?.try_into().unwrap()) as usize)
}
fn wr32(d: &mut [u8], p: usize, v: u32) -> wasmtime::Result<()> {
    d.get_mut(p..p + 4).ok_or_else(|| wasmtime::Error::msg("out of bounds"))?.copy_from_slice(&v.to_le_bytes());
    Ok(())
}

const EBADF: i32 = 8;
const ESPIPE: i32 = 70;
const EINVAL: i32 = 28;

/// Frames the guest wrote on stdout: a call frame waits for the next read;
/// the reply frame goes out at once.
fn take_frames(ctx: &mut Ctx) -> wasmtime::Result<()> {
    while ctx.outbox.len() >= 4 {
        let n = u32::from_le_bytes(ctx.outbox[0..4].try_into().unwrap()) as usize;
        if ctx.outbox.len() < 4 + n {
            break;
        }
        let payload: Vec<u8> = ctx.outbox[4..4 + n].to_vec();
        ctx.outbox.drain(..4 + n);
        match payload.first() {
            Some(b'C') => {
                if ctx.pending.is_some() {
                    return Err(wasmtime::Error::msg("guest sent two call frames without reading"));
                }
                ctx.pending = Some(payload);
            }
            Some(b'R') => {
                let nl = payload.iter().position(|&b| b == b'\n');
                let head: ReplyHead = serde_json::from_slice(&payload[1..nl.unwrap_or(payload.len())]).map_err(|e| wasmtime::Error::msg(format!("bad reply frame: {e}")))?;
                let body = match &head.f {
                    Some(f) => ctx.files.get(f).unwrap_or_default(),
                    None => nl.map(|i| Bytes::copy_from_slice(&payload[i + 1..])).unwrap_or_default(),
                };
                if let Some(tx) = ctx.reply.take() {
                    ctx.status = Some(head.s);
                    let _ = tx.send(Reply { status: head.s, headers: head.h, body });
                }
            }
            Some(b'D') => {
                // A warm request is done: its outcome goes back now; the
                // instance waits for the next request at its next read.
                let nl = payload.iter().position(|&b| b == b'\n');
                let head: DoneHead = serde_json::from_slice(&payload[1..nl.unwrap_or(payload.len())]).unwrap_or(DoneHead { discard: true });
                if let (Some(done), Some(calls)) = (ctx.done.take(), ctx.calls.take()) {
                    ctx.reply = None;
                    let stderr = std::mem::take(&mut ctx.stderr);
                    let _ = done.send(Outcome { status: ctx.status.take(), error: None, stderr: String::from_utf8_lossy(&stderr).into_owned(), calls, discard: head.discard, memory: ctx.memory });
                }
            }
            _ => return Err(wasmtime::Error::msg("guest wrote an unknown frame")),
        }
    }
    Ok(())
}

fn wasi(l: &mut Linker<Ctx>) -> wasmtime::Result<()> {
    let m = "wasi_snapshot_preview1";
    l.func_wrap(m, "fd_write", |mut c: Caller<'_, Ctx>, fd: i32, iovs: i32, n: i32, nw: i32| -> wasmtime::Result<i32> {
        if fd != 1 && fd != 2 {
            return Ok(EBADF);
        }
        let (d, ctx) = mem(&mut c)?;
        ctx.memory = d.len();
        let mut total = 0usize;
        for i in 0..n.max(0) as usize {
            let p = rd32(d, iovs as usize + i * 8)?;
            let len = rd32(d, iovs as usize + i * 8 + 4)?;
            let bytes = d.get(p..p + len).ok_or_else(|| wasmtime::Error::msg("out of bounds"))?;
            if fd == 1 {
                ctx.outbox.extend_from_slice(bytes);
            } else if ctx.stderr.len() < STDERR_MAX {
                let room = STDERR_MAX - ctx.stderr.len();
                ctx.stderr.extend_from_slice(&bytes[..len.min(room)]);
            }
            total += len;
        }
        wr32(d, nw as usize, total as u32)?;
        if fd == 1 {
            take_frames(ctx)?;
        }
        Ok(0)
    })?;
    l.func_wrap_async(m, "fd_read", |mut c: Caller<'_, Ctx>, (fd, iovs, n, nr): (i32, i32, i32, i32)| {
        Box::new(async move {
            if fd != 0 {
                return Ok(EBADF);
            }
            if c.data().inpos >= c.data().inbox.len() {
                if let Some(call) = c.data_mut().pending.take() {
                    // Run the calls with the store's data set aside, then hand the answer in.
                    let mut calls = c.data_mut().calls.take().expect("calls");
                    let answer = calls.execute(&call).await;
                    let ctx = c.data_mut();
                    ctx.calls = Some(calls);
                    ctx.inbox.clear();
                    ctx.inpos = 0;
                    ctx.inbox.extend_from_slice(&(answer.len() as u32).to_le_bytes());
                    ctx.inbox.extend_from_slice(&answer);
                } else if c.data().jobs.is_some() && c.data().done.is_none() {
                    // A warm instance between requests: wait for the next one
                    // (none: the runner let it go, and the guest reads its end).
                    let mut jobs = c.data_mut().jobs.take().expect("jobs");
                    let job = jobs.recv().await;
                    let ctx = c.data_mut();
                    ctx.jobs = Some(jobs);
                    if let Some(job) = job {
                        ctx.inbox.clear();
                        ctx.inpos = 0;
                        ctx.inbox.extend_from_slice(&(job.input.len() as u32).to_le_bytes());
                        ctx.inbox.extend_from_slice(&job.input);
                        ctx.calls = Some(job.calls);
                        ctx.reply = Some(job.reply);
                        ctx.done = Some(job.done);
                        ctx.status = None;
                        ctx.stderr.clear();
                        ctx.ticks = 0;
                        ctx.max_ticks = ticks_for(job.cpu, ctx.epoch_ms);
                    }
                }
            }
            let (d, ctx) = mem(&mut c)?;
            let mut total = 0usize;
            for i in 0..n.max(0) as usize {
                let p = rd32(d, iovs as usize + i * 8)?;
                let len = rd32(d, iovs as usize + i * 8 + 4)?;
                let k = len.min(ctx.inbox.len() - ctx.inpos);
                d.get_mut(p..p + k).ok_or_else(|| wasmtime::Error::msg("out of bounds"))?.copy_from_slice(&ctx.inbox[ctx.inpos..ctx.inpos + k]);
                ctx.inpos += k;
                total += k;
                if k < len {
                    break;
                }
            }
            wr32(d, nr as usize, total as u32)?;
            Ok::<i32, wasmtime::Error>(0)
        })
    })?;
    l.func_wrap(m, "environ_sizes_get", |mut c: Caller<'_, Ctx>, a: i32, b: i32| -> wasmtime::Result<i32> {
        let (d, _) = mem(&mut c)?;
        wr32(d, a as usize, 0)?;
        wr32(d, b as usize, 0)?;
        Ok(0)
    })?;
    l.func_wrap(m, "environ_get", |_: i32, _: i32| 0i32)?;
    l.func_wrap(m, "args_sizes_get", |mut c: Caller<'_, Ctx>, a: i32, b: i32| -> wasmtime::Result<i32> {
        let (d, _) = mem(&mut c)?;
        wr32(d, a as usize, 0)?;
        wr32(d, b as usize, 0)?;
        Ok(0)
    })?;
    l.func_wrap(m, "args_get", |_: i32, _: i32| 0i32)?;
    l.func_wrap(m, "fd_close", |_: i32| 0i32)?;
    l.func_wrap(m, "fd_seek", |_: i32, _: i64, _: i32, _: i32| ESPIPE)?;
    l.func_wrap(m, "fd_fdstat_get", |mut c: Caller<'_, Ctx>, fd: i32, p: i32| -> wasmtime::Result<i32> {
        if !(0..=2).contains(&fd) {
            return Ok(EBADF);
        }
        let (d, _) = mem(&mut c)?;
        let p = p as usize;
        let s = d.get_mut(p..p + 24).ok_or_else(|| wasmtime::Error::msg("out of bounds"))?;
        s.fill(0);
        s[0] = 2; // a character device
        Ok(0)
    })?;
    l.func_wrap(m, "fd_prestat_get", |_: i32, _: i32| EBADF)?;
    l.func_wrap(m, "fd_prestat_dir_name", |_: i32, _: i32, _: i32| EBADF)?;
    l.func_wrap(m, "sched_yield", || 0i32)?;
    l.func_wrap(m, "proc_exit", |code: i32| -> wasmtime::Result<()> { Err(wasmtime::Error::msg(format!("exit {code}"))) })?;
    l.func_wrap(m, "clock_time_get", |mut c: Caller<'_, Ctx>, id: i32, _precision: i64, p: i32| -> wasmtime::Result<i32> {
        let ns: u64 = match id {
            0 => std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0),
            1..=3 => monotonic_ns(),
            _ => return Ok(EINVAL),
        };
        let (d, _) = mem(&mut c)?;
        d.get_mut(p as usize..p as usize + 8).ok_or_else(|| wasmtime::Error::msg("out of bounds"))?.copy_from_slice(&ns.to_le_bytes());
        Ok(0)
    })?;
    l.func_wrap(m, "random_get", |mut c: Caller<'_, Ctx>, p: i32, n: i32| -> wasmtime::Result<i32> {
        let (d, _) = mem(&mut c)?;
        let s = d.get_mut(p as usize..(p as usize + n.max(0) as usize)).ok_or_else(|| wasmtime::Error::msg("out of bounds"))?;
        ring::rand::SystemRandom::new().fill(s).map_err(|_| wasmtime::Error::msg("no randomness"))?;
        Ok(0)
    })?;
    Ok(())
}

fn monotonic_ns() -> u64 {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_nanos() as u64
}
