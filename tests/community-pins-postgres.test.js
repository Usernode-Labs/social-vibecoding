'use strict';

// The communities a person pins to the desktop sidebar are the account's
// (src/services/community-pins.js, schema.sql "Pinned communities"): a
// member's only, four at most, in pin order, gone when they leave, and the
// pins a device kept before are taken in once, quietly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, Pool } = require('pg');
const express = require('express');
const communities = require('../src/services/communities');
const { communityPinRoutes } = require('../src/routes/community-pins');

test('community pins: a member\'s, four at most, in order, dropped on leaving, imported quietly (PostgreSQL)', async (t) => {
  const dsn = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const root = new Client({ connectionString: dsn, connectionTimeoutMillis: 2000 });
  try { await root.connect(); } catch (err) { await root.end().catch(() => {}); return t.skip(`Local test database unavailable: ${err.code}`); }
  const name = `community_pins_test_${process.pid}`;
  let pool;
  let server;
  try {
    await root.query(`CREATE DATABASE ${name}`);
    const url = new URL(dsn); url.pathname = `/${name}`;
    pool = new Pool({ connectionString: url.toString() });
    await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
    const addUser = async (username) => (await pool.query(
      "INSERT INTO users (username, password) VALUES ($1, 'unused') RETURNING id, username", [username])).rows[0];
    const alice = await addUser('alice');
    const bob = await addUser('bob');
    const carol = await addUser('carol');
    const addApp = async (slug, visibility = 'public') => (await pool.query(
      `INSERT INTO apps (slug, name, created_by, view_visibility, collab_visibility, icon_emoji)
       VALUES ($1, $1, $2, $3, $3, '🎲') RETURNING *`, [slug, bob.id, visibility])).rows[0];
    const apps = {};
    for (const slug of ['chess', 'gym', 'run', 'dice', 'fifth', 'stranger']) apps[slug] = await addApp(slug);
    apps.secret = await addApp('secret', 'private');
    for (const slug of ['chess', 'gym', 'run', 'dice', 'fifth']) await communities.join(pool, apps[slug], alice.id);
    for (const slug of ['chess', 'gym']) await communities.join(pool, apps[slug], carol.id);

    const web = express();
    web.use(express.json());
    web.use((req, res, next) => { req.user = { alice, bob, carol }[req.get('x-test-user')]; next(); });
    web.use(communityPinRoutes({}, { pool }));
    server = web.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const call = async (method, url, user = 'alice', body) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
        method, headers: { 'x-test-user': user, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: await res.json() };
    };
    const slugs = (r) => r.body.pins.map((p) => p.slug);

    assert.equal((await call('GET', '/api/me/community-pins', '')).status, 401, 'signed out');
    assert.deepEqual(slugs(await call('GET', '/api/me/community-pins')), [], 'none to begin with');

    let r = await call('PUT', '/api/me/community-pins/chess');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.pins, [{ slug: 'chess', name: 'chess', iconUrl: null, iconEmoji: '🎲' }], 'the face the sidebar draws');
    assert.deepEqual(slugs(await call('PUT', '/api/me/community-pins/chess')), ['chess'], 'pinning again changes nothing');

    // Only a member's: one you cannot see is not found, one you are not in asks you to join.
    assert.equal((await call('PUT', '/api/me/community-pins/secret')).status, 404);
    r = await call('PUT', '/api/me/community-pins/stranger');
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'join_required');
    assert.deepEqual(r.body.app, { slug: 'stranger', name: 'stranger' });

    // Four at most, in the order pinned.
    for (const slug of ['gym', 'run', 'dice']) assert.equal((await call('PUT', `/api/me/community-pins/${slug}`)).status, 200);
    r = await call('PUT', '/api/me/community-pins/fifth');
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'pins_full');
    assert.deepEqual(slugs(await call('GET', '/api/me/community-pins')), ['chess', 'gym', 'run', 'dice']);

    // Unpinning makes room; a new pin goes at the end.
    assert.deepEqual(slugs(await call('DELETE', '/api/me/community-pins/gym')), ['chess', 'run', 'dice']);
    assert.deepEqual(slugs(await call('PUT', '/api/me/community-pins/fifth')), ['chess', 'run', 'dice', 'fifth']);
    assert.deepEqual(slugs(await call('DELETE', '/api/me/community-pins/nothing-here')), ['chess', 'run', 'dice', 'fifth'],
      'unpinning what is not pinned is no error');

    // Leaving a community takes its pin with it.
    assert.deepEqual(await communities.leave(pool, apps.run, alice.id), { ok: true });
    assert.deepEqual(slugs(await call('GET', '/api/me/community-pins')), ['chess', 'dice', 'fifth']);

    // Each person's own: Bob sees none of Alice's.
    assert.deepEqual(slugs(await call('GET', '/api/me/community-pins', 'bob')), []);

    // A device's old pins, taken in once: the ones Carol may pin, in order,
    // the rest skipped without a refusal.
    r = await call('POST', '/api/me/community-pins/import', 'carol', { slugs: ['gym', 'stranger', 'secret', 'chess', 'gym', 'dice'] });
    assert.equal(r.status, 200);
    assert.deepEqual(slugs(r), ['gym', 'chess']);
    assert.deepEqual(slugs(await call('POST', '/api/me/community-pins/import', 'carol', { slugs: 'junk' })), ['gym', 'chess']);

    // The database holds the rule too: no pin without the membership.
    const stranger = (await pool.query('SELECT community_id FROM apps WHERE slug = $1', ['stranger'])).rows[0].community_id;
    await assert.rejects(pool.query(
      'INSERT INTO community_pins (community_id, user_id) VALUES ($1, $2)', [stranger, alice.id]),
    /foreign key/);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await root.end();
  }
});
