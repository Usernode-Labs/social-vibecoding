'use strict';

// Welcome messages (#admin/welcome-dm): the parts that need no database.
// The trigger, the sweep and the routes run against real PostgreSQL in
// tests/welcome-dm-postgres.test.js; this pins the rendering helpers, the
// console card, and every place a new section has to be registered.
//
// Run with: node --test tests/welcome-dm.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const welcomeDm = require('../src/services/welcome-dm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('{username} fills the title and the message, and a long title stays inside 80 characters', () => {
  assert.equal(welcomeDm.render('Hi @{username}, {username}!', { username: 'ada' }), 'Hi @ada, ada!');
  assert.equal(welcomeDm.renderTitle('Welcome,   {username}', { username: 'ada' }), 'Welcome, ada');
  const long = welcomeDm.renderTitle('Welcome to the platform, {username}', { username: 'x'.repeat(80) });
  assert.equal(long.length, 80);
  assert.ok(long.endsWith('…'));
  assert.ok(welcomeDm.DEFAULT_TITLE.includes('{username}'));
  assert.ok(welcomeDm.DEFAULT_MESSAGE.includes('@{username}'));
});

test('a patch is validated before anything is read or written', async () => {
  const pool = { query() { throw new Error('no query expected'); } };
  assert.deepEqual(await welcomeDm.validatePatch(pool, {}), { ok: false, error: 'Nothing to update' });
  assert.equal((await welcomeDm.validatePatch(pool, { enabled: 'yes' })).ok, false);
  assert.equal((await welcomeDm.validatePatch(pool, { title: '   ' })).ok, false);
  assert.equal((await welcomeDm.validatePatch(pool, { title: 'x'.repeat(81) })).ok, false);
  assert.equal((await welcomeDm.validatePatch(pool, { message: '' })).ok, false);
  assert.equal((await welcomeDm.validatePatch(pool, { members: 'evan' })).ok, false);
  assert.equal((await welcomeDm.validatePatch(pool, {
    members: Array.from({ length: welcomeDm.MAX_MEMBERS + 1 }, (_, i) => `u${i}`),
  })).ok, false);
  assert.deepEqual(await welcomeDm.validatePatch(pool, { title: ' Hi  {username} ' }),
    { ok: true, updates: [['welcome_dm_title', 'Hi {username}']] });
});

