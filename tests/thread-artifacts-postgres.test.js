'use strict';
// test:changed: when src/db/migrations/thread-artifacts.sql (its rolling-release contract)
//
// 20 Nov 2026 (live-draft review, K): a thread can hold several artifacts
// (docs/plans/artifacts.md, "Several artifacts in a thread"). Migration
// thread-artifacts only adds, against the real migration history in a
// throwaway PostgreSQL database:
//
//   1. A database from before it, with a design thread, its versions and a
//      plan made from it, takes the migration (twice: the second changes
//      nothing), and the thread opens its artifact at the same versions; the
//      plan still shows that design.
//   2. The new store then gives the same thread a second and a third artifact
//      (a design and two pages), each with its own versions from 1.
//   3. A build from before, running beside it during a release, still reads
//      the thread's first artifact exactly as it did (its own statements, as
//      the build at c64daa3b wrote them) and sees nothing of the later ones;
//      its writes to the first artifact take the numbers the new store takes.
//   4. A plan of a later artifact names it; a deleted thread takes its later
//      artifacts with it.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/thread-artifacts-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// The statements of the build from before (src/services/artifacts.js at
// c64daa3b), word for word: what an older build or an open proposal's
// preview runs against this database during a release.
const OLD = Object.freeze({
  read: `SELECT p.id, p.root_message_id, p.conversation_id, p.state, p.result_ref, p.kind,
            p.about_kind, p.about_number,
            a.slug, a.name, d.title, d.surface, d.route, d.width, d.height,
            d.kind AS artifact_kind, d.viewport, d.place
       FROM private_threads p
       JOIN design_threads d ON d.private_thread_id = p.id
       LEFT JOIN apps a ON a.id = p.app_id
      WHERE p.root_message_id = $1 AND p.user_id = $2`,
  versions: `SELECT version, author, note, message_id, created_at FROM design_versions
      WHERE private_thread_id = $1 ORDER BY version`,
  upsert: `INSERT INTO design_threads (private_thread_id, title, surface, route, width, height, kind, viewport)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (private_thread_id) DO UPDATE
       SET width = EXCLUDED.width, height = EXCLUDED.height,
           viewport = EXCLUDED.viewport,
           surface = EXCLUDED.surface,
           route = COALESCE(EXCLUDED.route, design_threads.route)`,
  lock: 'SELECT id FROM private_threads WHERE id = $1 FOR UPDATE',
  last: 'SELECT COALESCE(MAX(version), 0) AS n FROM design_versions WHERE private_thread_id = $1',
  insert: `INSERT INTO design_versions (private_thread_id, version, html, author, note, message_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
});

test('thread-artifacts: old threads keep their artifact, new ones hold several, and a build from before reads its first', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `thread_artifacts_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });

  // The real history without this migration, as a database from before has
  // it (a migration recorded after it, which needs nothing of it, included,
  // so today's code runs on it).
  const { loadPlan, renderSchema } = require('../src/db/schema-source');
  const history = loadPlan();
  const at = history.findIndex((m) => m.id === 'thread-artifacts');
  assert.ok(at > 0, 'the migration is recorded');
  await pool.query(renderSchema(history.filter((m) => m.id !== 'thread-artifacts')));

  require('../src/db/pool').getPool = () => pool;
  const wsBus = require('../src/services/ws-bus');
  wsBus.publish = () => {};
  wsBus.publishBatched = () => {};
  const dm = require('../src/services/homeroom-bot-dm');
  const store = require('../src/services/artifacts');
  const designs = require('../src/services/design-threads');
  const specs = require('../src/services/request-specs');

  async function user(username, { synthetic = false } = {}) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO users (username, password, is_synthetic, has_platform_access) VALUES ($1, 'x', $2, TRUE) RETURNING id, username`,
      [username, synthetic],
    );
    return { id: Number(row.id), username: row.username };
  }
  const bot = await user('homeroom_bot', { synthetic: true });
  const ada = await user('ta_ada');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Gym tracker', 'ta-gym', 'running', $1, 'public', 'public') RETURNING id`,
    [ada.id],
  );

  // A design thread as the build from before leaves it: its row, two
  // versions, filed as request 31 with a plan that shows version 2.
  const line = await dm.sendDm(pool, { bot, userId: ada.id, content: 'A thread.', moment: null, thread: { kind: 'idea' } });
  const rootId = Number(line.messageId);
  const { rows: [thread] } = await pool.query('SELECT id FROM private_threads WHERE root_message_id = $1', [rootId]);
  const threadId = Number(thread.id);
  await pool.query('UPDATE private_threads SET app_id = $2, state = \'filed\', result_ref = 31 WHERE id = $1', [threadId, app.id]);
  await pool.query(OLD.upsert, [threadId, 'Style directions', 'app', null, 390, 844, 'design', 'phone']);
  for (const [version, html] of [[1, '<main>One</main>'], [2, '<main>Two</main>']]) {
    await pool.query(OLD.insert, [threadId, version, html, 'bot', `v${version}`, null]);
  }
  const { rows: [session] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, source, created_from_issue_number, linked_issues, issue_link_seeded, session_title, is_headless)
     VALUES ($1, $2, NULL, 'paused', 'request_spec', 31, ARRAY[31], TRUE, 'Plan', FALSE) RETURNING id`,
    [app.id, ada.id],
  );
  await pool.query(
    `INSERT INTO chat_session_specs (session_id, version, content, content_html, shared_to_group_at, design_thread_id, design_version)
     VALUES ($1, 1, 'plan', '<article data-spec></article>', NOW(), $2, 2)`,
    [session.id, threadId],
  );

  await t.test('1. the migration runs twice on that database and changes nothing an older build reads', async () => {
    const before = (await pool.query(OLD.versions, [threadId])).rows.map((v) => [v.version, v.note]);
    await pool.query(history[at].sql);
    await pool.query(history[at].sql);
    const { rows: tables } = await pool.query(
      `SELECT c.relname, obj_description(c.oid, 'pg_class') AS note FROM pg_class c
        WHERE c.relname IN ('thread_artifacts', 'thread_artifact_versions') ORDER BY c.relname`,
    );
    assert.deepEqual(tables.map((r) => [r.relname, r.note]), [
      ['thread_artifact_versions', 'staging:private'], ['thread_artifacts', 'staging:private'],
    ], 'both new tables are private on a staging copy');
    const { rows: columns } = await pool.query(
      `SELECT table_name, is_nullable, column_default FROM information_schema.columns
        WHERE column_name = 'design_artifact_id' ORDER BY table_name`,
    );
    assert.deepEqual(columns.map((c) => [c.table_name, c.is_nullable, c.column_default]), [
      ['chat_session_specs', 'YES', null], ['homeroom_bot_first_versions', 'YES', null],
    ]);
    // The old tables' own keys are untouched: one row per thread, one number per version.
    const { rows: keys } = await pool.query(
      `SELECT conrelid::regclass::text AS t, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid IN ('design_threads'::regclass, 'design_versions'::regclass) AND contype IN ('p', 'u') ORDER BY 1, 2`,
    );
    assert.deepEqual(keys.map((k) => [k.t, k.def]), [
      ['design_threads', 'PRIMARY KEY (private_thread_id)'],
      ['design_versions', 'PRIMARY KEY (id)'],
      ['design_versions', 'UNIQUE (private_thread_id, version)'],
    ]);
    assert.deepEqual((await pool.query(OLD.versions, [threadId])).rows.map((v) => [v.version, v.note]), before);
    // The new store opens the old thread's artifact at the same versions,
    // and the plan from before still shows that design.
    const held = await store.artifactFor(pool, { userId: ada.id, rootId });
    assert.deepEqual([held.artifactId, held.artifactKind, held.title, held.latest], [1, 'design', 'Style directions', 2]);
    assert.deepEqual(held.versions.map((v) => v.version), [1, 2]);
    assert.equal(held.artifacts.length, 1);
    assert.deepEqual(await designs.threadForRequest(pool, { userId: ada.id, appId: app.id, number: 31 }), { rootId, designVersion: 2 });
  });

  await t.test('2. the same thread holds a design and two pages, each with its own versions from 1', async () => {
    const room = { rootId, conversationId: Number(line.conversationId), app: null };
    const layouts = await store.addArtifact(pool, { user: ada, thread: room, kind: 'page', title: 'iOS list layouts' });
    const budget = await store.addArtifact(pool, { user: ada, thread: room, kind: 'page', title: 'Budget' });
    assert.deepEqual([layouts.artifact.artifactId, budget.artifact.artifactId], [2, 3]);
    assert.deepEqual(await store.addVersion(pool, { threadId, artifactId: 2, html: '<ul><li>Rows</li></ul>' }), { version: 1 });
    assert.deepEqual(await store.addVersion(pool, { threadId, artifactId: 2, html: '<ul><li>Cards</li></ul>' }), { version: 2 });
    assert.deepEqual(await store.addVersion(pool, { threadId, artifactId: 3, html: '<table></table>' }), { version: 1 });
    const read = await store.artifactFor(pool, { userId: ada.id, rootId, artifactId: 2 });
    assert.deepEqual(read.artifacts.map((a) => [a.artifactId, a.artifactKind, a.title, a.latest]), [
      [1, 'design', 'Style directions', 2], [2, 'page', 'iOS list layouts', 2], [3, 'page', 'Budget', 1],
    ]);
    assert.equal((await store.versionOf(pool, { userId: ada.id, rootId, artifactId: 2, version: 1 })).html, '<ul><li>Rows</li></ul>');
    assert.equal((await store.versionOf(pool, { userId: ada.id, rootId })).html, '<main>Two</main>', 'none named: the first');
    // Two numbers are never taken twice: the table refuses it outright.
    await assert.rejects(pool.query(
      'INSERT INTO thread_artifacts (private_thread_id, number, title, surface, width, height) VALUES ($1, 2, \'x\', \'new\', 390, 844)', [threadId]));
    await assert.rejects(pool.query(
      'INSERT INTO thread_artifacts (private_thread_id, number, title, surface, width, height) VALUES ($1, 1, \'x\', \'new\', 390, 844)', [threadId]),
    /check/i, 'number 1 is design_threads\' row');
  });

  await t.test('3. a build from before reads the first artifact as it did, and its writes take the numbers the new store takes', async () => {
    const { rows: [old] } = await pool.query(OLD.read, [rootId, ada.id]);
    assert.deepEqual([old.title, old.artifact_kind], ['Style directions', 'design']);
    assert.deepEqual((await pool.query(OLD.versions, [threadId])).rows.map((v) => v.version), [1, 2], 'nothing of the later ones');
    // Its version, under its own lock: version 3 of the first.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(OLD.lock, [threadId]);
      const { rows: [last] } = await client.query(OLD.last, [threadId]);
      await client.query(OLD.insert, [threadId, Number(last.n) + 1, '<main>Three</main>', 'bot', 'from the old build', null]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await pool.query(OLD.upsert, [threadId, 'Ignored', 'app', null, 1280, 800, 'design', 'desktop']);
    const first = await store.artifactFor(pool, { userId: ada.id, rootId });
    assert.deepEqual([first.latest, first.viewport, first.title], [3, 'desktop', 'Style directions'], 'the new store reads what the old one wrote');
    assert.deepEqual(await store.addVersion(pool, { threadId, html: '<main>Four</main>' }), { version: 4 }, 'and numbers on from it');
    assert.equal((await store.artifactFor(pool, { userId: ada.id, rootId, artifactId: 2 })).latest, 2, 'a later artifact is untouched');
  });

  await t.test('4. a plan of a later artifact names it; a deleted thread takes its later artifacts with it', async () => {
    await pool.query('UPDATE chat_session_specs SET shared_to_group_at = NOW() - INTERVAL \'1 hour\' WHERE session_id = $1', [session.id]);
    await pool.query(
      `INSERT INTO chat_session_specs (session_id, version, content, content_html, shared_to_group_at, design_thread_id, design_version, design_artifact_id)
       VALUES ($1, 2, 'plan', '<article data-spec></article>', NOW(), $2, 2, 2)`,
      [session.id, threadId],
    );
    // A plan names only a design; artifact 2 is a page, so the door says nothing of it.
    assert.deepEqual(await designs.threadForRequest(pool, { userId: ada.id, appId: app.id, number: 31 }), { rootId });
    await pool.query('UPDATE thread_artifacts SET kind = \'design\' WHERE private_thread_id = $1 AND number = 2', [threadId]);
    assert.deepEqual(await designs.threadForRequest(pool, { userId: ada.id, appId: app.id, number: 31 }),
      { rootId, designVersion: 2, artifactId: 2 });
    assert.deepEqual(specs.designSource({ threadId, version: 2, artifactId: 2 }), { threadId, version: 2, artifactId: 2 });
    assert.deepEqual(specs.designSource({ threadId, version: 2, artifactId: 1 }), { threadId, version: 2 }, 'the first is said by naming none');

    await pool.query('DELETE FROM private_threads WHERE id = $1', [threadId]);
    const { rows: [left] } = await pool.query(
      `SELECT (SELECT COUNT(*) FROM thread_artifacts)::int AS artifacts, (SELECT COUNT(*) FROM thread_artifact_versions)::int AS versions`,
    );
    assert.deepEqual(left, { artifacts: 0, versions: 0 });
  });

  await t.test('5. the shots\' staging seed: one thread of the capture member\'s holding two pages, once', async () => {
    const capture = await user('usernode-capture');
    const { seedStagingArtifactsThread } = require('../src/db/migrate');
    const was = process.env.USERNODE_ENV;
    try {
      delete process.env.USERNODE_ENV;
      await seedStagingArtifactsThread(pool);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM private_threads WHERE user_id = $1', [capture.id])).rows[0].n, 0,
        'a no-op outside staging');
      process.env.USERNODE_ENV = 'staging';
      await seedStagingArtifactsThread(pool);
      await seedStagingArtifactsThread(pool);
    } finally {
      if (was === undefined) delete process.env.USERNODE_ENV;
      else process.env.USERNODE_ENV = was;
    }
    const { rows: threads } = await pool.query('SELECT root_message_id FROM private_threads WHERE user_id = $1', [capture.id]);
    assert.equal(threads.length, 1, 'idempotent');
    const held = await store.artifactFor(pool, { userId: capture.id, rootId: Number(threads[0].root_message_id) });
    assert.deepEqual(held.artifacts.map((a) => [a.artifactId, a.artifactKind, a.title, a.latest]), [
      [1, 'page', 'Staging demo: style directions', 2], [2, 'page', 'Staging demo: list layouts', 1],
    ]);
    const { rows: lines } = await pool.query(
      `SELECT content, metadata->'homeroomBot'->>'artifactId' AS artifact, metadata->'homeroomBot'->>'designVersion' AS version
         FROM conversation_messages WHERE thread_root_id = $1 ORDER BY id`,
      [Number(threads[0].root_message_id)],
    );
    assert.deepEqual(lines.map((l) => [l.artifact, l.version]), [['1', '1'], ['1', '2'], ['2', '1']]);
    assert.equal(lines[2].content, 'Staging demo: list layouts, version 1: three ways to lay out a list.');
    const second = await store.artifactFor(pool, { userId: capture.id, rootId: Number(threads[0].root_message_id), artifactId: 2 });
    assert.ok(second.versions[0].messageId, 'each version knows its line');
  });
});
