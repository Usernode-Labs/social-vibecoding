const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');
const seeds = require('../src/db/migrate');

const names = ['seedStagingTopicScrollThreads', 'seedStagingHomeLayout', 'seedStagingLlmUsage',
  'seedStagingAnalyticsCharts', 'seedStagingSpendDistribution'];
const savedEnvironment = process.env.USERNODE_ENV;
test.after(() => {
  if (savedEnvironment === undefined) delete process.env.USERNODE_ENV;
  else process.env.USERNODE_ENV = savedEnvironment;
});

test('batched fixture routines remain strict no-ops outside staging', async () => {
  process.env.USERNODE_ENV = 'production';
  const pool = { query() { assert.fail('production must not seed fixtures'); } };
  for (const name of names) await seeds[name](pool, {});
});

test('batched fixtures preserve real PostgreSQL data, ordering and repeated-boot behavior', {
  skip: !process.env.FIXTURE_BATCH_TEST_URL,
}, async () => {
  const url = new URL(process.env.FIXTURE_BATCH_TEST_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'use disposable local PostgreSQL only');
  const database = `fixture_batch_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: url.toString() });
  let client;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    url.pathname = `/${database}`;
    client = new Client({ connectionString: url.toString() });
    await client.connect();
    await client.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
    await client.query('BEGIN'); // stable NOW/CURRENT_DATE for repeatability
    await client.query(`
      INSERT INTO users(id, username, password, is_admin) VALUES
        (1, 'fixture-admin', 'sentinel', true), (2, 'usernode-capture', 'sentinel', false),
        (3, 'usernode-capture-admin', 'sentinel', true), (4, 'staging-demo-quota-zero', 'sentinel', false),
        (5, 'other-viewer', 'sentinel', false), (6, 'last-viewer', 'sentinel', false);
      INSERT INTO apps(id, name, slug, status, self_hosted) VALUES
        (1, 'Self', 'self-app', 'running', true),
        (2, 'Chess', 'staging-demo-chess-arena', 'running', false),
        (3, 'Racer', 'staging-demo-pixel-racer', 'running', false),
        (4, 'Puzzle', 'staging-demo-puzzle-chain', 'running', false),
        (5, 'Garden', 'staging-demo-word-garden', 'running', false);
      INSERT INTO chat_sessions(id, app_id, user_id, branch_name) VALUES (1, 1, 1, 'staging-fixture/my-open-pr');
      INSERT INTO issues(id, app_id, title) VALUES (1, 1, 'Set secret "STAGING_DEMO_PUBLIC_URL"');
      INSERT INTO user_home_layout(user_id, cols, item_type, widget_key, grid_col, grid_row)
        VALUES (1, 5, 'widget', 'create', 1, 7);
    `);
    process.env.USERNODE_ENV = 'staging';
    const config = { adminUsername: 'fixture-admin', selfAppSlug: 'self-app' };
    const counts = {};
    for (const name of names) {
      counts[name] = 0;
      await seeds[name]({ query: (...args) => { counts[name]++; return client.query(...args); } }, config);
    }
    assert.deepEqual(Object.values(counts), [7, 1, 2, 4, 3], '17 SQL round trips for these five routines');
    const rows = async sql => (await client.query(sql)).rows;
    const scalar = async sql => (await rows(sql))[0].n;
    assert.equal(await scalar('SELECT count(*)::int n FROM chat_messages'), 54);
    const thread = await rows("SELECT content, user_id, created_at FROM chat_messages WHERE thread_type='issue' ORDER BY id");
    assert.ok(thread[0].content.includes('#1:'));
    assert.ok(thread[17].content.includes('#18:'));
    assert.deepEqual(thread.slice(0, 6).map(r => r.user_id), [1, 3, 2, 1, 3, 2]);
    assert.ok(thread.every((r, i) => i === 0 || r.created_at > thread[i - 1].created_at));
    assert.equal(await scalar('SELECT count(*)::int n FROM user_home_layout'), 43);
    assert.deepEqual(await rows('SELECT grid_col, grid_row FROM user_home_layout WHERE user_id=1'), [{ grid_col: 1, grid_row: 7 }]);
    assert.equal(await scalar('SELECT count(*)::int n FROM events WHERE id BETWEEN 90006000 AND 90006059'), 60);
    assert.equal(await scalar('SELECT count(*)::int n FROM app_activity'), 57);
    assert.equal(await scalar('SELECT count(*)::int n FROM llm_usage'), 420);
    assert.equal(await scalar('SELECT count(*)::int n FROM llm_usage WHERE user_id IN (9300001,9300002)'), 0);
    assert.equal(await scalar('SELECT count(*)::int n FROM llm_usage WHERE user_id=9300006 AND total_cost_cents >= 2000'), 0);
    assert.equal(await scalar('SELECT count(*)::int n FROM llm_usage WHERE user_id=9300008 AND byok_cost_cents >= 800'), 30);
    const snapshot = async () => Promise.all(['users', 'chat_messages', 'user_home_layout', 'events', 'app_activity', 'llm_usage']
      .map(table => rows(`SELECT to_jsonb(t) AS data FROM ${table} t ORDER BY to_jsonb(t)::text`)));
    const before = await snapshot();
    for (const name of names) await seeds[name](client, config);
    assert.deepEqual(await snapshot(), before, 'second boot preserves all existing fixture rows');
    await client.query("UPDATE users SET is_admin=true, anthropic_key_enc='changed' WHERE id=9300003");
    await client.query('UPDATE llm_usage SET total_cost_cents=123 WHERE user_id=9300003');
    await seeds.seedStagingSpendDistribution(client);
    assert.deepEqual(await rows('SELECT is_admin, anthropic_key_enc FROM users WHERE id=9300003'), [{ is_admin: false, anthropic_key_enc: null }]);
    assert.equal(await scalar('SELECT count(*)::int n FROM llm_usage WHERE user_id=9300003 AND total_cost_cents=123'), 30);
    // A partially seeded thread is filled back in without replacing its neighbors.
    await client.query("DELETE FROM chat_messages WHERE thread_type='session' AND content LIKE '%#2:%'");
    await seeds.seedStagingTopicScrollThreads(client, config);
    assert.equal(await scalar('SELECT count(*)::int n FROM chat_messages'), 54);
    // Missing anchors/apps remain supported; an existing custom layout survives.
    await client.query('DELETE FROM issues WHERE id=1');
    await client.query('DELETE FROM chat_sessions WHERE id=1');
    await seeds.seedStagingTopicScrollThreads(client, config);
    await client.query('DELETE FROM apps WHERE id=5');
    await seeds.seedStagingHomeLayout(client, { adminUsername: 'other-viewer' });
    assert.equal(await scalar('SELECT count(*)::int n FROM user_home_layout WHERE user_id=5'), 12);
    await client.query('ROLLBACK');
  } finally {
    if (client) await client.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.end();
  }
});
