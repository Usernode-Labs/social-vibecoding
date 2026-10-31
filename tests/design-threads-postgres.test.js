'use strict';

// #6071: design threads, against the FULL PostgreSQL schema in a throwaway
// database, through the real code (services/design-threads.js,
// services/design-bot.js over homeroom-bot-mayor.js's engine and
// homeroom-bot-dm.js sendDm, request-specs.js). GitHub and the model are the
// fakes.
//
// What this pins:
//   1. A captured screen opens a design thread: the bot's line in Main, the
//      private_threads row (kind 'design'), the capture as version 1, and
//      the thread's first reply saying it.
//   2. It is its owner's alone: nobody else reads it, its versions, or pins
//      a comment on it; a pin's point is checked and kept to its fields.
//   3. The bot edits it at their word: exact find-and-replace edits make the
//      next version, said in the thread; an edit that does not apply is told
//      to the model and changes nothing; a pinned comment reaches the model
//      with the element under it.
//   4. Propose it files a request with the before and after screens as its
//      plan, scripts left out, once; a project they have not joined answers
//      join_required.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/design-threads-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const CAPTURE = [
  '<!doctype html>',
  '<html><head><link rel="stylesheet" href="https://app.test/css/app.css"></head>',
  '<body class="app-body"><main id="screen"><h1 class="page-title">Plant list</h1>',
  '<button class="save">Save</button></main></body></html>',
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
    return { content: '', toolCalls: calls, usage: { inputTokens: 100, outputTokens: 20, costUsd: 0 } };
  };
}

