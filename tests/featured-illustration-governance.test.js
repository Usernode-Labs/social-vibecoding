// The `featured_illustration` governance kind (#2086).
//
// A featured-illustration change is a proposal now, modelled on the rename
// card: it applies when the vote passes under the app's gate, and an admin
// can force-apply it. The governance machine applies it (published, kept
// or removed: tests/workflow-governance-postgres.test.js). This suite pins
// the surfaces that have to know the kind:
//
//   * POST /api/issues/:id/admin-apply accepts the kind and hands an
//     admin's force to the governance machine;
//   * the kind lists in issues.js / shared-objects.js / governance-kinds
//     carry the kind, so the card resolves by id and as a share;
//   * the board card renders the proposed image beside the current one, as
//     an <img> with alt text and never a link, and offers the admin the same
//     force-apply row the other kinds get.
//
// Same harness as tests/close-issue-proposal.test.js: collaborators stubbed
// via require.cache, handlers driven off the router stack.
//
// Run with: node --test tests/featured-illustration-governance.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { govCardHtml } = require('./lib/dev-card-html');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ── Mock pool ─────────────────────────────────────────────────────────────
function makePool(handlers) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    for (const [re, rows] of handlers) {
      if (re.test(sql)) return { rows: typeof rows === 'function' ? rows(params) : rows };
    }
    return { rows: [] };
  };
  return {
    calls,
    query,
    async connect() { return { query, release() {} }; },
    issued(re) { return calls.find((c) => re.test(c.sql)); },
    issuedAll(re) { return calls.filter((c) => re.test(c.sql)); },
  };
}

const APP = { id: 9, slug: 'cool-app', name: 'Cool App', repo_url: 'https://github.com/acme/cool-app' };

