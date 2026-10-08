'use strict';

// A PRIVATE MEMBER in the shell (users.private_member_since): an invite link
// lands them inside the group's app with no ✕, the mark menu's "Go to
// Homeroom" is their way on, and its first use runs the maker's eight-card
// tour, from a Home that has Discover but no Challenges and no New project
// and has the waitlist card, through the community's hub and the app. The
// invite's Join that makes them asks for a name and a phone first
// (tests/phone-invite-join.test.js). The server half is
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

test('the private tour: the maker\'s route in eight cards, ending on the waitlist card', () => {
  const { privateSteps } = loadTsx('frontend/src/features/first-session/tour-steps.ts');
  const steps = privateSteps({ slug: 'best-brunch', name: 'Best brunch spots' });
  assert.deepEqual(steps.map((s) => s.screen), ['home', 'home', 'hub', 'app', 'app', 'app', 'app', 'home']);
  // The taps lead on through the product's own controls: the Communities tab,
  // the Homeroom mark, then ✕ back to Home.
  assert.deepEqual(steps.map((s) => !!s.tap), [false, true, false, false, true, false, true, false]);
  assert.deepEqual(steps.map((s) => s.target), [
    '.app-card[data-slug="best-brunch"]',
    '#platform-tab-workshop',
    '#app-content',
    '#app-view',
    '#platform-mark-btn',
    '#improve-row-feedback',
    '#back-btn',
    '#home-waitlist-card',
  ]);
  // The other tours' words, reused card for card (#4044): the hub and in-app
  // cards are sharedSteps' own, so the wording cannot drift. This tour's own
  // two cards — the first and the last — never say "group" (the owner,
  // 7 October 2026); the shared menu card's approved copy does.
  assert.deepEqual(steps.map((s) => [s.title, s.text]), [
    ['Best brunch spots is on your Home', 'Open it any time from here.'],
    ['You can find Best brunch spots here', 'Communities lists every community you\'re in.'],
    ['The Best brunch spots hub', 'The discussion and the app\'s changes are here.'],
    ['Best brunch spots opens here', 'This is the app your community makes together.'],
    ['Suggest an improvement', 'Every app has this menu. Tap it.'],
    ['Suggest an improvement', 'It doesn\'t vanish into a feedback box: Homeroom bot starts building it for you, or brings it to the group, and you can follow along.'],
    ['✕ takes you back to Home', 'Open Best brunch spots again from Home any time.'],
    ['Your own apps start here', 'Join the waitlist to get your spot.'],
  ]);
  // One short sentence on this tour's own cards; the shared menu card says
  // its two ("Every app has this menu." "Tap it.").
  for (const [i, s] of steps.entries()) assert.ok(s.text.split(/[.?]\s/).length <= (i === 4 ? 2 : 1), `short: ${s.text}`);
  assert.doesNotMatch(JSON.stringify([steps[0], steps[7]].map((s) => [s.title, s.text])), /group/i);
  // The first card is pointed at, led on with Next; the menu's button and
  // the waitlist card are ringed; the last card ends the tour.
  assert.deepEqual(steps.map((s) => !!s.ringed), [true, false, false, false, false, true, false, true]);
  assert.deepEqual(steps.map((s) => !!s.last), [false, false, false, false, false, false, false, true]);
  // The menu card is drawn over the open menu; the app-whole card says where
  // the app opens (tests/first-session.test.js pins the attribute).
  assert.equal(steps[5].inMenu, true);
  assert.equal(steps[3].saysWhereItOpens, true);
  // No challenges (a private member's Home has none).
  assert.doesNotMatch(JSON.stringify(steps), /challenge|points/i);
  // Every target is one the shell draws: the Communities tab is the bar's
  // own id, the card is the waitlist card's own section.
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.ok(bar.includes('id={`platform-tab-${key}`}'));
  assert.ok(bar.includes("key: 'workshop' as const"));
  assert.match(read('frontend/src/features/home/waitlist-card.tsx'), /<section id="home-waitlist-card"/);
});

