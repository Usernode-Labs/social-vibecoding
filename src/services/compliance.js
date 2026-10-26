'use strict';

// The Compliance report (#5634): where Homeroom stands on each action of
// its compliance plan (services/compliance-items.js, a fixed list), as an
// admin set it and as the scan finds it.
//
// Read by GET /api/admin/compliance and written by
// POST /api/admin/compliance/items/:code/status and
// POST /api/admin/compliance/scan (routes/admin.js); drawn by the console's
// Compliance section (frontend/src/features/admin/admin-compliance.tsx).
//
// TWO KINDS OF STATUS, kept apart:
//   * an item's status (to do, partly done, done) is set BY HAND. Most of
//     the plan is decisions, contracts and documents that no script can
//     read. Each save is a row in compliance_status_changes, so the newest
//     row is the status and the rows before it are its history; an item
//     nobody has saved yet shows the plan's starting value. A save with no
//     note keeps the note the item had.
//   * a check (CHECKS, below) reads the platform or every project and
//     says pass or fail. The scan runs them all (the `compliance-scan`
//     clock, every COMPLIANCE_SCAN_INTERVAL_DAYS, and an admin's Scan
//     now), and each run is kept in compliance_scans with one
//     compliance_scan_results row per check.
// A failing check never changes what a person set. The item shows both,
// and the page lists it first, so a "done" that the scan contradicts is
// the first thing an admin sees.

const { AREAS, ITEMS } = require('./compliance-items');
const ipRetention = require('./ip-retention');
const adminAccessReview = require('./admin-access-review');
const repoRef = require('./repo-ref');

const STATUSES = Object.freeze(['todo', 'partial', 'done']);
const NOTE_MAX = 1000;
// The failing projects a result keeps, so one scan row stays small.
const FAILING_MAX = 200;
// The scans the page lists as history.
const SCAN_HISTORY = 12;
// How long a deletion request may stay open: GDPR gives a month to answer.
const DELETION_DAYS = 30;

const ITEM_BY_CODE = new Map(ITEMS.map((i) => [i.code, i]));

const DEFAULT_SCAN_DAYS = 7;

// The scan's interval: COMPLIANCE_SCAN_INTERVAL_DAYS, whole days from 1 to
// 90; anything else is a week.
function scanIntervalDays(env = process.env) {
  const raw = String(env.COMPLIANCE_SCAN_INTERVAL_DAYS ?? '').trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_SCAN_DAYS;
  const days = Number(raw);
  return days >= 1 && days <= 90 ? days : DEFAULT_SCAN_DAYS;
}

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const pass = (summary, extra = {}) => ({ state: 'pass', summary, ...extra });
const fail = (summary, extra = {}) => ({ state: 'fail', summary, ...extra });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ── Checks ─────────────────────────────────────────────────────────────
//
// Each reads what is true now and answers { state: 'pass' | 'fail' |
// 'error', summary, checked?, failed?, failing? }: `checked` and `failed`
// count projects when the check is one per project, and `failing` names
// them ({ slug, name, reason }). A check that throws is recorded as an
// error with its message, and the scan goes on to the next.

// A project's repository, read from its repo_url.
function repoOf(url) {
  return repoRef.ownerRepo(url);
}

const LICENSE_PATHS = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'];

