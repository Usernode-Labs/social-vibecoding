'use strict';

// #6260: in a design thread, Homeroom bot reads a project's open requests
// (list_requests, get_request), the same board Main Chat's turn reads. The
// project is this design's unless they name another, and only one the person
// can see is read. Reading is all it does: nothing is filed or posted, and
// the turn's platform grant is closed when it ends.
//
// Pinned here, without a database:
//   1. Both tools are offered, and are readers (gone once reading is over).
//   2. This design's project is the default.
//   3. A design with no project reads one they name.
//   4. A project they cannot see answers the same as one that does not
//      exist, and nothing is read.
//   5. get_request sends the number and asks for no screenshots; a number
//      that is not a positive whole one is refused.
//   6. The grant is opened once, and closed once, and only when a board was
//      read; without one the turn still answers.

const test = require('node:test');
const assert = require('node:assert/strict');

const mayor = require('../src/services/homeroom-bot-mayor');
const designBot = require('../src/services/design-bot');

const HOMEROOM = { id: 3, slug: 'homeroom', name: 'Homeroom' };
const EAR = { id: 4, slug: 'ear', name: 'Ear Trainer' };

test('the design bot is offered both board readers, and they count as reading', () => {
  const names = designBot.TOOLS.map((t) => t.function.name);
  assert.ok(names.includes('list_requests'));
  assert.ok(names.includes('get_request'));
  assert.equal(names.indexOf('list_requests') > names.indexOf('offer_project'), true, 'appended after offer_project');
  assert.deepEqual(designBot.TOOLS.slice(0, 5).map((t) => t.function.name), ['write_screen', 'edit_design', 'list_source', 'read_source', 'reply']);
  assert.equal(designBot.ACT_TOOLS.some((t) => t.function.name === 'list_requests'), false);
  assert.equal(designBot.ACT_TOOLS.some((t) => t.function.name === 'get_request'), false);
  for (const name of ['list_requests', 'get_request']) {
    const tool = designBot.TOOLS.find((t) => t.function.name === name).function;
    assert.equal(tool.parameters.additionalProperties, false);
    assert.doesNotMatch(tool.description, /—/);
  }
  assert.equal(designBot.TOOLS.find((t) => t.function.name === 'get_request').function.parameters.properties.includeImages, undefined,
    'screenshots are never an argument');
  assert.deepEqual(designBot.TOOLS.find((t) => t.function.name === 'get_request').function.parameters.required, ['number']);
});

const call = (name, args, id = `c${name}`) => ({ id, function: { name, arguments: JSON.stringify(args) } });

function scripted(steps, seen = []) {
  let i = 0;
  return async (req) => {
    seen.push(structuredClone(req.messages));
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return typeof step === 'string' ? { content: step, toolCalls: [] } : { content: step.content || '', toolCalls: step.calls };
  };
}

