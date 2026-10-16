'use strict';

// services/fixed-check-sync.js, executed by a REAL postgres planner: what
// main passes (the newest result among the last merged proposals), each
// open proposal's failing checks unpacked from its verdict, and the claim.
// tests/fixed-check-sync.test.js covers the decisions against fakes; only
// the planner can say the JSON and array statements do what they read as.
//
// Skips without a reachable server, like the other *-postgres suites; with
// TEST_DATABASE_URL set it runs.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/fixed-check-sync-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const subject = require('../src/services/fixed-check-sync');
const appManifest = require('../src/services/app-manifest');

const ROOT = path.join(__dirname, '..');
const SCHEMA_SQL = fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8');
const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';

// The smallest chat_sessions the statements read, with the claim columns
// taken from schema.sql so a rename there fails here. apps is what
// mainWatchVerdict reads (syncBeforeFix asks it), and loadRow joins for the
// proposal's identity.
const DDL = [
  `CREATE TABLE chat_sessions (
     id INTEGER PRIMARY KEY, app_id INTEGER NOT NULL, status TEXT NOT NULL,
     source TEXT, merged_at TIMESTAMPTZ, check_state TEXT, checks_checked_at TIMESTAMPTZ,
     checks_commit_sha TEXT, reviewed_head_sha TEXT,
     test_results JSONB NOT NULL DEFAULT '[]')`,
  `CREATE TABLE apps (
     id INTEGER PRIMARY KEY, slug TEXT, name TEXT, repo_url TEXT,
     main_check_state TEXT, main_check_at TIMESTAMPTZ, main_check_sha TEXT, main_sha TEXT)`,
  ...(SCHEMA_SQL.match(/^ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS fixed_check_sync_[^;]*;/gm) || []),
].join(';\n');

async function connect() {
  let Client;
  try { ({ Client } = require('pg')); } catch { return null; }
  const client = new Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch (err) {
    try { await client.end(); } catch { /* never connected */ }
    return { error: err.message || err.code || String(err) };
  }
  return { client };
}

