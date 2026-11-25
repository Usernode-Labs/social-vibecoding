'use strict';

// Personal access tokens for an app (25 Nov 2026).
//
// A member's own assistant calls an app at the app's own address with no
// browser and no Homeroom session: an MCP client at /mcp, a script. The
// app's door (services/edge-gate.js) is where such a call is checked, so an
// app never has to decide for itself whether a stranger may come in:
//
//   * a token is made by a member from inside the app: the app's server
//     asks POST /api/app-platform/v1/access-tokens with its app credential
//     and that member's identity (routes/app-platform-api.js). It belongs to
//     that member and that app, and nothing else can use it;
//   * only its SHA-256 is stored (app_access_tokens, staging:private). The
//     token is 32 random bytes, so a plain hash is enough, and it is shown
//     once, in the answer that made it;
//   * a request carrying it as `Authorization: Bearer hrat_…` passes the
//     door only on a path the app declared in dapp.json (`agentPaths`, read
//     by services/app-manifest.js readAgentPaths), only at the app's
//     production address, and only while the token is not revoked and its
//     owner is still a member who may see the app. It reaches the app with
//     that member's identity (`x-usernode-token`), exactly as a signed-in
//     visit does. Anything else is a bare 401.
//
// A token whose owner has left the project is revoked the first time it is
// seen at the door, and one made before its owner's current membership
// began never counts, so being let back in does not bring an old token back.
//
// The identity a token's request carries is marked (`scope` in the JWT):
// the app reads who it is, and the AI proxy, file storage and the directory
// refuse it. A token is therefore worth exactly one thing: calling this
// app's declared paths as that member.

const crypto = require('node:crypto');

const PREFIX = 'hrat_';
const TOKEN_RE = /^hrat_[A-Za-z0-9_-]{43}$/;
// Live tokens one member may hold for one app.
const MAX_PER_MEMBER = 10;
const MAX_NAME = 60;
// A path a token may be used on: declared whole, matched whole or as a
// directory. Never the app's root, and never the gate's own paths.
const PATH_RE = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;
const MAX_PATHS = 3;
const MAX_PATH_LENGTH = 64;
// last_used_at is written at most this often per token.
const TOUCH_EVERY_MS = 60 * 1000;

const touched = new Map(); // token id -> last write (ms)

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// The token of an `Authorization: Bearer hrat_…` header, or null. Any other
// Authorization value is not ours: the door treats it as it always has.
function bearerOf(value) {
  if (typeof value !== 'string') return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(value);
  return m && m[1].startsWith(PREFIX) ? m[1] : null;
}

// dapp.json's `agentPaths`, kept only when every entry is well formed: a
// half-read list would open a path the group did not vote for, or close one
// it did. Returns [] for anything else.
function cleanAgentPaths(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_PATHS) return [];
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || raw.length > MAX_PATH_LENGTH || !PATH_RE.test(raw)) return [];
    if (raw.split('/').some((part) => part === '.' || part === '..')) return [];
    if (raw.toLowerCase().startsWith('/__usernode')) return [];
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

// Is `path` (no query) one of the declared paths, or under one?
function onAgentPath(paths, path) {
  if (!Array.isArray(paths) || typeof path !== 'string') return false;
  // An encoded or dotted segment could name another path once the app
  // decodes it: only a plain path can match.
  if (path.includes('%') || path.includes('\\') || path.split('/').some((p) => p === '.' || p === '..')) return false;
  return paths.some((p) => path === p || path.startsWith(p + '/'));
}

function publicRow(row) {
  return {
    id: String(row.id),
    name: row.name,
    hint: row.hint,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    last_used_at: row.last_used_at instanceof Date ? row.last_used_at.toISOString() : (row.last_used_at || null),
  };
}

function cleanName(value) {
  const name = String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return name || null;
}

