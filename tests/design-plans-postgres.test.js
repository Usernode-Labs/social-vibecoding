'use strict';

// Threads, one loop (phase C2): plans that post and build, against the FULL
// PostgreSQL schema in a throwaway database, through the real code
// (services/design-threads.js postDesignPlan, design-bot.js offer_plan,
// homeroom-bot-mayor.js's post_design card and settleOffer,
// request-specs.js personPlanOf, homeroom-bot.js actOnVerdict's ready
// branch, threads.js builtFrom, the Mayor's start_project_thread). GitHub,
// the model and the bot's queue are the fakes.
//
// What this pins:
//   1. A design posts as a plan on the request its thread is about (the
//      next version when it posts again), lifting the bot's wait for a
//      plan; a request that is not open takes nothing.
//   2. A design drawn from words (no capture) posts as one screen: an empty
//      state before, the design after; with no request, it files one.
//   3. "Looks good" is a card: Post as a plan on #N / Not yet on a thread
//      about a request, New request / Add to an existing request with none,
//      and the tap posts it, once.
//   4. A person's plan that is enough is what the bot builds (no plan of its
//      own); one that is not goes the complicated way with their words.
//   5. A change built from a plan names it on the thread's payload.
//   6. start_project_thread opens a thread for a new project from Main and
//      the turn's answer goes there.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/design-plans-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const CAPTURE = [
  '<!doctype html><html><head></head>',
  '<body class="app-body"><main id="screen"><h1 class="page-title">Plant list</h1>',
  '<button class="save">Save</button></main></body></html>',
].join('');
const DRAWN = [
  '<!doctype html><html><head><style>.water{background:#2563eb;color:#fff}</style></head>',
  '<body class="app-body"><main><h1 class="page-title">Watering</h1><ul class="plants"><li>Fern, every 3 days</li></ul>',
  '<button class="water">Water now</button><script>document.body.dataset.x=1</script></main></body></html>',
].join('');

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
      content: '', toolCalls: calls, assistantMessage: { role: 'assistant', content: null, tool_calls: calls },
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0 },
    };
  };
}

