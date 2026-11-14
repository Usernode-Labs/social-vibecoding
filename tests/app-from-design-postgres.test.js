'use strict';

// Threads, one loop (phase C2.4): a new project made from a design in a
// private thread, against the FULL PostgreSQL schema, through the real
// create route (POST /api/apps with `design`) and the first request's
// filing (homeroom-bot-dm.js fileFirstRequest). The project's setup, GitHub
// and realtime are the fakes; the bot's first-version calls are not made.
//
// What this pins:
//   1. Only the person's own design with no project yet makes one; its
//      brief is the design's title and notes, its early plan is ready from
//      the design and asks nothing, and its thread is the new project's.
//   2. The design's Make the project card gives way to what it made.
//   3. Its first request is filed with the design as its plan, one screen,
//      as its maker, so the bot builds the first version from it.

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
stub(require.resolve('../src/services/app-forker'), { forkApp: async () => {} });
stub(require.resolve('../src/services/caddy'), { productionHostname: (slug) => `${slug}.example.test`, USERNODE_DOMAIN: 'example.test' });
stub(require.resolve('../src/services/docker'), { getHostPort: async () => null });
stub(require.resolve('../src/services/github'), { parseGithubUrl: () => null, isEnabled: () => false, canActOn: () => false });
stub(require.resolve('../src/services/main-drift-poller'), { checkAndRedeployOne: async () => ({}) });
stub(require.resolve('../src/services/app-secrets'), {});
stub(require.resolve('../src/services/rename-pr'), {});
stub(require.resolve('../src/services/staging'), { MissingSecretsError: class extends Error {} });

let pool = null;
require('../src/db/pool').getPool = () => pool;
const wsBus = require('../src/services/ws-bus');
wsBus.publish = () => {};
wsBus.publishBatched = () => {};

const dm = require('../src/services/homeroom-bot-dm');
const designs = require('../src/services/design-threads');
const fvPlan = require('../src/services/first-version-plan');
const { appRoutes } = require('../src/routes/apps');
const { steps: makeSteps } = require('../src/workflow/kernel/steps.ts');

const DRAWN = [
  '<!doctype html><html><head><style>.water{background:#2563eb;color:#fff}</style></head>',
  '<body class="app-body"><main><h1>Watering</h1><ul><li>Fern, every 3 days</li></ul>',
  '<button class="water">Water now</button></main></body></html>',
].join('');

