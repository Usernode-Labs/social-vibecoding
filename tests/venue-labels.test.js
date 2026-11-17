'use strict';

// The closed VENUE vocabulary.
//
// Before this test the product had two different things called "Claude
// Code" — the platform backend (chat_sessions.agent_backend='claude_code')
// and the web hand-off (users.dev_flow_preference='claude-code') — offered
// in menus inches apart, plus a third `claude-code` as an external_agent
// provenance value. Choosing one when you meant the other cost real money
// on the wrong plan, and nothing in the codebase stopped the two labels
// converging again.
//
// So the label set is pinned here, in ONE place, across every module that
// owns a copy of it. Renaming a venue means editing this list on purpose.
// Note what is NOT asserted: the ids. `claude_code`, `claude-code`,
// `codex_openrouter` and friends are persisted values and stay exactly as
// they are — this is a copy change, not a schema change.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const registry = require('../src/agents/registry');

// The six venues a change can be built in. Kept in sync with
// public/js/build-venues.js VENUES.
const VENUE_LABELS = {
  'usernode-claude': 'Homeroom · Claude',
  'usernode-openrouter': 'Homeroom · OpenRouter',
  local: 'Your computer · Homeroom session',
  'web-claude-code': 'Claude Code on the web',
  'web-codex': 'Codex on the web',
  'own-tools-pr': 'Your computer · your own tools',
};

// Labels that must NOT come back. Each one was ambiguous about WHERE the
// work happens, which is the whole failure this vocabulary fixes.
const RETIRED_LABELS = [
  'Claude Code (OpenRouter BYOK)',
  'Codex (OpenRouter BYOK)',
  'Codex via OpenRouter',
  'Build it here on Homeroom',
  'Build it with Claude Code',
  'Build it with Codex',
  'Carry on in Claude Code',
  'Carry on in Codex',
  'Use a coding tool on your computer',
  'Run this session on your computer',
];

// Load a public/js module the way the browser does — as a classic script
// against a bare `window` — rather than through require(). That is the
// environment the drift happens in, and it is the one where a module that
// reads window.BuildVenues has to find it. build-venues.js is evaluated
// into the same sandbox first, in the same order the shell loads it
// (tests/shell-script-order.test.js pins that order for real).
function loadBrowserModule(relPath, globalName) {
  const sandbox = { window: {}, module: { exports: {} }, document: undefined };
  sandbox.self = sandbox.window;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  for (const dep of ['public/js/build-venues.js', relPath]) {
    const src = fs.readFileSync(path.join(__dirname, '..', dep), 'utf8');
    sandbox.module = { exports: {} };
    vm.runInContext(src, sandbox, { filename: dep });
  }
  return sandbox.window[globalName] || sandbox.module.exports;
}

function run(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('venue labels');

run('the backend registry uses the two in-chat venue labels', () => {
  assert.strictEqual(registry.BACKENDS.claude_code.label, VENUE_LABELS['usernode-claude']);
  assert.strictEqual(registry.BACKENDS.codex_openrouter.label, VENUE_LABELS['usernode-openrouter']);
  // Ids unchanged — the persisted values must not move with the copy.
  assert.strictEqual(registry.BACKENDS.claude_code.id, 'claude_code');
  assert.strictEqual(registry.BACKENDS.codex_openrouter.id, 'codex_openrouter');
});

run('build-venues.js is the single list and matches this vocabulary', () => {
  const BuildVenues = loadBrowserModule('public/js/build-venues.js', 'BuildVenues');
  // The list itself is module-private; a stored build_venue names a venue
  // verbatim, so each id is reached through the one function a change card
  // reads (sessionVenue).
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'public/js/build-venues.js'), 'utf8');
  const list = SRC.slice(SRC.indexOf('var VENUES = ['), SRC.indexOf('];', SRC.indexOf('var VENUES = [')));
  const ids = Array.from(list.matchAll(/^\s*id: '([^']+)',/gm), (m) => m[1]);
  assert.strictEqual(ids.length, 6, 'expected exactly six venues');
  for (const [id, label] of Object.entries(VENUE_LABELS)) {
    assert.ok(ids.includes(id), `missing venue ${id}`);
    const v = BuildVenues.sessionVenue({ buildVenue: id });
    assert.strictEqual(v && v.id, id, `venue ${id} does not resolve to itself`);
    assert.strictEqual(v.label, label, `venue ${id} label drifted`);
  }
});

// A retired label may legitimately appear inside a comment that EXPLAINS
// the rename — that is documentation, not a shipped string. Strip comments
// first so the guard looks only at code. Crude but sufficient: these are
// plain ES5 modules with no regex literals containing `//`.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

run('no retired label survives in any copy-owning module', () => {
  const files = [
    'src/agents/registry.js',
    'public/js/build-venues.js',
    'public/js/credit-options.js',
  ];
  for (const rel of files) {
    const src = stripComments(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
    for (const retired of RETIRED_LABELS) {
      const quoted = [`'${retired}'`, `"${retired}"`, `\`${retired}\``];
      for (const needle of quoted) {
        assert.ok(
          !src.includes(needle),
          `${rel} still ships the retired label ${needle}`,
        );
      }
    }
  }
});
