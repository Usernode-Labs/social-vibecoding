'use strict';

// The admin console's Onboarding flows section
// (frontend/src/features/admin/admin-onboarding-flows.tsx): where it sits,
// that it mounts the console's way, that the chart engine and the frame
// React renders agree on every host, that its styles stay inside the
// section, and that what was a guess in the prototype is not drawn as one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SECTION = 'frontend/src/features/admin/admin-onboarding-flows.tsx';
const ENGINE = 'frontend/src/features/admin/onboarding-flows/engine.js';

test('it sits under Insights beside Journey and is not public', () => {
  const src = read('frontend/src/features/admin/admin-console.js');
  assert.match(src, /\{ key: 'onboarding-flows', label: 'Onboarding flows', group: 'Insights' \}/, 'admin-only: no `public: true`');
  const sections = src.slice(src.indexOf('SECTIONS: ['), src.indexOf('LEGACY_SECTION_KEYS'));
  const at = (key) => sections.indexOf(`{ key: '${key}'`);
  assert.ok(at('journey') < at('onboarding-flows') && at('onboarding-flows') < at('analytics'), 'right after Journey');
  assert.match(src, /'onboarding-flows': 'AdminOnboardingFlows',/);
  assert.match(src, /'onboarding-flows': '<svg /, 'a nav icon like every section');
  assert.match(read('frontend/src/features/admin/sections.ts'), /import '\.\/admin-onboarding-flows\.tsx';/);
});

test('it mounts through the render/destroy portal seam and nothing in it writes', () => {
  const src = read(SECTION);
  assert.match(src, /render\(el: Element\) \{\s*host = el;\s*mountLegacyPortal\(el, <OnboardingFlowsSection \/>\);/);
  assert.match(src, /destroy\(\) \{\s*unmountLegacyPortal\(host\);\s*host = null;/);
  assert.match(src, /import \{ AdminUI \} from '\.\/admin-console\.js';/);
  assert.doesNotMatch(src, /@\/components\/ui/, 'no admin source imports the shell primitives');
  assert.doesNotMatch(src, /requireAdminWrite|canWrite/, 'nothing here writes, so view-only admins see all of it');
  assert.match(src, /className=\{AdminUI\.loading\}>Loading the onboarding flows…/);
  assert.match(src, /fetchJson\(DEMO \? `\$\{PATH\}\?demo=1` : PATH\)/, 'the demo payload under ?demo=1, like Journey');
  const audit = read('scripts/audit-react-ownership.mjs');
  assert.match(audit, /\{ sel: '#admin-section-content', when: '#admin\/onboarding-flows' \}/);
  assert.match(audit, /'#admin\/onboarding-flows'/);
});

test('the chart is one engine over hosts React renders once', () => {
  const src = read(SECTION);
  const engine = read(ENGINE);
  assert.match(src, /const Frame = memo\(function Frame/, 'a re-render cannot reconcile over what the engine drew');
  assert.match(src, /const chart = mountFlows\(root\.current, reading\);\s*return \(\) => chart\.destroy\(\);/);
  const hosts = new Set([...src.matchAll(/data-of="([a-zA-Z0-9]+)"/g)].map((m) => m[1]));
  const wanted = new Set([...engine.matchAll(/byId\('([a-zA-Z0-9]+)'\)/g)].map((m) => m[1]));
  assert.ok(wanted.size > 25, 'the engine names its hosts');
  assert.deepEqual([...wanted].filter((id) => !hosts.has(id)), [], 'every host the engine asks for is rendered');
  assert.deepEqual([...hosts].filter((id) => !wanted.has(id)), [], 'and nothing is rendered for it that it never takes');
  assert.doesNotMatch(engine, /getElementById|document\.querySelector/, 'it looks nothing up outside its root');
  assert.doesNotMatch(engine, /(window|document)\.addEventListener/, 'every listener goes through listen(), so destroy() takes it');
  assert.match(engine, /return \{ destroy: function\(\)\{\s*dead=true;\s*cleanups\.forEach/);
  assert.doesNotMatch(engine, /innerHTML/, 'names and project titles are written as text');
  // The fills the drawing refers to are the engine's own, under the section's prefix.
  for (const id of ['of-hatch', 'of-hatchSoft', 'of-bothStripe', 'of-arr']) assert.match(engine, new RegExp(`id:'${id}'`));
  assert.match(engine, /url\(#of-arr\)/);
  assert.match(engine, /var reduce=reducedMotion\(\);/, 'the Reduce motion setting, not the media query alone');
});

test('nothing is drawn as inferred: the reading settles private or public, lapsed and too early', () => {
  const engine = read(ENGINE);
  assert.doesNotMatch(engine, /[Ii]nferred/);
  assert.match(engine, /'got:new':\{l:'Let off this week, too early to say'[^}]*neutral:true\}/);
  assert.match(engine, /if\(!on&&!\(N\[Y\.id\]\|\|\{\}\)\.neutral\)/, 'a card that is too early to judge is not a loss');
  assert.match(engine, /'out:lapsed'/);
  assert.match(engine, /var EARLY=\(DATA\.early&&DATA\.early\.label\)\|\|'Earlier members';/, 'the early group is named by the reading');
  assert.match(engine, /s1Btn\.hidden=!count\(ALL,function\(p\)\{return p\.s1;\}\);/, 'no toggle when nobody is early');
  for (const view of ['whole', 'priv', 'pub', 'share', 'drop']) assert.match(engine, new RegExp(`id:'${view}'`), `the ${view} view`);
});

test('its styles are scoped to the section and use no untuned palette', () => {
  const css = read('public/css/app.css');
  const from = css.indexOf('/* ── Onboarding flows (features/admin/admin-onboarding-flows.tsx)');
  assert.ok(from > 0, 'the block is in app.css');
  const to = css.indexOf('/* ── THE NEW LOOK, AN EXPERIMENT');
  assert.ok(to > from, 'before the new look\'s block, which runs to the end of the file');
  const block = css.slice(from, to).replace(/\/\*[\s\S]*?\*\//g, '');
  // Every selector, inside a media query or not, starts at the section root.
  const selectors = [...block.matchAll(/(^|[{}])\s*([^{}@]+?)\s*\{/g)].map((m) => m[2].trim())
    .filter((s) => !/^(from|to|\d+%)$/.test(s));
  assert.ok(selectors.length > 150);
  for (const list of selectors) {
    for (const sel of list.split(',')) {
      assert.match(sel.trim(), /^(html\.dark |:where\(html\[data-motion="reduce"\]\) )?#admin-onboarding-flows\b/, `scoped: ${sel.trim()}`);
    }
  }
  assert.match(block, /html\.dark #admin-onboarding-flows \{/, 'dark inks follow the shell\'s own switch');
  assert.doesNotMatch(block, /font:[^;}]*var\(/, 'no font shorthand over a variable: an inherited family voids the whole declaration');
  assert.doesNotMatch(block, /url\(#(hatch|hatchSoft|bothStripe|arr)\)/, 'pattern ids carry the section prefix');
  assert.doesNotMatch(block, /fonts\.googleapis|@import/, 'no cross-origin assets');
  assert.doesNotMatch(block, /safe-area-inset/, 'the section sits inside the page, clear of the screen\'s edges');
  assert.match(block, /#admin-onboarding-flows \.scroller\{[^}]*direction:ltr/, 'the drawing reads left to right in every language');
  for (const src of [read(SECTION), read(ENGINE)]) assert.doesNotMatch(src, /\b(gray|indigo)-\d/);
});

test('the screen has its declared check', () => {
  const dapp = JSON.parse(read('dapp.json'));
  const check = dapp.tests.find((c) => c.path === '/?demo=1#admin/onboarding-flows');
  assert.ok(check, 'a check opens the section on the demo payload');
  assert.equal(check.expectSelector, '#admin-onboarding-flows [data-tab="drop"]');
  assert.match(read(ENGINE), /'data-tab':v\.id/);
});
