'use strict';

// Before/after visuals on UI-affecting proposals (issue #195).
//
// Runs AFTER a staging preview comes up healthy: decides whether the
// commit range plausibly affects the UI (changed-file heuristic), spawns
// the one-shot headless-Chromium capture container (capture/) to shoot
// the production app ("before") and the staging container ("after") over
// the internal docker network, stores the artifacts in Postgres
// (session_visuals, latest set per session only), patches the GitHub PR
// body's marker-delimited "Before / after" block when a PR exists, and
// emits a `visuals_ready` event so open dev-chat cards upgrade in place.
//
// Capture is an automatic platform pipeline step, not an agent
// responsibility — the worker image has no browser and the coding turn is
// already over by the time staging exists. It is fire-and-forget and
// strictly best-effort: captureForSession never throws, never delays
// staging_ready, and never changes the outcome of a dev turn (same
// contract as the #183 non-fatal staging build).

const crypto = require('crypto');
const path = require('path');
const jwt = require('jsonwebtoken');
const log = require('./logger');
const docker = require('./docker');
const github = require('./github');
const caddy = require('./caddy');
const prMetadata = require('./pr-metadata');
const sessionBus = require('./session-bus');
const appManifest = require('./app-manifest');
const { CAPTURE_MAX_PATHS } = require('./testing-notes');
const { getPool } = require('../db/pool');

const CAPTURE_IMAGE = 'usernode-capture:latest';

// Dedicated capture identity (seeded by src/db/migrate.js). A non-admin
// service account so the public artifacts (/visuals/:id is unauthenticated;
// PR bodies embed them on GitHub) never show anyone's personal data or
// admin-only UI. The capture run is capped at RUN_TIMEOUT_MS (240s); 15
// minutes covers the lazy image build + retry comfortably.
const CAPTURE_USERNAME = 'usernode-capture';
const CAPTURE_AUTH_TTL_MS = 15 * 60 * 1000;

// ── "Is this UI-affecting?" heuristic ──────────────────────────────────
// Deterministic and cheap — no LLM call. A changed file counts as
// frontend if its extension is plainly presentational, OR if it lives
// under a conventionally-frontend directory segment at any depth (which
// catches .js/.ts UI code across arbitrary vibe-coded apps). One match
// in the commit range triggers capture.
const FRONTEND_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.scss', '.less', '.styl',
  '.vue', '.svelte', '.jsx', '.tsx',
]);
const FRONTEND_DIR_SEGMENTS = new Set([
  'public', 'static', 'assets', 'client', 'frontend',
  'www', 'views', 'templates', 'components', 'pages',
]);

// Per-artifact storage caps. Over-cap artifacts are dropped individually —
// the rest of the set still stores, and the PR embed falls back from GIF
// to PNG per side. 1280x800 PNGs run 100-400 KB; a 5-9s webm ~0.5-2 MB;
// the 640px/10fps GIF typically 1-4 MB.
const MAX_BYTES = {
  png: 4 * 1024 * 1024,
  webm: 8 * 1024 * 1024,
  gif: 8 * 1024 * 1024,
};
const CONTENT_TYPES = {
  png: 'image/png',
  webm: 'video/webm',
  gif: 'image/gif',
};

// Recording + GIF encoding add real seconds per page on top of load, and
// the worst-case stdout is six base64 artifacts (2 png + 2 webm + 2 gif).
const RUN_TIMEOUT_MS = 240 * 1000;
const RUN_MAX_BUFFER = 128 * 1024 * 1024;

// Append the capture JWT as a `token` query param. testing_path can
// legitimately carry its own query string (e.g. `/board?demo-pr=1`, see
// testing-notes.js), so the join must pick '?' vs '&'. An empty token
// returns the URL unchanged (unauthenticated capture — current behaviour).
//
// Fragment-safe (#353): a self-app deep link carries a `#app/...` hash
// (the SPA routes off location.hash), and a query param MUST sit before
// the fragment or it never reaches the server. So split off any `#...`
// tail, splice `token=` onto the path+query part, then re-attach the
// fragment. Plain pathname URLs (no `#`) are byte-identical to the old
// concat behaviour.
function withToken(url, token) {
  if (!token) return url;
  const hashAt = url.indexOf('#');
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const frag = hashAt === -1 ? '' : url.slice(hashAt);
  return base + (base.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) + frag;
}

