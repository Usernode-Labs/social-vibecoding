'use strict';

// Invite links, without a database (tests/community-invites-postgres.test.js
// runs the SQL): the rules that are pure, the page's link preview, and the
// seams that carry a link through sign-in and into the shell.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const invites = require('../src/services/community-invites');
const routes = require('../src/routes/community-invites');

test('a token is 22 base64url characters, and nothing else reaches the database', () => {
  assert.equal(invites.isToken('YigKXxtTzBB_TFZVTkjEtg'), true);
  for (const bad of ['', 'short', 'YigKXxtTzBB_TFZVTkjEt', 'YigKXxtTzBB_TFZVTkjEtg1', "YigKXxtTzBB'TFZVTkjEtg", null, 42]) {
    assert.equal(invites.isToken(bad), false, String(bad));
  }
  assert.equal(invites.invitePath('abc'), '/invite/abc');
});

test('defaults are 7 days and 25 people, within 1–30 days and 1–100 people', () => {
  assert.equal(invites.DEFAULT_DAYS, 7);
  assert.equal(invites.DEFAULT_USES, 25);
  assert.deepEqual({ ...invites.LIMITS }, { minDays: 1, maxDays: 30, minUses: 1, maxUses: 100 });
  const schema = read('src/db/schema.sql');
  assert.match(schema, /max_uses\s+INTEGER NOT NULL DEFAULT 25 CHECK \(max_uses BETWEEN 1 AND 100\)/);
});

test('why a link is dead: turned off, then expired, then used up', () => {
  const now = new Date('2026-09-27T12:00:00Z');
  const live = { revoked_at: null, expires_at: '2026-10-01T00:00:00Z', uses: 0, max_uses: 25 };
  assert.equal(invites.deadReason(live, now), null);
  assert.equal(invites.deadReason(null, now), 'unknown');
  assert.equal(invites.deadReason({ ...live, revoked_at: now, uses: 25 }, now), 'revoked');
  assert.equal(invites.deadReason({ ...live, expires_at: '2026-09-27T12:00:00Z' }, now), 'expired');
  assert.equal(invites.deadReason({ ...live, uses: 25 }, now), 'used_up');
  // A link dies with its maker's standing: removed from the group, gone.
  assert.equal(invites.deadReason({ ...live, maker_holds: false }, now), 'revoked');
  assert.equal(invites.deadReason({ ...live, maker_holds: true }, now), null);
  // WP-D: no end date and no cap: it works until it is turned off.
  const forever = { ...live, expires_at: null, max_uses: null, uses: 5000 };
  assert.equal(invites.deadReason(forever, now), null);
  assert.equal(invites.deadReason({ ...forever, revoked_at: now }, now), 'revoked');
  assert.equal(invites.deadReason({ ...forever, max_uses: 25, uses: 25 }, now), 'used_up');
  assert.equal(invites.deadReason({ ...forever, expires_at: '2026-09-27T12:00:00Z' }, now), 'expired');
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE community_invites ALTER COLUMN expires_at DROP NOT NULL;\nALTER TABLE community_invites ALTER COLUMN max_uses DROP NOT NULL;/);
  assert.match(schema, /CREATE OR REPLACE FUNCTION community_invite_maker_holds\(p_invite INTEGER\) RETURNS BOOLEAN/);
  assert.match(schema, /IF NOT community_invite_maker_holds\(\(SELECT invite_id FROM community_invite_redemptions WHERE id = r\.id\)\) THEN\s+RETURN FALSE;/,
    'checked again at release, for a queued person');
  assert.match(read('src/services/community-invites.js'), /community_invite_maker_holds\(i\.id\) AS maker_holds/);
});

