'use strict';

// #5823: `loadContributedAppIds` against the FULL PostgreSQL schema.
//
// Home's All / Contributing switch shows the apps the viewer helps build, and
// the definition has to agree exactly with the Contributors list: apps you
// made, apps where you were accepted as a builder, apps where your change was
// voted in (a merged chat_session). That union and its user join live in SQL,
// so the contract is pinned here, through the real planner, rather than by
// matching the query's text:
//
//   * a creator, an accepted collaborator and a merged author each count;
//   * an unmerged session, an invited (not accepted) collaborator and a
//     plain member are not contributors;
//   * the answer is scoped to the app ids asked about AND to the one viewer;
//   * an empty list or a signed-out viewer never reaches the database.
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');

const { loadContributedAppIds } = require('../src/services/contributors');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('contributing apps against the full schema', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `contributing_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const user = async (username) => (await pool.query(
    `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`,
    [username]
  )).rows[0].id;
  const maker = await user('contrib-making');
  const builder = await user('contrib-building');
  const shipper = await user('contrib-shipping');
  const inviter = await user('contrib-invited-only');
  const visitor = await user('contrib-visiting');

  const app = async (slug, createdBy) => (await pool.query(
    `INSERT INTO apps (name, slug, status, created_by) VALUES ($1, $2, 'running', $3) RETURNING id`,
    [slug, slug, createdBy]
  )).rows[0].id;

  // Made by `maker`; `builder` is an accepted collaborator; `shipper` had a
  // change merged; `inviter` was only invited; `visitor` ran a session that
  // never merged. A second app, made by the visitor, is not in the first
  // app's answer.
  const made = await app('contrib-made', maker);
  const visited = await app('contrib-visited', visitor);

  await pool.query(
    `INSERT INTO app_collaborators (app_id, user_id, status) VALUES
       ($1, $2, 'member'),
       ($1, $3, 'invited')`,
    [made, builder, inviter]
  );
  await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status) VALUES
       ($1, $2, 'merged'),
       ($1, $3, 'active')`,
    [made, shipper, visitor]
  );

  const ask = (userId) => loadContributedAppIds(pool, [made, visited], userId);
  const ids = async (userId) => [...(await ask(userId))].sort((a, b) => a - b);

  assert.deepEqual(await ids(maker), [made], 'the creator contributes');
  assert.deepEqual(await ids(builder), [made], 'an accepted collaborator contributes');
  assert.deepEqual(await ids(shipper), [made], 'a merged author contributes');
  assert.deepEqual(await ids(inviter), [], 'an invite that was never accepted does not');
  assert.deepEqual(await ids(visitor), [visited], 'an unmerged session does not, and the scope is per app');

  // The real pg path returns int ids, not the bigint strings some drivers use.
  const set = await ask(maker);
  assert.ok(set instanceof Set);
  assert.equal(typeof [...set][0], 'number');

  // Nothing to ask, nothing sent — a pool that throws proves no query runs.
  const refusing = { query: () => { throw new Error('no query expected'); } };
  assert.equal((await loadContributedAppIds(refusing, [], maker)).size, 0);
  assert.equal((await loadContributedAppIds(refusing, [made], null)).size, 0);
});
