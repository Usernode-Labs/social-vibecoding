// #5379 — settings proposals stay out of the agent lists. The backfill tags
// the manifest sessions the platform wrote before createManifestPR began
// stamping source='settings'; the UPDATE has to match exactly those rows and
// be safe on every boot, which are claims worth proving against the real
// statement, not a regex over a copy.
//
// Same harness shape as tests/username-first-choice-postgres.test.js: the
// UPDATE is SLICED OUT of src/db/migrate.js so production code is tested
// rather than a fixture, and it runs in a throwaway schema holding just the
// columns the statement touches.
//
// Run with: node --test tests/settings-proposal-source.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, Pool } = require('pg');

const { backfillSettingsProposalSource } = require('../src/db/migrate');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// The backfill statement exactly as src/db/migrate.js runs it.
function backfillSql() {
  const migrate = read('src', 'db', 'migrate.js');
  const fn = migrate.slice(
    migrate.indexOf('async function backfillSettingsProposalSource'));
  const start = fn.indexOf('`UPDATE chat_sessions');
  const end = fn.indexOf('`', start + 1);
  assert.ok(start > 0 && end > start, 'migrate.js runs one UPDATE for the backfill');
  return fn.slice(start + 1, end);
}

function recordingPool(rowCount = 1) {
  const calls = [];
  return {
    calls,
    query: async (sql) => {
      calls.push({ sql: String(sql) });
      return { rows: [], rowCount };
    },
  };
}

test('the backfill targets every manifest flavour and nothing else', () => {
  const sql = backfillSql();
  // The seven branch prefixes createManifestPR is called with: rename,
  // visibility, governance, admins and secret-declare in rename-pr.js,
  // who-decides in who-decides-pr.js, topics in topics-pr.js.
  for (const prefix of ['rename/', 'visibility/', 'governance/', 'admins/',
    'secret-declare/', 'who-decides/', 'topics/']) {
    assert.match(sql, new RegExp(`branch_name LIKE '${prefix}`),
      `${prefix} branches are matched`);
  }
});

test('the backfill is idempotent and keeps real agent sessions out', () => {
  const sql = backfillSql();
  // source IS NULL is the idempotence gate: after the first run, no row
  // matches any more.
  assert.match(sql, /source IS NULL/);
  // A platform session backing a real agent conversation (agent_session_id
  // set, or a user/assistant transcript) keeps its NULL — only manifest PRs
  // read 'settings'.
  assert.match(sql, /agent_session_id IS NULL/);
  assert.match(sql, /NOT EXISTS[\s\S]*chat_session_messages m[\s\S]*m\.role IN \('user', 'assistant'\)/);
  // A settings proposal exists because a pull request is up for vote.
  assert.match(sql, /pr_number IS NOT NULL/);
});

test('the migrate boot calls the backfill in the maintenance block', () => {
  const migrate = read('src', 'db', 'migrate.js');
  const call = 'await backfillSettingsProposalSource(pool);';
  assert.ok(migrate.includes(call), 'the backfill is awaited during migration');
  const at = migrate.indexOf(call);
  const usernameBackfill = migrate.indexOf('await backfillUsernameChoiceForEmailHandles(pool);');
  const phase = migrate.indexOf("finishPhase('maintenanceMs')");
  assert.ok(at > usernameBackfill && at < phase,
    'the call sits among the maintenance backfills, before the phase closes');
});

test('the backfill is best effort: a failed query never aborts boot', async () => {
  const calls = [];
  await assert.doesNotReject(() => backfillSettingsProposalSource({
    query: async (sql) => { calls.push(String(sql)); throw new Error('connection refused'); },
  }));
  assert.equal(calls.length, 1, 'exactly one UPDATE was attempted');
});

// ── the statement against real PostgreSQL ──────────────────────────────

async function withDatabase(t, run) {
  const admin = new Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch (error) {
    await admin.end().catch(() => {});
    return t.skip(`no postgres reachable at ${DSN}: ${error.message || error.code || error}`);
  }

  const schema = `settings_source_test_${process.pid}`;
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: DSN,
    connectionTimeoutMillis: 3000,
    options: `-c search_path=${schema}`,
  });
  try {
    await pool.query(`
      CREATE TABLE chat_sessions (
        id SERIAL PRIMARY KEY,
        branch_name VARCHAR(255),
        pr_number INTEGER,
        agent_session_id INTEGER,
        source TEXT
      );
      CREATE TABLE chat_session_messages (
        id SERIAL PRIMARY KEY,
        session_id INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role VARCHAR(20) NOT NULL
      );
    `);
    await run(pool);
  } finally {
    await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

test('the backfill tags the manifest rows and only them', async (t) => {
  await withDatabase(t, async (pool) => {
    // One row per manifest flavour: all seven read 'settings' afterwards.
    const flavours = ['rename/demo-1', 'visibility/demo-2', 'governance/demo-3',
      'admins/demo-4', 'secret-declare/demo-5', 'who-decides/demo-6',
      'topics/demo-7'];
    for (const branch of flavours) {
      await pool.query(
        'INSERT INTO chat_sessions (branch_name, pr_number, source) VALUES ($1, 42, NULL)',
        [branch]);
    }
    // Left alone: agent work that happens to branch from one of these
    // prefixes, an already-stamped row, a proposal with no pull request,
    // and anything outside the prefixes. The transcript counter-example is
    // inserted separately below, so its conversation exists before the run.
    const untouched = [
      ['rename/real-agent-8', 43, 901, null],
      ['rename/already-stamped-10', 45, null, 'imported'],
      ['rename/no-pr-11', null, null, null],
      ['dev/chat-12', 46, null, null],
    ];
    for (const [branch, pr, agentId, source] of untouched) {
      await pool.query(
        'INSERT INTO chat_sessions (branch_name, pr_number, agent_session_id, source) VALUES ($1, $2, $3, $4)',
        [branch, pr, agentId, source]);
    }
    // The transcript guard's counter-example: a conversation really happened.
    const withTranscript = await pool.query(
      'INSERT INTO chat_sessions (branch_name, pr_number, source) VALUES ($1, 44, NULL) RETURNING id',
      ['who-decides/with-transcript-9']);
    await pool.query(
      'INSERT INTO chat_session_messages (session_id, role) VALUES ($1, $2)',
      [withTranscript.rows[0].id, 'user']);

    const result = await pool.query(backfillSql());
    assert.equal(result.rowCount, 7, 'exactly the seven manifest rows moved');

    const { rows } = await pool.query(
      'SELECT branch_name, source FROM chat_sessions ORDER BY id');
    for (const row of rows.slice(0, 7)) {
      assert.equal(row.source, 'settings', `${row.branch_name} reads settings`);
    }
    for (const row of rows.slice(7)) {
      assert.notEqual(row.source, 'settings', `${row.branch_name} keeps its source`);
    }
  });
});

test('the backfill is safe on every boot, not only the first', async (t) => {
  await withDatabase(t, async (pool) => {
    await pool.query(
      'INSERT INTO chat_sessions (branch_name, pr_number, source) VALUES ($1, 42, NULL)',
      ['rename/demo-1']);
    assert.equal((await pool.query(backfillSql())).rowCount, 1);
    assert.equal((await pool.query(backfillSql())).rowCount, 0,
      'the second run matches nothing: source IS NULL has no rows left');
  });
});