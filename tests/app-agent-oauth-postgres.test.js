'use strict';

// Browser approval for an app's agent path (25 Nov 2026), against the real
// schema in a throwaway database.
//
// A member's assistant is given only the app's declared address. The door's
// 401 names the document that says where to ask, the member approves on
// Homeroom, and the assistant gets an hour-long token for that one app,
// renewed with a rotating refresh token (src/services/app-agent-oauth.js,
// src/routes/mcp-remote.js, src/services/edge-gate.js).
//
// What this holds:
//   * the door's 401 on a declared path points at the document, and a client
//     that looks for it on the app's own address is sent to it;
//   * only an app's production address and a path it declared can be asked
//     for; a request naming anything else is refused, never answered with a
//     connector token; a request naming no address is the connector's, as
//     before;
//   * only a member of the project who may see the app can approve, and
//     nobody else learns the app's name;
//   * a code works once, for the client, address and PKCE secret it was made
//     for, and a second use ends what the first made;
//   * the token opens the declared path as its member, marked as a token's,
//     and nothing else: not another app, not Homeroom's own connector;
//   * a refresh rotates, and a spent refresh token ends the approval;
//   * leaving the project ends it at the door and at the token endpoint;
//   * the app lists and disconnects its member's assistants.
//
// The database part is required when TEST_DATABASE_URL is set and skipped
// when no server is reachable.
//
// Run with: node --test tests/app-agent-oauth-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');

process.env.EDGE_JWT_SECRET = 'app-agent-oauth-test-edge-secret';
delete process.env.APP_HOST_SIGNIN;
delete process.env.USERNODE_ENV;
require('./platform-keys').setPlatformKeys();
{
  const id = require.resolve('../src/services/logger');
  require.cache[id] = { id, filename: id, loaded: true, paths: [], exports: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } };
}

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
// USERNODE_DOMAIN is unset in tests: services/caddy.js default.
const DOMAIN = 'social-vibecoding.usernodelabs.org';
const ORIGIN = `https://${DOMAIN}`;
const HOST = `team.${DOMAIN}`;
const RESOURCE = `https://${HOST}/mcp`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const APP_TOKEN = 'e'.repeat(64);

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

