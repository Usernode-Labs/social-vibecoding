'use strict';

// A shared link opened while signed out (#5264): the landing's sign-in sheet,
// titled for where the link leads, over a blurred stand-in for that page, in
// place of the full-page "Sign in" form; signing in lands on the link
// (frontend/src/features/auth/deep-link-sign-in.tsx, landing.tsx,
// AuthScreens.showSignInFor, App.restoreFromHash).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');
const providers = require('../src/services/sign-in-providers');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MOD = 'frontend/src/features/auth/deep-link-sign-in.tsx';
const lib = () => loadTsx(MOD);

test('the place a link names: a screen, a project, or a page', () => {
  const { deepLinkPlace } = lib();
  assert.deepEqual(deepLinkPlace('#apps'), { kind: 'screen', screen: 'discover' });
  assert.deepEqual(deepLinkPlace('#discover'), { kind: 'screen', screen: 'discover' });
  assert.deepEqual(deepLinkPlace('#apps/demo-app'), { kind: 'screen', screen: 'discover' });
  assert.deepEqual(deepLinkPlace('#messages'), { kind: 'screen', screen: 'messages' });
  assert.deepEqual(deepLinkPlace('#chat/12'), { kind: 'screen', screen: 'messages' });
  assert.deepEqual(deepLinkPlace('#communities'), { kind: 'screen', screen: 'communities' });
  assert.deepEqual(deepLinkPlace('#workshop'), { kind: 'screen', screen: 'communities' });
  assert.deepEqual(deepLinkPlace('#notifications'), { kind: 'screen', screen: 'notifications' });
  assert.deepEqual(deepLinkPlace('#settings/account'), { kind: 'screen', screen: 'settings' });
  assert.deepEqual(deepLinkPlace('#app/demo-app/board'), { kind: 'project', slug: 'demo-app' });
  assert.deepEqual(deepLinkPlace('#app/demo-app/full?path=/t/1'), { kind: 'project', slug: 'demo-app' });
  assert.deepEqual(deepLinkPlace('/app/demo-app/dev?demo=1'), { kind: 'project', slug: 'demo-app' });
  assert.deepEqual(deepLinkPlace('#app/Not%20A%20Slug'), { kind: 'page' });
  assert.deepEqual(deepLinkPlace('#leaderboard'), { kind: 'page' });
  assert.deepEqual(deepLinkPlace('#toString'), { kind: 'page' }, 'only the map\'s own keys');
  assert.deepEqual(deepLinkPlace(''), { kind: 'page' });
});

test('the title names the place, each a whole message', () => {
  const { deepLinkTitle } = lib();
  const t = (id, params) => message(id, params);
  assert.equal(deepLinkTitle({ kind: 'screen', screen: 'discover' }, null, t), 'Sign in to open Discover');
  assert.equal(deepLinkTitle({ kind: 'screen', screen: 'messages' }, null, t), 'Sign in to open Messages');
  assert.equal(deepLinkTitle({ kind: 'screen', screen: 'communities' }, null, t), 'Sign in to open Communities');
  assert.equal(deepLinkTitle({ kind: 'screen', screen: 'notifications' }, null, t), 'Sign in to see your notifications');
  assert.equal(deepLinkTitle({ kind: 'screen', screen: 'settings' }, null, t), 'Sign in to open Settings');
  assert.equal(deepLinkTitle({ kind: 'project', slug: 'run' }, 'Sunday Run Club', t), 'Sign in to open Sunday Run Club');
  assert.equal(deepLinkTitle({ kind: 'project', slug: 'run' }, null, t), 'Sign in to open this project');
  assert.equal(deepLinkTitle({ kind: 'page' }, null, t), 'Sign in to open this page');
});

test('a provider\'s trip comes back to the link, and the server takes only paths on this origin', () => {
  const { deepLinkReturnTo } = lib();
  assert.equal(deepLinkReturnTo('#apps'), '/#apps');
  assert.equal(deepLinkReturnTo('#app/demo-app/board'), '/#app/demo-app/board');
  assert.equal(deepLinkReturnTo('/app/demo-app/board?demo=1'), '/app/demo-app/board');
  assert.equal(deepLinkReturnTo('#'), '/');
  assert.equal(deepLinkReturnTo(''), '/');
  for (const value of ['/', '/#apps', '/#app/demo-app/board', '/app/demo-app/board', '/invite/AAAAAAAAAAAAAAAAAAAAAA']) {
    assert.equal(providers.safeReturnTo(value), value, value);
  }
  for (const value of ['//evil.example', '//evil.example/#apps', 'https://evil.example/', '/\\evil.example',
    'javascript:alert(1)', '/x', '/app/../x', '/app/Demo', '/#', '/#a b', '/#<x>', null, 7]) {
    assert.equal(providers.safeReturnTo(value), '/', String(value));
  }
});

