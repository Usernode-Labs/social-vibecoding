'use strict';

// Admin access review (#5133): who holds admin rights, what each of them
// can do, and the quarterly review that confirms the list is still right.
//
// Read by GET /api/admin/access-review and written by
// POST /api/admin/access-review/reviews (routes/admin.js), both full-admin
// only; drawn by the console's Access review section
// (frontend/src/features/admin/admin-access-review.tsx). The procedure the
// review is part of is docs/ops/admin-access.md.
//
// WHAT EACH ROLE CAN DO is stated here once, from the gates the routes
// actually apply, so the review cannot claim a power the code does not
// grant (tests/admin-access-review.test.js holds the two together):
//   * every admin (`adminMiddleware`, is_admin) reads every admin screen,
//     and runs the SQL console (routes/topochain/admin/db-tools.js: a
//     SELECT-only query, in a READ ONLY transaction, as the column-scoped
//     topochain_console_ro role that cannot read credential columns);
//   * only a full admin (`requireAdminWrite`, is_admin AND NOT
//     admin_readonly) changes anything, and takes any export that carries
//     personal data or secrets: the whole-database dump (which also asks
//     for their password every time, routes/admin.js), the programme
//     database export, and the user, waitlist, bot-verdict, shots and
//     benchmark CSVs.
//
// "Last sign-in" is the newest live browser session's start
// (sessions.created_at). A session ends when it expires or is signed out,
// so an admin with no live session reads "none live", which is also the
// answer the review needs: nobody is signed in as them right now.

// How long a review stays current. The request (#5133) asks for a
// quarterly review; 90 days is that quarter.
const REVIEW_INTERVAL_DAYS = 90;
const NOTE_MAX = 500;

const ROLE_FULL = 'admin';
const ROLE_VIEW = 'view_admin';

function roleOf(row) {
  if (!row || !row.is_admin) return 'user';
  return row.admin_readonly ? ROLE_VIEW : ROLE_FULL;
}

// The capabilities a role carries, as booleans the section draws as yes/no.
function capabilitiesFor(role) {
  const admin = role === ROLE_FULL || role === ROLE_VIEW;
  const full = role === ROLE_FULL;
  return {
    readConsole: admin,
    sqlConsole: admin,
    changeThings: full,
    databaseExport: full,
    personalDataExports: full,
    manageAdmins: full,
  };
}

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// The review's state on `now`: the latest review, when the next is due,
// and whether that date has passed. No review at all is overdue.
function reviewStatus(latest, now = new Date()) {
  const lastAt = latest && latest.reviewed_at ? new Date(latest.reviewed_at) : null;
  if (!lastAt || Number.isNaN(lastAt.getTime())) {
    return { lastReviewedAt: null, lastReviewedBy: null, note: null, nextDueAt: null, overdue: true };
  }
  const due = new Date(lastAt.getTime() + REVIEW_INTERVAL_DAYS * 24 * 60 * 60 * 1000);
  return {
    lastReviewedAt: lastAt.toISOString(),
    lastReviewedBy: latest.reviewer_username || null,
    note: latest.note || null,
    nextDueAt: due.toISOString(),
    overdue: now.getTime() >= due.getTime(),
  };
}

function toAdmin(row) {
  const role = roleOf(row);
  return {
    id: Number(row.id),
    username: row.username,
    role,
    accountCreatedAt: iso(row.created_at),
    roleSetAt: iso(row.role_set_at),
    roleSetBy: row.role_set_by || null,
    lastSignInAt: iso(row.last_sign_in_at),
    lastDatabaseExportAt: iso(row.last_database_export_at),
    capabilities: capabilitiesFor(role),
  };
}

async function listAdmins(db) {
  const { rows } = await db.query(
    `SELECT u.id, u.username, u.is_admin, u.admin_readonly, u.created_at,
            rc.changed_at AS role_set_at,
            setter.username AS role_set_by,
            (SELECT MAX(s.created_at) FROM sessions s
              WHERE s.user_id = u.id AND s.expires_at > NOW()) AS last_sign_in_at,
            (SELECT MAX(x.requested_at) FROM db_exports x
              WHERE x.user_id = u.id AND x.status = 'completed') AS last_database_export_at
       FROM users u
       LEFT JOIN LATERAL (
         SELECT c.changed_at, c.changed_by
           FROM admin_role_changes c
          WHERE c.user_id = u.id
          ORDER BY c.changed_at DESC, c.id DESC
          LIMIT 1
       ) rc ON TRUE
       LEFT JOIN users setter ON setter.id = rc.changed_by
      WHERE u.is_admin = TRUE
      ORDER BY u.admin_readonly ASC, u.username ASC`
  );
  return rows.map(toAdmin);
}

async function latestReview(db) {
  const { rows } = await db.query(
    `SELECT r.id, r.reviewed_at, r.full_admins, r.view_only_admins, r.note,
            reviewer.username AS reviewer_username
       FROM admin_access_reviews r
       LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by
      ORDER BY r.reviewed_at DESC, r.id DESC
      LIMIT 1`
  );
  return rows[0] || null;
}

async function report(db, { now = new Date() } = {}) {
  const [admins, latest] = await Promise.all([listAdmins(db), latestReview(db)]);
  return {
    reviewIntervalDays: REVIEW_INTERVAL_DAYS,
    admins,
    counts: {
      full: admins.filter((a) => a.role === ROLE_FULL).length,
      viewOnly: admins.filter((a) => a.role === ROLE_VIEW).length,
    },
    review: reviewStatus(latest, now),
  };
}

function normaliseNote(note) {
  if (note == null) return { ok: true, value: null };
  if (typeof note !== 'string') return { ok: false, error: 'note must be text' };
  const trimmed = note.trim();
  if (trimmed.length > NOTE_MAX) return { ok: false, error: `note must be at most ${NOTE_MAX} characters` };
  return { ok: true, value: trimmed || null };
}

// Records that `reviewerId` reviewed the list as it stands now. The list is
// read in the same statement that stores it, so the record is exactly what
// was on the books at that moment.
async function recordReview(db, { reviewerId, note = null }) {
  const { rows } = await db.query(
    `WITH current_admins AS (
       SELECT u.id, u.admin_readonly
         FROM users u
        WHERE u.is_admin = TRUE
     )
     INSERT INTO admin_access_reviews (reviewed_by, full_admins, view_only_admins, admins, note)
     SELECT $1,
            (SELECT COUNT(*)::int FROM current_admins WHERE admin_readonly = FALSE),
            (SELECT COUNT(*)::int FROM current_admins WHERE admin_readonly = TRUE),
            COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'id', id,
                        'role', CASE WHEN admin_readonly THEN 'view_admin' ELSE 'admin' END)
                      ORDER BY id)
                        FROM current_admins), '[]'::jsonb),
            $2
     RETURNING id, reviewed_at, full_admins, view_only_admins`,
    [reviewerId, note]
  );
  return rows[0];
}

// One row per role set through the console. Called after the role write
// has committed; the caller decides what a failure here means.
async function recordRoleChange(db, { userId, role, changedBy }) {
  await db.query(
    `INSERT INTO admin_role_changes (user_id, role, changed_by)
     VALUES ($1, $2, $3)`,
    [userId, role, changedBy]
  );
}

module.exports = {
  REVIEW_INTERVAL_DAYS,
  NOTE_MAX,
  roleOf,
  capabilitiesFor,
  reviewStatus,
  listAdmins,
  latestReview,
  report,
  normaliseNote,
  recordReview,
  recordRoleChange,
};
