// Topochain v4 admin API — D1 season-events, D2 users, D3 user-activities
// (plan Task 11; SPEC 2193-2197 admin auth + conventions, 2199-2269 D1,
// 2271-2405 D2, 2407-2532 D3, 883-895 §4.8 fix list).
//
// HTTP-level tests against throwaway express apps + a shared in-memory
// "fake Postgres" (tables as plain arrays, one regex/startsWith-dispatching
// `handleQuery`, BEGIN/COMMIT/ROLLBACK implemented as a deep-clone
// snapshot/restore of the whole store) — the same idiom as
// tests/board-order.test.js and tests/topochain-partner-api.test.js,
// scaled up because this router composes three sub-routers with real
// FK-shaped relationships between season_events/users/user_activities.
//
// Scope: this file does not re-derive every field of every endpoint —
// it targets the auth gates, the specific v4 bug fixes the brief calls
// out by name, and one smoke pass (index/show/create/update/delete) per
// D-group so a wiring mistake anywhere in the three route modules would
// still be caught.
//
// Run with: node --test tests/topochain-admin-api.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// Every admin route module destructures `getPool` from src/db/pool at
// REQUIRE time (`const { getPool } = require('../../../db/pool')`), so
// reassigning `poolMod.getPool` AFTER those modules are first required
// would be invisible to them (a plain destructure snapshots the function
// reference, it isn't a live binding to the module property) — the same
// pitfall tests/board-order.test.js's own top-of-file comment calls out.
// The fix: install a level of indirection (`() => currentMockPool`)
// BEFORE requiring any topochain admin module below, so every module's
// captured `getPool` reference is already this wrapper; swapping
// `currentMockPool` per test (in beforeEach) is then enough.
const poolMod = require('../src/db/pool');
let currentMockPool = null;
poolMod.getPool = () => currentMockPool;

const { iso } = require('../src/routes/topochain/helpers');
const { topochainAdminRoutes } = require('../src/routes/topochain/admin');
const { seasonEventsAdminRoutes } = require('../src/routes/topochain/admin/season-events');
const { usersAdminRoutes } = require('../src/routes/topochain/admin/users');
const { userActivitiesAdminRoutes } = require('../src/routes/topochain/admin/user-activities');

// ─── Fake Postgres ───────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const T = (offsetDays) => new Date(NOW + offsetDays * DAY);

let db;
let snapshot;
let queryLog; // raw SQL strings, in order — used by the transaction test

function freshDb() {
  return {
    seasons: [{ id: 5, name: 'Season Alpha' }],
    seasonEvents: [],
    users: [],
    userEnrollments: [],
    onchainAccounts: [],
    challengeTemplates: [{ id: 50, category: 'onchain_tx' }, { id: 51, category: 'send_tx' }],
    challenges: [],
    userActivities: [],
    leaderboardSnapshots: [],
    // Starts well above every hand-picked fixture id used across this
    // file's tests, so a row created BY a route handler (e.g. import-csv
    // creating a new user) can never collide with an id a test seeded
    // directly (e.g. `db.users.push({ id: 1, ... })`).
    nextId: {
      seasonEvents: 100000, users: 100000, userEnrollments: 100000,
      onchainAccounts: 100000, challenges: 100000, userActivities: 100000, leaderboardSnapshots: 100000,
    },
  };
}

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function like(str, pattern) {
  if (!pattern) return true;
  const needle = pattern.replace(/^%|%$/g, '').toLowerCase();
  return String(str || '').toLowerCase().includes(needle);
}

// Generic "UPDATE <table> SET col = $2, col2 = $3, ... [, updated_at = NOW()] WHERE id = $1" applier.
function applyDynamicSet(row, setSql, params) {
  const re = /(\w+)\s*=\s*\$(\d+)/g;
  let m;
  while ((m = re.exec(setSql))) {
    const col = m[1];
    const paramIdx = Number(m[2]) - 1;
    let value = params[paramIdx];
    if ((col === 'scoring_formula' || col === 'metadata') && typeof value === 'string') {
      value = JSON.parse(value);
    }
    row[col] = value;
  }
  if (/updated_at\s*=\s*NOW\(\)/.test(setSql)) row.updated_at = new Date();
}

