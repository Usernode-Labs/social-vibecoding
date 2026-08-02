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

test('dev-chat renders a live count-down for the remaining-time guess (#359)', () => {
  const devChat = read('public/js/dev-chat.js');
  // The numeric guess is now an absolute target end-timestamp the shared 1s
  // ticker counts down from, rendered as a data-countdown-to child span.
  assert.match(devChat, /_countdownTo\s*=\s*DevChat\._countdownTarget/,
    'apply/hydrate/pending must anchor _countdownTo from remainingSeconds');
  assert.match(devChat, /data-countdown-to="\$\{countdownTo\}"/,
    'the estimate span must render a data-countdown-to child span');
  assert.match(devChat, /class="dc-cc-countdown"/,
    'the count-down lives in its own .dc-cc-countdown span');
  // Both ticker hooks must know about the count-down span so the single
  // shared DevChat._elapsedTimer drives it.
  assert.match(devChat, /\[data-countdown-to\]/,
    '_syncElapsedTicker / _tickElapsed must reference data-countdown-to');
  assert.match(devChat, /formatCountdown/,
    'the count-down text must come from formatCountdown');
  assert.match(
    devChat,
    /_applyEstimate\(data\.text, data\.remainingSeconds\)/,
    'cc_estimate handlers must pass remainingSeconds through'
  );
});

test('dev-chat clears the count-down anchor when a step finishes (#359)', () => {
  const devChat = read('public/js/dev-chat.js');
  const fnStart = devChat.indexOf('_deactivateLastStatus() {');
  assert.ok(fnStart !== -1, '_deactivateLastStatus must exist');
  const fnBody = devChat.slice(fnStart, fnStart + 1400);
  assert.match(fnBody, /delete m\._estimate/, 'finished step must drop the guess');
  assert.match(fnBody, /delete m\._countdownTo/,
    'finished step must also drop the count-down anchor');
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
  // Matched key-by-key rather than as one fixed run, so adding a sibling
  // key to the payload (e.g. `stopping`, #889) doesn't fail this — the
  // invariant is that `estimate` ships alongside the polling basics, not
  // the order they're written in.
  const payload = sessions.match(/res\.json\(\{\s*\n?\s*busy,[\s\S]{0,200}?\}\);/);
  assert.ok(payload, 'found the /status res.json payload');
  for (const key of ['busy', 'progress', 'phase', 'estimate']) {
    assert.match(payload[0], new RegExp(`\\b${key}\\b`), `/status payload must include ${key}`);
  }
});

// ── 3. Mobile visibility (#286) ─────────────────────────────────────────

// Slice out the body of the first `@media (max-width: 640px)` block by
// brace-matching, so we can assert what it does (and doesn't) hide.
function narrowMediaBlock(css) {
  const marker = '@media (max-width: 640px)';
  const at = css.indexOf(marker);
  assert.ok(at !== -1, 'a max-width:640px media query must exist');
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced braces in 640px media query');
}

