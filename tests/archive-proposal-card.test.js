// Tests for the proposal-card Withdraw control (app-view.js
// _renderProposalCard / _renderGovCard). A proposer-only Withdraw button
// must render on your OWN live (status:'promoted') proposals, beside
// "Open session", and must NOT render on someone else's proposal or on a
// merged/merging card. Governance cards get the equivalent creator-only
// Withdraw button.
//
// app-view.js is a plain browser script (`const AppView = {…}`) that
// defines its own escapeHtml/etc. We load its source into a vm context,
// stub the external globals it reaches (App, Kudos, relTime, window,
// document), expose AppView, and assert on the returned HTML string.
//
// Run with: node --test tests/archive-proposal-card.test.js

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
  AppView._proposalsCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  AppView.__sandbox = sandbox;
  return AppView;
}

const ME = 42;
const baseProposal = (over) => ({
  id: 7, pr_number: 700, pr_title: 'Tidy the header', username: 'me',
  user_id: ME, status: 'promoted', created_at: '2026-06-01T00:00:00Z',
  ...over,
});

test('my own promoted proposal renders the Withdraw control', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal());
  assert.match(html, /withdrawProposal\(7\)/, 'Withdraw button wired to withdrawProposal(id)');
  assert.match(html, />Withdraw</, 'button is labelled Withdraw');
  assert.doesNotMatch(html, />Archive</, 'proposal card no longer says Archive');
  assert.match(html, /openProposalSession\(7\)/, 'Open session still present');
});

test("someone else's promoted proposal does NOT render Withdraw", () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({ user_id: 999 }));
  assert.doesNotMatch(html, /withdrawProposal/, 'not the proposer — no Withdraw');
  assert.doesNotMatch(html, /openProposalSession/, 'not the proposer — no Open session');
});

test('my merged proposal does NOT render Withdraw', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({ status: 'merged' }));
  assert.doesNotMatch(html, /withdrawProposal/, 'merged card has no Withdraw');
});

test('my merging proposal does NOT render Withdraw', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({ status: 'merging' }));
  assert.doesNotMatch(html, /withdrawProposal/, 'merging card has no Withdraw');
});

// Rename and visibility PRs are ordinary promoted chat_sessions rows, so
// the owner-scoped Withdraw button renders on them too.
test('my own rename PR proposal renders Withdraw', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({ pr_title: 'Rename to "Cooler App"' }));
  assert.match(html, /withdrawProposal\(7\)/, 'rename PR shows Withdraw');
});

// #313: the card-level "Ask AI" advisor button renders on proposals the
// viewer does NOT own (where there's no "Open session"), and is omitted
// on the viewer's own cards.
test("someone else's proposal renders the Ask AI card button", () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({ user_id: 999 }));
  assert.match(html, /gc-ask-ai-btn/, 'Ask AI button present on a foreign proposal');
  assert.match(html, /data-proposal-id="7"/, 'wired to the proposal id');
});

test('my own proposal does NOT render the Ask AI card button', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal());
  assert.doesNotMatch(html, /gc-ask-ai-btn/, 'own card has no Ask AI (Open session covers it)');
});

test("someone else's merged proposal renders the Ask AI card button", () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({ user_id: 999, status: 'merged' }));
  assert.match(html, /gc-ask-ai-btn/, 'Ask AI present on a foreign merged card');
});

test('withdrawProposal POSTs to the archive endpoint and reloads the feed', async () => {
  const AppView = makeAppView(ME);
  let posted = null;
  let reloaded = false;
  AppView._proposals = [baseProposal()];
  // fetch/ConfirmModal are resolved against the sandbox global at call
  // time, so patching them post-load drives the real handler.
  AppView.__sandbox.fetch = async (url, init) => {
    posted = { url, method: init && init.method };
    return { ok: true, json: async () => ({}) };
  };
  AppView.__sandbox.ConfirmModal = { show: async () => true };
  AppView._loadDevFeed = async () => { reloaded = true; };
  await AppView.withdrawProposal(7);
  assert.equal(posted.url, '/api/sessions/7/archive', 'POSTs to the owner-scoped archive endpoint');
  assert.equal(posted.method, 'POST');
  assert.equal(reloaded, true, 'feed reloaded on success');
});

test('withdrawProposal does nothing when the confirm is cancelled', async () => {
  const AppView = makeAppView(ME);
  let posted = false;
  AppView._proposals = [baseProposal()];
  AppView.__sandbox.fetch = async () => { posted = true; return { ok: true, json: async () => ({}) }; };
  AppView.__sandbox.ConfirmModal = { show: async () => false };
  AppView._loadDevFeed = async () => {};
  await AppView.withdrawProposal(7);
  assert.equal(posted, false, 'cancelled confirm — no POST');
});

// ---- Governance card Withdraw -------------------------------------------

const baseGov = (over) => ({
  id: 31, kind: 'secret_change', title: 'Set secret API_KEY',
  created_by: ME, created_by_username: 'me', status: 'open',
  payload: { action: 'set', key: 'API_KEY' },
  up_count: 1, down_count: 0,
  created_at: '2026-06-01T00:00:00Z',
  ...over,
});

test('my own governance proposal renders a creator-only Withdraw button', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderGovCard(baseGov());
  assert.match(html, /withdrawGovProposal\(31\)/, 'Withdraw wired to withdrawGovProposal(id)');
  assert.match(html, />Withdraw</, 'button labelled Withdraw');
});

test("someone else's governance proposal does NOT render Withdraw", () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderGovCard(baseGov({ created_by: 999 }));
  assert.doesNotMatch(html, /withdrawGovProposal/, 'not the creator — no Withdraw');
});

test('withdrawGovProposal POSTs to the gated close endpoint and reloads', async () => {
  const AppView = makeAppView(ME);
  let posted = null;
  let reloaded = false;
  AppView.__sandbox.fetch = async (url, init) => {
    posted = { url, method: init && init.method };
    return { ok: true, json: async () => ({}) };
  };
  AppView.__sandbox.ConfirmModal = { show: async () => true };
  AppView._loadDevFeed = async () => { reloaded = true; };
  await AppView.withdrawGovProposal(31);
  assert.equal(posted.url, '/api/issues/31/close', 'POSTs to the creator-gated close/withdraw endpoint');
  assert.equal(posted.method, 'POST');
  assert.equal(reloaded, true, 'feed reloaded on success');
});
