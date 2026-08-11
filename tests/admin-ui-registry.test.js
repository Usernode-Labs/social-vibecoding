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

const JS_DIR = path.join(__dirname, '..', 'public', 'js');
const ADMIN_FILES = fs.readdirSync(JS_DIR).filter((f) => /^admin(-|\.)/.test(f) && f.endsWith('.js'));

function loadRegistry() {
  const src = fs.readFileSync(path.join(JS_DIR, 'admin-console.js'), 'utf8');
  const m = src.match(/window\.AdminUI = Object\.freeze\(\{[\s\S]*?\n\}\);/);
  assert.ok(m, 'admin-console.js defines window.AdminUI = Object.freeze({ ... });');
  const sandbox = { window: {} };
  vm.runInNewContext(m[0], sandbox);
  return sandbox.window.AdminUI;
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
