'use strict';

// A PRIVATE MEMBER in the shell (users.private_member_since): an invite link
// lands them inside the group's app with no ✕ (and the tip under the
// Homeroom mark), the mark menu's "Go to Homeroom" is their way on, and the
// Home it opens runs the walk, its fourth card the waitlist card, on a Home
// that has Discover but no Challenges and no New project. The invite's Join that makes
// them asks for a name and a phone first (tests/phone-invite-join.test.js).
// The server half is tests/private-member-postgres.test.js and
// tests/community-invites-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const APP = read('public/js/app.js');

test('the private member\'s walk: the three cards every newcomer gets, then the waitlist card', () => {
  const { homeWalkSteps } = loadTsx('frontend/src/features/first-session/tour-steps.ts');
  const steps = homeWalkSteps({ slug: 'best-brunch', privateMember: true });
  assert.deepEqual(steps.map((s) => s.screen), ['home', 'home', 'home', 'home']);
  assert.deepEqual(steps.map((s) => s.target), [
    '#app-list .app-card[data-slug="best-brunch"]',
    '#platform-tab-messages',
    '#platform-tab-workshop',
    '#home-waitlist-card',
  ]);
  assert.deepEqual(steps.map((s) => [s.title, s.text]), [
    ['Welcome to Homeroom', 'Your apps live here, on Home.'],
    ['Homeroom bot', 'It\'s in Messages. Ask it for a change.'],
    ['Communities', 'Each one has a hub, to talk and decide.'],
    ['Make your own apps', 'Join the waitlist to get your spot.'],
  ]);
  // Each points at its place and leads on with Next; none is pressed.
  assert.deepEqual(steps.map((s) => !!s.ringed), [true, true, true, true]);
  assert.deepEqual(steps.map((s) => !!s.last), [false, false, false, true]);
  assert.ok(steps.every((s) => !s.tap && !s.inMenu && !s.waitsFor));
  // The first three are everybody's.
  assert.deepEqual(steps.slice(0, 2), homeWalkSteps({ slug: 'best-brunch' }).slice(0, 2));
  // No challenges or points.
  assert.doesNotMatch(JSON.stringify(steps), /challenge|points/i);
  // Every target is one the shell draws: the tabs are the bar's own ids, the
  // card is the waitlist card's own section.
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.ok(bar.includes('id={`platform-tab-${key}`}'));
  for (const key of ["key: 'workshop' as const", "key: 'messages' as const"]) assert.ok(bar.includes(key), key);
  assert.match(read('frontend/src/features/home/waitlist-card.tsx'), /<section id="home-waitlist-card"/);
});

