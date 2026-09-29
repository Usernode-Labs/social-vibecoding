'use strict';

// Per-app database storage cap (#2253).
//
// Every app gets its own Postgres database (services/db-manager.js), and
// until now that database could grow without limit: uploaded files have
// been capped per app since app-files.js's PER_APP_CAP, but one app
// writing rows in a loop could still fill the volume every production
// app, every staging preview and the platform itself share. This module
// is the ceiling for that database: a few gigabytes per app by default,
// with a warning on the way up and a read-only freeze at the top.
//
// It is a SWEEP, not a write-path check. The platform does not sit
// between an app and its database (the app holds its own connection
// string), so the only place a limit can bite is Postgres itself, and the
// only way to learn how big a database is is to ask. The leader measures
// every `app_*` database every APP_DB_STORAGE_SWEEP_INTERVAL_MS
// (server.js, becomeLeader), records the figure on the app row, and moves
// each app through a small state machine:
//
//   ok --(>= warn%)--> warned --(>= cap)--> frozen --(< 95% of cap)--> ok
//
// `decide()` below IS that machine, pure, so its transitions are pinned by
// tests/app-storage-cap.test.js without a database. The hysteresis is the
// point: an app hovering at the cap must not flap between writable and
// read-only every quarter hour, so it thaws only once it has shed 5%, and
// the warning fires once per crossing rather than once per sweep.
//
// A freeze flips the app's owner role to default_transaction_read_only
// (db-manager.setAppDatabaseWritable): reads keep working, writes fail.
// It tells the app's creator and admins through the `app_health`
// notification channel, the same one a failed deploy uses, with a short
// token as the detail (`storage_warn` / `storage_full`) that the drawer
// and the push copy render. Two admin levers undo a freeze without waiting
// for the app to shrink: a per-app cap override (apps.db_storage_cap_bytes)
// and a grace window (apps.db_storage_grace_until), during which the
// database stays writable however big it is; the sweep re-freezes after
// the window lapses if the app is still over.
//
// STAGING: a preview of the platform shares the Postgres server with the
// production app databases, so it must never touch a role or terminate a
// backend; that would freeze a real app from a throwaway copy. Measuring
// is read-only and still runs there (the admin screen shows real figures),
// and the column writes land in the preview's own cloned apps table. The
// role changes and the notifications are skipped, and if the measurement
// itself fails in a preview it is logged once and forgotten.

const dbManager = require('./db-manager');
const log = require('./logger');

const GIB = 1024 * 1024 * 1024;
const DEFAULT_CAP_BYTES = 3 * GIB; // 3221225472
const DEFAULT_WARN_PERCENT = 80;
const DEFAULT_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
// A frozen app thaws only once it is this far under its cap.
const UNFREEZE_RATIO = 0.95;
const MAX_GRACE_MINUTES = 24 * 60;

// notifications.detail tokens (VARCHAR(32); rendered, never shown raw).
const DETAIL_WARN = 'storage_warn';
const DETAIL_FULL = 'storage_full';

function isStaging() {
  return process.env.USERNODE_ENV === 'staging';
}

