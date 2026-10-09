'use strict';

// Demo states for before & after shots of Homeroom's own proposals.
//
// A shots pair is two copies of a redacted production database, each booted
// by its own revision with that revision's staging seeds. Some screens a
// proposal changes still cannot be reached there: no model key is configured
// (unreviewed code must not spend credits), nothing in the background runs,
// and most staging fixtures belong to the read-only admin the declared checks
// sign in as. These rows give the other personas those screens too.
//
// Each state is written by the platform, after both copies have booted, to
// BOTH databases or to neither: a state whose tables, columns or ids one side
// lacks is left out of the run rather than drawn on one side only. Every row
// is an obviously fake "[shots fixture]" row with a reserved id, written only
// into the run's two disposable databases (assertShotsDatabase). Nothing here
// fakes a model: a fake model would exist only in the "after" build.
//
// Both sides are written at one moment (installDemoStates): a time a state
// writes, as NOW() in its SQL or from `ctx.at`, is that instant on both,
// never a read of either side's own clock.
//
// Reserved ids: 990840-990895, across every table here, beside the shots
// session copies (990896-990899, shots-fixtures.js). tests/staging-demo-id-
// ranges.test.js keeps the staging seeds and mocks out of the block.
//
// The states are written by the DEPLOYED platform's copy of this file, not
// by either revision under test, so a state a proposal adds here reaches
// shots only once it has merged. Data a proposal needs for its own shots
// belongs in its staging seeds (src/db/migrate.js), which each side runs for
// its own revision.

const dbRetry = require('./db-retry');
const shotsFixtures = require('./shots-fixtures');

const IDS = Object.freeze({
  runningSession: 990840,
  stoppingSession: 990841,
  previewSession: 990842,
  previewChange: 990843,
  listSessions: Object.freeze([990844, 990845, 990846, 990847, 990848]),
  proposal: 990849,
  onboardingTemplates: Object.freeze([990850, 990851, 990852]),
  alwaysOpenTemplate: 990853,
  onboardingChallenges: Object.freeze([990854, 990855, 990856]),
  alwaysOpenChallenge: 990857,
  visibilityProposal: 990858,
  weeklyTemplates: Object.freeze([990860, 990861]),
  weeklyChallenges: Object.freeze([990862, 990863]),
  proposalTemplate: 990864,
  proposalChallenge: 990865,
  memberRemix: 990866,
  botConversation: 990867,
  // A request number on the platform app, not a row id: its GitHub issues
  // are nowhere near it, so the bot's records on it are the fixture's alone.
  botRequest: 990868,
  awaitingProposal: 990869,
  firstVersionApp: 990870,
});
const RESERVED_RANGE = Object.freeze([990840, 990895]);

// The staging seeds' own topochain fixtures (src/db/migrate.js,
// seedStagingTopochain): the season the challenge states join, and the event
// the Challenges tab opens on.
const FIXTURE_SEASON_ID = 900500;
const FIXTURE_EVENT_ID = 900501;
// The one of its three cards the organiser has not closed.
const FIXTURE_EVENT_CHALLENGE_ID = 900507;
// A real staging build's preview address (.invalid never resolves): the
// same one the staging agent-build fixture uses.
const PREVIEW_URL = 'https://staging-fixture-preview.invalid';
// Rows without a reserved id are told apart by these.
const FIXTURE_MARK = 'shots-demo';
const COMPLETION = JSON.stringify({ kind: 'challenge_completion', fixture: FIXTURE_MARK });
const BOT_BRANCH = 'homeroom-bot/shots-fixture-900003';
// The staging seeds' fork-lineage source (src/db/migrate.js,
// seedStagingForkLineage): a public app that is not the platform's own, which
// the member's remix was copied from.
const FIXTURE_FORK_SOURCE_SLUG = 'staging-demo-forkable';
const REMIX_SLUG = 'shots-demo-member-remix';
// The Homeroom bot's account (homeroom-bot-dm.js botAccount).
const BOT_USERNAME = 'homeroom_bot';
// The staging mock request nothing else marks (src/routes/issues.js
// stagingMockIssues): the copies have no GitHub, so their Requests board is
// those mocks, and the member's change waiting for approval names this one.
const FIXTURE_REQUEST_NUMBER = 900017;
// The staging seeds' topochain players entered for the whole fixture season
// (seedStagingTopochain), by username; the Discord handle each is given; and
// how long ago, in minutes, each of their two activities happened.
const STANDINGS_PLAYERS = Object.freeze([
  ['staging-demo-topochain-participant-6', 'shots_fixture_ada', [40, 3 * 1440]],
  ['staging-demo-topochain-participant-5', 'shots_fixture_bo', [5 * 60, 6 * 1440]],
  ['staging-demo-topochain-participant-2', 'shots_fixture_cy', [26 * 60, 12 * 1440]],
]);
// The fixture event's two seeded challenges the activities are recorded on.
const STANDINGS_CHALLENGES = Object.freeze([
  [900505, 250, 'Reported a reproducible bug.'],
  [900506, 100, 'Sent a testnet transaction.'],
]);
const FIRST_VERSION_SLUG = 'shots-demo-member-book-club';
const FIRST_VERSION_NAME = '[shots fixture] Book club';

const sessionPath = (id) => `/#messages/agent/${id}`;

// ── Shape ────────────────────────────────────────────────────────────────

async function columnsOf(client, tables) {
  const { rows } = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
    [tables]
  );
  const found = new Map();
  for (const row of rows) {
    if (!found.has(row.table_name)) found.set(row.table_name, new Set());
    found.get(row.table_name).add(row.column_name);
  }
  return found;
}

async function hasShape(client, needs) {
  const found = await columnsOf(client, Object.keys(needs));
  return Object.entries(needs).every(([table, columns]) =>
    found.has(table) && columns.every((column) => found.get(table).has(column)));
}

// Every reserved id a state writes must be free on this side.
const TAKEN_SQL = Object.freeze({
  agent_sessions: 'SELECT COUNT(*)::int AS taken FROM agent_sessions WHERE id = ANY($1::bigint[])',
  chat_sessions: 'SELECT COUNT(*)::int AS taken FROM chat_sessions WHERE id = ANY($1::bigint[])',
  challenge_templates: 'SELECT COUNT(*)::int AS taken FROM challenge_templates WHERE id = ANY($1::bigint[])',
  challenges: 'SELECT COUNT(*)::int AS taken FROM challenges WHERE id = ANY($1::bigint[])',
  apps: 'SELECT COUNT(*)::int AS taken FROM apps WHERE id = ANY($1::bigint[])',
  conversations: 'SELECT COUNT(*)::int AS taken FROM conversations WHERE id = ANY($1::bigint[])',
});
async function idsFree(client, table, ids) {
  const { rows } = await client.query(TAKEN_SQL[table], [ids]);
  return rows[0].taken === 0;
}

const AGENT_SESSION_COLUMNS = ['id', 'user_id', 'title', 'title_source', 'status', 'focus_app_id',
  'focus_context', 'active_change_id', 'last_activity_at', 'created_at'];
const MESSAGE_COLUMNS = ['session_id', 'agent_session_id', 'role', 'content', 'metadata', 'created_at'];
const CHANGE_COLUMNS = ['id', 'app_id', 'user_id', 'branch_name', 'session_title', 'status',
  'agent_session_id', 'created_at', 'last_activity_at'];
const WEEKLY_TEMPLATE_COLUMNS = ['id', 'category', 'goal', 'task', 'reward', 'description', 'metric_type',
  'metric_target', 'metric_label', 'illustration', 'created_at', 'updated_at'];
const WEEKLY_CHALLENGE_COLUMNS = ['id', 'season_event_id', 'challenge_template_id', 'enabled', 'completed',
  'display_order', 'schedule_start', 'schedule_end'];

// The fixture event the challenge states join, where the staging seeds put it.
async function fixtureEventFound(client) {
  const event = await client.query(
    `SELECT 1 FROM season_events WHERE id = $1 AND season_id = $2 AND internal = FALSE`,
    [FIXTURE_EVENT_ID, FIXTURE_SEASON_ID]
  );
  return event.rowCount === 1;
}

// ── Writers ─────────────────────────────────────────────────────────────

async function insertAgentSession(client, ctx, { id, title, minutesAgo }) {
  await client.query(
    `INSERT INTO agent_sessions
       (id, user_id, title, title_source, status, focus_app_id, focus_context,
        last_activity_at, created_at)
     VALUES ($1, $2, $3::text, CASE WHEN $3::text IS NULL THEN 'auto' ELSE 'manual' END, 'open', $4,
             '{}'::jsonb, NOW() - make_interval(mins => $5), NOW() - make_interval(mins => $5 + 20))`,
    [id, ctx.member.id, title, ctx.appId, minutesAgo]
  );
}

