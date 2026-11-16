// Where the venue answer is SHOWN.
//
// tests/build-venues.test.js pins the list and its rule; this file pins the
// surface that puts the answer in front of somebody: the chip on a change
// card in the Dev board, so where the work happened is readable from the
// list without opening the change.
//
// The failure this guards is not "the wrong label rendered" — it is the
// pre-#1086 state, where nothing rendered at all, and a card full of
// changes looked identical whether the work was billed to Homeroom credits,
// an OpenRouter key or a laptop. So most assertions here are about PRESENCE
// and about the columns that must reach the card for it to be right.
//
// Run with: node --test tests/venue-surfaces.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const APP_VIEW_SRC = read('public/js/app-view.js');
const SESSIONS_SRC = read('src/routes/sessions.js');
const APP_CSS = read('public/css/app.css');
const DEV_CARD_TSX = read('frontend/src/features/dev-board/card/dev-card.tsx');

// Same loader as tests/venue-labels.test.js: a classic script against a
// bare `window`, which is the realm this module actually runs in.
function loadBuildVenues() {
  const sandbox = { window: {}, module: { exports: {} }, document: undefined };
  sandbox.self = sandbox.window;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/build-venues.js'), sandbox, {
    filename: 'public/js/build-venues.js',
  });
  return sandbox.window.BuildVenues || sandbox.module.exports;
}

const BV = loadBuildVenues();

// ── 1. The chip on a change card ─────────────────────────────────────

// The chip is resolved by `_sessionVenueChipSpec` and drawn as
// card/dev-card.tsx's `venue` badge.
const extract = (source, signature) => {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `${signature} must exist`);
  const end = source.indexOf('\n  },', start);
  return source.slice(start + signature.length, end);
};
// The chip's tooltip is a catalog message, so the body is handed the English runtime.
const cardBody = new Function('s', 'window', 'PlatformI18n', extract(APP_VIEW_SRC, '_sessionVenueChipSpec(s) {'));
const card = (s) => cardBody(s, { BuildVenues: BV }, englishPlatformI18n());

test('the card chip names the venue and carries the blurb as its title', () => {
  const chip = card({ agent_backend: 'codex_openrouter' });
  assert.equal(chip.t, 'venue');
  assert.equal(chip.label, 'Homeroom · OpenRouter');
  const v = BV.sessionVenue({ agentBackend: 'codex_openrouter' });
  assert.ok(chip.title.includes(v.blurb), 'the blurb is the hover explanation');
  assert.match(DEV_CARD_TSX, /case 'venue':\s*\n\s*return <span className="dc-venue-chip" title=\{b\.title\}>\{b\.label\}<\/span>;/,
    'the card draws the label, with the title as its tooltip');
});

test('an imported proposal gets no chip, because it has no venue to be in', () => {
  // own-tools-pr is the one venue with no chat and no session — the work
  // already happened somewhere Homeroom never saw. A chip saying "Your
  // computer · your own tools" on a card with no session behind it would
  // read as a place you could go.
  // The chip's MARKUP is card/dev-card.tsx's `venue` badge since #1367's
  // card chunk; the resolution — which is what this test is about — is
  // `_sessionVenueChipSpec`.
  const fnStart = APP_VIEW_SRC.indexOf('_sessionVenueChipSpec(s) {');
  assert.ok(fnStart !== -1, '_sessionVenueChipSpec must exist');
  const fn = APP_VIEW_SRC.slice(fnStart, APP_VIEW_SRC.indexOf('\n  },', fnStart));
  assert.match(fn, /s\.source === 'imported'/, 'imported rows are excluded');
  assert.match(fn, /\bBV\.sessionVenue\(/, 'and the rest resolve through the shared chain');
  assert.match(fn, /externalAgent: s\.external_agent/,
    'external_agent travels, or a handed-off session reads as a Homeroom one');
});

test('the session list SELECT carries what the chip needs', () => {
  // A chip derived from `agent_backend` alone cannot tell an imported row
  // from a Homeroom · Claude one: an imported row has a DEFAULTED backend
  // that no turn ever ran through. `source` and `external_agent` are the
  // two columns that make the difference expressible.
  const list = SESSIONS_SRC.slice(SESSIONS_SRC.indexOf('SELECT id, branch_name, pr_number'));
  const select = list.slice(0, list.indexOf('FROM chat_sessions'));
  for (const col of ['agent_backend', 'agent_model', 'source', 'external_agent']) {
    assert.ok(select.includes(col), `the list SELECT carries ${col}`);
  }
});

// ── 2. Styles ────────────────────────────────────────────────────────

test('the class the chip renders has a rule', () => {
  // The shell's Tailwind is compiled and this is a hand-written class in
  // app.css; one that is not there simply has no styles, and the chip would
  // render as an unstyled run of text on the card.
  for (const cls of ['dc-venue-chip']) {
    assert.ok(new RegExp('\\.' + cls + '[\\s,:{]').test(APP_CSS),
      `.${cls} has no rule in app.css`);
  }
});


test('the session card displays the native provider after reload', () => {
  for (const [agent, label] of [['codex', 'Codex'], ['claude-code', 'Claude Code'], [null, 'External agent']]) {
    const session = { source: 'cli_handoff', external_agent: agent, agent_backend: 'claude_code' };
    assert.equal(card(session).label, label);
  }
});


test('all session lists serialize the identity needed by provider badges', () => {
  for (const route of ['/api/me/active-sessions', '/api/apps/:slug/sessions', '/api/apps/:slug/shared-sessions']) {
    const start = SESSIONS_SRC.indexOf("router.get('" + route + "'");
    assert.ok(start >= 0, route);
    const select = SESSIONS_SRC.indexOf('`SELECT', start);
    const query = SESSIONS_SRC.slice(select, SESSIONS_SRC.indexOf('FROM chat_sessions', select));
    for (const field of ['source', 'external_agent', 'build_venue', 'agent_backend']) {
      assert.ok(query.includes(field), route + ' includes ' + field);
    }
  }
});
