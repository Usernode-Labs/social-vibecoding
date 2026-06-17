// #404: consolidated action-button layout on issue / proposal / governance /
// merged cards (app-view.js). Actions are now grouped into primary (filled
// accent), secondary (inline outline pills), and overflow (the long tail,
// behind a "⋯" menu) by the shared _cardActionsHtml composer. These tests
// pin the contract: every existing action still renders, the primary action
// carries gc-vote-btn-primary, the ⋯ menu appears only when it consolidates
// ≥2 actions (single-item overflow renders inline), and voteButtonsHtml's
// group-chat collapsed-vote path is unchanged.
//
// app-view.js is a plain browser script (`const AppView = {…}`); we load it
// into a vm context, stub the globals it reaches, and assert on the returned
// HTML strings — same harness as archive-proposal-card.test.js.
//
// Run with: node --test tests/card-action-layout.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function makeAppView(userId, opts) {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: userId, canAdminWrite: !!(opts && opts.admin) } },
    // Distinct marker so we can assert the kudos button is present in a bucket.
    Kudos: { renderButton: () => '<button class="gc-vote-btn">kudos</button>' },
    ConfirmModal: { show: async () => true },
    ProposalDiscuss: { open: () => {} },
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
  AppView._proposalsCtx = { majority: 1 };
  AppView._mergedCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  AppView.__sandbox = sandbox;
  return AppView;
}

const ME = 42;

// ── _cardActionsHtml composer ────────────────────────────────────────────

test('_cardActionsHtml: ≥2 overflow items render the ⋯ menu', () => {
  const AppView = makeAppView(ME);
  const html = AppView._cardActionsHtml({
    primary: ['<button class="gc-vote-btn">A</button>'],
    overflow: ['<button class="gc-vote-btn">B</button>', '<button class="gc-vote-btn">C</button>'],
  });
  assert.match(html, /gc-overflow-btn/, 'overflow trigger rendered');
  assert.match(html, /gc-action-menu/, 'overflow menu container rendered');
  assert.match(html, />B</, 'first overflow action present in menu');
  assert.match(html, />C</, 'second overflow action present in menu');
});

test('_cardActionsHtml: a single overflow item renders inline (no ⋯ menu)', () => {
  const AppView = makeAppView(ME);
  const html = AppView._cardActionsHtml({
    primary: ['<button class="gc-vote-btn">A</button>'],
    overflow: ['<button class="gc-vote-btn">Solo</button>'],
  });
  assert.doesNotMatch(html, /gc-overflow-btn/, 'no menu for a single overflow action');
  assert.match(html, />Solo</, 'the solo action still renders inline');
});

test('_cardActionsHtml: empty buckets render nothing', () => {
  const AppView = makeAppView(ME);
  assert.equal(AppView._cardActionsHtml({}), '');
  assert.equal(AppView._cardActionsHtml({ primary: [''], overflow: [null] }), '');
});

test('_asPrimary: splices the primary class onto a vote button', () => {
  const AppView = makeAppView(ME);
  const out = AppView._asPrimary('<button class="gc-vote-btn" onclick="x()">Go</button>');
  assert.match(out, /class="gc-vote-btn gc-vote-btn-primary"/);
  assert.match(out, /onclick="x\(\)"/, 'handler preserved');
  assert.equal(AppView._asPrimary(''), '', 'no-op on empty');
});

// ── Issue card ───────────────────────────────────────────────────────────

const baseIssue = (over) => ({ number: 5, title: 'Fix the thing', ...over });

test('issue card: fresh issue makes "Create proposal" the primary action', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderIssueRow(baseIssue());
  // Create proposal is the violet primary.
  assert.match(html, /class="gc-vote-btn gc-vote-btn-primary"[^>]*createPrForIssue\(5\)[^>]*>Create proposal</);
  // Generate proposal still offered.
  assert.match(html, /confirmAutoSession\(5\)/);
  assert.match(html, />Generate proposal</);
  // Pledge kudos preserved (the lone overflow item → inline, no menu).
  assert.match(html, /giveIssueBounty\(5\)/);
  assert.match(html, />Pledge kudos</);
  assert.doesNotMatch(html, /gc-overflow-btn/, 'one overflow action → no menu');
});

test('issue card: a ready headless run becomes the primary, Create drops to secondary', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderIssueRow(baseIssue({
    headless: { status: 'ready', outcome: 'spec', sessionId: 90 },
  }));
  assert.match(html, /class="gc-vote-btn gc-vote-btn-primary"[^>]*startFromAutoSession\(90\)[^>]*>Review spec/);
  assert.match(html, />Create proposal</, 'Create proposal still present');
  assert.match(html, /giveIssueBounty\(5\)/, 'kudos still present');
});

test('issue card: question-outcome rerun + kudos give a ⋯ overflow menu', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderIssueRow(baseIssue({
    headless: { status: 'ready', outcome: 'question', sessionId: 91 },
  }));
  // Two overflow items (rerun Generate + Pledge kudos) → menu appears.
  assert.match(html, /gc-overflow-btn/, 'menu appears with ≥2 overflow actions');
  assert.match(html, /startFromAutoSession\(91\)/, 'primary clone action present');
  assert.match(html, /confirmAutoSession\(5\)/, 'rerun Generate proposal present');
});

// ── Proposal card ──────────────────────────────────────────────────────────

const baseProposal = (over) => ({
  id: 7, pr_number: 700, pr_title: 'Tidy the header', username: 'me',
  user_id: 999, status: 'promoted', yes_count: 0, no_count: 0,
  created_at: '2026-06-01T00:00:00Z', ...over,
});

