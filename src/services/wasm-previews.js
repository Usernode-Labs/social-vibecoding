'use strict';

// Wasm previews (pilot): the rules every part of the platform shares about
// the second, WebAssembly preview a switched project's proposals get beside
// their Node one. runtime/wasm/README.md describes the whole arrangement;
// this module is what the platform decides with:
//
//   - WHICH projects: an admin's list, stored in platform_settings and read
//     through a short cache, like services/preview-projects-setting.js. Only
//     on a deploy with WASM_PREVIEWS=on, which brings the runners up
//     (services/wasm-runtime.js); off, nothing here ever answers yes.
//   - NAMES: the twin's database beside its attempt's (`…_w`, on the preview
//     server like every attempt database), and its address beside the
//     preview's (`<slug>--s<id>--wasm`, which app-access.parseAppHost and
//     the waking page already read as that preview's).
//   - THE PASS the platform signs for each request to a twin, which the
//     runner and the data service check (Ed25519, WASM_PASS_KEY).
//   - THE PASSWORD of a twin database's owner login, derived from its name
//     with WASM_DB_SECRET, so the data service can log in without the
//     platform handing a password to anything.

const crypto = require('crypto');
const log = require('./logger');

const KEY = 'wasm_previews';
const CACHE_TTL_MS = 10 * 1000;
// The label suffix of a twin's address and the database suffix of its copy.
const HOST_SUFFIX = '--wasm';
const DB_SUFFIX = '_w';
// What the runner Service and the data service are called in the app
// namespace (services/wasm-runtime.js creates both).
const RUNNER_NAME = 'usernode-wasm-runner';
const DATA_NAME = 'usernode-wasm-data';
const PASS_VERSION = 1;
const PASS_TTL_S = new Map([['req', 60], ['setup', 300]]);

// Postgres keeps 63 bytes of a name; a twin's owner login is `<db>_owner`.
const MAX_DB_BYTES = 63 - '_owner'.length;
const ATTEMPT_DB_RE = /^(app_[a-z0-9_]+?)(_staging_s\d+_[0-9a-f]{6})$/;
const TWIN_DB_RE = /^app_[a-z0-9_]+_staging_s\d+_[0-9a-f]{6}_w$/;

/** Whether this deploy runs Wasm previews at all (the runners exist). */
function deployOn(config) {
  const value = config?.wasmPreviews?.mode ?? process.env.WASM_PREVIEWS ?? 'off';
  if (String(value).trim().toLowerCase() !== 'on') return false;
  const runtime = config?.appRuntime || process.env.APP_RUNTIME || 'docker';
  // Never inside a preview of the platform itself: the runners are the
  // cluster's, and a preview has none of the keys.
  return runtime === 'kubernetes' && process.env.USERNODE_ENV !== 'staging';
}

// Per pool, so tests that each mount their own fake pool never share an answer.
const caches = new WeakMap();

function parseStored(raw) {
  try {
    const list = JSON.parse(String(raw || '[]'));
    if (!Array.isArray(list)) return new Set();
    return new Set(list.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0));
  } catch {
    return new Set();
  }
}

/** The switched projects' ids. Never throws: a failed read is "none". */
async function projects(pool) {
  const cached = caches.get(pool);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.ids;
  let ids = new Set();
  try {
    const { rows } = await pool.query('SELECT value FROM platform_settings WHERE key = $1', [KEY]);
    ids = parseStored(rows[0] && rows[0].value);
  } catch (err) {
    log.warn('wasm-previews', 'Wasm previews setting read failed; treating it as none', { err: err.message });
    return new Set();
  }
  caches.set(pool, { ids, at: Date.now() });
  return ids;
}

/** Whether a proposal of this project gets a Wasm twin, here and now. */
async function enabledFor(config, pool, appId) {
  if (!deployOn(config)) return false;
  return (await projects(pool)).has(Number(appId));
}

/** null when acceptable, else the reason: a list of project ids. */
function validate(value) {
  if (!Array.isArray(value)) return 'projects must be a list of project ids.';
  if (value.length > 20) return 'At most 20 projects can be switched to Wasm previews.';
  if (!value.every((id) => Number.isSafeInteger(Number(id)) && Number(id) > 0)) return 'projects must be project ids.';
  return null;
}

