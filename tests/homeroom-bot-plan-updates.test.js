'use strict';

// A newer plan posted while Homeroom bot builds, or after its change is up
// for a vote (#6406): services/homeroom-bot-plan-updates.js, the change's
// plan line (services/threads.js builtFrom.newer), and the words the bot says.
//
// What these pin:
//   1. A newer plan stops the run waiting for a build and is the one built.
//   2. While the bot builds, it says so and queues nothing yet.
//   3. Once up for a vote, it says so and queues the update through the
//      voice's own ask path (recordAsk), naming the change by its number.
//   4. Somebody other than the requester or the plan's author changes
//      nothing: the bot asks the requester.
//   5. The same words reposted are not newer, and a line is said once.
//   6. The change's plan line knows a newer version exists.
//
// Run with: node --test tests/homeroom-bot-plan-updates.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const planUpdates = require('../src/services/homeroom-bot-plan-updates');
const threads = require('../src/services/threads');

const BOT = { id: 99, username: 'homeroom-bot' };
const APP = { id: 9, slug: 'recipe-bot' };

function fakePool(cfg = {}) {
  const calls = [];
  const query = async (sql, params = []) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    // Step 4: a line is one post, claimed by its key (services/bot-post.js):
    // one said before answers what it said.
    if (/INSERT INTO bot_posts/.test(text)) {
      return { rows: [cfg.existingLine ? { id: 1, fresh: false, outcome: 'said', chat_message_id: cfg.existingLine } : { id: 1, fresh: true, outcome: 'pending' }] };
    }
    if (/SELECT id, mode, verdict, build_ok, build_session_id, proposal_session_id, plan/.test(text)) {
      return { rows: cfg.run ? [cfg.run] : [] };
    }
    if (/FROM homeroom_bot_runs r JOIN chat_sessions cs ON cs.id = r.proposal_session_id/.test(text)) {
      return { rows: cfg.promoted ? [cfg.promoted] : [] };
    }
    if (/built_from_session_id, cs\.built_from_version/.test(text)) {
      return { rows: cfg.built ? [cfg.built] : [] };
    }
    if (/SELECT id, status, pr_number FROM chat_sessions WHERE id = \$1/.test(text)) {
      return { rows: cfg.change ? [cfg.change] : [] };
    }
    if (/SELECT user_id FROM chat_sessions WHERE id = \$1/.test(text)) {
      return { rows: [{ user_id: cfg.authorId == null ? 7 : cfg.authorId }] };
    }
    if (/SELECT content FROM chat_session_specs/.test(text)) {
      return { rows: cfg.builtContent == null ? [] : [{ content: cfg.builtContent }] };
    }
    if (/SELECT created_by FROM requests/.test(text)) {
      return { rows: [{ created_by: cfg.createdBy || null }] };
    }
    if (/FROM chat_session_specs s\s+JOIN chat_sessions cs ON cs\.id = s\.session_id/.test(text)) {
      return { rows: cfg.personPlanRows || [] };
    }
    return { rows: [] };
  };
  return { calls, query };
}

function deps(cfg = {}) {
  const sent = [];
  const asks = [];
  let nextId = 100;
  return {
    sent,
    asks,
    ws: {
      async sendBotMessage(pool, appId, msg) {
        sent.push({ appId, ...msg });
        return { id: nextId++ };
      },
    },
    dm: {
      async requesterOf() { return cfg.requester === undefined ? { userId: 7, username: 'evan' } : cfg.requester; },
      async botAccount() { return BOT; },
    },
    voice: {
      async recordAsk(pool, args) { asks.push(args); return { id: 900 }; },
    },
    botModule: { async usePersonPlan() { return cfg.swap || null; } },
  };
}

const v2 = {
  sessionId: 5, version: 2, author: 'evan', authorId: 7, markdown: 'new words', html: null, screens: 1, enough: true,
};

// ── 1. Waiting: the newer plan replaces the old one ────────────────────

test('a newer plan before the build starts replaces it and is said', async () => {
  const pool = fakePool({
    run: {
      id: 1, build_ok: null, build_session_id: null, proposal_session_id: null,
      plan: { fromPlan: { sessionId: 5, version: 1, author: 'evan' } },
    },
    builtContent: 'old words',
  });
  const d = deps({ requester: { userId: 7, username: 'evan' }, swap: { use: 'build', fromPlan: { sessionId: 5, version: 2 } } });
  const out = await planUpdates.noticeNewerPlan(pool, {
    app: APP, issueNumber: 177, posted: { sessionId: 5, version: 2, user: { id: 7, username: 'evan' } },
  }, { ...d, requestSpecs: { personPlanOf: async () => v2 } });
  assert.equal(out.acted, 'swapped');
  assert.equal(d.sent.length, 1);
  assert.equal(d.sent[0].content, 'You posted v2 before I started: I\'ll build from v2 instead of v1.');
  assert.deepEqual(d.sent[0].thread, { type: 'issue', ref: 177 });
  assert.equal(d.sent[0].metadata.homeroomBot.stage, 'waiting');
});

