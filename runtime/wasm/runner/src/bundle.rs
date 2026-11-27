//! `POST /_wasm/build`: a commit's tree (gzip tar) in, a module out.
//!
//! 1. Unpack into a temporary directory (regular files only; no absolute
//!    paths, no `..`, no links; at most 100 MiB and 20,000 entries). A tree
//!    wrapped in one top directory is unwrapped.
//! 2. Find the server entry: server.js, else package.json's main.
//! 3. Give each source file its own __dirname and __filename (the bundle
//!    is one file; the project lives at /app as in its container).
//! 4. Bundle with esbuild: the entry and everything it requires, with
//!    express, pg, jsonwebtoken and Node's modules pointed at the adapters
//!    (guest/aliases.json); async functions lowered to generators over the
//!    guest's Promise. A package nothing covers fails here, by name.
//! 5. Compile with Javy against the image's plugin (dynamic linking: the
//!    module is the app's bytecode only).
//! 6. Append the project's files (public/, words.json, data) and the
//!    module's meta as custom sections, and compile it here once to check
//!    it (and keep it: this runner can serve it at once).
//!
//! Answers the module with its SHA-256, or 422 with the reason.

use crate::modules::{self, Files, Meta};
use anyhow::{anyhow, Context, Result};
use bytes::Bytes;
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

const MAX_UNPACKED: u64 = 100 << 20;
const MAX_ENTRIES: usize = 20_000;
const MAX_FILES_BYTES: usize = 50 << 20;
const ENTRY_NAME: &str = "__usernode_entry.js";

/// Node's own modules: when one of these is missing, the message says so.
const NODE_BUILTINS: &[&str] = &[
    "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto", "dgram", "diagnostics_channel", "dns",
    "domain", "events", "fs", "http", "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode",
    "querystring", "readline", "repl", "stream", "string_decoder", "sys", "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm",
    "wasi", "worker_threads", "zlib", "sqlite", "test",
];

pub enum BuildError {
    /// The project cannot be built (422): the reason, for people.
    Refused(String),
    /// The runner failed (500).
    Failed(String),
}

pub struct Built {
    pub wasm: Vec<u8>,
    pub sha: String,
    pub ms: f64,
    pub bundle_bytes: usize,
    pub files_bytes: usize,
}

pub struct Builder {
    pub guest_dir: PathBuf,
    pub plugin: PathBuf,
    pub javy: PathBuf,
    pub esbuild: PathBuf,
    pub work_dir: PathBuf,
    pub timeout: Duration,
    pub engine_id: String,
    aliases: Vec<(String, PathBuf)>,
    permits: tokio::sync::Semaphore,
}

impl Builder {
    #[allow(clippy::too_many_arguments)]
    pub fn new(guest_dir: PathBuf, plugin: PathBuf, javy: PathBuf, esbuild: PathBuf, work_dir: PathBuf, timeout: Duration, engine_id: String, concurrency: usize) -> Result<Self> {
        let table: BTreeMap<String, serde_json::Value> = serde_json::from_slice(&std::fs::read(guest_dir.join("aliases.json")).context("reading guest/aliases.json")?)?;
        let mut aliases = vec![];
        for (k, v) in table {
            if k.starts_with("//") {
                continue;
            }
            let p = guest_dir.join(v.as_str().context("aliases.json values are paths")?);
            if !p.is_file() {
                return Err(anyhow!("aliases.json names {} which is not there", p.display()));
            }
            if NODE_BUILTINS.contains(&k.as_str()) || NODE_BUILTINS.iter().any(|b| k.starts_with(&format!("{b}/"))) {
                aliases.push((format!("node:{k}"), p.clone()));
            }
            aliases.push((k, p));
        }
        if !guest_dir.join("runtime.js").is_file() {
            return Err(anyhow!("{} has no runtime.js", guest_dir.display()));
        }
        Ok(Builder { guest_dir, plugin, javy, esbuild, work_dir, timeout, engine_id, aliases, permits: tokio::sync::Semaphore::new(concurrency) })
    }

