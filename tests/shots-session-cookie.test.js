'use strict';

// Since #6743 a preview's token exchange answers with two session cookies:
// the clearing unpartitioned Lax copy first, then the partitioned one that
// signs the reviewer in. The shots runner reads those headers itself (it
// reaches previews over plain HTTP, where Secure cookies are not kept) and
// used to take the first `session` cookie it found, so it read the clear and
// failed `invalid_session_cookie` before the agent ever started.
//
// These tests pin the read (skip a clear, use the last value set), the
// install through a staging-shaped answer, and the failure the machine
// stores when signing in is what stopped the run.
//
// Run with: node --test tests/shots-session-cookie.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SessionBootstrapError, sessionCookieValue, bootstrapInternalSession } =
  require('../worker/session-bootstrap');
const { shots, WORK } = require('../src/workflow/shots/machine.ts');

const CLEAR = { name: 'Set-Cookie', value: 'session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT' };
const SET = { name: 'Set-Cookie',
  value: 'session=abc; Path=/; HttpOnly; Secure; SameSite=None; Partitioned' };

// ── sessionCookieValue ──────────────────────────────────────────────────

test('a clear followed by a set uses the set value', () => {
  assert.equal(sessionCookieValue([CLEAR, SET]), 'abc');
});

test('two values set: the last one wins', () => {
  assert.equal(sessionCookieValue([
    { name: 'Set-Cookie', value: 'session=first; Path=/' },
    { name: 'Set-Cookie', value: 'session=last; Path=/' },
  ]), 'last');
});

test('Max-Age of 0 or less is a clear', () => {
  assert.equal(sessionCookieValue([
    { name: 'Set-Cookie', value: 'session=gone; Path=/; Max-Age=0' },
    SET,
  ]), 'abc');
  assert.equal(sessionCookieValue([{ name: 'Set-Cookie', value: 'session=gone; Path=/; Max-Age=-1' }]), null);
});

test('only a clear (or no session cookie at all) returns null', () => {
  assert.equal(sessionCookieValue([CLEAR]), null);
  assert.equal(sessionCookieValue([{ name: 'Set-Cookie', value: 'other=abc; Path=/' }]), null);
  assert.equal(sessionCookieValue([]), null);
  assert.equal(sessionCookieValue(undefined), null);
});

test('a clear followed by a malformed set value still throws, without the value', () => {
  for (const value of ['abc,def', 'a'.repeat(4097)]) {
    assert.throws(() => sessionCookieValue([
      CLEAR,
      { name: 'Set-Cookie', value: `session=${value}; Path=/` },
    ]), (error) => {
      assert.ok(error instanceof SessionBootstrapError);
      assert.equal(error.code, 'invalid_session_cookie');
      assert.doesNotMatch(error.message, new RegExp(value.slice(0, 20)));
      return true;
    });
  }
});

test('an attribute that does not parse is not a clear', () => {
  assert.equal(sessionCookieValue([
    { name: 'Set-Cookie', value: 'session=abc; Path=/; Max-Age=abc' },
  ]), 'abc');
  assert.equal(sessionCookieValue([
    { name: 'Set-Cookie', value: 'session=abc; Path=/; Expires=not a date' },
  ]), 'abc');
});

// ── Through the preview ─────────────────────────────────────────────────

test('bootstrapInternalSession installs the partitioned set value from a staging-shaped exchange', async () => {
  const origin = 'http://preview.onhomeroom.dev';
  const authorizedUrl = `${origin}/__preview/auth`;
  const cookies = [];
  const added = [];
  const context = {
    cookies: async () => (added.length ? [{ name: 'session', value: 'abc' }] : []),
    addCookies: async (values) => { added.push(...values); cookies.push(...values); },
    request: {
      get: async () => ({
        status: () => 200,
        headersArray: () => [
          { name: 'Content-Type', value: 'text/html' },
          CLEAR,
          SET,
        ],
        dispose: async () => {},
      }),
    },
  };
  const diagnostic = {};
  const result = await bootstrapInternalSession(context, origin, authorizedUrl, 'token', diagnostic);

  assert.equal(result, true);
  assert.deepEqual(added, [{ name: 'session', value: 'abc', url: origin, httpOnly: true, secure: false, sameSite: 'Lax' }]);
  assert.equal(diagnostic.sessionCookieInstalled, true);
});

// ── The stored failure and the page's words ─────────────────────────────
//
// The same machine paths tests/shots-merge-keeps-run.test.js drives.

