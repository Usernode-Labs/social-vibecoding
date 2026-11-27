//! App modules: fetched by SHA-256, checked against it, compiled here, kept
//! in memory (least recently used out first, by bytes).
//!
//! A module is what `/_wasm/build` made: Javy's dynamically linked module
//! (the app's bytecode; QuickJS itself is the plugin every module shares),
//! plus two custom sections the build appends:
//!   `usernode.meta`   JSON {abi, engine, entry}: the guest protocol and the
//!                     plugin it was compiled against; a module from another
//!                     runner version is refused (rebuild it).
//!   `usernode.files`  the project's files (public/, words.json, data), as
//!                     repeated (u32 LE name length, name, u32 LE size, bytes).

use anyhow::{bail, Context, Result};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use wasmtime::{Engine, Module};

/// The guest protocol: runtime.js's ABI.
pub const ABI: u32 = 1;
pub const META_SECTION: &str = "usernode.meta";
pub const FILES_SECTION: &str = "usernode.files";

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Meta {
    pub abi: u32,
    pub engine: String,
    pub entry: String,
}

/// The project's files, by path relative to its root.
#[derive(Default)]
pub struct Files {
    files: HashMap<String, Bytes>,
    children: BTreeMap<String, BTreeSet<String>>,
    pub bytes: usize,
}

impl Files {
    pub fn from_entries(entries: Vec<(String, Bytes)>) -> Self {
        let mut f = Files::default();
        for (name, data) in entries {
            f.bytes += data.len();
            let mut dir = String::new();
            for (i, seg) in name.split('/').enumerate() {
                let path = if i == 0 { seg.to_string() } else { format!("{dir}/{seg}") };
                f.children.entry(dir.clone()).or_default().insert(seg.to_string());
                dir = path;
            }
            f.files.insert(name, data);
        }
        f
    }
    pub fn get(&self, p: &str) -> Option<Bytes> {
        self.files.get(p).cloned()
    }
    /// ("f", size) for a file, ("d", 0) for a directory.
    pub fn stat(&self, p: &str) -> Option<(&'static str, usize)> {
        if let Some(b) = self.files.get(p) {
            return Some(("f", b.len()));
        }
        if self.children.contains_key(p) {
            return Some(("d", 0));
        }
        None
    }
    pub fn list(&self, p: &str) -> Option<Vec<String>> {
        self.children.get(p).map(|s| s.iter().cloned().collect())
    }
    pub fn encode(entries: &[(String, Vec<u8>)]) -> Vec<u8> {
        let mut out = vec![];
        for (n, d) in entries {
            out.extend_from_slice(&(n.len() as u32).to_le_bytes());
            out.extend_from_slice(n.as_bytes());
            out.extend_from_slice(&(d.len() as u32).to_le_bytes());
            out.extend_from_slice(d);
        }
        out
    }
    fn decode(section: Bytes) -> Result<Vec<(String, Bytes)>> {
        let mut out = vec![];
        let mut i = 0usize;
        let rd = |i: usize| -> Result<usize> {
            Ok(u32::from_le_bytes(section.get(i..i + 4).context("truncated files section")?.try_into().unwrap()) as usize)
        };
        while i < section.len() {
            let n = rd(i)?;
            let name = std::str::from_utf8(section.get(i + 4..i + 4 + n).context("truncated files section")?)?.to_string();
            i += 4 + n;
            let d = rd(i)?;
            if i + 4 + d > section.len() {
                bail!("truncated files section");
            }
            out.push((name, section.slice(i + 4..i + 4 + d)));
            i += 4 + d;
        }
        Ok(out)
    }
}

/// Reads a LEB128 u32.
fn leb(b: &[u8], i: &mut usize) -> Result<usize> {
    let (mut v, mut shift) = (0usize, 0);
    loop {
        let x = *b.get(*i).context("truncated module")?;
        *i += 1;
        v |= ((x & 0x7f) as usize) << shift;
        if x & 0x80 == 0 {
            return Ok(v);
        }
        shift += 7;
        if shift > 28 {
            bail!("bad LEB128");
        }
    }
}

