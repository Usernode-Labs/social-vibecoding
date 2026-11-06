'use strict';

// Threads, stage 6 of #6019: merging and splitting threads, against the
// FULL PostgreSQL schema in a throwaway database, through the real code
// (services/thread-moves.js, src/workflow/rules/thread-moves.ts and the
// route in routes/threads.js). The governance machine's own run is the one
// thing stood in for: its apply calls the same rule, which is called here.
//
// What this pins:
//   1. A merge the only requester proposes happens at once: everything moves,
//      replies included, and the merged thread points at the one it went
//      into, so its number still opens it.
//   2. With another requester it waits: their Agree makes it happen; a split
//      puts an item back in its own thread, reopened.
//   3. An objection puts it to the vote (a `thread_move` governance row);
//      the vote's apply moves the rows once; a vote that ends without
//      applying it refuses the move.
//   4. 24 hours with nobody objecting: the sweep applies it.
//   5. What a move may not do: take a thread's lead, merge a decision, or be
//      proposed by someone who has not joined.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/thread-moves-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('thread moves against the full schema', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `thread_moves_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);

  require('../src/db/pool').getPool = () => pool;
  const wsBus = require('../src/services/ws-bus');
  wsBus.publish = () => {};
  wsBus.publishBatched = () => {};
  const moves = require('../src/services/thread-moves');
  const rules = require('../src/workflow/rules/thread-moves.ts');
  const threads = require('../src/services/threads');
  const filed = [];
  const deps = { workflow: { async fileProposal(id, appId) { filed.push({ id, appId }); } } };

  const users = {};
  async function user(username) {
    const { rows: [row] } = await pool.query(`INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id, username`, [username]);
    users[row.id] = { id: row.id, username: row.username };
    return users[row.id];
  }
  const ada = await user('tm_ada');
  const bob = await user('tm_bob');
  const eve = await user('tm_eve');
  const { rows: [made] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Garden', 'tm-garden', 'running', $1, 'public', 'public') RETURNING id`,
    [ada.id]
  );
  const { rows: [app] } = await pool.query('SELECT id, slug, name, community_id FROM apps WHERE id = $1', [made.id]);
  for (const who of [ada, bob]) {
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, who.id]);
  }
  async function request(number, who, title) {
    const { rows: [row] } = await pool.query(
      'INSERT INTO requests (app_id, number, title, created_by) VALUES ($1, $2, $3, $4) RETURNING thread_id',
      [app.id, number, title, who.id]
    );
    return Number(row.thread_id);
  }
  const reply = async (who, number, content) => pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref) VALUES ($1, $2, $3, 'issue', $4) RETURNING id`,
    [app.id, who.id, content, number]
  );
  const threadOf = async (number) => Number((await pool.query('SELECT thread_id FROM requests WHERE app_id = $1 AND number = $2', [app.id, number])).rows[0].thread_id);
  const thread = (id) => threads.threadById(pool, id);

  const t1 = await request(1, ada, 'Watering log');
  const t2 = await request(2, ada, 'Log when I water');
  await reply(bob, 2, 'Same as #1?');
  const { rows: [change] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, pr_number) VALUES ($1, $2, 'promoted', '{2}', 5) RETURNING id, thread_id`,
    [app.id, bob.id]
  );
  assert.equal(Number(change.thread_id), t2);

  await t.test('a merge its only requester proposes happens at once, replies and changes with it', async () => {
    const out = await moves.propose(pool, { app, user: ada, thread: await thread(t2), kind: 'merge', into: 1, deps });
    assert.equal(out.ok, true, out.error);
    assert.equal(out.move.state, 'applied');
    assert.equal(await threadOf(2), t1);
    assert.equal(Number((await pool.query('SELECT thread_id FROM chat_sessions WHERE id = $1', [change.id])).rows[0].thread_id), t1, 'its change too');
    const { rows: msgs } = await pool.query(`SELECT thread_id FROM chat_messages WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 2`, [app.id]);
    assert.ok(msgs.length >= 1 && msgs.every((m) => Number(m.thread_id) === t1), 'and its replies');
    const merged = (await pool.query('SELECT merged_into, state FROM threads WHERE id = $1', [t2])).rows[0];
    assert.deepEqual([Number(merged.merged_into), merged.state], [t1, 'closed']);
    assert.equal(Number((await threads.threadForNumber(pool, { appId: app.id, number: 2 })).id), t1, 'its number still opens the thread');
    const { rows: lines } = await pool.query(
      `SELECT content FROM chat_messages WHERE app_id = $1 AND msg_type = 'system' AND content LIKE 'Merged into #1%'`, [app.id]);
    assert.ok(lines.length >= 1, 'and the thread says so');
  });

  await t.test('a split puts an item back in its own thread, reopened, with its change', async () => {
    const out = await moves.propose(pool, { app, user: ada, thread: await thread(t1), kind: 'split', items: [{ type: 'request', number: 2 }], deps });
    assert.equal(out.ok, true, out.error);
    assert.equal(out.move.state, 'applied');
    assert.equal(await threadOf(2), t2);
    assert.equal(Number((await pool.query('SELECT thread_id FROM chat_sessions WHERE id = $1', [change.id])).rows[0].thread_id), t2);
    const back = (await pool.query('SELECT merged_into, state FROM threads WHERE id = $1', [t2])).rows[0];
    assert.deepEqual([back.merged_into, back.state], [null, 'open']);
  });

  const t3 = await request(3, bob, 'Seed swaps');
  await t.test('with another requester it waits for their Agree', async () => {
    const out = await moves.propose(pool, { app, user: ada, thread: await thread(t3), kind: 'merge', into: 1, deps });
    assert.equal(out.move.state, 'pending');
    assert.deepEqual(out.move.agreed, [ada.id]);
    assert.equal((await moves.agree(pool, { app, user: eve, moveId: out.move.id, deps })).status, 403, 'only a requester agrees');
    const agreed = await moves.agree(pool, { app, user: bob, moveId: out.move.id, deps });
    assert.equal(agreed.move.state, 'applied');
    assert.equal(await threadOf(3), t1);
  });

  const t4 = await request(4, bob, 'Compost');
  await t.test('an objection puts it to the vote; the vote\'s apply moves it once', async () => {
    const out = await moves.propose(pool, { app, user: ada, thread: await thread(t4), kind: 'merge', into: 1, deps });
    assert.equal(out.move.state, 'pending');
    const objected = await moves.object(pool, { app, user: bob, moveId: out.move.id, reason: 'Different thing', deps });
    assert.equal(objected.move.state, 'voting');
    const { rows: [vote] } = await pool.query('SELECT kind, status, payload, created_by FROM issues WHERE id = $1', [objected.move.governanceId]);
    assert.deepEqual([vote.kind, vote.status, vote.payload.moveId, vote.created_by], ['thread_move', 'open', out.move.id, bob.id]);
    assert.deepEqual(filed.at(-1), { id: objected.move.governanceId, appId: app.id }, 'filed into the governance machine');
    assert.equal(await threadOf(4), t4, 'nothing moved yet');
    // The machine's apply, in its transaction.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      assert.equal(await rules.applyMove(client, out.move.id), t1);
      assert.equal(await rules.applyMove(client, out.move.id), null, 'once');
      await client.query('COMMIT');
    } finally { client.release(); }
    assert.equal(await threadOf(4), t1);
  });

  const t6 = await request(6, bob, 'Rain barrels');
  await t.test('a vote that ends without applying it refuses the move; 24 quiet hours apply one', async () => {
    const voted = await moves.propose(pool, { app, user: ada, thread: await thread(t6), kind: 'merge', into: 1, deps });
    const objected = await moves.object(pool, { app, user: bob, moveId: voted.move.id, deps });
    await pool.query(`UPDATE issues SET status = 'closed' WHERE id = $1`, [objected.move.governanceId]);
    const t7 = await request(7, bob, 'Mulch');
    const quiet = await moves.propose(pool, { app, user: ada, thread: await thread(t7), kind: 'merge', into: 1, deps });
    assert.equal(quiet.move.state, 'pending');
    await pool.query(`UPDATE thread_moves SET deadline = NOW() - INTERVAL '1 minute' WHERE id = $1`, [quiet.move.id]);
    assert.deepEqual(await moves.sweep(pool, { deps }), { applied: 1, refused: 1 });
    assert.equal((await pool.query('SELECT state FROM thread_moves WHERE id = $1', [voted.move.id])).rows[0].state, 'refused');
    assert.equal(await threadOf(6), t6, 'refused: nothing moved');
    assert.equal(await threadOf(7), t1, 'quiet: it happened');
  });

  await t.test('what a move may not do', async () => {
    const lead = await moves.propose(pool, { app, user: ada, thread: await thread(t1), kind: 'split', items: [{ type: 'request', number: 1 }], deps });
    assert.equal(lead.status, 422);
    assert.match(lead.error, /lead stays/);
    const { rows: [decision] } = await pool.query(
      `INSERT INTO issues (app_id, title, kind, payload, created_by) VALUES ($1, 'Rename', 'rename', '{"newName":"Plot"}', $2) RETURNING thread_id`,
      [app.id, ada.id]
    );
    const merged = await moves.propose(pool, { app, user: ada, thread: await thread(decision.thread_id), kind: 'merge', into: 1, deps });
    assert.equal(merged.status, 409);
    assert.equal((await moves.propose(pool, { app, user: ada, thread: await thread(t6), kind: 'merge', into: 999, deps })).status, 404);
  });

  await t.test('ballots: each change keeps its own vote; the first live closes the rest', async () => {
    const t8 = await request(8, ada, 'Raised beds');
    const make = async (pr) => (await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, pr_number) VALUES ($1, $2, 'promoted', '{8}', $3) RETURNING id`,
      [app.id, bob.id, pr],
    )).rows[0].id;
    const a = await make(20);
    const b = await make(21);
    // Her Yes on A counts at its current epoch; her Yes on B was cast before
    // B's last push, so it does not.
    await pool.query('UPDATE chat_sessions SET approval_epoch = 1 WHERE id = $1', [b]);
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch) VALUES ($1, $2, 'yes', 0), ($3, $2, 'yes', 0)`, [a, ada.id, b]);
    const page = await threads.threadPage(pool, { thread: await thread(t8), viewerId: ada.id });
    const votes = Object.fromEntries(page.items.filter((i) => i.type === 'change').map((i) => [i.id, [i.myVote, i.epoch]]));
    assert.deepEqual(votes, { [a]: ['yes', 0], [b]: [null, 1] }, 'a push resets only its own change');
    // A goes live: B closes as replaced, and says why.
    await pool.query(`UPDATE chat_sessions SET status = 'merged' WHERE id = $1`, [a]);
    const archived = [];
    const lifecycle = { async archiveSession(args) { archived.push(args); return { archived: true }; } };
    assert.deepEqual(await threads.closeRivals(pool, { appId: app.id, prNumber: 20, deps: { lifecycle } }), [b]);
    assert.deepEqual(archived.map((x) => [x.sessionId, x.reason, x.from]), [[b, 'superseded', 'promoted']]);
    const { rows: [line] } = await pool.query(
      `SELECT content FROM chat_messages WHERE app_id = $1 AND thread_type = 'session' AND thread_ref = $2 AND msg_type = 'system'`, [app.id, b]);
    assert.equal(line.content, 'Change #20 went live first, so this one closes.');
    assert.deepEqual(await threads.closeRivals(pool, { appId: app.id, prNumber: 999, deps: { lifecycle } }), [], 'no merged change, nothing to close');
  });

  // #6019 follow-up: a big request broken into smaller requests in its own
  // thread, decided as a merge is; it closes with the last of them.
  await t.test('a break-up files the parts in the same thread, and the request closes with the last', async () => {
    const requests = require('../src/services/requests');
    requests.setPool(pool);
    await pool.query(`UPDATE apps SET repo_url = 'https://github.com/tm-owner/tm-garden' WHERE id = $1`, [app.id]);
    requests.invalidateApps?.();
    const t20 = await request(20, ada, 'Garden planner');
    const bad = await moves.propose(pool, { app, user: ada, thread: await thread(t20), kind: 'breakup', request: 20, parts: [{ title: 'Only one' }], deps });
    assert.deepEqual([bad.ok, bad.status], [false, 422], 'at least two parts');
    const out = await moves.propose(pool, {
      app, user: ada, thread: await thread(t20), kind: 'breakup', request: 20, deps,
      parts: [{ title: 'Plot map', doneWhen: 'I can draw my beds' }, { title: 'Sowing calendar' }],
    });
    assert.equal(out.ok, true, out.error);
    assert.equal(out.move.state, 'applied', 'its only requester proposed it, so it happens at once');
    const { rows: parts } = await pool.query(
      'SELECT number, title, body, thread_id, part_of, created_by FROM requests WHERE app_id = $1 AND part_of = 20 ORDER BY number', [app.id]);
    assert.deepEqual(parts.map((p) => [p.title, Number(p.thread_id), p.part_of, p.created_by]),
      [['Plot map', t20, 20, ada.id], ['Sowing calendar', t20, 20, ada.id]], 'in the same thread, as hers');
    assert.match(parts[0].body, /^Done when: I can draw my beds\n\nPart of #20\.$/);
    const { rows: [line] } = await pool.query(
      `SELECT content FROM chat_messages WHERE app_id = $1 AND msg_type = 'system' AND content LIKE 'Broken up into%' ORDER BY id DESC LIMIT 1`, [app.id]);
    assert.equal(line.content, `Broken up into #${parts[0].number}, #${parts[1].number}, as everyone who asked agreed. #20 closes with the last of them.`);
    const state = async (n) => (await pool.query('SELECT state FROM requests WHERE app_id = $1 AND number = $2', [app.id, n])).rows[0].state;
    await requests.close('tm-owner', 'tm-garden', parts[0].number);
    assert.equal(await state(20), 'open', 'one part left');
    await requests.close('tm-owner', 'tm-garden', parts[1].number);
    assert.equal(await state(20), 'closed', 'closed with the last of its parts');
    const again = await moves.propose(pool, { app, user: ada, thread: await thread(t20), kind: 'breakup', request: parts[0].number, parts: [{ title: 'a' }, { title: 'b' }], deps });
    assert.equal(again.ok, false, 'a closed thread, or a part, breaks up no further');
  });

  await t.test('a break-up the vote applies has its parts filed by the next sweep, once', async () => {
    const t30 = await request(30, ada, 'Recipe box');
    const out = await moves.propose(pool, {
      app, user: bob, thread: await thread(t30), kind: 'breakup', request: 30, deps,
      parts: [{ title: 'Save a recipe' }, { title: 'Share a recipe' }],
    });
    assert.equal(out.move.state, 'pending', 'Ada asked for it; Bob proposed it, so it waits for her');
    // The project voted for it: the governance machine applies it, in its
    // own transaction, as rules.applyMove (a rule calls no service).
    assert.equal(await rules.applyMove(pool, out.move.id), t30);
    const parts = async () => (await pool.query(
      'SELECT title FROM requests WHERE app_id = $1 AND part_of = 30 ORDER BY number', [app.id])).rows.map((r) => r.title);
    assert.deepEqual(await parts(), [], 'nothing filed in the vote\'s transaction');
    await moves.sweep(pool, { deps });
    assert.deepEqual(await parts(), ['Save a recipe', 'Share a recipe']);
    await moves.sweep(pool, { deps });
    assert.equal((await parts()).length, 2, 'once');
  });

  // On prod, #5995 going live closed #5997 as superseded: both were made
  // from request #5927, but #5997 is a part of it and closes nothing. Parts
  // of one request are not rivals; only changes that would close the same
  // request are.
  await t.test('parts of one request are not rivals: only a change closing the same request closes', async () => {
    const t9 = await request(9, ada, 'Polish');
    const make = async (pr, closes) => (await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, created_from_issue_number, pr_number)
       VALUES ($1, $2, 'promoted', $3, 9, $4) RETURNING id`,
      [app.id, bob.id, closes, pr],
    )).rows[0].id;
    const partA = await make(40, '{}');
    const partB = await make(41, '{}');
    const closer = await make(42, '{9}');
    const rival = await make(43, '{9}');
    const page = await threads.threadPage(pool, { thread: await thread(t9), viewerId: ada.id });
    const closes = Object.fromEntries(page.items.filter((i) => i.type === 'change').map((i) => [i.id, i.closes]));
    assert.deepEqual(closes, { [partA]: [], [partB]: [], [closer]: [9], [rival]: [9] }, 'each change says what it closes');
    const archived = [];
    const lifecycle = { async archiveSession(args) { archived.push(args); return { archived: true }; } };
    // A part goes live: it closes nothing, so nothing is its rival.
    await pool.query(`UPDATE chat_sessions SET status = 'merged' WHERE id = $1`, [partA]);
    assert.deepEqual(await threads.closeRivals(pool, { appId: app.id, prNumber: 40, deps: { lifecycle } }), []);
    // A change closing #9 goes live: only the other change closing #9 closes.
    await pool.query(`UPDATE chat_sessions SET status = 'merged' WHERE id = $1`, [closer]);
    assert.deepEqual(await threads.closeRivals(pool, { appId: app.id, prNumber: 42, deps: { lifecycle } }), [rival]);
    assert.deepEqual(archived.map((x) => x.sessionId), [rival], 'the other part stays up for its vote');
  });

  // #6421: a change that closes requests in other threads gathers them into
  // its own, at once for its author's own and after Yes from anyone else.
  await t.test('a change gathers its other request threads, asking their askers', async () => {
    const bot = await user('tm_bot');
    await pool.query('UPDATE users SET is_synthetic = TRUE WHERE id = $1', [bot.id]);
    const t50 = await request(50, bob, 'Night watering');
    const t51 = await request(51, ada, 'Water at dawn');
    const makeChange = async ({ who = bob, status = 'promoted', linked, thread, pr, shared = null }) => (await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, thread_id, pr_number, shared_at, pr_title)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, thread_id, pr_number`,
      [app.id, who.id, status, linked, thread, pr, shared, `Change at #${pr}`]
    )).rows[0];
    const change51 = await makeChange({ linked: '{50,51}', thread: t50, pr: 60 });
    assert.equal(Number(change51.thread_id), t50, 'it lives in its first request\'s thread');
    await moves.gather(pool, { deps });
    const { rows: [ask] } = await pool.query(
      'SELECT * FROM thread_moves WHERE thread_id = $1 AND for_session_id = $2', [t51, change51.id]);
    assert.ok(ask, 'the other thread is asked');
    assert.equal(ask.state, 'pending');
    assert.deepEqual(ask.input.requests, [51]);
    assert.equal(Number(ask.input.into), t50);
    const forAda = await moves.openMoves(pool, { threadId: t51, viewerId: ada.id });
    assert.equal(forAda[0].canAnswer, true);
    assert.deepEqual(forAda[0].askOf, ['tm_ada']);
    assert.deepEqual(forAda[0].forChange, { id: Number(change51.id), number: 60 });
    const forBob = await moves.openMoves(pool, { threadId: t51, viewerId: bob.id });
    assert.equal(forBob[0].canAnswer, false, 'the author does not answer');
    assert.equal((await moves.consent(pool, { app, user: eve, moveId: ask.id, answer: 'yes', deps })).status, 403, 'only a requester answers');
    assert.equal((await moves.consent(pool, { app, user: bob, moveId: ask.id, answer: 'yes', deps })).status, 403, 'nor the author');
    assert.equal((await moves.object(pool, { app, user: ada, moveId: ask.id, deps })).status, 409, 'a consent row is not objected to');
    assert.equal((await moves.agree(pool, { app, user: ada, moveId: ask.id, deps })).status, 409, 'nor agreed to the old way');
    await reply(ada, 51, 'Dawn is better');
    await pool.query(
      `INSERT INTO thread_followers (thread_id, user_id, muted_at)
       VALUES ($1, $2, NOW()), ($1, $3, NULL) ON CONFLICT DO NOTHING`,
      [t51, eve.id, ada.id]
    );
    const yes = await moves.consent(pool, { app, user: ada, moveId: ask.id, answer: 'yes', deps });
    assert.equal(yes.move.state, 'applied');
    assert.equal(await threadOf(51), t50, 'Yes moved it');
    const { rows: [moved] } = await pool.query(
      `SELECT thread_id, thread_ref FROM chat_messages WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 51 ORDER BY id DESC LIMIT 1`, [app.id]);
    assert.equal(Number(moved.thread_id), t50, 'its reply moved');
    assert.equal(Number(moved.thread_ref), 51, 'and keeps the request it was written on');
    const { rows: [kept] } = await pool.query('SELECT muted_at FROM thread_followers WHERE thread_id = $1 AND user_id = $2', [t50, eve.id]);
    assert.ok(kept && kept.muted_at, 'followers move, mute included');
    assert.ok((await threads.followerIds(pool, { threadId: t50, appId: app.id })).includes(ada.id));
    assert.equal(await threadOf(51), t50, 'its old number opens the merged thread');
    const page = await threads.threadPage(pool, { thread: await thread(t50), viewerId: ada.id });
    assert.equal(page.thread.requests, 2);
    assert.equal(page.thread.name, 'Change at #60', 'a merged thread is called by its change');
    const mergedLine = (await pool.query(
      `SELECT content FROM chat_messages WHERE app_id = $1 AND content LIKE 'tm_ada agreed to move #51%'`, [app.id])).rows;
    assert.equal(mergedLine.length, 1, 'the merge says who agreed');

    // Keep separate leaves it where it is, still linked, and asks once.
    const t52 = await request(52, ada, 'Rain gauge');
    const change52 = await makeChange({ linked: '{52}', thread: t50, pr: 61 });
    await moves.gather(pool, { deps });
    const { rows: [sep] } = await pool.query(
      'SELECT * FROM thread_moves WHERE thread_id = $1 AND for_session_id = $2', [t52, change52.id]);
    assert.ok(sep);
    const keptOut = await moves.consent(pool, { app, user: ada, moveId: sep.id, answer: 'separate', deps });
    assert.equal(keptOut.move.state, 'refused');
    assert.equal(Number(keptOut.move.input.kept), ada.id);
    assert.equal(await threadOf(52), t52, 'nothing moved');
    await moves.gather(pool, { deps });
    assert.equal(Number((await pool.query(
      'SELECT COUNT(*) AS n FROM thread_moves WHERE thread_id = $1 AND for_session_id = $2', [t52, change52.id])).rows[0].n), 1, 'not asked again');
    const elsewhere = await threads.changesElsewhere(pool, { thread: await thread(t52), numbers: [52], viewerId: ada.id });
    assert.ok(elsewhere.some((e) => Number(e.id) === Number(change52.id) && Number(e.on) === 50), 'the pointer still shows');

    // The author asked for everything in it: it moves at once and says why.
    const t53 = await request(53, bob, 'Drip line');
    await makeChange({ linked: '{53}', thread: t50, pr: 62 });
    await moves.gather(pool, { deps });
    assert.equal(await threadOf(53), t50, 'its author\'s own request moves without asking');
    assert.ok((await pool.query(
      `SELECT 1 FROM chat_messages WHERE app_id = $1 AND content LIKE 'tm_bob asked for #53 and Change #62 closes it%'`, [app.id])).rows.length);

    // A bot-built change speaks for whoever asked for its thread's lead request.
    const t54 = await request(54, ada, 'Hose reel');
    const t55 = await request(55, ada, 'Soaker hose');
    await makeChange({ who: bot, linked: '{54,55}', thread: t54, pr: 63 });
    await moves.gather(pool, { deps });
    assert.equal(await threadOf(55), t54, 'both are hers, so it moves');

    // A private draft asks nobody.
    const t56 = await request(56, ada, 'Mist');
    const privateChange = await makeChange({ linked: '{56}', thread: t50, pr: 64, status: 'active' });
    await moves.gather(pool, { deps });
    assert.equal(Number((await pool.query(
      'SELECT COUNT(*) AS n FROM thread_moves WHERE thread_id = $1 AND for_session_id = $2', [t56, privateChange.id])).rows[0].n), 0);

    // The 24-hour sweep never applies a consent row.
    const t57 = await request(57, ada, 'Tap timer');
    const change57 = await makeChange({ linked: '{57}', thread: t50, pr: 65 });
    await moves.gather(pool, { deps });
    const { rows: [late] } = await pool.query(
      'SELECT * FROM thread_moves WHERE thread_id = $1 AND for_session_id = $2', [t57, change57.id]);
    assert.equal(late.state, 'pending');
    await pool.query(`UPDATE thread_moves SET deadline = NOW() - INTERVAL '1 minute' WHERE id = $1`, [late.id]);
    await moves.sweep(pool, { deps });
    assert.equal((await pool.query('SELECT state FROM thread_moves WHERE id = $1', [late.id])).rows[0].state, 'pending');
    assert.equal(await threadOf(57), t57, 'nothing moved on the clock');
  });

  await t.test('the route is for members: someone who has not joined is asked to', async () => {
    const httpApp = express();
    httpApp.use(express.json());
    httpApp.use((req, _res, next) => { req.user = users[Number(req.get('x-test-user'))]; next(); });
    httpApp.use(require('../src/routes/threads').threadsRoutes({}));
    server = await new Promise((resolve) => { const s = httpApp.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/api/apps/${app.slug}/threads/6/moves`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': String(eve.id) },
      body: JSON.stringify({ kind: 'merge', into: 1 }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'join_required');
    const consentRes = await fetch(`${base}/api/apps/${app.slug}/thread-moves/1/consent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': String(eve.id) },
      body: JSON.stringify({ answer: 'yes' }),
    });
    assert.equal(consentRes.status, 403, 'a non-member cannot answer a consent question');
    assert.equal((await consentRes.json()).code, 'join_required');
    const page = await (await fetch(`${base}/api/apps/${app.slug}/threads/1`, { headers: { 'x-test-user': String(ada.id) } })).json();
    assert.ok(Array.isArray(page.moves), 'the page carries its open moves');
  });
});