function handleQuery(rawSql, params = []) {
  const sql = collapse(rawSql);
  queryLog.push(sql);

  if (sql === 'BEGIN') { snapshot = JSON.parse(JSON.stringify(db)); return { rows: [] }; }
  if (sql === 'COMMIT') { snapshot = null; return { rows: [] }; }
  if (sql === 'ROLLBACK') { if (snapshot) db = JSON.parse(JSON.stringify(snapshot)); snapshot = null; return { rows: [] }; }

  // ── seasons ────────────────────────────────────────────────────────
  if (sql === 'SELECT id FROM seasons WHERE id = $1') {
    const row = db.seasons.find((s) => s.id === params[0]);
    return { rows: row ? [{ id: row.id }] : [] };
  }

  // ── season_events: existence-only lookups (several call sites share
  // this exact text: account_source check, D3's event-exists checks) ──
  if (sql === 'SELECT id FROM season_events WHERE id = $1') {
    const row = db.seasonEvents.find((e) => e.id === params[0]);
    return { rows: row ? [{ id: row.id }] : [] };
  }
  if (sql === 'SELECT id, season_id FROM season_events WHERE id = $1') {
    const row = db.seasonEvents.find((e) => e.id === params[0]);
    return { rows: row ? [{ id: row.id, season_id: row.season_id }] : [] };
  }
  if (sql === 'SELECT season_id FROM season_events WHERE id = $1') {
    const row = db.seasonEvents.find((e) => e.id === params[0]);
    return { rows: row ? [{ season_id: row.season_id }] : [] };
  }
  if (sql === 'SELECT id, season_id FROM season_events WHERE id = ANY($1)') {
    const ids = params[0];
    const rows = db.seasonEvents.filter((e) => ids.includes(e.id)).map((e) => ({ id: e.id, season_id: e.season_id }));
    return { rows };
  }
  if (sql === 'SELECT id, name, ends_at, scoring_formula FROM season_events WHERE id = $1') {
    const row = db.seasonEvents.find((e) => e.id === params[0]);
    return { rows: row ? [{ id: row.id, name: row.name, ends_at: row.ends_at, scoring_formula: row.scoring_formula }] : [] };
  }
  if (sql.startsWith('SELECT id FROM season_events WHERE season_id = $1 AND type')) {
    const [seasonId, excludeId] = params;
    const row = db.seasonEvents.find((e) => e.season_id === seasonId && e.type === 'season' && e.id !== excludeId);
    return { rows: row ? [{ id: row.id }] : [] };
  }
  if (sql === 'SELECT * FROM season_events WHERE id = $1') {
    const row = db.seasonEvents.find((e) => e.id === params[0]);
    return { rows: row ? [{ ...row }] : [] };
  }

  // ── season_events: index/show (counts) ──────────────────────────────
  if (sql.startsWith('SELECT COUNT(*)::int AS c FROM season_events WHERE')) {
    const pattern = params[0];
    const total = db.seasonEvents.filter((e) => like(e.name, pattern)).length;
    return { rows: [{ c: total }] };
  }
  if (sql.startsWith('SELECT se.*') && sql.includes('FROM season_events se') && sql.includes('ORDER BY se.starts_at DESC')) {
    const [pattern, limit, offset] = params;
    const rows = db.seasonEvents
      .filter((e) => like(e.name, pattern))
      .sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at) || b.id - a.id)
      .slice(offset, offset + limit)
      .map((e) => ({
        ...e,
        users_count: db.userEnrollments.filter((u) => u.season_event_id === e.id).length,
        onchain_accounts_count: db.onchainAccounts.filter((a) => a.season_event_id === e.id).length,
      }));
    return { rows };
  }
  if (sql.startsWith('SELECT se.*') && sql.includes('WHERE se.id = $1')) {
    const row = db.seasonEvents.find((e) => e.id === params[0]);
    if (!row) return { rows: [] };
    return {
      rows: [{
        ...row,
        users_count: db.userEnrollments.filter((u) => u.season_event_id === row.id).length,
        onchain_accounts_count: db.onchainAccounts.filter((a) => a.season_event_id === row.id).length,
        user_activities_count: db.userActivities.filter((a) => a.season_event_id === row.id).length,
      }],
    };
  }

  // ── season_events: insert / update / delete ─────────────────────────
  if (sql.startsWith('INSERT INTO season_events')) {
    const [name, description, startsAt, endsAt, isActive, scoringFormula, startEpoch, endEpoch, internal,
      disclaimer, displayLeaderboard, scoreStartTime, scoreEndTime, displayDisclaimer, chainId,
      rankBasis, displayActivities, seasonId, type, accountInheritanceMode, accountSourceId] = params;
    const row = {
      id: db.nextId.seasonEvents++, name, description, starts_at: startsAt, ends_at: endsAt, is_active: isActive,
      scoring_formula: JSON.parse(scoringFormula), created_at: new Date(), updated_at: new Date(),
      start_epoch: startEpoch, end_epoch: endEpoch, internal, disclaimer, display_leaderboard: displayLeaderboard,
      score_start_time: scoreStartTime, score_end_time: scoreEndTime, display_disclaimer: displayDisclaimer,
      chain_id: chainId, rank_based_on_bp_or_success_rate: rankBasis, display_activities: displayActivities,
      season_id: seasonId, type, account_inheritance_mode: accountInheritanceMode,
      account_source_season_event_id: accountSourceId,
    };
    db.seasonEvents.push(row);
    return { rows: [{ ...row }] };
  }
  if (sql.startsWith('INSERT INTO user_enrollments') && sql.includes('SELECT $1, ue.user_id, $2')) {
    const [newEventId, seasonId] = params;
    const seasonWide = db.userEnrollments.filter((u) => u.season_id === seasonId && u.season_event_id == null);
    for (const u of seasonWide) {
      const exists = db.userEnrollments.some((e) => e.user_id === u.user_id && e.season_event_id === newEventId);
      if (!exists) {
        db.userEnrollments.push({
          id: db.nextId.userEnrollments++, season_event_id: newEventId, user_id: u.user_id, season_id: seasonId,
          registered_at: new Date(), created_at: new Date(), updated_at: new Date(),
        });
      }
    }
    return { rows: [] };
  }
  if (sql.startsWith('UPDATE season_events SET')) {
    const id = params[0];
    const row = db.seasonEvents.find((e) => e.id === id);
    if (row) applyDynamicSet(row, sql, params);
    return { rows: row ? [{ ...row }] : [] };
  }
  if (sql === 'DELETE FROM season_events WHERE id = $1 RETURNING id') {
    const idx = db.seasonEvents.findIndex((e) => e.id === params[0]);
    if (idx === -1) return { rows: [] };
    const [removed] = db.seasonEvents.splice(idx, 1);
    return { rows: [{ id: removed.id }] };
  }

  // ── users ────────────────────────────────────────────────────────────
  if (sql === 'SELECT id, is_admin, admin_readonly FROM users WHERE id = $1') {
    const row = db.users.find((u) => u.id === params[0]);
    return { rows: row ? [{ id: row.id, is_admin: !!row.is_admin, admin_readonly: !!row.admin_readonly }] : [] };
  }
  if (sql === 'SELECT COUNT(*)::int AS n FROM users WHERE is_admin = TRUE AND admin_readonly = FALSE') {
    const n = db.users.filter((u) => u.is_admin && !u.admin_readonly).length;
    return { rows: [{ n }] };
  }
  if (sql === 'SELECT id FROM users WHERE email = $1') {
    const row = db.users.find((u) => u.email === params[0]);
    return { rows: row ? [{ id: row.id }] : [] };
  }
  if (sql === 'SELECT id FROM users WHERE email = $1 AND id != $2') {
    const row = db.users.find((u) => u.email === params[0] && u.id !== params[1]);
    return { rows: row ? [{ id: row.id }] : [] };
  }
  if (sql === 'SELECT id FROM users WHERE email = $1 OR discord = $2 LIMIT 1') {
    const row = db.users.find((u) => u.email === params[0] || u.discord === params[1]);
    return { rows: row ? [{ id: row.id }] : [] };
  }
  if (sql === 'SELECT id FROM users WHERE id = $1') {
    const row = db.users.find((u) => u.id === params[0]);
    return { rows: row ? [{ id: row.id }] : [] };
  }
  if (sql.startsWith('SELECT') && sql.includes('FROM users WHERE id = $1') && !sql.includes('id != $2')) {
    const row = db.users.find((u) => u.id === params[0]);
    return { rows: row ? [{ ...row }] : [] };
  }
  if (sql.startsWith('SELECT id FROM user_enrollments WHERE user_id = $1')) {
    const [userId, seasonEventId, seasonId] = params;
    const row = db.userEnrollments.find((e) => e.user_id === userId
      && (e.season_event_id === seasonEventId || (e.season_event_id == null && e.season_id === seasonId)));
    return { rows: row ? [{ id: row.id }] : [] };
  }
  if (sql.startsWith('DELETE FROM user_enrollments WHERE user_id = $1 AND season_event_id IS NOT NULL')) {
    const [userId, keepIds] = params;
    db.userEnrollments = db.userEnrollments.filter((e) => !(e.user_id === userId && e.season_event_id != null && !keepIds.includes(e.season_event_id)));
    return { rows: [] };
  }
  if (sql.startsWith('INSERT INTO user_enrollments') && sql.includes('ON CONFLICT DO NOTHING') && sql.includes('VALUES ($1, $2, $3')) {
    const [seasonEventId, userId, seasonId] = params;
    const exists = db.userEnrollments.some((e) => e.user_id === userId && e.season_event_id === seasonEventId);
    if (!exists) {
      db.userEnrollments.push({
        id: db.nextId.userEnrollments++, season_event_id: seasonEventId, user_id: userId, season_id: seasonId,
        registered_at: new Date(), created_at: new Date(), updated_at: new Date(),
      });
    }
    return { rows: [] };
  }
  if (sql.startsWith('INSERT INTO user_enrollments') && !sql.includes('ON CONFLICT')) {
    const [seasonEventId, userId, seasonId] = params;
    db.userEnrollments.push({
      id: db.nextId.userEnrollments++, season_event_id: seasonEventId, user_id: userId, season_id: seasonId,
      registered_at: new Date(), created_at: new Date(), updated_at: new Date(),
    });
    return { rows: [] };
  }
  if (sql.startsWith('SELECT ue.user_id, se.id AS event_id')) {
    const ids = params[0];
    const rows = db.userEnrollments
      .filter((e) => ids.includes(e.user_id) && e.season_event_id != null)
      .map((e) => {
        const ev = db.seasonEvents.find((s) => s.id === e.season_event_id);
        return { user_id: e.user_id, event_id: e.season_event_id, event_name: ev ? ev.name : null, registered_at: e.registered_at };
      });
    return { rows };
  }
  if (sql.startsWith('SELECT id, user_id, season_event_id, registration_code')) {
    const ids = params[0];
    const rows = db.onchainAccounts.filter((a) => ids.includes(a.user_id)).map((a) => ({ ...a }));
    return { rows };
  }
  if (sql.startsWith('SELECT COUNT(DISTINCT u.id)::int AS c FROM users u')) {
    const rows = filterUsersIndex(sql, params);
    return { rows: [{ c: rows.length }] };
  }
  if (sql.startsWith('SELECT DISTINCT') && sql.includes('FROM users u')) {
    const rows = filterUsersIndex(sql, params, true);
    return { rows };
  }
  if (sql.startsWith('INSERT INTO users (username, password, password_set, email, telegram, discord, display_name, accept_logs, is_admin')) {
    const [username, password, email, telegram, discord, displayName, acceptLogs] = params;
    const row = {
      id: db.nextId.users++, username, password, password_set: false, email, telegram, discord, display_name: displayName,
      exclude_podium: false, accept_logs: acceptLogs, github: null, x: null, country: null, city: null,
      referrer: null, referrer_handle: null, is_in_waitlist: false, created_at: new Date(), updated_at: new Date(),
    };
    db.users.push(row);
    return { rows: [{ ...row }] };
  }
  if (sql.startsWith('INSERT INTO users (username, password, password_set, email, discord, is_admin')) {
    const [username, password, email, discord] = params;
    const row = {
      id: db.nextId.users++, username, password, password_set: false, email, telegram: null, discord, display_name: null,
      exclude_podium: false, accept_logs: true, created_at: new Date(), updated_at: new Date(),
    };
    db.users.push(row);
    return { rows: [{ id: row.id }] };
  }
  if (sql.startsWith('UPDATE users SET exclude_podium = NOT exclude_podium')) {
    const row = db.users.find((u) => u.id === params[0]);
    if (row) { row.exclude_podium = !row.exclude_podium; row.updated_at = new Date(); }
    return { rows: row ? [{ ...row }] : [] };
  }
  if (sql.startsWith('UPDATE users SET')) {
    const id = params[0];
    const row = db.users.find((u) => u.id === id);
    if (row) applyDynamicSet(row, sql, params);
    return { rows: row ? [{ ...row }] : [] };
  }
  if (sql === 'DELETE FROM users WHERE id = $1 RETURNING id' || sql === 'DELETE FROM users WHERE id = $1') {
    const idx = db.users.findIndex((u) => u.id === params[0]);
    if (idx === -1) return { rows: [] };
    const [removed] = db.users.splice(idx, 1);
    return { rows: [{ id: removed.id }] };
  }
  if (sql.startsWith('SELECT id, amount FROM onchain_accounts WHERE season_event_id = $1 AND is_used = FALSE')) {
    const seasonEventId = params[0];
    let rows = db.onchainAccounts.filter((a) => a.season_event_id === seasonEventId && !a.is_used);
    let pi = 1;
    if (sql.includes('amount >=')) { rows = rows.filter((a) => a.amount >= params[pi]); pi += 1; }
    if (sql.includes('amount <=')) { rows = rows.filter((a) => a.amount <= params[pi]); pi += 1; }
    rows = rows.slice().sort((a, b) => b.amount - a.amount || a.id - b.id);
    return { rows: rows.map((a) => ({ id: a.id, amount: a.amount })) };
  }
  if (sql.startsWith('UPDATE onchain_accounts SET user_id = $1, is_used = TRUE')) {
    const [userId, accountId] = params;
    const row = db.onchainAccounts.find((a) => a.id === accountId);
    if (row) { row.user_id = userId; row.is_used = true; row.used_at = new Date(); }
    return { rows: [] };
  }
  // export-csv: enrolled users (event-scoped or season-wide) joined to
  // their best-matching onchain account's registration_code.
  if (sql.startsWith('WITH enrolled AS')) {
    const [seasonEventId, seasonId] = params;
    const enrolledIds = [...new Set(db.userEnrollments
      .filter((e) => e.season_event_id === seasonEventId || (e.season_event_id == null && e.season_id === seasonId))
      .map((e) => e.user_id))];
    const rows = enrolledIds
      .map((uid) => db.users.find((u) => u.id === uid))
      .filter(Boolean)
      .sort((a, b) => a.id - b.id)
      .map((u) => {
        const accts = db.onchainAccounts
          .filter((a) => a.user_id === u.id
            && (a.season_event_id === seasonEventId || (a.season_event_id == null && a.season_id === seasonId)))
          .sort((a, b) => ((a.season_event_id == null) - (b.season_event_id == null)) || (b.id - a.id));
        return {
          email: u.email ?? null,
          username: u.discord ?? null,
          registration_code: accts.length ? accts[0].registration_code : null,
        };
      });
    return { rows };
  }

  // ── challenge_templates / challenges ──────────────────────────────────
  if (sql === 'SELECT DISTINCT category FROM challenge_templates') {
    return { rows: db.challengeTemplates.map((t) => ({ category: t.category })) };
  }
  if (sql.startsWith('SELECT c.id, c.season_event_id, ct.category FROM challenges c')) {
    const row = db.challenges.find((c) => c.id === params[0]);
    if (!row) return { rows: [] };
    const template = db.challengeTemplates.find((t) => t.id === row.challenge_template_id);
    return { rows: [{ id: row.id, season_event_id: row.season_event_id, category: template ? template.category : null }] };
  }

  // ── user_activities ────────────────────────────────────────────────
  if (sql === 'SELECT * FROM user_activities WHERE id = $1') {
    const row = db.userActivities.find((a) => a.id === params[0]);
    return { rows: row ? [{ ...row }] : [] };
  }
  if (sql.startsWith('SELECT COUNT(*)::int AS c FROM user_activities ua')) {
    const rows = filterActivitiesIndex(sql, params);
    return { rows: [{ c: rows.length }] };
  }
  if (sql.startsWith('SELECT ua.*') && sql.includes('WHERE ua.id = $1')) {
    const row = db.userActivities.find((a) => a.id === params[0]);
    if (!row) return { rows: [] };
    return { rows: [activityJoinedRow(row)] };
  }
  if (sql.startsWith('SELECT ua.*') && sql.includes('ORDER BY ua.activity_at DESC')) {
    const rows = filterActivitiesIndex(sql, params, true);
    return { rows: rows.map(activityJoinedRow) };
  }
  // refresh-totals' own per-(user,type) sum — no COUNT(*), distinct from
  // the /totals endpoint's richer version matched just below.
  if (sql.startsWith('SELECT user_id, activity_type, COALESCE(SUM(points), 0) AS total_points FROM user_activities')) {
    const seasonEventId = params[0];
    const scoped = db.userActivities.filter((a) => a.season_event_id === seasonEventId);
    const groups = new Map();
    for (const a of scoped) {
      const key = `${a.user_id}::${a.activity_type}`;
      if (!groups.has(key)) groups.set(key, { user_id: a.user_id, activity_type: a.activity_type, total_points: 0 });
      groups.get(key).total_points += Number(a.points);
    }
    return { rows: [...groups.values()] };
  }
  if (sql.startsWith('SELECT user_id, activity_type, COUNT(*)::int AS count, COALESCE(SUM(points), 0) AS total_points FROM user_activities')) {
    const seasonEventId = sql.includes('WHERE season_event_id = $1') ? params[0] : null;
    const scoped = db.userActivities.filter((a) => !seasonEventId || a.season_event_id === seasonEventId);
    const groups = new Map();
    for (const a of scoped) {
      const key = `${a.user_id}::${a.activity_type}`;
      if (!groups.has(key)) groups.set(key, { user_id: a.user_id, activity_type: a.activity_type, count: 0, total_points: 0 });
      const g = groups.get(key);
      g.count += 1; g.total_points += Number(a.points);
    }
    return { rows: [...groups.values()] };
  }
  if (sql.startsWith('SELECT activity_type, COUNT(*)::int AS count')) {
    const seasonEventId = sql.includes('WHERE season_event_id = $1') ? params[0] : null;
    const scoped = db.userActivities.filter((a) => !seasonEventId || a.season_event_id === seasonEventId);
    const groups = new Map();
    for (const a of scoped) {
      if (!groups.has(a.activity_type)) groups.set(a.activity_type, { activity_type: a.activity_type, count: 0, total_points: 0, users: new Set() });
      const g = groups.get(a.activity_type);
      g.count += 1; g.total_points += Number(a.points); g.users.add(a.user_id);
    }
    return { rows: [...groups.values()].map((g) => ({ activity_type: g.activity_type, count: g.count, total_points: g.total_points, unique_users: g.users.size })) };
  }
  if (sql.startsWith('SELECT COALESCE(SUM(points), 0) AS total_points, COUNT(*)::int AS total_activities')) {
    const seasonEventId = sql.includes('WHERE season_event_id = $1') ? params[0] : null;
    const scoped = db.userActivities.filter((a) => !seasonEventId || a.season_event_id === seasonEventId);
    const totalPoints = scoped.reduce((acc, a) => acc + Number(a.points), 0);
    const uniqueUsers = new Set(scoped.map((a) => a.user_id)).size;
    return { rows: [{ total_points: totalPoints, total_activities: scoped.length, unique_users: uniqueUsers }] };
  }
  if (sql === 'SELECT id, email, telegram, discord, display_name FROM users WHERE id = ANY($1)') {
    const ids = params[0];
    return { rows: db.users.filter((u) => ids.includes(u.id)).map((u) => ({ id: u.id, email: u.email, telegram: u.telegram, discord: u.discord, display_name: u.display_name })) };
  }
  if (sql.startsWith('INSERT INTO user_activities') && sql.includes('metadata')) {
    const [userId, seasonEventId, activityType, points, description, metadata, activityAt, addedBy, challengeId] = params;
    const row = {
      id: db.nextId.userActivities++, user_id: userId, season_event_id: seasonEventId, activity_type: activityType,
      points, description, metadata: metadata ? JSON.parse(metadata) : null, activity_at: activityAt, added_by: addedBy,
      source: 'admin_ui', challenge_id: challengeId, created_at: new Date(), updated_at: new Date(),
    };
    db.userActivities.push(row);
    return { rows: [{ id: row.id }] };
  }
  if (sql.startsWith('INSERT INTO user_activities') && !sql.includes('metadata')) {
    const [userId, seasonEventId, activityType, points, description, activityAt, addedBy, challengeId] = params;
    const row = {
      id: db.nextId.userActivities++, user_id: userId, season_event_id: seasonEventId, activity_type: activityType,
      points, description, metadata: null, activity_at: activityAt, added_by: addedBy,
      source: 'admin_ui', challenge_id: challengeId, created_at: new Date(), updated_at: new Date(),
    };
    db.userActivities.push(row);
    return { rows: [{ id: row.id }] };
  }
  if (sql.startsWith('UPDATE user_activities SET')) {
    const id = params[0];
    const row = db.userActivities.find((a) => a.id === id);
    if (row) applyDynamicSet(row, sql, params);
    return { rows: row ? [{ ...row }] : [] };
  }
  if (sql === 'DELETE FROM user_activities WHERE id = $1 RETURNING id') {
    const idx = db.userActivities.findIndex((a) => a.id === params[0]);
    if (idx === -1) return { rows: [] };
    const [removed] = db.userActivities.splice(idx, 1);
    return { rows: [{ id: removed.id }] };
  }
  if (sql.startsWith('UPDATE leaderboard_snapshots ls')) {
    const [seasonEventId, userId, extraPoints, bugReportPoints, invitingPoints, communityPoints, firstBlockPoints, top3Points, success50Points] = params;
    const candidates = db.leaderboardSnapshots
      .filter((s) => s.season_event_id === seasonEventId && s.user_id === userId)
      .sort((a, b) => new Date(b.snapshot_at) - new Date(a.snapshot_at) || b.id - a.id);
    const latest = candidates[0];
    if (!latest) return { rows: [], rowCount: 0 };
    latest.extra_points = extraPoints;
    latest.bug_report_points = bugReportPoints;
    latest.inviting_new_participant_points = invitingPoints;
    latest.community_contribution_points = communityPoints;
    latest.first_block_points = firstBlockPoints;
    latest.top_3_points = top3Points;
    latest.success_50_percent_points = success50Points;
    latest.updated_at = new Date();
    return { rows: [{ ...latest }], rowCount: 1 };
  }

  throw new Error(`unexpected SQL in mock: ${sql.slice(0, 120)}`);
}

