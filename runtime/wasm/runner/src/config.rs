//! The runner's configuration, all from the environment.

use anyhow::{bail, Context, Result};
use std::path::PathBuf;
use std::time::Duration;

pub struct Config {
    pub port: u16,
    pub pass_pubkey: String,
    pub runner_token: String,
    /// Where modules are fetched by hash (`GET {url}/<sha256>`); None: only modules built here.
    pub module_url: Option<String>,
    pub data_addr: String,
    pub jwt_public_key: Option<String>,
    pub guest_jwt_public_key: Option<String>,
    pub workers: usize,
    pub epoch: Duration,
    pub test_hooks: bool,
    /// Running time a request may use (Wasm executing, not waiting on I/O).
    pub cpu_limit: Duration,
    pub setup_cpu_limit: Duration,
    /// Wall-clock limit for a request, and for a setup run.
    pub request_timeout: Duration,
    pub setup_timeout: Duration,
    pub memory_bytes: usize,
    pub slots: u32,
    pub module_cache_bytes: usize,
    pub guest_dir: PathBuf,
    pub plugin: PathBuf,
    pub javy: PathBuf,
    pub esbuild: PathBuf,
    pub build_dir: PathBuf,
    pub build_concurrency: usize,
    pub build_timeout: Duration,
    pub fetch_allow_private: bool,
    pub fetch_timeout: Duration,
    /// A PEM bundle an app's outside calls trust besides the usual roots (tests only).
    pub fetch_extra_ca: Option<PathBuf>,
    /// USERNODE_ENV as the app sees it.
    pub app_env: String,
    /// Warm instances (0: a fresh instance per request): each recycled after this many requests.
    pub warm: u32,
    pub warm_idle: Duration,
    pub warm_max: usize,
    pub warm_per_module: usize,
    /// A warm instance whose memory has grown past this is let go after its
    /// request (the plugin's QuickJS collects no cycles, so a heap only grows).
    pub warm_memory_bytes: usize,
}

fn var(k: &str) -> Option<String> {
    std::env::var(k).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}
fn num<T: std::str::FromStr>(k: &str, d: T) -> Result<T> {
    match var(k) {
        None => Ok(d),
        Some(v) => v.parse().ok().with_context(|| format!("{k} must be a number, got {v:?}")),
    }
}
/// A PEM from the environment, with `\n` written as two characters accepted too.
fn pem(k: &str) -> Option<String> {
    std::env::var(k).ok().map(|v| v.replace("\\n", "\n")).filter(|v| v.contains("-----BEGIN"))
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let epoch_ms: u64 = num("EPOCH_MS", 10)?;
        if epoch_ms == 0 {
            bail!("EPOCH_MS must be at least 1");
        }
        Ok(Config {
            port: num("PORT", 3000)?,
            pass_pubkey: var("WASM_PASS_PUBKEY").context("WASM_PASS_PUBKEY is not set")?,
            runner_token: var("WASM_RUNNER_TOKEN").context("WASM_RUNNER_TOKEN is not set")?,
            module_url: var("WASM_MODULE_URL").map(|u| u.trim_end_matches('/').to_string()),
            data_addr: var("WASM_DATA_ADDR").context("WASM_DATA_ADDR is not set")?,
            jwt_public_key: pem("USERNODE_JWT_PUBLIC_KEY"),
            guest_jwt_public_key: pem("USERNODE_GUEST_JWT_PUBLIC_KEY"),
            workers: num("WORKERS", std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2))?.max(1),
            epoch: Duration::from_millis(epoch_ms),
            test_hooks: var("WASM_TEST_HOOKS").as_deref() == Some("1"),
            cpu_limit: Duration::from_millis(num("WASM_CPU_MS", 2_000)?),
            setup_cpu_limit: Duration::from_millis(num("WASM_SETUP_CPU_MS", 60_000)?),
            request_timeout: Duration::from_millis(num("WASM_REQUEST_TIMEOUT_MS", 30_000)?),
            setup_timeout: Duration::from_millis(num("WASM_SETUP_TIMEOUT_MS", 240_000)?),
            memory_bytes: num::<usize>("WASM_MEMORY_MB", 64)? << 20,
            slots: num("WASM_SLOTS", 256)?,
            module_cache_bytes: num::<usize>("WASM_MODULE_CACHE_MB", 512)? << 20,
            guest_dir: var("WASM_GUEST_DIR").unwrap_or_else(|| "/opt/wasm/guest".into()).into(),
            plugin: var("WASM_PLUGIN").unwrap_or_else(|| "/opt/wasm/plugin.wasm".into()).into(),
            javy: var("WASM_JAVY").unwrap_or_else(|| "/usr/local/bin/javy".into()).into(),
            esbuild: var("WASM_ESBUILD").unwrap_or_else(|| "/usr/local/bin/esbuild".into()).into(),
            build_dir: var("WASM_BUILD_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir),
            build_concurrency: num("WASM_BUILD_CONCURRENCY", 2)?.max(1),
            build_timeout: Duration::from_millis(num("WASM_BUILD_TIMEOUT_MS", 120_000)?),
            fetch_allow_private: var("WASM_FETCH_ALLOW_PRIVATE").as_deref() == Some("1"),
            fetch_timeout: Duration::from_millis(num("WASM_FETCH_TIMEOUT_MS", 30_000)?),
            fetch_extra_ca: var("WASM_FETCH_EXTRA_CA").map(PathBuf::from),
            app_env: var("WASM_APP_ENV").unwrap_or_else(|| "staging".into()),
            warm: num("WASM_WARM", 0)?,
            warm_idle: Duration::from_millis(num("WASM_WARM_IDLE_MS", 60_000)?),
            warm_max: num("WASM_WARM_MAX", 200)?,
            warm_per_module: num("WASM_WARM_PER_MODULE", 1)?,
            warm_memory_bytes: match var("WASM_WARM_MEMORY_MB") {
                Some(_) => num::<usize>("WASM_WARM_MEMORY_MB", 32)? << 20,
                None => (num::<usize>("WASM_MEMORY_MB", 64)? << 20) / 2,
            },
        })
    }
}
