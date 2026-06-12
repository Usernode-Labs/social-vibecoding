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
const log = require('./logger');
const docker = require('./docker');
const github = require('./github');
const caddy = require('./caddy');
const prMetadata = require('./pr-metadata');
const sessionBus = require('./session-bus');
const { getPool } = require('../db/pool');

const CAPTURE_IMAGE = 'usernode-capture:latest';

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
//   __USERNODE_SHOT__ kind=before media=png status=200 bytes=12345
//   <base64, single line>
//   __USERNODE_SHOT_END__
// and __USERNODE_SHOT_FAIL__ kind=... media=... reason=... for failures.
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

// ── Storage ────────────────────────────────────────────────────────────
// Latest set per session only: each successful capture deletes the
// session's prior rows and inserts the fresh set inside one transaction,
// bounding growth at <= 6 artifacts per session ever. Returns the shaped
// id map ({ before: {png,webm,gif}, after: {...} }) or null when nothing
// usable was stored (no "after" artifact = nothing to show).
async function storeArtifacts(pool, sessionId, commitHash, capturedPath, shots) {
  const rows = [];
  for (const s of shots) {
    if (s.buf.length > MAX_BYTES[s.media]) {
      log.warn('visuals', 'Artifact over size cap — dropped', {
        sessionId, kind: s.kind, media: s.media, bytes: s.buf.length,
      });
      continue;
    }
    rows.push({ id: crypto.randomBytes(16).toString('hex'), ...s });
  }
  if (!rows.some((r) => r.kind === 'after')) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM session_visuals WHERE session_id = $1', [sessionId]);
    for (const r of rows) {
      await client.query(
        `INSERT INTO session_visuals (id, session_id, commit_hash, kind, media, content_type, data, captured_path)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [r.id, sessionId, commitHash || null, r.kind, r.media, CONTENT_TYPES[r.media], r.buf, capturedPath || null]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const shaped = {};
  for (const r of rows) {
    if (!shaped[r.kind]) shaped[r.kind] = {};
    shaped[r.kind][r.media] = r.id;
  }
  shaped.capturedPath = capturedPath || '/';
  return shaped;
}

// Shape a session's stored artifact ids for clients:
// { before: {png,webm,gif}, after: {...}, capturedPath } or null.
// Used by GET /api/sessions/:id (history reloads) and exported for any
// other surface that wants the same shape.
async function getForSession(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT id, kind, media, captured_path FROM session_visuals WHERE session_id = $1`,
    [sessionId]
  );
  if (!rows.length) return null;
  const shaped = {};
  for (const r of rows) {
    if (!shaped[r.kind]) shaped[r.kind] = {};
    shaped[r.kind][r.media] = r.id;
    if (r.captured_path) shaped.capturedPath = r.captured_path;
  }
  return shaped;
}

// Shape the jsonb_object_agg('kind_media' -> id) form produced by the
// /promoted vote-panel query into the same client shape as above.
function shapeAgg(agg) {
  if (!agg || typeof agg !== 'object') return null;
  const shaped = {};
  for (const [key, id] of Object.entries(agg)) {
    const m = key.match(/^(before|after)_(png|webm|gif)$/);
    if (!m) continue;
    if (!shaped[m[1]]) shaped[m[1]] = {};
    shaped[m[1]][m[2]] = id;
  }
  return Object.keys(shaped).length ? shaped : null;
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
async function captureForSession(config, session, app, commitHash, stagingResult, { send } = {}) {
  if (_inFlight.has(session.id)) {
    log.info('visuals', 'Capture already in flight — skipping', { sessionId: session.id });
    return;
  }
  _inFlight.add(session.id);
  try {
    const pool = getPool(config);
    const [, repoOwner, repoName] = (app.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];

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
    if (!uiAffecting) {
      log.info('visuals', 'Skipping capture — no frontend files in commit range', {
        sessionId: session.id, branch: session.branch_name,
      });
      return;
    }

    await ensureCaptureImage();

    // Targets, reached directly over the shared docker network — same
    // access model waitForHealthy uses, bypassing Caddy's forward-auth
    // gate. testing_path was validated by testing-notes.validatePath
    // before it was persisted.
    const capturePath = (session.testing_path || '/');
    const stagingName = `usernode-staging-${app.slug}--${session.id}`;
    const afterUrl = `http://${stagingName}:3000${capturePath}`;
    const prodName = `usernode-app-${app.slug}`;
    let beforeUrl = '';
    let beforeFallbackUrl = '';
    if ((await docker.getContainerStatus(prodName)) === 'running') {
      beforeUrl = `http://${prodName}:3000${capturePath}`;
      // A newly-added page 404s on prod — capture.js retries at / so
      // "before" shows the app's prior state rather than an error page.
      if (capturePath !== '/') beforeFallbackUrl = `http://${prodName}:3000/`;
    }

    log.info('visuals', 'Starting capture', {
      sessionId: session.id, slug: app.slug, before: !!beforeUrl, path: capturePath,
    });
    const { stdout } = await docker.runOneShot(`usernode-capture-${session.id}`, {
      image: CAPTURE_IMAGE,
      env: {
        BEFORE_URL: beforeUrl,
        AFTER_URL: afterUrl,
        BEFORE_FALLBACK_URL: beforeFallbackUrl,
      },
      timeoutMs: RUN_TIMEOUT_MS,
      maxBuffer: RUN_MAX_BUFFER,
    });

    const { shots, failures } = parseShots(stdout);
    for (const f of failures) {
      log.warn('visuals', 'Capture frame failed', { sessionId: session.id, ...f });
    }

    const stored = await storeArtifacts(pool, session.id, commitHash, capturePath, shots);
    if (!stored) {
      log.warn('visuals', 'No usable "after" artifact — nothing stored', { sessionId: session.id });
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
  } finally {
    _inFlight.delete(session.id);
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

module.exports = {
  captureForSession,
  getForSession,
  shapeAgg,
  isFrontendFile,
  isUiAffecting,
  parseShots,
  CAPTURE_IMAGE,
};
