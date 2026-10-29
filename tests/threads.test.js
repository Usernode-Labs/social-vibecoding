'use strict';

// Threads, stage 1 of #6019, without a database: services/threads.js's
// backfill against a pool that records what it is asked, and the schema
// block's shape. The SQL itself runs against PostgreSQL in
// threads-postgres.test.js.
//
// What these pin:
//   1. The backfill runs once: a marker skips it, a completed pass sets it,
//      and a pass that fails leaves it unset and never throws into the boot.
//   2. Its order: requests and governance rows, then changes, then messages,
//      so a message's anchor has its thread before the message looks for it.
//   3. Every statement touches only rows with no thread yet, and the large
//      tables go in id ranges that cover every row.
//   4. The schema's triggers cannot fail a write, attach only what has no
//      thread, and name the same manifest branches the code makes.
//
// Run with: node --test tests/threads.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const threads = require('../src/services/threads');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
const MIGRATE_SRC = fs.readFileSync(path.join(__dirname, '../src/db/migrate.js'), 'utf8');
const SERVICE_SRC = fs.readFileSync(path.join(__dirname, '../src/services/threads.js'), 'utf8');
const BLOCK = SCHEMA_SQL.slice(SCHEMA_SQL.indexOf('-- ── Threads (stage 1 of #6019)'));

// A pool that answers by SQL substring, recording every call.
function fakePool({ marker = false, maxSession = 0, maxMessage = 0, failOn = null } = {}) {
  const queries = [];
  const settings = new Set(marker ? [threads.MARKER_KEY] : []);
  return {
    queries,
    settings,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (failOn && failOn.test(sql)) throw new Error('connection reset');
      if (/SELECT 1 FROM platform_settings/.test(sql)) return { rows: settings.has(params[0]) ? [{}] : [] };
      if (/INSERT INTO platform_settings/.test(sql)) { settings.add(params[0]); return { rows: [], rowCount: 1 }; }
      if (/MAX\(id\).*FROM chat_sessions/.test(sql)) return { rows: [{ max: maxSession }] };
      if (/MAX\(id\).*FROM chat_messages/.test(sql)) return { rows: [{ max: maxMessage }] };
      return { rows: [], rowCount: 1 };
    },
  };
}

test('a marked pass is skipped; a completed pass marks itself, once', async () => {
  const done = fakePool({ marker: true });
  assert.deepEqual(await threads.backfill(done), { skipped: 'done' });
  assert.equal(done.queries.length, 1, 'one lookup and nothing else');

  const fresh = fakePool();
  const out = await threads.backfill(fresh);
  assert.ok(!out.failed && !out.skipped);
  assert.ok(fresh.settings.has(threads.MARKER_KEY));
  const marking = fresh.queries.find((q) => /INSERT INTO platform_settings/.test(q.sql));
  assert.match(marking.sql, /ON CONFLICT \(key\) DO NOTHING/);
  assert.equal(threads.MARKER_KEY, 'threads_backfilled_v1');
});

test('a pass that fails is logged, leaves the marker unset, and never throws into the boot', async () => {
  for (const step of [/UPDATE requests/, /UPDATE issues/, /UPDATE chat_sessions/, /UPDATE chat_messages/]) {
    const pool = fakePool({ maxSession: 5, maxMessage: 5, failOn: step });
    const out = await threads.backfill(pool);
    assert.equal(out.failed, true, String(step));
    assert.ok(!pool.settings.has(threads.MARKER_KEY), 'the next boot carries on');
  }
  const unreadable = fakePool({ failOn: /SELECT 1 FROM platform_settings/ });
  assert.deepEqual(await threads.backfill(unreadable), { skipped: 'unavailable' });
  assert.equal(unreadable.queries.length, 1, 'nothing is written when the marker cannot be read');
});