// The self-app is a hash-routed SPA (#353): App.restoreFromHash() in
// public/js/app.js reads location.hash, so its internal screens are
// addressed by fragment (`#app/<slug>/...`, `#leaderboard`, ...), NOT by
// server pathname. A testing path joined as a pathname loads index.html
// with an empty hash → the home feed, for both "before" and "after".
//
// Normalise a self-app testing path into the form the SPA actually
// routes off: if its first segment is one of the SPA hash routes, move
// the whole path into the URL fragment (pathname stays '/'). Anything
// else — the bare '/', a path already written as a fragment ('/#...'),
// or a standalone server-rendered page (/dashboard, /admin, /status,
// /node-status, /login, /register) — is left exactly as-is so those
// real routes still resolve. Only applied for the self-app; child apps
// are genuinely path-routed and pass through untouched.
const SELF_APP_HASH_ROUTES = new Set([
  'app', 'leaderboard', 'group-chat', 'individual-chat',
]);
function selfAppHashPath(p) {
  const path = typeof p === 'string' ? p : '/';
  if (!path.startsWith('/') || path.startsWith('/#')) return path;
  const firstSeg = path.slice(1).split(/[/?#]/)[0];
  if (!SELF_APP_HASH_ROUTES.has(firstSeg)) return path;
  return '/#' + path.slice(1);
}

// "Before" (production) target container for an app. Child apps run as
// `usernode-app-<slug>`; the platform itself runs as the compose service
// named by config.selfAppContainer (default 'usernode'), NOT as
// `usernode-app-<selfAppSlug>` — which is why self-app sessions used to
// get no "before" image at all (#195 follow-up).
function beforeContainerName(config, slug) {
  return slug === config.selfAppSlug
    ? (config.selfAppContainer || 'usernode')
    : `usernode-app-${slug}`;
}

function isFrontendFile(file) {
  const f = String(file || '').replace(/\\/g, '/');
  const ext = path.extname(f).toLowerCase();
  if (FRONTEND_EXTENSIONS.has(ext)) return true;
  const segments = f.split('/').slice(0, -1);
  return segments.some((s) => FRONTEND_DIR_SEGMENTS.has(s.toLowerCase()));
}

function isUiAffecting(files) {
  return Array.isArray(files) && files.some(isFrontendFile);
}

// ── Capture image ──────────────────────────────────────────────────────
// Built lazily by the platform from capture/, mirroring the worker-image
// pattern (worker.js ensureWorkerImage). Memoized per process: capture/
// only changes when the platform itself redeploys, which restarts the
// process anyway; Docker's layer cache makes the one build per boot fast.
let _imagePromise = null;
function ensureCaptureImage() {
  if (!_imagePromise) {
    const captureDir = path.join(__dirname, '../../capture');
    _imagePromise = docker.buildImage(captureDir, CAPTURE_IMAGE).catch((err) => {
      _imagePromise = null; // allow a retry on the next capture
      throw err;
    });
  }
  return _imagePromise;
}

// ── Output protocol parsing ────────────────────────────────────────────
// capture.js emits one frame per artifact:
//   __USERNODE_SHOT__ kind=before media=png status=200 bytes=12345 index=0
//   <base64, single line>
//   __USERNODE_SHOT_END__
// and __USERNODE_SHOT_FAIL__ kind=... media=... reason=... index=... for
// failures. `index` is the capture group (multi-route, #270); it defaults
// to 0 when absent so an older capture container is parsed as one group.
function parseShots(stdout) {
  const shots = [];
  const failures = [];
  const lines = String(stdout || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('__USERNODE_SHOT__ ')) {
      const attrs = {};
      for (const m of line.matchAll(/(\w+)=(\S+)/g)) attrs[m[1]] = m[2];
      const payload = lines[i + 1] || '';
      if (lines[i + 2] === '__USERNODE_SHOT_END__'
          && (attrs.kind === 'before' || attrs.kind === 'after')
          && CONTENT_TYPES[attrs.media]) {
        try {
          const buf = Buffer.from(payload, 'base64');
          if (buf.length) {
            shots.push({
              kind: attrs.kind,
              media: attrs.media,
              status: parseInt(attrs.status, 10) || 0,
              index: parseInt(attrs.index, 10) || 0,
              buf,
            });
          }
        } catch { /* malformed base64 — treat as a missing frame */ }
        i += 2;
      }
    } else if (line.startsWith('__USERNODE_SHOT_FAIL__ ')) {
      const attrs = {};
      for (const m of line.matchAll(/(\w+)=(\S+)/g)) attrs[m[1]] = m[2];
      failures.push({
        kind: attrs.kind, media: attrs.media,
        reason: decodeURIComponent(attrs.reason || 'unknown'),
      });
    }
  }
  return { shots, failures };
}

// ── Console-error check (#381) ───────────────────────────────────────────
// capture.js emits one console frame per "after" target:
//   __USERNODE_CONSOLE__ index=<n> errors=<count> loadStatus=<n>
//   <base64 JSON array of { kind, message, source }>
//   __USERNODE_CONSOLE_END__
// Parse them into one frame per capture index (latest wins on a dup index).
const CONSOLE_MAX_ERRORS = 20;
const CONSOLE_MAX_MSG_LEN = 500;

function parseConsole(stdout) {
  const byIndex = new Map();
  const lines = String(stdout || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('__USERNODE_CONSOLE__ ')) continue;
    const attrs = {};
    for (const m of line.matchAll(/(\w+)=(\S+)/g)) attrs[m[1]] = m[2];
    const payload = lines[i + 1] || '';
    if (lines[i + 2] !== '__USERNODE_CONSOLE_END__') continue;
    const index = parseInt(attrs.index, 10) || 0;
    const loadStatus = parseInt(attrs.loadStatus, 10) || 0;
    let errors = [];
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
      if (Array.isArray(parsed)) errors = parsed;
    } catch { /* malformed base64/JSON — treat the frame as no parsed errors */ }
    byIndex.set(index, { index, loadStatus, errors });
    i += 2;
  }
  return Array.from(byIndex.values()).sort((a, b) => a.index - b.index);
}

