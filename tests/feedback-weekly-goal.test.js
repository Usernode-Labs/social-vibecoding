// Send Feedback dialog: the weekly "Send useful feedback" line (#6758).
//
// The contract that's easy to break later:
//   - the line exists in the modal markup, empty and hidden, just above
//     Cancel and Post, so the dialog looks exactly as before until the read
//     answers;
//   - the answer comes from the RULE that scores the challenge
//     (services/topochain/feedback-goal.js): an enabled USEFUL_FEEDBACK rule
//     on a WEEKLY challenge the scorer would run right now, with the target
//     the scorer caps by. A card nothing scores gives no line;
//   - the words say how many more CAN count and never that this report
//     will: a report is credited later, once it is checked as useful;
//   - the line is a note: nothing in it disables Post;
//   - no answer, a failed read or a signed-out viewer leaves the line
//     hidden, with no console error.
//
// Static-assertion style (cf. tests/feedback-bounty-ui.test.js).
//
// Run with: node --test tests/feedback-weekly-goal.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { message } = require('./lib/platform-i18n');
const { pickFeedbackGoal, FEEDBACK_GOAL_SQL } = require('../src/services/topochain/feedback-goal');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const feedbackJs = fs.readFileSync(
  path.join(root, 'frontend/src/features/dialogs/feedback-controller.js'), 'utf8');
const tsx = fs.readFileSync(
  path.join(root, 'frontend/src/features/dialogs/feedback.tsx'), 'utf8');

// The block that owns the line, from its element lookup to the point where
// the file's next unrelated listener begins.
function weeklyGoalBlock() {
  const start = feedbackJs.indexOf('const refreshWeeklyGoal = () => {');
  const end = feedbackJs.indexOf('privateCheckbox.addEventListener', start);
  assert.ok(start > 0 && end > start, 'found refreshWeeklyGoal');
  return feedbackJs.slice(start, end);
}

// ── Markup ───────────────────────────────────────────────────────────

