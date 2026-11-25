'use strict';

// The challenge page's itemized report and proposal list against a real
// PostgreSQL (services/topochain/challenge-items.js, #7152).
//
// The reader reuses the scorer's own rule row, eligibility test, junk filter
// and plan, so the tables it touches are the scorer's: the season tables, the
// challenge rules, the feedback and request records, the change tables, the
// events and the ledger. They are created here as the minimal shape those
// statements read — the point being the STATUS each seeded row produces.
//
// Set TEST_DATABASE_URL to run it; without a reachable server it skips.

const test = require('node:test');
const assert = require('node:assert/strict');

const DSN = process.env.TEST_DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SCHEMA_NAME = `challenge_items_test_${process.pid}`;

const { challengeItems } = require('../src/services/topochain/challenge-items');
const scorer = require('../src/services/topochain/challenge-scorer');
const rules = require('../src/services/topochain/challenge-rules');
const grader = require('../src/services/topochain/challenge-grader');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

async function connectPool() {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return { skip: 'the pg driver is not installed' }; }
  const probe = new Pool({ connectionString: DSN, connectionTimeoutMillis: 1500, max: 1 });
  try {
    await probe.query('SELECT 1');
  } catch (err) {
    await probe.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw new Error(`TEST_DATABASE_URL is not reachable: ${err.message || err.code}`);
    return { skip: 'No local PostgreSQL; set TEST_DATABASE_URL to run the database tests.' };
  }
  await probe.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`);
  await probe.query(`CREATE SCHEMA ${SCHEMA_NAME}`);
  await probe.end();
  const pool = new Pool({ connectionString: DSN, max: 4, options: `-c search_path=${SCHEMA_NAME}` });
  await pool.query(`
    CREATE TABLE users (
      id SERIAL PRIMARY KEY, username TEXT, display_name TEXT);
    CREATE TABLE communities (id SERIAL PRIMARY KEY);
    CREATE TABLE community_members (
      community_id INTEGER NOT NULL REFERENCES communities(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      PRIMARY KEY (community_id, user_id));
    CREATE TABLE apps (
      id SERIAL PRIMARY KEY, community_id INTEGER REFERENCES communities(id),
      created_by INTEGER REFERENCES users(id),
      slug TEXT, name TEXT,
      view_visibility TEXT NOT NULL DEFAULT 'public',
      self_hosted BOOLEAN NOT NULL DEFAULT FALSE,
      repo_url TEXT);
    CREATE TABLE app_collaborators (
      app_id INTEGER NOT NULL REFERENCES apps(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'member',
      PRIMARY KEY (app_id, user_id));
    CREATE TABLE feedback_reports (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      target VARCHAR(16) NOT NULL,
      app_id INTEGER REFERENCES apps(id),
      issue_owner TEXT, issue_repo TEXT, issue_number INTEGER,
      title VARCHAR(512), description TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE seasons (
      id BIGSERIAL PRIMARY KEY, starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE,
      internal BOOLEAN NOT NULL DEFAULT FALSE);
    CREATE TABLE season_events (
      id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL, ends_at TIMESTAMPTZ NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE, internal BOOLEAN NOT NULL DEFAULT FALSE,
      season_id BIGINT REFERENCES seasons(id));
    CREATE TABLE challenge_templates (
      id BIGSERIAL PRIMARY KEY, category VARCHAR(50) NOT NULL,
      goal VARCHAR(255) NOT NULL, reward VARCHAR(255) NOT NULL,
      schedule_start TIMESTAMPTZ, schedule_end TIMESTAMPTZ,
      metric_target NUMERIC(20,4));
    CREATE TABLE challenges (
      id BIGSERIAL PRIMARY KEY,
      season_event_id BIGINT NOT NULL REFERENCES season_events(id),
      challenge_template_id BIGINT NOT NULL REFERENCES challenge_templates(id),
      schedule_start TIMESTAMPTZ, schedule_end TIMESTAMPTZ,
      metric_target NUMERIC(20,4), reward NUMERIC(20,4),
      enabled BOOLEAN NOT NULL DEFAULT TRUE, completed BOOLEAN NOT NULL DEFAULT FALSE,
      display_order INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE challenge_scoring_rules (
      id BIGSERIAL PRIMARY KEY, name VARCHAR(120) NOT NULL,
      measure VARCHAR(40) NOT NULL,
      challenge_template_id BIGINT, challenge_id BIGINT,
      target NUMERIC(20,4), points NUMERIC(10,2),
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      interval_minutes INTEGER, last_scored_at TIMESTAMPTZ);
    CREATE TABLE user_activities (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      season_event_id BIGINT NOT NULL,
      activity_type VARCHAR(100) NOT NULL,
      points NUMERIC(10,2) NOT NULL DEFAULT 0,
      metadata JSONB, activity_at TIMESTAMPTZ NOT NULL,
      challenge_id BIGINT NOT NULL);
    CREATE UNIQUE INDEX user_activities_source_key_unique
      ON user_activities (challenge_id, user_id, (metadata->>'source_key'))
      WHERE metadata->>'source_key' IS NOT NULL;
    CREATE TABLE requests (
      id BIGSERIAL PRIMARY KEY,
      app_id INTEGER NOT NULL REFERENCES apps(id),
      number INTEGER NOT NULL,
      created_by INTEGER REFERENCES users(id),
      UNIQUE (app_id, number));
    CREATE TABLE homeroom_bot_requesters (
      app_id INTEGER NOT NULL REFERENCES apps(id),
      issue_number INTEGER NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
      PRIMARY KEY (app_id, issue_number));
    CREATE TABLE chat_sessions (
      id SERIAL PRIMARY KEY,
      app_id INTEGER REFERENCES apps(id),
      user_id INTEGER REFERENCES users(id),
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      is_headless BOOLEAN NOT NULL DEFAULT FALSE,
      pr_number INTEGER, pr_title VARCHAR(256),
      promoted_at TIMESTAMPTZ, merged_at TIMESTAMPTZ, live_at TIMESTAMPTZ,
      archived_at TIMESTAMPTZ, last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      linked_issues INTEGER[] NOT NULL DEFAULT '{}',
      created_from_issue_number INTEGER,
      spec_md TEXT NOT NULL DEFAULT '');
    CREATE TABLE events (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      app_id INTEGER REFERENCES apps(id),
      session_id INTEGER REFERENCES chat_sessions(id),
      event_type VARCHAR(64) NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  `);

  const { rows: [{ id: seasonId }] } = await pool.query(
    `INSERT INTO seasons (starts_at, ends_at, is_active)
     VALUES (NOW() - interval '90 days', NOW() + interval '90 days', TRUE) RETURNING id`);
  const { rows: [{ id: eventId }] } = await pool.query(
    `INSERT INTO season_events (name, starts_at, ends_at, is_active, internal, season_id)
     VALUES ('Event', NOW() - interval '30 days', NOW() + interval '30 days', TRUE, FALSE, $1) RETURNING id`,
    [seasonId]);
  await pool.query(`INSERT INTO communities (id) VALUES (1), (2), (3)`);
  return { pool, eventId };
}

async function seedUser(pool, username) {
  const { rows: [{ id }] } = await pool.query(
    'INSERT INTO users (username) VALUES ($1) RETURNING id', [username]);
  return Number(id);
}

async function seedApp(pool, { id, communityId, createdBy, slug, name, visibility = 'public', selfHosted = false, repoUrl = null, members = [] }) {
  await pool.query(
    `INSERT INTO apps (id, community_id, created_by, slug, name, view_visibility, self_hosted, repo_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, communityId, createdBy, slug, name, visibility, selfHosted, repoUrl]);
  for (const userId of members) {
    await pool.query(
      'INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [communityId, userId]);
  }
}

async function seedChallenge(pool, eventId, {
  measure = 'USEFUL_FEEDBACK', target = 4, points = 1000, category = 'ONBOARDING', enabled = true,
} = {}) {
  const { rows: [{ id: templateId }] } = await pool.query(
    `INSERT INTO challenge_templates (category, goal, reward)
     VALUES ($1, 'Challenge', '1000 pts') RETURNING id`, [category]);
  const { rows: [{ id: challengeId }] } = await pool.query(
    `INSERT INTO challenges (season_event_id, challenge_template_id) VALUES ($1, $2) RETURNING id`,
    [eventId, templateId]);
  await pool.query(
    `INSERT INTO challenge_scoring_rules (name, measure, challenge_id, target, points, enabled)
     VALUES ('Rule', $1, $2, $3, $4, $5)`,
    [measure, challengeId, target, points, enabled]);
  return Number(challengeId);
}

async function seedReport(pool, userId, {
  appId = null, target = 'app', title = 'Report', description = 'A real report with enough words to act on',
  createdAt = new Date(NOW - HOUR), issueNumber = 1, owner = 'acme', repo = 'app',
} = {}) {
  const { rows: [{ id }] } = await pool.query(
    `INSERT INTO feedback_reports (user_id, target, app_id, issue_owner, issue_repo, issue_number, title, description, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [userId, target, appId, owner, repo, issueNumber, title, description, createdAt]);
  return Number(id);
}

async function creditFeedback(pool, challengeId, viewer, reportId, { points = 210, reason = 'says what happened' } = {}) {
  await pool.query(
    `INSERT INTO user_activities (user_id, season_event_id, activity_type, points, metadata, activity_at, challenge_id)
     VALUES ($1, 1, 'challenge_scoring', $2, $3, $4, $5)`,
    [viewer, points, JSON.stringify({ source_key: `feedback:${reportId}`, grade: { score: points, reason } }),
      new Date(NOW - HOUR), challengeId]);
}

async function seedSession(pool, {
  appId, userId, status = 'promoted', promotedAt = new Date(NOW - 2 * DAY),
  mergedAt = null, liveAt = null, archivedAt = null, lastActivityAt = new Date(NOW - DAY),
  headless = false, prNumber = null, prTitle = 'A change', linkedIssues = [],
  createdFromIssueNumber = null,
} = {}) {
  const { rows: [{ id }] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, is_headless, pr_number, pr_title,
       promoted_at, merged_at, live_at, archived_at, last_activity_at, linked_issues, created_from_issue_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
    [appId, userId, status, headless, prNumber, prTitle, promotedAt, mergedAt, liveAt, archivedAt,
      lastActivityAt, linkedIssues, createdFromIssueNumber]);
  return Number(id);
}

async function mergeEvent(pool, sessionId, userId, { at = new Date(NOW - DAY), forced = false, appId = 1 } = {}) {
  const { rows: [{ id }] } = await pool.query(
    `INSERT INTO events (user_id, app_id, session_id, event_type, metadata, created_at)
     VALUES ($1, $2, $3, 'pr_merged', $4, $5) RETURNING id`,
    [userId, appId, sessionId, JSON.stringify(forced ? { forced: true } : {}), at]);
  return Number(id);
}

async function creditMerge(pool, challengeId, viewer, eventId, { points = 420 } = {}) {
  await pool.query(
    `INSERT INTO user_activities (user_id, season_event_id, activity_type, points, metadata, activity_at, challenge_id)
     VALUES ($1, 1, 'challenge_scoring', $2, $3, $4, $5)`,
    [viewer, points, JSON.stringify({ source_key: `merged:${eventId}` }), new Date(NOW - DAY), challengeId]);
}

const byKey = (data) => Object.fromEntries(data.items.map((i) => [i.key, i]));

// ── The tests ─────────────────────────────────────────────────────────

test('the itemized list against a real PostgreSQL', async (t) => {
  const setup = await connectPool();
  if (setup.skip) { t.skip(setup.skip); return; }
  const { pool, eventId } = setup;

  await t.test('every feedback status reads off its seeded rows', async () => {
    const viewer = await seedUser(pool, 'reporter');
    const other = await seedUser(pool, 'other');
    const challengeId = await seedChallenge(pool, eventId, { target: 4, points: 1000, category: 'REGULAR' });

    // App A: somebody else's public project (eligible).
    await seedApp(pool, { id: 1, communityId: 1, createdBy: other, slug: 'plant-pal', name: 'Plant Pal' });
    // App B: the viewer's own project.
    await seedApp(pool, { id: 2, communityId: 2, createdBy: viewer, slug: 'mine', name: 'Mine' });
    // App C: somebody else's, private, only they are in it (solo).
    await seedApp(pool, {
      id: 3, communityId: 3, createdBy: other, slug: 'solo', name: 'Solo', visibility: 'private', members: [other],
    });
    // The platform's own repo, for a platform report's link.
    await seedApp(pool, {
      id: 4, communityId: 1, createdBy: null, slug: 'homeroom', name: 'Homeroom',
      selfHosted: true, repoUrl: 'https://github.com/acme/platform',
    });

    const counted = await seedReport(pool, viewer, {
      appId: 1, title: 'Map won’t zoom', description: 'Opening the map on a phone leaves it stuck at one zoom level.',
      createdAt: new Date(NOW - 5 * HOUR), issueNumber: 11,
    });
    await creditFeedback(pool, challengeId, viewer, counted, { points: 210, reason: 'says what happened and where' });

    const grading = await seedReport(pool, viewer, {
      appId: 1, title: 'Search skips accents', description: 'Searching “café” finds nothing while “cafe” finds the place.',
      createdAt: new Date(NOW - 4 * HOUR), issueNumber: 12,
    });
    const own = await seedReport(pool, viewer, {
      appId: 2, title: 'Add dark mode', description: 'Please add a dark theme to this app so it is easier at night.',
      createdAt: new Date(NOW - 3 * HOUR), issueNumber: 13,
    });
    const solo = await seedReport(pool, viewer, {
      appId: 3, title: 'Private note', description: 'The solo app should remember my last selected list.',
      createdAt: new Date(NOW - 3 * HOUR), issueNumber: 14,
    });
    const short = await seedReport(pool, viewer, {
      appId: 1, title: 'Broken', description: 'nope', createdAt: new Date(NOW - 2 * HOUR), issueNumber: 15,
    });
    const first = await seedReport(pool, viewer, {
      appId: 1, title: 'Same words', description: 'The same report is sent twice and only the first should count.',
      createdAt: new Date(NOW - 2 * HOUR), issueNumber: 16,
    });
    const copy = await seedReport(pool, viewer, {
      appId: 1, title: 'Same words again', description: 'The same report is sent twice and only the first should count.',
      createdAt: new Date(NOW - HOUR), issueNumber: 17,
    });
    const platform = await seedReport(pool, viewer, {
      target: 'platform', title: 'Settings is slow', description: 'Opening Settings takes several seconds every time.',
      createdAt: new Date(NOW - HOUR), issueNumber: 21, owner: 'acme', repo: 'platform',
    });
    const elsewhere = await seedReport(pool, viewer, {
      target: 'platform', title: 'Other repo', description: 'A platform report filed into a repository we do not host.',
      createdAt: new Date(NOW - 30 * 60 * 1000), issueNumber: 22, owner: 'someone', repo: 'elsewhere',
    });

    const data = await challengeItems(pool, { userId: viewer, challengeId, now: NOW });
    assert.ok(data, 'the feedback challenge has a list');
    assert.equal(data.measure, 'USEFUL_FEEDBACK');
    assert.equal(data.target, 4);
    assert.equal(data.weekly, false);
    const items = byKey(data);

    assert.equal(items[`feedback:${counted}`].status, 'counted');
    assert.equal(items[`feedback:${counted}`].points, 210);
    assert.equal(items[`feedback:${counted}`].max, 250);
    assert.equal(items[`feedback:${counted}`].reason_text, 'says what happened and where');
    assert.deepEqual(items[`feedback:${counted}`].link, { kind: 'request', slug: 'plant-pal', number: 11 });

    assert.equal(items[`feedback:${grading}`].status, 'grading');
    assert.equal(items[`feedback:${own}`].status, 'own_project');
    assert.equal(items[`feedback:${solo}`].status, 'solo');
    assert.equal(items[`feedback:${short}`].status, 'too_short');
    assert.equal(items[`feedback:${first}`].status, 'grading');
    assert.equal(items[`feedback:${copy}`].status, 'duplicate');
    assert.deepEqual(items[`feedback:${platform}`].link, { kind: 'request', slug: 'homeroom', number: 21 });
    assert.equal(items[`feedback:${elsewhere}`].link, null);

    // The report the list shows as grading is exactly one the scorer's own
    // candidate read and plan would plan.
    const { rows: ruleRows } = await pool.query(scorer.RULE_CHALLENGES_SQL, [scorer.ONBOARDING_LIMIT]);
    const row = ruleRows.find((r) => Number(r.challenge_id) === challengeId);
    const rule = { id: row.rule_id, measure: row.measure, target: row.rule_target, points: row.rule_points };
    const window = rules.resolveWindow(row, { now: NOW });
    const candidates = await scorer.loadCandidates(pool, 'USEFUL_FEEDBACK', window, { target: 4 });
    const seen = new Map();
    const screened = candidates.filter((c) => {
      const bag = seen.get(c.userId) || new Set();
      seen.set(c.userId, bag);
      return !grader.preFilter('USEFUL_FEEDBACK', c.gradeInput, bag);
    });
    const credited = await scorer.loadCredited(pool, challengeId);
    const planned = rules.planCredits(rule, row, { candidates: screened, credited, now: NOW });
    assert.ok(planned.some((c) => c.sourceKey === `feedback:${grading}`),
      'the grading report is one the scorer plans');
  });

  await t.test('over the target reads on a counted table', async () => {
    const viewer = await seedUser(pool, 'reporter2');
    const other = await seedUser(pool, 'other2');
    const challengeId = await seedChallenge(pool, eventId, { target: 1, category: 'REGULAR' });
    await seedApp(pool, { id: 5, communityId: 1, createdBy: other, slug: 'quiz', name: 'Quiz Night' });
    const paid = await seedReport(pool, viewer, {
      appId: 5, description: 'The score board does not update when a new round begins.',
      createdAt: new Date(NOW - 3 * HOUR), issueNumber: 31,
    });
    await creditFeedback(pool, challengeId, viewer, paid);
    const late = await seedReport(pool, viewer, {
      appId: 5, description: 'The timer keeps counting after the game has already finished.',
      createdAt: new Date(NOW - HOUR), issueNumber: 32,
    });

    const data = await challengeItems(pool, { userId: viewer, challengeId, now: NOW });
    const items = byKey(data);
    assert.equal(items[`feedback:${paid}`].status, 'counted');
    assert.equal(items[`feedback:${late}`].status, 'over_target');
  });

  await t.test('a weekly challenge lists only this week', async () => {
    const viewer = await seedUser(pool, 'weekly-reporter');
    const other = await seedUser(pool, 'weekly-other');
    const challengeId = await seedChallenge(pool, eventId, { target: 4, category: 'WEEKLY' });
    await seedApp(pool, { id: 6, communityId: 1, createdBy: other, slug: 'weekly', name: 'Weekly' });
    const lastWeek = await seedReport(pool, viewer, {
      appId: 6, description: 'A report sent last week that belongs to the earlier count.',
      createdAt: new Date(NOW - 8 * DAY), issueNumber: 41,
    });
    const thisWeek = await seedReport(pool, viewer, {
      appId: 6, description: 'A report sent this week that the next count will grade.',
      createdAt: new Date(NOW - HOUR), issueNumber: 42,
    });

    const data = await challengeItems(pool, { userId: viewer, challengeId, now: NOW });
    assert.equal(data.weekly, true);
    const items = byKey(data);
    assert.equal(items[`feedback:${lastWeek}`], undefined, 'last week’s report is not in this week’s list');
    assert.equal(items[`feedback:${thisWeek}`].status, 'grading');
  });

  await t.test('each proposal state and count line reads off its seeded rows', async () => {
    const viewer = await seedUser(pool, 'builder');
    const bot = await seedUser(pool, 'bot');
    const other = await seedUser(pool, 'request-author');
    const challengeId = await seedChallenge(pool, eventId, {
      measure: 'PROPOSAL_ACCEPTED', target: 2, points: 500,
    });
    await seedApp(pool, { id: 7, communityId: 1, createdBy: other, slug: 'plant', name: 'Plant Pal' });
    // Two requests: one the viewer filed, one the bot took from them.
    await pool.query(
      `INSERT INTO requests (app_id, number, created_by) VALUES (7, 1, $1), (7, 2, $2)`, [viewer, other]);
    await pool.query(
      'INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id) VALUES (7, 2, $1)', [viewer]);

    // Author, merged and live: counted.
    const live = await seedSession(pool, {
      appId: 7, userId: viewer, status: 'merged', prNumber: 101, prTitle: 'Water reminders',
      promotedAt: new Date(NOW - 10 * DAY), mergedAt: new Date(NOW - DAY), liveAt: new Date(NOW - DAY),
    });
    const liveEvent = await mergeEvent(pool, live, viewer, { at: new Date(NOW - DAY) });
    await creditMerge(pool, challengeId, viewer, liveEvent);

    // Author, still up for a vote.
    await seedSession(pool, {
      appId: 7, userId: viewer, status: 'promoted', prNumber: 102, prTitle: 'Weekly score email',
      promotedAt: new Date(NOW - 2 * DAY),
    });

    // A change built for a request the viewer filed.
    await seedSession(pool, {
      appId: 7, userId: bot, status: 'promoted', prNumber: 103, prTitle: 'Dark mode',
      promotedAt: new Date(NOW - DAY), linkedIssues: [1],
    });

    // A change built for a request the bot took from the viewer.
    await seedSession(pool, {
      appId: 7, userId: bot, status: 'promoted', prNumber: 104, prTitle: 'Calendar sync',
      promotedAt: new Date(NOW - HOUR), createdFromIssueNumber: 2,
    });

    // A forced merge: live, but it does not count.
    const forced = await seedSession(pool, {
      appId: 7, userId: viewer, status: 'merged', prNumber: 105, prTitle: 'New colours',
      promotedAt: new Date(NOW - 5 * DAY), mergedAt: new Date(NOW - 2 * DAY), liveAt: new Date(NOW - 2 * DAY),
    });
    await mergeEvent(pool, forced, viewer, { at: new Date(NOW - 2 * DAY), forced: true });

    // Archived without going live.
    const closed = await seedSession(pool, {
      appId: 7, userId: viewer, status: 'archived', prNumber: 106, prTitle: 'Rough idea',
      promotedAt: new Date(NOW - 6 * DAY), archivedAt: new Date(NOW - 2 * DAY),
      lastActivityAt: new Date(NOW - 2 * DAY),
    });

    // Merged outside the window: not listed.
    const outside = await seedSession(pool, {
      appId: 7, userId: viewer, status: 'merged', prNumber: 107, prTitle: 'Old work',
      promotedAt: new Date(NOW - 60 * DAY), mergedAt: new Date(NOW - 40 * DAY), liveAt: new Date(NOW - 40 * DAY),
    });
    await mergeEvent(pool, outside, viewer, { at: new Date(NOW - 40 * DAY) });

    // Two more unforced merges: one counts at the next count, one is over the
    // target (the live change above is the first of two).
    const pending = await seedSession(pool, {
      appId: 7, userId: viewer, status: 'merged', prNumber: 108, prTitle: 'Reminders',
      promotedAt: new Date(NOW - 3 * DAY), mergedAt: new Date(NOW - 2 * HOUR), liveAt: new Date(NOW - 2 * HOUR),
    });
    await mergeEvent(pool, pending, viewer, { at: new Date(NOW - 2 * HOUR) });
    const over = await seedSession(pool, {
      appId: 7, userId: viewer, status: 'merged', prNumber: 109, prTitle: 'Extra polish',
      promotedAt: new Date(NOW - 2 * DAY), mergedAt: new Date(NOW - HOUR), liveAt: new Date(NOW - HOUR),
    });
    await mergeEvent(pool, over, viewer, { at: new Date(NOW - HOUR) });

    // A headless session never lists, and neither does one never promoted.
    await seedSession(pool, {
      appId: 7, userId: viewer, status: 'promoted', prNumber: 110, headless: true,
    });
    await seedSession(pool, {
      appId: 7, userId: viewer, status: 'merged', prNumber: 111, promotedAt: null,
      mergedAt: new Date(NOW - HOUR), liveAt: new Date(NOW - HOUR),
    });

    const data = await challengeItems(pool, { userId: viewer, challengeId, now: NOW });
    assert.equal(data.measure, 'PROPOSAL_ACCEPTED');
    assert.equal(data.target, 2);
    const items = byKey(data);

    assert.equal(items[`change:${live}`].status, 'counted');
    assert.equal(items[`change:${live}`].state, 'live');
    assert.equal(items[`change:${live}`].points, 420);
    assert.deepEqual(items[`change:${live}`].link,
      { kind: 'change', slug: 'plant', session_id: live, pr_number: 101 });

    const upForVote = data.items.filter((i) => i.state === 'up_for_vote');
    assert.equal(upForVote.length, 3, 'two own proposals and one from a request');
    assert.equal(upForVote.every((i) => i.status === 'needs_accept'), true);
    assert.equal(upForVote.filter((i) => i.via === 'request').length, 2,
      'both a linked request and a bot-taken request read as the viewer’s');

    assert.equal(items[`change:${forced}`].status, 'forced');
    assert.equal(items[`change:${forced}`].state, 'live');
    assert.equal(items[`change:${closed}`].status, 'closed');
    assert.equal(items[`change:${closed}`].state, 'closed');
    assert.equal(items[`change:${outside}`], undefined, 'a merge outside the period is not listed');
    assert.equal(items[`change:${pending}`].status, 'pending_count');
    assert.equal(items[`change:${over}`].status, 'over_target');
    assert.equal(data.items.some((i) => i.link && i.link.session_id === 110), false, 'headless sessions never list');

    // Up for vote first, then the live ones, then closed.
    assert.equal(data.items[0].state, 'up_for_vote');
    assert.equal(data.items[data.items.length - 1].state, 'closed');
  });

  await t.test('a challenge another measure scores has no list', async () => {
    const viewer = await seedUser(pool, 'nobody');
    const other = await seedChallenge(pool, eventId, { measure: 'TRY_APPS' });
    assert.equal(await challengeItems(pool, { userId: viewer, challengeId: other, now: NOW }), null);
    assert.equal(await challengeItems(pool, { userId: viewer, challengeId: 99999, now: NOW }), null);
  });
});
