# Report locking, history, public sharing, and bullet highlights — design

Date: 2026-08-11
Status: approved
Branch: `feature/report-lock-share`

## Context

The Reporting tab (dev board `#app/<slug>/dev`, view mode `report`) gained an
AI-generated summary in #1106: narrative, risks, and work-by-owner, cached as a
single row per app in `app_report_ai`. Regeneration overwrites that row in
place — there is no history, no way to preserve a milestone report, and no way
to show a report to someone outside the platform.

This design adds:

1. A **Lock report** button that freezes the current report as an immutable,
   dated snapshot.
2. **Generation based on the last report**: the newest locked snapshot's AI
   summary is fed into the next generation so it highlights progress since.
3. Every locked report saved with its **date/time**, listed **by date** in the
   Reporting tab.
4. **Bullet-point progress highlights** in the AI summary for easy reading.
5. A **public share link** per locked report, viewable by anyone with the URL.

Decisions made during brainstorming:

- Lock = freeze a snapshot. Regeneration keeps overwriting the current draft
  (today's behaviour); only locking creates a permanent entry. The history
  list contains locked reports only.
- Share links point to a **specific locked report**, never the live draft.
- **App admins only** (`apps.admin_usernames` via `src/services/app-admins.js`,
  plus platform admins) may lock, share, and unshare. Viewers keep today's
  ability to read and regenerate the draft.
- Storage approach: **client-posted HTML snapshot + capability URL** (approach
  A). The client already renders a fully self-contained standalone report
  (`_renderReportHtml(model, { standalone: true })`, used by the download
  button; `tests/dev-report.test.js` asserts it contains no `<script>`,
  `<img>`, or `<link>`). Locking posts that HTML; the public route serves it
  under a sandbox CSP. One renderer, byte-exact fidelity with what the admin
  saw.

## Data model

One new table, appended idempotently to `src/db/schema.sql` (project
convention — no migrations directory):

```sql
CREATE TABLE IF NOT EXISTS app_report_snapshots (
  id           SERIAL PRIMARY KEY,
  app_id       INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  html         TEXT NOT NULL,
  ai_json      JSONB,
  locked_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  locked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  share_token  VARCHAR(64) UNIQUE,
  shared_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_app_report_snapshots_app
  ON app_report_snapshots (app_id, locked_at DESC);
```

- `html` — the self-contained standalone report document posted at lock time.
- `ai_json` — the structured AI summary (narrative, highlights, risks, owners,
  model, generated_at) captured at lock time; input for the next generation.
  NULL when the report was locked before any AI summary existed.
- `share_token` — 32-hex capability token; NULL means not shared. Unsharing
  sets it back to NULL (revocation; old links 404).
- `app_report_ai` (the single-row draft cache) is unchanged.

## Backend

New `src/routes/report-snapshots.js`, mounted in `server.js` after
`authMiddleware` alongside `report-ai.js`. All app resolution through
`appAccess.getAppForUser(pool, slug, req.user, 'view', APP_COLS)`; deny = 404.
Admin gate: `appAdmins.canManageApp(pool, app, req.user)` — platform admins,
the app creator, and declared app admins — the same gate every other
management action in the codebase uses; failure = 403.

| Route | Access | Behaviour |
| --- | --- | --- |
| `GET /api/apps/:slug/report-snapshots` | view | List `{ id, lockedAt, lockedBy (username), shared (bool), sharePath (when shared) }` ordered by `locked_at DESC`. Never returns `html`; the token appears only as `sharePath` on already-shared rows. |
| `POST /api/apps/:slug/report-snapshots` | app admin | Body `{ html }` only — `ai_json` is never taken from the client. It is read from the server's own `app_report_ai` draft cache at lock time (stronger than validating a client-posted `ai` shape), since that cache is exactly what the next generation's `previousReport` input consumes. Validates `html` is a string ≤ 2 MB. Inserts snapshot, `locked_at = NOW()`, `locked_by = user`. Rate-limited. |
| `GET /api/apps/:slug/report-snapshots/:id/html` | view | Serves the stored HTML (`text/html`) with the sandbox CSP below — in-app "Open" target. |
| `POST /api/apps/:slug/report-snapshots/:id/share` | app admin | Mints `crypto.randomBytes(16).toString('hex')` token if absent, sets `shared_at = NOW()`, returns `{ sharePath: "/reports/<token>" }`. Idempotent. |
| `POST /api/apps/:slug/report-snapshots/:id/unshare` | app admin | Sets `share_token = NULL, shared_at = NULL`. |

Public route, mounted **before** `authMiddleware` (same pattern and placement
as `src/routes/visuals.js`):

- `GET /reports/:token` — token must match `^[a-f0-9]{32}$`; look up by
  `share_token`; serve `html` as `text/html` with
  `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'`
  and `X-Content-Type-Options: nosniff`. Unknown or revoked token → 404.
  The sandbox CSP gives the document an opaque origin and blocks script
  execution, so hostile markup posted by a malicious admin cannot run code or
  reach the platform origin.

  During implementation review the serving CSP (used by both this route and
  the in-app `/html` route above) was amended to
  `sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none';
  style-src 'unsafe-inline'`. The two added tokens are the minimum needed to
  keep the report's `target="_blank"` links to GitHub/the app working:
  `allow-popups` lets those links open a tab at all, and
  `allow-popups-to-escape-sandbox` lets the opened tab run as a normal,
  unsandboxed page rather than inheriting the opaque origin. `allow-scripts`
  and `allow-same-origin` are deliberately still absent, so script execution
  stays blocked and the document itself stays unable to read platform
  cookies/storage.

Rate limiter: `reportSnapshotLimiter` (per-user, e.g. 10/min) added to
`src/middleware/rate-limits.js` **before** the `waitlistJoinLimiter,
mailTestLimiter` tail — `tests/admin-mail-console.test.js` pins
`mailTestLimiter }` as the last export.

Trust boundary: the posted `html` is treated as untrusted user content. Guards
are the size cap, the admin-only gate, and the sandbox CSP on every route that
serves it. The server never embeds this HTML into any other page.

## Generation based on the last report + bullet highlights

- `REPORT_SUMMARY_SCHEMA` (`src/services/llm.js`) gains
  `highlights: string[]` — 3–8 bullets, each a single sentence.
  `sanitizeReportSummary` caps: ≤ 8 items, each ≤ 200 chars, non-string items
  dropped; missing/empty array allowed (renderer skips the section).
- Prompt addition: produce concise progress bullets; when `previousReport` is
  present, focus the bullets and narrative on what changed **since that
  report's date**.
- `buildReportInput` (`src/services/report-ai.js`) adds
  `input.previousReport = { lockedAt (day granularity), narrative, highlights }`
  read from the newest snapshot for the app with `ai_json IS NOT NULL`
  (omitted when none). It participates in the canonical fingerprint, so locking a
  report makes the draft stale and regenerable — exactly the intended
  "each report builds on the last" loop.

## Frontend (`public/js/app-view.js` only)

The report subtree is 100% legacy-JS-rendered inside `#dev-body`; no
`frontend/` changes, no shell rebuild, no baseline edits, no new script file
(so no `SHELL_ASSETS` / `sw.js` / script-count changes).

- **Toolbar**: add `#dev-report-lock` ("Lock report") after the existing
  buttons, rendered only when the current user is an app admin (admin
  usernames are already available on the app payload; platform admin flag on
  the user). Click → ensure report data + AI are loaded → build
  `_renderReportHtml(model, { standalone: true, ai })` → POST → toast +
  refresh the snapshot list.
- **AI section**: `_renderReportAiHtml` renders a new
  `<section class="ur-rpt-section" data-section="ai-highlights">` containing a
  `<ul>` of the bullet highlights, placed above the narrative section. All
  text through `escapeHtml`.
- **Previous reports list**: new pure renderer
  `_renderReportSnapshotsHtml(snapshots, isAdmin)` producing a
  `data-section="snapshots"` block under the toolbar: one row per snapshot —
  `locked_at` via `toLocaleDateString()` + `toLocaleTimeString()` (matching
  existing report formatting), locker username, a "Shared" badge when shared,
  an **Open** link (new tab to the authenticated `/html` route), and for
  admins **Share** / **Unshare** actions plus a copy-link control showing the
  absolute public URL when shared. Fetched via a new
  `_ensureReportSnapshots()` (cached like `_reportAi`, reset in
  `_resetReportCaches()`).
- The current draft continues to show its `generated_at` date/time; locked
  entries carry their own `locked_at`.

## Error handling

- Lock with no AI summary yet: allowed — snapshot stores the plain progress
  report, `ai_json` NULL; next generation simply has no `previousReport`
  from it (falls back to the newest snapshot that has one — implemented as
  "newest snapshot where ai_json IS NOT NULL").
- Lock POST failures surface via `PlatformUI.toast` (same as generate).
- Oversized HTML → 413-style 400 with a clear error string.
- Public route never leaks whether a token existed (uniform 404).
- Share/unshare on a snapshot of another app → 404 via the app-scoped lookup
  (`WHERE id = $1 AND app_id = $2`).

## Testing

- **`tests/report-snapshots.test.js`** (new; harness copied from
  `tests/report-ai.test.js` — stubbed pool, ephemeral express app, real
  fetch): admin-only lock/share/unshare (403 for member, 404 for
  non-viewer), list shape and ordering, size cap, share token mint +
  idempotency, unshare revocation, public route serves HTML with the sandbox
  CSP header, 404 for unknown/revoked/malformed tokens, cross-app id
  isolation.
- **`tests/report-ai-llm.test.js`**: highlights sanitization (cap 8, length
  200, non-strings dropped, absent allowed).
- **`tests/report-ai.test.js`**: `previousReport` included in input and
  fingerprint when a snapshot exists.
- **`tests/dev-report.test.js`** (vm sandbox, pure renderers): lock button
  present for admins and absent otherwise, `ai-highlights` section markup,
  snapshots list rendering (dates, badges, admin actions), invariants (no
  inline handlers) extended to the new markup.
- Full `npm test` green, including `admin-mail-console.test.js` (limiter
  export order) and the shell/baseline suites (untouched by design).

## Out of scope (deliberate)

Editing or annotating locked reports; deleting snapshots; share-link expiry;
emailing reports; converting the report view to React; sharing the live
draft.