// A weekly challenge on the fixture event, in a week begun four days ago with
// three left, which the "This week" header counts down ("3d left").
async function insertWeeklyChallenge(client, {
  templateId, challengeId, order, goal, task, reward, description = null, metric = null, illustration,
}) {
  await client.query(
    `INSERT INTO challenge_templates
       (id, category, goal, task, reward, description, metric_type, metric_target, metric_label, illustration,
        created_at, updated_at)
     VALUES ($1, 'WEEKLY', $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())`,
    [templateId, `[shots fixture] ${goal}`, task, reward, description,
      metric ? 'count' : null, metric ? metric.target : null, metric ? metric.label : null, illustration]
  );
  await client.query(
    `INSERT INTO challenges
       (id, season_event_id, challenge_template_id, enabled, completed, display_order, schedule_start, schedule_end)
     VALUES ($1, $2, $3, TRUE, FALSE, $4, NOW() - INTERVAL '4 days', NOW() + INTERVAL '3 days')`,
    [challengeId, FIXTURE_EVENT_ID, templateId, order]
  );
}

async function insertUserMessage(client, { agentSessionId, changeId = null, content, minutesAgo }) {
  await client.query(
    `INSERT INTO chat_session_messages (session_id, agent_session_id, role, content, metadata, created_at)
     VALUES ($1, $2, 'user', $3, '{}'::jsonb, NOW() - make_interval(mins => $4))`,
    [changeId, agentSessionId, content, minutesAgo]
  );
}

// Whether the member's chat with the Homeroom bot can be the fixture's: the
// bot's account, when the copy has one, is a platform account with no chat
// with the member yet. The bot run card's state asks the same.
async function botChatFree(client, ctx) {
  const bot = (await client.query(
    'SELECT id, is_synthetic FROM users WHERE username = $1', [BOT_USERNAME])).rows[0];
  if (bot) {
    if (!bot.is_synthetic || Number(bot.id) === Number(ctx.member.id)) return false;
    const pair = await client.query(
      `SELECT 1 FROM conversation_direct_pairs
        WHERE user_low_id = LEAST($1::int, $2::int) AND user_high_id = GREATEST($1::int, $2::int)`,
      [ctx.member.id, bot.id]
    );
    if (pair.rowCount) return false;
  }
  return idsFree(client, 'conversations', [IDS.botConversation]);
}

// The member's chat with the Homeroom bot: the one the bot run card's state
// opened in this run, or opened here the same way, so either state can be
// written without the other. Resolves { botId, conversationId }.
async function memberBotChat(client, ctx) {
  await client.query(
    `INSERT INTO users (username, password, is_synthetic, display_name)
     VALUES ($1, 'staging-demo-not-a-login', TRUE, 'Homeroom bot')
     ON CONFLICT DO NOTHING`,
    [BOT_USERNAME]
  );
  const bot = (await client.query(
    'SELECT id FROM users WHERE username = $1 AND is_synthetic = TRUE', [BOT_USERNAME])).rows[0];
  if (!bot) throw new Error('The Homeroom bot fixture lost its account.');
  const conversationId = IDS.botConversation;
  const pair = await client.query(
    `SELECT conversation_id FROM conversation_direct_pairs
      WHERE user_low_id = LEAST($1::int, $2::int) AND user_high_id = GREATEST($1::int, $2::int)`,
    [ctx.member.id, bot.id]
  );
  if (pair.rowCount) {
    if (Number(pair.rows[0].conversation_id) !== conversationId) {
      throw new Error('The member already has a chat with the Homeroom bot.');
    }
    return { botId: bot.id, conversationId };
  }
  // As openAdmittedDirect opens it (conversations.js): both already in.
  await client.query(
    `INSERT INTO conversations (id, kind, created_by, status, created_at, updated_at)
     VALUES ($1, 'direct', $2, 'active', NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '30 minutes')`,
    [conversationId, bot.id]
  );
  await client.query(
    `INSERT INTO conversation_direct_pairs (conversation_id, user_low_id, user_high_id)
     VALUES ($1, LEAST($2::int, $3::int), GREATEST($2::int, $3::int))`,
    [conversationId, bot.id, ctx.member.id]
  );
  await client.query(
    `INSERT INTO conversation_members
       (conversation_id, user_id, role, status, invited_by, responded_at, joined_at)
     VALUES ($1, $2, 'member', 'member', $2, NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '30 minutes'),
            ($1, $3, 'member', 'member', $2, NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '30 minutes')`,
    [conversationId, bot.id, ctx.member.id]
  );
  return { botId: bot.id, conversationId };
}

// The bot's message to the member, and its record as news about one of
// their requests (homeroom-bot-dm.js sendDm, then the record its sender
// writes). Resolves the message's id.
async function insertBotDm(client, ctx, chat, {
  appId, issueNumber, kind, runId = null, content, key, metadata, minutesAgo,
}) {
  const sent = await client.query(
    `INSERT INTO conversation_messages (conversation_id, sender_id, content, idempotency_key, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NOW() - make_interval(mins => $6))
     RETURNING id`,
    [chat.conversationId, chat.botId, content, key, JSON.stringify({ homeroomBot: metadata }), minutesAgo]
  );
  const messageId = sent.rows[0].id;
  await client.query(
    `INSERT INTO homeroom_bot_dm_messages (message_id, user_id, conversation_id, app_id, issue_number, kind, run_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() - make_interval(mins => $8))`,
    [messageId, ctx.member.id, chat.conversationId, appId, issueNumber, kind, runId, minutesAgo]
  );
  return messageId;
}

// ── States ──────────────────────────────────────────────────────────────

