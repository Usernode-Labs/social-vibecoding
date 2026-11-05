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
  assert.deepEqual(names.slice(-4, -2), ['offer_plan', 'offer_project'], 'a separate block, before #6260\'s board readers');
  for (const tool of designBot.TOOLS.slice(-4, -2)) {
    assert.equal(tool.function.parameters.additionalProperties, false);
    assert.doesNotMatch(tool.function.description, /—/);
  }
  const plan = designBot.TOOLS.find((t) => t.function.name === 'offer_plan').function;
  assert.deepEqual(plan.parameters.properties.target.enum, ['request', 'new']);
  assert.equal(plan.parameters.properties.project.type, 'string');
  assert.match(plan.parameters.properties.project.description, /existing project/);
  assert.match(plan.description, /pass project when they name an existing project/);
  assert.match(plan.description, /Never say it was posted: it is posted only when they tap\./);
  const prompt = designBot.designPrompt({
    username: 'ada', design: { surface: 'app', app: { name: 'Plant pal' }, title: 'List', width: 390, height: 844 }, version: 2, html: '<p>x</p>',
  });
  assert.match(prompt, /You never post, file or make anything yourself: when they say it looks good,\n {2}or ask to post it, offer it with offer_plan/);
  assert.match(prompt, /offer it with offer_plan and project when they name an existing project to put it on, and with offer_project\n {2}only when they want a new project/);
  const src = read('src/services/design-bot.js');
  assert.match(src, /if \(offered && !changed && !error\) \{\n {4}return mayor\.sendDesignOffer\(/, 'the card is the turn\'s answer');
  assert.match(src, /key: `hrbot-design-offer-\$\{message\.id\}`/, 'or follows the version the same turn made');
  assert.match(src, /if \(design && !\['open', 'posted', 'filed'\]\.includes\(design\.state\)\) return say\(CLOSED_TEXT\);/, 'a posted design is still worked on');
});

