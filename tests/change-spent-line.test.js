'use strict';

// #6116: a change's page says what it has cost so far, to its author and to
// whoever the dev chat's meter already shows it to (an admin), and to nobody
// else. It is the meter's list-price figure (services/session-cost.js), not
// the credits charged, and the line says so. Nothing at zero or unknown, and
// nothing on a change submitted from a fork, which had no dev session here.
//
// Run with: node --test tests/change-spent-line.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// The two page reads, driven for real, with a pool that answers the row.
const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({ query: (sql, params) => poolQueryHandler(String(sql), params) });
const worker = require('../src/services/worker');
worker.warmRegistrySnapshot = () => [];
const appAccess = require('../src/services/app-access');
appAccess.getAppForUser = async () => ({ id: 1, slug: 'demo', repo_url: 'https://github.com/bot/demo' });
const { sessionRoutes } = require('../src/routes/sessions');
const { voteRoutes } = require('../src/routes/votes');
const express = require('express');
const { sessionCostForViewer, canReadSessionCost } = require('../src/services/session-cost');

const AUTHOR = { id: 7, username: 'author' };
const VOTER = { id: 8, username: 'voter' };
const ADMIN = { id: 9, username: 'admin', isAdmin: true };
const ACCESS = { slug: 'demo', created_by: 1, self_hosted: false, collab_visibility: 'public', view_visibility: 'public', moderation_suspended_at: null };
const LEDGER = /SUM\(m\.cost_cents\)/;

async function asUser(user, routes, fn) {
  const app = express();
  app.use((req, res, next) => { req.user = user; next(); });
  app.use(routes);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    poolQueryHandler = async () => ({ rows: [] });
  }
}

function answer(row, ledgerReads) {
  poolQueryHandler = async (sql) => {
    if (LEDGER.test(sql)) { ledgerReads.push(sql); return { rows: [{ cents: 412.5 }] }; }
    if (/FROM chat_sessions cs\s+JOIN apps a ON a\.id = cs\.app_id\s+WHERE cs\.id = \$1/.test(sql)
      || /WHERE cs\.app_id = \$1 AND cs\.id = \$3/.test(sql)) {
      return { rows: [{ id: 41, user_id: AUTHOR.id, app_slug: 'demo', status: 'merged', source: 'native', ...ACCESS, ...row }] };
    }
    return { rows: [] };
  };
}

const READS = [
  ['/api/sessions/:id/details', () => sessionRoutes({}), '/api/sessions/41/details', (b) => b.session],
  ['/api/apps/:slug/proposals/:id', () => voteRoutes({}), '/api/apps/demo/proposals/41', (b) => b.proposal],
];

for (const [name, routes, url, pick] of READS) {
  test(`${name}: the change's author and an admin read its cost`, async () => {
    for (const user of [AUTHOR, ADMIN]) {
      const reads = [];
      answer({}, reads);
      await asUser(user, routes(), async (base) => {
        const res = await fetch(`${base}${url}`);
        assert.equal(res.status, 200);
        assert.equal(pick(await res.json()).cost_total_cents, 412.5, user.username);
      });
      assert.equal(reads.length, 1);
    }
  });

  test(`${name}: anyone else who may view the change gets no figure, and the ledger is not read`, async () => {
    const reads = [];
    answer({}, reads);
    await asUser(VOTER, routes(), async (base) => {
      const res = await fetch(`${base}${url}`);
      assert.equal(res.status, 200, 'the page itself stays readable');
      const row = pick(await res.json());
      assert.equal(row.id, 41);
      assert.equal(row.cost_total_cents, null);
    });
    assert.equal(reads.length, 0);
  });

  test(`${name}: a change submitted from a fork has no figure, even for its author`, async () => {
    const reads = [];
    answer({ source: 'imported' }, reads);
    await asUser(AUTHOR, routes(), async (base) => {
      const row = pick(await (await fetch(`${base}${url}`)).json());
      assert.equal(row.cost_total_cents, null);
    });
    assert.equal(reads.length, 0);
  });
}

test('the rule is the meter\'s own read: the author or an admin', () => {
  const session = { id: 1, user_id: AUTHOR.id };
  assert.equal(canReadSessionCost(session, AUTHOR), true);
  assert.equal(canReadSessionCost(session, ADMIN), true);
  assert.equal(canReadSessionCost(session, VOTER), false);
  assert.equal(canReadSessionCost(session, null), false);
  assert.equal(canReadSessionCost(null, AUTHOR), false);
  assert.match(read('src/routes/sessions.js'), /WHERE cs\.id = \$1 AND \(cs\.user_id = \$2 OR \$3::boolean\)/);
});

