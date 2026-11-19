'use strict';

// Credit and failure handling that is true (review A1, A2, A5, B1, B6 of 19
// Nov 2026). Every test here enters at a real boundary: a stubbed `fetch`
// answered with the provider's own response, the worker's own result shape,
// or the pure machine driven as the kernel drives it. None builds the
// already-classified error by hand, which is how A1 shipped.
//
// Run with: node --test tests/bot-turn-failure.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const openrouter = require('../src/services/openrouter');
const openrouterMayor = require('../src/services/openrouter-mayor');
const providerError = require('../src/services/provider-error');
const turnFailure = require('../src/services/bot-turn-failure');
const credit = require('../src/services/openrouter-credit');
const mayor = require('../src/services/homeroom-bot-mayor');
const bot = require('../src/services/homeroom-bot');
const laneMachine = require('../src/workflow/bot-lane/machine.ts');
const laneFacts = require('../src/workflow/bot-lane/facts.ts');
const rules = require('../src/workflow/rules/bot-loop.ts');
const replies = require('../src/workflow/rules/bot-replies.ts');
const investigation = require('../src/workflow/rules/investigation.ts');

// ── The provider's own answers ──────────────────────────────────────────

// OpenRouter's body on 19 Nov 2026, when the bot's credit ran out.
const OUT_OF_CREDIT = 'This request would exceed your available credits given your current in-flight requests. '
  + 'Retry after in-flight requests settle, or add credits.';
const INSUFFICIENT = 'Insufficient credits';
const SHORTER = 'This request requires more credits, or fewer max_tokens. You requested up to 4000 tokens, but can only afford 900.';
const body = (message, code) => JSON.stringify({ error: { message, ...(code ? { code } : {}) } });
const answer = (status, text) => async () => new Response(text, { status, headers: { 'content-type': 'application/json' } });

const viaOpenRouter = (fetchImpl) => openrouter.streamChat({
  apiKey: 'k', baseUrl: 'https://openrouter.test/api/v1', model: 'z-ai/glm-5.3-flash', reasoning: 'low',
  messages: [{ role: 'user', content: 'hi' }], tools: [], fetchImpl,
});
const viaMayor = (fetchImpl) => openrouterMayor
  .createClient({ apiKey: 'k', model: 'm/x', fetchImpl }).streamChat({ messages: [] });

const codeFrom = async (call) => {
  try { await call; } catch (err) { return { code: err.code, status: err.status ?? null }; }
  return { code: null, status: null };
};

test('A1: both clients read OpenRouter\'s 402 for credit as credit_out, and the 402 for a shorter reply as billing', async () => {
  for (const [name, via] of [['openrouter.js', viaOpenRouter], ['openrouter-mayor.js', viaMayor]]) {
    for (const text of [body(OUT_OF_CREDIT, 402), body(INSUFFICIENT), '', 'Payment Required']) {
      assert.deepEqual(await codeFrom(via(answer(402, text))), { code: 'credit_out', status: 402 }, `${name}: ${text || '(empty body)'}`);
    }
    assert.deepEqual(await codeFrom(via(answer(402, body(SHORTER, 402)))), { code: 'billing', status: 402 }, `${name}: a shorter reply gets through`);
    // A 200 whose body carries the 402.
    assert.equal((await codeFrom(via(answer(200, body(INSUFFICIENT, 402))))).code, 'credit_out', `${name}: in the body`);
    // Every other status says what it always said, in both.
    for (const [status, code] of [[401, 'authentication'], [403, 'authentication'], [408, 'timeout'], [429, 'rate_limited'],
      [500, 'provider_unavailable'], [503, 'provider_unavailable'], [504, 'timeout'], [400, 'invalid_request']]) {
      assert.equal((await codeFrom(via(answer(status, body('no'))))).code, code, `${name}: HTTP ${status}`);
    }
  }
});

