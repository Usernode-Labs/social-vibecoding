'use strict';

// 14 Oct 2026, newcomer run eight (iPhone Safari, Club Votes): the first
// version was built to the end and its proposal was refused, so the build
// ended "built but could not be proposed". The bell said "Stopped · Club
// Votes first version" and the build's thread said it, with Try again. But
// the project's own screens had no first version to say any more
// (services/homeroom-bot-dm.js firstVersionState answered null for a build
// that did not succeed): the App tab framed the starter template the repo was
// made from ("Welcome to your new app! Everything on this screen is
// placeholder content…"), and the hub card and the Home tile said nothing.
//
// Pinned here: the state says `stopped` (line and flag) with where its maker
// was told, until Try again starts it over; the routes hand the thread to
// the maker alone; the hub card says Stopped with Try again for its maker;
// the Home tile says Stopped. The App tab's half is in
// tests/app-status-placeholder.test.js; the words of every stop in
// tests/build-failed-words-everywhere.test.js.
//
// Run with: node --test tests/first-version-stopped.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dm = require('../src/services/homeroom-bot-dm');
const progress = require('../src/services/homeroom-bot-progress');
const fvScreens = require('../src/services/first-version-screens');
const { hubFirstVersion, stoppedThread } = require('../src/routes/apps');
const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const UNPROPOSED = 'the change was built but could not be proposed: Server is restarting';

// A first version's request row (homeroom-bot-progress.js requestRows) whose
// newest look went ahead and whose build came to nothing.
const STOPPED_ROW = {
  app_id: 5, issue_number: 1, mode: 'live', verdict: 'ready', build_ok: false, build_error: UNPROPOSED,
  build_session_id: 88, run_id: 2027, proposal_status: null, request_closed: false, queue_id: null,
};

test('firstVersionStopped: a build that came to nothing, on an open request, with nothing up or live', () => {
  assert.equal(progress.firstVersionStopped(STOPPED_ROW), true, 'built and not proposed');
  for (const error of ['the build ran past its time limit', 'the build turn failed (exit 1)', null]) {
    assert.equal(progress.firstVersionStopped({ ...STOPPED_ROW, build_error: error }), true, String(error));
  }
  // Not stopped.
  assert.equal(progress.firstVersionStopped({ ...STOPPED_ROW, build_ok: null }), false, 'still under way');
  assert.equal(progress.firstVersionStopped({ ...STOPPED_ROW, build_ok: true }), false, 'built');
  assert.equal(progress.firstVersionStopped({ ...STOPPED_ROW, build_error: 'skipped: its request was closed' }), false,
    'a skip: its request was answered or closed meanwhile');
  assert.equal(progress.firstVersionStopped({ ...STOPPED_ROW, build_error: 'blocked: needs a payment provider' }), false,
    'found impossible as written: it asks for detail instead');
  assert.equal(progress.firstVersionStopped({ ...STOPPED_ROW, request_closed: true }), false, 'its request was closed');
  for (const status of ['promoted', 'merging', 'merged']) {
    assert.equal(progress.firstVersionStopped({ ...STOPPED_ROW, proposal_status: status }), false, status);
  }
  assert.equal(progress.firstVersionStopped({ ...STOPPED_ROW, proposal_status: 'closed' }), true,
    'an earlier proposal closed, and the newest build stopped');
  assert.equal(progress.firstVersionStopped({ ...STOPPED_ROW, verdict: 'person' }), false, 'left to the group');
  assert.equal(progress.firstVersionStopped({ ...STOPPED_ROW, mode: 'shadow' }), false);
  assert.equal(progress.firstVersionStopped(null), false);
  // No stage is the stopped line: it is said apart.
  assert.ok(progress.BUILD_LINE_STATES.includes('stopped'));
  for (const stage of Object.keys({ queued: 1, reading: 1, planning: 1, building: 1, checks: 1, vote: 1 })) {
    assert.notEqual(progress.buildLineOf(stage), 'stopped', stage);
  }
});

// ── firstVersionState ────────────────────────────────────────────────────

const FV_ROW = {
  app_id: 5, user_id: 7, status: 'filed', issue_number: 1, merged: false, created_at: '2026-10-14T09:00:00Z',
  slug: 'club-votes', name: 'Club Votes', app_status: 'running', username: 'ada', conversation_id: 12,
};

function fakePool({ said = null, throws = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/FROM homeroom_bot_first_versions f/.test(String(sql))) return { rows: [FV_ROW] };
      if (/FROM homeroom_bot_dm_messages d/.test(String(sql))) {
        if (throws) throw new Error('read failed');
        return { rows: said ? [said] : [] };
      }
      return { rows: [] };
    },
  };
}

async function stateFor(row, { state = null, said = null, throws = false, viewerId = 7 } = {}) {
  const pool = fakePool({ said, throws });
  const out = await dm.firstVersionState(pool, 5, {
    viewerId,
    progress: { ...progress, requestStates: async () => [{ row, state }] },
  });
  return { state: out, pool };
}