    fn covered(&self) -> String {
        let mut names: Vec<&str> = self.aliases.iter().map(|(k, _)| k.as_str()).filter(|k| !k.starts_with("node:") && !NODE_BUILTINS.contains(k) && !k.contains('/')).collect();
        names.sort();
        names.join(", ")
    }

    pub async fn build(&self, tar_gz: Bytes, store: &modules::Store) -> Result<Built, BuildError> {
        let _permit = self.permits.acquire().await.map_err(|_| BuildError::Failed("shutting down".into()))?;
        let t0 = Instant::now();
        let deadline = t0 + self.timeout;
        let dir = tempfile::Builder::new().prefix("wasm-build-").tempdir_in(&self.work_dir).map_err(|e| BuildError::Failed(format!("temporary directory: {e}")))?;
        let work = dir.path().to_path_buf();

        // Unpack and prepare (file system work, off the async threads).
        let w2 = work.clone();
        let runtime_js = self.guest_dir.join("runtime.js");
        let prepared = tokio::task::spawn_blocking(move || prepare(&tar_gz, &w2, &runtime_js))
            .await
            .map_err(|e| BuildError::Failed(e.to_string()))??;

        // Bundle.
        let mut args: Vec<String> = vec![
            ENTRY_NAME.into(),
            "--bundle".into(),
            "--format=iife".into(),
            "--platform=neutral".into(),
            "--target=es2022".into(),
            "--supported:async-await=false".into(),
            "--supported:async-generator=false".into(),
            "--supported:for-await=false".into(),
            "--supported:top-level-await=false".into(),
            "--main-fields=main,module".into(),
            "--resolve-extensions=.js,.cjs,.mjs,.json".into(),
            "--charset=utf8".into(),
            "--legal-comments=none".into(),
            "--minify-whitespace".into(),
            "--minify-syntax".into(),
            "--log-level=error".into(),
            "--color=false".into(),
            format!("--outfile={}", work.join("bundle.js").display()),
        ];
        for (k, v) in &self.aliases {
            args.push(format!("--alias:{k}={}", v.display()));
        }
        let out = run(&self.esbuild, &args, &prepared.root, deadline).await?;
        if !out.ok {
            return Err(BuildError::Refused(self.esbuild_reason(&out.stderr, &work)));
        }
        let bundle_bytes = std::fs::metadata(work.join("bundle.js")).map(|m| m.len() as usize).unwrap_or(0);

        // Compile.
        let args: Vec<String> = vec![
            "build".into(),
            "-C".into(),
            "dynamic=y".into(),
            "-C".into(),
            format!("plugin={}", self.plugin.display()),
            "-C".into(),
            "source=omitted".into(),
            "-o".into(),
            work.join("app.wasm").display().to_string(),
            work.join("bundle.js").display().to_string(),
        ];
        let out = run(&self.javy, &args, &work, deadline).await?;
        if !out.ok {
            return Err(BuildError::Refused(format!("the bundle did not compile: {}", clean(&out.stderr, &work))));
        }
        let mut wasm = std::fs::read(work.join("app.wasm")).map_err(|e| BuildError::Failed(format!("reading the module: {e}")))?;
        let files_bytes: usize = prepared.files.iter().map(|(_, d)| d.len()).sum();
        modules::append_section(&mut wasm, modules::FILES_SECTION, &Files::encode(&prepared.files));
        let meta = Meta { abi: modules::ABI, engine: self.engine_id.clone(), entry: prepared.entry.clone() };
        modules::append_section(&mut wasm, modules::META_SECTION, &serde_json::to_vec(&meta).unwrap());
        let sha = wasm_common::sha256_hex(&wasm);
        let bytes = Bytes::from(wasm.clone());
        tokio::task::block_in_place(|| store.load(bytes)).map_err(|e| BuildError::Failed(format!("the built module does not load: {e}")))?;
        Ok(Built { wasm, sha, ms: t0.elapsed().as_secs_f64() * 1e3, bundle_bytes, files_bytes })
    }

