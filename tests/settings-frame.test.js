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
  assert.match(settings, new RegExp(`${ANY} #settings-sidebar-col \\{ order: 1; flex: 0 0 360px; width: 360px; position: static; height: auto; overflow: visible; padding: 0; \\}`), 'the list is part of the page: not a sheet that scrolls on its own');
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
  assert.ok(css.includes(`html[data-skin] .fr-row+.fr-row,${WORN} :is(.ui-lrow,.ui-row,.drawer-ver-row):is(#settings-root *)+:is(.ui-lrow,.ui-row,.drawer-ver-row):is(#settings-root *){border-top:1px solid var(--fr-line2)}`));
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

test('no rule here paints a literal colour or blurs the page', () => {
  assert.doesNotMatch(settings, /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  assert.doesNotMatch(settings.replace(/backdrop-filter: none/g, ''), /backdrop-filter/);
});