async function withSchema(client, fn) {
  const name = `fixed_check_sync_test_${process.pid}`;
  await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
  await client.query(`CREATE SCHEMA ${name}`);
  try {
    await client.query(`SET search_path TO ${name}`);
    await client.query(DDL);
    return await fn();
  } finally {
    await client.query('SET search_path TO public').catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`).catch(() => {});
  }
}

const DOMAIN = { name: 'Custom domain row', path: '/#app/staging-demo-custom-domain/dev' };
const OTHER = { name: 'Another check', path: '/#app/x' };
const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const key = (c) => appManifest.checkKey(c.name, c.path);
const result = (c, status, extra = {}) => ({ ...c, status, ...extra });
// The proposal machine's write of a check sync's once-record.
const CLAIM_SQL = fs.readFileSync(path.join(ROOT, 'src/workflow/proposal/machine.ts'), 'utf8')
  .match(/`(UPDATE chat_sessions\s+SET fixed_check_sync_head[\s\S]*?WHERE id = \$1)`/)[1];

test('main passes what the newest merged run of it passed, and a stuck proposal is claimed once', async (t) => {
  assert.equal((DDL.match(/fixed_check_sync_/g) || []).length, 2, 'both claim columns come from schema.sql');
  const conn = await connect();
  if (!conn) return t.skip('the pg driver is not installed in this environment');
  if (conn.error) return t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
  const { client } = conn;
  try {
    await withSchema(client, async () => {
      const insert = (row) => client.query(
        `INSERT INTO chat_sessions (id, app_id, status, source, merged_at, check_state, checks_commit_sha,
                                    reviewed_head_sha, test_results)
         VALUES ($1, 12, $2, 'cli_handoff', $3, $4, $5, $5, $6::jsonb)`,
        [row.id, row.status, row.mergedAt || null, row.checkState || null, row.head || null, JSON.stringify(row.results || [])]
      );
      // Merged: the older one failed the domain check, the newer (the fix)
      // passed it. OTHER passed on the older and failed on the newer.
      await insert({ id: 1, status: 'merged', mergedAt: '2026-10-09T17:00:00Z',
        results: [result(DOMAIN, 'fail'), result(OTHER, 'pass')] });
      await insert({ id: 2, status: 'merged', mergedAt: '2026-10-09T19:20:00Z',
        results: [result(DOMAIN, 'pass'), result(OTHER, 'fail', { advisory: true })] });
      // Open: two stuck on the domain check, one passing.
      await insert({ id: 10, status: 'promoted', checkState: 'failing', head: HEAD,
        results: [result(DOMAIN, 'fail'), result(OTHER, 'pass')] });
      await insert({ id: 11, status: 'promoted', checkState: 'failing', head: HEAD,
        results: [result(DOMAIN, 'fail', { index: 4 })] });
      await insert({ id: 12, status: 'promoted', checkState: 'passing', head: HEAD,
        results: [result(DOMAIN, 'fail', { advisory: true })] });

      const passes = await subject.mainPasses(client, 12);
      assert.deepEqual([...passes], [key(DOMAIN)], 'the newest merged result decides each check');

      const rows = await subject.openVerdicts(client, 12);
      assert.deepEqual(rows.map((r) => r.id), [10, 11, 12]);
      assert.deepEqual(rows[0].failing, [{ name: DOMAIN.name, path: DOMAIN.path, index: null, advisory: false }]);
      assert.equal(rows[2].failing[0].advisory, true, 'an advisory failure is still read, as evidence');

      const { candidates } = subject.select(rows, passes);
      assert.deepEqual(candidates.map((c) => c.id), [10, 11]);

      // The once-record, through the proposal machine's own statement (its
      // fixedCheckClaim write, made with the sync's work: once per head is
      // the machine's guard, tests/workflow-merge-postgres.test.js M8).
      const claimSql = CLAIM_SQL;
      await client.query(claimSql, [10, HEAD, [key(DOMAIN)]]);
      await client.query(claimSql, [10, HEAD, [key(DOMAIN)]]);
      const { rows: [after] } = await client.query('SELECT fixed_check_sync_head, fixed_check_sync_keys FROM chat_sessions WHERE id = 10');
      assert.equal(after.fixed_check_sync_head, HEAD);
      assert.deepEqual(after.fixed_check_sync_keys, [key(DOMAIN)]);

      const again = subject.select(await subject.openVerdicts(client, 12), passes);
      assert.deepEqual(again.candidates.map((c) => c.id), [11]);
      assert.equal(again.skipped[10], 'already_tried');
    });
  } finally {
    await client.end().catch(() => {});
  }
});

// #5220: syncBeforeFix reads one proposal (ownVerdict), decides it alone
// (selectOwn), and its claim is the sweep's claim, so a following sweep
// finds nothing left on the same head.
test('ownVerdict returns what decideRow reads, and a syncBeforeFix claim blocks a following sweep on the same head', async (t) => {
  const conn = await connect();
  if (!conn) return t.skip('the pg driver is not installed in this environment');
  if (conn.error) return t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
  const { client } = conn;
  try {
    await withSchema(client, async () => {
      await client.query(
        `INSERT INTO chat_sessions (id, app_id, status, source, merged_at, check_state, checks_commit_sha,
                                    reviewed_head_sha, test_results)
         VALUES ($1, 12, $2, 'cli_handoff', $3, $4, $5, $5, $6::jsonb)`,
        [1, 'merged', '2026-10-09T17:00:00Z', null, null, JSON.stringify([result(DOMAIN, 'pass')])]
      );
      await client.query(
        `INSERT INTO chat_sessions (id, app_id, status, source, check_state, checks_commit_sha,
                                    reviewed_head_sha, test_results)
         VALUES ($1, 12, 'promoted', 'cli_handoff', 'failing', $2, $2, $3::jsonb)`,
        [10, HEAD, JSON.stringify([result(DOMAIN, 'fail'), result(OTHER, 'pass')])]
      );
      await client.query(
        `INSERT INTO apps (id, slug, name, repo_url)
         VALUES (12, 'staging-demo', 'Staging demo', 'https://github.com/usernode-bot/staging-demo')`
      );

      const row = await subject.ownVerdict(client, 10);
      assert.equal(row.app_id, 12, 'the app, so the bot reads what main passes for it');
      assert.equal(row.check_state, 'failing');
      assert.deepEqual(row.failing,
        [{ name: DOMAIN.name, path: DOMAIN.path, index: null, advisory: false }]);

      const picked = subject.selectOwn(row, await subject.mainPasses(client, 12),
        await subject.mainWatchVerdict(client, 12));
      assert.deepEqual(picked.candidate, { id: 10, head: HEAD, keys: [key(DOMAIN)] },
        'judged alone: one proposal failing a check main passes is enough');

      // The proposal machine accepts the sync and writes its once-record.
      const deps = {
        integration: { measure: async () => ({ headSha: HEAD, behindBy: 3, mergesClean: true }) },
        platform: () => ({
          requestSync: async (p) => {
            await client.query(CLAIM_SQL, [p.sessionId, p.head, p.keys]);
            return { status: 'accepted', sync: 1, lastSync: { n: 1, outcome: 'clean', sha: NEW_HEAD } };
          },
        }),
      };
      const out = await subject.syncBeforeFix({ config: {}, pool: client, sessionId: 10, head: HEAD }, deps);
      assert.deepEqual(out, { synced: true, why: null, sha: NEW_HEAD });

      const swept = subject.select(await subject.openVerdicts(client, 12),
        await subject.mainPasses(client, 12));
      assert.deepEqual(swept.candidates.map((c) => c.id), [],
        'the sweep finds the head already tried: the bot\'s claim is the sweep\'s');
      assert.equal(swept.skipped[10], 'already_tried');
    });
  } finally {
    await client.end().catch(() => {});
  }
});
