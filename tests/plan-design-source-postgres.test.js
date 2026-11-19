'use strict';

// Artifacts, stages 0 and 1 (docs/plans/artifacts.md), against the FULL
// PostgreSQL schema in a throwaway database: the two migrations this work
// adds, run again over rows written the way a build from before writes
// them, and the boot backfill that names the design of a plan an older build
// posted during a rollout.
//
//   1. plan-design-source: a plan posted before it names its design once
//      the migration runs (the same words the code read), and a second run
//      changes nothing. A plan that is no design's, or whose author has no
//      design thread on its request, is left empty.
//   2. The boot backfill (services/plan-design-source.js): a plan an older
//      build posted after the migration is filled at the next boot, from a
//      design thread only (never a page's), within its window, at most its
//      limit, and a second boot changes nothing.
//   3. artifact-store: a design row as the build from before inserts it
//      (naming none of the new columns) is a design that lives in its
//      thread; the migration runs again harmlessly; a kind it does not know
//      is refused; and the store reads and writes a page through the real
//      tables.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/plan-design-source-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const MIGRATIONS = path.join(__dirname, '..', 'src', 'db', 'migrations');

// A plan made from a design, as planHtml words its after side.
const planWords = (version) => `<article data-spec><h1>Design: Watering</h1><p>The after is version ${version} of the design.</p></article>`;

