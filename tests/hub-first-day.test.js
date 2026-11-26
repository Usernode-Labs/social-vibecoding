'use strict';

// One hub from a project's first day (15 Oct 2026,
// frontend/src/features/dev-board/workshop/).
//
// A brand-new ready-made app's hub looked nothing like an older project's:
// no name or tile (its first week had a hero of its own, which expected the
// First version card to draw them), "Private community" between open seats
// once a link was out though nobody had joined, no For you at all, and no
// Recently live. Evan approved, and this pins:
//
//   - the hub's cards each have a ✕ that closes the card on that project
//     for good (hub-dismissed.ts);
//   - the payload's new fields (routes/apps.js GET /api/apps/:slug/community),
//     the invite links out summed in `invite_summary` (community-invites.js
//     inviteSummary).
//
// The Share it and Invite cards that read them were the brand look's hub,
// removed 26 Nov 2026.
//
// The hub's order, For you and Recently live's own card are pinned beside
// the tests they changed (tests/community-hub.test.js,
// tests/hub-just-you.test.js), the hero in tests/community-hub-details.test.js,
// and the Communities list's "Invite link out" in tests/workshop-screen.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DISMISSED = 'frontend/src/features/dev-board/workshop/hub-dismissed.ts';

function fakeStorage({ broken = false } = {}) {
  const map = new Map();
  return {
    map,
    getItem: (k) => { if (broken) throw new Error('blocked'); return map.has(k) ? map.get(k) : null; },
    setItem: (k, v) => { if (broken) throw new Error('blocked'); map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

function withWindow(win, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prev = globalThis.window;
  globalThis.window = win;
  try { return fn(); } finally {
    if (had) globalThis.window = prev; else delete globalThis.window;
  }
}

test('a closed card stays closed for that person on that project, and nowhere else', () => {
  const mod = loadTsx(DISMISSED, { cache: false });
  const storage = fakeStorage();
  const win = { App: { user: { id: 7 } }, localStorage: storage };
  withWindow(win, () => {
    mod.hydrateHubDismissed();
    assert.equal(mod.isHubCardDismissed('garden', 'first'), false, 'nothing closed yet');
    mod.dismissHubCard('garden', 'first');
    assert.equal(mod.isHubCardDismissed('garden', 'first'), true);
    assert.equal(mod.isHubCardDismissed('garden', 'start'), false, 'one card, not both');
    assert.equal(mod.isHubCardDismissed('orchard', 'first'), false, 'one project, not every one');
    const kept = JSON.parse(storage.getItem('hubDismissed:v1:7'));
    assert.deepEqual(Object.keys(kept), ['garden'], 'kept on the device, under this account');
    assert.equal(typeof kept.garden.first, 'number');
  });
  // Another account on the same device reads its own record.
  withWindow({ App: { user: { id: 8 } }, localStorage: storage }, () => {
    mod.hydrateHubDismissed();
    assert.equal(mod.isHubCardDismissed('garden', 'first'), false, 'not closed for somebody else');
  });
  // And the first account, back again (a reload: a fresh module), finds it closed.
  const again = loadTsx(DISMISSED, { cache: false });
  withWindow(win, () => {
    again.hydrateHubDismissed();
    assert.equal(again.isHubCardDismissed('garden', 'first'), true, 'for good');
  });
  // A private window: closed for the page, and never an error.
  const blocked = loadTsx(DISMISSED, { cache: false });
  withWindow({ App: { user: { id: 7 } }, localStorage: fakeStorage({ broken: true }) }, () => {
    blocked.hydrateHubDismissed();
    blocked.dismissHubCard('garden', 'start');
    assert.equal(blocked.isHubCardDismissed('garden', 'start'), true);
  });
  // Bounded: the newest HUB_DISMISSED_MAX projects are kept.
  const many = loadTsx(DISMISSED, { cache: false });
  const big = fakeStorage();
  withWindow({ App: { user: { id: 9 } }, localStorage: big }, () => {
    many.hydrateHubDismissed();
    for (let i = 0; i < many.HUB_DISMISSED_MAX + 5; i++) many.dismissHubCard(`p${i}`, 'first');
    assert.equal(Object.keys(JSON.parse(big.getItem('hubDismissed:v1:9'))).length, many.HUB_DISMISSED_MAX);
  });
  // Read in a layout effect, never during render (the island rule).
  const src = read(DISMISSED);
  assert.match(src, /useLayoutEffect\(\(\) => \{ hydrateHubDismissed\(\); \}, \[\]\);/);
});

test('the hub read carries the invite links out, summed as listInvites lists them, and since when the app is live', () => {
  const invites = require('../src/services/community-invites');
  const link = (over) => ({ status: 'live', joined: 0, waiting: 0, expiresAt: null, shared: true, ...over });
  assert.deepEqual(invites.summarizeLinks([
    link({ joined: 1, expiresAt: '2026-10-22T10:00:00.000Z' }),
    link({ waiting: 2, expiresAt: '2026-10-18T10:00:00.000Z' }),
    link({}),
    link({ status: 'expired', joined: 5, expiresAt: '2026-10-01T10:00:00.000Z' }),
    link({ status: 'revoked', joined: 3 }),
  ]), { links: 3, joined: 1, waiting: 2, expires_at: '2026-10-18T10:00:00.000Z' }, 'the live ones alone, and the soonest end');
  assert.deepEqual(invites.summarizeLinks([]), { links: 0, joined: 0, waiting: 0, expires_at: null });
  assert.deepEqual(invites.summarizeLinks([link({})]).expires_at, null, 'no end: none');
  // Audit D03: a link nobody copied, shared or came through is not out.
  assert.equal(invites.summarizeLinks([link({ shared: false })]).links, 0, 'made by opening the pane: not out');
  assert.equal(invites.summarizeLinks([link({ shared: false, waiting: 1 })]).links, 1, 'somebody came through it: out');
  const svc = read('src/services/community-invites.js');
  assert.match(svc, /async function inviteSummary\(pool, \{ app, user \}\) \{\s*if \(!app \|\| !user\) return null;\s*const \{ links \} = await listInvites\(pool, \{ app, user \}\);\s*return summarizeLinks\(links\);/,
    'the very links listInvites shows this viewer: their own, or every one to someone who manages the project');
  const route = read('src/routes/apps.js');
  const hub = route.slice(route.indexOf("router.get('/api/apps/:slug/community'"), route.indexOf('res.json({', route.indexOf("router.get('/api/apps/:slug/community'")));
  assert.match(hub, /if \(req\.user\?\.id && \(membership\?\.is_member \|\| canManage\)\) \{\s*try \{\s*inviteSummary = await communityInvites\.inviteSummary\(pool, \{ app, user: req\.user \}\);/);
  assert.match(hub, /COALESCE\(first_running_at, CASE WHEN status = 'running' THEN created_at END\) AS live_since/);
  const body = route.slice(route.indexOf('res.json({', route.indexOf("router.get('/api/apps/:slug/community'")));
  assert.match(body, /invite_link: inviteLink,\s*invite_summary: inviteSummary,/);
  assert.match(body, /live_since: app\.self_hosted \|\| !app\.live_since \? null : new Date\(app\.live_since\)\.toISOString\(\),/);
  assert.doesNotMatch(body.slice(0, body.indexOf('first_version: firstVersion')), /first_week/, 'the hub has no first week of its own');
});