/// The custom sections of a Wasm module, by name (the last one of each name wins).
pub fn custom_sections(wasm: &Bytes) -> Result<HashMap<String, Bytes>> {
    if wasm.len() < 8 || &wasm[0..4] != b"\0asm" {
        bail!("not a Wasm module");
    }
    let mut out = HashMap::new();
    let mut i = 8;
    while i < wasm.len() {
        let id = wasm[i];
        i += 1;
        let size = leb(wasm, &mut i)?;
        let end = i.checked_add(size).filter(|e| *e <= wasm.len()).context("truncated module")?;
        if id == 0 {
            let mut j = i;
            let n = leb(wasm, &mut j)?;
            let name = std::str::from_utf8(wasm.get(j..j + n).context("truncated module")?)?.to_string();
            out.insert(name, wasm.slice(j + n..end));
        }
        i = end;
    }
    Ok(out)
}

/// Appends a custom section to a module.
pub fn append_section(wasm: &mut Vec<u8>, name: &str, payload: &[u8]) {
    fn put_leb(out: &mut Vec<u8>, mut v: usize) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                out.push(b);
                return;
            }
            out.push(b | 0x80);
        }
    }
    let mut body = vec![];
    put_leb(&mut body, name.len());
    body.extend_from_slice(name.as_bytes());
    body.extend_from_slice(payload);
    wasm.push(0);
    put_leb(wasm, body.len());
    wasm.extend_from_slice(&body);
}

pub struct Loaded {
    pub sha: String,
    pub module: Module,
    pub files: Arc<Files>,
    pub size: usize,
}

/// One fetch-and-compile that every request asking for the same module waits on.
type Loading = Arc<tokio::sync::OnceCell<Result<Arc<Loaded>, Miss>>>;

struct Entry {
    m: Arc<Loaded>,
    used: u64,
}

pub struct Store {
    engine: Engine,
    engine_id: String,
    http: reqwest::Client,
    url: Option<String>,
    token: String,
    cap: usize,
    cache: Mutex<(HashMap<String, Entry>, u64, usize)>,
    loading: tokio::sync::Mutex<HashMap<String, Loading>>,
}

#[derive(Clone)]
pub enum Miss {
    /// Not found where modules are kept.
    Unknown(String),
    /// Found but refused (wrong hash, another runner's build, not Wasm).
    Refused(String),
    /// Could not be fetched now.
    Unavailable(String),
}
impl std::fmt::Display for Miss {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Miss::Unknown(s) | Miss::Refused(s) | Miss::Unavailable(s) => write!(f, "{s}"),
        }
    }
}

impl Store {
    pub fn new(engine: Engine, engine_id: String, url: Option<String>, token: String, cap: usize) -> Result<Self> {
        let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build()?;
        Ok(Store {
            engine,
            engine_id,
            http,
            url,
            token,
            cap,
            cache: Mutex::new((HashMap::new(), 0, 0)),
            loading: tokio::sync::Mutex::new(HashMap::new()),
        })
    }

    pub fn cached(&self, sha: &str) -> Option<Arc<Loaded>> {
        let mut g = self.cache.lock().unwrap();
        g.1 += 1;
        let tick = g.1;
        g.0.get_mut(sha).map(|e| {
            e.used = tick;
            e.m.clone()
        })
    }

    pub fn stats(&self) -> (usize, usize) {
        let g = self.cache.lock().unwrap();
        (g.0.len(), g.2)
    }