test('a plan names the design it came from: the migration, the boot backfill, the artifact store', { timeout: 180000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `plan_design_source_${crypto.randomBytes(6).toString('hex')}`;
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
  require('../src/db/pool').getPool = () => pool;
  const wsBus = require('../src/services/ws-bus');
  wsBus.publish = () => {};
  wsBus.publishBatched = () => {};
  const dm = require('../src/services/homeroom-bot-dm');
  const store = require('../src/services/artifacts');
  const source = require('../src/services/plan-design-source');

  async function user(username, { synthetic = false } = {}) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO users (username, password, is_synthetic, has_platform_access) VALUES ($1, 'x', $2, TRUE) RETURNING id, username`,
      [username, synthetic],
    );
    return { id: Number(row.id), username: row.username };
  }
  const bot = await user('homeroom_bot', { synthetic: true });
  const ada = await user('pds_ada');
  const sam = await user('pds_sam');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Plant pal', 'pds-plant-pal', 'running', $1, 'public', 'public') RETURNING id`,
    [ada.id],
  );

  // A private thread of `who` that filed or posted on request `number`,
  // holding an artifact of `kind` (null: none). Inserted as the build from
  // before inserts a design: naming none of the new columns.
  async function thread(who, { number, kind = 'design', state = 'filed', ago = '0 days' } = {}) {
    const line = await dm.sendDm(pool, { bot, userId: who.id, content: 'A thread.', moment: null, thread: { kind: 'idea' } });
    const { rows: [row] } = await pool.query('SELECT id FROM private_threads WHERE root_message_id = $1', [line.messageId]);
    await pool.query(
      `UPDATE private_threads SET app_id = $2, state = $3, result_ref = $4, updated_at = NOW() - $5::interval WHERE id = $1`,
      [row.id, app.id, state, number, ago],
    );
    if (kind) {
      await pool.query(
        `INSERT INTO design_threads (private_thread_id, title, surface, width, height) VALUES ($1, 'Watering', 'app', 390, 844)`,
        [row.id],
      );
      if (kind !== 'design') await pool.query('UPDATE design_threads SET kind = $2 WHERE private_thread_id = $1', [row.id, kind]);
    }
    return { threadId: Number(row.id), rootId: Number(line.messageId) };
  }
  // A plan's version on request `number` by `who`, as postRequestSpec writes
  // it (one record per author per request), with no design named: as the
  // build from before writes every plan.
  async function plan(who, { number, html, ago = '0 days' }) {
    let { rows: [session] } = await pool.query(
      `SELECT id FROM chat_sessions WHERE app_id = $1 AND user_id = $2 AND source = 'request_spec' AND created_from_issue_number = $3`,
      [app.id, who.id, number],
    );
    if (!session) {
      ({ rows: [session] } = await pool.query(
        `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, source, created_from_issue_number, linked_issues, issue_link_seeded, session_title, is_headless)
         VALUES ($1, $2, NULL, 'paused', 'request_spec', $3, ARRAY[$3::int], TRUE, 'Plan', FALSE) RETURNING id`,
        [app.id, who.id, number],
      ));
    }
    const { rows: [row] } = await pool.query(
      `INSERT INTO chat_session_specs (session_id, version, content, content_html, shared_to_group_at, created_at)
       VALUES ($1, COALESCE((SELECT MAX(version) FROM chat_session_specs WHERE session_id = $1), 0) + 1, 'plan', $2, NOW(), NOW() - $3::interval)
       RETURNING id`,
      [session.id, html, ago],
    );
    return Number(row.id);
  }
  const named = async (id) => {
    const { rows: [row] } = await pool.query('SELECT design_thread_id, design_version FROM chat_session_specs WHERE id = $1', [id]);
    return [row.design_thread_id == null ? null : Number(row.design_thread_id), row.design_version];
  };
  const migration = (id) => fs.readFileSync(path.join(MIGRATIONS, `${id}.sql`), 'utf8');

  await t.test('plan-design-source: plans from before name their design once it runs, and a second run changes nothing', async () => {
    const watered = await thread(ada, { number: 12 });
    const fromDesign = await plan(ada, { number: 12, html: planWords(3) });
    const mockup = await plan(ada, { number: 12, html: '<article data-spec><p>Its after is version 2, a mockup.</p></article>' });
    const words = await plan(ada, { number: 12, html: '<article data-spec><h1>Water reminders</h1><p>A plan in words.</p></article>' });
    const noThread = await plan(sam, { number: 12, html: planWords(5) });
    await pool.query(migration('plan-design-source'));
    assert.deepEqual(await named(fromDesign), [watered.threadId, 3]);
    assert.deepEqual(await named(mockup), [watered.threadId, 2]);
    assert.deepEqual(await named(words), [null, null], 'a plan that is no design\'s is left empty');
    assert.deepEqual(await named(noThread), [null, null], 'its author has no design thread on the request');
    // Again: the columns are there, and every filled row stays as it was.
    await pool.query('UPDATE chat_session_specs SET design_version = 9 WHERE id = $1', [fromDesign]);
    await pool.query(migration('plan-design-source'));
    assert.deepEqual(await named(fromDesign), [watered.threadId, 9], 'a row already named is never written again');
    assert.deepEqual(await named(words), [null, null]);
    // The plan's readers see it (request-specs.js personPlanOf).
    const read = await require('../src/services/request-specs').personPlanOf(pool, { appId: app.id, issueNumber: 12 });
    assert.ok(read, 'the newest plan on the request');
  });

  await t.test('the boot backfill names the design of a plan an older build posted in a rollout, a design\'s only, bounded', async () => {
    // After the migration: an older build posts two plans, one from a design
    // and one from a thread that holds a page on the same request.
    const design = await thread(sam, { number: 14 });
    const posted = await plan(sam, { number: 14, html: planWords(4) });
    const page = await thread(ada, { number: 15, kind: 'page', state: 'posted' });
    const fromPage = await plan(ada, { number: 15, html: planWords(1) });
    // And one so old that no boot reads it again.
    await thread(sam, { number: 16, ago: '20 days' });
    const old = await plan(sam, { number: 16, html: planWords(2), ago: '20 days' });
    assert.deepEqual(await named(posted), [null, null]);

    assert.equal(await source.backfill(pool), 1);
    assert.deepEqual(await named(posted), [design.threadId, 4]);
    assert.deepEqual(await named(fromPage), [null, null], 'a page\'s thread is never a plan\'s design');
    assert.ok(page.threadId > 0);
    assert.deepEqual(await named(old), [null, null], 'outside the window');
    assert.equal(await source.backfill(pool), 0, 'a second boot changes nothing');
    assert.equal(await source.backfill(pool, { days: 30 }), 1, 'a wider window reaches it');
    assert.deepEqual((await named(old))[1], 2);

    // At most `limit` a boot, the rest at the next.
    const many = [];
    for (const n of [21, 22, 23]) {
      await thread(ada, { number: n });
      many.push(await plan(ada, { number: n, html: planWords(n) }));
    }
    assert.equal(await source.backfill(pool, { limit: 2 }), 2);
    assert.equal(await source.backfill(pool, { limit: 2 }), 1);
    for (const [i, id] of many.entries()) assert.equal((await named(id))[1], 21 + i);
    // It never fails a boot: a broken query is logged and answered with 0.
    assert.equal(await source.backfill({ async query() { throw new Error('gone'); } }), 0);
  });

  await t.test('artifact-store: a row the build from before writes is a design in its thread, and the store holds a page', async () => {
    const held = await thread(ada, { number: 30 });
    const { rows: [row] } = await pool.query(
      'SELECT kind, viewport, place FROM design_threads WHERE private_thread_id = $1', [held.threadId]);
    assert.deepEqual(row, { kind: 'design', viewport: null, place: 'thread' });
    // Run again: nothing is added twice, nothing dropped.
    await pool.query(migration('artifact-store'));
    await pool.query(migration('artifact-store'));
    await assert.rejects(pool.query('UPDATE design_threads SET kind = $2 WHERE private_thread_id = $1', [held.threadId, 'plan']), /check constraint/);
    await assert.rejects(pool.query('UPDATE design_threads SET place = $2 WHERE private_thread_id = $1', [held.threadId, 'project']), /check constraint/,
      'an artifact lives in its author\'s thread: there is no other place');
    const read = await store.artifactFor(pool, { userId: ada.id, rootId: held.rootId });
    assert.deepEqual([read.artifactKind, read.viewport, read.place], ['design', 'phone', 'thread'], 'its size read off its width, as before');

    // A page, written and read through the real tables.
    const line = await dm.sendDm(pool, { bot, userId: sam.id, content: 'Lay the budget out as a page.', moment: null, thread: { kind: 'idea' } });
    const room = { rootId: Number(line.messageId), conversationId: Number(line.conversationId) };
    const made = await store.ensureArtifact(pool, { user: sam, thread: room, kind: 'page', title: 'Trip budget', viewport: 'desktop', surface: 'new' });
    assert.deepEqual([made.artifactKind, made.viewport, made.width, made.surface, made.app], ['page', 'desktop', 1280, 'new', null]);
    const v1 = await store.addVersion(pool, { threadId: made.threadId, html: '<h1>Trip budget</h1>', author: 'bot', note: 'Flights and hotel' });
    assert.deepEqual(v1, { version: 1 });
    // Asked again as a design, it keeps its kind: a thread holds one artifact.
    const again = await store.ensureArtifact(pool, { user: sam, thread: room, kind: 'design', title: 'x', viewport: 'phone' });
    assert.equal(again.artifactKind, 'page');
    // Its author's alone.
    assert.equal(await store.artifactFor(pool, { userId: ada.id, rootId: room.rootId }), null);
    assert.equal((await store.versionOf(pool, { userId: sam.id, rootId: room.rootId })).html, '<h1>Trip budget</h1>');
    assert.equal(await store.versionOf(pool, { userId: ada.id, rootId: room.rootId }), null);
    // Never posted as a plan, never a project's New project.
    const designs = require('../src/services/design-threads');
    assert.deepEqual(await designs.proposeDesign(pool, {}, { user: sam, rootId: room.rootId }), { ok: false, status: 409, error: 'not_a_design' });
    const where = await require('../src/services/private-threads').stateOf(pool, { user: sam, rootId: room.rootId, bot });
    assert.equal(where.design, undefined);
  });
});