test('B6: one status table for both clients', () => {
  assert.equal(providerError.refusalCode(402, body(OUT_OF_CREDIT, 402)), 'credit_out');
  assert.equal(providerError.refusalCode(402, SHORTER), 'billing');
  assert.equal(providerError.refusalCode(402), 'credit_out', 'a bare 402 is Payment Required');
  assert.equal(providerError.refusalCode(429, INSUFFICIENT), 'rate_limited', 'only a 402\'s body is read');
  assert.equal(providerError.bodyErrorCode({ code: 402, message: INSUFFICIENT }), 'credit_out');
  assert.equal(providerError.bodyErrorCode({ message: 'no code' }), null);
  // An error in a 200's body other than the 402 keeps the code the chat's
  // retries were written against.
  return codeFrom(viaOpenRouter(answer(200, body('slow down', 429)))).then((out) => assert.equal(out.code, 'provider_error'));
});

test('A1: the chat\'s fallback reads the code the real client gave, and says the credit line', async () => {
  const { code } = await codeFrom(viaOpenRouter(answer(402, body(OUT_OF_CREDIT, 402))));
  let noted = 0;
  const t = { ctx: { userText: 'hello', deps: { credit: { noteOutage: async () => { noted += 1; } } } }, failures: [] };
  const out = await mayor.fallbackAnswer({ query: async () => ({ rows: [] }) }, t, { error: code, history: [] });
  assert.deepEqual({ fallback: out.fallback, text: out.text, defer: out.defer }, { fallback: 'credit', text: mayor.CREDIT_TEXT, defer: true });
  assert.equal(noted, 1);
});

// ── One sort for every finished turn ────────────────────────────────────

test('B6: a failed turn is credit\'s, the platform\'s or the model\'s, from its own fields', async () => {
  const cls = (what) => turnFailure.sort(what).class;
  // A model client's thrown error, as the real client throws it.
  const thrown = async (status, text) => {
    try { await viaOpenRouter(answer(status, text)); } catch (err) { return err; }
    return null;
  };
  assert.equal(cls({ err: await thrown(402, body(OUT_OF_CREDIT, 402)) }), 'credit');
  assert.equal(cls({ err: await thrown(503, body('down')) }), 'platform');
  assert.equal(cls({ err: await thrown(429, body('slow')) }), 'platform');
  assert.equal(cls({ err: await thrown(401, body('bad key')) }), 'platform', 'a key that does not work is Homeroom\'s to fix');
  assert.equal(cls({ err: await thrown(402, body(SHORTER, 402)) }), 'platform');
  assert.equal(cls({ err: await thrown(400, body('bad request')) }), 'model', 'a request refused as built is the turn\'s own');
  assert.equal(cls({ err: Object.assign(new Error('x'), { code: 'output_limit' }) }), 'model');
  // A coding turn's result, as the worker reports it.
  assert.equal(cls({ turn: { lastResultText: '', agentErrorCode: 'insufficient_credits', agentError: INSUFFICIENT } }), 'credit');
  assert.equal(cls({ turn: { lastResultText: `API Error: 402 ${body(INSUFFICIENT)}` } }), 'credit');
  assert.equal(cls({ turn: { lastResultText: 'API Error: 503 {"error":{"message":"Provider returned error","code":503}}' } }), 'platform');
  assert.equal(cls({ turn: { lastResultText: '', markerlessCause: 'oom_killed', exitCode: -1 } }), 'platform');
  assert.equal(cls({ turn: { lastResultText: '', agentErrorCode: 'stream_disconnected' } }), 'platform');
  assert.equal(cls({ turn: { lastResultText: 'The plan: show a friendly page on HTTP 402 and 503.' } }), 'model',
    'the model\'s own words are never read as a provider\'s');
  assert.equal(cls({ turn: { lastResultText: '' } }), 'model', 'an empty reply nothing explains');
  // A routed turn that never ran.
  assert.equal(cls({ code: 'dispatch: socket hang up' }), 'model', 'only a code is a code');
  assert.equal(cls({ code: 'dispatch:worker_gone' }), 'platform');
  for (const code of turnFailure.DISPATCH_CODES) assert.equal(cls({ code }), 'platform', code);
  assert.equal(cls({ code: 'insufficient_credits' }), 'credit');
  assert.equal(cls({}), 'model');
});

