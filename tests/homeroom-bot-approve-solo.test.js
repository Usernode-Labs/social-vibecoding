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
// Don't approve too. The words and the status are B7's, unchanged.
//
// #4270 tidied the two leftovers. ⋯ no longer carries B7's "Don't approve":
// it was a second way to the picker's own No, asking for its line by prompt.
// And the Communities screen's Needs you, the feed across every project,
// says Approve and Don't approve for these changes as the project's own tab
// does: the needs feed marks them `approve` (src/routes/workshop-overview.js,
// the same three tests as AppView._approveSolo), and the reel carries it
// onto the row's Yes. A group project's rows still ask for a vote.
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
  // #4270: ⋯ has no "Don't approve" of its own any more (B7 put one there,
  // last and red); the picker's other side is the one way to it.
  assert.ok(!AppView._proposalMenuItems(change(), {}).some((i) => /approve/i.test(i.label)));
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

test('#4270: ⋯ no longer offers a separate "Don\'t approve"', () => {
  // #3977 left B7's item in place: the same castVote No, whose line castVote
  // asked for by its own prompt. With Approve opening the picker, that was
  // two ways to one No, one of them without the box. It is gone; Don't
  // approve is the picker's No side (the test above), on the board, the
  // folded row and the change page alike.
  const AppView = makeAppView();
  AppView.appData = { slug: 'plant-pal', audience: 'solo' };
  for (const pr of [change(), change({ my_vote: 'yes' }), change({ username: 'someone', user_id: 5 })]) {
    const labels = AppView._proposalMenuItems(pr, {}).map((i) => i.label);
    assert.ok(!labels.some((l) => /approve/i.test(l)), `no approval row in ⋯: ${labels.join(', ')}`);
  }
  const menu = SRC.slice(SRC.indexOf('  _proposalMenuItems(pr, state) {'), SRC.indexOf('  _proposalDetailsView(pr) {'));
  assert.ok(menu.length > 0);
  assert.doesNotMatch(menu, /castVote\(/, 'no vote is cast from ⋯');
  assert.doesNotMatch(menu, /label: 'Don’t approve'/);
  // The picker still has it, worded so, on every face that draws VoteButton.
  assert.match(CARD_SRC, /const noWord = approve \? 'Don’t approve' :/);
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

// The needs feed's row for a change on a project that is just yours, and one
// for a group's: the shape GET /api/workshop/needs-feed answers with.
const feedItem = (over) => ({
  kind: 'proposal', id: 7, title: 'Sunday reminder', summary: 'Sends a reminder on Sundays.', author: 'homeroom_bot',
  number: 3, epoch: 3, at: null, yes: 0, no: 0,
  app: { slug: 'plant-pal', name: 'Plant pal', icon_url: null, icon_emoji: null }, ...over,
});

test('#4270: the feed across every project says Approve and Don\'t approve for these changes', () => {
  const reel = loadTsx('frontend/src/features/workshop/needs-reel.tsx');
  // The flag rides onto the row's Yes, as `_cardVoteButtonSpecs` puts it
  // there on a project's own Needs you; a group's Yes carries none.
  const [solo, group, decision] = reel.reelRows([
    feedItem({ approve: true }),
    feedItem({ id: 8, title: 'Sort', author: 'ada', yes: 1, approve: undefined, app: { slug: 'garden', name: 'Garden', icon_url: null, icon_emoji: null } }),
    { ...feedItem({ kind: 'governance', id: 9, epoch: null, yes: null, no: null }), approve: true },
  ]);
  assert.deepEqual(solo.yes, { label: 'Yes', act: { fn: 'castVote', args: [7, 'yes', 3] }, approve: true });
  assert.ok(!('approve' in solo.no), 'the No is the same No either way');
  assert.ok(!('approve' in group.yes));
  assert.equal(decision.yes, null, 'a group decision still has no pair here');

  // Drawn by the project's own feed: the rail and the swipe say it.
  const draw = (items) => renderToHtml(createElement(reel.NeedsReel, { items, error: false, capped: false, onDone: () => {} }));
  const html = draw([feedItem({ approve: true })]);
  assert.match(html, /<span class="dev-ws-rail-lab">Approve<\/span>/);
  assert.doesNotMatch(html, /<span class="dev-ws-rail-lab">Vote<\/span>/);
  assert.match(html, /<span class="dev-ws-swipe-hint dev-ws-swipe-yes" aria-hidden="true">Approve<\/span>/);
  assert.match(html, /<span class="dev-ws-swipe-hint dev-ws-swipe-no" aria-hidden="true">Don’t approve<\/span>/);
  // The vote sheet's form is the card's picker, as an approval.
  const { NeedsVoteForm } = loadTsx('frontend/src/features/dev-board/workshop/workshop.tsx');
  const noop = () => {};
  const form = (row, side = 'yes') => renderToHtml(createElement(NeedsVoteForm, {
    row, slug: '', side, line: '', onSide: noop, onLine: noop, onBoxKey: noop, onCancel: noop, onSend: noop,
  }));
  assert.match(form(solo), />Your approval<\/div>/);
  assert.match(form(solo), /dev-vote-switch-yes" aria-pressed="true" data-act="castVote">[\s\S]*?Approve<\/button>/);
  assert.match(form(solo), /dev-vote-switch-no" aria-pressed="false" data-act="castVote">[\s\S]*?Don’t approve<\/button>/);
  assert.match(form(solo, 'no'), /dev-vote-reason-send-no" disabled="">Don’t approve<\/button>/);

  // A group's row is a vote, word for word.
  const groupHtml = draw([feedItem({ id: 8, title: 'Sort', author: 'ada', yes: 1, app: { slug: 'garden', name: 'Garden', icon_url: null, icon_emoji: null } })]);
  assert.match(groupHtml, /<span class="dev-ws-rail-lab">Vote<\/span>/);
  assert.match(groupHtml, /dev-ws-swipe-yes" aria-hidden="true">Yes<\/span>/);
  assert.match(groupHtml, /dev-ws-swipe-no" aria-hidden="true">No<\/span>/);
  assert.match(form(group), />Your vote<\/div>/);
  assert.match(form(group), />Vote yes<\/button>/);

  // Once answered, the feed's own facts line says it as the project's does:
  // "You approved it" / "You didn't approve it", not "You voted yes".
  const lander = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/dev-board/workshop/workshop.tsx'), 'utf8');
  const facts = lander.slice(lander.indexOf('function factsFor('), lander.indexOf('function approves('));
  assert.equal((facts.match(/text: youAnswered\(row, voted\)/g) || []).length, 2, 'both branches, the project\'s and the feed\'s');
  assert.doesNotMatch(facts, /`You voted \$\{voted\}`/);
});

test('#4270: the needs feed marks a change approve by AppView._approveSolo\'s three tests', () => {
  // The query says which rows are on a project that is just the viewer's
  // and count their vote (`solo`); withVotesRequired adds the merge gate's
  // count for those; the item is marked when that count is one.
  const route = require('../src/routes/workshop-overview');
  assert.match(route.NEEDS_FEED_SQL, /\(o\.kind = 'proposal'\s+AND \(CASE[\s\S]*?ELSE 'solo'\s+END\) = 'solo'\s+AND counts_toward_outcome\(\$1, a\.id\)\) AS solo/);
  const row = (over) => ({
    slug: 'plant-pal', name: 'Plant pal', icon_image_id: null, icon_emoji: null, app_id: 4,
    kind: 'proposal', id: 7, title: 'Sunday reminder', summary: null, author: 'homeroom_bot', number: 3, epoch: 3,
    at: null, yes: 0, no: 0, ...over,
  });
  const shaped = (over) => route.shapeNeedsFeed([row(over)])[0];
  assert.equal(shaped({ solo: true, votes_required: 1 }).approve, true);
  assert.equal(shaped({ solo: true }).approve, true, 'no count worked out: one person\'s project needs one');
  assert.ok(!('approve' in shaped({ solo: true, votes_required: 2 })), 'a rule asking for two Yes votes keeps the vote');
  assert.ok(!('approve' in shaped({ solo: false, votes_required: 1 })), 'a group, or a vote that does not count, keeps the vote');
  assert.ok(!('approve' in shaped({})));
  // And the route works the count out before it shapes.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/routes/workshop-overview.js'), 'utf8');
  assert.match(src, /const items = shapeNeedsFeed\(await withVotesRequired\(pool, rows\)\);/);
  assert.match(src, /row\.votes_required = governance\.computeGate\(gov, electorate\.active, row\.yes, row\.no, row\.at, null\)\.required;/);
});

test('#4270: withVotesRequired asks only for the solo rows, once per project', async () => {
  const route = require('../src/routes/workshop-overview');
  const governance = require('../src/services/governance');
  const asked = [];
  const real = { getGovernance: governance.getGovernance, getElectorate: governance.getElectorate };
  governance.getGovernance = async (pool, appId) => { asked.push(appId); return { approverPolicy: 'anyone', approvalsRequired: appId === 5 ? 2 : null }; };
  governance.getElectorate = async () => ({ active: 1, approverIds: null, adminFallback: false });
  try {
    const rows = [
      { app_id: 4, id: 1, kind: 'proposal', solo: true, yes: 0, no: 0, at: null },
      { app_id: 4, id: 2, kind: 'proposal', solo: true, yes: 0, no: 0, at: null },
      { app_id: 5, id: 3, kind: 'proposal', solo: true, yes: 0, no: 0, at: null },
      { app_id: 6, id: 4, kind: 'proposal', solo: false, yes: 1, no: 0, at: null },
      { app_id: 6, id: 5, kind: 'governance', solo: false, yes: null, no: null, at: null },
    ];
    const out = await route.withVotesRequired({}, rows);
    assert.equal(out, rows);
    assert.deepEqual(asked.sort(), [4, 5]);
    assert.deepEqual(rows.map((r) => r.votes_required), [1, 1, 2, undefined, undefined]);
    assert.deepEqual(route.shapeNeedsFeed(rows.map((r) => ({ ...r, slug: 'x' }))).map((it) => !!it.approve), [true, true, false, false, false]);
  } finally {
    Object.assign(governance, real);
  }
});

// #4313: the Needs you vote sheet's line under its question. A group's row
// counts the votes; a row that asks for your approval has nobody else to
// count, so it says whose answer it waits on, and once you have answered,
// the answer, in #4270's words.
test('#4313: the vote sheet\'s line asks for your approval, and reads as answered', () => {
  const reel = loadTsx('frontend/src/features/workshop/needs-reel.tsx');
  const { VoteSub } = loadTsx('frontend/src/features/dev-board/workshop/workshop.tsx');
  const [solo, group] = reel.reelRows([
    feedItem({ approve: true }),
    feedItem({ id: 8, title: 'Sort', author: 'ada', yes: 1, app: { slug: 'garden', name: 'Garden', icon_url: null, icon_emoji: null } }),
  ]);
  const sub = (row, voted = null) => renderToHtml(createElement(VoteSub, { row, voted }));
  assert.equal(sub(solo), '<p class="dev-ws-vote-sub">Waiting for your approval.</p>');
  assert.equal(sub(solo, 'yes'), '<p class="dev-ws-vote-sub">Approved.</p>');
  assert.equal(sub(solo, 'no'), '<p class="dev-ws-vote-sub">Not approved.</p>');
  assert.doesNotMatch(sub(solo), /voted/);
  // A group's row is counted, as before.
  assert.equal(sub(group), '<p class="dev-ws-vote-sub">1 yes and 0 no so far.</p>');
  assert.equal(sub({ ...group, tally: { yes: 0, no: 0 } }), '<p class="dev-ws-vote-sub">Nobody has voted yet.</p>');
  // On a project's own Needs you the row has its card's pill: the wait is
  // the eyebrow's already, so it is not said twice; any other word follows.
  const pilled = (state) => ({ ...solo, card: { ...solo.card, pill: { state } } });
  assert.equal(sub(pilled({ key: 'needs_vote', label: 'Waiting for your approval', yes: 0, majority: 1 })),
    '<p class="dev-ws-vote-sub">Waiting for your approval.</p>');
  assert.equal(sub(pilled({ key: 'checks', label: 'Checks failing', yes: 0, majority: 1 })),
    '<p class="dev-ws-vote-sub">Waiting for your approval. Checks failing.</p>');
});

// #4313: the ?demo=1 feed carries one Just-you card so the wording can be
// seen in a preview, and the page's follow-up requests for it are answered.
test('#4313: the demo feed has one Just-you card, and its follow-ups are answered', () => {
  const route = require('../src/routes/workshop-overview');
  const solo = route.DEMO_NEEDS_FEED.filter((it) => it.approve);
  assert.equal(solo.length, 1, 'one Just-you card');
  const [card] = solo;
  assert.equal(card.kind, 'proposal');
  assert.ok(card.id < 0, 'a demo id, never a real proposal');
  assert.equal(card.author, null, 'it names nobody');
  assert.match(card.title, /^\[Demo\] /, 'obviously fake');
  assert.deepEqual([card.yes, card.no], [0, 0]);
  const [row] = reel().reelRows([card]);
  assert.equal(row.yes.approve, true, 'the reel asks for approval');
  // Answered by the demo path only on staging (the module reads the flag at load).
  assert.equal(route.isDemoNeedsProposal(card.id), false, 'not outside staging');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  assert.match(read('server.js'), /app\.use\(demoNeedsVoteRoutes\(\)\);\napp\.use\(sessionRoutes\(/,
    'the vote is answered ahead of the session guard that refuses a negative id');
  assert.match(read('src/routes/chat.js'), /threadType === 'session' && isDemoNeedsProposal\(req\.query\.thread_ref\)/);
  assert.match(read('src/routes/workshop-ask.js'), /isDemoNeedsProposal\(req\.query\.ref\)\) return res\.json\(\{ messages: \[\] \}\)/);
  assert.match(read('src/routes/votes.js'), /\|\| stagingDemoNeedsProposal\(id, req\.params\.slug\)/);
  // The declared check opens the feed on it, with its vote sheet up.
  const check = require('../dapp.json').tests.find((t) => /shot=needs-approve/.test(t.path));
  assert.ok(check, 'a declared check rides ?shot=needs-approve');
  assert.match(check.expectSelector, /\[data-ws-sheet="vote"\] \.dev-ws-vote-sub$/);
  assert.equal(check.expectText, 'Waiting for your approval.');
  assert.ok(check.expectSelector.length < 256);
  function reel() { return loadTsx('frontend/src/features/workshop/needs-reel.tsx'); }
});

test('#4313: on staging the demo card\'s vote, voters and page read are answered', async () => {
  const prev = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  const ids = [require.resolve('../src/routes/workshop-overview')];
  const saved = ids.map((id) => require.cache[id]);
  ids.forEach((id) => { delete require.cache[id]; });
  try {
    const route = require('../src/routes/workshop-overview');
    const card = route.DEMO_NEEDS_FEED.find((it) => it.approve);
    assert.equal(route.isDemoNeedsProposal(card.id), true);
    assert.equal(route.isDemoNeedsProposal(String(card.id)), true, 'as a route param');
    assert.equal(route.isDemoNeedsProposal(-999), false, 'only the feed\'s own ids');
    assert.equal(route.isDemoNeedsProposal(42), false);
    const router = route.demoNeedsVoteRoutes();
    const call = (method, url, id, body) => new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(b) { resolve({ status: this.statusCode, body: b }); },
      };
      router.handle({ method, url, params: { id }, body, user: { id: 1 }, query: {} }, res, () => resolve({ next: true }));
    });
    assert.deepEqual(await call('POST', `/api/sessions/${card.id}/vote`, String(card.id), { vote: 'yes' }),
      { status: 200, body: { ok: true, demo: true, vote: 'yes' } });
    assert.equal((await call('POST', `/api/sessions/${card.id}/vote`, String(card.id), { vote: 'maybe' })).status, 400);
    assert.deepEqual((await call('GET', `/api/sessions/${card.id}/votes`, String(card.id))).body,
      { yes: [], no: [], reasons: [], earlier: { yes: [], no: [] } });
    assert.deepEqual(await call('POST', '/api/sessions/42/vote', '42', { vote: 'yes' }), { next: true }, 'a real id passes through');
  } finally {
    ids.forEach((id, i) => { if (saved[i]) require.cache[id] = saved[i]; else delete require.cache[id]; });
    if (prev === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = prev;
  }
});
