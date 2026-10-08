'use strict';

// A built change's cards say how many approvals it needs, not only who
// could give them.
//
// First-session run-through, 5 Oct 2026: Page Turners has three members
// (alex_t1005 made it, priya_t1006 and mo_t1006 joined) and a change there
// needs two of them to approve: its change page said "1/2" once Alex had.
// The ready card in Alex's chat with Homeroom bot said "Waiting for approval
// from you, @priya_t1006 and @mo_t1006", which reads as if all three must.
// When fewer approvals are needed than the people listed, the card and the
// card under the chat message the change was asked in now say how many,
// and that any of them will do (frontend/src/features/messages/
// approval-words.ts): "Needs 2 approvals from you, @priya_t1006 or
// @mo_t1006", then "Needs one more approval from @priya_t1006 or
// @mo_t1006" once one is in. When everybody listed is needed they still
// say "Waiting for approval from you and @ada".
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-ready-threshold.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const words = loadTsx('frontend/src/features/messages/approval-words.ts');
const readyCard = loadTsx('frontend/src/features/messages/bot-ready.tsx');
const chatCard = loadTsx('frontend/src/features/group-chat/bot-request.tsx');

const group = (ready) => ({ group: true, last: false, waitingOn: [], more: 0, ...ready });

// ── The words ──

test('fewer approvals needed than people listed: how many, and any of them', () => {
  const { waitingLine } = readyCard;
  const { approvalWords } = chatCard;
  // Page Turners, before anybody approved: two of the three.
  assert.equal(waitingLine(group({ waitingOn: ['priya_t1006', 'mo_t1006'], missing: 2, needed: 2 }), true),
    'Needs 2 approvals from you, @priya_t1006 or @mo_t1006');
  assert.equal(approvalWords({ stage: 'proposed', youApprove: true, waitingOn: ['priya_t1006', 'mo_t1006'], more: 0, missing: 2, needed: 2 }),
    'Needs 2 approvals from you, @priya_t1006 or @mo_t1006.');
  // After Alex approved: one more, from either of the other two.
  assert.equal(waitingLine(group({ waitingOn: ['priya_t1006', 'mo_t1006'], missing: 1, needed: 2 }), false),
    'Needs one more approval from @priya_t1006 or @mo_t1006');
  assert.equal(approvalWords({ stage: 'proposed', youApprove: false, waitingOn: ['priya_t1006', 'mo_t1006'], more: 0, missing: 1, needed: 2 }),
    'Needs one more approval from @priya_t1006 or @mo_t1006.');
  // A rule of "at least one" among named approvers: one, from any of them.
  assert.equal(waitingLine(group({ waitingOn: ['ada', 'ben'], missing: 1, needed: 1 }), false), 'Needs one approval from @ada or @ben');
  // More people than it names: the rest are counted, still with "or".
  assert.equal(waitingLine(group({ waitingOn: ['ada', 'ben', 'cy'], more: 2, missing: 3, needed: 4 }), true),
    'Needs 3 more approvals from you, @ada, @ben, @cy or 2 others');
  assert.equal(words.waitingWords({ names: ['ada', 'ben', 'cy'], more: 1, missing: 2, needed: 2 }), 'Needs 2 approvals from @ada, @ben, @cy or 1 other');
});

test('every one of them needed: "Waiting for approval from" as before', () => {
  const { waitingLine } = readyCard;
  const { approvalWords } = chatCard;
  // A group of two where both must say yes.
  assert.equal(waitingLine(group({ waitingOn: ['ada'], missing: 2, needed: 2 }), true), 'Waiting for approval from you and @ada');
  assert.equal(approvalWords({ stage: 'proposed', youApprove: true, waitingOn: ['ada'], missing: 2, needed: 2 }), 'Waiting for approval from you and @ada.');
  assert.equal(approvalWords({ stage: 'proposed', youApprove: false, waitingOn: ['ada'], missing: 1, needed: 2 }), 'Waiting for approval from @ada.');
  assert.equal(waitingLine(group({ waitingOn: ['ada', 'cy'], more: 2, missing: 4, needed: 4 }), false), 'Waiting for approval from @ada, @cy and 2 more');
  // A card sent before cards carried the count reads as it always did.
  assert.equal(waitingLine(group({ waitingOn: ['priya_t1006', 'mo_t1006'] }), true), 'Waiting for approval from you, @priya_t1006 and @mo_t1006');
  assert.equal(approvalWords({ stage: 'proposed', youApprove: true, waitingOn: ['jordan'] }), 'Waiting for approval from you and @jordan.');
  // Their Yes is the last one needed, or it has every one it needs: nobody is named.
  assert.equal(waitingLine(group({ last: true, waitingOn: ['ada', 'ben'], missing: 1, needed: 2 }), true), null);
  assert.equal(waitingLine(group({ waitingOn: ['ada'], missing: 0, needed: 2 }), false), null);
  assert.equal(approvalWords({ stage: 'proposed', youApprove: false, waitingOn: ['ada'], missing: 0, needed: 2 }), 'It has the approvals it needs.');
});

