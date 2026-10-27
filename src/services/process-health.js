'use strict';

// How busy each process was, per minute, and what it was doing when its
// event loop stalled.
//
// A web Pod once sat at one core for seven minutes and failed its liveness
// probe twice (27 Oct 2026, release 5688053) while it answered no more
// requests than usual and logged almost nothing. The request counts said
// how many; nothing said whether the loop was busy, blocked or collecting
// garbage, or which request it was on. Here every process keeps, per
// minute, and flushes beside its server counts (services/server-error-
// counts.js, the route costs there say which route cost the time):
//
//   server_process_minutes  (minute, pod)  role, cpu_ms, loop_utilization,
//                           loop_delay_p99_ms, loop_delay_max_ms, stalls,
//                           stall_max_ms, gc_ms, gc_count, gc_max_ms,
//                           rss_mb, heap_used_mb (the minute's peaks)
//
// and a watcher that wakes every TICK_MS: a wake-up STALL_MS or more after
// the one before means the loop was held for between that gap less one tick
// and the gap. One warning (at most one per LOG_EVERY_MS) then says what was
// going on, SETTLE_MS later, once the collections and finished responses of
// the stall have been delivered: the requests still in flight
// (middleware/inflight-requests.js), the slow ones that finished across the
// stall (the one that held it, most often, is done by the time the watcher
// runs), and how much of it was garbage collection. It names route
// templates and surfaces, never a path a person requested.
//
// A minute is sampled just after it ends, on a timer re-armed from the
// clock each time, and flushed at once, so a process killed outright loses
// at most the minute it was in; a sample the loop held late covers its
// overrun, under the minute it began in. Memory is bounded: MAX_MINUTES
// minutes held while the database refuses the flush, and RING slow
// requests.

const { performance, monitorEventLoopDelay, PerformanceObserver } = require('node:perf_hooks');
const log = require('./logger');
const inflightRequests = require('../middleware/inflight-requests');
const { minuteOf, msToNextMinute, podName } = require('./server-error-counts');

const RETENTION_DAYS = 14;
const MAX_MINUTES = 30;
const TICK_MS = 200;
const STALL_MS = 1000;
const LOG_EVERY_MS = 10 * 1000;
// Node hands collections to their observer, and finishes responses, a few
// milliseconds after the loop is let go; the warning waits this long.
const SETTLE_MS = 50;
// The event-loop delay histogram samples every this many ms, and records
// the whole interval between samples: this much of every figure is the
// sampling itself, not delay.
const DELAY_RESOLUTION_MS = 20;
// A request that took this long is kept for the next stall's warning.
const SLOW_MS = 250;
const RING = 50;
// Memory is read every this many ticks (once a second), for the minute's peak.
const MEMORY_EVERY = 5;
const LISTED = 10;
const MB = 1024 * 1024;

const round = (n, places = 1) => {
  const f = 10 ** places;
  return Number.isFinite(n) ? Math.round(n * f) / f : 0;
};

// ── Pure helpers ────────────────────────────────────────────────────────

function emptyWindow() {
  return {
    cpuMs: 0, activeMs: 0, windowMs: 0, delayP99Ms: 0, delayMaxMs: 0, stalls: 0, stallMaxMs: 0,
    gcMs: 0, gcCount: 0, gcMaxMs: 0, rssMb: 0, heapUsedMb: 0,
  };
}

/** Pure: two windows of one minute as one (sums, and the larger peak). */
function mergeWindow(a, b) {
  return {
    cpuMs: a.cpuMs + b.cpuMs,
    activeMs: a.activeMs + b.activeMs,
    windowMs: a.windowMs + b.windowMs,
    delayP99Ms: Math.max(a.delayP99Ms, b.delayP99Ms),
    delayMaxMs: Math.max(a.delayMaxMs, b.delayMaxMs),
    stalls: a.stalls + b.stalls,
    stallMaxMs: Math.max(a.stallMaxMs, b.stallMaxMs),
    gcMs: a.gcMs + b.gcMs,
    gcCount: a.gcCount + b.gcCount,
    gcMaxMs: Math.max(a.gcMaxMs, b.gcMaxMs),
    rssMb: Math.max(a.rssMb, b.rssMb),
    heapUsedMb: Math.max(a.heapUsedMb, b.heapUsedMb),
  };
}

/** Pure: entries of `ring` ({ startedAt, endedAt }) that overlap [from, to]. */
function overlapping(ring, from, to) {
  return ring.filter((e) => e.startedAt <= to && e.endedAt >= from);
}

// ── The figures ─────────────────────────────────────────────────────────

/**
 * One process's figures. The readers are this process's own by default;
 * tests pass their own. `now` is epoch ms, `clock` a monotonic ms clock.
 */
