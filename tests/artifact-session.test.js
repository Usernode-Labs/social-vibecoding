'use strict';

// Artifacts, stage 2 (docs/plans/artifacts.md): the artifact capability of a
// private thread's turn (src/services/artifact-session.js), its tools
// (src/services/bot-tools/artifact.js) and its place among the profiles
// (src/services/bot-profiles.js). Each turn here is a whole chat turn
// (homeroom-bot-mayor.js runDmTurn) with a scripted model, entered where a
// real one is: the model's tool calls, and what is sent and stored after.
//
//   1. A page is written in a thread that held nothing: one call, one reply,
//      version 1 stored as a row the message points at.
//   2. A thread that holds a page changes it with exact edits; the page is in
//      the prompt only there, and a version too big to show is not edited.
//   3. show and compare put a card under the reply and save nothing.
//   4. Private threads with the bot only; a chat with no artifact pays for
//      one tool's description and nothing else.

const test = require('node:test');
const assert = require('node:assert/strict');

const { designChatTurn, call } = require('./lib/design-chat-turn');
const profiles = require('../src/services/bot-profiles');
const botTools = require('../src/services/bot-tools');
const session = require('../src/services/artifact-session');
const realStore = require('../src/services/artifacts');

const PAGE_HTML = '<!doctype html><html><head><style>td{padding:4px}</style></head><body><h1>Trip budget</h1>'
  + '<table><tr><td>Flights</td><td id="f">420</td></tr><tr><td>Hotel</td><td>610</td></tr></table>'
  + '<p id="sum"></p><script>document.getElementById("sum").textContent = "Total: 1030";</script></body></html>';

// The store, as the turn meets it: what was made and saved is kept here.
function fakeStore({ artifact = null, current = null } = {}) {
  const made = [];
  const saved = [];
  return {
    made, saved,
    store: {
      ...realStore,
      async versionOf() { return current; },
      async ensureArtifact(_pool, args) {
        made.push(args);
        return artifact || { threadId: 7, rootId: 500, title: args.title, artifactKind: args.kind, app: null, latest: 0, versions: [], viewport: args.viewport };
      },
      async addVersion(_pool, args) {
        saved.push(args);
        return { version: (current?.version || 0) + saved.length };
      },
    },
  };
}

const pageSection = (messages) => (messages || []).filter((m) => m.role === 'system' && String(m.content).startsWith('THIS THREAD\'S PAGE')).map((m) => m.content).join('\n');
const resultOf = (messages, id) => JSON.parse((messages.find((m) => m.role === 'tool' && m.tool_call_id === id) || { content: 'null' }).content);