test('the line ships hidden and empty, just above Cancel and Post', () => {
  const lineIdx = html.indexOf('id="feedback-weekly-goal"');
  const actionsIdx = html.indexOf('class="feedback-actions');
  assert.ok(lineIdx > 0, 'the line is in the prerendered dialog');
  assert.ok(actionsIdx > 0, 'the actions row is in the prerendered dialog');
  assert.ok(lineIdx < actionsIdx, 'the line sits before Cancel and Post');
  // Empty: the dialogue's own words arrive with the answer, and an initial
  // render that carried one would both lie on open and mismatch on hydration.
  const line = html.slice(html.indexOf('>', lineIdx) + 1, html.indexOf('</p>', lineIdx));
  assert.match(html.slice(lineIdx, html.indexOf('>', lineIdx)), /class="hidden\b/, 'hidden until the read answers');
  assert.doesNotMatch(line.replace(/<[^>]*>/g, ''), /\S/, 'no words in the prerender');
  // React-owned node, outside .feedback-actions: the feedback-actions row is
  // pinned by app.css, and a line inside it would ride that pin.
  assert.match(tsx, /<p id="feedback-weekly-goal" className="hidden mt-3 mb-5 text-xs text-zinc-500 dark:text-zinc-400/);
});

// ── The answer (server) ──────────────────────────────────────────────

const NOW = Date.UTC(2026, 10, 18, 12); // a Wednesday
const HOUR = 60 * 60 * 1000;
function goalRow(over = {}) {
  return {
    rule_id: 7, measure: 'USEFUL_FEEDBACK', rule_target: null, rule_points: null,
    rule_interval_minutes: null,
    challenge_id: 42, enabled: true, completed: false,
    schedule_start: null, schedule_end: null, metric_target: null, reward: null,
    t_category: 'WEEKLY', t_schedule_start: null, t_schedule_end: null,
    t_metric_target: 4, t_reward: '250 pts',
    event_starts_at: new Date(NOW - 30 * 24 * HOUR), event_ends_at: new Date(NOW + 30 * 24 * HOUR),
    credits: 0,
    ...over,
  };
}
const pick = (rows, opts = {}) => pickFeedbackGoal(rows, { now: NOW, defaultMinutes: 10, ...opts });

test('the goal is what the scoring rule can still count this week', () => {
  assert.deepEqual(pick([goalRow()]), { target: 4, counted: 0, left: 4 });
  assert.deepEqual(pick([goalRow({ credits: 3 })]), { target: 4, counted: 3, left: 1 });
  assert.deepEqual(pick([goalRow({ credits: 4 })]), { target: 4, counted: 4, left: 0 });
  // More credits than the cap never reads as a negative count.
  assert.deepEqual(pick([goalRow({ credits: 9 })]), { target: 4, counted: 4, left: 0 });
});

test('the rule\'s own target wins over the card\'s, as it does for the scorer', () => {
  assert.deepEqual(pick([goalRow({ rule_target: 2, credits: 1 })]), { target: 2, counted: 1, left: 1 });
});

test('a challenge nothing scores right now gives no goal', () => {
  assert.equal(pick([]), null);
  assert.equal(pick([goalRow()], { defaultMinutes: 0 }), null, 'the schedule is switched off');
  assert.equal(pick([goalRow({ enabled: false })]), null, 'challenge switched off');
  assert.equal(pick([goalRow({ completed: true })]), null, 'challenge closed');
  assert.equal(pick([goalRow({ schedule_start: new Date(NOW + HOUR) })]), null, 'window not started');
  assert.equal(pick([goalRow({ event_ends_at: new Date(NOW - 3 * 24 * HOUR) })]), null, 'window closed');
  assert.equal(pick([goalRow({ t_metric_target: null })]), null, 'no target to cap by');
  assert.equal(pick([goalRow({ t_reward: 'A badge' })]), null, 'no points, so the scorer skips it');
  // A closed challenge does not hide an open one behind it.
  assert.deepEqual(pick([goalRow({ completed: true }), goalRow({ challenge_id: 43, credits: 2 })]),
    { target: 4, counted: 2, left: 2 });
});

test('the read is scoped to weekly useful-feedback rules and this week\'s credits', () => {
  assert.match(FEEDBACK_GOAL_SQL, /r\.enabled = TRUE AND r\.measure = 'USEFUL_FEEDBACK'/);
  assert.match(FEEDBACK_GOAL_SQL, /UPPER\(TRIM\(COALESCE\(ct\.category, ''\)\)\) = 'WEEKLY'/);
  assert.match(FEEDBACK_GOAL_SQL, /ua\.user_id = \$1 AND ua\.challenge_id = c\.id/);
  assert.match(FEEDBACK_GOAL_SQL, /ua\.activity_at >= date_trunc\('week', NOW\(\) AT TIME ZONE 'UTC'\) AT TIME ZONE 'UTC'/,
    'Monday 00:00 UTC, the week the scorer caps by');
  assert.match(FEEDBACK_GOAL_SQL, /se\.internal = FALSE AND COALESCE\(s\.internal, FALSE\) = FALSE/);
  assert.match(FEEDBACK_GOAL_SQL, /se\.is_active = TRUE AND COALESCE\(s\.is_active, FALSE\) = TRUE/);
});

// ── The read (client) ────────────────────────────────────────────────

test('the line reads the goal the server answers', () => {
  const block = weeklyGoalBlock();
  assert.match(block, /fetch\('\/challenges-api\/me\/feedback-goal', \{ credentials: 'same-origin' \}\)/);
  assert.match(block, /!Number\.isInteger\(goal\.target\) \|\| goal\.target < 1/);
  assert.match(block, /const left = Math\.min\(target, goal\.left\)/);
  // Read once per open, and an answer that lands after the dialog reopened or
  // the account changed is dropped.
  assert.match(block, /const opened = presentation/);
  assert.match(block, /opened !== presentation \|\| userId !== App\.user\?\.id/);
});

test('the line words itself from the catalog, and promises nothing about this report', () => {
  const block = weeklyGoalBlock();
  assert.match(block, /t\('dialogs:feedback\.weeklyGoal\.met', \{ target \}\)/);
  assert.match(block, /t\('dialogs:feedback\.weeklyGoal\.left', \{ count: left, counted: target - left, target \}\)/);
  assert.equal(message('dialogs:feedback.weeklyGoal.left', { count: 2, counted: 2, target: 4 }),
    "This week's feedback challenge: 2 of 4 counted. 2 more useful reports can still count.");
  assert.equal(message('dialogs:feedback.weeklyGoal.left', { count: 1, counted: 3, target: 4 }),
    "This week's feedback challenge: 3 of 4 counted. 1 more useful report can still count.");
  assert.equal(message('dialogs:feedback.weeklyGoal.met', { target: 4 }),
    "You've met this week's feedback challenge: 4 of 4 counted. More reports are welcome, but no more count this week.");
  for (const id of ['dialogs:feedback.weeklyGoal.left', 'dialogs:feedback.weeklyGoal.met']) {
    assert.doesNotMatch(message(id, { count: 2, counted: 2, target: 4 }), /this report|will count/i);
  }
});

test('it hides whenever there is nothing to say', () => {
  const block = weeklyGoalBlock();
  // Signed out, or no goal, or any failure: the line stays hidden.
  assert.match(block, /hideWeeklyGoal\(\);\s*\n\s*if \(!weeklyGoalLine \|\| !App\.user\) return;/);
  assert.match(block, /\.catch\(\(\) => \{ \/\* the line stays hidden \*\/ \}\)/);
  assert.doesNotMatch(block, /console\.(error|warn)/, 'a missing count is normal, not an error');
  // A non-ok answer (401 and friends) is treated like no data at all.
  assert.match(block, /response\.ok \? response\.json\(\) : null/);
});

test('the goal line is a note: Post is never gated on it', () => {
  const block = weeklyGoalBlock();
  assert.doesNotMatch(block, /feedbackBtn/, 'the button is not this block\'s business');
  assert.doesNotMatch(block, /disabled = /, 'nothing here disables a control');
  assert.doesNotMatch(block, /submitBusy/);
});

// ── Lifecycle ────────────────────────────────────────────────────────

test('the open half reads it once, and the dismiss half clears it', () => {
  const open = feedbackJs.slice(
    feedbackJs.indexOf('Feedback._open = (opts = {}) => {'),
    feedbackJs.indexOf('// The header\'s #feedback-btn used to be wired here'),
  );
  assert.ok(open.length > 0, 'found the open half');
  // After the form reset, so the edit and first-feedback early returns above
  // never reach it.
  const resetIdx = open.indexOf('resetVideoState();');
  const callIdx = open.indexOf('refreshWeeklyGoal();');
  assert.ok(resetIdx > 0 && callIdx > resetIdx, 'called after the form reset');
  assert.ok(open.indexOf('if (opts.edit)') < callIdx, 'not on the edit early return');
  assert.ok(open.indexOf('if (opts.firstFeedback') < callIdx, 'not behind a confirmation');

  const reset = feedbackJs.slice(
    feedbackJs.indexOf('Feedback._reset = () => {'),
    feedbackJs.indexOf('Feedback._takeDraft = () => {'),
  );
  assert.match(reset, /presentation \+= 1;\s*\n\s*\/\/ #6758[^\n]*\n\s*hideWeeklyGoal\(\);/);
});