test('zero and a failed read are null, so the page says nothing', async () => {
  const session = { id: 1, user_id: AUTHOR.id, source: 'native' };
  assert.equal(await sessionCostForViewer({ query: async () => ({ rows: [{ cents: 0 }] }) }, session, AUTHOR), null);
  assert.equal(await sessionCostForViewer({ query: async () => { throw new Error('down'); } }, session, AUTHOR), null);
});

// ── The client ──────────────────────────────────────────────────────────

function loadAppView(search = '') {
  const sandbox = {
    console, relTime: () => 'just now', App: { user: { id: 1 } },
    Kudos: { renderButton: () => '' }, DOMPurify: { sanitize: (s) => s },
    document: {
      getElementById: () => null, querySelector: () => ({ innerHTML: '' }),
      querySelectorAll: () => ({ forEach() {} }), addEventListener() {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { appendChild() {} }, hidden: false,
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert() {}, setTimeout, clearTimeout, setInterval, clearInterval, addEventListener() {},
    dispatchEvent() {}, CustomEvent: class {},
    localStorage: { getItem: () => null, setItem() {} },
    location: { search, hash: '' }, URLSearchParams,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(
    `${read('public/js/merge-status.js')}\n${read('public/js/session-transcript.js')}\n`
    + `${read('public/js/app-view.js')}\n;globalThis.__AppView = AppView;`, sandbox);
  return sandbox.__AppView;
}

const line = (amount) => message('changes:page.testing.spent').replace('{{amount}}', amount);

test('the line says list price and that it is not the credits charged', () => {
  const text = message('changes:page.testing.spent');
  assert.match(text, /list price/);
  assert.match(text, /not the credits charged/);
});

test('_changeSpentView words the figure, and says nothing at zero or unknown', () => {
  const AppView = loadAppView();
  const view = AppView._changeSpentView('proposal', { cost_total_cents: 412.5 });
  assert.equal(view.text, line('4.13'));
  assert.equal(view.title, message('devchat:budget.pill.thisChangeTitle'));
  for (const cents of [0, 0.4, null, undefined, -5, 'x']) {
    assert.equal(AppView._changeSpentView('proposal', { cost_total_cents: cents }), null, String(cents));
  }
  assert.equal(AppView._changeSpentView('session', { cost_total_cents: 412.5 }).text, line('4.13'));
  assert.equal(AppView._changeSpentView('gov', { cost_total_cents: 412.5 }), null);
  assert.equal(AppView._changeSpentView('proposal', { source: 'imported', cost_total_cents: 412.5 }), null);
});

test('?shot=session-cost paints the meter\'s sample, except on a change from a fork', () => {
  const AppView = loadAppView('?demo=1&shot=session-cost');
  assert.equal(AppView._changeSpentView('proposal', {}).text, line('1.24'));
  assert.equal(AppView._changeSpentView('proposal', { source: 'imported' }), null);
  assert.equal(AppView._changeSpentView('gov', {}), null);
});

test('the thread view hands the Testing card its line', () => {
  const src = read('public/js/app-view.js');
  assert.match(src, /testing: \{ \.\.\.AppView\._changeTestingView\(item\), spent: AppView\._changeSpentView\(kind, item\) \}/);
});

const HEAD = 'frontend/src/features/dev-board/topic/change-head.tsx';
const GATE = {
  name: 'Testing', figure: 'Passed', tone: 'done', done: true, segments: [], label: 'Passed', note: [],
};

test('the Testing card draws the line at its foot, and nothing without one', () => {
  const spent = { text: 'This change has cost $1.24 so far at list price. That is not the credits charged.', title: 'Everything it cost' };
  const html = renderComponent(HEAD, 'GateCard', { which: 'testing', g: { ...GATE, spent }, action: null, id: 41 });
  assert.match(html, /<p class="dev-change-gate-note" data-change-spent="" title="Everything it cost">This change has cost \$1\.24/);
  const none = renderComponent(HEAD, 'GateCard', { which: 'testing', g: { ...GATE, spent: null }, action: null, id: 41 });
  assert.doesNotMatch(none, /data-change-spent/);
});

test('a request-led change shows it too, on its cards and while it is still being built', () => {
  const src = read('frontend/src/features/dev-board/topic/thread-changes.tsx');
  // Reviewed and merged changes draw ChangeGates, whose Testing card has it.
  assert.match(src, /<ChangeGates id=\{item\.id\} card=\{view\.card\} v=\{view\.v\} ballot=\{ballot\} \/>/);
  // Underway has no cards, and the line stands alone under "being built".
  assert.match(src, /\(item\.state === 'underway' \|\| !hasCards\(item\)\) && view\?\.v\.testing\.spent\s+\? <ChangeSpentLine spent=\{view\.v\.testing\.spent\} \/>/);
});
