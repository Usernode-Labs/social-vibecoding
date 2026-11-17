// The signed-out page about private communities
// (frontend/src/features/guest/guest-communities.tsx), at `/communities`.
//
// The landing's own pitch is the public library, apps anyone can edit. A
// private community is a different promise (its maker says who gets in and
// who approves a change), for somebody who runs a group, so it has a page
// of its own behind a door on the landing (features/auth/story.tsx). This
// holds:
//   - what the page says, top to bottom, and that its approval rules and
//     audiences are the product's own messages, not a second wording;
//   - its one way in, which says "Join the waitlist" while new accounts wait
//     and notes itself as where a sign-up came from;
//   - its address: the landing draws it at that pathname in the guest
//     Discover's place, and a visitor with no account may open it.
//   - its look: the website's, spelled only as that look's variables, so the
//     dark shell follows from one rule of the stylesheet.
//
// Run with: node --test tests/guest-communities.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const PAGE = 'frontend/src/features/guest/guest-communities.tsx';
const LANDING = 'frontend/src/features/auth/landing.tsx';
const STORY = 'frontend/src/features/auth/story.tsx';

const text = (html) => html.replace(/<[^>]+>/g, '\n').split('\n').map((t) => t.trim()).filter(Boolean)
  .map((t) => t.replace(/&#x27;/g, "'").replace(/&amp;/g, '&'));
const render = (over = {}) => renderComponent(PAGE, 'GuestCommunities', { waitlist: true, onStart() {}, ...over }, {
  cache: false,
  stubs: { '../auth/sign-up-from': { noteSignUpFrom() {} } },
});

test('the page, top to bottom: the hero and its hub, how it works, who it is for, the rules with how private it is, and one way in', () => {
  const html = render();
  assert.deepEqual(text(html), [
    'Private communities',
    'An app for your group, made by your group',
    // Two sentences, a line each.
    'Say what your group needs and Homeroom builds it.', 'Only the people you invite can see it.',
    'Join the waitlist',
    'Explore public apps',
    // The hero's picture: a small community hub, every word of it made up.
    'Friday Supper Club', 'Private · 12 members', 'Invite',
    '8 active this week',
    'Needs you', 'Add a sign-up sheet for Friday', 'Vote',
    'Workshop', '2 changes in progress',
    'general', 'Sam: who is bringing dessert?',
    // How it works comes first under the hero: it is what the landing's
    // button to this page promises.
    'How it works',
    message('auth:guest.groups.how.sub'),
    '01', 'Say what you need', message('auth:guest.groups.how.say.body'),
    '02', 'Invite your people', message('auth:guest.groups.how.invite.body'),
    // Drea's words (17 Nov 2026): shorter, and they say a change is previewed.
    '03', 'Change it together', 'Anyone can suggest. Everyone previews and votes. Approved changes go live in minutes.',
    'Made for groups like yours',
    'One app to bring your people together.',
    'Friend groups', message('auth:guest.groups.for.friends.body'),
    'School clubs & classes', message('auth:guest.groups.for.school.body'),
    'Local clubs', message('auth:guest.groups.for.clubs.body'),
    'Studios & collectives', message('auth:guest.groups.for.studios.body'),
    'Neighborhoods', message('auth:guest.groups.for.neighbors.body'),
    'Towns & cities', message('auth:guest.groups.for.towns.body'),
    'Your group, your rules',
    'Only the people you invite can see the app, and your group chooses who approves changes.',
    'Default', message('dialogs:whoDecides.preset.you_or_the_group.name'), 'Your yes, or a yes from most of the group.',
    message('dialogs:whoDecides.preset.two_yeses.name'), 'Any two people approve.',
    message('dialogs:whoDecides.preset.open_floor.name'), 'Any member’s yes is enough.',
    message('dialogs:whoDecides.preset.group_vote.name'), 'Most active members approve.',
    // How private it is, as one row under the rules: it was a section of
    // three cards of its own.
    'Private until you say otherwise',
    message('communities:sections.solo.noun'), message('communities:sections.invited.noun'), 'Public, if you choose',
    'Bring your group.',
    message('auth:guest.groups.closing.body'),
    'Join the waitlist',
  ]);
  // One headline for the page; a heading for each of its four sections.
  assert.equal([...html.matchAll(/<h1 /g)].length, 1);
  assert.equal([...html.matchAll(/<h2 /g)].length, 4);
  // Three steps, six kinds of group, four rules, and the label over the row of audiences.
  assert.equal([...html.matchAll(/<h3 /g)].length, 3 + 6 + 4 + 1);
  // Who it is for is drawn three ways, not as six identical cards: one large
  // card on the sky, two tinted ones, and three as a line each under a rule.
  assert.match(html, /<section [^>]*data-guest-groups-for=""/);
  assert.equal([...html.matchAll(/<article class="site-sky-card /g)].length, 1);
  assert.equal([...html.matchAll(/<article class="[^"]*bg-\[var\(--site-(?:sky-pale|mint)\)\]"/g)].length, 2);
});

test('the approval rules and the audiences are the product\'s own, in its order', () => {
  const html = render();
  // The four presets a community picks from, as the Who decides dialog lists
  // them and under its names; a new one starts on the first, and only that
  // one says so. Drea's mock-up had three; the page keeps to what the
  // product has.
  const { PRESET_KEYS, DEFAULT_PRESET } = require('../src/services/governance-rules');
  assert.deepEqual([...html.matchAll(/data-guest-groups-rule="([a-z_]+)"/g)].map((m) => m[1]), [...PRESET_KEYS]);
  assert.equal(DEFAULT_PRESET, PRESET_KEYS[0], 'the pill sits on the rule a new community has');
  assert.equal([...html.matchAll(/>Default</g)].length, 1);
  assert.ok(html.indexOf('>Default<') < html.indexOf(message('dialogs:whoDecides.preset.two_yeses.name')));
  const src = read(PAGE);
  for (const key of PRESET_KEYS) {
    // The name is the dialog's own; the line is this page's short form of it.
    assert.match(src, new RegExp(`td\\('dialogs:whoDecides\\.preset\\.${key}\\.name'\\), line: t\\('auth:guest\\.groups\\.rules\\.${key}'\\)`));
    assert.ok(message(`auth:guest.groups.rules.${key}`).length <= 48, `${key}'s line is short`);
  }
  // The first two audiences are the Communities screen's nouns; the third
  // says the step is the group's to take.
  for (const key of ['solo', 'invited']) assert.match(src, new RegExp(`tc\\('communities:sections\\.${key}\\.noun'\\)`));
  assert.match(src, /label: t\('auth:guest\.groups\.private\.publicIf'\)/);
  assert.equal(message('communities:sections.solo.noun'), 'Just you');
  assert.equal(message('communities:sections.invited.noun'), 'Private community');
  assert.equal(message('auth:guest.groups.private.publicIf'), 'Public, if you choose');
  assert.match(html, /<ol data-guest-groups-stages="" class="[^"]*">(?:<li [^>]*>(?:<svg[^>]*>.*?<\/svg>)?<span [^>]*>[^<]+<\/span><\/li>){3}<\/ol>/);
});

test('one way in, which says what it does and notes where the sign-up came from', () => {
  const waiting = render({ waitlist: true });
  const open = render({ waitlist: false });
  // The same button at the top and in the closing band.
  assert.equal([...waiting.matchAll(/<button [^>]*data-guest-groups-start=""[^>]*>Join the waitlist<\/button>/g)].length, 2);
  assert.equal([...open.matchAll(/<button [^>]*data-guest-groups-start=""[^>]*>Start a community<\/button>/g)].length, 2);
  assert.doesNotMatch(open, /Join the waitlist/);
  // Nothing else to press but the way back to the public apps, a plain link
  // to the guest Discover: this page and that one are two addresses of one
  // document. The hub in the hero's picture is a picture: its Invite and
  // Vote are not buttons.
  assert.equal([...waiting.matchAll(/<button /g)].length, 2);
  assert.deepEqual([...waiting.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]), ['/']);
  // The white button beside the first one is the way back, and the way to
  // see what people have built: somebody deciding whether to bring a group
  // wants to see one first. It stands where a back link and a line under
  // the button were.
  assert.match(waiting, /<button type="button" data-guest-groups-start="" class="[^"]*">Join the waitlist<\/button><a href="\/" data-guest-groups-public="" class="[^"]*bg-\[var\(--site-panel\)\][^"]*">Explore public apps<\/a>/);
  assert.doesNotMatch(waiting, /data-guest-groups-back/);
  const src = read(PAGE);
  assert.match(src, /const start = \(\) => \{ noteSignUpFrom\('groups'\); onStart\(\); \};/);
  assert.match(src, /const startLabel = waitlist \? t\('auth:guest\.hero\.joinWaitlist'\) : t\('auth:guest\.groups\.start'\);/);
  // The server records that name and no other (tests/sign-up-from.test.js).
  assert.ok(require('../src/services/sign-up-from').SIGN_UP_FROM.includes('groups'));
  // No id of its own (tests/shell-id-inventory.test.js) and no drawing of its
  // own (tests/shell-icon-set.test.js): its glyphs are the shell's set.
  assert.doesNotMatch(waiting, / id="/);
  assert.doesNotMatch(src, /<svg|\sd="M/);
});

test('its address: the landing draws it at /communities in Discover\'s place, and anybody may open that document', () => {
  assert.equal(loadTsx(STORY).COMMUNITIES_PATH, '/communities');
  const landing = read(LANDING);
  // Read in the first render, as the invite path is; the prerender has no location.
  assert.match(landing, /useState\(\s+\(\) => typeof location !== 'undefined' && location\.pathname === COMMUNITIES_PATH,\s+\);/);
  assert.match(landing, /useEffect\(\(\) => \{ setOnGroupsPath\(location\.pathname === COMMUNITIES_PATH\); \}, \[\]\);/);
  // A project's page or a members' link's sheet named by the hash still comes first.
  assert.match(landing, /const groupsPage = guestPages && onGroupsPath && !guestProject && !linkPending && !gate;/);
  // In the guest Discover's place, under either drawing of it.
  assert.match(landing, /\{groupsPage \? \(\s+<GuestCommunities waitlist=\{accountsWait\} onStart=\{\(\) => setSheet\('start'\)\} \/>\s+\) : \(\s+<>/);
  const at = landing.indexOf('<GuestCommunities');
  assert.ok(at > 0 && at < landing.indexOf('<LandingFrame') && at < landing.indexOf('<GuestDiscover'));

  // A visitor with no account is who it is for: the anonymous redirect and
  // the waiting-room gate both leave that one pathname alone.
  const auth = read('src/middleware/auth.js');
  const source = auth.match(/function isSpaDocumentPath\(pathname\) \{[\s\S]*?\n\}/);
  assert.ok(source, 'isSpaDocumentPath is one function');
  const isSpaDocumentPath = new Function(`${source[0]}; return isSpaDocumentPath;`)();
  assert.equal(isSpaDocumentPath('/communities'), true);
  assert.equal(isSpaDocumentPath('/'), true);
  assert.equal(isSpaDocumentPath('/app/notes-9206f8'), true);
  // Narrow: nothing under it and nothing beside it.
  assert.equal(isSpaDocumentPath('/communities/'), false);
  assert.equal(isSpaDocumentPath('/communities/anything'), false);
  assert.equal(isSpaDocumentPath('/community'), false);
  assert.equal(isSpaDocumentPath('/dashboard'), false);
});

test('drawn in the website\'s look: bands and windows, every colour a variable of that look', () => {
  const html = render();
  const src = read(PAGE);
  // A sky band with a window for the headline, then the site's green, pale
  // sun and sun bands down the page; the two sections between sit on the
  // page's own cream ground.
  assert.deepEqual([...html.matchAll(/site-band (?:site-clouds )?\[--band:var\(--site-([a-z-]+)\)\]/g)].map((m) => m[1]), ['sky', 'leaf', 'sun-band', 'sun-deep']);
  // THE LANDING'S HERO FRAME (17 Nov 2026): the sky band is the clouds, its
  // window has no strip of dots, and the words are centred. No window on
  // the page opens with a strip of three dots any more.
  assert.match(html, /<section class="site-band site-clouds \[--band:var\(--site-sky\)\] [^"]*">/);
  assert.doesNotMatch(html, /bg-\[#f2a531\] md:h-2\.5/);
  // The headline in the hero's own lighter serif, as the landing's is; four
  // of the five section headings in the site's serif (How it works is the
  // small label over its line, which takes the serif instead), and the
  // closing band's.
  assert.match(html, /<div class="[^"]* hidden md:block">Private communities<\/div><h1 class="font-\[family-name:var\(--site-display\)\] font-normal [^"]*">An app for your group, made by your group<\/h1>/);
  assert.match(html, /<span class="block">Say what your group needs and Homeroom builds it\.<\/span> <span class="block">Only the people you invite can see it\.<\/span>/);
  // The page's own picture, for the eye only, from lg: a small community
  // hub drawn in markup on a sun sheet, as the landing's picture is of the
  // communities page. It is not an image file.
  assert.match(html, /<div class="hidden [^"]*\blg:block\b[^"]*" aria-hidden="true" data-guest-groups-hub=""><div class="relative [^"]*-rotate-2">/);
  assert.doesNotMatch(html, /<img /);
  assert.match(html, /<h2 class="[^"]*uppercase[^"]*">How it works<\/h2><p class="[^"]*font-\[family-name:var\(--site-serif\)\][^"]*">From one sentence/);
  // The first button is the landing's sun pill and the one beside it its
  // white pill (features/auth/story.tsx); the closing band's is a white pill.
  assert.match(html, /<button type="button" data-guest-groups-start="" class="[^"]*bg-\[var\(--site-sun\)\] text-\[color:var\(--site-on-sun\)\]"/);
  assert.match(src, /import \{ HERO_PRIMARY, HERO_SECONDARY, SITE_DISPLAY, SITE_LABEL \} from '\.\.\/auth\/story';/);
  const css = read('public/css/app.css');
  // No colour of the app's own palette and no dark class: the look's
  // variables are the only inks, and the dark shell moves them in one rule.
  assert.doesNotMatch(src, /\b(?:text|bg|border|shadow)-(?:zinc|violet|white|black)\b/);
  assert.doesNotMatch(src, /\bdark:/);
  for (const name of new Set([...src.matchAll(/var\((--site-[a-z-]+)\)/g)].map((m) => m[1]))) {
    assert.match(css, new RegExp(`#auth-landing-screen \\{[^}]*${name}:`), `${name} is declared for the light shell`);
  }
  const dark = css.match(/\.dark #auth-landing-screen \{[^}]*\}/);
  assert.ok(dark, 'the dark shell moves the look\'s variables in one rule');
  for (const name of ['--site-ink', '--site-muted', '--site-line', '--site-sky', '--site-ground', '--site-panel', '--site-leaf', '--site-sun-pale', '--site-sun-band', '--site-sun-deep', '--site-sky-pale', '--site-mint', '--site-line-soft', '--site-ground-card']) {
    assert.ok(dark[0].includes(`${name}:`), `${name} has a dark value`);
  }
  // Sun keeps its ink words in the dark shell too.
  assert.doesNotMatch(dark[0], /--site-sun:|--site-on-sun:/);
  // THE SITE AT NIGHT (17 Nov 2026): a ground of its own, the navy of the
  // brand look's dark page and card, in place of the app's dark wallpaper;
  // the sky is dark with stars where the clouds are in light, on this
  // page's hero and its Friend groups card.
  assert.match(dark[0], /--site-ground: #0d1421;/);
  assert.match(dark[0], /--site-panel: #182135;/);
  assert.match(css, /html:not\(\[data-skin\]\) #auth-landing-screen:has\(:is\(\[data-guest-discover\], \[data-guest-groups\]\)\) \{\s+background: var\(--site-ground\);/);
  assert.match(css, /\.dark #auth-landing-screen \.site-clouds::before \{\s+background-color: var\(--site-sky\);\s+background-image:\s+radial-gradient\(/);
  assert.match(css, /\.dark #auth-landing-screen \.site-sky-card \{\s+background-color: var\(--site-sky\);/);
});