// `threadApp`: the project the design's thread belongs to (surface 'new': null).
// `apps`: what findApp resolves, by the name the model passed.
// `design`/`current`: the thread's design and the version shown (read_plan).
// `planTarget`: the request planTargetOf gives; `requestSpecs` what it posts.
function boardTurn(steps, {
  surface = 'app', threadApp = HOMEROOM, canView = true, apps = { homeroom: HOMEROOM, ear: EAR }, openMcp,
  design = null, current = null, planTarget = null, requestSpecs = null,
} = {}) {
  const sent = [];
  const seen = [];
  const opened = [];
  const closes = [];
  const calls = [];
  const versions = [];
  const turns = [];
  const realThreads = require('../src/services/design-threads');
  const platform = openMcp === undefined ? {
    async call(name, args) { calls.push({ name, args }); return { text: `answer from ${name}` }; },
    async close() { closes.push(true); },
  } : null;
  const pool = { async query(sql) { return { rows: /FROM conversation_messages\b/.test(sql) ? [] : [] }; } };
  const deps = {
    chat: scripted(steps, seen), apiKey: 'sk-test', seesImages: false, sleep: async () => {},
    dm: { async sendDm(_pool, args) { sent.push(args); return { messageId: 900 + sent.length }; } },
    mayor: Object.assign(Object.create(mayor), {
      async recordTurn(_pool, args) { turns.push(args); }, async turnsLastHour() { return 0; },
      async findApp(_pool, name) {
        const q = String(name || '').toLowerCase();
        return Object.values(apps).find((a) => a.slug === q || String(a.name).toLowerCase() === q) || null;
      },
      // The code readers are not what this suite pins: they only spend the
      // reading budget.
      async listSource() { return { ok: true, files: [] }; },
      async canView() { return canView; },
    }),
    designThreads: {
      ...realThreads,
      surfaceFor: () => surface,
      validHtml: () => true,
      async versionOf() { return current; },
      async ensureDesign() { return { threadId: 7, title: 'Main screen', app: threadApp || HOMEROOM }; },
      async addVersion(_pool, args) { versions.push(args); return { version: 1 }; },
      bareNote: require('../src/services/design-threads').bareNote,
      versionLine: (version, note) => `Version ${version} · ${note}`,
      async noteVersionMessage() {},
      async planTargetOf() { return planTarget; },
    },
    track: { async tracksForRequests() { return new Map(); } },
    openMcp: async (options) => { opened.push(options); return openMcp === undefined ? platform : openMcp(); },
    ...(requestSpecs ? { requestSpecs } : {}),
  };
  const run = designBot.answer(pool, { port: 3000 }, {
    bot: { id: 2, username: 'homeroom_bot' },
    user: { id: 9, username: 'evan' },
    settings: { mode: 'live' },
    conversationId: 41,
    message: { id: 71, content: 'check recent issues on Homeroom' },
    design,
    thread: { rootId: 500, threadId: 7, app: threadApp },
    handoff: false,
    deps,
  });
  return { run, sent, seen, opened, closes, calls, versions, turns, platform };
}

/** The result the model was handed for the tool call with `id`. */
function toolResult(seen, id) {
  for (let i = seen.length - 1; i >= 0; i -= 1) {
    const tool = [...seen[i]].reverse().find((m) => m.role === 'tool' && m.tool_call_id === id);
    if (tool) return JSON.parse(tool.content);
  }
  return null;
}

test('a design with a project reads that project\'s board by default', async () => {
  const turn = boardTurn([
    { calls: [call('list_requests', {})] },
    { calls: [call('reply', { text: 'I looked through Homeroom\'s open requests.' })] },
  ]);
  await turn.run;
  assert.deepEqual(turn.calls, [{ name: 'list_requests', args: { slug: 'homeroom' } }]);
  const result = toolResult(turn.seen, 'clist_requests');
  assert.equal(result.ok, true);
  assert.equal(result.project, 'Homeroom', 'the model can name the project it read');
  assert.equal(turn.sent.length, 1);
  assert.match(turn.sent[0].content, /looked through Homeroom/);
});

test('a design with no project reads the one they name', async () => {
  const turn = boardTurn([
    { calls: [call('list_requests', { project: 'Homeroom', query: 'issue list', detail: 'full' })] },
    { calls: [call('reply', { text: 'Here is what I found in Homeroom.' })] },
  ], { surface: 'new', threadApp: null });
  await turn.run;
  assert.deepEqual(turn.calls, [{ name: 'list_requests', args: { slug: 'homeroom', query: 'issue list', detail: 'full' } }]);
  assert.equal(turn.sent.length, 1);
});

test('a design with no project says to name one, and reads nothing', async () => {
  const turn = boardTurn([
    { calls: [call('list_requests', {})] },
    { calls: [call('reply', { text: 'Which project do you mean? I can read any project you can see.' })] },
  ], { surface: 'new', threadApp: null });
  await turn.run;
  assert.deepEqual(turn.calls, []);
  assert.deepEqual(turn.opened, [], 'no grant is opened for nothing');
  assert.match(toolResult(turn.seen, 'clist_requests').error, /Name a project/);
  assert.equal(turn.sent.length, 1);
});