test('firstVersionState: a build that stopped says so, with where its maker was told', async () => {
  const said = { message_id: 901, conversation_id: 12, thread_root_id: 880 };
  const { state, pool } = await stateFor(STOPPED_ROW, { said });
  assert.deepEqual(state, {
    userId: 7, creator: 'ada', conversationId: 12,
    step: 4, of: 7, line: 'stopped', question: false, ready: false,
    stopped: { conversationId: 12, messageId: 901, threadRootId: 880 },
  });
  const asked = pool.calls.find((c) => /FROM homeroom_bot_dm_messages d/.test(c.sql));
  assert.deepEqual(asked.params, [7, 5, 1], 'its maker\'s message about this request');
  assert.match(asked.sql, /d\.kind = 'build_failed'/);
  assert.match(asked.sql, /m\.deleted_at IS NULL/);
  assert.match(asked.sql, /ORDER BY d\.message_id DESC\s+LIMIT 1/, 'the newest');
  // Said in the main chat, not a thread: the message itself.
  assert.deepEqual((await stateFor(STOPPED_ROW, { said: { ...said, thread_root_id: null } })).state.stopped,
    { conversationId: 12, messageId: 901, threadRootId: null });
  // Never said in their chat, or a read that fails: still stopped, with no message to point at.
  assert.deepEqual((await stateFor(STOPPED_ROW)).state.stopped, {});
  const failed = await stateFor(STOPPED_ROW, { said, throws: true });
  assert.equal(failed.state.line, 'stopped');
  assert.deepEqual(failed.state.stopped, {});
  // Everyone reads Stopped, the maker and anybody else.
  assert.equal((await stateFor(STOPPED_ROW, { said, viewerId: 9 })).state.line, 'stopped');
  // Nothing is under way: no phase and no steps to list.
  assert.equal(state.phase, undefined);
  assert.equal(state.steps, undefined);
});

test('firstVersionState: anything else that ended it is still no state, and Try again puts it back on its way', async () => {
  for (const build_error of ['skipped: its request was closed', 'blocked: needs a payment provider']) {
    assert.equal((await stateFor({ ...STOPPED_ROW, build_error })).state, null, build_error);
  }
  assert.equal((await stateFor({ ...STOPPED_ROW, verdict: 'person', build_ok: null })).state, null, 'left to the group');
  // Try again (homeroom-bot-mayor.js start_request) puts it first in the
  // bot's queue: it is read again, not stopped (the queue row is its stage).
  const queued = await stateFor({ ...STOPPED_ROW, queue_id: 3 }, { state: { stage: 'queued', since: '2026-10-14T10:00:00Z' } });
  assert.equal(queued.state.line, 'planning');
  assert.equal(queued.state.stopped, undefined);
});

// ── The routes ───────────────────────────────────────────────────────────

const STATE = {
  userId: 7, creator: 'ada', conversationId: 12, step: 4, of: 7, line: 'stopped', question: false, ready: false,
  stopped: { conversationId: 12, messageId: 901, threadRootId: 880 },
};

test('stoppedThread: the build\'s thread, else the message, else the maker\'s chat', () => {
  assert.deepEqual(stoppedThread(STATE), { conversationId: 12, threadRootId: 880, messageId: 901 });
  assert.deepEqual(stoppedThread({ ...STATE, stopped: {} }), { conversationId: 12, threadRootId: null, messageId: null },
    'never said in their chat: the chat itself');
  assert.deepEqual(stoppedThread({ ...STATE, conversationId: null, stopped: {} }), { conversationId: null, threadRootId: null, messageId: null });
  assert.deepEqual(stoppedThread({ ...STATE, stopped: { conversationId: 'x', threadRootId: -1, messageId: 0 } }),
    { conversationId: 12, threadRootId: null, messageId: null });
});

test('the hub: Stopped for everyone, and where Try again is for its maker alone', () => {
  assert.deepEqual(hubFirstVersion(STATE, 7, { member: true }), {
    step: 4, of: 7, line: 'stopped', phase: null, ready: false, mine: true, creator: 'ada', waits_on: null,
    conversation_id: 12, session_id: null, plan: null,
    stopped: true, thread: { conversationId: 12, threadRootId: 880, messageId: 901 },
  });
  const member = hubFirstVersion({ ...STATE, chosenPlan: { bullets: ['A ballot'], questions: [] } }, 9, { member: true });
  assert.equal(member.stopped, true);
  assert.equal(member.thread, null, 'somebody else\'s chat is never handed out');
  assert.equal(member.conversation_id, null);
  assert.equal(member.plan, null, 'no plan being built to read');
});