test('plans that post and build, against the full schema', { timeout: 180000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `design_plans_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  require('../src/db/pool').getPool = () => pool;
  const wsBus = require('../src/services/ws-bus');
  wsBus.publish = () => {};
  wsBus.publishBatched = () => {};
  const conversations = require('../src/services/conversations');
  const designs = require('../src/services/design-threads');
  const designBot = require('../src/services/design-bot');
  const mayor = require('../src/services/homeroom-bot-mayor');
  const dm = require('../src/services/homeroom-bot-dm');
  const specs = require('../src/services/request-specs');
  const homeroomBot = require('../src/services/homeroom-bot');
  const live = require('../src/services/homeroom-bot-live');
  const threads = require('../src/services/threads');

  async function user(username, { synthetic = false } = {}) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO users (username, password, is_synthetic, has_platform_access) VALUES ($1, 'x', $2, TRUE)
       RETURNING id, username`,
      [username, synthetic],
    );
    return { id: row.id, username: row.username, isAdmin: false };
  }
  const bot = await user('homeroom_bot', { synthetic: true });
  const ada = await user('dp_ada');
  const sam = await user('dp_sam');
  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Plant pal', 'dp-plant-pal', 'running', $1, 'https://github.com/usernode-bot/dp-plant-pal', 'public', 'public')
     RETURNING id`,
    [ada.id],
  );
  const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [inserted.id]);
  await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2)', [app.community_id, ada.id]);
  const config = { selfAppSlug: 'dp-plant-pal' };

  // The project's open requests, as GitHub (the platform's requests) says.
  const open = new Map([[12, 'Water reminders'], [13, 'Sort plants'], [14, 'Dark mode']]);
  let nextIssue = 40;
  const comments = [];
  const cards = [];
  const github = {
    isEnabled: () => true,
    safeMention: (s) => s,
    async createIssue(_o, _r, { title }) { nextIssue += 1; open.set(nextIssue, title); return { number: nextIssue }; },
    async createIssueComment(_o, _r, number, body) { comments.push({ number, body }); return { id: comments.length }; },
    async fetchPublicIssues() {
      return { issues: [...open].map(([number, title]) => ({ number, title, state: 'open' })), truncatedList: false };
    },
    async fetchPublicIssue(_o, _r, number) {
      return open.has(number) ? { issue: { number, title: open.get(number), state: 'open' } } : { issue: null, note: 'not found' };
    },
  };
  const ws = {
    sendSystemMessage: async () => null,
    sendBotMessage: async (_p, appId, message) => { cards.push({ appId, ...message }); return { id: cards.length }; },
    pushIssueUpdate: () => {},
    pushConversationEvent: () => 0,
  };
  const deps = { bot, github, ws, domain: 'example.test' };
  const lastSaid = async (rootId) => (await pool.query(
    'SELECT id, content, metadata FROM conversation_messages WHERE thread_root_id = $1 ORDER BY id DESC LIMIT 1', [rootId])).rows[0];

  // A design drawn from words, with no capture (C1 drafts these): its row,
  // its thread's line in Main, and version 1 by the bot.
  async function drawn(owner, title) {
    const line = await dm.sendDm(pool, { bot, userId: owner.id, content: `New thread, about ${title}.`, threadRootId: false, moment: null,
      metadata: { kind: 'opened_thread', changeKind: 'any' } });
    const { rows: [row] } = await pool.query(
      `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, kind, state)
       VALUES ($1, $2, $3, $4, 'design', 'open') RETURNING id`,
      [owner.id, line.conversationId, line.messageId, app.id],
    );
    await pool.query(
      `INSERT INTO design_threads (private_thread_id, title, surface, route, width, height) VALUES ($1, $2, 'app', NULL, 390, 844)`,
      [row.id, title],
    );
    await designs.addVersion(pool, { threadId: row.id, html: DRAWN, author: 'bot', note: 'A watering list' });
    return designs.designFor(pool, { userId: owner.id, rootId: line.messageId });
  }

  // A design drawn from words for a screen that has no project yet (C1
  // drafts these): app_id NULL, surface 'new'.
  async function drawnNew(owner, title) {
    const line = await dm.sendDm(pool, { bot, userId: owner.id, content: `New thread, about ${title}.`, threadRootId: false, moment: null,
      metadata: { kind: 'opened_thread', changeKind: 'any' } });
    const { rows: [row] } = await pool.query(
      `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, kind, state)
       VALUES ($1, $2, $3, NULL, 'design', 'open') RETURNING id`,
      [owner.id, line.conversationId, line.messageId],
    );
    await pool.query(
      `INSERT INTO design_threads (private_thread_id, title, surface, route, width, height) VALUES ($1, $2, 'new', NULL, 390, 844)`,
      [row.id, title],
    );
    await designs.addVersion(pool, { threadId: row.id, html: DRAWN, author: 'bot', note: 'A saved replies list' });
    return designs.designFor(pool, { userId: owner.id, rootId: line.messageId });
  }

  let about;
  await t.test('a design posts as a plan on the request its thread is about, and again as its next version', async () => {
    const opened = await designs.startDesign(pool, config, {
      user: ada, html: CAPTURE, surface: 'app', appSlug: app.slug, title: 'Plant list', width: 1280, height: 800, deps,
    });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    // Opened from request #12's page (phase B), by its requester: the bot waits for her plan.
    await pool.query(
      `UPDATE private_threads SET about_kind = 'request', about_number = 12, holds_bot = TRUE WHERE root_message_id = $1`,
      [opened.rootId],
    );
    about = await designs.designFor(pool, { userId: ada.id, rootId: opened.rootId });
    await designs.addVersion(pool, { threadId: about.threadId, html: CAPTURE.replace('Save', 'Save it'), author: 'bot', note: 'Clearer button' });
    about = await designs.designFor(pool, { userId: ada.id, rootId: opened.rootId });
    assert.equal(await designs.planTargetOf(pool, about), 12, 'the thread\'s request');

    const first = await designs.postDesignPlan(pool, config, { user: ada, rootId: about.rootId, issueNumber: 12, deps });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.deepEqual([first.state, first.number, first.version, first.planVersion], ['posted', 12, 2, 1]);
    const { rows: [row] } = await pool.query(
      'SELECT state, result_ref, hold_lifted_by, hold_lifted_at IS NOT NULL AS lifted FROM private_threads WHERE id = $1', [about.threadId]);
    assert.deepEqual(row, { state: 'posted', result_ref: 12, hold_lifted_by: 'plan', lifted: true }, 'posted, and the bot waits no more');
    const { rows: [spec] } = await pool.query(
      `SELECT spec_html FROM chat_sessions WHERE app_id = $1 AND created_from_issue_number = 12 AND source = 'request_spec' AND user_id = $2`,
      [app.id, ada.id],
    );
    assert.match(spec.spec_html, /<div data-side="before">[\s\S]*<button class="save">Save<\/button>/, 'the capture before');
    assert.match(spec.spec_html, /<div data-side="after" data-change="1">[\s\S]*Save it/, 'the version after');
    assert.equal(cards.at(-1).metadata.specShare.version, 1, 'its card on the request\'s thread');
    assert.match(comments.at(-1).body, /\[Read the plan on Homeroom\]\(https:\/\/example\.test\/#app\/dp-plant-pal\/dev\/issues\/12\)/);
    assert.equal((await lastSaid(about.rootId)).content, 'Posted version 2 as a plan on request #12 on Plant pal, under your name.');

    const again = await designs.postDesignPlan(pool, config, { user: ada, rootId: about.rootId, deps });
    assert.equal(again.ok, true);
    assert.equal(again.state, 'filed', 'with no number, a new request');
    // Back on #12 explicitly: the plan's next version there.
    await pool.query(`UPDATE private_threads SET state = 'posted', result_ref = 12 WHERE id = $1`, [about.threadId]);
    const next = await designs.postDesignPlan(pool, config, { user: ada, rootId: about.rootId, issueNumber: 12, deps });
    assert.deepEqual([next.ok, next.planVersion], [true, 2]);
    assert.match((await lastSaid(about.rootId)).content, /\(the plan's version 2\)\.$/);

    const closed = await designs.postDesignPlan(pool, config, { user: ada, rootId: about.rootId, issueNumber: 99, deps });
    assert.deepEqual([closed.ok, closed.status], [false, 404], 'a request that is not open takes nothing');
    assert.match(closed.error, /isn't open/);
    const notHers = await designs.postDesignPlan(pool, config, { user: sam, rootId: about.rootId, issueNumber: 12, deps });
    assert.equal(notHers.status, 404, 'nobody else posts her design');
  });

  let words;
  await t.test('a design drawn from words is one screen: an empty state before, the design after', async () => {
    words = await drawn(ada, 'Watering');
    assert.equal(await designs.planTargetOf(pool, words), null, 'about no request');
    const filed = await designs.postDesignPlan(pool, config, { user: ada, rootId: words.rootId, deps });
    assert.equal(filed.ok, true, JSON.stringify(filed));
    assert.equal(filed.state, 'filed');
    const { rows: [spec] } = await pool.query(
      `SELECT spec_html, spec_md FROM chat_sessions WHERE app_id = $1 AND created_from_issue_number = $2 AND source = 'request_spec'`,
      [app.id, filed.number],
    );
    assert.match(spec.spec_html, /<div data-side="before">[\s\S]*Watering is not there yet\./, 'nothing there today');
    assert.match(spec.spec_html, /<div data-side="after" data-change="1">[\s\S]*Water now/);
    assert.doesNotMatch(spec.spec_html, /<script/i, 'scripts left out');
    assert.match(spec.spec_md, /The screen is new/);
    const filedLine = await lastSaid(words.rootId);
    assert.equal(filedLine.content,
      `Filed it as request #${filed.number} on Plant pal, under your name, with version 1 as its plan.`);
    // #6151: what happens next, read off the new request's track. Homeroom
    // bot is off here, so nothing queued it and it has no track: a person
    // decides (tests/design-plans.test.js pins the other cases).
    assert.equal(filedLine.metadata.homeroomBot.kind, 'design_filed');
    assert.deepEqual(filedLine.metadata.homeroomBot.filedNext, { say: 'person' });
    const pure = designs.planHtml({ design: { width: 390, height: 844, title: 'Watering', route: null }, title: 'T', notes: '', before: null, after: DRAWN, version: 1 });
    assert.match(pure, /data-size="phone" data-height="844"/);
  });

  await t.test('"looks good" is a card the person taps, and the tap posts the plan once', async () => {
    const settings = { mode: 'shadow', perPerson: 2 };
    const ask = async (design, text) => (await conversations.sendMessage(pool, ada, design.conversationId, {
      content: text, thread_root_id: design.rootId,
    })).message;
    about = await designs.designFor(pool, { userId: ada.id, rootId: about.rootId });
    const message = await ask(about, 'looks good');
    const seen = [];
    const sent = await designBot.answer(pool, config, {
      bot, user: ada, settings, conversationId: about.conversationId, message, design: about,
      deps: { ...deps, apiKey: 'sk-test', chat: scripted([[['offer_plan', {}]], [['reply', { text: 'Tap below to post it on #12.' }]]], seen) },
    });
    assert.match(JSON.stringify(seen[1]), /Post as a plan on #12/, 'the model is told what the card says');
    const card = (await pool.query('SELECT content, thread_root_id, metadata FROM conversation_messages WHERE id = $1', [sent.messageId])).rows[0];
    assert.equal(card.thread_root_id, about.rootId, 'in the thread');
    assert.match(card.content, /^Tap below to post it on #12\.\n\n\*\*Plant pal\*\* · a plan on request #12: version 2 of Plant list$/);
    const meta = card.metadata.homeroomBot;
    assert.equal(meta.kind, 'confirm');
    assert.deepEqual(meta.actions.map((a) => [a.id, a.label, a.type]), [['yes', 'Post as a plan on #12', 'server'], ['no', 'Not yet', 'server']]);
    const { rows: [action] } = await pool.query('SELECT * FROM homeroom_bot_dm_actions WHERE id = $1', [meta.actionId]);
    assert.deepEqual([action.kind, action.source_issue_number, Number(action.private_thread_id), action.design_version, action.message_id],
      ['post_design', 12, about.threadId, 2, sent.messageId]);

    // The tap, decided in her DM machine and done by its work, here at once.
    const replies = {
      async tapDmAction(a) {
        await mayor.actOnTap(pool, config, { ...a, key: `action:${a.actionId}`, deps });
        return { ok: true };
      },
    };
    const before = (await specs.listRequestSpecs(pool, { appId: app.id, issueNumber: 12, viewerId: ada.id })).length;
    const tapped = await mayor.decideOfferTap(pool, config, { user: ada, actionId: meta.actionId, choice: 'yes', deps: { replies } });
    assert.deepEqual(tapped, { ok: true, choice: 'yes', label: 'Post as a plan on #12' });
    assert.equal((await specs.listRequestSpecs(pool, { appId: app.id, issueNumber: 12, viewerId: ada.id })).length, before + 1, 'posted');
    const after = (await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [sent.messageId])).rows[0].metadata.homeroomBot;
    assert.deepEqual([after.status, after.answer, after.chosen], ['answered', 'Post as a plan on #12', 'yes']);
    const { rows: [done] } = await pool.query('SELECT status, issue_number FROM homeroom_bot_dm_actions WHERE id = $1', [meta.actionId]);
    assert.deepEqual(done, { status: 'done', issue_number: 12 });
    const twice = await mayor.decideOfferTap(pool, config, { user: ada, actionId: meta.actionId, choice: 'yes', deps: { replies } });
    assert.deepEqual([twice.ok, twice.status], [false, 409]);

    // About no request: New request, or an existing one they name next.
    words = await designs.designFor(pool, { userId: ada.id, rootId: words.rootId });
    await pool.query(`UPDATE private_threads SET state = 'open', result_ref = NULL WHERE id = $1`, [words.threadId]);
    words = await designs.designFor(pool, { userId: ada.id, rootId: words.rootId });
    const plain = await designBot.answer(pool, config, {
      bot, user: ada, settings, conversationId: words.conversationId, message: await ask(words, 'perfect, post it'), design: words,
      deps: { ...deps, apiKey: 'sk-test', chat: scripted([[['offer_plan', {}]], [['reply', { text: 'Where should it go?' }]]]) },
    });
    const choices = (await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [plain.messageId])).rows[0].metadata.homeroomBot;
    assert.deepEqual(choices.actions.map((a) => [a.label, a.type, a.quote === true]),
      [['New request', 'server', false], ['Add to an existing request…', 'prompt', true]]);
    // A number they gave that is no open request is no card.
    const seenBad = [];
    const bad = await designBot.answer(pool, config, {
      bot, user: ada, settings, conversationId: words.conversationId, message: await ask(words, 'put it on #99'), design: words,
      deps: { ...deps, apiKey: 'sk-test', chat: scripted([[['offer_plan', { target: 'request', issueNumber: 99 }]], [['reply', { text: 'Which request?' }]]], seenBad) },
    });
    assert.match(JSON.stringify(seenBad[1]), /has no open request #99/);
    assert.equal((await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [bad.messageId])).rows[0].metadata?.homeroomBot?.actionId, undefined);
    // A design of a project is no new project.
    assert.equal(mayor.checkProjectOffer({ design: words, args: { name: 'Plant pal 2' } }).ok, false);
    assert.equal(mayor.checkProjectOffer({ design: { ...words, app: null }, args: { name: 'Watering can' } }).offer.name, 'Watering can');
  });

  await t.test('a design with no project is filed on a project they name', async () => {
    const idea = await drawnNew(ada, 'Saved replies');
    assert.equal(idea.app, null, 'no project yet');
    assert.equal(idea.surface, 'new');

    // No project named: the bot asks which one.
    const noName = await mayor.checkPlanOffer(pool, { user: ada, design: idea, args: {} });
    assert.equal(noName.ok, false);
    assert.match(noName.error, /^Which project should it go on\?/);

    // Named: the card on that project, exactly as a project's own design.
    const checked = await mayor.checkPlanOffer(pool, { user: ada, design: idea, args: { project: 'Plant pal' } });
    assert.equal(checked.ok, true, JSON.stringify(checked));
    assert.equal(Number(checked.offer.app.id), Number(app.id));
    const cardMessage = (await conversations.sendMessage(pool, ada, idea.conversationId, {
      content: 'under Plant pal', thread_root_id: idea.rootId,
    })).message;
    const sent = await mayor.sendDesignOffer(pool, {
      bot, user: ada, conversationId: idea.conversationId, message: cardMessage,
      design: idea, offer: checked.offer, key: 'test-new-project-offer', deps,
    });
    const card = (await pool.query('SELECT content, metadata FROM conversation_messages WHERE id = $1', [sent.messageId])).rows[0];
    assert.match(card.content, /^Want me to post this as a plan on Plant pal\?/);
    const meta = card.metadata.homeroomBot;
    assert.deepEqual(meta.actions.map((a) => [a.label, a.type]),
      [['New request', 'server'], ['Add to an existing request…', 'prompt']]);
    const { rows: [action] } = await pool.query('SELECT app_id, kind, design_version FROM homeroom_bot_dm_actions WHERE id = $1', [meta.actionId]);
    assert.deepEqual([Number(action.app_id), action.kind, action.design_version], [Number(app.id), 'post_design', 1]);

    // The tap files the request on that project, and the thread joins it.
    const replies = {
      async tapDmAction(a) {
        await mayor.actOnTap(pool, config, { ...a, key: `action:${a.actionId}`, deps });
        return { ok: true };
      },
    };
    const tapped = await mayor.decideOfferTap(pool, config, { user: ada, actionId: meta.actionId, choice: 'yes', deps: { replies } });
    assert.deepEqual(tapped, { ok: true, choice: 'yes', label: 'New request' });
    const filedLine = await lastSaid(idea.rootId);
    const number = Number(/request #(\d+)/.exec(filedLine.content)[1]);
    assert.match(filedLine.content, new RegExp(`^Filed it as request #${number} on Plant pal, under your name, with version 1 as its plan\\.`));
    const { rows: [spec] } = await pool.query(
      `SELECT spec_html FROM chat_sessions WHERE app_id = $1 AND created_from_issue_number = $2 AND source = 'request_spec'`,
      [app.id, number],
    );
    assert.match(spec.spec_html, /<div data-side="before">[\s\S]*Saved replies is not there yet\./, 'nothing there today');
    assert.match(spec.spec_html, /<div data-side="after" data-change="1">[\s\S]*Water now/);
    assert.match(spec.spec_html, /drawn with Homeroom's own stylesheets/);
    const { rows: [thread] } = await pool.query('SELECT app_id, state, result_ref FROM private_threads WHERE id = $1', [idea.threadId]);
    assert.deepEqual([Number(thread.app_id), thread.state, Number(thread.result_ref)], [Number(app.id), 'filed', number], 'the thread is attached');

    // A later version, no appId: designFor now knows the project.
    const later = await designs.designFor(pool, { userId: ada.id, rootId: idea.rootId });
    assert.equal(later.app.slug, app.slug);
    const again = await designs.postDesignPlan(pool, config, { user: ada, rootId: idea.rootId, deps });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(again.app.slug, app.slug, 'still on the project it was filed on');

    // A non-member naming it is told to join first.
    const samsIdea = await drawnNew(sam, 'Reminders');
    const sams = await mayor.checkPlanOffer(pool, { user: sam, design: samsIdea, args: { project: 'Plant pal' } });
    assert.equal(sams.ok, false);
    assert.match(sams.error, /join Plant pal before a plan can go on it/);
    const samPosted = await designs.postDesignPlan(pool, config, { user: sam, rootId: samsIdea.rootId, appId: app.id, deps });
    assert.deepEqual([samPosted.ok, samPosted.status, samPosted.code], [false, 403, 'join_required']);

    // A design that is a screen of a project posts there, and no other.
    const { rows: [other] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
       VALUES ('Fern friend', 'dp-fern-friend', 'running', $1, 'https://github.com/usernode-bot/dp-fern-friend', 'public', 'public')
       RETURNING id`,
      [ada.id],
    );
    assert.ok(other.id, 'a second project to name');
    const wrong = await mayor.checkPlanOffer(pool, { user: ada, design: words, args: { project: 'Fern friend' } });
    assert.equal(wrong.ok, false);
    assert.match(wrong.error, /This design is a screen of Plant pal, so it posts there\. Offer it without project\./);
    const same = await mayor.checkPlanOffer(pool, { user: ada, design: words, args: { project: 'Plant pal' } });
    assert.equal(same.ok, true, 'naming its own project falls through');
    assert.equal(Number(same.offer.app.id), Number(app.id));
  });

  await t.test('the bot builds from a person\'s plan that is enough, and plans from one that is not', async () => {
    const plan = await specs.personPlanOf(pool, { appId: app.id, issueNumber: 12 });
    assert.equal(plan.author, ada.username);
    assert.equal(plan.screens, 1);
    assert.equal(plan.enough, true);
    assert.equal(plan.version, 3, 'the newest version shared');
    // A thin plan, words only.
    await specs.postRequestSpec(pool, {
      app, repo: { owner: 'usernode-bot', repo: 'dp-plant-pal' }, issueNumber: 13, user: ada, text: '# Sort\n\nSort by name.',
    }, deps);
    const thin = await specs.personPlanOf(pool, { appId: app.id, issueNumber: 13 });
    assert.deepEqual([thin.screens, thin.enough], [0, false]);
    assert.equal(await specs.personPlanOf(pool, { appId: app.id, issueNumber: 14 }), null);

    const realSeen = live.advanceSeen;
    live.advanceSeen = async () => ({ advanced: false });
    t.after(() => { live.advanceSeen = realSeen; });
    const run = async (issueNumber) => (await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note) VALUES ($1, $2, 'live', 'ready', 'Build it.') RETURNING id`,
      [app.id, issueNumber])).rows[0].id;
    const act = (issueNumber, runId, parsed) => homeroomBot.actOnVerdict({
      pool, config, bot, app, repo: { owner: 'usernode-bot', repo: 'dp-plant-pal' }, issueNumber, issue: { title: open.get(issueNumber) },
      parsed: { verdict: 'ready', buildNote: 'Build it.', ...parsed }, capSuppressed: null, runId,
      seed: 's', seedReadAt: new Date().toISOString(), postedAt: [], turnBudgetMs: 1000, model: 'm',
      deps: { github, ws, threadContext: { async loadIssueThread() { return { messages: [] }; } } },
    });
    const built = await run(12);
    assert.equal(await act(12, built, { complicated: true }), 'build_queued', 'her plan is built as it is, even for a change the bot would plan first');
    const { rows: [r12] } = await pool.query('SELECT * FROM homeroom_bot_runs WHERE id = $1', [built]);
    assert.equal(r12.complicated, false);
    assert.equal(r12.build_spec_md, plan.markdown);
    assert.equal(r12.build_spec_html, plan.html);
    assert.deepEqual(r12.plan.fromPlan, { sessionId: plan.sessionId, version: 3, author: ada.username });
    assert.ok(r12.live_build_waiting_at, 'queued to build');

    const planned = await run(13);
    assert.equal(await act(13, planned, { complicated: false }), 'plan_queued', 'a thin plan: the bot writes its own from it, first');
    const { rows: [r13] } = await pool.query('SELECT complicated, build_note, build_spec_md FROM homeroom_bot_runs WHERE id = $1', [planned]);
    assert.equal(r13.complicated, true);
    assert.equal(r13.build_spec_md, null);
    assert.match(r13.build_note, /@dp_ada posted a plan on this request \(version 1\)\. Write your plan from it/);
    assert.match(r13.build_note, /<untrusted-content># Sort\n\nSort by name\.<\/untrusted-content>$/);

    const plain = await run(14);
    assert.equal(await act(14, plain, { complicated: false }), 'build_queued', 'no plan: as before');
    const { rows: [r14] } = await pool.query('SELECT plan, build_spec_md FROM homeroom_bot_runs WHERE id = $1', [plain]);
    assert.deepEqual([r14.plan, r14.build_spec_md], [null, null]);

    assert.equal(live.fromPlanHomeroomText({ author: 'dp_ada', version: 3 }), 'Building from @dp_ada\'s plan (version 3).');
    assert.equal(live.fromPlanCommentText({ author: 'dp_ada', version: 3 }), 'Homeroom bot is building this request from dp_ada\'s plan (version 3) now.');
  });

  await t.test('a change built from a plan names it on its thread\'s payload', async () => {
    const plan = await specs.personPlanOf(pool, { appId: app.id, issueNumber: 12 });
    const { rows: [thread] } = await pool.query(
      `INSERT INTO threads (app_id, number, kind, title) VALUES ($1, 12, 'work', 'Water reminders')
       ON CONFLICT (app_id, number) WHERE number IS NOT NULL DO UPDATE SET title = EXCLUDED.title RETURNING *`, [app.id]);
    await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, is_headless, created_from_issue_number, linked_issues, pr_number,
                                  session_title, thread_id, built_from_session_id, built_from_version, promoted_at)
       VALUES ($1, $2, 'promoted', FALSE, 12, ARRAY[12], 812, 'Water reminders', $3, $4, 3, NOW())`,
      [app.id, bot.id, thread.id, plan.sessionId],
    );
    const page = await threads.threadPage(pool, { thread, viewerId: ada.id });
    const change = page.items.find((i) => i.type === 'change' && i.number === 812);
    assert.deepEqual(change.builtFrom, { sessionId: plan.sessionId, version: 3 });
    assert.ok(!page.items.some((i) => i.type === 'change' && i.id === plan.sessionId), 'her plan is the request\'s plan, never a change');
  });

  await t.test('start_project_thread opens a thread for a new project, and the answer goes there', async () => {
    const opened = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
    const message = (await conversations.sendMessage(pool, ada, opened.conversationId, { content: 'I want an app to remind me to water plants' })).message;
    const settings = { ...(await homeroomBot.readSettings(pool)), mode: 'shadow' };
    const sent = await mayor.runDmTurn(pool, config, {
      bot, user: ada, settings, conversationId: opened.conversationId, message,
      deps: {
        apiKey: 'sk-test', seesImages: false, sleep: async () => {},
        openMcp: async () => { throw new Error('no platform tools here'); },
        chat: scripted([
          [['start_project_thread', { idea: 'a plant watering reminder' }]],
          [['reply', { text: 'Tell me what its first screen shows.' }]],
        ]),
      },
    });
    const { rows: [root] } = await pool.query(
      `SELECT id, content, thread_root_id, reply_to_id, metadata FROM conversation_messages
        WHERE conversation_id = $1 AND sender_id = $2 AND metadata->'homeroomBot'->>'changeKind' = 'project'`,
      [opened.conversationId, bot.id],
    );
    assert.equal(root.content, 'New thread, for a new project: a plant watering reminder. Only you can see it.');
    assert.equal(root.thread_root_id, null, 'one line in Main');
    assert.equal(root.reply_to_id, message.id, 'quoting what she said');
    assert.equal(root.metadata.homeroomBot.kind, 'opened_thread');
    const { rows: [row] } = await pool.query('SELECT kind, state, app_id FROM private_threads WHERE root_message_id = $1', [root.id]);
    assert.deepEqual(row, { kind: 'ask', state: 'open', app_id: null }, 'a thread with no project');
    const { rows: [answer] } = await pool.query('SELECT content, thread_root_id FROM conversation_messages WHERE id = $1', [sent.messageId]);
    assert.deepEqual(answer, { content: 'Tell me what its first screen shows.', thread_root_id: root.id }, 'the answer is the thread\'s first reply');
    const next = (await conversations.sendMessage(pool, ada, opened.conversationId, { content: 'a list of plants', thread_root_id: root.id })).message;
    const where = await dm.messageThread(pool, { userId: ada.id, conversationId: opened.conversationId, message: next });
    assert.equal(where.draft.changeKind, 'project', 'its turns know what it is for');
    assert.match(mayor.systemPrompt({ username: 'dp_ada', thread: where }), /the private thread you opened for a NEW project/);
  });

  await t.test('B01: a turn that opened a project thread and then gave no answer asks its question in the thread, once', async () => {
    const opened = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
    const message = (await conversations.sendMessage(pool, ada, opened.conversationId, { content: 'Can you make us a chore chart for our flat?' })).message;
    const settings = { ...(await homeroomBot.readSettings(pool)), mode: 'shadow' };
    let later = 0;
    const sent = await mayor.runDmTurn(pool, config, {
      bot, user: ada, settings, conversationId: opened.conversationId, message,
      deps: {
        apiKey: 'sk-test', seesImages: false, sleep: async () => {},
        onLater: () => { later += 1; },
        openMcp: async () => { throw new Error('no platform tools here'); },
        // The model opens the thread, then says nothing at all.
        chat: scripted([[['start_project_thread', { idea: 'a chore chart for our flat' }]], []]),
      },
    });
    const { rows } = await pool.query(
      `SELECT id, content, thread_root_id, reply_to_id FROM conversation_messages
        WHERE conversation_id = $1 AND sender_id = $2 AND id > $3 ORDER BY id`,
      [opened.conversationId, bot.id, message.id],
    );
    const inMain = rows.filter((r) => r.thread_root_id == null);
    assert.equal(inMain.length, 1, 'Main gets the thread\'s one line and nothing else');
    assert.match(inMain[0].content, /^New thread, for a new project: a chore chart for our flat/);
    const answer = rows.find((r) => Number(r.id) === Number(sent.messageId));
    assert.equal(Number(answer.thread_root_id), Number(inMain[0].id), 'the answer is in the new thread');
    assert.equal(answer.reply_to_id, null, 'quoting nothing');
    assert.match(answer.content, /What should the first screen show/);
    assert.doesNotMatch(answer.content, /come back|in a minute/i, 'no promise for later');
    assert.equal(later, 0, 'and no later try is owed');
  });
});
