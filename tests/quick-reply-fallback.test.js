'use strict';

// Guaranteed quick-reply pills (#894).
//
// Background: the dev-chat pill bar renders from the newest message
// carrying metadata.quickReplies, and those pills came ONLY from the
// Mayor's optional suggest_replies tool. Production turns skip it
// routinely (a chat reply with `toolUses: 0`, a wrap-up that ends
// `end_turn`), and several turn-end paths — worker-busy, stop-during-run,
// refusal, provider error — never reach a pill-bearing persist at all. The
// bar then stays empty until the user types something themselves, which is
// the reported symptom ("suggested dev chat options have kind of stopped
// showing up").
//
// Three layers now guarantee the pills, and this file covers all three:
//   1. the deterministic policy in services/recovery-pills.js;
//   2. the server substituting it at every turn-end path in routes/sessions.js;
//   3. the client's last-resort default for rows that predate the guarantee.
//
// Layers 2 and 3 are source-invariant tests (repo convention for
// closure-internal logic): they read the source and assert the wiring
// rather than booting a server or a browser.
//
// Run with: node --test tests/quick-reply-fallback.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const recoveryPills = require('../src/services/recovery-pills.js');
const { sanitizeQuickReplies } = require('../src/routes/sessions.js');

const {
  RECOVERY_PILLS,
  QR_MAX_REPLIES,
  QR_MAX_REPLY_LEN,
  fallbackKindForTurn,
  turnFallbackQuickReplies,
} = recoveryPills;

const SESSIONS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'sessions.js'),
  'utf8'
);
const DEVCHAT_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'dev-chat.js'),
  'utf8'
);

// ── 1. The policy ────────────────────────────────────────────────────

test('new pill kinds exist with the wording the spec fixed', () => {
  assert.deepEqual([...RECOVERY_PILLS.chat_generic],
    ['Make a change', 'What issues are open right now?', "What's the current state?"]);
  assert.deepEqual([...RECOVERY_PILLS.build_running],
    ["How's it going?", 'Stop this build']);
  assert.deepEqual([...RECOVERY_PILLS.turn_failed],
    ['Try that again', 'What went wrong?']);
});

test('every pill set round-trips through the route sanitizer unchanged', () => {
  // recovery-pills.js deliberately does NOT require routes/sessions.js
  // (services → routes cycle), so the sanitizer contract is asserted here
  // instead: <= 3 entries, <= 80 chars, no case-insensitive dupes.
  for (const [kind, pills] of Object.entries(RECOVERY_PILLS)) {
    const arr = [...pills];
    assert.ok(arr.length > 0 && arr.length <= QR_MAX_REPLIES, `${kind}: 1..${QR_MAX_REPLIES} entries`);
    for (const p of arr) {
      assert.ok(p.length <= QR_MAX_REPLY_LEN, `${kind}: "${p}" fits ${QR_MAX_REPLY_LEN} chars`);
    }
    assert.deepEqual(sanitizeQuickReplies({ replies: arr }), arr,
      `${kind} survives sanitizeQuickReplies unchanged`);
  }
});

test('fallbackKindForTurn: dispatch outcomes ignore session state', () => {
  for (const state of [{}, { hasPr: true }, { hasSpec: true }, { hasPr: true, hasSpec: true }]) {
    assert.equal(fallbackKindForTurn({ outcome: 'build_done', ...state }), 'code_done');
    assert.equal(fallbackKindForTurn({ outcome: 'spec_done', ...state }), 'spec_done');
    assert.equal(fallbackKindForTurn({ outcome: 'failed', ...state }), 'turn_failed');
    assert.equal(fallbackKindForTurn({ outcome: 'stopped', ...state }), 'turn_failed');
    assert.equal(fallbackKindForTurn({ outcome: 'worker_busy', ...state }), 'build_running');
  }
});

test('fallbackKindForTurn: a chat turn derives its kind from session state', () => {
  // A PR means a build landed; else a spec means scout work landed; else
  // nothing has happened yet and we offer the ways in.
  assert.equal(fallbackKindForTurn({ outcome: 'chat', hasPr: true, hasSpec: true }), 'code_done');
  assert.equal(fallbackKindForTurn({ outcome: 'chat', hasPr: true, hasSpec: false }), 'code_done');
  assert.equal(fallbackKindForTurn({ outcome: 'chat', hasPr: false, hasSpec: true }), 'spec_done');
  assert.equal(fallbackKindForTurn({ outcome: 'chat', hasPr: false, hasSpec: false }), 'chat_generic');
});

