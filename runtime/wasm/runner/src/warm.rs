//! Warm instances (WASM_WARM=N > 0, opt-in): an instance kept after its
//! request for the next requests of the same app, so the app's globals (a
//! cache, data it parsed) last as they do in its container. Off by default:
//! every request then gets a fresh instance, as before.
//!
//! The rules this pool keeps:
//! - An instance is bound to one module, one app, one database and one
//!   environment (the pass's `env`), and only ever serves requests that
//!   name all four.
//! - It serves one request at a time. A request that finds every instance
//!   of its key busy, or the key at WASM_WARM_PER_MODULE, gets a fresh
//!   instance: nobody waits for a warm one.
//! - It is let go after N requests (recycled), after WASM_WARM_IDLE_MS
//!   unused, when the runner holds WASM_WARM_MAX and needs room (least
//!   recently used first), and at once after a request that went wrong (a
//!   trap, the time limit, memory, an uncaught error, process.exit).
//!
//! The pool holds handles of any type; letting go of one is the caller's
//! (it returns them), so the rules are tested here without Wasm.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// What an instance is bound to.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct Key {
    pub module: String,
    pub app: u64,
    pub db: String,
    /// A fingerprint of the pass's `env` (values the app may read at boot).
    pub env: u64,
}

impl Key {
    pub fn new(module: &str, app: u64, db: &str, env: &Option<std::collections::BTreeMap<String, String>>) -> Self {
        let mut h = DefaultHasher::new();
        env.hash(&mut h);
        Key { module: module.to_string(), app, db: db.to_string(), env: h.finish() }
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    /// Requests an instance serves before it is let go.
    pub recycle_after: u32,
    pub idle: Duration,
    pub max: usize,
    pub per_module: usize,
}

struct Entry<H> {
    key: Key,
    /// None while the instance is being made.
    handle: Option<H>,
    busy: bool,
    served: u32,
    last: Instant,
}

/// What a request gets.
pub enum Take<H> {
    /// A warm instance of its key, now busy with it.
    Warm(u64, H),
    /// No free instance, but room for one: make it and `attach` it. The
    /// handles are instances let go to make room.
    New(u64, Vec<H>),
    /// A fresh instance, as when warm instances are off.
    Fresh,
}

pub struct Pool<H> {
    cfg: Config,
    inner: Mutex<(HashMap<u64, Entry<H>>, u64)>,
}

impl<H: Clone> Pool<H> {
    pub fn new(cfg: Config) -> Self {
        Pool { cfg, inner: Mutex::new((HashMap::new(), 0)) }
    }

    pub fn take(&self, key: &Key, now: Instant) -> Take<H> {
        let mut g = self.inner.lock().unwrap();
        let (entries, next) = &mut *g;
        let free = entries.iter_mut().filter(|(_, e)| &e.key == key && !e.busy && e.handle.is_some()).min_by_key(|(_, e)| e.last).map(|(id, _)| *id);
        if let Some(id) = free {
            let e = entries.get_mut(&id).unwrap();
            e.busy = true;
            e.last = now;
            return Take::Warm(id, e.handle.clone().unwrap());
        }
        if entries.values().filter(|e| &e.key == key).count() >= self.cfg.per_module.max(1) {
            return Take::Fresh;
        }
        let mut evicted = vec![];
        while entries.len() >= self.cfg.max.max(1) {
            let lru = entries.iter().filter(|(_, e)| !e.busy).min_by_key(|(_, e)| e.last).map(|(id, _)| *id);
            match lru {
                Some(id) => {
                    if let Some(h) = entries.remove(&id).and_then(|e| e.handle) {
                        evicted.push(h);
                    }
                }
                None => return Take::Fresh,
            }
        }
        *next += 1;
        let id = *next;
        entries.insert(id, Entry { key: key.clone(), handle: None, busy: true, served: 0, last: now });
        Take::New(id, evicted)
    }

    /// The instance made for a `New`.
    pub fn attach(&self, id: u64, handle: H) {
        if let Some(e) = self.inner.lock().unwrap().0.get_mut(&id) {
            e.handle = Some(handle);
        }
    }

    /// A request is done. A sound instance under its limit becomes free again;
    /// otherwise it is taken out and its handle returned, to be let go.
    pub fn give_back(&self, id: u64, sound: bool, now: Instant) -> Option<H> {
        let mut g = self.inner.lock().unwrap();
        let e = g.0.get_mut(&id)?;
        e.served += 1;
        if sound && e.served < self.cfg.recycle_after {
            e.busy = false;
            e.last = now;
            return None;
        }
        g.0.remove(&id).and_then(|e| e.handle)
    }

    pub fn remove(&self, id: u64) -> Option<H> {
        self.inner.lock().unwrap().0.remove(&id).and_then(|e| e.handle)
    }

    /// Free instances unused for longer than the idle time.
    pub fn reap(&self, now: Instant) -> Vec<H> {
        let mut g = self.inner.lock().unwrap();
        let idle: Vec<u64> = g.0.iter().filter(|(_, e)| !e.busy && now.duration_since(e.last) > self.cfg.idle).map(|(id, _)| *id).collect();
        idle.into_iter().filter_map(|id| g.0.remove(&id).and_then(|e| e.handle)).collect()
    }