test('"Go to Homeroom" starts it once; a private member lands in the app instead of "You\'re in"', () => {
  const src = read('frontend/src/features/first-session/index.tsx');
  assert.match(src, /if \(mode\.path === 'private'\) return privateSteps\(project\);/);
  const welcome = src.slice(src.indexOf('welcome(info: FirstSessionInfo): boolean {'), src.indexOf('goHome('));
  assert.match(welcome, /if \(legacy\(\)\.App\?\.user\?\.privateMember\) \{[\s\S]*legacy\(\)\.App\?\.navigateToApp\?\.\(slug, 'app'\);[\s\S]*return true;/);
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
  // A white card leading the list, right under "Suggest an improvement"
  // (#4401): 20px, one inset hairline, the mark, rows' 15 over 13, a chevron.
  const card = sheet.slice(sheet.indexOf('id="app-menu-row-homeroom"'));
  assert.match(card, /^id="app-menu-row-homeroom"\s+type="button"\s+className="[^"]*\brounded-\[20px\][^"]*\bbg-white\b[^"]*shadow-\[inset_0_0_0_1px_var\(--app-sheet-line\)\]/);
  assert.match(card, /src="\/brand\/homeroom-mark\.png"[\s\S]*?className="platform-mark-tile w-10 h-10/);
  assert.match(card, /text-\[15px\] font-\[650\][^>]*>Go to Homeroom</);
  assert.match(card, /text-\[13px\][^>]*>Your Home, your communities and Homeroom bot</);
  assert.match(card.slice(0, card.indexOf('</button>')), /<ChevronRightIcon/);
  assert.match(sheet, /firstSession\?\.goHome\?\.\(info\)/);
  assert.match(sheet, /\{showTerminal && !privateMember \? \(/);
  assert.match(sheet, /readOnly: writeBarred,\s+\} = useStoreState\(improveStore\);[\s\S]*const readOnly = writeBarred \|\| privateMember;/);
  // First in the list, inside #switcher-nav, so the quick actions stay its
  // previous sibling (dapp.json: #improve-quick-actions + #switcher-nav).
  const nav = sheet.indexOf('id="switcher-nav"');
  assert.ok(nav < sheet.indexOf('id="app-menu-row-homeroom"'));
  assert.ok(sheet.indexOf('id="app-menu-row-homeroom"') < sheet.indexOf('id="app-menu-row-workshop"'));
});

test('the waitlist card: join, an email, a code, then On the waitlist with "Want in sooner?"', () => {
  const card = 'frontend/src/features/home/waitlist-card.tsx';
  const none = renderComponent(card, 'WaitlistCardBody', {
    standing: { state: 'none', email: null, accountEmail: 'lina@example.com', moreToken: null },
    onListed: () => {},
  });
  assert.match(none, /data-waitlist-card="join"/);
  assert.match(none, />Make your own apps</);
  assert.doesNotMatch(none, /suggest changes to them now/, 'the pitch paragraph is gone');
  assert.match(none, /We&#x27;re letting people in a few at a time\./);
  assert.match(none, /id="home-waitlist-join"[^>]*>Join the waitlist</);
  assert.doesNotMatch(none, /On the waitlist/);

  const token = 'ab'.repeat(24);
  const listed = renderComponent(card, 'WaitlistCardBody', {
    standing: { state: 'listed', email: 'lina@example.com', accountEmail: 'lina@example.com', moreToken: token },
    onListed: () => {},
  });
  assert.match(listed, /data-waitlist-card="listed"/);
  assert.match(listed, /On the waitlist/);
  assert.match(listed, />Make your own apps</);
  assert.match(listed, /We’ll email you when your spot is ready\./);
  assert.doesNotMatch(listed, /few at a time|Until then/, 'one line under the title');
  // "Want in sooner?" is one row: the question, and a link to the questions.
  assert.match(listed, /Want in sooner\?/);
  assert.match(listed, new RegExp(`href="#more/${token}"[^>]*>Answer 4 questions<`));
  assert.doesNotMatch(listed, /Optional \(moves you up the list\)|Answer them now/);

  const src = read(card);
  // Not in the prerender: nothing until the shell knows who is signed in.
  assert.match(src, /if \(!privateMember \|\| !standing \|\| standing\.state === 'admitted'\) return null;/);
  for (const p of ["'/api/me/waitlist'", "'/api/me/waitlist/join'", "'/api/me/waitlist/verify'", "'/api/me/waitlist/join-phone'"]) assert.ok(src.includes(p), p);

  // #4223: a verified phone and no confirmed email joins with the one button,
  // nothing asked; listed by phone, the news goes by text and an email is optional.
  const phone = renderComponent(card, 'WaitlistCardBody', {
    standing: { state: 'none', email: null, accountEmail: null, hasPhone: true, moreToken: null },
    onListed: () => {},
  });
  assert.match(phone, /id="home-waitlist-join"[^>]*>Join the waitlist</);
  assert.doesNotMatch(phone, /type="email"/);
  assert.match(src, /onClick=\{\(\) => \(phoneOnly \? void joinByPhone\(\) : setStep\(\{ kind: 'email' \}\)\)\}/);
  const byPhone = renderComponent(card, 'WaitlistCardBody', {
    standing: { state: 'listed', email: null, accountEmail: null, hasPhone: true, moreToken: token },
    onListed: () => {},
  });
  assert.match(byPhone, /We’ll text you when your spot is ready\./);
  assert.match(byPhone, /id="home-waitlist-add-email"[^>]*>Add an email too</);
  assert.match(byPhone, new RegExp(`href="#more/${token}"`));
  assert.doesNotMatch(listed, /Add an email too/, 'an email row has nothing to add');
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