    fn insert(&self, m: Arc<Loaded>) {
        let mut g = self.cache.lock().unwrap();
        g.1 += 1;
        let tick = g.1;
        let size = m.size;
        if let Some(old) = g.0.insert(m.sha.clone(), Entry { m, used: tick }) {
            g.2 -= old.m.size;
        }
        g.2 += size;
        while g.2 > self.cap && g.0.len() > 1 {
            let victim = g.0.iter().min_by_key(|(_, e)| e.used).map(|(k, _)| k.clone()).unwrap();
            if let Some(e) = g.0.remove(&victim) {
                g.2 -= e.m.size;
            }
        }
    }

    /// Checks and compiles a module's bytes (named by their SHA-256).
    pub fn load(&self, wasm: Bytes) -> Result<Arc<Loaded>, Miss> {
        let sha = wasm_common::sha256_hex(&wasm);
        let sections = custom_sections(&wasm).map_err(|e| Miss::Refused(format!("module {sha}: {e}")))?;
        let meta: Meta = sections
            .get(META_SECTION)
            .and_then(|b| serde_json::from_slice(b).ok())
            .ok_or_else(|| Miss::Refused(format!("module {sha} was not built by a Wasm runner")))?;
        if meta.abi != ABI || meta.engine != self.engine_id {
            return Err(Miss::Refused(format!(
                "module {sha} was built for another runner version (abi {}, engine {}; this runner: abi {ABI}, engine {}): build it again",
                meta.abi, meta.engine, self.engine_id
            )));
        }
        let files = match sections.get(FILES_SECTION) {
            Some(s) => Files::from_entries(Files::decode(s.clone()).map_err(|e| Miss::Refused(format!("module {sha}: {e}")))?),
            None => Files::default(),
        };
        let module = Module::new(&self.engine, &wasm).map_err(|e| Miss::Refused(format!("module {sha} does not compile: {e}")))?;
        // The files are slices of the module's bytes; the compiled code comes on top.
        let image = module.image_range();
        let size = wasm.len() + (image.end as usize - image.start as usize);
        let m = Arc::new(Loaded { sha, module, files: Arc::new(files), size });
        self.insert(m.clone());
        Ok(m)
    }

    /// The module named `sha`: from memory, or fetched, checked and compiled
    /// (once, however many requests ask at the same time).
    pub async fn get(&self, sha: &str) -> Result<Arc<Loaded>, Miss> {
        if let Some(m) = self.cached(sha) {
            return Ok(m);
        }
        let cell = {
            let mut l = self.loading.lock().await;
            l.entry(sha.to_string()).or_insert_with(|| Arc::new(tokio::sync::OnceCell::new())).clone()
        };
        let r = cell
            .get_or_init(|| async {
                let t0 = Instant::now();
                let r = self.fetch(sha).await;
                if let Ok(m) = &r {
                    wasm_common::log::info("module loaded", serde_json::json!({ "mod": sha, "bytes": m.size, "ms": t0.elapsed().as_secs_f64() * 1e3 }));
                }
                r
            })
            .await
            .clone();
        self.loading.lock().await.remove(sha);
        r
    }

