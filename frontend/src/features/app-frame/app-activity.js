/**
 * Engaged-use accounting for the live App frame.
 *
 * A load event is deliberately not readiness: browsers fire `load` for error
 * documents too.  The vendored child bridge answers a generation-scoped probe
 * only after its document loaded, then forwards throttled, trusted input.  This
 * collector counts bounded elapsed time while that ready document is visible
 * and its input lease is fresh.
 *
 * Upload state is durable and account-scoped.  A batch keeps the same UUID
 * until the server acknowledges it; the server receipt makes a retry after a
 * lost response harmless.  Buffers retain occurrence-day milliseconds so a
 * delayed upload does not move yesterday's use into today.
 */

export const ENGAGEMENT_IDLE_MS = 60_000;
export const ENGAGEMENT_MAX_ELAPSED_MS = 5_000;
export const ACTIVITY_FLUSH_MS = 30_000;
export const TRY_APP_FLUSH_MS = 10_000;
export const ACTIVITY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const ACTIVITY_MAX_BATCH_SECONDS = 3_600;
export const ACTIVITY_MAX_BATCHES = 64;
export const ACTIVITY_MAX_BUFFERS = 128;
export const ACTIVITY_FETCH_TIMEOUT_MS = 10_000;

const STORAGE_KEY = 'sv:engaged-app-usage:v1';
const MAX_DRAIN_BATCHES = 8;
const MESSAGE_KEY = '__usernode_engagement';

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayStart(day) {
  const value = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(value) ? value : null;
}

function validSlug(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function validUserId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? String(n) : null;
}

