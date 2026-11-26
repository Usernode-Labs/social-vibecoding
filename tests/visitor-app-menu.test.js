'use strict';
// The Homeroom mark and its menu for a visitor with no account who has an
// app open (frontend/src/features/guest/visitor-app-menu.tsx, drawn in the
// landing's bar, frontend/src/features/auth/landing.tsx):
//
//   - the bar ends in the mark, after Join the waitlist on a computer and
//     after Sign in on a phone, only while an app is open and nobody is
//     signed in; Pin is gone from it;
//   - the menu is a running app's, less what needs an account: Suggest an
//     improvement, About <app>, Go to community, Report app, Privacy and
//     Terms;
//   - Suggest opens a pop-up asking to sign up or sign in, in the app's
//     name; Report app, which needs an account, opens the sign-in sheet.
//
// Run with: node --test tests/visitor-app-menu.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const MENU = 'frontend/src/features/guest/visitor-app-menu.tsx';
const LANDING = 'frontend/src/features/auth/landing.tsx';
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const text = (html) => html.replace(/<[^>]+>/g, '\n').split('\n').map((t) => t.trim()).filter(Boolean)
  .map((t) => t.replace(/&#x27;/g, "'").replace(/&amp;/g, '&'));

const ROW = {
  slug: 'game-corner', name: 'Game Corner', description: 'Puzzle, word, card and arcade games.',
  category: 'games', member_count: 95, guest_ready: true, requires_login: true, url: 'https://game-corner.example',
};
const APP = { slug: 'game-corner', name: 'Game Corner', row: ROW };
const noop = () => {};
const ACTIONS = {
  onSuggest: noop, onCommunity: noop, onReport: noop,
  privacyHref: 'https://example.com/privacy', termsHref: 'https://example.com/terms',
};

test('the bar ends in the Homeroom mark while an app is open for a visitor, and Pin is gone', () => {
  const src = read(LANDING);
  const header = src.slice(src.indexOf('id="landing-header"'), src.indexOf('</header>'));
  const actions = header.slice(header.indexOf('data-landing-actions'));
  // After the bar's Sign up (Join the waitlist), the last control in the
  // group: on a phone that button is not drawn, so the mark follows Sign in.
  const signUp = actions.indexOf('data-landing-sign-up=""');
  const mark = actions.indexOf('<VisitorMark');
  assert.ok(signUp > 0 && mark > signUp, 'the mark comes after Sign up');
  assert.match(actions, /\{openApp && !session \? \(\s+<VisitorMark\s+app=\{openApp\}/);
  assert.doesNotMatch(header, /data-landing-pin-app/);
  // The title keeps clear of Sign in and the mark, as it kept clear of Pin.
  assert.match(src, /id="landing-header-title"\s+className="flex-1 min-w-0 px-10 [^"]* \[#landing-header:has\(\[data-landing-app-menu\]\)_&\]:pe-\[112px\]"/);
  // Still no anchor in the bar (tests/header-height-parity.test.js).
  assert.doesNotMatch(header, /<a[\s>]/);
});

test('the mark is the member bar\'s mark: the artwork and a chevron at the bar\'s 28px, a 44px box for the finger', () => {
  const html = renderComponent(MENU, 'VisitorMark', { app: APP, open: false, onToggle: noop, buttonRef: { current: null } });
  assert.match(html, /<button[^>]*data-landing-app-menu="game-corner"/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /aria-expanded="false"/);
  assert.ok(html.includes(`aria-label="${message('auth:landing.appMenu.button', { app: 'Game Corner' })}"`));
  assert.match(html, /class="un-touch-target -my-2 min-h-11 /, 'the same touch box as Sign in beside it');
  assert.match(html, /<img[^>]*src="\/brand\/homeroom-mark\.png"[^>]*alt=""/);
  assert.match(html, /class="platform-mark-tile w-\[26px\] h-\[26px\]/);
});

test('the menu is a running app\'s, less what needs an account', () => {
  const html = renderComponent(MENU, 'VisitorMenuBody', { app: APP, actions: ACTIONS, onAbout: noop, titleId: 't' });
  assert.deepEqual(text(html), [
    'Feedback & info',
    'Suggest an improvement',
    'About Game Corner',
    'Go to community',
    'Report app',
    'Privacy',
    '·',
    'Terms',
  ]);
  assert.match(html, /data-visitor-menu-suggest=""[^>]*class="one-btn one-btn-1 w-full"/, 'Suggest is the menu\'s one main action');
  for (const row of ['about', 'community', 'report']) assert.match(html, new RegExp(`data-visitor-menu-row="${row}"`));
  assert.match(html, /<a href="https:\/\/example\.com\/privacy" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /<a href="https:\/\/example\.com\/terms" target="_blank" rel="noopener noreferrer"/);
  // Nothing an account does: no Pin, no Join, no invite, no terminal.
  assert.doesNotMatch(text(html).join('\n'), /\bPin|\bJoin|Invite|terminal/i);
  // Until the options say where Privacy and Terms are, the foot is left out.
  const bare = renderComponent(MENU, 'VisitorMenuBody', { app: APP, actions: { ...ACTIONS, privacyHref: null, termsHref: null }, onAbout: noop, titleId: 't' });
  assert.doesNotMatch(bare, /data-visitor-menu-legal/);
});

test('About is the menu\'s second pane: the app as the public directory has it', () => {
  const html = renderComponent(MENU, 'VisitorAboutPane', { app: APP, onBack: noop, titleId: 't' });
  const words = text(html);
  assert.ok(words.includes('Game Corner'));
  assert.ok(words.includes('Puzzle, word, card and arcade games.'));
  assert.match(html, /data-visitor-menu-members=""/);
  assert.ok(text(html).join(' ').includes('Public community · 95 members'));
  assert.match(html, /data-visitor-menu-back=""[^>]*aria-label="Back to the menu"/);
  // A small community says no number, as the project page does (MIN_MEMBERS).
  const small = renderComponent(MENU, 'VisitorAboutPane', { app: { ...APP, row: { ...ROW, member_count: 1 } }, onBack: noop, titleId: 't' });
  assert.doesNotMatch(small, /data-visitor-menu-members/);
  // Without the directory's row, the name alone.
  const unnamed = renderComponent(MENU, 'VisitorAboutPane', { app: { slug: 'x', name: 'X', row: null }, onBack: noop, titleId: 't' });
  assert.deepEqual(text(unnamed), ['X']);
});

test('Suggest asks a visitor to sign up first, in the app\'s own name', () => {
  assert.equal(message('auth:landing.appMenu.prompt.title'), 'Sign up to suggest an improvement');
  assert.equal(message('auth:landing.appMenu.prompt.bodyPlay', { app: 'Game Corner' }),
    'Game Corner is made by the people who play it. Sign up to suggest a change and vote on what goes in.');
  assert.equal(message('auth:landing.appMenu.prompt.bodyUse', { app: 'Todo List' }),
    'Todo List is made by the people who use it. Sign up to suggest a change and vote on what goes in.');
  assert.equal(message('auth:landing.appMenu.prompt.signUp'), 'Sign up');
  assert.equal(message('auth:landing.appMenu.prompt.signIn'), 'Sign in');
  const src = read(MENU);
  // A modal the kit presents: its backdrop is the in-place chrome the kit
  // marks adopted, so the card itself is never the node app.css hides.
  assert.match(src, /useSheet\(\{\s+kind: 'modal',/);
  assert.match(src, /ref=\{rootRef\}\s+role="dialog"/);
  assert.match(src, /data-visitor-suggest-sign-up="" className="one-btn one-btn-1 w-full"/);
  assert.match(src, /data-visitor-suggest-sign-in="" className="one-btn one-btn-2 w-full"/);
});

test('each row does what it says for somebody with no account', () => {
  const src = read(LANDING);
  // Suggest: the pop-up. Its Sign up is the bar's own sheet that makes an
  // account (Join the waitlist while new accounts wait); Sign in the sign-in sheet.
  assert.match(src, /onSuggest: \(\) => \{ setAppMenu\(null\); setSuggestPrompt\(true\); \}/);
  assert.match(src, /onSignUp=\{\(\) => \{ setSuggestPrompt\(false\); noteSignUpFrom\('header_sign_up'\); setSheet\('start'\); \}\}/);
  assert.match(src, /onSignIn=\{\(\) => \{ setSuggestPrompt\(false\); noteSignUpFrom\('header_sign_in'\); setSheet\('signin'\); \}\}/);
  // Report app: a report needs an account (POST /api/reports is behind the
  // session check), so the row leads to signing in rather than hiding.
  assert.match(src, /onReport: \(\) => \{ setAppMenu\(null\); noteSignUpFrom\('header_sign_in'\); setSheet\('signin'\); \}/);
  const server = read('server.js');
  assert.ok(server.indexOf('app.use(authMiddleware(config));') < server.indexOf("require('./src/routes/moderation').moderationRoutes(config)"),
    'reports are mounted behind the session check');
  // Go to community: the app's signed-out page.
  assert.match(src, /onCommunity: \(\) => \{ setAppMenu\(null\); goToCommunity\(openApp\.slug\); \}/);
  assert.match(src, /const target = projectHash\(slug\);/);
  // The menu and its pop-up go with the app.
  assert.match(src, /useEffect\(\(\) => \{\s+if \(openApp\) return;\s+setAppMenu\(null\);\s+setSuggestPrompt\(false\);\s+\}, \[openApp\]\);/);
});

test('a popover under the mark from 640px, the kit\'s bottom sheet under it', () => {
  const src = read(MENU);
  assert.match(src, /export const VISITOR_MENU_POPOVER_QUERY = '\(min-width: 640px\)';/);
  assert.match(src, /placeUnderAnchor\(anchorRectOf\(anchor\), size, viewport, \{ flip: false \}\)/);
  assert.match(src, /useAnchoredDismiss\(true, \[anchorRef, panelRef\], onClose\);/);
  assert.match(src, /useSheet\(\{ kind: 'sheet', onClose \}\)/);
  // Decided as it opens, never in a render the prerender makes.
  assert.match(read(LANDING), /onToggle=\{\(\) => setAppMenu\(\(m\) => \(m \? null : \{ popover: menuIsPopover\(\) \}\)\)\}/);
});
