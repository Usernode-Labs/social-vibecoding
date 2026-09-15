// Human-created proposal/session rows receive a proposal-level assignee vote
// before their creation becomes externally visible. The shared helper is
// insert-only so retries and backfills preserve deliberate assignments.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const topicAttrs = require('../src/services/topic-attributes');
const { backfillProposalIssuerAssignments } = require('../src/db/migrate');

function recordingPool(rowCount = 1) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      return { rows: [], rowCount };
    },
  };
}

function source(file) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
}

function orderedSlice(text, startNeedle, endNeedle, labels) {
  const start = text.indexOf(startNeedle);
  const end = text.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0 && end > start, `route slice ${startNeedle} is findable`);
  const slice = text.slice(start, end);
  let previous = -1;
  for (const [label, needle] of labels) {
    const at = slice.indexOf(needle);
    assert.ok(at >= 0, `${label} is present`);
    assert.ok(at > previous, `${label} occurs after the preceding step`);
    previous = at;
  }
}

test('self-assignment stores the trimmed issuer on the proposal target', async () => {
  const pool = recordingPool();
  const inserted = await topicAttrs.selfAssignProposal(
    pool, 41, 3778, { id: 73, username: '  Bruno  ' }
  );

  assert.equal(inserted, true);
  assert.deepEqual(pool.calls[0].params, [
    41, 'proposal', 3778, 'assignee', 'Bruno', 73,
  ]);
  assert.match(pool.calls[0].sql, /WHERE NOT EXISTS/);
  assert.match(pool.calls[0].sql, /field = \$4/);
  assert.match(pool.calls[0].sql, /\$2::varchar\(16\)/,
    'shared placeholders carry explicit PostgreSQL types');
  assert.match(pool.calls[0].sql, /ON CONFLICT .* DO NOTHING/s);
});

test('self-assignment is a no-op when a proposal assignment already exists', async () => {
  const pool = recordingPool(0);
  assert.equal(await topicAttrs.selfAssignProposal(
    pool, 41, 3778, { id: 73, username: 'Bruno' }
  ), false);
});

test('self-assignment refuses an unusable issuer identity without writing', async () => {
  const pool = recordingPool();
  await assert.rejects(
    () => topicAttrs.selfAssignProposal(pool, 41, 3778, { id: 73, username: '  ' }),
    /no assignable identity/
  );
  assert.equal(pool.calls.length, 0);
});

test('native and imported proposal creation assign inside their transactions', () => {
  orderedSlice(
    source('src/routes/proposal-handoff.js'),
    "router.post('/api/apps/:slug/proposal-handoffs'",
    "router.post('/api/sessions/:id/proposal-handoff/context'",
    [
      ['session insert', 'INSERT INTO chat_sessions'],
      ['issuer assignment', 'await topicAttrs.selfAssignProposal(client'],
      ['transaction commit', "await client.query('COMMIT')"],
      ['success response', 'res.status(insertedSession ? 201 : 200)'],
    ]
  );
  orderedSlice(
    source('src/routes/votes.js'),
    "router.post('/api/apps/:slug/pr-import'",
    "router.post('/api/apps/:slug/pr-import/_mock/advance'",
    [
      ['session insert', 'INSERT INTO chat_sessions'],
      ['issuer assignment', 'await topicAttrs.selfAssignProposal('],
      ['transaction commit', "await importClient.query('COMMIT')"],
      ['broadcast', 'pushSessionUpdate({ action: promote'],
      ['success response', 'res.json({ ok: true, sessionId'],
    ]
  );
});

test('browser, shared, cloned and forked work assigns before it is exposed', () => {
  const sessions = source('src/routes/sessions.js');
  orderedSlice(sessions, "router.post('/api/apps/:slug/sessions'", 'start a HEADLESS auto session', [
    ['session insert', 'INSERT INTO chat_sessions'],
    ['issuer assignment', 'await topicAttrs.selfAssignProposal('],
    ['start event', 'events.record(pool'],
    ['success response', 'res.status(201).json'],
  ]);
  orderedSlice(sessions, "router.post('/api/sessions/:id/clone-headless'", "router.post('/api/sessions/:id/share'", [
    ['session insert', 'INSERT INTO chat_sessions'],
    ['issuer assignment', 'await topicAttrs.selfAssignProposal('],
  ]);
  orderedSlice(sessions, "router.post('/api/sessions/:id/fork'", "router.post('/api/sessions/:id/pause'", [
    ['session insert', 'INSERT INTO chat_sessions'],
    ['issuer assignment', 'await topicAttrs.selfAssignProposal('],
  ]);
  orderedSlice(
    source('src/routes/proposal-handoff.js'),
    "router.post('/api/apps/:slug/work/share-in-progress'",
    "router.post('/api/apps/:slug/proposal-handoffs'",
    [
      ['session insert', 'INSERT INTO chat_sessions'],
      ['issuer assignment', 'await topicAttrs.selfAssignProposal('],
      ['shared broadcast', "pushSessionUpdate({ action: 'shared'"],
      ['success response', 'return res.json'],
    ]
  );
});

test('direct human-decided proposals assign before announcements', () => {
  orderedSlice(source('src/services/rename-pr.js'), 'async function createManifestPR', 'async function createRenamePR', [
    ['session insert', 'INSERT INTO chat_sessions'],
    ['issuer assignment', 'await topicAttrs.selfAssignProposal('],
    ['vote announcement', 'await sendSystemMessage'],
  ]);
  orderedSlice(source('src/routes/votes.js'), 'async function checkAndOpenRevert', 'async function createRevertPR', [
    ['session insert', 'INSERT INTO chat_sessions'],
    ['issuer assignment', 'await topicAttrs.selfAssignProposal('],
    ['original pointer update', 'UPDATE chat_sessions SET revert_of_session_id = $1'],
  ]);
});

test('the open-proposal backfill preserves existing choices and excludes automation', async () => {
  const pool = recordingPool(4);
  assert.equal(await backfillProposalIssuerAssignments(pool), 4);
  const sql = pool.calls[0].sql;
  assert.match(sql, /status IN \('active', 'paused', 'promoted', 'merging'\)/);
  assert.match(sql, /is_headless = FALSE/);
  assert.match(sql, /source IS DISTINCT FROM 'maintenance'/);
  assert.match(sql, /NOT EXISTS[\s\S]*target_type = 'proposal'[\s\S]*field = 'assignee'/);
  assert.match(sql, /ON CONFLICT .* DO NOTHING/s);
});
