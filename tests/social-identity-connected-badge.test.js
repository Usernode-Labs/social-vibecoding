// A connected social account says so, on the row it is about (#1557).
//
// The OAuth round trip already writes a one-line result into
// `#github-link-status` ("GitHub connected."). That line is transient, xs, and
// a SIBLING of the provider block — come back to Settings a minute later and
// the only thing separating a connected account from an unconnected one was a
// sentence about credit tiers.
//
// So the row carries a badge. The interesting part is what it does NOT say:
// a `reconnectRequired` link is linked for GitHub attribution but is not yet
// credit-eligible, and calling that "Connected" would paper over exactly the
// distinction its amber state text exists to draw.
//
// Run with: node --test tests/social-identity-connected-badge.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SETTINGS = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/settings/settings.js'), 'utf8');
const VIEW = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/settings/social-identity.tsx'), 'utf8');

/** The badge decision, lifted out of _socialIdentityRowView's source. */
function badgeFor(link) {
  const at = SETTINGS.indexOf('badge: link.reconnectRequired');
  assert.notEqual(at, -1, 'the badge decision is still made in the row view');
  // Evaluated rather than re-implemented, so this test cannot drift from it.
  const expr = SETTINGS.slice(at + 'badge: '.length, SETTINGS.indexOf('\n        state,', at));
  // eslint-disable-next-line no-new-func
  return Function('link', `return (${expr.trim().replace(/,$/, '')});`)(link);
}

test('a linked account is badged Connected', () => {
  assert.deepEqual(badgeFor({ linked: true }), { text: 'Connected', tone: 'emerald' });
});

test('an unlinked account is badged nothing at all', () => {
  assert.equal(badgeFor({ linked: false }), null);
  assert.equal(badgeFor({}), null);
});

test('a legacy link that still needs a reconnect is not called Connected', () => {
  // It is linked for attribution and not credit-eligible; the amber row text
  // says so, and the badge must not contradict it.
  assert.deepEqual(
    badgeFor({ linked: true, reconnectRequired: true }),
    { text: 'Reconnect needed', tone: 'amber' });
});

test('the badge renders as read-only text, not as a pressable control', () => {
  const row = VIEW.slice(VIEW.indexOf('function ProviderRow'));
  const head = row.slice(0, row.indexOf('row.state.text'));
  assert.match(head, /<span/, 'a span, not a button');
  assert.doesNotMatch(head, /aria-pressed/,
    'announcing a status as a pressed button is wrong on a screen reader');
  assert.match(head, /id=\{`\$\{row\.provider\}-link-badge`\}/,
    'addressable per provider');
  // Tailwind extracts by regex over source text, so the tints must be whole
  // literals rather than assembled at runtime.
  assert.match(VIEW, /emerald: 'bg-emerald-500\/10 text-emerald-700 dark:text-emerald-400'/);
  assert.match(VIEW, /amber: 'bg-amber-500\/10 text-amber-800 dark:text-amber-400'/);
});

test('the heading still truncates beside it', () => {
  // The badge is shrink-0 and the heading min-w-0/truncate, so a long
  // "GitHub · @a-very-long-handle" loses characters rather than pushing the
  // badge out of the row.
  const row = VIEW.slice(VIEW.indexOf('function ProviderRow'));
  const head = row.slice(0, row.indexOf('row.state.text'));
  assert.match(head, /min-w-0/);
  assert.match(head, /truncate/);
  assert.match(VIEW, /BADGE_BASE =\s*\n?\s*'shrink-0/);
});