const STATES = [
  {
    // The Stop control and the stopping status exist only during a run, and
    // these copies cannot start one ("LLM not configured"). Untitled, as a
    // conversation is before its first reply: a working one draws a spinner
    // in every list that shows it, and an untitled one stays out of the
    // rail's Recents and the menu, which are on every screen. Messages lists
    // it, and its own page is where the run is shown.
    id: 'shots-demo-member-agent-runs-v1',
    persona: 'member',
    needs: {
      agent_sessions: [...AGENT_SESSION_COLUMNS, 'active_turn'],
      chat_session_messages: MESSAGE_COLUMNS,
    },
    free: (client) => idsFree(client, 'agent_sessions', [IDS.runningSession, IDS.stoppingSession]),
    async install(client, ctx) {
      for (const [id, stop] of [[IDS.runningSession, false], [IDS.stoppingSession, true]]) {
        await insertAgentSession(client, ctx, { id, title: null, minutesAgo: 1 });
        await insertUserMessage(client, {
          agentSessionId: id, minutesAgo: 1,
          content: 'Make the empty state on the dev board friendlier.',
        });
        // Nothing in a copy renews a running agent's lease, and one not
        // renewed for 90 seconds reads as interrupted: this one is renewed
        // ahead, past the life of any shots pair.
        await client.query(
          `UPDATE agent_sessions SET active_turn = jsonb_build_object(
             'id', $2::text, 'startedAt', NOW() - INTERVAL '40 seconds',
             'renewedAt', NOW() + INTERVAL '6 hours', 'phase', 'mayor')
             || CASE WHEN $3 THEN jsonb_build_object(
                  'stopRequestedAt', NOW() - INTERVAL '10 seconds', 'stopRequestedBy', $4::text)
                ELSE '{}'::jsonb END
           WHERE id = $1`,
          [id, `shots-fixture-turn-${id}`, stop, ctx.member.username]
        );
      }
      return {
        shows: [
          { state: 'An agent run in progress, in a conversation not yet named: the composer shows Stop (and Save draft once you type).',
            path: sessionPath(IDS.runningSession) },
          { state: 'An agent run whose Stop was pressed and is taking longer than expected (Retry stop), in a conversation not yet named.',
            path: sessionPath(IDS.stoppingSession) },
        ],
      };
    },
  },
  {
    // A change of the member's whose staging preview has deployed: the
    // preview card and its "Propose to group". The read-only admin's
    // staging conversation has this card already; the member's copy does not.
    id: 'shots-demo-member-change-preview-v1',
    persona: 'member',
    needs: {
      agent_sessions: AGENT_SESSION_COLUMNS,
      chat_sessions: [...CHANGE_COLUMNS, 'staging_url', 'check_state'],
      chat_session_messages: MESSAGE_COLUMNS,
    },
    free: async (client) => await idsFree(client, 'agent_sessions', [IDS.previewSession])
      && idsFree(client, 'chat_sessions', [IDS.previewChange]),
    async install(client, ctx) {
      await insertAgentSession(client, ctx, {
        id: IDS.previewSession, title: '[shots fixture] A change with a deployed preview', minutesAgo: 3,
      });
      await client.query(
        `INSERT INTO chat_sessions
           (id, app_id, user_id, branch_name, session_title, status, agent_session_id,
            staging_url, check_state, created_at, last_activity_at)
         VALUES ($1, $2, $3, 'shots-fixture/member-preview', '[shots fixture] A change with a deployed preview',
                 'active', $4, $5, 'passing', NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '3 minutes')`,
        [IDS.previewChange, ctx.appId, ctx.member.id, IDS.previewSession, PREVIEW_URL]
      );
      await client.query('UPDATE agent_sessions SET active_change_id = $2 WHERE id = $1',
        [IDS.previewSession, IDS.previewChange]);
      await insertUserMessage(client, {
        agentSessionId: IDS.previewSession, changeId: IDS.previewChange, minutesAgo: 10,
        content: 'Add a short welcome line above the dev board.',
      });
      await client.query(
        `INSERT INTO chat_session_messages (session_id, agent_session_id, role, content, metadata, created_at)
         VALUES ($1, $2, 'system', 'Staging deployed!', $3::jsonb, NOW() - INTERVAL '3 minutes')`,
        [IDS.previewChange, IDS.previewSession, JSON.stringify({ stagingUrl: PREVIEW_URL, prNumber: null })]
      );
      return {
        shows: [{
          state: 'A change with a deployed preview: the preview card, Open preview and Propose to group (do not confirm the proposal).',
          path: sessionPath(IDS.previewSession),
        }],
      };
    },
  },
  {
    // Enough titled sessions that the menu's Agent sessions list is cut off
    // and offers "Show more" (it shows five).
    id: 'shots-demo-member-agent-list-v1',
    persona: 'member',
    needs: { agent_sessions: AGENT_SESSION_COLUMNS },
    free: (client) => idsFree(client, 'agent_sessions', IDS.listSessions),
    async install(client, ctx) {
      const titles = [
        '[shots fixture] Tidy the settings page',
        '[shots fixture] Sort the request list by votes',
        '[shots fixture] A clearer empty inbox',
        '[shots fixture] Bigger tap targets on the board',
        '[shots fixture] Name the weekly digest',
      ];
      for (const [index, id] of IDS.listSessions.entries()) {
        await insertAgentSession(client, ctx, { id, title: titles[index], minutesAgo: 30 + index * 15 });
      }
      return {
        shows: [{
          state: 'Six or more titled agent sessions, so the menu\'s Agent sessions list offers Show more.',
          path: '/#messages',
        }],
      };
    },
  },
  {
    // A proposal up for a vote whose threshold has moved since voting opened
    // ("was N when voting opened"), with a vote of the member's cast on an
    // earlier version, which is not counted ("Still yes?").
    id: 'shots-demo-proposal-vote-states-v1',
    persona: 'member',
    needs: {
      chat_sessions: ['id', 'app_id', 'user_id', 'branch_name', 'pr_number', 'pr_title', 'pr_summary_md',
        'status', 'promoted_at', 'votes_required', 'active_users_at_promote', 'approval_epoch',
        'check_state', 'created_at', 'last_activity_at'],
      pr_votes: ['session_id', 'user_id', 'vote', 'approval_epoch', 'created_at'],
      chat_messages: ['app_id', 'user_id', 'content', 'msg_type', 'metadata', 'thread_type', 'thread_ref', 'created_at'],
    },
    free: async (client, ctx) => {
      const pr = await client.query('SELECT 1 FROM chat_sessions WHERE app_id = $1 AND pr_number = $2',
        [ctx.appId, IDS.proposal]);
      return pr.rowCount === 0 && idsFree(client, 'chat_sessions', [IDS.proposal]);
    },
    async install(client, ctx) {
      // By the read-only admin, so the member can vote on it. Checks have
      // not passed, so no vote in the copy can start a merge.
      await client.query(
        `INSERT INTO chat_sessions
           (id, app_id, user_id, branch_name, pr_number, pr_title, pr_summary_md, status,
            promoted_at, votes_required, active_users_at_promote, approval_epoch, check_state, created_at,
            last_activity_at)
         VALUES ($1, $2, $3, 'shots-fixture/vote-states', $1,
                 '[shots fixture] A proposal changed since you voted',
                 'A demo proposal: its author pushed a new version after people voted, and more people joined since voting opened.',
                 'promoted', NOW() - INTERVAL '2 hours', NULL, 1, 1, 'pending', NOW() - INTERVAL '3 hours', NOW())`,
        [IDS.proposal, ctx.appId, ctx.admin.id]
      );
      // An explicit earlier epoch: left NULL, a trigger stamps the current one.
      await client.query(
        `INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch, created_at)
         VALUES ($1, $2, 'yes', 0, NOW() - INTERVAL '90 minutes')`,
        [IDS.proposal, ctx.member.id]
      );
      await client.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref, created_at)
         VALUES ($1, $2, $3, 'vote', $4::jsonb, 'session', $5, NOW() - INTERVAL '90 minutes')`,
        [ctx.appId, ctx.member.id,
          `${ctx.member.username} voted yes on PR #${IDS.proposal}: [shots fixture] A proposal changed since you voted`,
          JSON.stringify({ vote: { sessionId: IDS.proposal, prNumber: IDS.proposal, reason: null } }),
          IDS.proposal]
      );
      return {
        shows: [{
          state: 'A proposal up for a vote with a vote of yours on an earlier version, not counted ("Still yes?"), and a threshold that moved since voting opened ("was 1 when voting opened"). Its checks are still running.',
          path: `/#app/${ctx.selfAppSlug}/dev/proposals/${IDS.proposal}`,
        }],
      };
    },
  },
  {
    // A proposal of the member's to make the app private, stamped as the
    // platform stamps one (a visibility change needs explicit approval), with
    // only its author's Yes: the lock on its card and what it still needs.
    // A copy cannot open one for real (that needs GitHub, which a copy does
    // not have), and "Make it private" is offered only to whoever manages a
    // public app. Checks have not passed, so no vote in the copy merges it.
    id: 'shots-demo-member-visibility-proposal-v1',
    persona: 'member',
    needs: {
      chat_sessions: ['id', 'app_id', 'user_id', 'branch_name', 'pr_number', 'pr_title', 'pr_summary_md',
        'status', 'promoted_at', 'check_state', 'created_at', 'last_activity_at',
        'requires_explicit_approval', 'explicit_approval_reason'],
      pr_votes: ['session_id', 'user_id', 'vote', 'created_at'],
    },
    free: async (client, ctx) => {
      const pr = await client.query('SELECT 1 FROM chat_sessions WHERE app_id = $1 AND pr_number = $2',
        [ctx.appId, IDS.visibilityProposal]);
      return pr.rowCount === 0 && idsFree(client, 'chat_sessions', [IDS.visibilityProposal]);
    },
    async install(client, ctx) {
      await client.query(
        `INSERT INTO chat_sessions
           (id, app_id, user_id, branch_name, pr_number, pr_title, pr_summary_md, status,
            promoted_at, check_state, created_at, last_activity_at, requires_explicit_approval,
            explicit_approval_reason)
         VALUES ($1, $2, $3, 'visibility/shots-fixture-990858', $1,
                 '[shots fixture] Make this app private (collaborators only)',
                 'A demo proposal: it changes who can see the app, so it needs a Yes from another member.',
                 'promoted', NOW() - INTERVAL '30 minutes', 'pending', NOW() - INTERVAL '40 minutes', NOW(),
                 TRUE, 'visibility')`,
        [IDS.visibilityProposal, ctx.appId, ctx.member.id]
      );
      // The author's own Yes; the epoch is stamped by the table's trigger.
      await client.query(
        `INSERT INTO pr_votes (session_id, user_id, vote, created_at)
         VALUES ($1, $2, 'yes', NOW() - INTERVAL '25 minutes')`,
        [IDS.visibilityProposal, ctx.member.id]
      );
      return {
        shows: [{
          state: 'A proposal of yours to make the app private, with only your own Yes: its card shows the lock, and its checklist of what it still needs (expand it).',
          path: `/#app/${ctx.selfAppSlug}/dev/proposals/${IDS.visibilityProposal}`,
        }],
      };
    },
  },
  {
    // The bot never acts on a staging copy, and the clone empties its
    // verdicts with the private sessions they point at.
    id: 'shots-demo-homeroom-bot-verdict-v1',
    persona: 'read_only_admin',
    needs: {
      homeroom_bot_runs: ['app_id', 'issue_number', 'mode', 'verdict', 'determined', 'build_note', 'model',
        'cost_usd', 'input_tokens', 'output_tokens', 'duration_ms', 'created_at', 'proposal_session_id',
        'build_ok', 'build_branch', 'build_sha', 'build_commits', 'build_cost_usd', 'build_at', 'build_spec_md'],
    },
    free: async (client) => (await client.query(
      `SELECT 1 FROM homeroom_bot_runs WHERE build_branch = $1`, [BOT_BRANCH])).rowCount === 0,
    async install(client, ctx) {
      const proposal = await client.query('SELECT id FROM chat_sessions WHERE id = $1 AND app_id = $2',
        [IDS.proposal, ctx.appId]);
      await client.query(
        `INSERT INTO homeroom_bot_runs
           (app_id, issue_number, mode, verdict, determined, build_note, model, cost_usd,
            input_tokens, output_tokens, duration_ms, created_at, proposal_session_id,
            build_ok, build_branch, build_sha, build_commits, build_cost_usd, build_at, build_spec_md)
         VALUES ($1, 900003, 'live', 'ready', TRUE,
                 '[shots fixture] The request is specific enough to build: one screen, one change.',
                 'shots-fixture-model', 0.0123, 4210, 380, 9100, NOW() - INTERVAL '2 hours', $2,
                 TRUE, $3, $4, 2, 0.4120, NOW() - INTERVAL '100 minutes', $5)`,
        [ctx.appId, proposal.rowCount ? IDS.proposal : null, BOT_BRANCH, 'f'.repeat(40),
          '# [shots fixture] Friendlier empty board\n\nShow a short welcome line when the board has no cards.\n']
      );
      return {
        shows: [{
          state: 'A live Homeroom bot verdict marked Ready on request #900003, with the build it made and the plan it built from (expand that row).',
          path: '/#admin/homeroom-bot',
        }],
        alsoFor: ['full_admin'],
      };
    },
  },
  {
    // The season's one-time "First challenges" and an "Always open"
    // challenge counted hourly ("next count"). Every persona has finished the
    // first challenges: an unfinished one hides the season's other cards.
    id: 'shots-demo-challenge-groups-v1',
    persona: 'member',
    needs: {
      challenge_templates: ['id', 'category', 'goal', 'task', 'reward', 'metric_type', 'metric_target',
        'metric_label', 'created_at', 'updated_at'],
      challenges: ['id', 'season_event_id', 'challenge_template_id', 'enabled', 'completed', 'display_order'],
      challenge_scoring_rules: ['name', 'measure', 'challenge_id', 'interval_minutes', 'last_scored_at', 'enabled'],
      user_activities: ['user_id', 'season_event_id', 'challenge_id', 'activity_type', 'points', 'metadata',
        'activity_at', 'source'],
      season_events: ['id', 'season_id', 'internal', 'is_active'],
    },
    free: async (client) => await fixtureEventFound(client)
      && await idsFree(client, 'challenge_templates', [...IDS.onboardingTemplates, IDS.alwaysOpenTemplate])
      && idsFree(client, 'challenges', [...IDS.onboardingChallenges, IDS.alwaysOpenChallenge]),
    async install(client, ctx) {
      const steps = [
        ['Say hello in #general', 'Post a first message in #general.'],
        ['Join a community', 'Join any community from the Communities tab.'],
        ['Vote on a proposal', 'Cast your first vote on a proposal.'],
      ];
      for (const [index, [goal, task]] of steps.entries()) {
        await client.query(
          `INSERT INTO challenge_templates (id, category, goal, task, reward, created_at, updated_at)
           VALUES ($1, 'ONBOARDING', $2, $3, '50 pts', NOW(), NOW())`,
          [IDS.onboardingTemplates[index], `[shots fixture] ${goal}`, task]
        );
        await client.query(
          `INSERT INTO challenges (id, season_event_id, challenge_template_id, enabled, completed, display_order)
           VALUES ($1, $2, $3, TRUE, FALSE, $4)`,
          [IDS.onboardingChallenges[index], FIXTURE_EVENT_ID, IDS.onboardingTemplates[index], index]
        );
      }
      await client.query(
        `INSERT INTO challenge_templates
           (id, category, goal, task, reward, metric_type, metric_target, metric_label, created_at, updated_at)
         VALUES ($1, 'PERSISTENT', '[shots fixture] Try three apps',
                 'Open three different apps and spend half a minute in each.', '500 pts',
                 'count', 3, 'Apps tried', NOW(), NOW())`,
        [IDS.alwaysOpenTemplate]
      );
      await client.query(
        `INSERT INTO challenges (id, season_event_id, challenge_template_id, enabled, completed, display_order)
         VALUES ($1, $2, $3, TRUE, FALSE, 10)`,
        [IDS.alwaysOpenChallenge, FIXTURE_EVENT_ID, IDS.alwaysOpenTemplate]
      );
      // Counted an hour apart and just now, so the card reads "next count".
      // Nothing scores in a copy; "Run now" (full admin) would score it for real.
      await client.query(
        `INSERT INTO challenge_scoring_rules (name, measure, challenge_id, interval_minutes, last_scored_at, enabled)
         VALUES ('[shots fixture] Apps tried, counted hourly', 'TRY_APPS', $1, 60, NOW(), TRUE)`,
        [IDS.alwaysOpenChallenge]
      );
      for (const user of ctx.personas) {
        for (const challengeId of IDS.onboardingChallenges) {
          await client.query(
            `INSERT INTO user_activities
               (user_id, season_event_id, challenge_id, activity_type, points, metadata, activity_at, source)
             VALUES ($1, $2, $3, 'challenge_completion', 50, $4::jsonb, NOW() - INTERVAL '1 day', 'admin_ui')`,
            [user.id, FIXTURE_EVENT_ID, challengeId, COMPLETION]
          );
        }
      }
      return {
        shows: [{
          state: 'The Challenges tab with the finished "First challenges" group (3/3 done, at the end) and an "Always open" challenge with its next count time.',
          path: '/#leaderboard/challenges',
        }],
        alsoFor: ['read_only_admin', 'full_admin'],
      };
    },
  },
  {
    // The member's standing in the fixture season, and a finished challenge
    // on the tab. "Your standing" asks for the newest active season, which in
    // a production clone is a real one the member has no place in: make the
    // fixture season the newest, as it already is on a fresh staging copy.
    id: 'shots-demo-member-challenge-standing-v1',
    persona: 'member',
    needs: {
      seasons: ['id', 'starts_at', 'is_active', 'internal'],
      user_activities: ['user_id', 'season_event_id', 'challenge_id', 'activity_type', 'points', 'metadata',
        'activity_at', 'source'],
    },
    free: async (client, ctx) => {
      const fixture = await client.query(
        `SELECT 1 FROM seasons s
           JOIN season_events se ON se.season_id = s.id AND se.id = $2
           JOIN challenges c ON c.id = $3 AND c.season_event_id = se.id AND c.enabled AND NOT c.completed
          WHERE s.id = $1 AND s.internal = FALSE AND s.is_active`,
        [FIXTURE_SEASON_ID, FIXTURE_EVENT_ID, FIXTURE_EVENT_CHALLENGE_ID]
      );
      if (fixture.rowCount !== 1) return false;
      const credited = await client.query(
        `SELECT 1 FROM user_activities WHERE user_id = $1 AND challenge_id = $2 AND metadata->>'fixture' = $3`,
        [ctx.member.id, FIXTURE_EVENT_CHALLENGE_ID, FIXTURE_MARK]
      );
      return credited.rowCount === 0;
    },
    async install(client, ctx) {
      await client.query(
        `UPDATE seasons SET starts_at = LEAST(NOW(), GREATEST(starts_at,
           (SELECT MAX(o.starts_at) + INTERVAL '1 second' FROM seasons o
             WHERE o.internal = FALSE AND o.is_active AND o.id <> $1)))
          WHERE id = $1`,
        [FIXTURE_SEASON_ID]
      );
      await client.query(
        `INSERT INTO user_activities
           (user_id, season_event_id, challenge_id, activity_type, points, metadata, activity_at, source)
         VALUES ($1, $2, $3, 'challenge_completion', 50, $4::jsonb, NOW() - INTERVAL '2 days', 'admin_ui')`,
        [ctx.member.id, FIXTURE_EVENT_ID, FIXTURE_EVENT_CHALLENGE_ID, COMPLETION]
      );
      return {
        shows: [{
          state: 'Your standing in the season ("Standings update every few hours") and a challenge you finished (Done, points earned).',
          path: '/#leaderboard/challenges',
        }],
      };
    },
  },
  {
    // A friend request someone sent the member: Accept and Decline on the
    // profile. Not in the notification bell: an unread notification badges
    // the bell on every screen the member is shot on.
    id: 'shots-demo-member-friend-request-v1',
    persona: 'member',
    needs: {
      friendships: ['user_low_id', 'user_high_id', 'requester_id', 'status', 'created_at'],
    },
    free: async (client, ctx) => {
      const sender = await client.query(
        `SELECT id FROM users WHERE username = 'staging-demo-general-lin'`);
      if (sender.rowCount !== 1) return false;
      const pair = await client.query(
        `SELECT 1 FROM friendships WHERE user_low_id = LEAST($1::int, $2::int) AND user_high_id = GREATEST($1::int, $2::int)`,
        [ctx.member.id, sender.rows[0].id]
      );
      return pair.rowCount === 0;
    },
    async install(client, ctx) {
      const sender = (await client.query(
        `SELECT id, username FROM users WHERE username = 'staging-demo-general-lin'`)).rows[0];
      await client.query(
        `INSERT INTO friendships (user_low_id, user_high_id, requester_id, status, created_at)
         VALUES (LEAST($1::int, $2::int), GREATEST($1::int, $2::int), $2, 'pending', NOW() - INTERVAL '2 hours')`,
        [ctx.member.id, sender.id]
      );
      return {
        shows: [{
          state: `A friend request from ${sender.username} waiting for you (Accept, Decline).`,
          path: '/#profile?friends',
        }],
      };
    },
  },
  {
    // A "This week" group on the Challenges tab: two weekly challenges on
    // the fixture event the tab opens on, which has none of its own, one
    // counted to 2 ("0/2"), neither started. Nothing credits them in a copy.
    id: 'shots-demo-weekly-challenges-v1',
    persona: 'member',
    needs: {
      challenge_templates: WEEKLY_TEMPLATE_COLUMNS,
      challenges: WEEKLY_CHALLENGE_COLUMNS,
      season_events: ['id', 'season_id', 'internal', 'is_active'],
    },
    free: async (client) => await fixtureEventFound(client)
      && await idsFree(client, 'challenge_templates', IDS.weeklyTemplates)
      && idsFree(client, 'challenges', IDS.weeklyChallenges),
    async install(client) {
      await insertWeeklyChallenge(client, {
        templateId: IDS.weeklyTemplates[0], challengeId: IDS.weeklyChallenges[0], order: 5,
        goal: 'Spend ten minutes in apps', task: 'Use any apps for ten minutes in all this week.',
        reward: '300 pts', illustration: 'ten-minutes-in-apps',
      });
      await insertWeeklyChallenge(client, {
        templateId: IDS.weeklyTemplates[1], challengeId: IDS.weeklyChallenges[1], order: 6,
        goal: 'Send useful feedback', task: 'Report a problem or an idea on two apps this week.',
        reward: '250 pts', metric: { target: 2, label: 'Reports sent' }, illustration: 'useful-feedback',
      });
      return {
        shows: [{
          state: 'The Challenges tab\'s "This week" group: two weekly challenges, neither started, one counted to 2, with the days left on the group\'s header.',
          path: '/#leaderboard/challenges',
        }],
        alsoFor: ['read_only_admin', 'full_admin'],
      };
    },
  },
  {
    // A weekly challenge scored on sending a proposal (PROPOSAL_SENT): its
    // rule switched on, its window open, and counted hourly and just now, so
    // its card and its page say when it is next counted. Nothing scores in a
    // copy; "Run now" (full admin) would credit the clone's real proposals.
    id: 'shots-demo-proposal-challenge-v1',
    persona: 'member',
    needs: {
      challenge_templates: WEEKLY_TEMPLATE_COLUMNS,
      challenges: WEEKLY_CHALLENGE_COLUMNS,
      challenge_scoring_rules: ['name', 'measure', 'challenge_id', 'interval_minutes', 'last_scored_at', 'enabled'],
      season_events: ['id', 'season_id', 'internal', 'is_active'],
    },
    free: async (client) => await fixtureEventFound(client)
      && await idsFree(client, 'challenge_templates', [IDS.proposalTemplate])
      && idsFree(client, 'challenges', [IDS.proposalChallenge]),
    async install(client) {
      await insertWeeklyChallenge(client, {
        templateId: IDS.proposalTemplate, challengeId: IDS.proposalChallenge, order: 7,
        goal: 'Send a proposal', task: 'Put a change to any app up for a vote this week.',
        description: 'Counted from the proposals you put to a vote this week. One is enough.',
        reward: '500 pts', illustration: 'make-a-proposal',
      });
      await client.query(
        `INSERT INTO challenge_scoring_rules (name, measure, challenge_id, interval_minutes, last_scored_at, enabled)
         VALUES ('[shots fixture] Proposals sent, counted hourly', 'PROPOSAL_SENT', $1, 60, NOW(), TRUE)`,
        [IDS.proposalChallenge]
      );
      return {
        shows: [
          { state: 'A weekly challenge scored on sending a proposal ("Sent a proposal"), open and counted hourly: its card in "This week" with its next count time.',
            path: '/#leaderboard/challenges' },
          { state: 'The same challenge\'s own page.',
            path: `/#leaderboard/challenges/${FIXTURE_EVENT_ID}/${IDS.proposalChallenge}` },
        ],
        alsoFor: ['read_only_admin', 'full_admin'],
      };
    },
  },
  {
    // A remix the member made of a staging demo app: its page's ⋯ offers its
    // owner "Suggest this back". Shaped as the remix route makes one (Just
    // you, its owner a member), but with the lineage the staging seeds' own
    // fork has, by reference only: a copy has no repository to compare, so
    // the dialog says why it cannot send rather than reaching for GitHub.
    id: 'shots-demo-member-remix-v1',
    persona: 'member',
    needs: {
      apps: ['id', 'name', 'slug', 'status', 'created_by', 'collab_visibility', 'view_visibility',
        'forked_from', 'self_hosted', 'created_at'],
      app_collaborators: ['app_id', 'user_id', 'status', 'accepted_at'],
    },
    free: async (client) => {
      const source = await client.query('SELECT 1 FROM apps WHERE slug = $1 AND NOT self_hosted',
        [FIXTURE_FORK_SOURCE_SLUG]);
      const taken = await client.query('SELECT 1 FROM apps WHERE slug = $1', [REMIX_SLUG]);
      return source.rowCount === 1 && taken.rowCount === 0 && idsFree(client, 'apps', [IDS.memberRemix]);
    },
    async install(client, ctx) {
      const forkedAt = new Date(Date.parse(ctx.at) - 2 * 24 * 60 * 60 * 1000).toISOString();
      const remix = await client.query(
        `INSERT INTO apps (id, name, slug, status, created_by, collab_visibility, view_visibility, forked_from, created_at)
         SELECT $1, '[shots fixture] My remix', $2, 'running', $3, 'private', 'private',
                jsonb_build_object('appId', source.id, 'slug', source.slug, 'forkedAt', $4::text),
                NOW() - INTERVAL '2 days'
           FROM apps source
          WHERE source.slug = $5 AND NOT source.self_hosted
         RETURNING id`,
        [IDS.memberRemix, REMIX_SLUG, ctx.member.id, forkedAt, FIXTURE_FORK_SOURCE_SLUG]
      );
      if (remix.rowCount !== 1) throw new Error('The remix fixture has no original to point at.');
      await client.query(
        `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
         VALUES ($1, $2, 'member', NOW() - INTERVAL '2 days')`,
        [IDS.memberRemix, ctx.member.id]
      );
      return {
        shows: [{
          state: 'A remix you made of another app (Just you): the ⋯ on its page offers "Suggest this back" (its dialog says why these copies cannot send it; do not press Send).',
          path: `/#app/${REMIX_SLUG}/dev`,
        }],
      };
    },
  },
  {
    // The member's chat with the Homeroom bot, holding two activity cards on
    // one request of theirs: the first look found it ready to build and its
    // build is waiting its turn, so that card is working; a second look began
    // since, with a card of its own below. A card's state is read from the
    // bot's records (homeroom-bot-activity.js cardsFor), so these are the
    // records: the request, the live run between the cards, and the cards.
    // Both cards are read, so no Unread badge rides on every screen, and
    // nothing is written to the bell.
    id: 'shots-demo-member-bot-run-card-v1',
    persona: 'member',
    needs: {
      users: ['id', 'username', 'password', 'is_synthetic', 'display_name', 'created_at'],
      conversations: ['id', 'kind', 'created_by', 'status', 'created_at', 'updated_at'],
      conversation_direct_pairs: ['conversation_id', 'user_low_id', 'user_high_id'],
      conversation_members: ['conversation_id', 'user_id', 'role', 'status', 'invited_by', 'responded_at',
        'joined_at', 'last_read_message_id'],
      conversation_messages: ['id', 'conversation_id', 'sender_id', 'content', 'idempotency_key', 'metadata',
        'created_at'],
      homeroom_bot_dm_messages: ['message_id', 'user_id', 'conversation_id', 'app_id', 'issue_number', 'kind',
        'created_at'],
      homeroom_bot_requesters: ['app_id', 'issue_number', 'user_id', 'issue_title', 'created_at'],
      homeroom_bot_runs: ['app_id', 'issue_number', 'mode', 'verdict', 'determined', 'build_note', 'duration_ms',
        'created_at', 'build_ok', 'proposal_session_id', 'cap_suppressed', 'live_build_waiting_at'],
    },
    free: async (client, ctx) => {
      // The bot's account, when the copy has one, is a platform account with
      // no chat with the member yet.
      const bot = (await client.query(
        'SELECT id, is_synthetic FROM users WHERE username = $1', [BOT_USERNAME])).rows[0];
      if (bot) {
        if (!bot.is_synthetic || Number(bot.id) === Number(ctx.member.id)) return false;
        const pair = await client.query(
          `SELECT 1 FROM conversation_direct_pairs
            WHERE user_low_id = LEAST($1::int, $2::int) AND user_high_id = GREATEST($1::int, $2::int)`,
          [ctx.member.id, bot.id]
        );
        if (pair.rowCount) return false;
      }
      const request = await client.query(
        `SELECT EXISTS (SELECT 1 FROM homeroom_bot_requesters WHERE app_id = $1 AND issue_number = $2)
             OR EXISTS (SELECT 1 FROM homeroom_bot_runs WHERE app_id = $1 AND issue_number = $2)
             OR EXISTS (SELECT 1 FROM homeroom_bot_dm_messages WHERE app_id = $1 AND issue_number = $2) AS taken`,
        [ctx.appId, IDS.botRequest]
      );
      return !request.rows[0].taken && idsFree(client, 'conversations', [IDS.botConversation]);
    },
    async install(client, ctx) {
      // A production clone has the bot's account; elsewhere it is made the
      // way the staging Messages fixture makes it (staging-messages.js).
      await client.query(
        `INSERT INTO users (username, password, is_synthetic, display_name, created_at)
         VALUES ($1, 'staging-demo-not-a-login', TRUE, 'Homeroom bot', NOW())
         ON CONFLICT DO NOTHING`,
        [BOT_USERNAME]
      );
      const bot = (await client.query(
        'SELECT id FROM users WHERE username = $1 AND is_synthetic = TRUE', [BOT_USERNAME])).rows[0];
      const app = (await client.query('SELECT name FROM apps WHERE id = $1', [ctx.appId])).rows[0];
      if (!bot || !app) throw new Error('The Homeroom bot fixture lost its account or the platform app.');
      const conversationId = IDS.botConversation;
      // As openAdmittedDirect opens it (conversations.js): both already in.
      await client.query(
        `INSERT INTO conversations (id, kind, created_by, status, created_at, updated_at)
         VALUES ($1, 'direct', $2, 'active', NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '10 minutes')`,
        [conversationId, bot.id]
      );
      await client.query(
        `INSERT INTO conversation_direct_pairs (conversation_id, user_low_id, user_high_id)
         VALUES ($1, LEAST($2::int, $3::int), GREATEST($2::int, $3::int))`,
        [conversationId, bot.id, ctx.member.id]
      );
      await client.query(
        `INSERT INTO conversation_members
           (conversation_id, user_id, role, status, invited_by, responded_at, joined_at)
         VALUES ($1, $2, 'member', 'member', $2, NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '30 minutes'),
                ($1, $3, 'member', 'member', $2, NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '30 minutes')`,
        [conversationId, bot.id, ctx.member.id]
      );
      const issueTitle = '[shots fixture] Show vote counts on the request list';
      await client.query(
        `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, created_at)
         VALUES ($1, $2, $3, $4, NOW() - INTERVAL '31 minutes')`,
        [ctx.appId, IDS.botRequest, ctx.member.id, issueTitle]
      );
      // The first look's verdict, between the two cards. Nothing in a copy
      // builds it, so it waits its turn for the life of the pair.
      await client.query(
        `INSERT INTO homeroom_bot_runs
           (app_id, issue_number, mode, verdict, determined, build_note, duration_ms, created_at, live_build_waiting_at)
         VALUES ($1, $2, 'live', 'ready', TRUE, '[shots fixture] Specific enough to build: one number on each row.',
                 41000, NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '20 minutes')`,
        [ctx.appId, IDS.botRequest]
      );
      const metadata = JSON.stringify({
        homeroomBot: {
          kind: 'activity', appSlug: ctx.selfAppSlug, appName: app.name, issueNumber: IDS.botRequest, issueTitle,
        },
      });
      const content = `**${app.name}** · request #${IDS.botRequest}: ${issueTitle}\n\n`
        + 'I\'m working on this now. This card updates as I go.';
      const cards = [['shots-fixture-hrbot-activity-first', 30], ['shots-fixture-hrbot-activity-second', 10]];
      let newest = null;
      for (const [key, minutesAgo] of cards) {
        const sent = await client.query(
          `INSERT INTO conversation_messages (conversation_id, sender_id, content, idempotency_key, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, NOW() - make_interval(mins => $6))
           RETURNING id`,
          [conversationId, bot.id, content, key, metadata, minutesAgo]
        );
        newest = sent.rows[0].id;
        // A card's work begins when its record was written (cardRows).
        await client.query(
          `INSERT INTO homeroom_bot_dm_messages (message_id, user_id, conversation_id, app_id, issue_number, kind, created_at)
           VALUES ($1, $2, $3, $4, $5, 'activity', NOW() - make_interval(mins => $6))`,
          [newest, ctx.member.id, conversationId, ctx.appId, IDS.botRequest, minutesAgo]
        );
      }
      await client.query(
        'UPDATE conversation_members SET last_read_message_id = $3 WHERE conversation_id = $1 AND user_id = $2',
        [conversationId, ctx.member.id, newest]
      );
      return {
        shows: [{
          state: 'Your chat with Homeroom bot: an activity card on a request of yours whose build is ready and waiting its turn (working), and a newer card on the same request below it. Nothing in it is unread.',
          path: `/#messages/${IDS.botConversation}`,
        }],
      };
    },
  },
  {
    // A request whose change waits for approval (#4446): a change of the
    // member's up for a vote that names request #900017 as one it addresses
    // (`linked_issues`, as the Mayor's addresses_issues writes it), so the
    // request's chip reads "Waiting for approval · you" and no Build it now
    // is offered beside it (app-view.js _issueWorkState and
    // _issueAwaitingApproval, read from routes/issues.js composeInProgress
    // and resolveIssueProposalRefs). Not started from the request
    // (`created_from_issue_number`): that would be the member's own Start
    // more work instead. Checks have not passed, so no vote in the copy
    // merges it.
    id: 'shots-demo-member-request-awaiting-approval-v1',
    persona: 'member',
    needs: {
      chat_sessions: ['id', 'app_id', 'user_id', 'branch_name', 'pr_number', 'pr_title', 'pr_summary_md',
        'status', 'promoted_at', 'check_state', 'linked_issues', 'created_from_issue_number', 'is_headless',
        'last_activity_at', 'created_at'],
    },
    free: async (client, ctx) => {
      // Nothing else on the platform app already claims the request.
      const taken = await client.query(
        `SELECT 1 FROM chat_sessions
          WHERE app_id = $1 AND (pr_number = $2 OR $3 = ANY(linked_issues) OR created_from_issue_number = $3)`,
        [ctx.appId, IDS.awaitingProposal, FIXTURE_REQUEST_NUMBER]
      );
      return taken.rowCount === 0 && idsFree(client, 'chat_sessions', [IDS.awaitingProposal]);
    },
    async install(client, ctx) {
      await client.query(
        `INSERT INTO chat_sessions
           (id, app_id, user_id, branch_name, pr_number, pr_title, pr_summary_md, status,
            promoted_at, check_state, linked_issues, last_activity_at, created_at)
         VALUES ($1, $2, $3, 'shots-fixture/awaiting-approval', $1,
                 '[shots fixture] A change of yours for a request',
                 'A demo proposal of yours that addresses a request: it waits for the group''s approval.',
                 'promoted', NOW() - INTERVAL '50 minutes', 'pending', ARRAY[$4::int],
                 NOW() - INTERVAL '50 minutes', NOW() - INTERVAL '2 hours')`,
        [IDS.awaitingProposal, ctx.appId, ctx.member.id, FIXTURE_REQUEST_NUMBER]
      );
      return {
        shows: [
          { state: `Request #${FIXTURE_REQUEST_NUMBER}, which a change of yours addresses and which waits for approval: its chip, on the Requests board and on its page, reads "Waiting for approval · you" (the admins see "Waiting for approval · ${ctx.member.username}"), and neither offers Build it now.`,
            path: `/#app/${ctx.selfAppSlug}/dev/issues/${FIXTURE_REQUEST_NUMBER}` },
          { state: 'The change itself, up for a vote with no votes yet. Its checks are still running.',
            path: `/#app/${ctx.selfAppSlug}/dev/proposals/${IDS.awaitingProposal}` },
        ],
        alsoFor: ['read_only_admin', 'full_admin'],
      };
    },
  },
  {
    // Standings rows that open onto recorded point activities (#4364). The
    // Leaderboard opens on the fixture season's own standings event, where
    // the drill-down finds a player by their Discord handle alone
    // (event-standings.js fetchEventLeaderboardRows: a whole season has no
    // one event to find an onchain account on), and the staging seeds'
    // players have only an email, so every row's drill-down said "No
    // identifier available for this row." Three players entered
    // for the season get a handle, as a real player has one, and two
    // activities each on the event, written as a partner records them
    // (routes/topochain/partner.js POST /user-activities: on one of the
    // event's challenges, typed by its category, from `api`). Activities
    // move no standing: the board reads its snapshots.
    id: 'shots-demo-standings-activities-v1',
    persona: 'member',
    needs: {
      users: ['id', 'username', 'discord'],
      season_events: ['id', 'season_id', 'type', 'internal', 'display_leaderboard'],
      user_enrollments: ['user_id', 'season_event_id', 'season_id'],
      leaderboard_snapshots: ['season_event_id', 'user_id'],
      challenges: ['id', 'season_event_id', 'challenge_template_id'],
      challenge_templates: ['id', 'category'],
      user_activities: ['user_id', 'season_event_id', 'challenge_id', 'activity_type', 'points', 'description',
        'metadata', 'activity_at', 'source', 'created_at', 'updated_at'],
    },
    free: async (client) => {
      if (!await fixtureEventFound(client)) return false;
      const { rows: [found] } = await client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM season_events
             WHERE id = $1 AND type = 'season' AND display_leaderboard) AS board,
           (SELECT COUNT(*)::int FROM challenges WHERE id = ANY($3::bigint[]) AND season_event_id = $1) AS challenges,
           (SELECT COUNT(*)::int FROM users u
             WHERE u.username = ANY($4::text[]) AND u.discord IS NULL
               AND EXISTS (SELECT 1 FROM user_enrollments ue
                            WHERE ue.user_id = u.id
                              AND (ue.season_event_id = $1 OR (ue.season_event_id IS NULL AND ue.season_id = $2)))
               AND EXISTS (SELECT 1 FROM leaderboard_snapshots ls JOIN season_events se ON se.id = ls.season_event_id
                            WHERE ls.user_id = u.id AND se.season_id = $2)) AS players,
           (SELECT COUNT(*)::int FROM users WHERE discord = ANY($5::text[])) AS handles`,
        [FIXTURE_EVENT_ID, FIXTURE_SEASON_ID, STANDINGS_CHALLENGES.map(([id]) => id),
          STANDINGS_PLAYERS.map(([username]) => username), STANDINGS_PLAYERS.map(([, handle]) => handle)]
      );
      return found.board === 1 && found.challenges === STANDINGS_CHALLENGES.length
        && found.players === STANDINGS_PLAYERS.length && found.handles === 0;
    },
    async install(client) {
      for (const [username, handle, minutesAgo] of STANDINGS_PLAYERS) {
        const player = await client.query(
          'UPDATE users SET discord = $2 WHERE username = $1 AND discord IS NULL RETURNING id', [username, handle]);
        if (player.rowCount !== 1) throw new Error('A standings player of the staging seeds is missing.');
        for (const [index, [challengeId, points, words]] of STANDINGS_CHALLENGES.entries()) {
          const written = await client.query(
            `INSERT INTO user_activities
               (user_id, season_event_id, activity_type, points, description, metadata,
                activity_at, source, challenge_id, created_at, updated_at)
             SELECT $1, c.season_event_id, COALESCE(ct.category, 'activity'), $3, $4, $5::jsonb,
                    NOW() - make_interval(mins => $6), 'api', c.id, NOW(), NOW()
               FROM challenges c LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
              WHERE c.id = $2 AND c.season_event_id = $7`,
            [player.rows[0].id, challengeId, points, `[shots fixture] ${words}`,
              JSON.stringify({ fixture: FIXTURE_MARK }), minutesAgo[index], FIXTURE_EVENT_ID]
          );
          if (written.rowCount !== 1) throw new Error('A standings challenge of the staging seeds is missing.');
        }
      }
      const handles = STANDINGS_PLAYERS.map(([, handle]) => handle);
      return {
        shows: [{
          state: `The Leaderboard's season standings: the rows of ${handles.join(', ')} each open a drill-down listing that player's recorded point activities and when each happened. The other rows, yours among them, have no identifier, and their drill-down says so.`,
          path: '/#leaderboard/topochain',
        }],
        alsoFor: ['read_only_admin', 'full_admin'],
      };
    },
  },
  {
    // The member's chat with the Homeroom bot after they answered the plan
    // for a new project's first version (#4392): the plan, built, and under
    // it the bot's thanks for answering over the project's card and its
    // build line. The records are the real flow's: the project (Just you),
    // its first request (homeroom-bot-dm.js fileFirstVersion), the look that
    // wrote the plan and, once Build it was tapped, waits its turn to build
    // (homeroom-bot.js awaitGo, goAhead), the plan's card with its button
    // decided (sendPlanCard, decidePlanTap) and the thanks
    // (homeroom-bot-activity.js cardUnderPlan). Not the project's first-
    // version record: with it, the member's Home tile would draw a turning
    // build line on every screen they are shot on. Nothing builds it in a
    // copy, so it reads Building it for the life of the pair. It shares the
    // chat the bot run card's state opens, after that state's cards.
    id: 'shots-demo-member-first-version-thanks-v1',
    persona: 'member',
    needs: {
      users: ['id', 'username', 'password', 'is_synthetic', 'display_name'],
      apps: ['id', 'name', 'slug', 'status', 'created_by', 'collab_visibility', 'view_visibility', 'icon_emoji',
        'created_at'],
      app_collaborators: ['app_id', 'user_id', 'status', 'accepted_at'],
      conversations: ['id', 'kind', 'created_by', 'status', 'created_at', 'updated_at'],
      conversation_direct_pairs: ['conversation_id', 'user_low_id', 'user_high_id'],
      conversation_members: ['conversation_id', 'user_id', 'role', 'status', 'invited_by', 'responded_at',
        'joined_at', 'last_read_message_id'],
      conversation_messages: ['id', 'conversation_id', 'sender_id', 'content', 'idempotency_key', 'metadata',
        'created_at'],
      homeroom_bot_requesters: ['app_id', 'issue_number', 'user_id', 'issue_title', 'first_version', 'asked_text',
        'created_at'],
      homeroom_bot_runs: ['id', 'app_id', 'issue_number', 'mode', 'verdict', 'determined', 'build_note',
        'duration_ms', 'created_at', 'plan', 'awaiting_go_at', 'live_build_waiting_at', 'plan_send_attempts'],
      homeroom_bot_dm_messages: ['message_id', 'user_id', 'conversation_id', 'app_id', 'issue_number', 'kind',
        'run_id', 'created_at'],
      homeroom_bot_dm_actions: ['id', 'user_id', 'conversation_id', 'message_id', 'app_id', 'kind', 'title',
        'status', 'created_at', 'decided_at'],
    },
    free: async (client, ctx) => {
      const taken = await client.query('SELECT 1 FROM apps WHERE slug = $1', [FIRST_VERSION_SLUG]);
      return taken.rowCount === 0 && await idsFree(client, 'apps', [IDS.firstVersionApp]) && botChatFree(client, ctx);
    },
    async install(client, ctx) {
      const botSvc = require('./homeroom-bot');
      const dm = require('./homeroom-bot-dm');
      const activity = require('./homeroom-bot-activity');
      const chat = await memberBotChat(client, ctx);
      const appId = IDS.firstVersionApp;
      const name = FIRST_VERSION_NAME;
      // As the create route makes a project: Just you, its maker a member.
      await client.query(
        `INSERT INTO apps (id, name, slug, status, created_by, collab_visibility, view_visibility, icon_emoji, created_at)
         VALUES ($1, $2, $3, 'running', $4, 'private', 'private', $5, NOW() - INTERVAL '1 hour')`,
        [appId, name, FIRST_VERSION_SLUG, ctx.member.id, '📚']
      );
      await client.query(
        `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
         VALUES ($1, $2, 'member', NOW() - INTERVAL '1 hour')`,
        [appId, ctx.member.id]
      );
      const brief = 'A page for our book club: the book we are reading this month, and who has finished it.';
      const issueTitle = `First version of ${name}`;
      await client.query(
        `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, first_version, asked_text, created_at)
         VALUES ($1, 1, $2, $3, TRUE, $4, NOW() - INTERVAL '40 minutes')`,
        [appId, ctx.member.id, issueTitle, brief]
      );
      const plan = {
        bullets: [
          'This month\'s book, with how far each member has read',
          'Mark the book finished, and see who else has',
          'Suggest next month\'s book, and vote on the suggestions',
        ],
        questions: [{ question: 'Who can suggest a book?', answers: ['Anyone in the club', 'Only you'] }],
      };
      // Build it took the suggested answer.
      const chosen = botSvc.choicesFrom(plan.questions, []);
      const { rows: [run] } = await client.query(
        `INSERT INTO homeroom_bot_runs
           (app_id, issue_number, mode, verdict, determined, build_note, duration_ms, created_at,
            plan, awaiting_go_at, live_build_waiting_at, plan_send_attempts)
         VALUES ($1, 1, 'live', 'ready', TRUE, $2, 38000, date_trunc('milliseconds', NOW() - INTERVAL '9 minutes'),
                 $3::jsonb, NULL, NOW() - INTERVAL '5 minutes', 1)
         RETURNING id, created_at`,
        [appId, `[shots fixture] Specific enough to build: one page for the club.${botSvc.creatorChoiceNote(chosen, plan)}`,
          JSON.stringify({ ...plan, chosen })]
      );
      const { rows: [action] } = await client.query(
        `INSERT INTO homeroom_bot_dm_actions (user_id, conversation_id, app_id, kind, title, status, created_at, decided_at)
         VALUES ($1, $2, $3, 'build_plan', $4, 'done', NOW() - INTERVAL '8 minutes', NOW() - INTERVAL '5 minutes')
         RETURNING id`,
        [ctx.member.id, chat.conversationId, appId, `The plan for ${name}`]
      );
      const planMessage = await insertBotDm(client, ctx, chat, {
        appId, issueNumber: 1, kind: 'plan', runId: run.id, minutesAgo: 8, key: `hrbot-plan-${run.id}`,
        content: dm.planCardText({ appName: name, plan }),
        metadata: {
          kind: 'plan', appSlug: FIRST_VERSION_SLUG, appName: name, issueNumber: 1, firstVersion: true,
          plan, actionId: Number(action.id),
          status: 'answered', chosen: 'build', answer: 'Build it', choices: chosen.map((c) => c.answer),
        },
      });
      await client.query('UPDATE homeroom_bot_dm_actions SET message_id = $2 WHERE id = $1', [action.id, planMessage]);
      const thanks = await insertBotDm(client, ctx, chat, {
        appId, issueNumber: 1, kind: 'activity', minutesAgo: 5, key: `hrbot-activity-run-${run.id}`,
        content: activity.thanksText(name),
        metadata: {
          kind: 'activity', appSlug: FIRST_VERSION_SLUG, appName: name, issueNumber: 1, issueTitle,
          firstVersion: true, askedText: dm.askedLine(brief), lookAt: run.created_at.toISOString(),
          thanks: true, appEmoji: '📚',
        },
      });
      await client.query('UPDATE conversations SET updated_at = NOW() - INTERVAL \'5 minutes\' WHERE id = $1',
        [chat.conversationId]);
      await client.query(
        'UPDATE conversation_members SET last_read_message_id = $3 WHERE conversation_id = $1 AND user_id = $2',
        [chat.conversationId, ctx.member.id, thanks]
      );
      return {
        shows: [{
          state: `Your chat with Homeroom bot: the plan for your new project ${name}, answered with Build it, and under it the bot's thanks for answering over the project's card, whose build line reads Building it. Nothing in it is unread.`,
          path: `/#messages/${IDS.botConversation}`,
        }],
      };
    },
  },
];

