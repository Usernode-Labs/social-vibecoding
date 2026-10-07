'use strict';

// B7 (decided: "Approve" on a project that is just you). A change on a
// project that is just the viewer's, whose one Yes is the Yes it needs, no
// longer asks them to vote: the status reads "Waiting for your approval",
// the step is "Your approval", the button reads "Approve" (their own Yes,
// which makes it live), and "Don't approve" sits last and red in ⋯, as
// today's No with its line. A group project, a rule asking for more than one
// Yes, or a test account's uncounted vote keeps the vote as it is.
//
// #3977 superseded B7's one tap. "Approve" opens the same picker a group's
// vote does, in the same places (the anchored popover on desktop, the kit
// sheet on touch), so approving is the same gesture on every project; its
// two sides read "Approve" / "Don't approve", with the optional note, and a
// Don't approve sends its line exactly as a group's No does. On a change
// Homeroom bot built, that line now reaches the bot, for a solo Don't approve
// and a group's No alike (tests/vote-reasons.test.js, tests/homeroom-bot-
// vote-line-postgres.test.js). The project's Needs you tab says Approve and
// Don't approve too. The words, the status and ⋯ are B7's, unchanged.
//
// Run with: node --test tests/homeroom-bot-approve-solo.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderToHtml, createElement, renderComponent } = require('./lib/render-tsx');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');
const CARD = 'frontend/src/features/dev-board/card/dev-card.tsx';
const CARD_SRC = fs.readFileSync(path.join(__dirname, '..', CARD), 'utf8');

function makeAppView(over = {}) {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 42, canAdminWrite: false } },
    Kudos: { renderButton: () => '', attach: () => {}, _ensureCache: () => ({ count: 0 }) },
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
    ...over,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 1 };
  return AppView;
}

const change = (over) => ({
  id: 7, pr_title: 'Sunday reminder', username: 'homeroom_bot', user_id: 999, status: 'promoted',
  yes_count: 0, no_count: 0, approval_epoch: 3, votes_required: 1, my_vote: null, created_at: '2026-10-01T00:00:00Z', ...over,
});

test('B7: which changes are approved rather than voted on', () => {
  const AppView = makeAppView();
  AppView.appData = { slug: 'plant-pal', audience: 'solo' };
  assert.equal(AppView._approveSolo(change()), true);
  assert.equal(AppView._approveSolo(change({ votes_required: null })), true, 'no snapshot: one person\'s project needs one');
  assert.equal(AppView._approveSolo(change({ votes_required: 2 })), false, 'a rule asking for two Yes votes keeps the vote');
  assert.equal(AppView._approveSolo(change({ my_vote_uncounted: true })), false, 'a test account\'s vote does not count');
  for (const audience of ['invited', 'open', undefined]) {
    AppView.appData = { slug: 'plant-pal', audience };
    assert.equal(AppView._approveSolo(change()), false, `${audience}: a group votes`);
  }
});

test('B7: the button, the status, the step and ⋯ on a project that is just yours', () => {
  const AppView = makeAppView();
  AppView.appData = { slug: 'plant-pal', audience: 'solo' };
  const [yes, no] = AppView._cardVoteButtonSpecs(change());
  assert.equal(yes.approve, true);
  assert.ok(!('approve' in no));
  const pill = AppView.statusPillState(change());
  assert.equal(pill.label, 'Waiting for your approval');
  assert.equal(pill.dot, true, 'it still says it needs you');
  const summary = AppView._summarizeRequirements(
    [{ key: 'approvals', state: 'waiting', actor: 'group', label: 'Enough approvals' }],
    { hasVoted: false, approveSolo: true },
  );
  assert.equal(summary.headline, 'Waiting for your approval');
  assert.equal(AppView._summarizeRequirements(
    [{ key: 'approvals', state: 'waiting', actor: 'group', label: 'Enough approvals' }], { hasVoted: false },
  ).headline, 'Waiting for your approval', 'B10a: a group\'s says it the same way');
  const items = AppView._proposalMenuItems(change(), {});
  const last = items[items.length - 1];
  assert.equal(last.label, 'Don’t approve');
  assert.equal(last.danger, true);
  assert.ok(!AppView._proposalMenuItems(change({ my_vote: 'no' }), {}).some((i) => i.label === 'Don’t approve'), 'once said, not offered again');
  AppView.appData = { slug: 'plant-pal', audience: 'invited' };
  assert.equal(AppView.statusPillState(change({ votes_required: 2 })).label, 'Vote · 0/2');
  assert.ok(!AppView._proposalMenuItems(change(), {}).some((i) => i.label === 'Don’t approve'));
  assert.match(SRC, /const voteStep = AppView\._approveSolo\(item\) \? 'Your approval' : 'Vote';/);
  // B10a: the change page's eyebrow and the card's meta line say it the same way.
  AppView.appData = { slug: 'plant-pal', audience: 'solo' };
  assert.equal(AppView._waitingWords(change()), 'Waiting for your approval');
  AppView.appData = { slug: 'plant-pal', audience: 'open' };
  assert.equal(AppView._waitingWords(change()), 'Waiting for approval');
  assert.match(SRC, /: item\.status === 'promoted' \? AppView\._waitingWords\(item\)/);
  assert.match(SRC, /\(item\.status === 'promoted' \? AppView\._waitingWords\(item\) : item\.status\)/);
});

