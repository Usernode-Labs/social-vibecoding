// A deep link into a GATED Settings section survives its gate resolving late
// (#2893).
//
// WHAT THIS PINS. #settings/usernode — Settings › Homeroom app, where block
// production is asked for, and where the block-production challenge's button
// points — fell back to the Settings root on the first open of the screen in
// a document. _renderUsernodeSection decides the gate synchronously, but the
// node it reaches is rendered by a React store that commits a tick later, and
// open() read the NODE straight after the decision. Two fixes, both driven
// here through the real methods sliced out of settings.js:
//
//   1. _visibleSections reads the Homeroom app gate from `_usernodeGated`,
//      the value the node is rendered from, once it has been decided.
//   2. A deep link to a registered gated section that is not offered yet is
//      remembered, and _renderNavIfOpen finishes the route once the gate
//      opens — only if the address still names that section.
//
// Run with: node --test tests/settings-gated-deep-link.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const settingsJs = fs.readFileSync(
  path.join(__dirname, '..', 'frontend/src/features/settings/settings.js'), 'utf8');

// Same scanner as tests/settings-screen.test.js: the method's text from its
// name to its own closing brace.
function sliceMethod(src, name) {
  const m = src.match(new RegExp(`\\n    (async )?${name}\\(`));
  assert.ok(m, `${name} exists`);
  let i = m.index + m[0].length;
  let depth = 0;
  let started = false;
  for (; i < src.length; i++) {
    if (src[i] === '{') { depth++; started = true; } else if (src[i] === '}') { depth--; }
    if (started && depth === 0) { i++; break; }
  }
  return src.slice(m.index + 1, i).trim();
}

// The real registry, and a gate node the test controls — standing in for
// #settings-usernode-section, whose `hidden` lags the model by a commit.
function makeSettings({ nodeHidden = true, hash = '#settings/usernode' } = {}) {
  const block = settingsJs.slice(settingsJs.indexOf('    SECTIONS: ['), settingsJs.indexOf('    ADVANCED_GROUP:'));
  const node = { hidden: nodeHidden };
  const document = {
    getElementById: (id) => (id === 'settings-usernode-section'
      ? { classList: { contains: (c) => c === 'hidden' && node.hidden } }
      : null),
  };
  const location = { hash };
  const methods = ['_visibleSections', '_notePendingSection', '_renderNavIfOpen']
    .map((n) => sliceMethod(settingsJs, n)).join(',\n');
  const Settings = new Function('document', 'location', `
    const Settings = {
      ${block.trim()}
      _open: true,
      _pendingSection: null,
      calls: [],
      _ensureActiveGroupExpanded() { this.calls.push('expand'); },
      _renderNav() { this.calls.push('nav'); },
      setSection(k) { this.calls.push('setSection:' + k); },
      route(k) { this.calls.push('route:' + k); },
      ${methods}
    };
    return Settings;
  `)(document, location);
  return { Settings, node, location };
}

const keys = (S) => S._visibleSections().map((s) => s.key);

test('the Homeroom app gate is read from its model once decided, not the lagging node', () => {
  const { Settings, node } = makeSettings({ nodeHidden: true });
  assert.ok(!keys(Settings).includes('usernode'), 'undecided: the node decides (hidden)');
  node.hidden = false;
  assert.ok(keys(Settings).includes('usernode'), 'undecided: the node decides (shown)');

  // _renderUsernodeSection has decided "in the app"; React has not committed.
  node.hidden = true;
  Settings._usernodeGated = true;
  assert.ok(keys(Settings).includes('usernode'),
    'a deep link read right after the decision finds the section offered');
  Settings._usernodeGated = false;
  node.hidden = false;
  assert.ok(!keys(Settings).includes('usernode'), 'and a closed gate is closed at once');
});

test('the synchronous prelude decides the gate before its first await', () => {
  const fn = sliceMethod(settingsJs, '_renderUsernodeSection');
  const firstAwait = fn.indexOf('await ');
  assert.ok(fn.indexOf('this._usernodeGated = true;') !== -1
    && fn.indexOf('this._usernodeGated = true;') < firstAwait,
  'open() calls this without awaiting it, so the gate must be set synchronously');
  assert.match(sliceMethod(settingsJs, 'open'),
    /_renderAllSections\(\);\s*\n\s*\n\s*const visible = Settings\._visibleSections\(\);/,
    'open() resolves the section only after the sections (and the gate) have rendered');
});

test('a deep link that beats its gate is finished once the gate opens', () => {
  const { Settings } = makeSettings({ nodeHidden: true });
  Settings._notePendingSection('usernode', false);
  assert.equal(Settings._pendingSection, 'usernode', 'remembered: registered, gated, not yet offered');

  Settings._renderNavIfOpen();
  assert.deepEqual(Settings.calls.filter((c) => c.startsWith('route')), [],
    'nothing happens while the gate is still shut');
  assert.equal(Settings._pendingSection, 'usernode');

  Settings._usernodeGated = true;
  Settings._renderNavIfOpen();
  assert.ok(Settings.calls.includes('route:usernode'), 'the gate opened: the route is finished');
  assert.equal(Settings._pendingSection, null, 'spent exactly once');
});

test('a viewer who moved on is not pulled back, and only gated keys are remembered', () => {
  const { Settings, location } = makeSettings({ nodeHidden: true });
  Settings._notePendingSection('usernode', false);
  location.hash = '#settings/theme';
  Settings._usernodeGated = true;
  Settings._renderNavIfOpen();
  assert.ok(!Settings.calls.includes('route:usernode'), 'the address no longer asks for it');
  assert.equal(Settings._pendingSection, null);

  Settings._notePendingSection('theme', false);
  assert.equal(Settings._pendingSection, null, 'an ungated section is never pending');
  Settings._notePendingSection('no-such-section', false);
  assert.equal(Settings._pendingSection, null, 'nor is an unknown one');
  Settings._notePendingSection('usernode', true);
  assert.equal(Settings._pendingSection, null, 'nor one that resolved');
});

test('open(), route() and close() maintain the pending link', () => {
  const open = sliceMethod(settingsJs, 'open');
  assert.match(open, /Settings\._pendingSection = null;[^]*_renderAllSections\(\)/,
    'open() drops a stale one before it renders');
  assert.match(open, /Settings\._notePendingSection\(section, valid\);/);
  assert.match(sliceMethod(settingsJs, 'route'), /Settings\._notePendingSection\(section, valid\);/);
  assert.match(sliceMethod(settingsJs, 'close'), /Settings\._pendingSection = null;/);
});
