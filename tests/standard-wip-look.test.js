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
  // A project's hub has no Topics card under the look (asked 18 Nov 2026).
  'html:not([data-skin]) #dev-workshop [data-ws-hub-topics]',
  // A board card's category tag shows in Advanced mode only (asked 18 Nov 2026).
  'html:not([data-skin])[data-interface-mode="basic"] #dev-kanban [data-attr-field="category"]',
  // The Workshop's door opens the board under the look, so the board has no "‹ All items" line of its own.
  'html:not([data-skin]) #dev-workshop .dev-ws[data-ws-tab="all"] .dev-ws-pagehead',
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
const MENU_HIDES = [
  // With the sidebar open, Homeroom's logo is the panel's brand, so the top bar does not repeat it (asked 19 Nov 2026).
  'html:not([data-skin]) body:has(> #platform-tabs:not(.hidden):not(.platform-tabs-route-hidden):not(.platform-tabs-folded)) #platform-header #header-title > span:has(> span > #header-title-name > svg)',
  // The sidebar's glass sheet and the top bar's fill: the panel and the page are the ground now.
  'html:not([data-skin]) #platform-tabs::before',
  'html:not([data-skin]) body #platform-header#platform-header::before',
  // Folded, the menu is a strip of icons and logos: the fold button has the logo's line, so the brand is not drawn in the strip (the top bar says it there),
  'html:not([data-skin]) #platform-tabs.platform-tabs-folded:not(.platform-tabs-peek)::before',
  // and the words, counts, headings, pins and nested places are the open menu's (asked 20 Nov 2026).
  'html:not([data-skin]) #platform-tabs.platform-tabs-folded:not(.platform-tabs-peek) :is(.platform-tab-label, .platform-rail-name, .platform-rail-head, .platform-side-apps-head, .platform-rail-pin, .platform-rail-nest, .platform-rail-votes, .platform-tab-votes, .platform-side-app-x)',
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
      assert.ok(one.startsWith(MENU_SCOPE), `"${one}" is not scoped to the standard look and its brand drawing`);
      assert.doesNotMatch(one, /data-skin-wip|data-skin="/, `"${one}" names a look: the block is the two together`);
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
  const count = all.find((r) => r.selector === `${GIVE} .platform-tab-votes`);
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
    + '    inset-block-start: calc(var(--wip-nav-brand-top) + (var(--wip-nav-brand-tile) - var(--wip-nav-fold)) / 2);\n'
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
  assert.match(tokens[0].body, /--wip-btn-font: 'Source Serif 4',/);
  // The rule that shapes every level reads the shell's classes through :where(), so a level's own rule outranks it.
  assert.match(css.slice(start, end), /html:not\(\[data-skin\]\) :is\(button, a, label, summary, \[role="button"\]\):where\(\.bg-violet-600, \.wip-cta,[^{]*\{\s*border: 1px solid var\(--wip-btn-line\);\s*border-radius: var\(--wip-btn-radius\);\s*box-shadow: var\(--wip-btn-edge\);/);
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
