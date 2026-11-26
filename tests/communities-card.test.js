'use strict';

// A COMMUNITY'S CARD ("New, lighter", approved 20 Nov 2026;
// frontend/src/features/communities/card.tsx and app.css's block of the
// same name). The big card is a 16:9 picture, the real icon standing mostly
// below it, the name over the members, two lines of what it is and this
// week in words at its foot; with no picture its icon is the picture, on a
// wash of the icon's colour (23 Nov 2026); the compact
// card is the same with the picture taken off, its week in two plain lines
// under the name (the Joined list, approved 23 Nov 2026).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CARD = 'frontend/src/features/communities/card.tsx';
const mod = loadTsx(CARD);
const draw = (name, props) => renderToHtml(createElement(mod[name], props));
const css = read('public/css/app.css');
const block = css.slice(css.indexOf("/* ── A COMMUNITY'S CARD"), css.indexOf("/* THE COMMUNITIES TAB'S PAGE (features/communities/index.tsx"));
const rule = (selector) => {
  const at = block.indexOf(`${selector} {`);
  assert.ok(at >= 0, `${selector} is drawn`);
  return block.slice(at, block.indexOf('}', at));
};

const TIDE = {
  slug: 'tide', name: 'Tide Table', iconUrl: '/app-icons/tide', iconEmoji: null,
  pictureUrl: '/app-illustrations/light', pictureDarkUrl: '/app-illustrations/dark',
  members: 1284, description: 'Tide times for the bay.', activeWeek: 33, liveWeek: 5,
};

test('the big card: its picture (and its dark twin), its icon, its name over the members, what it is and this week, in that order', () => {
  const html = draw('CommunityCardContent', { community: TIDE });
  const order = ['class="cm-card-pic"', 'cm-card-body', 'cm-card-face', 'cm-card-icon', 'cm-card-name', 'cm-card-members', 'cm-card-desc', 'cm-card-week'];
  let last = -1;
  for (const part of order) {
    const at = html.indexOf(part);
    assert.ok(at > last, `${part} comes after what is before it`);
    last = at;
  }
  assert.match(html, /<span class="cm-card-pic"><img src="\/app-illustrations\/light" alt="" loading="lazy" draggable="false" class="cm-card-img dark:hidden"\/><img src="\/app-illustrations\/dark" alt="" loading="lazy" draggable="false" class="cm-card-img hidden dark:block"\/><\/span>/,
    'not shaded: the picture alone, decorative');
  assert.match(html, /<span class="cm-card-icon" data-icon="image" aria-hidden="true">/);
  assert.match(html, /<span class="cm-card-members" data-cm-members="">1,284 members<\/span>/);
  // This week in words at every width (phone review S3, 23 Nov 2026): no glyph and bare number to need a legend.
  assert.match(html, new RegExp(`<span class="cm-card-week" data-cm-week=""><span class="cm-week-in"><span>${message('home:communities.activeShort', { count: 33, formatted: '33' })}</span><span class="cm-week-live">${message('home:communities.liveThisWeek', { count: 5, formatted: '5' })}</span></span></span>`));
  assert.doesNotMatch(html, /cm-week-glyph|cm-week-sr|<svg/, 'no glyphs, and no second copy for a screen reader');
  assert.doesNotMatch(html, /cm-band-|data-cm-band|data-cm-bare/, 'a card with a picture is as it was');
  // A picture with no dark twin is one picture.
  assert.match(draw('CommunityCardContent', { community: { ...TIDE, pictureDarkUrl: null } }), /<span class="cm-card-pic"><img src="\/app-illustrations\/light" alt="" loading="lazy" draggable="false" class="cm-card-img"\/><\/span>/);
});