// Classify the parsed frames into the persisted snapshot:
//   'errors'  — at least one console error / page error / failed load
//   'clean'   — every checked target navigated OK with no error output
//   'unknown' — nothing to classify (no frame parsed: container crashed,
//               no staging "after" reachable, …) → no badge
// The flattened error list is deduped by message and capped, matching the
// capture-side caps so a runaway app can't bloat the row.
function classifyConsole(frames) {
  if (!Array.isArray(frames) || !frames.length) return { state: 'unknown', errors: [] };
  const seen = new Set();
  const errors = [];
  for (const f of frames) {
    for (const e of (Array.isArray(f.errors) ? f.errors : [])) {
      const message = String((e && e.message) || '').slice(0, CONSOLE_MAX_MSG_LEN);
      if (!message || seen.has(message)) continue;
      seen.add(message);
      errors.push({
        kind: (e && typeof e.kind === 'string') ? e.kind : 'console',
        message,
        source: (e && e.source) ? String(e.source).slice(0, CONSOLE_MAX_MSG_LEN) : '',
      });
      if (errors.length >= CONSOLE_MAX_ERRORS) break;
    }
    if (errors.length >= CONSOLE_MAX_ERRORS) break;
  }
  return { state: errors.length ? 'errors' : 'clean', errors };
}

// Latest-only snapshot on the session, mirroring the merge-conflict trio.
async function storeConsoleCheck(pool, sessionId, result) {
  await pool.query(
    `UPDATE chat_sessions
       SET console_check_state = $1, console_errors = $2, console_checked_at = NOW()
     WHERE id = $3`,
    [result.state, JSON.stringify(result.errors || []), sessionId]
  );
}

// ── Test suite (#47, "CI for proposals") ─────────────────────────────────
// capture.js emits one frame per declared test:
//   __USERNODE_TEST__ index=<n> status=<pass|fail> loadStatus=<n>
//   <base64 JSON { name, path, consoleErrors:[...], failureReason }>
//   __USERNODE_TEST_END__
// Parse them into one record per index (latest wins on a dup index).
const TEST_MAX_RESULTS = 20;

function parseTests(stdout) {
  const byIndex = new Map();
  const lines = String(stdout || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('__USERNODE_TEST__ ')) continue;
    const attrs = {};
    for (const m of line.matchAll(/(\w+)=(\S+)/g)) attrs[m[1]] = m[2];
    const payloadLine = lines[i + 1] || '';
    if (lines[i + 2] !== '__USERNODE_TEST_END__') continue;
    const index = parseInt(attrs.index, 10) || 0;
    const status = attrs.status === 'pass' ? 'pass' : 'fail';
    const loadStatus = parseInt(attrs.loadStatus, 10) || 0;
    let payload = {};
    try {
      const parsed = JSON.parse(Buffer.from(payloadLine, 'base64').toString('utf8'));
      if (parsed && typeof parsed === 'object') payload = parsed;
    } catch { /* malformed — keep the status from the header line */ }
    byIndex.set(index, {
      index,
      name: typeof payload.name === 'string' ? payload.name : `test ${index + 1}`,
      path: typeof payload.path === 'string' ? payload.path : '',
      status,
      loadStatus,
      consoleErrors: Array.isArray(payload.consoleErrors) ? payload.consoleErrors : [],
      failureReason: typeof payload.failureReason === 'string' ? payload.failureReason : '',
    });
    i += 2;
  }
  return Array.from(byIndex.values()).sort((a, b) => a.index - b.index);
}

// Classify the parsed test frames into the persisted snapshot:
//   'passing' — at least one test ran and ALL passed
//   'failing' — at least one test failed an assertion / had console errors
//   'error'   — tests were expected but NONE produced a parseable frame
//               (capture container crashed / staging unreachable) → the
//               gate blocks fail-closed, the UI shows "couldn't run"
// `expectedCount` is how many tests the orchestrator dispatched, so a
// partial run (some frames missing) is treated as 'error' not 'passing'.
function classifyTests(frames, expectedCount) {
  const results = (Array.isArray(frames) ? frames : []).slice(0, TEST_MAX_RESULTS).map((f) => ({
    name: String(f.name || '').slice(0, CONSOLE_MAX_MSG_LEN),
    path: String(f.path || '').slice(0, CONSOLE_MAX_MSG_LEN),
    status: f.status === 'pass' ? 'pass' : 'fail',
    consoleErrors: (Array.isArray(f.consoleErrors) ? f.consoleErrors : [])
      .slice(0, CONSOLE_MAX_ERRORS)
      .map((e) => ({
        kind: (e && typeof e.kind === 'string') ? e.kind : 'console',
        message: String((e && e.message) || '').slice(0, CONSOLE_MAX_MSG_LEN),
        source: (e && e.source) ? String(e.source).slice(0, CONSOLE_MAX_MSG_LEN) : '',
      })),
    failureReason: String(f.failureReason || '').slice(0, CONSOLE_MAX_MSG_LEN),
  }));
  const expected = Number.isInteger(expectedCount) ? expectedCount : results.length;
  if (!results.length) return { state: 'error', results: [] };
  if (expected > 0 && results.length < expected) return { state: 'error', results };
  const anyFail = results.some((r) => r.status !== 'pass');
  return { state: anyFail ? 'failing' : 'passing', results };
}