test('browser approval for an app\'s agent path, on the real schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'app_agent_oauth_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  const poolPath = require.resolve('../src/db/pool');
  const originalPool = require.cache[poolPath];
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (originalPool) require.cache[poolPath] = originalPool;
    else delete require.cache[poolPath];
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  require.cache[poolPath] = {
    exports: { getPool: () => pool },
    loaded: true, id: poolPath, filename: poolPath, paths: originalPool ? originalPool.paths : [],
  };

  const platformJwt = require('../src/services/platform-jwt');
  const appAccess = require('../src/services/app-access');
  const edgeGate = require('../src/services/edge-gate');
  const appAgent = require('../src/services/app-agent-oauth');
  const mcpOauth = require('../src/services/mcp-oauth');
  const { internalRoutes } = require('../src/routes/internal');
  const appPlatformApiRoutes = require('../src/routes/app-platform-api');
  const { mcpPreAuthRoutes, mcpBrowserRoutes, authenticateConnector } = require('../src/routes/mcp-remote');

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const user = async (username) => (await one(
    'INSERT INTO users (username, password, has_platform_access) VALUES ($1, $2, TRUE) RETURNING id', [username, 'x'])).id;
  const ana = await user('ana');
  const ben = await user('ben');
  const outsider = await user('outsider');
  const addApp = async (slug, paths, token = null) => (await one(
    `INSERT INTO apps (slug, name, created_by, view_visibility, collab_visibility, manifest_snapshot, llm_proxy_token)
     VALUES ($1, $2, $3, 'private', 'private', $4::jsonb, $5) RETURNING id`,
    [slug, slug === 'team' ? 'Team list' : slug, ana, JSON.stringify(paths ? { agentPaths: paths } : {}), token])).id;
  const team = await addApp('team', ['/mcp'], APP_TOKEN);
  const other = await addApp('other', ['/mcp']);
  await addApp('plain', null);
  const join = (appId, userId) => pool.query(
    "INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING", [appId, userId]);
  const leave = async (appId, userId) => {
    await pool.query('DELETE FROM app_collaborators WHERE app_id = $1 AND user_id = $2', [appId, userId]);
    await pool.query(
      'DELETE FROM community_members WHERE user_id = $2 AND community_id = (SELECT community_id FROM apps WHERE id = $1)',
      [appId, userId]);
    appAccess.invalidateAllVisibility();
    edgeGate._resetCachesForTest();
  };
  for (const appId of [team, other]) { await join(appId, ana); await join(appId, ben); }
  appAccess.invalidateAllVisibility();
  assert.equal(await appAgent.mayApprove(pool, team, ana), true, 'a collaborator is a member of the project');

  const client = await mcpOauth.registerClient(pool, { clientName: 'Claude', redirectUris: [REDIRECT] });
  const config = { cliAuthEnabled: true, cliAuthOrigin: ORIGIN };

  // One server: the public surfaces, then a stand-in for the session (the
  // `x-test-user` header), then the session's own routes, the door and the
  // app API.
  const app = express();
  app.use(cookieParser());
  app.use(mcpPreAuthRoutes(config));
  app.use((req, _res, next) => {
    const id = Number(req.headers['x-test-user']);
    if (id) req.user = { id, username: id === ana ? 'ana' : id === ben ? 'ben' : 'outsider' };
    next();
  });
  app.use(mcpBrowserRoutes(config));
  app.use(internalRoutes({}));
  app.use(appPlatformApiRoutes({}));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;

  function request(method, pathname, headers = {}, body) {
    return new Promise((resolve, reject) => {
      const req = http.request(`${base}${pathname}`, { method, headers }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, body: text, json });
        });
      });
      req.on('error', reject);
      if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
      req.end();
    });
  }
  const gate = ({ host = HOST, uri = '/mcp', method = 'POST', bearer } = {}) => request('GET', '/__caddy/access', {
    Host: host, 'X-Forwarded-Host': host, 'X-Forwarded-Method': method, 'X-Forwarded-Uri': uri,
    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
  });
  const details = (userId, query) => request('GET', '/api/connect/authorization?' + new URLSearchParams(query), { 'x-test-user': String(userId) });
  const decide = (userId, body) => request('POST', '/api/connect/oauth/authorize',
    { 'x-test-user': String(userId), origin: ORIGIN, 'content-type': 'application/json' }, body);
  const tokenCall = (fields) => request('POST', '/api/connect/oauth/token',
    { 'content-type': 'application/x-www-form-urlencoded' }, new URLSearchParams(fields).toString());
  const ask = (challenge, extra = {}) => ({
    decision: 'approve', client_id: client.client_id, redirect_uri: REDIRECT, state: 's1',
    code_challenge: challenge, code_challenge_method: 'S256', resource: RESOURCE, ...extra,
  });
  // Approve as `userId` and trade the code: the whole of what a client does.
  async function connect(userId = ana) {
    const p = pkce();
    const approved = await decide(userId, ask(p.challenge));
    assert.equal(approved.status, 200);
    const code = new URL(approved.json.redirect_to).searchParams.get('code');
    const tokens = await tokenCall({
      grant_type: 'authorization_code', client_id: client.client_id, code, redirect_uri: REDIRECT,
      code_verifier: p.verifier, resource: RESOURCE,
    });
    assert.equal(tokens.status, 200);
    return { code, verifier: p.verifier, ...tokens.json };
  }
  const METADATA = `${ORIGIN}/.well-known/oauth-protected-resource/app/${HOST}/mcp`;

  await t.test('the door\'s 401 names the document, and the document names Homeroom', async () => {
    const refused = await gate({});
    assert.equal(refused.status, 401);
    assert.equal(refused.headers['www-authenticate'], `Bearer resource_metadata="${METADATA}"`);
    // Looked for on the app's own address, it is the same document.
    for (const uri of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const sent = await gate({ uri, method: 'GET' });
      assert.equal(sent.status, 302, uri);
      assert.equal(sent.headers.location, METADATA);
    }
    const doc = await request('GET', `/.well-known/oauth-protected-resource/app/${HOST}/mcp`);
    assert.equal(doc.status, 200);
    assert.equal(doc.json.resource, RESOURCE);
    assert.deepEqual(doc.json.authorization_servers, [ORIGIN]);
    // Not an address an app declared: nothing.
    for (const path of [`${HOST}/other`, `plain.${DOMAIN}/mcp`, `team--s4.${DOMAIN}/mcp`, `nobody.${DOMAIN}/mcp`]) {
      assert.equal((await request('GET', `/.well-known/oauth-protected-resource/app/${path}`)).status, 404, path);
    }
    // An app that declared nothing sends nobody anywhere.
    const plain = await gate({ host: `plain.${DOMAIN}`, uri: '/.well-known/oauth-protected-resource/mcp', method: 'GET' });
    assert.ok(!String(plain.headers.location || '').includes('/.well-known/'), 'it is treated as any other address of that app');
  });

  await t.test('only an app\'s production address and a declared path can be asked for', async () => {
    assert.equal((await appAgent.resolveResource(pool, RESOURCE)).appId, team);
    for (const bad of [
      `http://${HOST}/mcp`, `https://${HOST}/mcp?x=1`, `https://${HOST}/mcp#x`, `https://${HOST}:8443/mcp`,
      `https://${HOST}/mcp/`, `https://${HOST}/`, `https://${HOST}/api`, `https://team--s4.${DOMAIN}/mcp`,
      `https://plain.${DOMAIN}/mcp`, `https://user@${HOST}/mcp`, 'https://example.com/mcp', 'not a url', '',
    ]) {
      assert.equal(await appAgent.resolveResource(pool, bad), null, bad);
    }
  });

  await t.test('a member sees which app is asking; nobody else learns it exists', async () => {
    const query = { client_id: client.client_id, redirect_uri: REDIRECT, resource: RESOURCE };
    const shown = await details(ana, query);
    assert.equal(shown.status, 200);
    assert.equal(shown.json.app.name, 'Team list');
    assert.equal(shown.json.app.address, `${HOST}/mcp`);
    assert.equal(shown.json.redirect_origin, 'https://claude.ai');
    assert.match(shown.json.scopes[0].label, /Act as you in Team list/);
    assert.equal((await details(outsider, query)).status, 404);
    assert.equal((await details(ana, { ...query, resource: 'https://example.com/mcp' })).status, 404);
    // No address, or Homeroom's own: the connector's screen, as before.
    for (const resource of [undefined, `${ORIGIN}/mcp`]) {
      const own = await details(ana, resource ? { ...query, resource } : { client_id: client.client_id, redirect_uri: REDIRECT });
      assert.equal(own.status, 200);
      assert.equal(own.json.app, undefined);
      assert.equal(own.json.scopes.length, 2);
    }
  });

  await t.test('only a member approves, and a request naming something else is refused outright', async () => {
    const p = pkce();
    assert.equal((await decide(outsider, ask(p.challenge))).status, 404);
    assert.equal((await decide(ana, ask(p.challenge, { resource: 'https://example.com/mcp' }))).status, 404);
    assert.equal((await decide(ana, ask(p.challenge, { resource: `https://plain.${DOMAIN}/mcp` }))).status, 404);
    // Without the configured origin it is not the person pressing Allow.
    const cross = await request('POST', '/api/connect/oauth/authorize',
      { 'x-test-user': String(ana), origin: 'https://evil.example', 'content-type': 'application/json' }, ask(p.challenge));
    assert.equal(cross.status, 403);
    assert.equal((await one('SELECT COUNT(*)::int AS n FROM app_agent_codes')).n, 0);
    // Cancel goes back with an error and makes nothing.
    const denied = await decide(ana, ask(p.challenge, { decision: 'deny' }));
    assert.equal(new URL(denied.json.redirect_to).searchParams.get('error'), 'access_denied');
    assert.equal((await one('SELECT COUNT(*)::int AS n FROM app_agent_codes')).n, 0);
  });

  await t.test('the token opens the declared path as its member, and nothing else', async () => {
    const got = await connect(ana);
    assert.match(got.access_token, /^hrao_[A-Za-z0-9_-]{43}$/);
    assert.match(got.refresh_token, /^hrar_[A-Za-z0-9_-]{43}$/);
    assert.equal(got.expires_in, 3600);
    assert.equal(got.token_type, 'Bearer');
    // Only digests are kept.
    const stored = (await pool.query('SELECT token_hash FROM app_agent_tokens')).rows.map((r) => r.token_hash);
    assert.ok(stored.includes(crypto.createHash('sha256').update(got.access_token).digest('hex')));
    assert.ok(!JSON.stringify(stored).includes(got.access_token.slice(5)));

    const through = await gate({ bearer: got.access_token });
    assert.equal(through.status, 200);
    const claims = platformJwt.verifyAppIdentityToken(through.headers['x-usernode-identity'], { appId: team });
    assert.equal(claims.id, ana);
    assert.equal(claims.scope, 'access_token');
    assert.equal((await gate({ bearer: got.access_token, uri: '/mcp/messages' })).status, 200);

    assert.equal((await gate({ bearer: got.access_token, uri: '/api/people' })).status, 401);
    assert.equal((await gate({ bearer: got.access_token, host: `other.${DOMAIN}` })).status, 401);
    assert.equal((await gate({ bearer: got.access_token, host: `team--s4.${DOMAIN}` })).status, 401);
    assert.equal((await gate({ bearer: got.refresh_token })).status, 401, 'a refresh token opens nothing');
    assert.equal((await gate({ bearer: 'hrao_' + 'A'.repeat(43) })).status, 401);
    // It is not a connector token: Homeroom's own /mcp does not know it.
    assert.deepEqual(await authenticateConnector(pool, got.access_token), { error: 'invalid_token' });
    const audit = await one("SELECT event_type, metadata FROM mcp_auth_audit_events WHERE event_type = 'token_issued' ORDER BY id DESC LIMIT 1");
    assert.equal(audit.metadata.surface, 'app_agent');
    assert.equal(audit.metadata.app_id, team);
  });

  await t.test('a code works once, for the client, address and secret it was made for', async () => {
    const trade = (code, verifier, extra = {}) => tokenCall({
      grant_type: 'authorization_code', client_id: client.client_id, code, redirect_uri: REDIRECT, code_verifier: verifier, ...extra,
    });
    const fresh = async () => {
      const p = pkce();
      const approved = await decide(ben, ask(p.challenge));
      return { code: new URL(approved.json.redirect_to).searchParams.get('code'), ...p };
    };
    let c = await fresh();
    assert.equal((await trade(c.code, pkce().verifier)).status, 400, 'another secret');
    assert.equal((await trade(c.code, c.verifier)).status, 400, 'and the code is spent by the try');
    c = await fresh();
    assert.equal((await trade(c.code, c.verifier, { redirect_uri: 'https://claude.ai/elsewhere' })).status, 400);
    c = await fresh();
    assert.equal((await trade(c.code, c.verifier, { resource: `https://other.${DOMAIN}/mcp` })).json.error, 'invalid_target');
    c = await fresh();
    const elsewhere = await mcpOauth.registerClient(pool, { clientName: 'Other', redirectUris: [REDIRECT] });
    assert.equal((await trade(c.code, c.verifier, { client_id: elsewhere.client_id })).status, 400);

    // A second use of a good code ends what the first made.
    c = await fresh();
    const first = await trade(c.code, c.verifier);
    assert.equal(first.status, 200);
    assert.equal((await gate({ bearer: first.json.access_token })).status, 200);
    assert.equal((await trade(c.code, c.verifier)).status, 400);
    assert.equal((await gate({ bearer: first.json.access_token })).status, 401);
    // An expired code is refused.
    c = await fresh();
    await pool.query("UPDATE app_agent_codes SET created_at = created_at - interval '5 minutes', expires_at = expires_at - interval '5 minutes' WHERE consumed_at IS NULL");
    assert.equal((await trade(c.code, c.verifier)).status, 400);
  });

  await t.test('a refresh rotates, and a spent refresh token ends the approval', async () => {
    const got = await connect(ben);
    const renew = (token, clientId = client.client_id) => tokenCall({ grant_type: 'refresh_token', client_id: clientId, refresh_token: token });
    const second = await renew(got.refresh_token);
    assert.equal(second.status, 200);
    assert.notEqual(second.json.access_token, got.access_token);
    assert.equal((await gate({ bearer: got.access_token })).status, 401, 'the old access token went with the rotation');
    assert.equal((await gate({ bearer: second.json.access_token })).status, 200);
    // The first refresh token again: somebody else holds a copy.
    assert.equal((await renew(got.refresh_token)).status, 400);
    assert.equal((await gate({ bearer: second.json.access_token })).status, 401);
    assert.equal((await renew(second.json.refresh_token)).status, 400);

    // An expired access token is refused at the door; its refresh still works.
    const again = await connect(ben);
    await pool.query(
      "UPDATE app_agent_tokens SET created_at = created_at - interval '2 hours', expires_at = expires_at - interval '2 hours' WHERE kind = 'access' AND token_hash = $1",
      [crypto.createHash('sha256').update(again.access_token).digest('hex')]);
    assert.equal((await gate({ bearer: again.access_token })).status, 401);
    assert.equal((await renew(again.refresh_token)).status, 200);
  });

  await t.test('the app lists its member\'s assistants and disconnects one', async () => {
    await pool.query('UPDATE app_agent_grants SET revoked_at = NOW() WHERE revoked_at IS NULL');
    const got = await connect(ana);
    const identity = (id) => platformJwt.signAppIdentityToken({ appId: team, user: { id, username: 'u' + id } });
    const api = (method, pathname, userId) => request(method, `/api/app-platform/v1${pathname}`,
      { 'x-usernode-app-token': APP_TOKEN, 'x-usernode-user-token': identity(userId) });
    const listed = await api('GET', '/access-tokens', ana);
    assert.equal(listed.status, 200);
    assert.equal(listed.json.connections.length, 1);
    const row = listed.json.connections[0];
    assert.equal(row.name, 'Claude');
    assert.equal(row.origin, 'https://claude.ai');
    assert.ok(!JSON.stringify(listed.json).includes('hrao_'));
    assert.deepEqual((await api('GET', '/access-tokens', ben)).json.connections, [], 'each member sees their own');
    assert.equal((await api('DELETE', `/access-tokens/connections/${row.id}`, ben)).status, 404, 'and ends only their own');
    assert.equal((await gate({ bearer: got.access_token })).status, 200);
    assert.equal((await api('DELETE', `/access-tokens/connections/${row.id}`, ana)).status, 200);
    assert.equal((await gate({ bearer: got.access_token })).status, 401);
    assert.equal((await tokenCall({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: got.refresh_token })).status, 400);
  });

  await t.test('the client can ask for its token to be forgotten', async () => {
    const got = await connect(ana);
    const gone = await request('POST', '/api/connect/oauth/revoke',
      { 'content-type': 'application/x-www-form-urlencoded' }, new URLSearchParams({ token: got.refresh_token }).toString());
    assert.equal(gone.status, 200);
    assert.equal((await gate({ bearer: got.access_token })).status, 401);
  });

  await t.test('a member holds at most ten; the one used longest ago goes', async () => {
    await pool.query('UPDATE app_agent_grants SET revoked_at = NOW() WHERE revoked_at IS NULL');
    const first = await connect(ana);
    await pool.query("UPDATE app_agent_grants SET created_at = created_at - interval '1 day' WHERE revoked_at IS NULL");
    for (let i = 0; i < appAgent.MAX_PER_MEMBER; i++) await connect(ana);
    assert.equal((await appAgent.list(pool, { appId: team, userId: ana })).length, appAgent.MAX_PER_MEMBER);
    assert.equal((await gate({ bearer: first.access_token })).status, 401);
  });

  await t.test('leaving the project ends it, at the door and at the token endpoint', async () => {
    const atDoor = await connect(ben);
    const atRefresh = await connect(ben);
    await leave(team, ben);
    assert.equal((await gate({ bearer: atDoor.access_token })).status, 401);
    assert.equal((await appAgent.list(pool, { appId: team, userId: ben })).length, 0, 'every approval of theirs is ended');
    assert.equal((await tokenCall({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: atRefresh.refresh_token })).status, 400);
    // Let back in: the old approval does not come back, and a new one works.
    await join(team, ben);
    appAccess.invalidateAllVisibility();
    edgeGate._resetCachesForTest();
    assert.equal((await gate({ bearer: atDoor.access_token })).status, 401);
    assert.equal((await gate({ bearer: (await connect(ben)).access_token })).status, 200);

    // One who left between approving and the door, with nothing revoked yet.
    const stale = await connect(ben);
    await leave(team, ben);
    await pool.query('UPDATE app_agent_grants SET revoked_at = NULL; UPDATE app_agent_tokens SET revoked_at = NULL');
    await join(team, ben);
    await pool.query(
      "UPDATE community_members SET joined_at = NOW() + interval '1 minute' WHERE user_id = $1 AND community_id = (SELECT community_id FROM apps WHERE id = $2)",
      [ben, team]);
    appAccess.invalidateAllVisibility();
    edgeGate._resetCachesForTest();
    assert.equal((await gate({ bearer: stale.access_token })).status, 401, 'an approval from before they came back does not count');
  });
});