const SHA = (c) => c.repeat(40);
const machine = shots({ execute: true, agentBudgetMs: 480000, runBudgetMs: 1440000 });
const now = new Date('2026-11-17T15:32:00Z');
const ctx = { now, key: 'session:42' };

function liveState() {
  const run = {
    id: 'run-1', n: 1, head: SHA('a'), base: SHA('0'), trigger: 'preview-ready', startedAt: '2026-11-17T15:29:00Z',
    busy: 0, died: 0, dispatches: 1, copiesAt: '2026-11-17T15:29:30Z', agentStartedAt: '2026-11-17T15:29:30Z',
    agentWaitUntil: null, platformRetry: false, afterOnly: false,
  };
  return { name: 'taking_shots', data: {
    sessionId: 42, appId: 10, appSlug: 'usernode-2d5619', declared: { intent: { version: 1 }, required: true },
    head: SHA('a'), run, last: null, n: 1, cleaning: [],
  } };
}
const facts = (status) => ({ session: { id: 42, appId: 10, appSlug: 'usernode-2d5619', status, source: null, head: SHA('a'),
  pins: { imported: null, reviewed: SHA('a'), handoff: null }, readyHeads: [SHA('a')], agentBusy: false,
  slot: { state: null, runId: null, detail: null, run: null }, temporaryWorker: false } });
const agentEvent = (result) => {
  const event = { id: 7, type: 'WorkSucceeded', payload: { sessionId: 42, kind: WORK.agent, workKey: 'agent:1:1', result },
    source: { kind: 'service', workId: 'w1' } };
  return event;
};
const apply = (s, e, f) => machine.entryFor(s.name, e.type).to(s, e, f, ctx);

function signInResult({ firstAtMs = {}, events } = {}) {
  return {
    agent: { outcome: 'failed', code: 'shots_agent_failed' },
    passed: false, skippedAny: false,
    trace: { agentActivity: { firstAtMs, events } },
  };
}

test('a run that failed signing in stores a sign-in failure naming the side, persona and code', () => {
  const out = apply(liveState(), agentEvent(signInResult({
    events: [{ kind: 'auth_bootstrap', outcome: 'error', side: 'base', persona: 'member',
      failureStage: 'exchange', failureCode: 'invalid_session_cookie', responseStatus: 200 }],
  })), facts('promoted'));

  assert.equal(out.next.name, 'failed');
  const moved = out.writes.find((w) => w.type === 'runMoved');
  assert.equal(moved.patch.failureCode, 'shots_sign_in_failed');
  assert.match(moved.patch.failureReason, /before copy/);
  assert.match(moved.patch.failureReason, /the member/);
  assert.match(moved.patch.failureReason, /invalid_session_cookie/);
  assert.doesNotMatch(moved.patch.failureReason, /shots agent/i);
  assert.equal(out.next.data.last.fault, 'agent_exit', 'the same one automatic retry as today');
  assert.equal(out.timer.event.type, 'RetryDue');
});

test('a sign-in failure after a tool started keeps the generic agent failure', () => {
  const out = apply(liveState(), agentEvent(signInResult({
    firstAtMs: { tool_start: 1200 },
    events: [{ kind: 'auth_bootstrap', outcome: 'error', side: 'base', persona: 'member', failureCode: 'invalid_session_cookie' }],
  })), facts('promoted'));

  const moved = out.writes.find((w) => w.type === 'runMoved');
  assert.equal(moved.patch.failureCode, 'shots_agent_failed');
});

test('an agent failure with no sign-in event keeps the generic agent failure', () => {
  const out = apply(liveState(), agentEvent(signInResult({
    events: [{ kind: 'tool_start', tool: 'get_brief' }],
  })), facts('promoted'));

  const moved = out.writes.find((w) => w.type === 'runMoved');
  assert.equal(moved.patch.failureCode, 'shots_agent_failed');
});

test('the change page shows a stored non-special failure reason under "Couldn’t take the screenshots"', () => {
  // The words are the server's; the card quotes failureReason after the
  // couldNotBecause message, whichever failed code it is.
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app-view.js'), 'utf8');
  const start = source.indexOf('_shotsSentence(shots, state');
  assert.ok(start > 0, '_shotsSentence is in the change page');
  const body = source.slice(start, source.indexOf('\n  },', start));
  assert.match(body, /e\.failureCode === 'shots_change_failed'/);
  assert.match(body, /couldNotBecause', \{ reason: quoted\(e\.failureReason\) \}/,
    'any other failed code quotes the stored reason');
});