async function set(pool, { projects: ids, actorId = null }) {
  const list = [...new Set(ids.map(Number))].sort((a, b) => a - b);
  if (!list.length) {
    await pool.query('DELETE FROM platform_settings WHERE key = $1', [KEY]);
  } else {
    await pool.query(
      `INSERT INTO platform_settings (key, value, updated_at, updated_by)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [KEY, JSON.stringify(list), actorId]
    );
  }
  caches.delete(pool);
}

/** What the admin API answers: whether the deploy runs them, and for whom. */
async function adminPayload(pool, config) {
  const ids = [...await projects(pool)];
  let named = [];
  if (ids.length) {
    const { rows } = await pool.query('SELECT id, slug FROM apps WHERE id = ANY($1::int[]) ORDER BY id', [ids]);
    named = rows.map((r) => ({ id: r.id, slug: r.slug }));
  }
  return { deploy: deployOn(config) ? 'on' : 'off', projects: named };
}

// ── Names ────────────────────────────────────────────────────────────────

/**
 * The twin's database for an attempt's: the attempt's name with `_w`, its
 * slug part shortened when that is needed to keep the owner login within 63
 * bytes. null for a name that is not an attempt database (a preview built
 * before the machine, or a platform preview), which then gets no twin.
 */
function twinDb(attemptDb) {
  const m = ATTEMPT_DB_RE.exec(String(attemptDb || ''));
  if (!m) return null;
  const [, prefix, tail] = m;
  const room = MAX_DB_BYTES - tail.length - DB_SUFFIX.length;
  if (room < 'app_x'.length) return null;
  return `${prefix.slice(0, room)}${tail}${DB_SUFFIX}`;
}

function isTwinDb(name) {
  return TWIN_DB_RE.test(String(name || ''));
}

/** The twin's DNS label for a preview's (`<slug>--s<id>` → `<slug>--s<id>--wasm`). */
function twinLabel(slug, sessionId) {
  return `${slug}--s${Number(sessionId)}${HOST_SUFFIX}`;
}

/** Whether a parsed app host (app-access.parseAppHost) is a Wasm twin, and of which preview. */
function twinOfLabel(label) {
  const m = /^([a-z0-9-]+?)--s(\d+)--wasm$/.exec(String(label || ''));
  return m ? { slug: m[1], sessionId: Number(m[2]) } : null;
}

// ── Passes ───────────────────────────────────────────────────────────────

let signingKey = null;
function passKey() {
  if (signingKey) return signingKey;
  const pem = process.env.WASM_PASS_KEY || '';
  if (!pem) throw new Error('WASM_PASS_KEY is not set; Wasm twins cannot be reached');
  signingKey = crypto.createPrivateKey(pem.includes('BEGIN') ? pem : Buffer.from(pem, 'base64').toString('utf8'));
  if (signingKey.asymmetricKeyType !== 'ed25519') throw new Error('WASM_PASS_KEY must be an Ed25519 key');
  return signingKey;
}

/**
 * A pass for one request to a twin (`scope` 'req') or for its release's
 * setup run ('setup'): which project, preview, module and database, and who
 * is signed in (null for nobody). runtime/wasm/README.md "The pass".
 */
function signPass({ appId, sessionId, moduleHash, db, userId = null, scope = 'req', env = null }, { now = Date.now() } = {}) {
  if (!PASS_TTL_S.has(scope)) throw new Error(`Unknown pass scope ${scope}`);
  if (!/^[0-9a-f]{64}$/.test(String(moduleHash || ''))) throw new Error('A pass names its module by its SHA-256');
  if (!isTwinDb(db)) throw new Error('A pass names a twin database');
  const claims = {
    v: PASS_VERSION, app: Number(appId), ses: Number(sessionId), mod: moduleHash, db,
    user: userId == null ? null : Number(userId), scope,
    exp: Math.floor(now / 1000) + PASS_TTL_S.get(scope),
    ...(env && Object.keys(env).length ? { env } : {}),
  };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = crypto.sign(null, Buffer.from(body), passKey()).toString('base64url');
  return `${body}.${sig}`;
}

/**
 * What a twin's code finds in process.env beside what the runner sets, as
 * its container would (app-identity-env.js): the project's name and address
 * and the platform's origin. It rides in each pass, so it stays this small.
 */
function twinEnv(app) {
  const origin = require('./app-identity-env').platformOrigin();
  return {
    USERNODE_APP_NAME: String(app?.name || ''),
    USERNODE_APP_SLUG: String(app?.slug || ''),
    ...(origin ? { USERNODE_PLATFORM_ORIGIN: origin } : {}),
  };
}

/** The raw 32-byte public half, base64: what runners and the data service check with. */
function passPublicKey() {
  const der = crypto.createPublicKey(passKey()).export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('base64');
}

// ── The twin database's password ─────────────────────────────────────────

/** hex(HMAC-SHA256(WASM_DB_SECRET, db)): set by the platform, derived by the data service. */
function dbPassword(db) {
  const secret = process.env.WASM_DB_SECRET || '';
  if (secret.length < 32) throw new Error('WASM_DB_SECRET is not set (32 characters at least)');
  if (!isTwinDb(db)) throw new Error('Only a twin database gets a derived password');
  return crypto.createHmac('sha256', secret).update(db).digest('hex');
}

function _resetForTest() { signingKey = null; }

module.exports = {
  KEY, CACHE_TTL_MS, HOST_SUFFIX, DB_SUFFIX, RUNNER_NAME, DATA_NAME, PASS_VERSION,
  deployOn, projects, enabledFor, validate, set, adminPayload,
  twinDb, isTwinDb, twinLabel, twinOfLabel,
  signPass, passPublicKey, dbPassword, twinEnv,
  _resetForTest,
};