test('design threads against the full schema', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `design_threads_${crypto.randomBytes(6).toString('hex')}`;
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
  require('../src/services/app-numbers').setPool?.(pool);
  const wsBus = require('../src/services/ws-bus');
  wsBus.publish = () => {};
  wsBus.publishBatched = () => {};
  const conversations = require('../src/services/conversations');
  const designs = require('../src/services/design-threads');
  const designBot = require('../src/services/design-bot');

  async function user(username, { synthetic = false } = {}) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO users (username, password, is_synthetic, has_platform_access) VALUES ($1, 'x', $2, TRUE)
       RETURNING id, username`,
      [username, synthetic],
    );
    return { id: row.id, username: row.username, isAdmin: false };
  }
  const bot = await user('homeroom_bot', { synthetic: true });
  const ada = await user('dt_ada');
  const sam = await user('dt_sam');
  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Plant pal', 'dt-plant-pal', 'running', $1, 'https://github.com/usernode-bot/dt-plant-pal', 'public', 'public')
     RETURNING id`,
    [ada.id],
  );
  const { rows: [app] } = await pool.query('SELECT id, slug, community_id FROM apps WHERE id = $1', [inserted.id]);
  await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2)', [app.community_id, ada.id]);
  // Homeroom's own pages are the self app's: the same app, for this test.
  const config = { selfAppSlug: 'dt-plant-pal' };

  let nextIssue = 70;
  const comments = [];
  const deps = {
    bot,
    github: {
      isEnabled: () => true,
      safeMention: (s) => s,
      async createIssue() { nextIssue += 1; return { number: nextIssue }; },
      async createIssueComment(owner, repo, number, body) { comments.push({ number, body }); return { id: 1 }; },
    },
    ws: {
      sendSystemMessage: async () => null, sendBotMessage: async () => ({ id: 1 }), pushIssueUpdate: () => {},
      pushConversationEvent: () => 0,
    },
  };

  let design;
  await t.test('a captured screen opens a design thread, its capture version 1', async () => {
    const opened = await designs.startDesign(pool, config, {
      user: ada, html: CAPTURE, surface: 'platform', title: 'Plant list', route: '#app/dt-plant-pal/app',
      width: 1280, height: 800, deps,
    });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.match(opened.href, new RegExp(`^#messages/${opened.conversationId}/thread/${opened.rootId}$`));
    const { rows: [line] } = await pool.query('SELECT sender_id, content, thread_root_id, metadata FROM conversation_messages WHERE id = $1', [opened.rootId]);
    assert.equal(line.sender_id, bot.id);
    assert.equal(line.thread_root_id, null, 'in Main');
    assert.equal(line.metadata.homeroomBot.kind, 'opened_design');
    assert.match(line.content, /^I opened a design thread for Plant list, in a thread only you can see\./);
    const { rows: [row] } = await pool.query('SELECT kind, state, app_id FROM private_threads WHERE root_message_id = $1', [opened.rootId]);
    assert.deepEqual(row, { kind: 'design', state: 'open', app_id: app.id });
    design = await designs.designFor(pool, { userId: ada.id, rootId: opened.rootId });
    assert.deepEqual([design.title, design.surface, design.width, design.height, design.latest], ['Plant list', 'platform', 1280, 800, 1]);
    assert.equal(design.versions[0].author, 'capture');
    const { rows: [first] } = await pool.query(
      'SELECT content, metadata FROM conversation_messages WHERE thread_root_id = $1 ORDER BY id LIMIT 1', [opened.rootId]);
    assert.match(first.content, /^Version 1: Plant list as it is now\. What should change\?$/);
    assert.equal(first.metadata.homeroomBot.designVersion, 1);
    assert.equal(design.versions[0].messageId != null, true, 'the version names the message that said it');
    // Nothing too big, or with nothing in it, opens one.
    const big = await designs.startDesign(pool, config, {
      user: ada, html: 'x'.repeat(designs.MAX_HTML_BYTES + 1), surface: 'platform', title: 'Big', width: 1280, height: 800, deps,
    });
    assert.equal(big.status, 413);
  });

  await t.test('it is its owner\'s alone, and a pin is checked', async () => {
    assert.equal(await designs.designFor(pool, { userId: sam.id, rootId: design.rootId }), null);
    assert.equal(await designs.versionOf(pool, { userId: sam.id, rootId: design.rootId }), null);
    assert.equal((await designs.versionOf(pool, { userId: ada.id, rootId: design.rootId })).html, CAPTURE);
    const pin = await designs.pinFor(pool, {
      user: ada, conversationId: design.conversationId, threadRootId: design.rootId,
      pin: { version: 1, x: 0.123456, y: 0.5, element: { tag: 'button', id: '', text: 'Save', extra: 'dropped' } },
    });
    assert.deepEqual(pin, { version: 1, x: 0.1235, y: 0.5, element: { tag: 'button', id: '', text: 'Save' } });
    for (const bad of [{ version: 2, x: 0.1, y: 0.1 }, { version: 1, x: 2, y: 0.1 }, null, 'x']) {
      assert.equal(await designs.pinFor(pool, { user: ada, conversationId: design.conversationId, threadRootId: design.rootId, pin: bad }), null);
    }
    assert.equal(await designs.pinFor(pool, {
      user: sam, conversationId: design.conversationId, threadRootId: design.rootId, pin: { version: 1, x: 0.1, y: 0.1 },
    }), null, 'nobody else pins on it');
  });

  await t.test('the bot edits it at their word: each turn\'s edits are the next version', async () => {
    const settings = { mode: 'on', perPerson: 2 };
    const asked = await conversations.sendMessage(pool, ada, design.conversationId, {
      content: 'make the save button green', thread_root_id: design.rootId,
    }, { metadata: { designPin: { version: 1, x: 0.2, y: 0.4, element: { tag: 'button', id: '', text: 'Save' } } } });
    const message = asked.message;
    assert.equal((await designs.threadOf(pool, { userId: ada.id, conversationId: design.conversationId, message })).rootId, design.rootId);
    const seen = [];
    const sent = await designBot.answer(pool, config, {
      bot, user: ada, settings, conversationId: design.conversationId, message, design,
      deps: {
        ...deps, apiKey: 'sk-test',
        chat: scripted([
          [['edit_design', { edits: [{ find: 'not in it', replace: 'x' }], note: 'nothing' }]],
          [['edit_design', { edits: [{ find: '<button class="save">', replace: '<button class="save" style="background:#16a34a">' }], note: 'A green Save button' }]],
          [['reply', { text: 'Done: Save is green now.' }]],
        ], seen),
      },
    });
    const prompt = seen[0][0].content;
    assert.match(prompt, /THE CURRENT VERSION \(version 1\), its whole HTML:\n<!doctype html>/);
    assert.match(seen[0][seen[0].length - 1].content, /^\[Pinned on version 1 at 20% across, 40% down, on <button> "Save"\]\nmake the save button green$/);
    assert.match(JSON.stringify(seen[1]), /its find is not in the HTML/, 'the model is told an edit did not apply');
    const { rows: [answer] } = await pool.query('SELECT content, thread_root_id, metadata FROM conversation_messages WHERE id = $1', [sent.messageId]);
    assert.equal(answer.thread_root_id, design.rootId, 'answered in the thread');
    assert.equal(answer.content, 'Version 2: A green Save button.\n\nDone: Save is green now.');
    assert.equal(answer.metadata.homeroomBot.designVersion, 2);
    const v2 = await designs.versionOf(pool, { userId: ada.id, rootId: design.rootId });
    assert.equal(v2.version, 2);
    assert.match(v2.html, /<button class="save" style="background:#16a34a">Save<\/button>/);
    // A turn that changes nothing makes no version.
    const again = (await conversations.sendMessage(pool, ada, design.conversationId, { content: 'what do you think?', thread_root_id: design.rootId })).message;
    design = await designs.designFor(pool, { userId: ada.id, rootId: design.rootId });
    await designBot.answer(pool, config, {
      bot, user: ada, settings, conversationId: design.conversationId, message: again, design,
      deps: { ...deps, apiKey: 'sk-test', chat: scripted([[['reply', { text: 'It reads well.' }]]]) },
    });
    assert.equal((await designs.designFor(pool, { userId: ada.id, rootId: design.rootId })).latest, 2);
  });

  await t.test('pure: edits apply exactly once each, in order', () => {
    assert.deepEqual(designBot.applyEdits('<a>1</a><a>2</a>', [{ find: '<a>1', replace: '<b>1' }, { find: '1</a>', replace: '1</b>' }]), { html: '<b>1</b><a>2</a>' });
    assert.match(designBot.applyEdits('<a></a><a></a>', [{ find: '<a>', replace: '' }]).error, /more than once/);
    assert.match(designBot.applyEdits('x', []).error, /at least one/);
  });

  await t.test('Propose it files the design with its plan, once; a project not joined answers join_required', async () => {
    const refused = await designs.proposeDesign(pool, config, { user: sam, rootId: design.rootId, deps });
    assert.equal(refused.status, 404, 'nobody else proposes it');
    const filed = await designs.proposeDesign(pool, config, {
      user: ada, rootId: design.rootId, title: 'Green save button', notes: 'Save should stand out.', deps,
    });
    assert.equal(filed.ok, true, JSON.stringify(filed));
    assert.equal(filed.number, nextIssue);
    assert.equal(filed.plan, true);
    const { rows: [row] } = await pool.query('SELECT state, result_ref FROM private_threads WHERE root_message_id = $1', [design.rootId]);
    assert.deepEqual(row, { state: 'filed', result_ref: filed.number });
    const { rows: [spec] } = await pool.query(
      `SELECT cs.spec_html FROM chat_sessions cs WHERE cs.app_id = $1 AND cs.created_from_issue_number = $2 AND cs.source = 'request_spec'`,
      [app.id, filed.number],
    );
    assert.match(spec.spec_html, /<figure data-screens>/);
    assert.match(spec.spec_html, /<div data-side="before">[\s\S]*<button class="save">Save<\/button>/);
    assert.match(spec.spec_html, /<div data-side="after" data-change="1">[\s\S]*background:#16a34a/);
    const said = (await pool.query(
      'SELECT content FROM conversation_messages WHERE thread_root_id = $1 ORDER BY id DESC LIMIT 1', [design.rootId])).rows[0].content;
    assert.equal(said, `Filed it as request #${filed.number} on Plant pal, under your name, with version 1 and version 2 side by side as its plan.`);
    const twice = await designs.proposeDesign(pool, config, { user: ada, rootId: design.rootId, deps });
    assert.deepEqual([twice.status, twice.error, twice.number], [409, 'already_done', filed.number]);
    // Once proposed, the bot changes it no more.
    const late = (await conversations.sendMessage(pool, ada, design.conversationId, { content: 'one more change', thread_root_id: design.rootId })).message;
    const closed = await designBot.answer(pool, config, {
      bot, user: ada, settings: { mode: 'on' }, conversationId: design.conversationId, message: late,
      design: await designs.designFor(pool, { userId: ada.id, rootId: design.rootId }),
      deps: { ...deps, apiKey: 'sk-test', chat: async () => { throw new Error('not called'); } },
    });
    assert.match((await pool.query('SELECT content FROM conversation_messages WHERE id = $1', [closed.messageId])).rows[0].content, /was proposed/);

    // Sam's own design of a project he has not joined is filed nowhere.
    const samDesign = await designs.startDesign(pool, config, {
      user: sam, html: CAPTURE, surface: 'platform', title: 'Plant list', width: 390, height: 844, deps,
    });
    const notJoined = await designs.proposeDesign(pool, config, { user: sam, rootId: samDesign.rootId, deps });
    assert.deepEqual([notJoined.status, notJoined.code], [403, 'join_required']);
  });

  await t.test('pure: a plan\'s screens are script-free, and sized by the capture', () => {
    const doc = '<html><head><style>.x{color:red}</style><script>alert(1)</script></head><body class="dark"><p onclick="x()">Hi</p><script src="/a.js"></script></body></html>';
    const markup = designs.screenMarkup(doc);
    assert.doesNotMatch(markup, /<script/i);
    assert.match(markup, /^<style>\.x\{color:red\}<\/style><div class="dark"><p onclick="x\(\)">Hi<\/p><\/div>$/, 'handlers are cleaned again where it is drawn');
    const plan = designs.planHtml({ design: { width: 390, height: 900, title: 'Plant list', route: null }, title: 'T <b>', notes: '', before: doc, after: doc, version: 3 });
    assert.match(plan, /data-size="phone" data-height="900"/);
    assert.match(plan, /<h1>T &lt;b&gt;<\/h1>/);
  });
});
