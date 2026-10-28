'use strict';

// "Your week" on Me (#5963): the apps you used since Monday and the minutes
// in each, busiest first, the week's total, and the totals of the three weeks
// before. Three halves, pinned here:
//
//   1. the read — GET /api/me/weekly-use (src/routes/profile.js): the week is
//      the weekly challenges' week (Monday 00:00 UTC), apps you made are left
//      out as the minutes challenge leaves them out, and shapeWeeklyUse floors
//      minutes, drops the apps under a minute while keeping their seconds in
//      the total, orders by minutes then name, caps the list and always
//      answers three earlier weeks;
//   2. the words — weekView (frontend/src/features/profile/profile-store.js)
//      is null when there is nothing to show, and otherwise says "32 min",
//      "Week of 19 Oct", "No time" and "Nothing yet this week." from the
//      catalog;
//   3. the panel — WeekPanel (account-panel.tsx) draws rows that lead
//      nowhere, and ProfileRoot puts it after Rewards and before Account.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const profile = require('../src/routes/profile');
const { weekStartMs } = require('../src/services/topochain/challenge-rules');

// ── 1. The read ─────────────────────────────────────────────────────────

test('the route is mounted behind requireUser and reads the challenges\' week', () => {
  const src = read('src/routes/profile.js');
  assert.match(src, /router\.get\('\/api\/me\/weekly-use', requireUser, async \(req, res\) =>/);
  assert.match(src, /weekStartMs\(Date\.now\(\)\)/, 'Monday 00:00 UTC, the week the weekly challenges count');
  assert.match(src, /require\('\.\.\/services\/topochain\/challenge-rules'\)/);
  assert.match(src, /log\.error\('profile', 'Weekly use read failed'/);
  // Both reads go out together.
  assert.match(src, /Promise\.all\(\[\s*pool\.query\(WEEKLY_USE_APPS_SQL, \[req\.user\.id, weekStart\]\),\s*pool\.query\(WEEKLY_USE_TOTALS_SQL, \[req\.user\.id, weekStart\]\),\s*\]\)/);
});

test('both queries are the viewer\'s own rows, without the apps they made', () => {
  for (const sql of [profile.WEEKLY_USE_APPS_SQL, profile.WEEKLY_USE_TOTALS_SQL]) {
    assert.match(sql, /aa\.user_id = \$1/);
    assert.match(sql, /a\.created_by IS DISTINCT FROM aa\.user_id/, 'the challenge scorer\'s own-app rule');
    assert.match(sql, /FROM app_activity aa/);
  }
  assert.match(profile.WEEKLY_USE_APPS_SQL, /aa\.date >= \$2::date\b/);
  assert.doesNotMatch(profile.WEEKLY_USE_APPS_SQL, /LIMIT/i, 'no SQL limit: the shape drops the sub-minute apps first');
  assert.match(profile.WEEKLY_USE_APPS_SQL, /ORDER BY seconds DESC, a\.name ASC/);
  assert.match(profile.WEEKLY_USE_TOTALS_SQL, /aa\.date >= \$2::date - 21/, 'this week and the three before');
  assert.match(profile.WEEKLY_USE_TOTALS_SQL, /FLOOR\(\(aa\.date - \$2::date\) \/ 7\.0\)/, 'a day before the week start buckets to last week');
  assert.equal(profile.WEEKLY_USE_APPS_LIMIT, 20);
  assert.equal(profile.WEEKLY_USE_EARLIER_WEEKS, 3);
});

test('shapeWeeklyUse: whole minutes, busiest first, sub-minute apps kept in the total only', () => {
  const week = profile.shapeWeeklyUse(
    [
      { slug: 'b', name: 'Bravo', seconds: '1980' },      // 33 min
      { slug: 'a', name: 'Alpha', seconds: '1990' },      // 33 min too: ties go alphabetical
      { slug: 'c', name: 'Charlie', seconds: '59' },      // under a minute: no row
      { slug: 'd', name: null, seconds: '600' },          // 10 min, named by its slug
    ],
    [
      { weeks_back: 0, seconds: '4629' },                  // 77 min 9 s: every app, every second
      { weeks_back: 1, seconds: '1500' },
      { weeks_back: 3, seconds: '30' },
    ],
    '2026-10-26',
  );
  assert.deepEqual(week, {
    weekStart: '2026-10-26',
    totalMinutes: 77,
    apps: [
      { slug: 'a', name: 'Alpha', minutes: 33 },
      { slug: 'b', name: 'Bravo', minutes: 33 },
      { slug: 'd', name: 'd', minutes: 10 },
    ],
    earlier: [
      { weekStart: '2026-10-19', minutes: 25 },
      { weekStart: '2026-10-12', minutes: 0 },
      { weekStart: '2026-10-05', minutes: 0 },
    ],
  });
});

test('shapeWeeklyUse: at most 20 apps, always three earlier weeks, and nothing from nothing', () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ slug: `app-${i}`, name: `App ${i}`, seconds: String((i + 1) * 60) }));
  const week = profile.shapeWeeklyUse(rows, [], '2026-10-26');
  assert.equal(week.apps.length, profile.WEEKLY_USE_APPS_LIMIT);
  assert.equal(week.apps[0].slug, 'app-24', 'the busiest leads');
  assert.equal(week.totalMinutes, 0, 'the total is the totals query\'s, not the list\'s');
  assert.equal(week.earlier.length, 3);
  const empty = profile.shapeWeeklyUse([], [], '2026-10-26');
  assert.deepEqual(empty.apps, []);
  assert.equal(empty.totalMinutes, 0);
  assert.deepEqual(empty.earlier.map((w) => w.minutes), [0, 0, 0]);
});