test('a new-project design\'s plan says it was drawn with Homeroom\'s own stylesheets', () => {
  const designs = require('../src/services/design-threads');
  const html = designs.planHtml({
    design: { width: 390, height: 844, title: 'Saved replies', route: null, surface: 'new' },
    title: 'Saved replies', notes: '', before: null, after: '<main><h1>Saved replies</h1></main>', version: 3,
  });
  assert.match(html, /a mockup drawn with Homeroom's own stylesheets/);
  assert.doesNotMatch(html, /drawn with the project's stylesheets/);
  assert.equal(designs.planDesignVersion(html), 3);
  const ofProject = designs.planHtml({
    design: { width: 390, height: 844, title: 'List', route: null, surface: 'app' },
    title: 'List', notes: '', before: null, after: '<main>x</main>', version: 2,
  });
  assert.match(ofProject, /a mockup drawn with the project's stylesheets/);
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
  assert.match(settle, /issueNumber: Number\(action\.source_issue_number\) > 0 \? Number\(action\.source_issue_number\) : null,\n {6}appId: Number\(action\.app_id\) \|\| null, allowEmptier: true, deps,/);
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

// ── #6151: after filing, Homeroom bot builds it, and where it stands ──────
//
// Ear Trainer, 2 Nov 2026: the line said "Filed it as request #14 on Ear
// Trainer, under your name, with version 4 as its plan." and stopped;
// asked "will you build this now?" a few seconds later, the design bot said
// it could not, and Homeroom bot built #14 a minute after. The line now says
// what happens next, from the new request's track, in words the client says
// (messages bot.track.filed.*), and the design bot's prompt says where the
// request stands (tests/homeroom-bot-working.test.js pins its turn).

const TRACK_TSX = 'frontend/src/features/messages/bot-track.tsx';
const EAR = { id: 3, slug: 'ear', name: 'Ear Trainer', repo_url: 'https://github.com/usernode-bot/ear' };
// A request's track (homeroom-bot-track.js trackOf): its stored work state,
// waiting its turn unless `work` says otherwise.
const track = (work = {}, extra = {}) => ({
  key: 'ear#14', appSlug: 'ear', appName: 'Ear Trainer', issueNumber: 14,
  work: { stage: 'reading', why: null, reason: null, line: { code: 'queued', place: 1 }, since: null, ...work },
  step: null, waitingOn: null, busy: false, try: 1, ...extra,
});
const HELD_SLOTS = { line: { code: 'held_waiting' }, stage: 'building' };
// A person must decide: the bot handed it to the people on the project.
const DECIDE = { stage: 'waiting_for_you', why: 'decide', line: null };

// A design thread drawn from words, at version 4: no capture, so its plan is version 4 alone.
function filingPool() {
  return {
    async query(sql, params = []) {
      const text = String(sql);
      if (/FROM private_threads p\s+JOIN design_threads d/.test(text)) {
        return { rows: [{
          id: 7, root_message_id: 500, conversation_id: 41, state: 'open', result_ref: null, kind: 'idea',
          about_kind: null, about_number: null, slug: 'ear', name: 'Ear Trainer', title: 'Interval drill',
          surface: 'app', route: null, width: 390, height: 844,
        }] };
      }
      if (/SELECT version, author, note, message_id, created_at FROM design_versions/.test(text)) {
        return { rows: [1, 2, 3, 4].map((version) => ({ version, author: 'bot', note: null, message_id: null, created_at: new Date() })) };
      }
      if (/SELECT version, html FROM design_versions/.test(text)) return { rows: [{ version: params[1], html: '<main class="keys">Keys</main>' }] };
      return { rows: [] };
    },
  };
}

// New request on the plan card: fileRequest scripted to file #14 (queued
// unless `queued` is false: the bot is off for the project), and `newTrack`
// the track the new request reads (null: none).
async function fileDesign(newTrack, { queued = true } = {}) {
  const designs = require('../src/services/design-threads');
  const sent = [];
  const read = [];
  const filed = await designs.postDesignPlan(filingPool(), {}, {
    user: { id: 9, username: 'evan' }, rootId: 500,
    deps: {
      mayor: {
        findApp: async () => EAR, canView: async () => true, canFile: async () => true,
        fileRequest: async () => ({ issueNumber: 14, queueId: queued ? '61' : null }),
      },
      dm: { botAccount: async () => ({ id: 2 }), async sendDm(_pool, args) { sent.push(args); return { messageId: 901 }; } },
      requestSpecs: { prepareSpec: () => ({ ok: true }), postRequestSpec: async () => ({ version: 1, sessionId: 77 }) },
      homeroomBot: { readSettings: async () => ({ mode: 'live' }) },
      track: { async tracksForRequests(_pool, args) { read.push(args); return new Map(newTrack ? [[14, newTrack]] : []); } },
      domain: null,
    },
  });
  return { filed, sent, read };
}

test('#6151: filing a design says Homeroom bot reads it next and builds it from its version, from the new request\'s track', async () => {
  const { filedNextLine } = loadTsx(TRACK_TSX);
  const { filed, sent, read } = await fileDesign(track());
  assert.deepEqual([filed.ok, filed.state, filed.number, filed.version], [true, 'filed', 14, 4]);
  assert.deepEqual(read.map((args) => [args.appId, args.numbers]), [[3, [14]]], 'the new request\'s track, read once');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, 'Filed it as request #14 on Ear Trainer, under your name, with version 4 as its plan.');
  assert.deepEqual(sent[0].metadata, { kind: 'design_filed', appSlug: 'ear', appName: 'Ear Trainer', filedNext: { say: 'builds', version: 4 } },
    'codes, never words: the client says them');
  const line = `${sent[0].content} ${filedNextLine(sent[0].metadata.filedNext)}`;
  assert.equal(line, 'Filed it as request #14 on Ear Trainer, under your name, with version 4 as its plan. '
    + 'Homeroom bot reads it next and builds it from version 4. Its progress shows here and on the request.');
  assert.match(line, /reads it next and builds it from version 4\. Its progress shows here and on the request\.$/);
  // Planning or building already, it is still Homeroom bot's to build.
  for (const state of ['planning', 'building']) {
    assert.deepEqual((await fileDesign(track({ stage: state, line: null }, { step: state === 'planning' ? 'plan' : 'build' }))).sent[0].metadata.filedNext,
      { say: 'builds', version: 4 }, state);
  }
});

test('#6151: held at a limit, the filed line names the wait in the track\'s own words; off or a person\'s, who decides', async () => {
  const { filedNextLine } = loadTsx(TRACK_TSX);
  const held = await fileDesign(track(HELD_SLOTS, { step: 'build', held: { limit: 'slots', position: 2, until: null } }));
  assert.deepEqual(held.sent[0].metadata.filedNext, { say: 'held', limit: 'slots' });
  assert.equal(filedNextLine(held.sent[0].metadata.filedNext),
    'Homeroom bot builds it when one of its changes is voted in or closed: it is at its limit of changes up for a vote here. Its progress shows here and on the request.');
  // #6156: held for its turn among the project's builds.
  const turn = await fileDesign(track({ stage: 'building', line: { code: 'held_builds' } }, { step: 'build', held: { limit: 'builds', position: 1, until: null } }));
  assert.deepEqual(turn.sent[0].metadata.filedNext, { say: 'held', limit: 'builds' });
  // The track's own held lines (bot.track.line.held.*) are gone (5 Nov
  // 2026): a held track says its work state's line (lib/work-state.ts), and
  // the filed line keeps whole sentences of its own, one per limit.
  for (const limit of ['builds', 'slots', 'bot_wide', 'allowance']) {
    assert.match(filedNextLine({ say: 'held', limit }), /^Homeroom bot builds it .+: .+\. Its progress shows here and on the request\.$/, limit);
  }
  // The bot is off for the project: nothing queued it, and it has no track.
  const off = await fileDesign(null, { queued: false });
  assert.deepEqual(off.sent[0].metadata.filedNext, { say: 'person' });
  assert.equal(filedNextLine(off.sent[0].metadata.filedNext), 'This needs a person, not Homeroom bot: the people on the project decide who builds it.');
  // Queued, though the read found no track: it reads it next all the same.
  assert.deepEqual((await fileDesign(null)).sent[0].metadata.filedNext, { say: 'builds', version: 4 });
  const designs = require('../src/services/design-threads');
  assert.deepEqual(designs.filedNext(track(DECIDE, { step: 'plan' }), { version: 4 }), { say: 'person' });
  assert.deepEqual(designs.filedNext(track({ stage: 'building', line: { code: 'claimed', by: 'maya' } }, { step: 'build' }), { version: 4 }), { say: 'person' });
  assert.equal(designs.filedNext(track({ stage: 'up_for_vote', line: null }, { step: 'vote' }), { version: 4 }), null, 'a track that says none of these says nothing');
});

test('#6151: the design bot is told where a filed design\'s request stands; an unfiled one is not', async () => {
  const designBot = require('../src/services/design-bot');
  const base = { surface: 'app', app: { slug: 'ear', name: 'Ear Trainer' }, title: 'Interval drill', width: 390, height: 844 };
  const building = track({ stage: 'building', line: null }, { step: 'build', busy: true });
  const read = [];
  const deps = { track: { async tracksForRequests(_pool, args) { read.push(args); return new Map([[14, building]]); } } };
  const project = { id: 3, slug: 'ear', name: 'Ear Trainer' };
  // private_threads.state 'filed', result_ref 14: designFor's state and number.
  const filed = await designBot.filedOf({}, { design: { ...base, state: 'filed', number: 14 }, project, settings: { mode: 'live' }, deps });
  assert.deepEqual(read.map((args) => [args.appId, args.numbers]), [[3, [14]]]);
  assert.deepEqual(filed, { state: 'filed', number: 14, appName: 'Ear Trainer', track: building, live: true });
  const prompt = designBot.designPrompt({ username: 'evan', design: { ...base, state: 'filed', number: 14 }, version: 4, html: '<p>x</p>', filed });
  assert.match(prompt, /\nFILED: this design is request #14 on Ear Trainer\. Homeroom bot: building \(its next step: checks\)\.\n/);
  assert.match(prompt, /- Asked whether it will be built, or when: say Homeroom bot builds it from the plan and where it stands now\.\n {2}Never say it cannot be built or that someone else has to start it, unless the line above says a person must decide\./);
  assert.match(prompt, /- You never post, file or make anything yourself: when they say it looks good,/, 'its own role is as it was');
  assert.ok(prompt.indexOf('FILED:') < prompt.indexOf('THE CURRENT VERSION'));
  // Posted as the plan on a request, it is that request's.
  const posted = await designBot.filedOf({}, { design: { ...base, state: 'posted', number: 14 }, project, settings: { mode: 'live' }, deps });
  assert.match(designBot.filedLine(posted), /^FILED: this design is the plan on request #14 on Ear Trainer\./);
  // Not filed: no line, and nothing read.
  read.length = 0;
  assert.equal(await designBot.filedOf({}, { design: { ...base, state: 'open', number: null }, project, settings: { mode: 'live' }, deps }), null);
  assert.equal(await designBot.filedOf({}, { design: null, project, settings: { mode: 'live' }, deps }), null);
  assert.deepEqual(read, []);
  const open = designBot.designPrompt({ username: 'evan', design: { ...base, state: 'open' }, version: 4, html: '<p>x</p>' });
  assert.doesNotMatch(open, /FILED:/);
  assert.doesNotMatch(open, /Asked whether it will be built/);
  // Where a person must decide, the line says so, and only there.
  const line = (t, live = true) => designBot.filedLine({ state: 'filed', number: 14, appName: 'Ear Trainer', track: t, live });
  assert.match(line(null, false), /Homeroom bot does not build on this project now: a person must decide who builds it\.$/);
  assert.match(line(track(DECIDE, { step: 'plan' })), /a person must decide who builds it\.$/);
  assert.match(line(track()), /Homeroom bot: queued \(its next step: plan\)\.$/);
  assert.match(line(track(HELD_SLOTS, { step: 'build', held: { limit: 'slots', position: 2 } })),
    /Homeroom bot: held at a limit \(slots, number 2 in line\); it builds it once that frees\.$/);
  for (const t of [track(), building, track(HELD_SLOTS, { held: { limit: 'slots' } }), null]) {
    assert.doesNotMatch(line(t), /must decide/);
  }
  assert.equal(designBot.filedBuilds({ track: null, live: false }), false, 'off: a person decides');
  assert.equal(designBot.filedBuilds({ track: building, live: true }), true);
  assert.equal(designBot.filedBuilds({ track: track(DECIDE), live: true }), false);
  // Somebody took it on: a person, by name.
  const taken = track({ stage: 'building', line: { code: 'claimed', by: 'maya' } }, { step: 'build' });
  assert.match(line(taken), /Homeroom bot: @maya has taken it on: a person must decide who builds it\.$/);
  assert.equal(designBot.filedBuilds({ track: taken, live: true }), false);
  // Waiting on its requester's answer: said with what it waits for.
  assert.match(line(track({ stage: 'waiting_for_you', why: 'question', line: null }, { step: 'plan' })),
    /Homeroom bot: waiting for you, question \(its next step: build\)\.$/);
  assert.equal(designBot.filedBuilds({ track: track({ stage: 'live', line: null }, { step: 'live' }), live: true }), false, 'over');
});

// ── #6353: a plan is drawn without scripts, so a script-built screen is
//    caught before it is posted, and the card offers to write the rows in ──

const SCRIPTED_LISTS = '<main><h1>Homeroom bot</h1><ul id="rows"></ul></main>'
  + '<script>document.getElementById("rows").innerHTML = "<li>One</li><li>Two</li>";</script>';

// A design at version 4 whose screen is `html`.
function gapDesignPool(html) {
  return {
    async query(sql, params = []) {
      const text = String(sql);
      if (/FROM private_threads p\s+JOIN design_threads d/.test(text)) {
        return { rows: [{
          id: 7, root_message_id: 500, conversation_id: 41, state: 'open', result_ref: null, kind: 'idea',
          about_kind: null, about_number: null, slug: 'ear', name: 'Ear Trainer', title: 'Homeroom bot page',
          surface: 'app', route: null, width: 390, height: 844,
        }] };
      }
      if (/SELECT version, author, note, message_id, created_at FROM design_versions/.test(text)) {
        return { rows: [{ version: 4, author: 'bot', note: null, message_id: null, created_at: new Date() }] };
      }
      if (/SELECT version, html FROM design_versions/.test(text)) return { rows: [{ version: params[1], html }] };
      return { rows: [] };
    },
  };
}

async function postGap(html, { allowEmptier = false } = {}) {
  const designs = require('../src/services/design-threads');
  const posted = [];
  const result = await designs.postDesignPlan(gapDesignPool(html), {}, {
    user: { id: 9, username: 'evan' }, rootId: 500, issueNumber: 18, allowEmptier,
    deps: {
      mayor: { findApp: async () => EAR, canView: async () => true, canFile: async () => true },
      dm: { botAccount: async () => ({ id: 2 }), async sendDm() { return { messageId: 901 }; } },
      requestSpecs: {
        prepareSpec: () => ({ ok: true }),
        openRequest: async () => ({ ok: true, repo: { owner: 'usernode-bot', repo: 'ear' }, issue: { title: 'Homeroom bot page' } }),
        async postRequestSpec(_pool, args) { posted.push(args); return { version: 1, sessionId: 77 }; },
      },
      domain: null,
    },
  });
  return { result, posted };
}

test('planGap catches a script filling an empty list, and not rows already in the markup', () => {
  const designs = require('../src/services/design-threads');
  const gap = designs.planGap(SCRIPTED_LISTS);
  assert.equal(gap.kind, 'lists');
  assert.deepEqual(gap.empty, ['rows']);
  assert.equal(gap.reason, 'The plan would show its lists empty, because a script builds them.');
  assert.equal(designs.planGap(
    '<main><ul id="rows"><li>One</li></ul></main><script>document.getElementById("rows").textContent = "x";</script>'
  ), null, 'a target with rows in it is no gap');
  assert.equal(designs.planGap('<main><ul><li>One</li></ul></main>'), null, 'no script, no gap');
  assert.equal(designs.planGap(
    '<main><p>Hi</p></main><script>document.getElementById("rows").classList.add("open");</script>'
  ), null, 'a script that writes no page content is no gap');
  const screen = designs.planGap('<main><p>Hi</p></main><script>document.getElementById("x").innerHTML = '
    + '"Everything this screen shows is written by this script instead of the markup";</script>');
  assert.equal(screen.kind, 'screen');
  assert.equal(screen.reason, 'The plan would show this screen mostly empty, because a script writes its words.');
});

test('planReadout counts screens, lists, rows and empty lists as the plan draws them', () => {
  const designs = require('../src/services/design-threads');
  const plan = designs.planHtml({
    design: { width: 390, height: 844, title: 'List', route: null, surface: 'app' },
    title: 'List', notes: '', before: null,
    after: '<main><ul><li>One</li><li>Two</li></ul><ol></ol></main>', version: 2,
  });
  const screens = designs.planReadout(plan);
  assert.equal(screens.length, 1);
  assert.equal(screens[0].size, 'phone');
  const before = screens[0].sides.find((s) => s.side === 'before');
  const after = screens[0].sides.find((s) => s.side === 'after');
  assert.equal(before.text, 'List is not there yet.');
  assert.equal(after.lists, 2);
  assert.equal(after.rows, 2);
  assert.equal(after.emptyLists, 1);
  assert.match(after.text, /^One Two$/);
});

test('postDesignPlan refuses a plan a script would empty, and posts it when allowed', async () => {
  const refused = await postGap(SCRIPTED_LISTS);
  assert.equal(refused.result.ok, false);
  assert.equal(refused.result.status, 409);
  assert.equal(refused.result.code, 'plan_emptier');
  assert.equal(refused.result.gap.kind, 'lists');
  assert.match(refused.result.error, /^The plan would show its lists empty, because a script builds them\. Ask Homeroom bot to write them into the screen, then post it again\.$/);
  assert.deepEqual(refused.posted, [], 'nothing is filed');

  const posted = await postGap(SCRIPTED_LISTS, { allowEmptier: true });
  assert.equal(posted.result.ok, true);
  assert.equal(posted.result.planVersion, 1);
  assert.equal(posted.posted.length, 1, 'the plan posts when the card showed the warning');
  assert.match(posted.posted[0].text, /<ul id="rows"><\/ul>/, 'the plan keeps the empty list: that is what the warning is about');
  assert.doesNotMatch(posted.posted[0].text, /<script\b/, 'and drops the script, as every plan does');

  const clean = await postGap('<main><ul><li>One</li><li>Two</li></ul></main>');
  assert.equal(clean.result.ok, true, 'a plan with its rows in the markup posts as before');
});

test('the plan card warns that the lists would show empty, and offers to write the rows in first', async () => {
  const designs = require('../src/services/design-threads');
  const mayor = require('../src/services/homeroom-bot-mayor');
  const sent = [];
  const pool = {
    async query(sql) {
      if (/INSERT INTO bot_cards/.test(String(sql))) return { rows: [{ id: 5 }] };
      return { rows: [] };
    },
  };
  const design = { threadId: 7, rootId: 500, title: 'Homeroom bot page', latest: 4 };
  const offer = { kind: 'plan', app: EAR, issueNumber: 18, version: 4, gap: designs.planGap(SCRIPTED_LISTS) };
  await mayor.sendDesignOffer(pool, {
    bot: { id: 2 }, user: { id: 9 }, conversationId: 41, message: { id: 71 }, design, offer, key: 'k', text: '',
    deps: { dmSvc: { async sendDm(_pool, args) { sent.push(args); return { messageId: 902 }; } } },
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /The plan would show its lists empty, because a script builds them\. I can write the rows into the screen first\./);
  const actions = sent[0].metadata.actions;
  assert.deepEqual(actions[0], { id: 'fill', label: 'Write the rows in first', style: 'primary', type: 'prompt', quote: true });
  assert.deepEqual(actions[1], { id: 'yes', label: 'Post as a plan on #18', style: 'secondary', type: 'server' }, 'posting stays, as the way to post as it is');
  assert.deepEqual(actions[2], { id: 'no', label: 'Not yet', style: 'secondary', type: 'server' });
  assert.deepEqual(sent[0].metadata.answers, ['Post as a plan on #18', 'Not yet'], 'the answers are unchanged');
});

test('#6355: a card\'s sentence names only the request its button posts to', () => {
  const mayor = require('../src/services/homeroom-bot-mayor');
  const F = 'Tap the card to post version 4 on request #6351 as its plan, publicly, under your name.';
  // The model's own words named another request: they are dropped whole.
  assert.equal(mayor.cardSentence('Tap the card to post version 4 on request #6355 as its plan.', { issueNumber: 6351, fallback: F }), F);
  // Its own request, as "#N" or "request N", is kept as written.
  const good = 'Tap the card to post version 4 on request #6351 as its plan.';
  assert.equal(mayor.cardSentence(good, { issueNumber: 6351, fallback: F }), good);
  assert.equal(mayor.cardSentence('Tap the card to post version 4 on request 6351.', { issueNumber: 6351, fallback: F }),
    'Tap the card to post version 4 on request 6351.');
  // A paragraph keeps the sentences that pass and drops the others.
  assert.equal(mayor.cardSentence('Here is the design. Tap the card to post it on request 12.', { issueNumber: 6351, fallback: F }),
    'Here is the design.');
  assert.equal(mayor.cardSentence('A plan on #12. A plan on #6351.', { issueNumber: 6351, fallback: F }), 'A plan on #6351.');
  // A new-request card has no number yet, so a sentence naming one is dropped.
  assert.equal(mayor.cardSentence('Tap New request to file one on #6351.', { issueNumber: null, fallback: F }), F);
  assert.equal(mayor.cardSentence('Tap New request to file one.', { issueNumber: null, fallback: F }), 'Tap New request to file one.');
  // A version is not a request: it stays as the bot wrote it.
  assert.equal(mayor.cardSentence('Version 4 is ready.', { issueNumber: 6351, fallback: F }), 'Version 4 is ready.');
  // Nothing left, or nothing said: the fixed line.
  assert.equal(mayor.cardSentence('Tap it on request #12.', { issueNumber: 6351, fallback: F }), F);
  assert.equal(mayor.cardSentence('', { issueNumber: 6351, fallback: F }), F);
  const src = read('src/services/homeroom-bot-mayor.js');
  assert.match(src, /cardSentence\(text, \{ issueNumber: n, fallback \}\)/, 'the plan card\'s first line is checked');
  assert.match(src, /cardSentence\(text, \{ issueNumber: null, fallback: `Want to make \$\{o\.name\} from this design\?` \}\)/);
  assert.match(src, /Tap the card to post version \$\{v\} on request #\$\{n\} as its plan, publicly, under your name\./);
  assert.match(src, /Tap New request to file a request on \$\{name\} with version \$\{v\} as its plan/);
});

test('#6355: a version line says "Version N:" once, and the note does not repeat it', () => {
  const designs = require('../src/services/design-threads');
  assert.equal(designs.bareNote('Version 5: rows in the markup'), 'rows in the markup');
  assert.equal(designs.bareNote('Version 5: Version 5: rows in the markup'), 'rows in the markup');
  assert.equal(designs.bareNote('version 4 - rows in the markup'), 'rows in the markup');
  assert.equal(designs.bareNote('rows in the markup'), 'rows in the markup');
  assert.equal(designs.versionLine(5, 'Version 5: rows in the markup, no script'), 'Version 5: rows in the markup, no script.');
  assert.equal(designs.versionLine(5, 'Version 5: Version 5: x'), 'Version 5: x.');
  assert.equal(designs.versionLine(5, 'version 4 - x; Version 4: y'), 'Version 5: x; y.');
  assert.equal(designs.versionLine(3, 'Version 3:'), 'Version 3.');
  assert.equal(designs.versionLine(3, 'Version 3: A green Save button.'), 'Version 3: A green Save button.');
  const src = read('src/services/design-bot.js');
  assert.doesNotMatch(src, /it names the version/);
  assert.match(src, /What it is, in a few plain words\. Leave out the version number: the thread adds it\./);
  assert.match(src, /What changed, in a few plain words\. Leave out the version number: the thread adds it\./);
  assert.match(src, /notes\.push\(threads\.bareNote\(screen\.note\)\)/, 'a written screen\'s note is stored bare');
  assert.match(src, /notes\.push\(threads\.bareNote\(clip\(args\.note, 120\)\)\)/, 'an edit\'s note is stored bare');
});
