'use strict';

// Test accounts (#admin/test-accounts): frontend/src/features/admin/
// admin-test-accounts.tsx, the console section over the three routes in
// src/routes/test-accounts.js (the ones the connector's create_test_account,
// list_test_accounts and retire_test_account wrap).
//
// The routes and the service run against real PostgreSQL in
// tests/test-accounts-postgres.test.js. This file pins the section: that it is
// registered everywhere a console section has to be; that Create posts the
// right body and the one-time password lands in exactly one place (never in
// storage, the console or the address bar); that errors render as sentences;
// that Retire asks in the page before it posts; and that a view-only admin is
// told rather than shown a form.
//
// Effects do not run under renderToStaticMarkup, so the flows are exercised
// through the module's own exported steps (runCreate, runRetire, loadLive and
// the create reducer), which are what the components call.
//
// Run with: node --test tests/admin-test-accounts.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SRC = read('frontend/src/features/admin/admin-test-accounts.tsx');
// The code without its comments, which describe the very things the
// assertions below say the code never does.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PASSWORD = 'pw-Zq8xV3nT0aLk2Rf9';

function loadSection() {
  globalThis.window = globalThis.window || globalThis;
  return loadTsx('frontend/src/features/admin/admin-test-accounts.tsx', {
    stubs: {
      './admin-console.js': {
        AdminUI: new Proxy({}, {
          get: (_t, key) => (['btn', 'badge'].includes(key)
            ? new Proxy({}, { get: (_u, k) => `${key}-${String(k)}` })
            : String(key)),
        }),
      },
      '../../lib/legacy-portals': { mountLegacyPortal() {}, unmountLegacyPortal() {} },
    },
  });
}

const mod = loadSection();

/** A fetch that records each call and answers from `answer(url, init)`. */
function fakeFetch(answer) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const { status = 200, body = {} } = await answer(url, init);
    return {
      status,
      ok: status >= 200 && status < 300,
      async json() { return body; },
    };
  };
  return { impl, calls };
}

const CREATED = {
  account: {
    userId: 41, username: 'maya_test', password: PASSWORD, needsUsernameChoice: false,
    platformAccess: true, welcomeDm: false, note: 'first session',
  },
};

/**
 * Watch every place a careless line could leave the password: both storages,
 * every console method and the History API. Returns what was written, and
 * puts everything back on restore().
 */
function watchLeaks() {
  const writes = [];
  const record = (where) => (...args) => { writes.push({ where, text: args.map(String).join(' ') }); };
  const restore = [];
  for (const name of ['localStorage', 'sessionStorage']) {
    const before = Object.getOwnPropertyDescriptor(globalThis, name);
    const store = { setItem: record(`${name}.setItem`), getItem: () => null, removeItem() {}, clear() {}, key: () => null, length: 0 };
    Object.defineProperty(globalThis, name, { value: store, configurable: true, writable: true });
    restore.push(() => {
      if (before) Object.defineProperty(globalThis, name, before);
      else delete globalThis[name];
    });
  }
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    const before = console[method];
    console[method] = record(`console.${method}`);
    restore.push(() => { console[method] = before; });
  }
  const historyBefore = Object.getOwnPropertyDescriptor(globalThis, 'history');
  Object.defineProperty(globalThis, 'history', {
    value: { pushState: record('history.pushState'), replaceState: record('history.replaceState') },
    configurable: true, writable: true,
  });
  restore.push(() => {
    if (historyBefore) Object.defineProperty(globalThis, 'history', historyBefore);
    else delete globalThis.history;
  });
  return { writes, restore: () => { for (const undo of restore.reverse()) undo(); } };
}

// ── Registration ────────────────────────────────────────────────────────

