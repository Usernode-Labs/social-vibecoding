'use strict';

// Browser approval for an app's agent path (25 Nov 2026).
//
// services/app-access-tokens.js is the token a member copies by hand. This
// is the same door opened the standard way an MCP client expects: the
// assistant is given only the app's declared address
// (https://<app>/mcp), the door's 401 names where to ask, and the member
// approves it on Homeroom in their own browser. Homeroom is the
// authorization server, with the client registration, the consent page and
// the token endpoint its own connector already has (routes/mcp-remote.js).
// A request that names an app's address in `resource` (RFC 8707) is this
// flow; one that names none is the connector's, untouched.
//
// What comes out is kept apart from the connector's tokens on purpose, in
// tables and prefixes of its own, so neither can ever be taken for the
// other: an app's token never opens Homeroom's /mcp, and a connector token
// never opens an app.
//
//   * an approval is one row of app_agent_grants: this member, this app,
//     this client. Only a member of the project who may see the app can
//     make one, and only for a path the app declared (`agentPaths`);
//   * its access token (`hrao_…`) lasts an hour, its refresh token
//     (`hrar_…`) thirty days, rotated at every use. Presenting a refresh
//     token that was already rotated away ends the whole approval;
//   * the door (services/edge-gate.js) checks the access token on every
//     request exactly as it checks a personal one: declared path,
//     production address, this app's, its owner a member since before the
//     approval and still able to see the app. The app sees the same marked
//     identity either way.
//
// Only SHA-256 digests are stored. Everything here is data handling: no
// Express.

const crypto = require('node:crypto');
const mcpOauth = require('./mcp-oauth');

const ACCESS_PREFIX = 'hrao_';
const REFRESH_PREFIX = 'hrar_';
const CODE_PREFIX = 'hrac_';
const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const CODE_TTL_SECONDS = 60;
// Live approvals one member may hold for one app. One more ends the one
// used longest ago: an approval is made from a chat product's own screen,
// which has nowhere to say "revoke one first".
const MAX_PER_MEMBER = 10;
const TOUCH_EVERY_MS = 60 * 1000;

const touched = new Map(); // grant row id -> last write (ms)

const hash = (value) => mcpOauth.hashSecret(value);
const make = (prefix) => prefix + crypto.randomBytes(32).toString('base64url');
const isAccessToken = (value) => mcpOauth.isCanonicalSecret(value, ACCESS_PREFIX);
const isRefreshToken = (value) => mcpOauth.isCanonicalSecret(value, REFRESH_PREFIX);
const isCode = (value) => mcpOauth.isCanonicalSecret(value, CODE_PREFIX);

// The token of an `Authorization: Bearer hrao_…` header, or null.
function bearerOf(value) {
  if (typeof value !== 'string') return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(value);
  return m && m[1].startsWith(ACCESS_PREFIX) ? m[1] : null;
}

// The app address a request names, as the app it is, or null. It must be
// exactly https://<the app's production address><a path the app declared>:
// no port, query, fragment or credentials, never a preview, never an app
// that declared no such path. The canonical string is what gets stored and
// compared, so two spellings of one address cannot differ later.
async function resolveResource(pool, value) {
  if (typeof value !== 'string' || !value || value.length > 512) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) return null;
  const parsed = await require('./app-domains').resolveAppHost(pool, url.hostname);
  if (!parsed || parsed.label !== parsed.slug) return null;
  const vis = await require('./app-access').getHostVisibility(pool, parsed.slug);
  if (!vis || vis.suspended) return null;
  const paths = Array.isArray(vis.agentPaths) ? vis.agentPaths : [];
  if (!paths.includes(url.pathname)) return null;
  const { rows } = await pool.query('SELECT name FROM apps WHERE id = $1', [vis.appId]);
  if (!rows.length) return null;
  return {
    appId: vis.appId,
    slug: parsed.slug,
    name: rows[0].name || parsed.slug,
    host: parsed.host,
    path: url.pathname,
    resource: `https://${parsed.host}${url.pathname}`,
  };
}

