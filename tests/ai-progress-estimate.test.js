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

// ── 1b. sanitizeRemainingSeconds unit tests (#50 follow-up) ──────────────

test('llm exports sanitizeRemainingSeconds', () => {
  assert.equal(typeof llm.sanitizeRemainingSeconds, 'function');
});

test('sanitizeRemainingSeconds: passes through an in-range integer', () => {
  assert.equal(llm.sanitizeRemainingSeconds(180), 180);
  assert.equal(llm.sanitizeRemainingSeconds(0), 0);
});

test('sanitizeRemainingSeconds: coerces a float to an integer', () => {
  assert.equal(llm.sanitizeRemainingSeconds(180.9), 180);
  assert.equal(llm.sanitizeRemainingSeconds('240'), 240);
});

test('sanitizeRemainingSeconds: negative / NaN / Infinity / null become null', () => {
  assert.equal(llm.sanitizeRemainingSeconds(-1), null);
  assert.equal(llm.sanitizeRemainingSeconds(NaN), null);
  assert.equal(llm.sanitizeRemainingSeconds(Infinity), null);
  assert.equal(llm.sanitizeRemainingSeconds(-Infinity), null);
  assert.equal(llm.sanitizeRemainingSeconds(null), null);
  assert.equal(llm.sanitizeRemainingSeconds(undefined), null);
  assert.equal(llm.sanitizeRemainingSeconds('not a number'), null);
});

test('sanitizeRemainingSeconds: clamps above the 7200s ceiling', () => {
  assert.equal(llm.sanitizeRemainingSeconds(10000), 7200);
  assert.equal(llm.sanitizeRemainingSeconds(7200), 7200);
  assert.equal(llm.sanitizeRemainingSeconds(7201), 7200);
});

test('estimateRunProgress requests a numeric remaining-time guess', () => {
  const src = read('src/services/llm.js');
  const fnStart = src.indexOf('async function estimateRunProgress');
  const fnBody = src.slice(fnStart, src.indexOf('module.exports'));
  // The system prompt now asks for remaining_seconds alongside the phrase,
  // and the parsed result carries an additive remainingSeconds field.
  assert.match(fnBody, /remaining_seconds/, 'system prompt must request a numeric remaining-time value');
  assert.match(fnBody, /remainingSeconds/, 'estimateRunProgress must return a remainingSeconds field');
  assert.match(fnBody, /sanitizeRemainingSeconds/, 'the numeric guess must pass through the sanitizer');
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

test('schema adds the progress_estimates accuracy table (private)', () => {
  const schema = read('src/db/schema.sql');
  assert.match(
    schema,
    /CREATE TABLE IF NOT EXISTS progress_estimates/,
    'schema must create the progress_estimates table'
  );
  assert.match(
    schema,
    /progress_message_id\s+INTEGER REFERENCES chat_session_messages/,
    'progress_estimates must anchor on progress_message_id'
  );
  assert.match(
    schema,
    /COMMENT ON TABLE progress_estimates IS 'staging:private'/,
    'progress_estimates must be marked staging:private'
  );
});

test('sessions route persists each estimate and backfills the actual outcome', () => {
  const sessions = read('src/routes/sessions.js');
  assert.match(
    sessions,
    /INSERT INTO progress_estimates/,
    'estimator success path must INSERT into progress_estimates'
  );
  assert.match(
    sessions,
    /UPDATE progress_estimates/,
    'terminal choke point must backfill the actual outcome'
  );
  assert.match(
    sessions,
    /actual_remaining_ms = \$1 - elapsed_ms/,
    'backfill must store per-tick ground-truth remaining'
  );
  assert.match(
    sessions,
    /predicted_remaining_seconds/,
    'the predicted numeric remaining-seconds must be persisted'
  );
});

test('dev-chat renders the numeric ~X left suffix', () => {
  const devChat = read('public/js/dev-chat.js');
  assert.match(devChat, /_estimateSuffix/, 'a helper must build the numeric remaining-time suffix');
  assert.match(devChat, /~\$\{formatElapsed/, 'suffix must use formatElapsed to render ~X left');
  assert.match(devChat, /left/, 'suffix must read "~X left"');
  assert.match(
    devChat,
    /_applyEstimate\(data\.text, data\.remainingSeconds\)/,
    'cc_estimate handlers must pass remainingSeconds through'
  );
});

test('cc_estimate SSE payload carries remainingSeconds', () => {
  const sessions = read('src/routes/sessions.js');
  assert.match(
    sessions,
    /send\('cc_estimate', \{ text, remainingSeconds/,
    'SSE payload must include remainingSeconds'
  );
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
