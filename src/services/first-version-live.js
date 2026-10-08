'use strict';

// #4449: LIVE, the new app itself taking shape while its first version is
// built, beside #4387's first look (services/first-version-screens.js).
//
//   THE WATCHER  worker/usernode-live-watch.js, in the build's own worker,
//                started with the first version's build turn and killed when
//                it ends (liveController, from homeroom-bot.js buildLive via
//                homeroom-bot-live.js buildAndPropose `onBuildTurn`). It
//                boots the app on every change and records it with rrweb.
//                Always on during "Building it" while the Admin setting is
//                (KEY, read through a short cache: liveEnabled).
//   THE STREAM   the watcher appends one JSON object a line to a file in the
//                worker; the platform reads it as it grows (READ_SCRIPT,
//                every POLL_MS) and keeps, per run, the latest good restart's
//                events and what was recorded on it since, at most
//                MAX_STORED_BYTES (first_version_live_chunks). Everything is
//                SANITISED first (sanitizeEvents): no URL but data:, no
//                script, nothing a viewer could fetch.
//   THE READ     GET /api/apps/:slug/first-version/live?since=<seq>
//                (liveOf), for the project's members only, the gate of the
//                first version's screens.
//   MEASURED     events.js: first_version_build_turn on every first
//                version's build turn (with whether the watcher ran),
//                live_build_stream per run, live_build_opened and
//                live_build_watched from the App tab.
//
// The watcher must never fail, block or slow the build turn: starting it is
// not waited on, every error here ends the stream quietly, and the watcher
// itself runs under nice/ionice and stops on low memory (worker side).

const fs = require('fs');
const path = require('path');
const log = require('./logger');
const events = require('./events');

const KEY = 'live_build_stream';
const CACHE_MS = 10 * 1000;
const DIR = '/tmp/usernode-live';
const PORT = 3300;
const DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/usernode_live';
// Memory headroom the watcher needs before it starts and before each
// restart, and below which it stops while it runs (worker side). A worker
// has 2 GiB by default; Chromium and a small app take about 400 MB.
const START_HEADROOM_MB = 768;
const RUN_HEADROOM_MB = 384;
const POLL_MS = 3000;
// One line of the stream is at most the watcher's MAX_FULL_BYTES (1.5 MB);
// a read takes up to this, so a whole line always fits.
const READ_BYTES = 2 * 1024 * 1024;
const MAX_STORED_BYTES = 2 * 1024 * 1024;
const WATCH_FILE = path.join(__dirname, '..', '..', 'worker', 'usernode-live-watch.js');
const LIB_FILE = path.join(__dirname, '..', '..', 'worker', 'usernode-bench-capture.js');

// ── The setting ──────────────────────────────────────────────────────────

const caches = new WeakMap();

/** Whether Live is on (no row, or a failed read: on). Cached per pool. */
async function liveEnabled(pool) {
  const cached = caches.get(pool);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.on;
  let on = true;
  try {
    const { rows } = await pool.query('SELECT value FROM platform_settings WHERE key = $1', [KEY]);
    on = !rows[0] || rows[0].value !== 'off';
  } catch (err) {
    log.debug('first-version-live', 'Setting read failed; Live stays on', { err: err.message });
  }
  caches.set(pool, { at: Date.now(), on });
  return on;
}

function forgetSetting(pool) {
  caches.delete(pool);
}

// ── Sanitising ───────────────────────────────────────────────────────────

