'use strict';

// A channel is what people said. Homeroom used to write its activity — a
// proposal put up for a vote, a merge, a check verdict, a setting changed,
// main going red — into each project's channel (the app's main stream) and,
// for its own project, into #general. It writes none now:
//
//   - services/ws.js sendSystemMessage writes nothing without a thread, so
//     the one funnel every platform line goes through cannot reach a channel;
//   - a proposal's notices that were only ever posted to the channel now
//     name the proposal's own thread, so its story is not lost;
//   - db/migrate.js clearAutomatedChannelLines removes the lines written
//     before (the database half is in tests/communities-postgres.test.js).
//
// One exception, and only one (#4238): when a new project's first version
// is made, Homeroom bot says so in its channel, once, as its own message
// with an Open button (ws.sendFirstVersionMessage, called from
// homeroom-bot-dm.js announceFirstVersion and nowhere else).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function recordingPool() {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [{ id: 7, created_at: '2026-09-26T00:00:00Z' }] };
    },
  };
}

test('a platform line with no thread is written nowhere; one with a thread goes into it', async () => {
  const ws = require('../src/services/ws');
  const pool = recordingPool();
  assert.equal(await ws.sendSystemMessage(pool, 3, 'evan promoted PR #4: Dark mode for voting', 'vote',
    { vote: { sessionId: 12, prNumber: 4 } }), null);
  assert.equal(await ws.sendSystemMessage(pool, 3, 'Dark mode is live (PR #4).', 'system'), null);
  assert.equal(pool.queries.length, 0, 'not the app room, and not #general either');

  const row = await ws.sendSystemMessage(pool, 3, 'evan promoted PR #4: Dark mode for voting', 'vote',
    { vote: { sessionId: 12, prNumber: 4 } }, { type: 'session', ref: 12 });
  assert.deepEqual(row, { id: 7, createdAt: '2026-09-26T00:00:00Z' });
  assert.equal(pool.queries.length, 1);
  assert.match(pool.queries[0].sql, /INSERT INTO chat_messages \(app_id, content, msg_type, metadata, thread_type, thread_ref\)/);
  assert.deepEqual(pool.queries[0].params.slice(4), ['session', 12]);
});

test('#4238: the one channel line is the bot\'s first-version message, written once per project', async () => {
  const ws = require('../src/services/ws');
  const queries = [];
  let written = false;
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/^\s*INSERT INTO chat_messages/.test(sql)) {
        if (written) return { rows: [] };
        written = true;
        return { rows: [{ id: 9, created_at: '2026-10-07T00:00:00Z' }] };
      }
      return { rows: [] };
    },
  };
  const bot = { id: 42, username: 'homeroom_bot' };
  const action = { id: 'open_app', label: 'Open Page Turners', style: 'primary', type: 'open', target: '#app/page-turners/app' };
  const first = await ws.sendFirstVersionMessage(pool, 3, { user: bot, content: 'I\'ve made the first version of Page Turners!', metadata: { actions: [action] } });
  assert.deepEqual(first, { id: 9, createdAt: '2026-10-07T00:00:00Z' });
  const insert = queries.find((q) => /INSERT INTO chat_messages/.test(q.sql));
  assert.match(insert.sql, /INSERT INTO chat_messages \(app_id, user_id, content, msg_type, metadata\)\s+SELECT \$1, \$2, \$3, 'message', \$4::jsonb\s+WHERE NOT EXISTS/);
  assert.match(insert.sql, /thread_type IS NULL\s+AND metadata->>'kind' = 'first_version'/);
  assert.deepEqual(insert.params.slice(0, 2), [3, 42]);
  assert.deepEqual(JSON.parse(insert.params[3]), { actions: [action], kind: 'first_version' });
  assert.equal(await ws.sendFirstVersionMessage(pool, 3, { user: bot, content: 'again' }), null, 'once per project');
  assert.equal(await ws.sendFirstVersionMessage(pool, 3, { user: null, content: 'no author' }), null);

  // Nothing else in the services writes a channel line, and nothing else calls this.
  const services = fs.readdirSync(path.join(ROOT, 'src/services')).filter((f) => f.endsWith('.js'));
  const channelInserts = [];
  const callers = [];
  for (const f of services) {
    const src = read(`src/services/${f}`);
    for (const m of src.matchAll(/INSERT INTO chat_messages \(([^)]*)\)/g)) {
      if (!/thread_type/.test(m[1])) channelInserts.push(f);
    }
    if (f !== 'ws.js' && /sendFirstVersionMessage/.test(src)) callers.push(f);
  }
  assert.deepEqual(channelInserts, ['ws.js']);
  const wsSrc = read('src/services/ws.js');
  assert.equal((wsSrc.match(/INSERT INTO chat_messages \(app_id, user_id, content, msg_type, metadata\)\n/g) || []).length, 1);
  assert.deepEqual(callers, ['homeroom-bot-dm.js']);
  const dm = read('src/services/homeroom-bot-dm.js');
  assert.equal((dm.match(/sendFirstVersionMessage\(/g) || []).length, 1);
  assert.match(dm, /if \(requester\?\.firstVersion && !platform\) await announceFirstVersion\(pool, run, \{ live, deps \}\);/);
});

