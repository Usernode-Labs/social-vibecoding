'use strict';

// The Admin console's polish pass (#7181, 26 Nov 2026): what a walk through
// every section found broken, held here so it stays fixed.
//
//  - the dashboard and its menu are drawn at every width and in dark: their
//    rules sit outside any width query and name tokens, never a colour;
//  - no control on the dashboard is dead, and nothing it used to show is
//    hidden: Platform health is on the page again, and Refresh reloads it all;
//  - a part that did not load says so instead of staying on "Loading…";
//  - a section opens at its top, and the menu keeps its place and shows the
//    row that is lit.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const css = read('public/css/app.css');
const overviewTsx = read('frontend/src/features/admin/admin-overview.tsx');
const consoleJs = read('frontend/src/features/admin/admin-console.js');

const START = '/* THE ADMIN DASHBOARD AND ITS MENU (#7181';
const END = '/* END OF THE ADMIN DASHBOARD AND ITS MENU. */';
const block = css.slice(css.indexOf(START), css.indexOf(END));

// The block's rules, as [selector, body], with the @media wrappers dropped.
function rules(text) {
  const out = [];
  const flat = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]+\{/g, '');
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push([m[1].trim(), m[2]]);
  return out;
}

test('the block exists and declares its tokens in light and in dark', () => {
  assert.ok(css.includes(START) && css.includes(END), 'the block is delimited');
  const all = rules(block);
  const light = all.find(([sel]) => sel === '#admin-screen');
  const dark = all.find(([sel]) => /html\.dark #admin-screen/.test(sel));
  assert.ok(light && dark, 'tokens for both modes');
  assert.match(dark[0], /html\[data-app-tone="dark"\] #admin-screen/, 'the dark tone counts as dark');
  for (const name of ['--adm-ink', '--adm-muted', '--adm-paper', '--adm-line', '--adm-link', '--adm-sky', '--adm-leaf', '--adm-butter', '--adm-ok-bg', '--adm-chart-fill']) {
    assert.ok(light[1].includes(`${name}:`), `${name} in light`);
    assert.ok(dark[1].includes(`${name}:`), `${name} in dark`);
  }
});

test('after the two token rules, no rule of the block names a colour', () => {
  const drawing = rules(block).slice(2);
  assert.ok(drawing.length > 60, 'the drawing is in this block');
  for (const [sel, body] of drawing) {
    assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/, `${sel} uses tokens`);
    assert.doesNotMatch(body, /Georgia|Young Serif/, `${sel} names no typeface`);
  }
});

test('the dashboard is drawn at every width: its base rules sit outside a width query', () => {
  const before = block.slice(0, block.indexOf('@media'));
  for (const sel of ['.admin-metric-grid {', '.admin-metric-card {', '.admin-dashboard-panel {', '.admin-dashboard-section-head {',
    '.admin-record-row {', '.admin-quick-actions button {', '.admin-sidebar-row {']) {
    assert.ok(before.includes(sel), `${sel} is a base rule`);
  }
  assert.match(block, /@media \(max-width: 767px\) \{[\s\S]*\.admin-metric-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/,
    'a phone draws the figures two to a row');
  assert.match(block, /#admin-root #admin-mobile-menu \{ margin-inline: -14px; \}/, 'the phone menu matches the page gutter');
  assert.doesNotMatch(css, /\.admin-metric-card\.sky \{ background: linear-gradient/, 'the first version\'s light-only tiles are gone');
});

test('the dashboard has no dead control and hides nothing it has', () => {
  assert.doesNotMatch(overviewTsx, /admin-dashboard-period|Last 30 days/, 'the period menu that changed nothing is gone');
  assert.doesNotMatch(overviewTsx, /<div hidden>\{ops\}<\/div>/, 'Platform health is not hidden');
  assert.match(overviewTsx, /<h2>Platform health<\/h2>/);
  assert.match(overviewTsx, /\{recentTables\}\s*\{ops\}/, 'and it is on the page');
  assert.match(overviewTsx, /className="admin-dashboard-refresh" onClick=\{load\} disabled=\{busy\}/, 'Refresh reloads the page\'s data');
  for (const url of ['/api/admin/overview', '/api/admin/analytics/overview', '/api/admin/moderation?status=new',
    '/api/admin/users', '/api/admin/apps-usage?days=30', '/api/admin/analytics/growth']) {
    assert.ok(overviewTsx.includes(`fetchJson('${url}')`), `${url} is read by load()`);
  }
});

test('a part that did not load says so, and never stays on Loading', () => {
  assert.match(overviewTsx, /id="admin-dashboard-error" role="alert"/);
  assert.match(overviewTsx, /Some of this page did not load: \$\{failed\.join\(', '\)\}/);
  for (const part of ['the moderation queue', 'recent members', 'recent projects', 'the weekly chart', 'platform health', 'the figures']) {
    assert.ok(overviewTsx.includes(`missing.push('${part}')`), `${part} is reported`);
  }
  assert.match(overviewTsx, /value == null \? '—'/, 'a figure that has not arrived is a dash');
});

test('icons are the console\'s own, dates read one way, and the newest accounts are the newest', () => {
  assert.doesNotMatch(overviewTsx, /[♧◇⌁⚑⚙♙▱◷◯]/, 'no text glyph stands in for an icon');
  assert.match(overviewTsx, /AdminConsole\?\.NAV_ICONS\?\.\[key\]/);
  assert.match(overviewTsx, /const DAY = \{ day: 'numeric', month: 'short', year: 'numeric' \} as const;/);
  assert.doesNotMatch(overviewTsx, /toLocaleDateString\(\)/, 'no bare numeric date');
  assert.match(overviewTsx, /Date\.parse\(right\.created_at\) \|\| 0\) - \(Date\.parse\(left\.created_at\) \|\| 0\)/,
    'sorted by when they joined, not by the order the list arrived in');
  assert.match(overviewTsx, /STATUS_TONE\[app\.status \|\| ''\] \|\| 'admin-pill'/, 'only a running project is green');
});

test('a section opens at its top, and the menu keeps its place with the lit row in view', () => {
  const set = consoleJs.slice(consoleJs.indexOf('  setSection(key, opts) {'), consoleJs.indexOf('  _teardownActiveSection() {'));
  assert.match(set, /const moved = AdminConsole\._section !== key;/);
  assert.match(set, /if \(moved && !AdminConsole\._isMobile\(\)\) AdminConsole\._restoreScroll\(\);/);
  const shell = consoleJs.slice(consoleJs.indexOf('  _renderShell() {'), consoleJs.indexOf('  _wireSectionButtons(root) {'));
  assert.match(shell, /const wasTop = was \? was\.scrollTop : 0;/);
  assert.match(shell, /menu\.scrollTop = wasTop;/);
  assert.match(shell, /row\.top < box\.top \|\| row\.bottom > box\.bottom/, 'only a row out of sight is brought in');
});

test('with room the open tabs stay on one line, and never scroll sideways', () => {
  assert.match(css, /@media \(min-width: 1200px\) \{\s*\.admin-tab-strip \{ flex-wrap: nowrap; \}/);
  assert.match(css, /\.admin-tab-strip > \[data-admin-tab\] \{ flex: 0 1 auto; min-width: 4\.25rem; \}/);
  assert.doesNotMatch(consoleJs, /overflow-x-(auto|scroll)/);
});

test('the console runs the window\'s width, and its menu folds to icons', () => {
  assert.match(css, /#admin-screen #admin-root \{ max-width: none; padding-inline: 12px; \}/, 'one small gutter');
  assert.doesNotMatch(css, /#admin-root \{ max-width: 1800px/);
  assert.match(css, /\.admin-console-layout:has\(\.admin-sidebar\.is-folded\) \{ grid-template-columns: 64px minmax\(0, 1fr\); \}/,
    'the page takes the room the folded menu gives back');
  const bar = consoleJs.slice(consoleJs.indexOf('  _topBarHtml() {'), consoleJs.indexOf('  _tabStripHtml() {'));
  assert.match(bar, /data-admin-nav-fold="" aria-expanded="\$\{folded \? 'false' : 'true'\}" aria-label="\$\{foldLabel\}"/);
  assert.match(bar, /title="\$\{label\}" class="admin-sidebar-row/, 'a folded row is named by its tooltip');
  assert.match(consoleJs, /localStorage\.setItem\(NAV_FOLDED_KEY, on \? '1' : '0'\)/, 'the choice is kept for this browser');
  assert.match(block, /\.admin-sidebar\.is-folded \[data-admin-group\]\.hidden \{ display: block !important; \}/,
    'folded, a collapsed group still shows its tools');
});

test('on a computer the header carries Homeroom\'s name and the console\'s note, not a title', () => {
  const header = read('frontend/src/features/header/platform-header.tsx');
  const note = read('frontend/src/features/admin/admin-header-note.tsx');
  assert.match(header, /<a href="#home" className="admin-header-home" aria-label=\{t\('core:header\.home'\)\} \/>/,
    'the name is a real link home');
  assert.match(css, /\.admin-header-home \{[^}]*mask: url\('\/brand\/homeroom-logotype-black\.png'\) center \/ contain no-repeat;/,
    'drawn from the logotype\'s own file');
  assert.match(header, /<HeaderTitle titleRef=\{titleRef\} \/>[\s\S]{0,260}<AdminHeaderNote \/>/, 'the note sits in the title\'s seat');
  assert.match(note, /<div className="admin-header-note" role="note">/);
  assert.match(note, /Platform-wide tools\. These are not your settings but the settings of the platform\. Be careful before changing anything\./);
  assert.match(note, /<a href="#profile" onClick=\{onExit\} className="admin-header-exit">Exit<\/a>/);
  assert.doesNotMatch(note, /components\/ui\//, 'an admin source imports no shell primitive');
  // Always in the header, shown by the sheet alone: no part of hydration.
  assert.match(css, /\.admin-header-home, \.admin-header-note \{ display: none; \}/);
  const at = css.indexOf('/* THE PLATFORM HEADER, IN THE CONSOLE, ON A COMPUTER.');
  const rulesText = css.slice(at, css.indexOf('/* END OF THE PLATFORM HEADER, IN THE CONSOLE. */'));
  assert.match(rulesText, /@media \(min-width: 768px\) \{/, 'a phone keeps its title and the band');
  assert.match(rulesText, /body:has\(#admin-screen:not\(\.hidden\)\) #platform-header #sidebar-toggle \{ display: none !important; \}/);
  assert.match(rulesText, /#admin-console-bar:not\(\.hidden\)\) #platform-header #header-title \{ display: none !important; \}/,
    'only for an admin: public mode keeps its title');
  assert.match(rulesText, /#admin-console-bar:not\(\.hidden\)\) #admin-console-bar > div \{ display: none; \}/, 'the band is not said twice');
  assert.match(rulesText, /#admin-console-bar:not\(\.hidden\)\) #platform-header #back-btn \{ display: none !important; \}/, 'no back arrow beside the name');
  assert.match(rulesText, /\.admin-header-note \{ position: absolute; inset: 0; width: fit-content; max-width: calc\(100% - 340px\); height: fit-content; margin: auto;/,
    'the note is as wide as its words and sits in the middle of the bar');
});

test('the pages opened lately are badges: small pills, the sun on the one you are on', () => {
  assert.match(block, /#admin-open-tabs \.admin-tab-strip > \[data-admin-tab\] \{ min-height: 28px; border-radius: 999px; background: var\(--adm-paper\); box-shadow: inset 0 0 0 1px var\(--adm-line\);/);
  assert.match(block, /\[data-admin-tab\]\[aria-current="page"\] \{ background: var\(--adm-sun\);/);
  assert.match(block, /> \[data-admin-tab-close\] \{ width: 20px; height: 20px;/, 'the close button stays inside the badge');
});