// rrweb's top-level event types and incremental sources
// (@rrweb/types EventType, IncrementalSource) that are kept. Everything else
// (custom and plugin events, canvas, fonts, media, console logs) is dropped.
const EVENT = Object.freeze({ DomContentLoaded: 0, Load: 1, FullSnapshot: 2, IncrementalSnapshot: 3, Meta: 4 });
const KEPT_SOURCES = new Set([0, 1, 2, 3, 4, 5, 6, 8, 12, 13, 14, 15]);
const NODE = Object.freeze({ Document: 0, DocumentType: 1, Element: 2, Text: 3, CDATA: 4, Comment: 5 });
// Attributes that name something to fetch or navigate to.
const URL_ATTRS = new Set([
  'src', 'href', 'srcset', 'imagesrcset', 'action', 'formaction', 'poster', 'data', 'background', 'xlink:href',
  'ping', 'cite', 'longdesc', 'manifest', 'codebase', 'archive', 'profile', 'usemap', 'icon', 'lowsrc', 'dynsrc',
  'itemtype', 'rr_src', 'rr_dataurl',
]);
const DROPPED_TAGS = new Set(['script', 'noscript', 'iframe', 'frame', 'object', 'embed', 'applet', 'portal', 'base']);
const DATA_URL = /^\s*data:/i;
const DATA_IMAGE = /^\s*data:image\/(png|jpeg|jpg|gif|webp|svg\+xml|avif)[;,]/i;