// Latest-only checks snapshot, tied to the commit it describes (staleness
// signal for the merge gate). The console_* columns are kept written in
// parallel (deriving an advisory clean/errors/unknown from the same run)
// for one release so a rolling deploy's old readers don't break.
async function storeChecks(pool, sessionId, commitSha, result) {
  await pool.query(
    `UPDATE chat_sessions
       SET check_state = $1, test_results = $2, checks_commit_sha = $3, checks_checked_at = NOW()
     WHERE id = $4`,
    [result.state, JSON.stringify(result.results || []), commitSha || null, sessionId]
  );
}

// Set 'pending' the instant a (re)check starts so a stale 'passing' can't
// slip through the merge gate while the fresh build is being tested.
async function setChecksPending(pool, sessionId, commitSha) {
  await pool.query(
    `UPDATE chat_sessions
       SET check_state = 'pending', checks_commit_sha = $2, checks_checked_at = NOW()
     WHERE id = $1`,
    [sessionId, commitSha || null]
  );
}

// Map the structured test result onto the legacy advisory console snapshot
// so the dual-written console_* columns stay coherent for one release.
function consoleSnapshotFromTests(result) {
  if (!result || result.state === 'error') return { state: 'unknown', errors: [] };
  const seen = new Set();
  const errors = [];
  for (const r of (result.results || [])) {
    for (const e of (Array.isArray(r.consoleErrors) ? r.consoleErrors : [])) {
      const message = String((e && e.message) || '').slice(0, CONSOLE_MAX_MSG_LEN);
      if (!message || seen.has(message)) continue;
      seen.add(message);
      errors.push({ kind: e.kind || 'console', message, source: e.source || '' });
      if (errors.length >= CONSOLE_MAX_ERRORS) break;
    }
    if (errors.length >= CONSOLE_MAX_ERRORS) break;
  }
  return { state: errors.length ? 'errors' : 'clean', errors };
}

// ── Storage ────────────────────────────────────────────────────────────
// Client shape (#270): an ordered list of capture groups —
//   { captures: [ { index, path, before: {png,webm,gif}, after: {...} } ] }
// one group per captured route, ascending by capture_index. A group is
// only kept when it has an "after" artifact (nothing to show otherwise).
// A single-route proposal yields a one-element list, so the common case is
// unchanged in substance — just wrapped. Renderers (pr-metadata.js,
// app-view.js) iterate `captures` and label each row with its `path`.

// Assemble rows ([{kind, media, capture_index, captured_path, id}]) into
// the ordered { captures: [...] } shape. Groups missing an "after" are
// dropped. Shared by storeArtifacts / getForSession / shapeAgg so all
// three surfaces emit byte-identical shapes.
function groupRows(rows) {
  const byIndex = new Map();
  for (const r of rows) {
    const idx = Number.isInteger(r.index) ? r.index : (parseInt(r.capture_index, 10) || 0);
    let g = byIndex.get(idx);
    if (!g) { g = { index: idx, path: null }; byIndex.set(idx, g); }
    if (!g[r.kind]) g[r.kind] = {};
    g[r.kind][r.media] = r.id;
    const p = r.path || r.captured_path;
    if (p && !g.path) g.path = p;
  }
  const captures = [];
  for (const idx of Array.from(byIndex.keys()).sort((a, b) => a - b)) {
    const g = byIndex.get(idx);
    if (!g.after) continue; // nothing to show without an "after"
    captures.push({ index: g.index, path: g.path || '/', before: g.before || null, after: g.after });
  }
  return captures.length ? { captures } : null;
}

