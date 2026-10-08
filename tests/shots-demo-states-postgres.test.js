'use strict';

// The before & after shots demo states (src/services/shots-demo-states.js)
// against the REAL schema in two throwaway PostgreSQL databases, named as a
// shots pair's base and head are. Pinned here: every state goes into both
// copies or neither (a column one side lacks, or a state that fails on one
// side, leaves it out of both); a second install finds nothing to add; and
// each state reads back through the platform's own code the way its screen
// needs it. Skipped when no server is reachable, and required when
// TEST_DATABASE_URL is set, the same contract as tests/communities-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const dbManager = require('../src/services/db-manager');
const shotsFixtures = require('../src/services/shots-fixtures');
const demoStates = require('../src/services/shots-demo-states');
const agentSessions = require('../src/services/agent-sessions');
const friends = require('../src/services/friends');
const { loadOnboarding } = require('../src/services/topochain/challenge-onboarding');
const { loadCadence } = require('../src/services/topochain/challenge-scorer');
const { TEMPLATE_JOIN_COLUMNS_SQL, buildChallengeListItem } = require('../src/routes/topochain/challenge-view');
const { attachForkLineage } = require('../src/routes/apps');
const suggestBack = require('../src/services/suggest-back');
const conversations = require('../src/services/conversations');
const botActivity = require('../src/services/homeroom-bot-activity');
const { currentVotePredicateSql } = require('../src/services/pr-vote-revision');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SLUG = 'usernode-2d5619';

// What a shots copy holds before the demo states: the fixture personas, the
// platform app, the staging seeds' topochain season the challenge states join
// and their fork-lineage source the member's remix points at
// (src/db/migrate.js), beside a newer season of production's. No Homeroom
// bot account: the bot run card's state makes one where a copy has none.
async function seedCopy(pool) {
  await pool.query(
    `INSERT INTO users (username, password, is_admin, admin_readonly) VALUES
       ('usernode-capture', 'x', FALSE, FALSE),
       ('usernode-capture-admin', 'x', TRUE, TRUE),
       ('staging-demo-general-lin', 'x', FALSE, FALSE),
       ('staging-demo-user', 'staging-demo-not-a-login', FALSE, FALSE)`
  );
  await pool.query(`INSERT INTO apps (name, slug, status) VALUES ('Homeroom', $1, 'running')`, [SLUG]);
  await pool.query(
    `INSERT INTO apps (name, slug, status, view_visibility, created_by)
     SELECT 'Staging demo forkable app', 'staging-demo-forkable', 'running', 'public', id
       FROM users WHERE username = 'staging-demo-user'`
  );
  await pool.query(
    `INSERT INTO seasons (id, name, starts_at, ends_at, is_active, internal, display_order) VALUES
       (77, 'Pre Season 2', NOW() - INTERVAL '10 days', NOW() + INTERVAL '50 days', TRUE, FALSE, 1),
       (900500, 'Staging Demo Season (topochain)', NOW() - INTERVAL '60 days', NOW() + INTERVAL '30 days', TRUE, FALSE, 2)`
  );
  await pool.query(
    `INSERT INTO season_events (id, season_id, name, starts_at, ends_at, scoring_formula, is_active, internal)
     VALUES (900501, 900500, 'Staging Demo Event (season standings)', NOW() - INTERVAL '1 hour',
             NOW() + INTERVAL '30 days', '{"metrics": [], "offchain_weight": 1}'::jsonb, TRUE, FALSE)`
  );
  await pool.query(
    `INSERT INTO challenge_templates (id, category, goal, task, reward)
     VALUES (900502, 'social', 'Share the season announcement', 'Share it.', '50 points')`
  );
  await pool.query(
    `INSERT INTO challenges (id, season_event_id, challenge_template_id, enabled, completed, display_order)
     VALUES (900507, 900501, 900502, TRUE, FALSE, 3)`
  );
}