test('no picture: the icon is the picture, large in the band on its wash, and nothing beside the name (23 Nov 2026)', () => {
  const bare = { ...TIDE, pictureUrl: null, pictureDarkUrl: null };
  const html = draw('CommunityCardContent', { community: bare });
  // An image icon: the band waits on the plain ground while its colour is read (nothing is read in a prerender).
  assert.match(html, /^<span class="cm-card-pic" data-cm-band="wait"><span class="cm-band-face"><span class="cm-band-icon" data-icon="image" aria-hidden="true">/);
  // The name starts at the card's left edge: no small icon in the head.
  assert.match(html, /<span class="cm-card-body" data-cm-bare=""><span class="cm-card-head"><span class="cm-card-id"><span class="cm-card-name">Tide Table<\/span>/);
  assert.doesNotMatch(html, /cm-card-face|cm-card-icon/);
  assert.equal((html.match(/data-icon=/g) || []).length, 1, 'one icon on the card');
  // No stock background on any card, and nothing for one to hang from.
  assert.doesNotMatch(html, /data-cm-scene|brand\/bg/);
  assert.doesNotMatch(block, /data-cm-scene|brand\/bg/);
  assert.equal(mod.cardScene, undefined, 'the scene picker is gone');
  // An emoji or an initial: the glyph on its tile, over the community's brand tint, the same one every time.
  const { bandTint } = loadTsx('frontend/src/lib/community-color.ts');
  const emoji = draw('CommunityCardContent', { community: { ...bare, slug: 'oath', iconUrl: null, iconEmoji: '🔥' } });
  assert.match(emoji, new RegExp(`^<span class="cm-card-pic" data-cm-band="tint" data-cm-tint="${bandTint('oath')}"><span class="cm-band-face"><span class="cm-band-icon" data-icon="emoji" aria-hidden="true">`));
  const letter = draw('CommunityCardContent', { community: { ...bare, slug: 'zed', name: 'Zed', iconUrl: null, iconEmoji: null } });
  assert.match(letter, new RegExp(`data-cm-band="tint" data-cm-tint="${bandTint('zed')}"><span class="cm-band-face"><span class="cm-band-icon" data-icon="letter" aria-hidden="true">Z</span>`));
  // A colour dapp.json sets is the wash as it is.
  const set = draw('CommunityCardContent', { community: { ...bare, iconColor: '#2e6660' } });
  assert.match(set, /^<span class="cm-card-pic" data-cm-band="wash" style="--cm-wash:#2e6660">/);
  // A set colour with no colour in it is no wash: the tint.
  assert.match(draw('CommunityCardContent', { community: { ...bare, iconColor: '#777777', iconUrl: null, iconEmoji: '⚫' } }), /data-cm-band="tint"/);
  // The page's card puts its votes and edit discs on the band's icon.
  const page = draw('CommunityPageCard', { community: bare, votes: 2, editing: false });
  assert.match(page, /<span class="cm-band-face"><span class="cm-band-icon"[^>]*>[\s\S]*?<\/span><span [^>]*data-home-community-votes="2"/);
  const editing = draw('CommunityPageCard', { community: bare, votes: 2, editing: true, onUnpin: () => {} });
  assert.match(editing, /<span class="cm-band-face animate-\[home-wiggle/, 'the band\'s icon wiggles');
  // A picture that does not load falls back to this card (the component's own state).
  assert.match(read(CARD), /onError=\{\(\) => setFailed\(true\)\}/);
});

test('the band\'s wash: the icon\'s main colour, read once, not a blur; a brand tint where it has little colour', () => {
  const color = loadTsx('frontend/src/lib/community-color.ts');
  const px = (pixels) => Uint8ClampedArray.from(pixels.flat());
  // A two-tone icon, yellow and black (the prototype's blotchy blur): its main colour is the yellow.
  const bee = color.mainColorFromPixels(px(Array.from({ length: 64 }, (_, i) => (i % 2 ? [20, 20, 20, 255] : [250, 204, 21, 255]))));
  const [r, g, b] = color.parseHex(bee);
  assert.ok(r > 200 && g > 160 && b < 80, `yellow, not a grey blend: ${bee}`);
  // An icon with little colour (black and white, grey) has none to lend.
  assert.equal(color.mainColorFromPixels(px(Array.from({ length: 64 }, (_, i) => (i % 2 ? [15, 15, 15, 255] : [240, 240, 240, 255])))), null);
  assert.equal(color.mainColorFromPixels(px(Array.from({ length: 64 }, () => [128, 128, 132, 255]))), null);
  // The header's reading is the same hue, fitted for white text; the band's is the colour itself.
  assert.notEqual(color.deriveFromPixels(px(Array.from({ length: 64 }, () => [250, 204, 21, 255]))), bee);
  // Kept under the icon's own address, apart from the header's.
  const src = read('frontend/src/lib/community-color.ts');
  assert.match(src, /const MAIN_PREFIX = 'communityMain:v1:';/);
  assert.match(src, /canvas\.width = 64;/);
  // A tint is 1 to 5, the same for the same slug, and slugs spread across them.
  const seen = new Set();
  for (let i = 0; i < 400; i += 1) {
    const n = color.bandTint(`app-${i}`);
    assert.ok(n >= 1 && n <= color.BAND_TINTS);
    seen.add(n);
  }
  assert.equal(seen.size, color.BAND_TINTS);
  assert.equal(color.bandTint('tide'), color.bandTint('tide'));
  assert.deepEqual(color.bandWash('tide', null), { attrs: { 'data-cm-band': 'wait' } });
  assert.deepEqual(color.bandWash('tide', 'none'), { attrs: { 'data-cm-band': 'tint', 'data-cm-tint': String(color.bandTint('tide')) } });
  assert.deepEqual(color.bandWash('tide', '#123456'), { attrs: { 'data-cm-band': 'wash' }, style: { '--cm-wash': '#123456' } });
  // Each tint is a token with a dimmer dark twin, and the wash is mixed into the card's own ground.
  for (let i = 1; i <= 5; i += 1) {
    assert.match(block, new RegExp(`\\.cm-card-pic\\[data-cm-tint="${i}"\\] \\{ --cm-wash: var\\(--cm-tint-${i}\\); \\}`));
    const light = block.match(new RegExp(`:root \\{[\\s\\S]*?--cm-tint-${i}: (#[0-9a-f]{6});`))[1];
    const dark = block.match(new RegExp(`\\.dark \\{[\\s\\S]*?--cm-tint-${i}: (#[0-9a-f]{6});`))[1];
    const lum = (hex) => color.parseHex(hex).reduce((n, v) => n + v, 0);
    assert.ok(lum(dark) < lum(light), `tint ${i} is dimmer in the dark`);
  }
  assert.match(rule('.cm-card-pic:is([data-cm-band="wash"], [data-cm-band="tint"])'), /color-mix\(in oklab, var\(--cm-wash\) var\(--cm-band-near\), var\(--cm-bg\)\)/);
});

test('an emoji icon, one member, no sentence and a quiet week: each says what it has and nothing more', () => {
  const html = draw('CommunityCardContent', {
    community: { slug: 'oath', name: 'Oath of Ember', iconUrl: null, iconEmoji: '🔥', members: 1, description: '  ', activeWeek: 0, liveWeek: 0 },
  });
  assert.match(html, /<span class="cm-band-icon" data-icon="emoji" aria-hidden="true">/, 'no picture: the emoji is the band\'s');
  assert.match(html, /1 member</);
  assert.doesNotMatch(html, /cm-card-desc/, 'no sentence, no line');
  assert.doesNotMatch(html, /cm-card-week/, 'a quiet week says nothing');
  // Only active: "N active this week"; only live: the changes alone.
  assert.match(draw('CommunityWeek', { active: 6, live: 0 }), /<span class="cm-week-in"><span>6 active this week<\/span><\/span>/);
  assert.match(draw('CommunityWeek', { active: 0, live: 1 }), /<span class="cm-week-in"><span class="cm-week-live">1 change live this week<\/span><\/span>/);
  assert.equal(draw('CommunityWeek', { active: 0, live: 0 }), '');
  // No members yet: no line.
  assert.doesNotMatch(draw('CommunityCardContent', { community: { ...TIDE, members: null } }), /cm-card-members/);
});

test('the compact card: the icon beside the name, then the members and who was active, then what went live, and nothing else', () => {
  const html = draw('CommunityCardCompactContent', { community: TIDE });
  // One message, its two facts each kept whole so a narrow card wraps between them; then the tick and what went live.
  assert.equal(message('home:communities.compactMembersActive', { count: 33, formatted: '33', members: '1,284 members' }), '<0>1,284 members,</0> <1>33 active this week</1>');
  assert.match(html, /^<span class="cm-card-head"><span class="cm-card-face"><span class="cm-card-icon" data-icon="image" aria-hidden="true">[\s\S]*<span class="cm-card-name">Tide Table<\/span><span class="cm-card-members" data-cm-members=""><span class="cm-card-fact">1,284 members,<\/span> <span class="cm-card-fact">33 active this week<\/span><\/span><span class="cm-card-live" data-cm-live=""><svg[^>]*class="cm-card-live-tick"[^>]*aria-hidden="true"[\s\S]*?<\/svg><span class="cm-card-fact">5 changes live this week<\/span><\/span><\/span><\/span>$/);
  assert.doesNotMatch(html, /cm-card-pic|cm-card-desc|cm-card-week|<img[^>]*avatar/, 'no picture, no sentence, no faces');
  // A quiet community is its members alone: a zero says nothing.
  const quiet = draw('CommunityCardCompactContent', { community: { ...TIDE, members: 16, activeWeek: 0, liveWeek: 0 } });
  assert.match(quiet, /<span class="cm-card-members" data-cm-members="">16 members<\/span><\/span><\/span>$/);
  assert.doesNotMatch(quiet, /cm-card-live|cm-card-fact|active/);
  // One active, one change: the singular of each.
  const one = draw('CommunityCardCompactContent', { community: { ...TIDE, members: 1, activeWeek: 1, liveWeek: 1 } });
  assert.match(one, /<span class="cm-card-fact">1 member,<\/span> <span class="cm-card-fact">1 active this week<\/span>/);
  assert.match(one, new RegExp(`<span class="cm-card-fact">${message('home:communities.compactLive', { count: 1, formatted: '1' })}</span>`));
  assert.equal(message('home:communities.compactLive', { count: 1, formatted: '1' }), '1 change live this week');
  // Changes live with nobody active: the members, then the changes.
  const liveOnly = draw('CommunityCardCompactContent', { community: { ...TIDE, activeWeek: 0, liveWeek: 6 } });
  assert.match(liveOnly, /data-cm-members="">1,284 members<\/span><span class="cm-card-live" data-cm-live="">[\s\S]*6 changes live this week/);
  // Before the week is read: the members, as the card drew them before.
  const unread = draw('CommunityCardCompactContent', { community: { ...TIDE, activeWeek: undefined, liveWeek: undefined } });
  assert.match(unread, /<span class="cm-card-members" data-cm-members="">1,284 members<\/span><\/span><\/span>$/);
  // The big card draws its own week line, never the compact card's.
  assert.doesNotMatch(draw('CommunityCardContent', { community: TIDE }), /cm-card-live|cm-card-fact/);
});

test('the page\'s card is one link to the hub, the tile\'s hooks and votes, and its edit discs', () => {
  const html = draw('CommunityPageCard', { community: TIDE, votes: 3, editing: false });
  assert.match(html, /^<a href="\/app\/tide\/workshop" class="cm-card" data-home-community="tide" data-home-community-pinned="">/);
  assert.match(html, /data-home-community-votes="3" aria-hidden="true">3</);
  assert.match(html, new RegExp(`<span class="sr-only">${message('communities:row.toVote', { count: 3 })}</span></a>$`));
  const editing = draw('CommunityPageCard', { community: TIDE, votes: 3, editing: true, onUnpin: () => {} });
  assert.match(editing, /<span class="cm-card-face animate-\[home-wiggle/, 'the icon wiggles');
  assert.match(editing, new RegExp(`aria-label="${message('home:communities.unpinNamed', { community: 'Tide Table' })}"`));
  assert.doesNotMatch(editing, /data-home-community-votes/, 'no count while editing');
  const joined = draw('CommunityPageCard', { community: TIDE, votes: 0, editing: false, compact: true, onPin: () => {} });
  assert.match(joined, /class="cm-card" data-cm-size="compact"/);
  assert.match(joined, new RegExp(`aria-label="${message('home:communities.pinNamed', { community: 'Tide Table' })}"`));
});

test('the card\'s measures: a 16:9 picture, a 56px icon 14px over its edge, 15px names over 12px words, this week at the foot', () => {
  assert.match(rule('.cm-card-pic'), /aspect-ratio: 16 \/ 9;/);
  assert.match(rule('.cm-card-pic'), /background: var\(--cm-pic-ground\) center \/ cover no-repeat;/);
  assert.match(rule('.cm-card-img'), /object-fit: cover;\s*object-position: center;/);
  assert.match(rule('.cm-card-body'), /padding: 0 12px 14px;/);
  assert.match(rule('.cm-card-head'), /gap: 12px;/);
  assert.match(rule('.cm-card-face'), /z-index: 1;[\s\S]*margin-top: -14px;/);
  const icon = rule('.cm-card-icon');
  assert.match(icon, /width: 56px;\s*height: 56px;/);
  assert.match(icon, /border-radius: 14px;/);
  assert.match(icon, /box-shadow: 0 0 0 1\.5px var\(--cm-icon-outline\);/);
  assert.match(block, /--cm-icon-outline: rgb\(255 255 255 \/ 0\.85\);/);
  assert.match(block, /\.cm-card-icon:not\(\[data-icon="image"\]\) \{ background-color: var\(--cm-icon-tile\); \}/, 'no ground under a picture');
  assert.match(rule('.cm-card-id'), /padding-top: 6px;/);
  assert.match(rule('.cm-card-name'), /-webkit-line-clamp: 2;[\s\S]*font-size: 15px;\s*font-weight: 650;/);
  assert.match(rule('.cm-card-members'), /font-size: var\(--cm-small\);\s*line-height: var\(--cm-small-line\);[\s\S]*color: var\(--cm-muted\);/);
  assert.match(rule('.cm-card-desc'), /-webkit-line-clamp: 2;[\s\S]*margin-top: 9px;/);
  // At the card's foot, so every card of a row has it on one line (S3), at least 12px under the words.
  assert.match(rule('.cm-card-week'), /overflow: hidden;\s*margin-top: auto;\s*padding-top: 12px;/);
  assert.match(rule('.cm-card-body'), /flex: 1 1 auto;\s*flex-direction: column;/);
  // The band's icon: 64px, 16px corners, a soft shadow, centred; an emoji or initial on a white tile; 80px on a lead card.
  assert.match(rule('.cm-card-pic[data-cm-band]'), /display: flex;\s*align-items: center;\s*justify-content: center;/);
  assert.match(block, /--cm-band-icon: 64px;\s*--cm-band-icon-radius: 16px;/);
  assert.match(rule('.cm-band-icon'), /width: var\(--cm-band-icon\);\s*height: var\(--cm-band-icon\);[\s\S]*border-radius: var\(--cm-band-icon-radius\);\s*box-shadow: var\(--cm-band-icon-shadow\);/);
  assert.match(block, /\.cm-band-icon:not\(\[data-icon="image"\]\) \{ background-color: var\(--cm-band-tile\); \}/);
  assert.match(rule('.cm-card[data-cm-size="lead"] .cm-band-icon'), /--cm-band-icon: 80px;/);
  assert.match(block, /\.cm-card-body\[data-cm-bare\] \.cm-card-id \{ padding-top: 10px; \}/);
  assert.match(block, /--cm-small: 12px;\s*--cm-small-line: 17px;/);
  // A wrapped line never starts with the dot: each part's dot is before it, and the line's start is cut off.
  assert.match(rule('.cm-week-in'), /flex-wrap: wrap;\s*margin-inline-start: -14px;/);
  assert.match(rule('.cm-week-in > span::before'), /content: "\\00B7" \/ "";[\s\S]*inset-inline-start: 5px;/);
  assert.match(rule('.cm-week-live'), /font-weight: 600;\s*color: var\(--cm-link\);/);
  // Words at every width: no glyph line to switch to on a phone.
  assert.doesNotMatch(block, /cm-week-glyph|cm-week-words|cm-week-sr/);
  // The compact card: a 44px icon on a dark hairline, the head centred, 16px round it, 14px from the
  // icon to the words, 5px between the lines, its small words 13px on 18px.
  assert.match(block, /\.cm-card\[data-cm-size="compact"\] \{ padding: 16px; \}/);
  assert.match(rule('.cm-card[data-cm-size="compact"] .cm-card-icon'), /width: 44px;\s*height: 44px;\s*border-radius: 11px;\s*box-shadow: 0 0 0 1px var\(--cm-icon-edge\);/);
  assert.match(block, /\.cm-card\[data-cm-size="compact"\] \.cm-card-head \{ align-items: center; gap: 14px; \}/);
  assert.match(block, /\.cm-card\[data-cm-size="compact"\] \.cm-card-id \{ gap: 5px; padding-top: 0; \}/);
  assert.match(block, /\.cm-card\[data-cm-size="compact"\] :is\(\.cm-card-members, \.cm-card-live\) \{ font-size: 13px; line-height: 18px; \}/);
  // Its first line wraps between its two facts, never inside one; what went live is the link's blue, with no fill.
  assert.match(block, /\.cm-card\[data-cm-size="compact"\] \.cm-card-members \{ white-space: normal; \}/);
  assert.match(rule('.cm-card-fact'), /display: inline-block;\s*max-width: 100%;\s*overflow: hidden;\s*text-overflow: ellipsis;\s*white-space: nowrap;/);
  const live = rule('.cm-card-live');
  assert.match(live, /gap: 5px;[\s\S]*font-weight: 600;[\s\S]*color: var\(--cm-link\);/);
  assert.doesNotMatch(live, /background/, 'no filled pill');
  assert.match(rule('.cm-card-live-tick'), /width: 14px;\s*height: 14px;/);
  // No blur anywhere on it, and no stock palette.
  assert.doesNotMatch(block, /blur\(|backdrop-filter|gray-|indigo-/);
});

test('every place draws the same card from its own tokens: the standard look, the brand look and the visitor page', () => {
  const tokenRule = (selector) => {
    const at = css.indexOf(`${selector} {\n  --cm-bg:`);
    assert.ok(at >= 0, `${selector} sets the card's tokens`);
    return css.slice(at, css.indexOf('}', at));
  };
  assert.match(tokenRule('html:not([data-skin])'), /--cm-bg: var\(--wip-card-bg\);[\s\S]*--cm-edge-lift: inset 0 0 0 1px var\(--wip-card-line\), /);
  const brand = tokenRule('html[data-skin="brand"]:is(:not(.dark):not([data-app-tone="dark"]), .dark:not([data-app-tone="light"]))');
  assert.match(brand, /--cm-radius: 18px;[\s\S]*--cm-small: 13px;\s*--cm-small-line: 18px;/);
  assert.match(tokenRule('#auth-landing-screen [data-guest-discover]'), /--cm-bg: var\(--site-panel\);\s*--cm-radius: 14px;/);
  // No look restyles the card's parts by hand: only tokens, and the edge, the
  // votes and the visitor page's outline and serif name.
  for (const part of ['.cm-card-pic', '.cm-card-icon', '.cm-card-week', '.cm-card-desc']) {
    const outside = css.replace(block, '').split(part).length - 1;
    assert.equal(outside, 0, `${part} is drawn only by the card's own block`);
  }
  // Every big card says this week in words, wherever it is.
  assert.doesNotMatch(css, /cm-week-glyph/);
});

// Request #7165, point 5: a card loaded its community's whole picture, up to
// 1 MB, for a slot about 110px wide on a phone. A stored picture is asked for
// at the card's size; any other address is drawn as it came.
test('a stored picture is asked for at the card\'s size', () => {
  const light = `/app-illustrations/${'a'.repeat(32)}`;
  const dark = `/app-illustrations/${'b'.repeat(32)}`;
  const html = draw('CommunityCardContent', { community: { ...TIDE, pictureUrl: light, pictureDarkUrl: dark } });
  assert.ok(html.includes(`<img src="${light}?w=512"`), 'the picture');
  assert.ok(html.includes(`<img src="${dark}?w=512"`), 'and its dark twin');
  const src = read(CARD);
  assert.match(src, /window\.innerWidth >= 768 \? 1024 : 512/, 'a wide screen takes the next size up');
});
