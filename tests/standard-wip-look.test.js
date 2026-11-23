// Standard (WIP): the standard look with the changes still being tried on it
// (frontend/src/lib/skin.ts 'wip'). Three rules keep it the standard look and
// keep its drawing in one system; app.css's "STANDARD (WIP)" block states
// them and this file holds them.
//
//   1. It is not a copy. The head sets `data-skin-wip` and no `data-skin`, so
//      every screen is the standard one and a feature added to Standard is
//      under this look too.
//   2. Every value in its block is a token: colours are written once, in the
//      block's first rule, and nowhere after it.
//   3. Nothing of the standard look is hidden under it except what WIP_HIDES
//      lists, each a decision somebody made.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

/** What Standard (WIP) deliberately does not display, by selector. */
const WIP_HIDES = [
  // Home has no Pinned communities section under the look.
  'html:not([data-skin]) #home-communities-section',
  // A pinned project's tile has no description under the look (asked 19 Nov 2026).
  'html:not([data-skin]) #app-list .app-card-desc',
  // Under 1024px a project's tile is its icon and name alone.
  'html:not([data-skin]) #app-list .app-card-people',
  // On a phone New project is the grid's last tile, not a button on the search row that waits under the header (phone review, 23 Nov 2026).
  'html:not([data-skin]) #home-search-bar #home-new-project-top',
  // While words are in the Communities page's search, New community gives the field its place, as New project does on Home (phone review, 23 Nov 2026).
  'html:not([data-skin]) #communities-screen .communities-top:has(#communities-search-input:not(:placeholder-shown)) > #communities-new-top',
  // So it is beside the open sidebar up to 1280px, where the tile stays stacked: as a row its name had about 75px.
  'html:not([data-skin]) body:has(> #platform-tabs:not(.hidden):not(.platform-tabs-route-hidden):not(.platform-tabs-folded)) #app-list .app-card-people',
  // A project's hub has no Topics card under the look (asked 18 Nov 2026).
  'html:not([data-skin]) #dev-workshop [data-ws-hub-topics]',
  // A board card's category tag shows in Advanced mode only (asked 18 Nov 2026).
  'html:not([data-skin])[data-interface-mode="basic"] #dev-kanban [data-attr-field="category"]',
  // The Workshop's door opens the board under the look, so the board has no "‹ All items" line of its own.
  // Under this look alone: the standard look's door opens the overview, and its board keeps the line (20 Nov 2026).
  'html[data-skin-wip] #dev-workshop .dev-ws[data-ws-tab="all"] .dev-ws-pagehead',
  // For you's label heads the vote line alone on the hub, so it goes when there is no vote line.
  'html:not([data-skin]) #dev-workshop [data-ws-hub-for-you]:not(:has(> .dev-ws-foryou > :is(.dev-ws-week-note, [data-ws-hub-needs]))) > :first-child',
  // The end of a run shows a picture of the brand's where the little pile, or the tick, was (20 Nov 2026).
  'html:not([data-skin]) #dev-workshop .dev-ws[data-ws-tab="needs"] .rf-end-alone > :is(.rf-end-stack, .rf-end-mark)',
  // Needs you does not carry the project's paused-changes notice: voting goes on (20 Nov 2026).
  'html:not([data-skin]) #dev-forum-scroll:has(> #dev-body > #dev-workshop > .dev-ws[data-ws-tab="needs"]) > #dev-code-pause-notice',
  // From 1280px a project's Needs you shows what a change does beside it: no arrow to open it, no dimming behind it (20 Nov 2026).
  'html:not([data-skin]) #dev-workshop .rf-page-wrap[data-rf-beside] .rf-desc-dim',
  'html:not([data-skin]) #dev-workshop .rf-page-wrap[data-rf-beside] .rf-bar-toggle',
  // And the short claim over the picture: the full text is beside it, so it is said once.
  'html:not([data-skin]) #dev-workshop .dev-ws[data-ws-tab="needs"] .rf-page-wrap[data-rf-beside] .rf-claim-row',
  // Messages' empty pane holds the guide from 768px: its own heading and line give way to the guide's.
  'html:not([data-skin]) .messages-layout.messages-list-page > .messages-thread-pane.messages-no-selection > :is(h2, p)',
  // The Workshop's figures are four cards, each with a mark: the mark says what the label's dot said (asked 23 Nov 2026).
  'html:not([data-skin]) #dev-workshop .dev-ws[data-ws-tab="workshop"] > .dev-ws-tabbody > [data-ws-dashboard] .dev-ws-dash-dot',
  // Beside the open sidebar, on Homeroom's own pages, the bar shows the place alone: the panel's brand is the community's name already.
  'html:not([data-skin]) body:has(> #platform-tabs:not(.hidden):not(.platform-tabs-route-hidden):not(.platform-tabs-folded)) #platform-header #header-title > span:has(> span > #header-title-name > svg):has(.header-place-name) > #header-app-tile, html:not([data-skin]) body:has(> #platform-tabs:not(.hidden):not(.platform-tabs-route-hidden):not(.platform-tabs-folded)) #platform-header #header-title > span:has(.header-place-name) > span > #header-title-name:has(> svg)',
  // A request's page has no title of its own while the top bar names the place.
  'html:not([data-skin]):not(.in-side-panel) body:has(#platform-header .header-place-name) #app-view > #app-content > .dc-lift-strip:not(:has(> .gc-tab-body > .gc-spec-side-panel-open)) > .dev-thread-place-title',
  // The project's preview is a card beside the hero from 1024px; narrower, the hero keeps the picture at its side (20 Nov 2026).
  'html:not([data-skin]) #dev-workshop .wip-hero-preview',
  // And where the card is there, the hero's own tilted copy of the picture is not.
  'html:not([data-skin]) #dev-workshop .dev-ws-hero-summary[data-has-preview] .wip-hero-art-pic',
  // A pinned app's tile does not say when it was last opened under the look: its tiles say less (#4025).
  'html:not([data-skin]) #app-list .app-card-opened',
];

/**
 * The left menu and the top bar were drawn for this look first and are the
 * standard look's too since 20 Nov 2026: their rules moved to a block of
 * their own, after this look's, scoped to the two together
 * (html:not([data-skin])). The same rules hold there: every value a token,
 * declared once, and nothing hidden but what MENU_HIDES lists.
 */