function createHealth({
  pod = podName(),
  role = '',
  now = () => Date.now(),
  clock = () => performance.now(),
  cpuUsage = (prev) => process.cpuUsage(prev),
  loopUtilization = () => performance.eventLoopUtilization(),
  delay = null,
  delayResolutionMs = 0,
  memory = () => process.memoryUsage(),
  inflight = () => inflightRequests.snapshot(),
  logger = log,
  // Runs the warning SETTLE_MS later (tests run it when they choose).
  later = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); },
  tickMs = TICK_MS,
  stallMs = STALL_MS,
  logEveryMs = LOG_EVERY_MS,
  maxMinutes = MAX_MINUTES,
} = {}) {
  const rows = new Map(); // minute (ms) → window
  const slow = []; // finished slow requests: { method, route, status, durationMs, startedAt, endedAt }
  let window = emptyWindow();
  let windowStartedAt = now();
  let cpuPrev = cpuUsage();
  let eluPrev = loopUtilization();
  let lastTick = clock();
  let ticks = 0;
  let lastLogAt = -Infinity;
  let suppressed = 0;
  // Every collection's time since this process began, and what it was at
  // the last wake-up: a stall's share is the difference, read once the
  // stall's collections have been delivered.
  let gcTotalMs = 0;
  let gcAtTick = 0;

  const push = (ring, entry) => { ring.push(entry); if (ring.length > RING) ring.shift(); };

  function readMemory() {
    try {
      const m = memory();
      window.rssMb = Math.max(window.rssMb, (m.rss || 0) / MB);
      window.heapUsedMb = Math.max(window.heapUsedMb, (m.heapUsed || 0) / MB);
      return m;
    } catch {
      return null;
    }
  }

  /**
   * A response that finished, or whose client gave up first (`aborted`)
   * (middleware/request-counts.js); only a slow one is kept.
   */
  function noteFinished({ method, route, status, startedAt, durationMs, aborted = false } = {}) {
    if (!(Number.isFinite(durationMs) && durationMs >= SLOW_MS && Number.isFinite(startedAt))) return;
    push(slow, { method, route, status, aborted: !!aborted, durationMs, startedAt, endedAt: startedAt + durationMs });
  }

  /** A garbage collection: how long it took. */
  function noteGc({ durationMs } = {}) {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    window.gcMs += durationMs;
    window.gcCount += 1;
    window.gcMaxMs = Math.max(window.gcMaxMs, durationMs);
    gcTotalMs += durationMs;
  }

  /**
   * The watcher's wake-up: how long since the one before, and when that is
   * a stall, counted in the minute and (at most once per logEveryMs) said,
   * SETTLE_MS later. Returns the gap in ms when it is a stall, or 0.
   */
  function tick() {
    const at = clock();
    const gapMs = at - lastTick;
    lastTick = at;
    ticks += 1;
    const gcBefore = gcAtTick;
    gcAtTick = gcTotalMs;
    if (ticks % MEMORY_EVERY === 0) readMemory();
    if (!(gapMs >= stallMs)) return 0;
    window.stalls += 1;
    window.stallMaxMs = Math.max(window.stallMaxMs, gapMs);
    const endedAt = now();
    if (endedAt - lastLogAt < logEveryMs) { suppressed += 1; return gapMs; }
    lastLogAt = endedAt;
    const unsaid = suppressed;
    suppressed = 0;
    let open = [];
    try { open = inflight().slice(0, LISTED); } catch { /* the warning goes out without them */ }
    later(() => {
      const from = endedAt - gapMs;
      const m = readMemory();
      logger.warn('process-health', 'The event loop stalled', {
        stallMs: Math.round(gapMs),
        blockedAtLeastMs: Math.round(Math.max(0, gapMs - tickMs)),
        ...(unsaid ? { stallsNotLogged: unsaid } : {}),
        inflight: open,
        finishedDuring: overlapping(slow, from, endedAt)
          .sort((a, b) => b.durationMs - a.durationMs)
          .slice(0, LISTED)
          .map((e) => ({
            method: e.method, route: e.route, status: e.status, durationMs: Math.round(e.durationMs),
            ...(e.aborted ? { aborted: true } : {}),
          })),
        gcMs: Math.round(gcTotalMs - gcBefore),
        heapUsedMb: m ? Math.round((m.heapUsed || 0) / MB) : null,
        rssMb: m ? Math.round((m.rss || 0) / MB) : null,
      });
    }, SETTLE_MS);
    return gapMs;
  }

  /** Close the window that began at the last sample, under that minute. */
  function sample() {
    const at = now();
    try {
      const cpu = cpuUsage(cpuPrev);
      window.cpuMs += ((cpu.user || 0) + (cpu.system || 0)) / 1000;
      cpuPrev = cpuUsage();
    } catch { /* this window has no CPU figure */ }
    try {
      const cur = loopUtilization();
      const d = deltaElu(cur, eluPrev);
      if (d) { window.activeMs += d.active; window.windowMs += d.active + d.idle; }
      eluPrev = cur;
    } catch { /* nor a utilization */ }
    if (delay) {
      try {
        // Less the sampling interval the histogram records with each delay.
        const net = (ns) => (Number.isFinite(ns) ? Math.max(0, ns / 1e6 - delayResolutionMs) : 0);
        window.delayP99Ms = Math.max(window.delayP99Ms, net(delay.percentile(99)));
        window.delayMaxMs = Math.max(window.delayMaxMs, net(delay.max));
        delay.reset();
      } catch { /* nor a delay */ }
    }
    readMemory();
    const minute = minuteOf(windowStartedAt);
    const held = rows.get(minute);
    while (!held && rows.size >= maxMinutes) rows.delete(Math.min(...rows.keys()));
    rows.set(minute, held ? mergeWindow(held, window) : window);
    window = emptyWindow();
    windowStartedAt = at;
    return minute;
  }

  /**
   * Upsert every minute held and drop them from memory; minutes the
   * database refused stay for the next flush. `all` samples the minute
   * still going first (a process stopping). Never throws: resolves
   * { minutes } sent.
   */
  async function flush(pool, { all = false } = {}) {
    if (!pool) return { minutes: 0 };
    if (all) sample();
    const taken = [...rows.entries()].sort((a, b) => a[0] - b[0]);
    if (!taken.length) return { minutes: 0 };
    for (const [minute] of taken) rows.delete(minute);
    const col = (f) => taken.map(([, w]) => f(w));
    try {
      await pool.query(PROCESS_UPSERT_SQL, [
        taken.map(([minute]) => new Date(minute).toISOString()), pod, String(role || '').slice(0, 16),
        col((w) => round(w.cpuMs, 1)),
        col((w) => (w.windowMs > 0 ? round(w.activeMs / w.windowMs, 4) : 0)),
        col((w) => round(w.delayP99Ms)), col((w) => round(w.delayMaxMs)),
        col((w) => w.stalls), col((w) => round(w.stallMaxMs)),
        col((w) => round(w.gcMs)), col((w) => w.gcCount), col((w) => round(w.gcMaxMs)),
        col((w) => round(w.rssMb)), col((w) => round(w.heapUsedMb)),
      ]);
      return { minutes: taken.length };
    } catch (err) {
      for (const [minute, w] of taken) {
        const held = rows.get(minute);
        rows.set(minute, held ? mergeWindow(held, w) : w);
      }
      while (rows.size > maxMinutes) rows.delete(Math.min(...rows.keys()));
      log.warn('process-health', 'Could not flush process health; kept for the next flush', { err: err.message });
      return { minutes: 0 };
    }
  }

  /** What is held now, for tests: [{ minute, ...window }], and the window going. */
  function snapshot() {
    return {
      minutes: [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([minute, w]) => ({ minute, ...w })),
      current: { ...window },
    };
  }

  return { pod, noteFinished, noteGc, tick, sample, flush, snapshot };
}

