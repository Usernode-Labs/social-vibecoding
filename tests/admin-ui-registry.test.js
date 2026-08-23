// tests/admin-ui-registry.test.js — static analysis: every AdminUI.<key>
// reference across the admin modules resolves to a key defined in the
// registry in admin-console.js, so a typo fails CI instead of silently
// rendering class="undefined". Mirrors the source-regex style of
// tests/shell-script-order.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// #1082 chunk E moved the ten admin modules into the React bundle. Same
// files, same registry, same discipline — only the directory changed.
const JS_DIR = path.join(__dirname, '..', 'frontend', 'src', 'features', 'admin');
// `.tsx` as well as `.js` since #1120 slice 6: a converted section renders in
// React but is still styled by the registry below, so every rule in this file
// applies to it unchanged. Both renderers, one vocabulary.
const ADMIN_FILES = fs.readdirSync(JS_DIR).filter((f) => /^admin(-|\.)/.test(f) && /\.(js|tsx)$/.test(f));

function loadRegistry() {
  const src = fs.readFileSync(path.join(JS_DIR, 'admin-console.js'), 'utf8');
  // An `export const` since the move — it is a real module dependency for the
  // section modules now, not a global they happened to find. Rewritten to a
  // `var` so it can be evaluated in a bare vm context.
  const m = src.match(/export const AdminUI = Object\.freeze\(\{[\s\S]*?\n\}\);/);
  assert.ok(m, 'admin-console.js defines export const AdminUI = Object.freeze({ ... });');
  const sandbox = {};
  vm.runInNewContext(m[0].replace(/^export const/, 'var'), sandbox);
  return sandbox.AdminUI;
}

test('every AdminUI reference resolves to a defined registry key', () => {
  const registry = loadRegistry();
  const refRe = /\bAdminUI\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g;
  for (const file of ADMIN_FILES) {
    const src = fs.readFileSync(path.join(JS_DIR, file), 'utf8');
    for (const [, k1, k2] of src.matchAll(refRe)) {
      const v1 = registry[k1];
      assert.notStrictEqual(v1, undefined, `${file}: AdminUI.${k1} is not defined`);
      if (typeof v1 === 'object') {
        assert.ok(k2, `${file}: AdminUI.${k1} is a group — reference a member (e.g. AdminUI.${k1}.primary)`);
        assert.strictEqual(typeof v1[k2], 'string', `${file}: AdminUI.${k1}.${k2} is not defined`);
        assert.ok(v1[k2].length > 0, `${file}: AdminUI.${k1}.${k2} is empty`);
      } else {
        assert.strictEqual(typeof v1, 'string', `${file}: AdminUI.${k1} is not a string`);
        assert.ok(v1.length > 0, `${file}: AdminUI.${k1} is empty`);
      }
    }
  }
});

test('registry values are complete literals (no template placeholders)', () => {
  const registry = loadRegistry();
  const flat = [];
  for (const [k, v] of Object.entries(registry)) {
    if (typeof v === 'string') flat.push([k, v]);
    else for (const [k2, v2] of Object.entries(v)) flat.push([`${k}.${k2}`, v2]);
  }
  assert.ok(flat.length >= 20, 'registry has a real set of recipes');
  for (const [k, v] of flat) {
    assert.doesNotMatch(v, /[${}]/, `AdminUI.${k} must be a plain class-string literal`);
  }
});

// ── The registry boundary (#1120 slice 5) ────────────────────────────────
//
// The two tests above are one direction: every AdminUI reference resolves.
// This is the converse, and it is the half that actually keeps the two design
// systems apart. The platform shell is zinc/violet and draws from
// frontend/@/components/ui/**; the admin console is topochain's gray/indigo
// and draws from the AdminUI registry above. They render into the same
// document, so nothing but a rule stops a contributor reaching across — and
// the result of reaching across is not a build error, it is an indigo button
// on a violet screen, or a zinc one in the console.
//
// See the "Two design systems, one bundle" section in AGENTS.md.

const UI_DIR = path.join(__dirname, '..', 'frontend', '@', 'components', 'ui');
const SRC_DIR = path.join(__dirname, '..', 'frontend', 'src');