test('the backdrop is a stand-in, hidden from assistive tech, between the story and the sheet', () => {
  const { DeepLinkBackdrop } = lib();
  const html = renderToHtml(createElement(DeepLinkBackdrop));
  assert.match(html, /^<div aria-hidden="true" data-deep-link-backdrop=""/);
  assert.match(html, /fixed inset-0 z-\[45\]/, 'under the sheet (z-50), over the story');
  assert.match(html, /blur-md/);
});

test('the router hands a signed-out deep link to the landing\'s sheet, remembered for after', () => {
  const app = read('public/js/app.js');
  assert.match(app, /AuthScreens\.showSignInFor\(App\._deepLinkTarget\(\)\);/);
  assert.doesNotMatch(app, /AuthScreens\.rememberDeepLink\(App\._deepLinkTarget\(\)\);\s*\n\s*AuthScreens\.show\('login'\);/);
  const screens = read('public/js/auth-screens.js');
  assert.match(screens, /showSignInFor\(fullHash\) \{\s*AuthScreens\.rememberDeepLink\(fullHash\);\s*AuthScreens\._deepLinkSignIn = AuthScreens\._pendingHash \|\| '';\s*AuthScreens\.show\('landing'\);/);
  // finishLogin restores the same remembered link, so the sheet's sign-in lands on it.
  assert.ok(screens.includes("const target = AuthScreens._pendingHash || '';"));
});

test('the landing opens the sheet as it shows, titled for the link, and Close leaves the story', () => {
  const landing = read('frontend/src/features/auth/landing.tsx');
  assert.match(landing, /const target = typeof host\?\._deepLinkSignIn === 'string' \? host\._deepLinkSignIn : '';\s*if \(host\) host\._deepLinkSignIn = '';\s*flushSync\(/,
    'read once, in the on-show hook, committed before the screen is revealed');
  assert.match(landing, /\{gate \? <DeepLinkBackdrop \/> : null\}/);
  assert.match(landing, /title=\{deepLinkTitle\(gate\.place, gateProject,/);
  assert.match(landing, /returnTo=\{deepLinkReturnTo\(gate\.target\)\}/);
  assert.match(landing, /onClose=\{closeGate\}/);
  assert.match(landing, /open=\{!gate && !intent && \(sheet === 'start' \|\| sheet === 'signin'\)\}/,
    'the story\'s own sheet stays down under it, and under a project page\'s own sheet');
  assert.match(landing, /const linkedApp = linkedSlug && apps \? apps\.find\(\(a\) => a\.slug === linkedSlug\) \?\? null : null;/,
    'a public project\'s name, from the directory the screen loads anyway');
});

// THE GUEST PAGES TAKE THE LINKS A VISITOR CAN READ (features/guest): a link
// to Discover opens the guest Discover, and a link to a PUBLIC project opens
// its read-only page, with no sheet. The sheet stays for everything else, and
// a project link waits for the directory before either shows.
test('Discover and public project links open the guest pages; the rest keep the sheet', () => {
  const landing = read('frontend/src/features/auth/landing.tsx');
  // The story's switch, and an account still on the waitlist looks around too.
  assert.match(landing, /const guestOn = storyOn \|\| waitingGuest;/, 'the guest pages ride the story\'s switch');
  assert.match(landing, /const waitingGuest = session && waitlistPayload\?\.story_landing !== false && !onInvitePath;/);
  assert.match(landing, /const guestProject = guestOn \? linkedApp : null;/);
  assert.match(landing, /const linkPending = guestOn && !!linkedSlug && apps === null && !appsFailed;/);
  assert.match(landing, /const discoverLink = deepPlace\?\.kind === 'screen' && deepPlace\.screen === 'discover';/);
  // A signed-in account is never asked to sign in.
  assert.match(landing, /const gate = !session && deepLink && !\(guestOn && discoverLink\) && !guestProject && !linkPending \? deepLink : null;/);
  assert.match(landing, /setDeepLink\(target \? \{ target, place: deepLinkPlace\(target\) \} : null\);/,
    'the on-show hook keeps the link as it came; what is left for the sheet is derived');
});

test('under a look the bar names the place a gated link was for, in the product\'s own words', () => {
  // Version 2 of the looks (o12 to o25): gated addresses behave as in the
  // standard look. What a look adds is the place's name in the frame's bar.
  const { gatePlaceWords } = lib();
  const said = (target) => {
    const { head, trail } = gatePlaceWords(target);
    return [head ? message(head.id, head.values) : null, ...trail.map((w) => message(w.id, w.values))];
  };
  assert.deepEqual(said('#messages'), ['Messages']);
  assert.deepEqual(said('#chat/12'), ['Messages']);
  assert.deepEqual(said('#homeroom-bot/main'), ['Homeroom bot']);
  assert.deepEqual(said('#profile'), ['You']);
  assert.deepEqual(gatePlaceWords('#profile/evan').head, { id: '', text: '@evan' }, 'somebody\'s profile keeps its name, not You');
  assert.equal(renderToHtml(createElement(lib().GatePlace, { target: '#profile/evan' })), '<span hidden="" data-guest-place="head">@evan</span>');
  assert.deepEqual(said('#settings/account'), ['Settings']);
  assert.deepEqual(said('#leaderboard'), ['Challenges']);
  assert.deepEqual(said('#challenges'), ['Challenges'], 'the older address of the same page');
  assert.deepEqual(said('#leaderboard/challenges/3/9'), ['Challenges']);
  assert.deepEqual(said('#leaderboard/kudos'), [null], 'a place with no name of its own leaves the bar its brand');
  assert.deepEqual(said('#notifications'), [null]);
  assert.deepEqual(said('#toString'), [null], 'only the map\'s own keys');
  // A project: the brand, then the place; a bare link to its page opens its Workshop.
  assert.deepEqual(said('/app/usernode-2d5619/workshop'), [null, 'Workshop']);
  assert.deepEqual(said('#app/usernode-2d5619/workshop?ws=workshop'), [null, 'Workshop']);
  assert.deepEqual(said('/app/usernode-2d5619/workshop?ws=status'), [null], 'the Hub is the project itself');
  assert.deepEqual(said('/app/usernode-2d5619/workshop?ws=needs'), [null, 'Needs you']);
  assert.deepEqual(said('/app/usernode-2d5619/dev/issues/5998'), [null, 'Workshop', 'Request #5998']);
  assert.deepEqual(said('#app/usernode-2d5619/dev/changes/6369'), [null, 'Workshop', 'Change #6369']);
  assert.deepEqual(said('/app/usernode-2d5619/dev/issues/abc'), [null]);
  assert.deepEqual(said('#app/usernode-2d5619'), [null]);
  const html = renderToHtml(createElement(lib().GatePlace, { target: '/app/usernode-2d5619/dev/issues/5998' }));
  assert.equal(html, '<span hidden="" data-guest-place="trail">Workshop</span><span hidden="" data-guest-place="trail">Request #5998</span>');
  assert.equal(renderToHtml(createElement(lib().GatePlace, { target: '#messages' })), '<span hidden="" data-guest-place="head">Messages</span>');
});

test('under a look a gated address is the same sheet over the same outline: no page of its own', () => {
  const landing = read('frontend/src/features/auth/landing.tsx');
  assert.doesNotMatch(landing, /GatedFrame|gateSheet|gated-frame/, 'the first tour\'s members\' page is gone');
  assert.ok(!fs.existsSync(path.join(ROOT, 'frontend/src/features/guest/frame/gated-frame.tsx')));
  assert.match(landing, /\{gate \? <DeepLinkBackdrop \/> : null\}\s*\{gate \? \(\s*<SignInSheet\s+open\s+title=\{deepLinkTitle\(gate\.place, gateProject/, 'the sheet opens by itself, whatever the look');
  const catalog = JSON.parse(read('frontend/locales/en/auth.json'));
  assert.deepEqual(Object.keys(catalog).filter((key) => key.startsWith('frame.gated.')), [], 'its words went with it');
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf("A MEMBERS' ADDRESS OPENED BY A VISITOR"), css.indexOf('/* looks:begin'));
  assert.ok(css.includes("A MEMBERS' ADDRESS OPENED BY A VISITOR"));
  assert.doesNotMatch(css, /data-gated-frame/);
  assert.match(hand, /html\[data-frame-chrome="guest"\] \[data-deep-link-backdrop\] \{ top: var\(--fr-shell-top, 0px\); z-index: 0; background: none !important; \}/, 'under the bar, on the look\'s own ground');
  assert.match(hand, /\[data-deep-link-backdrop\] > div \{[^}]*opacity: 0\.6; filter: none; \}/, 'an outline, not a blur');
  assert.match(hand, /:is\(\.rounded-full, \.rounded-\\\[20px\\\]\) \{ background: var\(--fr-surface\); box-shadow: inset 0 0 0 1px var\(--fr-line2\); \}/, 'drawn with the kit\'s surface');
  assert.match(hand, /#auth-landing-screen:has\(\[data-deep-link-backdrop\]\) \[data-guest-discover\] \{ display: none; \}/, 'the landing\'s own page is not under it');
});
