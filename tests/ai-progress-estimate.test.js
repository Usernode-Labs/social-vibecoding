// Tests for the experimental AI progress estimate (#50 follow-up).
//
// Two layers:
//   1. Unit tests for llm.sanitizeEstimate — the pure clamp applied to
//      every Haiku estimate before it reaches the dev-chat summary line.
//      src/services/llm.js is plain CommonJS, so we require the real
//      function (init() need not be called).
//   2. Source guards — the feature spans schema, auth middleware, the
//      /me payload + toggle endpoint, the estimator wiring in sessions.js,
//      the cc_estimate handling in dev-chat.js, and the Settings markup.
//      Each guard pins the contract so a refactor can't silently drop a
//      link in the chain while the unit-tested helper stays green.
//
// Run with: node --test tests/ai-progress-estimate.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const llm = require('../src/services/llm.js');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ── 1. sanitizeEstimate unit tests ──────────────────────────────────────

test('sanitizeEstimate: trims and passes through a normal phrase', () => {
  assert.equal(
    llm.sanitizeEstimate('  maybe two-thirds done — a few minutes left  '),
    'maybe two-thirds done — a few minutes left'
  );
});

test('sanitizeEstimate: collapses newlines and internal whitespace runs', () => {
  assert.equal(
    llm.sanitizeEstimate('probably\nhalfway —\n\n  a while to go'),
    'probably halfway — a while to go'
  );
});

test('sanitizeEstimate: hard-caps at 90 chars with an ellipsis', () => {
  const long = 'x'.repeat(200);
  const out = llm.sanitizeEstimate(long);
  assert.ok(out.length <= 90, `expected <= 90 chars, got ${out.length}`);
  assert.ok(out.endsWith('…'));
});

test('sanitizeEstimate: 90-char input is untouched', () => {
  const exact = 'y'.repeat(90);
  assert.equal(llm.sanitizeEstimate(exact), exact);
});

test('sanitizeEstimate: nullish and non-string inputs become empty string', () => {
  assert.equal(llm.sanitizeEstimate(null), '');
  assert.equal(llm.sanitizeEstimate(undefined), '');
  assert.equal(llm.sanitizeEstimate('   '), '');
});

test('llm exports estimateRunProgress alongside sanitizeEstimate', () => {
  assert.equal(typeof llm.estimateRunProgress, 'function');
  assert.equal(typeof llm.sanitizeEstimate, 'function');
});

// ── 2. Source guards ────────────────────────────────────────────────────

test('schema adds the ai_progress_estimate column (default FALSE)', () => {
  const schema = read('src/db/schema.sql');
  assert.match(
    schema,
    /ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_progress_estimate BOOLEAN NOT NULL DEFAULT FALSE/
  );
});

test('auth middleware selects the column and exposes aiProgressEstimate', () => {
  const mw = read('src/middleware/auth.js');
  assert.match(mw, /ai_progress_estimate/, 'session SELECT must include the column');
  assert.match(mw, /aiProgressEstimate/, 'req.user must carry the flag');
});

test('auth routes return the flag from /me and define the toggle endpoint', () => {
  const routes = read('src/routes/auth.js');
  assert.match(routes, /aiProgressEstimate/, '/api/auth/me must include the flag');
  assert.match(routes, /\/api\/me\/ai-progress-estimate/, 'toggle endpoint must exist');
  assert.match(routes, /SET ai_progress_estimate/, 'toggle endpoint must persist the column');
});

test('sessions route gates the estimator on the flag and emits cc_estimate', () => {
  const sessions = read('src/routes/sessions.js');
  assert.match(sessions, /aiProgressEstimate/, 'estimator must be gated on the per-user flag');
  assert.match(sessions, /send\('cc_estimate'/, 'estimator must emit cc_estimate');
  assert.match(sessions, /estimateRunProgress/, 'estimator must call llm.estimateRunProgress');
  assert.match(
    sessions,
    /workerProgress\.setEstimate/,
    'latest estimate must be stashed for the /status polling fallback'
  );
});

test('estimateRunProgress uses Haiku', () => {
  const src = read('src/services/llm.js');
  const fnStart = src.indexOf('async function estimateRunProgress');
  assert.ok(fnStart !== -1, 'estimateRunProgress must exist in llm.js');
  const fnBody = src.slice(fnStart, src.indexOf('module.exports'));
  assert.match(fnBody, /claude-haiku-4-5/, 'estimator must use the Haiku model');
});

test('dev-chat handles cc_estimate in both event switches', () => {
  const devChat = read('public/js/dev-chat.js');
  const matches = devChat.match(/case 'cc_estimate':/g) || [];
  assert.ok(
    matches.length >= 2,
    `expected cc_estimate in both the POST-SSE and external handlers, found ${matches.length}`
  );
  assert.match(devChat, /_applyEstimate/, 'handlers must funnel through _applyEstimate');
  assert.match(devChat, /dc-cc-estimate/, 'running summary must render the estimate span');
});

test('settings modal has the experimental toggle wired to the endpoint', () => {
  const html = read('public/index.html');
  assert.match(html, /id="ai-progress-estimate"/, 'settings modal must have the checkbox');
  const settings = read('public/js/settings.js');
  assert.match(settings, /\/api\/me\/ai-progress-estimate/, 'settings.js must POST the toggle');
});

test('/status response carries the estimate for the polling fallback', () => {
  const sessions = read('src/routes/sessions.js');
  assert.match(sessions, /busy, progress, phase, estimate/, '/status payload must include estimate');
});