test('a project they cannot see answers as one that does not exist, and is not read', async () => {
  for (const canView of [true, false]) {
    const turn = boardTurn([
      { calls: [call('list_requests', { project: 'Ear Trainer' })] },
      { calls: [call('reply', { text: 'I cannot see that project.' })] },
    ], { canView });
    await turn.run;
    if (!canView) {
      assert.deepEqual(turn.calls, []);
      assert.deepEqual(turn.opened, []);
      assert.equal(toolResult(turn.seen, 'clist_requests').error, 'No project they can see is called that.');
    } else {
      assert.deepEqual(turn.calls, [{ name: 'list_requests', args: { slug: 'ear' } }]);
    }
  }
  const missing = boardTurn([
    { calls: [call('list_requests', { project: 'Not a project' })] },
    { calls: [call('reply', { text: 'I could not find it.' })] },
  ]);
  await missing.run;
  assert.equal(toolResult(missing.seen, 'clist_requests').error, 'No project they can see is called that.',
    'a missing project reads the same as a hidden one');
});

test('get_request sends its number, never asks for screenshots, and refuses a bad number', async () => {
  const turn = boardTurn([
    { calls: [call('get_request', { project: 'Homeroom', number: 6260, extra: 'ignored' })] },
    { calls: [call('reply', { text: 'That request is about the bot seeing the issue list.' })] },
  ]);
  await turn.run;
  assert.deepEqual(turn.calls, [{ name: 'get_request', args: { slug: 'homeroom', number: 6260, includeImages: false } }]);

  for (const bad of [-1, 0, 2.5, 'abc']) {
    const refused = boardTurn([
      { calls: [call('get_request', { number: bad })] },
      { calls: [call('reply', { text: 'Which request?' })] },
    ]);
    await refused.run;
    assert.deepEqual(refused.calls, [], `refused ${JSON.stringify(bad)}`);
    assert.match(toolResult(refused.seen, 'cget_request').error, /number/);
  }
});

test('the grant is opened once for the turn and closed after it, only when a board was read', async () => {
  const read = boardTurn([
    { calls: [call('list_requests', {})] },
    { calls: [call('get_request', { number: 1 })] },
    { calls: [call('reply', { text: 'Both looked at.' })] },
  ]);
  await read.run;
  assert.equal(read.opened.length, 1, 'opened once, not once a call');
  assert.equal(read.opened[0].userId, 9);
  assert.equal(read.opened[0].imageInput, false);
  assert.equal(read.opened[0].rateSubject, 'hrbot-design-9');
  assert.equal(read.calls.length, 2);
  assert.equal(read.closes.length, 1, 'closed after the turn');

  const replyOnly = boardTurn([{ calls: [call('reply', { text: 'Nothing to look up.' })] }]);
  await replyOnly.run;
  assert.deepEqual(replyOnly.opened, [], 'never opened when no board was read');
  assert.deepEqual(replyOnly.closes, []);
});

test('without a grant the board cannot be read, and the turn still answers', async () => {
  const turn = boardTurn([
    { calls: [call('list_requests', {})] },
    { calls: [call('reply', { text: 'I cannot read the requests right now.' })] },
  ], { openMcp: async () => null });
  await turn.run;
  assert.deepEqual(turn.calls, []);
  assert.equal(toolResult(turn.seen, 'clist_requests').error, 'Requests cannot be read right now.');
  assert.equal(turn.sent.length, 1);
  assert.match(turn.sent[0].content, /cannot read the requests/);
});

test('reading requests stops at the reading budget, like the code readers', async () => {
  // READ_UNTIL rounds of code reading, then a board read: refused.
  const steps = [];
  for (let i = 0; i < designBot.READ_UNTIL; i += 1) steps.push({ calls: [call(`list_source`, { dir: 'public' }, `c${i}`)] });
  steps.push({ calls: [call('list_requests', {})] });
  steps.push({ calls: [call('reply', { text: 'I ran out of reading rounds.' })] });
  const turn = boardTurn(steps);
  await turn.run;
  assert.deepEqual(turn.calls, [], 'the late board read never reaches the platform');
  assert.match(toolResult(turn.seen, 'clist_requests').error, /Reading is over/);
});

