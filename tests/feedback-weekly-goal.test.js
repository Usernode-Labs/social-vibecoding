// Send Feedback dialog — the weekly "Send useful feedback" line (#6758).
//
// The contract that's easy to break later:
//   - the line exists in the modal markup, empty and hidden, just above
//     Cancel and Post, so the dialog looks exactly as before until the read
//     answers;
//   - the controller reads the same session-authed challenge list the
//     Leaderboard shows, and picks the WEEKLY row carrying the
//     useful-feedback artwork — the always-open bug-report challenge shares
//     that artwork and must not drive the line;
//   - the target comes from the challenge's own `progress.target`, never a
//     fixed 4, and the met case is read from `progress.done` (or a current
//     that has reached the target, which is never shown as a negative count);
//   - the line is a note: nothing in it disables Post;
//   - no challenge, no shape, a failed read or a signed-out viewer leaves the
//     line hidden, with no console error.
//
// Static-assertion style (cf. tests/feedback-bounty-ui.test.js).
//
// Run with: node --test tests/feedback-weekly-goal.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { message } = require('./lib/platform-i18n');

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

// ── The read ─────────────────────────────────────────────────────────

test('the line reads the Leaderboard\'s own challenge list', () => {
  const block = weeklyGoalBlock();
  assert.match(block, /fetch\('\/challenges-api\/challenges', \{ credentials: 'same-origin' \}\)/,
    'the session-authed list, no season param so the server resolves the active one');
  assert.match(block, /r\.illustration === 'useful-feedback'/);
  assert.match(block, /String\(r\.category\)\.toUpperCase\(\) === 'WEEKLY'/,
    'the always-open bug-report challenge shares the artwork — WEEKLY is the discriminator');
  assert.match(block, /r\.enabled !== false && r\.completed !== true/);
  // The target is the challenge's, and a null one has no figure to show.
  assert.match(block, /Number\.isInteger\(r\.progress\.target\) && r\.progress\.target > 0/);
  assert.match(block, /const left = target - Math\.max\(0, Number\(current\) \|\| 0\)/,
    'a current past the target is shown as met, never as a negative count');
  assert.match(block, /done === true \|\| \(Number\(current\) \|\| 0\) >= target/);
  // Read once per open, and an answer that lands after the dialog reopened or
  // the account changed is dropped.
  assert.match(block, /const opened = presentation/);
  assert.match(block, /opened !== presentation \|\| userId !== App\.user\?\.id/);
});

test('the line words itself from the catalog', () => {
  const block = weeklyGoalBlock();
  assert.match(block, /t\('dialogs:feedback\.weeklyGoal\.met'\)/);
  assert.match(block, /t\('dialogs:feedback\.weeklyGoal\.left', \{ count: left, target \}\)/);
  assert.equal(message('dialogs:feedback.weeklyGoal.left', { count: 2, target: 4 }), '2 of 4 left this week');
  assert.equal(message('dialogs:feedback.weeklyGoal.left', { count: 1, target: 4 }), '1 of 4 left this week');
  assert.equal(message('dialogs:feedback.weeklyGoal.met'), "This week's feedback goal is met");
});

test('it hides whenever there is nothing to say', () => {
  const block = weeklyGoalBlock();
  // Signed out, or no matching row, or any failure: the line stays hidden.
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