test('what a link grants is what its maker could: a collaborator where building is by invitation', () => {
  assert.equal(invites.grantFor({ collab_visibility: 'private', self_hosted: false }), 'collaborator');
  assert.equal(invites.grantFor({ collab_visibility: 'public', self_hosted: false }), 'member');
  assert.equal(invites.grantFor({ collab_visibility: 'private', self_hosted: true }), 'member', 'Homeroom has no collaborators');
  // The one implementation, in SQL, says the same.
  assert.match(read('src/db/schema.sql'), /IF r\.collab_visibility = 'private' AND NOT r\.self_hosted THEN\s+INSERT INTO app_collaborators/);
});

test('THE TREE gives 10 lifetime skips to generation 0 and none after it; admins unlimited', () => {
  const saved = { budgets: process.env.INVITE_TREE_BUDGETS };
  try {
    delete process.env.INVITE_TREE_BUDGETS;
    assert.deepEqual(invites.treeBudgets(), [10]);
    assert.deepEqual([0, 1, 2, 3, 9].map((g) => invites.budgetFor(g)), [10, 0, 0, 0, 0],
      'invites do not chain: whoever a link let in has none to give');
    assert.equal(invites.budgetFor(null), 0, 'no generation (existing accounts, not let in by hand): no skips');
    assert.equal(invites.budgetFor(5, { isAdmin: true }), Infinity);
    process.env.INVITE_TREE_BUDGETS = '4, 3';
    assert.deepEqual(invites.treeBudgets(), [4, 3]);
    process.env.INVITE_TREE_BUDGETS = 'nonsense';
    assert.deepEqual(invites.treeBudgets(), [10], 'a bad value falls back, never to a chain');
    process.env.INVITE_TREE_BUDGETS = '';
    assert.deepEqual(invites.treeBudgets(), [10], 'and so does an empty one');
  } finally {
    if (saved.budgets === undefined) delete process.env.INVITE_TREE_BUDGETS; else process.env.INVITE_TREE_BUDGETS = saved.budgets;
  }
  const src = read('src/services/community-invites.js');
  // The inviter's row is locked while their skips are counted, and the count
  // IS the record: no counter to drift.
  assert.match(src, /FROM users WHERE id = \$1\s+FOR UPDATE/);
  assert.match(src, /SELECT COUNT\(\*\)::int AS n FROM users WHERE admitted_by = \$1/);
  // No generation reads as no place in the tree, not as generation 0: an
  // account that had access before the tree gets no skips.
  assert.doesNotMatch(src, /COALESCE\(invite_generation/);
  // An admin's link is not a release by hand: its people start at 1.
  assert.match(src, /const generation = inviter\.is_admin \? 1 : inviter\.generation \+ 1;/);
  // grantPlatformAccess makes generation 0 only for a release by hand, and
  // only on the grant that lets somebody in.
  const waitlistSrc = read('src/services/waitlist.js');
  assert.match(waitlistSrc, /invite_generation = CASE WHEN \$2::boolean THEN 0 ELSE invite_generation END\s+WHERE id = \$1 AND has_platform_access = FALSE`,\s+\[userId, manualRelease === true\]/);
  // The three releases by hand ask for it; the invite-equivalent signups do not.
  assert.equal((waitlistSrc.match(/grantPlatformAccess\(pool, userId, \{ manualRelease: true \}\)/g) || []).length, 2,
    'an Admit, and an admitted address signing up later');
  assert.match(read('src/routes/topochain/admin/waitlist.js'), /waitlist\.grantPlatformAccess\(pool, id, \{ manualRelease: true \}\)/);
  const auth = read('src/routes/auth.js');
  const grants = auth.match(/grantPlatformAccess\([^)]*\)/g) || [];
  assert.deepEqual(grants, ['grantPlatformAccess(pool, userId)', 'grantPlatformAccess(pool, userId)'],
    'activation codes and genesis wallets grant access without skips');
});

// A pool that answers the switch's read from `rows` (or throws), and records
// every statement it was sent.
function settingPool(rows) {
  const sent = [];
  return {
    sent,
    async query(sql, params) {
      sent.push({ sql, params });
      if (rows instanceof Error) throw rows;
      if (/FROM platform_settings/.test(sql)) return { rows };
      return { rows: [] };
    },
  };
}

test('the switch is an admin setting: on with no row, off only when it says so, cached for 10 seconds', async () => {
  assert.equal(await invites.treeEnabled(settingPool([])), true, 'no row: on by default');
  assert.equal(await invites.treeEnabled(settingPool([{ value: 'false' }])), false);
  assert.equal(await invites.treeEnabled(settingPool([{ value: 'true' }])), true);
  assert.equal(await invites.treeEnabled(settingPool([{ value: 'yes' }])), false, 'only true is on');

  // Unreadable reads as off, and is not cached: the next read tries again.
  const broken = settingPool(new Error('relation "platform_settings" does not exist'));
  assert.equal(await invites.treeEnabled(broken), false);
  await invites.treeEnabled(broken);
  assert.equal(broken.sent.length, 2);

  // Cached per pool, until the setting is written through this module.
  const pool = settingPool([]);
  await invites.treeEnabled(pool);
  await invites.treeEnabled(pool);
  assert.equal(pool.sent.length, 1, 'the second read is the cache');
  await invites.setTreeEnabled(pool, { enabled: false, actorId: 7 });
  const write = pool.sent[1];
  assert.match(write.sql, /INSERT INTO platform_settings \(key, value, description, updated_at, updated_by\)/);
  assert.deepEqual([write.params[0], write.params[1], write.params[3]], [invites.SETTING_KEY, 'false', 7]);
  await invites.treeEnabled(pool);
  assert.equal(pool.sent.length, 3, 'a write drops the cache');

  // With it off, the invite sheet says nothing about skips.
  assert.equal(await invites.skipsLeft(settingPool([{ value: 'false' }]), { id: 1 }), null);
});

test('the switch is served to the Waitlist screen, and only a boolean is written', () => {
  const route = read('src/routes/topochain/admin/waitlist.js');
  assert.match(route, /router\.get\('\/api\/v4\/admin\/invite-tree', async/);
  assert.match(route, /router\.put\('\/api\/v4\/admin\/invite-tree', adminWriteGate, async/,
    'a view-only admin can read it, not switch it');
  assert.match(route, /if \(typeof enabled !== 'boolean'\) return fail\(res, 422,/);
  assert.match(read('frontend/src/features/admin/topochain/waitlist.tsx'), /<InviteTreePanel \/>/);
});

test('the Waitlist screen says what the switch does, and shows a view-only admin its state', () => {
  const { InviteTreeBody } = loadTsx('frontend/src/features/admin/topochain/waitlist.tsx');
  const tree = { enabled: true, root_skips: 10, roots: 1, through_links: 3, updated_at: null, updated_by: null };
  const writable = renderToHtml(createElement(InviteTreeBody, { tree, write: true, onToggle: () => {} }));
  assert.match(writable, /id="admin-topo-wl-invites-enabled" type="checkbox"[^>]* checked=""/);
  assert.match(writable, /Invite links skip the waitlist/);
  assert.match(writable, /Everyone you admit gets 10 invites: anyone new who follows one of their invite links gets in straight away\./);
  assert.match(writable, /The people they invite get none, and neither do accounts that already had access\./);
  assert.match(writable, /1 person admitted can invite; 3 people got in through an invite so far\./);

  const readOnly = renderToHtml(createElement(InviteTreeBody, {
    tree: { ...tree, enabled: false, updated_at: '2026-09-29T12:00:00.000+00:00', updated_by: 'ada' },
    write: false,
    onToggle: () => {},
  }));
  assert.doesNotMatch(readOnly, /type="checkbox"/, 'nothing to click that would be refused');
  assert.match(readOnly, /Invite links do not skip the waitlist\./);
  assert.match(readOnly, /by ada\./);
});

test('the skips per generation come from the chart, and are in the Platform variables panel', () => {
  // The Kubernetes Deployment lists its env explicitly, so a variable the
  // chart does not name never reaches the process. The on/off switch is an
  // admin setting, so it is deliberately NOT a chart value.
  const platform = read('deploy/helm/social-vibecoding-platform/templates/platform.yaml');
  assert.match(platform, /\{name: INVITE_TREE_BUDGETS, value: \{\{ \.Values\.config\.inviteTreeBudgets \| default "10" \| quote \}\}\}/);
  assert.doesNotMatch(platform, /INVITE_TREE_ENABLED/);
  const values = read('deploy/helm/social-vibecoding-platform/values.yaml');
  assert.match(values, /^ {2}inviteTreeBudgets: "10"$/m, 'the chart default is the code default: no chaining');
  // Declared, so an admin can find it; not required, so this merges unset.
  const appManifest = require('../src/services/app-manifest');
  const declared = new Map(appManifest.readPlatformEnv(JSON.parse(read('dapp.json'))).map((e) => [e.key, e]));
  assert.equal(declared.get('INVITE_TREE_BUDGETS')?.default, '10');
  assert.equal(declared.get('INVITE_TREE_BUDGETS')?.required, false);
  assert.equal(declared.has('INVITE_TREE_ENABLED'), false);
});

test('the tables are staging:private, and a queued invite is applied by a trigger on being let in', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema, /COMMENT ON TABLE community_invites IS 'staging:private';/);
  assert.match(schema, /COMMENT ON TABLE community_invite_redemptions IS 'staging:private';/);
  assert.match(schema, /CREATE TRIGGER users_apply_queued_community_invites\s+AFTER UPDATE OF has_platform_access ON users\s+FOR EACH ROW WHEN \(NEW\.has_platform_access\)/);
  assert.match(schema, /IF TG_OP = 'UPDATE' AND OLD\.has_platform_access THEN\s+RETURN NULL;/, 'the false → true edge only');
});

test('the page\'s link preview: a live link names the project and inviter, a dead one nothing, all escaped', () => {
  const live = routes.previewTags({
    live: true,
    project: { name: 'Tiers & <Lists>', iconUrl: '/app-icons/abc' },
    inviter: 'ada',
    memberCount: 3,
  }, 'https://app.example');
  assert.match(live, /<meta property="og:title" content="Join Tiers &amp; &lt;Lists&gt; on Homeroom">/);
  assert.match(live, /<meta property="og:description" content="@ada invited you to Tiers &amp; &lt;Lists&gt;\. 3 people are in it\.">/);
  assert.match(live, /<meta property="og:image" content="https:\/\/app\.example\/app-icons\/abc">/);
  const dead = routes.previewTags({ live: false, reason: 'revoked' }, 'https://app.example');
  assert.match(dead, /content="Homeroom invite"/);
  assert.doesNotMatch(dead, /og:image/);
  assert.equal(routes.withPreviewTags('<html><head><title>x</title></head></html>', '<meta a>'),
    '<html><head><title>x</title><meta a>\n</head></html>');
});

test('the paths: the page is a shell document; following from the waiting room is open, making links is not', () => {
  const auth = read('src/middleware/auth.js');
  assert.match(auth, /\|\| \/\^\\\/invite\\\/\[A-Za-z0-9_-\]\{22\}\$\/\.test\(pathname\)/);
  assert.match(auth, /'\/api\/invite-links\/by-token\/',\s+'\/api\/invite-links\/queued',(\s+\/\/[^\n]*)+\s+'\/api\/me\/first-session\/started',\s+\];/);
  assert.doesNotMatch(auth, /'\/api\/invite-links\/',/, 'not the whole prefix');
  assert.match(auth, /'\/api\/public\/',/, 'the preview rides the existing anonymous tier');
  const server = read('server.js');
  assert.ok(server.indexOf('app.use(communityInviteRoutes(config));') < server.indexOf("app.get('*', (req, res) => {"),
    'mounted before the catch-all');
  const src = read('src/routes/community-invites.js');
  for (const route of [
    "router.post('/api/apps/:slug/invite-links', drainGuard, inviteLinkCreateLimiter,",
    "router.get('/api/apps/:slug/invite-links',",
    "router.delete('/api/invite-links/:id', drainGuard,",
    "router.get('/api/public/invites/:token', invitePreviewLimiter,",
    "router.get('/api/invite-links/by-token/:token', invitePreviewLimiter,",
    "router.post('/api/invite-links/by-token/:token/redeem', drainGuard, inviteRedeemLimiter,",
    "router.get('/api/invite-links/queued',",
    "router.get('/invite/:token', invitePreviewLimiter,",
  ]) assert.ok(src.includes(route), route);
  // Only a live link leaves its token for sign-in to follow.
  assert.match(src, /if \(preview\.live\) invites\.setInviteCookie\(req, res, token\);/);
});

test('signing UP from an invite page follows the link server-side; signing IN is asked first', () => {
  const auth = read('src/routes/auth.js');
  // Only an account the email code just created: signing up from the link is
  // the consent. A forced navigation that plants the cookie cannot make an
  // existing account join anything without the shell's confirm.
  // A link that joined them on the spot (its maker's skip let them in) has
  // its "Find people to build with" counted before the answer (#3564); that
  // one line sits between the redeem and the branch, and nothing else may.
  // An existing account follows it only when the sign-in is the Join its page
  // asked for (the sheet sends followInvite); the cookie alone never does.
  assert.match(auth, /const consented = verified\.created \|\| req\.body\?\.followInvite === true;\s+const invite = consented\s+\? await communityInvites\.redeemCarried\(pool, req, res, verified\.userId\)\s+: \(communityInvites\.clearInviteCookie\(res\), null\);\s+(?:\/\/[^\n]*\n\s*)*if \(invite && invite\.status === 'joined'\) await challengeScorer\.scoreOnJoin\(pool, config\);\s+if \(verified\.next === 'signed-in'\)/);
  assert.match(read('frontend/src/features/auth/sign-in-sheet.tsx'), /body: JSON\.stringify\(\{ email, code, \.\.\.\(followInvite \? \{ followInvite: true \} : \{\}\) \}\)/);
  const login = auth.slice(auth.indexOf("log.info('auth', 'Login successful'"), auth.indexOf("log.info('auth', 'Login successful'") + 900);
  assert.match(login, /communityInvites\.clearInviteCookie\(res\);/, 'a password sign-in drops the carried copy');
  assert.doesNotMatch(login, /redeemCarried/);
  const src = read('src/services/community-invites.js');
  assert.match(src, /httpOnly: true,\s+sameSite: 'lax',/);
  // It never throws into a sign-in.
  assert.match(src, /log\.warn\('invites', 'Following a carried invite link failed'/);
});

test('the shell: signed out it is the landing, remembered for after sign-in; signed in it is a confirm', () => {
  const app = read('public/js/app.js');
  assert.match(app, /const inviteToken = rawHash \? null : App\._inviteTokenFromPath\(location\.pathname\);/);
  assert.match(app, /AuthScreens\.rememberDeepLink\(location\.pathname\);\s+AuthScreens\.show\('landing'\);/);
  assert.match(app, /if \(App\.user\.hasPlatformAccess !== false\) \{\s+App\._followInvite\(inviteToken\);/);
  assert.match(app, /confirmLabel: 'Join',\s+cancelLabel: 'Not now',/);
  const screens = read('public/js/auth-screens.js');
  assert.match(screens, /if \(\/\^\\\/invite\\\/\[A-Za-z0-9_-\]\{22\}\$\/\.test\(value\)\) return value;/, 'a deep link back to it');
  assert.match(screens, /if \(invite\) AuthScreens\._waitingInvite = invite\[1\];/, 'kept for the waiting room');
  const waiting = read('frontend/src/features/auth/waiting.tsx');
  assert.match(waiting, /fetch\(`\/api\/invite-links\/by-token\/\$\{encodeURIComponent\(token\)\}\/redeem`/);
  assert.match(waiting, /fetch\('\/api\/invite-links\/queued'/);
});

test('the words: the landing card, the invite pane', () => {
  const card = loadTsx('frontend/src/features/auth/invite-card.tsx');
  assert.equal(card.inviteTokenFrom('/invite/YigKXxtTzBB_TFZVTkjEtg'), 'YigKXxtTzBB_TFZVTkjEtg');
  assert.equal(card.inviteTokenFrom('/invite/nope'), null);
  assert.equal(card.invitedLine({ live: true, reason: null, project: { name: 'Tiers', iconEmoji: null, iconUrl: null }, inviter: 'ada' }),
    '@ada invited you to join Tiers.');
  assert.equal(card.membersLine(1), '1 person is in it.');
  assert.equal(card.membersLine(0), '');
  // "Made for you": the gift when the sender made it, the invitation when not.
  const made = { live: true, reason: null, project: { name: 'Sunday Run Club', iconEmoji: '🏃', iconUrl: null },
    inviter: 'maya', inviterName: 'Maya', inviterMadeIt: true, memberCount: 4 };
  assert.equal(card.madeLine(made), 'Maya made this for Sunday Run Club');
  assert.equal(card.underLine(made), 'and invited you to join · 4 people are in it');
  assert.equal(card.underLine({ ...made, memberCount: 0 }), 'and invited you to join');
  assert.equal(card.madeLine({ ...made, inviterMadeIt: false }), '@maya invited you to join Sunday Run Club.');
  assert.equal(card.underLine({ ...made, inviterMadeIt: false, memberCount: 1 }), '1 person is in it.');

  const pane = loadTsx('frontend/src/features/app-context/invite-pane.tsx');
  const now = Date.parse('2026-09-27T12:00:00Z');
  const fresh = { expiresAt: '2026-10-04T12:00:00Z', maxUses: 25, uses: 0 };
  assert.equal(pane.linkSentence(fresh, 'member', now), 'Anyone with this link can join. It expires in 7 days and works for 25 people.');
  assert.equal(pane.linkSentence({ ...fresh, uses: 24 }, 'collaborator', now),
    'Anyone with this link can join and build with you. It expires in 7 days and works for 1 more person.');
  assert.equal(pane.linkDetail({ ...fresh, uses: 3 }, now), '3 of 25 used · 7 days left');
  // WP-D: a link with no end date, or for anyone, says so.
  const forever = { expiresAt: null, maxUses: null, uses: 0 };
  assert.equal(pane.linkSentence(forever, 'member', now), 'Anyone with this link can join. It works until you turn it off.');
  assert.equal(pane.linkSentence({ ...forever, maxUses: 25 }, 'member', now), 'Anyone with this link can join. It has no end date and works for 25 people.');
  assert.equal(pane.linkSentence({ ...fresh, maxUses: null }, 'member', now), 'Anyone with this link can join. It expires in 7 days.');
  assert.equal(pane.linkDetail({ ...forever, uses: 4 }, now), '4 joined · no end date');
  assert.equal(pane.linkDetail({ ...fresh, maxUses: null, uses: 2 }, now), '2 joined · 7 days left');
  const paneSrc = read('frontend/src/features/app-context/invite-pane.tsx');
  assert.match(paneSrc, /const DAY_CHOICES = \[1, 7, 30, NO_LIMIT\];/);
  assert.match(paneSrc, /'Until you turn it off'/);
  assert.match(paneSrc, /'Anyone with the link'/);
  assert.match(paneSrc, /\{state\.joiningRule\}/);
  assert.equal(pane.newcomerLine(null), 'Someone new to Homeroom joins the waitlist first, and this project when they are let in.');
  assert.equal(pane.newcomerLine(2), 'You can let 2 people new to Homeroom skip the waitlist.');

  // #3362: the menu's "Invite to community" row is gone; the pane opens from
  // the hub's Invite (and a just-yours project's Share it card), beside the
  // people it adds.
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  assert.doesNotMatch(sheet, /id="app-menu-row-invite"/);
  const hubCard = read('frontend/src/features/dev-board/workshop/community-card.tsx');
  assert.match(hubCard, /export function openInviteLinks\(\): void \{[\s\S]*?ctx\.open\?\.\(\);\s*ctx\.showInvite\?\.\(\);/);
  assert.match(hubCard, /data-ws-community-invite=""[\s\S]{0,120}onClick=\{openInviteLinks\}/);
  assert.match(hubCard, /data-ws-share-invite=""[\s\S]{0,60}onClick=\{openInviteLinks\}/);
  assert.match(sheet, /view === 'invite' \? \(\s+<InvitePane slug=\{slug \|\| null\} label=\{appLabel\} \/>/);
  assert.match(read('frontend/src/features/app-context/app-context-controller.js'), /showInvite\(\) \{\s+appContextStore\.set\(\{ view: 'invite' \}\);/);
});

test(`a link carries its maker's note: plain text, one paragraph, at most 280 characters`, () => {
  assert.equal(invites.NOTE_MAX, 280);
  assert.deepEqual(invites.cleanNote(undefined), { ok: true, note: null });
  assert.deepEqual(invites.cleanNote('   '), { ok: true, note: null });
  assert.deepEqual(invites.cleanNote('  Come  help\nwith our run tracker! '), { ok: true, note: 'Come help with our run tracker!' });
  assert.equal(invites.cleanNote('x'.repeat(280)).ok, true);
  assert.equal(invites.cleanNote('x'.repeat(281)).ok, false);
  assert.equal(invites.cleanNote('🏃'.repeat(280)).ok, true, 'counted in characters, not code units');
  assert.equal(invites.cleanNote('bell\u0007').ok, false);
  assert.equal(invites.cleanNote(42).ok, false);
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE community_invites ADD COLUMN IF NOT EXISTS note TEXT;/);
  assert.match(schema, /CHECK \(note IS NULL OR char_length\(note\) BETWEEN 1 AND 280\)/);
  const src = read('src/services/community-invites.js');
  assert.match(src, /const cleaned = cleanNote\(note\);\s+if \(!cleaned\.ok\) return \{ ok: false, status: 400, error: cleaned\.error \};/);
  assert.match(read('src/routes/community-invites.js'), /maxUses: req\.body\?\.maxUses, note: req\.body\?\.note,/);
});

test(`the preview reads like the page: who made it for whom, their note, the project's picture`, () => {
  const live = {
    live: true,
    project: { name: 'Sunday Run Club', iconUrl: '/app-icons/abc', description: 'A run tracker', picture: null },
    inviter: 'maya', inviterName: 'Maya', inviterMadeIt: true, note: 'Come help with our run tracker!', memberCount: 4,
  };
  const tags = routes.previewTags(live, 'https://homeroom.example');
  assert.match(tags, /og:title" content="Maya made this for Sunday Run Club"/);
  assert.match(tags, /og:description" content="Come help with our run tracker!"/);
  assert.match(tags, /og:image" content="https:\/\/homeroom\.example\/app-icons\/abc"/);
  assert.match(tags, /twitter:card" content="summary"/);
  // No note: the project's own line. Not its maker: the plain invitation.
  const plain = routes.previewTags({ ...live, note: null, inviterMadeIt: false }, null);
  assert.match(plain, /og:title" content="Join Sunday Run Club on Homeroom"/);
  assert.match(plain, /og:description" content="A run tracker"/);
  assert.doesNotMatch(plain, /og:image/);
  // A picture is the large card.
  const shot = routes.previewTags({ ...live, project: { ...live.project, picture: { kind: 'shot', url: '/api/public/invites/t/picture' } } }, 'https://h.example');
  assert.match(shot, /twitter:card" content="summary_large_image"/);
  assert.match(shot, /og:image" content="https:\/\/h\.example\/api\/public\/invites\/t\/picture"/);
  // WP-D: a sketch is a page, not an image: the preview keeps the icon.
  const sketched = routes.previewTags({ ...live, project: { ...live.project, picture: { kind: 'sketch', url: '/api/public/invites/t/sketch.html' } } }, 'https://h.example');
  assert.match(sketched, /og:image" content="https:\/\/h\.example\/app-icons\/abc"/);
  assert.match(sketched, /twitter:card" content="summary"/);
  assert.doesNotMatch(sketched, /sketch\.html/);
  // The note is escaped like everything else.
  assert.match(routes.previewTags({ ...live, note: 'a "quote" <b>' }, null), /content="a &quot;quote&quot; &lt;b&gt;"/);
});

test('the picture is served only through a live link, and only an after-shot of a merged change', () => {
  const src = read('src/services/community-invites.js');
  assert.match(src, /WHERE s\.app_id = \$1 AND s\.merged_at IS NOT NULL AND s\.shots_state = 'verified'\s+AND a\.side = 'head' AND a\.media = 'png'/);
  assert.match(src, /async function pictureBytes\(pool, token\) \{\s+const invite = await loadInvite\(pool, token\);\s+if \(deadReason\(invite\)\) return null;/);
  const route = read('src/routes/community-invites.js');
  assert.match(route, /router\.get\('\/api\/public\/invites\/:token\/picture', invitePreviewLimiter,/);
  assert.match(route, /'X-Content-Type-Options': 'nosniff',/);
  // WP-D: the sketch a project still being built shows, through a live link,
  // sandboxed like the project's own sketch page.
  assert.match(route, /router\.get\('\/api\/public\/invites\/:token\/sketch\.html', invitePreviewLimiter,/);
  assert.match(route, /'Content-Security-Policy': require\('\.\.\/services\/app-sketch'\)\.SKETCH_CSP,/);
  assert.match(src, /async function sketchPage\(pool, token, \{ theme = null \} = \{\}\) \{\s+const invite = await loadInvite\(pool, token\);\s+if \(deadReason\(invite\)\) return null;/);
  const card = read('frontend/src/features/auth/invite-card.tsx');
  assert.match(card, /<iframe\s+title=\{`A sketch of \$\{project\.name\}`\}\s+src=\{`\$\{picture\.url\}\?theme=/);
  assert.match(card, /sandbox=""/);
});

test(`a live link's landing is "Made for you"; the pitch stays in the document, hidden`, () => {
  const landing = read('frontend/src/features/auth/landing.tsx');
  assert.match(landing, /const madeForYou = !!invite\?\.live;/);
  assert.match(landing, /const pitchHidden = madeForYou \|\| storyOn;/);
  for (const hidden of [
    "hiddenLast(pitchHidden, 'grow')",
    "hiddenLast(pitchHidden, 'mx-auto mt-6 block h-auto w-[272px] xl:w-[320px] max-w-full')",
    "hiddenLast(pitchHidden, 'mt-3 overflow-hidden pt-2 pb-1 pl-4')",
    "hiddenLast(pitchHidden, 'px-4 flex grow flex-col text-center')",
  ]) assert.ok(landing.includes(hidden), hidden);
  const card = read('frontend/src/features/auth/invite-card.tsx');
  assert.match(card, /<section data-landing-invite="live"/);
  assert.match(card, /data-landing-invite-picture=\{picture\.kind\}/);
  assert.match(card, /data-landing-invite-note=""/);
  assert.match(card, /\{`Join \$\{project\.name\}`\}/);
});