// ── 2. Building: noticed at once, nothing queued yet ───────────────────

test('a newer plan while building is said at once, and no update is queued yet', async () => {
  const pool = fakePool({
    run: {
      id: 2, build_ok: null, build_session_id: 44, proposal_session_id: null,
      plan: { fromPlan: { sessionId: 5, version: 1, author: 'evan' } },
    },
    change: { id: 44, status: 'active', pr_number: 178 },
  });
  const d = deps({ requester: { userId: 7, username: 'evan' } });
  const out = await planUpdates.noticeNewerPlan(pool, {
    app: APP, issueNumber: 177, posted: { sessionId: 5, version: 2, user: { id: 7, username: 'evan' } },
  }, { ...d, requestSpecs: { personPlanOf: async () => v2 } });
  assert.equal(out.acted, 'noticed');
  assert.equal(d.sent[0].content, '@evan, you posted v2 while I was building v1. I\'ll finish it, then update the change to follow v2.');
  assert.equal(d.asks.length, 0, 'the update waits for the change to be up');
});

test('somebody else\'s newer plan while building asks the requester, and changes nothing', async () => {
  const pool = fakePool({
    run: {
      id: 3, build_ok: null, build_session_id: 44, proposal_session_id: null,
      plan: { fromPlan: { sessionId: 5, version: 1, author: 'evan' } },
    },
    change: { id: 44, status: 'active', pr_number: 178 },
    requester: { userId: 7, username: 'evan' },
  });
  const d = deps({ requester: { userId: 7, username: 'evan' } });
  const ana = { ...v2, author: 'ana', authorId: 8 };
  const out = await planUpdates.noticeNewerPlan(pool, {
    app: APP, issueNumber: 177, posted: { sessionId: 5, version: 2, user: { id: 8, username: 'ana' } },
  }, { ...d, requestSpecs: { personPlanOf: async () => ana } });
  assert.equal(out.acted, 'asked');
  assert.equal(d.sent[0].content,
    '@evan, @ana posted a newer plan than the one I\'m building. Want me to update the change to follow it? Reply here and I will.');
  assert.equal(d.asks.length, 0);
});

// ── 3. Up for a vote: say so and queue the update ──────────────────────

test('a newer plan on a change up for a vote queues its update, naming Change #178', async () => {
  const pool = fakePool({
    run: {
      id: 4, build_ok: true, build_session_id: 44, proposal_session_id: 44,
      plan: { fromPlan: { sessionId: 5, version: 1, author: 'evan' } },
    },
    promoted: { id: 44, status: 'promoted', pr_number: 178 },
    change: { id: 44, status: 'promoted', pr_number: 178 },
    built: { built_from_session_id: 5, built_from_version: 1, built_from_author: 'evan' },
  });
  const d = deps({ requester: { userId: 7, username: 'evan' } });
  const out = await planUpdates.noticeNewerPlan(pool, {
    app: APP, issueNumber: 177, posted: { sessionId: 5, version: 2, user: { id: 7, username: 'evan' } },
  }, { ...d, requestSpecs: { personPlanOf: async () => v2 } });
  assert.equal(out.followed, true);
  assert.equal(d.sent[0].content,
    '@evan, Change #178 is built from v1 and you posted v2. I\'ve queued its update to v2: its votes clear when the update lands.');
  assert.equal(d.asks.length, 1);
  assert.equal(d.asks[0].sessionId, 44);
  assert.equal(d.asks[0].source, 'issue');
  assert.equal(d.asks[0].force, true);
  assert.equal(d.asks[0].queueReason, 'plan_update');
  assert.equal(d.asks[0].messageId, 100, 'the line\'s id makes the ask idempotent');
  assert.match(d.asks[0].instruction, /plan version 2/);
});

test('the same words reposted are not a newer plan', async () => {
  const pool = fakePool({
    run: {
      id: 5, build_ok: true, build_session_id: 44, proposal_session_id: 44,
      plan: { fromPlan: { sessionId: 5, version: 1, author: 'evan' } },
    },
    promoted: { id: 44, status: 'promoted', pr_number: 178 },
    change: { id: 44, status: 'promoted', pr_number: 178 },
    built: { built_from_session_id: 5, built_from_version: 1, built_from_author: 'evan' },
    builtContent: 'new words',
  });
  const d = deps({ requester: { userId: 7, username: 'evan' } });
  const out = await planUpdates.noticeNewerPlan(pool, {
    app: APP, issueNumber: 177, posted: { sessionId: 5, version: 2, user: { id: 7, username: 'evan' } },
  }, { ...d, requestSpecs: { personPlanOf: async () => v2 } });
  assert.equal(out, null);
  assert.equal(d.sent.length, 0);
  assert.equal(d.asks.length, 0);
});