/** Pure: what the loop did between two eventLoopUtilization() readings, in ms. */
function deltaElu(cur, prev) {
  if (!cur || !prev) return null;
  const active = (cur.active || 0) - (prev.active || 0);
  const idle = (cur.idle || 0) - (prev.idle || 0);
  if (!(active >= 0 && idle >= 0)) return null;
  return { active, idle };
}

// ── The database ────────────────────────────────────────────────────────

// One row per process and minute; a minute written twice (put back after a
// refused flush, or sampled late twice) adds its sums and keeps its peaks.
const PROCESS_UPSERT_SQL = `
  INSERT INTO server_process_minutes (minute, pod, role, cpu_ms, loop_utilization, loop_delay_p99_ms,
                                      loop_delay_max_ms, stalls, stall_max_ms, gc_ms, gc_count, gc_max_ms,
                                      rss_mb, heap_used_mb)
  SELECT t.minute, $2::text, $3::text, t.cpu_ms, t.loop_utilization, t.loop_delay_p99_ms, t.loop_delay_max_ms,
         t.stalls, t.stall_max_ms, t.gc_ms, t.gc_count, t.gc_max_ms, t.rss_mb, t.heap_used_mb
    FROM unnest($1::timestamptz[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::int[],
                $9::float8[], $10::float8[], $11::int[], $12::float8[], $13::float8[], $14::float8[])
         AS t(minute, cpu_ms, loop_utilization, loop_delay_p99_ms, loop_delay_max_ms, stalls, stall_max_ms,
              gc_ms, gc_count, gc_max_ms, rss_mb, heap_used_mb)
  ON CONFLICT (minute, pod) DO UPDATE
     SET cpu_ms = server_process_minutes.cpu_ms + EXCLUDED.cpu_ms,
         loop_utilization = GREATEST(server_process_minutes.loop_utilization, EXCLUDED.loop_utilization),
         loop_delay_p99_ms = GREATEST(server_process_minutes.loop_delay_p99_ms, EXCLUDED.loop_delay_p99_ms),
         loop_delay_max_ms = GREATEST(server_process_minutes.loop_delay_max_ms, EXCLUDED.loop_delay_max_ms),
         stalls = server_process_minutes.stalls + EXCLUDED.stalls,
         stall_max_ms = GREATEST(server_process_minutes.stall_max_ms, EXCLUDED.stall_max_ms),
         gc_ms = server_process_minutes.gc_ms + EXCLUDED.gc_ms,
         gc_count = server_process_minutes.gc_count + EXCLUDED.gc_count,
         gc_max_ms = GREATEST(server_process_minutes.gc_max_ms, EXCLUDED.gc_max_ms),
         rss_mb = GREATEST(server_process_minutes.rss_mb, EXCLUDED.rss_mb),
         heap_used_mb = GREATEST(server_process_minutes.heap_used_mb, EXCLUDED.heap_used_mb)`;

