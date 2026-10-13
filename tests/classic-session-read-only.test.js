'use strict';

// #3976: classic dev sessions are read-only (src/services/classic-sessions.js).
//
// #2779 closed CREATING a classic session (a change whose dev chat is its
// own); this closes CONTINUING one. Pinned here:
//
//   1. which rows are classic, decided once, by one function;
//   2. the routes that would run more work in a classic chat refuse it with
//      409 `classic_session_read_only` (the chat, an attachment for it, the
//      coding agent and model, the venue), and a paused one is refused rather
//      than resumed first;
//   3. everything about the proposal it became stays open: none of those
//      routes reads the predicate;
//   4. GET /api/sessions/:id says which sessions are read-only, from the same
//      function, and the dev chat puts its composer away for them, says why
//      and offers an agent session on the same app.
//
// Run with: node --test tests/classic-session-read-only.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The route tests below drive the real routes over a recording pool, the
// tests/chat-repo-less-turn.test.js harness: the override has to be in place
// before src/routes/sessions.js is required, because it takes getPool by name.
const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
let capturedQueries = [];
poolMod.getPool = () => ({
  query: (sql, params) => {
    capturedQueries.push({ sql: String(sql), params });
    return poolQueryHandler(String(sql), params);
  },
});
const limits = require('../src/services/limits');
let billingCalls = 0;
limits.resolveBillingPath = async () => { billingCalls += 1; return { apiKey: null }; };

const classic = require('../src/services/classic-sessions');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const SESSIONS_SRC = read('src/routes/sessions.js');
const VOTES_SRC = read('src/routes/votes.js');
const DEV_CHAT_SRC = read('frontend', 'src', 'features', 'dev-chat', 'dev-chat.js');

// One route's handler: from its `router.<method>(` to the next route.
function routeBody(src, method, route) {
  const escaped = route.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const found = new RegExp(`router\\.${method}\\(\\s*'${escaped}'`).exec(src);
  assert.ok(found, `${method.toUpperCase()} ${route} exists`);
  const at = found.index;
  const next = src.indexOf('\n  router.', at + 1);
  return src.slice(at, next === -1 ? undefined : next);
}

// ── 1. Which rows ───────────────────────────────────────────────────────

test('a classic session is a change whose chat is its own', () => {
  const row = (over) => ({ agent_session_id: null, is_headless: false, source: null, ...over });
  // Created by the browser before #2779.
  assert.equal(classic.isClassicSession(row()), true);
  assert.equal(classic.isClassicSession(row({ agent_session_id: undefined })), true,
    'a row read without the column is still a classic one');
  // Not classic: an agent session's change (revised in its conversation),
  // a headless run and an imported pull request (no chat at all).
  assert.equal(classic.isClassicSession(row({ agent_session_id: 12 })), false);
  assert.equal(classic.isClassicSession(row({ is_headless: true })), false);
  assert.equal(classic.isClassicSession(row({ source: 'imported' })), false);
  // Not old sessions: rows still created today, whose web chat stays open.
  // A CLI hand-off's local and web turns may alternate (proposal_start), and
  // a request's planning record is revised where it was posted.
  assert.equal(classic.isClassicSession(row({ source: 'cli_handoff' })), false);
  assert.equal(classic.isClassicSession(row({ source: 'request_spec' })), false);
  for (const nothing of [null, undefined, 'x', 7]) {
    assert.equal(classic.isClassicSession(nothing), false);
  }
});

test('the refusal is one 409 body that says where to go instead', () => {
  const body = classic.refusal();
  assert.equal(body.code, 'classic_session_read_only');
  assert.equal(body.code, classic.CODE);
  assert.match(body.error, /older session/);
  assert.match(body.error, /agent session/);
  assert.doesNotMatch(body.error, /—/, 'no em dash in copy');
  assert.notEqual(classic.refusal(), body, 'a fresh object per answer');
});