function loadIssues(pool, { active = 2, locked = false } = {}) {
  const realActiveUsers = require('../src/services/active-users');
  const ids = {
    pool: require.resolve('../src/db/pool'),
    ws: require.resolve('../src/services/ws'),
    appAccess: require.resolve('../src/services/app-access'),
    appAdmins: require.resolve('../src/services/app-admins'),
    activeUsers: require.resolve('../src/services/active-users'),
    adminApproval: require.resolve('../src/services/admin-approval'),
    proposals: require.resolve('../src/services/illustration-proposals'),
    workflow: require.resolve('../src/workflow/platform.ts'),
    subject: require.resolve('../src/routes/issues'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  const spies = { systemMessages: [], issueUpdates: [], appUpdates: [], adminApplied: [] };
  const stub = (id, exports) => {
    require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  };
  stub(ids.pool, { getPool: () => pool });
  const realWs = orig.ws ? orig.ws.exports : require('../src/services/ws');
  stub(ids.ws, {
    ...realWs,
    sendSystemMessage: async (...args) => { spies.systemMessages.push(args); },
    pushIssueUpdate: (data) => { spies.issueUpdates.push(data); },
    pushAppUpdate: (data) => { spies.appUpdates.push(data); },
  });
  stub(ids.appAccess, {
    ACCESS_COLUMNS: '*',
    issueCollabGuard: () => (_req, _res, next) => next(),
    getAppForUser: async () => ({ ...APP }),
  });
  const realAdmins = orig.appAdmins ? orig.appAdmins.exports : require('../src/services/app-admins');
  stub(ids.appAdmins, {
    ...realAdmins,
    canForceMerge: async (_pool, _app, user) => !!(user && user.canAdminWrite),
  });
  stub(ids.activeUsers, {
    ...realActiveUsers,
    getActiveUserStats: async () => ({ active, majority: Math.floor(active / 2) + 1 }),
  });
  stub(ids.adminApproval, { isAppLocked: async () => locked });
  stub(ids.workflow, {
    async fileProposal() {},
    async adminApplyProposal(issue, user) {
      spies.adminApplied.push([issue.id, user.username]);
      return { status: 200, body: { ok: true, applied: { applied: true }, secretChanged: null } };
    },
  });
  // The service reads ws at require time, so it is reloaded under the stub.
  delete require.cache[ids.proposals];
  delete require.cache[ids.subject];
  const subject = require('../src/routes/issues');
  const router = subject.issueRoutes({ databaseUrl: 'postgres://test', jwtSecret: 's' });
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
    delete require.cache[ids.subject];
    delete require.cache[ids.proposals];
  };
  return { subject, router, spies, restore };
}

function routeHandler(router, routePath, method = 'post') {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error(`${method} ${routePath} route not found`);
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

const NEW_ID = 'b'.repeat(32);
const NEW_DARK_ID = 'c'.repeat(32);
const OLD_ID = 'a'.repeat(32);
const CURRENT = { url: `/app-illustrations/${OLD_ID}`, darkUrl: null, zoom: 1, x: 0, y: 0, tint: 'teal' };
const PROPOSED = { url: `/app-illustrations/${NEW_ID}`, darkUrl: `/app-illustrations/${NEW_DARK_ID}`, zoom: 1.4, x: 10, y: -5, tint: 'blue' };

const PROPOSAL = (over) => ({
  id: 71, app_id: 9, created_by: 42, kind: 'featured_illustration', status: 'open',
  github_issue_number: null,
  title: 'Change the featured illustration',
  payload: { proposed: PROPOSED, current: CURRENT, remove: false },
  created_at: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
  app_slug: 'cool-app', app_created_by: 1,
  ...over,
});


// ── Admin force-apply ─────────────────────────────────────────────────────

test('admin-apply: accepts the kind and hands an admin\'s force to the machine; non-admin 403', async () => {
  const pool = makePool([[/SELECT i\.\*, a\.slug AS app_slug/, [PROPOSAL({ created_at: new Date().toISOString() })]]]);
  const { router, spies, restore } = loadIssues(pool, { active: 20, locked: true });
  try {
    const handler = routeHandler(router, '/api/issues/:id/admin-apply');
    const denied = mockRes();
    await handler({ params: { id: '71' }, user: { id: 5, username: 'someone', canAdminWrite: false } }, denied);
    assert.equal(denied.statusCode, 403);
    assert.deepEqual(spies.adminApplied, []);

    const res = mockRes();
    await handler({ params: { id: '71' }, user: { id: 1, username: 'root', canAdminWrite: true }, get: () => undefined }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(spies.adminApplied, [[71, 'root']]);
    assert.ok(!pool.issued(/UPDATE /), 'the route writes nothing itself');
  } finally { restore(); }
});

// ── Wiring: every surface that enumerates the governance kinds ───────────

test('the governance kinds, the by-id read and the share resolver carry the kind', () => {
  assert.ok(require('../src/services/governance-kinds').GOVERNANCE_KINDS.includes('featured_illustration'),
    'the governance machine decides it');
  const issues = read('src/routes/issues.js');
  // #6019 added 'thread_move' after it.
  assert.match(issues, /AND i\.kind IN \('secret_change', 'rename', 'close_issue', 'reopen_issue', 'maintenance_campaign',\s*'featured_illustration', 'thread_move'\)\s*LIMIT 1/,
    'GET /api/apps/:slug/governance/:id resolves the kind');
  const shared = read('src/services/shared-objects.js');
  assert.equal((shared.match(/'maintenance_campaign',\s*'featured_illustration', 'thread_move'\)/g) || []).length, 2);
  // The generic create route does not accept it: the bytes travel with the
  // save, through the illustration endpoint.
  assert.match(issues, /const VALID_KINDS = \['general', 'secret_change', 'close_issue', 'reopen_issue', 'maintenance_campaign'\];/);
  // And it gets no GitHub twin, like the other platform-governance kinds.
  const { shouldCreateGithubTwin } = require('../src/routes/issues');
  assert.equal(shouldCreateGithubTwin('featured_illustration'), false);
  // The schema holds the pending bytes and the one-open-per-app guard.
  const schema = read('src/db/schema.sql');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS app_illustration_proposals \(\s*issue_id INTEGER PRIMARY KEY REFERENCES issues\(id\) ON DELETE CASCADE/);
  assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_open_featured_illustration\s+ON issues \(app_id\)\s+WHERE kind = 'featured_illustration' AND status = 'open'/);
});

test('the staging mock row is served under ?demo=1 and is what the declared checks read', () => {
  const issues = read('src/routes/issues.js');
  assert.match(issues, /mk\(9100077, 'featured_illustration', '\[Mock\] Change the featured illustration'/);
  const dapp = JSON.parse(read('dapp.json'));
  const checks = dapp.tests.filter((t) => /#2086/.test(t.name));
  assert.equal(checks.length, 2);
  for (const t of checks) {
    assert.match(t.path, /demo=1/);
    assert.match(t.expectSelector, /\[data-gov-row='9100077'\] \[data-illustration-preview\]/);
    assert.match(t.expectSelector, /img\[alt\]$/);
  }
});

// ── The card ──────────────────────────────────────────────────────────────

const APP_VIEW_SRC = read('public/js/app-view.js');
function makeAppView({ user = { id: 1, username: 'me' } } = {}) {
  const sandbox = {
    console, relTime: () => '2h ago',
    escapeHtml: (s) => String(s == null ? '' : s), escapeAttr: (s) => String(s == null ? '' : s),
    App: { user, currentApp: 'demo-app', currentSubTab: 'forum', _appUrl: () => '#x', switchTab: () => {} },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: {
      getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }), addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }), alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { search: '', hash: '', href: 'http://localhost/' }, URLSearchParams,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'demo-app', can_collaborate: true };
  AppView._proposalsCtx = { majority: 2, activeUsers: 3 };
  AppView._govProposals = [];
  return AppView;
}