const PRUNE_PROCESS_SQL = 'DELETE FROM server_process_minutes WHERE minute < NOW() - make_interval(days => $1)';

/**
 * Remove rows older than RETENTION_DAYS (the server counts' daily clock
 * job). Never throws: resolves { processes } removed, or null.
 */
async function prune(pool, { days = RETENTION_DAYS } = {}) {
  if (!pool) return null;
  try {
    const r = await pool.query(PRUNE_PROCESS_SQL, [days]);
    return { processes: r.rowCount || 0 };
  } catch (err) {
    log.warn('process-health', 'Could not prune old process health', { err: err.message });
    return null;
  }
}

// ── This process ────────────────────────────────────────────────────────

let health = null;
let delayHistogram = null;
let gcObserver = null;
let watcher = null;
let sampler = null;
let running = false;
let flushing = null;

/**
 * Every process, at boot: watch its loop, and sample and flush each minute
 * just after it ends, one flush at a time, the timer re-armed from the
 * clock each time so it stays on the minute. Every timer is unref'd, so
 * none holds the process open.
 */
function start({ pool, role = '' } = {}) {
  if (running || !pool) return;
  running = true;
  try {
    delayHistogram = monitorEventLoopDelay({ resolution: DELAY_RESOLUTION_MS });
    delayHistogram.enable();
  } catch { delayHistogram = null; }
  health = createHealth({ role, delay: delayHistogram, delayResolutionMs: DELAY_RESOLUTION_MS });
  try {
    gcObserver = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) health?.noteGc({ durationMs: e.duration });
    });
    gcObserver.observe({ entryTypes: ['gc'] });
  } catch { gcObserver = null; }
  watcher = setInterval(() => health?.tick(), TICK_MS);
  watcher.unref?.();
  const arm = () => {
    sampler = setTimeout(() => {
      if (!running) return;
      health.sample();
      if (!flushing) flushing = health.flush(pool).finally(() => { flushing = null; });
      arm();
    }, msToNextMinute(Date.now()));
    sampler.unref?.();
  };
  arm();
}

function stop() {
  running = false;
  if (watcher) clearInterval(watcher);
  if (sampler) clearTimeout(sampler);
  watcher = null;
  sampler = null;
  try { gcObserver?.disconnect(); } catch { /* already gone */ }
  try { delayHistogram?.disable(); } catch { /* already off */ }
  gcObserver = null;
  delayHistogram = null;
}

module.exports = {
  // This process's figures (no-ops until start()).
  noteFinished: (entry) => health?.noteFinished(entry),
  flush: (pool, opts) => (health ? health.flush(pool, opts) : Promise.resolve({ minutes: 0 })),
  prune,
  start,
  stop,
  // Pure parts, and a fresh set of figures, for tests.
  createHealth,
  msToNextMinute,
  mergeWindow,
  overlapping,
  deltaElu,
  PROCESS_UPSERT_SQL,
  PRUNE_PROCESS_SQL,
  RETENTION_DAYS,
  TICK_MS,
  STALL_MS,
  SETTLE_MS,
  SLOW_MS,
  LOG_EVERY_MS,
  DELAY_RESOLUTION_MS,
};