    /// (instances, of which busy)
    pub fn counts(&self) -> (usize, usize) {
        let g = self.inner.lock().unwrap();
        (g.0.len(), g.0.values().filter(|e| e.busy).count())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(module: &str, app: u64, db: &str) -> Key {
        Key::new(module, app, db, &None)
    }
    fn pool(recycle_after: u32, max: usize, per_module: usize) -> Pool<&'static str> {
        Pool::new(Config { recycle_after, idle: Duration::from_secs(60), max, per_module })
    }
    fn new_id(t: Take<&'static str>) -> u64 {
        match t {
            Take::New(id, _) => id,
            _ => panic!("expected a new instance"),
        }
    }

    #[test]
    fn bound_to_module_app_and_database() {
        let p = pool(100, 10, 1);
        let now = Instant::now();
        let a = key("m1", 1, "db1");
        let id = new_id(p.take(&a, now));
        p.attach(id, "A");
        assert!(p.give_back(id, true, now).is_none());
        // The same key gets it back; any other key never does.
        assert!(matches!(p.take(&a, now), Take::Warm(i, "A") if i == id));
        p.give_back(id, true, now);
        for other in [key("m2", 1, "db1"), key("m1", 2, "db1"), key("m1", 1, "db2"), Key::new("m1", 1, "db1", &Some([("X".to_string(), "1".to_string())].into()))] {
            assert!(matches!(p.take(&other, now), Take::New(..)), "{other:?}");
        }
    }

    #[test]
    fn busy_means_fresh_not_waiting() {
        let p = pool(100, 10, 1);
        let now = Instant::now();
        let a = key("m", 1, "d");
        let id = new_id(p.take(&a, now));
        p.attach(id, "A");
        assert!(matches!(p.take(&a, now), Take::Fresh));
        // Two per module: a second instance is made while the first is busy.
        let p2 = pool(100, 10, 2);
        let i1 = new_id(p2.take(&a, now));
        p2.attach(i1, "A");
        let i2 = new_id(p2.take(&a, now));
        assert_ne!(i1, i2);
        assert!(matches!(p2.take(&a, now), Take::Fresh));
    }

    #[test]
    fn recycled_after_n_requests() {
        let p = pool(3, 10, 1);
        let now = Instant::now();
        let a = key("m", 1, "d");
        let id = new_id(p.take(&a, now));
        p.attach(id, "A");
        assert!(p.give_back(id, true, now).is_none());
        assert!(matches!(p.take(&a, now), Take::Warm(..)));
        assert!(p.give_back(id, true, now).is_none());
        assert!(matches!(p.take(&a, now), Take::Warm(..)));
        assert_eq!(p.give_back(id, true, now), Some("A"), "the third request is its last");
        assert!(matches!(p.take(&a, now), Take::New(i, _) if i != id));
    }

    #[test]
    fn discarded_after_a_request_that_went_wrong() {
        let p = pool(100, 10, 1);
        let now = Instant::now();
        let a = key("m", 1, "d");
        let id = new_id(p.take(&a, now));
        p.attach(id, "A");
        assert_eq!(p.give_back(id, false, now), Some("A"));
        assert_eq!(p.counts(), (0, 0));
        // A timeout takes it out while busy.
        let id = new_id(p.take(&a, now));
        p.attach(id, "B");
        assert_eq!(p.remove(id), Some("B"));
        assert!(p.give_back(id, true, now).is_none(), "nothing to give back once removed");
    }

    #[test]
    fn least_recently_used_makes_room() {
        let p = pool(100, 2, 1);
        let t0 = Instant::now();
        let (a, b, c) = (key("m", 1, "d"), key("m", 2, "d"), key("m", 3, "d"));
        let ia = new_id(p.take(&a, t0));
        p.attach(ia, "A");
        p.give_back(ia, true, t0);
        let ib = new_id(p.take(&b, t0 + Duration::from_secs(1)));
        p.attach(ib, "B");
        p.give_back(ib, true, t0 + Duration::from_secs(1));
        // Full: c's instance takes the place of a's, used least recently.
        match p.take(&c, t0 + Duration::from_secs(2)) {
            Take::New(_, evicted) => assert_eq!(evicted, vec!["A"]),
            _ => panic!(),
        }
        assert!(matches!(p.take(&b, t0 + Duration::from_secs(3)), Take::Warm(_, "B")));
        // Every instance busy and no room: fresh.
        assert!(matches!(p.take(&key("m", 4, "d"), t0), Take::Fresh));
    }

    #[test]
    fn idle_instances_go() {
        let p = Pool::new(Config { recycle_after: 100, idle: Duration::from_millis(500), max: 10, per_module: 1 });
        let t0 = Instant::now();
        let a = key("m", 1, "d");
        let id = new_id(p.take(&a, t0));
        p.attach(id, "A");
        p.give_back(id, true, t0);
        assert!(p.reap(t0 + Duration::from_millis(100)).is_empty());
        assert_eq!(p.reap(t0 + Duration::from_secs(1)), vec!["A"]);
        assert_eq!(p.counts(), (0, 0));
    }
}
