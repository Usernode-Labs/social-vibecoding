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
//   6. The grant is the turn's own (step 6, #6864: the chat's turn opens one
//      and the design reads through it), opened once and closed once;
//      without one the turn still answers.
// Step 6: every turn here is the chat's own (homeroom-bot-mayor.js
// runDmTurn), in a thread that holds a design (tests/lib/design-chat-turn.js).

const test = require('node:test');
const assert = require('node:assert/strict');

// #6682: a draft's access check reads app-access and the community's
// membership. Both are stubbed here, so the offer path needs no database and
// no platform key (the real modules read one). What the bot does with their
// answers is the point of this suite.
const accessPath = require.resolve('../src/services/app-access');
require.cache[accessPath] = {
  id: accessPath, filename: accessPath, loaded: true,
  exports: {
    nonSecretAppColumnList: () => 'id, slug, name, view_visibility, collab_visibility, community_id',
    async checkAppAccess(_pool, app) { return !!app && app.collab_visibility !== 'private'; },
  },
};
const communitiesPath = require.resolve('../src/services/communities');
require.cache[communitiesPath] = {
  id: communitiesPath, filename: communitiesPath, loaded: true,
  exports: { async isMember() { return false; } },
};

const mayor = require('../src/services/homeroom-bot-mayor');
const designBot = require('../src/services/design-bot');

const HOMEROOM = { id: 3, slug: 'homeroom', name: 'Homeroom' };
const EAR = { id: 4, slug: 'ear', name: 'Ear Trainer' };
const LOCKED = { id: 5, slug: 'locked', name: 'Locked Project' };

