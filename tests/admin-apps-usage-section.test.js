'use strict';

// The admin console's Apps & usage section
// (frontend/src/features/admin/admin-apps-usage.tsx) and the read behind it
// (services/admin-apps-usage.js). Where it sits, that it is built the
// console's React way, that view-only admins can read it, what the service
// makes of the rows Postgres returns, and what the section's pure helpers do.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SECTION = 'frontend/src/features/admin/admin-apps-usage.tsx';
const usage = require('../src/services/admin-apps-usage');

test('it sits first under Insights and is not public', () => {
  const src = read('frontend/src/features/admin/admin-console.js');
  assert.match(src, /\{ key: 'apps', label: 'Apps & usage', group: 'Insights' \}/, 'admin-only: no `public: true`');
  const sections = src.slice(src.indexOf('SECTIONS: ['), src.indexOf('LEGACY_SECTION_KEYS'));
  const at = (key) => sections.indexOf(`{ key: '${key}'`);
  assert.ok(at('apps') < at('journey') && at('apps') > at('delegations'), 'the first Insights entry');
  assert.match(src, /apps: 'AdminAppsUsage',/);
  assert.match(src, /'apps': '<svg /, 'a nav icon like every section');
  assert.match(read('frontend/src/features/admin/sections.ts'), /import '\.\/admin-apps-usage\.tsx';/);
});

test('it mounts through the render/destroy portal seam and draws with AdminUI', () => {
  const src = read(SECTION);
  assert.match(src, /render\(el: Element\) \{\s*host = el;\s*mountLegacyPortal\(el, <AppsUsageSection \/>\);/);
  assert.match(src, /destroy\(\) \{\s*unmountLegacyPortal\(host\);\s*host = null;/);
  assert.match(src, /import \{ AdminUI \} from '\.\/admin-console\.js';/);
  assert.doesNotMatch(src, /@\/components\/ui/, 'no admin source imports the shell primitives');
  assert.doesNotMatch(src, /requireAdminWrite|canWrite/, 'nothing here writes, so view-only admins see all of it');
  assert.doesNotMatch(src, /AdminUI\.[a-zA-Z]+\[/, 'the registry is never indexed dynamically');
  const audit = read('scripts/audit-react-ownership.mjs');
  assert.match(audit, /\{ sel: '#admin-section-content', when: '#admin\/apps' \}/);
  assert.match(audit, /'#admin\/apps'/);
});

test('the read is admin-gated but not write-gated', () => {
  const src = read('src/routes/admin.js');
  assert.match(src, /router\.get\('\/api\/admin\/apps-usage', async \(req, res\) => \{/,
    'on the plain adminMiddleware gate, like every console read');
});

test('the window is held to the ones the screen offers', () => {
  assert.deepEqual(usage.WINDOWS, [7, 30, 90]);
  assert.equal(usage.windowDays('7'), 7);
  assert.equal(usage.windowDays(90), 90);
  assert.equal(usage.windowDays('365'), usage.DEFAULT_DAYS, 'a window the screen does not offer');
  assert.equal(usage.windowDays(undefined), usage.DEFAULT_DAYS);
  assert.equal(usage.windowDays('30; DROP TABLE apps'), 30, 'only ever an integer reaches the query');
});

test('the payload joins each app to its top contributors and totals the window', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/ROW_NUMBER\(\) OVER/.test(sql)) {
        return { rows: [
          { app_id: 1, username: 'alice', proposed: 3, merged: 2 },
          { app_id: 1, username: 'bob', proposed: 1, merged: 0 },
        ] };
      }
      return { rows: [
        {
          id: 1, slug: 'recipe-bot', name: 'Recipe Bot', status: 'running', self_hosted: false,
          view_visibility: 'public', created_at: '2026-09-01T10:00:00Z', last_deploy_at: '2026-10-10T10:00:00Z',
          creator: 'alice', members: 12, new_members: 3, contributors: 2, shipped_contributors: 1,
          sessions: 4, proposed: 3, merged: 2, requests: 5, open_requests: 7, users: 9, seconds: '3720',
          last_active_at: '2026-10-12T08:00:00Z',
        },
        {
          id: 2, slug: 'quiet', name: 'Quiet', status: 'error', self_hosted: false,
          view_visibility: null, created_at: '2026-10-01T10:00:00Z', last_deploy_at: null,
          creator: null, members: 0, new_members: 0, contributors: 0, shipped_contributors: 0,
          sessions: 0, proposed: 0, merged: 0, requests: 0, open_requests: 0, users: 0, seconds: '0',
          last_active_at: null,
        },
      ] };
    },
  };
  const out = await usage.adminPayload(pool, { days: '7' });
  assert.equal(out.days, 7);
  assert.deepEqual(out.windows, [7, 30, 90]);
  const appsCall = calls.find((c) => !/ROW_NUMBER/.test(c.sql));
  assert.deepEqual(appsCall.params, [7], 'the window is a bound parameter');
  assert.deepEqual(calls.find((c) => /ROW_NUMBER/.test(c.sql)).params, [usage.TOP_CONTRIBUTORS]);

  const [busy, quiet] = out.apps;
  assert.equal(busy.slug, 'recipe-bot');
  assert.equal(busy.seconds, 3720, 'the bigint sum arrives as a string and leaves as a number');
  assert.equal(busy.lastActiveAt, '2026-10-12T08:00:00.000Z');
  assert.deepEqual(busy.topContributors, [
    { username: 'alice', proposed: 3, merged: 2 },
    { username: 'bob', proposed: 1, merged: 0 },
  ]);
  assert.deepEqual(quiet.topContributors, []);
  assert.equal(quiet.creator, null);
  assert.equal(quiet.lastActiveAt, null);
  assert.deepEqual(out.totals, {
    apps: 2, usedApps: 1, builtApps: 1, seconds: 3720, proposed: 3, merged: 2, requests: 5,
  });
});

test('the SQL counts members from the community, contributors from proposals and requests of kind general', () => {
  const src = read('src/services/admin-apps-usage.js');
  assert.match(src, /JOIN community_members cm ON cm\.community_id = a\.community_id/);
  assert.match(src, /COUNT\(DISTINCT cs\.user_id\) FILTER \(WHERE cs\.pr_number IS NOT NULL\)::int AS contributors/);
  assert.match(src, /WHERE i\.kind = 'general'/);
  assert.match(src, /make_interval\(days => \$1::int\)/);
});

test('the section searches, sorts and words its figures', () => {
  const { loadTsx } = require('./lib/render-tsx.js');
  const mod = loadTsx(SECTION, { stubs: { '../../lib/legacy-portals': { mountLegacyPortal() {}, unmountLegacyPortal() {} } } });
  const app = (slug, extra) => ({
    slug, name: slug, status: 'running', platform: false, visibility: 'public', creator: null,
    createdAt: null, lastDeployAt: null, lastActiveAt: null, members: 0, newMembers: 0,
    contributors: 0, shippedContributors: 0, topContributors: [], users: 0, seconds: 0,
    sessions: 0, proposed: 0, merged: 0, requests: 0, openRequests: 0, ...extra,
  });
  const apps = [
    app('bravo', { seconds: 50, members: 9, createdAt: '2026-09-01T00:00:00Z', creator: 'carol' }),
    app('alpha', { seconds: 50, members: 1, createdAt: '2026-10-01T00:00:00Z', lastActiveAt: '2026-10-12T00:00:00Z' }),
    app('charlie', { seconds: 900, members: 4 }),
  ];
  const slugs = (list) => list.map((a) => a.slug);
  assert.deepEqual(slugs(mod.sortApps(apps, 'used')), ['charlie', 'alpha', 'bravo'], 'a tie falls back to the name');
  assert.deepEqual(slugs(mod.sortApps(apps, 'members')), ['bravo', 'charlie', 'alpha']);
  assert.deepEqual(slugs(mod.sortApps(apps, 'newest')), ['alpha', 'bravo', 'charlie'], 'no date sorts last');
  assert.deepEqual(slugs(mod.sortApps(apps, 'active')), ['alpha', 'bravo', 'charlie']);
  assert.deepEqual(slugs(mod.sortApps(apps, 'name')), ['alpha', 'bravo', 'charlie']);
  assert.deepEqual(slugs(mod.sortApps(apps, 'nonsense')), ['charlie', 'alpha', 'bravo'], 'an unknown sort is Most time used');
  assert.deepEqual(slugs(apps), ['bravo', 'alpha', 'charlie'], 'never mutates');
  assert.ok(mod.SORTS.every((s) => mod.sortApps(apps, s.key).length === 3), 'every offered sort has an order');

  assert.deepEqual(slugs(mod.filterApps(apps, '  CAROL ')), ['bravo'], 'matches the creator, case-insensitively');
  assert.deepEqual(slugs(mod.filterApps(apps, 'arl')), ['charlie']);
  assert.equal(mod.filterApps(apps, '').length, 3);

  assert.equal(mod.formatDuration(0), '0s');
  assert.equal(mod.formatDuration(45), '45s');
  assert.equal(mod.formatDuration(720), '12m');
  assert.equal(mod.formatDuration(3600), '1h');
  assert.equal(mod.formatDuration(12000), '3h 20m');
  assert.equal(mod.formatDuration(187200), '2d 4h');

  assert.equal(mod.statusBadge('running').label, 'Running');
  assert.equal(mod.statusBadge('error').label, 'Failed');
  assert.equal(mod.statusBadge('awaiting_secrets').label, 'Needs secrets');
  assert.equal(mod.statusBadge('creating').label, 'creating', 'a status this build has no words for still reads');
});