// users index: dynamic JOIN (season_event_id filter) + WHERE (search) —
// detected by substring rather than exact text (the route builds this
// SQL by string-concatenating optional clauses).
function filterUsersIndex(sql, params) {
  let idx = 0;
  let seasonEventId = null;
  let eventSeasonId = null;
  if (sql.includes('JOIN user_enrollments ue_filter')) {
    seasonEventId = params[idx]; idx += 1;
    eventSeasonId = params[idx]; idx += 1;
  }
  let searchPattern = null;
  if (sql.includes('ILIKE')) { searchPattern = params[idx]; idx += 1; }

  let rows = db.users.slice();
  if (seasonEventId != null) {
    rows = rows.filter((u) => db.userEnrollments.some((e) => e.user_id === u.id
      && (e.season_event_id === seasonEventId || (e.season_event_id == null && e.season_id === eventSeasonId))));
  }
  if (searchPattern) {
    rows = rows.filter((u) => like(u.email, searchPattern) || like(u.telegram, searchPattern)
      || like(u.discord, searchPattern) || like(u.display_name, searchPattern));
  }
  rows = rows.slice().sort((a, b) => b.id - a.id);
  if (sql.includes('LIMIT')) {
    const limit = params[idx];
    const offset = params[idx + 1];
    rows = rows.slice(offset, offset + limit);
  }
  return rows.map((u) => ({ ...u }));
}