    /// esbuild's errors, as a person would want them.
    fn esbuild_reason(&self, stderr: &str, work: &Path) -> String {
        let mut missing: Vec<String> = vec![];
        for line in stderr.lines() {
            if let Some(i) = line.find("Could not resolve \"") {
                let rest = &line[i + 19..];
                if let Some(j) = rest.find('"') {
                    let name = &rest[..j];
                    if !missing.iter().any(|m| m == name) {
                        missing.push(name.to_string());
                    }
                }
            }
        }
        if !missing.is_empty() {
            let parts: Vec<String> = missing
                .iter()
                .map(|m| {
                    let base = m.trim_start_matches("node:");
                    let top = base.split('/').next().unwrap_or(base);
                    if m.starts_with('.') || m.starts_with('/') {
                        format!("the file {m} is not in the project")
                    } else if NODE_BUILTINS.contains(&top) {
                        format!("the Node module {base} is not available in Wasm previews")
                    } else {
                        let pkg = if base.starts_with('@') { base.splitn(3, '/').take(2).collect::<Vec<_>>().join("/") } else { top.to_string() };
                        format!("the npm package {pkg} is not covered by the adapters")
                    }
                })
                .collect();
            return format!("{} (covered: {})", parts.join("; "), self.covered());
        }
        format!("the server code did not bundle: {}", clean(stderr, work))
    }
}

struct Prepared {
    root: PathBuf,
    entry: String,
    files: Vec<(String, Vec<u8>)>,
}