async function checkRepoLicenses(pool, { shouldStop = () => false, github = require('./github'), budget = require('./github-budget') } = {}) {
  const { rows } = await pool.query(
    `SELECT id, slug, name, repo_url FROM apps
      WHERE repo_url IS NOT NULL AND status != 'archived'
      ORDER BY id`
  );
  const queue = rows.slice();
  const failing = [];
  let checked = 0;
  let held = false;
  async function hasLicense(owner, repo) {
    for (const path of LICENSE_PATHS) {
      if (await github.getFileContent(owner, repo, path) !== null) return true;
    }
    return false;
  }
  async function worker() {
    while (queue.length) {
      // One read per project (more only for one without a LICENSE): it
      // gives way to everything else when GitHub's hourly budget runs low.
      if (shouldStop() || !budget.budgetAllows('background')) { held = true; return; }
      const row = queue.shift();
      const at = repoOf(row.repo_url);
      checked++;
      if (!at) { failing.push({ slug: row.slug, name: row.name, reason: 'not_on_github' }); continue; }
      try {
        if (!await hasLicense(at.owner, at.repo)) failing.push({ slug: row.slug, name: row.name, reason: 'missing' });
      } catch {
        failing.push({ slug: row.slug, name: row.name, reason: 'unreadable' });
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  const total = rows.length;
  const extra = { checked, failed: failing.length, failing };
  if (held) {
    return {
      state: 'error',
      summary: `Stopped after ${checked} of ${plural(total, 'project', 'projects')}: GitHub's hourly budget was low. The next scan reads them all again.`,
      ...extra,
    };
  }
  // Not one repository could be read (no GitHub credentials here, or GitHub
  // down): that is the scan failing, not every project.
  const unreadable = failing.filter((f) => f.reason === 'unreadable').length;
  if (checked > 0 && unreadable === checked) {
    return { state: 'error', summary: 'GitHub could not be read, so no repository was checked.', checked, failed: 0, failing: [] };
  }
  if (!failing.length) return pass(`Every one of ${plural(total, 'project', 'projects')} has a LICENSE file.`, extra);
  return fail(`${failing.length} of ${plural(total, 'project', 'projects')} have no LICENSE file that could be read.`, extra);
}

const CHECKS = Object.freeze([
  Object.freeze({
    key: 'db-tls',
    items: ['I-03'],
    label: 'The platform\'s database connection is encrypted',
    async run(pool) {
      const { rows } = await pool.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
      return rows[0] && rows[0].ssl === true
        ? pass('The platform connects to its database over TLS.')
        : fail('The platform connects to its database without TLS.');
    },
  }),
  Object.freeze({
    key: 'ip-retention',
    items: ['I-05'],
    label: 'No stored IP address is older than the retention period',
    async run(pool) {
      const days = ipRetention.retentionDays();
      const { rows: [r] } = await pool.query(
        `SELECT
           (SELECT count(*) FROM waitlist_signups
             WHERE ip IS NOT NULL AND submitted_at < NOW() - make_interval(days => $1::int))
         + (SELECT count(*) FROM users
             WHERE waitlist_ip IS NOT NULL
               AND COALESCE(waitlist_submitted_at, created_at) < NOW() - make_interval(days => $1::int))
         + (SELECT count(*) FROM user_terms_consents
             WHERE ip IS NOT NULL AND responded_at < NOW() - make_interval(days => $1::int))
         + (SELECT count(*) FROM db_exports
             WHERE ip IS NOT NULL AND requested_at < NOW() - make_interval(days => $1::int)) AS old`,
        [days]
      );
      const old = Number(r.old) || 0;
      return old === 0
        ? pass(`No stored IP address is older than ${days} days.`)
        : fail(`${plural(old, 'stored IP address is', 'stored IP addresses are')} older than ${days} days.`);
    },
  }),
  Object.freeze({
    key: 'admin-access-review',
    items: ['I-06'],
    label: 'The admin access review is up to date',
    async run(pool) {
      const status = adminAccessReview.reviewStatus(await adminAccessReview.latestReview(pool));
      if (!status.lastReviewedAt) return fail('The admin list has never been reviewed.');
      return status.overdue
        ? fail(`The admin access review is overdue since ${status.nextDueAt.slice(0, 10)}.`)
        : pass(`Reviewed ${status.lastReviewedAt.slice(0, 10)}; next due ${status.nextDueAt.slice(0, 10)}.`);
    },
  }),
  Object.freeze({
    key: 'account-deletions',
    items: ['A-08', 'O-01'],
    label: `Account deletions finish within ${DELETION_DAYS} days`,
    async run(pool) {
      const { rows: [r] } = await pool.query(
        `SELECT
           (SELECT count(*) FROM account_deletions
             WHERE completed_at IS NULL AND created_at < NOW() - make_interval(days => $1::int)) AS late,
           (SELECT count(*) FROM account_deletion_tasks
             WHERE state = 'review' AND kind <> 'app_data') AS review`,
        [DELETION_DAYS]
      );
      const late = Number(r.late) || 0;
      const review = Number(r.review) || 0;
      if (!late && !review) return pass(`No deletion is open longer than ${DELETION_DAYS} days, and none waits on a person.`);
      const parts = [];
      if (late) parts.push(`${plural(late, 'deletion is', 'deletions are')} open longer than ${DELETION_DAYS} days`);
      if (review) parts.push(`${plural(review, 'cleanup step waits', 'cleanup steps wait')} on a person`);
      return fail(`${parts.join('; ')}.`);
    },
  }),
  Object.freeze({
    key: 'app-data-deletion',
    items: ['X-05'],
    label: 'Every project erases a deleted account\'s data when asked',
    async run(pool) {
      // An app_data task's target is "<appId>" or "<appId>:<pubkey>"
      // (services/app-user-data.js); one in review is a project that could
      // not or would not erase the person's rows.
      const { rows } = await pool.query(
        `WITH asked AS (
           SELECT split_part(t.target, ':', 1) AS app_key, t.state, t.error_code
             FROM account_deletion_tasks t
            WHERE t.kind = 'app_data' AND t.target ~ '^[0-9]+(:|$)'
         )
         SELECT a.slug, a.name, asked.app_key,
                bool_or(asked.state = 'review') AS in_review,
                (array_agg(asked.error_code) FILTER (WHERE asked.state = 'review'))[1] AS reason
           FROM asked
           LEFT JOIN apps a ON a.id = asked.app_key::int
          GROUP BY asked.app_key, a.slug, a.name
          ORDER BY asked.app_key::int`
      );
      const failing = rows.filter((r) => r.in_review).map((r) => ({
        slug: r.slug || `app ${r.app_key}`, name: r.name || null, reason: r.reason || 'review',
      }));
      const extra = { checked: rows.length, failed: failing.length, failing };
      if (!rows.length) return pass('No project has been asked to erase anybody\'s data yet.', extra);
      return failing.length
        ? fail(`${failing.length} of ${plural(rows.length, 'project', 'projects')} asked to erase a deleted account's data did not.`, extra)
        : pass(`Every one of ${plural(rows.length, 'project', 'projects')} asked to erase a deleted account's data did.`, extra);
    },
  }),
  Object.freeze({
    key: 'repo-license',
    items: ['X-07', 'L-08'],
    label: 'Every project\'s repository has a LICENSE file',
    run: (pool, opts) => checkRepoLicenses(pool, opts),
  }),
]);

const CHECK_BY_KEY = new Map(CHECKS.map((c) => [c.key, c]));

function clip(text, max) {
  const s = String(text == null ? '' : text);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// One result as stored: the state, a sentence, and the failing projects.
function normaliseResult(raw) {
  const state = raw && ['pass', 'fail', 'error'].includes(raw.state) ? raw.state : 'error';
  const failing = Array.isArray(raw && raw.failing) ? raw.failing.slice(0, FAILING_MAX) : [];
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  return {
    state,
    summary: clip((raw && raw.summary) || 'The check gave no answer.', 500),
    checked: count(raw && raw.checked),
    failed: count(raw && raw.failed),
    failing,
  };
}

// Runs every check once and keeps what each found. Safe to run twice (a
// second run is a second scan); a run asked to stop records what it reached
// and ends, so the clock tries again sooner. The result is small: the
// scan's id and each check's state.
async function runScan(pool, { shouldStop = () => false, checks = CHECKS, checkOpts = {} } = {}) {
  const { rows: [scan] } = await pool.query(
    'INSERT INTO compliance_scans DEFAULT VALUES RETURNING id, started_at'
  );
  const states = {};
  for (const check of checks) {
    if (shouldStop()) break;
    let result;
    try {
      result = normaliseResult(await check.run(pool, { shouldStop, ...checkOpts }));
    } catch (err) {
      result = normaliseResult({ state: 'error', summary: `The check failed: ${err && err.message}` });
    }
    await pool.query(
      `INSERT INTO compliance_scan_results (scan_id, check_key, state, summary, checked, failed, failing)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (scan_id, check_key) DO NOTHING`,
      [scan.id, check.key, result.state, result.summary, result.checked, result.failed, JSON.stringify(result.failing)]
    );
    states[check.key] = result.state;
  }
  const stopped = Object.keys(states).length < checks.length;
  await pool.query('UPDATE compliance_scans SET finished_at = NOW() WHERE id = $1', [scan.id]);
  if (stopped) throw new Error(`Compliance scan ${scan.id} stopped before every check ran`);
  return { scanId: Number(scan.id), states };
}

// ── The report ─────────────────────────────────────────────────────────

async function latestStatuses(db) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (c.item_code) c.item_code, c.status, c.note, c.changed_at, u.username
       FROM compliance_status_changes c
       LEFT JOIN users u ON u.id = c.changed_by
      ORDER BY c.item_code, c.changed_at DESC, c.id DESC`
  );
  return new Map(rows.map((r) => [r.item_code, r]));
}

function resultOut(row) {
  const check = CHECK_BY_KEY.get(row.check_key);
  return {
    key: row.check_key,
    label: check ? check.label : row.check_key,
    state: row.state,
    summary: row.summary,
    checked: row.checked,
    failed: row.failed,
    failing: Array.isArray(row.failing) ? row.failing : [],
  };
}

// The newest finished scans, newest first, each with its checks' states.
async function recentScans(db, limit = SCAN_HISTORY) {
  const { rows: scans } = await db.query(
    `SELECT id, started_at, finished_at FROM compliance_scans
      WHERE finished_at IS NOT NULL
      ORDER BY finished_at DESC, id DESC
      LIMIT $1`,
    [limit]
  );
  if (!scans.length) return [];
  const { rows } = await db.query(
    `SELECT scan_id, check_key, state, summary, checked, failed, failing
       FROM compliance_scan_results WHERE scan_id = ANY($1::bigint[])`,
    [scans.map((s) => s.id)]
  );
  return scans.map((s) => ({
    id: Number(s.id),
    startedAt: iso(s.started_at),
    finishedAt: iso(s.finished_at),
    results: rows.filter((r) => String(r.scan_id) === String(s.id)).map(resultOut),
  }));
}

function itemOut(item, saved, latestScan) {
  const checks = latestScan
    ? latestScan.results.filter((r) => (CHECK_BY_KEY.get(r.key)?.items || []).includes(item.code))
    : [];
  return {
    code: item.code,
    area: item.area,
    title: item.title,
    issue: item.issue,
    priority: item.priority,
    status: saved ? saved.status : item.start,
    note: saved ? saved.note : item.startNote,
    setBy: saved ? saved.username || null : null,
    setAt: saved ? iso(saved.changed_at) : null,
    fromPlan: !saved,
    checks,
    attention: checks.some((c) => c.state === 'fail'),
    automatic: CHECKS.some((c) => c.items.includes(item.code)),
  };
}

// Items that a scan contradicts first, then the plan's own order.
function sortItems(items) {
  const order = new Map(ITEMS.map((i, n) => [i.code, n]));
  return items.slice().sort((a, b) => (Number(b.attention) - Number(a.attention))
    || (order.get(a.code) - order.get(b.code)));
}

async function report(db) {
  const [saved, scans] = await Promise.all([latestStatuses(db), recentScans(db)]);
  const latest = scans[0] || null;
  const items = sortItems(ITEMS.map((i) => itemOut(i, saved.get(i.code), latest)));
  const counts = { todo: 0, partial: 0, done: 0 };
  for (const i of items) counts[i.status]++;
  return {
    areas: AREAS,
    statuses: STATUSES,
    scanIntervalDays: scanIntervalDays(),
    checks: CHECKS.map((c) => ({ key: c.key, label: c.label, items: c.items })),
    items,
    counts,
    attention: items.filter((i) => i.attention).length,
    scans,
  };
}

// One item's history: every status saved, newest first, and what its
// checks found in each kept scan.
async function itemHistory(db, code) {
  const item = ITEM_BY_CODE.get(code);
  if (!item) return null;
  const { rows } = await db.query(
    `SELECT c.id, c.status, c.note, c.changed_at, u.username
       FROM compliance_status_changes c
       LEFT JOIN users u ON u.id = c.changed_by
      WHERE c.item_code = $1
      ORDER BY c.changed_at DESC, c.id DESC
      LIMIT 200`,
    [code]
  );
  const keys = CHECKS.filter((c) => c.items.includes(code)).map((c) => c.key);
  let scans = [];
  if (keys.length) {
    const { rows: results } = await db.query(
      `SELECT s.id, s.finished_at, r.check_key, r.state, r.summary, r.checked, r.failed
         FROM compliance_scan_results r
         JOIN compliance_scans s ON s.id = r.scan_id
        WHERE r.check_key = ANY($1::text[]) AND s.finished_at IS NOT NULL
        ORDER BY s.finished_at DESC, s.id DESC
        LIMIT 200`,
      [keys]
    );
    scans = results.map((r) => ({
      scanId: Number(r.id), at: iso(r.finished_at), key: r.check_key,
      label: CHECK_BY_KEY.get(r.check_key).label,
      state: r.state, summary: r.summary, checked: r.checked, failed: r.failed,
    }));
  }
  return {
    code: item.code,
    start: item.start,
    startNote: item.startNote,
    changes: rows.map((r) => ({
      id: Number(r.id), status: r.status, note: r.note, at: iso(r.changed_at), by: r.username || null,
    })),
    scans,
  };
}

// A status from the page, checked: a known item, one of the three
// statuses, a note within NOTE_MAX. A blank note keeps the item's note.
function normaliseStatus(code, body) {
  if (!ITEM_BY_CODE.has(code)) return { ok: false, status: 404, error: 'No such item in the compliance plan.' };
  const status = body && body.status;
  if (!STATUSES.includes(status)) return { ok: false, status: 400, error: 'Status must be to do, partly done or done.' };
  const raw = body && body.note;
  if (raw !== undefined && raw !== null && typeof raw !== 'string') return { ok: false, status: 400, error: 'The note must be text.' };
  const note = typeof raw === 'string' ? raw.trim() : '';
  if (note.length > NOTE_MAX) return { ok: false, status: 400, error: `The note is longer than ${NOTE_MAX} characters.` };
  return { ok: true, value: { status, note: note || null } };
}

// Saves an item's status. With no note, the item keeps the one it had (the
// last saved, else the plan's starting note).
async function recordStatus(db, { code, status, note, changedBy }) {
  const item = ITEM_BY_CODE.get(code);
  let keep = note;
  if (!keep) {
    const { rows: [prev] } = await db.query(
      `SELECT note FROM compliance_status_changes WHERE item_code = $1
        ORDER BY changed_at DESC, id DESC LIMIT 1`,
      [code]
    );
    keep = prev ? prev.note : item.startNote;
  }
  const { rows: [row] } = await db.query(
    `INSERT INTO compliance_status_changes (item_code, status, note, changed_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, item_code, status, note, changed_at`,
    [code, status, keep || null, changedBy || null]
  );
  return row;
}

module.exports = {
  STATUSES,
  NOTE_MAX,
  DEFAULT_SCAN_DAYS,
  CHECKS,
  scanIntervalDays,
  repoOf,
  checkRepoLicenses,
  normaliseResult,
  runScan,
  report,
  itemHistory,
  normaliseStatus,
  recordStatus,
  sortItems,
};
