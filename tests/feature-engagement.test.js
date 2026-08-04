'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const engagement = require('../src/services/feature-engagement');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('v1 catalog is a small, frozen platform workflow allowlist', () => {
  assert.equal(engagement.CATALOG_VERSION, 1);
  assert.deepEqual(Object.keys(engagement.CATALOG), [
    'onboarding_first_app',
    'proposal_authoring',
    'proposal_submission',
    'proposal_review',
    'proposal_delivery',
  ]);
  assert.ok(Object.isFrozen(engagement.CATALOG));
  assert.equal(engagement.CATALOG.onboarding_first_app.subject, 'user');
  assert.equal(engagement.CATALOG.proposal_review.subject, 'session');
});

test('record writes only allowlisted structured fields and deduplicates', async () => {
  const calls = [];
  const pool = { query: async (...args) => { calls.push(args); return { rowCount: 1 }; } };
  await engagement.recordStart(pool, engagement.WORKFLOW_IDS.PROPOSAL_AUTHORING, {
    userId: 7, appId: 8, sessionId: 9, metadata: { prompt: 'must not persist' },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /INSERT INTO feature_engagement_events/);
  assert.match(calls[0][0], /ON CONFLICT DO NOTHING/);
  assert.doesNotMatch(calls[0][0], /metadata/i);
  assert.deepEqual(calls[0][1], [1, 'proposal_authoring', 'start', 7, 8, 9]);
});

test('record drops invalid workflow, actor, stage and subject without querying', async () => {
  let queries = 0;
  const pool = { query: async () => { queries += 1; } };
  await engagement.record(pool, { workflow: 'made_up', stage: 'start', userId: 1 });
  await engagement.record(pool, { workflow: 'proposal_review', stage: 'start', userId: 1 });
  await engagement.record(pool, { workflow: 'onboarding_first_app', stage: 'complete', userId: 1, sessionId: 2 });
  await engagement.record(pool, { workflow: 'proposal_review', stage: 'finish', userId: 1, sessionId: 2 });
  await engagement.record(pool, { workflow: 'onboarding_first_app', stage: 'start', userId: 'not-an-id' });
  assert.equal(queries, 0);
});

test('record is fail-open when analytics storage fails', async () => {
  const pool = { query: () => Promise.reject(new Error('db unavailable')) };
  await assert.doesNotReject(() => engagement.recordStart(
    pool, engagement.WORKFLOW_IDS.ONBOARDING_FIRST_APP, { userId: 1 }
  ));
});

test('cohorts are fully matured and non-overlapping', () => {
  const bounds = engagement.cohortBounds(new Date('2026-08-05T18:45:00Z'));
  assert.equal(bounds.baselineStart.toISOString(), '2026-06-24T00:00:00.000Z');
  assert.equal(bounds.baselineEnd.toISOString(), '2026-07-22T00:00:00.000Z');
  assert.equal(bounds.recentStart.toISOString(), '2026-07-22T00:00:00.000Z');
  assert.equal(bounds.recentEnd.toISOString(), '2026-07-29T00:00:00.000Z');
  assert.equal(bounds.completionCutoff.toISOString(), '2026-08-05T00:00:00.000Z');
});

test('drop-off requires 20 starts in both cohorts and a 20 point decline', () => {
  const exact = engagement.evaluateWorkflow('proposal_authoring', {
    recentStarts: 20, recentCompletions: 10,
    baselineStarts: 40, baselineCompletions: 28,
  });
  assert.equal(exact.recentRate, 50);
  assert.equal(exact.baselineRate, 70);
  assert.equal(exact.declinePoints, 20);
  assert.equal(exact.status, 'dropoff');
  assert.equal(exact.insight, true);

  const tooSmall = engagement.evaluateWorkflow('proposal_authoring', {
    recentStarts: 19, recentCompletions: 0,
    baselineStarts: 100, baselineCompletions: 100,
  });
  assert.equal(tooSmall.status, 'insufficient_data');

  const smallBaseline = engagement.evaluateWorkflow('proposal_authoring', {
    recentStarts: 100, recentCompletions: 1,
    baselineStarts: 19, baselineCompletions: 19,
  });
  assert.equal(smallBaseline.status, 'insufficient_data');

  const healthy = engagement.evaluateWorkflow('proposal_authoring', {
    recentStarts: 20, recentCompletions: 12,
    baselineStarts: 40, baselineCompletions: 30,
  });
  assert.equal(healthy.status, 'healthy');
});

test('insights query excludes admins, allows equal completion time, and returns aggregates only', async () => {
  let sql;
  let params;
  const pool = {
    query: async (statement, values) => {
      sql = statement;
      params = values;
      return { rows: [{
        workflow: 'onboarding_first_app',
        recent_starts: 25,
        recent_completions: 10,
        baseline_starts: 80,
        baseline_completions: 56,
      }] };
    },
  };
  const result = await engagement.insights(pool, { now: new Date('2026-08-05T12:00:00Z') });
  assert.match(sql, /JOIN users u ON u\.id = s\.user_id AND u\.is_admin = FALSE/);
  assert.match(sql, /c\.user_id = s\.user_id/);
  assert.match(sql, /c\.occurred_at >= s\.occurred_at/);
  assert.match(sql, /c\.occurred_at < s\.occurred_at \+ INTERVAL '7 days'/);
  assert.match(sql, /s\.occurred_at < \$4/);
  assert.equal(params.length, 5);
  assert.equal(result.insights.length, 1);
  assert.equal(result.insights[0].id, 'onboarding_first_app');
  assert.equal(result.privacy.rawRetentionDays, 90);
  assert.equal(result.privacy.hostedAppsInstrumented, false);
  assert.equal(JSON.stringify(result).includes('userId'), false);
  assert.equal(JSON.stringify(result).includes('sessionId'), false);
});

test('retention cleanup is indexed, time-bounded and batch-capped', async () => {
  let sql;
  let params;
  const pool = { query: async (statement, values) => {
    sql = statement; params = values; return { rowCount: 12 };
  } };
  assert.equal(await engagement.cleanupExpired(pool, { batchSize: 999999 }), 12);
  assert.match(sql, /occurred_at < NOW\(\) - INTERVAL '90 days'/);
  assert.match(sql, /LIMIT \$1/);
  assert.deepEqual(params, [25000]);
});

test('schema enforces no free-form metadata, deletion privacy and staging scrubbing', () => {
  const schema = read('src/db/schema.sql');
  const start = schema.indexOf('CREATE TABLE IF NOT EXISTS feature_engagement_events');
  const end = schema.indexOf('-- Per-app visibility', start);
  const block = schema.slice(start, end);
  assert.ok(start > 0);
  assert.doesNotMatch(block, /metadata\s+JSON/i);
  assert.match(block, /user_id\s+INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(block, /session_id\s+INTEGER REFERENCES chat_sessions\(id\) ON DELETE CASCADE/);
  assert.match(block, /stage IN \('start', 'complete'\)/);
  assert.match(block, /idx_feature_engagement_user_milestone[\s\S]*WHERE session_id IS NULL/);
  assert.match(block, /idx_feature_engagement_session_milestone[\s\S]*WHERE session_id IS NOT NULL/);
  assert.match(block, /idx_feature_engagement_cohorts/);
  assert.match(block, /idx_feature_engagement_retention/);
  assert.match(block, /COMMENT ON TABLE feature_engagement_events IS 'staging:private'/);
});

test('authoritative platform actions are wired and no hosted-app ingestion route exists', () => {
  const sources = [
    'src/routes/auth.js', 'src/routes/apps.js', 'src/routes/sessions.js',
    'src/routes/proposal-handoff.js', 'src/routes/votes.js',
    'src/services/rename-pr.js',
  ].map(read).join('\n');
  for (const key of Object.keys(engagement.WORKFLOW_IDS)) {
    assert.match(sources, new RegExp(`WORKFLOW_IDS\\.${key}`));
  }
  assert.match(sources, /recordComplete\([\s\S]*PROPOSAL_REVIEW/);
  assert.match(sources, /recordComplete\([\s\S]*PROPOSAL_DELIVERY/);
  assert.doesNotMatch(read('server.js'), /app\.post\([^\n]*feature[-_]engagement/i);
});

test('drop-off API inherits admin middleware and UI labels signals conservatively', () => {
  const route = read('src/routes/dashboard.js');
  const middlewareAt = route.indexOf("router.use('/api/admin/analytics', adminMiddleware)");
  const endpointAt = route.indexOf("router.get('/api/admin/analytics/dropoffs'");
  assert.ok(middlewareAt >= 0 && endpointAt > middlewareAt);
  assert.match(route, /res\.json\(response\)/);

  const ui = read('public/js/admin-analytics.js');
  assert.match(ui, /Feature completion signals/);
  assert.match(ui, /Drop-off signal/);
  assert.match(ui, /signals suggest where to investigate; they do not prove a regression/i);
  assert.match(ui, /raw rows expire after 90 days/i);
  assert.match(ui, /getJSON\(withAdmins\('\/api\/admin\/analytics\/dropoffs'\)\)\.catch\(\(\) => null\)/);
  assert.match(ui, /Feature completion signals are temporarily unavailable/);
  assert.match(ui, /Math\.abs\(Number\(item\.declinePoints\)\)/);
  assert.match(ui, /data-dropoff-issue/);
  assert.match(ui, /Create investigation issue\?/);
  assert.match(ui, /Nothing is filed automatically/);
  assert.match(ui, /method: 'POST'/);
  assert.match(ui, /kind: 'general'/);
  assert.match(route, /self_hosted = TRUE AND status <> 'deleted'/);

  const manifest = JSON.parse(read('dapp.json'));
  const check = manifest.tests.find((item) => item.name.includes('feature completion signals'));
  assert.equal(check.path, '/?demo=1#admin/analytics');
  assert.equal(check.expectText, 'Drop-off signal');
  assert.equal(check.expectSelector, '#engagement-dropoffs article');
});