test('proposal card: vote pair is primary and keeps its yes/no colours (not violet)', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal());
  assert.match(html, /gc-vote-btn-yes[^>]*castVote\(7, 'yes'\)/);
  assert.match(html, /gc-vote-btn-no[^>]*castVote\(7, 'no'\)/);
  // The vote buttons are positionally primary but must NOT get the violet
  // primary fill — they keep their semantic green/red.
  assert.doesNotMatch(html, /gc-vote-btn-yes gc-vote-btn-primary/);
});

test('proposal card (admin, not author): every action survives, power actions in ⋯ menu', () => {
  const AppView = makeAppView(ME, { admin: true });
  const html = AppView._renderProposalCard(baseProposal({ staging_url: 'https://stg.example' }));
  // Preview + kudos are inline secondary; Admin merge + Ask AI hide in overflow.
  assert.match(html, /swapToStagingForSession\(7/, 'Preview present');
  assert.match(html, />kudos</, 'kudos present');
  assert.match(html, /castAdminMerge\(7\)/, 'Admin merge preserved');
  assert.match(html, /gc-ask-ai-btn/, 'Ask AI preserved');
  assert.match(html, /gc-overflow-btn/, 'power actions consolidated behind ⋯');
});

test('proposal card (author): Open session + Withdraw still render', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({ user_id: ME }));
  assert.match(html, /openProposalSession\(7\)/, 'Open session present');
  assert.match(html, /withdrawProposal\(7\)/, 'Withdraw present');
  assert.doesNotMatch(html, /gc-ask-ai-btn/, 'no Ask AI on your own proposal');
});

// ── Governance card ──────────────────────────────────────────────────────

const baseGov = (over) => ({
  id: 11, kind: 'secret_change', title: 'Set API key', up_count: 0, down_count: 0,
  created_by: 999, created_at: '2026-06-01T00:00:00Z', ...over,
});

test('gov card: yes/no primary, admin merge + withdraw consolidate into ⋯', () => {
  const AppView = makeAppView(ME, { admin: true });
  const html = AppView._renderGovCard(baseGov({ created_by: ME }));
  assert.match(html, /castIssueVote\(11, 'up'\)/);
  assert.match(html, /castIssueVote\(11, 'down'\)/);
  assert.match(html, /castIssueAdminApply\(11\)/, 'Admin merge preserved');
  assert.match(html, /withdrawGovProposal\(11\)/, 'Withdraw preserved');
  assert.match(html, /gc-overflow-btn/, 'two overflow actions → menu');
});

test('gov card: non-admin non-creator has no overflow menu', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderGovCard(baseGov());
  assert.doesNotMatch(html, /gc-overflow-btn/, 'nothing to consolidate');
  assert.doesNotMatch(html, /castIssueAdminApply/, 'no admin merge for non-admin');
  assert.doesNotMatch(html, /withdrawGovProposal/, 'no withdraw for non-creator');
});

// ── Merged card ────────────────────────────────────────────────────────────

const baseMerged = (over) => ({
  id: 8, pr_number: 800, pr_title: 'Ship it', username: 'someone', user_id: 999,
  status: 'merged', yes_count: 3, no_count: 1, chat_count: 0,
  created_at: '2026-06-01T00:00:00Z', ...over,
});

test('merged card: Undo + Ask AI consolidate, voted indicator moves up', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderMergedCard(baseMerged({ my_vote: 'yes' }), 1);
  assert.match(html, /undoPr\(8\)/, 'Undo preserved');
  assert.match(html, /gc-ask-ai-btn/, 'Ask AI preserved');
  assert.match(html, /gc-overflow-btn/, 'two overflow actions → menu');
  assert.match(html, /gc-vote-voted-box-yes[^>]*>You voted Yes</, '"You voted Yes" indicator present');
});

test('merged card: revert-status link stays inline, not in the menu', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderMergedCard(baseMerged({
    revert_session_id: 9, revert_status: 'merged', revert_pr_number: 900,
  }), 1);
  assert.match(html, /Undone by PR#900/, 'revert status link present');
  assert.doesNotMatch(html, /undoPr/, 'no Undo button once a revert exists');
});

// ── voteButtonsHtml: group-chat collapsed-vote path unchanged ──────────────

test('voteButtonsHtml: collapseVoted returns the read-only "You voted X" box', () => {
  const AppView = makeAppView(ME);
  const yes = AppView.voteButtonsHtml(baseProposal({ my_vote: 'yes' }), { collapseVoted: true });
  assert.match(yes, /gc-vote-voted-box gc-vote-voted-box-yes/);
  assert.match(yes, />You voted Yes</);
  // A non-promoted PR with no vote collapses to nothing.
  const none = AppView.voteButtonsHtml(baseProposal({ status: 'merged' }), { collapseVoted: true });
  assert.equal(none, '');
});

test('voteButtonsHtml: full set (no collapse) still concatenates Preview/Yes/No/Admin', () => {
  const AppView = makeAppView(ME, { admin: true });
  const html = AppView.voteButtonsHtml(baseProposal({ staging_url: 'https://stg' }));
  assert.match(html, /swapToStagingForSession/, 'Preview');
  assert.match(html, /castVote\(7, 'yes'\)/, 'Yes');
  assert.match(html, /castVote\(7, 'no'\)/, 'No');
  assert.match(html, /castAdminMerge\(7\)/, 'Admin merge');
});