/** Every .ts/.tsx/.js under `dir`, as repo-relative paths. */
function sourcesUnder(dir, out = [], base = dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourcesUnder(full, out, base);
    else if (/\.(tsx?|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Source with block and line comments removed — prose mentions are fine. */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('the admin console does not reach for the shell’s primitives', () => {
  // THIS is the boundary now. It used to be a palette one — gray/indigo here,
  // zinc/violet there — and the widget-language reskin folded the console into
  // the shell's language, so that half is gone (see the test below, which now
  // enforces ONE palette rather than two).
  //
  // What is left is a SURFACE boundary, and unlike the palette one it does not
  // dissolve as sections convert to React. An operator console and a phone
  // screen want different densities of the same vocabulary: a 44px tap target
  // and a card with 1.5rem of padding are right on `#home` and wrong in a
  // table of 130 test cases. So the console keeps its own recipes — the same
  // zinc/violet utilities, tuned for a desk — and reaching for `<Button>` here
  // would drop a phone-sized control into a spreadsheet.
  //
  // A converted section is still bound by this. `admin-e2e.tsx` renders JSX and
  // spells every class `className={AdminUI.td}`; what changed there is the
  // renderer, not the vocabulary.
  for (const file of ADMIN_FILES.concat(['index.tsx'])) {
    const src = code(fs.readFileSync(path.join(JS_DIR, file), 'utf8'));
    const hit = src.match(/from '@\/components\/ui\/[^']*'/);
    assert.strictEqual(hit, null,
      `frontend/src/features/admin/${file} imports ${hit && hit[0]} — the console is styled `
      + 'by the AdminUI registry, not by the shell primitives (see AGENTS.md)');
  }
});

test('nothing outside the admin console reads the registry', () => {
  // The other direction, and it outlived its original reason. It used to keep
  // a gray/indigo recipe off a zinc/violet screen; both are zinc/violet now,
  // so what it keeps out is a CLASS STRING where a component belongs. A shell
  // file reaching for AdminUI.card is a React tree being handed markup meant
  // for an innerHTML host — it would work, and it would be the first crack in
  // the rendering boundary above.
  for (const file of sourcesUnder(SRC_DIR)) {
    if (file.startsWith(JS_DIR + path.sep)) continue;
    const src = code(fs.readFileSync(file, 'utf8'));
    assert.doesNotMatch(src, /\bAdminUI\b/,
      `${path.relative(path.join(__dirname, '..'), file)} references AdminUI — that registry is `
      + "the admin console's alone (see AGENTS.md)");
  }
});

test('one palette across the product — no gray or indigo anywhere', () => {
  // This assertion INVERTED with the reskin, and got stronger doing it.
  //
  // It used to police a split: `gray-`/`indigo-` was the admin console's,
  // `zinc-`/`violet-` was the shell's, and each side using the other's scale
  // was the failure. The console speaks the shell's language now, so the split
  // is gone — and the rule that replaces it covers strictly more ground: the
  // stock gray and indigo scales appear NOWHERE, in either system.
  //
  // That is what catches a revert. The scale keys `zinc`/`violet` are
  // overridden in tailwind.config.js (see the long note there on why they keep
  // their names while their hues moved), so a stray `bg-gray-100` renders
  // stock Tailwind grey next to the platform's — a difference no reviewer
  // spots in a diff of class strings.
  const scoped = [...sourcesUnder(UI_DIR), ...ADMIN_FILES.map((f) => path.join(JS_DIR, f))];
  for (const file of scoped) {
    const src = code(fs.readFileSync(file, 'utf8'));
    for (const token of ['gray-', 'indigo-']) {
      assert.ok(!src.includes(token),
        `${path.basename(file)} uses the ${token.slice(0, -1)} scale — the platform is `
        + 'zinc/violet everywhere since the widget-language reskin');
    }
  }
  // And the registry is IN that language rather than merely free of the old
  // one: an empty file would pass the loop above.
  const registry = fs.readFileSync(path.join(JS_DIR, 'admin-console.js'), 'utf8');
  const table = registry.slice(registry.indexOf('export const AdminUI'), registry.indexOf('\n});'));
  for (const token of ['zinc-', 'violet-']) {
    assert.ok(table.includes(token),
      `the AdminUI registry has no ${token.slice(0, -1)} classes — it should speak the shell's palette`);
  }
});

test('no section module re-spells a recipe the registry already holds', () => {
  // The first two tests keep the systems apart from each other. This one keeps
  // the console honest with ITSELF: a registry is only a single source of
  // truth while nobody pastes its value inline. A pasted `${AdminUI.card}`
  // looks identical on the day it lands and silently stops tracking the
  // registry on the day the card gets a ring — which is the whole reason the
  // recipes were extracted.
  //
  // Threshold: recipes of five or more utilities. Three short ones —
  // `muted`, `label`, `separator`, each 3–4 utilities — DO appear inline in
  // five modules, and that is not the failure this describes. Nobody copies
  // `border-t border-gray-200 dark:border-gray-800` from the registry; two
  // authors independently spell a hairline the same way because there is only
  // one way to spell it. Raising the bar to five keeps every recipe with a
  // real shape (`card`, all six `btn.*`, `input`/`select`/`textarea`, all six
  // `badge.*`, `dialogOverlay`/`dialogPanel`, `kbd`, `th`, `trHover`) under
  // the rule while leaving the coincidences alone. 26 of the 33 recipes.
  const registry = fs.readFileSync(path.join(JS_DIR, 'admin-console.js'), 'utf8');
  const from = registry.indexOf('export const AdminUI');
  const to = registry.indexOf('\n});', from);
  const table = registry.slice(from, to);
  const recipes = [...table.matchAll(/: '([^']+)'/g)]
    .map((m) => m[1])
    .filter((v) => v.split(' ').length >= 5);
  assert.ok(recipes.length >= 20, 'the registry stopped parsing — check the slice bounds');

  for (const file of ADMIN_FILES) {
    let src = fs.readFileSync(path.join(JS_DIR, file), 'utf8');
    // The registry's own definitions are not duplicates of themselves.
    if (file === 'admin-console.js') src = src.slice(0, from) + src.slice(to);
    for (const recipe of recipes) {
      assert.ok(!src.includes(recipe),
        `frontend/src/features/admin/${file} hand-writes a string the registry already covers:\n`
        + `    ${recipe}\n`
        + '  Interpolate the AdminUI key instead — a pasted copy stops tracking the recipe '
        + 'the moment it changes.');
    }
  }
});
