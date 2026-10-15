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
//   - Share it and "What do you want to change?" each have a ✕ that closes
//     the card on that project for good (hub-dismissed.ts);
//   - Share it says what invite is out, "Invite link sent · nobody has
//     joined yet · 7 days left" (community-card.tsx inviteSentLine), from
//     the hub read's `invite_summary` (community-invites.js inviteSummary);
//   - the payload's new fields (routes/apps.js GET /api/apps/:slug/community).
//
// The hub's order, For you and Recently live's own card are pinned beside
// the tests they changed (tests/community-hub.test.js,
// tests/hub-just-you.test.js), the hero in tests/community-hub-details.test.js,
// and the Communities list's "Invite link out" in tests/workshop-screen.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CARD = 'frontend/src/features/dev-board/workshop/community-card.tsx';
const DISMISSED = 'frontend/src/features/dev-board/workshop/hub-dismissed.ts';
const DAY = 24 * 60 * 60 * 1000;

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
    assert.equal(mod.isHubCardDismissed('garden', 'share'), false, 'nothing closed yet');
    mod.dismissHubCard('garden', 'share');
    assert.equal(mod.isHubCardDismissed('garden', 'share'), true);
    assert.equal(mod.isHubCardDismissed('garden', 'start'), false, 'one card, not both');
    assert.equal(mod.isHubCardDismissed('orchard', 'share'), false, 'one project, not every one');
    const kept = JSON.parse(storage.getItem('hubDismissed:v1:7'));
    assert.deepEqual(Object.keys(kept), ['garden'], 'kept on the device, under this account');
    assert.equal(typeof kept.garden.share, 'number');
  });
  // Another account on the same device reads its own record.
  withWindow({ App: { user: { id: 8 } }, localStorage: storage }, () => {
    mod.hydrateHubDismissed();
    assert.equal(mod.isHubCardDismissed('garden', 'share'), false, 'not closed for somebody else');
  });
  // And the first account, back again (a reload: a fresh module), finds it closed.
  const again = loadTsx(DISMISSED, { cache: false });
  withWindow(win, () => {
    again.hydrateHubDismissed();
    assert.equal(again.isHubCardDismissed('garden', 'share'), true, 'for good');
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
    for (let i = 0; i < many.HUB_DISMISSED_MAX + 5; i++) many.dismissHubCard(`p${i}`, 'share');
    assert.equal(Object.keys(JSON.parse(big.getItem('hubDismissed:v1:9'))).length, many.HUB_DISMISSED_MAX);
  });
  // Read in a layout effect, never during render (the island rule).
  const src = read(DISMISSED);
  assert.match(src, /useLayoutEffect\(\(\) => \{ hydrateHubDismissed\(\); \}, \[\]\);/);
});