test('a page is written in a thread that held nothing: one call, one reply, version 1 a row the message points at', async () => {
  const { store, made, saved } = fakeStore();
  const turn = designChatTurn([
    { calls: [call('write_artifact', { title: 'Trip budget', size: 'desktop', html: PAGE_HTML })] },
    { calls: [call('reply', { text: 'Here is the budget as a page.', summary: 'Flights and hotel, with the total' })] },
  ], { ask: 'can you lay the trip budget out as a page?', deps: { artifacts: store } });
  await turn.run;

  // Round 1 is an ordinary chat turn: it pays for one tool's description, and no page is in its prompt.
  assert.ok(turn.offered[0].includes('write_artifact'));
  for (const name of ['edit_artifact', 'show_artifact', 'compare_artifacts']) assert.equal(turn.offered[0].includes(name), false, name);
  assert.equal(pageSection(turn.seen[0]), '', 'nothing about a page until there is one');
  // The call wrote it and loaded the capability for the rest of the turn.
  const wrote = resultOf(turn.seen[1], 'cwrite_artifact');
  assert.equal(wrote.ok, true);
  assert.equal(wrote.version, 1);
  assert.deepEqual(turn.offered[1].filter((name) => /artifact/.test(name)), ['write_artifact', 'edit_artifact', 'show_artifact', 'compare_artifacts']);
  assert.equal(turn.offered[1].includes('start_design'), false, 'a thread holds one artifact');
  assert.match(pageSection(turn.seen[1]), /^THIS THREAD'S PAGE\nYou are writing a page with @evan in this thread\./);
  // Saved once, as the plain kind, whole, by the reply.
  assert.equal(made.length, 1);
  assert.deepEqual([made[0].kind, made[0].title, made[0].viewport, made[0].surface], ['page', 'Trip budget', 'desktop', 'new']);
  assert.equal(saved.length, 1);
  assert.deepEqual([saved[0].html, saved[0].author, saved[0].note], [PAGE_HTML, 'bot', 'Flights and hotel, with the total']);
  // The message holds words and a pointer, never the page: a message is 8,000 characters at most.
  assert.equal(turn.sent.length, 1);
  const said = turn.sent[0];
  assert.equal(said.content, 'Here is the budget as a page.\n\nVersion 1: Flights and hotel, with the total.');
  assert.equal(said.metadata.designVersion, 1);
  assert.equal(said.metadata.designTitle, 'Trip budget');
  assert.doesNotMatch(JSON.stringify(said), /<table>|<script>/, 'the page is the store\'s row, not the message\'s');
  assert.equal(turn.recorded.at(-1).error, null);
});

test('a thread that holds a page changes it with exact edits, and the page is in the prompt only there', async () => {
  const artifact = { threadId: 7, rootId: 500, conversationId: 41, state: 'open', kind: 'idea', artifactKind: 'page', title: 'Trip budget', app: null, surface: 'new', viewport: 'desktop', width: 1280, height: 800, latest: 1, versions: [{ version: 1, author: 'bot', note: null, messageId: 880 }] };
  const { store, made, saved } = fakeStore({ artifact, current: { version: 1, html: PAGE_HTML } });
  const turn = designChatTurn([
    { calls: [call('edit_artifact', { edits: [{ find: '<td id="f">420</td>', replace: '<td id="f">480</td>' }, { find: 'Total: 1030', replace: 'Total: 1090' }] })] },
    { calls: [call('reply', { text: 'Done.', summary: 'Flights are 480 now' })] },
  ], { design: artifact, ask: 'flights went up to 480', deps: { artifacts: store } });
  await turn.run;

  // The capability is loaded from the first round: its section, the page, its tools.
  const section = pageSection(turn.seen[0]);
  assert.match(section, /^THIS THREAD'S PAGE\nThis thread holds a page you wrote with @evan, "Trip budget"\./);
  assert.ok(section.includes(`THE CURRENT VERSION (version 1), its whole HTML:\n${PAGE_HTML}`));
  assert.match(section, /saved as version 2 when you reply/);
  assert.ok(turn.offered[0].includes('edit_artifact'));
  assert.equal(turn.offered[0].includes('start_design'), false);
  // The chat's own section says what the thread holds, in the page's words.
  const chat = turn.seen[0][0].content;
  assert.match(chat, /- This thread holds a page you wrote with them, "Trip budget"\. Its newest version is version 1\./);
  assert.doesNotMatch(chat, /This thread holds a design/);
  // A plain page files nothing: offer_request is the chat's own, with no word of a design.
  const offer = turn.seen.length && require('../src/services/homeroom-bot-mayor').TOOLS.find((t) => t.function.name === 'offer_request');
  assert.equal('notTheDesign' in offer.function.parameters.properties, false);
  for (const name of ['offer_plan', 'offer_project', 'write_screen', 'edit_design', 'capture_page', 'read_plan']) {
    assert.equal(turn.offered[0].includes(name), false, `${name} is the design kind's`);
  }
  // The edits made one version, saved once; the artifact's row is not made again.
  assert.equal(made.length, 0);
  assert.equal(saved.length, 1);
  assert.match(saved[0].html, /<td id="f">480<\/td>[\s\S]*Total: 1090/);
  assert.equal(saved[0].note, 'Flights are 480 now');
  assert.equal(turn.sent[0].content, 'Done.\n\nVersion 2: Flights are 480 now.');
  assert.equal(turn.sent[0].metadata.designVersion, 2);
  // An edit that does not apply is said, and nothing is saved for it.
  const bad = designChatTurn([
    { calls: [call('edit_artifact', { edits: [{ find: 'not in the page', replace: 'x' }] })] },
    { calls: [call('reply', { text: 'I could not find that line.' })] },
  ], { design: artifact, deps: { artifacts: fakeStore({ artifact, current: { version: 1, html: PAGE_HTML } }).store } });
  await bad.run;
  assert.match(resultOf(bad.seen[1], 'cedit_artifact').error, /^Edit 1: its find is not in the HTML\./);
  assert.equal(bad.sent[0].metadata.designVersion, undefined);
});

test('a version too big to show the model is not edited, and the turn says so', async () => {
  const artifact = { threadId: 7, rootId: 500, conversationId: 41, state: 'open', kind: 'idea', artifactKind: 'page', title: 'Big', app: null, latest: 3, versions: [] };
  const big = `<p>${'x'.repeat(profiles.ARTIFACT_LIMITS.versionChars)}</p>`;
  const { store, saved } = fakeStore({ artifact, current: { version: 3, html: big } });
  const turn = designChatTurn([
    { calls: [call('reply', { text: 'This page is too big for me to change in one piece.' })] },
  ], { design: artifact, ask: 'make the heading blue', deps: { artifacts: store } });
  await turn.run;
  assert.equal(profiles.ARTIFACT_LIMITS.versionChars, 120000);
  assert.equal(pageSection(turn.seen[0]), '', 'the page is not put in the prompt');
  assert.equal(turn.offered[0].includes('edit_artifact'), false);
  assert.ok(turn.seen[0][0].content.includes(`It cannot be changed in this turn. If they ask you to change it, say so: "${session.TOO_BIG_TEXT}"`));
  assert.equal(saved.length, 0);
});

test('show and compare put a card under the reply and save nothing', async () => {
  const artifact = { threadId: 7, rootId: 500, conversationId: 41, state: 'open', kind: 'idea', artifactKind: 'page', title: 'Trip budget', app: null, latest: 3, versions: [{ version: 1, author: 'bot' }, { version: 2, author: 'bot' }, { version: 3, author: 'bot' }] };
  const shown = fakeStore({ artifact, current: { version: 3, html: PAGE_HTML } });
  const show = designChatTurn([
    { calls: [call('show_artifact', { version: 2 })] },
    { calls: [call('reply', { text: 'Here is version 2 again.' })] },
  ], { design: artifact, ask: 'show me version 2 again', deps: { artifacts: shown.store } });
  await show.run;
  assert.equal(resultOf(show.seen[1], 'cshow_artifact').ok, true);
  assert.equal(show.sent[0].content, 'Here is version 2 again.');
  assert.equal(show.sent[0].metadata.designVersion, 2, 'the reply points at the version; the client draws its card');
  assert.equal(shown.saved.length, 0);
  // A version that is not there is said.
  const none = designChatTurn([
    { calls: [call('show_artifact', { version: 9 })] },
    { calls: [call('reply', { text: 'There is no version 9.' })] },
  ], { design: artifact, deps: { artifacts: fakeStore({ artifact, current: { version: 3, html: PAGE_HTML } }).store } });
  await none.run;
  assert.equal(resultOf(none.seen[1], 'cshow_artifact').error, 'There is no version 9: the newest is 3.');

  const compared = fakeStore({ artifact, current: { version: 3, html: PAGE_HTML } });
  const compare = designChatTurn([
    { calls: [call('compare_artifacts', { versions: [1, 3], labels: ['First', 'With the hotel'] })] },
    { calls: [call('reply', { text: 'Side by side below.' })] },
  ], { design: artifact, ask: 'compare 1 and 3', deps: { artifacts: compared.store } });
  await compare.run;
  assert.deepEqual(compare.sent[0].metadata.card, {
    type: 'compare', v: 1, rootId: 500, title: 'Trip budget',
    items: [{ version: 1, label: 'First' }, { version: 3, label: 'With the hotel' }], picked: null,
  }, 'the comparison names versions in the store, by number');
  assert.equal(compared.saved.length, 0);
});

test('the artifact capability is its own profile data: its tools, its limits, and when it loads', () => {
  const cap = profiles.capabilityOf('artifact');
  assert.deepEqual(cap.tools, ['write_artifact', 'edit_artifact', 'show_artifact', 'compare_artifacts']);
  assert.equal(cap.limits, profiles.ARTIFACT_LIMITS);
  assert.deepEqual(profiles.PROFILES.private.capabilities, ['design', 'draft', 'artifact']);
  // Loaded by what the thread holds: a page, a design, or nothing.
  assert.deepEqual(profiles.capabilitiesInChat({}), []);
  assert.deepEqual(profiles.capabilitiesInChat({ threadDesign: { artifactKind: 'page' } }), ['artifact']);
  assert.deepEqual(profiles.capabilitiesInChat({ threadDesign: { artifactKind: 'design' } }), ['design']);
  assert.deepEqual(profiles.capabilitiesInChat({ threadDesign: { title: 'a row from before' } }), ['design']);
  // Cheap by default: fewer rounds than a design, the same room to write a
  // page in one step, and edits that stay find-and-replace.
  assert.ok(profiles.ARTIFACT_LIMITS.rounds < profiles.DESIGN_LIMITS.rounds);
  assert.equal(profiles.ARTIFACT_LIMITS.outputTokens, 16000);
  assert.equal(profiles.ARTIFACT_LIMITS.editsPerCall, 16);
  const limits = profiles.turnLimits(['artifact']);
  assert.deepEqual([limits.outputTokens, limits.retryOutputTokens, limits.requestTimeoutMs], [16000, 32000, 180000]);
  assert.equal(limits.rounds, profiles.CHAT_LIMITS.rounds, 'never fewer rounds than the chat\'s own');
  // The plain kind's skill inlines no stylesheet and reads no project.
  const prompt = session.pagePrompt({ username: 'ada', artifact: null });
  assert.doesNotMatch(prompt, /stylesheet|list_source|read_source|capture_page|offer_plan/);
  assert.doesNotMatch(prompt, /—/);
  // Written against the chat's rules: a question comes with what its answer
  // changes, and nothing is promised for later.
  assert.match(prompt, /Ask a\n {2}question only when you cannot write anything true without the answer, and say what the answer changes\./);
  assert.doesNotMatch(prompt, /ask one short question|I'll get back|come back to you|later/i);
});

test('a page is said as a page: the thread opened for it, the working card, the reply check', async () => {
  const designs = require('../src/services/design-threads');
  const mayor = require('../src/services/homeroom-bot-mayor');
  const claims = require('../src/services/reply-claims');
  // A page asked for where no thread is: the thread opened for it says so, of no project.
  const sent = [];
  const dm = { botAccount: async () => ({ id: 2 }), async sendDm(_pool, args) { sent.push(args); return { messageId: 950 }; } };
  await designs.openDrawThread({ async query() { return { rows: [] }; } }, {
    user: { id: 9 }, app: { id: 3, slug: 'ear', name: 'Ear Trainer' }, title: 'Trip budget', messageId: 71, kind: 'page', deps: { dm },
  });
  assert.equal(sent[0].content, 'I\'m writing "Trip budget" in a new thread. Only you can see it.');
  assert.deepEqual([sent[0].metadata.changeKind, sent[0].thread.appId], ['any', null], 'not a design\'s thread, and in no project');
  assert.equal(designs.drawLine({ title: 'Swap list', appName: 'Ear Trainer' }), 'I\'m drawing "Swap list" for Ear Trainer in a new thread. Only you can see it.');
  // The working card: writing, never drawing.
  for (const name of ['write_artifact', 'edit_artifact']) assert.deepEqual(mayor.doingFor(name, {}, { version: 2 }), { kind: 'writing' }, name);
  assert.deepEqual(mayor.doingFor('write_screen', {}, { version: 2 }), { kind: 'drawing', version: 2 });
  // The reply check: a page's thread has its own claim, and none of a design's.
  const page = (drew) => ({ page: true, drew, designTitle: 'Trip budget' });
  const said = (t, text) => claims.CLAIMS.filter((c) => (!c.applies || c.applies(t)) && c.re.test(text) && !c.turn(t)).map((c) => c.kind);
  assert.deepEqual(said(page(false), 'I\'ve added the hotel row.'), ['page_done']);
  assert.deepEqual(said(page(true), 'I\'ve added the hotel row.'), [], 'backed by the version this turn wrote');
  assert.deepEqual(said(page(false), 'Here\'s the page with the totals.'), ['page_done']);
  assert.equal(claims.CLAIMS.find((c) => c.kind === 'not_built').applies(page(true)), false, 'nothing about a page is filed or built');
  assert.equal(claims.CLAIMS.find((c) => c.kind === 'design_done').applies(page(true)), false);
  const note = claims.repairNote([{ kind: 'page_done', said: 'says you wrote or changed the page' }], { tools: new Set(['edit_artifact']) });
  assert.match(note, /Nothing in the page was written or changed this turn\. Change it with edit_artifact/);
});

test('private threads with the bot only: no project thread is offered an artifact tool, and nothing publishes one', () => {
  for (const name of profiles.ARTIFACT_TOOLS) {
    assert.equal(botTools.offers(name, 'thread'), false, `${name} in a project's thread`);
    assert.equal(botTools.offers(name, 'design'), false);
    assert.equal(botTools.offers(name, 'artifact'), true);
  }
  assert.equal(botTools.offers('write_artifact', 'main'), true, 'the one way a private thread comes to hold a page');
  assert.equal(botTools.offers('edit_artifact', 'main'), false);
  for (const kind of ['request', 'change', 'channel', 'reply']) {
    assert.deepEqual(profiles.PROFILES[kind].tools.filter((name) => /artifact/.test(name)), [], kind);
    assert.equal(profiles.PROFILES[kind].capabilities, undefined);
  }
  assert.throws(() => botTools.toolsFor(['write_artifact'], 'thread'), /not offered in thread/);
  // A tool run outside a session changes nothing.
  return botTools.run('edit_artifact', { edits: [] }, { scope: 'artifact' }).then((out) => {
    assert.deepEqual(out, { ok: false, error: 'edit_artifact is not offered here.' });
    const src = require('node:fs').readFileSync(require.resolve('../src/services/artifact-session.js'), 'utf8').replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(src, /postRequestSpec|fileRequest|sendSystemMessage|objects:/, 'the session files, posts and announces nothing');
  });
});

test('one way to edit every kind: exact pairs, each found once', () => {
  assert.deepEqual(session.applyEdits('<p>a</p><p>b</p>', [{ find: '<p>a</p>', replace: '<p>c</p>' }]), { html: '<p>c</p><p>b</p>' });
  assert.match(session.applyEdits('<p>a</p><p>a</p>', [{ find: '<p>a</p>', replace: '' }]).error, /occurs more than once/);
  assert.match(session.applyEdits('<p>a</p>', []).error, /at least one edit/);
  assert.match(session.applyEdits('<p>a</p>', new Array(17).fill({ find: 'a', replace: 'b' })).error, /At most 16 edits/);
  assert.equal(require('../src/services/design-bot').applyEdits('abc', [{ find: 'b', replace: 'x' }]).html, 'axc', 'a design\'s edits are the same');
  // A page that would load from an address is told so: its frame names no origin.
  assert.match(session.loadsNote('<script src="https://cdn.example/x.js"></script>'), /loads from another address/);
  assert.match(session.loadsNote('<style>@import url(//fonts.example/a.css);</style>'), /loads from another address/);
  assert.equal(session.loadsNote(PAGE_HTML), null);
});
