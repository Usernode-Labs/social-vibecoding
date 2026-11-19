'use strict';

// Architecture pass, track 1 (19 Nov 2026): the Homeroom bot's failure
// paths that ended with nobody told, a promise nobody kept, or a retry that
// never came. Each is pinned here without a database:
//
//   T1.3/T1.4/T1.5  out of OpenRouter's credit: one classifier, a probe that
//                   lifts a pause no balance read can, the admins told at
//                   once and again when a pause runs long, the chat's line;
//   T1.6            a person's Stop of a build is recorded as stopped by them;
//   T1.7            a lost merge answer is recognised, a conflict nobody acts
//                   on is handed to the requester;
//   T1.8            a held answer whose post ran out of tries is decided again;
//   T1.9/T1.10      a fix lost twice, and a merged change whose deploy failed,
//                   reach whoever asked; a merge not live after hours is an
//                   incident;
//   T1.11           a chat answer that failed names what the turn did;
//   T1.13           a change whose reviewer failed says it went unreviewed;
//   T1.15           the notes promise only what the code does.
//
// Run with: node --test tests/homeroom-bot-failure-paths.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const SHA = (c) => c.repeat(40);
const event = (type, payload, source = { kind: 'system', name: 'test' }) => ({
  id: 7, type, payload, source, actor: null, requestKey: 'k', appId: 10, causedBy: null,
});

// ── T1.3: one classifier for "out of credit" ────────────────────────────

test('T1.3: out of credit is told apart from the 402 that asks for a shorter reply, wherever it is said', () => {
  const credit = require('../src/services/openrouter-credit');
  // HTTP failures (the chat's client, the probe).
  assert.equal(credit.creditOut({ status: 402, body: '{"error":{"message":"Insufficient credits"}}' }), true);
  assert.equal(credit.creditOut({ status: 402, body: '' }), true, 'a bare 402 is Payment Required');
  assert.equal(credit.creditOut({ status: 402, body: 'This request requires more credits, or fewer max_tokens. You requested up to 4000 tokens, but can only afford 900.' }), false);
  assert.equal(credit.creditOut({ status: 429, body: 'slow down' }), false);
  // The Codex harness: an empty reply whose only trace is its code.
  assert.equal(credit.creditOut({ lastResultText: '', agentErrorCode: 'insufficient_credits' }), true);
  assert.equal(credit.creditOut({ agentError: 'API Error: 402 Insufficient credits' }), true);
  // A routed turn: its error, or its result.
  assert.equal(credit.creditOut({ error: null, result: { agentErrorCode: 'insufficient_credits' } }), true);
  // Claude Code's notice in place of an answer, but never the model's words.
  assert.equal(credit.creditOut({ lastResultText: 'API Error: 402 {"error":{"message":"Insufficient credits"}}' }), true);
  assert.equal(credit.creditOut({ lastResultText: 'The plan: show a friendly page on HTTP 402 and 404.' }), false);
  // A status of 402 with the shorter-reply words beside it is that refusal.
  assert.equal(credit.creditOut({ providerErrorStatus: 402, agentError: 'requires more credits, or fewer max_tokens' }), false);
  assert.equal(credit.creditOut('API Error: 402 Insufficient credits'), true);
  assert.equal(credit.creditOut(null), false);
});

// ── T1.4: the probe and the long pause ──────────────────────────────────

