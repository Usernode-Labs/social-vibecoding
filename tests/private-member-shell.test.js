'use strict';

// A PRIVATE MEMBER in the shell (users.private_member_since): an invite link
// lands them inside the group's app with no ✕, the mark menu's "Go to
// Homeroom" is their way on, and its first use runs a four-step tour of a
// Home that has Discover but no Challenges and no New project, and has the
// waitlist card. The invite's Join that makes them asks for a name and a
// phone first (tests/phone-invite-join.test.js). The server half is
// tests/private-member-postgres.test.js and
// tests/community-invites-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const APP = read('public/js/app.js');

test('the private tour: four steps on Home, Next through each, ending on the waitlist card', () => {
  const { privateSteps } = loadTsx('frontend/src/features/first-session/tour-steps.ts');
  const steps = privateSteps({ slug: 'best-brunch', name: 'Best brunch spots' });
  assert.deepEqual(steps.map((s) => s.screen), ['home', 'home', 'home', 'home']);
  assert.deepEqual(steps.map((s) => !!s.tap), [false, false, false, false], 'nothing to press but Next');
  assert.deepEqual(steps.map((s) => s.target), [
    '.app-card[data-slug="best-brunch"]',
    '#platform-tab-workshop',
    '#platform-tab-messages',
    '#home-waitlist-card',
  ]);
  assert.deepEqual(steps.map((s) => s.title), [
    'Best brunch spots is on your Home',
    'The group lives in Communities',
    'Homeroom bot is in Messages',
    'Make and share your own apps',
  ]);
  assert.deepEqual(steps.map((s) => !!s.last), [false, false, false, true]);
  // No challenges, and no ✕ to teach: the invited tour's step about it is
  // not in this one.
  assert.doesNotMatch(JSON.stringify(steps), /challenge|points|✕|back-btn/i);
  // Every target is one the shell draws: the tabs are the bar's own ids, the
  // card is the waitlist card's own section.
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.ok(bar.includes('id={`platform-tab-${key}`}'));
  for (const key of ["key: 'workshop' as const", "key: 'messages' as const"]) assert.ok(bar.includes(key), key);
  assert.match(read('frontend/src/features/home/waitlist-card.tsx'), /<section id="home-waitlist-card"/);
});

