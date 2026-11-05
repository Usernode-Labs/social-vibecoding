'use strict';

// #4772: services/workshop-waiting.js against the real schema: what Homeroom
// bot waits on one viewer for, on one project. Skips without a database.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const waiting = require('../src/services/workshop-waiting');
const aiWork = require('../src/services/ai-work');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

async function openDatabase(t) {
  let pg;
  try { pg = require('pg'); } catch { t.skip('the pg driver is not installed'); return null; }
  const admin = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 3000, max: 1 });
  try {
    await admin.query('SELECT 1');
  } catch (err) {
    await admin.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip(`no postgres reachable at ${DSN}: ${err.message}`);
    return null;
  }
  const name = `ws_waiting_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: String(url), max: 4 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end().catch(() => {});
  });
  await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
  return pool;
}

test('what Homeroom bot waits on the viewer for, read off the real tables', { timeout: 120000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;
  const user = async (name, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic)
     VALUES ($1, 'x', TRUE, $2) RETURNING id`, [name, synthetic],
  )).rows[0].id;
  const bot = await user('homeroom_bot', true);
  const ada = await user('ada');
  const sam = await user('sam');
  const appId = (await pool.query(
    `INSERT INTO apps (name, slug, status, created_by) VALUES ('Book club', 'book-club', 'running', $1) RETURNING id`, [ada],
  )).rows[0].id;

  // Plans: #13 is Ada's, its newest run waits for Build it. #14 is Ada's and
  // its plan was built already. #15 is Sam's.
  for (const [n, who] of [[13, ada], [14, ada], [15, sam]]) {
    await pool.query('INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id) VALUES ($1, $2, $3)', [appId, n, who]);
  }
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, awaiting_go_at) VALUES
       ($1, 13, 'live', 'ready', NOW() - INTERVAL '1 hour'),
       ($1, 15, 'live', 'ready', NOW() - INTERVAL '1 hour')`, [appId],
  );
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, awaiting_go_at, build_ok) VALUES
       ($1, 14, 'live', 'ready', NOW() - INTERVAL '2 hours', TRUE)`, [appId],
  );

  // #5229: a back and forth with the bot is not waiting on Ada, whoever
  // wrote last. Change A, where the bot wrote last, and request #9, where
  // Ada did, are both recent and both open.
  const a = (await pool.query(
    'INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, $3) RETURNING id', [appId, ada, 'promoted'],
  )).rows[0].id;
  const say = (who, type, ref, minutesAgo) => pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref, created_at)
     VALUES ($1, $2, 'hi', $3, $4, NOW() - make_interval(mins => $5))`,
    [appId, who, type, ref, minutesAgo],
  );
  await say(ada, 'session', a, 120);
  await say(bot, 'session', a, 60);
  await say(bot, 'issue', 9, 300);
  await say(ada, 'issue', 9, 200);

  const out = await waiting.waitingOnViewer(pool, { appId, userId: ada });
  assert.deepEqual(Object.keys(out).sort(), ['plans', 'questions'], 'no conversation kind');
  assert.deepEqual(out.plans.map((p) => p.number), [13]);
  assert.deepEqual(out.questions, []);

  const forSam = await waiting.waitingOnViewer(pool, { appId, userId: sam });
  assert.deepEqual(forSam.plans.map((p) => p.number), [15]);
  assert.deepEqual(forSam.questions, []);
});

// #6246 (4 Nov 2026): #6149's and #6081's plans waited for Build it but were
// missing from the bot page's Needs you while the Workshop listed them. One
// definition (planWaitingSql) now decides both, so the same plan is listed on
// both screens beside an older question, a person's reply, a message from a
// bot account (synthetic or not), a held queue row, or 26 newer requests.
// Built, closed or replaced, it leaves both.
test('#6246: a plan waiting for Build it is listed on both screens, whatever sits beside it', { timeout: 180000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const user = async (name, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic)
     VALUES ($1, 'x', TRUE, $2) RETURNING id`, [name, synthetic],
  )).rows[0].id;
  const bot = await user('homeroom_bot', true);
  const helper = await user('bot_helper');
  const ada = await user('ada6246');
  const appId = (await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Previews', 'previews-6246', 'running', $1, 'public', 'public') RETURNING id`, [ada],
  )).rows[0].id;
  const request = (number, state = 'open') => pool.query(
    `INSERT INTO requests (app_id, number, title, created_by, state)
     VALUES ($1, $2, 'Previews: a schema change rolling out', $3, $4)`, [appId, number, ada, state]);
  await request(40);
  await pool.query('INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id) VALUES ($1, 40, $2)', [appId, ada]);
  const planRun = (await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, awaiting_go_at, created_at)
     VALUES ($1, 40, 'live', 'ready', NOW() - INTERVAL '50 minutes', NOW() - INTERVAL '1 hour') RETURNING id`,
    [appId],
  )).rows[0].id;

  const deps = { bot, liveSvc: { isStaging: () => false }, settings: { mode: 'live' } };
  // The writes below go straight to the bot's tables; on the platform the
  // machine or route that makes them refreshes the stored work state the bot
  // page reads (services/work-state.js), as this does.
  const workState = require('../src/services/work-state');
  const listed = async () => {
    await workState.refresh(pool, [{ appId, issueNumber: 40 }]);
    const { plans } = await waiting.waitingOnViewer(pool, { appId, userId: ada });
    const work = await aiWork.workFor(pool, { user: { id: ada }, deps });
    // The page's plan row: another hand-back of the same request (a newer
    // run that found nothing to build asks its requester for more detail) is
    // not the plan.
    const plan = work.needs.find((n) => n.number === 40 && n.app && n.app.slug === 'previews-6246' && n.work.why === 'plan');
    return { workshop: plans.map((p) => p.number), page: plan ? plan.work.why : null };
  };
  const both = async (why) => {
    const now = await listed();
    assert.deepEqual(now.workshop, [40], `${why}: the Workshop lists the plan`);
    assert.equal(now.page, 'plan', `${why}: Needs you holds it as a plan`);
  };
  const neither = async (why) => {
    const now = await listed();
    assert.deepEqual(now.workshop, [], `${why}: the Workshop leaves it out`);
    assert.equal(now.page, null, `${why}: Needs you leaves it out`);
  };

  await both('the plain waiting plan');

  // An older question the bot left open on it does not hide the plan.
  const convo = await one(`INSERT INTO conversations (kind) VALUES ('direct') RETURNING id`);
  const question = await one(
    `INSERT INTO conversation_messages (conversation_id, sender_id, content) VALUES ($1, $2, 'which store?') RETURNING id`,
    [convo.id, bot],
  );
  await pool.query(
    `INSERT INTO homeroom_bot_dm_messages (message_id, user_id, conversation_id, app_id, issue_number, kind, question_status, created_at)
     VALUES ($1, $2, $3, $4, 40, 'question', 'open', NOW() - INTERVAL '3 hours')`,
    [question.id, ada, convo.id, appId],
  );
  await both('an older open question');
  await pool.query('DELETE FROM homeroom_bot_dm_messages WHERE message_id = $1', [question.id]);

  // A person's reply newer than the plan, with no queue row yet.
  const say = (who, minutesAgo) => pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref, created_at)
     VALUES ($1, $2, 'a reply', 'issue', 40, NOW() - make_interval(mins => $3))`, [appId, who, minutesAgo],
  );
  await say(ada, 5);
  await both('a person\'s newer reply');
  await pool.query(`DELETE FROM chat_messages WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 40`, [appId]);

  // A message from a bot account, synthetic and not.
  await say(bot, 4);
  await both('a synthetic bot message');
  await pool.query(`DELETE FROM chat_messages WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 40`, [appId]);
  await say(helper, 4);
  await both('a bot-like account\'s message');
  await pool.query(`DELETE FROM chat_messages WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 40`, [appId]);

  // A queue row on hold until Monday.
  await pool.query(
    `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, enqueued_at, held_until)
     VALUES ($1, 40, 2, NOW() - INTERVAL '10 hours', NOW() + INTERVAL '3 days')`, [appId],
  );
  await both('a held queue row');
  await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 40', [appId]);

  // The 25-request window: 26 newer requests with runs push the plan out of
  // requestRows, and the facts path still finds it.
  await pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id)
     SELECT $1, n, $2 FROM generate_series(41, 66) n`, [appId, ada],
  );
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, created_at)
     SELECT $1, n, 'live', 'empty', NOW() - make_interval(mins => n - 40) FROM generate_series(41, 66) n`, [appId],
  );
  await both('26 newer requests with runs');
  await pool.query('DELETE FROM homeroom_bot_runs WHERE app_id = $1 AND issue_number BETWEEN 41 AND 66', [appId]);
  await pool.query('DELETE FROM homeroom_bot_requesters WHERE app_id = $1 AND issue_number BETWEEN 41 AND 66', [appId]);

  // Closed: a plan on a closed request waits on nobody.
  await pool.query(
    `INSERT INTO issues (app_id, github_issue_number, title, status) VALUES ($1, 40, 'Previews', 'closed')`, [appId],
  );
  await neither('the request closed');
  await pool.query('DELETE FROM issues WHERE app_id = $1 AND github_issue_number = 40', [appId]);
  await both('reopened');

  // Build it tapped: the build waits its turn, which is not a plan waiting.
  await pool.query(
    `UPDATE homeroom_bot_runs SET live_build_waiting_at = NOW() WHERE id = $1`, [planRun],
  );
  await neither('the build waiting its turn');
  await pool.query('UPDATE homeroom_bot_runs SET live_build_waiting_at = NULL WHERE id = $1', [planRun]);
  await both('the wait left alone again');

  // A newer run replaces the plan, whichever way it went.
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, created_at)
     VALUES ($1, 40, 'live', 'empty', NOW())`, [appId],
  );
  await neither('a newer run replaced it');
});