test('Share it: a ✕ that closes it, and one line about the invite that is out', async () => {
  const realFetch = globalThis.fetch;
  const record = (over = {}) => ({
    slug: 'garden-share', name: 'Garden', description: null, member_count: 1, is_member: true, is_creator: true,
    audience: 'solo', audience_label: 'Just you', members: [{ id: 1, username: 'ada' }], channel: null,
    activity: null, can_manage: true, audience_change: null, first_version: null, invite_link: false, invite_summary: null,
    approval: { policy: 'anyone', approvals_required: null, electorate: 1, required: 1 },
    ...over,
  });
  const soon = new Date(Date.now() + 7 * DAY - 60000).toISOString();
  const records = {
    'garden-share': record(),
    'garden-share-link': record({ slug: 'garden-share-link', invite_link: true, invite_summary: { links: 1, joined: 0, waiting: 0, expires_at: soon } }),
    'garden-share-group': record({ slug: 'garden-share-group', audience: 'invited', audience_label: 'Private community', member_count: 2 }),
  };
  globalThis.fetch = async (url) => {
    const slug = String(url).match(/\/api\/apps\/([^/]+)\/community/)[1];
    return { ok: true, json: async () => records[slug] };
  };
  try {
    let closed = false;
    const presses = [];
    const card = loadTsx(CARD, {
      cache: false,
      stubs: { './hub-dismissed': { useHubDismissed: (slug, which) => [closed, () => presses.push([slug, which])] } },
    });
    for (const slug of Object.keys(records)) await card.reloadCommunity(slug);
    const draw = (slug) => renderToHtml(createElement(card.ShareItCard, { slug, name: 'Garden' }));
    const plain = draw('garden-share');
    assert.match(plain, /^<section class="dev-ws-strip dev-ws-share" data-ws-share=""><div class="dev-ws-head"><span class="dev-ws-head-title">Share it<\/span><button type="button" class="dev-ws-card-close un-touch-target" data-ws-card-close="share" aria-label="Close this card" title="Close this card"><svg[^>]*>[\s\S]*?<\/svg><\/button><\/div><p class="dev-ws-strip-text">/,
      'its ✕ ends the head; no line while no link is out');
    assert.doesNotMatch(plain, /data-ws-share-sent/);
    const link = draw('garden-share-link');
    assert.match(link, /<\/div><p class="dev-ws-share-sent" data-ws-share-sent="">Invite link sent · nobody has joined yet · 7 days left<\/p><p class="dev-ws-strip-text">/,
      'the line over the card\'s text');
    assert.match(link, /data-ws-share-invite=""[^>]*>Invite people<\/button>/, 'and its Invite, as before');
    assert.equal(draw('garden-share-group'), '', 'a group has no Share it');
    closed = true;
    assert.equal(draw('garden-share'), '', 'closed: gone on this project');
  } finally {
    globalThis.fetch = realFetch;
  }
  const src = read(CARD);
  assert.match(src, /const \[closed, close\] = useHubDismissed\(slug, 'share'\);\s*if \(!data \|\| data\.audience !== 'solo' \|\| closed\) return null;/);
  assert.match(src, /<HubCardClose card="share" onClose=\{close\} \/>/);
  // What it offered stays on the page: Invite in the hero's row.
  assert.match(src, /\{member \? \(\s*<Button[\s\S]{0,160}data-ws-community-invite=""/);
  assert.match(read('public/css/app.css'), /\.dev-ws-card-close \{\s*margin: -6px -6px -6px auto;/);
});

test('the invite line says how many joined and how long the soonest link has left, in words', () => {
  const { inviteSentLine, linkTimeLeft } = loadTsx(CARD);
  const now = Date.parse('2026-10-15T12:00:00Z');
  const at = (ms) => new Date(now + ms).toISOString();
  const line = (over) => inviteSentLine({ links: 1, joined: 0, waiting: 0, expires_at: at(7 * DAY - 60000), ...over }, now);
  assert.equal(line({}), 'Invite link sent · nobody has joined yet · 7 days left', 'a link made a minute ago for a week');
  assert.equal(line({ joined: 1, expires_at: at(6 * DAY) }), 'Invite link sent · 1 joined · 6 days left');
  assert.equal(line({ joined: 2, expires_at: at(6 * DAY) }), 'Invite link sent · 2 joined · 6 days left');
  assert.equal(line({ links: 2 }), '2 invite links sent · nobody has joined yet · 7 days left');
  assert.equal(line({ expires_at: at(DAY + 60000) }), 'Invite link sent · nobody has joined yet · 1 day left');
  assert.equal(line({ expires_at: at(DAY - 60000) }), 'Invite link sent · nobody has joined yet · expires today', 'under a day');
  assert.equal(line({ expires_at: null }), 'Invite link sent · nobody has joined yet', 'a link with no end says no time');
  assert.equal(inviteSentLine({ links: 0, joined: 0, waiting: 0, expires_at: null }, now), '', 'no live link: nothing');
  assert.equal(inviteSentLine(null, now), '');
  assert.equal(linkTimeLeft(at(3 * DAY + 3 * 3600 * 1000), now), '3 days left', 'rounded');
  assert.equal(linkTimeLeft(at(-60000), now), 'expires today', 'a clock behind the server\'s');
  assert.equal(linkTimeLeft('not a date', now), '');
  for (const id of ['communityCard.share.sent_one', 'communityCard.share.nobodyJoined', 'communityCard.share.joined_other',
    'communityCard.share.daysLeft_other', 'communityCard.share.expiresToday', 'hub.card.close']) {
    assert.ok(message(`project:${id}`), id);
  }
});

test('the hub read carries the invite links out, summed as listInvites lists them, and since when the app is live', () => {
  const invites = require('../src/services/community-invites');
  const link = (over) => ({ status: 'live', joined: 0, waiting: 0, expiresAt: null, ...over });
  assert.deepEqual(invites.summarizeLinks([
    link({ joined: 1, expiresAt: '2026-10-22T10:00:00.000Z' }),
    link({ waiting: 2, expiresAt: '2026-10-18T10:00:00.000Z' }),
    link({}),
    link({ status: 'expired', joined: 5, expiresAt: '2026-10-01T10:00:00.000Z' }),
    link({ status: 'revoked', joined: 3 }),
  ]), { links: 3, joined: 1, waiting: 2, expires_at: '2026-10-18T10:00:00.000Z' }, 'the live ones alone, and the soonest end');
  assert.deepEqual(invites.summarizeLinks([]), { links: 0, joined: 0, waiting: 0, expires_at: null });
  assert.deepEqual(invites.summarizeLinks([link({})]).expires_at, null, 'no end: none');
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