// url("…"), url('…'), url(…) and the newer src(…), with their payload.
const URL_FN = /\b(?:url|src)\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)]*?))\s*\)/gi;
const IMAGE_SET = /image-set\((?:[^()]|\([^()]*\))*\)/gi;
// A data: URL (never an HTML one) names nothing to fetch.
const KEPT_URL = (u) => /^\s*data:/i.test(u) && !/^\s*data:text\/html/i.test(u);
// SVG's own references (fill="url(#grad)"): a fragment, resolved in the
// document. Kept only in these attributes; anywhere else url(#…) is blanked,
// as it could resolve against the viewer's page.
const SVG_REF_ATTRS = new Set(['fill', 'stroke', 'clip-path', 'mask', 'filter', 'marker-start', 'marker-mid', 'marker-end']);
// Elements whose href="#id" is resolved in the document (an <image> or
// <feImage> would load it).
const LOCAL_HREF_TAGS = new Set(['use', 'a', 'textpath', 'mpath']);
const LOCAL_REF = /^url\(\s*(['"]?)#[A-Za-z0-9_-]+\1\s*\)$/;

function cssPass(text) {
  return String(text)
    .replace(/@import\b[^;]*;?/gi, '')
    .replace(URL_FN, (whole, dq, sq, bare) => (KEPT_URL(dq ?? sq ?? bare ?? '') ? whole : 'url()'))
    // image-set("a.png" 1x) names images by bare strings.
    .replace(IMAGE_SET, (whole) => (/(["'])(?!\s*data:)[^"']*\1/i.test(whole) ? 'none' : whole));
}

// CSS escapes decoded (`\75 rl(` is url(), `\40 import` is @import), to
// check what the browser would read.
function decodeCssEscapes(text) {
  return String(text).replace(/\\([0-9a-f]{1,6})\s?|\\([\s\S])/gi, (m, hex, ch) => {
    if (ch !== undefined) return ch;
    const cp = parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  });
}

function cssIsClean(css) {
  const read = decodeCssEscapes(css);
  if (/@import/i.test(read)) return false;
  for (const m of read.matchAll(/\b(?:url|src)\(\s*(["']?)([^)"']*)/gi)) {
    if (m[2].trim() && !KEPT_URL(m[2])) return false;
  }
  return !/image-set\([^)]*["'](?!\s*data:)/i.test(read);
}

/**
 * CSS with every URL that is not a data: URL blanked (url(), src(),
 * image-set()) and every @import removed. A sheet that still reads as
 * fetching something once its escapes are decoded loses its escapes and is
 * cleaned again. Pure.
 */
function sanitizeCss(text) {
  const css = cssPass(text == null ? '' : text);
  return cssIsClean(css) ? css : cssPass(css.replace(/\\[0-9a-f]{1,6}\s?|\\[\s\S]/gi, ''));
}

function cleanAttrValue(name, value, tag) {
  const key = String(name).toLowerCase();
  if (key.startsWith('on')) return undefined;
  if (key === 'srcdoc' || key === 'http-equiv' || key === 'nonce' || key === 'integrity') return undefined;
  if (typeof value === 'object' && value !== null) {
    // A style attribute as rrweb diffs it: { prop: value | [value, priority] | false }.
    if (key !== 'style') return undefined;
    const out = {};
    for (const [prop, v] of Object.entries(value)) {
      if (v === false) out[prop] = false;
      else if (Array.isArray(v)) out[prop] = [sanitizeCss(v[0]), typeof v[1] === 'string' ? v[1] : ''];
      else if (typeof v === 'string') out[prop] = sanitizeCss(v);
    }
    return out;
  }
  if (value === null) return null;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value !== 'string') return undefined;
  if (key === '_csstext' || key === 'style') return sanitizeCss(value);
  if (key === 'rr_dataurl') return DATA_IMAGE.test(value) ? value : undefined;
  if (URL_ATTRS.has(key)) {
    if (key === 'srcset' || key === 'imagesrcset') {
      return value.split(',').every((c) => DATA_URL.test(c)) ? value : undefined;
    }
    // A fragment (an SVG <use href="#icon">) names nothing to fetch.
    if ((key === 'href' || key === 'xlink:href') && LOCAL_HREF_TAGS.has(tag) && /^#[A-Za-z0-9_-]+$/.test(value)) return value;
    // Only data: here: a fragment in src= resolves against the viewer's own
    // page (an about:blank frame inherits its base URL) and would fetch it.
    return KEPT_URL(value) ? value : undefined;
  }
  if (tag === 'meta' && key === 'content') return undefined;
  // Any other attribute that carries CSS (an SVG presentation attribute
  // such as fill="url(#a)" is local, so only a non-local url() is cut).
  if (SVG_REF_ATTRS.has(key) && LOCAL_REF.test(value.trim())) return value;
  if (/url\s*\(/i.test(value)) return sanitizeCss(value).replace(/url\(\)/g, 'none');
  return value;
}

/** The attributes of one element, cleaned. Pure. */
function cleanAttributes(attrs, tag) {
  const out = {};
  for (const [name, value] of Object.entries(attrs || {})) {
    const clean = cleanAttrValue(name, value, tag);
    if (clean !== undefined) out[name] = clean;
  }
  return out;
}

/**
 * One serialized node (rrweb-snapshot) cleaned, with its children: its
 * URLs and CSS as sanitizeCss and cleanAttrValue say, a script's text
 * dropped, and the elements that can load a document of their own (an
 * iframe, an object…) replaced by an empty placeholder. Null to drop it.
 * Pure; never mutates its input.
 */
function sanitizeNode(node, parentTag = null) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === NODE.Element) {
    const tag = String(node.tagName || '').toLowerCase();
    if (DROPPED_TAGS.has(tag)) {
      // Kept as an empty <div>, so the ids the recording names stay whole.
      return { type: NODE.Element, id: node.id, tagName: 'div', attributes: {}, childNodes: [] };
    }
    if (tag === 'link') {
      // A stylesheet rrweb inlined is its _cssText; any other link goes.
      const css = node.attributes && typeof node.attributes._cssText === 'string' ? sanitizeCss(node.attributes._cssText) : null;
      return { type: NODE.Element, id: node.id, tagName: css != null ? 'style' : 'meta', attributes: css != null ? { _cssText: css } : {}, childNodes: [] };
    }
    return {
      ...node,
      attributes: cleanAttributes(node.attributes, tag),
      childNodes: (Array.isArray(node.childNodes) ? node.childNodes : []).map((c) => sanitizeNode(c, tag)).filter(Boolean),
    };
  }
  if (node.type === NODE.Text) {
    const text = typeof node.textContent === 'string' ? node.textContent : '';
    if (parentTag === 'script') return { ...node, textContent: '' };
    return { ...node, textContent: node.isStyle || parentTag === 'style' ? sanitizeCss(text) : text };
  }
  if (node.type === NODE.Document) {
    return { ...node, childNodes: (Array.isArray(node.childNodes) ? node.childNodes : []).map((c) => sanitizeNode(c)).filter(Boolean) };
  }
  if (node.type === NODE.DocumentType) return { type: node.type, id: node.id, name: 'html', publicId: '', systemId: '' };
  if (node.type === NODE.Comment) return { type: node.type, id: node.id, textContent: '' };
  if (node.type === NODE.CDATA) return { type: node.type, id: node.id, textContent: '' };
  return null;
}

function sanitizeMutation(data) {
  const texts = (Array.isArray(data.texts) ? data.texts : []).map((t) => ({
    id: t.id, value: typeof t.value === 'string' && /url\s*\(|@import/i.test(t.value) ? sanitizeCss(t.value) : t.value,
  }));
  const attributes = (Array.isArray(data.attributes) ? data.attributes : []).map((a) => {
    const out = {};
    for (const [name, value] of Object.entries(a.attributes || {})) {
      const clean = cleanAttrValue(name, value, null);
      // A URL that may not be kept is removed rather than left as it was.
      out[name] = clean === undefined ? null : clean;
    }
    return { id: a.id, attributes: out };
  });
  const adds = (Array.isArray(data.adds) ? data.adds : [])
    .map((a) => ({ parentId: a.parentId, nextId: a.nextId ?? null, ...(a.previousId !== undefined ? { previousId: a.previousId } : {}), node: sanitizeNode(a.node) }))
    .filter((a) => a.node);
  const removes = Array.isArray(data.removes) ? data.removes : [];
  return { ...data, texts, attributes, adds, removes };
}

function sanitizeRules(rules) {
  return (Array.isArray(rules) ? rules : []).map((r) => (r && typeof r === 'object' ? { ...r, ...(typeof r.rule === 'string' ? { rule: sanitizeCss(r.rule) } : {}) } : r));
}

/** One rrweb event cleaned, or null to drop it. Pure. */
function sanitizeEvent(event) {
  if (!event || typeof event !== 'object' || !Number.isFinite(event.timestamp)) return null;
  const { type, timestamp } = event;
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  if (type === EVENT.DomContentLoaded || type === EVENT.Load) return { type, timestamp, data: {} };
  if (type === EVENT.Meta) {
    return { type, timestamp, data: { href: '', width: Number(data.width) || 390, height: Number(data.height) || 760 } };
  }
  if (type === EVENT.FullSnapshot) {
    const node = sanitizeNode(data.node);
    return node ? { type, timestamp, data: { node, initialOffset: data.initialOffset || { top: 0, left: 0 } } } : null;
  }
  if (type !== EVENT.IncrementalSnapshot || !KEPT_SOURCES.has(data.source)) return null;
  if (data.source === 0) return { type, timestamp, data: sanitizeMutation(data) };
  if (data.source === 8) {
    return { type, timestamp, data: { ...data, adds: sanitizeRules(data.adds) } };
  }
  if (data.source === 13) {
    const set = data.set && typeof data.set.value === 'string' ? { ...data.set, value: sanitizeCss(data.set.value) } : data.set;
    return { type, timestamp, data: { ...data, ...(set ? { set } : {}) } };
  }
  if (data.source === 15) {
    const styles = (Array.isArray(data.styles) ? data.styles : []).map((s) => ({ ...s, rules: sanitizeRules(s.rules) }));
    return { type, timestamp, data: { ...data, styles } };
  }
  return { type, timestamp, data };
}

/** A batch of rrweb events, cleaned. Pure. */
function sanitizeEvents(list) {
  return (Array.isArray(list) ? list : []).map(sanitizeEvent).filter(Boolean);
}

// ── The worker's side ────────────────────────────────────────────────────

/** The watcher's three files, each { path, content }. */
function watcherFiles({ appId }) {
  const config = {
    dir: DIR, port: PORT, databaseUrl: DATABASE_URL, appId: Number(appId) || 1,
    startHeadroomMb: START_HEADROOM_MB, runHeadroomMb: RUN_HEADROOM_MB,
    libPath: `${DIR}/capture-lib.js`, rrwebPath: `${DIR}/rrweb.cjs`,
  };
  const rrwebFile = path.join(path.dirname(require.resolve('rrweb')), 'rrweb.umd.min.cjs');
  return [
    { path: `${DIR}/capture-lib.js`, content: fs.readFileSync(LIB_FILE, 'utf8') },
    { path: `${DIR}/rrweb.cjs`, content: fs.readFileSync(rrwebFile, 'utf8') },
    { path: `${DIR}/watch.js`, content: `'use strict';\nconst LIVE = ${JSON.stringify(config)};\n${fs.readFileSync(WATCH_FILE, 'utf8')}` },
  ];
}

// Started in the background, at the lowest CPU (and, where there is one,
// I/O) priority, in a session of its own so it is stopped as one group.
const START_SCRIPT = [
  `D=${DIR}`,
  'rm -f "$D/stream.ndjson" "$D/progress" "$D/pid" "$D/app.pgid"',
  ': > "$D/heartbeat"',
  'N="nice -n 19"',
  'command -v ionice >/dev/null 2>&1 && N="$N ionice -c 3"',
  'S=""',
  'command -v setsid >/dev/null 2>&1 && S=setsid',
  'cd /home/node/workspace 2>/dev/null || cd /',
  'nohup $S $N node "$D/watch.js" >"$D/watch.log" 2>&1 &',
  'echo $! > "$D/pid"',
].join('\n');

// $1: 1 to note a progress marker; $2: the byte offset read up to.
const READ_SCRIPT = [
  `D=${DIR}`,
  ': > "$D/heartbeat"',
  '[ "$1" = 1 ] && : > "$D/progress"',
  '[ -f "$D/stream.ndjson" ] || exit 0',
  `tail -c +$(($2 + 1)) "$D/stream.ndjson" | head -c ${READ_BYTES}`,
].join('\n');

const STOP_SCRIPT = [
  `D=${DIR}`,
  'p=$(cat "$D/pid" 2>/dev/null)',
  'a=$(cat "$D/app.pgid" 2>/dev/null)',
  'if [ -n "$p" ]; then',
  '  kill -TERM "$p" 2>/dev/null',
  '  i=0',
  '  while [ $i -lt 10 ] && kill -0 "$p" 2>/dev/null; do sleep 0.5; i=$((i + 1)); done',
  '  kill -KILL -- "-$p" 2>/dev/null; kill -KILL "$p" 2>/dev/null',
  'fi',
  '[ -n "$a" ] && kill -KILL -- "-$a" 2>/dev/null',
  'rm -rf "$D/app"',
  'true',
].join('\n');

/**
 * The whole lines in a read (each parsed, or skipped when it is not JSON)
 * and how many bytes they took. A partial last line waits for the next
 * read. Pure.
 */
function splitLines(text) {
  const s = String(text || '');
  const end = s.lastIndexOf('\n');
  if (end < 0) return { lines: [], bytes: 0 };
  const consumed = s.slice(0, end + 1);
  const lines = [];
  for (const raw of consumed.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object' && typeof obj.t === 'string') lines.push(obj);
    } catch { /* not ours */ }
  }
  return { lines, bytes: Buffer.byteLength(consumed, 'utf8') };
}

// ── Storing ──────────────────────────────────────────────────────────────

async function openRun(pool, runId) {
  await pool.query(
    `INSERT INTO first_version_live (bot_run_id) VALUES ($1)
     ON CONFLICT (bot_run_id) DO UPDATE
       SET next_seq = first_version_live.next_seq, base_seq = NULL, bytes = 0, restarts_kept = 0, restarts_failed = 0,
           good_at = NULL, failed_at = NULL, event_at = NULL, stopped_why = NULL, started_at = NOW(), ended_at = NULL`,
    [Number(runId)],
  );
  await pool.query('DELETE FROM first_version_live_chunks WHERE bot_run_id = $1', [Number(runId)]);
  // Recordings of builds that ended a day ago are nobody's to watch.
  await pool.query(
    `DELETE FROM first_version_live_chunks c USING first_version_live l
      WHERE c.bot_run_id = l.bot_run_id AND l.ended_at < NOW() - INTERVAL '1 day'`,
  ).catch(() => {});
}

/**
 * One line of the stream, kept. `stats` is the run's tally in memory
 * ({ bytes, base, kept, failed, goodFrame, memoryStop, stoppedWhy, dropped }).
 */
async function ingest(pool, runId, msg, stats) {
  const id = Number(runId);
  if (msg.t === 'full' || msg.t === 'inc') {
    if (msg.t === 'inc' && stats.base == null) return;
    const clean = sanitizeEvents(msg.events);
    if (!clean.length) return;
    const json = JSON.stringify(clean);
    const bytes = Buffer.byteLength(json);
    if (msg.t === 'full' && bytes > MAX_STORED_BYTES) {
      stats.failed += 1;
      await pool.query('UPDATE first_version_live SET restarts_failed = restarts_failed + 1, failed_at = NOW() WHERE bot_run_id = $1', [id]);
      return;
    }
    if (msg.t === 'inc' && stats.bytes + bytes > MAX_STORED_BYTES) {
      // Full: what follows waits for the next good restart.
      stats.dropped += 1;
      return;
    }
    const { rows: [row] } = await pool.query(
      'UPDATE first_version_live SET next_seq = next_seq + 1 WHERE bot_run_id = $1 RETURNING next_seq - 1 AS seq',
      [id],
    );
    if (!row) return;
    const seq = Number(row.seq);
    await pool.query(
      'INSERT INTO first_version_live_chunks (bot_run_id, seq, kind, events, bytes) VALUES ($1, $2, $3, $4::jsonb, $5)',
      [id, seq, msg.t, json, bytes],
    );
    if (msg.t === 'full') {
      await pool.query('DELETE FROM first_version_live_chunks WHERE bot_run_id = $1 AND seq < $2', [id, seq]);
      await pool.query(
        `UPDATE first_version_live SET base_seq = $2, bytes = $3, restarts_kept = restarts_kept + 1, good_at = NOW(), event_at = NOW()
          WHERE bot_run_id = $1`,
        [id, seq, bytes],
      );
      stats.base = seq;
      stats.bytes = bytes;
      stats.kept += 1;
      stats.goodFrame = true;
    } else {
      await pool.query('UPDATE first_version_live SET bytes = bytes + $2, event_at = NOW() WHERE bot_run_id = $1', [id, bytes]);
      stats.bytes += bytes;
    }
    return;
  }
  if (msg.t === 'fail') {
    stats.failed += 1;
    await pool.query('UPDATE first_version_live SET restarts_failed = restarts_failed + 1, failed_at = NOW() WHERE bot_run_id = $1', [id]);
    return;
  }
  if (msg.t === 'mem') {
    const mb = Number(msg.headroomMb);
    if (Number.isFinite(mb)) stats.minHeadroomMb = stats.minHeadroomMb == null ? mb : Math.min(stats.minHeadroomMb, mb);
    return;
  }
  if (msg.t === 'stop') {
    const why = String(msg.why || 'error').replace(/[^a-z_]/g, '').slice(0, 32) || 'error';
    if (!stats.stoppedWhy) stats.stoppedWhy = why;
    if (why === 'memory') stats.memoryStop = true;
    await pool.query('UPDATE first_version_live SET stopped_why = COALESCE(stopped_why, $2) WHERE bot_run_id = $1', [id, why]);
  }
}

// ── The build turn's controller ──────────────────────────────────────────

/**
 * A first version's Live, for its build (homeroom-bot.js buildLive).
 * `onProgress(line)` notes a `usernode-progress` marker (a restart);
 * `onBuildTurn({ containerName })` starts the watcher when Live is on and
 * answers `{ end({ buildTurnMs, turnsMs, nudged }) }`, which stops it and
 * records the run's numbers. Neither ever throws or waits on the worker.
 */
function liveController({ pool, runId, appId, sessionId = null, worker }) {
  let progress = false;
  let started = false;
  return {
    onProgress(line) {
      if (started && require('./first-version-screens').captionOf(line)) progress = true;
    },
    onBuildTurn({ containerName }) {
      const stats = { bytes: 0, base: null, kept: 0, failed: 0, goodFrame: false, memoryStop: false, stoppedWhy: null, dropped: 0, minHeadroomMb: null };
      let setting = null;
      let ran = false;
      let ended = false;
      let offset = 0;
      let timer = null;
      let reading = Promise.resolve();
      const where = { runId, containerName };

      const read = async () => {
        const flag = progress ? '1' : '0';
        progress = false;
        const out = await worker.runLiveScript(containerName, READ_SCRIPT, {
          args: [flag, String(offset)], timeoutMs: 15000, maxBuffer: READ_BYTES + 1024 * 1024,
        });
        const { lines, bytes } = splitLines(out);
        // A line longer than a whole read (the watcher never writes one) is
        // passed over rather than read again forever.
        offset += bytes || (Buffer.byteLength(out) >= READ_BYTES ? Buffer.byteLength(out) : 0);
        for (const msg of lines) {
          // eslint-disable-next-line no-await-in-loop
          await ingest(pool, runId, msg, stats);
        }
      };
      const tick = () => {
        timer = null;
        if (ended) return;
        reading = read()
          .catch((err) => log.debug('first-version-live', 'Live read failed', { ...where, err: err.message }))
          // Once the watcher has stopped (memory, an error), there is nothing more to read.
          .finally(() => { if (!ended && !stats.stoppedWhy) timer = setTimeout(tick, POLL_MS); });
      };

      const starting = (async () => {
        setting = await liveEnabled(pool);
        if (!setting || !containerName || typeof worker?.runLiveScript !== 'function') return;
        await openRun(pool, runId);
        await worker.runLiveScript(containerName, START_SCRIPT, { files: watcherFiles({ appId }), timeoutMs: 20000 });
        ran = true;
        started = true;
        if (!ended) timer = setTimeout(tick, POLL_MS);
      })().catch((err) => {
        log.info('first-version-live', 'Live did not start; the build goes on', { ...where, err: err.message });
      });

      return {
        end({ buildTurnMs = null, turnsMs = null, nudged = false } = {}) {
          if (ended) return Promise.resolve();
          ended = true;
          return (async () => {
            await starting;
            if (timer) { clearTimeout(timer); timer = null; }
            await reading;
            if (ran) {
              // What it wrote last, then stopped.
              await read().catch(() => {});
              await worker.runLiveScript(containerName, STOP_SCRIPT, { timeoutMs: 20000 }).catch(() => {});
              await pool.query(
                'UPDATE first_version_live SET ended_at = NOW(), stopped_why = COALESCE(stopped_why, $2) WHERE bot_run_id = $1',
                [Number(runId), 'ended'],
              ).catch(() => {});
              events.record(pool, {
                type: events.EVENT_TYPES.LIVE_BUILD_STREAM, appId, sessionId,
                metadata: {
                  runId: Number(runId), restartsKept: stats.kept, restartsFailed: stats.failed, goodFrame: stats.goodFrame,
                  memoryStop: stats.memoryStop, stoppedWhy: stats.stoppedWhy || 'ended', bytes: stats.bytes,
                  incDropped: stats.dropped, minHeadroomMb: stats.minHeadroomMb,
                },
              });
            }
            events.record(pool, {
              type: events.EVENT_TYPES.FIRST_VERSION_BUILD_TURN, appId, sessionId,
              metadata: {
                runId: Number(runId), buildTurnMs, turnsMs, nudged: !!nudged, watcher: ran, setting: setting !== false,
              },
            });
          })().catch((err) => log.debug('first-version-live', 'Ending Live failed', { ...where, err: err.message }));
        },
      };
    },
  };
}

// ── What the App tab reads ───────────────────────────────────────────────

const RUN_SQL = `SELECT r.id
                   FROM homeroom_bot_first_versions f
                   JOIN homeroom_bot_runs r ON r.app_id = f.app_id AND r.issue_number = f.issue_number
                  WHERE f.app_id = $1 AND f.bot_builds = TRUE
                  ORDER BY r.id DESC
                  LIMIT 1`;

/** The state a Live pill says. Pure. */
function liveState(row) {
  if (!row || row.base_seq == null) return row && row.stopped_why && row.stopped_why !== 'ended' ? 'stopped' : 'starting';
  const good = row.good_at ? new Date(row.good_at).getTime() : 0;
  const failed = row.failed_at ? new Date(row.failed_at).getTime() : 0;
  return failed > good ? 'failed' : 'live';
}

/**
 * The project's first version's Live, from `since` (the last chunk the
 * viewer has): { runId, state, seq, reset, events, age }. `reset` says the
 * viewer starts over from a new good restart; `age` is seconds since the
 * last event. Null when there is no run.
 */
async function liveOf(pool, appId, since = 0) {
  const { rows: [run] } = await pool.query(RUN_SQL, [Number(appId)]);
  if (!run) return null;
  const { rows: [row] } = await pool.query(
    `SELECT base_seq, good_at, failed_at, stopped_why, ended_at,
            EXTRACT(EPOCH FROM (NOW() - event_at))::float AS age
       FROM first_version_live WHERE bot_run_id = $1`,
    [Number(run.id)],
  );
  const runId = Number(run.id);
  const state = liveState(row);
  if (!row || row.base_seq == null) return { runId, state, seq: 0, reset: false, events: [], age: null };
  const base = Number(row.base_seq);
  const after = Number.isInteger(since) && since >= base ? since : null;
  const { rows } = await pool.query(
    `SELECT seq, events FROM first_version_live_chunks
      WHERE bot_run_id = $1 AND seq ${after == null ? '>= $2' : '> $2'}
      ORDER BY seq`,
    [runId, after == null ? base : after],
  );
  const out = [];
  let seq = after == null ? base - 1 : after;
  for (const r of rows) {
    seq = Math.max(seq, Number(r.seq));
    const list = typeof r.events === 'string' ? JSON.parse(r.events) : r.events;
    if (Array.isArray(list)) out.push(...list);
  }
  return {
    runId, state, seq, reset: after == null, events: out,
    age: row.age == null ? null : Math.max(0, Math.round(Number(row.age))),
  };
}

/** A member's Live opened or watched, as an analytics event. */
function recordView(pool, { userId, appId, runId, kind, seconds = null, goodFrame = false }) {
  if (kind === 'opened') {
    return events.record(pool, { type: events.EVENT_TYPES.LIVE_BUILD_OPENED, userId, appId, metadata: { runId } });
  }
  const s = Math.min(Math.max(Math.round(Number(seconds) || 0), 0), 6 * 3600);
  return events.record(pool, {
    type: events.EVENT_TYPES.LIVE_BUILD_WATCHED, userId, appId, metadata: { runId, seconds: s, goodFrame: !!goodFrame },
  });
}

module.exports = {
  KEY,
  DIR,
  PORT,
  DATABASE_URL,
  START_HEADROOM_MB,
  RUN_HEADROOM_MB,
  MAX_STORED_BYTES,
  POLL_MS,
  START_SCRIPT,
  READ_SCRIPT,
  STOP_SCRIPT,
  liveEnabled,
  forgetSetting,
  sanitizeCss,
  sanitizeNode,
  sanitizeEvent,
  sanitizeEvents,
  watcherFiles,
  splitLines,
  openRun,
  ingest,
  liveController,
  liveState,
  liveOf,
  recordView,
};
