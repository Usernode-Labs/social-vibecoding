// #404: consolidated action-button layout on issue / proposal / governance /
// merged cards (app-view.js). This is a LAYOUT-ONLY treatment: every action
// button stays visible and inline (no overflow "⋯" menu, no primary-violet
// emphasis), in its current colour/handler/order — they are simply routed
// through one shared _cardActionsHtml composer that wraps them in a single
// consistent, evenly-gapped row (.gc-card-actions). These tests pin that
// contract: all actions render inline, the shared container is used, and none
// of the removed overflow/primary machinery leaks into the markup. The
// group-chat collapseVoted path through voteButtonsHtml is unchanged.
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
    // Distinct marker so we can assert the kudos button is present inline.
    Kudos: { renderButton: () => '<button class="gc-vote-btn">kudos</button>' },
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
  AppView._proposalsCtx = { majority: 1 };
  AppView._mergedCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  AppView.__sandbox = sandbox;
  return AppView;
}

const ME = 42;

// Assert none of the removed overflow/primary machinery appears in markup.
function assertNoOverflowMachinery(html) {
  assert.doesNotMatch(html, /gc-overflow-btn/, 'no ⋯ overflow trigger');
  assert.doesNotMatch(html, /gc-action-menu/, 'no overflow menu');
  assert.doesNotMatch(html, /gc-vote-btn-primary/, 'no primary-violet emphasis');
}

// ── _cardActionsHtml composer (flat, layout-only) ─────────────────────────

test('_cardActionsHtml: wraps a flat button list in one consistent row', () => {
  const AppView = makeAppView(ME);
  const html = AppView._cardActionsHtml([
    '<button class="gc-vote-btn">A</button>',
    '',
    '<button class="gc-vote-btn">B</button>',
  ]);
  assert.match(html, /^<div class="gc-card-actions">/, 'uses the shared container');
  assert.match(html, />A</);
  assert.match(html, />B</);
  assertNoOverflowMachinery(html);
});

test('_cardActionsHtml: empty / all-falsy input renders nothing', () => {
  const AppView = makeAppView(ME);
  assert.equal(AppView._cardActionsHtml([]), '');
  assert.equal(AppView._cardActionsHtml(['', null, undefined]), '');
  assert.equal(AppView._cardActionsHtml(), '');
});

// ── Issue card ───────────────────────────────────────────────────────────

const baseIssue = (over) => ({ number: 5, title: 'Fix the thing', ...over });

test('issue card: all actions inline in the shared row, no primary/overflow', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderIssueRow(baseIssue());
  assert.match(html, /gc-card-actions/, 'shared action row present');
  assert.match(html, /giveIssueBounty\(5\)/, 'Pledge kudos present');
  assert.match(html, /createPrForIssue\(5\)/, 'Create proposal present');
  assert.match(html, /confirmAutoSession\(5\)/, 'Generate proposal present');
  assert.match(html, />Create proposal</);
  assert.match(html, />Generate proposal</);
  assertNoOverflowMachinery(html);
});

test('issue card: a ready headless run keeps its contextual label inline (no violet)', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderIssueRow(baseIssue({
    headless: { status: 'ready', outcome: 'spec', sessionId: 90 },
  }));
  assert.match(html, /startFromAutoSession\(90\)[^>]*>Review spec/, 'contextual ready label present');
  assert.match(html, />Create proposal</, 'Create proposal still present');
  assert.match(html, /giveIssueBounty\(5\)/, 'kudos still present');
  assertNoOverflowMachinery(html);
});

test('issue card: question-outcome rerun "Generate proposal" stays inline', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderIssueRow(baseIssue({
    headless: { status: 'ready', outcome: 'question', sessionId: 91 },
  }));
  assert.match(html, /startFromAutoSession\(91\)/, 'clone action present');
  assert.match(html, /confirmAutoSession\(5\)/, 'rerun Generate proposal present');
  assertNoOverflowMachinery(html);
});

// ── Proposal card ──────────────────────────────────────────────────────────

const baseProposal = (over) => ({
  id: 7, pr_number: 700, pr_title: 'Tidy the header', username: 'me',
  user_id: 999, status: 'promoted', yes_count: 0, no_count: 0,
  created_at: '2026-06-01T00:00:00Z', ...over,
});

