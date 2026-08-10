'use strict';

// Where the venue answer is SHOWN.
//
// tests/build-venues.test.js pins the list and its gating; this file pins
// the three surfaces that put the answer in front of somebody:
//
//   1. the line above the composer, which states the venue on first paint
//      and carries the only control that changes it;
//   2. the chip on a session card in the dev feed, so the answer is
//      readable from the list without opening the chat;
//   3. the fallback note, for the one case where the venue you got is not
//      the venue you asked for.
//
// The failure this guards is not "the wrong label rendered" — it is the
// pre-#1086 state, where nothing rendered at all. A session's venue was
// decided by resolveDefaultAgentPreference on the server, silently, and
// the only way to find out what had been chosen was to read the billing
// note under a dropdown that was about something else. So most assertions
// here are about PRESENCE and about the paths that must not be able to
// swallow it.
//
// Run with: node --test tests/venue-surfaces.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const DEV_CHAT_SRC = read('public/js/dev-chat.js');
const APP_VIEW_SRC = read('public/js/app-view.js');
const SESSIONS_SRC = read('src/routes/sessions.js');
const APP_CSS = read('public/css/app.css');

// Same loader as tests/venue-labels.test.js: a classic script against a
// bare `window`, which is the realm this module actually runs in.
function loadBuildVenues() {
  const sandbox = { window: {}, module: { exports: {} }, document: undefined };
  sandbox.self = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/build-venues.js'), sandbox, {
    filename: 'public/js/build-venues.js',
  });
  return sandbox.window.BuildVenues || sandbox.module.exports;
}

const BV = loadBuildVenues();

// ── 1. The line above the composer ───────────────────────────────────

test('the line states a venue for every session, with no empty case', () => {
  // Every venue must produce a line. A venue that rendered '' would put
  // the composer back exactly where it was: no statement, and no door to
  // the sheet either, since the change button lives inside the line.
  for (const v of BV.VENUES) {
    const html = BV.lineHtml({ current: v.id });
    assert.ok(html.includes('data-venue-line="' + v.id + '"'), `${v.id} renders a line`);
    assert.ok(html.includes(v.label), `${v.id} names itself`);
    assert.ok(html.includes('data-venue-change="1"'), `${v.id} offers the change control`);
  }
});

test('an unknown venue id renders nothing rather than a half sentence', () => {
  // `current` is derived from session columns, which are server data. A
  // value this list does not know about must not produce "Building in ".
  assert.equal(BV.lineHtml({ current: 'nonsense' }), '');
  assert.equal(BV.lineHtml({ current: 'constructor' }), '',
    'including the prototype-chain members a bare lookup would answer');
});