test('T1.4: a probe is due after a back-off that doubles; a long pause is due every N hours', () => {
  const credit = require('../src/services/openrouter-credit');
  const since = Date.parse('2026-11-19T10:00:00Z');
  const outage = { since: new Date(since).toISOString() };
  assert.equal(credit.probeDue(outage, since + 5 * 60 * 1000), false, 'not before the back-off');
  assert.equal(credit.probeDue(outage, since + credit.PROBE_BASE_MS), true);
  const once = { ...outage, probes: 1, probedAt: new Date(since + credit.PROBE_BASE_MS).toISOString() };
  assert.equal(credit.probeDue(once, since + credit.PROBE_BASE_MS + 10 * 60 * 1000), false);
  assert.equal(credit.probeDue(once, since + 2 * credit.PROBE_BASE_MS), true);
  const many = { ...outage, probes: 9, probedAt: new Date(since + 60 * 60 * 1000).toISOString() };
  assert.equal(credit.probeDue(many, since + 60 * 60 * 1000 + credit.PROBE_CEILING_MS), true, 'never more than the ceiling apart');
  assert.equal(credit.probeDue(null), false);
  assert.equal(credit.staleDue(outage, 6, since + 5 * 3600 * 1000), false);
  assert.equal(credit.staleDue(outage, 6, since + 6 * 3600 * 1000), true);
  assert.equal(credit.staleDue({ ...outage, staleAt: new Date(since + 6 * 3600 * 1000).toISOString() }, 6, since + 7 * 3600 * 1000), false,
    'told again only N hours after it was last told');
});

// A pool for the sweep: platform_settings in memory, everything else answered empty.
function settingsPool(state) {
  const settings = new Map([['homeroom_bot_credit_state', JSON.stringify(state)]]);
  const queries = [];
  return {
    queries,
    settings,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (/FROM platform_settings WHERE key = ANY/.test(sql)) {
        return { rows: [...settings].filter(([k]) => params[0].includes(k)).map(([key, value]) => ({ key, value })) };
      }
      if (/INSERT INTO platform_settings/.test(sql)) { settings.set(params[0], params[1]); return { rows: [] }; }
      return { rows: [] };
    },
  };
}

test('T1.4: an outage no balance read can lift is probed, and a probe that gets through lifts it', async () => {
  const credit = require('../src/services/openrouter-credit');
  const since = Date.parse('2026-11-19T10:00:00Z');
  const pool = settingsPool({ outage: { since: new Date(since).toISOString(), words: '402' } });
  let back = 0;
  const out = await credit.sweep(pool, {}, {
    staging: true, now: () => since + credit.PROBE_BASE_MS,
    readBalance: async () => ({ accountCents: null, keyCents: null, balanceCents: null, at: new Date().toISOString() }),
    probe: async () => 'ok',
    platform: () => ({ botCreditBack: async () => { back += 1; } }),
  });
  assert.equal(out.probe, 'ok');
  assert.equal(back, 1, 'the lane hears credit is back');
  assert.equal(JSON.parse(pool.settings.get('homeroom_bot_credit_state')).outage, null);
});

test('T1.4: a probe still refused counts its tries, and a pause past N hours is raised and told', async () => {
  const credit = require('../src/services/openrouter-credit');
  const since = Date.parse('2026-11-19T00:00:00Z');
  const pool = settingsPool({ outage: { since: new Date(since).toISOString(), words: '402' } });
  const told = [];
  const out = await credit.sweep(pool, {}, {
    staging: false, now: () => since + 7 * 3600 * 1000,
    readBalance: async () => ({ accountCents: null, keyCents: null, balanceCents: null, at: new Date().toISOString() }),
    probe: async () => 'credit',
    platform: () => ({ botCreditBack: async () => { throw new Error('not back'); } }),
    notifications: () => ({
      createPlatformIncidentNotifications: async (_db, args) => { told.push(args.detail); return []; },
      hydrateAndPush: async () => {},
    }),
  });
  const state = JSON.parse(pool.settings.get('homeroom_bot_credit_state'));
  assert.equal(state.outage.probes, 1);
  assert.ok(state.outage.staleAt, 'when it was last told');
  assert.equal(out.stale, 7);
  assert.deepEqual(told, ['credit:out'], 'the admins hear the pause goes on');
  assert.ok(pool.queries.some((q) => /INSERT INTO events/.test(q.sql) && /still_out/.test(JSON.stringify(q.params))), 'an incident');
});

