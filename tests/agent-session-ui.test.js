'use strict';

// The agent-session screen (#2779 step 4, docs/agent-sessions.md).
//
// What the user sees in a conversation with the Mayor is decided in one pure
// module, features/agent-session/transcript.ts, so the rules are pinned here
// rather than in a browser:
//
//   1. A CARD SHOWS EXACTLY WHAT IT WILL RUN. Its rows are its input, labelled,
//      and an input it cannot label is still shown rather than dropped.
//   2. A CARD PAST ITS EXPIRY IS EXPIRED even when the server has not swept it
//      yet: a Confirm that the server will refuse is not offered.
//   3. ONE OUTCOME, SAID ONCE. The action_result / action_dismissed note is
//      written for the Mayor (which reads text); under a card the transcript
//      draws, the card's own outcome line says it, so the note is skipped.
//   4. EACH WRITER MAPS TO ONE KIND: conversation events are dividers, the
//      coding agent's completion is an agent item, a live preview is a
//      preview item, anything else is a quiet note.
//   5. REPLY SUGGESTIONS BELONG TO THE LAST THING SAID, and only while it is
//      last.
//
// The inbox half: an agent session is an agent conversation, listed under
// Agents on the one clock, never under People.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const transcript = loadTsx('frontend/src/features/agent-session/transcript.ts');
const inbox = loadTsx('frontend/src/features/messages/inbox.ts');

const NOW = Date.parse('2026-09-01T12:00:00Z');
const LATER = '2026-09-01T13:00:00Z';
const EARLIER = '2026-09-01T11:00:00Z';

const card = (over = {}) => ({
  id: 'a1',
  toolName: 'promote_change',
  title: 'Put the change up for the group vote',
  input: { changeId: 12, title: 'Dark mode', linkedIssues: [4, 7] },
  expiresAt: LATER,
  ...over,
});
const row = (id, role, content, metadata = {}, changeId = null) => ({
  id, role, content, metadata, changeId, createdAt: null,
});

test('a card lists exactly the input it will run with, labelled', () => {
  assert.deepEqual(
    transcript.cardRows({ slug: 'notes', changeId: 12, linkedIssues: [4, 7], body: '  two\n lines ', empty: '', none: null }),
    [['App', 'notes'], ['Change', '#12'], ['Links', 'Request #4, Request #7'], ['Details', 'two lines']],
  );
  // A key with no label of its own is still shown, humanised, never dropped.
  assert.deepEqual(transcript.cardRows({ baseBranch: 'main', dry_run: true }), [['Base Branch', 'main'], ['Dry run', 'true']]);
  // Long values are clipped for the card; the server holds the full input.
  const [[, long]] = transcript.cardRows({ body: 'x'.repeat(500) });
  assert.equal(long.length, 140);
  assert.ok(long.endsWith('…'));
});

test('a pending card past its expiry is drawn expired; a decided one keeps its state and says its outcome', () => {
  const none = new Map();
  assert.equal(transcript.cardView(card(), none, NOW).status, 'pending');
  assert.equal(transcript.cardView(card({ expiresAt: EARLIER }), none, NOW).status, 'expired');

  const done = new Map([['a1', {
    id: 'a1', toolName: 'promote_change', title: '', status: 'done', expiresAt: EARLIER,
    result: { ok: true, text: 'raw', structured: { nextStep: 'The vote is open.' } },
  }]]);
  const view = transcript.cardView(card({ expiresAt: EARLIER }), done, NOW);
  assert.equal(view.status, 'done', 'a decided card is not re-labelled expired');
  assert.equal(view.outcome, 'The vote is open.');
});

