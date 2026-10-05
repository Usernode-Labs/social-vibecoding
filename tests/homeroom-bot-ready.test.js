'use strict';

// B7: a change ready to try, and the people who must approve it.
//
// When one of Homeroom bot's changes is ready to try (its preview is up and
// its checks passed or were not needed), whoever asked for it gets a card:
// Try it, Approve when their own Yes counts (cast from their browser, never
// the bot's), and Change something. Whoever else must approve gets one
// `change_ready` notification, on by default and pushed: on a project of
// one person's or a private community, the people active on it; on a public
// community, only the approvers it names (decided: everybody there could
// vote, and nobody is told this way). A Yes cast anywhere settles the card.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-ready.test.js

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

const dm = require('../src/services/homeroom-bot-dm');

// ── What the card offers, and says ──

test('B7: Try it always, Approve when their Yes counts, Change something; one filled', () => {
  assert.deepEqual(dm.readyActions({ sessionId: 9, epoch: 2, approve: true }), [
    { id: 'try', label: 'Try it', style: 'secondary', type: 'preview', sessionId: 9 },
    { id: 'approve', label: 'Approve', style: 'primary', type: 'vote', sessionId: 9, epoch: 2 },
    { id: 'change', label: 'Change something', style: 'secondary', type: 'reply' },
  ]);
  assert.deepEqual(dm.readyActions({ sessionId: 9, epoch: 2, approve: false }).map((a) => [a.id, a.style]),
    [['try', 'primary'], ['change', 'secondary']], 'with no Approve, Try it is the filled one');
  const ctx = { appName: 'Plant Pal', issueNumber: 2, issueTitle: 'Reminder' };
  assert.equal(dm.dmText('proposal', { sessionId: 9, card: { approve: true, last: true } }, ctx),
    "**Plant Pal** · request #2: Reminder\n\nIt's ready to try. Approve it when you're happy with it, and it goes live.");
  assert.equal(dm.dmText('proposal', { sessionId: 9, card: { approve: true, last: false } }, { ...ctx, group: true }),
    "**Plant Pal** · request #2: Reminder\n\nIt's ready to try. Approve it when you're happy with it.");
  assert.equal(dm.dmText('proposal', { sessionId: 9, card: { approve: false } }, { ...ctx, group: true }),
    "**Plant Pal** · request #2: Reminder\n\nIt's ready to try. It goes live once it's approved.");
  for (const said of ['vote', 'proposal', 'merged']) {
    assert.ok(!new RegExp(said, 'i').test(dm.dmText('proposal', { sessionId: 9, card: { approve: true } }, ctx)), said);
  }
});

test('B4: a ready card names the change, from the description the build wrote', () => {
  assert.equal(dm.changeSummaryLine('Adds a weekly reminder email every Friday'), 'Adds a weekly reminder email every Friday');
  // The build's credit line goes: the card is already in that person's chat.
  assert.equal(dm.changeSummaryLine('Adds a weekly reminder email every Friday.\n\nAsked for by @maya'), 'Adds a weekly reminder email every Friday.');
  // Multi-line text flattens to one line.
  assert.equal(dm.changeSummaryLine('Adds a weekly reminder\nemail every   Friday'), 'Adds a weekly reminder email every Friday');
  const long = 'Tracks which soups the household liked, which ones nobody finished, and what to buy for the next batch of stock before the market run.';
  const said = dm.changeSummaryLine(long);
  assert.ok(said.endsWith('…'), `clipped: ${said}`);
  assert.ok(said.length <= 121, `about one line: ${said.length}`);
  assert.ok(long.startsWith(said.slice(0, -1)), 'cut at a word boundary, not mid-word');
  for (const nothing of ['', '   ', null, undefined, '\n\nAsked for by @maya\n']) {
    assert.equal(dm.changeSummaryLine(nothing), null);
  }
});