test('loadOwned reads the owner\'s row, and only what the predicate needs', async () => {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: params[0] === 5 ? [{ id: 5, agent_session_id: null, is_headless: false, source: null }] : [] };
    },
  };
  assert.equal(classic.isClassicSession(await classic.loadOwned(pool, 5, 9)), true);
  assert.equal(await classic.loadOwned(pool, 6, 9), null, 'not theirs, so not refused here either');
  assert.match(calls[0].sql, /WHERE id = \$1 AND user_id = \$2/);
  assert.deepEqual(calls[0].params, [5, 9]);
});

// ── 2. What is refused ──────────────────────────────────────────────────

test('the chat refuses a classic session, and never resumes a paused one first', () => {
  const body = routeBody(SESSIONS_SRC, 'post', '/api/sessions/:id/chat');
  // Paused: refused for what it is. The resume this branch used to run
  // (#2779 follow-up) spent a slot on a session that takes no message.
  assert.match(body,
    /if \(pausedRows\.length && classicSessions\.isClassicSession\(pausedRows\[0\]\)\) \{\s*return res\.status\(409\)\.json\(classicSessions\.refusal\(\)\);/);
  assert.doesNotMatch(body, /resumePausedSession\(/, 'a message no longer resumes anything');
  // Active or promoted: refused after the duplicate lookup, so a retry of a
  // message stored before this landed still learns it was received, and
  // before anything is billed or stored.
  const refusal = body.indexOf('if (classicSessions.isClassicSession(session)) {');
  assert.ok(refusal > 0, 'the loaded session is refused');
  assert.ok(body.indexOf('chatDelivery.answerDuplicate(res, delivery)') < refusal);
  assert.ok(refusal < body.indexOf('limits.resolveBillingPath('), 'nothing is billed');
  assert.ok(refusal < body.indexOf("INSERT INTO chat_session_messages"), 'nothing is stored');
  // An agent session's change keeps its own answer, which names the
  // conversation to continue in.
  assert.ok(body.indexOf('agentSessionId: session.agent_session_id') < refusal);
});

test('an attachment, the coding agent and the venue are refused too', () => {
  const attach = routeBody(SESSIONS_SRC, 'post', '/api/sessions/:id/attachments');
  assert.match(attach, /classicSessions\.isClassicSession\(sessionRows\[0\]\)/);
  assert.ok(attach.indexOf('classicSessions.refusal()') < attach.indexOf('INSERT INTO chat_session_attachments'),
    'refused before a byte is stored');

  const reset = routeBody(SESSIONS_SRC, 'post', '/api/sessions/:id/reset-agent-context');
  const resetAt = reset.indexOf('classicSessions.refusal()');
  assert.ok(resetAt > 0);
  assert.ok(resetAt < reset.indexOf('resolveDefaultAgentPreference('),
    'ahead of the resolvers, which can provision a key over the network');

  const venue = routeBody(SESSIONS_SRC, 'post', '/api/sessions/:id/build-venue');
  const venueAt = venue.indexOf('classicSessions.refusal()');
  assert.ok(venueAt > 0);
  assert.ok(venueAt < venue.indexOf('UPDATE chat_sessions'));
  for (const b of [reset, venue]) {
    assert.match(b, /classicSessions\.isClassicSession\(\s*await classicSessions\.loadOwned\(pool, sessionId, req\.user\.id\),?\s*\)/);
  }
});

// ── 3. What stays open ──────────────────────────────────────────────────

test('everything about the proposal it became stays open', () => {
  // Reading, previews, checks, the vote and the proposal's own upkeep. None
  // of these may read the predicate: a classic session's proposal carries on.
  for (const [method, route] of [
    ['get', '/api/sessions/:id/transcript'],
    ['get', '/api/sessions/:id/spec'],
    ['post', '/api/sessions/:id/ensure-staging'],
    ['post', '/api/sessions/:id/deploy-staging'],
    ['post', '/api/sessions/:id/recheck'],
    ['post', '/api/sessions/:id/sync-main'],
    ['post', '/api/sessions/:id/archive'],
    ['post', '/api/sessions/:id/unarchive'],
    ['post', '/api/sessions/:id/unpromote'],
    ['post', '/api/sessions/:id/pause'],
    ['post', '/api/sessions/:id/resume'],
    ['post', '/api/sessions/:id/stop'],
    ['post', '/api/sessions/:id/share'],
    ['post', '/api/sessions/:id/share-transcript'],
    ['patch', '/api/sessions/:id/title'],
    ['patch', '/api/sessions/:id/description'],
    ['patch', '/api/sessions/:id/linked-issues'],
  ]) {
    assert.doesNotMatch(routeBody(SESSIONS_SRC, method, route), /classicSessions/,
      `${method.toUpperCase()} ${route} stays open for a classic session`);
  }
  // Proposing one that was never proposed: finished work, put to a vote.
  assert.doesNotMatch(routeBody(VOTES_SRC, 'post', '/api/sessions/:id/promote'), /classic/i);
  assert.match(routeBody(VOTES_SRC, 'post', '/api/sessions/:id/promote'),
    /cs\.status IN \('active', 'paused'\)/, 'a paused session is promoted as it is, with no resume');
});

// ── 4. The screen ───────────────────────────────────────────────────────

test('GET /api/sessions/:id says which sessions are read-only, from the same function', () => {
  const body = routeBody(SESSIONS_SRC, 'get', '/api/sessions/:id');
  assert.match(body, /session\.classic_read_only = classicSessions\.isClassicSession\(session\);/);
});

function makeDevChat() {
  const sandbox = {
    console,
    escapeHtml: (s) => String(s == null ? '' : s),
    App: { currentApp: 'recipe-box', switchTab: () => {}, user: { id: 7 } },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      removeEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} }, appendChild: () => {}, setAttribute: () => {} }),
      body: { appendChild: () => {}, addEventListener: () => {} },
    },
    requestAnimationFrame: () => {},
    alert: () => {},
    fetch: async () => { throw new Error('nothing on a read-only session reaches the network'); },
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { search: '', hash: '' },
    URLSearchParams,
    // Every session would be in a hand-off venue if this answered alone.
    Launchpad: { isLaunchpad: () => true },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const started = [];
  sandbox.UsernodeReact = {
    devChat: { publishBanners: () => {} },
    agentSession: { start: (hint) => { started.push(hint); return Promise.resolve(); } },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${DEV_CHAT_SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  return { DevChat: sandbox.__DevChat, started };
}

const READ_ONLY = {
  id: 41, user_id: 7, app_slug: 'recipe-box', status: 'promoted', pr_number: 12,
  session_title: 'Old work', branch_name: 'dev/old', classic_read_only: true,
};

test('the dev chat reads the server\'s answer, and only that', () => {
  const { DevChat } = makeDevChat();
  assert.equal(DevChat._classicReadOnlyView(null), null);
  assert.equal(DevChat._classicReadOnlyView({ ...READ_ONLY, classic_read_only: false }), null);
  assert.equal(DevChat._classicReadOnlyView({ ...READ_ONLY, classic_read_only: undefined }), null,
    'a payload without the field is a session the server did not refuse');
  assert.deepEqual(JSON.parse(JSON.stringify(DevChat._classicReadOnlyView(READ_ONLY))), { canStart: true });
});

test('a read-only session gets its strip, and the strips about continuing stand down', () => {
  const { DevChat } = makeDevChat();
  DevChat.currentSession = { ...READ_ONLY, behind_main: 2 };
  const view = JSON.parse(JSON.stringify(DevChat._bannersView()));
  assert.deepEqual(view.classicReadOnly, { canStart: true });
  assert.equal(view.newChange, null, 'its own strip already starts the next change');
  assert.equal(view.credits, null);
  assert.equal(view.creditsLow, null);
  assert.equal(view.sync.kind, 'behind', 'syncing a proposal with main is upkeep, so it stays');

  // The same session, live: the new-change strip is back and there is no
  // read-only one.
  DevChat.currentSession = { ...READ_ONLY, classic_read_only: false };
  const live = JSON.parse(JSON.stringify(DevChat._bannersView()));
  assert.equal(live.classicReadOnly, null);
  assert.ok(live.newChange, 'a proposed change still offers a new one');
});

test('nothing on a read-only session continues it', async () => {
  const { DevChat, started } = makeDevChat();
  DevChat.currentSession = { ...READ_ONLY };
  assert.equal(DevChat._launchpadVenue(), null, 'handed to no venue');
  assert.equal(DevChat._devFlowHtml(), '', 'and no hand-off walkthrough');
  assert.equal(DevChat._dropDisabled(), true, 'a dropped file has nowhere to go');
  // sendMessage stands down before it paints a turn or calls the network
  // (the sandbox's fetch throws).
  await DevChat.sendMessage('one more thing');
  assert.equal(DevChat.isStreaming, false);
  assert.equal(await DevChat._resumeCurrentSessionIfPaused({ silent: true }), false);
  // The strip's button: an unsent agent session on the same app.
  DevChat.startNewChange();
  assert.deepEqual(JSON.parse(JSON.stringify(started)), [{ slug: 'recipe-box', entry: 'banner' }]);
});

test('the composer, the questionnaire, the venue and the hints give way', () => {
  // Read off the source: these models read a dozen other module states that
  // a vm stub would have to fake one by one.
  assert.match(DEV_CHAT_SRC,
    /hidden: !!DevChat\._launchpadVenue\(\) \|\| !!DevChat\._agentSessionBannerView\(DevChat\.currentSession\)\n\s*\|\| !!DevChat\._classicReadOnlyView\(DevChat\.currentSession\),/);
  assert.match(DEV_CHAT_SRC,
    /const qaInteractive = [^;]*&& !DevChat\._classicReadOnlyView\(session\);/);
  assert.match(DEV_CHAT_SRC,
    /venue: DevChat\._classicReadOnlyView\(session\) \? null : DevChat\._headerVenue\(session\),/);
  assert.match(DEV_CHAT_SRC,
    /returnHint: !DevChat\._classicReadOnlyView\(DevChat\.currentSession\) && DevChat\._showReturnHint\(\),/);
  assert.match(DEV_CHAT_SRC,
    /barEmpty: \(!!DevChat\._launchpadVenue\(\) \|\| !!DevChat\._classicReadOnlyView\(DevChat\.currentSession\)\)/);
  // Opening a paused one never resumes it: it has no turn to resume for.
  assert.match(DEV_CHAT_SRC,
    /if \(session\.status === 'paused' && DevChat\._ownsSession\(session\) && !DevChat\._isShotDeepLink\(\)\n\s*&& !DevChat\._classicReadOnlyView\(session\)\) \{/);
});

test('the strip is a slot of the banners store, empty until a session fills it', () => {
  // Empty on the first render, as every island's initial render must be
  // (AGENTS.md: data arrives after mount, never in the prerendered markup).
  const STORE = read('frontend', 'src', 'features', 'dev-chat', 'banners-store.ts');
  assert.match(STORE, /classicReadOnly\?: ClassicReadOnlyBannerView \| null;/);
  assert.match(STORE, /export const NO_BANNERS: BannersState = \{[^}]*classicReadOnly: null,/);
});

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

test('the strip says it in words, and its one action routes through <Button>', () => {
  const m = loadTsx('tests/fixtures/dev-banners-api.ts');
  m.bannersStore.set({
    sync: null, newChange: null, credits: null, creditsLow: null, agentSession: null,
    classicReadOnly: { canStart: true },
  });
  const html = renderToHtml(createElement(m.DevChatBanners, {}));
  assert.match(html, /<div id="dc-classic-read-only-banner" class="grid [^"]*" role="status">/);
  assert.match(html,
    />This is an older session\. You can read it, but it can no longer be continued\. New work happens in agent sessions\.</);
  // The banner's primary, spelled by the shell's <Button> like "Start a new
  // change" (tests/shell-primitive-adoption.test.js).
  assert.match(html, /<button id="dc-classic-start-agent" type="button" class="rounded-md bg-violet-600 [^"]*">Start an agent session<\/button>/);
  // It leads the slot: the reason the composer is gone comes first.
  assert.ok(html.indexOf('dc-classic-read-only-banner') === html.indexOf('<div id=') + 9);

  // No app to start on, no button: the words stay.
  m.bannersStore.set({
    sync: null, newChange: null, credits: null, creditsLow: null, agentSession: null,
    classicReadOnly: { canStart: false },
  });
  const bare = renderToHtml(createElement(m.DevChatBanners, {}));
  assert.match(bare, /This is an older session/);
  assert.doesNotMatch(bare, /dc-classic-start-agent/);
});

// ── 5. The routes, driven ───────────────────────────────────────────────

const express = require('express');
const { sessionRoutes } = require('../src/routes/sessions');

const VIEWER = { id: 7, username: 'tester' };
const CLASSIC_ROW = {
  id: 3976, app_id: 494, user_id: 7, branch_name: 'dev/tester-1', status: 'active',
  is_headless: false, source: null, agent_session_id: null, session_title: 'Old work',
  pr_number: null, cc_session_id: null, app_slug: 'mypage-777ed2', app_name: 'MyPage',
  repo_url: 'https://github.com/example/mypage', app_self_hosted: false,
  collab_visibility: 'public', view_visibility: 'public',
};

// `active`: the chat route's main lookup finds the row; `paused`: only its
// paused lookup does. Every other read of chat_sessions answers the row too.
function installPool({ status = 'active', row = CLASSIC_ROW } = {}) {
  capturedQueries = [];
  billingCalls = 0;
  poolQueryHandler = async (sql) => {
    if (/AND cs\.status IN \('active', 'promoted'\)\s+AND cs\.is_headless = FALSE\s+-- #846/.test(sql)) {
      return { rows: status === 'active' ? [{ ...row }] : [] };
    }
    if (/status = 'paused'/.test(sql)) return { rows: status === 'paused' ? [{ ...row, status }] : [] };
    if (/FROM chat_sessions/.test(sql)) return { rows: [{ ...row, status }] };
    return { rows: [] };
  };
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = VIEWER; next(); });
  app.use(sessionRoutes({ jwtSecret: 's' }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
}

const writes = () => capturedQueries.filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q.sql));