function positiveInt(raw, fallback) {
  const n = parseInt(raw || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Read at call time rather than module load, so a value changed through
// the platform-variables screen applies on the first sweep after the
// deploy that carries it, and tests can set the environment without
// re-requiring the module. All three are declared in dapp.json's
// platform_env block.
function config() {
  const warn = parseInt(process.env.APP_DB_STORAGE_WARN_PERCENT || '', 10);
  return {
    capBytes: positiveInt(process.env.APP_DB_STORAGE_CAP_BYTES, DEFAULT_CAP_BYTES),
    warnPercent: Number.isFinite(warn) && warn >= 1 && warn <= 100 ? warn : DEFAULT_WARN_PERCENT,
    sweepIntervalMs: positiveInt(process.env.APP_DB_STORAGE_SWEEP_INTERVAL_MS, DEFAULT_SWEEP_INTERVAL_MS),
  };
}

function toMs(value) {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function toIso(value) {
  const ms = toMs(value);
  return ms == null ? null : new Date(ms).toISOString();
}

// BIGINT columns arrive from pg as strings; anything unusable is null.
function toBytes(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

// The cap an app is measured against: its own override when an admin set
// one, else the platform default.
function effectiveCap(app, cfg = config()) {
  const override = toBytes(app && app.db_storage_cap_bytes);
  return override != null ? override : cfg.capBytes;
}

/**
 * The state machine, pure. Returns the ONE transition this sweep applies
 * and the state the app is in afterwards:
 *
 *   none           nothing changed
 *   freeze         at or over the cap with no grace window open: writes
 *                  stop and the admins are told
 *   unfreeze       frozen, and now under 95% of the cap or inside a grace
 *                  window
 *   warn           crossed the warning line (once, until it drops back
 *                  under)
 *   clear_warning  back under the warning line: the warning re-arms
 *
 * One transition per call keeps every step observable: an app that drops
 * from frozen to well under the warning line thaws on this sweep and
 * re-arms on the next.
 */
function decide({ bytes, capBytes, warnPercent, frozenAt, graceUntil, warnedAt, now }) {
  const nowMs = toMs(now) ?? Date.now();
  const size = toBytes(bytes) ?? 0;
  const cap = toBytes(capBytes) ?? DEFAULT_CAP_BYTES;
  const pct = Number.isFinite(warnPercent) ? warnPercent : DEFAULT_WARN_PERCENT;
  const warnBytes = Math.floor((cap * pct) / 100);
  const thawBytes = Math.floor(cap * UNFREEZE_RATIO);
  const graceMs = toMs(graceUntil);
  const graceOpen = graceMs != null && graceMs > nowMs;
  const frozen = !!frozenAt;
  const warned = !!warnedAt;

  if (frozen) {
    if (graceOpen || size < thawBytes) {
      return { transition: 'unfreeze', frozen: false, warned, graceOpen };
    }
    return { transition: 'none', frozen: true, warned, graceOpen };
  }
  if (size >= cap && !graceOpen) {
    // Full implies past the warning line, so the freeze also marks the
    // warning as given: thawing later must not follow "out of storage"
    // with "has used most of its storage" for the same growth.
    return { transition: 'freeze', frozen: true, warned: true, graceOpen };
  }
  if (size >= warnBytes && !warned) {
    return { transition: 'warn', frozen: false, warned: true, graceOpen };
  }
  if (size < warnBytes && warned) {
    return { transition: 'clear_warning', frozen: false, warned: false, graceOpen };
  }
  return { transition: 'none', frozen: false, warned, graceOpen };
}

// ── Rows ──────────────────────────────────────────────────────────────

// What the admin console shows for one app. `state` is derived rather than
// stored: frozen beats grace beats warning, and "warning" also covers an
// app whose last measurement is past the line but which the sweep has not
// yet told anyone about.
function rowView(app, cfg, nowMs) {
  const capBytes = effectiveCap(app, cfg);
  const bytes = toBytes(app.db_size_bytes);
  const frozenAt = toIso(app.db_storage_frozen_at);
  const graceMs = toMs(app.db_storage_grace_until);
  const warnBytes = Math.floor((capBytes * cfg.warnPercent) / 100);
  let state = 'ok';
  if (frozenAt) state = 'frozen';
  else if (graceMs != null && graceMs > nowMs) state = 'grace';
  else if (app.db_storage_warned_at || (bytes != null && bytes >= warnBytes)) state = 'warning';
  return {
    slug: app.slug,
    name: app.name,
    dbSizeBytes: bytes,
    measuredAt: toIso(app.db_size_measured_at),
    capBytes,
    capOverrideBytes: toBytes(app.db_storage_cap_bytes),
    frozenAt,
    graceUntil: toIso(app.db_storage_grace_until),
    warnedAt: toIso(app.db_storage_warned_at),
    state,
  };
}

// Biggest first; apps never measured at the bottom; ties by name.
function bySizeDesc(a, b) {
  const av = a.dbSizeBytes;
  const bv = b.dbSizeBytes;
  if (av == null && bv == null) return String(a.name).localeCompare(String(b.name));
  if (av == null) return 1;
  if (bv == null) return -1;
  if (av !== bv) return bv - av;
  return String(a.name).localeCompare(String(b.name));
}

async function loadApps(pool) {
  const { rows } = await pool.query(
    `SELECT id, slug, name, self_hosted, db_size_bytes, db_size_measured_at,
            db_storage_cap_bytes, db_storage_frozen_at, db_storage_grace_until,
            db_storage_warned_at
       FROM apps
      WHERE NOT self_hosted`
  );
  return rows;
}

async function readApp(pool, slug, { now } = {}) {
  const { rows } = await pool.query(
    `SELECT id, slug, name, self_hosted, db_size_bytes, db_size_measured_at,
            db_storage_cap_bytes, db_storage_frozen_at, db_storage_grace_until,
            db_storage_warned_at
       FROM apps
      WHERE slug = $1 AND NOT self_hosted`,
    [slug]
  );
  if (!rows[0]) return null;
  return rowView(rows[0], config(), toMs(now) ?? Date.now());
}

async function listApps(pool, { now } = {}) {
  const cfg = config();
  const nowMs = toMs(now) ?? Date.now();
  const apps = await loadApps(pool);
  return apps.map((app) => rowView(app, cfg, nowMs)).sort(bySizeDesc);
}

// ── The sweep ─────────────────────────────────────────────────────────

const state = {
  lastSweep: null,
  stagingMeasureWarned: false,
};

function lastSweep() {
  return state.lastSweep;
}

// The notification creator, resolved at call time so a test can swap the
// module's export (the same seam staging.js's deploy-failure path uses).
function defaultNotify(pool, args) {
  return require('./notifications').createAppHealthNotification(pool, args);
}

async function applyTransition(pool, app, dbName, decision, ctx) {
  const { now, staging, execute, notify, bytes, capBytes, summary } = ctx;
  const meta = { slug: app.slug, dbName, bytes, capBytes, staging };
  switch (decision.transition) {
    case 'freeze': {
      // Role first, then the row, then the people: if the role change
      // fails nothing is recorded and the next sweep tries again; if the
      // notification fails the freeze still stands, which is the part
      // that protects the volume.
      if (!staging) await dbManager.setAppDatabaseWritable(dbName, false, { execute });
      await pool.query(
        `UPDATE apps
            SET db_storage_frozen_at = $1,
                db_storage_warned_at = COALESCE(db_storage_warned_at, $1)
          WHERE id = $2`,
        [now, app.id]
      );
      summary.frozen += 1;
      log.warn('app-storage-cap', 'App database frozen read-only: over its storage cap', meta);
      if (!staging) {
        try {
          await notify(pool, { appId: app.id, detail: DETAIL_FULL });
        } catch (err) {
          summary.errors.push(`${app.slug}: notify: ${err.message}`);
          log.warn('app-storage-cap', 'Could not notify app admins of the freeze', { ...meta, err: err.message });
        }
      }
      return;
    }
    case 'unfreeze': {
      if (!staging) await dbManager.setAppDatabaseWritable(dbName, true, { execute });
      await pool.query('UPDATE apps SET db_storage_frozen_at = NULL WHERE id = $1', [app.id]);
      summary.unfrozen += 1;
      log.info('app-storage-cap', 'App database writable again', { ...meta, grace: decision.graceOpen });
      return;
    }
    case 'warn': {
      await pool.query('UPDATE apps SET db_storage_warned_at = $1 WHERE id = $2', [now, app.id]);
      summary.warned += 1;
      log.info('app-storage-cap', 'App database past its storage warning line', meta);
      if (!staging) {
        try {
          await notify(pool, { appId: app.id, detail: DETAIL_WARN });
        } catch (err) {
          summary.errors.push(`${app.slug}: notify: ${err.message}`);
          log.warn('app-storage-cap', 'Could not notify app admins of the warning', { ...meta, err: err.message });
        }
      }
      return;
    }
    case 'clear_warning': {
      await pool.query('UPDATE apps SET db_storage_warned_at = NULL WHERE id = $1', [app.id]);
      summary.cleared += 1;
      return;
    }
    default:
  }
}

/**
 * Measure every app database and apply the transitions. Never throws: a
 * failed measurement or a failed app is recorded in the summary (and in
 * `lastSweep()`, which the admin API reads) and the rest carries on.
 *
 * deps.execute  the psql runner db-manager uses (tests inject a fake)
 * deps.now      the sweep's clock (tests pin it)
 * deps.staging  overrides the USERNODE_ENV read (see the module header)
 * deps.notify   overrides notifications.createAppHealthNotification
 */
async function sweep(pool, deps = {}) {
  const now = deps.now != null ? new Date(toMs(deps.now)) : new Date();
  const staging = deps.staging != null ? !!deps.staging : isStaging();
  const notify = deps.notify || defaultNotify;
  const cfg = config();
  const startedMs = Date.now();
  const summary = {
    startedAt: now.toISOString(),
    finishedAt: null,
    durationMs: 0,
    staging,
    capBytes: cfg.capBytes,
    warnPercent: cfg.warnPercent,
    databases: 0,
    measured: 0,
    skipped: 0,
    frozen: 0,
    unfrozen: 0,
    warned: 0,
    cleared: 0,
    errors: [],
  };
  const finish = () => {
    summary.finishedAt = new Date().toISOString();
    summary.durationMs = Date.now() - startedMs;
    state.lastSweep = summary;
    return summary;
  };

  let sizes;
  try {
    sizes = await dbManager.listAppDatabaseSizes({ execute: deps.execute });
  } catch (err) {
    summary.errors.push(`measure: ${err.message}`);
    if (!staging) {
      log.warn('app-storage-cap', 'Could not measure app databases', { err: err.message });
    } else if (!state.stagingMeasureWarned) {
      state.stagingMeasureWarned = true;
      log.warn('app-storage-cap', 'Could not measure app databases from this preview; storage figures stay as cloned', {
        err: err.message,
      });
    }
    return finish();
  }
  summary.databases = sizes.length;

  let apps;
  try {
    apps = await loadApps(pool);
  } catch (err) {
    summary.errors.push(`apps: ${err.message}`);
    log.warn('app-storage-cap', 'Could not load app rows for the storage sweep', { err: err.message });
    return finish();
  }
  const byDb = new Map();
  for (const app of apps) {
    if (app.self_hosted) continue;
    byDb.set(dbManager.appDbName(app.slug), app);
  }

  for (const { dbName, bytes } of sizes) {
    // A preview's clone and the redacted template it was cut from match
    // the app_ prefix too, and must never count against the app they
    // copy; anything else the catalog holds that no app row names (an
    // orphan from a failed delete, a hand-made database) is not ours to
    // freeze.
    if (dbManager.isStagingCloneDb(dbName) || dbManager.isStagingTemplateDb(dbName)) {
      summary.skipped += 1;
      continue;
    }
    const app = byDb.get(dbName);
    if (!app) {
      summary.skipped += 1;
      continue;
    }
    try {
      await pool.query(
        'UPDATE apps SET db_size_bytes = $1, db_size_measured_at = $2 WHERE id = $3',
        [bytes, now, app.id]
      );
      summary.measured += 1;
      const capBytes = effectiveCap(app, cfg);
      const decision = decide({
        bytes,
        capBytes,
        warnPercent: cfg.warnPercent,
        frozenAt: app.db_storage_frozen_at,
        graceUntil: app.db_storage_grace_until,
        warnedAt: app.db_storage_warned_at,
        now,
      });
      await applyTransition(pool, app, dbName, decision, {
        now, staging, execute: deps.execute, notify, bytes, capBytes, summary,
      });
    } catch (err) {
      summary.errors.push(`${app.slug}: ${err.message}`);
      log.warn('app-storage-cap', 'Storage sweep failed for an app', { slug: app.slug, dbName, err: err.message });
    }
  }
  return finish();
}

// ── Admin levers ──────────────────────────────────────────────────────

/**
 * Let an app write again for `minutes`, whatever its size. A frozen app is
 * thawed on the spot (role and row), not at the next sweep, because the
 * admin pressing this is standing next to someone whose app just stopped
 * saving. Returns the updated row view, or null when no such app exists.
 */
async function grantGrace(pool, slug, minutes, deps = {}) {
  const mins = Number(minutes);
  if (!Number.isInteger(mins) || mins < 1 || mins > MAX_GRACE_MINUTES) {
    throw new Error(`grace minutes must be an integer between 1 and ${MAX_GRACE_MINUTES}`);
  }
  const now = deps.now != null ? new Date(toMs(deps.now)) : new Date();
  const staging = deps.staging != null ? !!deps.staging : isStaging();
  const until = new Date(now.getTime() + mins * 60 * 1000);
  const { rows } = await pool.query(
    `UPDATE apps
        SET db_storage_grace_until = $1
      WHERE slug = $2 AND NOT self_hosted
  RETURNING id, slug, db_storage_frozen_at`,
    [until, slug]
  );
  const app = rows[0];
  if (!app) return null;
  if (app.db_storage_frozen_at) {
    // Same split as the sweep: the row is the preview's own to write, the
    // role is production's and is left alone from a staging copy.
    if (!staging) {
      await dbManager.setAppDatabaseWritable(dbManager.appDbName(slug), true, { execute: deps.execute });
    }
    await pool.query('UPDATE apps SET db_storage_frozen_at = NULL WHERE id = $1', [app.id]);
  }
  log.info('app-storage-cap', 'Grace window granted', {
    slug, minutes: mins, until: until.toISOString(), wasFrozen: !!app.db_storage_frozen_at, staging,
  });
  return readApp(pool, slug, { now });
}

/**
 * Set (bytes) or clear (null) an app's own cap. Takes effect at the next
 * measurement, which the admin console runs right after saving. Returns
 * the updated row view, or null when no such app exists.
 */
async function setCapOverride(pool, slug, capBytesOrNull, deps = {}) {
  let cap = null;
  if (capBytesOrNull != null) {
    cap = Number(capBytesOrNull);
    if (!Number.isInteger(cap) || cap < 0) {
      throw new Error('cap must be a non-negative integer number of bytes, or null for the default');
    }
  }
  const { rows } = await pool.query(
    `UPDATE apps
        SET db_storage_cap_bytes = $1
      WHERE slug = $2 AND NOT self_hosted
  RETURNING id`,
    [cap, slug]
  );
  if (!rows[0]) return null;
  log.info('app-storage-cap', 'App storage cap override set', { slug, capBytes: cap });
  return readApp(pool, slug, deps);
}

// ── Admin API payloads ────────────────────────────────────────────────

async function adminPayload(pool, { now } = {}) {
  return {
    apps: await listApps(pool, { now }),
    defaults: config(),
    lastSweep: state.lastSweep,
  };
}

// Staging mock data for the App storage section: a preview's cloned apps
// table may carry no figures at all, and nothing is ever frozen from a
// preview, so the screen would show every state as "ok" with blank bars.
// Deterministic, obviously fake, and one row per state the screen can
// render: frozen, nearly full, under a raised cap, and small.
function demoAdminPayload({ now } = {}) {
  const cfg = config();
  const nowMs = toMs(now) ?? Date.now();
  const at = (minutesAgo) => new Date(nowMs - minutesAgo * 60 * 1000).toISOString();
  const MIB = 1024 * 1024;
  const rows = [
    {
      slug: 'staging-demo-app-1', name: 'Staging demo app 1',
      db_size_bytes: cfg.capBytes + 120 * MIB, db_size_measured_at: at(4),
      db_storage_cap_bytes: null, db_storage_frozen_at: at(34),
      db_storage_grace_until: null, db_storage_warned_at: at(180),
    },
    {
      slug: 'staging-demo-app-2', name: 'Staging demo app 2',
      db_size_bytes: Math.floor(cfg.capBytes * 0.86), db_size_measured_at: at(4),
      db_storage_cap_bytes: null, db_storage_frozen_at: null,
      db_storage_grace_until: null, db_storage_warned_at: at(50),
    },
    {
      slug: 'staging-demo-app-3', name: 'Staging demo app 3',
      db_size_bytes: 412 * MIB, db_size_measured_at: at(4),
      db_storage_cap_bytes: 8 * GIB, db_storage_frozen_at: null,
      db_storage_grace_until: null, db_storage_warned_at: null,
    },
    {
      slug: 'staging-demo-app-4', name: 'Staging demo app 4',
      db_size_bytes: 9 * MIB, db_size_measured_at: at(4),
      db_storage_cap_bytes: null, db_storage_frozen_at: null,
      db_storage_grace_until: null, db_storage_warned_at: null,
    },
  ];
  return {
    apps: rows.map((r) => rowView(r, cfg, nowMs)).sort(bySizeDesc),
    defaults: cfg,
    lastSweep: {
      startedAt: at(4), finishedAt: at(4), durationMs: 812, staging: true,
      capBytes: cfg.capBytes, warnPercent: cfg.warnPercent,
      databases: 6, measured: 4, skipped: 2,
      frozen: 0, unfrozen: 0, warned: 0, cleared: 0, errors: [],
    },
    demo: true,
  };
}

function _resetForTest() {
  state.lastSweep = null;
  state.stagingMeasureWarned = false;
}

module.exports = {
  config,
  decide,
  effectiveCap,
  sweep,
  grantGrace,
  setCapOverride,
  listApps,
  readApp,
  adminPayload,
  demoAdminPayload,
  lastSweep,
  isStaging,
  DEFAULT_CAP_BYTES,
  DEFAULT_WARN_PERCENT,
  DEFAULT_SWEEP_INTERVAL_MS,
  UNFREEZE_RATIO,
  MAX_GRACE_MINUTES,
  DETAIL_WARN,
  DETAIL_FULL,
  _resetForTest,
};
