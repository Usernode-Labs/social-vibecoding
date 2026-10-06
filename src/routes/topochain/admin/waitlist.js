// Topochain v4 admin API — platform waitlist + block-producer queue
// (onboarding flow alignment). Reads are covered by the router-wide
// `adminReadGate` applied in ../admin.js; every mutating route is gated
// by `adminWriteGate`, matching users.js.
//
// Two queues, two release actions:
//   - Platform waitlist (`waitlist_signups`, keyed by EMAIL): "release"
//     marks the row released and grants `has_platform_access` to the
//     linked account if one exists — otherwise the grant happens
//     automatically when the email registers (services/waitlist.js).
//   - Block-producer queue (`users.bp_requested_at`): "release" sets
//     `bp_released_at`, which is what lets the mobile node enable its
//     block producer (surfaced via GET /api/v4/mobile/me).
// Plus a direct per-user access grant for accounts that never joined
// the waitlist, and the switch for invite links skipping the waitlist
// (services/community-invites.js, the invite tree).
'use strict';

const { Router } = require('express');
const { getPool } = require('../../../db/pool');
const log = require('../../../services/logger');
const waitlist = require('../../../services/waitlist');
const firstSession = require('../../../services/first-session');
const { signalsFor } = require('../../../services/waitlist-signals');
const { sendWaitlistReleaseMail } = require('../../../services/topochain/mailer');
const { sendWaitlistReleaseSms } = require('../../../services/sms');
const { loadMobileAppUrls } = require('../../../services/mobile-store-links');
const { adminWriteGate } = require('./auth');
const { toIntId } = require('./util');
const { ok, fail, iso, paginate, meta, csvField } = require('../helpers');

function formatSignup(row) {
  return {
    id: Number(row.id),
    email: row.email,
    // A row is keyed by exactly one of these; the other is null. A phone
    // row shows the number, and the Details block reads the text's outcome
    // off `invite_text` instead of `invite_email`.
    phone_e164: row.phone_e164 ?? null,
    submitted_at: iso(row.submitted_at),
    released_at: iso(row.released_at),
    // NULL after a join means the address never followed the confirm link
    // in its mail — it was never proved able to receive mail at all, which
    // is worth seeing before releasing the row.
    confirmed_at: iso(row.confirmed_at),
    linked_user_id: row.linked_user_id != null ? Number(row.linked_user_id) : null,
    linked_username: row.linked_username ?? null,
    has_platform_access: row.has_platform_access ?? null,
    // The other half of the invite graph. `invited_count` (below, via
    // signals) says how many this row brought in; these two say who
    // brought THIS row in, which is the question an admin looking at a
    // referral chain actually has. The address is carried because the id
    // alone is unreadable on a screen that is keyed by email.
    invited_by: row.invited_by != null ? Number(row.invited_by) : null,
    invited_by_email: row.invited_by_email ?? null,
    // What happened to the "you're in" mail for an admitted row. Admitting
    // sends exactly one, and whether it actually left is otherwise
    // invisible here — an admin seeing "Admitted" with no mail behind it
    // was reading a half-finished action as a finished one. Null when
    // nothing was ever recorded, which is also every row in a staging
    // clone (mail_deliveries is staging:private).
    invite_email: row.invite_mail_status
      ? {
        status: row.invite_mail_status,
        created_at: iso(row.invite_mail_at),
        error: row.invite_mail_error ?? null,
      }
      : null,
    // The phone twin of invite_email: what happened to the "you're in" text
    // for an admitted phone row. Null when nothing was recorded (the
    // staging-clone shape, since sms_deliveries is staging:private).
    invite_text: row.invite_text_status
      ? {
        status: row.invite_text_status,
        created_at: iso(row.invite_text_at),
        error: row.invite_text_error ?? null,
      }
      : null,
    // Two-stage survey payload (versioned JSON — stage 1 at join, stage 2
    // merged in via the "Want in sooner?" form). Null for plain-email rows.
    answers: row.answers && typeof row.answers === 'object' ? row.answers : null,
    // What this signup actually DID, derived in one place
    // (services/waitlist-signals.js) so this screen and any future ranking
    // read the same facts. Facts only: there is deliberately no score.
    signals: signalsFor(row),
  };
}

// Escape LIKE metacharacters so a literal %, _ or \ typed into the search box
// matches itself rather than widening the match. Paired with an explicit
// ESCAPE '\' in the clause below (services/user-directory.js does the same).
function escapeLike(s) {
  return s.replace(/([\\%_])/g, '\\$1');
}

