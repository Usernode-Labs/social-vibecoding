'use strict';

// Task 2148: Stop, in a person's chat with Homeroom bot
// (src/services/homeroom-bot-stop.js). A tester sent the wrong prompt and
// could only wait. Pinned here, without a database:
//
//   1. The one line a stopped turn says, from what it had already done.
//   2. Which tool calls leave something that stays, and that every tool the
//      chat and the design bot offer is one this module knows.
//   3. How a running answer hears of a Stop: by reading the mark, as the
//      try begins and as it runs, with nothing kept in the process.
//   4. Where a turn looks: before each model request and each tool call (the
//      turn engine), and a request in flight is cut off, never asked again
//      (askModel).
//
// The machine's part is in tests/workflow-bot-replies-postgres.test.js, the
// turn, the work and the route in tests/homeroom-bot-stop-postgres.test.js,
// and the button in tests/messages-bot-stop.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const botStop = require('../src/services/homeroom-bot-stop');
const engine = require('../src/services/homeroom-bot-turn-engine');
const mayor = require('../src/services/homeroom-bot-mayor');
const designBot = require('../src/services/design-bot');
const threadTools = require('../src/services/homeroom-bot-thread-tools');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── 1. The line ──────────────────────────────────────────────────────────

test('a stopped turn says one line: what it had already done stays done, or nothing was', () => {
  assert.equal(botStop.stoppedText([]), 'Stopped. Nothing was filed or changed.');
  assert.equal(botStop.NOTHING_TEXT, 'Stopped. Nothing was filed or changed.');
  // One thing, named, with how it stays.
  assert.equal(
    botStop.stoppedText([{ did: 'filed your report as request #12', stays: 'it stays filed' }]),
    'Stopped. I had already filed your report as request #12; it stays filed.',
  );
  // Two, both named.
  assert.equal(
    botStop.stoppedText([
      { did: 'started work on request #7', stays: 'it carries on' },
      { did: 'marked this thread done', stays: 'it stays done' },
    ]),
    'Stopped. I had already started work on request #7 and marked this thread done; both stay as they are.',
  );
  // More than two: two named, and more.
  assert.equal(
    botStop.stoppedText([
      { did: 'started work on request #7', stays: 'it carries on' },
      { did: 'marked this thread done', stays: 'it stays done' },
      { did: 'withdrawn the Seed swap proposal', stays: 'it stays withdrawn' },
    ]),
    'Stopped. I had already started work on request #7, marked this thread done and more; all of it stays as it is.',
  );
  // Something it cannot name beside something it can.
  assert.equal(
    botStop.stoppedText([{ did: 'marked this thread done', stays: 'it stays done' }, { unsure: true }]),
    'Stopped. I had already marked this thread done and more; all of it stays as it is.',
  );
  // No record of what it did, or only a tool whose effect is not known here:
  // it names nothing and rules nothing out.
  assert.equal(botStop.stoppedText(null), 'Stopped. Anything I had already done stays done.');
  assert.equal(botStop.stoppedText(undefined), botStop.UNSURE_TEXT);
  assert.equal(botStop.stoppedText([{ unsure: true }]), botStop.UNSURE_TEXT);
  // Product copy: no em dash, and it never says anything was undone.
  for (const text of [botStop.NOTHING_TEXT, botStop.UNSURE_TEXT]) {
    assert.doesNotMatch(text, /—/);
    assert.doesNotMatch(text, /undone|undid|cancel/i);
  }
});

// ── 2. What a tool call leaves ───────────────────────────────────────────

