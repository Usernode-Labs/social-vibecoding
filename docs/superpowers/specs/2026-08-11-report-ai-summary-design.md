# AI-generated progress report (Reporting tab v2)

Date: 2026-08-11
Status: approved (brainstormed interactively; user approved the design)
Branch: `report-ai-summary`

## Goal

The Reporting view (#1100) currently renders a deterministic, read-only
progress document (Done / In progress / Backlog). This feature adds an
LLM-generated layer on top, ordered as the user asked:

1. **AI narrative** — a simplified, human-readable "where this project
   stands" as the main body.
2. **Critical risks** — an LLM-flagged list (stalled reviews, failing
   checks, aging high-priority backlog, ownership concentration…).
3. **Work by owner** — one row per contributor with deterministic counts
   (completed / in review / in progress / assigned backlog) plus a
   one-sentence LLM blurb.
4. The existing deterministic task sections (Done / In progress /
   Backlog) — unchanged — then the footer.

The HTML export includes the AI sections when present.

## Decisions made during brainstorming

- **Generation model:** cached + explicit "Generate / Regenerate" button.
  Never auto-generated on tab visit.
- **Owner summary:** a section inside the same report (not a toggle, not a
  drill-down), included in the export.
- **Model:** `claude-haiku-4-5` with structured outputs (the existing
  utility-call convention in `src/services/llm.js`).
- **Architecture:** the **server builds the LLM input itself** from the
  same data the board endpoints already serve, and the cache is **shared,
  one row per app**. Consequences:
  - Private (viewer-only) dev sessions are **never** part of the LLM
    input — the cache is visible to every app member. Shared sessions are
    included.
  - No client-supplied data reaches the LLM, so no user can poison the
    shared narrative.
  - The server-side input builder is a *summary* input, not a re-creation
    of `_bucketDevItems` — the deterministic task list stays exclusively
    client-rendered, so board/report parity rules are untouched.

## Server side

### New service: `src/services/report-ai.js`

- `buildReportInput(pool, app)` — assembles a compact JSON snapshot from
  existing server data (reusing the same underlying queries/services the
  routes use, not HTTP):
  - open GitHub issues (title, number, assignee/priority/category
    attributes, updatedAt) from the server's issues cache;
  - open proposals awaiting review/vote (title, author, votes, check
    state, merge window);
  - open governance proposals;
  - merged/completed history (bounded, most recent N=200);
  - shared sessions only (title, owner, busy, last activity).
  - Caps: bounded item counts per section and per-title length so the
    prompt stays small; disclosed in the input as `truncated` flags.
- `fingerprint(input)` — stable hash (sha256 of canonical JSON) used for
  staleness detection and cache short-circuit.
- `generate(...)` — calls the LLM (via a new small helper in
  `src/services/llm.js`, following `generatePrMetadata`'s
  client-selection + usage-return pattern) and returns
  `{ narrative, risks[], owners[], model, usage }`.
  - Structured output schema: `narrative: string`,
    `risks: [{title, detail, severity(high|medium|low)}]`,
    `owners: [{username, blurb}]`. Server-side validation + length caps
    (narrative ≤ 2500 chars, ≤ 8 risks, ≤ 20 owners, each field capped).
  - Issue/PR titles are untrusted content: the system prompt instructs the
    model to treat document content as data, and every output field is
    validated/capped server-side and escaped client-side.

### New table: `app_report_ai` (migration in `src/db/migrate.js`)

One row per app: `app_id PK/FK, input_hash, narrative, risks_json,
owners_json, model, generated_by (user id), generated_at`.

### New routes (new file `src/routes/report-ai.js`)

- `GET /api/apps/:slug/report-ai` — requires app membership (same guard
  as other app-scoped GETs). Returns the cached row (or `{summary:null}`)
  plus `stale: currentFingerprint !== cachedFingerprint`. Computing the
  current fingerprint reuses the cached server data only — it must not
  trigger GitHub refetches beyond what the issues cache already does.
- `POST /api/apps/:slug/report-ai/generate` — requires membership.
  Rebuilds the input; if the fingerprint matches the cached row, returns
  the cache without an LLM call. Otherwise calls the LLM, upserts the
  row, and debits the clicking user via the existing `recordSpend` /
  BYOK-skip pattern (`pr-metadata.js`). Per-app in-flight lock (second
  concurrent POST returns 409 or waits) and a modest rate limit
  (e.g. one generation per app per minute). When no LLM is configured
  (no admin key, no BYOK), returns a clear `llm_unavailable` error.

## Client side (`public/js/app-view.js`)

Follows the Reporting view's existing hard rules: `ur-rpt-*` classes
only, no live-card `data-*` attributes, pure renderers.

- `_renderReportAiHtml(ai, model)` — new **pure** renderer (ai summary +
  report model in, HTML string out). Renders the three sections in order
  (narrative, critical risks, work by owner). All LLM text goes through
  `escapeHtml` and renders as plain paragraphs/list items — no markdown
  engine. Owner rows join the LLM blurb with **deterministic counts
  computed client-side** from the report model (new pure helper
  `_buildOwnerStats(model)`), so numbers never come from the LLM.
- Placement: between the summary strip and the Done section. When no
  summary exists (or the endpoint 404s/errors), a one-line
  `ur-rpt-empty` note invites generation; the deterministic report is
  unaffected.
- Toolbar gains **"Generate AI summary" / "Regenerate"** with a busy
  state; when `stale`, a hint says the data has changed since the last
  generation. Wiring mirrors the existing Download/Refresh buttons.
- Caches: `_reportAi` (fetched via GET on report paint, once per app
  visit) with the same reset discipline as `_resetReportCaches`.
- Export: `_renderReportHtml(model, {standalone:true, ai})` includes the
  AI sections when a summary is present.
- New CSS: a handful of `ur-rpt-risk-*` / `ur-rpt-owner-*` rules appended
  to `REPORT_CSS` (severity styled by tone, works in the light export and
  `--dark` on screen).

## Trust boundary

- LLM output is data, not markup: schema-validated and length-capped
  server-side, escaped client-side.
- Prompt input (titles, usernames) is untrusted; the prompt frames it as
  data to summarize.
- The shared cache contains only data every app member can already see.

## Tests

- `tests/dev-report.test.js` — extend the vm-sandbox suite: `_renderReportAiHtml`
  (escaping, section order, empty/absent summary), `_buildOwnerStats`.
- New `tests/report-ai.test.js` — service-level: input builder caps and
  private-session exclusion, fingerprint stability, output validation
  caps; route-level: membership guard, cache short-circuit on matching
  fingerprint, staleness flag, debit-on-generate.
- LLM calls mocked (the existing test suites already mock the Anthropic
  client for pr-metadata-style helpers).

## Out of scope

- No auto-generation, no cron refresh.
- No per-user or per-owner drill-down reports.
- No changes to `_bucketDevItems`, board rendering, or the deterministic
  sections' content.
- No React/frontend/ shell changes (the dev board is still `public/js`).