test('the section is registered everywhere a console section has to be', () => {
  const consoleJs = read('frontend/src/features/admin/admin-console.js');
  assert.match(consoleJs, /\{ key: 'test-accounts', label: 'Test accounts', group: 'People' \}/,
    'a menu entry under People');
  assert.match(consoleJs, /'test-accounts': 'AdminTestAccounts',/, 'SECTION_MODULES dispatches to the module');
  assert.match(consoleJs, /'test-accounts': '<svg /, 'the menu entry has an icon like its neighbours');
  assert.match(read('frontend/src/features/admin/sections.ts'), /import '\.\/admin-test-accounts\.tsx';/,
    'the lazily imported barrel loads it');
  assert.match(SRC, /\(window as any\)\.AdminTestAccounts = AdminTestAccounts;/, 'it publishes itself for _renderModule');
  assert.match(SRC, /render\(el: Element\) \{\n\s+host = el;\n\s+mountLegacyPortal\(el, <TestAccountsSection \/>\);/,
    'render(host) mounts the React section into the host it is handed');
  assert.match(SRC, /destroy\(\) \{\n\s+unmountLegacyPortal\(host\);\n\s+host = null;/,
    'destroy() unmounts it, which is what drops the one-time password with the rest of its state');
  assert.ok(!SRC.includes("getElementById('admin-section-content')"), 'it uses the host it is given');
  const audit = read('scripts/audit-react-ownership.mjs');
  assert.match(audit, /\{ sel: '#admin-section-content', when: '#admin\/test-accounts' \}/,
    'the ownership audit scopes the shared host to this route');
  assert.match(audit, /'#admin\/test-accounts'/, 'and visits the route');
  // No declared check of its own: dapp.json's count is pinned at the
  // MAX_DECLARED_TESTS floor (tests/dev-board-fold.test.js), and a new route
  // cannot fold into an existing check. The checks sign in as the view-only
  // admin anyway, who sees only the notice; this file covers both branches.
});

test('it calls only the four test-account routes, and draws nothing from the API as markup or a link', () => {
  const paths = [...CODE.matchAll(/['`](\/api\/[^'`]*)['`]/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(paths)].sort(), [
    '/api/test-accounts',
    '/api/test-accounts/${account.userId}/retire',
    '/api/test-accounts/phone-sign-ins',
  ]);
  assert.match(CODE, /send\(fetchImpl, 'POST', '\/api\/test-accounts\/phone-sign-ins', \{\}\)/, 'a one-time phone sign-in');
  assert.match(CODE, /send\(fetchImpl, 'GET', '\/api\/test-accounts'\)/, 'the list');
  assert.match(CODE, /send\(fetchImpl, 'POST', '\/api\/test-accounts', built\.body\)/, 'create');
  assert.match(CODE, /send\(fetchImpl, 'POST', `\/api\/test-accounts\/\$\{account\.userId\}\/retire`,\n\s+\{ confirm: RETIRE_CONFIRMATION \}\)/,
    'retire, with the confirmation word the service requires');
  assert.ok(!/<a[\s>]|href=/.test(CODE), 'nothing is rendered as an anchor');
  assert.ok(!/dangerouslySetInnerHTML|\.innerHTML/.test(CODE), 'and nothing as raw markup');
  assert.ok(!CODE.includes("from '@/components/ui/"), 'the console draws with AdminUI, not the shell primitives');
});

// ── Create: the body, and where the password goes ───────────────────────

test('the form builds the body the route takes, and checks a username lightly', () => {
  assert.deepEqual(mod.buildCreateBody(mod.BLANK), {
    ok: true, body: { platformAccess: true, welcomeDm: false },
  }, 'an empty username is left out (a placeholder and the real first-run step), and the toggles default as the route does');
  assert.deepEqual(mod.buildCreateBody({
    username: '  @Maya_Test ', note: '  first session with Maya ', platformAccess: false, welcomeDm: true,
  }), {
    ok: true,
    body: { username: 'Maya_Test', note: 'first session with Maya', platformAccess: false, welcomeDm: true },
  });
  for (const bad of ['ab', 'has space', 'dash-ed', 'x'.repeat(33), 'émile']) {
    const out = mod.buildCreateBody({ ...mod.BLANK, username: bad });
    assert.equal(out.ok, false, `${bad} is refused before it is sent`);
    assert.equal(out.field, 'username');
    assert.match(out.error, /3 to 32 letters, numbers and underscores, or leave it empty/);
  }
  const long = mod.buildCreateBody({ ...mod.BLANK, note: 'n'.repeat(mod.NOTE_MAX + 1) });
  assert.deepEqual(long, { ok: false, field: 'note', error: 'Keep the note to 200 characters.' });
  assert.equal(mod.NOTE_MAX, 200, 'the service\'s NOTE_MAX');
  assert.match(SRC, /maxLength=\{NOTE_MAX\}/, 'and the field cannot take more');
});

test('Create clears the last result, posts the body, and hands the password to the reducer alone', async () => {
  const { impl, calls } = fakeFetch(async () => ({ status: 200, body: CREATED }));
  const actions = [];
  const leaks = watchLeaks();
  let made;
  try {
    made = await mod.runCreate({
      username: 'maya_test', note: 'first session', platformAccess: true, welcomeDm: false,
    }, {
      fetchImpl: impl,
      dispatch: (action) => { actions.push({ action, fetchedYet: calls.length }); },
    });
  } finally {
    leaks.restore();
  }
  assert.equal(made, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/test-accounts');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.deepEqual(calls[0].body, {
    username: 'maya_test', note: 'first session', platformAccess: true, welcomeDm: false,
  });
  assert.deepEqual(actions.map((a) => a.action.type), ['start', 'created']);
  assert.equal(actions[0].fetchedYet, 0, 'the previous password is cleared before the request goes out');
  assert.equal(actions[1].action.account.password, PASSWORD);
  assert.equal(actions[1].action.account.username, 'maya_test');
  assert.deepEqual(leaks.writes, [], 'nothing was written to storage, the console or history');
});

test('the reducer is the one holder of the password, and lets go of it', () => {
  const account = { ...CREATED.account };
  let state = mod.createReducer(mod.CREATE_IDLE, { type: 'start' });
  assert.deepEqual(state, { busy: true, result: null, error: null, field: null });
  state = mod.createReducer(state, { type: 'created', account });
  assert.equal(state.result.password, PASSWORD);
  assert.equal(state.busy, false);
  // Making another account: the password is gone the moment Create is pressed.
  const again = mod.createReducer(state, { type: 'start' });
  assert.equal(again.result, null);
  // "Hide it", and the pagehide that keeps a back/forward restore from showing it.
  assert.equal(mod.createReducer(state, { type: 'dismiss' }).result, null);
  // A refusal never shows an earlier account.
  assert.equal(mod.createReducer(state, { type: 'refused', error: 'No.', field: null }).result, null);
  assert.ok(!JSON.stringify(mod.createReducer(state, { type: 'dismiss' })).includes(PASSWORD));
});

test('the password is kept in component state only, and cleared when the section goes', () => {
  // Nothing in the module can write it anywhere else.
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(CODE), 'no storage');
  assert.ok(!/\bconsole\.[a-z]+\(/.test(CODE), 'no console line at all');
  assert.ok(!/\bhistory\.(?:push|replace)State|\blocation\.(?:hash|href|search|assign|replace)/.test(CODE), 'no address bar');
  assert.ok(!/postMessage|sendBeacon|BroadcastChannel/.test(CODE), 'and no other channel');
  // Its one holder is CreateCard's reducer, so unmounting (destroy()) drops it.
  assert.match(CODE, /const \[state, dispatch\] = useReducer\(createReducer, CREATE_IDLE\);/);
  assert.match(CODE, /\{state\.result \? <OneTimeResult account=\{state\.result\} onDone=\{\(\) => dispatch\(\{ type: 'dismiss' \}\)\} \/> : null\}/);
  // An answer that arrives after the section has gone is dropped unread.
  assert.match(CODE, /dispatch: \(action\) => \{ if \(alive\.current\) dispatch\(action\); \}/);
  // And a page put away for good clears it synchronously first.
  assert.match(CODE, /const forget = \(\) => \{ flushSync\(\(\) => dispatch\(\{ type: 'dismiss' \}\)\); \};\n\s+window\.addEventListener\('pagehide', forget\);/);
  assert.match(CODE, /return \(\) => window\.removeEventListener\('pagehide', forget\);/);
});

test('the one-time box shows the password once, as text, with the sign-out reminder', () => {
  const html = renderToHtml(createElement(mod.OneTimeResult, { account: CREATED.account, onDone() {} }));
  assert.match(html, /id="admin-test-accounts-result"/);
  assert.match(html, /Shown once\. Copy it now\./);
  assert.equal(html.split(PASSWORD).length - 1, 1, 'the password appears exactly once');
  assert.match(html, new RegExp(`<code id="admin-test-accounts-new-password"[^>]*>${PASSWORD}</code>`),
    'as the text of its own <code>');
  assert.ok(!new RegExp(`="[^"]*${PASSWORD}`).test(html), 'never inside an attribute');
  assert.match(html, /<code id="admin-test-accounts-new-username"[^>]*>maya_test<\/code>/);
  assert.equal((html.match(/aria-label="Copy the (username|password)"/g) || []).length, 2, 'a Copy button for each');
  assert.match(html, /Sign out on the device first, then sign in with these\./);
  assert.match(html, /id="admin-test-accounts-done"[^>]*>Hide it</);
  assert.doesNotMatch(html, /placeholder/, 'a chosen username needs no placeholder note');
  assert.doesNotMatch(html, /waiting room/);

  const placeholder = renderToHtml(createElement(mod.OneTimeResult, {
    account: { ...CREATED.account, username: 'member_0a1b2c', needsUsernameChoice: true, platformAccess: false },
    onDone() {},
  }));
  assert.match(placeholder, /The username is a placeholder\. Sign in with it, and Homeroom asks for a real one straight after/);
  assert.match(placeholder, /It is not let in yet, so it signs in to the waiting room\./);
  // Copy uses the Clipboard API inside the click, and selects the text where it cannot.
  assert.match(CODE, /clip\.writeText\(value\)\.then\(\(\) => show\('copied'\), \(\) => \{ select\(\); show\('selected'\); \}\);/);
  assert.match(CODE, /range\.selectNodeContents\(el\);/);
});

// ── Errors ──────────────────────────────────────────────────────────────

test('a refusal is the server\'s sentence, under its field when it names one', async () => {
  const cases = [
    [{ status: 409, body: { error: 'That username is taken.', code: 'username_taken', field: 'username' } },
      { error: 'That username is taken.', field: 'username' }],
    [{ status: 400, body: { error: 'Usernames are at least 3 characters.', code: 'invalid_username', field: 'username' } },
      { error: 'Usernames are at least 3 characters.', field: 'username' }],
    [{ status: 400, body: { error: 'Keep the note to 200 characters.', code: 'note_too_long', field: 'note' } },
      { error: 'Keep the note to 200 characters.', field: 'note' }],
    [{ status: 429, body: { error: 'Too many test-account requests. Try again in 12 minutes.', retryAfterSeconds: 700 } },
      { error: 'Too many test-account requests. Try again in 12 minutes.', field: null }],
    // This one names the connector's parameters, so the console says it in its own words.
    [{ status: 429, body: { error: '… (list_test_accounts shows them) …', code: 'at_capacity', live: 25, max: 25 } },
      { error: 'There are already 25 live test accounts, the most allowed at once. Retire one below, then try again.', field: null }],
    [{ status: 403, body: { error: 'Full admin access required' } },
      { error: 'Only a full admin can do this, from this page.', field: null }],
    [{ status: 500, body: { error: 'Internal server error' } },
      { error: 'Something went wrong on the server (HTTP 500). Check the list below before you try again, in case it was made.', field: null }],
  ];
  for (const [reply, expected] of cases) {
    const { impl } = fakeFetch(async () => reply);
    const actions = [];
    const made = await mod.runCreate({ ...mod.BLANK, username: 'maya_test' }, { fetchImpl: impl, dispatch: (a) => actions.push(a) });
    assert.equal(made, false);
    assert.deepEqual(actions.at(-1), { type: 'refused', ...expected }, `HTTP ${reply.status} ${reply.body.code || ''}`);
  }
  // A request that never answered may still have made the account.
  const offline = await mod.runCreate(mod.BLANK, {
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    dispatch: (a) => { if (a.type === 'refused') assert.match(a.error, /^Could not reach the server\. Check the list below before you try again, in case it was made\.$/); },
  });
  assert.equal(offline, false);
  // A field the form refuses is never sent.
  const { impl, calls } = fakeFetch(async () => ({ status: 200, body: CREATED }));
  const actions = [];
  assert.equal(await mod.runCreate({ ...mod.BLANK, username: 'no spaces' }, { fetchImpl: impl, dispatch: (a) => actions.push(a) }), false);
  assert.equal(calls.length, 0);
  assert.equal(actions.at(-1).field, 'username');
});

test('the form shows a field\'s error under it and anything else under Create', () => {
  assert.match(CODE, /\{fieldError\('username'\) \? \(\n\s+<p id="admin-test-accounts-username-error" role="alert"/);
  assert.match(CODE, /\{fieldError\('note'\) \? \(\n\s+<p id="admin-test-accounts-note-error" role="alert"/);
  assert.match(CODE, /\{general \? <p id="admin-test-accounts-error" role="alert" className=\{ERROR\}>\{general\}<\/p> : null\}/);
  assert.match(CODE, /const general = state\.field \? null : state\.error;/);
});

// ── The list, and Retire ────────────────────────────────────────────────

const NOW = new Date('2026-10-05T12:00:00.000Z');
const LIVE = {
  accounts: [
    {
      userId: 7, username: 'maya_test', createdBy: 'evan', createdAt: '2026-10-05T09:00:00.000Z',
      lastActiveAt: '2026-10-05T11:30:00.000Z', note: 'first session <b>run</b>',
      apps: [{ slug: 'plant-pal', status: 'running' }, { slug: 'chores', status: null }],
    },
    {
      userId: 6, username: 'member_ab12', createdBy: null, createdAt: '2026-10-01T09:00:00.000Z',
      lastActiveAt: null, note: null, apps: [],
    },
  ],
  max: 25,
};

test('the list reads GET /api/test-accounts and says how many of the most are live', async () => {
  const { impl, calls } = fakeFetch(async () => ({ status: 200, body: LIVE }));
  const state = await mod.loadLive(impl);
  assert.equal(calls[0].url, '/api/test-accounts');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].body, undefined);
  assert.equal(state.kind, 'ready');
  assert.equal(state.max, 25);
  assert.deepEqual(state.accounts[0].apps, [{ slug: 'plant-pal', status: 'running' }, { slug: 'chores', status: null }]);

  const html = renderToHtml(createElement(mod.LiveAccounts, {
    state, retiring: null, status: null, onRefresh() {}, onRetire() {}, now: NOW,
  }));
  assert.match(html, /id="admin-test-accounts-count"[^>]*>2 of 25 live</);
  assert.match(html, /data-test-account="7"/);
  assert.match(html, /@maya_test/);
  assert.match(html, /first session &lt;b&gt;run&lt;\/b&gt;/, 'a note is text, escaped by the renderer');
  assert.match(html, /3h ago/, 'made, relative');
  assert.match(html, /by @evan/);
  assert.match(html, /30m ago/, 'last active, relative');
  assert.match(html, /Not yet/, 'an account never seen says so');
  assert.match(html, /plant-pal<\/span> · running/, 'its apps, with their status, as text');
  assert.match(html, /plant-pal \(running\), chores/, 'and folded into one line below md');
  assert.equal((html.match(/data-retire-test-account="/g) || []).length, 2, 'a Retire button per row');
  assert.doesNotMatch(html, /<a[\s>]|href=/, 'no slug, username or note becomes a link');

  const empty = renderToHtml(createElement(mod.LiveAccounts, {
    state: { kind: 'ready', accounts: [], max: 25 }, retiring: null, status: null, onRefresh() {}, onRetire() {}, now: NOW,
  }));
  assert.match(empty, />0 of 25 live</);
  assert.match(empty, /id="admin-test-accounts-empty"/);

  const failed = await mod.loadLive(fakeFetch(async () => ({ status: 429, body: { error: 'Too many test-account requests. Try again in 3 minutes.' } })).impl);
  assert.deepEqual(failed, { kind: 'error', error: 'Too many test-account requests. Try again in 3 minutes.' });
  const failedHtml = renderToHtml(createElement(mod.LiveAccounts, {
    state: failed, retiring: null, status: null, onRefresh() {}, onRetire() {}, now: NOW,
  }));
  assert.match(failedHtml, /role="alert"[^>]*>Too many test-account requests/);
  assert.doesNotMatch(failedHtml, /admin-test-accounts-count/);

  const busy = renderToHtml(createElement(mod.LiveAccounts, {
    state, retiring: 7, status: null, onRefresh() {}, onRetire() {}, now: NOW,
  }));
  assert.match(busy, /data-retire-test-account="7"[^>]*disabled=""[^>]*>Retiring…</);
  assert.match(busy, /data-retire-test-account="6"[^>]*disabled=""[^>]*>Retire</, 'one retire at a time');
});

test('Retire asks in the page first, says it takes the apps down and cannot be undone, then posts', async () => {
  const account = { ...LIVE.accounts[0] };
  const order = [];
  const asked = [];
  const { impl, calls } = fakeFetch(async () => {
    order.push('post');
    return { status: 200, body: { retired: { userId: 7, username: 'maya_test', appsDeleted: ['plant-pal', 'chores'] } } };
  });
  const out = await mod.runRetire(account, {
    confirm: async (opts) => { order.push('confirm'); asked.push(opts); return true; },
    onConfirmed: () => order.push('busy'),
    fetchImpl: impl,
  });
  assert.deepEqual(order, ['confirm', 'busy', 'post']);
  assert.equal(asked[0].title, 'Retire @maya_test?');
  assert.match(asked[0].message, /This takes down its 2 apps \(plant-pal, chores\) and deletes the account\./);
  assert.match(asked[0].message, /This can't be undone\./);
  assert.equal(asked[0].confirmLabel, 'Retire');
  assert.equal(asked[0].danger, true);
  assert.equal(calls[0].url, '/api/test-accounts/7/retire');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].body, { confirm: 'RETIRE' });
  assert.deepEqual(out, { confirmed: true, status: { text: 'Retired @maya_test and took down its 2 apps.', tone: 'ok' } });

  // No: nothing is sent.
  const quiet = fakeFetch(async () => ({ status: 200, body: {} }));
  const no = await mod.runRetire(account, { confirm: async () => false, fetchImpl: quiet.impl });
  assert.deepEqual(no, { confirmed: false, status: null });
  assert.equal(quiet.calls.length, 0);

  // An account with no apps says so.
  assert.match(mod.retireConfirmation(LIVE.accounts[1]).message, /^This deletes the account\. It has made no apps\./);

  // A teardown that failed part way comes back as the service's own sentence.
  const partial = fakeFetch(async () => ({ status: 502, body: {
    error: 'Could not take down chores, so the account was left in place. Nothing else was changed after that app. Retire it again to finish.',
    code: 'app_delete_failed', removedApps: ['plant-pal'], failedApp: 'chores',
  } }));
  const failed = await mod.runRetire(account, { confirm: async () => true, fetchImpl: partial.impl });
  assert.deepEqual(failed.status, {
    text: 'Could not take down chores, so the account was left in place. Nothing else was changed after that app. Retire it again to finish.',
    tone: 'err',
  });
  // The section confirms through the console's in-page dialog, then reads the list again.
  assert.match(CODE, /confirm: \(opts\) => consoleApi\(\)\._confirm\(opts\),/);
  assert.match(CODE, /if \(out\.confirmed\) void load\(\);/);
  assert.ok(!/window\.confirm\(|\bprompt\(/.test(CODE), 'never a native dialog of its own');
});

// ── Who sees what ───────────────────────────────────────────────────────

test('a view-only admin is told it needs a full admin, and is shown no form and no list', () => {
  globalThis.window.AdminConsole = { canWrite: () => false, _confirm: async () => false };
  const html = renderToHtml(createElement(mod.TestAccountsSection, {}));
  assert.match(html, /id="admin-test-accounts"/);
  assert.match(html, /id="admin-test-accounts-view-only"/);
  assert.match(html, /needs a full admin/);
  assert.doesNotMatch(html, /admin-test-accounts-form|admin-test-accounts-list|Loading/,
    'every test-account route is full-admin only, the list included, so nothing is fetched');
  // The branch returns before the component that loads anything.
  assert.match(CODE, /if \(!consoleApi\(\)\?\.canWrite\?\.\(\)\) \{\n\s+return \(\n\s+<div id="admin-test-accounts" className="space-y-4">\n\s+<ViewOnlyNotice \/>/);
});

test('a full admin gets the form, with the route\'s defaults, and the list loading', () => {
  globalThis.window.AdminConsole = { canWrite: () => true, _confirm: async () => false };
  const html = renderToHtml(createElement(mod.TestAccountsSection, {}));
  assert.match(html, /id="admin-test-accounts-form"/);
  assert.match(html, /id="admin-test-accounts-username"[^>]*autoComplete="off"|id="admin-test-accounts-username"[^>]*autocomplete="off"/i);
  assert.match(html, /Leave it empty for a placeholder name\. The tester then picks a username at first sign-in/);
  assert.match(html, /id="admin-test-accounts-note"[^>]*maxLength="200"/i);
  assert.match(html, /id="admin-test-accounts-platform-access"[^>]*checked=""/, 'Let in now is on');
  assert.doesNotMatch(html, /id="admin-test-accounts-bot-dm"/, 'the bot works for any account let in: nothing to switch');
  assert.doesNotMatch(html, /id="admin-test-accounts-welcome-dm"[^>]*checked=""/, 'Welcome DM is off');
  assert.match(html, />Let in now</);
  assert.doesNotMatch(html, />Homeroom bot builds for it</);
  assert.match(html, />Welcome DM</);
  assert.match(html, /id="admin-test-accounts-submit"[^>]*>Create test account</);
  assert.doesNotMatch(html, /id="admin-test-accounts-submit"[^>]*disabled/);
  assert.match(html, /id="admin-test-accounts-list"/);
  assert.match(html, /Loading…/);
  assert.doesNotMatch(html, /admin-test-accounts-result/, 'no result before anything is made');
  assert.doesNotMatch(html, /—/, 'no em dash in the copy');

  const full = renderToHtml(createElement(mod.CreateCard, { full: true, max: 25, onCreated() {} }));
  assert.match(full, /id="admin-test-accounts-submit"[^>]*disabled=""/, 'at the most allowed, Create waits');
  assert.match(full, /25 of 25 live\. Retire one below to make another\./);
});
