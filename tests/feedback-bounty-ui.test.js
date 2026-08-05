// Send Feedback dialog — the "Put a kudos bounty on this" row (#964).
//
// The contract that's easy to break later:
//   - the row and its checkbox exist in the modal markup, so the
//     screenshot deep link and the dapp.json checks have something to
//     select;
//   - the checkbox is UNCHECKED in the markup and re-cleared on every open
//     and every cancel — filing feedback must never quietly spend someone's
//     weekly allowance, which is the whole reason the pledge is opt-in;
//   - the note reads the live remaining/limit from Kudos.Budget rather than
//     hardcoding a number, and the checkbox is disabled at zero remaining;
//   - submitFeedback only sends `bounty` for a ticked, enabled box;
//   - `?shot=feedback` / `?shot=feedback-spent` both open the dialog, since
//     it is otherwise reachable only by tapping;
//   - the Kudos-tab subtitle no longer hardcodes the weekly allowance.
//
// Static-assertion style (cf. tests/standings-screen.test.js).
//
// Run with: node --test tests/feedback-bounty-ui.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const lbJs = fs.readFileSync(path.join(root, 'public/js/leaderboard.js'), 'utf8');
const appViewJs = fs.readFileSync(path.join(root, 'public/js/app-view.js'), 'utf8');
const dapp = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));

// ── Markup ───────────────────────────────────────────────────────────

test('the feedback modal carries the bounty row, checkbox and note', () => {
  assert.match(html, /id="feedback-bounty-row"/);
  assert.match(html, /id="feedback-bounty-checkbox"/);
  assert.match(html, /id="feedback-bounty-note"/);
  assert.match(html, /Put a kudos bounty on this/);
  assert.match(html, /pledges 1 of your weekly kudos/);
});

test('the bounty row sits after the app-state row and before the status line', () => {
  const stateIdx = html.indexOf('id="feedback-state-row"');
  const bountyIdx = html.indexOf('id="feedback-bounty-row"');
  const statusIdx = html.indexOf('id="feedback-status"');
  assert.ok(stateIdx > 0 && bountyIdx > 0 && statusIdx > 0);
  assert.ok(stateIdx < bountyIdx, 'the bounty row follows "Include app state"');
  assert.ok(bountyIdx < statusIdx, '…and precedes the submit status line');
});

test('the checkbox ships unchecked in the markup', () => {
  // The state checkbox above it IS `checked` by default; this one must not
  // be — a default-on box would spend allowance for people who never read
  // the row.
  const row = html.slice(
    html.indexOf('id="feedback-bounty-row"'),
    html.indexOf('id="feedback-status"')
  );
  assert.match(row, /id="feedback-bounty-checkbox"/);
  assert.doesNotMatch(row, /id="feedback-bounty-checkbox"[^>]*\schecked/);
});

// ── Open / reset behaviour ───────────────────────────────────────────