// Who may approve: a member of the app's project who may see the app. The
// same two questions the door asks on every call.
async function mayApprove(pool, appId, userId) {
  return await require('./communities').isMember(pool, appId, userId)
    && await require('./app-access').isViewMember(pool, appId, userId);
}

async function issueCode(pool, { appId, userId, clientId, redirectUri, codeChallenge, resource }) {
  const code = make(CODE_PREFIX);
  const grantId = mcpOauth.makeGrantId();
  await pool.query(
    `INSERT INTO app_agent_codes
       (code_hash, grant_id, app_id, user_id, client_id, redirect_uri, code_challenge, resource,
        created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             clock_timestamp(), clock_timestamp() + ($9 || ' seconds')::interval)`,
    [hash(code), grantId, appId, userId, clientId, redirectUri, codeChallenge, resource, String(CODE_TTL_SECONDS)]
  );
  return { code, grantId };
}

async function issuePair(db, { grantId, rotatedFrom = null }) {
  const accessToken = make(ACCESS_PREFIX);
  const refreshToken = make(REFRESH_PREFIX);
  await db.query(
    `INSERT INTO app_agent_tokens (token_hash, kind, grant_id, rotated_from, created_at, expires_at)
     VALUES ($1, 'access', $2, NULL, clock_timestamp(), clock_timestamp() + ($3 || ' seconds')::interval),
            ($4, 'refresh', $2, $5, clock_timestamp(), clock_timestamp() + ($6 || ' seconds')::interval)`,
    [hash(accessToken), grantId, String(ACCESS_TTL_SECONDS), hash(refreshToken), rotatedFrom, String(REFRESH_TTL_SECONDS)]
  );
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS };
}

// Ends an approval and every token made from it.
async function revokeGrant(db, grantId) {
  await db.query(
    'UPDATE app_agent_tokens SET revoked_at = clock_timestamp() WHERE grant_id = $1 AND revoked_at IS NULL',
    [grantId]
  );
  const { rowCount } = await db.query(
    'UPDATE app_agent_grants SET revoked_at = clock_timestamp() WHERE grant_id = $1 AND revoked_at IS NULL',
    [grantId]
  );
  return rowCount > 0;
}