test('fallbackKindForTurn: unknown/absent outcome degrades to the boot-sweep choice', () => {
  assert.equal(fallbackKindForTurn(), 'unknown_state');
  assert.equal(fallbackKindForTurn({}), 'unknown_state');
  assert.equal(fallbackKindForTurn({ outcome: 'nonsense' }), 'unknown_state');
  assert.equal(fallbackKindForTurn({ outcome: 'nonsense', hasPr: true }), 'code_done');
  assert.equal(fallbackKindForTurn({ outcome: 'nonsense', hasSpec: true }), 'spec_done');
});

test('turnFallbackQuickReplies materialises a fresh, non-empty array', () => {
  const a = turnFallbackQuickReplies({ outcome: 'build_done' });
  const b = turnFallbackQuickReplies({ outcome: 'build_done' });
  assert.deepEqual(a, ['Propose it to the group', 'Make a tweak', 'What did it change?']);
  assert.notEqual(a, b, 'each call returns its own array (callers JSON.stringify it)');
  a.push('mutated');
  assert.equal(b.length, 3, 'mutating one result must not affect the frozen source set');

  // Every outcome the chat handler passes must produce pills — the whole
  // point is that no path can end with nothing.
  for (const outcome of ['chat', 'build_done', 'spec_done', 'failed', 'stopped', 'worker_busy']) {
    const pills = turnFallbackQuickReplies({ outcome });
    assert.ok(Array.isArray(pills) && pills.length, `${outcome} yields pills`);
  }
});

// ── 2. Server wiring ─────────────────────────────────────────────────

test('the chat handler imports the fallback policy', () => {
  assert.match(SESSIONS_SRC, /turnFallbackQuickReplies\s*}\s*=\s*require\('\.\.\/services\/recovery-pills'\)/,
    'sessions.js must import turnFallbackQuickReplies from the policy module rather than inlining pill strings');
});