test('B7: the card, drawn in every state', () => {
  const { ReadyCardView, readyTitle, waitingLine, isReadyMessage } = loadTsx('frontend/src/features/messages/bot-ready.tsx');
  const actions = dm.readyActions({ sessionId: 9, epoch: 2, approve: true });
  const meta = {
    kind: 'proposal', appName: 'Plant Pal', appSlug: 'plant-pal', askedText: 'Add a weekly reminder',
    ready: { group: false, last: true, waitingOn: [], more: 0 }, actions, status: 'open', sessionId: 9, epoch: 2,
  };
  const draw = (props) => renderToHtml(createElement(ReadyCardView, { meta, state: 'open', actions, ...props }));
  const open = draw();
  assert.match(open, /data-bot-ready="open"/);
  assert.match(open, />Plant Pal is ready to try</);
  assert.match(open, /You asked: Add a weekly reminder/);
  assert.match(open, /data-bot-ready-action="try"><span>Try it<\/span>/);
  assert.match(open, /class="messages-bot-primary" data-bot-ready-action="approve"><span>Approve<\/span>/);
  assert.match(open, /data-bot-ready-action="change"><span>Change something<\/span>/);
  assert.ok(!/Waiting for approval/.test(open), 'a project of one waits on nobody else');
  // The change's own summary, under the title and before "You asked" — and
  // absent from a card that carries neither a description nor a spec title.
  const withSummary = renderToHtml(createElement(ReadyCardView, {
    meta: { ...meta, ready: { ...meta.ready, summary: 'Adds a weekly reminder email every Friday' } }, state: 'open', actions,
  }));
  assert.match(withSummary, /data-bot-ready-summary="">Adds a weekly reminder email every Friday</);
  assert.ok(
    withSummary.indexOf('data-bot-ready-title') < withSummary.indexOf('data-bot-ready-summary')
      && withSummary.indexOf('data-bot-ready-summary') < withSummary.indexOf('You asked:'),
    'under the title, before "You asked"',
  );
  const withBroken = renderToHtml(createElement(ReadyCardView, {
    meta: { ...meta, ready: { ...meta.ready, summary: 'Adds a weekly reminder email every Friday', broken: ['Tapping “mark as done” ticks it off'] } },
    state: 'open',
    actions,
  }));
  assert.match(withBroken, /data-bot-ready-summary/, 'said on a card that is not everything working yet, too');
  assert.ok(!/data-bot-ready-summary/.test(open), 'a card without the description has no line');
  assert.match(draw({ state: 'approved', actions: [] }), /You approved it\. It’s going live\./);
  assert.match(draw({ state: 'approved', actions: [], meta: { ...meta, ready: { ...meta.ready, last: false } } }), /You approved it\.</);
  const stale = draw({ state: 'stale', actions: actions.slice(0, 1) });
  assert.match(stale, /This change was updated\. Try the new version first\./);
  assert.ok(!/Approve</.test(stale), 'a replaced version approves nothing until it is tried');
  assert.match(draw({ state: 'updated', actions: [] }), /This change was updated\. Its newer version is below\./);

  const group = { ...meta, appName: 'Supper Club', ready: { group: true, last: false, waitingOn: ['ada'], more: 0 } };
  assert.equal(readyTitle(group), 'Your change to Supper Club is ready to try');
  assert.equal(waitingLine(group.ready, true), 'Waiting for approval from you and @ada');
  assert.equal(waitingLine(group.ready, false), 'Waiting for approval from @ada');
  assert.equal(waitingLine({ ...group.ready, waitingOn: ['ada', 'cy'], more: 2 }, false), 'Waiting for approval from @ada, @cy and 2 more');
  assert.equal(waitingLine({ ...group.ready, last: true }, true), null, 'their Yes is the last one needed');
  assert.equal(readyTitle({ ...group, firstVersion: true }), 'Supper Club is ready to try');

  const msg = (m) => ({ id: 1, sender: { id: 9, username: 'homeroom_bot', bot: true }, content: 'x', metadata: { homeroomBot: m } });
  assert.equal(isReadyMessage(msg(meta)), true);
  assert.equal(isReadyMessage(msg({ ...meta, ready: undefined })), false, 'an older "it is built" keeps its words');
});