test('proposal card: vote pair keeps its yes/no colours, all actions inline', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal());
  assert.match(html, /gc-vote-btn-yes[^>]*castVote\(7, 'yes'\)/);
  assert.match(html, /gc-vote-btn-no[^>]*castVote\(7, 'no'\)/);
  assert.match(html, /gc-card-actions/, 'shared action row present');
  assertNoOverflowMachinery(html);
});

test('proposal card (admin, not author): every action renders inline, none hidden', () => {
  const AppView = makeAppView(ME, { admin: true });
  const html = AppView._renderProposalCard(baseProposal({ staging_url: 'https://stg.example' }));
  assert.match(html, /swapToStagingForSession\(7/, 'Preview present');
  assert.match(html, />kudos</, 'kudos present');
  assert.match(html, /castAdminMerge\(7\)/, 'Admin merge present');
  assert.match(html, /gc-explore-chat-btn/, 'Explore in dev chat present');
  assertNoOverflowMachinery(html);
});

test('proposal card (author): Open session + Withdraw render inline', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({ user_id: ME }));
  assert.match(html, /openProposalSession\(7\)/, 'Open session present');
  assert.match(html, /withdrawProposal\(7\)/, 'Withdraw present');
  assert.doesNotMatch(html, /gc-explore-chat-btn/, 'no Explore pill on your own proposal');
  assertNoOverflowMachinery(html);
});

// ── Governance card ──────────────────────────────────────────────────────

const baseGov = (over) => ({
  id: 11, kind: 'secret_change', title: 'Set API key', up_count: 0, down_count: 0,
  created_by: 999, created_at: '2026-06-01T00:00:00Z', ...over,
});

test('gov card: yes/no/admin/withdraw all inline in the shared row', () => {
  const AppView = makeAppView(ME, { admin: true });
  const html = AppView._renderGovCard(baseGov({ created_by: ME }));
  assert.match(html, /castIssueVote\(11, 'up'\)/);
  assert.match(html, /castIssueVote\(11, 'down'\)/);
  assert.match(html, /castIssueAdminApply\(11\)/, 'Admin merge present');
  assert.match(html, /withdrawGovProposal\(11\)/, 'Withdraw present');
  assert.match(html, /gc-card-actions/);
  assertNoOverflowMachinery(html);
});

test('gov card: non-admin non-creator sees only yes/no (others gated off, as today)', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderGovCard(baseGov());
  assert.match(html, /castIssueVote\(11, 'up'\)/);
  assert.doesNotMatch(html, /castIssueAdminApply/, 'no admin merge for non-admin');
  assert.doesNotMatch(html, /withdrawGovProposal/, 'no withdraw for non-creator');
  assertNoOverflowMachinery(html);
});

// ── Merged card ────────────────────────────────────────────────────────────

const baseMerged = (over) => ({
  id: 8, pr_number: 800, pr_title: 'Ship it', username: 'someone', user_id: 999,
  status: 'merged', yes_count: 3, no_count: 1, chat_count: 0,
  created_at: '2026-06-01T00:00:00Z', ...over,
});

test('merged card: voted box, Undo, kudos, Explore pill all inline in the shared row', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderMergedCard(baseMerged({ my_vote: 'yes' }), 1);
  assert.match(html, /gc-card-actions/, 'shared action row present');
  assert.match(html, /gc-vote-voted-box-yes[^>]*>You voted Yes</, '"You voted Yes" indicator present in the action row');
  assert.match(html, /undoPr\(8\)/, 'Undo present');
  assert.match(html, /gc-explore-chat-btn/, 'Explore in dev chat present');
  assertNoOverflowMachinery(html);
});

test('merged card: revert-status link renders inline instead of an Undo button', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderMergedCard(baseMerged({
    revert_session_id: 9, revert_status: 'merged', revert_pr_number: 900,
  }), 1);
  assert.match(html, /Undone by PR#900/, 'revert status link present');
  assert.doesNotMatch(html, /undoPr/, 'no Undo button once a revert exists');
  assertNoOverflowMachinery(html);
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

test('voteButtonsHtml: full set concatenates Preview/Yes/No/Admin (group-chat row)', () => {
  const AppView = makeAppView(ME, { admin: true });
  const html = AppView.voteButtonsHtml(baseProposal({ staging_url: 'https://stg' }));
  assert.match(html, /swapToStagingForSession/, 'Preview');
  assert.match(html, /castVote\(7, 'yes'\)/, 'Yes');
  assert.match(html, /castVote\(7, 'no'\)/, 'No');
  assert.match(html, /castAdminMerge\(7\)/, 'Admin merge');
});
