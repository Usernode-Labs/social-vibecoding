// The Admin console in the brand, and its dashboard (#7081).
//
// Pinned here:
//  - the counting service (src/services/admin-dashboard.js), executed over a
//    stand-in pool: it only reads, it asks for the period it was given, it
//    passes the database's counts through unchanged and it refuses a period
//    the dashboard does not offer;
//  - the route: behind the admin gate every /api/admin read is behind, a GET,
//    never a write;
//  - the rules the page reads its figures by (features/admin/admin-workspace.js):
//    how a count moved, what needs somebody, how long ago;
//  - the page: a figure that has not arrived is a dash, a failed read says so,
//    and it keeps the ids the overview had;
//  - the regroup: every section still there, under one of the eight groups;
//  - the styling block in app.css: tokens for every look, drawing for the
//    standard look alone, one serif weight.
//
// Run with: node --test tests/admin-dashboard.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const dashboard = require('../src/services/admin-dashboard');
const ws = loadTsx('frontend/src/features/admin/admin-workspace.js');
const consoleJs = read('frontend/src/features/admin/admin-console.js');
const overviewTsx = read('frontend/src/features/admin/admin-overview.tsx');
const adminRoutes = read('src/routes/admin.js');
const css = read('public/css/app.css');

function standInPool(counts, queue = [], shipped = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === dashboard.COUNTS_SQL) return { rows: [counts] };
      if (sql === dashboard.QUEUE_SQL) return { rows: queue };
      if (sql === dashboard.SHIPPED_SQL) return { rows: shipped };
      throw new Error('unexpected query');
    },
  };
}

test('the dashboard only reads, and only counts', () => {
  for (const sql of [dashboard.COUNTS_SQL, dashboard.QUEUE_SQL, dashboard.SHIPPED_SQL]) {
    assert.match(sql.trim(), /^(WITH|SELECT)\b/, 'a read');
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE)\b/i, 'never a write');
  }
  // Nothing personal beyond what the console's own lists already show: no
  // email, no password material, no token.
  assert.doesNotMatch(dashboard.COUNTS_SQL + dashboard.QUEUE_SQL + dashboard.SHIPPED_SQL, /email|password|token|secret/i);
});