test('the week starts on a Monday, UTC, whether today is a Monday or a Sunday', () => {
  const monday = Date.UTC(2026, 9, 26, 0, 0, 0);      // Mon 26 Oct 2026
  assert.equal(new Date(weekStartMs(monday)).toISOString().slice(0, 10), '2026-10-26');
  const sunday = Date.UTC(2026, 10, 1, 23, 59, 59);   // Sun 1 Nov 2026
  assert.equal(new Date(weekStartMs(sunday)).toISOString().slice(0, 10), '2026-10-26');
  const tuesday = Date.UTC(2026, 9, 27, 9, 0, 0);
  assert.equal(new Date(weekStartMs(tuesday)).toISOString().slice(0, 10), '2026-10-26');
});

test('the ?demo=1 overlay fills an empty week with the staging directory\'s apps, and never a real one', () => {
  const empty = profile.shapeWeeklyUse([], [{ weeks_back: 2, seconds: '600' }], '2026-10-26');
  const demo = profile.withDemoWeeklyUse(empty);
  assert.equal(demo.demo, true);
  assert.deepEqual(demo.apps.map((a) => [a.slug, a.minutes]),
    [['staging-demo-popular-2', 32], ['staging-demo-popular-1', 14], ['staging-demo-featured-2', 3]]);
  assert.equal(demo.totalMinutes, 49);
  assert.deepEqual(demo.earlier.map((w) => w.minutes), [25, 10, 0]);
  assert.deepEqual(demo.earlier.map((w) => w.weekStart), empty.earlier.map((w) => w.weekStart), 'the weeks keep their dates');
  // The virtual directory really has those apps.
  const dir = read('src/services/staging-apps.js');
  for (const a of profile.DEMO_WEEKLY_USE_APPS) assert.ok(dir.includes(`slug: '${a.slug}'`), a.slug);

  const real = profile.shapeWeeklyUse([{ slug: 'x', name: 'X', seconds: '120' }], [{ weeks_back: 0, seconds: '120' }], '2026-10-26');
  assert.equal(profile.withDemoWeeklyUse(real), real, 'real data wins');
  // Only on staging, only with ?demo=1 (the same gate as the summary's).
  assert.match(read('src/routes/profile.js'), /if \(IS_STAGING && req\.query\.demo === '1'\) week = withDemoWeeklyUse\(week\);/);
  // No seeded app_activity rows: the challenge scorer reads that table.
  assert.doesNotMatch(read('src/db/migrate.js'), /app_activity[\s\S]{0,200}usernode-capture/);
});

// ── 2. The words ────────────────────────────────────────────────────────

const store = () => loadTsx('frontend/src/features/profile/profile-store.js');

