// #695: distinguish approver votes from non-approver (advisory) votes on
// invited-approvers apps.
//
// Covered here (app-view.js):
//   - _renderGovCard fills its tally pill from the QUALIFIED counts (the
//     issues-feed serializer already sends them) so a governance proposal
//     with only advisory votes reads "0 of 1 approval", never "2 / 1".
//   - voteButtonsHtml / the governance-card buttons split the count into
//     "✓approver +advisory" on invited rows and keep the plain total
//     everywhere else.
//   - _votingHelpText names the advisory numbers only when they exist.
//
// Harness mirrors tests/archive-proposal-card.test.js: load the real
// app-view.js into a vm context with stubbed globals and assert on the
// returned HTML/text.
//
// Run with: node --test tests/approver-vote-breakdown.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function makeAppView(opts) {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 42, canAdminWrite: !!(opts && opts.admin) } },
    Kudos: { renderButton: () => '' },
    ConfirmModal: { show: async () => true },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 1, activeUsers: 1 };
  AppView._visualsOpen = new Set();
  return AppView;
}

// A governance (issue) row as the issues-feed serializer shapes it on an
// invited-approvers app: raw up/down tallies PLUS the qualified counts.
const govRow = (over) => ({
  id: 9100004,
  kind: 'secret_change',
  title: 'Set ADVISORY_DEMO to "on"',
  payload: { key: 'ADVISORY_DEMO', action: 'set', hasValue: true },
  status: 'open',
  created_by: 1,
  created_by_username: 'someone',
  created_at: '2026-06-01T00:00:00Z',
  up_count: 2,
  down_count: 0,
  my_vote: null,
  chat_count: 0,
  votes_required: 1,
  merge_window_ends_at: null,
  contested: false,
  approval_policy: 'invited',
  approvals_required: 1,
  qualified_yes_count: 0,
  qualified_no_count: 0,
  ...over,
});

// A PR proposal row as /promoted shapes it on an invited-approvers app.
const prRow = (over) => ({
  id: 7,
  pr_number: 700,
  pr_title: 'Tidy the header',
  username: 'someone',
  user_id: 1,
  status: 'promoted',
  created_at: '2026-06-01T00:00:00Z',
  yes_count: 3,
  no_count: 0,
  my_vote: null,
  approval_policy: 'invited',
  approvals_required: 1,
  qualified_yes_count: 1,
  qualified_no_count: 0,
  ...over,
});

test('governance card pill fills from qualified counts, not the blended tally', () => {
  const AppView = makeAppView();
  const html = AppView._renderGovCard(govRow());
  // Two advisory up votes, zero approver votes, needs 1 approval → the
  // at-least pill renders at zero, and no "2 / 1" blended pill appears.
  assert.match(html, /0 of 1 approval/, 'pill shows the qualified progress');
  assert.doesNotMatch(html, /gc-vote-count-label">2 \/ 1</, 'no blended 2/1 pill');
  assert.doesNotMatch(html, /gc-vote-count-yes"/, 'pill is not in the reached (green) state');
});

test('governance card buttons split into ✓approver +advisory on invited apps', () => {
  const AppView = makeAppView();
  const html = AppView._renderGovCard(govRow());
  assert.match(html, /Yes \(✓0 \+2\)/, 'up button shows the split');
  assert.match(html, /No \(✓0\)/, 'down button shows the qualified count');
  assert.match(html, /votes from invited approvers/, 'buttons carry the notation tooltip');
});

test('governance card without governance fields keeps the plain totals', () => {
  const AppView = makeAppView();
  const html = AppView._renderGovCard(govRow({
    approval_policy: undefined,
    approvals_required: null,
    qualified_yes_count: undefined,
    qualified_no_count: undefined,
    votes_required: 2,
  }));
  assert.match(html, /Yes \(2\)/, 'plain blended count under the default policy');
  assert.doesNotMatch(html, /✓/, 'no breakdown notation');
});

test('voteButtonsHtml splits counts on invited rows and not otherwise', () => {
  const AppView = makeAppView();
  // 3 raw yes, 1 qualified → "✓1 +2"; 0/0 no → "✓0".
  const invited = AppView.voteButtonsHtml(prRow());
  assert.match(invited, /Yes \(✓1 \+2\)/);
  assert.match(invited, /No \(✓0\)/);
  assert.match(invited, /votes from invited approvers/);

  // No advisory votes → just the qualified count, no "+n" suffix.
  const allApprovers = AppView.voteButtonsHtml(prRow({ yes_count: 1 }));
  assert.match(allApprovers, /Yes \(✓1\)/);
  assert.doesNotMatch(allApprovers, /Yes \(✓1 \+/);

  // Default 'anyone' policy → unchanged plain totals.
  const anyone = AppView.voteButtonsHtml(prRow({
    approval_policy: 'anyone', qualified_yes_count: 3, qualified_no_count: 0,
  }));
  assert.match(anyone, /Yes \(3\)/);
  assert.doesNotMatch(anyone, /✓/);
});

test('_votingHelpText names the advisory numbers only when they exist', () => {
  const AppView = makeAppView();
  // 2 advisory yes on an invited at-least-1 app → counted sentence.
  const withAdvisory = AppView._votingHelpText(prRow({
    yes_count: 2, qualified_yes_count: 0, check_state: 'passing',
  }));
  assert.match(withAdvisory, /2 advisory Yes and 0 advisory No from non-approvers are recorded but don't count\./);
  assert.match(withAdvisory, /Currently 0 of 1/, 'progress reads from the qualified tally');

  // No advisory votes → the generic invited reassurance instead.
  const noAdvisory = AppView._votingHelpText(prRow({
    yes_count: 1, qualified_yes_count: 1, check_state: 'passing',
  }));
  assert.doesNotMatch(noAdvisory, /advisory Yes/);
  assert.match(noAdvisory, /only approvers’ votes count/);

  // Default-mode invited app (no approvals_required) also appends the split.
  const defaultMode = AppView._votingHelpText(prRow({
    approvals_required: null, votes_required: 1,
    yes_count: 2, qualified_yes_count: 0, check_state: 'passing',
  }));
  assert.match(defaultMode, /2 advisory Yes and 0 advisory No/);
});

test('voteCountPill tooltip mentions the excluded advisory votes', () => {
  const AppView = makeAppView();
  const pill = AppView.voteCountPill(prRow({
    yes_count: 2, qualified_yes_count: 0,
  }), 1);
  assert.match(pill, /2 advisory votes from non-approvers don't fill this tally/);
  assert.match(pill, /0 of 1 approval/);
});