const MENU_SCOPE = 'html:not([data-skin])';
// The bar's page-ground layer (asked 23 Nov 2026) paints the look's own page
// colour under Standard (WIP), where the page and its frame are one ground;
// the standard look reads its wallpaper instead. So these two rules
// of the menu's block name that look on purpose, and the foot test holds them.
const WIP_LAYER = /^html\[data-skin-wip\]\[data-wip-tokens\] body:has\(#(?:home|communities)-screen:not\(\.hidden\)\) #platform-header#platform-header::before$/;
const MENU_HIDES = [
  // With the sidebar open, Homeroom's logo is the panel's brand, so the top bar does not repeat it (asked 19 Nov 2026).
  'html:not([data-skin]) body:has(> #platform-tabs:not(.hidden):not(.platform-tabs-route-hidden):not(.platform-tabs-folded)) #platform-header #header-title > span:has(> span > #header-title-name > svg)',
  // The sidebar's glass sheet and the top bar's fill: the panel and the page are the ground now.
  'html:not([data-skin]) #platform-tabs::before',
  'html:not([data-skin]) body #platform-header#platform-header::before',
  // Folded, the menu is a strip of icons and logos: the fold button has the logo's line, so the brand is not drawn in the strip (the top bar says it there),
  'html:not([data-skin]) #platform-tabs.platform-tabs-folded:not(.platform-tabs-peek)::before',
  // and the words, headings, pins and nested places are the open menu's (asked 20 Nov 2026); the counts on the
  // places stay, on their glyphs' corners (phone review #81, 23 Nov 2026).
  'html:not([data-skin]) #platform-tabs.platform-tabs-folded:not(.platform-tabs-peek) :is(.platform-tab-label, .platform-rail-name, .platform-rail-head, .platform-side-apps-head, .platform-rail-pin, .platform-rail-nest, .platform-rail-votes, .platform-side-app-x)',
  // On a phone's bar the lit tab is its own sun pill, so the sliding marker is not drawn as well (phone review #106).
  'html:not([data-skin]):not([data-side-strip]) #platform-tabs .platform-tabs-marker',
];

function menuBlock() {
  const css = read('public', 'css', 'app.css');
  const start = css.indexOf('── THE LEFT MENU AND THE TOP BAR');
  const end = css.indexOf('END OF THE LEFT MENU AND THE TOP BAR.');
  assert.ok(start > 0 && end > start, 'app.css has the menu and top bar block, start to end');
  assert.ok(start > css.indexOf('END OF STANDARD (WIP).'), 'after the look\'s own block, which it is no part of');
  return css.slice(css.indexOf('*/', start) + 2, css.lastIndexOf('/*', end)).replace(/\/\*[\s\S]*?\*\//g, '');
}

function wipBlock() {
  const css = read('public', 'css', 'app.css');
  const start = css.indexOf('STANDARD (WIP): the standard look');
  const end = css.indexOf('END OF STANDARD (WIP).');
  assert.ok(start > 0 && end > start, 'app.css has the Standard (WIP) block, start to end');
  // From the end of the block's own opening comment to the start of the next block's.
  const from = css.indexOf('*/', start) + 2;
  const to = css.lastIndexOf('/*', end);
  return css.slice(from, to).replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every `selector { body }` of the block, media queries flattened. */
function rules(block) {
  const out = [];
  const flat = block.replace(/@media[^{]*\{/g, '').replace(/\}\s*\}/g, '}');
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] });
  }
  return out;
}

/** A selector list's members: split on the commas outside every bracket. */
function topLevel(selector) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) { out.push(selector.slice(from, i)); from = i + 1; }
  }
  out.push(selector.slice(from));
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Arithmetic on the menu's tokens, so a rule's measures can be held as what
 * they come to, with the tokens as they are and with others (`given`, in px).
 */