test('a line already said for this version is not said again', async () => {
  const pool = fakePool({
    run: {
      id: 6, build_ok: null, build_session_id: 44, proposal_session_id: null,
      plan: { fromPlan: { sessionId: 5, version: 1, author: 'evan' } },
    },
    change: { id: 44, status: 'active', pr_number: 178 },
    existingLine: 777,
  });
  const d = deps({ requester: { userId: 7, username: 'evan' } });
  await planUpdates.noticeNewerPlan(pool, {
    app: APP, issueNumber: 177, posted: { sessionId: 5, version: 2, user: { id: 7, username: 'evan' } },
  }, { ...d, requestSpecs: { personPlanOf: async () => v2 } });
  assert.equal(d.sent.length, 0, 'the same version gets one line');
});

// ── 4. The words themselves ────────────────────────────────────────────

test('the lines say the change by its number, never an internal id or a clock time', () => {
  const lines = [
    planUpdates.waitingText({ version: 2, fromVersion: 1 }),
    planUpdates.buildingText({ poster: 'evan', version: 2, fromVersion: 1 }),
    planUpdates.queuedText({ author: 'evan', pr: 178, version: 2, fromVersion: 1 }),
    planUpdates.queuedText({ author: 'evan', pr: null, version: 2, fromVersion: 1, building: true }),
    planUpdates.askRequesterText({ requester: 'evan', poster: 'ana', pr: 178 }),
  ];
  for (const line of lines) {
    assert.doesNotMatch(line, /—/, 'no em dash');
    assert.doesNotMatch(line, /\b\d{1,2}:\d{2}\b/, 'no clock time');
    assert.doesNotMatch(line, /change 1\d{3,}/, 'never the internal id');
  }
  assert.match(lines[2], /Change #178/);
  assert.match(lines[3], /the change is built from v1/);
});

// ── 5. The change's plan line ──────────────────────────────────────────

test('threadPage marks a change whose plan has a newer version', async () => {
  const pool = fakePool({
    personPlanRows: [{
      session_id: 5, version: 2, content: 'new words', content_html: null, user_id: 7, username: 'evan',
    }],
  });
  const query = pool.query;
  pool.query = async (sql, params) => {
    const text = String(sql);
    if (/SELECT 'request' AS type/.test(text)) {
      return {
        rows: [{
          type: 'change', id: 44, number: 178, title: 'Design', status: 'promoted', created_at: '2026-11-06T14:33:00Z',
          replies: 0, author: 'evan', author_bot: false, user_id: 7, shared_at: null,
          built_from_session_id: 5, built_from_version: 1, closes: [177], epoch: 1, my_vote: null, ready: false, live_at: null,
        }],
      };
    }
    if (/SELECT f\.thread_type/.test(text)) return { rows: [] };
    if (/FROM chat_sessions cs\s+JOIN threads t/.test(text)) return { rows: [] };
    return query(sql, params);
  };
  const page = await threads.threadPage(pool, {
    thread: { id: 1, number: 177, kind: 'work', title: 'Design: Recipe home', state: 'open', app_id: 9 },
    viewerId: null,
  });
  const change = page.items.find((i) => i.type === 'change');
  assert.deepEqual(change.builtFrom, {
    sessionId: 5, version: 1, newer: { version: 2, author: 'evan', sameAuthor: true },
  });
});

test('threadPage leaves no newer note when the built-from version is the newest', async () => {
  const pool = fakePool({
    personPlanRows: [{
      session_id: 5, version: 1, content: 'old words', content_html: null, user_id: 7, username: 'evan',
    }],
  });
  const query = pool.query;
  pool.query = async (sql, params) => {
    const text = String(sql);
    if (/SELECT 'request' AS type/.test(text)) {
      return {
        rows: [{
          type: 'change', id: 44, number: 178, title: 'Design', status: 'promoted', created_at: '2026-11-06T14:33:00Z',
          replies: 0, author: 'evan', author_bot: false, user_id: 7, shared_at: null,
          built_from_session_id: 5, built_from_version: 1, closes: [177], epoch: 1, my_vote: null, ready: false, live_at: null,
        }],
      };
    }
    if (/SELECT f\.thread_type/.test(text)) return { rows: [] };
    if (/FROM chat_sessions cs\s+JOIN threads t/.test(text)) return { rows: [] };
    return query(sql, params);
  };
  const page = await threads.threadPage(pool, {
    thread: { id: 1, number: 177, kind: 'work', title: 'Design: Recipe home', state: 'open', app_id: 9 },
    viewerId: null,
  });
  const change = page.items.find((i) => i.type === 'change');
  assert.equal(change.builtFrom.version, 1);
  assert.equal(change.builtFrom.newer, undefined);
});
