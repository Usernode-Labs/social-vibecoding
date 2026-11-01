'use strict';

// Threads, one loop (phase C2): what the database tests cannot show. The
// make sheet and the cards' buttons as drawn, the design bot's offer tools,
// and where the build path reads a person's plan
// (tests/design-plans-postgres.test.js and tests/app-from-design-postgres.test.js
// run them against PostgreSQL).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('the design bot offers a plan and a project as cards, its tools last, and never posts itself', () => {
  const designBot = require('../src/services/design-bot');
  const names = designBot.TOOLS.map((t) => t.function.name);
  assert.deepEqual(names.slice(-2), ['offer_plan', 'offer_project'], 'a separate block at the end');
  for (const tool of designBot.TOOLS.slice(-2)) {
    assert.equal(tool.function.parameters.additionalProperties, false);
    assert.doesNotMatch(tool.function.description, /—/);
  }
  const plan = designBot.TOOLS.find((t) => t.function.name === 'offer_plan').function;
  assert.deepEqual(plan.parameters.properties.target.enum, ['request', 'new']);
  assert.match(plan.description, /Never say it was posted: it is posted only when they tap\./);
  const prompt = designBot.designPrompt({
    username: 'ada', design: { surface: 'app', app: { name: 'Plant pal' }, title: 'List', width: 390, height: 844 }, version: 2, html: '<p>x</p>',
  });
  assert.match(prompt, /You never post, file or make anything yourself: when they say it looks good,\n {2}or ask to post it, offer it with offer_plan/);
  const src = read('src/services/design-bot.js');
  assert.match(src, /if \(offered && !changed && !error\) \{\n {4}return mayor\.sendDesignOffer\(/, 'the card is the turn\'s answer');
  assert.match(src, /key: `hrbot-design-offer-\$\{message\.id\}`/, 'or follows the version the same turn made');
  assert.match(src, /if \(design && !\['open', 'posted', 'filed'\]\.includes\(design\.state\)\) return say\(CLOSED_TEXT\);/, 'a posted design is still worked on');
});

test('a plan\'s card carries only yes or no: the request is the server\'s', () => {
  const mayor = require('../src/services/homeroom-bot-mayor');
  assert.deepEqual(mayor.designPlanActions(18), [
    { id: 'yes', label: 'Post as a plan on #18', style: 'primary', type: 'server' },
    { id: 'no', label: 'Not yet', style: 'secondary', type: 'server' },
  ]);
  assert.deepEqual(mayor.designPlanActions(null), [
    { id: 'yes', label: 'New request', style: 'primary', type: 'server' },
    { id: 'existing', label: 'Add to an existing request…', style: 'secondary', type: 'prompt', quote: true },
  ]);
  const settle = read('src/services/homeroom-bot-mayor.js');
  assert.match(settle, /if \(action\.kind === 'post_design'\) return decidePostDesign\(pool, config, \{ user, action, yes, ack, key, deps: actDeps \}\);/);
  assert.match(settle, /issueNumber: Number\(action\.source_issue_number\) > 0 \? Number\(action\.source_issue_number\) : null, deps,/);
  const migration = read('src/db/migrations/0005-plans-and-projects.sql');
  assert.match(migration, /'post_reply',\n {18}'post_design'\)\);/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS built_from_session_id INTEGER;/);
});