async function pairOfCopies(t) {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return null;
  }
  const runId = crypto.randomBytes(16).toString('hex');
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  const sides = {};
  for (const side of ['base', 'head']) {
    const name = dbManager.shotsDbName(SLUG, runId, side);
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN); url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: String(url), max: 4 });
    await pool.query(schema);
    await seedCopy(pool);
    const input = { databaseUrl: String(url), slug: SLUG, runId, side, selfAppSlug: SLUG };
    await shotsFixtures.ensureFullAdminIdentity(input);
    sides[side] = { name, pool, input };
  }
  t.after(async () => {
    for (const { pool, name } of Object.values(sides)) {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    }
    await admin.end();
  });
  return sides;
}

test('demo states go into both shots copies or neither, once', { timeout: 180000 }, async (t) => {
  const copies = await pairOfCopies(t);
  if (!copies) return;
  const { base, head } = copies;

  assert.deepEqual(await demoStates.inspectDemoStates(base.input), demoStates.STATE_IDS,
    'a copy with the staging seeds can hold every state');
  // A revision whose schema lacks what a state writes cannot hold it.
  await head.pool.query('DROP TABLE friendships CASCADE');
  const headReady = await demoStates.inspectDemoStates(head.input);
  assert.ok(!headReady.includes('shots-demo-member-friend-request-v1'));
  const both = demoStates.STATE_IDS.filter((id) => headReady.includes(id));
  assert.equal(both.length, demoStates.STATE_IDS.length - 1);

  // A state that fails on one side while being written is left out of both.
  await head.pool.query(
    `ALTER TABLE homeroom_bot_runs ADD CONSTRAINT head_refuses_fixture CHECK (build_branch NOT LIKE '%shots-fixture%')`);
  const result = await demoStates.installDemoStates({ base: base.input, head: head.input }, both);
  assert.deepEqual(result.skipped.map((state) => state.id), ['shots-demo-homeroom-bot-verdict-v1']);
  assert.deepEqual(result.installed.map((state) => state.id),
    both.filter((id) => id !== 'shots-demo-homeroom-bot-verdict-v1'));
  // The verdict's run is the one with a build; the bot run card's has none.
  for (const { pool } of [base, head]) {
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM homeroom_bot_runs WHERE build_branch IS NOT NULL'))
      .rows[0].n, 0);
  }
  assert.equal((await base.pool.query('SELECT COUNT(*)::int AS n FROM friendships')).rows[0].n, 0,
    'base could hold the friend request; head could not, so neither has it');

  // The same rows on both sides, and nothing left to add a second time.
  const shape = async (pool) => (await pool.query(
    `SELECT (SELECT array_agg(id ORDER BY id) FROM agent_sessions) AS sessions,
            (SELECT array_agg(id ORDER BY id) FROM chat_sessions) AS changes,
            (SELECT array_agg(id ORDER BY id) FROM challenges) AS challenges,
            (SELECT array_agg(measure ORDER BY measure) FROM challenge_scoring_rules) AS rules,
            (SELECT array_agg(slug ORDER BY slug) FROM apps) AS apps,
            (SELECT array_agg(id ORDER BY id) FROM conversations WHERE kind = 'direct') AS chats,
            (SELECT COUNT(*)::int FROM homeroom_bot_dm_messages) AS cards,
            (SELECT COUNT(*)::int FROM user_activities) AS credits,
            (SELECT COUNT(*)::int FROM pr_votes) AS votes`)).rows[0];
  assert.deepEqual(await shape(base.pool), await shape(head.pool));
  // Only what was left out is still free: the friend request base could
  // hold and head could not, and the verdict head refused.
  assert.deepEqual(await demoStates.inspectDemoStates(base.input),
    ['shots-demo-homeroom-bot-verdict-v1', 'shots-demo-member-friend-request-v1']);
  assert.deepEqual(await demoStates.inspectDemoStates(head.input), ['shots-demo-homeroom-bot-verdict-v1']);

  // Every row is in the reserved block or marked as the fixture's.
  const [low, high] = demoStates.RESERVED_RANGE;
  for (const table of ['agent_sessions', 'chat_sessions', 'challenges', 'challenge_templates', 'apps', 'conversations']) {
    const { rows } = await base.pool.query(`SELECT id FROM ${table} WHERE id >= 990000`);
    assert.ok(rows.every((row) => Number(row.id) >= low && Number(row.id) <= high), table);
  }

  // The brief tells the agent who each state is for and where it is.
  for (const state of result.installed) {
    assert.ok(['member', 'read_only_admin', 'full_admin'].includes(state.persona), state.id);
    assert.ok(state.shows.length && state.shows.every((item) => item.state && item.path.startsWith('/')), state.id);
  }
});