test('the design bot is offered both board readers, and they count as reading', () => {
  const names = designBot.TOOLS.map((t) => t.function.name);
  assert.ok(names.includes('list_requests'));
  assert.ok(names.includes('get_request'));
  assert.equal(names.indexOf('list_requests') > names.indexOf('offer_project'), true, 'appended after offer_project');
  assert.deepEqual(designBot.TOOLS.slice(0, 5).map((t) => t.function.name), ['write_screen', 'edit_design', 'list_source', 'read_source', 'read_plan'],
    'the chat\'s own reply ends a design turn');
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

const { designChatTurn, call } = require('./lib/design-chat-turn');

// `threadApp`: the project the design's thread belongs to (surface 'new': null).
// `apps`: what findApp resolves, by the name the model passed.
// `design`/`current`: the thread's design and the version shown (read_plan).
// `planTarget`: the request planTargetOf gives; `requestSpecs` what it posts.
function boardTurn(steps, {
  surface = 'app', threadApp = HOMEROOM, canView = true, apps = { homeroom: HOMEROOM, ear: EAR, locked: LOCKED }, openMcp,
  design = null, current = null, planTarget = null, requestSpecs = null,
} = {}) {
  const opened = [];
  const closes = [];
  const calls = [];
  // Step 6: the chat's own turn opens one read grant for the turn, and the
  // design reads the board through it (design-bot.js openSession `grant`).
  // This one serves no tools of its own, so the design's readers are used.
  const platform = openMcp === undefined ? {
    async call(name, args) { calls.push({ name, args }); return { text: `answer from ${name}` }; },
    async close() { closes.push(true); },
  } : null;
  // A thread that holds a design: one with no version yet, when none is given.
  const held = design || {
    threadId: 7, rootId: 500, state: 'open', number: null, latest: 0, versions: [],
    app: threadApp ? { slug: threadApp.slug, name: threadApp.name } : null,
    title: 'Main screen', surface, route: null, width: 390, height: 844,
  };
  // #6682: the real checkRequestOffer needs the project lookups a draft makes
  // (findApp, the block check, the member check); everything else is empty.
  const answer = (text, params) => {
    if (/FROM apps\s+WHERE slug = LOWER\(\$1\) OR LOWER\(name\) = LOWER\(\$1\)/.test(text)) {
      const q = String(params[0] || '').trim().toLowerCase();
      const app = Object.values(apps).find((a) => a.slug === q || String(a.name).toLowerCase() === q);
      return {
        rows: app ? [{
          ...app, view_visibility: 'public', collab_visibility: 'public',
          community_id: app.slug === 'locked' ? 55 : null,
        }] : [],
      };
    }
    return undefined;
  };
  const turn = designChatTurn(steps, {
    design: held, current, surface, answer, config: { port: 3000 },
    ask: 'check recent issues on Homeroom',
    room: { rootId: 500, threadId: 7, conversationId: 41, kind: 'ask', app: threadApp, about: null },
    mayorOverrides: {
      async findApp(_pool, name) {
        const q = String(name || '').toLowerCase();
        return Object.values(apps).find((a) => a.slug === q || String(a.name).toLowerCase() === q) || null;
      },
      // The code readers are not what this suite pins: they only spend the
      // reading budget.
      async listSource() { return { ok: true, files: [] }; },
      async canView() { return canView; },
    },
    threads: {
      async ensureDesign() { return { threadId: 7, rootId: 500, title: 'Main screen', app: threadApp || HOMEROOM }; },
      async addVersion(_pool, args) { turn.versionArgs.push(args); return { version: 1 }; },
      async planTargetOf() { return planTarget; },
    },
    deps: {
      openMcp: async (options) => { opened.push(options); return openMcp === undefined ? platform : openMcp(); },
      ...(requestSpecs ? { requestSpecs } : {}),
    },
  });
  // A request draft goes out through the chat's own offer, as a card under
  // the reply (bot_cards: `card.kind` file_request); the design's plan card is
  // post_design.
  const offers = () => turn.sent.filter((m) => m.card?.kind === 'file_request');
  const plans = () => turn.sent.filter((m) => m.card?.kind === 'post_design');
  return { ...turn, versions: turn.versionArgs, turns: turn.recorded, opened, closes, calls, offers, plans, platform };
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
  assert.deepEqual(turn.calls, [], 'nothing is read');
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

test('the turn\'s own grant is opened once and closed after it, and the design reads through it', async () => {
  const read = boardTurn([
    { calls: [call('list_requests', {})] },
    { calls: [call('get_request', { number: 1 })] },
    { calls: [call('reply', { text: 'Both looked at.' })] },
  ]);
  await read.run;
  assert.equal(read.opened.length, 1, 'opened once, not once a call');
  assert.equal(read.opened[0].userId, 9);
  assert.equal(read.opened[0].imageInput, false);
  assert.equal(read.opened[0].rateSubject, 'hrbot-dm-9', 'the chat turn\'s own grant');
  assert.equal(read.calls.length, 2);
  assert.equal(read.closes.length, 1, 'closed after the turn, once');
});

test('without a grant the board cannot be read, and the turn still answers', async () => {
  const turn = boardTurn([
    { calls: [call('list_requests', {})] },
    { calls: [call('reply', { text: 'I cannot read the requests right now.' })] },
  ], { openMcp: async () => null });
  await turn.run;
  assert.deepEqual(turn.calls, []);
  assert.equal(turn.opened.at(-1).rateSubject, 'hrbot-design-9', 'the design tried a grant of its own');
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
  // #6681: the look at the render runs before the version is shown, and this
  // harness has no capture job, so it records that it was skipped.
  assert.deepEqual(turn.turns[0].failures.filter((f) => !/:look_skipped$/.test(f)), ['d2:rewrite'], 'recorded among the turn\'s failures');
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

// ── #6682: a design thread offers an ordinary request, never the plan card ──

const REQUEST_ARGS = {
  title: 'Keep drawn screens close to the project\'s real styles',
  details: 'Read the project\'s own markup and classes before drawing, so the drawing matches how the app looks.',
  doneWhen: ['The drawing uses the project\'s own classes.'],
};

test('offer_request in a design thread is the chat\'s own, beside the design\'s offers', () => {
  // Step 6 (#6864): the design adds no offer_request of its own; the chat's
  // serves it, with notTheDesign for a request on the design's own project.
  const names = designBot.TOOLS.map((t) => t.function.name);
  assert.ok(!names.includes('offer_request'), 'not a second copy');
  const tool = mayor.TOOLS.find((t) => t.function.name === 'offer_request').function;
  assert.equal(tool.parameters.additionalProperties, false);
  assert.doesNotMatch(tool.description, /—/);
  assert.match(designBot.TOOLS.find((t) => t.function.name === 'offer_plan').function.description,
    /Only this design: never for another request/);
  assert.match(designBot.TOOLS.find((t) => t.function.name === 'offer_plan').function.description,
    /They approve the design \(lgtm, looks good, that's it\) or ask you to build, implement, file or post it/);
});

test('in a design thread for project A, the bot offers a request on project B, not the plan card', async () => {
  const turn = boardTurn([
    { calls: [call('offer_request', { ...REQUEST_ARGS, project: 'Ear Trainer' }, 'o1')] },
    { calls: [call('reply', { text: 'Here is the request I\'d file on Ear Trainer. Nothing is filed until you tap File it.' }, 'r1')] },
  ], { design: DESIGN, current: { version: 4, html: '<main><p>Now</p></main>' } });
  await turn.run;
  assert.equal(toolResult(turn.seen, 'o1').ok, true);
  assert.equal(turn.offers().length, 1, 'one card, through the chat turn\'s own offer');
  assert.equal(turn.offers()[0].card.appId, EAR.id);
  assert.match(turn.offers()[0].content, /Keep drawn screens close to the project's real styles/);
  assert.match(turn.offers()[0].content, /file on Ear Trainer/);
  assert.deepEqual(turn.plans(), [], 'no post_design card');
  assert.equal(turn.sent.length, 1, 'and no separate answer');
  assert.deepEqual(turn.versions, [], 'nothing filed or saved');
});

test('from a design thread about another project, the request can be filed on Homeroom', async () => {
  const ear = { ...DESIGN, app: { slug: 'ear', name: 'Ear Trainer' }, title: 'Ear Trainer drill' };
  const turn = boardTurn([
    { calls: [call('offer_request', { ...REQUEST_ARGS, project: 'Homeroom' }, 'o1')] },
    { calls: [call('reply', { text: 'Here is the request I\'d file on Homeroom. Tap File it to file it under your name.' }, 'r1')] },
  ], { design: ear, threadApp: EAR, current: { version: 4, html: '<main><p>Now</p></main>' } });
  await turn.run;
  assert.equal(toolResult(turn.seen, 'o1').ok, true);
  assert.equal(turn.offers().length, 1);
  assert.equal(turn.offers()[0].card.appId, HOMEROOM.id, 'Homeroom\'s own app is offered like any other');
  assert.deepEqual(turn.plans(), []);
});

test('step 6: a request on the design\'s own project goes back to offer_plan, unless it is something else', async () => {
  const turn = boardTurn([
    { calls: [call('offer_request', { ...REQUEST_ARGS, project: 'Homeroom' }, 'o1')] },
    { calls: [call('offer_request', { ...REQUEST_ARGS, project: 'Homeroom', notTheDesign: true }, 'o2')] },
    { calls: [call('reply', { text: 'Here is the request I\'d file on Homeroom.' }, 'r1')] },
  ], { design: DESIGN, current: { version: 4, html: '<main><p>Now</p></main>' } });
  await turn.run;
  assert.match(toolResult(turn.seen, 'o1').error, /To file this design, offer it with offer_plan/);
  assert.equal(toolResult(turn.seen, 'o2').ok, true, 'something that is not this design is offered as a request');
  assert.equal(turn.offers().length, 1);
  assert.ok(turn.offered[0].includes('offer_request'));
});

test('a project they cannot file on is refused with the membership error, and no card is offered', async () => {
  const turn = boardTurn([
    { calls: [call('offer_request', { ...REQUEST_ARGS, project: 'Locked Project' }, 'o1')] },
    { calls: [call('reply', { text: 'They are not a member of Locked Project, so they can join it from its page.' }, 'r1')] },
  ], { design: DESIGN, current: { version: 4, html: '<main><p>Now</p></main>' } });
  await turn.run;
  const result = toolResult(turn.seen, 'o1');
  assert.equal(result.ok, false);
  assert.match(result.error, /not a member of Locked Project/);
  assert.deepEqual(turn.offers(), [], 'nothing is offered');
  assert.equal(turn.sent.length, 1, 'the turn still answers');
});

test('one reply holds one kind of card: a request and the design are never offered together', async () => {
  const requestFirst = boardTurn([
    { calls: [call('offer_request', { ...REQUEST_ARGS, project: 'Ear Trainer' }, 'o1')] },
    { calls: [call('offer_plan', { target: 'new' }, 'p1')] },
    { calls: [call('reply', { text: 'Here is the request I\'d file on Ear Trainer.' }, 'r1')] },
  ], { design: DESIGN, current: { version: 4, html: '<main><p>Now</p></main>' } });
  await requestFirst.run;
  assert.equal(toolResult(requestFirst.seen, 'o1').ok, true);
  assert.match(toolResult(requestFirst.seen, 'p1').error, /one kind of card/);
  assert.equal(requestFirst.offers().length, 1, 'the request goes out');
  assert.deepEqual(requestFirst.plans(), [], 'and the plan does not');

  const designFirst = boardTurn([
    { calls: [call('offer_plan', { target: 'new' }, 'p1')] },
    { calls: [call('offer_request', { ...REQUEST_ARGS, project: 'Ear Trainer' }, 'o1')] },
    { calls: [call('reply', { text: 'Tap New request to file version 4 as a plan on Homeroom.' }, 'r1')] },
  ], { design: DESIGN, current: { version: 4, html: '<main><p>Now</p></main>' } });
  await designFirst.run;
  assert.equal(toolResult(designFirst.seen, 'p1').ok, true);
  assert.match(toolResult(designFirst.seen, 'o1').error, /one kind of card/);
  assert.deepEqual(designFirst.offers(), [], 'no request draft');
  assert.equal(designFirst.sent.length, 1, 'the design\'s own card goes out');
  assert.equal(designFirst.sent[0].card.kind, 'post_design');
});

test('the prompt lets the bot offer an ordinary request, and never tells the person to file it', () => {
  const prompt = designBot.designPrompt({ username: 'evan', design: DESIGN, version: 4, html: '<p>x</p>' });
  assert.match(prompt, /offered with\n {2}offer_request, on the project they name, Homeroom included/);
  assert.match(prompt, /offer_plan is only for this design, never for another request/);
  assert.match(prompt, /offer_request never for this design: its card cannot carry the design/);
  assert.match(prompt, /Never tell them to file it themselves/);
  // The line above it still says the bot itself posts and files nothing,
  // and that approving the design files it with offer_plan (#6864).
  assert.match(prompt, /- You never post, file or make anything yourself\. When they approve the design \(lgtm, looks good, that's it,\n {2}ship it\) or ask you to build, implement, file or post it, offer it with offer_plan/);
});