test('weekView: null for a failed read, a malformed payload, or four empty weeks', () => {
  const { weekView } = store();
  assert.equal(weekView(null), null);
  assert.equal(weekView({}), null);
  assert.equal(weekView({ apps: 'nope', earlier: [] }), null);
  assert.equal(weekView({
    weekStart: '2026-10-26', totalMinutes: 0, apps: [],
    earlier: [{ weekStart: '2026-10-19', minutes: 0 }, { weekStart: '2026-10-12', minutes: 0 }, { weekStart: '2026-10-05', minutes: 0 }],
  }), null, 'no time anywhere: the section is not shown');
});

test('weekView: the rows, the total line and the earlier weeks, in the catalog\'s words', () => {
  const { weekView } = store();
  const view = weekView({
    weekStart: '2026-10-26', totalMinutes: 49,
    apps: [{ slug: 'p2', name: 'Staging demo popular 2', minutes: 32 }, { slug: 'p1', name: 'Staging demo popular 1', minutes: 1 }],
    earlier: [{ weekStart: '2026-10-19', minutes: 25 }, { weekStart: '2026-10-12', minutes: 10 }, { weekStart: '2026-10-05', minutes: 0 }],
  });
  assert.deepEqual(view.apps, [
    { key: 'p2', name: 'Staging demo popular 2', minutes: message('profile:week.minutes', { count: 32, number: '32' }) },
    { key: 'p1', name: 'Staging demo popular 1', minutes: message('profile:week.minutes', { count: 1, number: '1' }) },
  ]);
  assert.equal(view.apps[0].minutes, '32 min');
  assert.equal(view.totalLine, message('profile:week.total', { count: 49, number: '49' }));
  assert.match(view.totalLine, /^49 min in all since Monday\. Apps you made are not counted\.$/);
  assert.equal(view.emptyLine, null);
  assert.equal(view.earlier.length, 3);
  assert.deepEqual(view.earlier.map((w) => w.key), ['2026-10-19', '2026-10-12', '2026-10-05']);
  assert.match(view.earlier[0].label, /^Week of /);
  assert.match(view.earlier[0].label, /19/, 'named by the Monday it starts on');
  assert.equal(view.earlier[0].minutes, '25 min');
  assert.equal(view.earlier[2].minutes, message('profile:week.none'));
  assert.equal(view.earlier[2].minutes, 'No time');
});

test('weekView: an empty week over earlier time says so, and still lists the earlier weeks', () => {
  const { weekView } = store();
  const view = weekView({
    weekStart: '2026-10-26', totalMinutes: 0, apps: [],
    earlier: [{ weekStart: '2026-10-19', minutes: 25 }, { weekStart: '2026-10-12', minutes: 0 }, { weekStart: '2026-10-05', minutes: 0 }],
  });
  assert.deepEqual(view.apps, []);
  assert.equal(view.totalLine, null);
  assert.equal(view.emptyLine, message('profile:week.empty'));
  assert.equal(view.emptyLine, 'Nothing yet this week.');
  assert.equal(view.earlier[0].minutes, '25 min');
});

test('buildProfileView carries the week on the viewer\'s own page only', () => {
  const { buildProfileView } = store();
  const week = {
    weekStart: '2026-10-26', totalMinutes: 5, apps: [{ slug: 'x', name: 'X', minutes: 5 }],
    earlier: [{ weekStart: '2026-10-19', minutes: 0 }, { weekStart: '2026-10-12', minutes: 0 }, { weekStart: '2026-10-05', minutes: 0 }],
  };
  const own = buildProfileView({ open: true, user: { username: 'me' }, data: { week } });
  assert.equal(own.kind, 'own');
  assert.equal(own.week.apps[0].name, 'X');
  const none = buildProfileView({ open: true, user: { username: 'me' }, data: {} });
  assert.equal(none.week, null);
  const pub = buildProfileView({ open: true, user: { username: 'me' }, data: { publicProfile: { username: 'dana' }, week } });
  assert.equal(pub.kind, 'public');
  assert.equal(pub.week, undefined, 'somebody else\'s page shows no week');
  // profile.js reads it with the rest of Me, non-fatally.
  assert.match(read('frontend/src/features/profile/profile.js'),
    /Profile\._fetchJson\(`\/api\/me\/weekly-use\$\{demo\}`\)\.catch\(\(\) => null\)/);
});

// ── 3. The panel ────────────────────────────────────────────────────────