test('T1.5: a new outage tells the full admins at once, not in the next day\'s digest', async () => {
  const credit = require('../src/services/openrouter-credit');
  const pool = settingsPool({});
  const told = [];
  const deps = {
    staging: false,
    notifications: () => ({
      createPlatformIncidentNotifications: async (_db, args) => { told.push(args.detail); return []; },
      hydrateAndPush: async () => {},
    }),
  };
  const first = await credit.noteOutage(pool, { words: 'API Error: 402' }, deps);
  assert.equal(first.fresh, true);
  assert.ok(first.since);
  const second = await credit.noteOutage(pool, { words: 'API Error: 402' }, deps);
  assert.equal(second.fresh, false, 'one outage');
  assert.deepEqual(told, ['credit:out'], 'told once, at once');
});

// ── T1.3: the chat turn ─────────────────────────────────────────────────

test('T1.3: a chat answer that met the 402 for credit notes the outage, says so, and is asked again on its own', async () => {
  const mayor = require('../src/services/homeroom-bot-mayor');
  let noted = 0;
  const t = { ctx: { userText: 'hello', deps: { credit: { noteOutage: async () => { noted += 1; } } } }, failures: [] };
  const out = await mayor.fallbackAnswer({ query: async () => ({ rows: [] }) }, t, { error: 'credit_out', history: [] });
  assert.equal(out.fallback, 'credit');
  assert.equal(out.text, mayor.CREDIT_TEXT);
  assert.equal(out.defer, true, 'its DM\'s own clock asks it again');
  assert.equal(noted, 1);
  assert.doesNotMatch(mayor.CREDIT_TEXT, /admin needs to fix/, 'never the key\'s words');
  assert.match(mayor.CREDIT_GAVE_UP_TEXT, /still out of building credit/);
});

// ── T1.6: a person's Stop ───────────────────────────────────────────────

test('T1.6: a build a person stopped is recorded as stopped by them, never as a failure', () => {
  const bot = require('../src/services/homeroom-bot');
  assert.equal(bot.stopperOf({ code: 'stopped', message: 'Stopped by ada', by: 'ada' }), 'ada');
  assert.equal(bot.stopperOf({ code: 'stopped', message: 'Stopped by evan' }), 'evan', 'a Stop recorded before it carried `by`');
  assert.equal(bot.stopperOf({ code: 'stopped', message: 'Stopped' }), null, 'the platform\'s own Stop');
  assert.equal(bot.stopperOf({ code: 'lease_lost', message: 'x' }), null);
  const src = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot'), 'utf8');
  const lost = src.slice(src.indexOf('async function recordLostLiveBuild'), src.indexOf('function stopperOf'));
  assert.match(lost, /`stopped: by @\$\{stoppedBy\}`/, 'its exact prefix, which the cause decoder reads');
});

// ── T1.7: the lost merge answer ─────────────────────────────────────────

