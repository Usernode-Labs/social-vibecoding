// Offline feedback outbox (#1054).
//
// The Send Feedback dialog used to end its submit path at
// `catch { 'Network error' }`: a typed-out bug report — the one someone wrote
// *because* the app was misbehaving on a bad connection — died with the tap
// that sent it. This module is the durable side of the fix: the dialog hands
// a submit here when the network refuses it, and it gets sent later.
//
// Why in the page and not the service worker: public/sw.js classifies every
// non-GET as 'bypass' (see classifyRequest there), so a POST is never
// intercepted and Background Sync has nothing to hook. The outbox has to be
// page-side, which also means it has to survive a reload on its own —
// IndexedDB, because a screenshot is a Blob and localStorage only holds text.
//
// Deliberate shape:
//   * A screenshot is stored as the raw Blob, NOT an uploaded id.
//     /api/feedback/screenshot is only reachable online, so the upload has to
//     happen at flush time; keeping the blob is what makes the attachment
//     survive. Where IndexedDB is unavailable we fall back to localStorage and
//     keep the text only (screenshotDropped), because losing the words is much
//     worse than losing the picture.
//   * Caps before durability: 10 entries and ~12 MB of screenshot bytes, with
//     an exact-duplicate guard. An outbox nobody can see must not be able to
//     fill a user's disk quota.
//   * One flush at a time, sequentially, across tabs (BroadcastChannel + a
//     `sendingSince` claim). Two tabs coming back online together must not
//     file the same issue twice.
//   * Failures are classified, not retried blindly: a 400 is never going to
//     succeed, so it becomes a `failed` record the dialog hands back to the
//     user with their text intact instead of a silent forever-retry.
//
// Pure helpers (dedupeKey / withinCaps / classifyFailure / backoffMs /
// formatQueuedAt / isDue) are exported for node --test — see
// tests/feedback-offline-queue.test.js. Everything touching window/indexedDB
// is guarded so requiring this file in Node is side-effect free.