test('phase-1 routes its substitution through the shared predicate', () => {
  // The rule itself (which turns opt out) is unit-tested against the
  // exported shouldFallbackQuickReplies in tests/quick-replies.test.js;
  // this only pins the call site so the handler can't drift into its own
  // inline copy of the co-occurrence rules.
  const m = SESSIONS_SRC.match(/const quickReplies1 = shouldFallbackQuickReplies\(([\s\S]{0,200}?)\n/);
  assert.ok(m, 'found the phase-1 substitution');
  assert.match(m[1], /quickReplies, suggestions, mayor1\.toolUses/,
    'the predicate sees the resolved pills, the answer chips and the turn s tool calls');
  assert.match(SESSIONS_SRC, /shouldFallbackQuickReplies\(quickReplies, suggestions, mayor1\.toolUses\)\s*\n\s*\? turnPills\('chat'\)\s*\n\s*: quickReplies;/,
    "a fallback-eligible turn gets the 'chat' set; everything else keeps the model's own value");
});

test('phase-1 persists and broadcasts the substituted set, not the raw one', () => {
  // The row metadata and the live 'quick_replies' event must both use the
  // resolved value, or the pills exist in exactly one of DB / open UI.
  assert.match(SESSIONS_SRC, /quickReplies1 \? \{ quickReplies: quickReplies1 \} : \{\}/,
    'the phase-1 assistant row persists quickReplies1');
  assert.match(SESSIONS_SRC, /if \(quickReplies1\) send\('quick_replies', \{ replies: quickReplies1 \}\)/,
    'the phase-1 SSE/WS event carries quickReplies1');
});

test('the phase-2 wrap-up falls back by dispatch outcome', () => {
  const m = SESSIONS_SRC.match(/const wrapUpPills = quickReplies2 \|\| turnPills\(([\s\S]{0,200}?)\);/);
  assert.ok(m, 'found the phase-2 substitution');
  const arg = m[1];
  assert.match(arg, /toolResult\.isError\s*\?\s*'failed'/, 'a failed dispatch gets the retry pills');
  assert.match(arg, /toolKind === 'scout'\s*\?\s*'spec_done'/, 'a scout wrap-up gets the spec pills');
  assert.match(arg, /'build_done'/, 'a build wrap-up gets the post-build pills');

  assert.match(SESSIONS_SRC, /wrapUpPills \? \{ quickReplies: wrapUpPills \} : \{\}/,
    'the wrap-up row persists wrapUpPills');
  assert.match(SESSIONS_SRC, /if \(wrapUpPills\) send\('quick_replies', \{ replies: wrapUpPills \}\)/,
    'the wrap-up SSE/WS event carries wrapUpPills');
});

test('every status-only turn end carries pills on its status row', () => {
  // These paths never persist an assistant row, so the status line is the
  // only thing the client's backward scan can find.
  const sites = [
    [/Claude Code is already running for this session[\s\S]{0,200}?turnPills\('worker_busy'\)/,
      'worker-busy race'],
    [/refusalText\(selectedModel, refusalCategory\)[\s\S]{0,300}?turnPills\('failed'\)/,
      'whole-chain model refusal'],
    [/This turn failed: \$\{friendly\}[\s\S]{0,300}?turnPills\('failed'\)/,
      'provider/turn error catch'],
    [/Scout stopped\$\{byStr\}[\s\S]{0,300}?turnFallbackQuickReplies\(\{ outcome: 'stopped' \}\)/,
      'scout stopped mid-run'],
    [/Claude Code stopped\$\{byStr\}[\s\S]{0,300}?turnFallbackQuickReplies\(\{ outcome: 'stopped' \}\)/,
      'build stopped mid-run'],
  ];
  for (const [re, label] of sites) {
    assert.match(SESSIONS_SRC, re, `${label}: its status row must carry quickReplies`);
  }
  // Both Mayor-phase stops (phase-1 and the data-summary re-prompt).
  const mayorStops = SESSIONS_SRC.match(/sendStatus\(`Stopped\$\{byStr\}\.`, \{ quickReplies: turnPills\('stopped'\) \}\)/g);
  assert.equal(mayorStops && mayorStops.length, 2,
    'both `Stopped by @…` status rows in the Mayor phases carry pills');
});

test('the turn-state helper reads PR/spec state at call time', () => {
  // session.pr_number is mutated in place by applyPrMetadata and the spec
  // is reloaded before phase 2 — a snapshot taken at turn start would give
  // a just-built session the pre-build pill set.
  assert.match(SESSIONS_SRC, /const turnPills = \(outcome\) => turnFallbackQuickReplies\(\{[\s\S]{0,200}?hasPr: session\.pr_number != null/,
    'turnPills reads session.pr_number when called');
  const specRefreshes = SESSIONS_SRC.match(/turnHasSpec = !!\(currentSpec \|\| ''\)\.trim\(\);/g);
  assert.equal(specRefreshes && specRefreshes.length, 2,
    'turnHasSpec is refreshed both at turn start and before the phase-2 wrap-up');
});

test('the Mayor prompt requires suggest_replies rather than suggesting it', () => {
  assert.match(SESSIONS_SRC, /Every message you send MUST call the suggest_replies tool/,
    'the SUGGESTED QUICK REPLIES block states the requirement');
  assert.match(SESSIONS_SRC, /ALWAYS call suggest_replies alongside your reply/,
    'GENERAL RULES cross-references it, where the one-tool limit is stated');
});

// ── 3. Client wiring ─────────────────────────────────────────────────

function sliceBetween(src, startMarker, endMarker, label) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `found ${label} start marker: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, `found ${label} end marker: ${endMarker}`);
  return src.slice(start, end);
}

const currentQuickRepliesBody = sliceBetween(
  DEVCHAT_SRC, '_currentQuickReplies() {', '_renderQuickReplies() {', 'DevChat._currentQuickReplies'
);

test('the client falls back instead of returning null when no row has pills', () => {
  assert.match(currentQuickRepliesBody, /return DevChat\._fallbackQuickReplies\(\);/,
    'the no-pills path must end in the fallback, not `return null`');
  // The pre-existing gates must survive: hidden mid-turn, hidden on a
  // non-interactive session, and a found set always wins.
  assert.match(currentQuickRepliesBody, /if \(DevChat\.isStreaming\) return null;/,
    'still hidden while a turn streams');
  assert.match(currentQuickRepliesBody, /status === 'active' \|\| session\.status === 'promoted'/,
    'still hidden on a read-only/finished session');
  assert.match(currentQuickRepliesBody, /if \(!sawNonSystem\) return DevChat\.STARTER_QUICK_REPLIES;/,
    'a brand-new session still gets the starter set');
});

test('the client fallback is gated to a pill-less assistant reply', () => {
  // Behaviour is exercised for real in tests/quick-replies-delivery.test.js
  // (which evals this function against fake timelines); these two guards
  // are pinned here because dropping either silently changes when the bar
  // is allowed to be empty.
  assert.match(currentQuickRepliesBody,
    /if \(!lastConvoRow \|\| lastConvoRow\.role !== 'assistant'\) return null;/,
    'a sent user row must still clear the bar (#786)');
  assert.match(currentQuickRepliesBody,
    /if \(Array\.isArray\(lastConvoRow\.suggestions\) && lastConvoRow\.suggestions\.length\) return null;/,
    'an assistant row carrying #32 answer chips must keep the above-box row empty');
});

test('client fallback strings match the server policy exactly', () => {
  // Two copies of the same wording (the browser cannot require the Node
  // module), so drift is the real hazard — assert them equal rather than
  // eyeballing them.
  const m = DEVCHAT_SRC.match(/FALLBACK_QUICK_REPLIES:\s*(\{[\s\S]*?\n  \}),/);
  assert.ok(m, 'found DevChat.FALLBACK_QUICK_REPLIES');
  // eslint-disable-next-line no-eval
  const clientSets = eval(`(${m[1]})`);

  for (const kind of ['code_done', 'spec_done', 'chat_generic']) {
    assert.deepEqual(clientSets[kind], [...RECOVERY_PILLS[kind]],
      `client ${kind} pills must match RECOVERY_PILLS.${kind}`);
  }
  assert.deepEqual(Object.keys(clientSets).sort(), ['chat_generic', 'code_done', 'spec_done'],
    'the client mirrors exactly the three state-derived sets it can choose between');
});

test('the client picks its fallback set the same way the server does', () => {
  const body = sliceBetween(
    DEVCHAT_SRC, '_fallbackQuickReplies() {', '\n  },', 'DevChat._fallbackQuickReplies'
  );
  assert.match(body, /pr_number != null[\s\S]{0,120}?code_done/,
    'a PR means the build landed → post-build pills');
  assert.match(body, /hasSpec[\s\S]{0,120}?spec_done/,
    'a spec means scout work landed → spec pills');
  assert.match(body, /return DevChat\.FALLBACK_QUICK_REPLIES\.chat_generic;/,
    'neither → the generic ways-in set');
});

// ── 4. Staging fixtures ──────────────────────────────────────────────

test('staging seeds cover each fallback shape', () => {
  const MIGRATE_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'db', 'migrate.js'),
    'utf8'
  );
  assert.match(MIGRATE_SRC, /await seedStagingQuickReplyFallback\(pool, config\);/,
    'the seed runs on boot');
  for (const branch of [
    'staging-fixture/fallback-after-build',
    'staging-fixture/fallback-after-spec',
    'staging-fixture/fallback-plain-chat',
    'staging-fixture/fallback-suppressed-by-chips',
  ]) {
    assert.ok(MIGRATE_SRC.includes(branch), `fixture seeded: ${branch}`);
  }
  // The fixtures must survive BOTH boot-time healers, or they demonstrate
  // the healer instead of the fallback: 'promoted' dodges the auto-pause
  // sweeper (a paused session hides the bar entirely) and the 30-day age
  // puts them outside restoreMissingQuickReplies' 7-day window.
  assert.match(MIGRATE_SRC, /VALUES\s*\n\s*\(\$1, \$2, \$3, \$4, \$5, \$6, 'promoted', \$7, FALSE,\s*\n\s*NOW\(\) - INTERVAL '30 days'/,
    "fallback fixtures are seeded 'promoted' and 30 days old on purpose");
});

test('dapp.json checks the pill bar on the seeded fixture routes', () => {
  // Fixed session ids (the route embeds one) are what make these routes
  // stable across staging rebuilds.
  const dapp = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dapp.json'), 'utf8'));
  const MIGRATE_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'db', 'migrate.js'),
    'utf8'
  );
  for (const id of [900801, 900802, 900803]) {
    assert.ok(MIGRATE_SRC.includes(`id: ${id},`), `fixture ${id} has a fixed id in the seed`);
    const t = (dapp.tests || []).find((x) => x.path && x.path.includes(`/sessions/${id}`));
    assert.ok(t, `dapp.json has a proposal check for session ${id}`);
    assert.equal(t.expectSelector, '#dc-quick-replies.dc-quick-replies-active .dc-quick-pill',
      `check ${id} asserts the pill bar actually rendered pills`);
  }
});
