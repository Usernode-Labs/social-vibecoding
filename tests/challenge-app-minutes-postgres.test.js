'use strict';

// The "N min used this week" line under a "use apps for N minutes" challenge
// card (frontend/src/features/leaderboard/challenge-card.tsx) comes from
// challenge-scorer: USES_APP_MINUTES_SQL, the column both challenge lists
// select to say an enabled USE_APPS_MINUTES rule scores a challenge, and
// appMinutesThisWeek, the viewer's seconds in app_activity since Monday 00:00
// UTC on apps they did not make (the scorer's own rule). This runs both
// against a real database, and attachAppMinutes over their answers: 0, not
// missing, for a viewer with no use.
//
// Run with: node --test tests/challenge-app-minutes-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { appMinutesThisWeek, attachAppMinutes, USES_APP_MINUTES_SQL } = require('../src/services/topochain/challenge-scorer');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('appMinutesThisWeek reads the viewer’s app minutes this week for "use apps" challenges only (PostgreSQL)',
  { timeout: 180000 }, async (t) => {
    const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
    try { await admin.query('SELECT 1'); } catch (error) {
      await admin.end();
      if (process.env.TEST_DATABASE_URL) throw error;
      t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
    }
    const name = `app_minutes_${crypto.randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN); url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: String(url), max: 4 });
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    });
    await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

    let seq = 0;
    const person = async () => Number((await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, 'unused') RETURNING id`,
      [`minutes_person_${++seq}`]
    )).rows[0].id);
    const project = async (ownerId) => Number((await pool.query(
      `INSERT INTO apps (slug, name, created_by, view_visibility, collab_visibility)
       VALUES ($1, 'Clock app', $2, 'public', 'public') RETURNING id`,
      [`minutes-app-${++seq}`, ownerId]
    )).rows[0].id);
    const viewer = await person();
    const idle = await person();
    const maker = await person();
    const theirs = await project(maker);
    const other = await project(maker);
    const mine = await project(viewer);

    // Days relative to this week's Monday (UTC), so the test reads the same
    // on any day it runs.
    const monday = `(date_trunc('week', NOW() AT TIME ZONE 'UTC'))::date`;
    const use = (appId, userId, seconds, dayExpr) => pool.query(
      `INSERT INTO app_activity (app_id, user_id, seconds_spent, date) VALUES ($1, $2, $3, ${dayExpr})`,
      [appId, userId, seconds]
    );
    await use(theirs, viewer, 300, monday); // 5 min on Monday
    await use(other, viewer, 470, `${monday} + 0`); // and 7 min 50 s on another app
    await use(theirs, viewer, 3600, `${monday} - 1`); // last Sunday: not this week
    await use(mine, viewer, 6000, monday); // their own app: never counted

    const season = Number((await pool.query(
      `INSERT INTO seasons (name, starts_at, ends_at, is_active)
       VALUES ('Minutes season', NOW() - INTERVAL '30 days', NOW() + INTERVAL '30 days', TRUE) RETURNING id`
    )).rows[0].id);
    const event = Number((await pool.query(
      `INSERT INTO season_events (name, starts_at, ends_at, is_active, scoring_formula, season_id, type)
       VALUES ('Minutes event', NOW() - INTERVAL '30 days', NOW() + INTERVAL '30 days', TRUE, '{}'::jsonb, $1, 'season')
       RETURNING id`, [season]
    )).rows[0].id);
    const challenge = async (measure, { onChallenge = false, enabled = true } = {}) => {
      const template = Number((await pool.query(
        `INSERT INTO challenge_templates (category, goal, task, reward, metric_target)
         VALUES ('WEEKLY', $1, 'Use apps', '100 pts', 1) RETURNING id`, [measure || 'No rule']
      )).rows[0].id);
      const id = Number((await pool.query(
        `INSERT INTO challenges (season_event_id, challenge_template_id) VALUES ($1, $2) RETURNING id`,
        [event, template]
      )).rows[0].id);
      if (measure) {
        await pool.query(
          `INSERT INTO challenge_scoring_rules (name, measure, challenge_template_id, challenge_id, target, enabled)
           VALUES ($1, $1, $2, $3, 10, $4)`,
          [measure, onChallenge ? null : template, onChallenge ? id : null, enabled]
        );
      }
      return id;
    };
    const byTemplate = await challenge('USE_APPS_MINUTES');
    const byChallenge = await challenge('USE_APPS_MINUTES', { onChallenge: true });
    const disabled = await challenge('USE_APPS_MINUTES', { enabled: false });
    const tryApps = await challenge('TRY_APPS');
    const noRule = await challenge(null);
    const all = [byTemplate, byChallenge, disabled, tryApps, noRule];

    const { rows } = await pool.query(
      `SELECT c.id, ${USES_APP_MINUTES_SQL} AS uses_app_minutes
         FROM challenges c WHERE c.id = ANY($1::bigint[]) ORDER BY c.id`, [all]
    );
    assert.deepEqual(rows.filter((r) => r.uses_app_minutes).map((r) => Number(r.id)), [byTemplate, byChallenge],
      'a live USE_APPS_MINUTES rule on the template or the challenge; not a disabled one, another measure or none');

    assert.equal(await appMinutesThisWeek(pool, viewer), 12,
      'whole minutes this week on other people’s apps (770 s is 12 min); last week and their own app left out');
    assert.equal(await appMinutesThisWeek(pool, idle), 0, 'no use this week is 0');
    assert.equal(await appMinutesThisWeek(pool, null), null, 'a signed-out viewer has no figure');

    const items = (who) => rows.map((r) => ({ id: Number(r.id), viewer: who }));
    const seen = items(viewer);
    await attachAppMinutes(pool, viewer, seen, rows);
    assert.deepEqual(seen.map((i) => [i.id, i.minutes_this_week]),
      all.map((id) => [id, id === byTemplate || id === byChallenge ? 12 : null]));
    const none = items(idle);
    await attachAppMinutes(pool, idle, none, rows);
    assert.equal(none.find((i) => i.id === byTemplate).minutes_this_week, 0, 'the line says 0 rather than going away');
    const anon = items(null);
    await attachAppMinutes(pool, null, anon, rows);
    assert.ok(anon.every((i) => i.minutes_this_week === null), 'signed out: no line');
  });