test('T1.7: an attempt that moved main and died before recording it is answered as merged', async () => {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    gitHost: require.resolve('../src/services/git-host'),
    repoMirror: require.resolve('../src/services/repo-mirror'),
    appNumbers: require.resolve('../src/services/app-numbers'),
    codeHostWrite: require.resolve('../src/services/code-host-write'),
    requests: require.resolve('../src/services/requests'),
    subject: require.resolve('../src/services/native-merge'),
  };
  const before = new Set(Object.keys(require.cache));
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  const stub = (id, exports) => { require.cache[id] = { id, filename: id, loaded: true, exports }; };
  const updates = [];
  const run = async ({ main, ancestor }) => {
    stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
    stub(ids.codeHostWrite, { requireCodeHostWrite() {} });
    stub(ids.requests, { async appFor() { return { id: 7, slug: 'demo' }; } });
    stub(ids.appNumbers, { getPool: () => ({ async query(sql, params) {
      if (/^\s*SELECT/.test(sql)) {
        return { rows: [{ number: 15, title: 'Chip', body: '', head_branch: 'dev/x', base_branch: 'main', draft: false, state: 'open',
          merged: false, merge_commit_sha: SHA('a'), merged_head_sha: SHA('9') }] };
      }
      updates.push({ sql, params });
      return { rows: [] };
    } }) });
    stub(ids.repoMirror, {
      async ensureMirror() { return '/mirror'; },
      async resolveBranch(_dir, name) { return name === 'main' ? main : SHA('9'); },
      async isAncestor() { return ancestor; },
      async mergeTree() { return { clean: true, tree: SHA('5'), conflicts: [] }; },
      async treeOf() { return SHA('6'); },
    });
    stub(ids.gitHost, {
      async readRef() { return main; }, defaultAuthor: () => ({ name: 'H', email: 'h@example.test' }),
      async git() { return { stdout: `${SHA('b')}\n` }; }, async casUpdateRef() {},
    });
    delete require.cache[ids.subject];
    return require(ids.subject).squashMerge({ owner: 'apps', repo: 'demo', number: 15, pinnedSha: SHA('9') });
  };
  try {
    const at = await run({ main: SHA('a'), ancestor: false });
    assert.deepEqual(at, { sha: SHA('a'), merged: true, message: 'Pull Request successfully merged' }, 'main is at the checkpoint');
    assert.ok(updates.some((u) => /SET merged = TRUE/.test(u.sql) && u.params[2] === SHA('a')), 'recorded as merged');
    updates.length = 0;
    const past = await run({ main: SHA('c'), ancestor: true });
    assert.equal(past.sha, SHA('a'), 'main moved past it: the merge happened');
    updates.length = 0;
    const not = await run({ main: SHA('c'), ancestor: false });
    assert.equal(not.sha, SHA('b'), 'a checkpoint main never reached is merged afresh');
    const checkpoint = updates.findIndex((u) => /merged = FALSE/.test(u.sql));
    const merged = updates.findIndex((u) => /SET merged = TRUE/.test(u.sql));
    assert.ok(checkpoint >= 0 && checkpoint < merged, 'the new merge is checkpointed before main moves');
  } finally {
    for (const id of Object.keys(require.cache)) if (!before.has(id)) delete require.cache[id];
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  }
  const { _pendingMerge } = require('../src/services/native-merge');
  assert.equal(_pendingMerge({ merged: true, merge_commit_sha: SHA('a'), merged_head_sha: SHA('9') }), null);
  assert.equal(_pendingMerge({ merged: false, merge_commit_sha: null, merged_head_sha: null }), null);
});

// ── bot-change: T1.7, T1.9, T1.10 ───────────────────────────────────────

function botChangeFacts(row = {}) {
  return {
    row: { app_id: 10, status: 'promoted', check_state: 'failing', reviewed_head_sha: SHA('7'), checks_commit_sha: SHA('7'),
      test_results: [{ name: 'Saving a list keeps it', status: 'fail' }], approval_epoch: 2, ...row },
    runId: 5, looked: false, fixRevised: false, requesterId: 3, builtFromSessionId: null,
  };
}
const fromMachine = (machine) => ({ kind: 'message', from: { machine, key: 'k' } });
const changeCtx = { now: new Date('2026-11-19T10:00:00Z'), key: 'session:44', version: 6 };

test('T1.9: a fix lost twice is handed to whoever asked for it, once per head', () => {
  const { botChange, WORK } = require('../src/workflow/bot-change/machine.ts');
  const m = botChange();
  const s = { name: 'with_the_bot', data: { sessionId: 44, appId: 10, told: null, stoppedEpoch: null, notes: {}, plan: null,
    fix: { head: SHA('7'), asked: true, lost: 1, refused: null, gaveUp: false } } };
  const e = event('FixRoundEnded', { sessionId: 44, head: SHA('7'), outcome: 'lost' });
  const out = m.entryFor('with_the_bot', 'FixRoundEnded').to(s, e, botChangeFacts(), changeCtx);
  const handOff = (out.work || []).find((w) => w.kind === WORK.handOff);
  assert.ok(handOff, 'its requester takes it from here');
  assert.deepEqual(handOff.input, { sessionId: 44, head: SHA('7') });
  assert.equal(out.next.data.fix.gaveUp, true);
  assert.ok(out.next.data.notes[handOff.key], 'noted, so it is asked once');
});