test('the transcript maps each writer to one kind, and says a card outcome once', () => {
  const items = transcript.buildTranscript([
    row(1, 'user', 'Add dark mode to notes'),
    row(2, 'system', 'Started change #12', { agentSessionEvent: 'change_started' }, 12),
    row(3, 'assistant', 'Here is the plan.', { confirmations: [card()], quickReplies: ['Go ahead', ' '] }),
    row(4, 'system', 'Confirmed: Put the change up', { agentSessionEvent: 'action_result', actionId: 'a1', ok: true }),
    row(5, 'system', 'Confirmed elsewhere', { agentSessionEvent: 'action_result', actionId: 'zz', ok: false }),
    row(6, 'system', 'Built it', { ccOutput: 'Added a toggle.', ccOutcome: 'no_changes' }, 12),
    row(7, 'system', 'Preview is live', { stagingUrl: 'https://pr-9.example.test', prNumber: 9 }, 12),
    row(8, 'system', 'Preview (not a link)', { stagingUrl: 'javascript:alert(1)' }, 12),
    row(9, 'system', 'The turn failed', { agentSessionEvent: 'turn_failed' }),
    row(10, 'system', '   '),
  ], [], NOW);

  assert.deepEqual(items.map((i) => i.kind), ['user', 'divider', 'mayor', 'note', 'agent', 'preview', 'note', 'note']);
  const [, divider, mayor, foreign, agent, preview, unsafe, failed] = items;
  assert.equal(divider.event, 'change_started');
  assert.deepEqual(mayor.quickReplies, ['Go ahead'], 'a blank suggestion is not a button');
  assert.equal(mayor.cards.length, 1);
  assert.ok(!items.some((i) => i.key === 'm4'), "the drawn card's own outcome note is not repeated under it");
  assert.equal(foreign.tone, 'error', 'an outcome for a card this transcript does not draw is still said');
  assert.equal(agent.outcome, 'no_changes');
  assert.equal(agent.changeId, 12);
  assert.equal(preview.url, 'https://pr-9.example.test');
  assert.equal(preview.prNumber, 9);
  assert.equal(unsafe.kind, 'note', 'only an http(s) preview URL becomes a link');
  assert.equal(failed.tone, 'error');
});

test('reply suggestions belong to the last thing said, and only while it is last', () => {
  const said = transcript.buildTranscript([row(1, 'assistant', 'Which app?', { quickReplies: ['Notes', 'Recipes'] })]);
  assert.deepEqual(transcript.latestReplies(said), ['Notes', 'Recipes']);
  const answered = transcript.buildTranscript([
    row(1, 'assistant', 'Which app?', { quickReplies: ['Notes', 'Recipes'] }),
    row(2, 'user', 'Notes'),
  ]);
  assert.deepEqual(transcript.latestReplies(answered), []);
});

test('the header pill and the live line say where things stand in words', () => {
  assert.equal(transcript.changeStatusLabel('active'), 'In progress');
  assert.equal(transcript.changeStatusLabel('paused'), 'Parked');
  assert.equal(transcript.changeStatusLabel('promoted'), 'In vote');
  assert.equal(transcript.changeStatusLabel(null), 'No active change');
  assert.equal(transcript.changeStatusLabel('active', true), 'Building');
  assert.equal(transcript.toolActivity('dispatch_coding_agent'), 'The coding agent is building');
  // A write tool the list does not name is one that ends in a card.
  assert.equal(transcript.toolActivity('start_change'), 'Preparing a confirmation');
});

test('an agent session is an agent conversation in the inbox: under Agents on the one clock, never under People', () => {
  const base = {
    conversations: [{ id: 1, lastActivityAt: '2026-09-01T10:00:00Z' }],
    discussions: [],
    agents: [],
    sessions: [{ key: 's1', lastActivityAt: '2026-09-01T09:00:00Z' }],
    mayors: [{ id: 7, lastActivityAt: '2026-09-01T11:00:00Z' }, { id: 8, lastActivityAt: null }],
  };
  const all = inbox.buildInbox({ ...base, filter: 'all' });
  assert.deepEqual(all.map((e) => e.key), ['mayor:7', 'person:1', 'session:s1', 'mayor:8']);
  assert.ok(all.filter((e) => e.kind === 'mayor').every((e) => e.section === 'chats'));
  assert.deepEqual(inbox.buildInbox({ ...base, filter: 'agents' }).map((e) => e.key), ['mayor:7', 'session:s1', 'mayor:8']);
  assert.deepEqual(inbox.buildInbox({ ...base, filter: 'people' }).map((e) => e.key), ['person:1']);
  assert.equal(inbox.admits('channels', 'mayor'), false);
});

test('the screen is reachable by address, on a phone and in the desktop Messages pane', () => {
  const app = read('public/js/app.js');
  const messages = read('frontend/src/features/messages/store.ts');
  const shell = read('frontend/src/Shell.tsx');
  assert.match(shell, /<Island name="AgentSessionScreen"/);
  assert.match(app, /'agent-session-screen'/);
  assert.match(app, /navigateToAgentSession\(/);
  assert.match(messages, /kind === 'agent'/);
  // The address the store hands out is the Messages one; app.js swaps it
  // for the full screen on a phone.
  assert.match(read('frontend/src/features/agent-session/store.ts'), /#messages\/agent\/\$\{id\}/);
});
