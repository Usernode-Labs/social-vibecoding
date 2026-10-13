'use strict';

// #3755: an agent chat notices its change's failing checks, and offers to fix
// them (frontend/src/features/agent-session/fix-checks.ts).
//
// The staging card said "1 check failing" in its corner and the conversation
// said nothing, so the person had to type "fix the failing check" for the
// Mayor to look. Now:
//
//   1. WHEN. The active change's verdict is failing, nothing is working, and
//      the person has not said anything since that run's verdict: one offer
//      per run. Running checks, a pass, a closed change, a busy turn or an
//      unsent message hide it; a new failing run offers again.
//   2. WHAT. The card names the checks and what each reported, with Fix it
//      and See checks. Fix it sends the Mayor the ask, in the person's name,
//      with the checks; nothing starts without the tap.
//   3. WHERE FROM. The session read carries the failing checks by name
//      (services/agent-sessions.js); tests/agent-sessions-postgres.test.js
//      runs that SQL.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { withStateRead } = require('./lib/agent-session-state-read');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const fix = loadTsx('frontend/src/features/agent-session/fix-checks.ts');

const AT = '2026-10-03T11:00:00.000Z';
const change = (over = {}) => ({
  id: 88, appSlug: 'todo-list', appName: 'Todo list', status: 'active', title: 'Done section', prNumber: 88,
  checkState: 'failing', checkFailing: 1,
  failingChecks: {
    at: AT,
    total: 1,
    checks: [{ name: 'A checked item renders in its own completed section', reason: 'Expected .done-items li, found none' }],
  },
  ...over,
});
const message = (id, role, createdAt, content = 'x') => ({ id, role, content, metadata: {}, changeId: null, createdAt });
const offerFor = (over = {}) => fix.fixChecksOffer({ change: change(), busy: false, messages: [], ...over });

test('a failing run is offered once the conversation is idle, and never while checks run or after they pass', () => {
  const offer = offerFor({
    messages: [
      message(1, 'user', '2026-10-03T10:50:00.000Z', 'Move checked items to their own section'),
      message(2, 'assistant', '2026-10-03T10:58:00.000Z', 'Done, 44/44 tests pass.'),
    ],
  });
  assert.deepEqual(offer, {
    key: `88:${AT}`,
    changeId: 88,
    prNumber: 88,
    total: 1,
    checks: [{ name: 'A checked item renders in its own completed section', reason: 'Expected .done-items li, found none' }],
  }, 'the Mayor said its piece before the checks settled: the chat still has to say they failed');

  for (const checkState of ['pending', 'running', 'passing', 'skipped', 'error', null]) {
    assert.equal(offerFor({ change: change({ checkState }) }), null, `${checkState}: nothing to fix (yet)`);
  }
  assert.equal(offerFor({ busy: true }), null, 'the Mayor or a build is working: it waits');
  assert.equal(offerFor({ unsent: 1 }), null, 'a message on its way already answers it');
  for (const status of ['merging', 'merged', 'archived']) {
    assert.equal(offerFor({ change: change({ status }) }), null, `${status}: no more work on it`);
  }
  for (const status of ['active', 'paused', 'promoted']) {
    assert.ok(offerFor({ change: change({ status }) }), `${status}: still open to a fix`);
  }
  assert.equal(offerFor({ change: null }), null);
  assert.equal(offerFor({ change: change({ failingChecks: null }) }), null, 'no names read: nothing to say');
  assert.equal(offerFor({ change: change({ failingChecks: { at: AT, total: 1, checks: [] } }) }), null);
  assert.equal(offerFor({ change: change({ failingChecks: { at: null, total: 1, checks: change().failingChecks.checks } }) }), null,
    'without the run\'s time it could not be told apart from the last one');
});

test('one offer per run: anything the person says after the verdict answers it, and the next run asks again', () => {
  const after = [message(3, 'user', '2026-10-03T11:00:05.000Z', 'Please fix the failing check on PR #88.')];
  assert.equal(offerFor({ messages: after }), null, 'Fix it was tapped (or the person typed): it does not come back');
  assert.equal(offerFor({ messages: [message(4, 'user', AT, 'same instant')] }), null);
  assert.ok(offerFor({ messages: [message(5, 'assistant', '2026-10-03T11:05:00.000Z')] }),
    'only the person answers it: a Mayor reply after the verdict does not');
  assert.ok(offerFor({ messages: [message(6, 'system', '2026-10-03T11:05:00.000Z', 'Staging deployed!')] }), 'nor a platform line');
  const rerun = change({ failingChecks: { ...change().failingChecks, at: '2026-10-03T11:20:00.000Z' } });
  const again = fix.fixChecksOffer({ change: rerun, busy: false, messages: after });
  assert.equal(again.key, '88:2026-10-03T11:20:00.000Z', 'a new failing run is a new offer');
});