test('a tool call is noted only when it left something that stays, in plain words, once', () => {
  const did = [];
  const note = (tool, args, result) => botStop.noteDone(did, tool, args, result);
  // A read, an offer and a reply leave nothing: an offer's card goes out
  // with the reply, which a stopped turn never sends.
  note('my_work', {}, { requests: [] });
  note('get_request', { number: 3 }, { text: 'x' });
  note('list_bench_runs', {}, { runs: [] });
  note('offer_request', { title: 'Dark mode' }, { ok: true });
  note('comment_on_request', { number: 3 }, { ok: true, drafted: 'x' });
  note('reply', { text: 'hi' }, { ok: true });
  // A screen drawn is saved only with the design turn's answer.
  note('write_screen', { html: '<p>x</p>' }, { ok: true });
  note('draw_screen', { what: 'a list' }, { ok: true });
  assert.deepEqual(did, []);
  // A call that was refused did nothing.
  note('start_request', { project: 'seed-swap', number: 7 }, { ok: false, error: 'Nothing was started.' });
  note('close_thread', {}, { ok: false, error: 'No such thread.' });
  // One that only found what already stood did nothing new.
  note('start_request', { project: 'seed-swap', number: 7 }, { ok: true, already: 'You are on it now.' });
  note('report_problem', {}, { ok: true, repeat: true, number: 40 });
  // A proposal's withdrawal offered, not done.
  note('withdraw_proposal', {}, { ok: true, proposal: { projectName: 'Seed swap' }, shown: 'They see it under your reply.' });
  // A revision drafted for them to post, not posted.
  note('revise_proposal', {}, { ok: true, drafted: 'x', shown: 'y' });
  assert.deepEqual(did, []);

  note('start_request', { project: 'seed-swap', number: 7 }, { ok: true, queued: 'At the front of your queue.' });
  assert.deepEqual(did, [{ did: 'started work on request #7', stays: 'it carries on' }]);
  // Said once, however often it was called.
  note('start_request', { project: 'seed-swap', number: 7 }, { ok: true, queued: 'At the front of your queue.' });
  assert.equal(did.length, 1);

  const each = (tool, args, result) => botStop.noteDone([], tool, args, result)[0];
  assert.deepEqual(each('report_problem', {}, { ok: true, number: 12 }), { did: 'filed your report as request #12', stays: 'it stays filed' });
  assert.deepEqual(each('report_problem', {}, { ok: true, number: null }), { did: 'sent your report to the Homeroom team', stays: 'it stays sent' });
  assert.deepEqual(each('withdraw_proposal', {}, { ok: true, withdrawn: { projectName: 'Seed swap' } }),
    { did: 'withdrawn the Seed swap proposal', stays: 'it stays withdrawn' });
  assert.deepEqual(each('revise_proposal', {}, { ok: true, posted: 'in the discussion' }),
    { did: 'posted your change on the proposal\'s discussion', stays: 'it stays posted' });
  assert.deepEqual(each('close_thread', {}, { ok: true, state: 'done' }), { did: 'marked this thread done', stays: 'it stays done' });
  assert.deepEqual(each('add_to_build', { number: 9 }, { ok: true }), { did: 'passed your note on to the build of request #9', stays: 'it stays with the build' });
  assert.deepEqual(each('tell_me_when', {}, { ok: true, promise: 'x' }), { did: 'noted to tell you when that is ready', stays: 'I still will' });
  assert.deepEqual(each('work_through', {}, { ok: true, readingNow: 'Queued: #3' }), { did: 'queued those requests to be read again', stays: 'they stay queued' });
  assert.equal(each('work_through', {}, { ok: true }), undefined, 'a table of requests that queued nothing left nothing');
  // A helper still reading the code is another turn, and ends by itself.
  assert.deepEqual(each('look_into', {}, { ok: true, running: true, project: 'Seed swap' }), { did: 'sent a helper to look into Seed swap', stays: 'it finishes on its own' });
  assert.equal(each('look_into', {}, { ok: true, summary: 'It sorts by date.' }), undefined, 'a look that finished is a read');
  assert.deepEqual(each('make_pictures', {}, { ok: true }), { did: 'made the pictures you asked for', stays: 'they are not shown here' });

  // A tool this module does not know: its effect cannot be named, and cannot
  // be ruled out, so the line says neither "nothing" nor what.
  assert.deepEqual(botStop.noteDone([], 'launch_bench_run', {}, { ok: true }), [{ unsure: true }]);
  assert.equal(botStop.stoppedText(botStop.noteDone([], 'launch_bench_run', {}, { ok: true })), botStop.UNSURE_TEXT);
  // Never throws on a result it cannot read.
  assert.deepEqual(botStop.noteDone([], 'start_request', null, null), []);
});