// user-activities index: same "detect which optional clauses are present,
// then consume params in the route's own push order" trick.
function filterActivitiesIndex(sql, params) {
  let idx = 0;
  let seasonEventId = null;
  let userId = null;
  let activityType = null;
  if (sql.includes('ua.season_event_id = $')) { seasonEventId = params[idx]; idx += 1; }
  if (sql.includes('ua.user_id = $')) { userId = params[idx]; idx += 1; }
  if (sql.includes('ua.activity_type = $')) { activityType = params[idx]; idx += 1; }

  let rows = db.userActivities.filter((a) => (!seasonEventId || a.season_event_id === seasonEventId)
    && (!userId || a.user_id === userId)
    && (!activityType || a.activity_type === activityType));
  rows = rows.slice().sort((a, b) => new Date(b.activity_at) - new Date(a.activity_at) || b.id - a.id);
  if (sql.includes('LIMIT')) {
    const limit = params[idx];
    const offset = params[idx + 1];
    rows = rows.slice(offset, offset + limit);
  }
  return rows;
}

function activityJoinedRow(a) {
  const user = db.users.find((u) => u.id === a.user_id) || {};
  const event = db.seasonEvents.find((e) => e.id === a.season_event_id) || {};
  const addedBy = a.added_by != null ? db.users.find((u) => u.id === a.added_by) : null;
  const challenge = a.challenge_id != null ? db.challenges.find((c) => c.id === a.challenge_id) : null;
  const template = challenge ? db.challengeTemplates.find((t) => t.id === challenge.challenge_template_id) : null;
  return {
    ...a,
    u_email: user.email, u_telegram: user.telegram, u_discord: user.discord, u_display_name: user.display_name,
    event_name: event.name,
    added_by_username: addedBy ? addedBy.username : null,
    c_id: challenge ? challenge.id : null, c_category: template ? template.category : null,
    c_goal: challenge ? challenge.goal : null, c_task: challenge ? challenge.task : null,
  };
}

function makeMockPool() {
  return {
    async query(sql, params) { return handleQuery(sql, params); },
    async connect() {
      return { async query(sql, params) { return handleQuery(sql, params); }, release() {} };
    },
  };
}

// ─── App builders ─────────────────────────────────────────────────────

function userMiddleware(role) {
  return (req, _res, next) => {
    if (role === 'anon') { next(); return; }
    if (role === 'user') { req.user = { id: 900, username: 'plain', isAdmin: false, canAdminWrite: false }; next(); return; }
    if (role === 'readonly') { req.user = { id: 901, username: 'ro-admin', isAdmin: true, canAdminWrite: false }; next(); return; }
    req.user = { id: 902, username: 'full-admin', isAdmin: true, canAdminWrite: true };
    next();
  };
}

function buildFullApp(role) {
  const app = express();
  app.use(express.json());
  app.use(userMiddleware(role));
  app.use(topochainAdminRoutes({}));
  return app;
}

function buildSubApp(factory, role = 'admin') {
  const app = express();
  app.use(express.json());
  app.use(userMiddleware(role));
  app.use(factory({}));
  return app;
}

async function listen(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test.beforeEach(() => {
  db = freshDb();
  snapshot = null;
  queryLog = [];
  currentMockPool = makeMockPool();
});

// ─── 1. Auth gates ──────────────────────────────────────────────────────

test('admin auth: anon caller gets the SPEC-shaped 403 (real pipeline 401s earlier at authMiddleware; this router alone treats a missing req.user like any other non-admin)', async () => {
  const { server, base } = await listen(buildFullApp('anon'));
  try {
    const res = await fetch(`${base}/api/v4/admin/season-events`);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { success: false, error: 'Unauthorized. Admin access required.' });
  } finally { server.close(); }
});

test('admin auth: non-admin caller gets the SPEC-shaped 403 (SPEC 2193), not the platform middleware\'s own body', async () => {
  const { server, base } = await listen(buildFullApp('user'));
  try {
    const res = await fetch(`${base}/api/v4/admin/season-events`);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { success: false, error: 'Unauthorized. Admin access required.' });
  } finally { server.close(); }
});