test('T1.10 and T1.7: a failed deploy, an unresolvable conflict and a stuck merge each reach the requester once', () => {
  const { botChange, WORK } = require('../src/workflow/bot-change/machine.ts');
  const m = botChange();
  const merged = { name: 'merged', data: { sessionId: 44, appId: 10, told: 2, stoppedEpoch: null, fix: null, plan: null, notes: {} } };
  const deploy = m.entryFor('merged', 'DeployFailed').to(merged, event('DeployFailed', { sessionId: 44, message: 'boot failed' }),
    botChangeFacts({ status: 'merged' }), changeCtx);
  assert.equal(deploy.work[0].kind, WORK.deployFailed);
  const again = m.entryFor('merged', 'DeployFailed').to(deploy.next, event('DeployFailed', { sessionId: 44, message: 'boot failed' }),
    botChangeFacts({ status: 'merged' }), changeCtx);
  assert.ok(!again.work?.length, 'once per merge');
  const ready = { name: 'ready', data: { ...merged.data } };
  const conflict = m.entryFor('ready', 'ConflictUnresolved').to(ready,
    event('ConflictUnresolved', { sessionId: 44, head: SHA('7'), files: ['a.js'] }), botChangeFacts(), changeCtx);
  assert.equal(conflict.work[0].kind, WORK.conflict);
  assert.deepEqual(conflict.work[0].input.files, ['a.js']);
  const stuck = m.entryFor('ready', 'MergeStuck').to(ready,
    event('MergeStuck', { sessionId: 44, head: SHA('7'), why: 'its required checks on GitHub never finished' }), botChangeFacts(), changeCtx);
  assert.equal(stuck.work[0].kind, WORK.conflict);
  assert.equal(stuck.work[0].input.stuck, true);
  const decode = m.events.get('ConflictUnresolved');
  assert.deepEqual(decode({ sessionId: 44, head: SHA('7'), files: ['a.js', 3] }).files, ['a.js']);
});

// ── merge-followups: T1.10 ──────────────────────────────────────────────

test('T1.10: a failed deploy tells the bot\'s change machine; a merge not live after hours is one incident', () => {
  const mf = require('../src/workflow/merge-followups/machine.ts');
  const m = mf.mergeFollowups({});
  const facts = {
    session: { id: 44, appId: 10, userId: 7, status: 'promoted', prNumber: 26, prTitle: 'T', linkedIssues: [11], agentSessionId: null, staging: null },
    app: { id: 10, slug: 'demo', repo: { owner: 'o', name: 'r' }, selfHosted: false, demoMode: false, booted: [] },
  };
  const ctx = { now: new Date('2026-11-19T10:00:00Z'), key: 'session:44', version: 1 };
  const created = m.entryFor('(none)', 'Merged').to({ name: '(none)', data: null },
    event('Merged', { sessionId: 44, mergeSha: SHA('a'), mergedAt: '2026-11-19T10:00:00Z', force: false, forcedBy: null, tally: null, observedBy: 'merge' }),
    facts, ctx);
  assert.equal(created.timer?.event?.type, 'NotLiveYet', 'its own clock');
  assert.equal(created.timer.at.toISOString(), new Date(Date.parse('2026-11-19T10:00:00Z') + mf.NOT_LIVE_ALERT_MS).toISOString());
  const failed = m.entryFor('delivering', 'DeliveryFailed').to(created.next,
    { ...event('DeliveryFailed', { message: 'the image would not boot', missingSecrets: null }), source: { kind: 'message', from: { machine: 'app-delivery', key: 'app:10' } } },
    facts, ctx);
  assert.equal(failed.next.name, 'deploy_failed');
  const told = (failed.writes || []).find((w) => w.type === 'botChange');
  assert.equal(told?.event, 'DeployFailed');
  assert.equal(told.payload.message, 'the image would not boot');
  const late = m.entryFor('deploy_failed', 'NotLiveYet').to(failed.next, { ...event('NotLiveYet', {}), source: { kind: 'timer' } }, facts,
    { ...ctx, now: new Date('2026-11-19T16:30:00Z') });
  const incident = (late.writes || []).find((w) => w.type === 'event');
  assert.equal(incident.eventType, 'platform_incident');
  assert.equal(incident.metadata.kind, 'merge_not_live');
  assert.equal(incident.metadata.hours, 7);
  const twice = m.entryFor('deploy_failed', 'NotLiveYet').to(late.next, { ...event('NotLiveYet', {}), source: { kind: 'timer' } }, facts, ctx);
  assert.ok(!twice.writes?.length, 'once');
});