// ── #6353: the plan is drawn without scripts, and screens grow by edits ───

// A design thread at version 4, its screen drawn at a phone size.
const DESIGN = Object.freeze({
  threadId: 7, rootId: 500, state: 'open', number: null, latest: 4,
  app: { id: 3, slug: 'homeroom', name: 'Homeroom' },
  title: 'Homeroom bot page', surface: 'platform', route: null, width: 390, height: 844,
});

test('read_plan is offered as a reader, and reads the plan the current version would make', async () => {
  const names = designBot.TOOLS.map((t) => t.function.name);
  assert.ok(names.includes('read_plan'));
  assert.equal(designBot.READ_TOOLS.has('read_plan'), true, 'a reader: the reading budget applies');
  assert.equal(designBot.ACT_TOOLS.some((t) => t.function.name === 'read_plan'), false);
  const tool = designBot.TOOLS.find((t) => t.function.name === 'read_plan').function;
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false });
  assert.match(tool.description, /without scripts/);
  assert.match(tool.description, /plan or the preview looks wrong/);
  assert.doesNotMatch(tool.description, /—/);

  // No design yet: said, not a read.
  const none = boardTurn([
    { calls: [call('read_plan', {})] },
    { calls: [call('reply', { text: 'Draw it first.' })] },
  ]);
  await none.run;
  assert.match(toolResult(none.seen, 'cread_plan').error, /no screen yet/);

  const html = '<main><h1>Homeroom bot</h1><ul><li>One</li><li>Two</li></ul></main>';
  const turn = boardTurn([
    { calls: [call('read_plan', {})] },
    { calls: [call('reply', { text: 'It shows two rows.' })] },
  ], { design: DESIGN, current: { version: 4, html } });
  await turn.run;
  const result = toolResult(turn.seen, 'cread_plan');
  assert.equal(result.ok, true);
  assert.equal(result.posted, false);
  assert.equal(result.designVersion, 4);
  assert.equal(result.gap, null, 'rows in the markup leave no gap');
  assert.equal(result.screens.length, 1);
  assert.equal(result.screens[0].size, 'phone');
  const after = result.screens[0].sides.find((s) => s.side === 'after');
  assert.equal(after.lists, 1);
  assert.equal(after.rows, 2);
  assert.equal(after.emptyLists, 0);
  assert.match(after.text, /Homeroom bot One Two/);
});

test('read_plan reads a posted plan back from its request, without scripts', async () => {
  const designs = require('../src/services/design-threads');
  const posted = designs.planHtml({
    design: { width: 390, height: 844, title: 'Homeroom bot page', route: null, surface: 'platform' },
    title: 'Homeroom bot page', notes: '', before: null, after: '<main><p>Posted words</p></main>', version: 3,
  });
  const read = [];
  const turn = boardTurn([
    { calls: [call('read_plan', {})] },
    { calls: [call('reply', { text: 'The posted plan says Posted words.' })] },
  ], {
    design: { ...DESIGN, state: 'posted', number: 18 }, current: { version: 4, html: '<main><p>Now</p></main>' },
    planTarget: 18,
    requestSpecs: { async personPlanOf(_pool, args) { read.push(args); return { version: 2, html: posted }; } },
  });
  await turn.run;
  assert.deepEqual(read, [{ appId: 3, issueNumber: 18 }], 'the thread\'s request, on its project');
  const result = toolResult(turn.seen, 'cread_plan');
  assert.equal(result.ok, true);
  assert.equal(result.posted, true);
  assert.equal(result.number, 18);
  assert.equal(result.planVersion, 2, 'the plan\'s own version');
  assert.equal(result.designVersion, 3, 'the design version it shows');
  assert.match(result.screens[0].sides.find((s) => s.side === 'after').text, /Posted words/);
});