test('admin auth: view-only admin can read but a mutation 403s with the v4-enveloped write-gate body', async () => {
  const { server, base } = await listen(buildFullApp('readonly'));
  try {
    const readRes = await fetch(`${base}/api/v4/admin/season-events`);
    assert.equal(readRes.status, 200);
    assert.equal((await readRes.json()).success, true);

    const writeRes = await fetch(`${base}/api/v4/admin/season-events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(writeRes.status, 403);
    assert.deepEqual(await writeRes.json(), { success: false, error: 'Full admin access required.' });
  } finally { server.close(); }
});

test('admin auth: full admin passes both gates (reaches route logic, not the auth gate, on a write)', async () => {
  const { server, base } = await listen(buildFullApp('admin'));
  try {
    const readRes = await fetch(`${base}/api/v4/admin/season-events`);
    assert.equal(readRes.status, 200);

    // Empty body -> 422 validation, proving the request reached the
    // route handler (not the 403 write gate).
    const writeRes = await fetch(`${base}/api/v4/admin/season-events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(writeRes.status, 422);
  } finally { server.close(); }
});

test('admin auth: the gate is scoped to /api/v4/admin/* only — a non-admin (or anonymous) request to ANY other path falls through untouched (mount-scope regression)', async () => {
  // Reproduces the exact server.js shape: topochainAdminRoutes is mounted
  // UNSCOPED (no path — server.js:481), ahead of other app.use()/app.get()
  // layers (express.static, /admin, /dashboard, the SPA catch-all). Before
  // this fix, `router.use(adminReadGate)` ran for literally every request
  // that reached this router — not just /api/v4/admin/* ones — so a
  // logged-in non-admin hitting ANY of those later routes got 302'd to
  // "/" instead of reaching them, and "/" itself isn't an /api/ path
  // either, making it an actual infinite redirect loop for every non-admin
  // user trying to use anything past this mount point.
  for (const role of ['anon', 'user', 'readonly']) {
    const app = buildFullApp(role);
    app.get('/dashboard', (_req, res) => res.status(200).send('DASHBOARD'));
    app.get('/', (_req, res) => res.status(200).send('ROOT'));
    const { server, base } = await listen(app);
    try {
      const dash = await fetch(`${base}/dashboard`, { redirect: 'manual' });
      assert.equal(dash.status, 200, `role=${role}: /dashboard must reach its own handler, not the admin gate`);
      assert.equal(await dash.text(), 'DASHBOARD');

      const root = await fetch(`${base}/`, { redirect: 'manual' });
      assert.equal(root.status, 200, `role=${role}: / must reach its own handler, not redirect back into the same gate`);

      // The gate must still apply to its own prefix regardless — a
      // readonly admin CAN read (only writes are gated further), so its
      // expected status differs from anon/user's.
      const adminPath = await fetch(`${base}/api/v4/admin/season-events`);
      const expected = role === 'readonly' ? 200 : 403;
      assert.equal(adminPath.status, expected, `role=${role}: /api/v4/admin/* gating must be unaffected by the mount-scope fix`);
    } finally { server.close(); }
  }
});

test('admin auth: case-variant /api/v4/ADMIN/* paths are still gated for a non-admin (Express matches routes case-insensitively, so the prefix guard must too)', async () => {
  // Regression for the security-review finding: Express 4 route matching
  // is case-INSENSITIVE by default, so `GET /api/v4/ADMIN/users` executes
  // the exact same handlers as `/api/v4/admin/users` — but req.path keeps
  // the caller's casing, and the old case-SENSITIVE startsWith guard
  // skipped adminReadGate entirely for any case-variant spelling. These
  // requests returned 200 (full user list, emails and all) to a plain
  // logged-in non-admin before the fix.
  db.users.push({ id: 30, email: 'someone@example.com' });
  const { server, base } = await listen(buildFullApp('user'));
  try {
    const upper = await fetch(`${base}/api/v4/ADMIN/users`);
    assert.equal(upper.status, 403);
    assert.deepEqual(await upper.json(), { success: false, error: 'Unauthorized. Admin access required.' });

    const mixed = await fetch(`${base}/api/v4/Admin/__ping`);
    assert.equal(mixed.status, 403);
    assert.deepEqual(await mixed.json(), { success: false, error: 'Unauthorized. Admin access required.' });
  } finally { server.close(); }

  // Sanity companion: a real admin through the same case-variant path
  // still reaches the route (the fix widens the GATE's scope to match
  // Express's routing scope; it must not break case-variant access for
  // callers the gate admits).
  const { server: adminServer, base: adminBase } = await listen(buildFullApp('admin'));
  try {
    const ping = await fetch(`${adminBase}/api/v4/Admin/__ping`);
    assert.equal(ping.status, 200);
  } finally { adminServer.close(); }
});

// ─── 2. Route-shadowing regression (D3) ─────────────────────────────────

test('user-activities: GET /totals reaches the totals handler, not the :id show handler (route-shadowing fix)', async () => {
  const { server, base } = await listen(buildSubApp(userActivitiesAdminRoutes));
  try {
    const res = await fetch(`${base}/api/v4/admin/user-activities/totals`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok('user_totals' in body.data && 'type_totals' in body.data && 'grand_total' in body.data,
      'expected the totals shape, not a 404/mismatched show response');
  } finally { server.close(); }
});

test('user-activities: GET /import (as a GET) does not accidentally match :id either — sanity companion to the shadowing test', async () => {
  // POST /import is registered ahead of /:id; a stray GET to the same
  // path has no GET handler on /import, so Express falls through to :id
  // with id="import" — toIntId rejects that, so this should 404, not 200.
  const { server, base } = await listen(buildSubApp(userActivitiesAdminRoutes));
  try {
    const res = await fetch(`${base}/api/v4/admin/user-activities/import`);
    assert.equal(res.status, 404);
  } finally { server.close(); }
});

// ─── 3. D1 season-events ─────────────────────────────────────────────────

test('season-events: POST creates, auto-enrolls season-wide users, and the persisted starts_at fix validates a body with ends_at only', async () => {
  db.seasons.push({ id: 5, name: 'Season Alpha' });
  db.users.push({ id: 1, email: 'a@x.com' }, { id: 2, email: 'b@x.com' });
  db.userEnrollments.push(
    { id: 1, user_id: 1, season_event_id: null, season_id: 5, registered_at: T(-1) },
    { id: 2, user_id: 2, season_event_id: null, season_id: 5, registered_at: T(-1) }
  );

  const { server, base } = await listen(buildSubApp(seasonEventsAdminRoutes));
  try {
    const createRes = await fetch(`${base}/api/v4/admin/season-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Event One', starts_at: T(0), ends_at: T(10),
        scoring_formula: { metrics: ['a'], offchain_weight: 1 },
        rank_based_on_bp_or_success_rate: 'BP', season_id: 5,
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()).data;
    assert.equal(created.name, 'Event One');
    assert.equal(created.season_id, 5);

    // Auto-enrollment: both season-wide users now have an event-scoped row.
    assert.equal(db.userEnrollments.filter((e) => e.season_event_id === created.id).length, 2);

    // THE FIX: PATCH sending ends_at ALONE must validate against the
    // PERSISTED starts_at (T(0)), not silently pass. ends_at before T(0)
    // must 422; ends_at after T(0) must succeed.
    const badPatch = await fetch(`${base}/api/v4/admin/season-events/${created.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ends_at: T(-5) }),
    });
    assert.equal(badPatch.status, 422);
    assert.ok((await badPatch.json()).details.ends_at);

    const goodPatch = await fetch(`${base}/api/v4/admin/season-events/${created.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ends_at: T(30) }),
    });
    assert.equal(goodPatch.status, 200);
    assert.equal(iso((await goodPatch.json()).data.ends_at), iso(T(30)));

    // No re-run of auto-enrollment on update.
    assert.equal(db.userEnrollments.filter((e) => e.season_event_id === created.id).length, 2);
  } finally { server.close(); }
});

test('season-events: one type=season event per season is enforced on both create and update', async () => {
  db.seasonEvents.push({
    id: 1, name: 'Season Wrap', starts_at: T(0), ends_at: T(10), season_id: 5, type: 'season',
    scoring_formula: { metrics: [], offchain_weight: 0 }, rank_based_on_bp_or_success_rate: 'BP',
  });
  db.seasonEvents.push({
    id: 2, name: 'Regular Event', starts_at: T(0), ends_at: T(10), season_id: 5, type: 'regular',
    scoring_formula: { metrics: [], offchain_weight: 0 }, rank_based_on_bp_or_success_rate: 'BP',
  });

  const { server, base } = await listen(buildSubApp(seasonEventsAdminRoutes));
  try {
    const createRes = await fetch(`${base}/api/v4/admin/season-events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Second Season Event', starts_at: T(0), ends_at: T(10),
        scoring_formula: { metrics: ['a'], offchain_weight: 1 },
        rank_based_on_bp_or_success_rate: 'BP', season_id: 5, type: 'season',
      }),
    });
    assert.equal(createRes.status, 422);
    assert.ok((await createRes.json()).details.type);

    const updateRes = await fetch(`${base}/api/v4/admin/season-events/2`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'season' }),
    });
    assert.equal(updateRes.status, 422);
    assert.ok((await updateRes.json()).details.type);
  } finally { server.close(); }
});