test('WeekPanel draws nothing for null, and rows that lead nowhere otherwise', () => {
  const mod = loadTsx('frontend/src/features/profile/account-panel.tsx');
  assert.equal(renderToHtml(createElement(mod.WeekPanel, { week: null })), '');
  const html = renderToHtml(createElement(mod.WeekPanel, {
    week: {
      apps: [{ key: 'p2', name: 'Staging demo popular 2', minutes: '32 min' }, { key: 'p1', name: 'Staging demo popular 1', minutes: '14 min' }],
      totalLine: '46 min in all since Monday. Apps you made are not counted.',
      emptyLine: null,
      earlier: [{ key: '2026-10-19', label: 'Week of 19 Oct', minutes: '25 min' }, { key: '2026-10-12', label: 'Week of 12 Oct', minutes: 'No time' }],
    },
  }));
  assert.match(html, /<section id="profile-week" class="mt-2">/);
  assert.match(html, /Your week<\/h2>/);
  assert.match(html, /data-week-app="p2"[^>]*>[\s\S]*?Staging demo popular 2[\s\S]*?32 min/);
  assert.match(html, /data-week-app="p1"/);
  assert.match(html, /46 min in all since Monday\. Apps you made are not counted\./);
  assert.match(html, /<section id="profile-week-earlier" class="mt-2">/);
  assert.match(html, /Earlier weeks<\/h2>/);
  assert.match(html, /data-week-earlier="2026-10-19"[^>]*>[\s\S]*?Week of 19 Oct[\s\S]*?25 min/);
  assert.match(html, /data-week-earlier="2026-10-12"[^>]*>[\s\S]*?No time/);
  assert.doesNotMatch(html, /<a /, 'the rows are for reading, not anchors');
  assert.doesNotMatch(html, /href=/);
  assert.doesNotMatch(html, /<svg/, 'no tile and no chevron');
  assert.doesNotMatch(html, /profile-week-empty/);

  const empty = renderToHtml(createElement(mod.WeekPanel, {
    week: { apps: [], totalLine: null, emptyLine: 'Nothing yet this week.', earlier: [{ key: '2026-10-19', label: 'Week of 19 Oct', minutes: '25 min' }] },
  }));
  assert.match(empty, /data-week-empty[^>]*>[\s\S]*?Nothing yet this week\./);
  assert.doesNotMatch(empty, /data-week-app=/);
  assert.doesNotMatch(empty, /in all since Monday/);
});

test('the panel sits after Rewards and before Account, and the declared check reads it', () => {
  const view = read('frontend/src/features/profile/profile-view.tsx');
  const work = view.indexOf('<WorkPanel');
  const rewards = view.indexOf('<RewardsPanel');
  const week = view.indexOf('<WeekPanel week={view.week} />');
  const account = view.indexOf('<AccountPanel');
  assert.ok(work > 0 && rewards > work && week > rewards && account > week,
    'DOM order: Your work, Rewards, Your week, Account');
  // The panel's two sections are siblings of Rewards' section (a fragment),
  // which is what `#profile-rewards + #profile-week` in dapp.json needs.
  const panel = read('frontend/src/features/profile/account-panel.tsx');
  assert.match(panel, /export function WeekPanel[\s\S]*?<>\s*<section id="profile-week" className="mt-2">[\s\S]*?<\/section>\s*<section id="profile-week-earlier" className="mt-2">/);
  // Folded into two existing Me checks, not added: the declared-check cap
  // stands at its floor, and one selector is clipped at 256 characters.
  const manifest = JSON.parse(read('dapp.json'));
  const apps = manifest.tests.find((t) => /Your week lists this week's apps under Rewards \(#5963\)/.test(t.name));
  assert.ok(apps, 'a Me check asserts this week\'s rows under Rewards');
  assert.equal(apps.path, '/?demo=1#profile');
  assert.match(apps.expectSelector, /:has\(#profile-rewards\+#profile-week \[data-week-app\]\)/);
  const earlier = manifest.tests.find((t) => /Earlier weeks follows Your week \(#5963\)/.test(t.name));
  assert.ok(earlier, 'a Me check asserts Earlier weeks after Your week');
  assert.equal(earlier.path, '/?demo=1#profile');
  assert.match(earlier.expectSelector, /:has\(#profile-week\+#profile-week-earlier \[data-week-earlier\]\)/);
  for (const t of [apps, earlier]) assert.ok(t.expectSelector.length <= 256, `${t.expectSelector.length} fits the runner's clip`);
});
