// Topochain §8 data-load tooling (Task 16; SPEC 3202-3321).
//
// Two layers, no live database required for either:
//   1. Unit tests over the pure transforms scripts/topochain-load.js
//      exports — normalizeEmail, mergeParticipants (the subtlest part:
//      canonical selection by earliest created_at, then newest-non-null
//      coalescing across the whole duplicate-email group),
//      rewritePasswordHash ($2y$ -> $2b$ rewrite / random-unusable-hash
//      branch), deriveScopeColumns, and the award-backfill row mapper
//      (mapBackfillRow / buildBackfillMetadata).
//   2. Static source-text assertions proving the PRIME DIRECTIVE holds:
//      the source connection is opened read-only two independent ways,
//      the script refuses to start without --i-have-restored-a-dump, and
//      — the one a human reviewer can't easily eyeball across a file
//      this size — every single read from the source pool goes through
//      one wrapper (querySource) and every call site passed to it is a
//      SELECT/WITH, never an INSERT/UPDATE/DELETE/COPY-FROM.
//
// Run with: node --test tests/topochain-load.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeEmail,
  mergeParticipants,
  rewritePasswordHash,
  deriveScopeColumns,
  buildBackfillMetadata,
  mapBackfillRow,
} = require('../scripts/topochain-load');

const loadSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts/topochain-load.js'), 'utf8');
const validateSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts/topochain-validate.js'), 'utf8');

// ═════════════════════════════════════════════════════════════════════
// 1. normalizeEmail
// ═════════════════════════════════════════════════════════════════════

test('normalizeEmail: lowercases and trims', () => {
  assert.equal(normalizeEmail('  User@Example.COM  '), 'user@example.com');
});

test('normalizeEmail: null/undefined become an empty string, not a crash', () => {
  assert.equal(normalizeEmail(null), '');
  assert.equal(normalizeEmail(undefined), '');
});

// ═════════════════════════════════════════════════════════════════════
// 2. mergeParticipants — canonical selection + newest-non-null coalesce
// ═════════════════════════════════════════════════════════════════════

test('mergeParticipants: a unique email is untouched, id map is identity', () => {
  const rows = [
    { id: 1, email: 'solo@example.com', created_at: '2026-01-01T00:00:00Z', display_name: 'Solo' },
  ];
  const { canonicalRows, idMap } = mergeParticipants(rows);
  assert.equal(canonicalRows.length, 1);
  assert.equal(canonicalRows[0].display_name, 'Solo');
  assert.equal(canonicalRows[0]._canonical_source_id, 1);
  assert.deepEqual(canonicalRows[0]._source_ids, [1]);
  assert.equal(idMap.get(1), 1);
});

test('mergeParticipants: canonical row is the EARLIEST by created_at, regardless of insertion order', () => {
  // Row 2 is earliest even though it appears second in the input array —
  // the merge must sort by created_at, not trust array order or id order.
  const rows = [
    { id: 5, email: 'dup@example.com', created_at: '2026-03-01T00:00:00Z', display_name: 'Later' },
    { id: 2, email: 'DUP@example.com', created_at: '2026-01-15T00:00:00Z', display_name: null },
  ];
  const { canonicalRows, idMap } = mergeParticipants(rows);
  assert.equal(canonicalRows.length, 1);
  const canonical = canonicalRows[0];
  assert.equal(canonical._canonical_source_id, 2, 'the earlier-created row (id 2) is canonical');
  assert.equal(canonical.created_at, '2026-01-15T00:00:00Z', 'canonical created_at is the earliest, not coalesced');
  assert.deepEqual(new Set(canonical._source_ids), new Set([5, 2]));
  // Every source id in the group points at the CANONICAL SOURCE id (2) —
  // mergeParticipants is a pure function with no DB access, so it can
  // only produce a source-id -> source-id map; the load step translates
  // this further into a source-id -> target-id map once it knows what id
  // the canonical row received on insert.
  assert.equal(idMap.get(5), 2);
  assert.equal(idMap.get(2), 2);
});