(function () {
  'use strict';

  const hasWindow = typeof window !== 'undefined';

  // Caps. Ten entries is far more than the realistic offline burst (the
  // dialog is a deliberate, typed action) and small enough that the worst
  // case is bounded; the byte cap is what actually protects the origin's
  // storage quota, since one full-screen PNG can be several MB.
  const MAX_ENTRIES = 10;
  const MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024;
  // #3027: images per message — the same limit POST /api/feedback enforces
  // (MAX_SCREENSHOTS_PER_ISSUE in src/routes/feedback.js). The dialog never
  // hands over more; this only keeps a stray caller from queueing a message
  // the server is certain to refuse.
  const MAX_SCREENSHOTS = 3;

  // Retry schedule: 30s, 1m, 2m, 4m, 8m, then flat 10m. Deliberately slow —
  // the flush triggers (coming back online, a fresh sign-in) are the ones
  // that matter, and the timer is only a safety net for a connection that
  // came back without firing an event.
  const BASE_BACKOFF_MS = 30_000;
  const MAX_BACKOFF_MS = 10 * 60_000;
  const FLUSH_INTERVAL_MS = 60_000;

  // A send is at most three screenshot uploads plus one POST. Two minutes is a
  // generous ceiling, after which another tab may assume the claiming tab
  // was closed mid-flight and take the record over.
  const CLAIM_STALE_MS = 2 * 60_000;

  const DB_NAME = 'usernode-feedback-queue';
  const DB_VERSION = 1;
  const STORE_NAME = 'queue';
  const LS_KEY = 'usernode:feedback-queue';
  const CHANNEL_NAME = 'usernode:feedback-queue';

  // ── Pure helpers ─────────────────────────────────────────────────────

  // Identity of a queued submit, for the exact-duplicate guard. Target +
  // app + title + description: re-tapping "Save for later" on the same
  // unchanged draft (the natural reaction to a dialog that just told you
  // you're offline) must not queue it twice.
  function dedupeKey(entry) {
    const p = (entry && entry.payload) || entry || {};
    return [
      p.target === 'app' ? 'app' : 'platform',
      p.appSlug || '',
      String(p.title || '').trim(),
      String(p.description || '').trim(),
    ].join('|');
  }

  // Can `entry` join `existing`? Returns a reason code the dialog turns into
  // a sentence, so every refusal is explainable rather than a silent drop.
  function withinCaps(existing, entry) {
    const list = Array.isArray(existing) ? existing : [];
    const key = dedupeKey(entry);
    if (list.some((r) => dedupeKey(r) === key)) return { ok: false, reason: 'duplicate' };
    if (list.length >= MAX_ENTRIES) return { ok: false, reason: 'full' };
    const bytes = list.reduce((n, r) => n + (Number(r.screenshotBytes) || 0), 0)
      + (Number(entry && entry.screenshotBytes) || 0);
    if (bytes > MAX_SCREENSHOT_BYTES) return { ok: false, reason: 'too-large' };
    return { ok: true, reason: null };
  }

  // What to do with a failed send.
  //   'retry'          — transient: count the attempt and back off.
  //   'retry-no-count' — the session lapsed (401/403). Retry when it's back,
  //                      but don't burn an attempt on it: a user who signs in
  //                      an hour later should not find their feedback aged
  //                      out into `failed`.
  //   'permanent'      — the request itself is wrong (400 validation, 404
  //                      repo gone, 409 conflict). Waiting cannot fix it, so
  //                      the record is handed back to the user instead.
  // 429 and 5xx are the server asking for later, so they retry.
  function classifyFailure(result) {
    const r = result || {};
    if (r.networkError) return 'retry';
    const status = Number(r.status) || 0;
    if (status >= 200 && status < 300) return 'ok';
    if (status === 401 || status === 403) return 'retry-no-count';
    if (status === 429) return 'retry';
    if (status >= 400 && status < 500) return 'permanent';
    return 'retry';
  }

  function backoffMs(attempts) {
    const n = Math.max(0, Number(attempts) || 0);
    return Math.min(BASE_BACKOFF_MS * Math.pow(2, n), MAX_BACKOFF_MS);
  }

  // The `queuedAt` the server stamps onto the issue body. ISO-8601 UTC, or
  // null when the timestamp is unusable — the field is optional end to end,
  // so a bad clock costs a body line, never a filing.
  function formatQueuedAt(ms) {
    const t = Number(ms);
    if (!Number.isFinite(t) || t <= 0) return null;
    try { return new Date(t).toISOString(); } catch (err) { return null; }
  }

  function isDue(record, nowMs) {
    if (!record || record.status === 'failed') return false;
    const claimed = Number(record.sendingSince) || 0;
    // Claimed by a live flush (this tab's or another's) — leave it alone
    // until the claim goes stale.
    if (claimed && nowMs - claimed < CLAIM_STALE_MS) return false;
    return (Number(record.nextAttemptAt) || 0) <= nowMs;
  }

  // ── Storage adapters ─────────────────────────────────────────────────
  //
  // Three of them, in preference order: IndexedDB (keeps the screenshot
  // Blob), localStorage (text only), and an in-memory adapter used by the
  // ?shot= screenshot deep links so a photographable queue never writes
  // anything to the device.

  // #3027: a record's image bytes, oldest shape included. Records queued
  // before multi-image support hold one Blob in `screenshot`; newer ones hold
  // an array in `screenshots`. Both flush the same way.
  function recordScreenshots(record) {
    if (!record) return [];
    if (Array.isArray(record.screenshots)) return record.screenshots.filter(Boolean);
    return record.screenshot ? [record.screenshot] : [];
  }

  function stripBlob(record) {
    const copy = Object.assign({}, record);
    delete copy.screenshot;
    delete copy.screenshots;
    copy.screenshotBytes = 0;
    copy.screenshotDropped = recordScreenshots(record).length > 0 || !!record.screenshotDropped;
    return copy;
  }

  function memoryStorage(seed) {
    const rows = new Map();
    (seed || []).forEach((r) => { if (r && r.id) rows.set(r.id, r); });
    return {
      kind: 'memory',
      keepsBlobs: true,
      all() { return Promise.resolve([...rows.values()]); },
      put(record) { rows.set(record.id, record); return Promise.resolve(record); },
      remove(id) { rows.delete(id); return Promise.resolve(); },
    };
  }

  function localStorageStorage() {
    const read = () => {
      try {
        const raw = window.localStorage.getItem(LS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((r) => r && r.id) : [];
      } catch (err) { return []; }
    };
    const write = (rows) => {
      try { window.localStorage.setItem(LS_KEY, JSON.stringify(rows)); } catch (err) { /* quota — drop */ }
    };
    return {
      kind: 'local',
      keepsBlobs: false,
      all() { return Promise.resolve(read()); },
      put(record) {
        const rows = read().filter((r) => r.id !== record.id);
        rows.push(stripBlob(record));
        write(rows);
        return Promise.resolve(record);
      },
      remove(id) {
        write(read().filter((r) => r.id !== id));
        return Promise.resolve();
      },
    };
  }

  function idbStorage() {
    let dbPromise = null;
    const open = () => {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        const req = window.indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            store.createIndex('userId', 'userId');
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
        req.onblocked = () => reject(new Error('indexedDB blocked'));
      });
      // A rejected open must not be cached as a permanent failure state that
      // later calls keep awaiting — ensureStore() falls back instead.
      dbPromise.catch(() => { dbPromise = null; });
      return dbPromise;
    };
    const tx = (mode, run) => open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(STORE_NAME, mode);
      const store = t.objectStore(STORE_NAME);
      let out;
      const req = run(store);
      if (req) req.onsuccess = () => { out = req.result; };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error || new Error('indexedDB transaction failed'));
      t.onabort = () => reject(t.error || new Error('indexedDB transaction aborted'));
    }));
    return {
      kind: 'idb',
      keepsBlobs: true,
      all() {
        return tx('readonly', (store) => store.getAll())
          .then((rows) => (Array.isArray(rows) ? rows.filter((r) => r && r.id) : []));
      },
      put(record) { return tx('readwrite', (store) => store.put(record)).then(() => record); },
      remove(id) { return tx('readwrite', (store) => store.delete(id)); },
      probe() { return open().then(() => true); },
    };
  }

  // ── Module state ─────────────────────────────────────────────────────

  let store = null;
  let storePromise = null;
  // Incremented whenever a caller deliberately replaces the storage adapter.
  // In particular, seedDisplayOnly() must outrank an IndexedDB open that init()
  // started earlier: that request can finish after the screenshot seed and
  // must not replace the seeded memory store with the device's real queue.
  let storeGeneration = 0;
  let flushing = null;
  let flushDisabled = false;   // set by the display-only ?shot= seeds
  let onChange = null;
  let onFlushed = null;
  let channel = null;
  let initialised = false;

  const nowMs = () => Date.now();

  function newId() {
    try {
      if (hasWindow && window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
    } catch (err) { /* fall through */ }
    return `fq-${nowMs().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }

  function currentUserId() {
    try {
      const id = hasWindow && window.App && window.App.user && window.App.user.id;
      return typeof id === 'number' ? id : null;
    } catch (err) { return null; }
  }

  function ensureStore() {
    if (store) return Promise.resolve(store);
    if (storePromise) return storePromise;
    const generation = storeGeneration;
    storePromise = (async () => {
      let selected = null;
      if (hasWindow && window.indexedDB) {
        const idb = idbStorage();
        try {
          await idb.probe();
          selected = idb;
        } catch (err) { /* private mode, blocked, unsupported — fall back */ }
      }
      if (!selected && hasWindow && window.localStorage) {
        selected = localStorageStorage();
      }
      if (!selected) selected = memoryStorage([]);
      // A display-only seed installed while the async probe was pending is
      // the newer fact. Return that adapter to this original caller too, so
      // its pending count cannot repaint from the stale device store.
      if (generation !== storeGeneration) return store;
      store = selected;
      return store;
    })();
    return storePromise;
  }

  // Records that belong to the viewer. A record saved before the session was
  // known (userId null) is claimable by whoever is signed in now — it was
  // typed on this device, in this browser, and the alternative is orphaning
  // it forever.
  function mine(rows) {
    const uid = currentUserId();
    return rows
      .filter((r) => uid === null || r.userId === null || r.userId === undefined || r.userId === uid)
      .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
  }

  function broadcast(kind) {
    try { if (channel) channel.postMessage({ kind }); } catch (err) { /* ignore */ }
  }

  function notifyChange() {
    try { if (typeof onChange === 'function') onChange(); } catch (err) { /* ignore */ }
  }

  // ── Sending ──────────────────────────────────────────────────────────

  // POST one record. Returns a plain result object so classifyFailure() can
  // stay pure and testable.
  async function send(record) {
    const body = Object.assign({}, record.payload);
    const queuedAt = record.queuedAt || formatQueuedAt(record.createdAt);
    if (queuedAt) body.queuedAt = queuedAt;

    // The screenshots have to be uploaded now — their ids only exist
    // server-side. A transient failure on ANY of them retries the whole
    // record (the words and the pictures stay together); a permanent one
    // files without that attachment, because the description is the part
    // that matters. #3027: ids the dialog had already uploaded before it went
    // offline ride in the payload, and the freshly minted ones join them.
    //
    // Progress is written back onto `record` as it happens (fresh objects,
    // never a mutation of the stored ones): an image that uploaded moves from
    // `screenshots` into `payload.screenshotIds`, and one the server refused
    // outright leaves `screenshots`. flushOnce persists the record it passed
    // in after a failure, so a retry uploads only what is still missing
    // rather than minting a second (orphaned) row for every image that
    // already made it, each against the per-user upload limiter.
    const shots = recordScreenshots(record);
    if (shots.length) {
      const ids = Array.isArray(body.screenshotIds) ? body.screenshotIds.slice() : [];
      const remaining = shots.slice();
      const saveProgress = () => {
        record.payload = Object.assign({}, record.payload, ids.length ? { screenshotIds: ids.slice() } : {});
        record.screenshots = remaining.slice();
        record.screenshotBytes = remaining.reduce((n, b) => n + (Number(b && b.size) || 0), 0);
        delete record.screenshot;
      };
      for (const shot of shots) {
        try {
          const res = await fetch('/api/feedback/screenshot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: shot,
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data && data.id) {
            ids.push(data.id);
            remaining.splice(remaining.indexOf(shot), 1);
            saveProgress();
          } else if (classifyFailure({ status: res.status }) !== 'permanent') {
            return { ok: false, status: res.status, networkError: false, error: (data && data.error) || 'screenshot upload failed' };
          } else {
            remaining.splice(remaining.indexOf(shot), 1);
            saveProgress();
          }
        } catch (err) {
          return { ok: false, status: 0, networkError: true, error: 'network error' };
        }
      }
      if (ids.length) body.screenshotIds = ids;
    }

    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      return {
        ok: res.ok,
        status: res.status,
        networkError: false,
        data: data || {},
        error: (data && data.error) || null,
      };
    } catch (err) {
      return { ok: false, status: 0, networkError: true, error: 'network error' };
    }
  }

  async function flushOnce(reason) {
    if (flushDisabled) return { sent: 0, failed: 0, remaining: 0, filed: [] };
    const s = await ensureStore();
    const all = mine(await s.all());
    const due = all.filter((r) => isDue(r, nowMs()));
    const result = { sent: 0, failed: 0, remaining: 0, filed: [], reason: reason || null };

    // Strictly sequential: two issues filed at once from a phone that just
    // reconnected is exactly the burst this module exists to avoid.
    for (const record of due) {
      const claimed = Object.assign({}, record, { sendingSince: nowMs() });
      try { await s.put(claimed); } catch (err) { continue; }
      broadcast('claim');

      const res = await send(claimed);
      if (res.ok) {
        await s.remove(claimed.id);
        result.sent += 1;
        result.filed.push({
          id: claimed.id,
          target: claimed.payload && claimed.payload.target,
          appSlug: (claimed.payload && claimed.payload.appSlug) || null,
          issue: (res.data && res.data.issueUrl) || null,
          ...(res.data?.firstFeedback ? { firstFeedback: res.data.firstFeedback } : {}),
        });
        continue;
      }

      const verdict = classifyFailure(res);
      const next = Object.assign({}, claimed, {
        sendingSince: null,
        lastError: res.error || 'Could not send',
      });
      if (verdict === 'permanent') {
        next.status = 'failed';
        next.nextAttemptAt = 0;
        result.failed += 1;
      } else {
        if (verdict !== 'retry-no-count') next.attempts = (Number(claimed.attempts) || 0) + 1;
        next.nextAttemptAt = nowMs() + backoffMs(next.attempts);
      }
      try { await s.put(next); } catch (err) { /* ignore */ }

      // The connection went away mid-flush: stop rather than burn an attempt
      // on every remaining record for the same reason.
      if (verdict === 'retry' && res.networkError) break;
    }

    result.remaining = mine(await s.all()).filter((r) => r.status !== 'failed').length;
    if (result.sent || result.failed) { broadcast('changed'); notifyChange(); }
    if (result.sent && typeof onFlushed === 'function') {
      try { onFlushed(result); } catch (err) { /* ignore */ }
    }
    return result;
  }

  // ── Public API ───────────────────────────────────────────────────────

  const FeedbackQueue = {
    MAX_ENTRIES,
    MAX_SCREENSHOT_BYTES,
    MAX_SCREENSHOTS,
    // Pure helpers, exported for tests and reused by the dialog.
    dedupeKey,
    withinCaps,
    classifyFailure,
    backoffMs,
    formatQueuedAt,
    isDue,

    // 'idb' | 'local' | 'memory' | 'none' — what actually backs the queue,
    // which is also what decides whether a screenshot could be kept.
    get storage() { return store ? store.kind : 'none'; },

    // Wire the flush triggers. Called once from App.init(); the callbacks let
    // app.js repaint the header dot and toast a successful send without this
    // module reaching into the DOM.
    init(opts = {}) {
      if (typeof opts.onChange === 'function') onChange = opts.onChange;
      if (typeof opts.onFlushed === 'function') onFlushed = opts.onFlushed;
      if (initialised || !hasWindow) return FeedbackQueue;
      initialised = true;

      try {
        if (typeof window.BroadcastChannel === 'function') {
          channel = new window.BroadcastChannel(CHANNEL_NAME);
          // Another tab queued or filed something: repaint, don't flush —
          // whichever tab owns the claim is already sending.
          channel.onmessage = (e) => { if (e && e.data && e.data.kind === 'changed') notifyChange(); };
        }
      } catch (err) { /* no cross-tab coordination — the claim still guards */ }

      // The connectivity probe (frontend/src/lib/offline.ts) is the truth
      // here, not navigator.onLine; `online` is kept as a cheap extra nudge.
      window.addEventListener('usernode:offline-change', (e) => {
        if (e && e.detail && e.detail.offline === false) FeedbackQueue.flush('reconnect');
      });
      window.addEventListener('online', () => FeedbackQueue.flush('online'));
      setInterval(() => {
        if (window.Offline && typeof window.Offline.isOffline === 'function' && window.Offline.isOffline()) return;
        FeedbackQueue.flush('timer');
      }, FLUSH_INTERVAL_MS);

      // Paint the dot from whatever survived the last session.
      ensureStore().then(notifyChange).catch(() => { /* ignore */ });
      return FeedbackQueue;
    },

    // Save a submit for later. `entry.payload` is the /api/feedback body the
    // dialog would have posted; `entry.screenshots` are the captured Blobs
    // not yet uploaded (#3027; `entry.screenshot`, one Blob, is the older
    // shape and still accepted), kept as-is because their ids can only be
    // minted online.
    async enqueue(entry) {
      const s = await ensureStore();
      const t = nowMs();
      const shots = recordScreenshots(entry).slice(0, MAX_SCREENSHOTS);
      const record = {
        id: newId(),
        userId: currentUserId(),
        createdAt: t,
        queuedAt: formatQueuedAt(t),
        payload: Object.assign({}, (entry && entry.payload) || {}),
        screenshots: s.keepsBlobs ? shots : [],
        screenshotBytes: s.keepsBlobs
          ? shots.reduce((n, b) => n + (Number(b && b.size) || 0), 0)
          : 0,
        screenshotDropped: shots.length > 0 && !s.keepsBlobs,
        attempts: 0,
        nextAttemptAt: t,
        status: 'pending',
        lastError: null,
        sendingSince: null,
      };

      const caps = withinCaps(mine(await s.all()), record);
      if (!caps.ok) {
        const err = new Error(caps.reason);
        err.code = caps.reason;
        throw err;
      }
      await s.put(record);
      broadcast('changed');
      notifyChange();
      return record;
    },

    // Everything still waiting to send, oldest first. Excludes `failed`
    // records — those are the dialog's business (takeFailed), not the dot's.
    async pending() {
      const s = await ensureStore();
      return mine(await s.all()).filter((r) => r.status !== 'failed');
    },

    async count() {
      try { return (await FeedbackQueue.pending()).length; } catch (err) { return 0; }
    },

    // Hand the oldest permanently-failed record back to the caller and remove
    // it from the store, so the dialog can re-open with the user's own words
    // in the textarea and the server's reason above it. Exactly once: if they
    // close the dialog it is gone, which is the same contract as any other
    // unsent draft.
    async takeFailed() {
      const s = await ensureStore();
      const failed = mine(await s.all()).filter((r) => r.status === 'failed');
      if (!failed.length) return null;
      const record = failed[0];
      try { await s.remove(record.id); } catch (err) { /* ignore */ }
      broadcast('changed');
      notifyChange();
      return record;
    },

    // Single-flight. Concurrent callers (reconnect + timer landing together)
    // share the one in-flight pass rather than racing it.
    flush(reason) {
      if (flushing) return flushing;
      flushing = flushOnce(reason)
        .catch((err) => ({ sent: 0, failed: 0, remaining: 0, filed: [], error: (err && err.message) || 'flush failed' }))
        .then((res) => { flushing = null; return res; });
      return flushing;
    },

    // Display-only seeding for the ?shot=feedback-queued screenshot link.
    // Swaps in the in-memory adapter and disables flushing: the pinned state
    // is photographable without writing to the device or filing anything.
    seedDisplayOnly(entries) {
      const t = nowMs();
      storeGeneration += 1;
      store = memoryStorage((entries || []).map((e, i) => Object.assign({
        id: `shot-${i}`,
        userId: currentUserId(),
        createdAt: t - (i + 1) * 60_000,
        queuedAt: formatQueuedAt(t - (i + 1) * 60_000),
        payload: {},
        screenshots: [],
        screenshotBytes: 0,
        attempts: 0,
        nextAttemptAt: t + MAX_BACKOFF_MS,
        status: 'pending',
        lastError: null,
        sendingSince: null,
      }, e)));
      storePromise = Promise.resolve(store);
      flushDisabled = true;
      notifyChange();
      return store;
    },
  };

  if (hasWindow) window.FeedbackQueue = FeedbackQueue;
  // Same guard public/sw.js uses: the pure helpers are unit-tested under
  // node --test, where there is no window to publish onto.
  if (typeof module !== 'undefined' && module.exports) module.exports = FeedbackQueue;
})();