test('a message to a classic session is refused, active or paused, and changes nothing', async () => {
  for (const status of ['active', 'paused']) {
    installPool({ status });
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/sessions/3976/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'one more thing' }),
      });
      assert.equal(res.status, 409, status);
      assert.equal((await res.json()).code, 'classic_session_read_only', status);
      assert.equal(capturedQueries.some((q) => /status = 'paused'/.test(q.sql)), status === 'paused',
        `${status}: refused on the path that found it`);
      assert.deepEqual(writes(), [], `${status}: nothing stored, nothing resumed`);
      assert.equal(billingCalls, 0, `${status}: nothing billed`);
    });
  }
});

test('an agent session\'s change keeps its own answer, which names the conversation', async () => {
  installPool({ row: { ...CLASSIC_ROW, agent_session_id: 88 } });
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/sessions/3976/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.agentSessionId, 88);
    assert.equal(body.code, undefined, 'not refused as a classic session');
  });
});

test('the coding agent, the venue and an attachment are refused before anything is written', async () => {
  installPool();
  await withServer(async (base) => {
    for (const [route, body] of [
      ['reset-agent-context', { backend: 'claude_code' }],
      ['build-venue', { venue: 'web-codex' }],
    ]) {
      capturedQueries = [];
      const res = await fetch(`${base}/api/sessions/3976/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 409, route);
      assert.equal((await res.json()).code, 'classic_session_read_only', route);
      assert.deepEqual(writes(), [], `${route}: nothing written`);
    }
    capturedQueries = [];
    const res = await fetch(`${base}/api/sessions/3976/attachments?filename=notes.txt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('hello'),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'classic_session_read_only');
    assert.deepEqual(writes(), [], 'no attachment stored');
  });
});