test('mergeParticipants: newest non-null value wins for every coalesced field', () => {
  const rows = [
    // earliest: sets telegram, leaves discord/github null
    { id: 1, email: 'a@example.com', created_at: '2026-01-01T00:00:00Z', telegram: '@old', discord: null, github: null },
    // middle: overwrites discord, leaves telegram/github alone (null)
    { id: 2, email: 'A@Example.com', created_at: '2026-01-10T00:00:00Z', telegram: null, discord: 'olddiscord#1', github: null },
    // newest: overwrites telegram again, leaves discord null (must NOT
    // blank out the middle row's discord value), sets github for the
    // first time
    { id: 3, email: 'a@example.com ', created_at: '2026-01-20T00:00:00Z', telegram: '@new', discord: null, github: 'newgh' },
  ];
  const { canonicalRows, idMap } = mergeParticipants(rows);
  assert.equal(canonicalRows.length, 1);
  const canonical = canonicalRows[0];
  assert.equal(canonical._canonical_source_id, 1, 'row 1 is earliest and thus canonical');
  assert.equal(canonical.email, 'a@example.com', 'email is normalized on the canonical row');
  assert.equal(canonical.telegram, '@new', 'newest non-null telegram (row 3) wins over row 1\'s');
  assert.equal(canonical.discord, 'olddiscord#1', 'row 2\'s non-null discord survives row 3\'s null (nulls never overwrite)');
  assert.equal(canonical.github, 'newgh', 'first-ever non-null github (row 3) is picked up');
  assert.deepEqual(new Set(canonical._source_ids), new Set([1, 2, 3]));
  for (const id of [1, 2, 3]) assert.equal(idMap.get(id), 1);
});

test('mergeParticipants: ties in created_at break on the smaller source id', () => {
  const rows = [
    { id: 9, email: 'tie@example.com', created_at: '2026-01-01T00:00:00Z', display_name: 'Nine' },
    { id: 4, email: 'tie@example.com', created_at: '2026-01-01T00:00:00Z', display_name: null },
  ];
  const { canonicalRows } = mergeParticipants(rows);
  assert.equal(canonicalRows[0]._canonical_source_id, 4);
});

test('mergeParticipants: two independent duplicate groups stay independent', () => {
  const rows = [
    { id: 1, email: 'x@example.com', created_at: '2026-01-01T00:00:00Z' },
    { id: 2, email: 'x@example.com', created_at: '2026-01-02T00:00:00Z' },
    { id: 3, email: 'y@example.com', created_at: '2026-01-01T00:00:00Z' },
  ];
  const { canonicalRows, idMap } = mergeParticipants(rows);
  assert.equal(canonicalRows.length, 2, '200-ish participants with 8 duplicate groups collapses per-group, not globally');
  assert.equal(idMap.get(3), 3);
});

// ═════════════════════════════════════════════════════════════════════
// 3. rewritePasswordHash
// ═════════════════════════════════════════════════════════════════════