test('requests and governance rows first, then changes, then messages', async () => {
  const pool = fakePool({ maxSession: 1, maxMessage: 1 });
  await threads.backfill(pool);
  const at = (re) => pool.queries.findIndex((q) => re.test(q.sql));
  const order = [/UPDATE requests/, /UPDATE issues/, /UPDATE chat_sessions/, /UPDATE chat_messages m SET thread_id = t\.id/,
    /INSERT INTO platform_settings/].map(at);
  assert.ok(order.every((n) => n >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((x, y) => x - y), order);
  // A request's number gets its thread before anything joins it.
  assert.ok(at(/INSERT INTO threads \(app_id, number\)\s+SELECT app_id, number FROM requests/) < at(/UPDATE requests/));
  assert.ok(at(/SELECT DISTINCT app_id, thread_ref FROM chat_messages/) < at(/UPDATE chat_messages/));
});

test('every statement touches only rows with no thread yet, and numbered threads are made once', () => {
  const statements = [...SERVICE_SRC.matchAll(/`((?:UPDATE|INSERT INTO threads)[\s\S]*?)`/g)].map((m) => m[1]);
  assert.ok(statements.length >= 8, `found ${statements.length}`);
  for (const sql of statements) {
    assert.match(sql, /thread_id IS NULL/, sql.slice(0, 60));
    if (/^INSERT INTO threads/.test(sql)) {
      assert.match(sql, /ON CONFLICT \(app_id, number\) WHERE number IS NOT NULL DO NOTHING/);
    }
  }
  // Governance rows with nothing to join are left out, not rewritten as unattached.
  assert.match(SERVICE_SRC, /AND NOT \(kind = 'general' AND github_issue_number IS NULL\)/);
  assert.match(SERVICE_SRC, /AND NOT \(kind = 'close_issue' AND COALESCE\(payload ->> 'issueNumber', ''\) !~ '\^\[0-9\]\{1,9\}\$'\)/);
});

test('changes and messages go in id ranges that cover every row', async () => {
  const pool = fakePool({ maxSession: 4500, maxMessage: 25001 });
  await threads.backfill(pool, { batch: { sessions: 2000, messages: 10000 } });
  const ranges = (re) => pool.queries.filter((q) => re.test(q.sql)).map((q) => q.params);
  assert.deepEqual(ranges(/UPDATE chat_sessions/), [[0, 2000], [2000, 4000], [4000, 6000]]);
  const issueMsgs = ranges(/UPDATE chat_messages m SET thread_id = t\.id/);
  assert.deepEqual(issueMsgs, [[0, 10000], [10000, 20000], [20000, 30000]]);
  assert.equal(ranges(/UPDATE chat_messages m SET thread_id = s\.thread_id/).length, 3);
  assert.equal(ranges(/UPDATE chat_messages m SET thread_id = i\.thread_id/).length, 3);
  for (const q of pool.queries.filter((x) => /UPDATE chat_(sessions|messages)/.test(x.sql))) {
    assert.match(q.sql, /id > \$1 AND (m\.)?id <= \$2/, 'half-open ranges, so no row is in two');
  }
  const empty = fakePool();
  await threads.backfill(empty);
  assert.equal(empty.queries.filter((q) => /UPDATE chat_sessions/.test(q.sql)).length, 1, 'one pass over an empty table');
});

test('the boot runs the backfill after the schema and the move off GitHub, before the seeds', () => {
  const backfill = MIGRATE_SRC.indexOf("require('../services/threads').backfill(pool)");
  assert.ok(backfill > 0);
  assert.ok(backfill > MIGRATE_SRC.indexOf('await applySchemaWithLockRetry(pool, schema);'));
  assert.ok(backfill > MIGRATE_SRC.indexOf("require('../services/github-move').migrate(pool)"));
  assert.ok(backfill < MIGRATE_SRC.indexOf('await seedAdmin(pool, config);'));
});

test('the schema: a public table, one thread per number, and four columns that point at it', () => {
  assert.ok(BLOCK.length > 100, 'the block is at the end of schema.sql');
  assert.match(BLOCK, /CREATE TABLE IF NOT EXISTS threads \(/);
  assert.match(BLOCK, /CREATE UNIQUE INDEX IF NOT EXISTS threads_app_number_idx\s+ON threads \(app_id, number\) WHERE number IS NOT NULL;/);
  assert.doesNotMatch(BLOCK, /COMMENT ON TABLE threads IS 'staging:private'/, 'public, like the rows that point at it');
  for (const table of ['requests', 'issues', 'chat_sessions', 'chat_messages']) {
    assert.match(BLOCK, new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS thread_id BIGINT REFERENCES threads\\(id\\) ON DELETE SET NULL;`));
  }
  // The anchor stays: nothing here drops or rewrites it.
  assert.doesNotMatch(BLOCK, /DROP COLUMN|thread_type\s*=\s*NULL|SET thread_type/);
});

test('every attach trigger fires only on rows with no thread and cannot fail the write it rides on', () => {
  const triggers = [...BLOCK.matchAll(/CREATE TRIGGER (\w+)\s+(BEFORE|AFTER) ([A-Z ,_a-z]+?) ON (\w+)\s+FOR EACH ROW WHEN \(([^)]*\)?[^)]*)\)\s+EXECUTE FUNCTION (\w+)\(\);/g)];
  assert.deepEqual(triggers.map((m) => m[1]).sort(), [
    'chat_messages_attach_thread', 'chat_sessions_attach_thread', 'chat_sessions_attach_thread_later',
    'chat_sessions_carry_thread_messages', 'issues_attach_thread', 'requests_attach_thread',
  ]);
  for (const m of triggers) {
    const [, name, , , , when, fn] = m;
    if (name !== 'chat_sessions_carry_thread_messages') assert.match(when, /NEW\.thread_id IS NULL/, name);
    const body = new RegExp(`CREATE OR REPLACE FUNCTION ${fn}\\(\\) RETURNS TRIGGER[\\s\\S]*?\\$\\$;`).exec(BLOCK);
    assert.ok(body, `${fn} is defined in the block`);
    assert.match(body[0], /EXCEPTION WHEN OTHERS THEN/, `${fn} catches whatever goes wrong`);
  }
  // Each is created only if it is not there yet, since the schema runs every boot.
  assert.equal((BLOCK.match(/IF NOT EXISTS \(SELECT 1 FROM pg_trigger WHERE tgname = '/g) || []).length, triggers.length);
  // Messages about one piece of work only; channels and reply threads keep none.
  assert.match(BLOCK, /WHEN \(NEW\.thread_id IS NULL AND NEW\.thread_type IN \('issue', 'session', 'governance'\)\)/);
});

test('a decision branch is every manifest branch the code makes', () => {
  const made = new Set();
  for (const file of ['src/services/rename-pr.js', 'src/services/topics-pr.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const m of src.matchAll(/branchPrefix: '([a-z-]+)'/g)) made.add(m[1]);
    for (const m of src.matchAll(/`(topics)\/\$\{/g)) made.add(m[1]);
  }
  const listed = /IN \(([^)]*)\)\s+THEN 'decision'/.exec(BLOCK)[1].match(/'([a-z-]+)'/g).map((s) => s.slice(1, -1));
  for (const prefix of made) assert.ok(listed.includes(prefix), `${prefix}/ is a decision branch`);
  assert.ok(made.has('visibility') && made.has('governance') && made.has('admins'));
});