function menuMath(all) {
  const tokens = all.find((r) => r.selector === MENU_SCOPE && /--wip-nav-row-h:/.test(r.body)).body;
  const decl = (body, prop) => {
    const m = body.match(new RegExp(`(?:^|[;{\\s])${prop}:\\s*([^;]+);`));
    assert.ok(m, `it sets ${prop}`);
    return m[1].trim();
  };
  const parts = (value) => {
    const out = [];
    let depth = 0;
    let from = 0;
    for (let i = 0; i <= value.length; i += 1) {
      const ch = value[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if ((ch === ' ' || ch === undefined) && depth === 0) { if (i > from) out.push(value.slice(from, i)); from = i + 1; }
    }
    return out;
  };
  const token = (name, given) => {
    if (given && name in given) return given[name];
    const m = tokens.match(new RegExp(`${name}:\\s*([0-9.]+)(px|rem);`));
    assert.ok(m, `${name} is a length in the token rule`);
    return Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
  };
  const px = (expr, given) => {
    const js = expr.replace(/var\((--wip-nav-[a-z0-9-]+)\)/g, (_, name) => `(${token(name, given)})`).replace(/calc\(/g, '(').replace(/(\d)px/g, '$1');
    assert.match(js, /^[-+*/(). 0-9]+$/, `${expr} is arithmetic on the menu's tokens`);
    return Function(`return (${js});`)();
  };
  return { decl, parts, token, px };
}

test('it is the standard look: the head sets data-skin-wip and no data-skin', () => {
  const head = read('frontend', 'src', 'head.html');
  assert.match(head, /if \(skin === 'wip'\) root\.setAttribute\('data-skin-wip', ''\);/);
  assert.match(head, /if \(skin !== 'standard' && skin !== 'wip'\) \{\s*root\.setAttribute\('data-skin', skin\);/,
    'no look\'s rules (html[data-skin] …) apply under it');
  const skin = require('./lib/render-tsx').loadTsx('frontend/src/lib/skin.ts');
  assert.equal(skin.isFrameSkin('wip'), false, 'it keeps the standard pages, not the frame\'s');
});

test('every rule of its block is scoped to the look or is a component of its kit', () => {
  for (const { selector } of rules(wipBlock())) {
    for (const one of topLevel(selector)) {
      // Home's rules are the standard look's too since 20 Nov 2026 (html:not([data-skin]): the two looks, and no other).
      assert.match(one, /data-skin-wip|^html:not\(\[data-skin\]\)|^\.wip-|^\.app-card-(desc|people)$/, `"${one}" would restyle another look`);
    }
  }
});

test('colours are written once, as tokens in the block\'s first rule', () => {
  const all = rules(wipBlock());
  // The token rules: the look's own (the config called Current) and each other config's, in light and dark.
  const tokens = all.filter((r) => /^html(\[data-skin-wip\]|:not\(\[data-skin\]\))(\[data-wip-tokens="[a-z0-9]+"\])?(\.dark)?$/.test(r.selector) && /--(wip|lit)-/.test(r.body));
  assert.ok(tokens.length >= 1, 'the block declares its tokens');
  const declared = new Set();
  for (const r of tokens) for (const m of r.body.matchAll(/(--wip-[a-z0-9-]+)\s*:/g)) declared.add(m[1]);
  for (const r of all) {
    if (tokens.includes(r)) continue;
    // The filled action's inner edge is the one literal: a white hairline on its own gradient.
    const body = r.selector === '.wip-cta' ? r.body.replace(/inset 0 0 0 1px rgb\(255 255 255 \/ 0\.2\)/, '') : r.body;
    assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, `${r.selector} writes a colour of its own; make it a --wip-* token`);
    for (const m of r.body.matchAll(/var\((--wip-[a-z0-9-]+)/g)) {
      assert.ok(declared.has(m[1]), `${m[1]} (used by ${r.selector}) is declared in the block's first rule`);
    }
  }
});

test('the menu and the top bar: one block for the standard look and this one, every value a token', () => {
  const all = rules(menuBlock());
  assert.ok(all.length > 30, 'the block holds the menu\'s rules');
  for (const { selector } of all) {
    for (const one of topLevel(selector)) {
      assert.ok(one.startsWith(MENU_SCOPE) || WIP_LAYER.test(one), `"${one}" is not scoped to the standard look and its brand drawing`);
      assert.ok(WIP_LAYER.test(one) || !/data-skin-wip|data-skin="/.test(one), `"${one}" names a look: the block is the two together`);
    }
  }
  // Colours are written in the token rules alone (light, then dark), and every token a rule reads is declared there.
  const tokens = all.filter((r) => /^html:not\(\[data-skin\]\)(\.dark)?$/.test(r.selector) && /--wip-nav-/.test(r.body));
  assert.equal(tokens.length, 2, 'one rule in light and one in dark');
  const declared = new Set();
  for (const r of tokens) for (const m of r.body.matchAll(/(--wip-nav-[a-z0-9-]+)\s*:/g)) declared.add(m[1]);
  for (const r of all) {
    if (tokens.includes(r)) continue;
    assert.doesNotMatch(r.body, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, `${r.selector} writes a colour of its own; make it a --wip-nav-* token`);
    // The page's own colour is Standard (WIP)'s token, declared in that block; it is not the menu's.
    if (WIP_LAYER.test(r.selector)) continue;
    for (const m of r.body.matchAll(/var\((--wip-[a-z0-9-]+)/g)) {
      assert.ok(declared.has(m[1]), `${m[1]} (used by ${r.selector}) is declared in the block's token rule`);
    }
  }
  // The standard look has none of the brand kit's own tokens, so the block's token rules read the shell's only.
  for (const r of tokens) assert.doesNotMatch(r.body, /var\(--wip-(?!nav-)/, 'a token here points at the shell, never at the brand kit');
  // The menu's colours are the brand kit's in both looks (asked 20 Nov 2026): its sky, and the sun for the place you are on.
  assert.match(tokens[0].body, /--wip-nav-bg: #3c7bd8;[\s\S]*--wip-nav-on-bg: #ffee6f;\s*[^\n]*\n\s*--wip-nav-on-ink: #121a0e;/);
  assert.match(tokens[1].body, /--wip-nav-bg: #122a52;/);
  // The brand kit's block only points the page-side tokens at its own values.
  assert.match(wipBlock(), /html\[data-skin-wip\]\[data-wip-tokens="brand"\] \{\s*--wip-nav-font: var\(--wip-font\);[^}]*--wip-nav-bar-ink: var\(--wip-ink\);/);
  assert.doesNotMatch(wipBlock(), /--wip-nav-bg:/, 'the panel\'s colour is written once, in the menu\'s block');
  // Nothing of the old menu and bar is hidden but what MENU_HIDES lists.
  const hidden = all.filter((r) => /display:\s*none|visibility:\s*hidden|content:\s*none/.test(r.body)).map((r) => r.selector);
  assert.deepEqual(hidden.sort(), [...MENU_HIDES].sort());
  // A folded sidebar opens from its arrow alone, in both.
  assert.match(read('frontend', 'src', 'features', 'nav', 'rail-peek.ts'),
    /export function enterPeek\(\): void \{\s*clearPeekTimer\(\);[^}]*!document\.documentElement\?\.hasAttribute\('data-skin'\)\) return;/);
});

test('the top bar has a foot: a hairline from the menu\'s edge to the window\'s, on every page (20 Nov 2026)', () => {
  const all = rules(menuBlock());
  const line = all.find((r) => r.selector === `${MENU_SCOPE} body #platform-header#platform-header::after`);
  assert.ok(line, 'the top bar ends in a line');
  assert.match(line.body, /content: "";/);
  assert.match(line.body, /position: absolute;/, 'on the bar itself, which is the positioned box');
  assert.match(line.body, /inset-block-end: 0\.5rem;/, 'at the page\'s top edge: the bar\'s -mb-2 overlap (#7048)');
  assert.match(line.body, /inset-inline-start: var\(--platform-rail-w, 0px\);/, 'from the menu\'s edge, open or folded to its strip');
  assert.match(line.body, /inset-inline-end: 0;/, 'to the window\'s');
  assert.match(line.body, /height: 1px;/);
  assert.match(line.body, /background: var\(--wip-nav-bar-line\);/, 'in the bar\'s own line');
  assert.match(line.body, /pointer-events: none;/);
  // Not scoped away from a project's page: the bar is the frame's on every page.
  assert.doesNotMatch(line.selector, /data-community-tint/);
  // From 768px, where the bar sits beside a sidebar: it is in the bar's own block of that query.
  const css = read('public', 'css', 'app.css');
  const at = css.indexOf('THE BAR HAS A FOOT');
  assert.ok(at > 0);
  const query = css.lastIndexOf('@media', at);
  assert.equal(css.slice(query, css.indexOf('{', query)).trim(), '@media (min-width: 768px)');
  assert.ok(css.indexOf('\n}\n', query) > at, 'inside that query, not after it');

  // THE PAGE STARTS AT THE FOOT (phone review #68, 23 Nov 2026): the bar no
  // longer overlaps the page, the line stops at an iPhone Duo's column of
  // system chrome, and a project's page keeps its gutter inside the box that
  // clips it, so the clip is the line's own span.
  const flush = all.find((r) => r.selector === `${MENU_SCOPE} body #platform-header#platform-header`);
  assert.ok(flush && /margin-bottom: 0;/.test(flush.body), 'the page starts under the line');
  const strip = all.find((r) => r.selector.includes('[data-side-strip="right"] body #platform-header#platform-header::after'));
  assert.ok(strip, 'the line has a rule for the Duo\'s column');
  assert.match(strip.body, /inset-inline-end: var\(--platform-strip-w, 0px\);/, 'and ends where the column starts');
  const view = all.find((r) => r.selector.endsWith('#app-view[data-app-surface="platform"]:not(.hidden)'));
  assert.ok(view, 'a project\'s page');
  assert.match(view.body, /padding-inline: var\(--platform-rail-w, 0px\) 0;/, 'stands beside the menu with no gutter outside its clip');
  const content = all.find((r) => r.selector.endsWith('#app-view[data-app-surface="platform"] > #app-content'));
  assert.ok(content && /padding-inline: var\(--platform-gutter\);/.test(content.body), 'the gutter is inside the clip');

  // THE PAGE SCROLLS UNDER THE BAR (asked 23 Nov 2026): on Home and
  // Communities the bar paints the page's own ground again, so the search
  // field and the page's action pass behind it instead of showing through it
  // and letting the foot line be drawn across them. The line does not move.
  const UNDER = `${MENU_SCOPE} body:has(:is(#home-screen, #communities-screen):not(.hidden)) #platform-header#platform-header::before`;
  const under = all.find((r) => r.selector === UNDER);
  assert.ok(under, 'Home and Communities paint the bar\'s layer');
  assert.match(under.body, /content: "" !important;/, 'it turns the layer back on against the content-none rule above');
  assert.match(under.body, /background: var\(--home-wallpaper\);/, 'with the page\'s own wallpaper, as the body paints it');
  assert.match(under.body, /clip-path: inset\(0 0 0\.5rem calc\(var\(--platform-rail-w, 0px\) \+ var\(--wip-nav-page-radius\)\)\);/,
    'clipped past the menu\'s edge and the rounded page corner, and by the bar\'s -mb-2 at the foot');
  const rtlUnder = all.find((r) => r.selector === `${MENU_SCOPE}[dir="rtl"] body:has(:is(#home-screen, #communities-screen):not(.hidden)) #platform-header#platform-header::before`);
  assert.ok(rtlUnder, 'right to left the menu is on the right');
  assert.match(rtlUnder.body, /clip-path: inset\(0 calc\(var\(--platform-rail-w, 0px\) \+ var\(--wip-nav-page-radius\)\) 0\.5rem 0\);/,
    'so its strip is cut on the other side, and its foot by the bar\'s -mb-2');
  // Standard (WIP) makes the page and its frame one colour, so there the layer paints that colour.
  const wip = rules(wipBlock());
  const wipTokens = new Set();
  for (const r of wip) for (const m of r.body.matchAll(/(--wip-[a-z0-9-]+)\s*:/g)) wipTokens.add(m[1]);
  const wipHome = all.find((r) => WIP_LAYER.test(r.selector) && /#home-screen/.test(r.selector));
  assert.ok(wipHome, 'Home under Standard (WIP) paints its page colour');
  assert.match(wipHome.body, /background: var\(--wip-page-bg\);/);
  assert.ok(wipTokens.has('--wip-page-bg'), 'the colour is the look\'s own token');
  const wipCommunities = all.find((r) => WIP_LAYER.test(r.selector) && /#communities-screen/.test(r.selector));
  assert.ok(wipCommunities, 'Communities under Standard (WIP) paints its page colour');
  assert.match(wipCommunities.body, /background: var\(--wip-page-bg-communities\);/);
  assert.ok(wipTokens.has('--wip-page-bg-communities'), 'the colour is the look\'s own token');
  // The layer is never content of its own, so the hidden-rule list does not grow.
  assert.ok(!MENU_HIDES.includes(UNDER));
});

test('on a community\'s page the Communities tab gives way to its row', () => {
  const block = menuBlock();
  const GIVE = 'html:not([data-skin]) #platform-tabs:has(.platform-rail-community[aria-current="page"]) #platform-tab-workshop[aria-current="page"]';
  const all = rules(block);
  const row = all.find((r) => r.selector === GIVE);
  assert.ok(row, 'the tab gives up its fill while a community\'s row is current');
  assert.match(row.body, /background: transparent;/, 'the lit-row rule above would otherwise paint it');
  assert.match(row.body, /color: var\(--wip-nav-ink\);/, 'it wears an unlit row\'s ink');
  const glyph = all.find((r) => r.selector === `${GIVE} :is(.platform-tab-glyph, .platform-tab-label)`);
  assert.ok(glyph, 'the glyph and the word stop wearing the lit row\'s on-ink');
  assert.match(glyph.body, /color: inherit;/);
  const count = all.find((r) => r.selector === `${GIVE} :is(.platform-tab-votes, .platform-tab-badge)`);
  assert.ok(count, 'its count goes back to an unlit row\'s disc');
  assert.match(count.body, /background: var\(--wip-nav-count-bg\);/);
  assert.match(count.body, /color: var\(--wip-nav-count-ink\);/);
  // It is a wide display's rule and it is in this block, whose scope is what out-ranks the lit row.
  assert.ok(block.includes(`@media (min-width: 768px) {\n  ${GIVE} {`), 'the give-way rules sit in a wide-display group of the menu block');
  // The look's own lit row is still there, so the give-way rule is what makes the difference.
  assert.match(block, /html:not\(\[data-skin\]\) #platform-tabs :is\(\.platform-tab, [^{]*\)\[aria-current="page"\] \{\s*background: var\(--wip-nav-on-bg\);/);
});

test('folded, the menu is a strip of icons and logos, and a medium display starts on it', () => {
  const css = read('public', 'css', 'app.css');
  const block = menuBlock();
  const STRIP = 'html:not([data-skin]) #platform-tabs.platform-tabs-folded:not(.platform-tabs-peek)';
  const FOLDED = 'html:not([data-skin]) body:has(> #platform-tabs.platform-tabs-folded:not(.hidden):not(.platform-tabs-route-hidden))';
  // It is still drawn (the shell's own rule takes a folded rail away), at the strip's width, which the page keeps clear.
  assert.ok(block.includes(`${STRIP} { display: flex; }`));
  assert.ok(block.includes(`${FOLDED} {\n    --platform-rail-full: var(--wip-nav-mini-w);\n    --platform-rail-w: var(--wip-nav-mini-w);`));
  assert.ok(block.includes(`${FOLDED} #app-view {\n    padding-inline-start: calc(var(--platform-rail-w, 0px) + var(--platform-gutter));`));
  // The fold button heads it, so no brand is drawn in the strip (20 Nov 2026; it was Homeroom's mark), and a hairline parts the places from the communities' logos.
  assert.ok(block.includes(`${STRIP}::before { content: none; }`));
  assert.ok(block.includes(`${STRIP} :is(.platform-rail-pinned, .platform-rail-communities)::before {`));
  // The top bar starts beside the strip as it does beside the open menu, and says Homeroom there: only the open menu hides the bar's own brand.
  assert.ok(block.includes(`${FOLDED} #platform-header { padding-inline-start: calc(var(--wip-nav-mini-w) + 1rem); }`));
  assert.ok(!rules(block).some((r) => r.selector.startsWith(FOLDED) && r.selector.includes('#header-title')), 'folded, the top bar shows its own title');
  // Nothing slides away: the strip stays, so the rail's leaving slide is skipped where <html> has no data-skin.
  const slide = read('frontend', 'src', 'features', 'nav', 'rail-slide.ts');
  assert.match(slide, /const strip = !document\.documentElement\.hasAttribute\('data-skin'\);\s*if \(!open && !fromPeek && !strip\) bar\.classList\.add\('platform-tabs-leaving'\);/);
  assert.match(slide, /if \(fromPeek \|\| strip\) return;/);
  // A medium display starts on the strip, and only where a folded menu is a strip.
  const auto = read('frontend', 'src', 'features', 'nav', 'rail-auto.ts');
  assert.match(auto, /export const RAIL_MEDIUM = '\(min-width: 768px\) and \(max-width: 1023\.98px\)';/);
  assert.match(auto, /if \(document\.documentElement\.hasAttribute\('data-skin'\)\) return;/);
  assert.match(read('frontend', 'src', 'features', 'nav', 'tab-bar.tsx'), /useEffect\(\(\) => followDisplaySize\(\), \[\]\);/);
  // A phone's bar keeps the shell's height: the lit pill's inset comes out of the tab, so the resume strip is not covered.
  assert.match(css, /html:not\(\[data-skin\]\) #platform-tabs \.platform-tab \{ height: calc\(var\(--wip-nav-bar-h\) - 2 \* var\(--wip-nav-tab-inset\)\);/);
});

test('the fold button leads the logo\'s line, on the same spot open and folded, with one glyph', () => {
  const css = read('public', 'css', 'app.css');
  const block = menuBlock();
  const all = rules(block);
  const RAIL = 'html:not([data-skin]) body:has(> #platform-tabs:not(.hidden):not(.platform-tabs-route-hidden))';
  // ONE RULE PLACES IT, whatever the menu's state: its glyph in the rows' icon column, on the logo's line.
  assert.ok(block.includes(`${RAIL} #platform-header #sidebar-toggle {\n    position: absolute;\n`
    + '    inset-block-start: calc(var(--platform-safe-top, 0px) + var(--wip-nav-brand-top) + (var(--wip-nav-brand-tile) - var(--wip-nav-fold)) / 2);\n'
    + '    inset-inline-start: calc(var(--wip-nav-pad) + var(--wip-nav-row-pad) - (var(--wip-nav-fold) - var(--wip-nav-ic-size)) / 2);'));
  assert.deepEqual(all.filter((r) => r.selector.includes('#sidebar-toggle') && /folded|peek/.test(r.selector)).map((r) => r.selector), [],
    'no rule moves or repaints it for the folded menu (it jumped 240px to the top bar\'s start there)');
  // …and the strip centres its glyphs on that same column, which is what keeps the one rule true folded.
  const tokens = all.find((r) => r.selector === MENU_SCOPE && /--wip-nav-/.test(r.body));
  const px = (name) => {
    const m = tokens.body.match(new RegExp(`${name}: ([0-9.]+)px;`));
    assert.ok(m, `${name} is a length in px`);
    return Number(m[1]);
  };
  assert.equal((px('--wip-nav-mini-w') - px('--wip-nav-ic-size')) / 2, px('--wip-nav-pad') + px('--wip-nav-row-pad'),
    'the strip\'s glyphs stand where the open rows\' do');
  // The logotype starts where the rows' words do, after the button.
  assert.match(block, /html:not\(\[data-skin\]\) #platform-tabs::before \{[^}]*inset-inline-start: calc\(var\(--wip-nav-pad\) \+ var\(--wip-nav-row-pad\) \+ var\(--wip-nav-ic-size\) \+ var\(--wip-nav-row-gap\)\);/);
  // ONE GLYPH: the shell's own SidebarIcon, the same in both states, at the rows' weight; no drawing of the look's own.
  assert.doesNotMatch(css, /--wip-nav-ic-(un)?fold\b/);
  const glyph = all.find((r) => r.selector === 'html:not([data-skin]) #platform-header #sidebar-toggle > svg');
  assert.ok(glyph, 'the look styles the icon the button renders');
  assert.match(glyph.body, /stroke-width: var\(--wip-nav-fold-stroke\);/);
  assert.doesNotMatch(glyph.body, /mask|background/, 'it is the icon itself, not a mask over it');
  assert.match(tokens.body, /--wip-nav-fold-stroke: 1\.8;/);
  assert.match(tokens.body, /--wip-nav-ic-home: url\("[^"]*stroke-width='1\.8'/, 'the weight the rows\' glyphs are drawn at');
  const toggle = read('frontend', 'src', 'features', 'nav', 'sidebar-toggle.tsx');
  assert.deepEqual(toggle.match(/<[A-Za-z]*(Icon|svg)\b[^>]*>/g), ['<SidebarIcon className="w-5 h-5" />']);
});

test('the page is a sheet tucked into the menu: its corners are rounded where it meets it (20 Nov 2026)', () => {
  const all = rules(menuBlock());
  const tokens = all.find((r) => r.selector === MENU_SCOPE && /--wip-nav-page-radius:/.test(r.body));
  assert.ok(tokens, 'the corners\' radius is a token of the block');
  assert.match(tokens.body, /--wip-nav-page-radius: 20px;/);
  // The corners: a fixed layer on <body>, just past the menu's edge, while the menu is docked.
  const docked = 'body:has(> #platform-tabs:not(.hidden):not(.platform-tabs-route-hidden):not(.platform-tabs-peek)):not(:has(#platform-header.hidden))::after';
  const corners = all.find((r) => r.selector === `${MENU_SCOPE} ${docked}`);
  assert.ok(corners, 'drawn while the menu is docked, beside a running app too (its frame is a card on the page); not while it peeks over the page, nor while an app has the whole window');
  assert.match(corners.body, /position: fixed;/);
  assert.match(corners.body, /inset-inline-start: var\(--platform-rail-w, 0px\);/, 'just past the menu\'s edge, open or folded to its strip');
  assert.match(corners.body, /width: var\(--wip-nav-page-radius\);/);
  assert.match(corners.body, /pointer-events: none;/, 'it takes no pointer from the page');
  const quarter = /radial-gradient\(circle at [^,]+, transparent calc\(var\(--wip-nav-page-radius\) - 0\.5px\), var\(--wip-nav-bg\) var\(--wip-nav-page-radius\)\)/g;
  assert.equal((corners.body.match(quarter) || []).length, 2, 'two quarter circles in the menu\'s own blue: the top corner and the bottom one');
  assert.match(corners.body, /circle at 100% 100%[\s\S]*0 0 \/[\s\S]*circle at 100% 0[\s\S]*0 100% \//, 'the top corner at the top, the bottom one at the foot');
  const rtl = all.find((r) => r.selector === `${MENU_SCOPE}[dir="rtl"] ${docked}`);
  assert.ok(rtl, 'right to left the menu is on the right');
  assert.match(rtl.body, /circle at 0 100%[\s\S]*circle at 0 0/, 'so the quarter circles open the other way');
  // From 768px only, where the menu is a sidebar: a phone's is the bar at the screen's foot.
  const css = read('public', 'css', 'app.css');
  const at = css.indexOf('THE PAGE IS A SHEET TUCKED INTO THE MENU');
  assert.ok(at > 0);
  assert.match(css.slice(css.indexOf('*/', at) + 2, css.indexOf('*/', at) + 40), /^\n@media \(min-width: 768px\) \{/);
});

test('where the page scrolls under the top bar, the bar has a ground from the menu\'s edge and keeps the page\'s corner (audit, 23 Nov 2026)', () => {
  const css = read('public', 'css', 'app.css');
  const all = rules(menuBlock());
  const DOCKED = 'body:has(> #platform-tabs:not(.hidden):not(.platform-tabs-route-hidden):not(.platform-tabs-peek))';
  // A touch browser scrolls the document under the sticky bar (a project's
  // Workshop ran under the logo and the bell on a tablet), and Safari's own
  // ground covered the menu's top (its fold button was white on white).
  const ltr = all.find((r) => r.selector.startsWith(`${MENU_SCOPE}[data-browser-scroller] ${DOCKED} #platform-header,`));
  assert.ok(ltr, 'where the document scrolls, with the menu docked, the bar has a ground');
  const [, safari] = topLevel(ltr.selector);
  assert.ok(safari.startsWith(`${MENU_SCOPE}.un-ios.web-browser-chrome:not([data-community-tint]) ${DOCKED}:has(`), 'and on the screens Safari gives a ground of its own');
  // …exactly those: the screens of Safari's own ground rule, and the platform's surface of #app-view.
  const at = css.indexOf('html.un-ios.web-browser-chrome:not([data-community-tint]) body:has(:is(#home-screen');
  assert.ok(at > 0, 'Safari\'s own ground rule');
  const screens = (s) => [...new Set(s.match(/#[a-z-]+-screen\b/g))].sort();
  assert.deepEqual(screens(safari), screens(css.slice(at, css.indexOf('{', at))));
  assert.ok(safari.includes('#app-view:not(.hidden)[data-app-surface="platform"]'));
  // The page's plane from the menu's edge, so the menu still reaches the top…
  assert.match(ltr.body, /background-color: transparent;/);
  assert.match(ltr.body, /linear-gradient\(to right, transparent var\(--platform-rail-w, 0px\), var\(--dc-sheet-solid\) 0\)/);
  // …and the page's top corner at that edge, drawn as the corner layer draws it, since the bar lies over that layer.
  assert.match(ltr.body, /radial-gradient\(circle at 100% 100%, transparent calc\(var\(--wip-nav-page-radius\) - 0\.5px\), var\(--wip-nav-bg\) var\(--wip-nav-page-radius\)\),\s*linear-gradient/, 'the corner is the top layer');
  assert.match(ltr.body, /background-position: var\(--platform-rail-w, 0px\) 0, 0 0;/);
  assert.match(ltr.body, /background-size: var\(--wip-nav-page-radius\) var\(--wip-nav-page-radius\), 100% calc\(100% - 0\.5rem\);/, 'the plane ends at the line, 0.5rem above the box bottom (#7048)');
  assert.match(ltr.body, /background-repeat: no-repeat;/);
  assert.doesNotMatch(ltr.body, /radius: 0/, 'no corner is squared off');
  const rtl = all.find((r) => r.selector.startsWith(`${MENU_SCOPE}[dir="rtl"][data-browser-scroller] ${DOCKED} #platform-header,`));
  assert.ok(rtl, 'right to left the menu is on the right');
  assert.match(rtl.body, /radial-gradient\(circle at 0 100%,[\s\S]*linear-gradient\(to left, transparent var\(--platform-rail-w, 0px\), var\(--dc-sheet-solid\) 0\)/);
  assert.match(rtl.body, /background-position: right var\(--platform-rail-w, 0px\) top 0, 0 0;/);
  // The menu starts under the strips above the header, and its brand's band, the brand and the fold button under the status bar.
  const menu = all.find((r) => r.selector === `${MENU_SCOPE} #platform-tabs` && /z-index: 9;/.test(r.body));
  assert.match(menu.body, /top: var\(--browser-banner-h, 0px\);/);
  assert.match(menu.body, /padding-top: calc\(var\(--platform-safe-top, 0px\) \+ var\(--wip-nav-brand-h\)\);/);
  const brand = all.find((r) => r.selector === `${MENU_SCOPE} #platform-tabs::before` && /mask:/.test(r.body));
  assert.match(brand.body, /inset-block-start: calc\(var\(--platform-safe-top, 0px\) \+ var\(--wip-nav-brand-top\)\);/);
  // The project's pause pill stands in the bar's row from 900px; where the bar is sticky at 30 with a ground, it rises over it.
  assert.match(css, /html:not\(\[data-skin\]\)\[data-browser-scroller\] body:has\(#platform-header \.header-place-name\) #dev-forum-scroll:has\([^{]*\) > #dev-code-pause-notice \{ z-index: 31; \}/);
  assert.match(css, /html\[data-browser-scroller\] :is\(#platform-header, #landing-header\) \{\s*position: sticky;\s*top: var\(--browser-banner-h\);\s*z-index: 30;/, 'the bar it rises over');
});

test('the All items head meets the top bar where the place bar is folded (asked 23 Nov 2026, #7050)', () => {
  const css = read('public', 'css', 'app.css');
  // The place bar is folded from 768px, so its height plus the column gap
  // (`--dev-ws-head-top`, 10px) left a strip cards scrolled through above
  // the pinned head. In that same block the All items head drops it and rests
  // on the top bar's measured foot (`--ws-pin-top`), as the Hub's header does.
  assert.match(css,
    /html:not\(\[data-skin\]\) body:has\(#platform-header \.header-place-name\) #dev-workshop \.dev-ws\[data-ws-tab="all"\] \.dev-ws-pane-head \{\s*top: var\(--ws-pin-top, 0px\);\s*\}/);
  const fold = css.indexOf('body:has(#platform-header .header-place-name) #dev-workshop .dev-ws > .dev-ws-placebar');
  const head = css.indexOf('#dev-workshop .dev-ws[data-ws-tab="all"] .dev-ws-pane-head');
  assert.ok(fold > 0 && head > fold, 'it goes in the 768px block that folds the bar, so it applies exactly when the bar is gone');
  // The base rule keeps the measured gap for every other look and tab.
  assert.match(css, /#dev-workshop \.dev-ws-pane-head \{[^}]*top: calc\(var\(--ws-pin-top, 0px\) \+ var\(--dev-ws-head-top, 0px\)\)/);
});

test('open, Settings is a square at the end of You\'s row, centred on its line, its glyph in the middle', () => {
  const block = menuBlock();
  const all = rules(block);
  const cogRule = (r) => /\.platform-rail-settings(?!-)/.test(r.selector);
  // It is not a row. With a row's height and start padding it stood 5px above
  // You and its glyph sat off centre, so its hover and lit fill poked out over
  // the row's corner (20 Nov 2026).
  const row = all.find((r) => /min-height: var\(--wip-nav-row-h\);/.test(r.body));
  assert.ok(row, 'the rows share one rule');
  assert.ok(!cogRule(row), 'Settings takes no row measure');
  for (const r of all.filter(cogRule)) {
    assert.doesNotMatch(r.body, /min-height:/, `${r.selector} gives it a row's height`);
    for (const m of r.body.matchAll(/padding[a-z-]*:\s*([^;]+);/g)) {
      assert.match(m[1].trim(), /^0( 0)*$/, `${r.selector} pads it, which moves its glyph off its centre`);
    }
  }
  // Unpadded, the shell's own rule for the button puts the glyph in its middle.
  const css = read('public', 'css', 'app.css');
  const desk = css.indexOf('\n  .platform-rail-settings {\n    position: relative;\n    z-index: 2;');
  assert.ok(desk > 0, 'the shell\'s rule for the button');
  assert.match(css.slice(desk, css.indexOf('}', desk)), /display: inline-flex;\s*align-items: center;\s*justify-content: center;/);
  // Its own box, every measure from the menu's tokens.
  const COG = 'html:not([data-skin]) #platform-tabs .platform-rail-settings';
  const cog = all.find((r) => r.selector === COG && /width:/.test(r.body));
  assert.ok(cog, 'Settings has a box of its own in the menu block');
  const { decl, parts, token, px } = menuMath(all);
  assert.equal(decl(cog.body, 'width'), 'var(--wip-nav-settings)');
  assert.equal(decl(cog.body, 'height'), 'var(--wip-nav-settings)');
  assert.equal(token('--wip-nav-settings'), 32, 'a 32px square');
  // The space it gives back is the menu's own space between rows.
  assert.ok(block.includes(`${MENU_SCOPE} #platform-tabs.platform-tabs { padding-inline: var(--wip-nav-pad); gap: var(--wip-nav-row-space); }`));
  // On the row's height as it is, and on a taller one: the margins follow the token.
  for (const given of [{}, { '--wip-nav-row-h': 48 }]) {
    const R = token('--wip-nav-row-h', given);
    const S = px(decl(cog.body, 'width'), given);
    const G = token('--wip-nav-row-space', given);
    const [top, foot] = parts(decl(cog.body, 'margin-block')).map((v) => px(v, given));
    const [start, end] = parts(decl(cog.body, 'margin-inline')).map((v) => px(v, given));
    assert.equal(top + S + foot + G, 0, `row ${R}px: it takes no height, so You starts on its line`);
    assert.equal(top + S / 2, R / 2, `row ${R}px: its centre is You's centre`);
    assert.equal(start, 0);
    assert.equal(end, top, `row ${R}px: the same air at the row's end as above and below it`);
    assert.equal(px(decl(cog.body, 'border-radius'), given), token('--wip-nav-row-radius') - top, 'its corner runs beside the row\'s');
  }
  // Folded, the strip still puts it on a line of its own above You.
  assert.ok(block.includes(`${MENU_SCOPE} #platform-tabs.platform-tabs-folded:not(.platform-tabs-peek) .platform-rail-settings { align-self: center; margin: 0 0 2px; }`));
});

test('open, You\'s row ends short of Settings, and on Settings only Settings is lit', () => {
  const block = menuBlock();
  const all = rules(block);
  const { decl, parts, px } = menuMath(all);
  // You's row ran on under Settings, so its lit, hover and focus grounds lay
  // under the button; and on Settings, which lights You's tab too, two things
  // were lit (20 Nov 2026).
  const OPEN = `${MENU_SCOPE} #platform-tabs:not(.platform-tabs-folded)`;
  const me = all.find((r) => r.selector === `${OPEN} #platform-tab-me`);
  assert.ok(me, 'the open menu ends You\'s row before Settings');
  const cog = all.find((r) => r.selector === `${MENU_SCOPE} #platform-tabs .platform-rail-settings` && /width:/.test(r.body));
  assert.ok(cog, 'Settings\' own box');
  // Both are measured in from the row's end: Settings' box starts its width and
  // its end margin in, and You's ground stops at its own end margin. Between
  // them is the menu's space between rows, as the tokens are and as they might be.
  for (const given of [{}, { '--wip-nav-row-h': 48 }, { '--wip-nav-settings': 28 }, { '--wip-nav-row-space': 4 }]) {
    const youEnd = px(decl(me.body, 'margin-inline-end'), given);
    const width = px(decl(cog.body, 'width'), given);
    const [start, cogEnd] = parts(decl(cog.body, 'margin-inline')).map((v) => px(v, given));
    assert.equal(start, 0);
    assert.equal(youEnd - (width + cogEnd), px('var(--wip-nav-row-space)', given),
      `${JSON.stringify(given)}: the space between rows parts You's ground from Settings, and no more is left unpressable`);
  }
  // The open menu's rule, beside Settings' box; the folded strip keeps its own.
  const at = block.indexOf(`${OPEN} #platform-tab-me {`);
  const group = block.lastIndexOf('@media (min-width: 768px) {', at);
  assert.ok(group > 0 && block.indexOf('\n}', group) > at, 'a wide display\'s rule');
  assert.ok(group < block.indexOf(`${MENU_SCOPE} #platform-tabs .platform-rail-settings {\n    width:`), 'in the group that draws Settings\' box');
  assert.ok(block.includes(`${MENU_SCOPE} #platform-tabs.platform-tabs-folded:not(.platform-tabs-peek) #platform-tab-me { padding-inline-end: 0; }`));

  // On Settings, You's tab keeps `aria-current` (it is Settings' section), and
  // its row steps back to rest: no ground, a resting row's ink and weight.
  // Open or folded (phone review #80): the folded strip stacks Settings'
  // square over You's tile, and both were lit.
  const GIVE = `${MENU_SCOPE} #platform-tabs:has(> .platform-rail-settings[aria-current="page"]) #platform-tab-me[aria-current="page"]`;
  const rest = all.find((r) => r.selector === GIVE);
  assert.ok(rest, 'You\'s row gives up its light while Settings is current');
  assert.equal(decl(rest.body, 'background'), 'transparent', 'the lit-row rule would otherwise paint it');
  assert.equal(decl(rest.body, 'font-weight'), '600');
  assert.match(block, /:is\(\.platform-tab, \.platform-rail-community\) \{ min-height: var\(--wip-nav-row-h\);[^}]*font-weight: 600; \}/, 'a resting row\'s weight');
  assert.equal(decl(rest.body, 'color'), 'var(--text-primary)');
  assert.match(read('public', 'css', 'app.css'), /\n {2}\.platform-tab \{\n {4}flex: none;\n {4}flex-direction: row;[^}]*color: var\(--text-primary\);/,
    'the ink the shell\'s own row rule gives a resting row');
  assert.match(all.find((r) => r.selector === `${MENU_SCOPE} #platform-tabs` && /--text-primary:/.test(r.body)).body, /--text-primary: var\(--wip-nav-ink-strong\);/);
  const words = all.find((r) => r.selector === `${GIVE} :is(.platform-tab-glyph, .platform-tab-label)`);
  assert.ok(words, 'the glyph and the word stop wearing the lit row\'s on-ink');
  assert.equal(decl(words.body, 'color'), 'inherit');
  // It answers the pointer with a resting row's ground.
  const hover = all.find((r) => r.selector === `${GIVE}:hover`);
  assert.ok(hover, 'under the pointer it is a row at rest under the pointer');
  const rowHover = all.find((r) => /\.platform-rail-settings, [^)]*\):not\(\[aria-current="page"\]\):hover$/.test(r.selector));
  assert.ok(rowHover, 'the menu\'s hover rule');
  assert.equal(decl(hover.body, 'background'), decl(rowHover.body, 'background'));
  // Settings keeps the lit row's own rule, so it is the one thing lit.
  const lit = all.find((r) => /^html:not\(\[data-skin\]\) #platform-tabs :is\(\.platform-tab, \.platform-rail-settings, .*\)\[aria-current="page"\]$/.test(r.selector) && /background:/.test(r.body));
  assert.ok(lit, 'the lit-row rule lights Settings');
  assert.equal(decl(lit.body, 'background'), 'var(--wip-nav-on-bg)');
  assert.ok(block.indexOf(GIVE) > block.indexOf(lit.selector), 'after the lit-row rule, which it out-ranks');
  // A wide display's rules, for the open menu and the folded strip alike;
  // the phone's bar has no Settings.
  assert.ok(block.includes(`@media (min-width: 768px) {\n  ${GIVE} {`), 'the give-way rules sit in a wide-display group of the menu block');
});

test('buttons: the Sticker drawing, one block for the standard look and this one, every value a token', () => {
  const css = read('public', 'css', 'app.css');
  const start = css.indexOf('── BUTTONS (20 Nov 2026)');
  const end = css.indexOf('END OF BUTTONS.');
  assert.ok(start > css.indexOf('END OF THE LEFT MENU AND THE TOP BAR.') && end > start, 'its own block, after the menu\'s');
  const all = rules(css.slice(css.indexOf('*/', start) + 2, css.lastIndexOf('/*', end)).replace(/\/\*[\s\S]*?\*\//g, ''));
  assert.ok(all.length > 15);
  for (const { selector } of all) {
    for (const one of topLevel(selector)) {
      assert.ok(one.startsWith('html:not([data-skin])'), `"${one}" is not scoped to the standard look and its brand drawing`);
      assert.match(one, /^html:not\(\[data-skin\]\)(\.dark)?$|#admin-screen \*|^html:not\(\[data-skin\]\) \.gc-vote-btn|^html:not\(\[data-skin\]\)(\.dark)? \.(rf-pair|rf-morph|rf-prev|rf-switch|platform-parked-pill)|#home-new-project-top/, `"${one}" leaves the admin console alone`);
    }
  }
  // Colours are written in the token rules alone, and every token a rule reads is declared there.
  const tokens = all.filter((r) => /^html:not\(\[data-skin\]\)(\.dark)?$/.test(r.selector) && /--wip-btn-/.test(r.body));
  assert.equal(tokens.length, 3, 'the levels in light and in dark, then the vote pair');
  const declared = new Set();
  for (const r of tokens) for (const m of r.body.matchAll(/(--wip-btn-[a-z0-9-]+)\s*:/g)) declared.add(m[1]);
  for (const r of all) {
    if (tokens.includes(r)) continue;
    assert.doesNotMatch(r.body, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, `${r.selector.slice(0, 80)} writes a colour of its own; make it a --wip-btn-* token`);
    for (const m of r.body.matchAll(/var\((--wip-[a-z0-9-]+)/g)) assert.ok(declared.has(m[1]), `${m[1]} is declared in the block's token rules`);
  }
  // The levels: the main action in the sun, the secondary in white, the destructive in red, a press onto the edge.
  assert.match(tokens[0].body, /--wip-btn-1-bg: #ffee6f;[\s\S]*--wip-btn-2-bg: #ffffff;[\s\S]*--wip-btn-bad-ink: #a3281a;/);
  assert.match(tokens[0].body, /--wip-btn-edge: 2px 2px 0 0 var\(--wip-btn-line\);/);
  // Phone review S2 (23 Nov 2026): the label is the page's typeface, set once here.
  assert.match(tokens[0].body, /--wip-btn-font: var\(--wip-font\);/);
  assert.doesNotMatch(tokens[0].body, /Source Serif/);
  // S8: in dark the hard edge is darker than the ground, never the pale outline again.
  assert.match(tokens[1].body, /--wip-btn-edge: 2px 2px 0 0 var\(--wip-btn-shade\);/);
  assert.match(tokens[1].body, /--wip-btn-shade: rgb\(0 0 0 \/ 0\.7\);/);
  // The rule that shapes every level reads the shell's classes through :where(), so a level's own rule outranks it.
  assert.match(css.slice(start, end), /html:not\(\[data-skin\]\) :is\(button, a, label, summary, \[role="button"\]\):where\(\.bg-violet-600, \.wip-cta,[^{]*\{\s*border: 1px solid var\(--wip-btn-line\);\s*border-radius: var\(--wip-btn-radius\);\s*box-shadow: var\(--wip-btn-edge\);/);
});

test('New community wears the Communities page\'s typeface, not the buttons\' serif (21 Nov 2026)', () => {
  const all = rules(wipBlock());
  // Its own rule gives it the page's font, which is Geist in this look.
  const rule = all.find((r) => r.selector === 'html:not([data-skin]) #communities-screen #communities-new-top');
  assert.ok(rule, 'the page action\'s family is a rule of the look\'s own block');
  assert.equal(rule.body.trim(), 'font-family: var(--wip-font);');
  const token = all.find((r) => /^html:not\(\[data-skin\]\)(\.dark)?$/.test(r.selector) && /--wip-font: 'Geist'/.test(r.body));
  assert.ok(token, 'the page\'s font is the one the rest of the page reads');
  // Two ids, so it outranks the BUTTONS block's shape (its classes are inside :where()).
  assert.equal((rule.selector.match(/#/g) || []).length, 2, 'it beats the class rules and the one-id page top action rule');
  // Since phone review S2 every button wears the page's typeface (the buttons'
  // own token), and the shared page top action rule names no family, so Home's
  // New project takes that one too.
  const css = read('public', 'css', 'app.css');
  const start = css.indexOf('── BUTTONS (20 Nov 2026)');
  const end = css.indexOf('END OF BUTTONS.');
  const buttons = rules(css.slice(css.indexOf('*/', start) + 2, css.lastIndexOf('/*', end)).replace(/\/\*[\s\S]*?\*\//g, ''));
  const serif = buttons.filter((r) => /^html:not\(\[data-skin\]\)(\.dark)?$/.test(r.selector) && /--wip-btn-/.test(r.body))[0];
  assert.match(serif.body, /--wip-btn-font: var\(--wip-font\);/);
  const top = buttons.find((r) => r.selector === 'html:not([data-skin]) :is(#home-new-project-top, #communities-new-top)');
  assert.ok(top, 'the page top action rule is still the buttons block\'s');
  assert.doesNotMatch(top.body, /font-family/, 'Home\'s New project reads the buttons\' face');
});

test('nothing of the standard look is hidden under it but what WIP_HIDES lists', () => {
  const hidden = rules(wipBlock())
    .filter((r) => /display:\s*none|visibility:\s*hidden/.test(r.body))
    // A kit component arranging its own parts (an icon stack a phone has no room for) hides nothing of Standard.
    .filter((r) => !topLevel(r.selector).every((one) => /^\.wip-/.test(one)))
    .map((r) => r.selector);
  assert.deepEqual(hidden.sort(), [...WIP_HIDES].sort(),
    'a section the look stops displaying is a decision: add it to WIP_HIDES with its reason');
});

test('no sheen: a pointer sends no band of light across a project\'s icon, a community\'s or the hub\'s filled action (20 Nov 2026)', () => {
  assert.doesNotMatch(read('public', 'css', 'app.css'), /--wip-sheen/, 'its colour and its time went with it');
  const all = rules(wipBlock());
  for (const { selector } of all) {
    for (const one of topLevel(selector)) {
      // Nothing is laid over an icon's tile (the sheen was ::after, the gloss before it ::before) ...
      assert.doesNotMatch(one, /\.app-icon-tile::(after|before)/, `"${one}" draws over an icon`);
      // ... or over the hub's Open app and Join.
      assert.doesNotMatch(one, /\[data-ws-community-(open-app|join)\]\)(:hover)?::(after|before)/, `"${one}" draws over the hub's filled action`);
    }
  }
  // What the pointer does there stays: a community's tint deepens a step, and nothing moves.
  assert.ok(all.some((r) => r.selector === 'html:not([data-skin]) #communities-screen #communities-body:not([data-editing]) .communities-grid > :is(a, button):hover'
    && /background-color: var\(--wip-soft-bg-on\);/.test(r.body)));
});

test('Home places what it does not name last, so a new standard section is drawn', () => {
  const block = wipBlock();
  assert.match(block, /html:not\(\[data-skin\]\) #home-screen \.home-main > \* \{ order: 4; \}/);
});

test('its pieces come from the kit, not from classes spelled in place', () => {
  const kit = read('frontend', 'src', 'features', 'home', 'wip-kit.tsx');
  for (const name of ['WipCard', 'WipCta', 'WipHeadMore']) assert.match(kit, new RegExp(`export (function|const) ${name}\\b`));
  const island = read('frontend', 'src', 'features', 'home', 'index.tsx');
  assert.match(island, /<WipCard on=\{wip\}>/);
  assert.match(island, /<WipCta id="home-new-project-top"/);
  assert.doesNotMatch(island, /bg-gradient-to-br/, 'the filled action\'s gradient is the kit\'s, from tokens');
});