test('the composer paints the line above its status row, not inside it', () => {
  // Inside the row it would be one chip among the meter, the runner and
  // the budget menu — the arrangement that made the venue invisible.
  const slot = DEV_CHAT_SRC.indexOf('id="dc-venue-slot"');
  const runner = DEV_CHAT_SRC.indexOf('id="dc-runner"');
  const budget = DEV_CHAT_SRC.indexOf('id="dc-budget"');
  assert.ok(slot !== -1, 'the slot exists');
  assert.ok(slot < runner && slot < budget, 'and it precedes the status row');
  assert.match(DEV_CHAT_SRC, /BuildVenues\.lineHtml\(\{/,
    'filled from the shared module, not retyped');
});

test('the line is painted from the session row, so first paint is right', () => {
  // Not from a status poll: a session whose venue only appeared after a
  // round trip would show the wrong venue for as long as that took, which
  // is precisely the moment someone is deciding whether to type.
  const fn = DEV_CHAT_SRC.slice(
    DEV_CHAT_SRC.indexOf('_currentVenueId() {'),
    DEV_CHAT_SRC.indexOf('\n  },', DEV_CHAT_SRC.indexOf('_currentVenueId() {'))
  );
  assert.ok(fn.length > 0, '_currentVenueId must exist');
  assert.match(fn, /BuildVenues\.currentVenue\(/,
    'the precedence chain lives in one place, not here');
});

test('the change control is disabled mid-turn, in both places that paint it', () => {
  // The old #dc-agent-select carried this guard: switching venue while a
  // turn is streaming would leave the reply arriving from somewhere the
  // line no longer names. Two sites set it — the render and the streaming
  // sync — and a guard on only one of them is a guard that opens itself
  // on the next repaint.
  const sites = DEV_CHAT_SRC.match(
    /#dc-venue-slot \[data-venue-change\]/g
  ) || [];
  assert.ok(sites.length >= 2, `expected the render and the sync to both find it (got ${sites.length})`);
  assert.match(DEV_CHAT_SRC, /venueChange\.disabled = DevChat\.isStreaming/,
    'and both set .disabled from the streaming flag');
});

test('the model row renders only for the venues that have a model', () => {
  // Four of the six have nothing to pick here — the chat model is a
  // Usernode-side setting, and showing it under "Building in your
  // computer" is half the confusion this line replaces.
  assert.match(DEV_CHAT_SRC, /venueId === 'usernode-claude' \|\| venueId === 'usernode-openrouter'/);
  assert.match(DEV_CHAT_SRC, /\$\{venueHasModel \? `/,
    'the detail block is conditional on it');
  // …which means #dc-model-select is now sometimes absent, and the wiring
  // has to survive that. An unguarded getElementById(...).addEventListener
  // would throw on every local / web / imported session.
  assert.ok(
    /const modelSelect = document\.getElementById\('dc-model-select'\);[\s\S]{0,200}?if \(modelSelect\)/.test(DEV_CHAT_SRC)
      || /getElementById\('dc-model-select'\)\?\./.test(DEV_CHAT_SRC),
    'the model-select wiring is null-guarded'
  );
});

// ── 2. The chip on a session card ────────────────────────────────────

test('the card chip names the venue and carries the blurb as its title', () => {
  const chip = BV.chipHtml('usernode-openrouter');
  assert.match(chip, /class="dc-venue-chip"/);
  assert.ok(chip.includes('Usernode · OpenRouter'));
  assert.match(chip, /title="/, 'the blurb is the hover explanation');
  assert.equal(BV.chipHtml('nonsense'), '', 'an unknown id renders no chip');
});

test('an imported proposal gets no chip, because it has no venue to be in', () => {
  // own-tools-pr is the one venue with no chat and no session — the work
  // already happened somewhere Usernode never saw. A chip saying "Your
  // computer · your own tools" on a card with no session behind it would
  // read as a place you could go.
  const fnStart = APP_VIEW_SRC.indexOf('_sessionVenueChipHtml(s) {');
  assert.ok(fnStart !== -1, '_sessionVenueChipHtml must exist');
  const fn = APP_VIEW_SRC.slice(fnStart, APP_VIEW_SRC.indexOf('\n  },', fnStart));
  assert.match(fn, /s\.source === 'imported'/, 'imported rows are excluded');
  assert.match(fn, /\bBV\.currentVenue\(/, 'and the rest resolve through the shared chain');
  assert.match(fn, /externalAgent: s\.external_agent/,
    'external_agent travels, or a handed-off session reads as a Usernode one');
});

test('the session list SELECT carries what the chip needs', () => {
  // A chip derived from `agent_backend` alone cannot tell an imported row
  // from a Usernode · Claude one: an imported row has a DEFAULTED backend
  // that no turn ever ran through. `source` and `external_agent` are the
  // two columns that make the difference expressible.
  const list = SESSIONS_SRC.slice(SESSIONS_SRC.indexOf('SELECT id, branch_name, pr_number'));
  const select = list.slice(0, list.indexOf('FROM chat_sessions'));
  for (const col of ['agent_backend', 'agent_model', 'source', 'external_agent']) {
    assert.ok(select.includes(col), `the list SELECT carries ${col}`);
  }
});

// ── 3. The fallback note ─────────────────────────────────────────────

test('every server fallback reason becomes a sentence', () => {
  // resolveDefaultAgentPreference is deliberately lenient — a session that
  // runs beats a 4xx — but until now the fallback was a log line and
  // nothing else. A reason with no copy is silence again.
  const fn = SESSIONS_SRC.slice(
    SESSIONS_SRC.indexOf('async function resolveDefaultAgentPreference('),
    SESSIONS_SRC.indexOf('\n}', SESSIONS_SRC.indexOf('async function resolveDefaultAgentPreference('))
  );
  const reasons = new Set();
  for (const m of fn.matchAll(/claudeFallback\('([a-z_]+)'\)/g)) reasons.add(m[1]);
  assert.ok(reasons.size >= 3, `the resolver produces reason codes (got ${reasons.size})`);
  for (const reason of reasons) {
    const note = BV.fallbackNote(reason);
    assert.ok(note.length > 0, `reason '${reason}' has no user-facing copy`);
    assert.ok(note.includes('Usernode · Claude'),
      `reason '${reason}' must name the venue it fell back TO`);
  }
});

test('a reason the client does not know about stays silent', () => {
  // The reason arrives on the 201 body, so it is server data. A bare
  // property lookup would answer `toString` with a function and render it
  // into the note.
  assert.equal(BV.fallbackNote('brand_new_reason'), '');
  assert.equal(BV.fallbackNote('toString'), '');
  assert.equal(BV.fallbackNote(null), '');
});

test('the client keeps the reason across the navigation into the session', () => {
  // The 201 arrives in createSession; the line that reports it is painted
  // after a tab switch, in a different call stack. Stashing it on DevChat
  // is what carries it across — and clearing it on paint is what stops it
  // reappearing on every later re-render of the same session.
  assert.match(DEV_CHAT_SRC, /DevChat\._venueFallbackReason = data\.agentFallbackReason/);
  assert.match(DEV_CHAT_SRC, /fallbackReason: DevChat\._venueFallbackReason \|\| /,
    'the stash is what the line reads');
  assert.match(DEV_CHAT_SRC, /DevChat\._venueFallbackReason = null;/,
    'cleared once painted');
});

test('the note is reviewable on staging without a failing credential', () => {
  // The reason is a creation-moment fact and is deliberately not stored, so
  // a seeded fixture row cannot produce one — every other venue state is a
  // column, this one is not. `?shot=venue-fallback` is the only way the
  // copy gets reviewed, and it must fall through the SAME fallbackNote
  // lookup, or a guessed reason would render an invented sentence.
  const fnStart = DEV_CHAT_SRC.indexOf('_shotVenueFallbackReason() {');
  assert.ok(fnStart !== -1, '_shotVenueFallbackReason must exist');
  const fn = DEV_CHAT_SRC.slice(fnStart, DEV_CHAT_SRC.indexOf('\n  },', fnStart));
  assert.match(fn, /shot !== 'venue-fallback'/, 'gated on the shot name');
  const fallback = fn.match(/return reason \|\| '([a-z_]+)'/);
  assert.ok(fallback, 'it names a default reason');
  assert.ok(BV.fallbackNote(fallback[1]).length > 0,
    `the default reason '${fallback?.[1]}' renders no copy`);
});

test('the headless routes report their fallback too', () => {
  // Three server paths resolve a default (new session, headless, clone);
  // all three already attach agentFallbackReason, and the client has a
  // reporter for the two that do not paint a composer line.
  const attached = SESSIONS_SRC.match(
    /\.\.\.\(pref\.fallbackReason \? \{ agentFallbackReason: pref\.fallbackReason \} : \{\}\)/g
  ) || [];
  assert.ok(attached.length >= 3,
    `every resolver call site reports its fallback (got ${attached.length})`);
  const fnStart = APP_VIEW_SRC.indexOf('_reportVenueFallback(reason) {');
  assert.ok(fnStart !== -1, '_reportVenueFallback must exist');
  const fn = APP_VIEW_SRC.slice(fnStart, APP_VIEW_SRC.indexOf('\n  },', fnStart));
  assert.match(fn, /BuildVenues\.fallbackNote\(reason\)/);
  assert.match(fn, /PlatformUI\.toast\(note\)/, 'and it is said out loud, not logged');
});

// ── 4. Styles ────────────────────────────────────────────────────────

test('every class these surfaces render has a rule', () => {
  // The shell's Tailwind is compiled and these are hand-written classes in
  // app.css; one that is not there simply has no styles, and the line
  // would render as an unstyled run of text under the composer.
  for (const cls of [
    'dc-venue-slot', 'dc-venue-line', 'dc-venue-name',
    'dc-venue-change', 'dc-venue-note', 'dc-venue-detail', 'dc-venue-chip',
  ]) {
    assert.ok(new RegExp('\\.' + cls + '[\\s,:{]').test(APP_CSS),
      `.${cls} has no rule in app.css`);
  }
});