test('every tool the chat, its thread tools and the design bot offer is one whose effect is known', () => {
  const names = new Set([
    ...mayor.TOOLS.map((t) => t.function.name),
    ...mayor.PLATFORM_TOOLS,
    ...designBot.TOOLS.map((t) => t.function.name),
  ]);
  // The thread tools, as a person's own chat is offered them (the admin's
  // own are behind confirm cards and are left as not known: see below).
  const ctx = {
    user: { id: 1, username: 'ada', isAdmin: false }, settings: { mode: 'live' }, config: {}, deps: { threadRootId: 5 },
    conversationId: 1, messageId: 1, userText: '',
  };
  for (const [name, load] of threadTools.MODULES) {
    if (name === 'admin') continue;
    for (const tool of load().tools(ctx) || []) names.add(tool.function.name);
  }
  assert.ok(names.size > 40, 'the tools were listed');
  const unknown = [...names].filter((name) => !botStop.knows(name));
  assert.deepEqual(unknown, [],
    'a new tool says here what a Stop after it leaves: add it to LASTING (it leaves something) or NOTHING (it does not) in homeroom-bot-stop.js');
  // The ones that leave something are each the bot's own tools.
  for (const name of Object.keys(botStop.LASTING)) {
    assert.ok(names.has(name), `${name} is a tool the bot has`);
    assert.equal(botStop.NOTHING.has(name), false, `${name} is listed once`);
  }
  // An admin tool that is not a read is not known, by design: the line then
  // says "Anything I had already done stays done."
  assert.equal(botStop.knows('list_bot_configs'), true);
  assert.equal(botStop.knows('save_bot_config'), false);
});

// ── 3. Hearing a Stop ────────────────────────────────────────────────────

const tick = (ms = 5) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('a running answer hears a Stop by reading the mark: before it starts, and as it runs', async () => {
  // Stopped before this try began.
  const before = await botStop.watch({ asked: async () => true, everyMs: 60_000 });
  assert.equal(before.signal.aborted, true);
  assert.equal(botStop.isStop(before.signal.reason), true);
  before.end();

  let marked = false;
  let reads = 0;
  const stop = await botStop.watch({ asked: async () => { reads += 1; return marked; }, everyMs: 20 });
  try {
    assert.equal(reads, 1, 'the mark is read once as the watch begins');
    assert.equal(stop.signal.aborted, false);
    marked = true;
    for (let i = 0; i < 100 && !stop.signal.aborted; i += 1) await tick();
    assert.equal(stop.signal.aborted, true, 'the next read finds the mark');
    const seen = reads;
    await tick(60);
    assert.equal(reads, seen, 'and nothing is read after it');
  } finally {
    stop.end();
  }
  // A read that fails is asked again, never taken as a Stop.
  let failing = true;
  const flaky = await botStop.watch({ asked: async () => { if (failing) throw new Error('down'); return true; }, everyMs: 20 });
  try {
    assert.equal(flaky.signal.aborted, false);
    failing = false;
    for (let i = 0; i < 100 && !flaky.signal.aborted; i += 1) await tick();
    assert.equal(flaky.signal.aborted, true);
  } finally {
    flaky.end();
  }
  // Once the answer ended nothing is read again.
  let after = 0;
  const ended = await botStop.watch({ asked: async () => { after += 1; return false; }, everyMs: 20 });
  ended.end();
  await tick(80);
  assert.equal(after, 1);
  assert.equal(botStop.STOP_POLL_MS, 1000, 'a Stop reaches the turn within a second, in whichever process it runs');
  // Nothing is kept between calls: no list of the answers running in this
  // process, which a restart would lose and another process never had.
  const src = read('src/services/homeroom-bot-stop.js');
  assert.doesNotMatch(src, /new (?:Map|Set|WeakMap)\(\)/);
  assert.equal('stopNow' in botStop, false);
});

test('what the answer did is kept as it is done, and an earlier try\'s is carried on', async () => {
  const kept = [];
  const stop = await botStop.watch({
    asked: async () => false, everyMs: 60_000,
    kept: [{ did: 'started work on request #7', stays: 'it carries on' }],
    onNote: async (now) => { kept.push(JSON.parse(JSON.stringify(now))); },
  });
  try {
    await stop.note('my_work', {}, { requests: [] });
    assert.equal(kept.length, 0, 'a read keeps nothing');
    await stop.note('close_thread', {}, { ok: true });
    assert.equal(kept.length, 1);
    await stop.add({ did: 'opened a thread for the screen', stays: 'it stays open' });
    await stop.add({ did: 'opened a thread for the screen', stays: 'it stays open' });
    assert.equal(kept.length, 2, 'said once');
    assert.deepEqual(stop.did.map((d) => d.did),
      ['started work on request #7', 'marked this thread done', 'opened a thread for the screen']);
    assert.deepEqual(kept[1], stop.did);
  } finally {
    stop.end();
  }
  // A checkpoint that cannot be written never fails the tool call.
  const lossy = await botStop.watch({ asked: async () => false, everyMs: 60_000, onNote: async () => { throw new Error('lease lost'); } });
  await lossy.note('close_thread', {}, { ok: true });
  assert.equal(lossy.did.length, 1);
  lossy.end();
});