test('season-events: GET index/show and DELETE work end to end', async () => {
  db.seasonEvents.push({
    id: 7, name: 'Findable Event', starts_at: T(0), ends_at: T(10), season_id: null, type: 'regular',
    scoring_formula: { metrics: [], offchain_weight: 0 }, rank_based_on_bp_or_success_rate: 'BP',
  });

  const { server, base } = await listen(buildSubApp(seasonEventsAdminRoutes));
  try {
    const indexRes = await fetch(`${base}/api/v4/admin/season-events?search=Findable`);
    const indexBody = await indexRes.json();
    assert.equal(indexBody.data.length, 1);
    assert.equal(indexBody.meta.total, 1);

    const showRes = await fetch(`${base}/api/v4/admin/season-events/7`);
    const showBody = await showRes.json();
    assert.equal(showBody.data.user_activities_count, 0);

    const delRes = await fetch(`${base}/api/v4/admin/season-events/7`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);
    assert.equal((await delRes.json()).message, 'Event deleted successfully.');

    const goneRes = await fetch(`${base}/api/v4/admin/season-events/7`);
    assert.equal(goneRes.status, 404);
  } finally { server.close(); }
});

// ─── 4. D2 users ─────────────────────────────────────────────────────────

test('users: create enforces at-least-one-identifier and unique email; update can clear identifiers but not down to zero', async () => {
  const { server, base } = await listen(buildSubApp(usersAdminRoutes));
  try {
    const noIdentifier = await fetch(`${base}/api/v4/admin/users`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(noIdentifier.status, 422);
    assert.equal((await noIdentifier.json()).error, 'At least one identifier (email, telegram, or discord) is required.');

    const createRes = await fetch(`${base}/api/v4/admin/users`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dup@example.com', telegram: 'tg1' }),
    });
    assert.equal(createRes.status, 201);
    const user = (await createRes.json()).data;

    const dupRes = await fetch(`${base}/api/v4/admin/users`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dup@example.com' }),
    });
    assert.equal(dupRes.status, 422);
    assert.equal((await dupRes.json()).error, 'The email has already been taken.');

    // Clear email explicitly (telegram remains) -> allowed.
    const clearRes = await fetch(`${base}/api/v4/admin/users/${user.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: null }),
    });
    assert.equal(clearRes.status, 200);
    assert.equal((await clearRes.json()).data.email, null);

    // Now clearing telegram too (email already null) -> the v4 fix:
    // at-least-one-identifier is enforced on update, unlike the source.
    const overClearRes = await fetch(`${base}/api/v4/admin/users/${user.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegram: null }),
    });
    assert.equal(overClearRes.status, 422);
    assert.equal((await overClearRes.json()).error, 'At least one identifier (email, telegram, or discord) is required.');
  } finally { server.close(); }
});

test('users: DELETE guards against self-deletion and against deleting the last full admin (code-review finding)', async () => {
  // buildSubApp's default 'admin' role injects req.user = { id: 902, ... }.
  db.users.push({ id: 902, username: 'full-admin', is_admin: true, admin_readonly: false });
  db.users.push({ id: 10, username: 'other-full-admin', is_admin: true, admin_readonly: false });
  db.users.push({ id: 11, username: 'plain-topochain-user', is_admin: false, admin_readonly: false, email: 'plain@example.com' });

  const { server, base } = await listen(buildSubApp(usersAdminRoutes));
  try {
    const selfDelete = await fetch(`${base}/api/v4/admin/users/902`, { method: 'DELETE' });
    assert.equal(selfDelete.status, 400);
    assert.equal((await selfDelete.json()).error, 'Cannot delete yourself.');
    assert.ok(db.users.some((u) => u.id === 902), 'the caller must survive');

    // Only two full admins exist (902 and 10); deleting 10 as a DIFFERENT
    // caller would be fine, but the caller here IS 902, so the OTHER full
    // admin (10) can still be deleted without threatening the invariant
    // (two admins remain none... wait: deleting 10 leaves only 902, which
    // is still >= 1, so this succeeds) — then deleting 902 (now the last)
    // via a different route context is what MUST be blocked.
    const deleteOther = await fetch(`${base}/api/v4/admin/users/10`, { method: 'DELETE' });
    assert.equal(deleteOther.status, 200);
    assert.ok(!db.users.some((u) => u.id === 10));

    // A non-admin user has no bearing on the admin-count invariant at all.
    const deletePlain = await fetch(`${base}/api/v4/admin/users/11`, { method: 'DELETE' });
    assert.equal(deletePlain.status, 200);
    assert.ok(!db.users.some((u) => u.id === 11));
  } finally { server.close(); }
});

test('users: DELETE blocks removing the last full admin even when the caller is someone else', async () => {
  db.users.push({ id: 902, username: 'full-admin', is_admin: true, admin_readonly: false });
  db.users.push({ id: 20, username: 'lone-full-admin', is_admin: true, admin_readonly: false });
  // Make 902 (the caller) a VIEW-ONLY admin so it doesn't count toward
  // the invariant, isolating the "last FULL admin" check from the
  // separate self-delete guard (different id, so that guard can't fire).
  db.users[0].admin_readonly = true;
  // Force the full-admin count down to exactly one (id 20) by removing
  // any other full admin the fixture might otherwise imply.
  db.users = db.users.filter((u) => u.id === 902 || u.id === 20);

  const { server, base } = await listen(buildSubApp(usersAdminRoutes));
  try {
    const res = await fetch(`${base}/api/v4/admin/users/20`, { method: 'DELETE' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "Can't delete the last full admin.");
    assert.ok(db.users.some((u) => u.id === 20));
  } finally { server.close(); }
});

test('users: enrollment (create, update, import-csv) rejects a season_event_id whose event has no season_id (NOT NULL guard)', async () => {
  db.seasonEvents.push({ id: 60, name: 'Seasonless Event', season_id: null, starts_at: T(0), ends_at: T(10) });

  const { server, base } = await listen(buildSubApp(usersAdminRoutes));
  try {
    const createRes = await fetch(`${base}/api/v4/admin/users`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'seasonless@example.com', season_event_ids: [60] }),
    });
    assert.equal(createRes.status, 422);
    assert.ok((await createRes.json()).details.season_event_ids);

    db.users.push({ id: 70, email: 'existing-seasonless@example.com' });
    const updateRes = await fetch(`${base}/api/v4/admin/users/70`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ season_event_ids: [60] }),
    });
    assert.equal(updateRes.status, 422);
    assert.ok((await updateRes.json()).details.season_event_ids);

    const importRes = await fetch(`${base}/api/v4/admin/users/import-csv`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        season_event_id: 60,
        participants: [{ email: 'someone@example.com', username: 'someone#0001' }],
      }),
    });
    assert.equal(importRes.status, 422);
    assert.ok((await importRes.json()).details.season_event_id);
  } finally { server.close(); }
});

test('users: toggle-exclude-podium message is derived from the REFRESHED state in both directions', async () => {
  db.users.push({ id: 42, email: 'toggle@example.com', exclude_podium: false });

  const { server, base } = await listen(buildSubApp(usersAdminRoutes));
  try {
    const firstToggle = await fetch(`${base}/api/v4/admin/users/42/toggle-exclude-podium`, { method: 'PATCH' });
    const firstBody = await firstToggle.json();
    assert.equal(firstBody.data.exclude_podium, true);
    assert.equal(firstBody.message, 'User marked as internal tester.');

    const secondToggle = await fetch(`${base}/api/v4/admin/users/42/toggle-exclude-podium`, { method: 'PATCH' });
    const secondBody = await secondToggle.json();
    assert.equal(secondBody.data.exclude_podium, false);
    assert.equal(secondBody.message, 'User unmarked as internal tester.');
  } finally { server.close(); }
});