test('it passes the database\'s counts through, for the period asked', async () => {
  const pool = standInPool({
    users_total: 275, users_now: 37, users_before: 22,
    apps_total: 206, apps_now: 45, apps_before: 111,
    communities_total: 206,
    proposals_now: 12, proposals_before: 9,
    votes_now: 40, votes_before: 0,
    voters_now: 7, voters_before: 7,
    shipped_now: 5, shipped_before: 8,
    moderation_open: 2, moderation_new: 1,
  }, [
    { id: '9', target_type: 'app_message', target_label: 'A message', status: 'new', created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-21T10:00:00Z', reports: 3, reason: 'spam' },
  ], [
    { id: 4, pr_title: 'A change', merged_at: '2026-11-22T10:00:00Z', app_slug: 'sample', app_name: 'Sample' },
  ]);
  const out = await dashboard.gather(pool, { days: 7 });
  assert.equal(out.days, 7);
  assert.deepEqual(out.periods, [7, 30, 90]);
  assert.deepEqual(out.totals, { users: 275, apps: 206, communities: 206 });
  assert.deepEqual(out.period.newUsers, { now: 37, before: 22 });
  assert.deepEqual(out.period.votes, { now: 40, before: 0 });
  assert.deepEqual(out.period.shipped, { now: 5, before: 8 });
  assert.equal(out.moderation.open, 2);
  assert.equal(out.moderation.fresh, 1);
  assert.deepEqual(out.moderation.queue, [{
    id: 9, targetType: 'app_message', label: 'A message', status: 'new', reports: 3, reason: 'spam',
    createdAt: '2026-11-20T10:00:00Z', updatedAt: '2026-11-21T10:00:00Z',
  }]);
  assert.deepEqual(out.shipped, [{ id: 4, title: 'A change', appSlug: 'sample', appName: 'Sample', mergedAt: '2026-11-22T10:00:00Z' }]);
  const counts = pool.calls.find((c) => c.sql === dashboard.COUNTS_SQL);
  assert.deepEqual(counts.params, [7], 'the period is a bound parameter, never written into the SQL');
  assert.equal(pool.calls.length, 3);
});

test('an empty database is zeros, not a throw, and an odd period is refused', async () => {
  const out = await dashboard.gather(standInPool({}), { days: 30 });
  assert.deepEqual(out.totals, { users: 0, apps: 0, communities: 0 });
  assert.deepEqual(out.period.proposals, { now: 0, before: 0 });
  assert.deepEqual(out.moderation, { open: 0, fresh: 0, queue: [] });
  assert.equal(dashboard.parseDays(undefined), 30);
  assert.equal(dashboard.parseDays('90'), 90);
  for (const bad of ['5', '0', '-7', 'abc', '30; DROP', '3650']) assert.equal(dashboard.parseDays(bad), null, bad);
  // A period that slipped past the route still falls back to the default.
  assert.equal((await dashboard.gather(standInPool({}), { days: 5 })).days, 30);
});

test('the route is a read behind the admin gate', () => {
  const gate = adminRoutes.indexOf("router.use('/api/admin', adminMiddleware);");
  const route = adminRoutes.indexOf("router.get('/api/admin/dashboard'");
  assert.ok(gate > 0 && route > gate, 'declared after the gate that covers /api/admin');
  const body = adminRoutes.slice(route, adminRoutes.indexOf('// ── Mobile push diagnostics', route));
  assert.match(body, /parseDays\(req\.query\.days\)/);
  assert.match(body, /res\.status\(400\)/, 'a period it does not offer is a 400');
  assert.doesNotMatch(body, /err\.message/, 'a failure is not echoed to the browser');
  assert.doesNotMatch(adminRoutes, /router\.(post|put|patch|delete)\('\/api\/admin\/dashboard/);
});

test('how a count moved is stated in words, and never invented', () => {
  assert.deepEqual(ws.deltaOf(37, 22), { dir: 'up', text: 'Up 68%' });
  assert.deepEqual(ws.deltaOf(45, 111), { dir: 'down', text: 'Down 59%' });
  assert.deepEqual(ws.deltaOf(72, 72), { dir: 'flat', text: 'Same as before' });
  assert.deepEqual(ws.deltaOf(0, 0), { dir: 'flat', text: 'None before either' });
  // Nothing before: there is no percentage to state.
  assert.deepEqual(ws.deltaOf(40, 0), { dir: 'up', text: 'None the period before' });
  assert.deepEqual(ws.deltaOf(1001, 1000), { dir: 'up', text: 'Up under 1%' });
  assert.equal(ws.beforeWords(7), 'vs the 7 days before');
});

test('what needs somebody: moderation first, then stuck projects and orphan workers', () => {
  assert.equal(ws.attentionItems(null, null), null, 'nothing known yet');
  assert.deepEqual(ws.attentionItems({ stuckApps: [], orphanWorkers: [] }, { moderation: { open: 0 } }), []);
  const items = ws.attentionItems({ stuckApps: [{}, {}], orphanWorkers: [{}] }, { moderation: { open: 1 } });
  assert.deepEqual(items.map((x) => [x.key, x.section, x.tone]), [
    ['moderation', 'reports', 'warn'], ['stuck', 'status', 'bad'], ['orphans', 'status', 'warn'],
  ]);
  assert.equal(items[0].text, '1 moderation case is open');
  assert.equal(items[1].text, '2 projects are stuck being made');
  // The home sentence counts an open case too, once the dashboard is in.
  assert.equal(ws.needsYouSentence({ stuckApps: [], orphanWorkers: [] }), 'Nothing needs you right now');
  assert.equal(ws.needsYouSentence({ stuckApps: [], orphanWorkers: [] }, { moderation: { open: 3 } }), '3 things need you');
});

test('how long ago, a case\'s words and the quick actions', () => {
  const now = Date.parse('2026-11-24T12:00:00Z');
  assert.equal(ws.agoWords('2026-11-24T11:59:40Z', now), 'just now');
  assert.equal(ws.agoWords('2026-11-24T11:15:00Z', now), '45 minutes ago');
  assert.equal(ws.agoWords('2026-11-24T09:00:00Z', now), '3 hours ago');
  assert.equal(ws.agoWords('2026-11-08T12:00:00Z', now), '16 days ago');
  assert.equal(ws.agoWords('not a date', now), '');
  assert.equal(ws.targetWords('conversation_message'), 'Message');
  assert.equal(ws.targetWords('something_new'), 'something new');
  assert.equal(ws.reasonWords('hate_speech'), 'Hate speech');
  const visible = [{ key: 'users' }, { key: 'status' }, { key: 'node' }];
  assert.deepEqual(ws.quickSections(visible).map((s) => s.key), ['users', 'status'], 'only what this viewer can open');
});

test('the page shows a dash for a figure it was not given, and says when a read failed', () => {
  assert.match(overviewTsx, /\{value == null \? '—' : count\(value\)\}/);
  assert.match(overviewTsx, /fetchJson\(`\/api\/admin\/dashboard\?days=\$\{period\}`\)/);
  assert.match(overviewTsx, /id="admin-dash-error" role="alert"/);
  assert.match(overviewTsx, /Nothing is shown in their place\./);
  assert.match(overviewTsx, /mine !== asked\.current/, 'an older period\'s answer never overwrites a newer one');
  // No figure is written into the page: every count comes from one of the two reads.
  assert.doesNotMatch(overviewTsx, /value=\{\d/);
  for (const id of ['admin-dash-users', 'admin-dash-apps', 'admin-dash-communities', 'admin-dash-moderation',
    'admin-dash-proposals', 'admin-dash-votes', 'admin-dash-voters', 'admin-dash-shipped', 'admin-dash-period',
    'admin-dash-queue', 'admin-dash-quick']) {
    assert.ok(overviewTsx.includes(`"${id}"`), id);
  }
  // The ids the overview had, which declared checks select.
  for (const id of ['admin-home', 'admin-home-status', 'admin-overview-stuck', 'admin-overview-llm', 'admin-overview-orphan', 'admin-refresh-overview']) {
    assert.ok(overviewTsx.includes(`id="${id}"`), id);
  }
  // It opens sections only through the chassis, and only ones the viewer has.
  assert.match(overviewTsx, /const opener = \(key: string\) => \(canOpen\(key\) \? go\(key\) : undefined\);/);
});

test('every section is still there, under one of the eight groups', () => {
  const list = consoleJs.slice(consoleJs.indexOf('  SECTIONS: ['), consoleJs.indexOf('\n  ],\n', consoleJs.indexOf('  SECTIONS: [')));
  const entries = [...list.matchAll(/\{ key: '([^']+)', label: '([^']+)', group: '([^']+)'/g)].map((m) => ({ key: m[1], group: m[3] }));
  assert.equal(entries.length, 53, 'no section was dropped by the regroup');
  assert.equal(new Set(entries.map((e) => e.key)).size, 53);
  const order = [];
  for (const e of entries) if (!order.includes(e.group)) order.push(e.group);
  assert.deepEqual(order, ['Overview', 'Community', 'Growth', 'Governance', 'Operations', 'AI & Quality', 'Content', 'Configuration']);
  const groupOf = Object.fromEntries(entries.map((e) => [e.key, e.group]));
  assert.equal(groupOf.overview, 'Overview');
  assert.equal(groupOf.users, 'Community');
  assert.equal(groupOf.reports, 'Community');
  assert.equal(groupOf.journey, 'Growth');
  assert.equal(groupOf.approvals, 'Governance');
  assert.equal(groupOf['homeroom-bot'], 'AI & Quality');
  assert.equal(groupOf['featured-apps'], 'Content');
  assert.equal(groupOf.settings, 'Configuration');
  // The two sections a signed-in non-admin may still open keep their flag.
  for (const key of ['status', 'node']) assert.match(list, new RegExp(`\\{ key: '${key}', label: '[^']+', group: '[^']+', public: true \\}`));
});

function block() {
  const start = css.indexOf('── THE ADMIN CONSOLE, IN THE BRAND');
  const end = css.indexOf('END OF THE ADMIN CONSOLE, IN THE BRAND.');
  assert.ok(start > 0 && end > start, 'app.css has the console\'s block, start to end');
  return css.slice(css.indexOf('*/', start) + 2, css.lastIndexOf('/*', end)).replace(/\/\*[\s\S]*?\*\//g, '');
}

test('the console\'s tokens are every look\'s; its drawing is the standard look\'s alone', () => {
  const flat = block().replace(/@media[^{]*\{/g, '').replace(/\}\s*\}/g, '}');
  const rules = [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] }));
  const [light, dark, ...rest] = rules;
  assert.equal(light.selector, ':root');
  assert.equal(dark.selector, ':root.dark');
  for (const token of ['--adm-ink', '--adm-ink-soft', '--adm-page', '--adm-paper', '--adm-line', '--adm-sky', '--adm-leaf', '--adm-sun', '--adm-chip', '--adm-up', '--adm-down', '--adm-lit', '--adm-lit-ink']) {
    assert.match(light.body, new RegExp(`${token}:`), `${token} is declared`);
    assert.match(dark.body, new RegExp(`${token}:`), `${token} has a dark value`);
  }
  assert.ok(rest.length >= 10);
  for (const rule of rest) {
    assert.ok(rule.selector.split(/,\s*(?![^()]*\))/).every((one) => one.trim().startsWith('html:not([data-skin]) #admin-')),
      `the standard look's, inside the console: ${rule.selector}`);
    assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(rule.body), `no colour of its own: ${rule.selector}`);
    if (/font-family: var\(--adm-serif\)/.test(rule.body)) assert.match(rule.body, /font-weight: 400;/, `one weight: ${rule.selector}`);
  }
  assert.ok(!/display:\s*none/.test(block()), 'it hides nothing');
  // Every tint a recipe names is one of the tokens.
  const used = new Set([...consoleJs.matchAll(/var\((--adm-[a-z-]+)\)/g)].map((m) => m[1]));
  assert.ok(used.size >= 6);
  for (const token of used) assert.match(light.body, new RegExp(`${token}:`), `${token} is declared for the recipe that reads it`);
});