// The pair `_cardVoteButtonSpecs` hands a solo change: the Yes carries
// `approve` (and `solo`, from the app's own record).
const yes = { key: 'yes', cls: 'gc-vote-btn gc-vote-btn-yes', title: 'Yes votes: 0 of 1', label: 'Yes (0/1)', act: { fn: 'castVote', args: [7, 'yes', 3] }, solo: true, approve: true };
const no = { key: 'no', cls: 'gc-vote-btn gc-vote-btn-no', title: 'No votes: 0', label: 'No (0/1)', act: { fn: 'castVote', args: [7, 'no', 3] } };
const active = (spec) => ({ ...spec, cls: `${spec.cls} gc-vote-active` });

test('#3977: Approve opens the picker a group\'s vote opens, and reads Approved once it is in', () => {
  const { VoteButton } = loadTsx(CARD);
  const open = renderToHtml(createElement(VoteButton, { yes, no }));
  assert.match(open, /^<button type="button" class="dev-vote-btn dev-vote-btn-approve" data-vote-btn="approve" aria-haspopup="dialog" title="Approve it, and it goes live\.">/,
    'still "Approve", and it says it opens a dialog');
  assert.match(open, />Approve<svg[^>]*dev-vote-caret/, 'with the caret every vote button wears');
  assert.ok(!/disabled/.test(open));
  // A Don't approve already said: the face says so, and opens the picker
  // again (on its line) to change it, as a group's "No" does.
  const said = renderToHtml(createElement(VoteButton, { yes, no: active(no) }));
  assert.match(said, /^<button type="button" class="dev-vote-btn dev-vote-btn-approve dev-vote-btn-no" data-vote-btn="not-approved" aria-haspopup="dialog" title="You didn’t approve it\. Press to change that\.">/);
  assert.match(said, />Not approved<svg[^>]*dev-vote-caret/);
  assert.ok(!/disabled/.test(said));
  // Approved is where it ends: the Yes made it live, nothing is left to pick.
  const done = renderToHtml(createElement(VoteButton, { yes: active(yes), no }));
  assert.match(done, /class="dev-vote-btn dev-vote-btn-approve dev-vote-btn-yes" data-vote-btn="approved"/);
  assert.match(done, /disabled=""/);
  assert.match(done, />Approved<\/button>$/, 'no caret on the one face that opens nothing');
  // A group keeps Vote, word for word.
  const group = renderToHtml(createElement(VoteButton, { yes: { ...yes, approve: undefined, solo: undefined }, no }));
  assert.match(group, /^<button type="button" class="dev-vote-btn" data-vote-btn="open" aria-haspopup="dialog"/);
  assert.match(group, />Vote<svg/);
  // One button, one path: the solo face is the group's button with other
  // words, so the board, the folded row (fold.tsx) and the change page
  // (topic-head.tsx), which all draw VoteButton, open the picker alike.
  const fn = CARD_SRC.slice(CARD_SRC.indexOf('export function VoteButton('), CARD_SRC.indexOf('export function VotePicker('));
  assert.match(fn, /const approve = !!yes\.approve && yes\.act\?\.fn === 'castVote';/);
  assert.equal((fn.match(/<button\b/g) || []).length, 1, 'no second, one-tap button');
  assert.match(fn, /onClick=\{toggle\}/, 'the press opens the picker (popover on desktop, sheet on touch)');
  assert.doesNotMatch(fn, /send\(yes, null\); \}\}/, 'the one tap is gone');
  assert.match(fn, /approve=\{approve\}/, 'the picker is told it is an approval');
  for (const file of ['frontend/src/features/dev-board/card/fold.tsx', 'frontend/src/features/dev-board/topic/topic-head.tsx']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(src, /<VoteButton yes=\{[^}]+\} no=\{[^}]+\} \/>/, `${file} draws the same button`);
  }
});

