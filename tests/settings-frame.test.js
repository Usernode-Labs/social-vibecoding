// Settings in the one frame, version 2 (looks v2, s56 to s73): today's
// screen laid out and dressed as the kit's page. A head ("Settings" and one
// sentence) stands above two columns: the list of sections first (360px,
// cards of kit rows, the open page lit, the kit's search field), then the
// open section (680px) under its name as a 22px sub-heading. On a phone the
// product's two levels are the kit's: the list is the page, a section its
// own page. The markup is the standard look's own, carrying stable `ui-*`
// names that draw nothing there; frontend/looks/looks.json ("wear") dresses
// them, and app.css says only the layout and what the wear cannot.
//
// Run with: node --test tests/settings-frame.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const css = read('public/css/app.css');
const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
const settings = hand.slice(hand.indexOf('SETTINGS (features/settings/index.tsx)'), hand.indexOf('MAKE, AND THE MADE SCREEN AFTER IT'));
const looks = JSON.parse(read('frontend/looks/looks.json'));
const roots = looks.wear.roots;
const ANY = 'html\\[data-skin\\]:where\\(:not\\(\\[data-skin="brand"\\]\\)\\)';
const WORN = 'html[data-skin]:where(:not([data-skin="brand"]))';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Every wearer of a root: its own, then the second wearers ("also"), each a selector of its own.
const wearers = (root) => [root.to, ...(root.also || []).map((w) => w.to)];
const section = (name) => read('frontend/src/features/settings/sections', name);

test('on a wide window the list of sections comes first at 360px, the open section after it at 680px', () => {
  assert.match(settings, new RegExp(`@media \\(min-width: 1024px\\) \\{\\s+${ANY} #settings-root \\{ max-width: 1136px; padding: 32px 32px 48px; \\}`));
  assert.match(settings, new RegExp(`${ANY} #settings-sidebar-col \\{ order: 1; flex: 0 0 360px; width: 360px; position: static; height: auto; overflow: visible; padding: 0; \\}`), 'the list is a column of the page, with no sheet of its own (it sticks: see below)');
  assert.match(settings, new RegExp(`${ANY} #settings-content-col \\{ order: 2; flex: 0 1 680px; \\}`));
  assert.match(settings, new RegExp(`${ANY} #settings-sidebar-col\\.settings-side-sheet \\{ background: none; box-shadow: none;`), 'the list\'s sheet is put away');
  assert.match(settings, new RegExp(`${ANY} #settings-section-content\\.settings-sheet \\{ margin-top: 0; margin-bottom: 0; padding: 0; background: none; box-shadow: none;[^}]*border-radius: 0; border-top: 0; \\}`), 'and the section\'s, with its top hairline and the negative margin that ran its last rows under the phone\'s tab bar');
});

test('a head stands above the two columns under a look, and the standard look never draws it', () => {
  const src = read('frontend/src/features/settings/index.tsx');
  assert.match(src, /<header className="settings-frame-head">\s*<div className="settings-frame-head-tx">\s*<h1 className="settings-frame-title">\{t\('settings:screen\.title'\)\}<\/h1>\s*<p className="settings-frame-purpose">\{t\('settings:frame\.head\.purpose'\)\}<\/p>/);
  assert.doesNotMatch(src, /isFrameSkin|useLiveSkin|useSkin/, 'the chassis is in the prerender: the same markup whatever the look');
  assert.match(css, /\n\.settings-frame-head \{ display: none; \}/, 'the standard look has no head');
  assert.equal(roots.head, undefined, 'the head is no root: as one it would take `.head .acts .btn` away from the other pages\' buttons');
  assert.deepEqual(roots.purpose, { to: '.settings-frame-purpose' });
  assert.ok(wearers(roots.title).includes('.settings-frame-title'), 'the title is a wearer of its own');
  assert.match(settings, new RegExp(`${ANY} \\.settings-frame-head \\{ display: flex; align-items: flex-start; gap: 16px; margin-bottom: 24px; \\}`), 'the kit\'s head, laid by hand');
  assert.match(settings, new RegExp(`@media \\(max-width: 1023\\.98px\\) \\{\\s+${ANY} #settings-root:has\\(#settings-section-content:not\\(\\.hidden\\)\\) > \\.settings-frame-head \\{ display: none; \\}`), 'a section opened on a phone is its own page, without the head');
  const { message } = require('./lib/platform-i18n');
  assert.equal(message('settings:frame.head.purpose'), 'Your account, your preferences and your tools.');
});