test('rewritePasswordHash: rewrites the $2y$ (PHP bcrypt) prefix to $2b$ and keeps passwordSet true', () => {
  const source = '$2y$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
  const { hash, passwordSet } = rewritePasswordHash(source);
  assert.equal(hash, '$2b$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
  assert.equal(passwordSet, true);
});

test('rewritePasswordHash: a hash with no $2y$ prefix passes through unchanged', () => {
  const source = '$2b$10$alreadyNodeStyleHashHere0123456789012345678901234567';
  const { hash, passwordSet } = rewritePasswordHash(source);
  assert.equal(hash, source);
  assert.equal(passwordSet, true);
});

test('rewritePasswordHash: null/empty password gets a random unusable hash and passwordSet false', () => {
  const fakeRandomBytes = () => Buffer.from('00'.repeat(32), 'hex');
  const fakeBcrypt = { hashSync: (input, cost) => `FAKE:${input}:${cost}` };
  const { hash, passwordSet } = rewritePasswordHash(null, { randomBytesFn: fakeRandomBytes, bcryptImpl: fakeBcrypt });
  assert.equal(passwordSet, false);
  assert.equal(hash, `FAKE:${'00'.repeat(32)}:10`);
});

test('rewritePasswordHash: two null-password calls produce different hashes (real randomness, no injection)', () => {
  const a = rewritePasswordHash(undefined);
  const b = rewritePasswordHash(undefined);
  assert.equal(a.passwordSet, false);
  assert.equal(b.passwordSet, false);
  assert.notEqual(a.hash, b.hash, 'each unusable hash must be freshly random, never reused across rows');
});

// ═════════════════════════════════════════════════════════════════════
// 4. deriveScopeColumns
// ═════════════════════════════════════════════════════════════════════

test('deriveScopeColumns: resolves season_id from the event via the map', () => {
  const map = new Map([[42, 7]]);
  assert.deepEqual(deriveScopeColumns(42, map), { season_event_id: 42, season_id: 7 });
});

test('deriveScopeColumns: null/undefined event id passes through as a season-wide (null, null) row', () => {
  const map = new Map();
  assert.deepEqual(deriveScopeColumns(null, map), { season_event_id: null, season_id: null });
  assert.deepEqual(deriveScopeColumns(undefined, map), { season_event_id: null, season_id: null });
});

test('deriveScopeColumns: throws on an event id the map does not know about', () => {
  const map = new Map([[1, 1]]);
  assert.throws(() => deriveScopeColumns(999, map), /unknown season_event_id 999/);
});

// ═════════════════════════════════════════════════════════════════════
// 5. Award-backfill row mapper
// ═════════════════════════════════════════════════════════════════════

test('mapBackfillRow: flash_challenge_completions with no existing activity inserts a zero-point completion', () => {
  const row = { offchain_activity_id: null, created_at: '2026-02-01T00:00:00Z' };
  const result = mapBackfillRow('flash_challenge_completions', row, { userId: 10, challengeId: 20, seasonEventId: 30 });
  assert.equal(result.mode, 'insert');
  assert.equal(result.row.user_id, 10);
  assert.equal(result.row.season_event_id, 30);
  assert.equal(result.row.challenge_id, 20);
  assert.equal(result.row.points, 0);
  assert.equal(result.row.source, 'migration');
  assert.deepEqual(result.row.metadata, { origin: 'flash_challenge_completions', kind: 'challenge_completion' });
});

test('mapBackfillRow: zkpassport_completions carries session_id and nullifier_hex into metadata', () => {
  const row = {
    offchain_activity_id: null,
    session_id: 'sess-123',
    nullifier_hex: '0xdead',
    completed_at: '2026-02-02T00:00:00Z',
  };
  const result = mapBackfillRow('zkpassport_completions', row, { userId: 11, challengeId: 21, seasonEventId: 31 });
  assert.equal(result.mode, 'insert');
  assert.deepEqual(result.row.metadata, {
    origin: 'zkpassport_completions',
    kind: 'challenge_completion',
    session_id: 'sess-123',
    nullifier_hex: '0xdead',
  });
  assert.equal(result.row.activity_at, '2026-02-02T00:00:00Z');
});

test('mapBackfillRow: activity_extra_points carries its real point value, reason and wallet_address', () => {
  const row = {
    offchain_activity_id: null,
    points: '2867.50',
    reason: 'Community moderation bonus',
    wallet_address: 'ut1abc',
    created_at: '2026-02-03T00:00:00Z',
  };
  const result = mapBackfillRow('activity_extra_points', row, { userId: 12, challengeId: 22, seasonEventId: 32 });
  assert.equal(result.mode, 'insert');
  assert.equal(result.row.points, 2867.5);
  assert.equal(result.row.activity_type, 'bonus_points');
  assert.deepEqual(result.row.metadata, {
    origin: 'activity_extra_points',
    kind: 'extra_points',
    reason: 'Community moderation bonus',
    wallet_address: 'ut1abc',
  });
});

test('mapBackfillRow: a row already linked to an activity is reconciled, not duplicated', () => {
  const row = { offchain_activity_id: 555, session_id: 'sess-999', nullifier_hex: '0xbeef' };
  const result = mapBackfillRow('zkpassport_completions', row, { userId: 13, challengeId: 23, seasonEventId: 33 });
  assert.equal(result.mode, 'reconcile');
  assert.equal(result.sourceOffchainActivityId, 555);
  assert.deepEqual(result.metadataPatch, {
    origin: 'zkpassport_completions',
    kind: 'challenge_completion',
    session_id: 'sess-999',
    nullifier_hex: '0xbeef',
  });
});

test('buildBackfillMetadata: activity_extra_points omits reason/wallet_address when absent, never emits null', () => {
  const metadata = buildBackfillMetadata('activity_extra_points', {});
  assert.deepEqual(metadata, { origin: 'activity_extra_points', kind: 'extra_points' });
  assert.equal('reason' in metadata, false);
  assert.equal('wallet_address' in metadata, false);
});

// ═════════════════════════════════════════════════════════════════════
// 6. PRIME DIRECTIVE — static source-text assertions
// ═════════════════════════════════════════════════════════════════════

test('topochain-load.js refuses to start without --i-have-restored-a-dump', () => {
  assert.match(loadSrc, /iHaveRestoredADump/);
  assert.match(loadSrc, /--i-have-restored-a-dump/);
  assert.match(loadSrc, /Refusing to start/);
});

test('the source connection is hardened read-only two independent ways', () => {
  assert.match(loadSrc, /options:\s*'-c default_transaction_read_only=on'/,
    'the connection options string sets default_transaction_read_only=on');
  assert.match(loadSrc, /SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY/,
    'every new source connection also runs the SET statement');
});

test('validate.js applies the same read-only hardening to its own standalone source connection', () => {
  assert.match(validateSrc, /options:\s*'-c default_transaction_read_only=on'/);
  assert.match(validateSrc, /SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY/);
});

// The load script must refuse to touch the source at all without the
// flag, and (separately) it must never MUTATE the source once it does
// touch it — both matter, so both are asserted.
test('scripts/topochain-load.js: sourcePool.query is called in exactly one place (the querySource wrapper)', () => {
  const occurrences = [...loadSrc.matchAll(/sourcePool\.query\(/g)];
  assert.equal(
    occurrences.length, 1,
    'every source read must funnel through querySource() so it can be statically audited — found ' +
      `${occurrences.length} direct sourcePool.query( call site(s)`
  );
});

test('scripts/topochain-validate.js: sourcePool.query is called in exactly one place (the querySource wrapper)', () => {
  const occurrences = [...validateSrc.matchAll(/sourcePool\.query\(/g)];
  assert.equal(occurrences.length, 1, `found ${occurrences.length} direct sourcePool.query( call site(s)`);
});

// Extracts the full text of every `querySource(...)` call (balanced on
// parens) so each call site's embedded SQL can be checked for forbidden
// verbs without needing a full SQL parser — the call text includes
// whatever quoting style (template literal, single/double quote) the
// SQL argument uses, so a substring/regex scan over the whole call is
// robust to that variation.
function extractQuerySourceCalls(source) {
  const calls = [];
  const marker = 'querySource(';
  let idx = 0;
  while ((idx = source.indexOf(marker, idx)) !== -1) {
    // Skip the function's own declaration line ("async function
    // querySource(sourcePool, sql, params) {") — only actual call sites
    // (invocations, not the definition) are checked below.
    const precedingText = source.slice(Math.max(0, idx - 'async function '.length), idx);
    if (precedingText.endsWith('function ')) {
      idx += marker.length;
      continue;
    }
    let depth = 1;
    let i = idx + marker.length;
    while (depth > 0 && i < source.length) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') depth--;
      i++;
    }
    calls.push(source.slice(idx, i));
    idx = i;
  }
  return calls;
}

const FORBIDDEN_VERBS = /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|GRANT|REVOKE|COPY)\b/i;

for (const [label, source] of [['topochain-load.js', loadSrc], ['topochain-validate.js', validateSrc]]) {
  test(`${label}: every querySource(sourcePool, ...) call site is a SELECT/WITH and never a mutating statement`, () => {
    const calls = extractQuerySourceCalls(source).filter((c) => /querySource\(\s*sourcePool\b/.test(c));
    // topochain-load.js funnels every read through fetchAll()/
    // iterateSourceBatches() (each a single querySource() call site
    // reused for every table), so it has fewer distinct call sites than
    // topochain-validate.js (whose gates each inline their own query).
    assert.ok(calls.length >= 2, `expected at least 2 querySource(sourcePool, ...) call sites in ${label}, found ${calls.length}`);
    for (const call of calls) {
      assert.match(call, /\bSELECT\b/i, `call site must contain a SELECT: ${call.slice(0, 100)}`);
      assert.doesNotMatch(call, FORBIDDEN_VERBS, `call site must not contain a mutating verb: ${call.slice(0, 150)}`);
    }
  });
}

// Function-definition wrapper itself is also checked, as a sanity bound:
// the ONE place sourcePool.query is invoked directly must be inside
// `async function querySource(...)`, not smuggled in somewhere else that
// also happens to be named querySource.
test('the sole sourcePool.query( call site lives inside the querySource() function body', () => {
  for (const source of [loadSrc, validateSrc]) {
    const defIdx = source.indexOf('async function querySource(sourcePool, sql, params)');
    assert.ok(defIdx >= 0, 'querySource is defined with the expected signature');
    const bodyEnd = source.indexOf('\n}', defIdx);
    const body = source.slice(defIdx, bodyEnd);
    assert.match(body, /sourcePool\.query\(/);
    // and nowhere else before/after within a reasonable window duplicates it directly
    const before = source.slice(0, defIdx);
    const after = source.slice(bodyEnd);
    assert.doesNotMatch(before, /sourcePool\.query\(/);
    assert.doesNotMatch(after, /sourcePool\.query\(/);
  }
});