test('B7: the client knows the new buttons, and Approve is the person\'s own vote, on the version they were sent', () => {
  const api = read('frontend/src/features/messages/api.ts');
  assert.match(api, /const BOT_ACTION_TYPES = new Set\(\['server', 'open', 'prompt', 'preview', 'vote', 'reply'\]\);/);
  assert.match(api, /fetch\(`\/api\/sessions\/\$\{sessionId\}\/vote`, \{/);
  assert.match(api, /body: JSON\.stringify\(epoch === null \? \{ vote: 'yes' \} : \{ vote: 'yes', expectedEpoch: epoch \}\),/);
  assert.match(api, /const stale = response\.status === 409 && pick\(data, 'headChanged'\) === true;/);
  const card = read('frontend/src/features/messages/bot-ready.tsx');
  assert.match(card, /view\.ensureStaging\(sessionId, null, null, \{ readOnly: false, app: \{ slug: meta\.appSlug \} \}\)/);
  // The bot never votes: no server path casts a Yes for the card.
  const dmSrc = read('src/services/homeroom-bot-dm.js');
  assert.ok(!/pr_votes \(|recordVote|\/vote'/.test(dmSrc), 'the bot service writes no vote');
  const votes = read('src/routes/votes.js');
  assert.match(votes, /if \(vote === 'yes'\) void require\('\.\.\/services\/homeroom-bot-dm'\)\.noteApproved\(pool, session\.id, req\.user\.id\);/);
  const policy = require('../src/services/cli-api-policy');
  assert.equal(policy.isConnectorApiRequest('POST', '/api/sessions/9/vote'), false, 'the vote route stays off the connector list');
  assert.equal(policy.isDelegatedApiRequest('agent_mayor', 'POST', '/api/sessions/9/vote'), false, 'and off the agents\'');
});

test('B7: "ready to try" in the bell and on the phone, on by default', async () => {
  const prefs = require('../src/services/notification-preferences');
  assert.equal(prefs.categoryForKind('change_ready'), 'changes_ready');
  assert.equal(prefs.isKindEnabled('change_ready', {}), true);
  const push = require('../src/services/mobile-push-preferences');
  assert.ok(push.ALLOWED_KINDS.has('change_ready'));
  const { buildNotificationCopy } = require('../src/services/mobile-push-policy');
  const copy = buildNotificationCopy('change_ready', { sourceUsername: 'ben', appName: 'Supper Club', sessionTitle: 'Sunday host reminder' });
  assert.equal(copy.title, "@ben's change to Supper Club is ready to try");
  assert.equal(copy.body, 'Sunday host reminder');
  if (!globalThis.window) globalThis.window = globalThis;
  loadTsx('frontend/src/features/notifications/notifications.js');
  const row = globalThis.window.Notifications._rowView({
    id: 1, kind: 'change_ready', createdAt: new Date().toISOString(), readAt: null,
    appName: 'Supper Club', appSlug: 'supper-club', sourceUsername: 'ben', sessionTitle: 'Sunday host reminder', sessionId: 5,
  });
  assert.equal(row.label, 'Ready to try');
  assert.equal(row.by, 'ben');
  assert.equal(row.icon, '\u{1F440}');
  assert.match(read('src/services/notifications.js'), /vote_cast: \{ kinds: \['pr_proposed', 'stale_pr', 'revision_recheck', 'change_ready'\]/);
});

// ── Against the full schema ──

test('B7: who approves, who is told, and the card, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_ready_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(read('src/db/schema.sql'));
  const governance = require('../src/services/governance');
  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2)
     RETURNING id, username, is_synthetic AS "isSynthetic", has_platform_access AS "hasPlatformAccess"`,
    [username, synthetic],
  )).rows[0];
  const homeroomBot = await user('homeroom_bot', true);
  const maya = await user('maya');
  const ben = await user('ben');
  const ada = await user('ada');
  const set = (key, value) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
  await set('homeroom_bot_dm_users', JSON.stringify(['maya', 'ben']));
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
      await pool.query(
        `INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [app.id, m.id],
      );
    }
    governance.invalidateGovernance(app.id);
    return app;
  };
  const active = (app, people) => Promise.all(people.map((p) => pool.query(
    `INSERT INTO app_activity (app_id, user_id, date, seconds_spent) VALUES ($1, $2, CURRENT_DATE, 120)
     ON CONFLICT DO NOTHING`, [app.id, p.id],
  )));
  const change = async (app, requester, issueNumber) => {
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, promoted_at, check_state)
       VALUES ($1, $2, $3, 'promoted', 'Sunday reminder', NOW(), 'passing') RETURNING id`,
      [app.id, homeroomBot.id, `bot-${app.slug}-${issueNumber}`],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, asked_text)
       VALUES ($1, $2, $3, 'Sunday reminder', 'Remind us on Sundays')`,
      [app.id, issueNumber, requester.id],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id, build_ok)
       VALUES ($1, $2, 'live', 'ready', $3, TRUE)`,
      [app.id, issueNumber, s.id],
    );
    return s.id;
  };
  const card = async (userId, sessionId) => (await pool.query(
    `SELECT m.id, m.content, m.metadata->'homeroomBot' AS meta
       FROM homeroom_bot_dm_messages d JOIN conversation_messages m ON m.id = d.message_id
       JOIN homeroom_bot_runs r ON r.id = d.run_id
      WHERE d.user_id = $1 AND d.kind = 'proposal' AND r.proposal_session_id = $2
      ORDER BY m.id DESC LIMIT 1`,
    [userId, sessionId],
  )).rows[0];
  const told = async (sessionId) => (await pool.query(
    `SELECT u.username, n.detail, n.source_user_id FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE n.session_id = $1 AND n.kind = 'change_ready' ORDER BY u.username`,
    [sessionId],
  )).rows;

  await t.test('just you: her Yes is the last one needed, and nobody else is told', async () => {
    const solo = await project('plant-pal', 'Plant Pal', { members: [maya] });
    const id = await change(solo, maya, 2);
    const state = await dm.approvalState(pool, { sessionId: id, userId: maya.id });
    assert.deepEqual([state.audience, state.counts, state.already, state.last], ['solo', true, false, true]);
    await dm.noteChangeReady(pool, id, { bot: homeroomBot, domain: 'app.example.test' });
    const sent = await card(maya.id, id);
    assert.equal(sent.meta.ready.group, false);
    assert.equal(sent.meta.ready.last, true);
    assert.deepEqual(sent.meta.actions.map((a) => a.id), ['try', 'approve', 'change']);
    assert.equal(sent.meta.actions[1].epoch, 0);
    assert.equal(sent.meta.askedText, 'Remind us on Sundays');
    assert.match(sent.content, /It's ready to try\. Approve it when you're happy with it, and it goes live\.$/);
    assert.deepEqual(await told(id), [], 'nobody else must approve');
    // A Yes, from the card or anywhere, settles it on every device.
    assert.equal(await dm.noteApproved(pool, id, maya.id), 1);
    assert.deepEqual([(await card(maya.id, id)).meta.status, (await card(maya.id, id)).meta.chosen], ['answered', 'approve']);
  });

  await t.test('a private community: the others active on it are told once per version, and the asker sees who it waits on', async () => {
    const club = await project('supper-club', 'Supper Club', { members: [ben, ada] });
    await active(club, [ben, ada]);
    const id = await change(club, ben, 4);
    const state = await dm.approvalState(pool, { sessionId: id, userId: ben.id });
    assert.deepEqual([state.audience, state.counts, state.last, state.needed], ['invited', true, false, 2]);
    assert.deepEqual(await dm.needsYesFrom(pool, state, { except: [ben.id] }), [ada.id]);
    await dm.noteChangeReady(pool, id, { bot: homeroomBot, domain: 'app.example.test' });
    const sent = await card(ben.id, id);
    assert.deepEqual(sent.meta.ready, { group: true, last: false, waitingOn: ['ada'] });
    assert.deepEqual(sent.meta.actions.map((a) => a.id), ['try', 'approve', 'change']);
    assert.deepEqual(await told(id), [{ username: 'ada', detail: 'epoch:0', source_user_id: ben.id }]);
    await dm.noteApproversReady(pool, { sessionId: id, epoch: 0, requesterId: ben.id });
    assert.equal((await told(id)).length, 1, 'once per version');
    await pool.query('UPDATE chat_sessions SET approval_epoch = 1 WHERE id = $1', [id]);
    await dm.noteChangeReady(pool, id, { bot: homeroomBot, domain: 'app.example.test' });
    assert.deepEqual((await told(id)).map((r) => r.detail).sort(), ['epoch:0', 'epoch:1'], 'a new version asks again');
    const older = (await pool.query(
      `SELECT m.metadata->'homeroomBot' AS meta FROM homeroom_bot_dm_messages d JOIN conversation_messages m ON m.id = d.message_id
        WHERE d.user_id = $1 AND d.kind = 'proposal' ORDER BY m.id`,
      [ben.id],
    )).rows;
    assert.deepEqual([older[0].meta.status, older[0].meta.updated], ['closed', true], 'the older version\'s card gives way');
    // Ada has said Yes: she is not asked, and nobody is left to ask.
    await pool.query(
      `INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch) VALUES ($1, $2, 'yes', 1)`, [id, ada.id],
    );
    assert.deepEqual(await dm.needsYesFrom(pool, await dm.approvalState(pool, { sessionId: id }), { except: [ben.id] }), []);
  });

  await t.test('a public community tells nobody this way, unless it names its approvers', async () => {
    const town = await project('town-square', 'Town Square', { view: 'public', members: [ben, ada, maya] });
    await active(town, [ben, ada, maya]);
    const id = await change(town, ben, 6);
    const state = await dm.approvalState(pool, { sessionId: id, userId: ben.id });
    assert.equal(state.audience, 'open');
    assert.deepEqual(await dm.needsYesFrom(pool, state, { except: [ben.id] }), []);
    await pool.query(`UPDATE apps SET approver_policy = 'invited' WHERE id = $1`, [town.id]);
    await pool.query(`INSERT INTO app_approvers (app_id, user_id, status) VALUES ($1, $2, 'member')`, [town.id, ada.id]);
    governance.invalidateGovernance(town.id);
    const named = await dm.approvalState(pool, { sessionId: id, userId: ben.id });
    assert.equal(named.counts, false, 'only the named approvers\' Yes counts');
    assert.deepEqual(await dm.needsYesFrom(pool, named, { except: [ben.id] }), [ada.id]);
    await dm.noteChangeReady(pool, id, { bot: homeroomBot, domain: 'app.example.test' });
    const sent = await card(ben.id, id);
    assert.deepEqual(sent.meta.actions.map((a) => a.id), ['try', 'change'], 'no Approve for a Yes that does not count');
    assert.match(sent.content, /It goes live once it's approved\.$/);
    assert.deepEqual((await told(id)).map((r) => r.username), ['ada']);
  });

  await t.test('the card names the change: the build\'s description, else the spec title, else nothing', async () => {
    const say = async (sessionId, description) => pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata) VALUES ($1, 'system', 'Built it.', $2)`,
      [sessionId, JSON.stringify({ ...(description ? { proposalDescription: description } : {}) })],
    );
    // The latest system row's proposalDescription, credit line stripped and clipped.
    const described = await project('soup-log', 'Soup Log', { members: [maya] });
    const describedId = await change(described, maya, 8);
    await say(describedId, 'Tracks which soups the household liked, which ones nobody finished, and what to buy for the next batch of stock before the market run.\n\nAsked for by @maya');
    await dm.noteChangeReady(pool, describedId, { bot: homeroomBot, domain: 'app.example.test' });
    const describedCard = await card(maya.id, describedId);
    assert.match(describedCard.meta.ready.summary, /^Tracks which soups the household liked/);
    assert.ok(describedCard.meta.ready.summary.endsWith('…'), 'clipped to one line');
    assert.ok(!/Asked for by/.test(describedCard.meta.ready.summary), 'the credit line is not on the card');

    // No description row: the spec's "# " title instead.
    const titled = await project('pantry', 'Pantry', { members: [maya] });
    const titledId = await change(titled, maya, 9);
    await pool.query('UPDATE chat_sessions SET spec_md = $2 WHERE id = $1', [titledId, '# Add a weekly reminder\n\nThe body of the spec.']);
    await dm.noteChangeReady(pool, titledId, { bot: homeroomBot, domain: 'app.example.test' });
    assert.equal((await card(maya.id, titledId)).meta.ready.summary, 'Add a weekly reminder');

    // Neither: the card goes out without the line, as it did before.
    const bare = await project('bare-shelf', 'Bare Shelf', { members: [maya] });
    const bareId = await change(bare, maya, 10);
    await dm.noteChangeReady(pool, bareId, { bot: homeroomBot, domain: 'app.example.test' });
    assert.equal((await card(maya.id, bareId)).meta.ready.summary, undefined);
  });
});