test('the bot builds from a person\'s plan before it plans one itself, and pairs the change with it', () => {
  const src = read('src/services/homeroom-bot.js');
  const ready = src.slice(src.indexOf("} else if (parsed.verdict === 'ready') {"), src.indexOf('await live.advanceSeen({', src.indexOf("} else if (parsed.verdict === 'ready') {")));
  const own = ready.indexOf("(ownPlan = await usePersonPlan(pool, { runId, app, issueNumber, deps }))?.use === 'build'");
  assert.ok(own > 0 && own < ready.indexOf("} else if (parsed.complicated || ownPlan?.use === 'plan') {"), 'before the complicated branch');
  assert.match(ready, /const own = await usePersonPlan\(pool, \{ runId, app, issueNumber, firstVersion: true, deps \}\);/, 'a first version too');
  assert.match(src, /const plan = \{ \.\.\.planFor\(parsed\), \.\.\.\(fromPlan\?\.sessionId \? \{ fromPlan \} : \{\}\) \};/, 'its plan keeps where it came from');
  const live = src.slice(src.indexOf('async function buildLive({'), src.indexOf('async function buildOne('));
  assert.match(live, /const builtFrom = fromPlan \|\| \(checkFirst && Number\(plan\?\.spec\?\.sessionId\) > 0 \? plan\.spec : null\);/);
  assert.match(live, /if \(builtFrom\) await noteBuiltFrom\(pool, \{ sessionId: session\.id, from: builtFrom \}\);/);
  assert.match(live, /threadMessage: version && !checkFirst && !fromPlan \? live\.specCard/, 'no second plan card');
  assert.match(live, /\.\.\.\(fromPlan \? \{ homeroomText: live\.fromPlanHomeroomText\(fromPlan\) \}/);
  const threads = read('src/services/threads.js');
  assert.match(threads, /AND NOT \(cs\.source IS NOT DISTINCT FROM 'request_spec' AND cs\.branch_name IS NULL\)/, 'a posted plan is never a change');
});

test('Make the project opens the make sheet in place, and Make it posts the design', () => {
  const { MakeSheet, makeBody, MAKE_AUDIENCES } = loadTsx('frontend/src/features/messages/bot-make.tsx');
  assert.deepEqual(MAKE_AUDIENCES, ['solo', 'invited', 'open']);
  assert.deepEqual(makeBody({ name: 'Watering can', rootId: 77, version: 2 }, ' Watering can ', 'solo', 'Europe/London'), {
    name: 'Watering can', audience: 'solo', brief: 'Watering can', from: 'design', design: { rootId: 77, version: 2 }, timeZone: 'Europe/London',
  });
  const html = renderToHtml(createElement(MakeSheet, { project: { name: 'Watering can', rootId: 77, version: 2 }, onClose() {}, onMade() {} }));
  assert.match(html, /data-bot-make-sheet=""/);
  assert.match(html, /value="Watering can"/, 'the name the card gave');
  assert.match(html, /data-bot-make-audience="invited"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-bot-make-audience="invited"/, 'a private community unless they choose');
  for (const id of ['messages:bot.make.title', 'messages:bot.make.audience.solo', 'messages:bot.make.audience.invited', 'messages:bot.make.audience.open', 'messages:bot.make.submit']) {
    assert.ok(html.includes(message(id).replace(/'/g, '&#x27;')), id);
  }
  assert.equal(message('messages:bot.make.title'), 'Make the project');

  const { BotQuestion } = loadTsx('frontend/src/features/messages/bot-question.tsx', {
    stubs: { './store': { answerBotQuestion() {}, quoteInComposer() {}, async tapBotAction() {} } },
  });
  const card = {
    id: 9, conversationId: 3, sender: { id: 4, username: 'homeroom_bot', bot: true }, content: 'Make it?', deleted: false,
    metadata: { homeroomBot: {
      kind: 'make_offer', status: 'open', question: 'Make Watering can?', makeProject: { name: 'Watering can', rootId: 77, version: 2 },
      actions: [{ id: 'make', label: 'Make the project', style: 'primary', type: 'make' }],
    } },
  };
  assert.match(renderToHtml(createElement(BotQuestion, { message: card, conversationId: 3 })), /class="messages-bot-primary"[^>]*><span>Make the project<\/span>/);
  const made = { ...card, metadata: { homeroomBot: { ...card.metadata.homeroomBot, status: 'answered', answer: 'Make the project', madeSlug: 'watering-can', madeName: 'Watering can' } } };
  assert.match(renderToHtml(createElement(BotQuestion, { message: made, conversationId: 3 })), /href="#app\/watering-can">Open Watering can<\/a>/);
  const question = read('frontend/src/features/messages/bot-question.tsx');
  assert.match(question, /if \(action\.type === 'make'\) \{\n {6}if \(meta\.makeProject\) setMaking\(true\);\n {6}return;\n {4}\}/);
});

test('the design pane posts on the thread\'s request when it has one, and may post again', () => {
  const pane = read('frontend/src/features/messages/design-pane.tsx');
  assert.match(pane, /const postable = !!design\?\.app && \(open \|\| design\?\.state === 'posted' \|\| design\?\.state === 'filed'\);/, 'a design for no project yet posts nowhere: Make the project is its way');
  assert.match(pane, /\{on \? t\('messages:design\.propose\.warningOn', \{ version, number: on, project \}\)/);
  assert.equal(message('messages:design.propose.sendOn'), 'Post it as a plan');
  const route = read('src/routes/conversations.js');
  assert.match(route, /const planOn = await designThreads\(\)\.planTargetOf\(pool, design\)\.catch\(\(\) => null\);/);
});

test('a new project\'s thread: the Mayor opens it from Main, and its turns know what it is for', () => {
  const mayor = require('../src/services/homeroom-bot-mayor');
  assert.equal(mayor.projectThreadLine('a plant watering reminder.'), 'New thread, for a new project: a plant watering reminder. Only you can see it.');
  const tool = mayor.TOOLS.find((t) => t.function.name === 'start_project_thread').function;
  assert.deepEqual(tool.parameters.required, ['idea']);
  assert.match(tool.description, /Not for a change to a project that exists\./);
  const prompt = mayor.systemPrompt({ username: 'ada', thread: { draft: { kind: 'ask', changeKind: 'project', state: 'open' } } });
  assert.match(prompt, /It is the private thread you opened for a NEW project, which does not exist yet\./);
  const src = read('src/services/homeroom-bot-mayor.js');
  assert.match(src, /\.\.\.\(ctx\.projectThread \? \{ replyToId: null, threadRootId: ctx\.projectThread\.rootId \} : \{\}\),/);
  assert.match(read('src/services/homeroom-bot-dm.js'), /changeKind: \['fix', 'add', 'design', 'project'\]\.includes\(p\.change_kind\)/);
});

test('POST /api/apps takes a design: checked, its brief and plan from it, the card settled', () => {
  const route = read('src/routes/apps.js');
  assert.match(route, /fromDesign = await homeroomBotDm\.designForProject\(pool, \{ user: req\.user, design: req\.body\.design, brief: req\.body\.brief \}\);/);
  assert.match(route, /app: appRow, user: req\.user, brief: req\.body\.brief, design: fromDesign,/);
  assert.match(route, /earlyPlan: MAKE_ORIGINS\.has\(req\.body\.from\) \|\| !!fromDesign,/);
  const dm = require('../src/services/homeroom-bot-dm');
  const brief = dm.designBrief({ title: 'Watering', versions: [{ version: 1, author: 'bot', note: 'A list' }, { version: 2, author: 'bot', note: 'Bigger' }] }, 1, '');
  assert.equal(brief, 'Watering\n\nIts first screen is "Watering", designed with Homeroom bot in a private thread (version 1). The first request\'s plan draws it.\n\nHow the design came to be, version by version:\n- A list');
  const plan = require('../src/services/first-version-plan').designPlan({ title: 'Watering' }, 2);
  assert.deepEqual(plan.questions, [], 'it asks nothing');
  assert.match(plan.buildNote, /posted as this request's plan\. Build the plan's screens as drawn/);
  const filing = read('src/services/homeroom-bot-dm.js');
  assert.ok(filing.indexOf("steps.once('design_plan'") < filing.indexOf("steps.once('record'"), 'the plan is there before the bot is told of the request');
});
