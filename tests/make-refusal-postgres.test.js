'use strict';

// #6900: a refused Make it from Homeroom bot's New project card tells the
// bot why, instead of letting it guess from my_projects. Against the FULL
// PostgreSQL schema, through the REAL create route (POST /api/apps with
// `thread.rootId`), for each limit that can refuse it:
//
//   1. The allowance check (403 app_allowance_exhausted): no_slots, slots.
//   2. The server-wide cap (429).
//   3. The hourly create limit (429 with retryAfterSeconds), which runs
//      before the route.
//
// and then what the bot does with it: its next turn in that thread is told
// Homeroom's own words, and a report filed there quotes them.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// The apps router's infrastructure is not what this is about.
stub(require.resolve('../src/services/ws'), {
  pushConversationEvent: () => 1, pushToUser: () => 1, pushNotificationToUser: () => 1,
  sendSystemMessage: async () => ({ id: 1 }), pushIssueUpdate() {}, sendBotMessage: async () => ({ id: 1 }), pushAppUpdate() {},
});
stub(require.resolve('../src/services/mobile-push'), { scheduleBadgeSync() { return false; } });
stub(require.resolve('../src/services/app-creator'), { createApp: async () => {} });
stub(require.resolve('../src/services/app-forker'), { forkApp: async () => {}, findForkSource: () => null });
stub(require.resolve('../src/services/caddy'), { productionHostname: (slug) => `${slug}.example.test`, USERNODE_DOMAIN: 'example.test' });
stub(require.resolve('../src/services/docker'), { getHostPort: async () => null });
const created = [];
stub(require.resolve('../src/services/github'), {
  parseGithubUrl: () => null, isEnabled: () => true, canActOn: () => false,
  async fetchPublicIssue(_owner, _repo, number) { return { issue: { number, title: `Issue ${number}`, state: 'open' } }; },
  async createIssue(owner, repo, { title, body, labels, createdBy }) {
    created.push({ owner, repo, title, body, labels, createdBy });
    return { number: 500 + created.length, title, html_url: `https://github.test/issues/${500 + created.length}` };
  },
  safeMention: (s) => s,
});
stub(require.resolve('../src/services/main-drift-poller'), { checkAndRedeployOne: async () => ({}) });
stub(require.resolve('../src/services/app-secrets'), {});
stub(require.resolve('../src/services/rename-pr'), {});
stub(require.resolve('../src/services/staging'), { MissingSecretsError: class extends Error {} });

let pool = null;
require('../src/db/pool').getPool = () => pool;
const wsBus = require('../src/services/ws-bus');
wsBus.publish = () => {};
wsBus.publishBatched = () => {};

const conversations = require('../src/services/conversations');
const dm = require('../src/services/homeroom-bot-dm');
const mayor = require('../src/services/homeroom-bot-mayor');
const homeroomBot = require('../src/services/homeroom-bot');
const { appRoutes } = require('../src/routes/apps');

const CONFIG = {
  maxApps: 0,
  openrouterApiBase: 'https://openrouter.test/api/v1',
  openrouterOrigin: 'https://test',
  openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash',
  platformRepoUrl: 'https://github.com/usernode-labs/social-vibecoding',
};

/** A scripted model: each call answers with the next step's tool calls. */
function scripted(steps, seen = []) {
  let i = 0;
  return async (request) => {
    seen.push(structuredClone(request.messages));
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    const calls = (typeof step === 'function' ? step(request) : step).map((c, n) => ({
      id: `call_${i}_${n}`, type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1] || {}) },
    }));
    return {
      content: '', toolCalls: calls,
      assistantMessage: { role: 'assistant', content: null, tool_calls: calls },
      usage: { inputTokens: 1000, outputTokens: 100, costUsd: 0.0021 },
    };
  };
}

function lastToolResult(request, name) {
  const msgs = request.messages;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i].role !== 'tool') continue;
    const call = msgs.slice(0, i).reverse().find((m) => m.tool_calls)?.tool_calls.find((c) => c.id === msgs[i].tool_call_id);
    if (!name || call?.function.name === name) return JSON.parse(msgs[i].content);
  }
  return null;
}