// Latest set per session only: each successful capture deletes the
// session's prior rows and inserts the fresh set inside one transaction.
// Growth is bounded at <= 6 artifacts per group; with CAPTURE_MAX_PATHS
// groups that's <= 18 rows/session ever. `targets` is the ordered capture
// target list ([{ index, path }]) so each row records its capture_index +
// captured_path (the group label). Returns the grouped shape, or null when
// nothing usable was stored (no group has an "after").
async function storeArtifacts(pool, sessionId, commitHash, targets, shots) {
  const pathByIndex = new Map();
  for (const t of (Array.isArray(targets) ? targets : [])) pathByIndex.set(t.index, t.path);

  const rows = [];
  for (const s of shots) {
    if (s.buf.length > MAX_BYTES[s.media]) {
      log.warn('visuals', 'Artifact over size cap — dropped', {
        sessionId, kind: s.kind, media: s.media, bytes: s.buf.length, index: s.index,
      });
      continue;
    }
    const index = Number.isInteger(s.index) ? s.index : 0;
    rows.push({
      id: crypto.randomBytes(16).toString('hex'),
      index,
      capturedPath: pathByIndex.has(index) ? pathByIndex.get(index) : null,
      ...s,
    });
  }
  if (!rows.some((r) => r.kind === 'after')) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM session_visuals WHERE session_id = $1', [sessionId]);
    for (const r of rows) {
      await client.query(
        `INSERT INTO session_visuals (id, session_id, commit_hash, kind, media, content_type, data, captured_path, capture_index)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [r.id, sessionId, commitHash || null, r.kind, r.media, CONTENT_TYPES[r.media], r.buf, r.capturedPath || null, r.index]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return groupRows(rows.map((r) => ({
    kind: r.kind, media: r.media, id: r.id, index: r.index, captured_path: r.capturedPath,
  })));
}

// Shape a session's stored artifact ids for clients into the grouped
// { captures: [...] } form (ascending by capture_index). Used by GET
// /api/sessions/:id (history reloads) and exported for any other surface
// that wants the same shape. Pre-#270 rows all carry capture_index 0, so
// they collapse into a single legacy group — back-compatible by default.
async function getForSession(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT id, kind, media, captured_path, capture_index FROM session_visuals WHERE session_id = $1`,
    [sessionId]
  );
  if (!rows.length) return null;
  return groupRows(rows);
}

// Shape the jsonb_object_agg(... -> id) form produced by the /promoted
// vote-panel query into the grouped client shape. The agg key is
// `kind_index_media` (#270); the legacy `kind_media` key (pre-#270 stored
// rows, or an older query) is also accepted, mapping to capture group 0.
// captured_path isn't carried in the agg, so group labels default to '/'
// (the vote-panel tiles already render fine without an explicit label).
function shapeAgg(agg) {
  if (!agg || typeof agg !== 'object') return null;
  const rows = [];
  for (const [key, id] of Object.entries(agg)) {
    let m = key.match(/^(before|after)_(\d+)_(png|webm|gif)$/);
    if (m) {
      rows.push({ kind: m[1], index: parseInt(m[2], 10) || 0, media: m[3], id });
      continue;
    }
    m = key.match(/^(before|after)_(png|webm|gif)$/);
    if (m) rows.push({ kind: m[1], index: 0, media: m[2], id });
  }
  return groupRows(rows);
}

// ── PR body patch ──────────────────────────────────────────────────────
// Targeted text patch for the interactive ordering (PR exists before the
// capture finishes): fetch the live body, replace/append the
// marker-delimited block, write it back, and stamp pr_visuals_applied so
// the next applyPrMetadata turn sees an up-to-date snapshot.
async function patchPrBody(pool, session, repoOwner, repoName, block) {
  const pr = await github.getPR(repoOwner, repoName, session.pr_number);
  const body = pr.body || '';
  const next = prMetadata.upsertVisualsBlock(body, block);
  if (next !== body) {
    await github.updatePR(repoOwner, repoName, session.pr_number, { body: next });
  }
  await pool.query(
    `UPDATE chat_sessions SET pr_visuals_applied = $1 WHERE id = $2`,
    [block || null, session.id]
  );
}

// One capture in flight per session — a fast follow-up turn that rebuilds
// staging while the previous capture is still shooting just skips.
const _inFlight = new Set();

// Main entry point. Fire-and-forget from the staging-success sites
// (routes/sessions.js interactive + headless tails, routes/votes.js
// post-promote clone build) — always AFTER staging_ready is sent so the
// preview button is never delayed. Never throws.
//
// `send` (optional) is the turn's SSE/bus emitter; when absent (promote
// path) we publish straight to the session bus + global WS so open
// clients still upgrade in place.
// Resolve the capture pixel density from an apps row (issue #360).
// 1 only when the app explicitly opted out via dapp.json's
// `screenshot.deviceScaleFactor: 1` (persisted on
// apps.screenshot_device_scale); everything else — including a missing
// row/column — defaults to 2× (HiDPI).
function resolveCaptureScale(row) {
  return row && row.screenshot_device_scale === 1 ? 1 : 2;
}

async function captureForSession(config, session, app, commitHash, stagingResult, { send } = {}) {
  if (_inFlight.has(session.id)) {
    log.info('visuals', 'Capture already in flight — skipping', { sessionId: session.id });
    return;
  }
  _inFlight.add(session.id);
  const pool = getPool(config);
  try {
    const [, repoOwner, repoName] = (app.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];

    // #47: mark the checks 'pending' for this commit the moment the run
    // starts, so the merge gate (votes.checkAndMerge) can't act on a stale
    // 'passing' while the fresh build is being tested. Best-effort.
    await setChecksPending(pool, session.id, commitHash).catch((err) => {
      log.warn('visuals', 'setChecksPending failed (non-fatal)', { sessionId: session.id, err: err.message });
    });

    // Heuristic gate. If the compare call fails, default to capturing —
    // staging exists, and a wasted screenshot is cheaper than a missed one.
    let uiAffecting = true;
    if (github.isEnabled() && repoOwner && repoName && session.branch_name) {
      try {
        const files = await github.listChangedFiles(
          repoOwner, repoName, `main...${session.branch_name}`
        );
        uiAffecting = isUiAffecting(files);
      } catch (err) {
        log.warn('visuals', 'Changed-file compare failed — defaulting to capture', {
          sessionId: session.id, err: err.message,
        });
      }
    }
    // #381: the headless run now ALWAYS happens so every proposal gets a
    // console-error check. The UI-affecting heuristic only decides whether
    // to also shoot the before/after media (the expensive part) — when
    // it's false we run a lightweight console-only pass (MEDIA=0): navigate
    // just the staging "after" target(s), collect console errors, skip
    // screenshots/recordings and the prod "before" leg.
    const media = uiAffecting;
    if (!media) {
      log.info('visuals', 'No frontend files in commit range — console-only check', {
        sessionId: session.id, branch: session.branch_name,
      });
    }

    await ensureCaptureImage();

    // Capture identity: sign every target visit as the seeded non-admin
    // usernode-capture user so screenshots show the real logged-in app
    // instead of the login screen. Strictly best-effort — a missing row
    // (migration not yet run) degrades to unauthenticated capture, never
    // a failed one. JWT payload mirrors /api/iframe-token (server.js):
    // child apps verify it in prod and staging, and the self-app staging
    // clone exchanges it for a local session via middleware/auth.js.
    let captureUser = null;
    let captureToken = '';
    try {
      const { rows } = await pool.query(
        'SELECT id, username, usernode_pubkey FROM users WHERE username = $1',
        [CAPTURE_USERNAME]
      );
      captureUser = rows[0] || null;
      if (captureUser) {
        captureToken = jwt.sign(
          {
            id: captureUser.id,
            username: captureUser.username,
            usernode_pubkey: captureUser.usernode_pubkey || null,
          },
          config.jwtSecret,
          { expiresIn: '15m' }
        );
      } else {
        log.warn('visuals', 'Capture user missing — capturing unauthenticated', {
          sessionId: session.id, username: CAPTURE_USERNAME,
        });
      }
    } catch (err) {
      log.warn('visuals', 'Capture user lookup failed — capturing unauthenticated', {
        sessionId: session.id, err: err.message,
      });
    }

    // Targets, reached directly over the shared docker network — same
    // access model waitForHealthy uses, bypassing Caddy's forward-auth
    // gate. The capture routes are the validated testing_paths list
    // (#270), falling back to [testing_path || '/'] for pre-#270 rows;
    // deduped (preserving order), capped at CAPTURE_MAX_PATHS, always
    // non-empty (a change with nothing to point at still shoots '/').
    const capturePaths = (() => {
      const raw = (Array.isArray(session.testing_paths) && session.testing_paths.length)
        ? session.testing_paths
        : [session.testing_path || '/'];
      const seen = new Set();
      const out = [];
      for (const p of raw) {
        const v = (typeof p === 'string' && p) ? p : null;
        if (!v || seen.has(v)) continue;
        seen.add(v);
        out.push(v);
        if (out.length >= CAPTURE_MAX_PATHS) break;
      }
      return out.length ? out : ['/'];
    })();

    const stagingName = `usernode-staging-${app.slug}--${session.id}`;
    const isSelfApp = app.slug === config.selfAppSlug;
    const prodName = beforeContainerName(config, app.slug);
    const prodRunning = (await docker.getContainerStatus(prodName)) === 'running';

    // Self-app "before" auth: the production platform never honours the
    // query token by design (replay protection — middleware/auth.js gates
    // the iframe-JWT path on USERNODE_ENV === 'staging'). For the self-app,
    // `pool` IS the platform's own DB, so mint ONE transient sessions-table
    // cookie for the capture user and reuse it across every before-path
    // (same origin, same TTL); deleted once in the finally below, with the
    // short expiry as the backstop if the process dies.
    let beforeCookie = '';
    let beforeSessionToken = '';
    if (media && prodRunning && isSelfApp && captureUser) {
      try {
        beforeSessionToken = crypto.randomBytes(32).toString('hex');
        await pool.query(
          'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
          [beforeSessionToken, captureUser.id, new Date(Date.now() + CAPTURE_AUTH_TTL_MS)]
        );
        beforeCookie = `session=${beforeSessionToken}`;
      } catch (err) {
        beforeSessionToken = '';
        log.warn('visuals', 'Capture session-cookie mint failed — "before" unauthenticated', {
          sessionId: session.id, err: err.message,
        });
      }
    }

    // One capture target per path. The "after" (staging) target always
    // exists; the "before" (prod) target only when prod is running. A
    // newly-added deep page 404s on prod, so each before-target falls back
    // to '/' (capture.js retries) — "before" shows the prior root state
    // rather than an error page. Child-app prod verifies the query token
    // directly (scaffold middleware); the self-app uses the minted cookie.
    //
    // Self-app (#353): the visited path is normalised into a `#`-fragment
    // deep link so the hash-routed SPA renders the changed screen instead
    // of the home feed. For a fragment target the server pathname is
    // always '/', so prod never 404s on a deep page — the '/' fallback is
    // moot and skipped (the bare-'/' and standalone-page cases keep it).
    const targets = capturePaths.map((p, index) => {
      const visitPath = isSelfApp ? selfAppHashPath(p) : p;
      const isFragmentTarget = visitPath.startsWith('/#');
      const afterUrl = withToken(`http://${stagingName}:3000${visitPath}`, captureToken);
      let beforeUrl = '';
      let beforeFallbackUrl = '';
      if (media && prodRunning) {
        if (isSelfApp) {
          beforeUrl = `http://${prodName}:3000${visitPath}`;
          if (p !== '/' && !isFragmentTarget) beforeFallbackUrl = `http://${prodName}:3000/`;
        } else {
          beforeUrl = withToken(`http://${prodName}:3000${visitPath}`, captureToken);
          if (p !== '/') beforeFallbackUrl = withToken(`http://${prodName}:3000/`, captureToken);
        }
      }
      return {
        index, path: p, afterUrl, beforeUrl, beforeFallbackUrl,
        beforeCookie: (beforeUrl && isSelfApp) ? beforeCookie : '',
        // Plumbed for symmetry; unused today (the after side always
        // authenticates via the query token).
        afterCookie: '',
      };
    });

    // Pixel density for the shots (issue #360). Default 2× (HiDPI), with
    // a per-app 1× opt-out persisted on apps.screenshot_device_scale by
    // the deploy-time reconcile (app-manifest.reconcileAppScreenshot).
    // Read fresh from the DB so we don't depend on the width of the `app`
    // row the caller happened to pass; an unreadable/absent value falls
    // back to 2× (the capture container also defaults to 2× regardless).
    let deviceScaleFactor = 2;
    try {
      const { rows } = await pool.query(
        'SELECT screenshot_device_scale FROM apps WHERE id = $1', [app.id]
      );
      deviceScaleFactor = resolveCaptureScale(rows[0]);
    } catch (err) {
      log.warn('visuals', 'Screenshot-scale lookup failed — defaulting to 2×', {
        sessionId: session.id, err: err.message,
      });
    }

    // #47: resolve the proposal's automated test suite. Declared tests live
    // in the branch's dapp.json `tests` array (fetched from GitHub so we
    // don't depend on the now-deleted staging clone). When none are
    // declared we synthesize the baseline — one "loads with no console
    // errors" test per capture path — so every proposal gets at least the
    // #381 coverage. Each test's route is resolved to the same staging
    // origin + token (and self-app hash normalisation) as the after target.
    const declaredTests = await resolveDeclaredTests(repoOwner, repoName, session.branch_name);
    const tests = (declaredTests.length
      ? declaredTests
      : capturePaths.map((p) => ({ name: `Loads ${p}`, path: p, expectSelector: '', expectText: '', allowConsoleErrors: false }))
    ).map((t, index) => {
      const visitPath = isSelfApp ? selfAppHashPath(t.path) : t.path;
      return {
        index,
        name: t.name,
        path: t.path,
        url: withToken(`http://${stagingName}:3000${visitPath}`, captureToken),
        expectSelector: t.expectSelector || '',
        expectText: t.expectText || '',
        allowConsoleErrors: !!t.allowConsoleErrors,
      };
    });

    log.info('visuals', 'Starting capture', {
      sessionId: session.id, slug: app.slug, before: media && prodRunning, paths: capturePaths,
      authenticated: !!captureToken, selfApp: isSelfApp, deviceScaleFactor, media,
      tests: tests.length, declaredTests: declaredTests.length,
    });
    let stdout;
    try {
      ({ stdout } = await docker.runOneShot(`usernode-capture-${session.id}`, {
        image: CAPTURE_IMAGE,
        env: {
          // Multi-target protocol (#270). The container loops over these
          // sequentially and tags each shot frame with its index=.
          TARGETS: JSON.stringify(targets.map((t) => ({
            index: t.index,
            beforeUrl: t.beforeUrl,
            afterUrl: t.afterUrl,
            beforeFallbackUrl: t.beforeFallbackUrl,
            beforeCookie: t.beforeCookie,
            afterCookie: t.afterCookie,
          }))),
          // Scalar single-target fallback (first target) so an older
          // capture image still works during a rolling platform deploy.
          BEFORE_URL: targets[0].beforeUrl,
          AFTER_URL: targets[0].afterUrl,
          BEFORE_FALLBACK_URL: targets[0].beforeFallbackUrl,
          BEFORE_COOKIE: targets[0].beforeCookie,
          AFTER_COOKIE: '',
          // Pixel density (#360). Global to the run — all of a proposal's
          // screens share one density, matching the single shared viewport.
          DEVICE_SCALE_FACTOR: String(deviceScaleFactor),
          // #381: MEDIA=0 → console-only run (no screenshots/recordings,
          // no prod "before"). The console-error check still runs.
          MEDIA: media ? '1' : '0',
          // #47: the proposal's automated test suite (each entry pre-resolved
          // to a staging url + assertions). The container runs these and
          // emits one __USERNODE_TEST__ frame each.
          TESTS: JSON.stringify(tests),
        },
        timeoutMs: RUN_TIMEOUT_MS,
        maxBuffer: RUN_MAX_BUFFER,
      }));
    } finally {
      if (beforeSessionToken) {
        await pool.query('DELETE FROM sessions WHERE token = $1', [beforeSessionToken])
          .catch((err) => log.warn('visuals', 'Capture session-cookie cleanup failed', {
            sessionId: session.id, err: err.message,
          }));
      }
    }

    const { shots, failures } = parseShots(stdout);
    for (const f of failures) {
      log.warn('visuals', 'Capture frame failed', { sessionId: session.id, ...f });
    }

    // #47: the test suite result is stored FIRST so it lands even on the
    // console-only path (no media artifacts; storeArtifacts returns early).
    // Best-effort: a missing/partial set degrades to 'error' (the gate
    // blocks fail-closed, the card shows "couldn't run"), never throws.
    // The advisory console_* columns are dual-written from the same run for
    // one release so a rolling deploy's old readers stay coherent.
    const checksResult = classifyTests(parseTests(stdout), tests.length);
    try {
      await storeChecks(pool, session.id, commitHash, checksResult);
      await storeConsoleCheck(pool, session.id, consoleSnapshotFromTests(checksResult));
      log.info('visuals', 'Checks stored', {
        sessionId: session.id, state: checksResult.state,
        tests: checksResult.results.length,
        failing: checksResult.results.filter((r) => r.status !== 'pass').length,
      });
      notifyChecks(session.id, checksResult, commitHash, send);
    } catch (err) {
      log.warn('visuals', 'Checks store failed (non-fatal)', {
        sessionId: session.id, err: err.message,
      });
    }

    const stored = await storeArtifacts(pool, session.id, commitHash, targets, shots);
    if (!stored) {
      if (media) log.warn('visuals', 'No usable "after" artifact — nothing stored', { sessionId: session.id });
      return;
    }

    // Interactive ordering: a PR already exists, so patch its body now.
    // (Headless → lazy-PR ordering is covered by applyPrMetadata's suffix
    // assembly reading session_visuals at promote time.)
    if (session.pr_number && repoOwner && repoName && github.isEnabled()) {
      const block = prMetadata.buildVisualsBlock(stored, caddy.USERNODE_DOMAIN);
      try {
        await patchPrBody(pool, session, repoOwner, repoName, block);
      } catch (err) {
        log.warn('visuals', 'PR body visuals patch failed', {
          sessionId: session.id, pr: session.pr_number, err: err.message,
        });
      }
    }

    notifyVisualsReady(session.id, stored, send);
    log.info('visuals', 'Capture complete', {
      sessionId: session.id,
      artifacts: shots.map((s) => `${s.kind}.${s.media}`).join(','),
    });
  } catch (err) {
    log.warn('visuals', 'Capture failed (non-fatal)', { sessionId: session.id, err: err.message });
    // #47: the capture/test pipeline broke before it could record a
    // verdict. Don't leave the proposal stuck 'pending' forever — record
    // 'error' so the gate blocks fail-closed with a visible "couldn't run"
    // rather than an indefinite spinner. Best-effort.
    try {
      await storeChecks(pool, session.id, commitHash, { state: 'error', results: [] });
      notifyChecks(session.id, { state: 'error', results: [] }, commitHash, send);
    } catch { /* nothing more we can do */ }
  } finally {
    _inFlight.delete(session.id);
  }
}

// #47: fetch the proposal branch's declared dapp.json `tests` from GitHub
// (the staging clone is gone by now) and normalise via the manifest
// reader. Returns [] when GitHub is disabled, the file is absent, or
// anything goes wrong — the caller then synthesizes the baseline suite.
async function resolveDeclaredTests(repoOwner, repoName, branch) {
  if (!github.isEnabled() || !repoOwner || !repoName || !branch) return [];
  try {
    const raw = await github.getFileContent(repoOwner, repoName, appManifest.MANIFEST_FILENAME, branch);
    if (!raw) return [];
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return []; }
    return appManifest.readTests(parsed);
  } catch (err) {
    log.warn('visuals', 'Declared-test fetch failed — using baseline', {
      repo: `${repoOwner}/${repoName}`, branch, err: err.message,
    });
    return [];
  }
}