test('GET /api/apps/:slug: stopped, the thread for its maker, and no "While you wait"', () => {
  const src = read('src/routes/apps.js');
  assert.match(src, /\.\.\.\(!mine && !state\.ready && !state\.stopped \? await waitingMemberFields\(/);
  assert.match(src, /\.\.\.\(state\.stopped \? \{ stopped: true, \.\.\.\(mine \? \{ thread: stoppedThread\(state\) \} : \{\}\) \} : \{\}\),/);
  // The Home tile reads the same line from the list (firstVersionLinesFor).
  assert.match(src, /const line = state && \(state\.line \|\| \(state\.ready \? 'ready' : 'planning'\)\);/);
});

test('the first look stays on its card when its build stopped, never the starter', () => {
  const look = { count: 1, at: '2026-10-14T09:30:00Z' };
  const real = { count: 3, at: '2026-10-14T09:50:00Z' };
  const both = fvScreens.firstVersionShowcase({ caption: 'Adding the ballot', screens: { first_look: look, real } }, 'stopped');
  assert.deepEqual(both, { screens: { kind: 'first_look', count: 1, at: look.at, v: String(Date.parse(look.at)) } },
    'the first look, as while it was built; no caption: nothing is being added');
  assert.equal(fvScreens.firstVersionShowcase({ screens: { real } }, 'stopped').screens.kind, 'real', 'else the screens it got to');
  assert.deepEqual(fvScreens.firstVersionShowcase({ screens: {} }, 'stopped'), {});
  // Live is not offered: nothing is being built.
  assert.match(read('src/routes/apps.js'), /if \(line !== 'building' && !\(held && !realScreens\)\) return \{\};/);
});

// ── The hub card ─────────────────────────────────────────────────────────

const hub = loadTsx('frontend/src/features/dev-board/workshop/hub-cards.tsx');

const stoppedFv = (over = {}) => ({
  step: 4, of: 7, line: 'stopped', phase: null, ready: false, mine: true, creator: 'ada', waits_on: null,
  conversation_id: 12, session_id: null, plan: null, stopped: true,
  thread: { conversationId: 12, threadRootId: 880, messageId: 901 }, ...over,
});

const hubCard = (fv) => renderToHtml(createElement(hub.FirstVersionCard, {
  slug: 'club-votes',
  data: {
    slug: 'club-votes', name: 'Club Votes', member_count: 2, is_member: true, is_creator: fv.mine, audience: 'invited',
    audience_label: 'Private community', members: [], channel: null, first_version: fv,
  },
}));

test('the hub card says Stopped; its maker gets Try again beside it, which opens the build\'s thread', () => {
  assert.equal(hub.firstVersionAction(stoppedFv()), 'retry');
  assert.equal(hub.firstVersionAction(stoppedFv({ mine: false, thread: null, conversation_id: null })), null);
  const mine = hubCard(stoppedFv());
  assert.match(mine, /data-ws-first-version="stopped"/);
  assert.match(mine, /<span role="status" data-build-line="stopped"[^>]*>.*>Stopped<\/span><\/span>/,
    'the line stays with the button: the button does not say it stopped');
  assert.doesNotMatch(mine, /animate-spin/, 'nothing turns');
  assert.match(mine, /<button type="button" data-ws-first-version-action="retry" class="w-full rounded-full bg-violet-600[^"]*">Try again<\/button><\/section>$/);
  assert.equal(message('project:hub.firstVersion.tryAgain'), 'Try again');
  const member = hubCard(stoppedFv({ mine: false, thread: null, conversation_id: null }));
  assert.match(member, /data-build-line="stopped"[^>]*>.*>Stopped</);
  assert.doesNotMatch(member, /<button|Try again/, 'nobody else can start it again');
  // Its press is the App tab's own opener.
  const src = read('frontend/src/features/dev-board/workshop/hub-cards.tsx');
  assert.match(src, /\} else if \(action === 'retry'\) \{[\s\S]*?\(window as any\)\.AppView\?\.openFirstVersionThread\?\.\(slug, thread\?\.conversationId \?\? fv\.conversation_id \?\? null,\s*thread\?\.threadRootId \?\? null, thread\?\.messageId \?\? null\);/);
  // No "first look" card under Share it: that one is for a build on its way.
  assert.equal(hub.hubShowsFirstLook(stoppedFv()), false);
});

// ── The Home tile ────────────────────────────────────────────────────────

test('the Home tile says Stopped, in the attention colour', () => {
  const HOME = read('frontend/src/features/home/home.js');
  const tileBuildLine = HOME.match(/  tileBuildLine\(app\) \{[\s\S]*?\n {2}\},/);
  const tileBuildStage = HOME.match(/  tileBuildStage\(app\) \{[\s\S]*?\n {2}\},/);
  const WORDS = read('frontend/src/features/first-session/build-line-words.js').replace(/^export\s+/gm, '');
  const Home = vm.runInNewContext(`${WORDS}\nvar Home = { ${tileBuildLine[0].trim()} ${tileBuildStage[0].trim().replace(/,$/, '')} }; ({ Home, buildLineTileWordsOf, buildLineTileClass })`, {});
  const line = Home.Home.tileBuildLine({ slug: 'club-votes', status: 'running', first_version_line: 'stopped' });
  assert.equal(line, 'stopped', 'its app runs (the starter): the tile still says where its first version is');
  assert.equal(message(Home.buildLineTileWordsOf(line, null)), 'Stopped');
  assert.equal(Home.buildLineTileClass(line), 'app-card-status line-clamp-1 text-[color:var(--state-attention)]');
});