const CARD_ROW = (over) => ({
  id: 9100077, app_id: 0, kind: 'featured_illustration',
  title: 'Change the featured illustration',
  description: 'maker proposed changing the featured illustration.',
  status: 'open',
  payload: { proposed: { url: '/icons/icon-512.png', darkUrl: null, zoom: 1.2, x: 10, y: -5, tint: 'teal' },
    current: { url: '/icons/icon-192.png', darkUrl: null, zoom: 1, x: 0, y: 0 }, remove: false },
  created_by: 42, created_by_username: 'maker', created_at: new Date().toISOString(),
  up_count: 1, down_count: 0, my_vote: null, chat_count: 0, votes_required: 2, contested: false,
  ...over,
});

test('the card previews the proposed image beside the current one, as images and never links', () => {
  const AppView = makeAppView();
  const html = govCardHtml(AppView, CARD_ROW());
  assert.match(html, /data-gov-row="9100077"/);
  assert.match(html, /Change the featured illustration/);
  const preview = html.slice(html.indexOf('data-illustration-preview="1"'));
  assert.ok(preview.length > 1, 'the preview block renders');
  const current = preview.slice(preview.indexOf('data-illustration-side="current"'), preview.indexOf('data-illustration-side="proposed"'));
  const proposed = preview.slice(preview.indexOf('data-illustration-side="proposed"'));
  assert.match(current, /<img[^>]*src="\/icons\/icon-192\.png"[^>]*alt="Current featured illustration"/);
  assert.match(proposed, /<img[^>]*src="\/icons\/icon-512\.png"[^>]*alt="Proposed featured illustration"/);
  assert.match(proposed, /home-tone-teal/, 'the proposed side wears the proposed card colour');
  assert.ok(!/<a [^>]*href="\/icons/.test(html), 'an API-supplied url is never a clickable anchor');
  assert.ok(!/—/.test(html), 'no em dash in the card copy');
  // Both empty states say so in words: the app icon shows instead.
  const removal = govCardHtml(AppView, CARD_ROW({ payload: { proposed: null, current: CARD_ROW().payload.current, remove: true } }));
  assert.match(removal, /Removed, the app icon shows instead/);
  const first = govCardHtml(AppView, CARD_ROW({ payload: { proposed: CARD_ROW().payload.proposed, current: null, remove: false } }));
  assert.match(first, /No illustration, the app icon shows/);
});

test('the card offers admins the force-apply row, and the kind is in the board filter', () => {
  const admin = makeAppView({ user: { id: 1, username: 'root', canAdminWrite: true, isAdmin: true } });
  const m = admin._govCardModel(CARD_ROW());
  const menu = admin._cardMenus ? admin._cardMenus[m.rail.menuKey] : null;
  const registered = menu || (admin._cardMenuRegistry && admin._cardMenuRegistry[m.rail.menuKey]);
  const labels = (registered || []).map((x) => x.label);
  assert.ok(labels.includes('Admin merge'), `admin row offered: ${JSON.stringify(labels)}`);
  const viewer = makeAppView();
  const mv = viewer._govCardModel(CARD_ROW());
  const vmenu = (viewer._cardMenus && viewer._cardMenus[mv.rail.menuKey])
    || (viewer._cardMenuRegistry && viewer._cardMenuRegistry[mv.rail.menuKey]) || [];
  assert.ok(!vmenu.map((x) => x.label).includes('Admin merge'), 'a plain member gets no admin row');
  assert.equal(viewer._govApplyLabel('featured_illustration'), 'Updating illustration…');
  assert.match(APP_VIEW_SRC, /\|\| i\.kind === 'maintenance_campaign' \|\| i\.kind === 'featured_illustration' \|\| i\.kind === 'thread_move'\);/);
  assert.match(APP_VIEW_SRC, /data\?\.campaignStarted \|\| data\?\.illustrationChanged \|\| null;/);
});
