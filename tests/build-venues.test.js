// The six build venues: where a change's work happened, as its card's chip
// says it (public/js/build-venues.js sessionVenue, drawn through app-view.js
// `_sessionVenueChipSpec`; tests/venue-surfaces.test.js pins the chip).
//
// Two of the venues say "Claude Code" about two different products: the
// platform backend (chat_sessions.agent_backend='claude_code', billed to
// Homeroom) and the web hand-off (external_agent='claude-code', billed to the
// person's own Claude plan). What is pinned here is the rule that picks one
// from a change's columns, and that it keeps them apart:
//
//   1. STRUCTURAL FACTS FIRST. An imported proposal is the author's own tools
//      and a pull request, whatever its other columns say.
//   2. THEN THE STORED CHOICE (#1281, chat_sessions.build_venue), which
//      outranks every derived venue; an id this build does not know is
//      ignored rather than painted.
//   3. THEN DERIVATION from the columns, which keeps every row with no stored
//      choice correct with no backfill.
//   4. A CLI hand-off names the agent that actually wrote it.
//
// Run with: node --test tests/build-venues.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// The script under test reads its text from the language runtime's global;
// give it the real English one.
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
globalThis.PlatformI18n = englishPlatformI18n();

const BV = require('../public/js/build-venues.js');

const at = (state) => BV.sessionVenue(state).id;

test('each venue is derived from the column that records it, and reads its words from the catalog', () => {
  const cases = [
    [{}, 'usernode-claude', 'usernodeClaude'],
    [{ agentBackend: 'claude_code' }, 'usernode-claude', 'usernodeClaude'],
    [{ agentBackend: 'codex_openrouter' }, 'usernode-openrouter', 'usernodeOpenrouter'],
    [{ externalAgent: 'claude-code' }, 'web-claude-code', 'webClaudeCode'],
    [{ externalAgent: 'codex' }, 'web-codex', 'webCodex'],
    [{ source: 'imported' }, 'own-tools-pr', 'ownToolsPr'],
  ];
  for (const [state, id, key] of cases) {
    const v = BV.sessionVenue(state);
    assert.equal(v.id, id, JSON.stringify(state));
    assert.equal(v.label, message(`session:venue.${key}.label`), `${id} label`);
    assert.equal(v.blurb, message(`session:venue.${key}.blurb`), `${id} blurb`);
  }
  assert.equal(BV.sessionVenue({ agentBackend: 'claude_code' }).label, 'Homeroom · Claude');
  assert.equal(BV.sessionVenue({ externalAgent: 'codex' }).label, 'Codex on the web');
});

test('an imported proposal short-circuits everything', () => {
  // An imported proposal has an agent_backend column like any other row —
  // the insert defaults it — but no turn ever ran through it and none ever
  // will, so reading the backend would name a venue that is not merely
  // unused but structurally unreachable.
  assert.equal(at({ source: 'imported', agentBackend: 'codex_openrouter' }), 'own-tools-pr');
  assert.equal(at({ source: 'imported', externalAgent: 'codex' }), 'own-tools-pr');
  assert.equal(at({ source: 'imported', buildVenue: 'usernode-claude' }), 'own-tools-pr',
    'structural, so not even a stored choice overrides it');
});

test('a stored venue outranks the derived ones', () => {
  assert.equal(at({ buildVenue: 'web-claude-code' }), 'web-claude-code');
  assert.equal(at({ buildVenue: 'web-codex' }), 'web-codex');
  assert.equal(at({ buildVenue: 'own-tools-pr' }), 'own-tools-pr');
  assert.equal(
    at({ buildVenue: 'web-codex', agentBackend: 'codex_openrouter' }),
    'web-codex',
    'the stored choice wins over the backend the session was created with',
  );
  assert.equal(at({ buildVenue: 'usernode-openrouter', source: 'cli_handoff' }), 'usernode-openrouter');
});

test('an unrecognised stored value degrades to the derivation, never to itself', () => {
  // The column has a CHECK, but a row written by an older or newer
  // deployment must not paint a venue this build has never heard of.
  for (const bogus of ['web-gemini', 'nonsense', '', 'constructor', '__proto__', 'toString', 'claude_code']) {
    assert.equal(
      at({ buildVenue: bogus, agentBackend: 'codex_openrouter' }),
      'usernode-openrouter',
      `${bogus} must fall through to the derived venue`,
    );
  }
  // And with nothing to derive from, the default — not a crash.
  assert.equal(at({ buildVenue: 'toString' }), 'usernode-claude');
});

test('native handoffs retain their actual provider without becoming web sessions', () => {
  for (const [agent, label] of [['codex', 'Codex'], ['claude-code', 'Claude Code'], ['external', 'External agent'], [undefined, 'External agent']]) {
    const state = { source: 'cli_handoff', externalAgent: agent, agentBackend: 'claude_code' };
    assert.equal(at(state), 'local');
    assert.equal(BV.sessionVenue(state).label, label);
    assert.equal(BV.sessionVenue({ ...state, buildVenue: 'usernode-openrouter' }).label, 'Homeroom · OpenRouter');
  }
  assert.equal(BV.sessionVenue({ source: 'cli_handoff', externalAgent: 'codex' }).blurb,
    message('session:venue.handoff.authoredWithCodex'));
  assert.equal(BV.sessionVenue({ source: 'cli_handoff' }).blurb,
    message('session:venue.handoff.authoredWithExternalAgent'));
});