test('one whole screen a turn: a second write_screen is refused and recorded, and the edit goes through', async () => {
  const first = '<main><h1>Homeroom bot</h1><p>Plenty of words written into this screen.</p></main>';
  const second = '<main><p>Second screen.</p></main>';
  const turn = boardTurn([
    { calls: [call('write_screen', { title: 'Page', size: 'phone', html: first, note: 'A page' }, 'w1')] },
    { calls: [call('write_screen', { title: 'Page', size: 'phone', html: second, note: 'Again' }, 'w2')] },
    { calls: [call('edit_design', { edits: [{ find: 'Homeroom bot', replace: 'Homeroom' }], note: 'Tidied' }, 'e1')] },
    { calls: [call('reply', { text: 'Drew it.' }, 'r1')] },
  ], { design: DESIGN, current: { version: 4, html: '<main><p>Old screen</p></main>' } });
  await turn.run;
  assert.equal(toolResult(turn.seen, 'w1').ok, true);
  const refused = toolResult(turn.seen, 'w2');
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'You drew this turn\'s screen already. Change or extend it with edit_design: a second '
    + 'write_screen is taken only when the first was refused or empty.');
  assert.equal(toolResult(turn.seen, 'e1').ok, true, 'the edit is taken');
  assert.deepEqual(turn.turns[0].failures, ['d2:rewrite'], 'recorded among the turn\'s failures');
  const saved = turn.versions[0].html;
  assert.doesNotMatch(saved, /Second screen/);
  assert.match(saved, /Plenty of words written into this screen/);
  assert.match(saved, /<h1>Homeroom<\/h1>/, 'the edit was applied to the first screen');
});

test('a second write_screen is taken after an empty one, or a refused one', async () => {
  for (const [label, first, taken] of [
    ['empty', '<main><div id="rows"></div><script>document.getElementById("rows").innerHTML = "x";</script></main>', true],
    ['refused', '', false],
  ]) {
    const second = '<main><h1>Second</h1><p>Now with words in the markup.</p></main>';
    const turn = boardTurn([
      { calls: [call('write_screen', { title: 'Page', size: 'phone', html: first, note: 'First' }, 'w1')] },
      { calls: [call('write_screen', { title: 'Page', size: 'phone', html: second, note: 'Second' }, 'w2')] },
      { calls: [call('reply', { text: 'Drew it.' }, 'r1')] },
    ], { design: DESIGN, current: { version: 4, html: '<main><p>Old screen</p></main>' } });
    await turn.run;
    assert.equal(toolResult(turn.seen, 'w1').ok, taken, label);
    assert.equal(toolResult(turn.seen, 'w2').ok, true, `${label}: the second is taken`);
    assert.match(turn.versions[0].html, /Now with words in the markup/, label);
    assert.equal(turn.turns[0].failures.includes('d2:rewrite'), false, `${label}: no rewrite recorded`);
  }
});

test('the tools and the prompt say a plan drops scripts, and name read_plan', () => {
  const write = designBot.TOOLS.find((t) => t.function.name === 'write_screen').function.description;
  assert.match(write, /A plan shows the screen without its scripts/);
  assert.match(write, /write every row, label and state it must show into the markup/);
  assert.match(write, /One write_screen a turn: grow it with edit_design/);
  const edit = designBot.TOOLS.find((t) => t.function.name === 'edit_design').function.description;
  assert.match(edit, /The way to change or extend this turn's screen/);
  assert.match(edit, /write rows and words into the markup, not a script that builds them/);
  const prompt = designBot.designPrompt({ username: 'evan', design: DESIGN, version: 4, html: '<p>x</p>' });
  assert.match(prompt, /A plan shows the screen without its scripts, so\n {2}every row, label and state it must show goes in the markup/);
  assert.match(prompt, /A second\n {2}write_screen is taken only when the first was refused or came out empty\./);
  assert.doesNotMatch(prompt, /A second write_screen in a turn replaces the first/);
  assert.match(prompt, /call read_plan first and answer from what it shows; never\n {2}guess why\./);
});
