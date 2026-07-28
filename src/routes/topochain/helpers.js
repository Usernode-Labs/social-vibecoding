// Shared response/serialization helpers for every /api/v4 (topochain)
// route module — implements the v4 contract standardizations (SPEC §4.8,
// lines 883-895) that apply to EVERY endpoint in the five groups (public,
// partner, ingest, mobile, admin):
//
//   1. One success envelope, one error envelope (`ok` / `fail` below).
//   2. Dates serialize as ISO-8601 WITH a numeric offset, never the bare
//      `Z` suffix Node's `Date#toISOString` produces (`iso`).
//   3. Decimal-cast Postgres columns (points, totals, …) serialize as JSON
//      numbers, not strings (`num`).
//   4. One pagination envelope everywhere, with `per_page` validated to
//      1..100 so a `per_page=0` can never division-by-zero the caller the
//      way the source system did (`paginate` / `meta`).
//
// Route modules under src/routes/topochain/ require this file; nothing
// here talks to the database or Express directly beyond `res`.

'use strict';

// ─── Error shape ────────────────────────────────────────────────────────
//
// `paginate()` needs a way to signal a validation failure (bad per_page)
// without every caller re-deriving the 422 envelope by hand. We picked
// "throw a typed error, let the route's existing try/catch turn it into a
// response" over "return a discriminated {error} object the caller must
// check" — every topochain route already wraps its body in try/catch and
// funnels unexpected errors through `fail`, so a thrown ValidationError
// slots into that same catch block with one extra `instanceof` check
// (see the route template used by Tasks 5-13). Documented here since the
// brief allows either shape.
class ValidationError extends Error {
  constructor(message, { details, code } = {}) {
    super(message);
    this.name = 'ValidationError';
    this.status = 422;
    this.details = details;
    this.code = code;
  }
}

// ─── Envelopes (SPEC §4.8 item 3) ───────────────────────────────────────

// Success: {"success": true, ...data, ...extra}. `data` and `extra` are
// merged flat rather than nested under a fixed key because different v4
// groups shape their payload differently (e.g. admin group's own
// convention is a single top-level `data` key per SPEC 2195 — a caller
// gets that by passing `ok(res, { data: rows })`; a leaderboard endpoint
// instead passes `ok(res, { leaderboard: rows }, { meta })`). Status
// defaults to 200; call `res.status(201)` before `ok(...)` for other
// codes (Express's `res.status()` returns `res`, so this composes: `ok(res.status(201), data)`).
function ok(res, data = {}, extra = {}) {
  return res.json({ success: true, ...data, ...extra });
}

// Error: the ONE v4 error envelope (SPEC §4.8 item 3), replacing the
// source's three coexisting shapes. `details` (field -> [messages]) and
// `code` (machine-readable tag) are both optional and omitted entirely
// (not sent as null) when not provided, so clients can do a plain
// `'details' in body` check.
function fail(res, status, error, { details, code } = {}) {
  const body = { success: false, error };
  if (details !== undefined) body.details = details;
  if (code !== undefined) body.code = code;
  return res.status(status).json(body);
}

// ─── Dates (SPEC §4.8 item 4) ───────────────────────────────────────────

// ISO-8601 with an explicit numeric offset, e.g. "2026-07-27T12:00:00.000+00:00".
// `Date#toISOString()` always renders UTC but suffixes it "Z"; every
// timestamp this platform stores/reads is UTC (TIMESTAMPTZ columns, `pg`
// hands back JS Date objects representing the same instant regardless of
// server tz), so swapping the suffix is sufficient — there is no
// non-UTC offset to compute. Returns null for anything that isn't a
// valid date (including null/undefined input) so callers can pass
// possibly-absent DB columns straight through.
function iso(date) {
  if (date == null) return null;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace('Z', '+00:00');
}

// ─── Numbers (SPEC §4.8 item 5) ─────────────────────────────────────────

// `pg` returns NUMERIC/DECIMAL columns as strings (to avoid silent
// float-precision loss); v4 deliberately serializes them as JSON numbers
// instead (a breaking-but-intentional change vs the source, which sent
// `"10.00"`). Null-safe: a missing/null decimal stays null rather than
// becoming 0 or NaN.
function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

// ─── Pagination (SPEC §4.8 item 6) ──────────────────────────────────────

const DEFAULT_PAGE = 1;
const DEFAULT_PER_PAGE = 25;
const MIN_PER_PAGE = 1;
const MAX_PER_PAGE = 100;

// Reads `page`/`per_page` query params off `req` and returns a validated
// `{page, perPage}`. `page` is clamped to >= 1 (a stray `page=0` or
// `page=-3` just becomes page 1 — there's nothing unsafe about it, unlike
// per_page). `per_page` is validated strictly to the 1..100 range: this is
// the fix for the source's `per_page=0` division-by-zero 500 (SPEC §4.8
// item 6), so an out-of-range or non-numeric value throws a
// ValidationError (422) rather than being silently clamped.
//
// `defaultPerPage` lets one call site override the "no per_page given"
// default without changing it for every other v4 endpoint sharing this
// helper: most endpoints don't specify a per-source default (this repo's
// own DEFAULT_PER_PAGE = 25 applies), but a handful of SPEC endpoints DO
// pin an explicit source default (e.g. GET /leaderboard and
// /leaderboard/global both say "default 50", SPEC 912/975) — those call
// sites pass `{ defaultPerPage: 50 }` rather than relitigating the shared
// constant for every route.
function paginate(req, { defaultPerPage = DEFAULT_PER_PAGE } = {}) {
  const rawPage = req?.query?.page;
  const rawPerPage = req?.query?.per_page;

  let page = DEFAULT_PAGE;
  if (rawPage !== undefined && rawPage !== '') {
    const n = parseInt(rawPage, 10);
    page = Number.isInteger(n) && n >= 1 ? n : DEFAULT_PAGE;
  }

  let perPage = defaultPerPage;
  if (rawPerPage !== undefined && rawPerPage !== '') {
    const n = parseInt(rawPerPage, 10);
    if (!Number.isInteger(n) || String(n) !== String(rawPerPage).trim() || n < MIN_PER_PAGE || n > MAX_PER_PAGE) {
      throw new ValidationError('The per_page field must be between 1 and 100.', {
        details: { per_page: ['The per_page field must be between 1 and 100.'] },
        code: 'invalid_per_page',
      });
    }
    perPage = n;
  }

  return { page, perPage };
}

// The flat pagination envelope shared by every paginated v4 endpoint
// (SPEC §4.8 item 6): `meta: {page, per_page, total, total_pages}`.
// `perPage` is guaranteed >= 1 by `paginate()` above, so this never
// divides by zero the way the source's unvalidated per_page could.
// total_pages is 0 for an empty result set (no pages exist), matching
// `total` rather than reporting a phantom page 1.
function meta(page, perPage, total) {
  return {
    page,
    per_page: perPage,
    total,
    total_pages: Math.ceil(total / perPage),
  };
}

module.exports = { ok, fail, iso, num, paginate, meta, ValidationError };