test('B6: the chat turn\'s own sets are built from the one list of codes, and say what they said', () => {
  const err = (code, more = {}) => Object.assign(new Error('x'), { code, ...more });
  // Asked again inside the turn: the provider's failures, a reply cut short, an empty one.
  for (const code of [...turnFailure.PROVIDER_CODES, 'output_limit', 'empty_answer']) {
    assert.ok(mayor.retryPlan(err(code)), `${code} is asked again`);
  }
  // Never: the key's, the outage, a Stop.
  for (const code of ['authentication', 'billing', 'credit_out', 'cancelled', undefined]) {
    assert.equal(mayor.retryPlan(err(code)), null, String(code));
  }
  // The provider left out of the next try: its own failures, never the network's.
  assert.deepEqual(mayor.avoidProviders([], err('provider_unavailable', { provider: 'Acme' })), ['Acme']);
  assert.deepEqual(mayor.avoidProviders([], err('network', { provider: 'Acme' })), []);
  assert.deepEqual(mayor.avoidProviders([], err('credit_out', { provider: 'Acme' })), [], 'no provider is at fault for the account\'s credit');
});

test('B6: a first version\'s one automatic retry is not spent on a build that stopped for credit', () => {
  const failed = { ok: false, error: 'the build turn failed', specMd: '# Plan\n\nBuild it.' };
  assert.equal(bot.autoRetryable(failed), true, 'a failed build with its plan is tried once more');
  assert.equal(bot.autoRetryable({ ...failed, creditOut: true }), false, 'one that met the 402 waits for credit instead');
});

// ── One stored outage, read as a level ──────────────────────────────────

function settingsPool() {
  const settings = new Map();
  const seen = [];
  return {
    settings, seen,
    async query(text, params) {
      const sql = String(text);
      seen.push(sql);
      if (/INSERT INTO platform_settings/.test(sql)) { settings.set(params[0], params[1]); return { rows: [] }; }
      if (/FROM platform_settings/.test(sql)) {
        const keys = Array.isArray(params[0]) ? params[0] : [params[0]];
        return { rows: keys.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k) })) };
      }
      return { rows: [{ id: 1 }] };
    },
  };
}

test('B1: creditState is the one question: asked from the stored outage, cached a few seconds, never a reason to stop answering', async () => {
  assert.equal(laneFacts.CREDIT_STATE_KEY, credit.KEY_STATE, 'the lane reads the row the sweep writes');
  const pool = settingsPool();
  assert.deepEqual(await credit.creditState(pool), { out: false, since: null, words: null });
  // A turn reports the 402: seen at once in this process.
  const noted = await credit.noteOutage(pool, { words: INSUFFICIENT }, { staging: true });
  assert.equal(noted.fresh, true);
  const out = await credit.creditState(pool);
  assert.deepEqual({ out: out.out, words: out.words }, { out: true, words: INSUFFICIENT });
  assert.equal(out.since, noted.since);
  // Another process's change is seen once the short cache lapses.
  const stored = JSON.parse(pool.settings.get(credit.KEY_STATE));
  pool.settings.set(credit.KEY_STATE, JSON.stringify({ ...stored, outage: null }));
  assert.equal((await credit.creditState(pool)).out, true, 'still the cached answer');
  assert.equal((await credit.creditState(pool, { now: Date.now() + credit.STATE_CACHE_MS + 1 })).out, false);
  // A read that fails says "not out".
  const broken = { async query() { throw new Error('db down'); } };
  assert.deepEqual(await credit.creditState(broken), { out: false, since: null, words: null });
});

test('A5: the sweep stores the cleared outage before it wakes the lane, and a wake-up that fails loses nothing', async () => {
  const pool = settingsPool();
  await credit.noteOutage(pool, { words: INSUFFICIENT }, { staging: true });
  const before = JSON.parse(pool.settings.get(credit.KEY_STATE));
  // Long enough ago that a balance read may lift it (BACK_AFTER_MS).
  pool.settings.set(credit.KEY_STATE, JSON.stringify({ ...before, outage: { ...before.outage, since: new Date(Date.now() - 2 * credit.BACK_AFTER_MS).toISOString() } }));
  const order = [];
  const out = await credit.sweep(pool, {}, {
    staging: true,
    readBalance: async () => ({ accountCents: 90000, keyCents: null, balanceCents: 90000, at: new Date().toISOString() }),
    platform: () => ({
      async botCreditBack() {
        order.push(JSON.parse(pool.settings.get(credit.KEY_STATE)).outage ? 'woken while the outage was still stored' : 'woken after the write');
        throw new Error('the event could not be appended');
      },
    }),
  });
  assert.deepEqual(out.events.map((e) => e.type), ['back']);
  assert.deepEqual(order, ['woken after the write']);
  assert.equal(JSON.parse(pool.settings.get(credit.KEY_STATE)).outage, null, 'the level is cleared whatever became of the wake-up');
  assert.equal((await credit.creditState(pool)).out, false);
});

