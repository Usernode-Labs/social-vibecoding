'use strict';

// #3700: an invite link opens the community's page with Join on it, instead
// of a confirm over Home.
//
//   - The link's standing names the project's page (`page`) for somebody not
//     in it yet who may already open it: a public community. For a private
//     one it carries `invitePreview` instead, and never the project's
//     address (src/services/community-invites.js). Both only for a live link.
//   - App._followInvite opens that page, in its not-joined state, with the
//     link published to its hero (App._openInvitePage), the link's address
//     replaced by the page's so Back goes to where the person was before.
//     A private community's link opens its invite preview
//     (App._openInvitePreview, frontend/src/features/invite-preview), drawn
//     from the standing alone, over Home's address. With neither, the
//     confirm, as before.
//   - The hero leads with who invited them and one "Join <name>"
//     (frontend/src/features/dev-board/workshop/community-card.tsx), which
//     follows the link (./invite-offer.ts) and lands on Needs you's first
//     card when votes are waiting on the new member, else stays on the hub.
//   - A Join anywhere else (the confirm, a sign-up from the invite card that
//     "You're in" does not cover) lands the same way (App._landJoined).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const TOKEN = 'YigKXxtTzBB_TFZVTkjEtg';
const CARD = 'frontend/src/features/dev-board/workshop/community-card.tsx';
const OFFER = 'frontend/src/features/dev-board/workshop/invite-offer.ts';

// ── The standing names the page ────────────────────────────────────────