test('each demo state reads back the way its screen needs it', { timeout: 180000 }, async (t) => {
  const copies = await pairOfCopies(t);
  if (!copies) return;
  const { base, head } = copies;
  const result = await demoStates.installDemoStates({ base: base.input, head: head.input }, demoStates.STATE_IDS);
  assert.deepEqual(result.skipped, []);
  const pool = base.pool;
  const ids = Object.fromEntries((await pool.query(
    `SELECT username, id FROM users WHERE username IN
       ('usernode-capture', 'usernode-capture-admin', 'usernode-shots-full-admin', 'staging-demo-general-lin')`))
    .rows.map((row) => [row.username, Number(row.id)]));
  const member = ids['usernode-capture'];

  // Agent runs: two working conversations, one asked to stop, both untitled
  // so that no list on every screen (the rail's Recents, the menu) spins;
  // and six titled ones, so the menu's list (five) offers Show more.
  const { sessions } = await agentSessions.listAgentSessions(pool, { userId: member });
  const busy = sessions.filter((s) => s.busy);
  assert.deepEqual(busy.map((s) => s.id).sort(), [demoStates.IDS.runningSession, demoStates.IDS.stoppingSession]);
  assert.ok(busy.every((s) => !s.title && !s.activeChange));
  assert.equal(sessions.filter((s) => s.title).length, 6, 'the preview change and five more');
  // Nothing in a copy renews a lease, and one not renewed for 90 seconds
  // reads as interrupted: the fixture's is renewed past the pair's life.
  const { rows: leases } = await pool.query(
    `SELECT (active_turn->>'renewedAt')::timestamptz > NOW() + INTERVAL '1 hour' AS ahead
       FROM agent_sessions WHERE active_turn IS NOT NULL`);
  assert.deepEqual(leases.map((row) => row.ahead), [true, true]);
  const running = await agentSessions.readState(pool, { userId: member, id: demoStates.IDS.runningSession });
  assert.equal(running.stale, false);
  assert.equal(running.lease.stopping, false);
  const stopping = await agentSessions.readState(pool, { userId: member, id: demoStates.IDS.stoppingSession });
  assert.equal(stopping.lease.stopping, true);
  assert.ok(Date.now() - stopping.lease.stopRequestedAt >= 3000, 'past the "Stopping the agent…" moment');

  // A change of the member's with its deployed preview, still proposable.
  const preview = await agentSessions.readState(pool, { userId: member, id: demoStates.IDS.previewSession });
  const card = preview.messages.find((message) => message.metadata?.stagingUrl);
  assert.equal(card.changeId, demoStates.IDS.previewChange);
  assert.match(card.metadata.stagingUrl, /^https:\/\/[a-z-]+\.invalid$/);
  assert.equal(preview.session.activeChange.status, 'active');

  // A proposal whose only vote is the member's, on an earlier version.
  const { rows: [votes] } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE ${currentVotePredicateSql('pv', 'cs')})::int AS counted,
            COUNT(*)::int AS cast, MIN(cs.active_users_at_promote) AS at_promote,
            MIN(cs.votes_required) AS required, MIN(cs.status) AS status
       FROM pr_votes pv JOIN chat_sessions cs ON cs.id = pv.session_id
      WHERE cs.id = $1 AND pv.user_id = $2`,
    [demoStates.IDS.proposal, member]
  );
  assert.deepEqual(votes, { counted: 0, cast: 1, at_promote: 1, required: null, status: 'promoted' });
  const { rows: tail } = await pool.query(
    `SELECT msg_type FROM chat_messages WHERE thread_type = 'session' AND thread_ref = $1`, [demoStates.IDS.proposal]);
  assert.deepEqual(tail.map((row) => row.msg_type), ['vote']);

  // A proposal of the member's to make the app private, flagged as the
  // platform flags one, whose only Yes is its author's.
  const { rows: [visibility] } = await pool.query(
    `SELECT cs.user_id, cs.status, cs.branch_name, cs.requires_explicit_approval, cs.explicit_approval_reason,
            COUNT(pv.*) FILTER (WHERE ${currentVotePredicateSql('pv', 'cs')})::int AS counted
       FROM chat_sessions cs LEFT JOIN pr_votes pv ON pv.session_id = cs.id
      WHERE cs.id = $1
      GROUP BY cs.id`,
    [demoStates.IDS.visibilityProposal]
  );
  assert.deepEqual(visibility, {
    user_id: member, status: 'promoted', branch_name: 'visibility/shots-fixture-990858',
    requires_explicit_approval: true, explicit_approval_reason: 'visibility', counted: 1,
  });

  // A live Ready verdict with its build, on the self app.
  const { rows: [verdict] } = await pool.query(
    `SELECT mode, verdict, build_ok, proposal_session_id FROM homeroom_bot_runs WHERE build_branch IS NOT NULL`);
  assert.deepEqual(verdict, { mode: 'live', verdict: 'ready', build_ok: true, proposal_session_id: demoStates.IDS.proposal });

  // First challenges, finished by every persona so nothing else is hidden;
  // an Always open challenge counted just now.
  for (const persona of ['usernode-capture', 'usernode-capture-admin', 'usernode-shots-full-admin']) {
    const onboarding = await loadOnboarding(pool, ids[persona], { eventId: 900501 });
    assert.deepEqual(onboarding.summary, { total: 3, completed: 3, unlocked: true, event_id: 900501 }, persona);
  }
  const { rows: [rule] } = await pool.query(
    `SELECT r.interval_minutes, r.last_scored_at > NOW() - INTERVAL '1 minute' AS fresh, t.category
       FROM challenge_scoring_rules r JOIN challenges c ON c.id = r.challenge_id
       JOIN challenge_templates t ON t.id = c.challenge_template_id
      WHERE r.measure = 'TRY_APPS'`);
  assert.deepEqual(rule, { interval_minutes: 60, fresh: true, category: 'PERSISTENT' });

  // The fixture season is the newest active one, so "your standing" asks
  // for it; and the member finished the event's open challenge.
  const { rows: [active] } = await pool.query(
    `SELECT id FROM seasons WHERE internal = FALSE AND is_active = TRUE ORDER BY starts_at DESC, id DESC LIMIT 1`);
  assert.equal(Number(active.id), 900500);
  const { rows: [credit] } = await pool.query(
    `SELECT points FROM user_activities WHERE user_id = $1 AND challenge_id = 900507`, [member]);
  assert.equal(Number(credit.points), 50);

  // A friend request to the member, on the profile and not in the bell,
  // whose badge would be on every screen.
  const list = await friends.listFor(pool, member);
  assert.deepEqual(list.incoming.map((person) => person.username), ['staging-demo-general-lin']);

  // This week, read as the Challenges tab reads its event (routes/topochain/
  // public.js): the two weekly challenges and the one scored on sending a
  // proposal, grouped by their cards' label, each open for three more days.
  // Only the proposal one and the Always open one are counted: hourly, and
  // just now, so their cards say when they are next counted.
  const { rows: listed } = await pool.query(
    `SELECT c.id, c.season_event_id, c.challenge_template_id, c.enabled, c.completed,
            c.goal, c.task, c.reward, c.description, c.requirements,
            c.schedule_start, c.schedule_end, c.reward_logic, c.cta_button, c.cta_label, c.cta_link,
            c.metric_type, c.metric_target, c.metric_label,
            ${TEMPLATE_JOIN_COLUMNS_SQL}
       FROM challenges c JOIN challenge_templates ct ON ct.id = c.challenge_template_id
      WHERE c.season_event_id = 900501 AND c.enabled = TRUE
      ORDER BY c.display_order ASC, c.id ASC`);
  const thisWeek = listed.map(buildChallengeListItem).filter((item) => item.card_preview.label === 'WEEKLY');
  assert.deepEqual(thisWeek.map((item) => item.id), [...demoStates.IDS.weeklyChallenges, demoStates.IDS.proposalChallenge]);
  for (const item of thisWeek) {
    const left = new Date(item.effective.schedule_end).getTime() - Date.now();
    assert.ok(new Date(item.effective.schedule_start).getTime() < Date.now(), item.id);
    assert.ok(left > 2 * 86400000 && left <= 3 * 86400000, `${item.id} has three days left`);
    assert.ok(!item.completed && item.enabled, item.id);
  }
  const cadence = await loadCadence(pool, 900501, listed, { defaultMinutes: 10 });
  assert.deepEqual([...cadence.keys()].sort(), [demoStates.IDS.alwaysOpenChallenge, demoStates.IDS.proposalChallenge]);
  const counted = cadence.get(demoStates.IDS.proposalChallenge);
  assert.equal(counted.intervalMinutes, 60);
  assert.ok(Date.now() - counted.lastScoredAt < 60000);
  const { rows: [proposalRule] } = await pool.query(
    `SELECT measure, enabled FROM challenge_scoring_rules WHERE challenge_id = $1`, [demoStates.IDS.proposalChallenge]);
  assert.deepEqual(proposalRule, { measure: 'PROPOSAL_SENT', enabled: true });

  // A remix of the member's: its ⋯ offers them "Suggest this back", read
  // through the app payload's lineage and the dialog's own condition, and
  // the dialog's preview says why a copy cannot send it.
  const { rows: [remix] } = await pool.query('SELECT * FROM apps WHERE slug = $1', ['shots-demo-member-remix']);
  assert.equal(Number(remix.id), demoStates.IDS.memberRemix);
  assert.deepEqual([remix.collab_visibility, remix.view_visibility, remix.self_hosted], ['private', 'private', false]);
  const { rows: [owner] } = await pool.query(
    `SELECT cm.source FROM community_members cm WHERE cm.community_id = $1 AND cm.user_id = $2`,
    [remix.community_id, member]);
  assert.equal(owner.source, 'creator');
  const payload = { ...remix };
  await attachForkLineage(pool, payload);
  const { loadTsx } = require('./lib/render-tsx');
  const { suggestBackTarget } = loadTsx('frontend/src/features/dev-board/suggest-back-dialog.tsx');
  assert.deepEqual(suggestBackTarget(payload, member), { slug: 'staging-demo-forkable', name: 'Staging demo forkable app' });
  assert.equal(suggestBackTarget(payload, ids['usernode-capture-admin']), null, 'only its owner is offered it');
  const suggested = await suggestBack.preview({ pool, user: { id: member, username: 'usernode-capture' }, fork: remix });
  assert.equal(suggested.reason.code, 'lineage_missing');
  assert.equal(suggested.original.slug, 'staging-demo-forkable');

  // The member's chat with the Homeroom bot: two activity cards on one
  // request, read through the cards' own reader. The older one's build is
  // ready and waiting its turn, so it is working though a newer card began
  // on the same request; both are read, and nothing went to the bell.
  const viewer = { id: member, username: 'usernode-capture' };
  const { cards } = await botActivity.cardsFor(pool, { user: viewer });
  assert.equal(cards.length, 2);
  const [newer, older] = cards;
  assert.ok(older.messageId < newer.messageId);
  assert.equal(older.state, 'working');
  assert.equal(older.stage, 'build_queued');
  assert.equal(newer.state, 'working', 'the request\'s own progress: its build is waiting its turn');
  assert.equal(older.links.request, `#app/${SLUG}/dev/issues/${demoStates.IDS.botRequest}`);
  const chats = await conversations.listConversations(pool, viewer);
  const chat = chats.find((conversation) => conversation.id === demoStates.IDS.botConversation);
  assert.equal(chat.homeroomBot, true);
  assert.equal(chat.unreadCount, 0);
  assert.equal(chat.latestMessage.id, newer.messageId);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM notifications')).rows[0].n, 0);
});

test('the demo states refuse a database that is not the run\'s own', async () => {
  const input = {
    databaseUrl: 'postgres://fixture@db/app_usernode_2d5619', slug: SLUG,
    runId: 'b'.repeat(32), side: 'base', selfAppSlug: SLUG,
  };
  await assert.rejects(demoStates.inspectDemoStates(input), /isolated shots database/);
  await assert.rejects(demoStates.installDemoStates({ base: input, head: { ...input, side: 'head' } },
    demoStates.STATE_IDS), /isolated shots database/);
});
