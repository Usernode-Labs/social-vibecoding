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
//      join_required. 1 Nov 2026: the design stays the thread's after it:
//      the bot changes it on (a plan may be posted again, phase C2).
//   5. 1 Nov 2026 (threads, one loop C1): any private thread can hold a
//      design. Main Chat's draw_screen hands the turn to the design bot: in
//      a "+" thread it draws version 1 there (write_screen, the project's
//      own stylesheets put in from main, its code read with list_source and
//      read_source); in Main Chat it opens a "+"-style thread first, says so
//      in Main in one line, and draws there; a thread off their own message
//      gets its private_threads row with its first version. A picture they
//      sent is described for a model that reads text only.
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
      // 1 Nov 2026 (C2.1): a design posts again on the request it filed.
      async fetchPublicIssues() { return { issues: [{ number: nextIssue, title: 'Green save button', state: 'open' }] }; },
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
    assert.match(opened.href, new RegExp(`^#homeroom-bot/thread/${opened.rootId}$`), 'on the bot\'s tab');
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
    // 1 Nov 2026 (C2.1): proposed again, it is the plan's next version on
    // the request it filed, and the bot keeps working on it meanwhile.
    const twice = await designs.proposeDesign(pool, config, { user: ada, rootId: design.rootId, deps });
    assert.deepEqual([twice.ok, twice.number, twice.planVersion], [true, filed.number, 2]);
    const late = (await conversations.sendMessage(pool, ada, design.conversationId, { content: 'one more change', thread_root_id: design.rootId })).message;
    const after = await designBot.answer(pool, config, {
      bot, user: ada, settings: { mode: 'on' }, conversationId: design.conversationId, message: late,
      design: await designs.designFor(pool, { userId: ada.id, rootId: design.rootId }),
      deps: {
        ...deps, apiKey: 'sk-test',
        chat: scripted([
          [['edit_design', { edits: [{ find: 'Plant list</h1>', replace: 'My plants</h1>' }], note: 'A new heading' }]],
          [['reply', { text: 'Renamed it.' }]],
        ]),
      },
    });
    assert.match((await pool.query('SELECT content FROM conversation_messages WHERE id = $1', [after.messageId])).rows[0].content, /^Version 3: A new heading\./);
    // Put away, the bot changes it no more.
    await pool.query(`UPDATE private_threads SET state = 'dropped' WHERE root_message_id = $1`, [design.rootId]);
    const gone = (await conversations.sendMessage(pool, ada, design.conversationId, { content: 'and another', thread_root_id: design.rootId })).message;
    const closed = await designBot.answer(pool, config, {
      bot, user: ada, settings: { mode: 'on' }, conversationId: design.conversationId, message: gone,
      design: await designs.designFor(pool, { userId: ada.id, rootId: design.rootId }),
      deps: { ...deps, apiKey: 'sk-test', chat: async () => { throw new Error('not called'); } },
    });
    assert.match((await pool.query('SELECT content FROM conversation_messages WHERE id = $1', [closed.messageId])).rows[0].content, /was put away/);

    // Sam's own design of a project he has not joined is filed nowhere.
    const samDesign = await designs.startDesign(pool, config, {
      user: sam, html: CAPTURE, surface: 'platform', title: 'Plant list', width: 390, height: 844, deps,
    });
    const notJoined = await designs.proposeDesign(pool, config, { user: sam, rootId: samDesign.rootId, deps });
    assert.deepEqual([notJoined.status, notJoined.code], [403, 'join_required']);
  });

  // ── 1 Nov 2026: a design in any private thread (C1) ──────────────────
  const mayor = require('../src/services/homeroom-bot-mayor');
  const privateThreads = require('../src/services/private-threads');
  const { rows: [seedRow] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Seed swap', 'dt-seed-swap', 'running', $1, 'https://github.com/usernode-bot/dt-seed-swap', 'public', 'public')
     RETURNING id`,
    [ada.id],
  );
  // The community is made by a trigger after the insert.
  const { rows: [seedApp] } = await pool.query('SELECT community_id FROM apps WHERE id = $1', [seedRow.id]);
  await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [seedApp.community_id, ada.id]);
  const read = [];
  const repoFiles = {
    'public/index.html': '<!doctype html><html><head><link rel="stylesheet" href="/usernode-native/v1/native.css"><link rel="stylesheet" href="styles.css?v=2"><link rel="stylesheet" href="https://cdn.test/x.css"></head><body><main class="seeds"></main></body></html>',
    'public/styles.css': '.seeds { color: #166534; } .card { border-radius: 12px; }',
    'public/app.js': 'render();',
    '.env': 'SECRET=1',
  };
  const drawDeps = {
    ...deps,
    github: {
      ...deps.github,
      async getFileContent(owner, repo, filePath) { read.push(`${repo}:${filePath}`); return repoFiles[filePath] ?? null; },
      async listRepoFiles() { return { files: Object.keys(repoFiles).map((path) => ({ path, size: repoFiles[path].length })), truncated: false }; },
    },
    openMcp: async () => null,
    seesImages: false,
  };
  const settingsOn = { mode: 'on', perPerson: 2 };
  const SCREEN = '<main class="seeds"><h1>Swap seeds</h1><div class="card">Tomatoes</div></main>';

  await t.test('a "+" thread holds a design: Main Chat\'s draw_screen hands version 1 to the design bot', async () => {
    const started = await privateThreads.startThread(pool, { user: ada, project: 'dt-seed-swap', kind: 'design', deps });
    assert.equal(started.ok, true, JSON.stringify(started));
    const asked = (await conversations.sendMessage(pool, ada, started.conversationId, {
      content: 'a screen to list the seeds I can swap', thread_root_id: started.rootId,
    })).message;
    assert.equal(await designs.threadOf(pool, { userId: ada.id, conversationId: started.conversationId, message: asked }), null, 'no design yet');
    const seen = [];
    read.length = 0;
    const sent = await mayor.runDmTurn(pool, config, {
      bot, user: ada, settings: settingsOn, conversationId: started.conversationId, message: asked,
      deps: {
        ...drawDeps, apiKey: 'sk-test', threadRootId: started.rootId,
        threadDraft: { kind: 'ask', appSlug: 'dt-seed-swap', appName: 'Seed swap', changeKind: 'design' },
        chat: scripted([
          [['draw_screen', { what: 'The seeds they can swap, as cards', title: 'Swap list', project: 'dt-seed-swap' }]],
          [['list_source', {}], ['read_source', { path: 'public/styles.css' }], ['read_source', { path: '.env' }]],
          [['write_screen', { title: 'Swap list', size: 'phone', html: SCREEN, note: 'The swap list' }]],
          [['reply', { text: 'Here is a first go.' }]],
        ], seen),
      },
    });
    // The Mayor's round, then the design bot's own prompt.
    assert.equal(seen[0][0].role, 'system');
    assert.match(seen[1][0].content, /This thread has no screen yet\. It is for a screen of the app Seed swap\./);
    assert.match(seen[1][0].content, /WHAT MAIN CHAT ASKED YOU TO DRAW\nThe seeds they can swap, as cards/);
    // #6257: the first drawing may ask first, so its last line says so; the
    // clear brief here still draws in the turn (the next scripted call).
    assert.match(seen[1][0].content, /THERE IS NO SCREEN YET: draw it with write_screen, or ask first as FIRST SCREEN says\.$/);
    const results = seen[2].filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
    assert.deepEqual(results[0].files.map((f) => f.path), ['public/index.html', 'public/styles.css', 'public/app.js'], 'secret paths are never listed');
    assert.match(results[1].text, /1: \.seeds \{ color: #166534; \}/);
    assert.match(results[2].error, /holds secrets/);
    const { rows: [answer] } = await pool.query('SELECT content, thread_root_id, metadata FROM conversation_messages WHERE id = $1', [sent.messageId]);
    assert.equal(answer.thread_root_id, started.rootId, 'drawn in the thread');
    assert.equal(answer.content, 'Version 1: The swap list.\n\nHere is a first go.');
    assert.equal(answer.metadata.homeroomBot.designVersion, 1);
    assert.equal(answer.metadata.homeroomBot.designTitle, 'Swap list');
    const drawn = await designs.designFor(pool, { userId: ada.id, rootId: started.rootId });
    assert.deepEqual([drawn.kind, drawn.surface, drawn.title, drawn.width, drawn.height, drawn.latest, drawn.app.slug],
      ['ask', 'app', 'Swap list', 390, 844, 1, 'dt-seed-swap'], 'a "+" thread\'s design: its own kind, the project\'s app');
    assert.equal(drawn.versions[0].author, 'bot');
    const v1 = await designs.versionOf(pool, { userId: ada.id, rootId: started.rootId });
    assert.match(v1.html, /^<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="\/usernode-native\/v1\/native\.css"><style data-design-sheet="public\/styles\.css">\.seeds \{ color: #166534; \}/,
      'the stylesheets the app\'s entry page links on main, put in by the server');
    assert.doesNotMatch(v1.html, /cdn\.test/, 'never another site\'s');
    assert.match(v1.html, /<body><main class="seeds"><h1>Swap seeds<\/h1>/);

    // Now the thread holds a design: its next message is the design bot's,
    // which reads the version with the stylesheet left empty, and keeps it.
    const next = (await conversations.sendMessage(pool, ada, started.conversationId, { content: 'add a swap button', thread_root_id: started.rootId })).message;
    const held = await designs.threadOf(pool, { userId: ada.id, conversationId: started.conversationId, message: next });
    assert.equal(held.rootId, started.rootId);
    const seen2 = [];
    await designBot.answer(pool, config, {
      bot, user: ada, settings: settingsOn, conversationId: started.conversationId, message: next, design: held,
      deps: {
        ...drawDeps, apiKey: 'sk-test',
        chat: scripted([
          [['edit_design', { edits: [{ find: 'Tomatoes</div>', replace: 'Tomatoes <button class="swap">Swap</button></div>' }], note: 'A Swap button' }]],
          [['reply', { text: 'Added.' }]],
        ], seen2),
      },
    });
    assert.match(seen2[0][0].content, /<style data-design-sheet="public\/styles\.css"><\/style>/, 'the model reads the stylesheet as one empty block');
    assert.doesNotMatch(seen2[0][0].content, /#166534/);
    const v2 = await designs.versionOf(pool, { userId: ada.id, rootId: started.rootId });
    assert.equal(v2.version, 2);
    assert.match(v2.html, /<style data-design-sheet="public\/styles\.css">\.seeds \{ color: #166534; \}/, 'and the version keeps it');
    assert.match(v2.html, /Tomatoes <button class="swap">Swap<\/button>/);
  });

  await t.test('Main Chat holds no design: draw_screen opens a thread, says so in Main in one line, and draws there', async () => {
    const opened = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
    const asked = (await conversations.sendMessage(pool, ada, opened.conversationId, { content: 'show me what a seed calendar could look like' })).message;
    const sent = await mayor.runDmTurn(pool, config, {
      bot, user: ada, settings: settingsOn, conversationId: opened.conversationId, message: asked,
      deps: {
        ...drawDeps, apiKey: 'sk-test',
        chat: scripted([
          [['draw_screen', { what: 'A calendar of when to sow each seed', title: 'Seed calendar' }]],
          [['write_screen', { title: 'Seed calendar', size: 'desktop', html: '<h1>Sow in March</h1>', note: 'A calendar' }]],
          [['reply', { text: 'A first calendar.' }]],
        ]),
      },
    });
    const { rows: [answer] } = await pool.query('SELECT thread_root_id, idempotency_key FROM conversation_messages WHERE id = $1', [sent.messageId]);
    assert.ok(answer.thread_root_id, 'answered in a thread');
    assert.equal(answer.idempotency_key, mayor.answerKey(asked.id), 'under the key the DM\'s answers use');
    const { rows: [line] } = await pool.query('SELECT id, sender_id, content, thread_root_id, reply_to_id, metadata FROM conversation_messages WHERE id = $1', [answer.thread_root_id]);
    assert.equal(line.sender_id, bot.id);
    assert.equal(line.thread_root_id, null, 'the thread hangs off a line in Main');
    assert.equal(line.reply_to_id, asked.id, 'which quotes what they asked');
    assert.equal(line.content, 'I\'m drawing "Seed calendar" in a new thread. Only you can see it.');
    assert.deepEqual([line.metadata.homeroomBot.kind, line.metadata.homeroomBot.changeKind, line.metadata.homeroomBot.designTitle], ['opened_thread', 'design', 'Seed calendar']);
    const { rows: mainLines } = await pool.query(
      'SELECT id FROM conversation_messages WHERE conversation_id = $1 AND thread_root_id IS NULL AND sender_id = $2 AND id > $3',
      [opened.conversationId, bot.id, asked.id],
    );
    assert.equal(mainLines.length, 1, 'one line in Main');
    const drawn = await designs.designFor(pool, { userId: ada.id, rootId: line.id });
    assert.deepEqual([drawn.kind, drawn.surface, drawn.app, drawn.width, drawn.latest], ['ask', 'new', null, 1280, 1], 'a new project\'s screen, at the desktop size');
    const v1 = await designs.versionOf(pool, { userId: ada.id, rootId: line.id });
    assert.match(v1.html, /<link rel="stylesheet" href="\/usernode-native\/v1\/native\.css">/, 'drawn with the native kit');
  });

  // #6257: "Can we open a thread to work on a design change together?" drew a
  // generic to-do list before the person said anything. With nothing to go
  // on, the designer asks what the app is for and what the screen should do,
  // and the thread holds no version until they answer.
  await t.test('#6257: a thin first ask asks what the app is for and draws nothing', async () => {
    const opened = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
    const asked = (await conversations.sendMessage(pool, ada, opened.conversationId, {
      content: 'Can we open a thread to work on a design change together?',
    })).message;
    const seen = [];
    const sent = await mayor.runDmTurn(pool, config, {
      bot, user: ada, settings: settingsOn, conversationId: opened.conversationId, message: asked,
      deps: {
        ...drawDeps, apiKey: 'sk-test',
        chat: scripted([
          [['draw_screen', { what: 'A design to work on together', title: 'Design' }]],
          [['reply', { text: 'What is the app for, and what should this screen do?' }]],
        ], seen),
      },
    });
    const { rows: [answer] } = await pool.query('SELECT content, thread_root_id, metadata FROM conversation_messages WHERE id = $1', [sent.messageId]);
    const rootId = answer.thread_root_id;
    assert.ok(rootId, 'the question is in the new thread');
    assert.equal(answer.content, 'What is the app for, and what should this screen do?', 'the question, with no version line');
    assert.equal(answer.metadata?.homeroomBot?.designVersion, undefined, 'no version under it');
    assert.match(seen[1][0].content, /FIRST SCREEN: Before you draw/, 'the designer was told to ask first');
    assert.equal(seen.length, 2, 'and no forced write_screen came after the question');
    assert.equal(await designs.designFor(pool, { userId: ada.id, rootId }), null, 'no design row, no version');
    const { rows: [{ n }] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM design_versions dv JOIN private_threads pt ON pt.id = dv.private_thread_id
        WHERE pt.root_message_id = $1`, [rootId]);
    assert.equal(n, 0);

    // They answer: the next turn draws it, with no question first.
    const reply = (await conversations.sendMessage(pool, ada, opened.conversationId, {
      content: 'A seed swap app, listing the seeds I can swap with a Swap button on each.',
      thread_root_id: rootId,
    })).message;
    const seen2 = [];
    const drawn = await mayor.runDmTurn(pool, config, {
      bot, user: ada, settings: settingsOn, conversationId: opened.conversationId, message: reply,
      deps: {
        ...drawDeps, apiKey: 'sk-test', threadRootId: rootId,
        threadDraft: { kind: 'ask', changeKind: 'design' },
        chat: scripted([
          [['draw_screen', { what: 'A seed swap app, listing the seeds I can swap with a Swap button on each', title: 'Swap list' }]],
          [['write_screen', { title: 'Swap list', size: 'phone', html: SCREEN, note: 'The swap list' }]],
          [['reply', { text: 'Here is a first go.' }]],
        ], seen2),
      },
    });
    assert.doesNotMatch(seen2[1][0].content, /FIRST SCREEN/, 'it asks once, then draws from the answer');
    const held = await designs.designFor(pool, { userId: ada.id, rootId });
    assert.equal(held.latest, 1, 'the thread now holds version 1');
    assert.equal((await pool.query('SELECT content FROM conversation_messages WHERE id = $1', [drawn.messageId])).rows[0].content,
      'Version 1: The swap list.\n\nHere is a first go.');
  });

  await t.test('a thread off their own message gets its row with its first version; a picture is described for a text-only model', async () => {
    const opened = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
    const root = (await conversations.sendMessage(pool, ada, opened.conversationId, { content: 'an idea: a seed map' })).message;
    const asked = (await conversations.sendMessage(pool, ada, opened.conversationId, { content: 'like this sketch', thread_root_id: root.id })).message;
    await pool.query(
      `INSERT INTO conversation_message_attachments (id, conversation_id, message_id, user_id, kind, filename, content_type, size_bytes, data)
       VALUES ('dtpic1', $1, $2, $3, 'image', 'sketch.png', 'image/png', 4, '\\x89504e47'::bytea)`,
      [opened.conversationId, asked.id, ada.id],
    );
    assert.equal((await pool.query('SELECT 1 FROM private_threads WHERE root_message_id = $1', [root.id])).rows.length, 0);
    const room = await designs.draftingThread(pool, { userId: ada.id, botId: bot.id, rootId: root.id });
    assert.deepEqual([room.threadId, room.kind, room.app], [null, 'idea', null]);
    assert.equal(await designs.draftingThread(pool, { userId: sam.id, botId: bot.id, rootId: root.id }), null, 'nobody else\'s');
    const seen = [];
    await designBot.draw(pool, config, {
      bot, user: ada, settings: settingsOn, conversationId: opened.conversationId, message: asked,
      ask: { app: null, title: 'Seed map', brief: 'A map of who has which seeds' },
      deps: {
        ...drawDeps, apiKey: 'sk-test', threadRootId: root.id, pictureModelSeesImages: true,
        chat: scripted([
          (req) => {
            assert.equal(req.model, mayor.DEFAULT_MODEL, 'the cheap model that reads pictures');
            assert.match(JSON.stringify(req.messages), /data:image\/png;base64,iVBORw==/);
            return [['describe_pictures', { pictures: ['A hand-drawn map with three pins and a list under it.'] }]];
          },
          [['write_screen', { title: 'Seed map', size: 'phone', html: '<h1>Seed map</h1>', note: 'A first map' }]],
          [['reply', { text: 'Drawn from your sketch.' }]],
        ], seen),
      },
    });
    assert.match(JSON.stringify(seen[1]), /they attached the picture sketch\.png, which you cannot see\. A model that reads pictures says it shows: A hand-drawn map with three pins and a list under it\./);
    assert.doesNotMatch(JSON.stringify(seen[1]), /base64/, 'the text-only model gets words, not the picture');
    const { rows: [row] } = await pool.query('SELECT kind, state, user_id FROM private_threads WHERE root_message_id = $1', [root.id]);
    assert.deepEqual(row, { kind: 'idea', state: 'open', user_id: ada.id }, 'its row, made with its first version');
    assert.equal((await designs.designFor(pool, { userId: ada.id, rootId: root.id })).latest, 1);
  });

  await t.test('ensureDesign keeps the surface and route a captured Homeroom page gives', async () => {
    const opened = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
    const root = (await conversations.sendMessage(pool, ada, opened.conversationId, { content: 'design the bot page' })).message;
    const thread = { conversationId: opened.conversationId, rootId: root.id };
    await designs.ensureDesign(pool, config, {
      user: ada, thread, title: 'Homeroom bot page', size: 'desktop',
      surface: 'platform', route: '/?demo=1#homeroom-bot',
    });
    const first = await designs.designFor(pool, { userId: ada.id, rootId: root.id });
    assert.equal(first.surface, 'platform');
    assert.equal(first.route, '/?demo=1#homeroom-bot');
    assert.deepEqual([first.width, first.height], [1280, 800]);
    // A later call without a route keeps the one already held.
    await designs.ensureDesign(pool, config, { user: ada, thread, title: 'Homeroom bot page', size: 'phone' });
    const after = await designs.designFor(pool, { userId: ada.id, rootId: root.id });
    assert.equal(after.route, '/?demo=1#homeroom-bot');
    assert.deepEqual([after.width, after.height], [390, 844]);
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