// The code for tokens, once. Runs inside the caller's transaction. A code
// presented twice has leaked: whatever its first use made is ended.
// `resource`, when the client sends it again here, must be the address it
// asked for.
async function exchangeCode(db, { code, clientId, redirectUri, codeVerifier, resource = null }) {
  const { rows } = await db.query(
    `SELECT id, grant_id, app_id, user_id, client_id, redirect_uri, code_challenge, resource,
            expires_at, consumed_at, clock_timestamp() AS now
       FROM app_agent_codes WHERE code_hash = $1 FOR UPDATE`,
    [hash(code)]
  );
  if (!rows.length) return { error: 'invalid_grant' };
  const row = rows[0];
  if (row.consumed_at) {
    await revokeGrant(db, row.grant_id);
    return { error: 'invalid_grant' };
  }
  if (new Date(row.now) >= new Date(row.expires_at)) return { error: 'invalid_grant' };
  if (row.client_id !== clientId || row.redirect_uri !== redirectUri) return { error: 'invalid_grant' };
  await db.query('UPDATE app_agent_codes SET consumed_at = clock_timestamp() WHERE id = $1', [row.id]);
  if (!mcpOauth.verifyPkce(codeVerifier, row.code_challenge)) return { error: 'invalid_grant' };
  if (resource != null && resource !== row.resource) return { error: 'invalid_target' };
  // Still a member a minute later: the approval is made here, so this is
  // where it is refused to somebody who has just left.
  if (!await mayApprove(db, row.app_id, row.user_id)) return { error: 'invalid_grant' };

  const { rows: clients } = await db.query('SELECT client_name FROM mcp_clients WHERE client_id = $1', [clientId]);
  let origin = '';
  try { origin = new URL(row.redirect_uri).origin; } catch { origin = ''; }
  await db.query(
    `INSERT INTO app_agent_grants (grant_id, app_id, user_id, client_id, client_name, redirect_origin)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [row.grant_id, row.app_id, row.user_id, clientId, (clients[0] && clients[0].client_name) || 'MCP client', origin]
  );
  // Over the limit: the ones used longest ago go.
  const { rows: extra } = await db.query(
    `SELECT grant_id FROM app_agent_grants
      WHERE app_id = $1 AND user_id = $2 AND revoked_at IS NULL
      ORDER BY COALESCE(last_used_at, created_at) DESC, id DESC
      OFFSET $3`,
    [row.app_id, row.user_id, MAX_PER_MEMBER]
  );
  for (const old of extra) await revokeGrant(db, old.grant_id);
  const issued = await issuePair(db, { grantId: row.grant_id });
  return { issued, appId: row.app_id, userId: row.user_id, grantId: row.grant_id, resource: row.resource };
}

// A new pair for a refresh token, which is spent by it. One that was
// already spent is the stolen-token signal: the approval ends.
async function rotate(pool, { refreshToken, clientId }) {
  return mcpOauth.withTransaction(pool, async (db) => {
    const { rows } = await db.query(
      `SELECT t.id, t.grant_id, t.expires_at, t.revoked_at,
              g.app_id, g.user_id, g.client_id, g.revoked_at AS grant_revoked_at, g.created_at AS grant_created_at,
              clock_timestamp() AS now
         FROM app_agent_tokens t JOIN app_agent_grants g ON g.grant_id = t.grant_id
        WHERE t.token_hash = $1 AND t.kind = 'refresh'
        FOR UPDATE OF t`,
      [hash(refreshToken)]
    );
    if (!rows.length) return { error: 'invalid_grant' };
    const row = rows[0];
    if (row.client_id !== clientId) return { error: 'invalid_grant' };
    if (row.revoked_at || row.grant_revoked_at) {
      await revokeGrant(db, row.grant_id);
      return { error: 'invalid_grant', reuse: !!row.revoked_at };
    }
    if (new Date(row.now) >= new Date(row.expires_at)) return { error: 'invalid_grant' };
    // Somebody who left gets no new token: the approval ends here rather
    // than at the door an hour of refreshes later.
    const held = { appId: Number(row.app_id), userId: Number(row.user_id), createdAt: new Date(row.grant_created_at) };
    const member = await require('./app-access-tokens').heldSinceJoining(db, held)
      && await require('./app-access').isViewMember(db, held.appId, held.userId);
    if (!member) {
      await revokeGrant(db, row.grant_id);
      return { error: 'invalid_grant' };
    }
    await db.query(
      'UPDATE app_agent_tokens SET revoked_at = clock_timestamp() WHERE grant_id = $1 AND revoked_at IS NULL',
      [row.grant_id]
    );
    const issued = await issuePair(db, { grantId: row.grant_id, rotatedFrom: row.id });
    return { issued, appId: held.appId, userId: held.userId, grantId: row.grant_id };
  });
}

// The live approval an access token belongs to, or null. Never says which
// of unknown, expired and revoked it was. `createdAt` is the approval's, so
// the door's "a member since before" question is about the approval.
async function resolveAccess(pool, token) {
  if (!isAccessToken(token)) return null;
  const { rows } = await pool.query(
    `SELECT g.id, g.grant_id, g.app_id, g.user_id, g.created_at
       FROM app_agent_tokens t JOIN app_agent_grants g ON g.grant_id = t.grant_id
      WHERE t.token_hash = $1 AND t.kind = 'access'
        AND t.revoked_at IS NULL AND t.expires_at > clock_timestamp()
        AND g.revoked_at IS NULL`,
    [hash(token)]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    grantId: row.grant_id,
    appId: Number(row.app_id),
    userId: Number(row.user_id),
    createdAt: new Date(row.created_at),
  };
}

const iso = (value) => (value instanceof Date ? value.toISOString() : (value || null));

// A member's connected assistants for one app, for the app's own screen.
async function list(pool, { appId, userId }) {
  const { rows } = await pool.query(
    `SELECT grant_id, client_name, redirect_origin, created_at, last_used_at
       FROM app_agent_grants
      WHERE app_id = $1 AND user_id = $2 AND revoked_at IS NULL
      ORDER BY created_at DESC, id DESC`,
    [appId, userId]
  );
  return rows.map((row) => ({
    id: row.grant_id,
    name: row.client_name,
    origin: row.redirect_origin,
    created_at: iso(row.created_at),
    last_used_at: iso(row.last_used_at),
  }));
}

async function revoke(pool, { appId, userId, id }) {
  if (typeof id !== 'string' || !mcpOauth.GRANT_ID_RE.test(id)) return false;
  return mcpOauth.withTransaction(pool, async (db) => {
    const { rows } = await db.query(
      `SELECT grant_id FROM app_agent_grants
        WHERE grant_id = $1 AND app_id = $2 AND user_id = $3 AND revoked_at IS NULL FOR UPDATE`,
      [id, appId, userId]
    );
    if (!rows.length) return false;
    await revokeGrant(db, id);
    return true;
  });
}

// Every approval a person holds for an app: they left, or were removed.
async function revokeAllFor(pool, { appId, userId }) {
  await pool.query(
    `UPDATE app_agent_tokens SET revoked_at = clock_timestamp()
      WHERE revoked_at IS NULL AND grant_id IN
        (SELECT grant_id FROM app_agent_grants WHERE app_id = $1 AND user_id = $2 AND revoked_at IS NULL)`,
    [appId, userId]
  );
  await pool.query(
    `UPDATE app_agent_grants SET revoked_at = clock_timestamp()
      WHERE app_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [appId, userId]
  );
}