// ── bot-voice: T1.8 ─────────────────────────────────────────────────────

test('T1.8: a held answer whose post ran out of tries is settled as failed, then owed once more', () => {
  const { botVoice, WORK } = require('../src/workflow/bot-voice/machine.ts');
  const m = botVoice();
  const place = { type: 'issue', ref: 12 };
  const key = 'held:301:going_ahead';
  const s = { name: 'quiet', data: { appId: 10, place, through: 0, first: null, again: false, turns: 0, sorry: false, taps: {},
    notes: { [key]: { kind: WORK.post, status: 'pending' } } } };
  const exhausted = m.entryFor('quiet', 'WorkExhausted').to(s,
    event('WorkExhausted', { kind: WORK.post, workKey: key, error: { message: 'GitHub said no' } }), { offer: null }, {});
  assert.equal(exhausted.next.data.notes[key].status, 'exhausted');
  assert.deepEqual(exhausted.writes, [{ type: 'heldPostFailed', appId: 10, issueNumber: 12, kind: 'going_ahead', mentionId: 301 }],
    'its pending row goes, so the refresh decides it again');
  const again = m.entryFor('quiet', 'HeldAnswer').to(exhausted.next,
    event('HeldAnswer', { appId: 10, place, kind: 'going_ahead', text: 'Going ahead.', mentionId: 301, mention: 'ada', mentions: [] }),
    { offer: null }, { now: new Date('2026-11-19T10:00:00Z'), key: 'place' });
  assert.equal(again.work[0].key, `${key}:again`, 'owed once more, under a key of its own');
  assert.equal(again.writes[0].type, 'heldPost', 'its row written pending again');
  const spent = { ...again.next, data: { ...again.next.data, notes: { ...again.next.data.notes, [`${key}:again`]: { kind: WORK.post, status: 'pending' } } } };
  const second = m.entryFor('quiet', 'WorkExhausted').to(spent,
    event('WorkExhausted', { kind: WORK.post, workKey: `${key}:again`, error: { message: 'no' } }), { offer: null }, {});
  assert.ok(!second.writes?.length, 'a second failure keeps its row, which reads as said');
});

// ── T1.11: what a stopped or failed turn did ────────────────────────────

test('T1.11: a reply that saved a live draft\'s changes is noted, and the fallback names what the turn did', () => {
  const stop = require('../src/services/homeroom-bot-stop');
  assert.equal(stop.NOTHING.has('reply'), false);
  const did = [];
  stop.noteDone(did, 'reply', { text: 'Done' }, { ok: false, error: 'x', applied: { saved: true } });
  assert.deepEqual(did, [{ did: 'saved a change to the live draft', stays: 'it stays in the draft' }]);
  assert.match(stop.stoppedText(did), /saved a change to the live draft/);
  const none = [];
  stop.noteDone(none, 'reply', { text: 'Hi' }, null);
  assert.deepEqual(none, [], 'a plain reply does nothing that lasts');
  stop.noteDone(did, 'start_request', { number: 12 }, { ok: true });
  assert.deepEqual(stop.doneSentences(did), ['I\'ve saved a change to the live draft.', 'I\'ve started work on request #12.']);
  assert.deepEqual(stop.doneSentences([{ did: 'withdrawn the X proposal' }], { skip: /^withdrawn / }), []);
});

// ── T1.13: unreviewed ───────────────────────────────────────────────────

