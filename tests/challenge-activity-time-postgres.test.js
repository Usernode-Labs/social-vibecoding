'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const activity = require('../src/services/app-activity');
const scorer = require('../src/services/topochain/challenge-scorer');
const { activityTimePrecision } = require('../src/services/topochain/activity-time');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const NOW = Date.parse('2026-10-03T20:00:00Z');

test('challenge credits retain the qualifying usage time through delayed and concurrent delivery (PostgreSQL)',
  { timeout: 180000 }, async (t) => {
    const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
    try { await admin.query('SELECT 1'); } catch (error) {
      await admin.end();
      if (process.env.TEST_DATABASE_URL) throw error;
      t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
    }
    const name = `challenge_time_${crypto.randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN); url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: String(url), max: 4 });
    t.after(async () => {
      await activity._awaitReceiptCleanupForTests();
      await pool.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    });
    const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
    await pool.query(schema);
    await pool.query(schema);
    let seq = 0;
    const person = async () => (await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, 'unused') RETURNING id`,
      [`time_person_${++seq}`]
    )).rows[0];
    const owner = await person();
    const project = async () => (await pool.query(
      `INSERT INTO apps (slug, name, created_by, view_visibility, collab_visibility)
       VALUES ($1, 'Clock app', $2, 'public', 'public') RETURNING id, slug`,
      [`time-app-${++seq}`, owner.id]
    )).rows[0];
    const season = (await pool.query(
      `INSERT INTO seasons (name, starts_at, ends_at, is_active)
       VALUES ('Clock season', '2026-10-01', '2026-10-20', TRUE) RETURNING id`
    )).rows[0];
    const event = (await pool.query(
      `INSERT INTO season_events (name, starts_at, ends_at, is_active, scoring_formula, season_id, type)
       VALUES ('Clock event', '2026-10-01', '2026-10-20', TRUE, '{}'::jsonb, $1, 'season') RETURNING id`,
      [season.id]
    )).rows[0];
    const challenge = async (measure) => {
      const template = (await pool.query(
        `INSERT INTO challenge_templates (category, goal, task, reward, metric_target)
         VALUES ('PERSISTENT', $1, 'Use the clock app', '100 pts', 1) RETURNING id`, [measure]
      )).rows[0];
      const c = (await pool.query(
        `INSERT INTO challenges (season_event_id, challenge_template_id) VALUES ($1, $2) RETURNING id`,
        [event.id, template.id]
      )).rows[0];
      await pool.query(
        `INSERT INTO challenge_scoring_rules (name, measure, challenge_template_id)
         VALUES ($1, $1, $2)`, [measure, template.id]
      );
      return Number(c.id);
    };
    const TRY = await challenge('TRY_APPS');
    const MINUTES = await challenge('USE_APPS_MINUTES');
    const credits = async (user, id) => (await pool.query(
      'SELECT points, activity_at, metadata FROM user_activities WHERE user_id = $1 AND challenge_id = $2',
      [user.id, id]
    )).rows;
    const payload = (ranges, batchId = crypto.randomUUID()) => {
      const byDay = new Map();
      for (const [start, end] of ranges) {
        const startedAt = new Date(start).toISOString();
        const endedAt = new Date(end).toISOString();
        const date = startedAt.slice(0, 10);
        const entry = byDay.get(date) || { date, seconds: 0, intervals: [] };
        entry.seconds += (Date.parse(endedAt) - Date.parse(startedAt)) / 1000;
        entry.intervals.push({ startedAt, endedAt });
        byDay.set(date, entry);
      }
      const parsed = activity.parseActivityRequest({ version: 2, batchId, entries: [...byDay.values()] }, new Date(NOW));
      assert.ok(parsed, 'test usage is a valid delayed upload');
      return parsed;
    };
    const record = (user, app, request) => activity.recordActivityBatch(pool, { user, slug: app.slug, request });

    await t.test('an afternoon threshold is retained after delayed upload, scoring, retry and later use', async () => {
      const user = await person(); const app = await project();
      const request = payload([['2026-10-01T15:16:50Z', '2026-10-01T15:17:00Z']]);
      assert.equal((await record(user, app, request)).duplicate, false);
      assert.equal((await record(user, app, request)).duplicate, true);
      const summary = await scorer.score(pool, { now: NOW });
      assert.equal(summary.credits, 1);
      const [credit] = await credits(user, TRY);
      assert.equal(credit.activity_at.toISOString(), '2026-10-01T15:17:00.000Z');
      assert.equal(activityTimePrecision(credit), 'instant');
      assert.equal(Number(credit.points), 100);
      await record(user, app, payload([['2026-10-02T18:00:00Z', '2026-10-02T18:00:20Z']]));
      await scorer.score(pool, { now: NOW });
      assert.equal((await credits(user, TRY))[0].activity_at.toISOString(), credit.activity_at.toISOString());
      assert.equal((await credits(user, TRY)).length, 1);
    });

    await t.test('minutes across apps resolve the threshold inside its original interval', async () => {
      const user = await person(); const a = await project(); const b = await project();
      await record(user, a, payload([['2026-10-01T15:00:00Z', '2026-10-01T15:00:20Z']]));
      await record(user, b, payload([['2026-10-01T16:00:00Z', '2026-10-01T16:01:00Z']]));
      await scorer.score(pool, { now: NOW });
      const [credit] = await credits(user, MINUTES);
      assert.equal(credit.activity_at.toISOString(), '2026-10-01T16:00:40.000Z');
      assert.equal(credit.metadata.timestamp_precision, 'instant');
    });

    await t.test('real noon and midnight completions keep explicit instant precision', async () => {
      for (const [start, end] of [
        ['2026-10-01T11:59:50Z', '2026-10-01T12:00:00Z'],
        ['2026-10-01T23:59:50Z', '2026-10-02T00:00:00Z'],
      ]) {
        const user = await person(); const app = await project();
        await record(user, app, payload([[start, end]]));
        await scorer.score(pool, { now: NOW });
        const [credit] = await credits(user, TRY);
        assert.equal(credit.activity_at.toISOString(), new Date(end).toISOString());
        assert.equal(activityTimePrecision(credit), 'instant');
      }
    });

    await t.test('a precise source is clipped to the challenge window, not its whole calendar day', async () => {
      const user = await person(); const app = await project();
      await record(user, app, payload([['2026-10-01T14:59:58Z', '2026-10-01T15:00:10Z']]));
      const window = { startMs: Date.parse('2026-10-01T15:00:05Z'), endMs: Date.parse('2026-10-01T17:00:00Z') };
      let rows = await scorer.loadCandidates(pool, 'TRY_APPS', window, { target: 1 });
      assert.ok(!rows.some((r) => Number(r.userId) === user.id), 'only five qualifying seconds are inside the window');
      await record(user, app, payload([['2026-10-01T15:00:20Z', '2026-10-01T15:00:30Z']]));
      rows = await scorer.loadCandidates(pool, 'TRY_APPS', window, { target: 1 });
      assert.equal(rows.find((r) => Number(r.userId) === user.id).activityAt, '2026-10-01T15:00:25.000Z');
    });

    await t.test('overlapping concurrent receipts acknowledge both uploads and count their union once', async () => {
      const user = await person(); const app = await project();
      const results = await Promise.allSettled([
        record(user, app, payload([['2026-10-01T15:00:00Z', '2026-10-01T15:00:10Z']])),
        record(user, app, payload([['2026-10-01T15:00:00Z', '2026-10-01T15:00:10Z']])),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
      assert.equal((await pool.query('SELECT seconds_spent FROM app_activity WHERE user_id = $1', [user.id])).rows[0].seconds_spent, 10);
      assert.equal((await pool.query('SELECT count(*)::int n FROM app_usage_intervals WHERE user_id = $1', [user.id])).rows[0].n, 1);
      assert.equal((await pool.query('SELECT count(*)::int n FROM app_activity_receipts WHERE user_id = $1', [user.id])).rows[0].n, 2);
    });

    await t.test('a partially overlapping upload preserves new time and fractional remainders', async () => {
      const user = await person(); const app = await project();
      await record(user, app, payload([['2026-10-01T15:00:00Z', '2026-10-01T15:00:10Z']]));
      await record(user, app, payload([['2026-10-01T15:00:05.500Z', '2026-10-01T15:00:15.500Z']]));
      await record(user, app, payload([['2026-10-01T15:00:15Z', '2026-10-01T15:00:16Z']]));
      const [day] = (await pool.query('SELECT seconds_spent, precise_milliseconds FROM app_activity WHERE user_id = $1', [user.id])).rows;
      assert.equal(day.seconds_spent, 16);
      assert.equal(Number(day.precise_milliseconds), 16_000);
      assert.equal((await pool.query('SELECT count(*)::int n FROM app_usage_intervals WHERE user_id = $1', [user.id])).rows[0].n, 1,
        'continuous time stays compact across receipts');
    });

    await t.test('combined minutes preserve the real threshold time when different apps overlap', async () => {
      const user = await person(); const a = await project(); const b = await project();
      await record(user, a, payload([['2026-10-01T15:00:00Z', '2026-10-01T15:01:00Z']]));
      await record(user, b, payload([['2026-10-01T15:00:00Z', '2026-10-01T15:01:00Z']]));
      await scorer.score(pool, { now: NOW });
      const [credit] = await credits(user, MINUTES);
      assert.equal(credit.activity_at.toISOString(), '2026-10-01T15:00:30.000Z',
        'the existing sum-across-apps measure crosses a minute after thirty seconds of parallel use');
    });

    await t.test('old day-only data continues to score without fabricating an occurrence time', async () => {
      const user = await person(); const app = await project();
      const request = activity.parseActivityRequest({ version: 1, batchId: crypto.randomUUID(),
        entries: [{ date: '2026-10-01', seconds: 10 }],
      }, new Date(NOW));
      await record(user, app, request);
      await scorer.score(pool, { now: NOW });
      const [credit] = await credits(user, TRY);
      assert.equal(activityTimePrecision(credit), 'day');
      assert.equal(credit.activity_at.toISOString(), '2026-10-01T12:00:00.000Z');
      assert.equal(activityTimePrecision({ metadata: { measure: 'TRY_APPS' } }), 'day', 'old scorer metadata remains identifiable');
      assert.equal(activityTimePrecision({ metadata: {}, activity_at: credit.activity_at }), 'instant', 'a clock hour alone never labels other actions date-only');
    });
  });
