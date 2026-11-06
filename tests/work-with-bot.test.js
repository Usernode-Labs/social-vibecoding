'use strict';

// Threads, one loop (phase B, 1 Nov 2026): "Work on this with Homeroom bot"
// replaces "Build it now" as a request's one action; Build it now moves into
// the ⋯ as "Build it in an agent session"; a change gets a quiet version of
// the button; and while the bot waits for the requester's plan the request
// says so, with "Let the bot build it now". The server half is pinned in
// tests/private-thread-about-postgres.test.js, the sent screen's in
// tests/feedback-first-ui.test.js.
//
// app-view.js is a plain browser script, loaded into a vm sandbox as
// tests/issue-inprogress-render.test.js loads it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const SRC = read('public/js/app-view.js');

function makeAppView() {
  const fetches = [];
  const toasts = [];
  const refreshed = [];
  const sandbox = {
    console,
    relTime: () => ({ text: 'just now', title: '' }),
    App: { user: { id: 42, username: 'me' }, switchTab: () => {} },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {}, createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    location: { hash: '#app/demo/dev/issues/3' },
    PlatformUI: { toast: (text) => toasts.push(text) },
    fetch: async (url, options) => {
      fetches.push({ url, options });
      return sandbox.answer(url, options);
    },
    answer: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  require('./lib/repo-link').installRepoLink(sandbox);
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  AppView._ghIssuesMeta = { myRemaining: 5 };
  AppView._govProposals = [];
  AppView.appData = { slug: 'demo', can_collaborate: true };
  AppView.refreshDevData = (what) => refreshed.push(what);
  return { AppView, sandbox, fetches, toasts, refreshed };
}

const baseIssue = (over) => ({
  number: 3, title: 'Dark mode', body: '', htmlUrl: 'https://github.com/o/r/issues/3', state: 'open',
  bounty_count: 0, my_bounty: false, created_by_username: 'me',
  headless: null, in_progress: null, myPrSessionId: null, bot: null, botAwaits: null, botHold: null,
  chatCount: 0, lastMessageAt: null, title_fallback: false, priority: null, assignee: null, category: null,
  ...over,
});
const plain = (x) => JSON.parse(JSON.stringify(x));

test('a request nobody is building: Work on this with Homeroom bot, and the agent session in its ⋯', () => {
  const { AppView } = makeAppView();
  const status = plain(AppView._requestStatusView(baseIssue()));
  assert.deepEqual(status.action, {
    label: 'Work on this with Homeroom bot',
    title: 'Talk it through and plan it with Homeroom bot, in a thread only you can see',
    disabled: false,
    act: { fn: 'workOnIssueWithBot', args: [3] },
  });
  assert.equal(status.agentSession, true, 'the page\'s ⋯ offers Build it in an agent session');
  assert.equal(status.lead, 'Nobody is working on this yet.');
  // The page's own ⋯ lists it beside Build it with your own Claude Code
  // (request-head.tsx), so the card menu it shares does not list it twice.
  const pageRows = AppView._requestMenuItems(baseIssue()).map((row) => row.label);
  assert.ok(!pageRows.includes('Build it in an agent session'));
  const cardRows = AppView._issueMenuItems(baseIssue(), { progressOnFace: true }).map((row) => row.label);
  assert.equal(cardRows[0], 'Build it in an agent session', 'the board card\'s ⋯ leads with it');
  // The other primary states stay: Continue work, the bot on it, a change waiting.
  assert.equal(AppView._requestStatusView(baseIssue({ myPrSessionId: 9 })).action.label, 'Continue your work');
  assert.equal(AppView._requestStatusView(baseIssue({ myPrSessionId: 9 })).agentSession, false);
  const botOn = AppView._requestStatusView(baseIssue({ bot: { what: 'building', since: null, askedBy: 'me', mine: true } }));
  // #6401: the progress card under this one already says where the bot is,
  // so the page offers no button that scrolls to it.
  assert.equal(botOn.action, null);
  assert.equal(botOn.agentSession, false);
  // The Workshop list keeps it (its page is not the one the press lands on).
  assert.equal(plain(AppView._issuePrimaryActionSpec(
    baseIssue({ bot: { what: 'building', since: null, askedBy: 'me', mine: true } }),
  )).label, 'See progress');
  // The progress card drawn (the track): still no action on the page.
  const tracked = plain(AppView._requestStatusView(baseIssue({
    bot: { what: 'reading', since: null, askedBy: 'me', mine: true },
    track: { work: { stage: 'reading' } },
  })));
  assert.equal(tracked.action, null, 'no See progress while the progress card is drawn');
  assert.equal(tracked.agentSession, false);
  // #6210 (3 Nov 2026): her own plan waits for her: "you", and the plan
  // with its Build it is right under this card, so the card has no button.
  const planMine = plain(AppView._requestStatusView(baseIssue({ bot: { what: 'reading', plan: true, since: null, askedBy: 'me', mine: true } })));
  assert.equal(planMine.lead, 'Your plan is ready. Build it is on the plan below.');
  assert.doesNotMatch(planMine.lead, /@me/);
  assert.equal(planMine.action, null, 'the plan card under it is the one Build it');
  const planTheirs = plain(AppView._requestStatusView(baseIssue({ bot: { what: 'reading', plan: true, since: null, askedBy: 'ada', mine: false } })));
  assert.equal(planTheirs.lead, '@ada\'s plan is ready. Any member can build it below.', 'anyone else is told any member may build it');
  AppView._ghIssuesMeta = { myRemaining: 5, homeroomBot: { typicalMinutes: 8 } };
  assert.equal(AppView._requestStatusView(baseIssue()).action.label, 'Ask Homeroom bot to build this', 'where the bot builds, its door stays');
});

// #6375: queued but held until later, its queue row is no `bot` (its read
// keeps unheld rows only), so the status card read "Nobody is working on
// this yet." with Ask over the track card's "On hold until …". The stored
// work state (the track) says it now, with nothing offered and no spinner.
test('a request the bot holds until later says so, offers no Ask and does not spin', () => {
  const { AppView } = makeAppView();
  AppView._ghIssuesMeta = { myRemaining: 5, homeroomBot: { typicalMinutes: 8 } };
  const track = { work: { stage: 'reading', why: null, reason: null, line: { code: 'on_hold' } }, held: { limit: 'allowance', position: null, until: '2026-11-09T01:00:00.000Z' } };
  const held = plain(AppView._requestStatusView(baseIssue({ track })));
  assert.equal(held.lead, message('core:work.line.onHold'), 'the stored line\'s own words');
  assert.doesNotMatch(held.lead, /Nobody/);
  assert.equal(held.action, null, 'no Ask Homeroom bot to build this');
  assert.equal(held.botSays, true);
  assert.equal(held.ownAgent, false);
  assert.equal(held.agentSession, false);
  assert.equal(AppView._issueWorkState(baseIssue({ track })), null, 'no bot state, so no working spinner');
  // A hold whose line has no words here says until when, and nothing more.
  const other = plain(AppView._requestStatusView(baseIssue({ track: { ...track, work: { ...track.work, line: { code: 'later' } } } })));
  assert.match(other.lead, /^Homeroom bot has this on hold until Nov 9\.$/);
  assert.equal(other.action, null);
  // Queued and not held: as before, and it spins.
  const queued = baseIssue({ bot: { what: 'queued', since: null } });
  assert.equal(AppView._requestStatusView(queued).lead, message('changes:request.status.lead.botQueued'));
  assert.equal(AppView._issueWorkState(queued).spinner, true);
  // Nobody on it, and a track that holds nothing: Nobody, with Ask.
  for (const issue of [baseIssue(), baseIssue({ track: { work: { stage: 'reading', line: { code: 'queued' } } } })]) {
    const nobody = AppView._requestStatusView(issue);
    assert.equal(nobody.lead, 'Nobody is working on this yet.');
    assert.equal(nobody.action.label, 'Ask Homeroom bot to build this');
  }
  // A person in review still wins over the hold.
  const review = AppView._requestStatusView(baseIssue({ track, in_progress: { sessions: [{ sessionId: 5, username: 'ada', status: 'promoted' }] } }));
  assert.equal(review.lead, 'ada’s change for this is waiting for approval.');
});

test('while the bot waits for her plan, the request says so, with Let the bot build it now', () => {
  const { AppView } = makeAppView();
  const held = baseIssue({ botHold: { rootId: 77, href: '#homeroom-bot/thread/77' } });
  const status = plain(AppView._requestStatusView(held));
  assert.equal(status.lead, 'Homeroom bot is waiting for your plan.');
  assert.equal(message('changes:request.status.lead.botWaitsPlan'), 'Homeroom bot is waiting for your plan.');
  assert.deepEqual(status.action, {
    label: 'Let the bot build it now',
    title: 'Homeroom bot starts on it without waiting for your plan',
    disabled: false,
    act: { fn: 'letBotBuildNow', args: [3] },
  });
  assert.equal(status.botSays, true, 'no "Plan v1 is ready" after it');
  assert.equal(status.agentSession, false);
  assert.equal(AppView._issuePrimaryActionSpec(held).act.fn, 'letBotBuildNow', 'the board card says the same');
  // Queued for a builder is still waiting for her; reading or building is not.
  assert.equal(AppView._planHeld({ ...held, bot: { what: 'queued', since: null } }), true);
  assert.equal(AppView._planHeld({ ...held, bot: { what: 'reading', since: null } }), false);
  assert.equal(AppView._planHeld({ ...held, state: 'closed' }), false);
  assert.equal(AppView._planHeld(baseIssue()), false);
});

test('the request page\'s button opens the thread on the bot tab; Let the bot build it now lifts the hold', async () => {
  const { AppView, sandbox, fetches, toasts, refreshed } = makeAppView();
  sandbox.answer = async () => ({ ok: true, json: async () => ({ rootId: 77, href: '#homeroom-bot/thread/77', holds: true }) });
  await AppView.workOnIssueWithBot(3);
  assert.equal(fetches[0].url, '/api/apps/demo/threads/3/private');
  assert.equal(fetches[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(fetches[0].options.body), { kind: 'request' });
  assert.equal(sandbox.location.hash, '#homeroom-bot/thread/77');
  assert.deepEqual(refreshed, ['issue'], 'her page says the bot waits once she is back');
  // A refusal says why, and goes nowhere.
  sandbox.location.hash = '#app/demo/dev/issues/3';
  sandbox.answer = async () => ({ ok: false, status: 404, json: async () => ({ error: 'demo has no request #3.' }) });
  await AppView.workOnIssueWithBot(3);
  assert.equal(sandbox.location.hash, '#app/demo/dev/issues/3');
  assert.deepEqual(toasts, ['demo has no request #3.']);
  // An answer that is no bot-tab address is not followed.
  sandbox.answer = async () => ({ ok: true, json: async () => ({ href: 'https://elsewhere.example/' }) });
  await AppView.workOnIssueWithBot(3);
  assert.equal(sandbox.location.hash, '#app/demo/dev/issues/3');
  assert.equal(toasts[1], 'The thread with Homeroom bot could not be started just now. Try again in a minute.');

  sandbox.answer = async () => ({ ok: true, json: async () => ({ ok: true, lifted: 1 }) });
  await AppView.letBotBuildNow(3);
  assert.equal(fetches.at(-1).url, '/api/apps/demo/issues/3/bot-go');
  assert.equal(fetches.at(-1).options.method, 'POST');
  assert.equal(toasts.at(-1), 'Homeroom bot no longer waits for your plan.');
  assert.deepEqual(refreshed, ['issue', 'issue']);
});

test('lib/thread-about.ts starts the thread and opens the bot tab at it', async () => {
  const calls = [];
  const toasts = [];
  globalThis.window = { location: { hash: '#app/x/dev/changes/406' }, PlatformUI: { toast: (s) => toasts.push(s) } };
  let answer = { ok: true, status: 200, body: { rootId: 12, href: '#homeroom-bot/thread/12', holds: false } };
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return { ok: answer.ok, status: answer.status, json: async () => answer.body }; };
  try {
    const { startThreadAbout, openThreadAbout } = loadTsx('frontend/src/lib/thread-about.ts');
    assert.deepEqual(await startThreadAbout('x', 406, 'change'), { rootId: 12, href: '#homeroom-bot/thread/12', holds: false });
    assert.equal(calls[0].url, '/api/apps/x/threads/406/private');
    assert.deepEqual(JSON.parse(calls[0].options.body), { kind: 'change' });
    const after = [];
    assert.equal(await openThreadAbout('x', 406, 'change', { failed: 'nope', after: () => after.push(window.location.hash) }), true);
    assert.equal(window.location.hash, '#homeroom-bot/thread/12');
    assert.deepEqual(after, ['#homeroom-bot/thread/12'], 'a dialog closes once the address is written');
    answer = { ok: false, status: 404, body: { error: 'x has no change #406.' } };
    await assert.rejects(startThreadAbout('x', 406, 'change'), /x has no change #406\./);
    assert.equal(await openThreadAbout('x', 406, 'change', { failed: 'nope' }), false);
    assert.deepEqual(toasts, ['nope']);
    answer = { ok: true, status: 200, body: { rootId: 12, href: 'javascript:alert(1)' } };
    await assert.rejects(startThreadAbout('x', 406, 'change'));
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
  }
});

test('a change gets the quiet version: under its cards, on its request\'s page and on its own', () => {
  const mod = loadTsx('frontend/src/features/dev-board/topic/work-with-bot.tsx');
  globalThis.window = { App: { user: { id: 1 } }, AppView: { readOnly: false } };
  try {
    // #6392 (6 Nov 2026): it says what it does, not "Work on this", which
    // read as starting work the bot had already started.
    const html = renderToHtml(createElement(mod.WorkWithBotButton, { slug: 'x', number: 406 }));
    assert.match(html, /^<div class="mt-2" data-work-with-bot="406"><button[^>]*class="[^"]*rounded-full bg-zinc-100[^"]*"[^>]*>Ask Homeroom bot privately<\/button><\/div>$/,
      'a neutral pill, never the accent');
    assert.match(html, /title="Ask Homeroom bot about this change in a thread only you can see"/);
    // Up for a vote, what it offers is a revision of the change.
    const voting = renderToHtml(createElement(mod.WorkWithBotButton, { slug: 'x', number: 406, voting: true }));
    assert.match(voting, />Suggest a change privately</);
    assert.match(voting, /title="Sketch a revision of this change with Homeroom bot, in a thread only you can see"/);
    // While the bot builds or fixes it, the Testing card and the thread
    // already say so: no button at all.
    assert.equal(renderToHtml(createElement(mod.WorkWithBotButton, { slug: 'x', number: 406, botAtWork: true })), '',
      'the bot is on it');
    assert.equal(renderToHtml(createElement(mod.WorkWithBotButton, { slug: 'x', number: 406, voting: true, botAtWork: true })), '',
      'and a change being fixed is not asking for a revision either');
    assert.equal(renderToHtml(createElement(mod.WorkWithBotButton, { slug: 'x', number: null })), '', 'a change with no number yet');
    window.AppView.readOnly = true;
    assert.equal(renderToHtml(createElement(mod.WorkWithBotButton, { slug: 'x', number: 406 })), '', 'nor on a board they cannot act on');
    window.App.user = null;
    window.AppView.readOnly = false;
    assert.equal(renderToHtml(createElement(mod.WorkWithBotButton, { slug: 'x', number: 406 })), '', 'nor signed out');
  } finally {
    delete globalThis.window;
  }
  const changes = read('frontend/src/features/dev-board/topic/thread-changes.tsx');
  // One page per thread: under the change's section, after its body (its
  // summary, before and after, Votes and Testing cards); not inside a
  // ballot's fold, where the ballot is what asks something. #6392: its vote
  // lines pick the words, and the bot building or fixing it leaves it out.
  assert.match(changes, /<ChangeBody item=\{item\} view=\{view\} plan=\{plan\} request=\{request\} \/>\s*\{\/\*[^*]*\*\/\}\s*<WorkWithBotButton\s+slug=\{pageSlug\(\)\}\s+number=\{item\.number\}\s+voting=\{!!view\?\.v\.votes\.facts\?\.length\}\s+botAtWork=\{changeBotAtWork\(item, view\)\}\s*\/>/);
  // `botAtWork` is the bot still building it, or fixing or about to fix its
  // failing checks; a fix it handed back, stopped or found to be the
  // platform's is not the bot at work.
  assert.match(changes, /function changeBotAtWork\(item: ThreadItem, view: ChangeView \| null\): boolean \{\s*if \(item\.byBot && item\.state === 'underway' && !item\.ready\) return true;\s*const fix = view\?\.v\.testing\.botFix;\s*return fix === 'fixing' \|\| fix === 'queued';\s*\}/);
  const page = read('frontend/src/features/dev-board/topic/change-head.tsx');
  assert.match(page, /\{v\.shots \? <ShotsCard s=\{v\.shots\} \/> : null\}\s*\{\/\*[^*]*\*\/\}\s*<WorkWithBotButton\s+slug=\{pageSlug\(\)\}\s+number=\{v\.number\}\s+voting=\{!!v\.votes\.facts\?\.length\}\s+botAtWork=\{v\.testing\.botFix === 'fixing' \|\| v\.testing\.botFix === 'queued'\}\s*\/>/,
    'the last of the change page\'s root post, under its cards, with the same two signals');
});

test('the bot tab says Waiting for you to OK the plan', () => {
  // 5 Nov 2026 (docs/plans/bot-one-model.md, step 3): in its stage's own
  // words (lib/work-state.ts), the same on every screen.
  const model = loadTsx('frontend/src/features/ai/model.ts');
  const t = {
    group: 'needs', app: { slug: 'x', name: 'Plant Pal' }, number: 18, title: 'Dark mode',
    work: { stage: 'waiting_for_you', why: 'plan', reason: null, line: null, since: null },
  };
  const words = model.nextWords(t);
  assert.equal(words.id, 'messages:ai.row.stage');
  assert.equal(words.nested.stage.id, 'core:work.why.plan');
  assert.equal(model.shortWords(t).id, 'core:work.why.plan');
  assert.equal(message('messages:ai.row.stage', { project: 'Plant Pal', number: 18, stage: message('core:work.why.plan') }),
    'Plant Pal · #18 · Waiting for you to OK the plan');
});