async function list(pool, { appId, userId }) {
  const { rows } = await pool.query(
    `SELECT id, name, hint, created_at, last_used_at
       FROM app_access_tokens
      WHERE app_id = $1 AND user_id = $2 AND revoked_at IS NULL
      ORDER BY created_at DESC, id DESC`,
    [appId, userId]
  );
  return rows.map(publicRow);
}

// Makes a token. Answers { token, row } (the only time the token itself
// exists outside its owner's hands), or { error } with a stable code.
async function create(pool, { appId, userId, name }) {
  const clean = cleanName(name);
  if (!clean) return { error: 'name_required' };
  const token = PREFIX + crypto.randomBytes(32).toString('base64url');
  // One statement, so two requests at once cannot both pass the limit.
  const { rows } = await pool.query(
    `INSERT INTO app_access_tokens (app_id, user_id, name, token_hash, hint)
     SELECT $1, $2, $3, $4, $5
      WHERE (SELECT COUNT(*) FROM app_access_tokens
              WHERE app_id = $1 AND user_id = $2 AND revoked_at IS NULL) < $6
     RETURNING id, name, hint, created_at, last_used_at`,
    [appId, userId, clean, hashToken(token), token.slice(-4), MAX_PER_MEMBER]
  );
  if (!rows.length) return { error: 'too_many_tokens' };
  return { token, row: publicRow(rows[0]) };
}

async function revoke(pool, { appId, userId, id }) {
  if (!/^\d{1,18}$/.test(String(id))) return false;
  const { rows } = await pool.query(
    `UPDATE app_access_tokens SET revoked_at = NOW()
      WHERE id = $1 AND app_id = $2 AND user_id = $3 AND revoked_at IS NULL
      RETURNING id`,
    [String(id), appId, userId]
  );
  return rows.length > 0;
}

// Every live token a person holds for an app: they left, or were removed.
async function revokeAllFor(pool, { appId, userId }) {
  await pool.query(
    `UPDATE app_access_tokens SET revoked_at = NOW()
      WHERE app_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [appId, userId]
  );
}

// The live token this string is, or null. Never throws on a malformed one,
// and never says which of "unknown" and "revoked" it was.
async function resolve(pool, token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const { rows } = await pool.query(
    `SELECT id, app_id, user_id, created_at FROM app_access_tokens
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(token)]
  );
  const row = rows[0];
  if (!row) return null;
  return { id: String(row.id), appId: Number(row.app_id), userId: Number(row.user_id), createdAt: new Date(row.created_at) };
}

// Is the token's owner a member of the app's project, and were they one
// already when the token was made? Leaving removes the membership row and
// coming back writes a new one, so a token from before does not count.
async function heldSinceJoining(pool, held) {
  const { rows } = await pool.query(
    `SELECT m.joined_at
       FROM apps a
       JOIN community_members m ON m.community_id = a.community_id
      WHERE a.id = $1 AND m.user_id = $2`,
    [held.appId, held.userId]
  );
  if (!rows.length) return false;
  const joined = rows[0].joined_at ? new Date(rows[0].joined_at).getTime() : 0;
  return held.createdAt.getTime() >= joined;
}

// Notes that a token was used. Never awaited by the door and never fatal.
function touch(pool, id) {
  const now = Date.now();
  const last = touched.get(id);
  if (last && now - last < TOUCH_EVERY_MS) return;
  if (touched.size > 5000) touched.clear();
  touched.set(id, now);
  pool.query('UPDATE app_access_tokens SET last_used_at = NOW() WHERE id = $1', [id]).catch(() => {});
}

function resetForTest() { touched.clear(); }

module.exports = {
  PREFIX,
  MAX_PER_MEMBER,
  MAX_PATHS,
  hashToken,
  bearerOf,
  cleanAgentPaths,
  onAgentPath,
  list,
  create,
  revoke,
  revokeAllFor,
  resolve,
  heldSinceJoining,
  touch,
  resetForTest,
};