/// Unpacks, finds the entry, rewrites __dirname, writes the bundle's entry, collects the files.
fn prepare(tar_gz: &[u8], work: &Path, runtime_js: &Path) -> Result<Prepared, BuildError> {
    let src = work.join("src");
    std::fs::create_dir_all(&src).map_err(|e| BuildError::Failed(e.to_string()))?;
    unpack(tar_gz, &src)?;
    let mut root = src.clone();
    if !root.join("package.json").exists() && !root.join("server.js").exists() {
        let dirs: Vec<PathBuf> = std::fs::read_dir(&root).map_err(|e| BuildError::Failed(e.to_string()))?.flatten().map(|e| e.path()).collect();
        if dirs.len() == 1 && dirs[0].is_dir() {
            root = dirs[0].clone();
        }
    }
    let entry = if root.join("server.js").is_file() {
        "server.js".to_string()
    } else {
        let main = std::fs::read(root.join("package.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .and_then(|v| v.get("main").and_then(|m| m.as_str()).map(str::to_string))
            .ok_or_else(|| BuildError::Refused("no server entry: the project has no server.js and package.json names no main".into()))?;
        let main = main.trim_start_matches("./").to_string();
        let candidates = [main.clone(), format!("{main}.js"), format!("{main}/index.js")];
        candidates
            .into_iter()
            .find(|c| safe_rel(Path::new(c)) && root.join(c).is_file())
            .ok_or_else(|| BuildError::Refused(format!("package.json's main ({main}) is not a file in the project")))?
    };

    let mut files = vec![];
    let mut total = 0usize;
    walk(&root, &root, &mut |rel: &str, path: &Path| -> Result<(), BuildError> {
        let is_source = [".js", ".cjs", ".mjs"].iter().any(|x| rel.ends_with(x));
        if is_source && !rel.starts_with("public/") {
            give_dirname(path, rel).map_err(|e| BuildError::Failed(e.to_string()))?;
        }
        if bundled(rel) {
            let data = std::fs::read(path).map_err(|e| BuildError::Failed(e.to_string()))?;
            total += data.len();
            if total > MAX_FILES_BYTES {
                return Err(BuildError::Refused(format!("the project's files are over {} MiB", MAX_FILES_BYTES >> 20)));
            }
            files.push((rel.to_string(), data));
        }
        Ok(())
    })?;
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let entry_js = format!(
        "// Generated by the Wasm runner's build.\nconst runtime = require({});\nruntime.run(() => require({}));\n",
        serde_json::to_string(&runtime_js.display().to_string()).unwrap(),
        serde_json::to_string(&format!("./{entry}")).unwrap()
    );
    std::fs::write(root.join(ENTRY_NAME), entry_js).map_err(|e| BuildError::Failed(e.to_string()))?;
    Ok(Prepared { root, entry, files })
}

fn safe_rel(p: &Path) -> bool {
    !p.as_os_str().is_empty() && p.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

fn unpack(tar_gz: &[u8], dest: &Path) -> Result<(), BuildError> {
    let refused = |e: std::io::Error| BuildError::Refused(format!("the source is not a gzip tar: {e}"));
    let mut ar = tar::Archive::new(flate2::read::GzDecoder::new(tar_gz));
    let mut total = 0u64;
    let mut count = 0usize;
    for entry in ar.entries().map_err(refused)? {
        let mut e = entry.map_err(refused)?;
        count += 1;
        if count > MAX_ENTRIES {
            return Err(BuildError::Refused(format!("the source has over {MAX_ENTRIES} entries")));
        }
        let kind = e.header().entry_type();
        if !kind.is_file() {
            // Directories are made as needed; links and devices are left out.
            continue;
        }
        let path = e.path().map_err(refused)?.into_owned();
        if !safe_rel(&path) {
            return Err(BuildError::Refused(format!("the source has an unsafe path: {}", path.display())));
        }
        let size = e.header().size().map_err(refused)?;
        total += size;
        if total > MAX_UNPACKED {
            return Err(BuildError::Refused(format!("the source unpacks to over {} MiB", MAX_UNPACKED >> 20)));
        }
        let out = dest.join(&path);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| BuildError::Failed(e.to_string()))?;
        }
        let mut data = Vec::with_capacity(size as usize);
        (&mut e).take(size).read_to_end(&mut data).map_err(refused)?;
        std::fs::write(&out, data).map_err(|e| BuildError::Failed(e.to_string()))?;
    }
    Ok(())
}

/// Which files go into the module: everything but dotfiles, dependencies,
/// lockfiles, documents and build recipes.
fn bundled(rel: &str) -> bool {
    if rel == ENTRY_NAME || rel.split('/').any(|s| s.starts_with('.')) || rel.starts_with("node_modules/") {
        return false;
    }
    let name = rel.rsplit('/').next().unwrap_or(rel);
    !(name == "package-lock.json"
        || name.ends_with(".md")
        || name.starts_with("LICENSE")
        || name.starts_with("Dockerfile")
        || name == "project.toml"
        || name == "yarn.lock"
        || name == "pnpm-lock.yaml")
}

fn walk(root: &Path, dir: &Path, f: &mut dyn FnMut(&str, &Path) -> Result<(), BuildError>) -> Result<(), BuildError> {
    let mut entries: Vec<_> = std::fs::read_dir(dir).map_err(|e| BuildError::Failed(e.to_string()))?.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if name == "node_modules" || name == ".git" {
            continue;
        }
        let ft = e.file_type().map_err(|e| BuildError::Failed(e.to_string()))?;
        if ft.is_dir() {
            walk(root, &p, f)?;
        } else if ft.is_file() {
            let rel = p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            f(&rel, &p)?;
        }
    }
    Ok(())
}

/// Puts `var __dirname = "/app/<dir>", __filename = "/app/<file>";` at the
/// top of a source file that uses them, after a "use strict" directive (on
/// the same line, so line numbers stay).
fn give_dirname(path: &Path, rel: &str) -> std::io::Result<()> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => return Ok(()),
    };
    if !text.contains("__dirname") && !text.contains("__filename") {
        return Ok(());
    }
    let dir = match rel.rfind('/') {
        Some(i) => format!("/app/{}", &rel[..i]),
        None => "/app".to_string(),
    };
    let decl = format!(
        "var __dirname = {}, __filename = {};",
        serde_json::to_string(&dir).unwrap(),
        serde_json::to_string(&format!("/app/{rel}")).unwrap()
    );
    let at = after_prologue(&text);
    let sep = if at > 0 { " " } else { "" };
    std::fs::write(path, format!("{}{sep}{decl}{}", &text[..at], &text[at..]))
}