test('a project made from a design', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `app_from_design_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  pool = new Pool({ connectionString: String(url), max: 8 });
  let server;
  t.after(async () => {
    server?.close();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await pool.query(`INSERT INTO platform_settings (key, value) VALUES ('homeroom_bot_mode', 'shadow') ON CONFLICT (key) DO UPDATE SET value = 'shadow'`);

  async function person(username, { synthetic = false } = {}) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
      [username, synthetic],
    );
    return { id: row.id, username: row.username, isAdmin: false, canAdminWrite: true, hasPlatformAccess: true };
  }
  const bot = await person('homeroom_bot', { synthetic: true });
  const ada = await person('ad_ada');
  const sam = await person('ad_sam');

  // A design drawn for a project that does not exist yet (C1's drafting
  // writes these): its thread, its row with no project, version 1 and 2 by
  // the bot, and the design bot's Make the project card under them.
  // 14 Nov 2026: a line that opens a thread carries the thread's row with
  // it (sendDm `thread`), written in the message's own transaction.
  const line = await dm.sendDm(pool, { bot, userId: ada.id, content: 'New thread, for a new project: watering.', moment: null,
    thread: { kind: 'design' }, metadata: { kind: 'opened_thread', changeKind: 'project' } });
  const { rows: [row] } = await pool.query(
    'SELECT id FROM private_threads WHERE root_message_id = $1 AND user_id = $2', [line.messageId, ada.id]);
  await pool.query(`INSERT INTO design_threads (private_thread_id, title, surface, width, height) VALUES ($1, 'Watering', 'app', 390, 844)`, [row.id]);
  await designs.addVersion(pool, { threadId: row.id, html: DRAWN, author: 'bot', note: 'A list of plants' });
  await designs.addVersion(pool, { threadId: row.id, html: DRAWN.replace('Water now', 'Watered'), author: 'bot', note: 'A clearer button' });
  const card = await dm.sendDm(pool, {
    bot, userId: ada.id, content: 'Want to make Watering can from this design?', threadRootId: line.messageId, moment: null,
    metadata: {
      kind: 'make_offer', question: 'Make Watering can?', makeProject: { name: 'Watering can', rootId: line.messageId, version: 2 },
      actions: [{ id: 'make', label: 'Make the project', style: 'primary', type: 'make' }], status: 'open',
    },
  });

  const web = express();
  web.use(express.json());
  let signedIn = ada;
  web.use((req, _res, next) => { req.user = signedIn; next(); });
  web.use(appRoutes({ maxApps: 0 }));
  server = web.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body, as = ada) => {
    signedIn = as;
    const res = await fetch(`${base}/api/apps`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };

  let made;
  await t.test('only the person\'s own design with no project makes one', async () => {
    assert.equal((await post({ name: 'Watering can', design: { rootId: 'x' } })).status, 400);
    assert.equal((await post({ name: 'Watering can', design: { rootId: line.messageId } }, sam)).status, 404, 'nobody else\'s design');
    assert.equal((await post({ name: 'Watering can', design: { rootId: line.messageId, version: 9 } })).status, 404, 'no such version');
    const res = await post({ name: 'Watering can', audience: 'invited', brief: 'Watering can', from: 'design', design: { rootId: line.messageId, version: 2 } });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    made = res.data.app;
    const again = await post({ name: 'Watering can two', design: { rootId: line.messageId } });
    assert.equal(again.status, 409, 'a design makes one project');
  });

  await t.test('its first version is the design\'s: the brief, a ready plan that asks nothing, the thread', async () => {
    const { rows: [fv] } = await pool.query('SELECT * FROM homeroom_bot_first_versions WHERE app_id = $1', [made.id]);
    assert.equal(Number(fv.design_thread_id), Number(row.id));
    assert.equal(fv.design_version, 2);
    assert.match(fv.brief, /^Watering can\n\nIts first screen is "Watering", designed with Homeroom bot in a private thread \(version 2\)\./);
    assert.match(fv.brief, /- A list of plants\n- A clearer button$/);
    assert.equal(fv.early_plan_status, 'ready');
    assert.equal(fvPlan.planStatus(fv), 'ready');
    assert.equal(fvPlan.decided(fv), true, 'it asks nothing, so it is built at once');
    const { rows: [thread] } = await pool.query('SELECT app_id, state FROM private_threads WHERE id = $1', [row.id]);
    assert.deepEqual(thread, { app_id: made.id, state: 'filed' });
    const design = await designs.designFor(pool, { userId: ada.id, rootId: line.messageId });
    assert.equal(design.app.slug, made.slug, 'the design is a screen of the new project now');
    const meta = (await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [card.messageId])).rows[0].metadata.homeroomBot;
    assert.deepEqual([meta.status, meta.chosen, meta.madeSlug], ['answered', 'make', made.slug], 'the card says what it made');
  });

  await t.test('its first request is filed with the design as its plan, as its maker', async () => {
    await pool.query(`UPDATE apps SET repo_url = $2, status = 'running' WHERE id = $1`, [made.id, `https://github.com/usernode-bot/${made.slug}`]);
    const filed = new Map();
    const github = {
      isEnabled: () => true,
      safeMention: (s) => s,
      async createIssue(_o, _r, { title }) { filed.set(1, title); return { number: 1 }; },
      async createIssueComment() { return { id: 1 }; },
      async fetchPublicIssues() { return { issues: [...filed].map(([number, title]) => ({ number, title, state: 'open' })) }; },
      async findIssueByMarker() { return null; },
    };
    const posted = [];
    const ws = {
      sendSystemMessage: async () => null, pushIssueUpdate() {}, pushConversationEvent: () => 0,
      sendBotMessage: async (_p, _a, m) => { posted.push(m); return { id: posted.length }; },
    };
    const kept = { value: null };
    const out = await dm.fileFirstRequest(pool, {}, made.id, {
      steps: makeSteps({ resumeFrom: null, checkpoint: async (v) => { kept.value = v; } }),
      deps: { github, ws, bot, allowStaging: true, domain: 'example.test', notifications: {} },
    });
    assert.deepEqual(out, { issueNumber: 1 });
    assert.deepEqual(kept.value.design_plan, { posted: true, version: 1 }, 'a step of the filing, once');
    const { rows: [spec] } = await pool.query(
      `SELECT user_id, spec_html FROM chat_sessions WHERE app_id = $1 AND created_from_issue_number = 1 AND source = 'request_spec'`, [made.id]);
    assert.equal(spec.user_id, ada.id, 'posted as its maker');
    assert.match(spec.spec_html, /Watering is not there yet\./, 'one screen: nothing before');
    assert.match(spec.spec_html, /<div data-side="after" data-change="1">[\s\S]*Watered/, 'version 2 after');
    assert.equal(posted.at(-1).metadata.specShare.version, 1, 'its card on the request');
    const { rows: [thread] } = await pool.query('SELECT state, result_ref FROM private_threads WHERE id = $1', [row.id]);
    assert.deepEqual(thread, { state: 'filed', result_ref: 1 });
    const plan = await require('../src/services/request-specs').personPlanOf(pool, { appId: made.id, issueNumber: 1 });
    assert.equal(plan.enough, true, 'enough to build the first version from');
  });
});
