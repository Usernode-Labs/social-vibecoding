'use strict';

// A COMMUNITY'S CARD ("New, lighter", approved 20 Nov 2026;
// frontend/src/features/communities/card.tsx and app.css's block of the
// same name). The big card is a 16:9 picture (a brand background where it
// has none), the real icon standing mostly below it, the name over the
// members, two lines of what it is and this week on one line; the compact
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
  assert.match(html, /<span class="cm-week-in"><span>33 active<\/span><span class="cm-week-live">5 changes live this week<\/span><\/span>/);
  // Under 640px: two glyphs and their numbers, the words for a screen reader.
  assert.match(html, /<span class="cm-week-glyphs" aria-hidden="true"><span><svg[^>]*class="cm-week-glyph"[\s\S]*?<\/svg>33<\/span><span class="cm-week-live"><svg[^>]*class="cm-week-glyph"[\s\S]*?<\/svg>5<\/span><\/span>/);
  assert.match(html, new RegExp(`<span class="cm-week-sr sr-only"><span>${message('home:communities.activeWeek', { count: 33, formatted: '33' })}</span><span>${message('home:communities.liveThisWeek', { count: 5, formatted: '5' })}</span></span>`));
  // A picture with no dark twin is one picture.
  assert.match(draw('CommunityCardContent', { community: { ...TIDE, pictureDarkUrl: null } }), /<span class="cm-card-pic"><img src="\/app-illustrations\/light" alt="" loading="lazy" draggable="false" class="cm-card-img"\/><\/span>/);
});

test('no picture: one of the brand kit\'s six backgrounds, always the same one for the same community, the tile band\'s', () => {
  const html = draw('CommunityCardContent', { community: { ...TIDE, pictureUrl: null, pictureDarkUrl: null } });
  const scene = Number(html.match(/<span class="cm-card-pic" data-cm-scene="([1-6])"><\/span>/)[1]);
  assert.equal(scene, mod.cardScene('tide'));
  assert.equal(draw('CommunityCardContent', { community: { ...TIDE, pictureUrl: null } }).includes(`data-cm-scene="${scene}"`), true, 'stable');
  // The tile's band wears --wip-scene-<n> for communityScene n as 1→4, 2→5, 3→6, 4→1, 5→2, 6→3; the card wears the same file.
  const { communityScene } = loadTsx('frontend/src/features/home/pinned-communities.tsx');
  const FILES = ['sky', 'halftone', 'dream', 'stars', 'collage', 'stripes'];
  for (const slug of ['tide', 'garden', 'puzzlechain-6cf8ff', 'recipebot-33b169', 'a', 'zz']) {
    const tileScene = Number(css.match(new RegExp(`\\[data-home-community-scene="${communityScene(slug)}"\\] \\{ --cm-scene: var\\(--wip-scene-(\\d)\\); \\}`))[1]);
    assert.equal(mod.cardScene(slug), tileScene, `${slug}: the card's background is its tile's`);
  }
  FILES.forEach((file, i) => {
    assert.match(block, new RegExp(`\\.cm-card-pic\\[data-cm-scene="${i + 1}"\\] \\{ background-image: url\\('/brand/bg/${file}\\.webp'\\); \\}`));
    assert.match(css, new RegExp(`--wip-scene-${i + 1}: url\\('/brand/bg/${file}\\.webp'\\);`), 'the same numbering as the tile\'s');
  });
  // A picture that does not load falls back to it (the component's own state).
  assert.match(read(CARD), /onError=\{\(\) => setFailed\(true\)\}/);
});

test('an emoji icon, one member, no sentence and a quiet week: each says what it has and nothing more', () => {
  const html = draw('CommunityCardContent', {
    community: { slug: 'oath', name: 'Oath of Ember', iconUrl: null, iconEmoji: '🔥', members: 1, description: '  ', activeWeek: 0, liveWeek: 0 },
  });
  assert.match(html, /<span class="cm-card-icon" data-icon="emoji" aria-hidden="true">/);
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

test('the card\'s measures: a 16:9 picture, a 56px icon 14px over its edge, 15px names over 12px words, this week 12px under them', () => {
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
  assert.match(rule('.cm-card-week'), /overflow: hidden;\s*margin-top: 12px;/);
  assert.match(block, /--cm-small: 12px;\s*--cm-small-line: 17px;/);
  // A wrapped line never starts with the dot: each part's dot is before it, and the line's start is cut off.
  assert.match(rule('.cm-week-in'), /flex-wrap: wrap;\s*margin-inline-start: -14px;/);
  assert.match(rule('.cm-week-in > span::before'), /content: "\\00B7" \/ "";[\s\S]*inset-inline-start: 5px;/);
  assert.match(rule('.cm-week-live'), /font-weight: 600;\s*color: var\(--cm-link\);/);
  // Under 640px the glyphs, always one line.
  assert.match(block, /@media \(max-width: 639\.98px\) \{\s*\.cm-card \.cm-week-words \{ display: none; \}\s*\.cm-card \.cm-week-glyphs \{ display: flex; \}\s*\}/);
  assert.match(block, /@media \(min-width: 640px\) \{\s*\.cm-week-sr \{ display: none; \}\s*\}/);
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
  // Under 640px every big card says this week with its two glyphs, wherever it is.
  assert.match(block, /\.cm-card \.cm-week-glyphs \{ display: flex; \}/);
});