test('the sweep runs on the leader, and the write is for full admins only', () => {
  const server = read('server.js');
  const leader = server.slice(server.indexOf('async function becomeLeader()'));
  assert.match(leader, /require\('\.\/src\/services\/welcome-dm'\)\.start\(config\);/);
  const admin = read('src/routes/admin.js');
  assert.match(admin, /router\.get\('\/api\/admin\/welcome-dm', async/);
  assert.match(admin, /router\.put\('\/api\/admin\/welcome-dm', requireAdminWrite,/);
  const schema = read('src/db/schema.sql');
  assert.match(schema, /CREATE TRIGGER users_enqueue_welcome_dm\s+AFTER INSERT OR UPDATE OF has_platform_access ON users/);
  assert.match(schema, /COMMENT ON TABLE welcome_dm_queue IS 'staging:private';/);
});

test('the section is registered everywhere a console section has to be', () => {
  const consoleJs = read('frontend/src/features/admin/admin-console.js');
  assert.match(consoleJs, /\{ key: 'welcome-dm', label: 'Welcome messages', group: 'People' \}/);
  assert.match(consoleJs, /'welcome-dm': 'AdminWelcomeDm'/);
  assert.match(consoleJs, /'welcome-dm': '<svg/, 'the nav entry has an icon like its neighbours');
  assert.match(read('frontend/src/features/admin/sections.ts'), /import '\.\/admin-welcome-dm\.tsx';/);
  const audit = read('scripts/audit-react-ownership.mjs');
  assert.match(audit, /\{ sel: '#admin-section-content', when: '#admin\/welcome-dm' \}/);
  assert.match(audit, /'#admin\/welcome-dm'/);
  const inventory = JSON.parse(read('src/services/global-chat/classic-inventory.generated.json'));
  const routes = JSON.stringify(inventory);
  assert.ok(routes.includes('"path":"/api/admin/welcome-dm"'), 'the Global Chat inventory lists the routes');
});

function loadSection() {
  globalThis.window = globalThis.window || globalThis;
  return loadTsx('frontend/src/features/admin/admin-welcome-dm.tsx', {
    stubs: {
      './admin-console.js': {
        AdminUI: new Proxy({}, {
          get: (_t, key) => (['btn', 'badge'].includes(key) ? new Proxy({}, { get: (_u, k) => `${key}-${String(k)}` }) : String(key)),
        }),
      },
      '../../lib/legacy-portals': { mountLegacyPortal() {}, unmountLegacyPortal() {} },
    },
  });
}

const PAYLOAD = {
  enabled: true,
  members: [
    { id: 1, username: 'evan', active: true },
    { id: 2, username: 'lukas', active: true },
    { id: 3, username: 'gone', active: false },
  ],
  title: 'Welcome, {username}',
  message: 'Hi @{username}!',
  defaults: { title: welcomeDm.DEFAULT_TITLE, message: welcomeDm.DEFAULT_MESSAGE },
  limits: { title: 80, message: 4000, members: 10 },
  updatedAt: '2026-09-29T12:00:00.000Z',
  updatedBy: 'evan',
  pending: 2,
  sent: 1,
  recent: [
    { userId: 9, username: 'ada', status: 'sent', enqueuedAt: '2026-09-29T12:00:00.000Z', processedAt: null, conversationId: 4, detail: null, attempts: 1 },
    { userId: 8, username: 'bea', status: 'pending', enqueuedAt: '2026-09-29T11:00:00.000Z', processedAt: null, conversationId: null, detail: null, attempts: 0, waitingForUsername: true },
    { userId: 6, username: 'dee', status: 'pending', enqueuedAt: '2026-09-29T10:00:00.000Z', processedAt: null, conversationId: null, detail: null, attempts: 0 },
    { userId: 7, username: 'cy', status: 'skipped', enqueuedAt: '2026-09-28T11:00:00.000Z', processedAt: null, conversationId: null, detail: 'no_one_to_send', attempts: 1 },
  ],
};

test('the section reads its settings before it offers a field', () => {
  const mod = loadSection();
  globalThis.window.AdminConsole = { canWrite: () => true, fetchJson: async () => ({ data: null }) };
  const html = renderToHtml(createElement(mod.WelcomeDmSection, {}));
  assert.match(html, /id="admin-welcome-dm"/);
  assert.match(html, /id="admin-welcome-dm-intro"/);
  assert.match(html, /When someone is let in to the platform/);
  assert.match(html, /Loading…/);
  assert.doesNotMatch(html, /id="admin-welcome-dm-members"/, 'no field before the read lands');
  assert.doesNotMatch(html, /—/, 'no em dash in the copy');
});

test('the form shows the saved people in order, the preview, and Save only to full admins', () => {
  const mod = loadSection();
  const html = renderToHtml(createElement(mod.WelcomeDmForm, { data: PAYLOAD, canWrite: true, onSaved() {} }));
  assert.match(html, /id="admin-welcome-dm-enabled"[^>]*checked=""/);
  assert.match(html, /id="admin-welcome-dm-members"[^>]*value="@evan, @lukas, @gone"/);
  assert.match(html, /id="admin-welcome-dm-title"[^>]*value="Welcome, \{username\}"/);
  assert.match(html, /Hi @\{username\}!<\/textarea>/);
  assert.match(html, /id="admin-welcome-dm-inactive"/, 'someone who can no longer take part is called out');
  assert.match(html, /Welcome, newcomer/, 'the preview fills the placeholder');
  assert.match(html, /Hi @newcomer!/);
  assert.match(html, /id="admin-welcome-dm-save"/);
  assert.match(html, /Last changed by @evan on 2026-09-29\./);
  assert.doesNotMatch(html, /—/);

  const viewOnly = renderToHtml(createElement(mod.WelcomeDmForm, { data: PAYLOAD, canWrite: false, onSaved() {} }));
  assert.doesNotMatch(viewOnly, /admin-welcome-dm-save/, 'a view-only admin gets no Save');
  assert.match(viewOnly, /id="admin-welcome-dm-members"[^>]*disabled=""/);
});

test('recently welcomed lists each person with what happened', () => {
  const mod = loadSection();
  const html = renderToHtml(createElement(mod.RecentlyWelcomed, { data: PAYLOAD }));
  assert.match(html, /1 sent · 2 waiting/);
  assert.match(html, /Sending within a minute\./);
  assert.match(html, /data-welcome-user="9"/);
  assert.match(html, /@ada/);
  assert.match(html, />Sent</);
  assert.match(html, />Waiting</);
  assert.match(html, /Sent once they have picked a username\./);
  assert.match(html, /Nobody in the list could send it\./);
  const empty = renderToHtml(createElement(mod.RecentlyWelcomed, { data: { ...PAYLOAD, recent: [] } }));
  assert.match(empty, /id="admin-welcome-dm-empty"/);
});
