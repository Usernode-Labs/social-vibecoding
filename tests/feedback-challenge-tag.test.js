'use strict';

// The challenge tag on a feedback report (#4968).
//
// Against the REAL schema in a throwaway PostgreSQL database — schema.sql
// applied as the boot migration applies it — and through the real route, so
// what is tested is what ships: CHALLENGE_TAG_SQL (a tag is honoured only
// for a real, enabled, DAILY/WEEKLY challenge that is open now, within the
// scorer's 24h end grace, and whose rule actually reads tagged reports),
// resolveChallengeTag's malformed-input handling, and the two columns the
// report stores: challenge_id and screenshot_count.
//
// The contract under test: a stale or invalid tag is DROPPED, never a 400 —
// the report itself is good, and the person sees their own confirmation
// either way. A tag counts for its own challenge only; Send useful feedback
// (FEEDBACK_SENT) and Help a newcomer (NEWCOMER_HELPED) are not read off a
// tagged report.
//
// Skipped when no server is reachable, and required when TEST_DATABASE_URL
// is set — the same contract as tests/challenge-on-the-spot-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { resolveChallengeTag, TAGGED_REPORT_MEASURES } = require('../src/routes/feedback');
const { recordFeedbackReport } = require('../src/services/feedback-reports');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a report is tagged only for a challenge whose rule reads tagged reports, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'challenge_tag_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const cleanup = [];
  t.after(async () => {
    for (const step of cleanup) await step();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  let seq = 0;
  async function user() {
    const n = ++seq;
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`,
      [`tag_${n}`]
    );
    return rows[0];
  }
  async function app({ createdBy }) {
    const n = ++seq;
    const { rows } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, self_hosted, view_visibility, collab_visibility, status, repo_url)
       VALUES ($1, $2, $3, FALSE, 'public', 'public', 'running', $4) RETURNING id`,
      [`App ${n}`, `app-${n}`, createdBy, `https://github.com/tag-owner/app-${n}`]
    );
    return (await pool.query('SELECT * FROM apps WHERE id = $1', [rows[0].id])).rows[0];
  }

  const { rows: [season] } = await pool.query(
    `INSERT INTO seasons (name, starts_at, ends_at, is_active)
     VALUES ('Season 2', NOW() - INTERVAL '3 days', NOW() + INTERVAL '60 days', TRUE) RETURNING id`);
  const { rows: [event] } = await pool.query(
    `INSERT INTO season_events (name, starts_at, ends_at, is_active, scoring_formula, season_id, type)
     VALUES ('Season 2', NOW() - INTERVAL '3 days', NOW() + INTERVAL '60 days', TRUE, '{}'::jsonb, $1, 'season')
     RETURNING id`, [season.id]);

  // One template per shape the tag has to tell apart, each with its one
  // template-bound rule.
  const { rows: templates } = await pool.query(
    `INSERT INTO challenge_templates (category, goal, task, reward, metric_type, metric_target) VALUES
       ('DAILY', 'Report a bug with a screenshot', 'File a bug report with a screenshot', '250 pts', NULL, NULL),
       ('WEEKLY', 'Run a usability test', 'Sit with how a project works', 'Up to 1,000 pts', NULL, NULL),
       ('DAILY', 'Help a newcomer', 'Reply to a new member', '250 pts', NULL, NULL),
       ('ONBOARDING', 'Suggest an improvement', 'Send feedback', '250 pts', NULL, NULL)
     RETURNING id, goal`);
  const templateOf = (goal) => templates.find((r) => r.goal === goal);
  async function rule(goal, measure) {
    const { rows } = await pool.query(
      `INSERT INTO challenge_scoring_rules (name, measure, challenge_template_id)
       VALUES ($1, $2, $3) RETURNING id`, [goal, measure, templateOf(goal).id]);
    return Number(rows[0].id);
  }
  await rule('Report a bug with a screenshot', 'BUG_REPORT_SCREENSHOT');
  await rule('Run a usability test', 'USABILITY_TEST');
  await rule('Help a newcomer', 'NEWCOMER_HELPED');
  await rule('Suggest an improvement', 'FEEDBACK_SENT');

  async function challenge(goal, scheduleEnd = null) {
    const { rows } = await pool.query(
      `INSERT INTO challenges (season_event_id, challenge_template_id, display_order, schedule_end)
       VALUES ($1, $2, ${seq += 1}, ${scheduleEnd || 'NULL'}) RETURNING id`,
      [event.id, templateOf(goal).id]);
    return Number(rows[0].id);
  }
  const BUG = await challenge('Report a bug with a screenshot');
  const USABILITY = await challenge('Run a usability test');
  const NEWCOMER = await challenge('Help a newcomer');
  const SUGGEST = await challenge('Suggest an improvement');
  // Disabled: real and open, but switched off by its organisers.
  const DISABLED = await challenge('Report a bug with a screenshot');
  await pool.query('UPDATE challenges SET enabled = FALSE WHERE id = $1', [DISABLED]);
  // Ended well past the scorer's 24h grace.
  const PAST = await challenge('Report a bug with a screenshot', "NOW() - INTERVAL '48 hours'");
  // Ended two hours ago: inside the grace, still honoured.
  const GRACE = await challenge('Report a bug with a screenshot', "NOW() - INTERVAL '2 hours'");
  // A challenge with its OWN enabled tagged rule, beside its template's.
  const OWN_RULE = await challenge('Report a bug with a screenshot');
  await pool.query(
    `INSERT INTO challenge_scoring_rules (name, measure, challenge_id)
     VALUES ('Own bug rule', 'BUG_REPORT_SCREENSHOT', $1) RETURNING id`, [OWN_RULE]);
  // A challenge whose own rule is FEEDBACK_SENT: the template's tagged rule
  // must not leak through — its own binding decides, and it does not read
  // tagged reports.
  const OVERRIDE = await challenge('Report a bug with a screenshot');
  await pool.query(
    `INSERT INTO challenge_scoring_rules (name, measure, challenge_id)
     VALUES ('Send useful feedback only', 'FEEDBACK_SENT', $1) RETURNING id`, [OVERRIDE]);

  // ─── resolveChallengeTag, directly ──────────────────────────────────

  await t.test('a valid tag names the challenge it counts for', async () => {
    assert.equal(await resolveChallengeTag(pool, BUG), BUG, 'an open daily challenge');
    assert.equal(await resolveChallengeTag(pool, USABILITY), USABILITY, 'an open weekly challenge');
    assert.equal(await resolveChallengeTag(pool, GRACE), GRACE,
      'ended two hours ago is inside the 24h grace');
    assert.equal(await resolveChallengeTag(pool, OWN_RULE), OWN_RULE,
      'its own tagged rule honours it');
    assert.equal(await resolveChallengeTag(pool, String(BUG)), BUG, 'a string id from the form');
  });

  await t.test('a tag the rules refuse is dropped, not refused', async () => {
    for (const [id, why] of [
      [NEWCOMER, 'Help a newcomer is not read off a tagged report'],
      [SUGGEST, 'Send useful feedback is not a DAILY/WEEKLY challenge'],
      [DISABLED, 'a switched-off challenge takes no tags'],
      [PAST, 'ended 48h ago is past the grace'],
      [OVERRIDE, 'its own FEEDBACK_SENT rule decides, not the template\'s'],
    ]) {
      assert.equal(await resolveChallengeTag(pool, id), null, why);
    }
  });

  await t.test('a malformed tag resolves to nothing, without throwing', async () => {
    for (const bad of [undefined, null, '', '   ', 'abc', '0', 0, -1, 1.5, NaN, {}, []]) {
      assert.equal(await resolveChallengeTag(pool, bad), null, `(${typeof bad}) ${String(bad)}`);
    }
    assert.equal(await resolveChallengeTag(pool, 999999), null, 'an unknown id');
    // And a pool that fails logs and drops rather than failing the report.
    assert.equal(await resolveChallengeTag({ query: async () => { throw new Error('connection reset'); } }, BUG), null);
  });

  await t.test('TAGGED_REPORT_MEASURES is the seven writing measures and nothing else', () => {
    assert.deepEqual([...TAGGED_REPORT_MEASURES], [
      'BUG_REPORT_SCREENSHOT', 'NEW_FEATURE_FEEDBACK', 'TUTORIAL_SHARED', 'DISCOVERY_SHARED',
      'USABILITY_TEST', 'FEATURE_COMPARISON', 'APP_REVIEW',
    ]);
    assert.ok(Object.isFrozen(TAGGED_REPORT_MEASURES));
  });

  // ─── through the real route ─────────────────────────────────────────

  const config = {
    databaseUrl: String(url), selfAppSlug: 'no-such-self-app', selfAppPublicVoting: true,
    platformRepoUrl: 'https://github.com/tag-owner/platform',
    challengeScorer: { intervalMinutes: 10, aggregateHours: 0 },
  };
  const express = require('express');
  const { getPool } = require('../src/db/pool');
  const server = express();
  server.use(express.json());
  let as = await user();
  server.use((req, _res, next) => {
    req.user = { id: as.id, username: as.username, isAdmin: false, hasPlatformAccess: true };
    next();
  });
  server.use(require('../src/routes/feedback').feedbackRoutes(config));
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  cleanup.push(async () => {
    await new Promise((r) => listener.close(r));
    await getPool(config).end().catch(() => {});
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  // GitHub stubbed: an app report files an issue before it records the
  // report. Nothing here reaches GitHub.
  const github = require('../src/services/github');
  const real = { isEnabled: github.isEnabled, createIssue: github.createIssue, noteIssueCreated: github.noteIssueCreated };
  const priorToken = process.env.GITHUB_BOT_TOKEN;
  let issueNumber = 200;
  github.isEnabled = () => true;
  github.createIssue = async (o, r) => {
    issueNumber += 1;
    return { number: issueNumber, html_url: `https://github.com/${o}/${r}/issues/${issueNumber}` };
  };
  github.noteIssueCreated = () => {};
  process.env.GITHUB_BOT_TOKEN = 'test-token';
  t.after(() => {
    Object.assign(github, real);
    if (priorToken === undefined) delete process.env.GITHUB_BOT_TOKEN;
    else process.env.GITHUB_BOT_TOKEN = priorToken;
  });

  const arena = await app({ createdBy: as.id });
  await pool.query(
    `INSERT INTO community_members (community_id, user_id)
     SELECT community_id, $2 FROM apps WHERE id = $1 ON CONFLICT DO NOTHING`,
    [arena.id, as.id],
  );
  // Two screenshots the reporter owns, unlinked to any issue: exactly what
  // POST /api/screenshots leaves behind for the dialog to send.
  const shot = async () => {
    const id = crypto.randomBytes(16).toString('hex');
    await pool.query(
      `INSERT INTO issue_screenshots (id, user_id, content_type, size_bytes, data)
       VALUES ($1, $2, 'image/png', 64, 'png-bytes')`, [id, as.id]);
    return id;
  };
  const lastReport = async () => (await pool.query(
    `SELECT challenge_id, screenshot_count, issue_number FROM feedback_reports
      WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [as.id])).rows[0];

  await t.test('a tagged report with screenshots stores both the challenge and the count', async () => {
    const a = await shot();
    const b = await shot();
    const got = await call('POST', '/api/feedback', {
      title: 'The vote button does nothing',
      description: 'The vote button on the Workshop does nothing the first time I press it.',
      target: 'app', appSlug: arena.slug,
      challengeId: BUG, screenshotIds: [a, b],
    });
    assert.equal(got.status, 200, JSON.stringify(got.body));
    const report = await lastReport();
    assert.equal(Number(report.challenge_id), BUG, 'tagged with the challenge it was sent from');
    assert.equal(Number(report.screenshot_count), 2, 'both screenshots counted');
    assert.ok(report.issue_number, 'and filed as a request as usual');
  });

  await t.test('an untagged report stores no challenge and no screenshots', async () => {
    const got = await call('POST', '/api/feedback', {
      title: 'The search box forgets input',
      description: 'The search box on Discover forgets what I typed when I go back to it.',
      target: 'app', appSlug: arena.slug,
    });
    assert.equal(got.status, 200, JSON.stringify(got.body));
    const report = await lastReport();
    assert.equal(report.challenge_id, null);
    assert.equal(Number(report.screenshot_count), 0);
  });

  await t.test('a stale tag is dropped at the door: filed, untagged, accepted', async () => {
    const got = await call('POST', '/api/feedback', {
      title: 'Old challenge, good report',
      description: 'The share button saves twice when the network is slow, and loses the second copy.',
      target: 'app', appSlug: arena.slug,
      challengeId: SUGGEST,
    });
    assert.equal(got.status, 200, 'dropped, never a 400');
    const report = await lastReport();
    assert.equal(report.challenge_id, null, 'filed untagged');
    assert.equal(Number(report.screenshot_count), 0);
  });

  // The bot's shape (filePlatformReport): no screenshot count passed at all.
  // The column is NOT NULL, so a caller that leaves it off must store 0 —
  // an explicit null would fail the INSERT and the best-effort catch would
  // swallow it, losing the receipt (#11's bot files reports this way).
  await t.test('a caller that leaves the count off still stores its receipt', async () => {
    await recordFeedbackReport(pool, {
      user: as, app: null, owner: 'tag-owner', repo: 'platform', issueNumber: 777,
      title: 'Two proposals for one request', description: 'private description',
      source: 'homeroom_bot',
    });
    const { rows } = await pool.query(
      `SELECT challenge_id, screenshot_count FROM feedback_reports
        WHERE user_id = $1 AND source = 'homeroom_bot' AND issue_number = 777`, [as.id]);
    assert.equal(rows.length, 1, 'the receipt lands under the person, not lost to NOT NULL');
    assert.equal(Number(rows[0].screenshot_count), 0, 'no screenshots carried stores 0');
    assert.equal(rows[0].challenge_id, null, 'the bot does not tag');
  });
});