function makeUuid(cryptoObj) {
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function browserStorage() {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}

export class EngagedAppUsage {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now());
    this.fetch = options.fetch || ((...args) => globalThis.fetch(...args));
    this.storage = options.storage !== undefined ? options.storage : browserStorage();
    this.crypto = options.crypto || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
    this.setInterval = options.setInterval || globalThis.setInterval?.bind(globalThis);
    this.clearInterval = options.clearInterval || globalThis.clearInterval?.bind(globalThis);
    this.setTimeout = options.setTimeout || globalThis.setTimeout?.bind(globalThis);
    this.clearTimeout = options.clearTimeout || globalThis.clearTimeout?.bind(globalThis);
    this.AbortController = options.AbortController
      || (typeof globalThis !== 'undefined' ? globalThis.AbortController : null);
    this.fetchTimeoutMs = options.fetchTimeoutMs || ACTIVITY_FETCH_TIMEOUT_MS;
    this.uuid = options.uuid || (() => makeUuid(this.crypto));
    this.idleMs = options.idleMs || ENGAGEMENT_IDLE_MS;
    this.maxElapsedMs = options.maxElapsedMs || ENGAGEMENT_MAX_ELAPSED_MS;
    this.flushMs = options.flushMs || ACTIVITY_FLUSH_MS;
    this.maxAgeMs = options.maxAgeMs || ACTIVITY_MAX_AGE_MS;

    this.state = { owner: null, batches: [], buffers: {} };
    this.current = null;
    this.target = null;
    this.timer = null;
    this.lastFlushAt = 0;
    this.lastPersistAt = 0;
    this.flushPromise = null;
    this.inflightController = null;
    this.onlineWindow = null;
    this.generation = 0;
    this.stateGeneration = 0;
    this.sessionId = this.uuid();
    this._onOnline = () => { void this.flush(); };
  }

  start({ slug, userId, isVisible } = {}) {
    const owner = validUserId(userId);
    if (!owner || !validSlug(slug)) return false;
    if (this.current) {
      this.tick();
      if (this.timer && this.clearInterval) this.clearInterval(this.timer);
      this.timer = null;
      this.current = null;
      this._persist();
    }
    this._load(owner);
    const at = this.now();
    this.current = {
      slug,
      owner,
      isVisible: typeof isVisible === 'function' ? isVisible : (() => false),
      lastSampleAt: at,
      lastActivityAt: 0,
      engagedMs: 0,
      earlyFlushDone: false,
      readyAt: this.target && this.target.slug === slug && this.target.ready
        && !this.target.failed ? at : 0,
    };
    this.lastFlushAt = at;
    if (!this.timer && this.setInterval) {
      this.timer = this.setInterval(() => this.tick(), 1_000);
    }
    this._listenOnline();
    void this.flush();
    return true;
  }

  stop({ discard = false } = {}) {
    if (this.current && !discard) this.tick();
    if (this.timer && this.clearInterval) this.clearInterval(this.timer);
    this.timer = null;
    this.current = null;
    this._persist();
    if (!discard) void this.flush();
  }

  visibilityChanged() {
    if (!this.current) return;
    // The visibility event fires after visibilityState changes. Resetting the
    // sample anchor on BOTH edges means a background/frozen gap can never be
    // credited when the document becomes visible again.
    this.current.lastSampleAt = this.now();
    void this.flush();
  }

  tick(at = this.now()) {
    const current = this.current;
    if (!current) return 0;
    const elapsed = Math.max(0, Math.min(at - current.lastSampleAt, this.maxElapsedMs));
    const start = at - elapsed;
    current.lastSampleAt = at;
    let visible = false;
    try { visible = !!current.isVisible(); } catch { visible = false; }
    const frameReady = this.target && this.target.slug === current.slug
      && this.target.ready && !this.target.failed;
    const leaseEnd = current.lastActivityAt ? current.lastActivityAt + this.idleMs : 0;
    const creditStart = Math.max(start, current.readyAt || at);
    const creditEnd = Math.min(at, leaseEnd);
    const credited = visible && frameReady && creditEnd > creditStart
      ? creditEnd - creditStart : 0;
    if (credited > 0) {
      this._addRange(creditStart, creditEnd, current.slug);
      current.engagedMs += credited;
    }

    if (at - this.lastPersistAt >= this.maxElapsedMs) this._persist();
    // Keep main's early "Try an app" receipt, measured in earned time. A
    // loading, hidden or idle screen must not reach it from wall time alone.
    const earlyFlush = !current.earlyFlushDone && current.engagedMs >= TRY_APP_FLUSH_MS;
    if (earlyFlush || at - this.lastFlushAt >= this.flushMs) {
      if (earlyFlush) current.earlyFlushDone = true;
      this.lastFlushAt = at;
      void this.flush();
    }
    return credited;
  }

  frameNavigated({ slug, frame, src } = {}) {
    if (!validSlug(slug) || !frame || !src) return false;
    let origin;
    try { origin = new URL(src).origin; } catch { return false; }
    this.tick();
    this.target = {
      slug,
      frame,
      origin,
      generation: `${this.sessionId}:${++this.generation}`,
      ready: false,
      failed: false,
    };
    if (this.current && this.current.slug === slug) {
      this.current.readyAt = 0;
      this.current.lastActivityAt = 0;
      this.current.lastSampleAt = this.now();
    }
    return true;
  }

  adoptFrame({ slug, frame, src } = {}) {
    if (!this.frameNavigated({ slug, frame, src })) return false;
    this._probe(frame);
    return true;
  }

  frameLoaded(frame) {
    if (!this.target || this.target.frame !== frame) return false;
    this.tick();
    // A frame can navigate itself without passing through setSrc. Rotate the
    // generation on every committed document load so a queued reply from the
    // prior same-origin document can never make the replacement look ready.
    this.target.generation = `${this.sessionId}:${++this.generation}`;
    this.target.ready = false;
    this.target.failed = false;
    if (this.current && this.current.slug === this.target.slug) {
      this.current.readyAt = 0;
      this.current.lastActivityAt = 0;
      this.current.lastSampleAt = this.now();
    }
    return this._probe(frame);
  }

  frameFailed(frame) {
    if (!this.target || this.target.frame !== frame) return false;
    this.tick();
    this.target.ready = false;
    this.target.failed = true;
    if (this.current && this.current.slug === this.target.slug) {
      this.current.readyAt = 0;
      this.current.lastActivityAt = 0;
      this.current.lastSampleAt = this.now();
    }
    return true;
  }

  detachFrame(frame) {
    if (!this.target || (frame && this.target.frame !== frame)) return false;
    this.tick();
    this.target = null;
    if (this.current) {
      this.current.readyAt = 0;
      this.current.lastActivityAt = 0;
      this.current.lastSampleAt = this.now();
    }
    return true;
  }

  handleFrameMessage(event) {
    const target = this.target;
    const data = event && event.data;
    if (!target || !data || event.source !== target.frame.contentWindow) return false;
    if (event.origin !== target.origin || data.generation !== target.generation) return false;
    const kind = data[MESSAGE_KEY];
    if (kind !== 'ready' && kind !== 'activity') return false;
    const at = this.now();
    this.tick(at);
    if (kind === 'ready') {
      target.ready = true;
      target.failed = false;
      if (this.current && this.current.slug === target.slug) {
        this.current.readyAt = at;
        this.current.lastSampleAt = at;
      }
      return true;
    }
    if (!target.ready || target.failed) return false;
    if (this.current && this.current.slug === target.slug) {
      this.current.lastActivityAt = at;
      this.current.lastSampleAt = at;
    }
    return true;
  }

  discardSlug(slug) {
    if (!validSlug(slug)) return;
    if (this.current && this.current.slug === slug) this.stop({ discard: true });
    this.state.batches = this.state.batches.filter((batch) => batch.slug !== slug);
    for (const key of Object.keys(this.state.buffers)) {
      if (this.state.buffers[key].slug === slug) delete this.state.buffers[key];
    }
    if (this.target && this.target.slug === slug) this.target = null;
    this._persist();
  }

  clearAccount() {
    if (this.timer && this.clearInterval) this.clearInterval(this.timer);
    this.timer = null;
    this.current = null;
    this.target = null;
    this._changeStateGeneration();
    this.state = { owner: null, batches: [], buffers: {} };
    try { this.storage?.removeItem(STORAGE_KEY); } catch { /* storage is best effort */ }
  }

  async flush() {
    if (!this.state.owner) return false;
    if (this.current) this.tick(this.now());
    this._prune();
    this._stageOne();
    this._persist();
    if (this.flushPromise) return this.flushPromise;
    const generation = this.stateGeneration;
    this.flushPromise = this._drain(generation).finally(() => { this.flushPromise = null; });
    return this.flushPromise;
  }

  debug() {
    return {
      state: clone(this.state),
      current: this.current ? { ...this.current, isVisible: undefined } : null,
      target: this.target ? { ...this.target, frame: undefined } : null,
    };
  }

  _listenOnline() {
    const win = typeof window !== 'undefined' ? window : null;
    if (!win || this.onlineWindow === win) return;
    this.onlineWindow = win;
    win.addEventListener('online', this._onOnline);
  }

  _probe(frame) {
    const target = this.target;
    if (!target || target.frame !== frame || !frame.contentWindow) return false;
    try {
      frame.contentWindow.postMessage({
        [MESSAGE_KEY]: 'probe',
        generation: target.generation,
      }, target.origin);
      return true;
    } catch { return false; }
  }

  _addRange(start, end, slug) {
    let cursor = start;
    while (cursor < end) {
      const day = utcDay(cursor);
      const nextDay = dayStart(day) + 24 * 60 * 60 * 1000;
      const partEnd = Math.min(end, nextDay);
      const key = `${slug}\n${day}`;
      let buffer = this.state.buffers[key];
      if (!buffer) {
        const values = Object.values(this.state.buffers);
        if (values.length >= ACTIVITY_MAX_BUFFERS) {
          values.sort((a, b) => a.day.localeCompare(b.day));
          const oldest = values[0];
          delete this.state.buffers[`${oldest.slug}\n${oldest.day}`];
        }
        buffer = { slug, day, milliseconds: 0 };
        this.state.buffers[key] = buffer;
      }
      buffer.milliseconds += partEnd - cursor;
      cursor = partEnd;
    }
  }

  _load(owner) {
    if (this.state.owner === owner) {
      // The in-memory copy is authoritative within this page. In particular,
      // storage can be unavailable or quota-failed: re-reading an absent value
      // on every app switch must not erase an unacknowledged batch.
      this._prune();
      return;
    }
    let parsed = null;
    try { parsed = JSON.parse(this.storage?.getItem(STORAGE_KEY) || 'null'); } catch { parsed = null; }
    if (!parsed || parsed.version !== 1 || String(parsed.owner) !== owner) {
      this._changeStateGeneration();
      this.state = { owner, batches: [], buffers: {} };
      this._persist();
      return;
    }
    const batches = Array.isArray(parsed.batches) ? parsed.batches.filter((batch) => (
      batch && typeof batch.id === 'string' && validSlug(batch.slug)
      && Array.isArray(batch.entries) && Number.isFinite(batch.createdAt)
    )).slice(-ACTIVITY_MAX_BATCHES) : [];
    const buffers = {};
    for (const buffer of Object.values(parsed.buffers || {})) {
      if (!buffer || !validSlug(buffer.slug) || !/^\d{4}-\d{2}-\d{2}$/.test(buffer.day)) continue;
      if (!Number.isFinite(buffer.milliseconds) || buffer.milliseconds <= 0) continue;
      buffers[`${buffer.slug}\n${buffer.day}`] = {
        slug: buffer.slug,
        day: buffer.day,
        milliseconds: Math.min(buffer.milliseconds, 86_400_000),
      };
    }
    this.state = { owner, batches, buffers };
    this._prune();
  }

  _prune() {
    const cutoff = this.now() - this.maxAgeMs;
    this.state.batches = this.state.batches.filter((batch) => batch.createdAt >= cutoff)
      .slice(-ACTIVITY_MAX_BATCHES);
    for (const [key, buffer] of Object.entries(this.state.buffers)) {
      const start = dayStart(buffer.day);
      if (start === null || start + 86_400_000 < cutoff) delete this.state.buffers[key];
    }
  }

  _stageOne() {
    if (this.state.batches.length >= ACTIVITY_MAX_BATCHES) return false;
    const buffers = Object.values(this.state.buffers)
      .filter((buffer) => buffer.milliseconds >= 1_000)
      .sort((a, b) => a.day.localeCompare(b.day) || a.slug.localeCompare(b.slug));
    const first = buffers.find((buffer) => (
      !this.state.batches.some((batch) => batch.slug === buffer.slug)
    ));
    if (!first) return false;
    let remaining = ACTIVITY_MAX_BATCH_SECONDS;
    const entries = [];
    for (const buffer of buffers) {
      if (buffer.slug !== first.slug || entries.length >= 8 || remaining <= 0) continue;
      const seconds = Math.min(Math.floor(buffer.milliseconds / 1_000), remaining);
      if (seconds <= 0) continue;
      entries.push({ date: buffer.day, seconds });
      buffer.milliseconds -= seconds * 1_000;
      remaining -= seconds;
      if (buffer.milliseconds < 1) delete this.state.buffers[`${buffer.slug}\n${buffer.day}`];
    }
    if (!entries.length) return false;
    this.state.batches.push({
      id: this.uuid(),
      slug: first.slug,
      entries,
      createdAt: this.now(),
    });
    return true;
  }

  async _drain(generation) {
    let sent = 0;
    while (generation === this.stateGeneration
        && this.state.batches.length && sent < MAX_DRAIN_BATCHES) {
      const batch = this.state.batches[0];
      let response;
      try {
        response = await this._fetchWithDeadline(`/api/apps/${encodeURIComponent(batch.slug)}/activity`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          keepalive: true,
          body: JSON.stringify({
            version: 1,
            batchId: batch.id,
            entries: batch.entries,
          }),
        });
      } catch {
        return false;
      }
      if (generation !== this.stateGeneration) return false;
      if (response && response.ok) {
        this.state.batches.shift();
        sent += 1;
        this._stageOne();
        this._persist();
        continue;
      }
      const status = Number(response && response.status);
      if (status === 401) {
        this.clearAccount();
        return false;
      }
      if (status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429) {
        // Invalid/stale/access-denied data cannot become valid on retry.  Drop
        // this stable receipt; a blocked app's remaining buffers are cleared
        // by the app-blocks-changed lifecycle event.
        this.state.batches.shift();
        sent += 1;
        this._stageOne();
        this._persist();
        continue;
      }
      return false;
    }
    return sent > 0;
  }

  async _fetchWithDeadline(url, options) {
    const Controller = this.AbortController;
    const controller = Controller ? new Controller() : null;
    this.inflightController = controller;
    let timeout = null;
    const expired = new Promise((_, reject) => {
      timeout = this.setTimeout?.(() => {
        try { controller?.abort(); } catch { /* already settled */ }
        reject(new Error(globalThis.PlatformI18n.t("apps:activity_upload_timed_out_9764bee6")));
      }, this.fetchTimeoutMs);
    });
    try {
      const request = this.fetch(url, controller
        ? { ...options, signal: controller.signal } : options);
      return await Promise.race([request, expired]);
    } finally {
      if (timeout && this.clearTimeout) this.clearTimeout(timeout);
      if (this.inflightController === controller) this.inflightController = null;
    }
  }

  _changeStateGeneration() {
    this.stateGeneration += 1;
    try { this.inflightController?.abort(); } catch { /* request already settled */ }
    this.inflightController = null;
  }

  _persist() {
    this.lastPersistAt = this.now();
    if (!this.state.owner) return;
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify({
        version: 1,
        owner: this.state.owner,
        batches: this.state.batches.slice(-ACTIVITY_MAX_BATCHES),
        buffers: this.state.buffers,
      }));
    } catch { /* private mode/quota: current-page delivery still proceeds */ }
  }
}

export const appActivity = new EngagedAppUsage();