// ── Context ─────────────────────────────────────────────────────────────

// The personas, the platform app, and the member's membership of it, which a
// genuine collaborator has (copyMemberAgentSession grants the same). `at` is
// the pair's moment, for a state that works out a time in JavaScript.
async function context(client, selfAppSlug, { grant = false, at = null } = {}) {
  const users = await client.query(
    `SELECT id, username, is_admin FROM users
      WHERE username IN ('usernode-capture', 'usernode-capture-admin', $1)`,
    [shotsFixtures.FULL_ADMIN_USERNAME]
  );
  const app = await client.query('SELECT id FROM apps WHERE slug = $1', [selfAppSlug]);
  const member = users.rows.find((u) => u.username === 'usernode-capture' && !u.is_admin);
  const admin = users.rows.find((u) => u.username === 'usernode-capture-admin');
  const fullAdmin = users.rows.find((u) => u.username === shotsFixtures.FULL_ADMIN_USERNAME
    && Number(u.id) === shotsFixtures.FULL_ADMIN_USER_ID);
  if (!member || !admin || app.rowCount !== 1) return null;
  const appId = app.rows[0].id;
  if (grant) {
    await client.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
       VALUES ($1, $2, 'member', NOW())
       ON CONFLICT (app_id, user_id)
       DO UPDATE SET status = 'member', accepted_at = COALESCE(app_collaborators.accepted_at, NOW())`,
      [appId, member.id]
    );
  }
  return {
    member, admin, fullAdmin: fullAdmin || null, appId, selfAppSlug,
    personas: [member, admin, ...(fullAdmin ? [fullAdmin] : [])],
    at: shotsFixtures.pairMoment(at),
  };
}

/** The ids of the states this side can hold: its tables, columns and ids allow them. */
async function inspectDemoStates({ databaseUrl, slug, runId, side, selfAppSlug }) {
  shotsFixtures.assertShotsDatabase(databaseUrl, slug, runId, side);
  return shotsFixtures.withClient(databaseUrl, async (client) => {
    const ctx = await context(client, selfAppSlug);
    if (!ctx) return [];
    const ready = [];
    for (const state of STATES) {
      try {
        if (await hasShape(client, state.needs) && await state.free(client, ctx)) ready.push(state.id);
      } catch { /* A state this revision cannot even be asked about is not ready. */ }
    }
    return ready;
  });
}

/**
 * Write the named states into both sides, and return what the shots agent is
 * told about each one written. Call with the states BOTH sides can hold
 * (inspectDemoStates).
 *
 * Both databases are written in step, a savepoint per state on each: a state
 * that fails on either side is rolled back on both and left out (`skipped`),
 * so a revision whose schema moved under a state costs that state, never the
 * run, and never leaves it on one side only.
 *
 * The booted copies are running against these databases meanwhile, so a
 * write can lose a deadlock or a serialization conflict to the app's own
 * work. Rolling back to the savepoint would not help: this transaction still
 * holds what the other session waits for. So the whole write is rolled back
 * on both sides and run again, a bounded number of times; on the last
 * attempt such a state is left out like any other. Once COMMIT has been sent
 * nothing is run again, since one side may already hold the states.
 *
 * Both are written at the pair's one moment (`at` on the inputs, else now;
 * shots-fixtures.atMoment): every NOW() a state writes, and `ctx.at`, are
 * that instant on both sides, so the two copies hold the same rows to the
 * microsecond however far apart their transactions began.
 */
async function installDemoStates({ base, head }, stateIds, { retry = {} } = {}) {
  for (const [side, input] of [['base', base], ['head', head]]) {
    shotsFixtures.assertShotsDatabase(input.databaseUrl, input.slug, input.runId, side);
  }
  if (base.at != null && head.at != null
      && shotsFixtures.pairMoment(base.at) !== shotsFixtures.pairMoment(head.at)) {
    throw new Error('Before & after shots demo states are written at one moment for both sides.');
  }
  const at = shotsFixtures.pairMoment(base.at ?? head.at);
  const wanted = new Set(stateIds || []);
  const states = STATES.filter((state) => wanted.has(state.id));
  if (!states.length) return { installed: [], skipped: [] };
  return installInStep({ base, head }, states, { retry, at });
}

async function installInStep({ base, head }, states, {
  retry = {}, at = shotsFixtures.pairMoment(base.at ?? head.at),
} = {}) {
  const attempts = retry.attempts || dbRetry.DB_RETRY_ATTEMPTS;
  let committing = false;
  return dbRetry.withDbRetry((attempt) => shotsFixtures.withClient(base.databaseUrl, (baseClient) =>
    shotsFixtures.withClient(head.databaseUrl, async (headClient) => {
      const clients = [baseClient, headClient];
      const all = (sql) => Promise.all(clients.map((client) => client.query(sql)));
      await all('BEGIN');
      try {
        const contexts = [
          await context(baseClient, base.selfAppSlug, { grant: true, at }),
          await context(headClient, head.selfAppSlug, { grant: true, at }),
        ];
        if (contexts.some((ctx) => !ctx)) {
          throw new Error('Before & after shots demo states lost their personas or platform app.');
        }
        const installed = [];
        const skipped = [];
        for (const state of states) {
          await all('SAVEPOINT shots_demo_state');
          try {
            const { shows, alsoFor = [] } = await state.install(baseClient, contexts[0]);
            await state.install(headClient, contexts[1]);
            await all('RELEASE SAVEPOINT shots_demo_state');
            installed.push({ id: state.id, persona: state.persona, ...(alsoFor.length ? { alsoFor } : {}), shows });
          } catch (error) {
            if (attempt < attempts && dbRetry.isTransientLockError(error)) throw error;
            await all('ROLLBACK TO SAVEPOINT shots_demo_state');
            skipped.push({ id: state.id, code: String(error?.code || 'install_failed').slice(0, 40) });
          }
        }
        committing = true;
        await all('COMMIT');
        return { installed, skipped };
      } catch (error) {
        await Promise.all(clients.map((client) => client.query('ROLLBACK').catch(() => {})));
        throw error;
      }
    }, { at }), { at }), {
    label: 'Shots demo states',
    ...retry,
    attempts,
    retryable: (error) => !committing && dbRetry.isTransientLockError(error),
  });
}

module.exports = {
  IDS,
  RESERVED_RANGE,
  STATES,
  STATE_IDS: Object.freeze(STATES.map((state) => state.id)),
  inspectDemoStates,
  installDemoStates,
  // Tests: install hand-made states through the same two-sided write.
  _installInStepForTest: installInStep,
};
