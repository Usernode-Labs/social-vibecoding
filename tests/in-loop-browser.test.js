// Tests for the optional in-loop browser (build-mode coding-agent turns).
//
// Covers the JS-side contract in src/services/in-loop-browser.js:
//   - mode gating: build gets browser tooling; scout/sync/warm do not
//   - INLOOP_* env: build boots the app with USERNODE_ENV=staging on a
//     dedicated port against a throwaway DB; other modes get nothing
//   - the prompt guidance reads OPTIONAL/encouraged (not a mandatory gate),
//     reuses the TESTING-block paths, carries the "blank page = missing
//     seed data" reminder, a time/cycle budget, and the graceful
//     "commit anyway if it won't boot" instruction
//   - the build prompt actually interpolates the guidance while the scout
//     prompt does not mention a browser
//
// Run with: node --test tests/in-loop-browser.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const inLoop = require('../src/services/in-loop-browser');

// ── mode gating ─────────────────────────────────────────────────────────

test('browserToolingEnabledForMode is true ONLY for build', () => {
  assert.equal(inLoop.browserToolingEnabledForMode('build'), true);
  assert.equal(inLoop.browserToolingEnabledForMode('scout'), false);
  assert.equal(inLoop.browserToolingEnabledForMode('sync'), false);
  assert.equal(inLoop.browserToolingEnabledForMode('warm'), false);
  assert.equal(inLoop.browserToolingEnabledForMode(undefined), false);
});

// ── INLOOP_* env plumbing ────────────────────────────────────────────────

test('browserEnvForMode(build) plumbs port + staging env + throwaway DB pointer', () => {
  const env = inLoop.browserEnvForMode('build');
  assert.equal(env.INLOOP_BROWSER, '1');
  assert.equal(env.INLOOP_ENV, 'staging'); // fresh-empty-DB staging contract
  assert.equal(env.INLOOP_PORT, String(inLoop.INLOOP_PORT));
  assert.equal(env.INLOOP_DATABASE_URL, inLoop.INLOOP_DATABASE_URL);
  // The in-loop launch must be local-only and must NOT smuggle in the
  // Anthropic proxy retarget — that var is owned by worker.execInWorker.
  assert.ok(!('ANTHROPIC_BASE_URL' in env));
});

test('browserEnvForMode is empty for scout and sync (no app launch, no browser)', () => {
  assert.deepEqual(inLoop.browserEnvForMode('scout'), {});
  assert.deepEqual(inLoop.browserEnvForMode('sync'), {});
  assert.deepEqual(inLoop.browserEnvForMode('warm'), {});
});

test('the in-loop port is not the 3000 app-convention port (avoids collision)', () => {
  assert.notEqual(inLoop.INLOOP_PORT, 3000);
});

// ── guidance text: optional, encouraged, with the right hooks ─────────────

test('guidance reads OPTIONAL/encouraged, not a mandatory per-turn gate', () => {
  const g = inLoop.IN_LOOP_BROWSER_GUIDANCE;
  assert.match(g, /OPTIONAL/);
  assert.match(g, /NOT required/);
  assert.match(g, /encouraged/i);
  assert.match(g, /\bMAY use\b/);
  assert.match(g, /not a\s+gate/i);
  // Must not phrase the browser as something the agent is forced to run
  // every turn.
  assert.doesNotMatch(g, /you MUST (use|run|open) the (in-loop )?browser/i);
  assert.doesNotMatch(g, /REQUIRED for (all|every|user-visible)/i);
});

test('guidance carries the usage hooks that make it likely to be used', () => {
  const g = inLoop.IN_LOOP_BROWSER_GUIDANCE;
  // reuse the TESTING-block path: routes
  assert.match(g, /TESTING block/);
  assert.match(g, /path:/);
  // staging launch contract
  assert.match(g, /USERNODE_ENV=\$INLOOP_ENV/);
  assert.match(g, /\$INLOOP_PORT/);
  assert.match(g, /\$INLOOP_DATABASE_URL/);
  assert.match(g, /FRESH, EMPTY local database/i);
  // "blank page = missing seed data, not a bug"
  assert.match(g, /BLANK[\s\S]*MISSING SEED DATA, not a bug/);
  // a tight verify-fix budget
  assert.match(g, /cycles?/i);
  // graceful degradation: commit anyway, never fail the turn
  assert.match(g, /commit your work anyway/i);
  // \s+ tolerates the guidance text re-wrapping across source lines.
  assert.match(g, /never\s+block or fail the turn/i);
});

// ── wiring: build prompt includes the guidance; scout prompt does not ────

test('the build prompt interpolates the guidance; the scout prompt has no browser', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'sessions.js'),
    'utf8'
  );
  // build prompt (claudePrompt) interpolates the shared constant
  assert.match(src, /\$\{IN_LOOP_BROWSER_GUIDANCE\}/);
  assert.match(src, /require\('\.\.\/services\/in-loop-browser'\)/);

  // The scout prompt template must NOT offer a browser. Slice out the
  // scoutPrompt literal and assert it's browser-free.
  const start = src.indexOf('const scoutPrompt = `');
  assert.ok(start !== -1, 'scoutPrompt literal not found');
  const end = src.indexOf('`;', start);
  const scoutLiteral = src.slice(start, end);
  assert.doesNotMatch(scoutLiteral, /browser_navigate|Playwright|in-loop browser|INLOOP_/i);
});
