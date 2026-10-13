'use strict';

// The programme CSV against the REAL schema in a throwaway PostgreSQL
// database — schema.sql applied as the boot migration applies it — so what is
// tested is the SQL that ships (src/routes/topochain/admin/programme-export.js):
// which rows come back, what each column holds, the order, and the gate in
// front of it, all through the composed admin router a request really meets.
//
// The fixture is a small programme with every case the file has to get right:
// two seasons whose display_order runs against their names, an internal event,
// an event with no season, categories spelled with stray case and whitespace,
// a challenge with both a challenge-bound and a template-bound rule, one with
// none, a challenge overriding its template's text, and two unused templates,
// one of them carrying a template rule.
//
// Skipped when no server is reachable, and required when TEST_DATABASE_URL
// is set — the same contract as tests/communities-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const { Pool } = require('pg');

// Route modules destructure `getPool` at require time, so the indirection is
// installed first and pointed at the throwaway database once it exists.
const poolMod = require('../src/db/pool');
let currentPool = null;
poolMod.getPool = () => currentPool;
const { topochainAdminRoutes } = require('../src/routes/topochain/admin');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const ROUTE = '/api/v4/admin/programme/export.csv';

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; i += 1;
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return { header, records: body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]]))) };
}

test('the programme CSV, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'programme_csv_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  currentPool = pool;
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const season = (nm, order, active) => one(
    `INSERT INTO seasons (name, starts_at, ends_at, is_active, display_order)
     VALUES ($1, '2026-01-01Z', '2026-12-31Z', $2, $3) RETURNING id`, [nm, active, order]);
  const event = (nm, seasonId, startsAt, { internal = false, active = true, type = 'regular' } = {}) => one(
    `INSERT INTO season_events (name, starts_at, ends_at, is_active, internal, scoring_formula, season_id, type)
     VALUES ($1, $2::timestamptz, $2::timestamptz + INTERVAL '7 days', $3, $4, '{}'::jsonb, $5, $6) RETURNING id`,
    [nm, startsAt, active, internal, seasonId, type]);
  const template = (cols) => one(
    `INSERT INTO challenge_templates (category, goal, task, reward, metric_type, metric_target, cta_label, cta_link,
                                      schedule_start, schedule_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [cols.category, cols.goal, cols.task, cols.reward, cols.metric_type || null, cols.metric_target ?? null,
      cols.cta_label || null, cols.cta_link || null, cols.schedule_start || null, cols.schedule_end || null]);
  const challenge = (eventId, templateId, cols = {}) => one(
    `INSERT INTO challenges (season_event_id, challenge_template_id, display_order, enabled, completed,
                             goal, reward, metric_target, schedule_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [eventId, templateId, cols.display_order ?? 0, cols.enabled ?? true, cols.completed ?? false,
      cols.goal || null, cols.reward || null, cols.metric_target ?? null, cols.schedule_end || null]);
  const rule = (cols) => one(
    `INSERT INTO challenge_scoring_rules (name, measure, challenge_template_id, challenge_id, target, points,
                                          enabled, interval_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [cols.name, cols.measure, cols.template ?? null, cols.challenge ?? null, cols.target ?? null,
      cols.points ?? null, cols.enabled ?? true, cols.interval ?? null]);

  // display_order decides, not the name or the dates: Season 2 carries 0 and
  // Season 1 carries 1, so Season 1's event comes second though it started
  // first.
  const s2 = await season('Season 2', 0, true);
  const s1 = await season('Season 1', 1, false);
  const week1 = await event('Week 1', s2.id, '2026-10-05T09:00:00Z');
  const week2 = await event('Week 2 (staff dry run)', s2.id, '2026-10-12T09:00:00Z', { internal: true });
  const kickoff = await event('Kickoff', s1.id, '2026-01-10T09:00:00Z', { active: false, type: 'season' });
  const loose = await event('Loose event', null, '2025-06-01T09:00:00Z');

  const tTry = await template({
    category: ' onboarding ', goal: 'Try 3 apps', task: 'Open three apps', reward: '500 pts',
    metric_type: 'apps_tried', metric_target: 3, cta_label: 'Open apps', cta_link: '/#discover',
    schedule_start: '2026-10-01T00:00:00Z',
  });
  const tShip = await template({
    category: 'BUILD', goal: 'Ship it', task: 'Merge one proposal, then say "done",\nout loud',
    reward: '=1+1 pts', metric_type: 'proposals_merged', metric_target: 1,
  });
  const tHello = await template({ category: 'Onboarding', goal: 'Say hello', task: 'Post in #general', reward: '50 pts' });
  const tZeta = await template({ category: 'zeta', goal: 'Unused Z', task: 'Nothing yet', reward: '10 pts' });
  const tAlpha = await template({ category: 'Alpha', goal: '@Unused A', task: 'Nothing yet', reward: '-5 pts' });

  // Week 1: BUILD sorts before ONBOARDING whatever the display_order says;
  // within ONBOARDING, ' onboarding ' and 'Onboarding' are one group, ordered
  // by display_order.
  const cTry = await challenge(week1.id, tTry.id, { display_order: 5 });
  const cHello = await challenge(week1.id, tHello.id, { display_order: 1 });
  const cShip = await challenge(week1.id, tShip.id, {
    display_order: 9, goal: 'Ship a feature', reward: '1,000 pts', metric_target: 2.5,
    schedule_end: '2026-10-11T23:00:00Z',
  });
  const cDry = await challenge(week2.id, tTry.id, { enabled: false });
  const cKick = await challenge(kickoff.id, tHello.id, { completed: true });
  const cLoose = await challenge(loose.id, tShip.id);

  // A template rule covers every challenge stamped from it; a challenge rule
  // narrows to one. cTry has both, so it is two rows, the challenge's first.
  const rTemplate = await rule({ name: 'Try apps (all weeks)', measure: 'TRY_APPS', template: tTry.id, points: 250, interval: 10 });
  const rChallenge = await rule({ name: 'Try apps (week 1 bonus)', measure: 'TRY_APPS', challenge: cTry.id, target: 5, points: -10, enabled: false });
  const rUnused = await rule({ name: 'Ready for later', measure: 'PROPOSAL_ACCEPTED', template: tZeta.id });

  function userMiddleware(role) {
    return (req, _res, next) => {
      if (role === 'user') req.user = { id: 1, username: 'plain', isAdmin: false, canAdminWrite: false };
      if (role === 'readonly') req.user = { id: 2, username: 'ro', isAdmin: true, canAdminWrite: false };
      if (role === 'admin') req.user = { id: 3, username: 'evan', isAdmin: true, canAdminWrite: true };
      next();
    };
  }
  async function download(role) {
    const app = express();
    app.use(userMiddleware(role));
    app.use(topochainAdminRoutes({ databaseUrl: String(url) }));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${ROUTE}`);
      // Buffer, not res.text(): the Fetch decoder strips a leading BOM, and
      // the BOM is part of what is being checked.
      return { res, text: Buffer.from(await res.arrayBuffer()).toString('utf8') };
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  const { res, text } = await download('admin');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="programme-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.equal(text.charCodeAt(0), 0xFEFF, 'BOM first');
  const { header, records } = parseCsv(text.slice(1));
  assert.equal(header.length, 35);
  assert.equal(header[0], 'row_kind');
  assert.equal(header[34], 'rule_interval_minutes');

  await t.test('one row per challenge per rule, then the unused templates, in the documented order', () => {
    assert.deepEqual(records.map((r) => [r.row_kind, r.challenge_id || r.template_id, r.rule_id]), [
      // Season 2 (display_order 0): Week 1, BUILD then ONBOARDING by display_order.
      ['challenge', String(cShip.id), ''],
      ['challenge', String(cHello.id), ''],
      ['challenge', String(cTry.id), String(rChallenge.id)],
      ['challenge', String(cTry.id), String(rTemplate.id)],
      // Week 2, the internal one, starts later.
      ['challenge', String(cDry.id), String(rTemplate.id)],
      // Season 1 (display_order 1), though its event started first.
      ['challenge', String(cKick.id), ''],
      // No season at all: after every season's events.
      ['challenge', String(cLoose.id), ''],
      // Unused templates last, by UPPER(TRIM(category)).
      ['unused_template', String(tAlpha.id), ''],
      ['unused_template', String(tZeta.id), String(rUnused.id)],
    ]);
  });

  const find = (pred) => records.filter(pred);

  await t.test('season and event columns, internal events included and flagged', () => {
    const [dry] = find((r) => r.challenge_id === String(cDry.id));
    assert.equal(dry.season_id, String(s2.id));
    assert.equal(dry.season, 'Season 2');
    assert.equal(dry.season_active, 'true');
    assert.equal(dry.event_id, String(week2.id));
    assert.equal(dry.event, 'Week 2 (staff dry run)');
    assert.equal(dry.event_type, 'regular');
    assert.equal(dry.event_internal, 'true');
    assert.equal(dry.event_active, 'true');
    assert.equal(dry.event_starts_at, '2026-10-12T09:00:00.000+00:00');
    assert.equal(dry.event_ends_at, '2026-10-19T09:00:00.000+00:00');
    assert.equal(dry.enabled, 'false');

    const [kick] = find((r) => r.challenge_id === String(cKick.id));
    assert.equal(kick.season, 'Season 1');
    assert.equal(kick.season_active, 'false');
    assert.equal(kick.event_type, 'season');
    assert.equal(kick.event_active, 'false');
    assert.equal(kick.event_internal, 'false');
    assert.equal(kick.completed, 'true');

    const [lone] = find((r) => r.challenge_id === String(cLoose.id));
    assert.equal(lone.season_id, '');
    assert.equal(lone.season, '');
    assert.equal(lone.season_active, '', 'no season, so no season flag either');
    assert.equal(lone.event, 'Loose event');
  });

  await t.test('text, metric and schedule are the effective values; the reward keeps both halves', () => {
    const [ship] = find((r) => r.challenge_id === String(cShip.id));
    assert.equal(ship.template_id, String(tShip.id));
    assert.equal(ship.category, 'BUILD');
    assert.equal(ship.title, 'Ship a feature', 'the challenge\'s own goal');
    assert.equal(ship.task, 'Merge one proposal, then say "done",\nout loud',
      'inherited, and the quote, comma and newline survive the round trip');
    assert.equal(ship.template_reward, '\'=1+1 pts', 'the template\'s reward, formula-neutralised');
    assert.equal(ship.reward_override, '1,000 pts');
    assert.equal(ship.metric_type, 'proposals_merged', 'inherited');
    assert.equal(ship.metric_target, '2.5', 'the challenge\'s own target, written as a number');
    assert.equal(ship.schedule_start, '');
    assert.equal(ship.schedule_end, '2026-10-11T23:00:00.000+00:00');
    assert.equal(ship.display_order, '9');

    const [tryRow] = find((r) => r.challenge_id === String(cTry.id));
    assert.equal(tryRow.category, ' onboarding ', 'the category is written as stored');
    assert.equal(tryRow.title, 'Try 3 apps');
    assert.equal(tryRow.reward_override, '');
    assert.equal(tryRow.cta_label, 'Open apps');
    assert.equal(tryRow.cta_link, '/#discover');
    assert.equal(tryRow.metric_target, '3');
    assert.equal(tryRow.schedule_start, '2026-10-01T00:00:00.000+00:00', 'inherited from the template');
  });

  await t.test('rule columns: which binding, the rule\'s own numbers, empty when there is no rule', () => {
    const [own, viaTemplate] = find((r) => r.challenge_id === String(cTry.id));
    assert.deepEqual(
      [own.rule_name, own.rule_measure, own.rule_bound_to, own.rule_target, own.rule_points, own.rule_enabled,
        own.rule_interval_minutes],
      ['Try apps (week 1 bonus)', 'TRY_APPS', 'challenge', '5', '-10', 'false', ''],
      'a negative points value stays a number',
    );
    assert.deepEqual(
      [viaTemplate.rule_name, viaTemplate.rule_bound_to, viaTemplate.rule_target, viaTemplate.rule_points,
        viaTemplate.rule_enabled, viaTemplate.rule_interval_minutes],
      ['Try apps (all weeks)', 'template', '', '250', 'true', '10'],
    );
    const [hello] = find((r) => r.challenge_id === String(cHello.id));
    for (const col of header.filter((h) => h.startsWith('rule_'))) {
      assert.equal(hello[col], '', `${col} is empty for a challenge no rule applies to`);
    }
  });

  await t.test('unused templates carry only template columns, and their template rule', () => {
    const [alpha] = find((r) => r.template_id === String(tAlpha.id));
    assert.equal(alpha.row_kind, 'unused_template');
    for (const col of ['season_id', 'season', 'event_id', 'event', 'event_internal', 'challenge_id',
      'display_order', 'enabled', 'completed', 'reward_override', 'rule_id']) {
      assert.equal(alpha[col], '', `${col} is empty on an unused template`);
    }
    assert.equal(alpha.title, '\'@Unused A', 'formula-neutralised');
    assert.equal(alpha.template_reward, '\'-5 pts', 'text that merely starts with a minus is still guarded');
    assert.equal(alpha.task, 'Nothing yet');

    const [zeta] = find((r) => r.template_id === String(tZeta.id));
    assert.equal(zeta.rule_name, 'Ready for later');
    assert.equal(zeta.rule_measure, 'PROPOSAL_ACCEPTED');
    assert.equal(zeta.rule_bound_to, 'template');
  });

  await t.test('a view-only admin may download it; anyone else gets the v4 403', async () => {
    const ro = await download('readonly');
    assert.equal(ro.res.status, 200);
    assert.equal(ro.text, text, 'the same file');
    for (const role of ['user', 'anon']) {
      const denied = await download(role);
      assert.equal(denied.res.status, 403, role);
      assert.deepEqual(JSON.parse(denied.text), { success: false, error: 'Unauthorized. Admin access required.' });
    }
  });
});