/// Where code may be inserted without changing a file's meaning: after a
/// shebang line and a leading "use strict" directive.
fn after_prologue(text: &str) -> usize {
    let b = text.as_bytes();
    let mut i = 0;
    if text.starts_with("#!") {
        i = text.find('\n').map(|n| n + 1).unwrap_or(text.len());
    }
    let start = i;
    // Skip whitespace and comments.
    loop {
        while i < b.len() && (b[i] as char).is_ascii_whitespace() {
            i += 1;
        }
        if text[i..].starts_with("//") {
            i = text[i..].find('\n').map(|n| i + n + 1).unwrap_or(b.len());
        } else if text[i..].starts_with("/*") {
            i = text[i..].find("*/").map(|n| i + n + 2).unwrap_or(b.len());
        } else {
            break;
        }
    }
    for d in ["'use strict'", "\"use strict\""] {
        if text[i..].starts_with(d) {
            let mut j = i + d.len();
            while j < b.len() && (b[j] == b' ' || b[j] == b'\t') {
                j += 1;
            }
            if j < b.len() && b[j] == b';' {
                j += 1;
            }
            return j;
        }
    }
    start
}

struct Ran {
    ok: bool,
    stderr: String,
}

async fn run(program: &Path, args: &[String], cwd: &Path, deadline: Instant) -> Result<Ran, BuildError> {
    let left = deadline.saturating_duration_since(Instant::now());
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("HOME", cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = cmd.spawn().map_err(|e| BuildError::Failed(format!("starting {}: {e}", program.display())))?;
    match tokio::time::timeout(left, child.wait_with_output()).await {
        Ok(Ok(o)) => {
            let mut stderr = String::from_utf8_lossy(&o.stderr).into_owned();
            if stderr.trim().is_empty() {
                stderr = String::from_utf8_lossy(&o.stdout).into_owned();
            }
            Ok(Ran { ok: o.status.success(), stderr })
        }
        Ok(Err(e)) => Err(BuildError::Failed(format!("running {}: {e}", program.display()))),
        Err(_) => Err(BuildError::Refused("the build took too long".into())),
    }
}

/// Tool output without the build directory's paths, cut to a readable length.
fn clean(s: &str, work: &Path) -> String {
    let w = work.display().to_string();
    let mut out: String = s.replace(&format!("{w}/src/"), "").replace(&w, "").lines().filter(|l| !l.trim().is_empty()).take(20).collect::<Vec<_>>().join("\n");
    if out.len() > 2000 {
        out.truncate(2000);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prologue() {
        assert_eq!(after_prologue("'use strict';\nconst a = 1;"), 13);
        assert_eq!(after_prologue("// hi\n\"use strict\"\nx"), 18);
        assert_eq!(after_prologue("const a = __dirname;"), 0);
        assert_eq!(after_prologue("#!/usr/bin/env node\nx"), 20);
        assert_eq!(after_prologue("/* c */ 'use strict'; x"), 21);
    }

    #[test]
    fn which_files() {
        assert!(bundled("public/index.html"));
        assert!(bundled("words.json"));
        assert!(bundled("data/countries.json"));
        assert!(!bundled(".env"));
        assert!(!bundled(".claude/settings.json"));
        assert!(!bundled("README.md"));
        assert!(!bundled("package-lock.json"));
        assert!(!bundled("node_modules/x/index.js"));
        assert!(!bundled("LICENSE"));
    }

    #[test]
    fn safe_paths() {
        assert!(safe_rel(Path::new("a/b.js")));
        assert!(safe_rel(Path::new("./a")));
        assert!(!safe_rel(Path::new("../a")));
        assert!(!safe_rel(Path::new("/etc/passwd")));
        assert!(!safe_rel(Path::new("a/../../b")));
    }
}