// The lane, driven as the kernel drives it: no database.
const lane = laneMachine.botLane({ staging: false });
const NOW = new Date('2026-11-19T11:00:00Z');
const LANE_CTX = { machine: laneMachine.MACHINE, key: laneMachine.KEY, appId: null, version: 1, now: NOW };
const OUTAGE = { since: '2026-11-19T09:00:00.000Z', words: INSUFFICIENT };
const READ = { app_id: 3, issue_number: 12, priority: 0, reason: 'reply', person_id: 9, follow_up_session_id: null, triage_session_id: 77, machine_version: 2 };
const laneData = (more = {}) => ({
  grants: 0, fault: null, budget: null, credit: null,
  refresh: { due: '2026-11-19T12:00:00.000Z', asked: [], soon: null, n: 1, running: null }, ...more,
});
const factsWith = (more = {}) => ({
  ...laneMachine.NO_FACTS, acting: true, credit: null, reads: [READ], ...more,
});
let laneSeq = 0;
const laneEvent = (type, payload = {}) => {
  laneSeq += 1;
  const decode = lane.events.get(type);
  return { id: laneSeq, type, payload: decode ? decode(payload) : payload, source: { kind: 'system', name: 'test' } };
};
const pass = (data, type, facts, payload) => lane.entryFor('open', type).to({ name: 'open', data }, laneEvent(type, payload), facts, LANE_CTX);
const grantsOf = (out) => (out.messages || []).filter((m) => m.to.machine === rules.BOT_REQUEST && m.event.type === 'Granted');
const dmsTold = (out) => (out.messages || []).filter((m) => m.to.machine === replies.DM).map((m) => [m.to.key, m.event.type]);

test('A5: the lane grants nothing while the stored outage stands, and grants again once it is gone, with no event delivered', () => {
  // No pause of its own yet: the chat noted the outage, the lane never heard.
  const paused = pass(laneData(), 'Look', factsWith({ credit: OUTAGE }));
  assert.deepEqual(grantsOf(paused), [], 'nothing is granted');
  assert.deepEqual(paused.next.data.credit, OUTAGE, 'it takes the stored outage as its own copy');
  assert.ok(paused.timer && paused.timer.event.type === 'Tick', 'and looks again by itself');
  assert.ok(paused.timer.at.getTime() <= NOW.getTime() + laneMachine.CREDIT_RECHECK_MS);
  // Its own clock, the outage still standing: still nothing.
  const still = pass(paused.next.data, 'Tick', factsWith({ credit: OUTAGE }));
  assert.deepEqual(grantsOf(still), []);
  // The outage is gone from the store. No CreditBack ever arrives (the
  // sweep's wake-up was lost): an ordinary tick lifts the pause, grants, and
  // tells the DMs that kept a message, once.
  const dms = [{ key: 'person:9', userId: 9 }];
  const lifted = pass(still.next.data, 'Tick', factsWith({ credit: null, creditDms: dms }));
  assert.equal(lifted.next.data.credit, null);
  assert.equal(grantsOf(lifted).length, 1, 'the read waiting is granted');
  assert.deepEqual(dmsTold(lifted), [['person:9', 'CreditBack']]);
  const after = pass(lifted.next.data, 'Tick', factsWith({ credit: null, creditDms: dms, reads: [] }));
  assert.deepEqual(dmsTold(after), [], 'told once');
});

test('A5: a turn\'s report of credit pauses nothing by itself: the stored outage does', () => {
  // The look said `credit` but the outage is not stored (its note failed):
  // the lane does not hold a pause nothing could lift.
  const reported = pass(laneData(), 'Released', factsWith({ credit: null }), { ran: true, credit: true, words: INSUFFICIENT });
  assert.equal(reported.next.data.credit, null);
  assert.equal(grantsOf(reported).length, 1);
  // With it stored (the usual order: the turn notes it, then lets go).
  const stored = pass(laneData(), 'Released', factsWith({ credit: OUTAGE }), { ran: true, credit: true, words: INSUFFICIENT });
  assert.deepEqual(stored.next.data.credit, OUTAGE);
  assert.deepEqual(grantsOf(stored), []);
});