test('users: index returns ONE consistent row shape with or without season_event_id (the v4 fix)', async () => {
  db.seasonEvents.push({ id: 3, name: 'Filter Event', season_id: 5, starts_at: T(0), ends_at: T(10) });
  db.users.push({ id: 1, email: 'in@x.com' }, { id: 2, email: 'out@x.com' });
  db.userEnrollments.push({ id: 1, user_id: 1, season_event_id: 3, season_id: 5, registered_at: T(-1) });

  const { server, base } = await listen(buildSubApp(usersAdminRoutes));
  try {
    const unfiltered = await fetch(`${base}/api/v4/admin/users`);
    const unfilteredBody = await unfiltered.json();
    assert.equal(unfilteredBody.data.length, 2);
    for (const row of unfilteredBody.data) {
      assert.ok('events' in row && 'onchain_accounts' in row, 'every row must carry the same eager-loaded shape');
    }

    const filtered = await fetch(`${base}/api/v4/admin/users?season_event_id=3`);
    const filteredBody = await filtered.json();
    assert.equal(filteredBody.data.length, 1);
    assert.equal(filteredBody.data[0].id, 1);
    assert.ok('events' in filteredBody.data[0] && 'onchain_accounts' in filteredBody.data[0],
      'the filtered branch must use the SAME shape as the unfiltered one');
  } finally { server.close(); }
});

test('users: export-csv sits behind the WRITE gate — a view-only admin gets the 403 write-gate body (data-egress reasoning, same as /database/export)', async () => {
  db.seasonEvents.push({ id: 8, name: 'Export Event', season_id: 5, starts_at: T(-5), ends_at: T(5) });
  const { server, base } = await listen(buildFullApp('readonly'));
  try {
    const res = await fetch(`${base}/api/v4/admin/users/export-csv/8`);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { success: false, error: 'Full admin access required.' });
  } finally { server.close(); }
});

test('users: export-csv streams the documented CSV — header row, one row per enrolled user (event-scoped OR season-wide), code empty when no account (SPEC 2396-2405)', async () => {
  db.seasonEvents.push({ id: 8, name: 'Export Event', season_id: 5, starts_at: T(-5), ends_at: T(5) });
  db.users.push(
    { id: 1, email: 'alice@example.com', discord: 'alice#1234' },
    { id: 2, email: 'bob@example.com', discord: null },
    { id: 3, email: 'outsider@example.com', discord: 'outsider#9' } // NOT enrolled
  );
  db.userEnrollments.push(
    { id: 1, user_id: 1, season_event_id: 8, season_id: 5, registered_at: T(-1) },
    // Season-wide enrollment (season_event_id NULL) counts as enrolled in
    // every event of that season, mirroring the route's own CTE.
    { id: 2, user_id: 2, season_event_id: null, season_id: 5, registered_at: T(-1) }
  );
  db.onchainAccounts.push({
    id: 1, user_id: 1, season_event_id: 8, season_id: 5, registration_code: 'ABCD1234',
    amount: 10, address: 'addr-1', tier: null, is_used: true,
  });

  const { server, base } = await listen(buildFullApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/users/export-csv/8`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/csv/);
    assert.match(res.headers.get('content-disposition'), /season-event-8-users\.csv/);
    const lines = (await res.text()).trim().split('\n');
    assert.equal(lines[0], 'email,username,code');
    assert.deepEqual(lines.slice(1).sort(), [
      'alice@example.com,alice#1234,ABCD1234',
      'bob@example.com,,',
    ].sort());
    assert.ok(!lines.some((l) => l.includes('outsider@example.com')), 'non-enrolled users never appear');

    // Unknown event -> plain 404 JSON, never CSV headers.
    const notFound = await fetch(`${base}/api/v4/admin/users/export-csv/999999`);
    assert.equal(notFound.status, 404);
    assert.equal((await notFound.json()).error, 'Event not found.');
  } finally { server.close(); }
});

test('users: export-csv neutralizes spreadsheet formula injection in every field (leading =, +, @ get the plain-text apostrophe prefix)', async () => {
  db.seasonEvents.push({ id: 8, name: 'Export Event', season_id: 5, starts_at: T(-5), ends_at: T(5) });
  // Admin-entered/CSV-imported strings can start with a formula trigger
  // character; opening the export in Excel/Sheets must not evaluate them.
  db.users.push({ id: 1, email: '=cmd|calc!A0@x.com', discord: '+SUM(A1)' });
  db.userEnrollments.push({ id: 1, user_id: 1, season_event_id: 8, season_id: 5, registered_at: T(-1) });
  db.onchainAccounts.push({
    id: 1, user_id: 1, season_event_id: 8, season_id: 5, registration_code: '@evilmacro',
    amount: 1, address: 'addr-1', tier: null, is_used: true,
  });

  const { server, base } = await listen(buildFullApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/users/export-csv/8`);
    assert.equal(res.status, 200);
    const lines = (await res.text()).trim().split('\n');
    assert.equal(lines[1], "'=cmd|calc!A0@x.com,'+SUM(A1),'@evilmacro");
  } finally { server.close(); }
});

test('users: import-csv runs in a transaction (BEGIN/COMMIT observed) with counters that cannot go negative', async () => {
  db.seasonEvents.push({ id: 9, name: 'Import Event', season_id: 5, starts_at: T(0), ends_at: T(10) });
  db.users.push({ id: 1, email: 'existing@example.com', discord: 'existing#0001' });
  db.userEnrollments.push({ id: 1, user_id: 1, season_event_id: 9, season_id: 5, registered_at: T(-1) });
  db.onchainAccounts.push(
    { id: 1, user_id: null, season_event_id: 9, amount: 100, is_used: false },
    { id: 2, user_id: null, season_event_id: 9, amount: 50, is_used: false }
  );

  const { server, base } = await listen(buildSubApp(usersAdminRoutes));
  try {
    const res = await fetch(`${base}/api/v4/admin/users/import-csv`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        season_event_id: 9,
        link_accounts: true,
        participants: [
          { email: 'existing@example.com', username: 'existing#0001' }, // already-enrolled existing user
          { email: 'brandnew@example.com', username: 'brandnew#0002' }, // new user, gets the higher-balance account
          { email: 'second@example.com', username: 'second#0003' },     // new user, gets the remaining account
          { email: 'third@example.com', username: 'third#0004' },       // new user, account pool exhausted
          { email: 'not-an-email', username: 'bad-row' },               // invalid row
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.data.created_count, 3);
    assert.equal(body.data.already_in_phase_count, 1);
    assert.equal(body.data.added_to_phase_count, 3);
    // link_accounts attempts a link for every processed row (existing +
    // 3 new), not only newly-enrolled ones; only 2 unused accounts exist,
    // so 2 link and the remaining 2 rows are unassigned — never negative
    // (the fix), even though more rows wanted an account than existed.
    assert.equal(body.data.linked_count, 2);
    assert.equal(body.data.unassigned_count, 2);
    assert.equal(body.data.skipped_count, 1);
    assert.equal(body.data.errors.length, 1);

    // Highest-balance-first: the account with amount 100 went to the
    // FIRST row processed (the existing user), not the second.
    const existingUser = db.users.find((u) => u.email === 'existing@example.com');
    const linkedAccount = db.onchainAccounts.find((a) => a.user_id === existingUser.id);
    assert.equal(linkedAccount.amount, 100);

    assert.ok(queryLog.includes('BEGIN'), 'import must run inside a transaction');
    assert.ok(queryLog.includes('COMMIT'), 'a fully successful import must commit');
  } finally { server.close(); }
});

test('users: import-csv rolls back entirely on an unexpected DB failure mid-batch', async () => {
  db.seasonEvents.push({ id: 9, name: 'Import Event', season_id: 5, starts_at: T(0), ends_at: T(10) });

  // Poison the SECOND row's user_enrollments insert so it throws — the
  // route's own enrollment INSERT has no existence guard (it trusts the
  // earlier lookup), so this simulates a hard mid-batch DB failure.
  // MUST be installed before `usersAdminRoutes(config)` is constructed
  // below: the factory calls `getPool(config)` once and keeps that
  // reference, so swapping `currentMockPool` afterward would be too late
  // (see the top-of-file comment on why `getPool` is a level of
  // indirection in the first place).
  let calls = 0;
  const poisonedQuery = async (sql, params) => {
    const collapsed = sql.replace(/\s+/g, ' ').trim();
    if (collapsed.startsWith('INSERT INTO user_enrollments') && !collapsed.includes('ON CONFLICT')) {
      calls += 1;
      if (calls === 2) throw new Error('simulated connection loss');
    }
    return handleQuery(sql, params);
  };
  currentMockPool = {
    query: poisonedQuery,
    async connect() { return { query: poisonedQuery, release() {} }; },
  };

  const { server, base } = await listen(buildSubApp(usersAdminRoutes));
  try {
    const res = await fetch(`${base}/api/v4/admin/users/import-csv`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        season_event_id: 9,
        participants: [
          { email: 'first@example.com', username: 'first#0001' },
          { email: 'second@example.com', username: 'second#0002' },
        ],
      }),
    });
    assert.equal(res.status, 500);
    assert.equal(db.users.length, 0, 'the whole batch must roll back — the first user must NOT survive either');
    assert.ok(queryLog.includes('ROLLBACK'));
  } finally { server.close(); }
});