// Capture completes after staging_ready fired, so the staging card needs a
// follow-up event to upgrade in place. Prefer the turn's own `send` (POST
// SSE + global WS + session bus, all dedup'd by _seq client-side); fall
// back to bus + WS directly when no turn is alive (promote-time capture).
let _notifySeq = 0;
function notifyVisualsReady(sessionId, visuals, send) {
  const data = { sessionId, visuals };
  try {
    if (send) {
      send('visuals_ready', data);
      return;
    }
    const event = { type: 'visuals_ready', _seq: `vis${Date.now().toString(36)}-${++_notifySeq}`, ...data };
    sessionBus.publish(sessionId, event);
    const { broadcastGlobal } = require('./ws');
    broadcastGlobal({ type: 'session_event', sessionId, event: 'visuals_ready', ...event });
  } catch (err) {
    log.warn('visuals', 'visuals_ready notify failed', { sessionId, err: err.message });
  }
}

// #47: the per-check WS push lives in notifyChecks below. (The #381
// console-only `console_check_ready` notifier was retired when the
// console check became one test in the suite — clients now listen for
// `checks_ready`.)

// #47: tell open clients the checks landed so the checks badge upgrades in
// place without a full panel reload. Same emit strategy as
// notifyVisualsReady — prefer the turn's `send`, else bus + global WS.
function notifyChecks(sessionId, result, commitSha, send) {
  const data = {
    sessionId,
    checkState: result.state,
    failingCount: (result.results || []).filter((r) => r.status !== 'pass').length,
    commitSha: commitSha || null,
  };
  try {
    if (send) {
      send('checks_ready', data);
      return;
    }
    const event = { type: 'checks_ready', _seq: `chk${Date.now().toString(36)}-${++_notifySeq}`, ...data };
    sessionBus.publish(sessionId, event);
    const { broadcastGlobal } = require('./ws');
    broadcastGlobal({ type: 'session_event', sessionId, event: 'checks_ready', ...event });
  } catch (err) {
    log.warn('visuals', 'checks_ready notify failed', { sessionId, err: err.message });
  }
}

module.exports = {
  captureForSession,
  storeArtifacts,
  getForSession,
  shapeAgg,
  parseConsole,
  classifyConsole,
  storeConsoleCheck,
  parseTests,
  classifyTests,
  storeChecks,
  setChecksPending,
  consoleSnapshotFromTests,
  resolveDeclaredTests,
  isFrontendFile,
  isUiAffecting,
  parseShots,
  withToken,
  selfAppHashPath,
  beforeContainerName,
  resolveCaptureScale,
  CAPTURE_IMAGE,
};