// RFC 7009: the client asks for a token to be forgotten, and the whole
// approval goes with it. Answers the approval ended, or null.
async function revokeByToken(pool, token) {
  if (!isAccessToken(token) && !isRefreshToken(token)) return null;
  return mcpOauth.withTransaction(pool, async (db) => {
    const { rows } = await db.query(
      `SELECT g.grant_id, g.app_id, g.user_id, g.client_id
         FROM app_agent_tokens t JOIN app_agent_grants g ON g.grant_id = t.grant_id
        WHERE t.token_hash = $1`,
      [hash(token)]
    );
    if (!rows.length) return null;
    await revokeGrant(db, rows[0].grant_id);
    return { grantId: rows[0].grant_id, appId: Number(rows[0].app_id), userId: Number(rows[0].user_id), clientId: rows[0].client_id };
  });
}

// Notes that an approval was used. Never awaited by the door, never fatal.
function touch(pool, id) {
  const now = Date.now();
  const last = touched.get(id);
  if (last && now - last < TOUCH_EVERY_MS) return;
  if (touched.size > 5000) touched.clear();
  touched.set(id, now);
  pool.query('UPDATE app_agent_grants SET last_used_at = NOW() WHERE id = $1', [id]).catch(() => {});
}

// Where the door's 401 sends a client: the document that names Homeroom as
// the place to ask, for this app address. It lives on Homeroom's own
// address because the door can only answer a request or pass it to the app;
// it cannot serve a page of its own on the app's.
function metadataPath(host, path) {
  return `/.well-known/oauth-protected-resource/app/${host}${path}`;
}

function resetForTest() { touched.clear(); }

module.exports = {
  ACCESS_PREFIX,
  REFRESH_PREFIX,
  CODE_PREFIX,
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  MAX_PER_MEMBER,
  isAccessToken,
  isRefreshToken,
  isCode,
  bearerOf,
  resolveResource,
  mayApprove,
  issueCode,
  exchangeCode,
  rotate,
  resolveAccess,
  list,
  revoke,
  revokeAllFor,
  revokeByToken,
  touch,
  metadataPath,
  resetForTest,
};