test('#3977: the picker\'s sides read Approve and Don\'t approve, with the note, and no tally', () => {
  const noop = () => {};
  const tally = (a) => (/\(([^)]*)\)\s*$/.exec(a.label || '') || [])[1] || '';
  const picker = (over) => renderComponent(CARD, 'VotePicker', {
    yes, no, prior: null, side: 'yes', line: '', reasonId: 'dev-vote-reason-7', tally, withLine: true, solo: true, approve: true,
    onSide: noop, onLine: noop, onBoxKey: noop, onCancel: noop, onSend: noop, ...(over || {}),
  });
  const onYes = picker();
  assert.match(onYes, /<div class="dev-vote-switch-label" id="dev-vote-reason-7-head">Your approval<\/div><div class="dev-vote-switch" role="group" aria-labelledby="dev-vote-reason-7-head">/,
    'the step\'s own name over the switch');
  assert.match(onYes, /<button type="button" class="dev-vote-switch-opt dev-vote-switch-yes" aria-pressed="true" data-act="castVote">[\s\S]*?Approve<\/button>/);
  assert.match(onYes, /<button type="button" class="dev-vote-switch-opt dev-vote-switch-no" aria-pressed="false" data-act="castVote">[\s\S]*?Don’t approve<\/button>/);
  assert.doesNotMatch(onYes, /dev-vote-n|0\/1/, 'one person\'s to give: no tally');
  assert.doesNotMatch(onYes, /Your vote|Vote yes|Vote no/);
  assert.match(onYes, /Add a note, if you like\.<\/label>/, 'the optional note');
  assert.match(onYes, /<button type="button" class="dev-vote-reason-send dev-vote-reason-send-yes">Approve<\/button>/, 'and no note needed to approve');
  const onNo = picker({ side: 'no' });
  assert.match(onNo, /What’s not working for you\? One line is plenty\.<\/label>/, 'a No\'s line, worded as any No\'s');
  assert.match(onNo, /placeholder="What would you want to change\?"/);
  assert.match(onNo, /<button type="button" class="dev-vote-reason-send dev-vote-reason-send-no" disabled="">Don’t approve<\/button>/,
    'Don\'t approve waits for its line, as a No does (the server asks for one)');
  const typed = picker({ side: 'no', line: 'Sort the list by date' });
  assert.match(typed, /<button type="button" class="dev-vote-reason-send dev-vote-reason-send-no">Don’t approve<\/button>/);
  const group = picker({ approve: false, solo: false });
  assert.match(group, />Your vote<\/div>/);
  assert.match(group, /Yes<span class="dev-vote-n">0\/1<\/span>/, 'a group keeps its words and tallies');
  assert.match(group, />Vote yes<\/button>/);
});

