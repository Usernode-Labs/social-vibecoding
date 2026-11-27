'use strict';

// The Wasm twin of a proposal preview (services/wasm-previews.js decides who
// gets one; runtime/wasm/README.md describes the runtime): what the
// preview's build does for it, beside the Node preview it already makes.
//
//   buildModule   the commit's tree goes to a runner, which bundles and
//                 compiles it inside its microVM and answers the module; the
//                 platform stores it by its SHA-256 and runs nothing of it.
//   prepareTwin   after its database is cloned: the owner login gets the
//                 password the data service derives, the app's setup code
//                 runs once against it (what a container does at every boot),
//                 and the twin's address is routed through the app gate.
//   removeTwin    its route; its database goes with the attempt's
//                 (workflow/preview/services.ts) and its module with the
//                 module sweep.
//
// A twin that fails never fails the Node preview: the build logs why and
// the preview serves without one.

const crypto = require('crypto');
const { execFile } = require('child_process');
const log = require('./logger');
const previews = require('./wasm-previews');

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const BUILD_TIMEOUT_MS = 120000;
const SETUP_TIMEOUT_MS = 60000;

function kubernetes() { return require('./kubernetes'); }
function dbManager() { return require('./db-manager'); }

function runnerToken() {
  const token = process.env.WASM_RUNNER_TOKEN || '';
  if (token.length < 32) throw new Error('WASM_RUNNER_TOKEN is not set (32 characters at least)');
  return token;
}

/** The twin's Kubernetes name (its Ingress) for a preview. */
function twinRuntimeName(appId, sessionId) {
  return `sv-wasm-${Number(appId)}-s${Number(sessionId)}`;
}

/** The checkout as a gzip tar, without its Git data or installed packages. */
function sourceArchive(dir) {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-czf', '-', '--exclude=./.git', '--exclude=./node_modules', '-C', dir, '.'],
      { encoding: 'buffer', maxBuffer: MAX_SOURCE_BYTES + 1, timeout: 60000 },
      (err, stdout) => {
        if (err) {
          if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            return reject(Object.assign(new Error('The source is larger than 20 MB, too large for a Wasm build'), { wasmBuild: true }));
          }
          return reject(err);
        }
        resolve(stdout);
      });
  });
}

async function readReason(res) {
  const text = await res.text().catch(() => '');
  return text.slice(0, 600).trim() || `HTTP ${res.status}`;
}

/**
 * Build the commit's module on a runner and store it. Answers
 * { moduleHash, size, ms }. A build the runner refuses (an npm package the
 * adapters do not cover, a syntax error) throws with `wasmBuild: true` and
 * the runner's reason.
 */