test('Fix it asks for the fix with each check and what it reported; the heading counts them', () => {
  const one = offerFor();
  assert.equal(fix.fixChecksHeading(one), '1 check failed on PR #88');
  assert.equal(fix.fixChecksMessage(one), [
    'Please fix the failing check on PR #88.',
    '',
    '- "A checked item renders in its own completed section", which reported: Expected .done-items li, found none',
  ].join('\n'));

  const many = fix.fixChecksOffer({
    change: change({
      prNumber: null,
      failingChecks: {
        at: AT,
        total: 4,
        checks: [
          { name: 'Home loads', reason: 'TypeError:\n  x is undefined\n    at main.js:3' },
          { name: 'Settings', reason: '' },
          { name: 'Long', reason: 'y'.repeat(500) },
        ],
      },
    }),
    busy: false,
    messages: [],
  });
  assert.equal(fix.fixChecksHeading(many), '4 checks failed on this change', 'before it has a pull request');
  const text = fix.fixChecksMessage(many);
  const lines = text.split('\n');
  assert.equal(lines[0], 'Please fix the 4 failing checks on this change.');
  assert.equal(lines[2], '- "Home loads", which reported: TypeError: x is undefined at main.js:3', 'one line per check');
  assert.equal(lines[3], '- "Settings"', 'nothing reported, nothing said');
  assert.ok(lines[4].length < 300 && lines[4].endsWith('…'), 'a long report is clipped');
  assert.equal(lines[5], '- and 1 more');
  assert.doesNotMatch(text, /—/, 'no em dash in words a person sends');
});

