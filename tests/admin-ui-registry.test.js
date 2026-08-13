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
const ADMIN_FILES = fs.readdirSync(JS_DIR).filter((f) => /^admin(-|\.)/.test(f) && f.endsWith('.js'));

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
  // The console predates the shadcn work and is styled end to end by the
  // registry. A <Button> here would be violet, and the surrounding markup is
  // built by innerHTML anyway, so there is nothing for it to compose with.
  for (const file of ADMIN_FILES.concat(['index.tsx'])) {
    const src = code(fs.readFileSync(path.join(JS_DIR, file), 'utf8'));
    const hit = src.match(/from '@\/components\/ui\/[^']*'/);
    assert.strictEqual(hit, null,
      `frontend/src/features/admin/${file} imports ${hit && hit[0]} — the console is styled `
      + 'by the AdminUI registry, not by the shell primitives (see AGENTS.md)');
  }
});

test('nothing outside the admin console reads the registry', () => {
  // The other direction. AdminUI is exported (index.tsx imports it for the
  // dialog it renders) rather than private, so this is the only thing keeping
  // a gray/indigo recipe from turning up on a zinc/violet screen.
  for (const file of sourcesUnder(SRC_DIR)) {
    if (file.startsWith(JS_DIR + path.sep)) continue;
    const src = code(fs.readFileSync(file, 'utf8'));
    assert.doesNotMatch(src, /\bAdminUI\b/,
      `${path.relative(path.join(__dirname, '..'), file)} references AdminUI — that registry is `
      + "the admin console's alone (see AGENTS.md)");
  }
});

test('the shell primitives carry no admin palette, and vice versa', () => {
  // The palettes are the boundary made visible: `gray-`/`indigo-` is
  // topochain, `zinc-`/`violet-` is the shell. Each side using the other's
  // scale is the exact failure this section exists to catch, and it is one a
  // reviewer will not see in a diff of class strings.
  for (const file of sourcesUnder(UI_DIR)) {
    const src = code(fs.readFileSync(file, 'utf8'));
    for (const token of ['gray-', 'indigo-']) {
      assert.ok(!src.includes(token),
        `${path.basename(file)} uses the ${token.slice(0, -1)} scale — the shell primitives are `
        + 'zinc/violet; that palette belongs to the admin console');
    }
  }
  const registry = fs.readFileSync(path.join(JS_DIR, 'admin-console.js'), 'utf8');
  const table = registry.slice(registry.indexOf('export const AdminUI'), registry.indexOf('\n});'));
  for (const token of ['zinc-', 'violet-']) {
    assert.ok(!table.includes(token),
      `the AdminUI registry uses the ${token.slice(0, -1)} scale — that palette belongs to the shell`);
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
