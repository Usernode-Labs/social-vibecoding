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
// Reserved ids: 990840-990859, across every table here, beside the shots
// session copies (990896-990899, shots-fixtures.js). tests/staging-demo-id-
// ranges.test.js keeps the staging seeds and mocks out of the block.

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
});
const RESERVED_RANGE = Object.freeze([990840, 990859]);

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

async function insertUserMessage(client, { agentSessionId, changeId = null, content, minutesAgo }) {
  await client.query(
    `INSERT INTO chat_session_messages (session_id, agent_session_id, role, content, metadata, created_at)
     VALUES ($1, $2, 'user', $3, '{}'::jsonb, NOW() - make_interval(mins => $4))`,
    [changeId, agentSessionId, content, minutesAgo]
  );
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
        'check_state', 'created_at'],
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
            promoted_at, votes_required, active_users_at_promote, approval_epoch, check_state, created_at)
         VALUES ($1, $2, $3, 'shots-fixture/vote-states', $1,
                 '[shots fixture] A proposal changed since you voted',
                 'A demo proposal: its author pushed a new version after people voted, and more people joined since voting opened.',
                 'promoted', NOW() - INTERVAL '2 hours', NULL, 1, 1, 'pending', NOW() - INTERVAL '3 hours')`,
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
        'status', 'promoted_at', 'check_state', 'created_at',
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
            promoted_at, check_state, created_at, requires_explicit_approval, explicit_approval_reason)
         VALUES ($1, $2, $3, 'visibility/shots-fixture-990858', $1,
                 '[shots fixture] Make this app private (collaborators only)',
                 'A demo proposal: it changes who can see the app, so it needs a Yes from another member.',
                 'promoted', NOW() - INTERVAL '30 minutes', 'pending', NOW() - INTERVAL '40 minutes',
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
          state: 'A live Homeroom bot verdict marked Ready, with the build it made and the spec it built from (expand the row).',
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
    free: async (client) => {
      const event = await client.query(
        `SELECT 1 FROM season_events WHERE id = $1 AND season_id = $2 AND internal = FALSE`,
        [FIXTURE_EVENT_ID, FIXTURE_SEASON_ID]
      );
      return event.rowCount === 1
        && await idsFree(client, 'challenge_templates', [...IDS.onboardingTemplates, IDS.alwaysOpenTemplate])
        && idsFree(client, 'challenges', [...IDS.onboardingChallenges, IDS.alwaysOpenChallenge]);
    },
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
];

// ── Context ─────────────────────────────────────────────────────────────

// The personas, the platform app, and the member's membership of it, which a
// genuine collaborator has (copyMemberAgentSession grants the same).
async function context(client, selfAppSlug, { grant = false } = {}) {
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
 */
async function installDemoStates({ base, head }, stateIds) {
  for (const [side, input] of [['base', base], ['head', head]]) {
    shotsFixtures.assertShotsDatabase(input.databaseUrl, input.slug, input.runId, side);
  }
  const wanted = new Set(stateIds || []);
  const states = STATES.filter((state) => wanted.has(state.id));
  if (!states.length) return { installed: [], skipped: [] };
  return shotsFixtures.withClient(base.databaseUrl, (baseClient) =>
    shotsFixtures.withClient(head.databaseUrl, async (headClient) => {
      const clients = [baseClient, headClient];
      const all = (sql) => Promise.all(clients.map((client) => client.query(sql)));
      await all('BEGIN');
      try {
        const contexts = [
          await context(baseClient, base.selfAppSlug, { grant: true }),
          await context(headClient, head.selfAppSlug, { grant: true }),
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
            await all('ROLLBACK TO SAVEPOINT shots_demo_state');
            skipped.push({ id: state.id, code: String(error?.code || 'install_failed').slice(0, 40) });
          }
        }
        await all('COMMIT');
        return { installed, skipped };
      } catch (error) {
        await Promise.all(clients.map((client) => client.query('ROLLBACK').catch(() => {})));
        throw error;
      }
    }));
}

module.exports = {
  IDS,
  RESERVED_RANGE,
  STATES,
  STATE_IDS: Object.freeze(STATES.map((state) => state.id)),
  inspectDemoStates,
  installDemoStates,
};