test('#3977: a solo Don\'t approve sends its note the way a group\'s No sends its line', async () => {
  // The picker hands VoteButton the side and the line; VoteButton sends the
  // side's own spec with the line in the options bag. Nothing in that path
  // asks whether the change is an approval, so a solo No is a group's No.
  const fn = CARD_SRC.slice(CARD_SRC.indexOf('export function VoteButton('), CARD_SRC.indexOf('export function VotePicker('));
  assert.match(fn, /const spec = side === 'yes' \? yes : no;/);
  assert.match(fn, /const isVote = yes\.act\?\.fn === 'castVote' \|\| yes\.act\?\.fn === 'castIssueVote';/, 'castVote: the line goes with it');
  assert.match(fn, /send\(spec, isVote \? \(trimmed \|\| null\) : null\);/);
  assert.match(fn, /call\(\{ fn: a\.act\.fn, args: \[\.\.\.args, \{ reason \}\] \}\);/);
  assert.match(fn, /onSend=\{submit\}/);
  // Fallback with no kit sheet: Approve asks for nothing, Don't approve asks
  // for its line through castVote's own prompt, as any No.
  assert.match(fn, /\{ label: '✓  Approve', handler: \(\) => send\(yes, null\) \}/);
  assert.match(fn, /label: approve \? '✕  Don’t approve' : [^\n]*handler: \(\) => pickTouch\(no\) \}/);

  // And castVote posts that line with the No: the server stores it on the
  // vote (pr_votes.reason) and writes it into the change's own discussion,
  // as a group's No does: on the vote row, or, on a change Homeroom bot
  // built, as the voter's reply that the bot's follow-up reads.
  const sent = [];
  const AppView = makeAppView({
    fetch: async (url, init) => {
      sent.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  AppView.appData = { slug: 'plant-pal', audience: 'solo' };
  AppView.refreshDevData = async () => {};
  const took = await AppView.castVote(7, 'no', 3, { reason: '  Sort the list   by date ' });
  assert.equal(took, true);
  const vote = sent.find((r) => r.url === '/api/sessions/7/vote');
  assert.ok(vote, 'the vote went to the change');
  assert.deepEqual(vote.body, { vote: 'no', expectedEpoch: 3, reason: 'Sort the list by date' });
});

test('#3977: ⋯ keeps "Don\'t approve", a second way to the same No', () => {
  // Left in place on purpose (B7's ⋯ item): the same castVote No, whose line
  // castVote asks for itself. The picker's No side is the main road to it.
  assert.match(SRC, /label: 'Don’t approve',[\s\S]{0,200}act: \(\) => AppView\.castVote\(pr\.id, 'no', \.\.\.\(epoch === null \? \[\] : \[epoch\]\)\),/);
});

test('#3977: the Needs you tab\'s vote sheet is the same picker, as an approval', () => {
  // Its row's Yes carries `approve` from `_cardVoteButtonSpecs` (app-view.js
  // builds the queue; tests/dev-workshop.test.js renders the tab).
  assert.match(SRC, /yes: yes \? \{ label: yes\.label, act: yes\.act, \.\.\.\(yes\.approve \? \{ approve: true \} : \{\}\) \} : null,/);
  const { NeedsVoteForm } = loadTsx('frontend/src/features/dev-board/workshop/workshop.tsx');
  const noop = () => {};
  const row = (approve) => ({
    t: 'card', key: 'needs:proposal:7', kind: 'vote', ask: 'Should this change go in?',
    yes: { label: 'Yes (0/1)', act: { fn: 'castVote', args: [7, 'yes', 3] }, ...(approve ? { approve: true } : {}) },
    no: { label: 'No (0/1)', act: { fn: 'castVote', args: [7, 'no', 3] } },
  });
  const draw = (approve, side = 'yes') => renderToHtml(createElement(NeedsVoteForm, {
    row: row(approve), slug: 'plant-pal', side, line: '',
    onSide: noop, onLine: noop, onBoxKey: noop, onCancel: noop, onSend: noop,
  }));
  const solo = draw(true);
  assert.match(solo, />Your approval<\/div>/);
  assert.match(solo, /dev-vote-switch-yes" aria-pressed="true" data-act="castVote">[\s\S]*?Approve<\/button>/);
  assert.match(solo, /dev-vote-switch-no" aria-pressed="false" data-act="castVote">[\s\S]*?Don’t approve<\/button>/);
  assert.match(solo, /dev-vote-reason-send-yes">Approve<\/button>/);
  assert.match(draw(true, 'no'), /dev-vote-reason-send-no" disabled="">Don’t approve<\/button>/);
  const group = draw(false);
  assert.match(group, />Your vote<\/div>/);
  assert.match(group, />Vote yes<\/button>/);
});