// ── 4. Where a turn looks ────────────────────────────────────────────────

const callOf = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
function profileOf(steps, overrides = {}) {
  const asked = [];
  const ran = [];
  const profile = {
    messages: [{ role: 'system', content: 'sys' }],
    ids: null,
    normalize: (calls) => (Array.isArray(calls) ? calls : []),
    parseArgs: (raw) => JSON.parse(raw || '{}'),
    resultChars: 200,
    ask: async () => { asked.push(1); const step = steps.shift(); return typeof step === 'string' ? { content: step, toolCalls: [] } : { content: null, toolCalls: step }; },
    where: (n) => `x${n}`,
    done: () => false,
    offer: () => ({ tools: [], toolChoice: 'auto' }),
    onWords: () => 'stop',
    call: async (_call, name) => { ran.push(name); return { ok: true }; },
    ...overrides,
  };
  return { profile, asked, ran };
}

test('the turn engine stops before the next model request and before the next tool call, never inside one', async () => {
  // Stopped before the round asks: the model is not asked.
  const first = new AbortController();
  first.abort();
  const a = profileOf(['never asked'], { signal: first.signal });
  await assert.rejects(engine.runRounds({ rounds: 0, limit: 3 }, a.profile), (err) => botStop.isStop(err));
  assert.equal(a.asked.length, 0);

  // Stopped while the first of three calls runs: that call finishes, the
  // other two are not begun, and no further request is made.
  const mid = new AbortController();
  const b = profileOf([[callOf('c1', 'one'), callOf('c2', 'two'), callOf('c3', 'three')], 'never asked'], { signal: mid.signal });
  b.profile.call = async (_call, name) => { b.ran.push(name); if (name === 'one') mid.abort(); return { ok: true }; };
  await assert.rejects(engine.runRounds({ rounds: 0, limit: 3 }, b.profile), (err) => botStop.isStop(err));
  assert.deepEqual(b.ran, ['one']);
  assert.equal(b.asked.length, 1);

  // Stopped while the last call of a round runs: the next round is not asked.
  const last = new AbortController();
  const c = profileOf([[callOf('c1', 'one')], 'never asked'], { signal: last.signal });
  c.profile.call = async (_call, name) => { c.ran.push(name); last.abort(); return { ok: true }; };
  await assert.rejects(engine.runRounds({ rounds: 0, limit: 3 }, c.profile), (err) => botStop.isStop(err));
  assert.equal(c.asked.length, 1);

  // A turn nobody can stop (a project's thread hands no signal) runs as it did.
  const d = profileOf([[callOf('c1', 'one')], 'Done.']);
  await engine.runRounds({ rounds: 0, limit: 3 }, d.profile);
  assert.equal(d.asked.length, 2);

  const src = read('src/services/homeroom-bot-turn-engine.js');
  assert.equal((src.match(/botStop\.check\(profile\.signal\);/g) || []).length, 2, 'the two safe points');
});

test('a model request in flight is cut off by a Stop: never recorded as a failure, never asked again', async () => {
  const controller = new AbortController();
  let calls = 0;
  const t = {
    config: {}, user: { id: 1 }, message: { id: 5 }, model: 'm', apiKey: 'sk', route: 1, startedMs: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, failures: [], avoid: [], sleep: async () => {},
    signal: controller.signal,
    // The transport, as openrouter.js streamChat ends on its caller's signal.
    chat: (request) => new Promise((_resolve, reject) => {
      calls += 1;
      assert.equal(request.signal, controller.signal, 'the transport is handed the turn\'s signal');
      request.signal.addEventListener('abort', () => reject(Object.assign(new Error('OpenRouter model cancelled'), { code: 'cancelled' })));
      setTimeout(() => controller.abort(), 5);
    }),
  };
  await assert.rejects(mayor.askModel(t, { messages: [], tools: [], toolChoice: 'auto', where: 'r1' }), (err) => botStop.isStop(err));
  assert.equal(calls, 1, 'not retried');
  assert.deepEqual(t.failures, [], 'not a failure of the model');
  // Stopped already: nothing is asked.
  await assert.rejects(mayor.askModel(t, { messages: [], tools: [], toolChoice: 'auto', where: 'r2' }), (err) => botStop.isStop(err));
  assert.equal(calls, 1);

  // A failure that is the model's, as the person stops: the wait before its
  // retry is the last thing it does.
  const late = new AbortController();
  let tries = 0;
  const t2 = {
    ...t, failures: [], signal: late.signal,
    chat: async () => { tries += 1; throw Object.assign(new Error('busy'), { code: 'rate_limited', status: 429 }); },
    sleep: async () => { late.abort(); },
  };
  await assert.rejects(mayor.askModel(t2, { messages: [], tools: [], toolChoice: 'auto', where: 'r1' }), (err) => botStop.isStop(err));
  assert.equal(tries, 1, 'the retry is not made');

  // A turn with no signal asks as it always did: no `signal` on the request.
  let seen = null;
  const plain = { ...t, failures: [], signal: null, chat: async (request) => { seen = request; return { content: 'hi', toolCalls: [], usage: {} }; } };
  await mayor.askModel(plain, { messages: [], tools: [], toolChoice: 'auto', where: 'r1' });
  assert.equal('signal' in seen, false);
});