// ─── 5. D3 user-activities ────────────────────────────────────────────────

function seedActivityFixtures() {
  db.seasonEvents.push(
    { id: 1, name: 'Event A', starts_at: T(-20), ends_at: T(-1), season_id: null },
    { id: 2, name: 'Event B', starts_at: T(-20), ends_at: T(-1), season_id: null }
  );
  db.users.push({ id: 1, email: 'u1@x.com' }, { id: 2, email: 'u2@x.com' });
  db.challenges.push(
    { id: 500, season_event_id: 1, challenge_template_id: 50, goal: 'Send a tx', task: 'do it' },
    { id: 501, season_event_id: 2, challenge_template_id: 51, goal: 'Other event', task: 'do it' }
  );
}

test('user-activities: create validates the challenge belongs to the given event and overwrites activity_type from the challenge category', async () => {
  seedActivityFixtures();
  const { server, base } = await listen(buildSubApp(userActivitiesAdminRoutes));
  try {
    const mismatchRes = await fetch(`${base}/api/v4/admin/user-activities`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: 1, season_event_id: 1, challenge_id: 501, activity_type: 'onchain_tx', points: 5, activity_at: T(-5),
      }),
    });
    assert.equal(mismatchRes.status, 422);
    assert.equal((await mismatchRes.json()).error, 'Selected activity type is not available for the specified event.');

    const okRes = await fetch(`${base}/api/v4/admin/user-activities`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: 1, season_event_id: 1, challenge_id: 500, activity_type: 'onchain_tx', points: 5, activity_at: T(-5),
      }),
    });
    assert.equal(okRes.status, 201);
    const created = (await okRes.json()).data;
    assert.equal(created.activity_type, 'onchain_tx'); // matches template 50's category
    assert.equal(created.challenge.id, 500);
    assert.equal(created.user.email, 'u1@x.com');
    assert.equal(created.event.name, 'Event A');
  } finally { server.close(); }
});

test('user-activities: update ALWAYS validates the event/challenge pair, even when only season_event_id changes (the v4 fix)', async () => {
  seedActivityFixtures();
  db.userActivities.push({
    id: 1000, user_id: 1, season_event_id: 1, activity_type: 'onchain_tx', points: 5, activity_at: T(-5),
    added_by: null, source: 'admin_ui', challenge_id: 500, created_at: T(-5), updated_at: T(-5),
  });

  const { server, base } = await listen(buildSubApp(userActivitiesAdminRoutes));
  try {
    // Moving the activity to event 2 WITHOUT touching challenge_id: the
    // existing challenge_id (500) belongs to event 1, not 2 — must 422,
    // where the source bug would have let this through unchecked.
    const res = await fetch(`${base}/api/v4/admin/user-activities/1000`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ season_event_id: 2 }),
    });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error, 'Selected activity type is not available for the specified event.');

    // Supplying the matching challenge for event 2 succeeds.
    const okRes = await fetch(`${base}/api/v4/admin/user-activities/1000`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ season_event_id: 2, challenge_id: 501 }),
    });
    assert.equal(okRes.status, 200);
    const updated = (await okRes.json()).data;
    assert.equal(updated.season_event_id, 2);
    assert.equal(updated.activity_type, 'send_tx'); // re-derived from template 51's category
  } finally { server.close(); }
});

test('user-activities: import accepts challenge_id per row, runs in a transaction, and reports per-row errors', async () => {
  seedActivityFixtures();
  const { server, base } = await listen(buildSubApp(userActivitiesAdminRoutes));
  try {
    const res = await fetch(`${base}/api/v4/admin/user-activities/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activities: [
          { user_id: 1, season_event_id: 1, challenge_id: 500, activity_type: 'onchain_tx', points: 3, activity_at: T(-5) },
          { user_id: 1, season_event_id: 1, challenge_id: 501, activity_type: 'onchain_tx', points: 3, activity_at: T(-5) }, // wrong event
          { user_id: 999, season_event_id: 1, challenge_id: 500, activity_type: 'onchain_tx', points: 3, activity_at: T(-5) }, // bad user
        ],
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.data.imported_count, 1);
    assert.equal(body.data.errors.length, 2);
    assert.equal(db.userActivities.length, 1);
    assert.ok(queryLog.includes('BEGIN'));
    assert.ok(queryLog.includes('COMMIT'));
  } finally { server.close(); }
});

test('user-activities: totals aggregates in SQL to the documented shape', async () => {
  seedActivityFixtures();
  db.userActivities.push(
    { id: 1, user_id: 1, season_event_id: 1, activity_type: 'onchain_tx', points: 10, activity_at: T(-5), challenge_id: 500, added_by: null, source: 'admin_ui' },
    { id: 2, user_id: 1, season_event_id: 1, activity_type: 'bug_report', points: 5, activity_at: T(-4), challenge_id: 500, added_by: null, source: 'admin_ui' },
    { id: 3, user_id: 2, season_event_id: 1, activity_type: 'onchain_tx', points: 20, activity_at: T(-3), challenge_id: 500, added_by: null, source: 'admin_ui' }
  );

  const { server, base } = await listen(buildSubApp(userActivitiesAdminRoutes));
  try {
    const res = await fetch(`${base}/api/v4/admin/user-activities/totals?season_event_id=1`);
    assert.equal(res.status, 200);
    const { data } = await res.json();

    assert.equal(data.grand_total.total_points, 35);
    assert.equal(data.grand_total.total_activities, 3);
    assert.equal(data.grand_total.unique_users, 2);

    const typeTotal = data.type_totals.find((t) => t.activity_type === 'onchain_tx');
    assert.equal(typeTotal.count, 2);
    assert.equal(typeTotal.total_points, 30);
    assert.equal(typeTotal.unique_users, 2);

    const userOne = data.user_totals.find((u) => u.user.id === 1);
    assert.equal(userOne.total_points, 15);
    assert.equal(userOne.total_activities, 2);
    assert.equal(userOne.by_type.onchain_tx.total_points, 10);
    assert.equal(userOne.by_type.bug_report.total_points, 5);
  } finally { server.close(); }
});

test('user-activities: refresh-totals rejects an active event and rewrites the latest snapshot for an ended one', async () => {
  db.seasonEvents.push(
    { id: 1, name: 'Active Event', starts_at: T(-5), ends_at: T(5), scoring_formula: { offchain_weight: 2 } },
    { id: 2, name: 'Ended Event', starts_at: T(-20), ends_at: T(-1), scoring_formula: { offchain_weight: 2 } }
  );
  db.users.push({ id: 1 });
  db.userActivities.push(
    { id: 1, user_id: 1, season_event_id: 2, activity_type: 'bug_report', points: 10, activity_at: T(-10), challenge_id: null, added_by: null, source: 'admin_ui' }
  );
  db.leaderboardSnapshots.push({
    id: 1, season_event_id: 2, user_id: 1, snapshot_at: T(-2), rank: 1, total_points: 10, extra_points: 0,
    bug_report_points: 0, inviting_new_participant_points: 0, community_contribution_points: 0,
    first_block_points: 0, top_3_points: 0, success_50_percent_points: 0,
  });

  const { server, base } = await listen(buildSubApp(userActivitiesAdminRoutes));
  try {
    const activeRes = await fetch(`${base}/api/v4/admin/user-activities/refresh-totals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ season_event_id: 1 }),
    });
    assert.equal(activeRes.status, 400);
    assert.equal((await activeRes.json()).error,
      'Refresh totals is only available for ended events. Active events are managed automatically.');

    const endedRes = await fetch(`${base}/api/v4/admin/user-activities/refresh-totals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ season_event_id: 2 }),
    });
    assert.equal(endedRes.status, 200);
    const body = await endedRes.json();
    assert.equal(body.data.updated_count, 1);
    assert.equal(body.data.event_name, 'Ended Event');

    // Documented recomputation: bug_report raw total 10 * offchain_weight
    // 2 = 20 on both bug_report_points and extra_points (only activity
    // type present for this user in this event).
    const snap = db.leaderboardSnapshots[0];
    assert.equal(snap.bug_report_points, 20);
    assert.equal(snap.extra_points, 20);
  } finally { server.close(); }
});