/** A pool answering the reads standing() makes, by what each one asks. */
function standingPool({ app, member = false, blocked = false, suspended = false, link = {} }) {
  const invite = {
    id: 5, token: TOKEN, community_id: 3, app_id: app.id, created_by: 1, max_uses: 25, uses: 0,
    expires_at: new Date(Date.now() + 86400000), revoked_at: null, note: 'Come vote', maker_holds: true,
    slug: app.slug, name: app.name, icon_emoji: '📚', icon_image_id: null, app_created_by: 1,
    self_hosted: !!app.self_hosted, collab_visibility: app.collab, view_visibility: app.view,
    app_community_id: 3, description: 'Our monthly pick', inviter: 'maya', inviter_display_name: 'Maya',
    ...link,
  };
  const asked = [];
  return {
    asked,
    query: async (sql) => {
      if (/FROM community_invites i/.test(sql)) return { rows: [invite] };
      if (/AS n FROM community_members/.test(sql)) return { rows: [{ n: 4 }] };
      if (/FROM chat_sessions s|app_illustrations|FROM app_sketches/.test(sql)) return { rows: [] };
      if (/homeroom_bot_first_versions/.test(sql)) return { rows: [{ pending: false }] };
      if (/FROM community_invite_redemptions/.test(sql)) return { rows: [] };
      if (/JOIN community_members m ON m\.community_id = a\.community_id/.test(sql)) return { rows: member ? [{}] : [] };
      if (/FROM app_collaborators/.test(sql)) return { rows: member ? [{}] : [] };
      if (/FROM user_app_blocks/.test(sql)) return { rows: blocked ? [{ app_id: app.id }] : [] };
      if (/FROM apps WHERE id = \$1/.test(sql)) {
        asked.push('page');
        return {
          rows: [{
            id: app.id, slug: app.slug, created_by: 1, self_hosted: !!app.self_hosted,
            collab_visibility: app.collab, view_visibility: app.view,
            moderation_suspended_at: suspended ? new Date() : null, icon_color: '#2e6660',
          }],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const PUBLIC = { id: 1, slug: 'arena', name: 'Arena', collab: 'public', view: 'public' };
const PRIVATE = { id: 2, slug: 'book-club', name: 'Book Club', collab: 'private', view: 'private' };
const BO = { id: 2, username: 'bo', isAdmin: false, hasPlatformAccess: true };

test('the standing names a public community\'s page to somebody not in it, and a private one\'s to nobody outside', async () => {
  const invites = require('../src/services/community-invites');
  const open = await invites.standing(standingPool({ app: PUBLIC }), TOKEN, BO);
  assert.deepEqual([open.live, open.mine, open.slug, open.page, open.invitePreview], [true, null, null, 'arena', null],
    'the page, while the address of the project they are in stays `slug`');
  const closed = await invites.standing(standingPool({ app: PRIVATE }), TOKEN, BO);
  assert.equal(closed.page, null, 'a private project\'s page is for its members');
  assert.deepEqual(closed.invitePreview, { iconColor: '#2e6660', audienceLabel: 'Private community' },
    'so its link is an invite preview, with only the colour its header wears beyond the link\'s own preview');
  const admin = await invites.standing(standingPool({ app: PRIVATE }), TOKEN, { ...BO, isAdmin: true });
  assert.deepEqual([admin.page, admin.invitePreview], ['book-club', null], 'an admin may open any page');
  for (const app of [PUBLIC, PRIVATE]) {
    const blocked = await invites.standing(standingPool({ app, blocked: true }), TOKEN, BO);
    assert.deepEqual([blocked.page, blocked.invitePreview], [null, null], `a blocked ${app.view} app is neither opened nor previewed`);
    const suspended = await invites.standing(standingPool({ app, suspended: true }), TOKEN, BO);
    assert.deepEqual([suspended.page, suspended.invitePreview], [null, null], `nor a suspended ${app.view} one`);
  }
  const inIt = standingPool({ app: PUBLIC, member: true });
  const joined = await invites.standing(inIt, TOKEN, BO);
  assert.deepEqual([joined.mine, joined.slug, joined.page, joined.invitePreview], ['joined', 'arena', null, null], 'a member opens the hub, as before');
  assert.deepEqual(inIt.asked, [], 'and nothing is read to decide it');
  const privateMember = await invites.standing(standingPool({ app: PRIVATE, member: true }), TOKEN, BO);
  assert.deepEqual([privateMember.mine, privateMember.slug, privateMember.invitePreview], ['joined', 'book-club', null]);
  // The platform's own project, only where its page's community read answers.
  const own = { ...PUBLIC, self_hosted: true };
  assert.equal((await invites.standing(standingPool({ app: own }), TOKEN, BO)).page, null);
  assert.equal((await invites.standing(standingPool({ app: own }), TOKEN, BO, { showSelfHosted: true })).page, 'arena');
  // A read that fails is no page, never a failed standing.
  const broken = standingPool({ app: PUBLIC });
  const query = broken.query;
  broken.query = async (sql, params) => {
    if (/FROM apps WHERE id = \$1/.test(sql)) throw new Error('boom');
    return query(sql, params);
  };
  assert.equal((await invites.standing(broken, TOKEN, BO)).page, null);
  const route = read('src/routes/community-invites.js');
  assert.match(route, /invites\.standing\(pool, req\.params\.token, req\.user, \{\s+showSelfHosted: !!req\.user\.isAdmin \|\| !!config\.selfAppPublicVoting,\s+\}\)/,
    'the route passes the community read\'s own rule for the platform\'s project');
});

test('a private community\'s preview carries only what the link already says, and only while the link is live', async () => {
  const invites = require('../src/services/community-invites');
  const standing = await invites.standing(standingPool({ app: PRIVATE }), TOKEN, BO);
  // What the preview draws: the name, icon and colour, the one line, the
  // count, the inviter and their note.
  assert.deepEqual(
    [standing.project.name, standing.project.iconEmoji, standing.project.description, standing.memberCount, standing.inviter, standing.note],
    ['Book Club', '📚', 'Our monthly pick', 4, 'maya', 'Come vote'],
  );
  // And nothing a member's gate keeps: no address of the project, no
  // member list, no item.
  const text = JSON.stringify(standing);
  assert.equal(text.includes('book-club'), false, 'no slug');
  assert.doesNotMatch(text, /\/app\//, 'no app address');
  for (const key of ['members', 'items', 'proposals', 'issues', 'channel', 'activity', 'repo_url', 'slug":"']) {
    assert.equal(text.includes(`"${key}`), false, `no ${key}`);
  }
  // Turned off, expired, used up, or its maker out of the group: the same
  // rule redeem follows (deadReason), and no preview at all.
  const dead = {
    revoked: { revoked_at: new Date() },
    expired: { expires_at: new Date(Date.now() - 1000) },
    used_up: { uses: 25 },
    maker: { maker_holds: false },
  };
  for (const [name, link] of Object.entries(dead)) {
    const pool = standingPool({ app: PRIVATE, link });
    const answer = await invites.standing(pool, TOKEN, BO);
    assert.deepEqual([answer.live, answer.page, answer.invitePreview, answer.project], [false, null, null, undefined], name);
    assert.deepEqual(pool.asked, [], `${name}: the project is not even read`);
  }
  const src = read('src/services/community-invites.js');
  assert.match(src, /const entry = !inIt && base\.live \? await entryFor\(pool, invite, user, showSelfHosted\) : null;/,
    'asked only for a live link, by the preview\'s own deadReason');
  // The gate a non-member meets everywhere else is the one it always was.
  const appAccess = require('../src/services/app-access');
  const gate = { query: async (sql) => (/user_app_blocks|app_collaborators/.test(sql) ? { rows: [] } : { rows: [] }) };
  const row = { id: 2, collab_visibility: 'private', view_visibility: 'private', moderation_suspended_at: null };
  assert.equal(await appAccess.checkAppAccess(gate, row, BO, 'view'), false, 'a non-member, link or no link, is refused (404)');
});

// ── The follow opens the page ──────────────────────────────────────────

/** App._followInvite and the methods after it, over stand-ins. */
function follow({ standing, pressed = false, confirm = true, redeem = null, counts = null, island = true }) {
  const src = read('public/js/app.js');
  const methods = src.slice(src.indexOf('  async _followInvite(token) {'), src.indexOf('\n  _deepLinkTarget() {'));
  const events = [];
  const offers = [];
  const previews = [];
  const toasts = [];
  let address = `/invite/${TOKEN}`;
  const sandbox = {
    console, Promise, setTimeout, clearTimeout, Date, JSON, Number, encodeURIComponent,
    location: { get pathname() { return address.split('?')[0]; }, search: '' },
    history: { replaceState(_s, _t, url) { address = url; events.push(`address:${url}`); } },
    sessionStorage: { getItem: () => (pressed ? `/invite/${TOKEN}` : null), removeItem() {} },
    fetch: async (url, opts) => {
      const method = (opts && opts.method) || 'GET';
      events.push(`${method} ${url}`);
      if (url.endsWith('/redeem')) {
        const body = redeem || { ok: true, status: 'joined', slug: 'arena', name: 'Arena', newAccount: false };
        return { status: 200, ok: true, json: async () => body };
      }
      if (url === '/api/workshop/counts') {
        if (!counts) throw new Error('offline');
        return { status: 200, ok: true, json: async () => counts };
      }
      return { status: 200, ok: true, json: async () => standing };
    },
    ConfirmModal: { show: async (o) => { events.push(`confirm:${o.title}`); return confirm; } },
    PlatformUI: { toast: (msg) => toasts.push(msg) },
    AppView: {
      _landOnHub(slug) { events.push(`landOnHub:${slug}`); },
      _landOnTab(slug, tab) { events.push(`landOnTab:${slug}:${tab}`); },
    },
  };
  sandbox.window = sandbox;
  sandbox.UsernodeReact = {
    devBoard: { publishInviteOffer(offer) { offers.push(offer); events.push(`offer:${offer.slug}`); } },
    firstSession: { welcome() { return false; } },
    ...(island ? { invitePreview: { open(info) { previews.push(info); events.push(`preview:${info.name}`); return true; } } } : {}),
  };
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  const App = vm.runInNewContext(`({ ${methods} })`, sandbox);
  Object.assign(App, {
    _markNavigationVia() {},
    _rootUrl: () => '/',
    _appUrl: (slug, tab, _ref, _sub, opts) => `/app/${slug}/${tab === 'dev' && opts && opts.boardView === 'workshop' ? 'workshop' : tab}`,
    restoreFromHash() { events.push(`route:${address}`); },
    navigateToApp(slug, tab) { events.push(`navigate:${slug}:${tab}`); },
    _inviteSessionEnded() { events.push('ended'); },
    _sessionFromSnapshot: false,
    _inviteLandingToken: null,
  });
  sandbox.App = App;
  return { App, events, offers, previews, toasts };
}

const LIVE = {
  live: true, reason: null, mine: null, slug: null, page: 'arena',
  project: { name: 'Arena' }, inviter: 'maya', inviterName: 'Maya', inviterMadeIt: false, note: 'Come vote', memberCount: 4,
};

test('signed in and not in it: the community\'s own page, with no question, in place of the link\'s address', async () => {
  const run = follow({ standing: LIVE });
  await run.App._followInvite(TOKEN);
  assert.deepEqual(run.events, [
    'address:/', 'route:/', `GET /api/invite-links/by-token/${TOKEN}`,
    'offer:arena', 'landOnHub:arena', 'address:/app/arena/workshop', 'route:/app/arena/workshop',
  ], 'no confirm and no redeem: the page is where they decide');
  const [offer] = run.offers;
  assert.deepEqual(
    [offer.token, offer.slug, offer.name, offer.inviter, offer.inviterName, offer.note, offer.preview],
    [TOKEN, 'arena', 'Arena', 'maya', 'Maya', 'Come vote', undefined],
  );
  assert.deepEqual(run.toasts, []);
  // The first-run join step waits on the follow; the page's Join settles it.
  let settled = null;
  run.App._inviteFollow.then((v) => { settled = v; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(settled, null, 'still open while the page is up and Join is not pressed');
  offer.settle(true);
  assert.equal(await run.App._inviteFollow, true);
  assert.equal(typeof offer.welcome, 'function', '"You\'re in" stays for an account the join makes new');
});

const PRIVATE_LIVE = {
  ...LIVE,
  page: null,
  invitePreview: { iconColor: '#2e6660', audienceLabel: 'Private community' },
  project: { name: 'Book Club', iconEmoji: '📚', iconUrl: null, description: 'Our monthly pick', picture: null },
};

test('signed in and not in a private community: its invite preview, from the standing alone, with no question', async () => {
  const run = follow({
    standing: PRIVATE_LIVE,
    counts: { counts: { 'book-club': { working: 0, needs: 1, owed: [] } } },
  });
  await run.App._followInvite(TOKEN);
  assert.deepEqual(run.events, [
    'address:/', 'route:/', `GET /api/invite-links/by-token/${TOKEN}`, 'preview:Book Club',
  ], 'no confirm, no redeem, and no route into the project: the address stays Home\'s, never the link\'s');
  assert.deepEqual(run.offers, []);
  const [info] = run.previews;
  assert.deepEqual(
    Object.keys(info).sort(),
    ['audienceLabel', 'building', 'description', 'iconColor', 'iconEmoji', 'iconUrl', 'inviter', 'inviterMadeIt',
      'inviterName', 'land', 'memberCount', 'name', 'note', 'settle', 'token', 'unnamed', 'welcome'],
    'what the preview is handed: no slug, no members, no items',
  );
  assert.deepEqual(
    [info.token, info.name, info.iconColor, info.description, info.memberCount, info.inviter, info.note],
    [TOKEN, 'Book Club', '#2e6660', 'Our monthly pick', 4, 'maya', 'Come vote'],
  );
  // Join settles the follow and lands where a Join lands; "You're in." was
  // said by the Join itself, so not again.
  info.settle(true);
  assert.equal(await run.App._inviteFollow, true);
  info.land('book-club');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(run.events.slice(-3), ['GET /api/workshop/counts', 'landOnTab:book-club:needs', 'navigate:book-club:dev']);
  assert.deepEqual(run.toasts, []);
});

test('a private community with no preview to show (suspended, blocked, no island) is the confirm, and its Join lands where a Join does', async () => {
  const noIsland = follow({ standing: PRIVATE_LIVE, island: false, confirm: false });
  await noIsland.App._followInvite(TOKEN);
  assert.ok(noIsland.events.includes('confirm:Join Book Club?'), 'without the island the follow asks, as before');
  const run = follow({
    standing: { ...LIVE, page: null, project: { name: 'Book Club' } },
    redeem: { ok: true, status: 'joined', slug: 'book-club', name: 'Book Club', newAccount: false },
    counts: { counts: { 'book-club': { working: 0, needs: 2, owed: [] } } },
  });
  await run.App._followInvite(TOKEN);
  assert.deepEqual([run.offers, run.previews], [[], []]);
  assert.ok(run.events.includes('confirm:Join Book Club?'), run.events.join(' '));
  const tail = run.events.slice(run.events.indexOf(`POST /api/invite-links/by-token/${TOKEN}/redeem`));
  assert.deepEqual(tail, [
    `POST /api/invite-links/by-token/${TOKEN}/redeem`, 'GET /api/workshop/counts',
    'landOnTab:book-club:needs', 'navigate:book-club:dev',
  ], 'votes waiting: Needs you, at its first card');
  assert.deepEqual(run.toasts, ["You're in."]);
  assert.equal(await run.App._inviteFollow, true);
});

test('Join pressed on the signed-out page, then a password sign-in, is not shown the page again', async () => {
  const run = follow({ standing: LIVE, pressed: true });
  await run.App._followInvite(TOKEN);
  assert.deepEqual(run.offers, [], 'that press was the Join');
  assert.ok(run.events.includes(`POST /api/invite-links/by-token/${TOKEN}/redeem`));
  assert.ok(run.events.includes('landOnTab:arena:status'), 'a counts read that fails is the hub');
  assert.ok(run.events.includes('navigate:arena:dev'));
});

test('members and dead links are as they were', async () => {
  const member = follow({ standing: { ...LIVE, mine: 'joined', slug: 'arena', page: null, joinedAt: '2026-01-01T00:00:00.000Z' } });
  await member.App._followInvite(TOKEN);
  assert.ok(member.events.includes('landOnHub:arena') && member.events.includes('navigate:arena:dev'));
  assert.deepEqual(member.toasts, [], 'a member reopening an old link hears nothing');
  assert.equal(member.events.includes('GET /api/workshop/counts'), false);
  const dead = follow({ standing: { live: false, reason: 'expired' } });
  await dead.App._followInvite(TOKEN);
  assert.deepEqual(dead.toasts, ['That invite link has expired.']);
  assert.deepEqual(dead.offers, []);
});

test('just let in by a sign-up from the invite card, and "You\'re in" will not show: where a Join lands', async () => {
  const run = follow({
    standing: { ...LIVE, mine: 'joined', slug: 'arena', page: null, joinedAt: new Date().toISOString() },
    counts: { counts: {} },
  });
  await run.App._followInvite(TOKEN);
  assert.deepEqual(run.events.slice(-3), ['GET /api/workshop/counts', 'landOnTab:arena:status', 'navigate:arena:dev'],
    'no votes waiting: the hub');
  assert.deepEqual(run.toasts, ["You're in."]);
});

// ── The page's Join ────────────────────────────────────────────────────

test('who invited them, in the confirm\'s words, over the Join', () => {
  const { invitedByLine, seenByLine } = loadTsx(OFFER);
  assert.equal(seenByLine, undefined, 'no line saying the inviter will see the join (#4395)');
  assert.equal(invitedByLine({ inviter: 'maya', inviterName: 'Maya', inviterMadeIt: false, building: false }), '@maya invited you');
  assert.equal(invitedByLine({ inviter: 'maya', inviterName: 'Maya', inviterMadeIt: true, building: false }), 'Maya made it and invited you');
  assert.equal(invitedByLine({ inviter: 'maya', inviterName: 'Maya', inviterMadeIt: true, building: true }), 'Maya is making it and invited you');
  assert.equal(invitedByLine({ inviter: null, inviterName: null, inviterMadeIt: false, building: false }), 'You were invited');
});

/** joinByInvite against a fake window, answering the redeem with `answer`. */
async function joinWith(answer, offerPatch = {}) {
  const mod = loadTsx(OFFER);
  const calls = { toasts: [], ended: [], settled: [], welcomed: [], posts: [] };
  const prior = { window: global.window, fetch: global.fetch };
  global.window = {
    PlatformUI: { toast: (msg, opts) => calls.toasts.push(opts && opts.error ? `error:${msg}` : msg) },
    App: { _inviteSessionEnded: (address) => calls.ended.push(address) },
    HomePanels: { ensureLoaded: () => {} },
    Home: { load: async () => {} },
  };
  global.fetch = async (url, init) => {
    calls.posts.push(`${init && init.method} ${url}`);
    return answer;
  };
  const offer = {
    token: TOKEN, slug: 'arena', name: 'Arena', inviter: 'maya', inviterName: 'Maya', inviterMadeIt: false, building: false, note: null,
    settle: (v) => calls.settled.push(v),
    welcome: (newAccount, slug) => { calls.welcomed.push([newAccount, slug]); return true; },
    ...offerPatch,
  };
  try {
    mod.publishInviteOffer(offer);
    const { outcome, slug } = await mod.joinByInvite(offer);
    return { outcome, slug, calls, left: mod.inviteOfferFor('arena') };
  } finally {
    global.window = prior.window;
    global.fetch = prior.fetch;
  }
}

const answer = (status, body) => ({ status, ok: status < 400, json: async () => body });

test('Join on the page follows the link: "You\'re in.", the link spent, the follow settled', async () => {
  const ok = await joinWith(answer(200, { ok: true, status: 'joined', slug: 'arena', name: 'Arena', newAccount: false }));
  assert.deepEqual([ok.outcome, ok.slug], ['joined', 'arena']);
  assert.deepEqual(ok.calls.posts, [`POST /api/invite-links/by-token/${TOKEN}/redeem`]);
  assert.deepEqual(ok.calls.toasts, ["You're in."]);
  assert.deepEqual(ok.calls.settled, [true]);
  assert.equal(ok.left, null, 'the page offers the link no more');
  const fresh = await joinWith(answer(200, { ok: true, status: 'joined', slug: 'arena', newAccount: true }));
  assert.equal(fresh.outcome, 'welcomed', 'an account the join made new is shown "You\'re in" instead');
  assert.deepEqual([fresh.calls.welcomed, fresh.calls.toasts], [[[true, 'arena']], []], 'for the project the join answered with');
  const dead = await joinWith(answer(410, { error: 'This invite link is not active.', reason: 'expired' }));
  assert.deepEqual([dead.outcome, dead.calls.toasts, dead.calls.settled, dead.left], ['dead', ['error:That invite link has expired.'], [], null],
    'a link that died meanwhile says why, and the hero\'s own Join is back');
  const ended = await joinWith(answer(401, { error: 'Not authenticated' }));
  assert.deepEqual([ended.outcome, ended.calls.ended, ended.calls.toasts], ['failed', [`/invite/${TOKEN}`], []],
    'an ended session reloads onto the link\'s own page');
  const busy = await joinWith(answer(500, { error: 'Internal server error' }));
  assert.equal(busy.left && busy.left.slug, 'arena', 'a read that did not land keeps the link on offer');
  const preview = await joinWith(answer(200, {}), { token: null, preview: true });
  assert.deepEqual([preview.outcome, preview.calls.posts], ['failed', []], 'the capture follows nothing');
});

// ── The hero ───────────────────────────────────────────────────────────

const COMMUNITY = {
  slug: 'arena', name: 'Arena', description: 'Who plays when', member_count: 4, is_member: false, is_creator: false,
  audience: 'open', audience_label: 'Public community',
  members: [{ id: 1, username: 'maya' }, { id: 3, username: 'cy' }], channel: null,
  activity: { active_week: 3, shipped_month: 1, daily: [] },
  approval: { policy: 'anyone', approvals_required: null, electorate: 3, required: 2 },
};

async function hero({ offer, community = COMMUNITY }) {
  const real = loadTsx(OFFER);
  const card = loadTsx(CARD, { stubs: { './invite-offer': { ...real, useInviteOffer: () => offer } } });
  const prior = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => community });
  try {
    await card.reloadCommunity('arena');
  } finally {
    global.fetch = prior;
  }
  return renderToHtml(createElement(card.CommunityCard, { slug: 'arena', name: 'Arena', canOpenApp: true }));
}

const PAGE_OFFER = {
  token: TOKEN, slug: 'arena', name: 'Arena', inviter: 'maya', inviterName: 'Maya', inviterMadeIt: false, building: false, note: 'Come vote',
};

test('the hero of a page opened from a link leads with who invited them and one Join', async () => {
  const html = await hero({ offer: PAGE_OFFER });
  assert.match(html, /<section class="dev-ws-hero dev-ws-hero-summary" data-ws-community="" data-audience="open"><div class="dev-ws-invite" data-ws-invite="">/,
    'first in the hero, above what it is and who is here');
  assert.ok(html.indexOf('data-ws-invite=""') < html.indexOf('data-ws-community-name=""'), 'then the name it is about');
  assert.match(html, /<p class="dev-ws-invite-from" data-ws-invite-from="">@maya invited you<\/p>/);
  assert.match(html, /<p class="dev-ws-invite-note" data-ws-invite-note="">“Come vote”<\/p>/);
  assert.match(html, /<div class="dev-ws-join-anchor"><button type="button" data-ws-invite-join="" class="w-full rounded-full bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-5 py-3 text-\[17px\] font-semibold text-white transition-colors">Join Arena<\/button><\/div>/,
    'the screen\'s primary button, the full width of the card');
  assert.doesNotMatch(html, /will see that you joined|data-ws-invite-seen/, 'the Join stands alone (#4395)');
  assert.doesNotMatch(html, /data-ws-community-join=""/, 'one Join on the hero');
  assert.match(html, /data-ws-community-open-app=""/, 'Open app, to try it first');
  assert.match(html, /data-ws-community-description="">Who plays when</, 'and what it is');
  assert.doesNotMatch(html, /data-ws-community-invite=""|data-ws-community-leave=""/);
});

test('a member, or a page opened any other way, has no invite head', async () => {
  const plain = await hero({ offer: null });
  assert.doesNotMatch(plain, /data-ws-invite=""/);
  assert.match(plain, /data-ws-community-join=""[^>]*>Join<\/button>/, 'the ordinary Join');
  const member = await hero({ offer: PAGE_OFFER, community: { ...COMMUNITY, is_member: true } });
  assert.doesNotMatch(member, /data-ws-invite=""/, 'joined already (in another tab, say): the hero as for any member');
  assert.match(member, /data-ws-community-invite=""/, 'a member\'s Invite');
  assert.doesNotMatch(member, /data-ws-community-join=""/, 'and no Join (Leave is a row of the ⋯, #4045)');
  // `?shot=invite-join`: drawn as an invitee sees it, whoever is looking.
  const shot = await hero({ offer: { ...PAGE_OFFER, token: null, preview: true }, community: { ...COMMUNITY, is_member: true } });
  assert.match(shot, /data-ws-invite=""/);
  assert.doesNotMatch(shot, /data-ws-community-leave=""|data-ws-community-invite=""/);
});

test('the page lands its Join, and the platform reaches it by URL', () => {
  const lander = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(lander, /onJoinedByInvite=\{\(\) => \{ if \(owesVote\(v\.queue\)\) openTab\('needs'\); \}\}/,
    'Needs you at its first card when votes are waiting; otherwise the hub it is on');
  const card = read(CARD);
  assert.match(card, /if \(outcome === 'joined' && land\) onJoinedByInvite\?\.\(\);/);
  assert.match(card, /onClick=\{\(\) => \{ if \(invited\) answerThroughLink\(asking\.answer\); else asking\.answer\(true\); \}\}/,
    'a question a refusal asks under it is answered by the link too');
  const mount = read('frontend/src/features/dev-board/mount.ts');
  assert.match(mount, /publishInviteOffer,\n\s+unmount: unmountLegacyPortal,/, 'app.js publishes through the dev board\'s bridge');
  const app = read('public/js/app.js');
  assert.match(app, /App\._applyAppContextShot\(\);\s+App\._applyInviteJoinShot\(\);\s+\},/);
  // Folded into the hero's own check (its route plus the capture), not a
  // new one: the manifest stands at its floor (tests/lib/check-cap.js).
  const checks = JSON.parse(read('dapp.json')).tests.filter((t) => /shot=invite-join/.test(t.path));
  assert.equal(checks.length, 1, 'a declared check reaches the invite head');
  assert.match(checks[0].expectSelector, /:has\(> \.dev-ws-invite:first-child \[data-ws-invite-join\]\) > \.dev-ws-hero-id \[data-ws-community-name\] \+ \[data-ws-members-cell\] > \[data-ws-community-audience\]$/);
  assert.match(read('public/css/app.css'), /\.dev-ws-invite \{\s+display: flex; flex-direction: column; gap: 10px;/);
});

// ── A private community's invite preview ───────────────────────────────

const PREVIEW = 'frontend/src/features/invite-preview/index.tsx';

test('a private community\'s invite preview shows the community and Join, and nothing that is its members\'', () => {
  const { InvitePreviewPage, InvitePreview, CLOSED_LINE } = loadTsx(PREVIEW);
  const info = {
    token: TOKEN, name: 'Book Club', iconEmoji: '📚', iconUrl: null, iconColor: '#2e6660',
    description: 'Our monthly pick', memberCount: 4, audienceLabel: 'Private community',
    inviter: 'maya', inviterName: 'Maya', inviterMadeIt: false, building: false, note: 'Come read',
  };
  const html = renderToHtml(createElement(InvitePreviewPage, { info, busy: false, onJoin() {}, onClose() {} }));
  assert.match(html, /<div role="dialog" aria-modal="true" aria-labelledby="invite-preview-name" data-invite-preview=""/);
  assert.match(html, /data-invite-preview-header=""[^>]*>[\s\S]*aria-label="Not now" data-invite-preview-close=""[\s\S]*>📚<\/span><h1 id="invite-preview-name"[^>]*>Book Club<\/h1>/,
    'the header in the community\'s colour: Not now, its icon and its name');
  assert.match(html, /<section class="dev-ws-hero" data-ws-invite-preview=""><div class="dev-ws-invite" data-ws-invite="">/,
    'who invited them and Join first, on screen without scrolling');
  assert.match(html, />@maya invited you</);
  assert.match(html, />“Come read”</);
  assert.match(html, /data-ws-invite-join=""[^>]*>Join Book Club<\/button>/);
  assert.doesNotMatch(html, /will see that you joined/, 'the Join stands alone (#4395)');
  assert.match(html, /<b>Private community<\/b><\/span> · 4 members/, 'the member count');
  assert.match(html, /data-invite-preview-description="">Our monthly pick</);
  assert.equal(message(CLOSED_LINE), 'Its members, its app and what it is deciding open once you join.');
  assert.ok(html.includes(message(CLOSED_LINE)), 'and why there is no more to see');
  assert.doesNotMatch(html, /dev-ws-hero-face|dev-ws-hero-faces/, 'no faces');
  assert.doesNotMatch(html, /data-ws-community-open-app|Open app/, 'no Open app');
  assert.doesNotMatch(html, /data-ws-members-trend|data-ws-members-stats/, 'no trend');
  // The island draws nothing until App._followInvite opens it.
  assert.equal(renderToHtml(createElement(InvitePreview)), '');
  assert.match(read('frontend/src/Shell.tsx'), /<Island name="InvitePreview"><InvitePreview \/><\/Island>/);
  const src = read(PREVIEW);
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), /fetch\(/,
    'it reads nothing of the project: only joinByInvite, which follows the link');
  assert.match(src, /if \(result\.outcome === 'joined' && result\.slug\) info\.land\?\.\(result\.slug\);/);
  // Reachable by URL for captures, with a made-up community and no link.
  const app = read('public/js/app.js');
  assert.match(app, /if \(shot === 'invite-preview'\) \{/);
});

// ── Signed out ─────────────────────────────────────────────────────────

test('the signed-out invite card says what the project is, beside its icon and count', () => {
  const card = loadTsx('frontend/src/features/auth/invite-card.tsx');
  const preview = {
    live: true, reason: null, inviter: 'maya', inviterName: 'Maya', inviterMadeIt: false, memberCount: 4,
    project: { name: 'Arena', iconEmoji: '🏟', iconUrl: null, description: 'Who plays when', picture: { kind: 'illustration', url: '/app-illustrations/a', darkUrl: null } },
  };
  const html = renderToHtml(createElement(card.MadeForYou, { preview, primaryClass: 'x', onJoin() {} }));
  assert.match(html, /data-landing-invite-description="[^"]*"[^>]*>Who plays when<\/p>/);
  assert.match(html, /4 people are in it/);
  const tile = renderToHtml(createElement(card.MadeForYou, { preview: { ...preview, project: { ...preview.project, picture: null } }, primaryClass: 'x', onJoin() {} }));
  // #4203: one hero, the tile, the name and the invitation under them; with
  // no picture the hero is the tile, and the icon shows once either way.
  assert.match(tile, /data-landing-invite-picture="tile"[\s\S]*>Arena<\/p>[\s\S]*data-landing-invite-line=""[^>]*>Maya invited you to Arena · 4 people are in it<\/p>[\s\S]*Who plays when/);
  assert.equal((tile.match(/app-icon-tile/g) || []).length, 1, 'the icon shows once');
  assert.equal((html.match(/app-icon-tile/g) || []).length, 1, 'the icon shows once beside a picture too');
  assert.match(html, /data-landing-invite="live"[\s\S]*Maya invited you to Arena[\s\S]*data-landing-invite-picture="illustration"/);
  assert.doesNotMatch(html, /data-landing-invite-signup|Join Arena/, 'Join is the pinned bar, not in the scroller');
  // The foot line closes the scroller, after the picture and the note (#4049).
  assert.match(html, /data-landing-invite-picture="illustration"[\s\S]*data-landing-invite-homeroom=""[^>]*>On Homeroom, people using an app build and improve it together\.<\/p>$/);
  assert.doesNotMatch(html, /will see that you joined/);
  const bar = renderToHtml(createElement(card.InviteJoinBar, { preview, primaryClass: 'x', onJoin() {} }));
  assert.match(bar, /data-landing-invite-join=""[\s\S]*data-landing-invite-signup=""[^>]*>Join Arena<\/a>/);
  assert.doesNotMatch(bar, /will see that you joined|data-landing-invite-seen/, 'the bar is Join alone');
  assert.match(bar, /padding-bottom:calc\(0\.75rem \+ var\(--platform-safe-bottom, env\(safe-area-inset-bottom, 0px\)\)\)/);
  assert.equal(card.pictureIsTile({ picture: { kind: 'sketch', card: null } }), true);
});

test('#4203: the invite page pins Join below its scroller, clear of the home indicator', () => {
  const landing = read('frontend/src/features/auth/landing.tsx');
  const scroller = landing.indexOf('<div id="auth-landing-scroll"');
  const cards = landing.indexOf('{madeForYou ? <MadeForYou preview={invite!} /> : null}');
  const bar = landing.indexOf("<InviteJoinBar preview={invite!} primaryClass={PRIMARY_PILL} onJoin={() => setSheet('join')} />");
  const viewer = landing.indexOf('<ViewerRegion />');
  assert.ok(scroller > 0 && cards > scroller, 'the hero scrolls');
  assert.ok(bar > cards && bar < viewer, 'the bar is the column\'s child after the scroller');
  assert.match(landing, /\{madeForYou && !openApp \? \(\s+<InviteJoinBar /, 'not over an open app');
  // The scroller ends above the bar, so its own 34px home-indicator clearance
  // is the bar's job on an invite.
  assert.ok(landing.includes("flex min-h-full flex-col ${madeForYou ? 'pb-4' : 'pb-[34px]'}"));
});