test('the Stop is the turn\'s own signal, never the work item\'s lease signal', () => {
  // The kernel aborts a handler's signal when its process stops for a
  // release too (kernel/services.ts onStop): that is not a person's Stop, and
  // an answer under way then is finished or retried, as before.
  const services = read('src/workflow/bot-dm/services.ts');
  const answer = services.slice(services.indexOf('[WORK.answer]: {'), services.indexOf('[WORK.sorry]: {'));
  assert.match(answer, /async run\(\{ input, key, resumeFrom, checkpoint, attempt: tries \}\): Promise<Json> \{/);
  assert.doesNotMatch(answer, /\bsignal\b/, 'the lease signal is not read');
  assert.match(answer, /legacy\('services\/homeroom-bot-stop'\)\.watch\(\{/);
  assert.match(answer, /asked: \(\) => stopAsked\(pool, \{ userId, messageId, attempt \}\),/);
  assert.match(answer, /\} finally \{\n\s+stop\.end\(\);\n\s+\}/, 'the watch ends with the answer, however it ends');
  // The machine cancels nothing: the answer's own work ends the turn.
  const machine = read('src/workflow/bot-dm/machine.ts');
  assert.doesNotMatch(machine, /\bcancel:/);
});

test('a stopped turn is recorded with what it cost and no error, and its line is never checked or rewritten', () => {
  const src = read('src/services/homeroom-bot-mayor.js');
  const stopped = src.slice(src.indexOf('const sayStopped = async () => {'), src.indexOf('if (t.apiKey === undefined) {'));
  assert.match(stopped, /error: null,\n\s+failures: t\.failures, fallback: 'stopped',/);
  assert.match(stopped, /await turnEngine\.chargeTurn\(pool, bot\.id, t\.usage\.costUsd,/, 'the bot\'s weekly cap counts it');
  assert.match(stopped, /return sayOutside\(botStop\.stoppedText\(deps\.stop\.did\)\);/, 'said where they wrote, as written');
  assert.doesNotMatch(stopped, /claims\.|checkReply|cleanReply|fallbackAnswer/, 'no reply check and no fallback answer');
  // Looked at after the rounds and after the fallback's one request, before
  // anything is sent; the second pass never swallows it.
  assert.equal((src.match(/if \(stoppedNow\(\)\) return sayStopped\(\);/g) || []).length, 2);
  assert.match(src, /\} catch \(err\) \{\n\s+if \(botStop\.isStop\(err\)\) throw err;\n\s+\/\/ The first answer, less what it should not have said, still goes\./);
  // The design bot's turn the same way.
  const design = read('src/services/design-bot.js');
  assert.match(design, /if \(deps\.stop\?\.signal\?\.aborted\) \{\n\s+await mayor\.recordTurn\(pool, \{[\s\S]{0,400}?error: null, failures: t\.failures, fallback: 'stopped',/);
  assert.match(design, /return say\(botStop\.stoppedText\(deps\.stop\.did\)\);/);
  // A look sent to read the code is waited for only until the Stop.
  const look = read('src/services/homeroom-bot-thread-tools/look-into.js');
  assert.match(look, /while \(row && row\.state === 'running' && Date\.now\(\) < until && !signal\?\.aborted\) \{/);
  assert.match(look, /signal: ctx\.stopSignal \|\| null,/);
});