test('the open page is named at 22px, on a phone too, and no sentence of the look\'s own follows', () => {
  assert.deepEqual(roots.sub22, { to: '.settings-page-title:is(#settings-root *)' });
  assert.ok(!wearers(roots.title).some((to) => /settings-page-title/.test(to)), 'it is a sub-heading now, not the kit\'s title');
  assert.match(css, new RegExp(`${ANY} \\.settings-page-title:is\\(#settings-root \\*\\)\\{font-size:22px;font-weight:700;letter-spacing:-\\.02em\\}`));
  assert.match(settings, new RegExp(`${ANY} #settings-screen \\.settings-page-title \\{ display: block; margin: 0 0 24px;`));
  const nav = read('frontend/src/features/settings/settings-nav.tsx');
  assert.doesNotMatch(nav, /pagePurpose|PURPOSES|settings-page-purpose|isFrameSkin|useLiveSkin/);
  assert.doesNotMatch(css, /settings-page-purpose/);
  assert.doesNotMatch(read('frontend/locales/en/settings.json'), /"frame\.purpose\./, 'the nineteen sentences went with it');
});

test('the bar says where you are: You, then Settings on the list; Settings, then the page', () => {
  const nav = read('frontend/src/features/settings/settings-nav.tsx');
  assert.match(nav, /const crumb = !shown \|\| !desktop \? null : mobile \|\| !page \? \[tCore\('core:tabs\.me'\), settings\] : \[settings, page\];/);
  assert.match(nav, /useFramePage\(crumb, crumb \? pressBack : null\);/);
  assert.match(nav, /const pressBack = \(\) => \{ document\.getElementById\('back-btn'\)\?\.click\(\); \};/, 'the arrow stays the shell\'s own, whose target settings.js keeps');
  assert.match(read('frontend/src/features/settings/index.tsx'), /<SettingsFrameCrumb \/>/);
});

test('the list of sections carries the names a look dresses: search, cards of rows, labels, the count, Sign out', () => {
  const nav = read('frontend/src/features/settings/settings-nav.tsx');
  assert.match(nav, /className=\{`ui-row ui-row-sm \$\{item\.className\}`\}/, 'the row\'s own classes still come from settings.js');
  assert.match(nav, /<span className="ui-row-t min-w-0 flex-1 truncate">\{item\.label\}<\/span>/);
  assert.match(nav, /const NAV_STATUS = 'ui-row-meta shrink-0 /);
  assert.match(nav, /const MENU_STATUS = 'ui-row-meta shrink-0 /);
  assert.match(nav, /const BETA_TAG = 'ui-pill shrink-0 /);
  assert.match(nav, /const NAV_HEADING = 'ui-cap px-3 pb-1';/);
  assert.match(nav, /<div className="ui-card">\s*\{\(group\.folded \? group\.items\.filter/, 'one neutral wrapper round a group\'s rows');
  assert.match(nav, /<div className="ui-search sticky top-0 /);
  assert.match(nav, /<div className="ui-search px-1 pb-4">/);
  assert.match(read('frontend/src/features/settings/index.tsx'), /id="settings-logout"\s+className="ui-btn ui-btn-bad ui-btn-block w-full /);
  // What today's list has and the mockup omits is kept.
  for (const kept of ['data-settings-recent=""', 'data-settings-control="pin"', 'data-settings-group-fold', 'data-settings-nav-status=""', 'data-settings-nav-tag=""', 'subtitle={item.subtitle || undefined}']) {
    assert.ok(nav.includes(kept), kept);
  }
  assert.match(settings, new RegExp(`${ANY} #settings-root \\.ui-card > \\[data-settings-row\\] \\+ \\[data-settings-row\\] > \\.ui-row \\{ border-top: 1px solid var\\(--fr-line2\\); \\}`), 'a row sits in its pin wrapper, so the kit\'s line between rows is said here');
});

test('the wear map dresses Settings\' own markup, inside #settings-root and nowhere else', () => {
  const S = ':is(#settings-root *)';
  assert.ok(wearers(roots.card).includes(`:is(.ui-glist,.ui-card)${S}`), 'a wearer of its own, so Settings\' id weighs on no other page\'s card');
  assert.doesNotMatch(roots.card.to, /settings|ui-glist/);
  assert.equal(roots.row.to, `:is(.ui-lrow,.ui-row,.drawer-ver-row)${S}`);
  assert.deepEqual(roots.row.parts, {
    tx: ':is(.ui-lrow-tx,.ui-row-tx)', t: ':is(.ui-lrow-t,.ui-row-t,.drawer-ver-label)', s: ':is(.ui-lrow-s,.ui-row-s)', go: '.ui-lrow-go',
    meta: ':is(.fr-meta,.ui-row-meta,.drawer-ver-value)', on: ':is([aria-current="page"],.ui-row-on)', sm: ':is(.ui-row-sm,.settings-menu-row)', wrap: '', all: '',
  }, 'every row here is the wrapping kind (a switch\'s sentence is never cut), and the open page is the lit one');
  assert.ok(wearers(roots.cap).includes(`:is(.ui-sechead,.ui-cap)${S}`));
  assert.doesNotMatch(roots.cap.to, /settings|ui-/);
  assert.equal(roots.secnote.to, `:is(.ui-secblurb,.ui-note)${S}`);
  assert.deepEqual(roots.tog, { to: `.un-switch${S}`, parts: { on: ':checked' } });
  assert.deepEqual(roots.chk, { to: `.ui-chk${S}`, parts: { on: '.ui-chk-on', round: '' } });
  assert.deepEqual(roots.search, { to: `.ui-search${S}`, parts: { inp: '.settings-filter', flush: '' } });
  assert.match(roots.inp.to, /^:is\(\.settings-filter,\.ui-inp,:is\(input:not\(/);
  const btn = (roots.btn.also || []).find((w) => /#settings-root/.test(w.to));
  assert.ok(btn && btn.to.startsWith(':is(.ui-btn,:is(button,a,label):is(.bg-violet-600,') && btn.to.endsWith(`:not(.ui-lrow,.ui-row,[role="radio"],.ui-plain))${S}`), 'Settings\' buttons are a wearer of their own');
  assert.deepEqual(Object.keys(btn.parts).sort(), ['bad', 'block', 'line', 'quiet', 'sm'], 'with kinds of their own');
  assert.deepEqual(roots.btn.parts, { quiet: ':is(.bg-white,.bg-zinc-100)' }, 'and the other pages\' buttons keep theirs');
  assert.doesNotMatch(roots.btn.to, /settings|ui-btn/);
  assert.equal(roots.pill.to, `.ui-pill${S}`);
  assert.equal(roots.fields.to, `.ui-fields${S}`);
  // One selector for a rule that names the row twice, outranking the standard sheet's own rules.
  // (A further wearer of the row, the review stage's help rows, follows it as a selector of its own.)
  const between = css.split('\n').find((rule) => rule.startsWith(`html[data-skin] .fr-row+.fr-row,${WORN} :is(.ui-lrow,.ui-row,.drawer-ver-row):is(#settings-root *)+:is(.ui-lrow,.ui-row,.drawer-ver-row):is(#settings-root *)`));
  assert.ok(between && between.endsWith('{border-top:1px solid var(--fr-line2)}'));
  assert.ok(css.includes(`${WORN} :is(.ui-lrow,.ui-row,.drawer-ver-row):is(#settings-root *):is([aria-current="page"],.ui-row-on){background:var(--fr-lit-t)}`), 'the open page is lit');
  assert.ok(css.includes(`${WORN} .un-switch:is(#settings-root *):checked{background:var(--fr-acc);box-shadow:none}`));
  assert.ok(css.includes(`${WORN} .ui-search:is(#settings-root *) .settings-filter{background:var(--fr-surface);border-radius:999px;padding:0 16px}`));
});

test('the primitives keep their stable names', () => {
  const src = read('frontend/@/components/ui/grouped-list.tsx');
  assert.match(src, /const groupedList = cva\('ui-glist mx-4 overflow-hidden rounded-\[20px\]/);
  assert.match(src, /'ui-lrow relative flex w-full items-center gap-4 px-4 py-3\.5 text-start',/);
  assert.match(src, /<div className=\{cn\('ui-lrow-tx min-w-0 flex-1', contentClassName\)\}>/);
  assert.match(src, /'ui-lrow-t truncate text-\[0\.9375rem\] font-\[650\] leading-5 text-zinc-900 dark:text-zinc-100',/);
  assert.match(src, /cn\('ui-lrow-s mt-0\.5 truncate text-\[0\.8125rem\] leading-\[1\.125rem\] text-zinc-500 dark:text-zinc-400', subtitleClassName\)/);
  const field = read('frontend/@/components/ui/field.tsx');
  assert.match(field, /<h3 className=\{cn\('ui-sechead text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1', className\)\}>/);
  assert.match(field, /<p className=\{cn\('ui-secblurb text-xs text-zinc-500 dark:text-zinc-500 mb-3', blurbClassName\)\}>/);
});

test('a section\'s parts stack with no rule between them, and a one-part page\'s label is not drawn twice', () => {
  assert.match(settings, new RegExp(`${ANY} #settings-section-content > \\[data-settings-section\\]:not\\(\\.hidden\\) ~ \\[data-settings-section\\]:not\\(\\.hidden\\):has\\(> :not\\(\\.hidden\\)\\) \\{ margin-top: 24px; padding-top: 0; border-top: 0; \\}`));
  assert.match(settings, /\[data-settings-section="linked-accounts"\], \[data-settings-section="phones"\], \[data-settings-section="agent-files"\], \[data-settings-section="language"\], \[data-settings-section="tour"\], \[data-settings-section="guide"\], \[data-settings-section="about"\], \[data-settings-section="experimental"\], \[data-settings-section="wallet"\], \[data-settings-section="usernode"\]\) > div:first-child > \.ui-sechead:first-child \{ display: none; \}/);
  assert.match(settings, new RegExp(`${ANY} #settings-section-content \\[data-settings-section\\] \\.border-t\\.pt-6 \\{ margin-top: 24px; padding-top: 0; border-top: 0; \\}`));
});

test('a switch row in a static pane is a neutral wrapper, laid out by the stylesheet: no node is moved', () => {
  for (const [file, id] of [['dev-console.tsx', 'dev-console-always-show'], ['admin-preview.tsx', 'view-as-non-admin'], ['alerts.tsx', 'devchat-alerts-toggle']]) {
    assert.match(section(file), new RegExp(`<div className="ui-card ui-swrow">\\s*<SwitchRow id="${id}">`), file);
  }
  const exp = section('experimental.tsx');
  assert.match(exp, /<div className="ui-card">\s*<InterfaceModeControl \/>\s*<div className="ui-swrow">\s*<SwitchRow id="ai-progress-estimate">/, 'the four switches are one card');
  assert.match(exp, /<div className="ui-swrow mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">\s*<SwitchRow id="session-bridge-enabled">/);
  assert.match(exp, /<div className="ui-swrow mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">\s*<SwitchRow id="new-look-enabled">/);
  assert.match(exp, /<div id="settings-look-section" className="hidden ui-card ui-fields /);
  assert.match(settings, new RegExp(`${ANY} #settings-screen #settings-section-content \\[data-settings-section\\] \\.ui-swrow \\{ display: grid; grid-template-columns: minmax\\(0, 1fr\\) auto;`));
  assert.match(settings, new RegExp(`${ANY} #settings-root \\.ui-swrow > label \\{ display: contents; \\}`), 'the label still toggles its switch; only its box steps aside');
  assert.match(settings, new RegExp(`${ANY} #settings-screen #settings-root \\.ui-swrow > label > \\.un-switch \\{ grid-column: 2;`), 'the switch at the end');
  assert.doesNotMatch(read('frontend/@/components/ui/switch.tsx'), /ui-/, 'the shared switch row itself is untouched');
});

test('a choice of one is radio rows in a card: the segments stand as rows, with a mark the standard look never draws', () => {
  for (const file of ['theme.tsx', 'accessibility.tsx']) {
    const src = section(file);
    assert.match(src, /'theme-seg ui-row ui-row-sm flex-1 basis-0 rounded-md px-1\.5 py-1 transition-colors';/, file);
    assert.match(src, /className="ui-card ui-radios relative flex p-0\.5 rounded-lg /, file);
    assert.match(src, /<span aria-hidden="true" className=\{on \? 'ui-chk ui-chk-on ui-look-only' : 'ui-chk ui-look-only'\}>/, file);
    assert.match(src, /role="radio"/, file);
  }
  assert.match(css, /\n\.ui-look-only \{ display: none; \}/);
  assert.match(settings, new RegExp(`${ANY} #settings-screen #settings-root \\.ui-radios \\{ display: block;`));
  const privacy = section('privacy.tsx');
  assert.match(privacy, /const ROW_FIRST = 'ui-row flex items-start gap-3 cursor-pointer select-none py-2\.5';/);
  assert.match(privacy, /className="ui-card flex flex-col"/);
  assert.match(section('privacy-text.tsx'), /<label className="ui-row ui-row-sw flex items-start gap-2 cursor-pointer select-none">/);
  assert.match(settings, new RegExp(`${ANY} #settings-screen #settings-root \\.ui-row\\.ui-row-sw \\{ flex-direction: row-reverse; \\}`), 'Privacy\'s switch rows: the switch at the end, by order alone');
});

test('`hidden` still hides a worn node, since settings.js shows and hides by that class', () => {
  assert.match(settings, new RegExp(`${ANY} #settings-screen #settings-root \\.hidden:not\\(\\[class\\*=":block"\\], \\[class\\*=":flex"\\], \\[class\\*=":inline"\\], \\[class\\*=":grid"\\]\\) \\{ display: none; \\}`));
});

test('the lists of small cards are one card of rows, and the hand-made cards wear the kit\'s', () => {
  for (const file of ['notification-prefs-list.tsx', 'app-permissions-list.tsx', 'grants-list.tsx', 'agent-files-list.tsx', 'cli-tokens-list.tsx', 'local-agents-list.tsx']) {
    assert.match(read('frontend/src/features/settings', file), /const ROW_CLASS = 'ui-mini rounded-lg bg-white dark:bg-zinc-900 px-3 py-2 text-xs';/, file);
  }
  assert.match(section('app-permissions.tsx'), /<div id="app-permissions-list" className="ui-card space-y-2">/);
  assert.match(section('app-ai.tsx'), /<div id="llm-grants-list" className="ui-card space-y-2">/);
  assert.match(section('cli.tsx'), /<div id="cli-tokens-list" className="ui-card space-y-2">/);
  assert.match(section('usage.tsx'), /className="ui-card rounded-2xl bg-white dark:bg-zinc-900 overflow-hidden mb-3"/);
  assert.match(section('profile.tsx'), /className="ui-card ui-row flex items-center gap-3 rounded-2xl bg-white /);
  assert.match(settings, new RegExp(`${ANY} #settings-root \\.ui-card > \\.ui-mini \\+ \\.ui-mini \\{ border-top: 1px solid var\\(--fr-line2\\); \\}`));
});

// What the visual pass of 11 Nov 2026 found on Settings, and what lane S left partly done (s61, s62, s63).
const IN = `${ANY} #settings-screen #settings-root `;

test('a field\'s value is the ink: the worn field\'s own colour is the placeholder\'s, and three ids outrank it', () => {
  assert.match(settings, new RegExp(`${IN}#settings-section-content :is\\(input, select, textarea\\) \\{ color: var\\(--fr-ink\\); \\}`));
  assert.match(settings, new RegExp(`${ANY} #settings-section-content :is\\(input, textarea\\)::placeholder \\{ color: var\\(--fr-faint\\); \\}`), 'the placeholder alone is faint');
  assert.equal(roots.inp.parts.val, undefined, 'the map still gives the field no `val`: the hand rule says the ink');
});

test('Copy and Test connection are the same small button, centred on the address', () => {
  const src = section('connectors.tsx');
  assert.match(src, /id="connector-url-test"[^>]*className="ui-btn-sm w-full sm:w-auto min-h-\[44px\] sm:min-h-\[36px\]"/);
  const btn = roots.btn.also.find((w) => /#settings-root/.test(w.to));
  assert.match(btn.parts.sm, /\.text-sm:not\(\.w-full\)/, 'Copy is small by its own classes');
  assert.match(btn.parts.sm, /\.ui-btn-sm/, 'and Test connection by name, since its `w-full` keeps it out of that');
  assert.match(settings, new RegExp(`${ANY} #settings-root #connectors-section :has\\(> #connector-url\\) \\{ align-items: center; \\}`));
  assert.match(settings, new RegExp(`${IN}#connectors-section > :is\\(label, details\\) \\{ padding-inline: 4px; \\}`), 'the label and How it works start where the notes do');
});

test('a card of fields the standard sheet rules off keeps the card\'s padding at its head (the Look menu)', () => {
  assert.match(settings, new RegExp(`${IN}\\.ui-fields\\.pt-6 \\{ margin-top: 24px; padding-top: 16px; border-top: 0; \\}`), 'named with the screen, so it outranks the rule that takes a ruled-off block\'s padding');
});

test('OpenRouter is one card: a neutral wrapper round its parts, each keeping its node, id and `hidden`', () => {
  const src = section('openrouter.tsx');
  const open = src.indexOf('<div className="ui-card ui-onecard">');
  const close = src.indexOf('<StatusLine id="settings-openrouter-status"');
  assert.ok(open > 0 && close > open);
  const inside = src.slice(open, close);
  const ids = ['settings-openrouter-included', 'settings-openrouter-key-display', 'settings-openrouter-key-info', 'settings-openrouter-personal-controls', 'settings-openrouter-models-wrap'];
  let at = 0;
  for (const id of ids) {
    const i = inside.indexOf(`id="${id}"`, at);
    assert.ok(i > at, `${id} is inside the wrapper, in today's order`);
    at = i;
  }
  assert.match(src, /<Label className="px-1 pb-1 text-\[15px\] font-normal text-zinc-500 dark:text-zinc-500" htmlFor="settings-openrouter-key">/, 'the personal key\'s label is a field\'s label, not a small-caps one');
  assert.match(settings, new RegExp(`${IN}:is\\(\\.ui-onecard, \\.ui-filecard\\) > \\.ui-card, ${IN}\\.ui-onecard \\.ui-keyrow \\{ margin: 0; border: 0; border-radius: 0; background: none; box-shadow: none;`), 'a part has no card of its own inside it');
  assert.match(settings, new RegExp(`${IN}#settings-openrouter-personal-controls > label \\{ display: block; padding: 0 0 8px; font-size: 13px; font-weight: 650;`));
  for (const file of ['openrouter.tsx', 'api-key.tsx']) {
    assert.match(section(file), /<div className="ui-card ui-keyrow rounded-2xl bg-white dark:bg-zinc-900 overflow-hidden">/, file);
  }
  assert.match(settings, new RegExp(`${IN}\\.ui-keyrow \\{ display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 16px; \\}`), 'a key is a field with its button beside it');
  assert.doesNotMatch(css.replace(settings, ''), /\.ui-(onecard|keyrow|filecard)/, 'the standard look says nothing for these names');
});

test('a kind of agent file is one card with Upload at the end of its first row, placed by the grid', () => {
  const src = section('agent-files.tsx');
  assert.match(src, /<div className="ui-card ui-filecard mb-4">\s*<div className="flex items-center justify-between mb-1\.5">\s*<h4 className="text-xs font-semibold /);
  assert.match(src, /<div className="ui-card ui-filecard mb-2">/);
  assert.match(src, /<\/h4>\s*<button\s+data-agent-files-upload="instruction"/, 'the button settings.js binds stays where it was in the markup');
  assert.match(settings, new RegExp(`${IN}\\.ui-filecard \\{ display: grid; grid-template-columns: minmax\\(0, 1fr\\) auto;`));
  assert.match(settings, new RegExp(`${IN}\\.ui-filecard > div:first-child \\{ display: contents; \\}`));
  assert.match(settings, new RegExp(`${IN}\\.ui-filecard \\[data-agent-files-upload\\] \\{ grid-column: 2; grid-row: 1 / span 2;`));
  assert.match(settings, new RegExp(`${IN}\\.ui-filecard:has\\(\\.ui-mini\\) > \\.ui-card \\{ grid-column: 1 / -1; border-top: 1px solid var\\(--fr-line2\\); \\}`), 'its files are rows across the card');
});

test('inside a tool\'s guided set-up the product\'s nodes are drawn in the kit\'s type and tokens', () => {
  const G = `${IN}#connectors-list `;
  assert.match(settings, new RegExp(`${G}details > div :is\\(p, ol > li > span\\) \\{ font-size: 15px; line-height: 1\\.45; color: var\\(--fr-mut\\); \\}`));
  assert.match(settings, new RegExp(`${G}\\[data-connector-step-tick\\] > span \\{ width: 24px; height: 24px; border-radius: 8px; background: var\\(--fr-sunk\\);`));
  assert.match(settings, new RegExp(`${G}\\[data-connector-step-tick\\]\\[aria-pressed="true"\\] > span \\{ background: var\\(--fr-acc\\); color: var\\(--fr-acc-ink\\); \\}`));
  assert.match(settings, new RegExp(`${G}details > div pre \\{ padding: 12px; border: 1px solid var\\(--fr-line\\); border-radius: 12px; background: var\\(--fr-ground\\); font-family: var\\(--fr-fm\\);`));
  assert.match(settings, new RegExp(`${G}details > div > \\.rounded-xl \\{ border-radius: 12px; background: var\\(--fr-sunk\\); \\}`));
});

test('the small pieces: Legal as rows, the version row centred, the look\'s check and avatar, a note\'s bold words', () => {
  assert.match(settings, new RegExp(`${IN}\\.ui-links \\.ui-link \\{ display: flex; align-items: center; min-height: 48px; padding: 8px 16px;`));
  assert.match(settings, new RegExp(`${IN}\\.ui-links \\.ui-link \\+ \\.ui-link \\{ border-top: 1px solid var\\(--fr-line2\\); \\}`));
  assert.match(settings, new RegExp(`${IN}#settings-about-section \\.drawer-ver-row \\{ align-items: center; min-height: 48px;`));
  assert.match(settings, new RegExp(`${IN}\\[data-settings-section="linked-accounts"\\] span\\.rounded-full\\.bg-violet-600 \\{ background: var\\(--fr-acc\\); color: var\\(--fr-acc-ink\\); \\}`));
  assert.match(settings, new RegExp(`${IN}:is\\(\\.ui-note, \\.ui-secblurb\\) strong \\{ color: var\\(--fr-ink\\); font-weight: 650; \\}`));
  assert.match(settings, new RegExp(`${IN}\\.ui-card\\.ui-pad\\[class\\*="space-y-"\\] > \\* \\+ \\* \\{ margin-top: 12px; \\}`));
  assert.match(settings, new RegExp(`${IN}\\[data-mobile-push-status\\] \\{ margin: 8px 0 0; padding: 0 4px;`));
  assert.match(settings, new RegExp(`${IN}#settings-mobile-menu-host \\.settings-menu-row \\{ gap: 12px; padding-inline: 16px; \\}`));
  assert.deepEqual(roots.av, { to: '#settings-profile-card > span[aria-hidden]:is(#settings-root *)' }, 'the profile row\'s letter wears the kit\'s avatar');
  assert.match(section('profile.tsx'), /style=\{\{ '--fr-ac': swatchFor\(user\?\.username \|\| '\?'\) \} as React\.CSSProperties\}/, 'on the colour the frame\'s bar draws the person in');
});

test('the list stays in view on a desktop while a long section scrolls, and scrolls on its own when it is taller than the window', () => {
  const rule = settings.match(new RegExp(`@media \\(min-width: 1024px\\) \\{\\s+${IN}#settings-sidebar-col \\{([^}]*)\\}`));
  assert.ok(rule, 'said with the screen and the root, so it outranks the column\'s own rule above');
  assert.match(rule[1], /position: sticky; top: 16px; align-self: flex-start;/, 'as the standard look\'s list does');
  assert.match(rule[1], /max-height: calc\(100dvh - var\(--platform-header-h, 0px\) - 16px\);/);
  assert.match(rule[1], /overflow-y: auto; overscroll-behavior: contain;/);
  assert.match(rule[1], /flex-basis: 376px; width: 376px;[^}]*margin: -8px; padding: 8px 8px 24px;/, '8px larger on every side, taken back as margins: a scroller cuts shadows, and the cards keep theirs');
});

test('a field inside a card has an edge in Pastel and in Paper, said for this screen and not in the looks\' own files', () => {
  const FIELD = ':is\\(input, select, textarea\\):not\\(\\[type="checkbox"\\], \\[type="radio"\\], \\[type="file"\\], \\[type="range"\\], \\[type="hidden"\\]\\):not\\(:focus\\)';
  const AT = '#settings-screen #settings-root #settings-section-content :is\\(\\.ui-card, \\.ui-fields\\) ';
  assert.match(settings, new RegExp(`html\\[data-skin="pastel"\\] ${AT}${FIELD} \\{ background: var\\(--fr-sunk\\); box-shadow: inset 0 0 0 1px var\\(--fr-line\\); \\}`), 'Pastel: what it does on a white sheet');
  assert.match(settings, new RegExp(`html\\[data-skin="paper"\\] ${AT}${FIELD} \\{ background: var\\(--fr-ctl\\); box-shadow: inset 0 0 0 1px color-mix\\(in srgb, var\\(--fr-ink\\) 22%, transparent\\); \\}`), 'Paper: its control tone (white in light) and a ring that shows');
  for (const look of ['pastel', 'paper']) assert.doesNotMatch(read('frontend/looks', `${look}.css`), /settings/, `${look}.css is not touched`);
});

test('in Paper a quiet button inside one of this screen\'s cards is the control tone (white in light), as the look says of its own', () => {
  assert.match(read('frontend/looks/paper.css'), /\.card \.btn\.quiet,\.card \.btn\.line\{background:var\(--ctl\);box-shadow:none\}/, 'the look\'s own rule');
  assert.match(settings, /html\[data-skin="paper"\] #settings-screen #settings-root :is\(\.ui-card, \.ui-glist\) :is\(\.ui-btn, :is\(button, a, label\):is\(\.bg-white, \.bg-zinc-100, \.border:is\(\.rounded, \.rounded-md, \.rounded-lg, \.rounded-full\)\)\):is\(\.bg-white, \.bg-zinc-100, \.border, \.ui-btn-quiet, \.ui-btn-line\):not\(\.border-red-400, \.ui-btn-bad, \.bg-violet-600, \.ui-lrow, \.ui-row, \[role="radio"\], \.ui-plain\) \{ background: var\(--fr-ctl\); box-shadow: none; \}/);
});

test('with the keys up on a phone the frame\'s tab bar goes while Settings is open, as the standard look\'s does', () => {
  assert.match(css, /html\.un-kb #platform-tabs \{\s+display: none;/, 'the standard look\'s own');
  assert.match(settings, /@media \(max-width: 767\.98px\) \{\s+html\[data-skin\]:is\(\.un-kb, \.platform-kb-open\):has\(#settings-screen:not\(\.hidden\)\) \.fr\.fr-shell \.fr-tabbar \{ display: none; \}/);
});

test('Disconnect in a tool\'s card is the small bad button', () => {
  const src = read('frontend/src/features/settings/connectors-list.tsx');
  assert.match(src, /className="ui-btn-sm inline-flex min-h-\[44px\] shrink-0 items-center rounded-full bg-red-500\/10 px-4 /, 'small by name: none of its own classes says so');
  const btn = roots.btn.also.find((w) => /#settings-root/.test(w.to));
  assert.match(btn.parts.sm, /\.ui-btn-sm/);
  assert.match(btn.parts.bad, /\.bg-red-500\\\/10/, 'and bad by its own fill');
});

test('Homeroom Wallet wears the look: the QR in a card, the linked key one row of a card', () => {
  const src = section('wallet.tsx');
  assert.match(src, /<div id="wallet-linking" className="ui-card hidden text-center">/, 'the id and `hidden` settings.js toggles are kept');
  assert.match(src, /<div className="ui-card ui-walletkey flex items-center gap-2 rounded-lg bg-zinc-100 /);
  for (const id of ['wallet-section', 'wallet-unlinked', 'wallet-link-btn', 'wallet-qr-canvas', 'wallet-link-timer', 'wallet-link-cancel', 'wallet-linked', 'wallet-pubkey-display', 'wallet-status']) assert.ok(src.includes(`id="${id}"`), id);
  assert.match(settings, new RegExp(`${IN}#wallet-linking\\.ui-card \\{ padding: 24px 16px 16px; \\}`));
  assert.match(settings, new RegExp(`${IN}\\.ui-walletkey \\{ gap: 12px; min-height: 48px; padding: 8px 16px; border: 0; \\}`));
  assert.match(settings, new RegExp(`${IN}\\.ui-walletkey > span:first-child \\{ font-size: 15px; color: var\\(--fr-ok\\); \\}`));
  assert.match(settings, new RegExp(`${IN}#wallet-pubkey-display \\{ font-family: var\\(--fr-fm\\);`));
  assert.doesNotMatch(settings, /#wallet-qr-canvas \{[^}]*background/, 'the code keeps its white ground');
});

test('the Homeroom app page: each part is one card headed by its name, and no wrapper stands between a heading and what follows it', () => {
  const src = section('usernode-ui.tsx');
  assert.match(src, /<div id=\{id\} className="ui-card ui-unsec mt-6 pt-5 border-t border-zinc-200 dark:border-zinc-800">\s*<SectionHeading title=\{title\}>\{description \|\| undefined\}<\/SectionHeading>\s*\{children\}\s*<\/div>/, 'names on the part\'s own box; its children stay the heading\'s siblings');
  assert.match(css, /\n\.settings-sheet h3 \+ p \{ font-size: 15px; line-height: 1\.35; margin-bottom: 14px; \}/, 'the standard sheet styles the paragraph after a heading: a wrapper between them changed a part that opens with a note (About, Account)');
  assert.match(src, /const ROW_BASE = 'ui-unrow flex items-center gap-2 mt-1 text-sm w-full text-start';/);
  assert.doesNotMatch(src, /isFrameSkin|useLiveSkin|useSkin/, 'one markup for both looks');
  const U = `${IN}#settings-usernode-section `;
  assert.match(settings, new RegExp(`${U}\\.ui-unsec \\{ display: flex; flex-direction: column; align-items: stretch; gap: 8px; margin-top: 12px; padding: 12px 16px 16px; border: 0; \\}`));
  assert.match(settings, new RegExp(`${U}\\.ui-unsec > h3\\.ui-sechead \\{ margin: 0; padding: 0; font-family: var\\(--fr-f\\); font-size: 15px; font-weight: 650;[^}]*text-transform: none; color: var\\(--fr-ink\\); \\}`), 'the part\'s name heads its card, in the row\'s type');
  assert.match(settings, new RegExp(`${U}\\.ui-unrow \\{ gap: 12px; min-height: 40px;`));
  assert.match(settings, new RegExp(`${U}\\.bg-emerald-500 \\{ background: var\\(--fr-ok\\); \\}`), 'a state\'s dot is the look\'s');
  assert.match(settings, new RegExp(`${U}\\.bg-amber-500 \\{ background: var\\(--fr-wait\\); \\}`));
  assert.match(settings, new RegExp(`${U}\\.ui-unsec > label:has\\(> \\.un-switch\\) \\{ flex-direction: row-reverse; justify-content: space-between;`), 'a switch at the end of its row');
  assert.match(settings, new RegExp(`${U}\\.ui-unsec > div\\.rounded-md\\.border\\.border-amber-300 \\{ background: var\\(--fr-wait-t\\); \\}`), 'a notice is a tinted box');
  assert.match(settings, new RegExp(`${U}\\.ui-unsec details \\{ margin: 0 0 8px; padding: 12px 16px; border: 0; border-radius: 12px; background: var\\(--fr-sunk\\); \\}`));
  assert.doesNotMatch(css.replace(settings, ''), /\.ui-(unsec|unbody|unrow|walletkey)/, 'the standard look says nothing for these names');
});

test('no rule here paints a literal colour or blurs the page', () => {
  assert.doesNotMatch(settings, /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  assert.doesNotMatch(settings.replace(/backdrop-filter: none/g, ''), /backdrop-filter/);
});
