// #1647 — importing a pull request assigns the resulting proposal to the
// collaborator who imported it. The assignee is a topic-attribute vote, so
// this test drives the route helper through the real topic-attribute service
// and inspects the exact persisted identity/target tuple.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { selfAssignImportedProposal } = require('../src/routes/votes');

function recordingPool() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      return { rows: [], rowCount: 0 };
    },
  };
}

test('an imported proposal stores the importer as its assignee', async () => {
  const pool = recordingPool();

  await selfAssignImportedProposal(
    pool, 41, 3778, { id: 73, username: '  Bruno  ' }
  );

  const write = pool.calls.find((call) =>
    /INSERT INTO topic_attribute_votes/.test(call.sql)
  );
  assert.ok(write, 'the import records an assignee vote');
  assert.deepEqual(write.params, [
    41, 'proposal', 3778, 'assignee', 'Bruno', 73,
  ]);
});

test('an imported proposal cannot succeed without an assignable identity', async () => {
  const pool = recordingPool();

  await assert.rejects(
    () => selfAssignImportedProposal(pool, 41, 3778, { id: 73, username: '   ' }),
    /no assignable identity/
  );
  assert.equal(pool.calls.length, 0, 'no partial assignee write is attempted');
});

test('the import handler assigns before it reports or broadcasts success', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'votes.js'), 'utf8'
  );
  const start = source.indexOf("router.post('/api/apps/:slug/pr-import'");
  const end = source.indexOf("router.post('/api/apps/:slug/pr-import/_mock/advance'");
  const handler = source.slice(start, end);

  const assignment = handler.indexOf('await selfAssignImportedProposal(');
  const commit = handler.indexOf("await importClient.query('COMMIT')");
  const response = handler.indexOf('res.json({ ok: true, sessionId');
  const broadcast = handler.indexOf('pushSessionUpdate({ action: promote');

  assert.ok(assignment >= 0, 'the live import handler invokes self-assignment');
  assert.ok(assignment < commit, 'session creation and assignment commit atomically');
  assert.ok(assignment < broadcast, 'cards are assigned before their import update is broadcast');
  assert.ok(assignment < response, 'a successful response never races ahead of assignment');
});
