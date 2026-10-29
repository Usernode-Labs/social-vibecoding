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
const fs = require('node:fs');
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
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema);

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
    const page = await (await fetch(`${base}/api/apps/${app.slug}/threads/1`, { headers: { 'x-test-user': String(ada.id) } })).json();
    assert.ok(Array.isArray(page.moves), 'the page carries its open moves');
  });
});