test('a private member lands in the app with the tip, and "Go to Homeroom" opens the Home that runs the walk', () => {
  const src = read('frontend/src/features/first-session/index.tsx');
  // The walk's fourth card for a private member.
  assert.match(src, /return homeWalkSteps\(\{ slug: mode\.info\.slug, privateMember: !!mode\.info\.privateMember \}\);/);
  const welcome = src.slice(src.indexOf('welcome(info: FirstSessionInfo): boolean {'), src.indexOf('goHome('));
  assert.match(welcome, /const privateMember = !!app\?\.user\?\.privateMember;/);
  assert.match(welcome, /if \(privateMember \|\| info\.newAccount\) oweWalk\(uid, \{ slug, name, privateMember \}\);/);
  assert.match(welcome, /const going = app\?\.navigateToApp\?\.\(slug, 'app'\);/);
  // Go to Homeroom: noted first (the app has its ✕ from then on), then Home,
  // where the walk runs: the app was their first visit.
  const goHome = src.slice(src.indexOf('goHome('), src.indexOf('holdWelcome(): boolean'));
  assert.match(goHome, /app\?\._notePrivateHome\?\.\(\);\s+app\?\.navigateHome\?\.\(\);/);
  assert.match(goHome, /if \(uid != null\) \{ armWalk\(uid\); setOwing\(\(n\) => n \+ 1\); \}/);
  assert.doesNotMatch(goHome, /path: 'private'/);
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

test('the mark menu: "Go to Homeroom" for a private member, and no terminal or Build it now', () => {
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  assert.match(sheet, /\{mounted && privateMember \? \(\s+<div\s+id="app-menu-homeroom-card"[^>]*>\s+<button\s+id="app-menu-row-homeroom"/);
  // A white card leading the list, right under "Suggest an improvement"
  // (#4401): 20px, one inset hairline, the mark, rows' 15 over 13, a chevron.
  // The card is a wrapper since #4399, which can add a second row to it.
  assert.match(sheet, /id="app-menu-homeroom-card"\s+className="[^"]*\brounded-\[20px\][^"]*\bbg-white\b[^"]*shadow-\[inset_0_0_0_1px_var\(--app-sheet-line\)\]/);
  const card = sheet.slice(sheet.indexOf('id="app-menu-row-homeroom"'));
  assert.match(card, /^id="app-menu-row-homeroom"\s+type="button"/);
  assert.match(card, /src="\/brand\/homeroom-mark\.png"[\s\S]*?className="platform-mark-tile w-10 h-10/);
  assert.match(card, /text-\[15px\] font-\[650\][^>]*>\{t\('agent:appContext\.goToHomeroom\.title'\)\}</);
  assert.equal(message('agent:appContext.goToHomeroom.title'), 'Go to Homeroom');
  assert.match(card, /text-\[13px\][^>]*>\{t\('agent:appContext\.goToHomeroom\.sub'\)\}</);
  assert.equal(message('agent:appContext.goToHomeroom.sub'), 'Your Home, your communities and Homeroom bot');
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

test('the Go to Homeroom card carries the home-screen offer, and the banner waits (#4399)', () => {
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  const card = sheet.slice(sheet.indexOf('id="app-menu-homeroom-card"'), sheet.indexOf('GIVE FEEDBACK IS NOT A ROW'));
  // A second row in the same card, under a hairline, only while Go to
  // Homeroom is offered and only when the banner would offer the home screen.
  assert.match(sheet, /const homeScreenOs = useHomeScreenOffer\(open && newcomer\);/);
  assert.match(card, /\{newcomer && homeScreenOs \? \(\s+<>\s+<div aria-hidden="true" className="[^"]*h-px bg-\[color:var\(--app-sheet-line\)\]"/);
  assert.match(card, /id="app-menu-row-add-home"/);
  assert.match(card, /w-10 h-10 rounded-\[11px\] bg-zinc-100[^"]*"[^>]*>\s+<PhonePlusIcon/);
  assert.match(card, /text-\[15px\] font-\[650\][^>]*>\{t\('agent:appContext\.addHomeroomToHomeScreen'\)\}</);
  assert.equal(message('agent:appContext.addHomeroomToHomeScreen'), 'Add Homeroom to your home screen');
  assert.match(card, /<InstallStepsSheet os=\{homeScreenOs\}/);
  // The offer is the banner's own decision, an a2hs one, minus its dismissal.
  const hook = read('frontend/src/features/mobile-install/home-screen-offer.ts');
  assert.match(hook, /installOffer\(\{/);
  assert.match(hook, /dismissed: false,/);
  assert.match(hook, /offer && offer\.kind === 'a2hs' \? offer\.os : null/);
  // The banner stays down while Go to Homeroom is offered.
  const banner = read('frontend/src/features/mobile-install/install-banner.tsx');
  assert.match(banner, /if \(offeringGoToHomeroom\(!!privateMember\)\) \{ setOffer\(null\); return; \}/);
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
  // Discover follows the launcher directly (#4937); the waitlist card keeps
  // its place after it.
  assert.match(read('frontend/src/features/home/index.tsx'), /<AppsMore \/>\s+<\/section>[\s\S]*<DiscoverSection \/>\s+[\s\S]*<WaitlistCard \/>/);
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