test('a refused Make it tells the bot why', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `make_refusal_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  pool = new Pool({ connectionString: String(url), max: 8 });
  let server = null;
  t.after(async () => {
    server?.close();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await pool.query(`INSERT INTO platform_settings (key, value) VALUES ('homeroom_bot_mode', 'shadow') ON CONFLICT (key) DO UPDATE SET value = 'shadow'`);

  let seq = 0;
  async function person(prefix, { quota = 5, synthetic = false } = {}) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic, app_quota)
       VALUES ($1, 'x', TRUE, $2, $3) RETURNING id, username`,
      [synthetic ? prefix : `${prefix}_${++seq}`, synthetic, quota],
    );
    return { id: row.id, username: row.username, isAdmin: false, canAdminWrite: false, hasPlatformAccess: true };
  }
  const bot = await person('homeroom_bot', { synthetic: true });
  const botRow = { id: bot.id, username: bot.username };

  // A private thread of this person's, opened as sendDm opens one (its row
  // written with the message). Resolves its root message id.
  async function threadFor(user) {
    const line = await dm.sendDm(pool, {
      bot: botRow, userId: user.id, content: 'Let\'s plan a project.', moment: null, thread: { kind: 'idea' },
    });
    return line.messageId;
  }

  const web = express();
  web.use(express.json());
  let signedIn = null;
  web.use((req, _res, next) => { req.user = signedIn; next(); });
  web.use(appRoutes(CONFIG));
  server = web.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body, as) => {
    signedIn = as;
    const res = await fetch(`${base}/api/apps`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  const stored = async (user, rootId) => {
    const { rows } = await pool.query(
      'SELECT last_make_refusal FROM private_threads WHERE root_message_id = $1 AND user_id = $2',
      [rootId, user.id],
    );
    return rows[0]?.last_make_refusal || null;
  };
  const activeApps = async () => Number((await pool.query(`SELECT COUNT(*)::int AS n FROM apps WHERE status <> 'error'`)).rows[0].n);

  const ada = await person('ada', { quota: 0 });
  const bea = await person('bea', { quota: 1 });
  const cy = await person('cy', { quota: 5 });
  const dana = await person('dana', { quota: 5 });
  const erin = await person('erin', { quota: 0 });
  const fred = await person('fred', { quota: 0 });
  const gina = await person('gina', { quota: 1 });

  let adaRoot = null;
  let adaRefusal = null;

  await t.test('no slots: the refusal is kept on the thread, the reply unchanged', async () => {
    adaRoot = await threadFor(ada);
    const res = await post({ name: 'PageTurnHers', audience: 'invited', brief: 'A site for my book club.', thread: { rootId: adaRoot } }, ada);
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'app_allowance_exhausted');
    assert.equal(res.data.reason, 'no_slots');
    const row = await stored(ada, adaRoot);
    assert.equal(row.reason, 'no_slots');
    assert.equal(row.status, 403);
    assert.equal(row.code, 'app_allowance_exhausted');
    assert.equal(row.error, res.data.error, 'Homeroom\'s own sentence, word for word');
    assert.equal(row.name, 'PageTurnHers');
    adaRefusal = row;
  });

  await t.test('slots used: the count is kept verbatim', async () => {
    const beaRoot = await threadFor(bea);
    await pool.query(
      `INSERT INTO apps (name, slug, status, created_by) VALUES ('Bea one', $1, 'running', $2)`,
      [`bea-one-${crypto.randomBytes(4).toString('hex')}`, bea.id],
    );
    const res = await post({ name: 'Bea two', audience: 'invited', brief: 'Another one.', thread: { rootId: beaRoot } }, bea);
    assert.equal(res.status, 403);
    assert.equal(res.data.reason, 'slots');
    const row = await stored(bea, beaRoot);
    assert.equal(row.reason, 'slots');
    assert.equal(row.error, res.data.error);
    assert.match(row.error, /^You have used 1 of 1 app slots\./);
    // What the bot is told: its own slots, and how they can get more.
    const note = await dm.makeRefusalNote(pool, { userId: bea.id, rootId: beaRoot });
    assert.match(note.line, /used all their app slots\./);
    assert.match(note.line, /ask for more from the app allowance panel/);
  });

  await t.test('server full: the cap\'s own sentence is kept', async () => {
    const cyRoot = await threadFor(cy);
    const used = await activeApps();
    CONFIG.maxApps = used;
    const res = await post({ name: 'Cy one', audience: 'invited', brief: 'Anything.', thread: { rootId: cyRoot } }, cy);
    CONFIG.maxApps = 0;
    assert.equal(res.status, 429);
    assert.match(res.data.error, /^This server is at its app limit \(\d+\)\. Ask an admin to remove an app or raise the limit\.$/);
    const row = await stored(cy, cyRoot);
    assert.equal(row.status, 429);
    assert.equal(row.reason, 'server_cap');
    assert.equal(row.error, res.data.error);
    const note = await dm.makeRefusalNote(pool, { userId: cy.id, rootId: cyRoot });
    assert.match(note.line, /server-wide limit for everyone, not their account/);
    assert.match(note.line, /only a Homeroom admin can remove an app or raise the limit/);
  });

  await t.test('the hourly create limit is kept too, from where it answers', async () => {
    const danaRoot = await threadFor(dana);
    let last = null;
    for (let i = 1; i <= 6; i += 1) {
      // The five the limit allows are ordinary creates; the sixth is the one
      // from the New project card, refused before the route ever reads it.
      last = await post({
        name: `Dana ${i}`, audience: 'invited', brief: `Number ${i}.`,
        ...(i === 6 ? { thread: { rootId: danaRoot } } : {}),
      }, dana);
      if (i < 6) assert.equal(last.status, 201, `create ${i} is not refused`);
    }
    assert.equal(last.status, 429);
    assert.ok(Number(last.data.retryAfterSeconds) > 0);
    assert.equal((await stored(dana, danaRoot)).reason, 'hourly', 'the five made no refusal; the sixth did');
    const row = await stored(dana, danaRoot);
    assert.equal(row.error, last.data.error);
    assert.equal(row.retryAfterSeconds, Number(last.data.retryAfterSeconds));
    // Nobody changes this one: it is a wait.
    const note = await dm.makeRefusalNote(pool, { userId: dana.id, rootId: danaRoot });
    assert.match(note.line, /five projects an hour per person\./);
    assert.match(note.line, /try again in about \d+ minutes?\./);
    assert.match(note.line, /was refused (just now|\d+ minutes? ago)/, 'and how long ago');
  });

  await t.test('a thread of another person, or none, records nothing for the caller', async () => {
    const fredRoot = await threadFor(fred);
    const before = await stored(ada, adaRoot);
    const res = await post({ name: 'Not mine', audience: 'invited', brief: 'Hers.', thread: { rootId: adaRoot } }, fred);
    assert.equal(res.status, 403);
    assert.deepEqual(await stored(ada, adaRoot), before, 'her own thread is untouched');
    assert.equal(await stored(fred, adaRoot), null, 'no row of his to write');
    await post({ name: 'No thread', audience: 'invited', brief: 'Nothing names a thread.' }, fred);
    assert.equal(await stored(fred, fredRoot), null, 'a create with no thread records nothing');
  });

  await t.test('a failed record changes nothing the person sees', async () => {
    const erinRoot = await threadFor(erin);
    const failing = {
      query: (sql, params) => (/UPDATE private_threads SET last_make_refusal/.test(sql)
        ? Promise.reject(new Error('the database is having a moment'))
        : pool.query(sql, params)),
    };
    const web2 = express();
    web2.use(express.json());
    let who = null;
    web2.use((req, _res, next) => { req.user = who; next(); });
    web2.use(appRoutes(CONFIG, { pool: failing }));
    const server2 = web2.listen(0, '127.0.0.1');
    await new Promise((resolve) => server2.once('listening', resolve));
    try {
      who = erin;
      const res = await fetch(`http://127.0.0.1:${server2.address().port}/api/apps`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'PageTurnHers', audience: 'invited', brief: 'A site for my book club.', thread: { rootId: erinRoot } }),
      });
      const data = await res.json();
      // The same refusal the unrecorded case gives this account (the same
      // allowance words): the record never decides what they are told.
      assert.equal(res.status, 403);
      assert.deepEqual(data, (await post({ name: 'PageTurnHers', audience: 'invited', brief: 'A site for my book club.' }, fred)).data);
      assert.equal(await stored(erin, erinRoot), null);
    } finally {
      server2.close();
    }
  });

  await t.test('a project made from the thread clears the refusal', async () => {
    const ginaRoot = await threadFor(gina);
    const used = await activeApps();
    CONFIG.maxApps = used;
    assert.equal((await post({ name: 'Gina one', audience: 'invited', brief: 'A first try.', thread: { rootId: ginaRoot } }, gina)).status, 429);
    CONFIG.maxApps = 0;
    assert.equal((await stored(gina, ginaRoot)).reason, 'server_cap');
    const made = await post({ name: 'Gina one', audience: 'invited', brief: 'A first try.', thread: { rootId: ginaRoot } }, gina);
    assert.equal(made.status, 201, JSON.stringify(made.data));
    assert.equal(await stored(gina, ginaRoot), null);
    assert.equal(await dm.makeRefusalNote(pool, { userId: gina.id, rootId: ginaRoot }), null);
  });

  await t.test('the bot\'s next turn is told the refusal, and its report quotes it', async () => {
    const opened = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
    const settings = await homeroomBot.readSettings(pool);
    const said = await conversations.sendMessage(pool, ada, opened.conversationId, {
      content: 'It said I made too many apps?', thread_root_id: adaRoot,
    });
    const message = said.message;
    const where = await dm.threadDeps(pool, { userId: ada.id, conversationId: opened.conversationId, message });
    assert.equal(where.threadRootId, adaRoot);
    const seen = [];
    let report = null;
    const chat = scripted([
      [[
        'report_problem',
        { summary: 'Make it was refused with a limit message', details: 'I tapped Make it and it was refused.' },
      ]],
      (req) => {
        report = lastToolResult(req, 'report_problem');
        return [['reply', { text: 'I\'ve told the team.' }]];
      },
    ], seen);
    await mayor.runDmTurn(pool, CONFIG, {
      bot: botRow, user: ada, settings, conversationId: opened.conversationId, message,
      deps: { chat, apiKey: 'sk-test', sleep: async () => {}, seesImages: false, openMcp: async () => null, ...where },
    });
    // 1. The turn is told, before it answers, in Homeroom's own words.
    const system = seen[0].filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
    assert.match(system, /Make it on "PageTurnHers" in this thread was refused (just now|\d+ minutes? ago)\./);
    assert.match(system, new RegExp(adaRefusal.error.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(system, /Their account has no app slots\. A Homeroom admin can give it some\./);
    assert.match(system, /do not guess the cause from my_projects/);

    // 2. The report quotes the refusal, without the thread's private name.
    assert.equal(report?.ok, true);
    const body = created.at(-1).body;
    assert.match(body, /\*\*Make it was refused\*\* \(HTTP 403, no_slots\) at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC:$/m);
    assert.ok(body.includes(`> ${adaRefusal.error}`), 'the server\'s sentence, word for word');
    assert.doesNotMatch(body, /PageTurnHers/, 'the private thread\'s project is not in the public issue');
    const { rows: receipts } = await pool.query(
      `SELECT description FROM feedback_reports WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [ada.id],
    );
    assert.match(receipts[0].description, /\*\*Make it was refused on "PageTurnHers"\*\*/);
    assert.ok(receipts[0].description.includes(`> ${adaRefusal.error}`));
  });
});