// Longest search the list accepts. Longer than any address (255), so it
// never truncates a real query; it only bounds what a pasted wall of text
// can make Postgres pattern-match against every row.
const SEARCH_MAX = 320;

// The `?status=` / `?only=` / `?q=` narrowing, shared by the list and the CSV
// export so a download always holds exactly the rows the screen's filters
// select. The status and only clauses are fixed literals chosen by an exact
// match; the search text is the one piece of request text, and it only ever
// reaches the SQL as a bound parameter. `firstParam` is the placeholder
// number that parameter takes, because the list query binds LIMIT and OFFSET
// ahead of it.
//
// The search matches the signup's address or its linked account's username,
// anywhere in either, case-insensitively. The username half is an EXISTS
// rather than a join so the count query, which has no join to users, can
// share the clause unchanged.
function waitlistWhere(query, firstParam = 1) {
  const status = typeof query.status === 'string' ? query.status : '';
  const only = typeof query.only === 'string' ? query.only : '';
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, SEARCH_MAX) : '';
  const clauses = [];
  const params = [];
  if (status === 'pending') clauses.push('w.released_at IS NULL');
  else if (status === 'released') clauses.push('w.released_at IS NOT NULL');
  if (only === 'confirmed') clauses.push('w.confirmed_at IS NOT NULL');
  else if (only === 'invited') {
    clauses.push('EXISTS (SELECT 1 FROM waitlist_signups c WHERE c.invited_by = w.id)');
  }
  if (q) {
    params.push(`%${escapeLike(q)}%`);
    const p = `$${firstParam}`;
    clauses.push(`(w.email ILIKE ${p} ESCAPE '\\'
                   OR EXISTS (SELECT 1 FROM users su
                               WHERE su.id = w.linked_user_id
                                 AND su.username ILIKE ${p} ESCAPE '\\'))`);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function plainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

// A handle as the file carries it: trimmed, and without a leading `@`
// (people type one into the self-reported fields; X's API never returns
// one), so a column can be matched against a list of handles directly.
function bareHandle(v) {
  return typeof v === 'string' ? v.trim().replace(/^@+/, '') : '';
}

// One export row, in file order (the header is EXPORT_HEADER). A verified
// handle is the one this SIGNUP proved through the waitlist's connect flow
// (answers.verified) first, and otherwise the identity connected on its
// linked ACCOUNT — `x_handle_source` says which, since only the first is
// the waitlist row's own claim.
//
// Every stage-1/stage-2 survey field the signup could have answered gets its
// own column (see services/waitlist-questions.js for the full shape): the
// "group" section covers what they're building and with whom
// (group_name/size/role/tools/need), and "loss" covers the platform-loss
// story (had_loss/loss_product/loss_kind/loss_story). Enum answers (group
// size/role/tools, loss had/kind) are exported as the raw stored code, same
// as `found_us` above, so the file matches what the row actually holds
// rather than a label that can be reworded later.
const EXPORT_HEADER = [
  'signup_id', 'email', 'phone', 'status', 'signed_up_at', 'confirmed_at', 'admitted_at',
  'admitted_notice', 'x_handle', 'x_handle_source', 'github_handle', 'linkedin_handle',
  'farcaster', 'discord', 'telegram', 'other_handle', 'referred_by_handle',
  'account_username', 'has_platform_access', 'came_from_email', 'brought_in',
  'country', 'city', 'found_us', 'found_us_detail', 'made_url', 'made_note',
  'group_name', 'group_size', 'group_role', 'group_tools', 'group_need',
  'had_loss', 'loss_product', 'loss_kind', 'loss_story', 'followed_claim',
];

function exportRow(r) {
  const a = plainObject(r.answers);
  const verified = plainObject(a.verified);
  const handles = plainObject(a.handles);
  const discovery = plainObject(a.discovery);
  const group = plainObject(a.group);
  const loss = plainObject(a.loss);
  const signupX = bareHandle(verified.x);
  const accountX = bareHandle(r.account_x_handle);
  // The channel the "you're in" notice went out on, as a plain word: a row is
  // keyed by exactly one of email/phone, so this reads the matching ledger.
  // Empty for a row still waiting (nothing was sent).
  const notice = r.released_at
    ? (r.phone_e164 ? (r.invite_text_status || '') : (r.invite_mail_status || ''))
    : '';
  return [
    Number(r.id),
    r.email,
    r.phone_e164 || '',
    r.released_at ? 'admitted' : 'waiting',
    iso(r.submitted_at),
    iso(r.confirmed_at),
    iso(r.released_at),
    notice,
    signupX || accountX,
    signupX ? 'waitlist' : (accountX ? 'account' : ''),
    bareHandle(verified.github) || bareHandle(r.account_github_handle),
    bareHandle(verified.linkedin),
    bareHandle(handles.farcaster),
    bareHandle(handles.discord),
    bareHandle(handles.telegram),
    bareHandle(handles.other),
    bareHandle(a.referrer_handle),
    r.linked_username || '',
    r.linked_username ? String(!!r.has_platform_access) : '',
    r.invited_by_email || '',
    Number(r.invited_count) || 0,
    a.country || '',
    a.city || '',
    discovery.source || '',
    discovery.detail || '',
    a.made_url || '',
    a.made_note || '',
    group.name || '',
    group.size || '',
    group.role || '',
    Array.isArray(group.tools) ? group.tools.join('; ') : '',
    group.need || '',
    loss.had || '',
    loss.product || '',
    Array.isArray(loss.kind) ? loss.kind.join('; ') : '',
    loss.story || '',
    a.followed_claim ? 'true' : '',
  ];
}

// The batch-admit tool's two bounds.
//
// RESOLVE_MAX bounds a lookup, which is read-only: two indexed ANY() queries
// over at most this many addresses.
//
// BULK_ADMIT_MAX is lower on purpose, because admitting mails. Every newly
// admitted row gets its "you're in" mail, and the platform's outbound
// ceiling (services/mail/rate-limit.js, DEFAULT_MAX_PER_HOUR = 300) is ONE
// budget shared by every kind of mail, login codes included. A batch that
// spent the whole hour's budget would silently stop everyone's sign-in
// codes until it rolled over. A hundred leaves most of it standing.
const RESOLVE_MAX = 500;
const BULK_ADMIT_MAX = 100;
// How many "you're in" mails a batch has in flight at once: enough that a
// hundred of them finish well inside a request timeout, few enough that the
// provider sees a trickle rather than a burst.
const BULK_MAIL_CONCURRENCY = 5;

// Run `fn` over `items` with at most `limit` calls in flight.
async function eachLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// One resolved row of a pasted list, in paste order. `match` is what the
// address turned out to be: `waiting` / `admitted` (a waitlist row, whose
// fields ride along as `signup`), `not_found` (no row — `account` then says
// whether a Homeroom account has the address anyway), or `invalid` (the
// join form's own rule rejects it).
function formatResolved(entry, signup, account) {
  const key = entry.phone || entry.email;
  if (!key) {
    return { input: entry.input, email: null, phone: null, match: 'invalid' };
  }
  const value = { input: entry.input, email: entry.email ?? null, phone: entry.phone ?? null };
  if (signup) {
    return {
      ...value,
      match: signup.released_at ? 'admitted' : 'waiting',
      signup: {
        id: Number(signup.id),
        email: signup.email,
        phone_e164: signup.phone_e164 ?? null,
        submitted_at: iso(signup.submitted_at),
        released_at: iso(signup.released_at),
        confirmed_at: iso(signup.confirmed_at),
        linked_username: signup.linked_username ?? null,
        has_platform_access: signup.has_platform_access ?? null,
      },
    };
  }
  return {
    ...value,
    match: 'not_found',
    account: account
      ? { username: account.username ?? null, has_platform_access: !!account.has_platform_access }
      : null,
  };
}

function formatBpUser(row) {
  return {
    id: Number(row.id),
    username: row.username,
    email: row.email,
    display_name: row.display_name,
    bp_requested_at: iso(row.bp_requested_at),
    bp_released_at: iso(row.bp_released_at),
    has_platform_access: row.has_platform_access,
  };
}

function waitlistAdminRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // "You're in" notification for a row admitting just released — first
  // release only (re-releases are idempotent no-ops and must not re-notify).
  // Channel-aware: a PHONE row with no email sends a text, everything else
  // sends the mail. A row is keyed by exactly one, so this is a property of
  // the row, never a preference to read at release. Degrades silently when
  // the channel's transport is unconfigured; never fails the release.
  // `mobile` is the store-listing lookup, done once by the caller so a batch
  // does not repeat it per row (and unused for a text, which has no room for
  // install steps).
  async function sendReleaseNotice(released, mobile) {
    if (released.phone_e164 && !released.email) {
      await sendWaitlistReleaseSms(config, released.phone_e164, {
        hasAccount: released.linked_user_id != null,
      });
      return;
    }
    await sendWaitlistReleaseMail(config, released.email, {
      mobile,
      hasAccount: released.linked_user_id != null,
      // #1548: lets the signup screen prefill the address and send the
      // code without a second step. An unguessable capability already
      // delivered to this address, so it carries nothing the recipient
      // does not already hold — and unlike the address itself it is safe
      // in a query string, which is what survives a link rewriter.
      moreToken: released.more_token || null,
    });
  }

  // The mail's mobile steps link the published store listings; a failed
  // lookup drops those steps rather than the mail or the release.
  function loadReleaseMailMobile() {
    return loadMobileAppUrls(pool).catch((err) => {
      log.error('topochain-admin', 'release mail mobile links failed', { message: err.message });
      return null;
    });
  }

  // ── GET /api/v4/admin/waitlist ────────────────────────────────────────
  // `?status=pending|released` filters; default lists everything,
  // pending first, oldest submission first within each group (FIFO —
  // the natural release order for a queue, and the only order this ships).
  //
  // `?only=confirmed|invited` narrows further, and `?sort=answered` is an
  // admin's manual lens over the same rows — how much someone filled in,
  // which is a coarse proxy and deliberately NOT a score. Nothing here
  // ranks the queue automatically.
  //
  // `?q=` searches the address and the linked username (see waitlistWhere).
  router.get('/api/v4/admin/waitlist', async (req, res) => {
    try {
      const { page, perPage } = paginate(req, { defaultPerPage: 200 });
      // The count binds only the search; the page query binds LIMIT and
      // OFFSET first, so its search parameter is $3.
      const countWhere = waitlistWhere(req.query);
      const where = waitlistWhere(req.query, 3);

      // The key count is computed in SQL rather than from signalsFor
      // because the list is PAGINATED: sorting the 200 rows a page happens
      // to contain would order each page against itself. jsonb_object_keys
      // rejects a non-object and these rows come from a public endpoint
      // across several schema versions, so the typeof guard is
      // load-bearing. `_version` is counted along with the real sections;
      // for a coarse ordering that is fine.
      const answeredCount = `
        CASE WHEN jsonb_typeof(w.answers) = 'object'
             THEN (SELECT COUNT(*) FROM jsonb_object_keys(w.answers))
             ELSE 0 END`;
      const order = req.query.sort === 'answered'
        ? `ORDER BY (w.released_at IS NOT NULL),
                    (w.confirmed_at IS NOT NULL) DESC,
                    ${answeredCount} DESC,
                    w.submitted_at ASC, w.id ASC`
        : 'ORDER BY (w.released_at IS NOT NULL), w.submitted_at ASC, w.id ASC';

      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM waitlist_signups w ${countWhere.sql}`,
        countWhere.params
      );
      const total = countRows[0].c;

      const { rows } = await pool.query(
        `SELECT w.id, w.email, w.phone_e164, w.submitted_at, w.released_at, w.confirmed_at,
                w.linked_user_id, w.answers, w.invited_by,
                (SELECT COUNT(*)::int FROM waitlist_signups c WHERE c.invited_by = w.id)
                  AS invited_count,
                p.email AS invited_by_email,
                u.username AS linked_username, u.has_platform_access,
                m.status AS invite_mail_status, m.created_at AS invite_mail_at,
                m.error AS invite_mail_error,
                s.status AS invite_text_status, s.created_at AS invite_text_at,
                s.error AS invite_text_error
           FROM waitlist_signups w
           LEFT JOIN users u ON u.id = w.linked_user_id
           LEFT JOIN waitlist_signups p ON p.id = w.invited_by
           LEFT JOIN LATERAL (
             SELECT d.status, d.created_at, d.error
               FROM mail_deliveries d
              WHERE d.recipient = w.email AND d.kind = 'waitlist_released'
              ORDER BY d.created_at DESC, d.id DESC
              LIMIT 1
           ) m ON TRUE
           LEFT JOIN LATERAL (
             SELECT sd.status, sd.created_at, sd.error
               FROM sms_deliveries sd
              WHERE sd.recipient = w.phone_e164 AND sd.kind = 'waitlist_released_sms'
              ORDER BY sd.created_at DESC, sd.id DESC
              LIMIT 1
           ) s ON TRUE
          ${where.sql}
          ${order}
          LIMIT $1 OFFSET $2`,
        [perPage, (page - 1) * perPage, ...where.params]
      );

      return ok(res, { data: rows.map(formatSignup) }, { meta: meta(page, perPage, total) });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/waitlist failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /api/v4/admin/waitlist/analytics ──────────────────────────────
  // Aggregate counts + a 30-day signup trend for the Analytics dashboard.
  // Read-only and cheap (a handful of aggregates plus one grouped count),
  // so it sits under the router-wide `adminReadGate` like the list route
  // above rather than `adminWriteGate` — nothing here exposes a row an
  // admin couldn't already see paging through the queue.
  //
  // Every figure is derived from columns the table actually has (no
  // invented "status" enum): `released_at` is waiting vs. admitted,
  // `confirmed_at` is whether the signup ever proved it could receive
  // mail, `linked_user_id` is whether a platform account is attached.
  router.get('/api/v4/admin/waitlist/analytics', async (req, res) => {
    try {
      const { rows: totalsRows } = await pool.query(
        `SELECT COUNT(*)::int AS "totalSignups",
                COUNT(*) FILTER (WHERE released_at IS NULL)::int AS waiting,
                COUNT(*) FILTER (WHERE released_at IS NOT NULL)::int AS admitted,
                COUNT(*) FILTER (WHERE confirmed_at IS NOT NULL)::int AS confirmed,
                COUNT(*) FILTER (WHERE linked_user_id IS NOT NULL)::int AS linked
           FROM waitlist_signups`
      );
      const totals = totalsRows[0];

      // 30-day daily trend, zero-filled so a quiet day is a real zero
      // rather than a missing point the chart would have to skip.
      const days = 30;
      const { rows: dailyRows } = await pool.query(
        `SELECT to_char(date_trunc('day', submitted_at), 'YYYY-MM-DD') AS day,
                COUNT(*)::int AS count
           FROM waitlist_signups
          WHERE submitted_at >= NOW() - $1::interval
          GROUP BY 1`,
        [`${days} days`]
      );
      const byDay = new Map(dailyRows.map((r) => [r.day, r.count]));
      const series = [];
      for (let i = days - 1; i >= 0; i -= 1) {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - i);
        const day = d.toISOString().slice(0, 10);
        series.push({ day, count: byDay.get(day) || 0 });
      }

      return ok(res, {
        data: {
          totalSignups: totals.totalSignups,
          waiting: totals.waiting,
          admitted: totals.admitted,
          confirmed: totals.confirmed,
          linked: totals.linked,
          series,
        },
      });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/waitlist/analytics failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /api/v4/admin/waitlist/export-csv ─────────────────────────────
  // Every signup the `?status=` / `?only=` / `?q=` filters select, unpaginated, as
  // a CSV — newest signup first, which is the order someone cross-checking
  // recent requests for access wants. Carries the X handle a signup
  // connected (see exportRow for where it is read from).
  //
  // `adminWriteGate` on a GET, for the reason users.js's export-csv gives:
  // a view-only admin can read these rows page by page, but walking away
  // with the whole list as a file is a different exposure class.
  router.get('/api/v4/admin/waitlist/export-csv', adminWriteGate, async (req, res) => {
    try {
      const where = waitlistWhere(req.query);
      const { rows } = await pool.query(
        `SELECT w.id, w.email, w.phone_e164, w.submitted_at, w.released_at, w.confirmed_at,
                w.answers,
                (SELECT COUNT(*)::int FROM waitlist_signups c WHERE c.invited_by = w.id)
                  AS invited_count,
                p.email AS invited_by_email,
                u.username AS linked_username, u.has_platform_access,
                sx.handle AS account_x_handle,
                sg.handle AS account_github_handle,
                m.status AS invite_mail_status,
                s.status AS invite_text_status
           FROM waitlist_signups w
           LEFT JOIN users u ON u.id = w.linked_user_id
           LEFT JOIN waitlist_signups p ON p.id = w.invited_by
           LEFT JOIN user_social_identities sx
             ON sx.user_id = w.linked_user_id AND sx.provider = 'x'
           LEFT JOIN user_social_identities sg
             ON sg.user_id = w.linked_user_id AND sg.provider = 'github'
           LEFT JOIN LATERAL (
             SELECT d.status FROM mail_deliveries d
              WHERE d.recipient = w.email AND d.kind = 'waitlist_released'
              ORDER BY d.created_at DESC, d.id DESC LIMIT 1
           ) m ON TRUE
           LEFT JOIN LATERAL (
             SELECT sd.status FROM sms_deliveries sd
              WHERE sd.recipient = w.phone_e164 AND sd.kind = 'waitlist_released_sms'
              ORDER BY sd.created_at DESC, sd.id DESC LIMIT 1
           ) s ON TRUE
          ${where.sql}
          ORDER BY w.submitted_at DESC, w.id DESC`,
        where.params
      );

      const status = req.query.status === 'pending' || req.query.status === 'released'
        ? req.query.status : 'all';
      const day = new Date().toISOString().slice(0, 10);
      res.status(200);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="waitlist-${status}-${day}.csv"`);
      res.write(`${EXPORT_HEADER.join(',')}\n`);
      for (const r of rows) {
        res.write(`${exportRow(r).map(csvField).join(',')}\n`);
      }
      return res.end();
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/waitlist/export-csv failed', { message: err.message });
      if (!res.headersSent) return fail(res, 500, 'Internal server error.');
      return res.end();
    }
  });

  // ── POST /api/v4/admin/waitlist/:id/release ──────────────────────────
  // Idempotent: re-releasing keeps the original released_at. Works with
  // or without a linked account (see services/waitlist.js).
  router.post('/api/v4/admin/waitlist/:id/release', adminWriteGate, async (req, res) => {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'Waitlist entry not found.');
      const released = await waitlist.releaseWaitlistSignup(pool, id);
      if (!released) return fail(res, 404, 'Waitlist entry not found.');
      log.info('topochain-admin', 'Waitlist entry released', {
        signupId: id, linkedUserId: released.linked_user_id, adminId: req.user?.id,
      });
      if (released.newly_released) {
        await sendReleaseNotice(released, await loadReleaseMailMobile());
      }
      return ok(res, {
        data: {
          id: Number(released.id),
          email: released.email,
          released_at: iso(released.released_at),
          linked_user_id: released.linked_user_id != null ? Number(released.linked_user_id) : null,
        },
      });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/waitlist/:id/release failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /api/v4/admin/waitlist/resolve ───────────────────────────────
  // The batch-admit tool's lookup. Takes `{ text }`, a pasted list of
  // addresses AND/OR phone numbers (see waitlist.parseEmailList for what it
  // accepts), and says
  // what each one is: a waiting row, an admitted row, no row at all (and
  // whether an account has the address anyway), or not an address. Changes
  // nothing — admitting is the separate bulk-release call, on the ids this
  // returns.
  //
  // `adminWriteGate` although it only reads, for the export's reason: the
  // tool exists to admit, which only a write admin can do, and answering
  // "which of these 500 addresses are on the waitlist" in one call is a
  // bulk-membership lookup a view-only admin has no use for.
  router.post('/api/v4/admin/waitlist/resolve', adminWriteGate, async (req, res) => {
    try {
      const { entries, skipped, duplicates } = waitlist.parseEmailList(req.body?.text);
      if (!entries.length) return fail(res, 422, 'No email addresses or phone numbers found in what was pasted.');
      if (entries.length > RESOLVE_MAX) {
        return fail(res, 422, `Paste at most ${RESOLVE_MAX} keys at a time (this has ${entries.length}).`);
      }
      // A pasted list may be addresses, numbers, or both. Each key is looked
      // up on ITS OWN column, so the two never cross: an address never
      // matches a phone row and vice versa.
      const emails = entries.map((e) => e.email).filter(Boolean);
      const phones = entries.map((e) => e.phone).filter(Boolean);
      const { rows: signups } = (emails.length || phones.length)
        ? await pool.query(
          `SELECT w.id, w.email, w.phone_e164, w.submitted_at, w.released_at, w.confirmed_at,
                  u.username AS linked_username, u.has_platform_access
             FROM waitlist_signups w
             LEFT JOIN users u ON u.id = w.linked_user_id
            WHERE w.email = ANY($1::text[]) OR w.phone_e164 = ANY($2::text[])`,
          [emails, phones]
        )
        : { rows: [] };
      const bySignupEmail = new Map(signups.filter((s) => s.email).map((s) => [s.email, s]));
      const bySignupPhone = new Map(signups.filter((s) => s.phone_e164).map((s) => [s.phone_e164, s]));
      // Keys with no row may still belong to an account — somebody who
      // signed up another way. Worth saying: admitting cannot reach them,
      // and one that already has access needs nothing at all. An email is
      // matched on the users table; a number on user_phone_identities.
      const missingEmails = emails.filter((e) => !bySignupEmail.has(e));
      const missingPhones = phones.filter((p) => !bySignupPhone.has(p));
      const { rows: accounts } = missingEmails.length
        ? await pool.query(
          `SELECT lower(email) AS email, username, has_platform_access
             FROM users
            WHERE lower(email) = ANY($1::text[])`,
          [missingEmails]
        )
        : { rows: [] };
      const { rows: phoneAccounts } = missingPhones.length
        ? await pool.query(
          `SELECT phi.phone_e164, u.username, u.has_platform_access
             FROM user_phone_identities phi
             JOIN users u ON u.id = phi.user_id
            WHERE phi.phone_e164 = ANY($1::text[])`,
          [missingPhones]
        )
        : { rows: [] };
      const byAccount = new Map(accounts.map((a) => [a.email, a]));
      const byPhoneAccount = new Map(phoneAccounts.map((a) => [a.phone_e164, a]));
      const data = entries.map((e) => formatResolved(
        e,
        e.phone ? bySignupPhone.get(e.phone) : (e.email ? bySignupEmail.get(e.email) : null),
        e.phone ? byPhoneAccount.get(e.phone) : (e.email ? byAccount.get(e.email) : null),
      ));
      // `admit_max` travels with the answer so the screen can size its Admit
      // button to the bound bulk-release enforces without a copy of it.
      return ok(res, { data: { entries: data, skipped, duplicates, admit_max: BULK_ADMIT_MAX } });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/waitlist/resolve failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /api/v4/admin/waitlist/bulk-release ──────────────────────────
  // Admits several signups at once — the batch-admit tool's "Admit all".
  // Each id goes through the same releaseWaitlistSignup as the single route,
  // so everything admitting one row does (the access grant, the account
  // backfill, the invite tree's skips) happens per row here too, and each
  // newly admitted row gets its one "you're in" mail. Already-admitted ids
  // are idempotent no-ops and are not mailed again; ids that don't parse or
  // don't exist are skipped. The response counts each outcome.
  //
  // One row failing does not abandon the rest: the rows before it are
  // already admitted, and stopping there would leave them admitted but
  // unmailed.
  router.post('/api/v4/admin/waitlist/bulk-release', adminWriteGate, async (req, res) => {
    try {
      const raw = Array.isArray(req.body?.ids) ? req.body.ids : [];
      const ids = [...new Set(raw.map(toIntId).filter((n) => n != null))];
      if (!ids.length) return fail(res, 422, 'No valid waitlist entry ids given.');
      if (ids.length > BULK_ADMIT_MAX) {
        return fail(res, 422, `Admit at most ${BULK_ADMIT_MAX} signups at a time (this has ${ids.length}).`);
      }

      const fresh = [];
      const already = [];
      const missing = [];
      const failed = [];
      for (const id of ids) {
        try {
          const released = await waitlist.releaseWaitlistSignup(pool, id);
          if (!released) missing.push(id);
          else if (released.newly_released) fresh.push(released);
          else already.push(id);
        } catch (err) {
          log.error('topochain-admin', 'bulk release: one entry failed', { signupId: id, message: err.message });
          failed.push(id);
        }
      }

      if (fresh.length) {
        const mobile = await loadReleaseMailMobile();
        await eachLimit(fresh, BULK_MAIL_CONCURRENCY, (released) => sendReleaseNotice(released, mobile));
      }

      log.info('topochain-admin', 'Waitlist entries bulk-released', {
        signupIds: fresh.map((r) => Number(r.id)),
        alreadyAdmitted: already.length,
        missing: missing.length,
        failed: failed.length,
        adminId: req.user?.id,
      });
      return ok(res, {
        data: {
          admitted: fresh.map((r) => Number(r.id)),
          already_admitted: already,
          not_found: missing,
          failed,
        },
      });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/waitlist/bulk-release failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── DELETE /api/v4/admin/waitlist/:id ─────────────────────────────────
  // Removes one signup outright. `invited_by` is self-referential with
  // ON DELETE SET NULL, so deleting a row that referred others clears
  // their invited_by rather than failing or cascading further.
  router.delete('/api/v4/admin/waitlist/:id', adminWriteGate, async (req, res) => {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'Waitlist entry not found.');
      const { rows } = await pool.query(
        'DELETE FROM waitlist_signups WHERE id = $1 RETURNING id, email',
        [id]
      );
      if (!rows.length) return fail(res, 404, 'Waitlist entry not found.');
      log.info('topochain-admin', 'Waitlist entry deleted', {
        signupId: id, email: rows[0].email, adminId: req.user?.id,
      });
      return ok(res, { data: { id: Number(rows[0].id) } });
    } catch (err) {
      log.error('topochain-admin', 'DELETE /admin/waitlist/:id failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /api/v4/admin/waitlist/bulk-delete ───────────────────────────
  // Deletes several signups at once, for the queue's multi-select. Ids
  // that don't parse or don't exist are silently skipped; the response
  // says how many rows were actually removed.
  router.post('/api/v4/admin/waitlist/bulk-delete', adminWriteGate, async (req, res) => {
    try {
      const raw = Array.isArray(req.body?.ids) ? req.body.ids : [];
      const ids = [...new Set(raw.map(toIntId).filter((n) => n != null))];
      if (!ids.length) return fail(res, 422, 'No valid waitlist entry ids given.');
      const { rows } = await pool.query(
        'DELETE FROM waitlist_signups WHERE id = ANY($1::bigint[]) RETURNING id',
        [ids]
      );
      log.info('topochain-admin', 'Waitlist entries bulk-deleted', {
        signupIds: rows.map((r) => Number(r.id)), adminId: req.user?.id,
      });
      return ok(res, { data: { deleted: rows.length } });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/waitlist/bulk-delete failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /api/v4/admin/users/:id/grant-access ────────────────────────
  // Direct platform-access grant for an account that never joined the
  // waitlist. Idempotent. A release by hand like Admit, so the account it
  // lets in gets the invite tree's generation-0 skips.
  router.post('/api/v4/admin/users/:id/grant-access', adminWriteGate, async (req, res) => {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'User not found.');
      const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [id]);
      if (!rows.length) return fail(res, 404, 'User not found.');
      await waitlist.grantPlatformAccess(pool, id, { manualRelease: true });
      log.info('topochain-admin', 'Platform access granted directly', { userId: id, adminId: req.user?.id });
      return ok(res, { data: { id, has_platform_access: true } });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/users/:id/grant-access failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET / PUT /api/v4/admin/story-landing ────────────────────────────
  // Whether the signed-out landing tells the first-session story and asks
  // people to get started, instead of pointing at the waitlist
  // (services/first-session.js). On unless switched off here.
  const formatStory = (s) => ({ enabled: s.enabled, updated_at: iso(s.updatedAt), updated_by: s.updatedBy });
  router.get('/api/v4/admin/story-landing', async (req, res) => {
    try {
      return ok(res, { data: formatStory(await firstSession.readStorySetting(pool)) });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/story-landing failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  router.put('/api/v4/admin/story-landing', adminWriteGate, async (req, res) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') return fail(res, 422, 'Provide enabled: true or false.');
    try {
      await firstSession.setStoryLanding(pool, { enabled, actorId: req.user?.id ?? null });
      log.info('topochain-admin', 'Story landing switched', { enabled, adminId: req.user?.id });
      return ok(res, { data: formatStory(await firstSession.readStorySetting(pool)) });
    } catch (err) {
      log.error('topochain-admin', 'PUT /admin/story-landing failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /api/v4/admin/bp-queue ────────────────────────────────────────
  // Users who asked to produce blocks. `?status=pending|released`;
  // default everything, pending first, oldest request first.
  router.get('/api/v4/admin/bp-queue', async (req, res) => {
    try {
      const { page, perPage } = paginate(req, { defaultPerPage: 200 });
      const status = typeof req.query.status === 'string' ? req.query.status : '';
      let where = 'WHERE bp_requested_at IS NOT NULL';
      if (status === 'pending') where += ' AND bp_released_at IS NULL';
      else if (status === 'released') where += ' AND bp_released_at IS NOT NULL';

      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM users ${where}`
      );
      const total = countRows[0].c;

      const { rows } = await pool.query(
        `SELECT id, username, email, display_name, bp_requested_at, bp_released_at,
                has_platform_access
           FROM users ${where}
          ORDER BY (bp_released_at IS NOT NULL), bp_requested_at ASC, id ASC
          LIMIT $1 OFFSET $2`,
        [perPage, (page - 1) * perPage]
      );

      return ok(res, { data: rows.map(formatBpUser) }, { meta: meta(page, perPage, total) });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/bp-queue failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /api/v4/admin/users/:id/release-bp ──────────────────────────
  // Manual block-producer key release. Idempotent. Allowed even if the
  // user never formally requested (bp_requested_at is backfilled) so an
  // admin can hand-pick producers.
  router.post('/api/v4/admin/users/:id/release-bp', adminWriteGate, async (req, res) => {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'User not found.');
      const { rows } = await pool.query(
        `UPDATE users
            SET bp_requested_at = COALESCE(bp_requested_at, NOW()),
                bp_released_at = COALESCE(bp_released_at, NOW())
          WHERE id = $1
          RETURNING id, username, email, display_name, bp_requested_at, bp_released_at,
                    has_platform_access`,
        [id]
      );
      if (!rows.length) return fail(res, 404, 'User not found.');
      log.info('topochain-admin', 'Block production released', { userId: id, adminId: req.user?.id });
      return ok(res, { data: formatBpUser(rows[0]) });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/users/:id/release-bp failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  return router;
}

module.exports = { waitlistAdminRoutes, RESOLVE_MAX, BULK_ADMIT_MAX };