test('the card names the checks, says why it matters, and offers Fix it and See checks', () => {
  const api = loadTsx('tests/fixtures/agent-session-api.ts');
  const html = renderToHtml(createElement(api.FixChecksCardView, { offer: offerFor() }));
  assert.match(html, /<section[^>]*aria-label="Failing checks"[^>]*data-agent-session-fix-checks="88"/);
  assert.match(html, /data-agent-session-fix-checks-heading[^>]*>1 check failed on PR #88</);
  assert.match(html, /data-agent-session-fix-check[^>]*><p[^>]*>A checked item renders in its own completed section<\/p><p[^>]*>Expected \.done-items li, found none<\/p>/);
  assert.match(html, />Checks have to pass before the change can merge\. The agent can read what failed and fix it\.</);
  assert.match(html, /<button[^>]*data-agent-session-fix-checks-go[^>]*>Fix it<\/button><button[^>]*data-agent-session-fix-checks-see[^>]*>See checks<\/button>/);
  assert.doesNotMatch(html, /disabled=""/, 'ready to tap');
  assert.doesNotMatch(html, /more\./);

  const asking = renderToHtml(createElement(api.FixChecksCardView, {
    offer: { ...offerFor(), total: 3 },
    asking: true,
  }));
  assert.match(asking, /disabled=""[^>]*data-agent-session-fix-checks-go|data-agent-session-fix-checks-go[^>]*disabled=""/, 'one tap, one ask');
  assert.match(asking, /animate-spin/);
  assert.match(asking, />And 2 more\.</);
  assert.match(asking, />3 checks failed on PR #88</);
});

// A static render reads the store's initial state (useSyncExternalStore's
// server snapshot), so this follows the panel's inputs through the store
// instead: what a read brings in, then what a send does to them.
test('the conversation\'s own read carries the offer, and Fix it sends the ask as the person\'s message', async () => {
  const sent = [];
  const session = {
    id: 7, title: 'Done section', status: 'open', focusApp: null, focusContext: {}, busy: false,
    activeChange: change(), changes: [], lastActivityAt: null, createdAt: null,
  };
  const messages = [
    message(1, 'user', '2026-10-03T10:50:00.000Z', 'Move checked items to their own section'),
    message(2, 'assistant', '2026-10-03T10:58:00.000Z', 'Done, 44/44 tests pass.'),
  ];
  globalThis.window = { location: { hash: '' }, App: { setHeaderTitle() {} }, UsernodeReact: {}, PlatformUI: { toast() {} } };
  globalThis.EventSource = class { close() {} };
  globalThis.fetch = withStateRead(async (url, init = {}) => {
    if ((init.method || 'GET') === 'POST' && /\/api\/agent-sessions\/7\/turns$/.test(url)) {
      sent.push(JSON.parse(init.body).message);
      return { ok: false, status: 400, headers: { get: () => 'application/json' }, json: async () => ({ error: 'no model in a test' }) };
    }
    const body = /\/messages\?/.test(url) ? { messages, nextAfter: null }
      : /\/actions$/.test(url) ? { actions: [] }
        : /\/drafts$/.test(url) ? { drafts: [] }
          : /\/api\/agent-sessions$/.test(url) ? { sessions: [session] }
            : { session, turn: null };
    return { ok: true, status: 200, json: async () => body };
  });
  try {
    const api = loadTsx('tests/fixtures/agent-session-api.ts');
    await api.openAgentSession({ id: 7, host: 'messages' });
    // The panel's own inputs (AgentSessionPanel's fixOffer).
    const panelOffer = (s) => fix.fixChecksOffer({
      change: s.session?.activeChange,
      busy: s.turn.running || !!s.session?.busy,
      messages: s.messages,
      unsent: s.outbox.length,
    });
    const before = api.getAgentSessionState();
    assert.equal(before.phase, 'ready');
    assert.deepEqual(panelOffer(before), offerFor(), 'the read carries the failing checks to the offer');

    const sending = api.sendAgentMessage(fix.fixChecksMessage(panelOffer(before)));
    assert.equal(panelOffer(api.getAgentSessionState()), null, 'asked once: the offer is gone the moment the ask leaves');
    await sending;
    assert.equal(sent.length, 1, 'the tap is one send, through the route the box uses');
    assert.match(sent[0], /^Please fix the failing check on PR #88\.\n\n- "A checked item renders in its own completed section", which reported: /);
    assert.equal(panelOffer(api.getAgentSessionState()), null, 'a refused ask stays in the conversation, Not sent, with Retry: still no second offer');
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
    delete globalThis.EventSource;
  }
});

test('the session read shapes the failing checks it is handed, and reads them only while failing', async () => {
  const agentSessions = require('../src/services/agent-sessions');
  const calls = [];
  const head = {
    id: 7, user_id: 4, title: 't', title_source: 'auto', status: 'open', change_id: 88, change_status: 'active',
    change_app_slug: 'todo-list', change_check_state: 'failing', change_check_failing: 2,
    change_checks_at: new Date(AT),
    change_failing_checks: {
      total: 2,
      checks: [{ name: ' Done section ', reason: ' none found ' }, { name: '', reason: 'nameless' }, { name: 'No reason', reason: null }],
    },
  };
  const pool = {
    async query(sql) {
      calls.push(sql);
      if (/FROM agent_sessions s/.test(sql)) return { rows: [head] };
      if (/FROM chat_sessions c JOIN apps a/.test(sql)) return { rows: [{ change_id: 88, change_status: 'active', change_check_state: 'failing' }] };
      return { rows: [] };
    },
  };
  const session = await agentSessions.getAgentSession(pool, { userId: 4, id: 7 });
  assert.deepEqual(session.activeChange.failingChecks, {
    at: AT, total: 2, checks: [{ name: 'Done section', reason: 'none found' }, { name: 'No reason', reason: '' }],
  }, 'a row without a name is dropped; text is trimmed');
  assert.equal(session.changes[0].failingChecks, null, 'the changes list reads none');
  assert.match(calls[0], /CASE WHEN c\.check_state = 'failing' THEN \(/, 'read only for a failing verdict');
  assert.match(calls[0], /COALESCE\(e\.t->>'status', ''\) <> 'pass'\s+AND COALESCE\(e\.t->>'advisory', 'false'\) <> 'true'/,
    'the merge gate\'s own kind of failure (visuals.classifyTests)');
  assert.match(calls[0], /WHERE f\.k <= 5/);
  assert.match(calls[1], /FROM chat_sessions c JOIN apps a/);
  assert.doesNotMatch(calls[1], /change_failing_checks/, 'nor does the changes list ask for them');

  head.change_failing_checks = null;
  assert.equal((await agentSessions.getAgentSession(pool, { userId: 4, id: 7 })).activeChange.failingChecks, null);
  head.change_failing_checks = { total: null, checks: null };
  assert.equal((await agentSessions.getAgentSession(pool, { userId: 4, id: 7 })).activeChange.failingChecks, null,
    'a failing verdict with no blocking row (an odd legacy one) offers nothing');
});

test('the panel decides with the pure rule, from what it already reads', () => {
  const panel = read('frontend/src/features/agent-session/index.tsx');
  assert.match(panel, /fixChecksOffer\(\{\s*change: snapshot\.session\?\.activeChange,\s*busy: snapshot\.running \|\| !!snapshot\.session\?\.busy,\s*messages: snapshot\.messages,\s*unsent: snapshot\.outbox,\s*\}\)/);
  assert.match(panel, /<LiveTurn runShown=\{runShown\} \/>\s*\{fixOffer \? <FixChecksCard key=\{fixOffer\.key\} offer=\{fixOffer\} \/> : null\}/,
    'at the conversation\'s end, one card per run');
  assert.match(panel, /count=\{items\.length \+ \(fixOffer \? 1 : 0\)\}/, 'a reader at the bottom stays there when it appears');
  assert.match(panel, /void sendAgentMessage\(fixChecksMessage\(offer\)\);/, 'nothing starts without the tap');
});