test('the row is repainted from the live Kudos budget, not a literal', () => {
  assert.match(appJs, /const resetBountyRow = \(\) => \{/);
  assert.match(appJs, /window\.Kudos\?\.Budget\?\.state/);
  // Both copy variants interpolate the server's numbers.
  assert.match(appJs, /\$\{remaining\} of \$\{limit\} kudos left this week/);
  assert.match(appJs, /You've used all \$\{limit\} kudos this week/);
  assert.match(appJs, /resets Monday 00:00 UTC/);
});

test('resetBountyRow unchecks the box and disables it at zero remaining', () => {
  const fn = appJs.slice(
    appJs.indexOf('const resetBountyRow = () => {'),
    appJs.indexOf('const activeTargetClasses')
  );
  assert.ok(fn.length > 0, 'found resetBountyRow');
  assert.match(fn, /bountyCheckbox\.checked = false/);
  assert.match(fn, /const exhausted = remaining === 0/);
  assert.match(fn, /bountyCheckbox\.disabled = exhausted/);
  assert.match(fn, /bountyRow\.classList\.remove\('hidden'\)/);
});

test('openFeedbackModal resets the row and refreshes the budget', () => {
  const open = appJs.slice(
    appJs.indexOf('App.openFeedbackModal = (opts = {}) => {'),
    appJs.indexOf("document.getElementById('feedback-btn').addEventListener")
  );
  assert.ok(open.length > 0, 'found openFeedbackModal');
  assert.match(open, /resetBountyRow\(\)/);
  // A long-lived tab would otherwise show an hour-stale figure.
  assert.match(open, /window\.Kudos\?\.Budget\?\.refresh\?\.\(\)/);
});

test('cancelling the dialog clears any pledge intent', () => {
  const cancel = appJs.slice(appJs.indexOf("document.getElementById('feedback-cancel').addEventListener"));
  assert.match(cancel.slice(0, 900), /bountyCheckbox\.checked = false/);
});

// ── Submit ───────────────────────────────────────────────────────────

test('submitFeedback sends bounty only for a ticked, enabled, visible box', () => {
  const submit = appJs.slice(
    appJs.indexOf('const submitFeedback = async () => {'),
    appJs.indexOf('App.openFeedbackModal = (opts = {}) => {')
  );
  assert.match(submit, /const wantBounty = bountyCheckbox\.checked && !bountyCheckbox\.disabled/);
  assert.match(submit, /if \(wantBounty\) body\.bounty = true/);
  // A disabled box must never send the flag — that's the allowance-spent
  // state, where the server would refuse it anyway.
  assert.match(submit, /!bountyRow\.classList\.contains\('hidden'\)/);
});

test('the confirmation reports the bounty outcome and refreshes the meter', () => {
  const submit = appJs.slice(
    appJs.indexOf('const submitFeedback = async () => {'),
    appJs.indexOf('App.openFeedbackModal = (opts = {}) => {')
  );
  assert.match(submit, /and pledged 1 kudos as a bounty/);
  assert.match(submit, /\$\{data\.bounty\.remaining\} left this week/);
  assert.match(submit, /Couldn't add the bounty/);
  // The drawer meter must show the number the user just spent down to.
  assert.match(submit, /data\.bounty\.placed[\s\S]{0,400}Kudos\?\.Budget\?\.refresh/);
});

// ── Screenshot deep links ────────────────────────────────────────────

test('_applyFeedbackShot handles both feedback and feedback-spent', () => {
  assert.match(appJs, /_applyFeedbackShot\(\) \{/);
  assert.match(appJs, /App\._applyFeedbackShot\(\);/);
  const shot = appJs.slice(
    appJs.indexOf('_applyFeedbackShot() {'),
    appJs.indexOf('renderAdminButton() {')
  );
  assert.match(shot, /shot !== 'feedback' && shot !== 'feedback-spent'/);
  assert.match(shot, /App\.openFeedbackModal\(\)/);
  // The spent variant forces a client-side zero so the disabled state is
  // reviewable without writing kudos rows for a real user.
  assert.match(shot, /remaining: 0/);
});

test('dapp.json checks both shot links and the unchecked/disabled states', () => {
  const paths = dapp.tests.map((t) => t.path);
  assert.ok(paths.includes('/?shot=feedback'), 'the enabled state is checked');
  assert.ok(paths.includes('/?shot=feedback-spent'), 'the disabled state is checked');

  const enabled = dapp.tests.find(
    (t) => t.path === '/?shot=feedback' && t.expectSelector
  );
  assert.match(enabled.expectSelector, /#feedback-bounty-row:not\(\.hidden\)/);
  assert.match(enabled.expectSelector, /#feedback-bounty-checkbox:not\(:checked\)/);

  const spent = dapp.tests.find(
    (t) => t.path === '/?shot=feedback-spent' && t.expectSelector
  );
  assert.match(spent.expectSelector, /#feedback-bounty-checkbox:disabled/);

  // Deliberately NOT scoped under `#feedback-modal`: PlatformUI adopts the
  // modal into the native kit, which reparents the card out of that wrapper
  // (verified in a real browser — the descendant selector matched nothing).
  // Same trap as the secrets panel's check; see tests/platform-env-admin.js.
  // `#feedback-bounty-row:not(.hidden)` is the real discriminator, since the
  // row ships hidden and is only revealed once the dialog opens.
  for (const t of [enabled, spent]) {
    assert.doesNotMatch(t.expectSelector, /#feedback-modal/,
      'the adopted modal reparents its content — this selector would never match');
  }
});

test('the two shot checks are inside app-manifest\'s MAX_TESTS cap', () => {
  // dapp.json carries far more declared tests than the reader keeps, so a
  // check appended to the end of the array is silently dropped and never
  // runs against the staging preview. These two must stay near the top.
  const appManifest = require('../src/services/app-manifest');
  const kept = appManifest.read(root).tests.filter((t) => /shot=feedback/.test(t.path));
  assert.equal(kept.length, 2,
    'both bounty-row checks must survive the cap — keep them at the top of dapp.json\'s tests array');
});

// ── The 5 → 20 sweep ─────────────────────────────────────────────────

test('the Kudos-tab subtitle reads the cap from the budget', () => {
  assert.doesNotMatch(lbJs, /'5 kudos per week/);
  assert.match(lbJs, /window\.Kudos\?\.Budget\?\.state\?\.limit \|\| 20/);
  assert.match(lbJs, /kudos per week, resets Monday 00:00 UTC/);
});

test('a Dev-screen pledge also refreshes the drawer kudos meter', () => {
  const give = appViewJs.slice(
    appViewJs.indexOf('async giveIssueBounty(issueNumber) {'),
    appViewJs.indexOf('async markIssueInProgress(issueNumber) {')
  );
  assert.ok(give.length > 0, 'found giveIssueBounty');
  assert.match(give, /window\.Kudos\?\.Budget\?\.refresh\?\.\(\)/);
});