test('mobile (#286): the 640px block no longer hides .dc-cc-estimate', () => {
  const block = narrowMediaBlock(read('public/css/app.css'));
  // The activity snippet stays hidden on narrow screens...
  assert.match(block, /\.dc-cc-current\s*\{\s*display:\s*none/,
    '.dc-cc-current must remain hidden on narrow viewports');
  // ...but the AI progress estimate must NOT be display:none anymore.
  assert.doesNotMatch(block, /\.dc-cc-estimate\s*\{\s*display:\s*none/,
    '.dc-cc-estimate must not be hidden in the 640px block');
  // And it should wrap onto its own full-width row instead.
  assert.match(block, /\.dc-cc-estimate\s*\{[^}]*flex-basis:\s*100%/,
    '.dc-cc-estimate must span its own full-width row on mobile');
});

test('mobile (#286): dev-chat hydrates _estimate from persisted metadata', () => {
  const devChat = read('public/js/dev-chat.js');
  assert.match(devChat, /m\.metadata\.estimate/,
    'load mapping must read metadata.estimate');
  assert.match(devChat, /m\._estimate\s*=/,
    'metadata.estimate must hydrate m._estimate');
  assert.match(devChat, /m\._estimateRemaining\s*=/,
    'metadata.estimate must hydrate m._estimateRemaining');
});

test('mobile (#286): staging seeds an active running line with an estimate', () => {
  const migrate = read('src/db/migrate.js');
  assert.match(migrate, /seedStagingCcEstimateRun/,
    'a CC-estimate staging fixture must be defined and called');
  const fnStart = migrate.indexOf('async function seedStagingCcEstimateRun');
  assert.ok(fnStart !== -1, 'seedStagingCcEstimateRun must exist');
  const fnBody = migrate.slice(fnStart, migrate.indexOf('async function', fnStart + 1));
  assert.match(fnBody, /USERNODE_ENV !== 'staging'/, 'fixture must be staging-gated');
  assert.match(fnBody, /\[staging fixture\]/, 'seeded rows must carry the staging prefix');
  assert.match(fnBody, /estimate:\s*\{\s*text:/, 'fixture must persist estimate metadata');
  assert.match(fnBody, /Claude Code is running/, 'fixture must seed an active running line');
});

// ── 4. Reliability for long runs (#323) ─────────────────────────────────
//
// The estimator must keep producing guesses for the whole life of a long
// run: a few transient failures must not disable it for good, the flat
// 20-emit cap must be gone, the first guess must be able to fire before any
// progress line lands, and the countdown must refresh on a wall-clock
// cadence so it never freezes during a quiet phase. These pin the inline
// estimator contract in sessions.js (it's a closure inside the route
// handler, so source guards are the practical seam).

// Slice out the estimator block: from the toggle gate down to the 60s tick.
function estimatorBlock() {
  const src = read('src/routes/sessions.js');
  const at = src.indexOf('const estimatorEnabled = !headless');
  assert.ok(at !== -1, 'estimatorEnabled gate must exist');
  const end = src.indexOf('}, 60_000);', at);
  assert.ok(end !== -1, 'estimator 60s tick must exist');
  return src.slice(at, end + 20);
}

test('#323: estimator no longer permanently dies after a flat failure/emit count', () => {
  const block = estimatorBlock();
  // The old hard kill — `estimateFailures >= 3 || estimateSuccesses >= 20`
  // followed by clearInterval — must be gone.
  assert.doesNotMatch(block, /estimateFailures\s*>=\s*3/,
    'the permanent 3-failure clearInterval must be removed');
  assert.doesNotMatch(block, /estimateSuccesses\s*>=\s*20/,
    'the flat 20-emit hard stop must be removed');
});

test('#323: estimator backs off on failure and resets the counter on success', () => {
  const block = estimatorBlock();
  // Backoff: failures increment a counter that skips a bounded number of
  // ticks rather than tearing down the interval.
  assert.match(block, /consecutiveFailures\+\+/, 'failures must increment a backoff counter');
  assert.match(block, /ticksToSkip\s*=\s*Math\.min\(consecutiveFailures,\s*5\)/,
    'failure backoff must skip up to 5 ticks');
  assert.match(block, /if\s*\(ticksToSkip\s*>\s*0\)\s*\{\s*ticksToSkip--;\s*return;\s*\}/,
    'the tick must wait out the backoff window');
  // Recovery: a success zeroes the failure counter so the run self-heals.
  assert.match(block, /consecutiveFailures\s*=\s*0/, 'a success must reset the failure counter');
});

test('#323: emits are bounded only by a generous runaway ceiling', () => {
  const block = estimatorBlock();
  assert.match(block, /MAX_ESTIMATES\s*=\s*60/, 'the runaway backstop must be a generous ceiling');
  assert.match(block, /estimateSuccesses\s*>=\s*MAX_ESTIMATES/,
    'the ceiling must gate only as a runaway backstop');
});

test('#323: first estimate can fire before any progress line lands', () => {
  const block = estimatorBlock();
  // lastEstimateAtMs == null (no successful emit yet) forces a run even with
  // zero lines — the old `lines === linesAtLastEstimate` early-return is gone.
  assert.match(block, /lastEstimateAtMs\s*==\s*null\)\s*shouldRun\s*=\s*true/,
    'the first tick must run even with no new progress lines');
  assert.doesNotMatch(block, /if\s*\(liveProgressLines\.length === linesAtLastEstimate\)\s*return;/,
    'the unconditional idle early-return must be removed');
});

test('#323: the countdown refreshes on a wall-clock cadence when idle', () => {
  const block = estimatorBlock();
  assert.match(block, /IDLE_REFRESH_MS/, 'an idle-refresh wall-clock threshold must exist');
  assert.match(block, /sinceLastMs\s*>=\s*IDLE_REFRESH_MS/,
    'an idle tick must re-ask once enough wall-clock has passed');
  // ...but a brand-new estimate is still skipped when nothing changed and it
  // was just asked (cost containment): the idle branch is the *else* of
  // hasNewLines, not an unconditional re-ask.
  assert.match(block, /else if\s*\(hasNewLines\)\s*shouldRun\s*=\s*true/,
    'new progress lines must still trigger an immediate estimate');
});

test('#323: cadence widens with elapsed time instead of stopping', () => {
  const block = estimatorBlock();
  assert.match(block, /WIDEN_AFTER_MS\s*=\s*15\s*\*\s*60_000/, 'cadence must widen after ~15 min');
  assert.match(block, /WIDE_SPACING_MS/, 'late-run minimum spacing must be defined');
  assert.match(block, /sinceLastMs\s*<\s*minSpacingMs\)\s*shouldRun\s*=\s*false/,
    'the widened spacing must throttle (not stop) late-run estimates');
});

test('#323: estimator logs start, backoff, and the silent-disable case', () => {
  const sessions = read('src/routes/sessions.js');
  assert.match(sessions, /AI progress estimator started/, 'estimator creation must be logged');
  assert.match(sessions, /backing off/, 'failure backoff must be logged');
  assert.match(sessions, /AI progress estimate skipped: no LLM key available/,
    'the toggle-on-but-no-key case must be logged for diagnosis');
});

test('#323: estimateRunProgress requests schema-constrained structured output', () => {
  const src = read('src/services/llm.js');
  const fnStart = src.indexOf('async function estimateRunProgress');
  const fnBody = src.slice(fnStart, src.indexOf('module.exports'));
  // The messages.create call must force Haiku to emit valid schema-matching
  // JSON via output_config.format, eliminating the parse-failure class at the
  // source. The bound schema (ESTIMATE_SCHEMA) must cover both keys the parser
  // reads — estimate + remaining_seconds.
  assert.match(fnBody, /output_config/, 'estimate call must pass output_config');
  assert.match(fnBody, /json_schema/, 'output_config.format must be a json_schema');
  assert.match(fnBody, /ESTIMATE_SCHEMA/, 'the bound schema must be passed to the call');

  // ESTIMATE_SCHEMA is a top-level object with additionalProperties:false whose
  // required keys are estimate (string) and remaining_seconds (nullable int).
  const schemaStart = src.indexOf('const ESTIMATE_SCHEMA');
  assert.ok(schemaStart !== -1, 'ESTIMATE_SCHEMA must be defined');
  const schemaBlock = src.slice(schemaStart, src.indexOf('estimateRunProgress', schemaStart));
  assert.match(schemaBlock, /additionalProperties:\s*false/, 'schema must forbid extra keys');
  assert.match(schemaBlock, /estimate:\s*\{\s*type:\s*'string'\s*\}/, 'schema must declare estimate as a string');
  assert.match(schemaBlock, /remaining_seconds:\s*\{\s*type:\s*\['integer',\s*'null'\]\s*\}/,
    'schema must declare remaining_seconds as a nullable integer');
  assert.match(schemaBlock, /required:\s*\['estimate',\s*'remaining_seconds'\]/,
    'both keys must be required');
});

test('#323: estimateRunProgress tolerates code fences and smart quotes', () => {
  const src = read('src/services/llm.js');
  const fnStart = src.indexOf('async function estimateRunProgress');
  const fnBody = src.slice(fnStart, src.indexOf('module.exports'));
  // Defensive fallback (now that structured outputs is the primary path):
  // strips ```json fences and normalises curly quotes before JSON.parse so an
  // off-schema response (refusal / truncation / older model) decorated with a
  // fence or smart quotes still parses rather than counting as a failure.
  assert.match(fnBody, /replace\(\/```/, 'must strip code fences before parsing');
  assert.match(fnBody, /[“”]/, 'must normalise smart double quotes');
  assert.match(fnBody, /[‘’]/, 'must normalise smart single quotes');
});

test('#323: _applyEstimate stashes a pending estimate instead of dropping it', () => {
  const devChat = read('public/js/dev-chat.js');
  // No active line yet → stash, don't silently return.
  assert.match(devChat, /_pendingEstimate\s*=\s*\{\s*text:\s*clean/,
    '_applyEstimate must stash the estimate when no active line exists');
  // renderMessages drains the pending estimate onto the active line.
  assert.match(devChat, /DevChat\._pendingEstimate\)/, 'renderMessages must drain a pending estimate');
  // Patch is scoped to THIS run's DOM node by persist-id, not the last span.
  assert.match(devChat, /data-persist-id="\$\{pid\}"\]\s*\.dc-cc-estimate/,
    'in-place patch must target the active run by persist-id');
});