    async fn fetch(&self, sha: &str) -> Result<Arc<Loaded>, Miss> {
        let Some(base) = &self.url else {
            return Err(Miss::Unknown(format!("unknown module {sha}")));
        };
        let res = self
            .http
            .get(format!("{base}/{sha}"))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| Miss::Unavailable(format!("fetching module {sha}: {e}")))?;
        match res.status().as_u16() {
            200 => {}
            404 => return Err(Miss::Unknown(format!("unknown module {sha}"))),
            s => return Err(Miss::Unavailable(format!("fetching module {sha}: status {s}"))),
        }
        let bytes = res.bytes().await.map_err(|e| Miss::Unavailable(format!("fetching module {sha}: {e}")))?;
        let got = wasm_common::sha256_hex(&bytes);
        if got != sha {
            return Err(Miss::Refused(format!("module {sha}: the bytes fetched hash to {got}")));
        }
        let store = self;
        // Compiling is CPU work; keep it off the threads serving requests.
        let engine_bytes = bytes.clone();
        tokio::task::block_in_place(|| store.load(engine_bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sections_round_trip() {
        let mut wasm = b"\0asm\x01\0\0\0".to_vec();
        let files = Files::encode(&[("public/index.html".into(), b"<p>hi</p>".to_vec()), ("words.json".into(), b"{}".to_vec())]);
        append_section(&mut wasm, FILES_SECTION, &files);
        append_section(&mut wasm, META_SECTION, br#"{"abi":1,"engine":"x","entry":"server.js"}"#);
        let s = custom_sections(&Bytes::from(wasm)).unwrap();
        let meta: Meta = serde_json::from_slice(&s[META_SECTION]).unwrap();
        assert_eq!(meta.entry, "server.js");
        let f = Files::from_entries(Files::decode(s[FILES_SECTION].clone()).unwrap());
        assert_eq!(f.get("public/index.html").unwrap().as_ref(), b"<p>hi</p>");
        assert_eq!(f.stat("public"), Some(("d", 0)));
        assert_eq!(f.stat("words.json"), Some(("f", 2)));
        assert_eq!(f.stat("nope"), None);
        assert_eq!(f.list("").unwrap(), vec!["public".to_string(), "words.json".to_string()]);
        assert_eq!(f.list("public").unwrap(), vec!["index.html".to_string()]);
    }

    fn module(engine_id: &str, filler: usize) -> Bytes {
        let mut wasm = b"\0asm\x01\0\0\0".to_vec();
        append_section(&mut wasm, FILES_SECTION, &Files::encode(&[("f".into(), vec![1u8; filler])]));
        append_section(&mut wasm, META_SECTION, format!(r#"{{"abi":{ABI},"engine":"{engine_id}","entry":"server.js"}}"#).as_bytes());
        Bytes::from(wasm)
    }

    #[test]
    fn least_recently_used_goes_first() {
        let one = Store::new(Engine::default(), "e1".into(), None, "t".into(), 1 << 20).unwrap().load(module("e1", 1000)).ok().unwrap().size;
        // Room for two modules, not three.
        let store = Store::new(Engine::default(), "e1".into(), None, "t".into(), one * 5 / 2).unwrap();
        let a = store.load(module("e1", 1000)).ok().unwrap().sha.clone();
        let b = store.load(module("e1", 1001)).ok().unwrap().sha.clone();
        assert!(store.cached(&a).is_some()); // a is now the most recently used
        let c = store.load(module("e1", 1002)).ok().unwrap().sha.clone();
        assert!(store.cached(&b).is_none(), "b was used least recently");
        assert!(store.cached(&a).is_some() && store.cached(&c).is_some());
        assert_eq!(store.stats().0, 2);
    }

    #[test]
    fn refuses_other_engines_and_strangers() {
        let store = Store::new(Engine::default(), "e1".into(), None, "t".into(), 1 << 20).unwrap();
        assert!(matches!(store.load(module("e2", 10)), Err(Miss::Refused(_))));
        assert!(matches!(store.load(Bytes::from_static(b"\0asm\x01\0\0\0")), Err(Miss::Refused(_))));
        assert!(matches!(store.load(Bytes::from_static(b"not wasm")), Err(Miss::Refused(_))));
    }

    #[tokio::test]
    async fn unknown_without_an_endpoint() {
        let store = Store::new(Engine::default(), "e1".into(), None, "t".into(), 1 << 20).unwrap();
        assert!(matches!(store.get(&"0".repeat(64)).await, Err(Miss::Unknown(_))));
    }

    #[test]
    fn long_sections() {
        let mut wasm = b"\0asm\x01\0\0\0".to_vec();
        let big = vec![7u8; 300_000];
        append_section(&mut wasm, "x", &big);
        let s = custom_sections(&Bytes::from(wasm)).unwrap();
        assert_eq!(s["x"].len(), 300_000);
    }
}