test('nothing routes a line into #general any more', () => {
  const ws = read('src/services/ws.js');
  const send = ws.slice(ws.indexOf('async function sendSystemMessage('));
  assert.match(send, /^async function sendSystemMessage\([^)]*\) \{\n {2}if \(!thread\) return null;\n/, 'the first thing it decides');
  for (const rel of ['src/services/ws.js', 'src/services/conversations.js']) {
    assert.doesNotMatch(read(rel), /postChannelEvent|generalEventProposal/, rel);
  }
  assert.doesNotMatch(read('src/services/conversations.js'), /INSERT INTO conversation_messages \(conversation_id, sender_id, content, msg_type, metadata\)\s*VALUES \(\$1, NULL/,
    'no sender-less row is written into a conversation');
});

test('a proposal\'s own notices that only ever went to the channel now go to its thread', () => {
  const thread = /'system', null, \{ type: 'session', ref: session\.id \}/;
  const votes = read('src/routes/votes.js');
  for (const lead of [
    'merged on GitHub, but the production deploy failed',
    'is closed on GitHub and couldn\'t be reopened',
    'hit a conflict with main during a merge attempt',
    'Failed to merge PR #',
    'Please open the revert PR manually.`,\n        \'system\'',
    'Most likely later commits depend on it.',
    'proposed undoing ${label}. Opened revert PR',
  ]) {
    const at = votes.indexOf(lead);
    assert.ok(at > 0, lead);
    assert.match(votes.slice(at, at + 700), thread, lead);
  }
  const lifecycle = read('src/services/session-lifecycle.js');
  assert.match(lifecycle, /await sendSystemMessage\(pool, session\.app_id, content, 'system', null, \{ type: 'session', ref: session\.id \}\);\n {4}\} catch \(err\) \{\n {6}log\.warn\('session-lifecycle', 'Failed to post PR-withdrawn chat message'/);
  assert.match(read('src/services/merge-queue.js'), /sendSystemMessage\(pool, session\.app_id, content, 'conflict', null, \{ type: 'session', ref: session\.id \}\)/);
  assert.match(read('src/services/rename-pr.js'), /\{ vote: \{ sessionId, prNumber: prData\.number \} \},\n {4}\{ type: 'session', ref: sessionId \}/);
  const fleet = read('src/services/fleet-maintenance.js');
  assert.match(fleet, /\{ vote: \{ sessionId, prNumber: prData\.number \} \},\n {4}\{ type: 'session', ref: sessionId \}/);
  assert.match(fleet, /'system', null, \{ type: 'governance', ref: campaign\.issue_id \}\);/, 'the campaign\'s tallies go to the decision that voted it');
});

test('the lines written before are cleared on boot, after the staging fixtures', () => {
  const migrate = read('src/db/migrate.js');
  const body = migrate.slice(migrate.indexOf('async function migrate(config) {'), migrate.indexOf('\n}\n', migrate.indexOf('async function migrate(config) {')));
  assert.ok(body.indexOf('await clearAutomatedChannelLines(pool);') > body.indexOf("finishPhase('stagingFixturesMs');"),
    'so a line a fixture wrote in the same boot goes too');
  assert.ok(body.indexOf('await clearAutomatedChannelLines(pool);') > body.indexOf('await backfillVotesRequired(pool);'),
    'and after the backfill that reads the merge announcements');
  assert.equal(typeof require('../src/db/migrate').clearAutomatedChannelLines, 'function');
  const clear = migrate.slice(migrate.indexOf('async function clearAutomatedChannelLines('));
  // The app channel: the main stream's sender-less platform rows only. A
  // thread's copy and a person's message are never in the set.
  assert.match(clear, /DELETE FROM chat_messages\s+WHERE user_id IS NULL AND thread_type IS NULL\s+AND msg_type IN \('system', 'vote', 'conflict'\)/);
  // #general: a read cursor on a removed line moves back first, a line
  // somebody answered in a thread is deleted in place, and the whole half is
  // one transaction.
  assert.match(clear, /JOIN conversations c ON c\.id = m\.conversation_id AND c\.kind = 'channel'/);
  assert.ok(clear.indexOf('SET last_read_message_id = (') < clear.indexOf('DELETE FROM conversation_messages WHERE id = ANY'));
  assert.match(clear, /UPDATE conversation_messages SET content = '', deleted_at = NOW\(\) WHERE id = ANY/);
  assert.match(clear, /await client\.query\('BEGIN'\);[\s\S]*await client\.query\('COMMIT'\);/);
});