test('a public community names nobody, as before', () => {
  const { waitingLine } = readyCard;
  const { approvalWords } = chatCard;
  // Everybody there could approve, so nobody else is listed (homeroom-bot-dm.js needsYesFrom).
  assert.equal(waitingLine(group({ waitingOn: [], missing: 2, needed: 2 }), true), 'Waiting for approval from you');
  assert.equal(waitingLine(group({ waitingOn: [], missing: 2, needed: 2 }), false), null);
  assert.equal(approvalWords({ stage: 'proposed', youApprove: false, waitingOn: [], more: 0, missing: 2, needed: 2 }), 'Waiting for approval.');
});

test('once you approved: one more approval, from any of them, or the day it goes live anyway', () => {
  const { approvedLine, goesLiveFromReady } = readyCard;
  const sunday = new Date(2026, 9, 4, 18, 0);
  const wednesday = new Date(2026, 9, 7, 9, 30).toISOString();
  const line = (next) => approvedLine({ soon: false, at: null, missing: 1, waitingOn: [], more: 0, ...next }, sunday, 'en-US');
  // Page Turners: the lazy-consensus clock runs three days from when it went up (active-users.js lazyWindowMs).
  assert.equal(line({ waitingOn: ['priya_t1006', 'mo_t1006'], at: wednesday }),
    'You approved it. It goes live after one more approval from @priya_t1006 or @mo_t1006, or on Wednesday if nobody objects.');
  assert.equal(line({ missing: 2, waitingOn: ['ada', 'ben', 'cy'] }), 'You approved it. It goes live after 2 more approvals from @ada, @ben or @cy.');
  assert.equal(line({ waitingOn: ['ada', 'ben', 'cy'], more: 2 }), 'You approved it. It goes live after one more approval from @ada, @ben, @cy or 2 others.');
  // Exactly who is needed, or nobody named: as before.
  assert.equal(line({ waitingOn: ['ada'], at: wednesday }), 'You approved it. It goes live when @ada approves too, or on Wednesday if nobody objects.');
  assert.equal(line({ missing: 2, waitingOn: [] }), 'You approved it. It goes live when 2 more people approve.');
  // Its next step not read: from what the card was sent with, one fewer than it needed.
  assert.deepEqual(goesLiveFromReady(group({ waitingOn: ['priya_t1006', 'mo_t1006'], missing: 2, needed: 2 })),
    { soon: false, at: null, missing: 1, waitingOn: ['priya_t1006', 'mo_t1006'], more: 0 });
  assert.equal(approvedLine(goesLiveFromReady(group({ waitingOn: ['priya_t1006', 'mo_t1006'], missing: 2, needed: 2 }))),
    'You approved it. It goes live after one more approval from @priya_t1006 or @mo_t1006.');
});

test('plain words, and the count travels with the card to every device', () => {
  const said = [
    words.waitingWords({ you: true, names: ['priya_t1006', 'mo_t1006'], missing: 2, needed: 2 }),
    words.waitingWords({ names: ['priya_t1006', 'mo_t1006'], missing: 1, needed: 2 }),
    readyCard.approvedLine({ soon: false, at: null, missing: 1, waitingOn: ['priya_t1006', 'mo_t1006'], more: 0 }),
    chatCard.approvalWords({ stage: 'proposed', missing: 0 }),
  ];
  for (const s of said) assert.doesNotMatch(s, /propos|merg|vote|\bPR\b|staging|—/i, s);
  const { normalizeBotMeta } = loadTsx('frontend/src/features/messages/api.ts');
  const ready = (row) => normalizeBotMeta({ homeroomBot: { kind: 'proposal', ready: row } }).homeroomBot.ready;
  assert.deepEqual(ready({ group: true, last: false, waitingOn: ['priya_t1006', 'mo_t1006'], missing: 2, needed: 2 }),
    { group: true, last: false, waitingOn: ['priya_t1006', 'mo_t1006'], more: 0, missing: 2, needed: 2 });
  assert.deepEqual(ready({ group: true, waitingOn: ['ada'], missing: 0, needed: 2 }), { group: true, last: false, waitingOn: ['ada'], more: 0, missing: 0, needed: 2 });
  for (const bad of [null, '2', -1, 1.5]) {
    assert.equal('missing' in ready({ group: true, waitingOn: ['ada'], missing: bad }), false, String(bad));
  }
  // Both cards word it in one place.
  assert.match(read('frontend/src/features/messages/bot-ready.tsx'), /import \{ afterYesWords, countOf, waitingWords, type AfterYes \} from '\.\/approval-words';/);
  assert.match(read('frontend/src/features/group-chat/bot-request.tsx'), /import \{ waitingWords \} from '\.\.\/messages\/approval-words';/);
});