test('T1.13: a change whose reviewer failed goes up for its vote saying it was not reviewed', () => {
  const review = require('../src/services/bot-review');
  const live = require('../src/services/homeroom-bot-live');
  assert.equal(review.unreviewedLine({ stop: 'ship', rounds: [] }), null);
  const none = review.unreviewedLine({ stop: review.STOPS.reviewerError, rounds: [{ round: 1 }] });
  assert.match(none, /^Not reviewed:/);
  const partly = review.unreviewedLine({ stop: review.STOPS.reviewerError, rounds: [{ round: 1, verdict: 'fix' }, { round: 2 }] });
  assert.match(partly, /^Not fully reviewed:/);
  assert.equal(live.withReviewNote('It adds dark mode.', none), `It adds dark mode.\n\n${none}`);
  assert.equal(live.withReviewNote(`It adds dark mode.\n\n${none}`, none), `It adds dark mode.\n\n${none}`, 'once');
  assert.equal(live.withReviewNote('It adds dark mode.', null), 'It adds dark mode.');
});

// ── T1.15: words that keep their promises ───────────────────────────────

test('T1.15: a failed build\'s Homeroom note names the Try again card under it; GitHub\'s keeps the reply', () => {
  const live = require('../src/services/homeroom-bot-live');
  const { firstPerson } = require('../src/services/homeroom-bot-words');
  const github = live.buildFailedText('the turn produced no change');
  assert.match(github, /Reply here \(or on the GitHub issue\) and it will try again\.$/);
  const homeroom = firstPerson(live.buildFailedText('the turn produced no change', { tapToRetry: true }));
  assert.match(homeroom, /Tap Try again under this, or reply with what to change\.$/);
  assert.equal(live.retryCardFits('the turn produced no change'), true);
  assert.equal(live.retryCardFits('the turn produced no change', { retrying: true }), false, 'already trying again by itself');
  const cards = require('../src/services/bot-cards');
  assert.equal(cards.offerActions('try_again', 9, { issueNumber: 12, restart: true })[0].label, 'Try again');
  assert.equal(cards.offerActions('try_again', 9, { sessionId: 5 })[0].label, 'Let it try again', 'the checks card keeps its words');
});

test('T1.15: the credit note is the bot\'s own words, and the vote opens once its checks are done', () => {
  const live = require('../src/services/homeroom-bot-live');
  const { firstPerson } = require('../src/services/homeroom-bot-words');
  assert.equal(firstPerson(live.buildCreditText()), 'I\'m out of building credit right now. I\'ll pick this up again by myself once credit is back.');
  assert.equal(live.proposalHomeroomText({ title: 'Dark mode' }), 'I built this: Dark mode. Its vote opens once its tests and screenshots are done.');
  assert.equal(live.proposalHomeroomText({}), 'I built this. Its vote opens once its tests and screenshots are done.');
});

test('T1.15: a yes is promised "I\'ll tell you here" only when a tell_me_when is stored', async () => {
  const voice = require('../src/services/homeroom-bot-voice');
  const pool = (rows) => ({ async query() { return { rows }; } });
  const args = { app: { id: 10 }, place: { type: 'issue', ref: 12 }, speaker: { id: 3 } };
  assert.equal(await voice.promiseWaiting(pool([{ '?column?': 1 }]), args), true);
  assert.equal(await voice.promiseWaiting(pool([]), args), false);
  assert.equal(await voice.promiseWaiting({ async query() { throw new Error('down'); } }, args), false, 'a failed read promises nothing');
  assert.equal(voice.AFFIRMED_PLAIN_TEXT, 'Thanks.');
});

test('T1.15: a build a newer plan was posted during, that failed, says what became of the plan', () => {
  const updates = require('../src/services/homeroom-bot-plan-updates');
  assert.equal(updates.unbuiltText({ poster: 'ada', version: 2, fromVersion: 1 }),
    '@ada, the build of v1 didn\'t finish, so there\'s no change to update to v2: nothing has been built from it yet.');
});

test('T1.15: a revise that failed asks for what to change, which is what a reply is read as', () => {
  const followup = require('../src/services/homeroom-bot-followup');
  assert.match(followup.revisionFailedText({ why: 'revise: the turn produced no change' }), /with what to change and it will try again\.$/);
});
