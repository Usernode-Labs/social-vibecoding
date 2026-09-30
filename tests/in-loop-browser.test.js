// Tests for the optional in-loop browser (build-mode coding-agent turns).
//
// Covers the JS-side contract in src/services/in-loop-browser.js:
//   - mode gating: build gets browser tooling; scout/sync/warm do not
//   - INLOOP_* env: build boots the app with USERNODE_ENV=staging on a
//     dedicated port against a throwaway DB; other modes get nothing
//   - the prompt guidance reads OPTIONAL/encouraged (not a mandatory gate),
//     reuses the TESTING-block paths, reads a blank page in order (the
//     page's own console and assets, then seed data), a time/cycle budget,
//     and the graceful
//     "commit anyway if it won't boot" instruction
//   - the build prompt interpolates backend-appropriate guidance while the
//     scout prompt does not mention a browser
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
  assert.match(g, /usernode-run-inloop node server\.js/);
  assert.match(g, /USERNODE_ENV=\$INLOOP_ENV/);
  assert.match(g, /\$INLOOP_PORT/);
  assert.match(g, /\$INLOOP_DATABASE_URL/);
  assert.match(g, /--changed.*zero checks/s);
  assert.match(g, /FRESH, EMPTY local database/i);
  // A blank page is read in order: the page's own console and assets
  // first (the launch serves them as production does), and only then
  // missing seed data. Silencing an asset with an empty/204 answer is
  // named and forbidden — that is how an app blanked production (#38).
  assert.match(g, /BLANK[\s\S]*is a BUG until you have ruled\s+the page itself out/);
  assert.match(g, /browser_console_messages[\s\S]*stylesheet and script loaded/);
  assert.match(g, /NEVER make the app answer a hosted-asset path or its own built\s+stylesheet/);
  assert.match(g, /\/tailwind\.css/);
  assert.match(g, /page itself is sound, suspect\s+MISSING SEED DATA, not a bug/);
  assert.ok(g.indexOf('BUG until') < g.indexOf('MISSING SEED DATA'), 'the page before the data');
  // The launch contract says what the launcher now does for parity.
  assert.match(g, /runs the app's `npm run build` first/);
  assert.match(g, /`\/usernode-bridge\/`, `\/usernode-native\/`\s+and `\/usernode-tailwind\/` from the platform/);
  // a tight verify-fix budget
  assert.match(g, /cycles?/i);
  // graceful degradation: commit anyway, never fail the turn
  assert.match(g, /commit your work anyway/i);
  // \s+ tolerates the guidance text re-wrapping across source lines.
  assert.match(g, /never\s+block or fail the turn/i);
});

// ── wiring: build prompt includes the guidance; scout prompt does not ────

test('the build prompt interpolates backend guidance; the scout prompt has no browser', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'sessions.js'),
    'utf8'
  );
  // The build prompt uses the pure backend selector. Hosted Claude receives
  // the compact system-handbook reminder; unchanged backends receive the full
  // inline constant through the same selector.
  assert.match(src, /buildCodingAgentBuildGuidance\(\{/);
  assert.match(src, /\$\{buildGuidance\.browserGuidance\}/);
  assert.match(src, /\$\{buildGuidance\.testingGuidance\}/);
  assert.match(src, /require\('\.\.\/services\/in-loop-browser'\)/);

  // The scout prompt template must NOT offer a browser. Slice out the
  // scoutPrompt literal and assert it's browser-free.
  const start = src.indexOf('const scoutPrompt = `');
  assert.ok(start !== -1, 'scoutPrompt literal not found');
  const end = src.indexOf('`;', start);
  const scoutLiteral = src.slice(start, end);
  assert.doesNotMatch(scoutLiteral, /browser_navigate|Playwright|in-loop browser|INLOOP_/i);
});

// ── production parity is stated where hosted Claude reads it ──────────────

test('the hosted reminder and the handbook carry the parity launch and the no-silencing rule', () => {
  const hosted = inLoop.HOSTED_CLAUDE_IN_LOOP_BROWSER_GUIDANCE;
  assert.match(hosted, /builds the app and serves the platform's hosted\s+assets as production does/);
  assert.match(hosted, /Never silence one with an empty response/);
  const handbook = fs.readFileSync(path.join(__dirname, '..', 'src', 'prompts', 'app-conventions.md'), 'utf8');
  const inLoopSection = handbook.slice(handbook.indexOf('## In-loop browser (build turns)'),
    handbook.indexOf('## Content rules'));
  assert.match(inLoopSection, /runs the app's\s+`npm run build` first/);
  assert.match(inLoopSection, /front proxy answers `\/usernode-bridge\/`/);
  assert.match(inLoopSection, /is a bug until you have ruled\s+the page itself out/);
  assert.doesNotMatch(inLoopSection, /blank or empty page usually means missing seed data/i);
  assert.match(handbook, /Never answer these prefixes from the app's own server\./);
  assert.match(handbook, /Never special-case `\/tailwind\.css` in `server\.js`\./);
});