// ── Against the full schema ──

test('Page Turners: two of three must approve, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_threshold_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(read('src/db/schema.sql'));
  const dm = require('../src/services/homeroom-bot-dm');
  const botChat = require('../src/services/homeroom-bot-chat');
  const governance = require('../src/services/governance');
  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
    [username, synthetic],
  )).rows[0];
  const homeroomBot = await user('homeroom_bot', true);
  const alex = await user('alex_t1005');
  const priya = await user('priya_t1006');
  const mo = await user('mo_t1006');
  const ben = await user('ben');
  const ada = await user('ada');
  const set = (key, value) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
  await set('homeroom_bot_dm_users', JSON.stringify(['alex_t1005', 'ben']));
  await set('homeroom_bot_mode', 'live');
  const project = async (slug, label, { view = 'private', members = [] } = {}) => {
    const { rows: [inserted] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
       VALUES ($1, $2, 'running', $3, $4, $4) RETURNING id`,
      [label, slug, members[0].id, view],
    );
    const app = (await pool.query('SELECT id, slug, name, community_id FROM apps WHERE id = $1', [inserted.id])).rows[0];
    for (const m of members) {
      await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, m.id]);
      await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [app.id, m.id]);
      await pool.query(
        `INSERT INTO app_activity (app_id, user_id, date, seconds_spent) VALUES ($1, $2, CURRENT_DATE, 120) ON CONFLICT DO NOTHING`, [app.id, m.id],
      );
    }
    governance.invalidateGovernance(app.id);
    return app;
  };
  const change = async (app, requester, issueNumber) => {
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, promoted_at, check_state)
       VALUES ($1, $2, $3, 'promoted', 'First version', NOW(), 'passing') RETURNING id, promoted_at`,
      [app.id, homeroomBot.id, `bot-${app.slug}-${issueNumber}`],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, asked_text)
       VALUES ($1, $2, $3, 'First version', 'A place for our book club')`,
      [app.id, issueNumber, requester.id],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id, build_ok)
       VALUES ($1, $2, 'live', 'ready', $3, TRUE)`,
      [app.id, issueNumber, s.id],
    );
    return s;
  };
  const card = async (userId, sessionId) => (await pool.query(
    `SELECT m.metadata->'homeroomBot' AS meta
       FROM homeroom_bot_dm_messages d JOIN conversation_messages m ON m.id = d.message_id
       JOIN homeroom_bot_runs r ON r.id = d.run_id
      WHERE d.user_id = $1 AND d.kind = 'proposal' AND r.proposal_session_id = $2
      ORDER BY m.id DESC LIMIT 1`,
    [userId, sessionId],
  )).rows[0]?.meta;
  const yes = (sessionId, who) => pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch) VALUES ($1, $2, 'yes', 0)`, [sessionId, who.id],
  );
  const viewOf = (meta) => renderToHtml(createElement(readyCard.ReadyCardView, { meta, state: 'open', actions: meta.actions }));

  await t.test('three members, two approvals needed: the cards say two, from any of the three', async () => {
    const pages = await project('page-turners', 'Page Turners', { members: [alex, priya, mo] });
    const s = await change(pages, alex, 1);
    const state = await dm.approvalState(pool, { sessionId: s.id, userId: alex.id });
    assert.deepEqual([state.audience, state.needed, state.have, state.missing, state.last], ['invited', 2, 0, 2, false]);

    await dm.noteChangeReady(pool, s.id, { bot: homeroomBot, domain: 'app.example.test' });
    const meta = await card(alex.id, s.id);
    assert.deepEqual({ ...meta.ready, waitingOn: [...meta.ready.waitingOn].sort() },
      { group: true, last: false, waitingOn: ['mo_t1006', 'priya_t1006'], missing: 2, needed: 2 });
    const [one, other] = meta.ready.waitingOn;
    assert.ok(viewOf(meta).includes(`data-bot-ready-waiting="">Needs 2 approvals from you, @${one} or @${other}<`), 'never "you, @… and @…"');
    assert.equal(chatCard.approvalWords({ stage: 'proposed', ...(await botChat.approvalOf(pool, { sessionId: s.id, viewer: { id: alex.id } })) }),
      'Needs 2 approvals from you, @mo_t1006 or @priya_t1006.');

    // Alex approves: the change page reads 1/2, and the lazy-consensus
    // clock runs three days from when it went up for approval.
    await yes(s.id, alex);
    const after = await dm.approvalState(pool, { sessionId: s.id, userId: alex.id });
    assert.deepEqual([after.gate.qualifiedYes, after.gate.required, after.missing], [1, 2, 1]);
    const next = await dm.noteApproved(pool, s.id, alex.id);
    assert.deepEqual({ ...next, waitingOn: [...next.waitingOn].sort() }, {
      soon: false, at: new Date(new Date(s.promoted_at).getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      missing: 1, waitingOn: ['mo_t1006', 'priya_t1006'], more: 0,
    });
    const [a, b] = next.waitingOn;
    assert.match(readyCard.approvedLine(next, new Date(s.promoted_at), 'en-US'),
      new RegExp(`^You approved it\\. It goes live after one more approval from @${a} or @${b}, or (on \\w+|tomorrow|later today) if nobody objects\\.$`));
    assert.equal(chatCard.approvalWords({ stage: 'proposed', ...(await botChat.approvalOf(pool, { sessionId: s.id, viewer: { id: alex.id } })) }),
      'Needs one more approval from @mo_t1006 or @priya_t1006.');

    // Priya approves too: it has what it needs, and names nobody.
    await yes(s.id, priya);
    const done = await botChat.approvalOf(pool, { sessionId: s.id, viewer: { id: alex.id } });
    assert.deepEqual([done.missing, done.waitingOn], [0, []]);
    assert.equal(chatCard.approvalWords({ stage: 'proposed', ...done }), 'It has the approvals it needs.');
  });

  await t.test('two members, both needed: "Waiting for approval from you and @ada", as before', async () => {
    const club = await project('supper-club', 'Supper Club', { members: [ben, ada] });
    const s = await change(club, ben, 1);
    await dm.noteChangeReady(pool, s.id, { bot: homeroomBot, domain: 'app.example.test' });
    const meta = await card(ben.id, s.id);
    assert.deepEqual(meta.ready, { group: true, last: false, waitingOn: ['ada'], missing: 2, needed: 2 });
    assert.ok(viewOf(meta).includes('data-bot-ready-waiting="">Waiting for approval from you and @ada<'));
    assert.equal(chatCard.approvalWords({ stage: 'proposed', ...(await botChat.approvalOf(pool, { sessionId: s.id, viewer: { id: ben.id } })) }),
      'Waiting for approval from you and @ada.');
    await yes(s.id, ben);
    assert.equal(readyCard.approvedLine(await dm.noteApproved(pool, s.id, ben.id), new Date(s.promoted_at), 'en-US').startsWith(
      'You approved it. It goes live when @ada approves too, or '), true);
    assert.equal(chatCard.approvalWords({ stage: 'proposed', ...(await botChat.approvalOf(pool, { sessionId: s.id, viewer: { id: ben.id } })) }),
      'Waiting for approval from @ada.');
  });

  await t.test('a public community names nobody, as before', async () => {
    const town = await project('town-square', 'Town Square', { view: 'public', members: [ben, ada, alex] });
    const s = await change(town, ben, 1);
    const state = await dm.approvalState(pool, { sessionId: s.id, userId: ben.id });
    assert.deepEqual([state.audience, state.missing], ['open', 2]);
    await dm.noteChangeReady(pool, s.id, { bot: homeroomBot, domain: 'app.example.test' });
    const meta = await card(ben.id, s.id);
    assert.deepEqual(meta.ready, { group: true, last: false, waitingOn: [], missing: 2, needed: 2 });
    assert.ok(viewOf(meta).includes('data-bot-ready-waiting="">Waiting for approval from you<'));
    const approval = await botChat.approvalOf(pool, { sessionId: s.id, viewer: { id: ben.id } });
    assert.deepEqual([approval.youApprove, approval.waitingOn], [false, []]);
    assert.equal(chatCard.approvalWords({ stage: 'proposed', ...approval }), 'Waiting for approval.');
  });
});