async function buildModule(config, pool, { app, sourceDir }) {
  const started = Date.now();
  await kubernetes().ensureWasmBackends(config);
  const archive = await sourceArchive(sourceDir);
  const res = await fetch(`${kubernetes().wasmRunnerOrigin(config)}/_wasm/build`, {
    method: 'POST',
    headers: { authorization: `Bearer ${runnerToken()}`, 'content-type': 'application/gzip' },
    body: archive,
    signal: AbortSignal.timeout(BUILD_TIMEOUT_MS),
  });
  if (res.status === 422) throw Object.assign(new Error(`Wasm build refused: ${await readReason(res)}`), { wasmBuild: true });
  if (!res.ok) throw new Error(`Wasm build failed: ${await readReason(res)}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const moduleHash = crypto.createHash('sha256').update(bytes).digest('hex');
  const said = String(res.headers.get('x-module-sha256') || '').toLowerCase();
  if (said && said !== moduleHash) throw new Error('Wasm build answered a module that does not match its hash');
  await pool.query(
    `INSERT INTO wasm_modules (sha256, bytes, size, app_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (sha256) DO UPDATE SET used_at = NOW()`,
    [moduleHash, bytes, bytes.length, app.id]);
  return { moduleHash, size: bytes.length, ms: Date.now() - started };
}

/**
 * Make a cloned twin database ready and route the twin. `cloned` is
 * db-manager.cloneDatabase's answer for `db`. Answers the twin's record, as
 * the preview machine keeps it (workflow/preview/machine.ts Served.twin).
 */
async function prepareTwin(config, { app, sessionId, db, cloned, moduleHash, hostname }) {
  const dbm = dbManager();
  // The data service reaches the preview server only: a clone that went to
  // the main server (the preview server draining) gets no twin.
  if (cloned?.server !== dbm.PREVIEW_SERVER) throw new Error('The twin database is not on the preview database server');
  await dbm.setTwinOwnerPassword(db, previews.dbPassword(db), { server: cloned.server });
  const pass = previews.signPass({ appId: app.id, sessionId, moduleHash, db, scope: 'setup', env: previews.twinEnv(app) });
  const res = await fetch(`${kubernetes().wasmRunnerOrigin(config)}/_wasm/setup`, {
    method: 'POST',
    headers: { authorization: `Bearer ${runnerToken()}`, 'x-usernode-pass': pass },
    signal: AbortSignal.timeout(SETUP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`The twin's setup failed: ${await readReason(res)}`);
  const setup = await res.json().catch(() => ({}));
  const name = twinRuntimeName(app.id, sessionId);
  await kubernetes().applyTwinIngress(config, { app, sessionId, name, hostname });
  return { db, mod: moduleHash, host: hostname, url: `https://${hostname}`, name, setupMs: Number(setup.ms) || null };
}

async function removeTwin(config, { appId, sessionId }) {
  await kubernetes().deleteTwinIngress(config, twinRuntimeName(appId, sessionId));
}

/**
 * The project's compiled stylesheet, from the Node preview just made from
 * the same commit: its image built it from the project's own Tailwind
 * config, which the platform never runs. Written into the checkout so the
 * twin's module carries it. Best effort: a twin without it still works.
 */
async function copyNodeStylesheet(config, nodeRef, sourceDir) {
  const origin = require('./application-runtime').appOrigin(config, nodeRef);
  if (!origin) return false;
  try {
    const res = await fetch(`${origin}/tailwind.css`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!res.ok || !/text\/css/.test(String(res.headers.get('content-type') || ''))) return false;
    const css = Buffer.from(await res.arrayBuffer());
    const fs = require('fs/promises');
    await fs.mkdir(require('path').join(sourceDir, 'public'), { recursive: true });
    await fs.writeFile(require('path').join(sourceDir, 'public', 'tailwind.css'), css);
    return true;
  } catch (err) {
    log.warn('wasm-runtime', 'Stylesheet not copied from the Node preview', { err: err.message });
    return false;
  }
}

/** A module's bytes for a runner (routes/wasm-internal.js), marking it used. */
async function moduleBytes(pool, sha256) {
  if (!/^[0-9a-f]{64}$/.test(String(sha256))) return null;
  const { rows } = await pool.query(
    'UPDATE wasm_modules SET used_at = NOW() WHERE sha256 = $1 RETURNING bytes', [sha256]);
  return rows[0] ? rows[0].bytes : null;
}

/** Modules no serving twin names and nothing has used for a day (a rebuild of the same commit reuses one). */
async function sweepModules(pool) {
  const { rowCount } = await pool.query(
    `DELETE FROM wasm_modules m
      WHERE m.used_at < NOW() - INTERVAL '1 day'
        AND NOT EXISTS (SELECT 1 FROM chat_sessions s WHERE s.wasm_twin ->> 'mod' = m.sha256)`);
  if (rowCount) log.info('wasm-runtime', 'Unused Wasm modules dropped', { dropped: rowCount });
  return rowCount;
}

module.exports = {
  MAX_SOURCE_BYTES, twinRuntimeName, sourceArchive, buildModule, copyNodeStylesheet, prepareTwin, removeTwin,
  moduleBytes, sweepModules,
};