test('"Go to Homeroom" starts it once; a private member lands in the app instead of "You\'re in"', () => {
  const src = read('frontend/src/features/first-session/index.tsx');
  assert.match(src, /if \(mode\.path === 'private'\) return privateSteps\(project\);/);
  const welcome = src.slice(src.indexOf('welcome(info: FirstSessionInfo): boolean {'), src.indexOf('goHome('));
  assert.match(welcome, /if \(legacy\(\)\.App\?\.user\?\.privateMember\) \{[\s\S]*enterScreen\('app', info\.slug\);[\s\S]*return true;/);
  assert.ok(welcome.indexOf('privateMember') < welcome.indexOf("setMode({ kind: 'welcome', info })"), 'before "You\'re in"');
  const goHome = src.slice(src.indexOf('goHome('), src.indexOf('holdWelcome(): boolean'));
  assert.match(goHome, /const first = !app\?\._privateHomeVisited\?\.\(\);\s+app\?\._notePrivateHome\?\.\(\);\s+app\?\.navigateHome\?\.\(\);/);
  assert.match(goHome, /if \(!first \|\| !info\?\.slug\) return;/, 'the tour runs the first time only');
  assert.match(goHome, /path: 'private'/);
});

test('the app has no ✕ for a private member until they have gone to Homeroom, from either writer', () => {
  assert.match(APP, /_privateNoClose\(\) \{\s+return !!App\.user\?\.privateMember && !App\._privateHomeVisited\(\);/);
  const slotFor = APP.slice(APP.indexOf('  _backSlotFor(revealId) {'), APP.indexOf("return ['close', App._closeAppHref()];"));
  assert.match(slotFor, /if \(App\._privateNoClose\(\)\) return \['none'\];/);
  assert.match(APP, /if \(App\._privateNoClose\(\)\) App\.setBackIcon\(\.\.\.App\._backSlotFor\('app-view'\)\);\s+else App\.setBackIcon\('close', App\._closeAppHref\(\)\);/);
  // Remembered per account on this device, like the tours.
  assert.match(APP, /PRIVATE_HOME_PREFIX: 'usernode:private-home:'/);
});

test('the shell follows the tier: a reload when it changes, the store told, "Want in sooner?" reachable', () => {
  assert.match(APP, /if \(!!user\.privateMember !== !!App\.user\?\.privateMember\) \{\s+App\.saveSessionSnapshot\(user\);\s+location\.reload\(\);/);
  assert.match(APP, /window\.UsernodeReact\?\.nav\?\.setPrivateMember\?\.\(!!App\.user\?\.privateMember\);/);
  assert.match(APP, /if \(authRoute === 'more' && App\.user\?\.privateMember\) \{\s+AuthScreens\.show\('more', authSeg\);\s+return;/);
  // Their bar is everybody's: they use public apps from Discover (and do not
  // vote on them, tests/private-member-postgres.test.js).
  assert.doesNotMatch(read('frontend/src/features/nav/tab-bar.tsx'), /privateMember/);
  assert.doesNotMatch(read('public/css/app.css'), /platform-tabs-private/);
  // The prerender is the full bar: the store says FALSE until boot.
  assert.match(read('frontend/src/features/nav/nav-store.js'), /viewer: null,\s+privateMember: false,/);
});

test('the mark menu: "Go to Homeroom" for a private member, and no terminal or Build it yourself', () => {
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  assert.match(sheet, /\{mounted && privateMember \? \(\s+<button\s+id="app-menu-row-homeroom"/);
  assert.match(sheet, /label="Go to Homeroom"/);
  assert.match(sheet, /firstSession\?\.goHome\?\.\(info\)/);
  assert.match(sheet, /\{showTerminal && !privateMember \? \(/);
  assert.match(sheet, /readOnly: writeBarred,\s+\} = useStoreState\(improveStore\);[\s\S]*const readOnly = writeBarred \|\| privateMember;/);
  // After "Go to community", so it stays the list's first row (dapp.json).
  assert.ok(sheet.indexOf('id="app-menu-row-workshop"') < sheet.indexOf('id="app-menu-row-homeroom"'));
  assert.ok(sheet.indexOf('id="app-menu-row-homeroom"') < sheet.indexOf('id="app-menu-row-about"'));
});

test('the waitlist card: join, an email, a code, then On the waitlist with "Want in sooner?"', () => {
  const card = 'frontend/src/features/home/waitlist-card.tsx';
  const none = renderComponent(card, 'WaitlistCardBody', {
    standing: { state: 'none', email: null, accountEmail: 'lina@example.com', moreToken: null },
    onListed: () => {},
  });
  assert.match(none, /data-waitlist-card="join"/);
  assert.match(none, /Make and share your own apps/);
  assert.match(none, /id="home-waitlist-join"[^>]*>Join the waitlist</);
  assert.doesNotMatch(none, /On the waitlist/);

  const token = 'ab'.repeat(24);
  const listed = renderComponent(card, 'WaitlistCardBody', {
    standing: { state: 'listed', email: 'lina@example.com', accountEmail: 'lina@example.com', moreToken: token },
    onListed: () => {},
  });
  assert.match(listed, /data-waitlist-card="listed"/);
  assert.match(listed, /On the waitlist/);
  assert.match(listed, /We’ll email lina@example\.com when your spot is ready\./);
  assert.match(listed, new RegExp(`href="#more/${token}"[^>]*>Answer them now<`));

  const src = read(card);
  // Not in the prerender: nothing until the shell knows who is signed in.
  assert.match(src, /if \(!privateMember \|\| !standing \|\| standing\.state === 'admitted'\) return null;/);
  for (const p of ["'/api/me/waitlist'", "'/api/me/waitlist/join'", "'/api/me/waitlist/verify'"]) assert.ok(src.includes(p), p);
  assert.match(read('frontend/src/features/home/index.tsx'), /<AppsMore \/>\s+<\/section>[\s\S]*<WaitlistCard \/>\s+[\s\S]*<DiscoverSection \/>/);
});

test('Home for a private member: no New project tile, Discover kept, no Challenges or Create panels', () => {
  const home = read('frontend/src/features/home/home.js');
  assert.match(home, /if \(App\.user\?\.privateMember\) create = null;/);
  const panels = read('src/routes/home-panels.js');
  assert.match(panels, /const PRIVATE_MEMBER_PANELS = new Set\(\['discover'\]\);/);
  assert.match(panels, /if \(req\.user\.privateMember && !PRIVATE_MEMBER_PANELS\.has\(panel\.key\)\) continue;/);
});

test('the vote routes refuse a private member on a public app before anything is recorded', () => {
  const votes = read('src/routes/votes.js');
  const sessionVote = votes.slice(votes.indexOf("router.post('/api/sessions/:id/vote'"));
  assert.match(sessionVote, /const session = sessionRows\[0\];\s+\/\/ A private member does not vote on a public app \(communities\.js\)\.\s+const privateRefusal = await communities\.privateVoteRefusal\(pool, session\.app_id, req\.user\?\.id\);\s+if \(privateRefusal\) return res\.status\(403\)\.json\(privateRefusal\);/);
  const issues = read('src/routes/issues.js');
  const issueVote = issues.slice(issues.indexOf("router.post('/api/issues/:id/vote'"));
  assert.match(issueVote, /const issue = issueRows\[0\];\s+\/\/ A private member does not vote on a public app \(communities\.js\)\.\s+const privateRefusal = await communities\.privateVoteRefusal\(pool, issue\.app_id, req\.user\?\.id\);/);
  // And every tally and denominator leaves such a vote out (schema.sql).
  // (Followed by the verified-identity clause, tests/verified-identity-shell.test.js.)
  assert.match(read('src/db/schema.sql'), /AND pa\.view_visibility = 'public'\s+\)\s+AND NOT public_vote_needs_identity\(voter_id, target_app_id\)\s+\$\$;/);
});

test('the waitlist card\'s routes: a code-mailing join behind the email code\'s limiters, for those still waiting', () => {
  const routes = read('src/routes/member-waitlist.js');
  assert.match(routes, /router\.get\('\/api\/me\/waitlist', async/);
  // Limiters before the same-origin check (tests/same-site-browser.test.js),
  // and only somebody still waiting gets past `waiting`.
  assert.match(routes, /router\.post\('\/api\/me\/waitlist\/join', drainGuard, otpRequestLimiter, otpRequestEmailLimiter,\s+sameOriginBrowserOnly, waiting,/);
  assert.match(routes, /router\.post\('\/api\/me\/waitlist\/verify', drainGuard, otpVerifyLimiter,\s+sameOriginBrowserOnly, waiting,/);
  assert.match(routes, /code: 'already_in'/);
  // Behind the session middleware, after the invite routes.
  const server = read('server.js');
  assert.ok(server.indexOf('app.use(authMiddleware(config));') < server.indexOf('app.use(memberWaitlistRoutes(config));'));
  assert.ok(server.indexOf('app.use(communityInviteRoutes(config));') < server.indexOf('app.use(memberWaitlistRoutes(config));'));
});