test('A5: CreditBack is a wake-up: it lifts nothing while the outage is still stored, and tells the DMs once it is gone', () => {
  const dms = [{ key: 'person:9', userId: 9 }, { key: 'person:12', userId: 12 }];
  const early = pass(laneData({ credit: OUTAGE }), 'CreditBack', factsWith({ credit: OUTAGE, creditDms: dms }));
  assert.deepEqual(early.next.data.credit, OUTAGE);
  assert.deepEqual([grantsOf(early), dmsTold(early)], [[], []]);
  const back = pass(laneData({ credit: OUTAGE }), 'CreditBack', factsWith({ credit: null, creditDms: dms }));
  assert.equal(back.next.data.credit, null);
  assert.equal(grantsOf(back).length, 1);
  assert.deepEqual(dmsTold(back), [['person:9', 'CreditBack'], ['person:12', 'CreditBack']], 'each once, not twice');
  // The chat alone met the outage and the lane never held a pause: the DMs
  // are still told when the sweep says credit is back.
  const never = pass(laneData(), 'CreditBack', factsWith({ credit: null, creditDms: dms, reads: [] }));
  assert.deepEqual(dmsTold(never), [['person:9', 'CreditBack'], ['person:12', 'CreditBack']]);
});

test('A5: the lane reads the stored outage whether the bot is on or not', async () => {
  const rows = (mode) => [
    { key: rules.KEY_MODE, value: mode },
    { key: laneFacts.CREDIT_STATE_KEY, value: JSON.stringify({ outage: OUTAGE, armed: {} }) },
  ];
  const tx = (mode) => ({
    async query(text, params) {
      if (/FROM platform_settings/.test(text)) {
        assert.ok(params[0].includes(laneFacts.CREDIT_STATE_KEY), 'one read brings the settings and the outage');
        return { rows: rows(mode) };
      }
      return { rows: [] };
    },
  });
  assert.deepEqual((await laneFacts.readFacts(tx('off'), { staging: false })).credit, OUTAGE);
  assert.deepEqual((await laneFacts.readFacts(tx('live'), { staging: false })).credit, OUTAGE);
  assert.equal(laneFacts.creditOutageOf(JSON.stringify({ outage: null })), null);
  assert.equal(laneFacts.creditOutageOf('not json'), null);
  assert.equal(laneFacts.creditOutageOf(null), null);
});

// ── Investigations ──────────────────────────────────────────────────────

test('A2: an investigation survives a credit outage: held looks are no failures of its own', () => {
  const now = new Date('2026-11-19T10:00:00Z');
  let ledger = { spentCents: 0, budgetCents: 500, everyMs: 6 * investigation.HOUR_MS, endsAt: '2026-11-26T10:00:00Z', failures: 0 };
  // Six looks in a row meet the 402 (a few hours without credit): none ends it.
  for (let i = 0; i < 6; i += 1) {
    const next = investigation.afterCheckIn(ledger, { ran: true, failed: false, held: 'credit', costCents: 0 }, now);
    assert.ok('at' in next, `look ${i + 1} is asked again, not ended`);
    assert.equal(next.failures, 0);
    ledger = { ...ledger, failures: next.failures };
  }
  // The platform failing under a look is the same.
  const platform = investigation.afterCheckIn({ ...ledger, failures: 2 }, { ran: true, failed: false, held: 'platform' }, now);
  assert.ok('at' in platform);
  assert.equal(platform.failures, 2, 'it neither adds a failure nor clears the ones before it');
  assert.ok(platform.at.getTime() - now.getTime() < ledger.everyMs, 'and it is asked again sooner');
  // The model's own failures still end it at three in a row.
  const third = investigation.afterCheckIn({ ...ledger, failures: 2 }, { ran: true, failed: true }, now);
  assert.deepEqual({ end: third.end, failures: third.failures }, { end: 'failed', failures: 3 });
  // A look that ran clean clears them.
  assert.equal(investigation.afterCheckIn({ ...ledger, failures: 2 }, { ran: true, failed: false }, now).failures, 0);
});
