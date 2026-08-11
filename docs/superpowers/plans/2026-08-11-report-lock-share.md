# Report Locking, History, Public Sharing & Bullet Highlights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let app admins freeze the Reporting tab's report as immutable dated snapshots, list them by date, share any snapshot publicly via an unguessable link, and make each AI generation build on the last locked report with bullet-point progress highlights.

**Architecture:** The existing single-row draft cache (`app_report_ai`) stays as-is; a new `app_report_snapshots` table stores client-posted self-contained report HTML plus the server's own AI summary at lock time. A pre-auth route serves shared snapshots under a sandbox CSP (the `visuals.js` capability-URL pattern). The AI schema gains a `highlights` bullet array, and the newest locked snapshot's summary feeds the next generation's input (and fingerprint).

**Tech Stack:** Express, PostgreSQL (idempotent DDL in `src/db/schema.sql`), `node:test` + fake-pool harness, legacy-JS frontend (`public/js/app-view.js` only — no React/shell changes).

**Spec:** `docs/superpowers/specs/2026-08-11-report-lock-share-design.md`

## Global Constraints

- Branch: `feature/report-lock-share` (already created; spec committed on it).
- **Never edit `public/index.html`** — and this plan never needs to: all frontend work is in `public/js/app-view.js`, so no `npm run build:shell`, no baseline/`SHELL_ASSETS`/script-count changes.
- No new `public/js/**` script files.
- `src/middleware/rate-limits.js` export object must keep `waitlistJoinLimiter, mailTestLimiter` as its final two entries (`tests/admin-mail-console.test.js` pins `mailTestLimiter }` as the tail).
- Report CSS stays plain CSS scoped under `.ur-rpt` — no Tailwind utilities.
- Report markup rules: every model/user string through `escapeHtml`/`escapeAttr`; no `data-issue-row`/`data-proposal-row`/`data-gov-row`/`data-session-chip`; no inline `onclick`.
- Snapshot HTML is untrusted user content: serve it ONLY with `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'` + `X-Content-Type-Options: nosniff` + `Cache-Control: no-store`; never embed it in another page.
- Server-side lock/share/unshare gate is `appAdmins.canManageApp` (platform admin OR app creator OR declared app admin); client-side visibility gate is `AppView.appData.can_manage`.
- Run tests with `node --test tests/<file>.test.js`; full suite is `npm test`.

---

### Task 1: Schema — `app_report_snapshots` table + `highlights_json` column

**Files:**
- Modify: `src/db/schema.sql` (append at end, after the `app_report_ai` block at lines ~4999-5015)

**Interfaces:**
- Produces: table `app_report_snapshots(id, app_id, html, ai_json, locked_by, locked_at, share_token, shared_at)` and column `app_report_ai.highlights_json JSONB NOT NULL DEFAULT '[]'` — consumed by Tasks 3 and 4.

Schema DDL is applied idempotently at boot by `src/db/migrate.js`; there is no migration runner and no schema unit test (all service/route tests use fake pools). This task is a pure DDL append verified by re-reading, then committed.

- [ ] **Step 1: Append the DDL to `src/db/schema.sql`**

```sql

-- Bullet-point progress highlights for the AI report summary
-- (report-lock-share). Additive to the existing app_report_ai row; old
-- rows default to an empty list and render without the section.
ALTER TABLE app_report_ai ADD COLUMN IF NOT EXISTS highlights_json JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Locked report snapshots (report-lock-share). Locking freezes the
-- client's self-contained standalone report document as an immutable
-- dated row; the draft cache above keeps being overwritten. html is
-- untrusted user content and is only ever served under a sandbox CSP.
-- ai_json is the SERVER's own draft summary at lock time — it feeds the
-- next generation's "previousReport" input, so it must never come from
-- the client. share_token (32-hex, crypto-random) is the sole access
-- control on the public /reports/:token route; NULL means not shared,
-- and unsharing nulls it again so revoked links 404.
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

- [ ] **Step 2: Commit**

```bash
git add src/db/schema.sql
git commit -m "feat(report-snapshots): app_report_snapshots table + highlights_json column"
```

---

### Task 2: LLM — `highlights` in schema, sanitizer, prompt

**Files:**
- Modify: `src/services/llm.js` (REPORT_SUMMARY_SCHEMA ~line 1014, `sanitizeReportSummary` ~1051, `generateReportSummary` ~1073)
- Test: `tests/report-ai-llm.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `sanitizeReportSummary(parsed, knownUsernames)` now returns `{ narrative, highlights, risks, owners }` where `highlights` is `string[]` (≤8 items, each ≤200 chars, non-strings/empties dropped, absent → `[]`); `generateReportSummary(...)` resolves to `{ narrative, highlights, risks, owners, usage, model }`. Tasks 3–4 rely on the `highlights` key existing.

- [ ] **Step 1: Write the failing tests** — append to `tests/report-ai-llm.test.js`:

```js
test('sanitizeReportSummary caps and cleans highlights', () => {
  const out = llm.sanitizeReportSummary({
    narrative: 'n',
    highlights: [
      'h'.repeat(300), '', 42, 'shipped the payments flow',
      'a', 'b', 'c', 'd', 'e', 'f', 'g',
    ],
    risks: [], owners: [],
  }, []);
  assert.ok(Array.isArray(out.highlights));
  assert.ok(out.highlights.length <= 8);
  assert.equal(out.highlights[0].length, 200);
  assert.ok(out.highlights.includes('shipped the payments flow'));
  assert.ok(!out.highlights.includes(''));
  assert.ok(!out.highlights.includes(42));
});

test('sanitizeReportSummary tolerates absent highlights', () => {
  const out = llm.sanitizeReportSummary({ narrative: 'n', risks: [], owners: [] }, []);
  assert.deepEqual(out.highlights, []);
});

test('REPORT_SUMMARY_SCHEMA requires highlights', () => {
  assert.ok(llm.REPORT_SUMMARY_SCHEMA.required.includes('highlights'));
  assert.equal(llm.REPORT_SUMMARY_SCHEMA.properties.highlights.type, 'array');
});
```

(The file already imports `llm` and uses `node:test`/`assert` — match its existing style at the top of the file.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/report-ai-llm.test.js`
Expected: the three new tests FAIL (`out.highlights` undefined / `required` missing `highlights`).

- [ ] **Step 3: Implement in `src/services/llm.js`**

In `REPORT_SUMMARY_SCHEMA`: change `required` to `['narrative', 'highlights', 'risks', 'owners']` and add to `properties` (after `narrative`):

```js
    highlights: { type: 'array', items: { type: 'string' } },
```

In `sanitizeReportSummary`, after the `narrative` line:

```js
  const highlights = (Array.isArray(p.highlights) ? p.highlights : [])
    .slice(0, 8)
    .map((h) => clip(h, 200))
    .filter(Boolean);
```

and change the return to `return { narrative, highlights, risks, owners };`.

In `generateReportSummary`'s system prompt, insert a new bullet between the `"narrative"` and `"risks"` bullets:

```
- "highlights": 3-8 short bullet strings capturing the most important progress points — what shipped, what is moving, what is blocked. Each one plain-text sentence, no markdown. When the snapshot contains a "previousReport" field, focus the highlights on what changed since that report (its lockedAt date); otherwise summarize the current state.
```

At the bottom of `generateReportSummary`, destructure and return `highlights`:

```js
  const { narrative, highlights, risks, owners } = sanitizeReportSummary(parsed, knownUsernames);
  if (!narrative) throw new Error('Empty narrative in report summary response');
  return { narrative, highlights, risks, owners, usage: resp.usage, model };
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/report-ai-llm.test.js`
Expected: PASS (all tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add src/services/llm.js tests/report-ai-llm.test.js
git commit -m "feat(report-ai): bullet-point highlights in the report summary schema"
```

---

### Task 3: Service — persist highlights; feed the last locked report into generation

**Files:**
- Modify: `src/services/report-ai.js` (`buildReportInput` ~line 42, `shapeRow` ~208, `getCached` ~221, upsert in `generateForApp` ~269)
- Modify: `src/routes/report-ai.js` (`publicShape` ~line 16)
- Test: `tests/report-ai.test.js`

**Interfaces:**
- Consumes: Task 1's `highlights_json` column and `app_report_snapshots` table; Task 2's `result.highlights`.
- Produces: `buildReportInput` output gains `input.previousReport` (`null`, or `{ lockedAt, narrative, highlights }`); `getCached`/`generateForApp` summaries and the GET/POST route responses gain `highlights: string[]`. Task 4's lock route calls `reportAi.getCached(pool, app.id)` and reads `.narrative/.highlights/.risks/.owners/.model/.generatedAt`.

- [ ] **Step 1: Write the failing tests** — append to `tests/report-ai.test.js`:

```js
test('buildReportInput feeds the newest locked snapshot as previousReport', async () => {
  dispatch([[/FROM app_report_snapshots/i, [{
    ai_json: { narrative: 'last time', highlights: ['did x', ''], risks: [], owners: [] },
    locked_at: '2026-08-05T10:00:00Z',
  }]]]);
  const { input } = await reportAi.buildReportInput(pool, APP);
  assert.ok(input.previousReport, 'previousReport must be present');
  assert.equal(input.previousReport.lockedAt, '2026-08-05');
  assert.equal(input.previousReport.narrative, 'last time');
  assert.deepEqual(input.previousReport.highlights, ['did x']);
  const snapSql = queries.map((q) => q.sql).find((s) => /app_report_snapshots/.test(s));
  assert.match(snapSql, /ai_json IS NOT NULL/);
});

test('buildReportInput sets previousReport null with no snapshots, and it changes the fingerprint', async () => {
  dispatch([]);
  const { input: bare } = await reportAi.buildReportInput(pool, APP);
  assert.equal(bare.previousReport, null);
  dispatch([[/FROM app_report_snapshots/i, [{
    ai_json: { narrative: 'last time', highlights: [], risks: [], owners: [] },
    locked_at: '2026-08-05T10:00:00Z',
  }]]]);
  const { input: withPrev } = await reportAi.buildReportInput(pool, APP);
  assert.notEqual(reportAi.fingerprint(bare), reportAi.fingerprint(withPrev));
});

test('generateForApp persists and returns highlights', async () => {
  dispatch([
    [/INSERT INTO app_report_ai/i, [{ ...INSERTED_ROW, highlights_json: ['h1'] }]],
    [/FROM app_report_ai/i, []],
  ]);
  const prev = llm._setClientForTests({
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ narrative: 'Fresh.', highlights: ['h1'], risks: [], owners: [] }) }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    },
  });
  try {
    queries.length = 0;
    const out = await reportAi.generateForApp({ pool, config: { dataEncryptionKey: 'k' }, app: APP, userId: 42 });
    assert.deepEqual(out.summary.highlights, ['h1']);
    const ins = queries.find((q) => /INSERT INTO app_report_ai/i.test(q.sql));
    assert.match(ins.sql, /highlights_json/);
  } finally { llm._setClientForTests(prev); }
});

test('GET report-ai serves highlights', async () => {
  dispatch([
    [/FROM apps WHERE slug/i, [appRow]],
    [/FROM app_report_ai/i, [{
      input_hash: 'h', narrative: 'n', highlights_json: ['point one'],
      risks_json: [], owners_json: [], model: 'claude-haiku-4-5',
      generated_by: 1, generated_at: '2026-08-01T00:00:00Z',
    }]],
  ]);
  const server = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/demo/report-ai`);
    const body = await res.json();
    assert.deepEqual(body.summary.highlights, ['point one']);
  } finally { server.close(); }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/report-ai.test.js`
Expected: the four new tests FAIL (`previousReport` undefined, `highlights` undefined).

- [ ] **Step 3: Implement**

`src/services/report-ai.js` — in `buildReportInput`, after the `merged` query block and before `const input = {`:

```js
  // The last locked report (app_report_snapshots): feeding it into the
  // input lets the model write "since the last report" highlights, and
  // makes the fingerprint change the moment a snapshot lands — so a
  // just-locked report immediately makes the draft regenerable. Bounded
  // clips: this is prompt context, not display data.
  let previousReport = null;
  try {
    const { rows: snapRows } = await pool.query(
      `SELECT ai_json, locked_at FROM app_report_snapshots
        WHERE app_id = $1 AND ai_json IS NOT NULL
        ORDER BY locked_at DESC, id DESC
        LIMIT 1`,
      [appId]
    );
    const snap = snapRows[0];
    if (snap && snap.ai_json) {
      previousReport = {
        lockedAt: day(snap.locked_at),
        narrative: clip(snap.ai_json.narrative, 1500),
        highlights: (Array.isArray(snap.ai_json.highlights) ? snap.ai_json.highlights : [])
          .slice(0, 8).map((h) => clip(h, 200)).filter(Boolean),
      };
    }
  } catch (err) {
    log.warn('report-ai', 'previous-report lookup failed', { app: app.slug, message: err.message });
  }
```

Add `previousReport,` to the `input` object literal (after `appName`).

In `shapeRow`, after `narrative`:

```js
    highlights: Array.isArray(r.highlights_json) ? r.highlights_json : [],
```

In `getCached`, change the SELECT column list to
`'SELECT input_hash, narrative, highlights_json, risks_json, owners_json, model, generated_by, generated_at FROM app_report_ai WHERE app_id = $1'`.

In `generateForApp`, change the upsert to include highlights (note the parameter renumbering):

```js
    const { rows } = await pool.query(
      `INSERT INTO app_report_ai (app_id, input_hash, narrative, highlights_json, risks_json, owners_json, model, generated_by, generated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, NOW())
       ON CONFLICT (app_id) DO UPDATE SET
         input_hash = EXCLUDED.input_hash, narrative = EXCLUDED.narrative,
         highlights_json = EXCLUDED.highlights_json,
         risks_json = EXCLUDED.risks_json, owners_json = EXCLUDED.owners_json,
         model = EXCLUDED.model, generated_by = EXCLUDED.generated_by, generated_at = NOW()
       RETURNING input_hash, narrative, highlights_json, risks_json, owners_json, model, generated_by, generated_at`,
      [app.id, hash, result.narrative, JSON.stringify(result.highlights || []),
        JSON.stringify(result.risks), JSON.stringify(result.owners), result.model, userId]
    );
```

`src/routes/report-ai.js` — in `publicShape`, after `narrative`:

```js
    highlights: summary.highlights,
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/report-ai.test.js && node --test tests/report-ai-llm.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/report-ai.js src/routes/report-ai.js tests/report-ai.test.js
git commit -m "feat(report-ai): persist highlights and build on the last locked report"
```

---

### Task 4: Routes — lock, list, serve, share, unshare + public `/reports/:token`

**Files:**
- Create: `src/routes/report-snapshots.js`
- Modify: `src/middleware/rate-limits.js` (add limiter after `reportAiLimiter` ~line 407; export list ~line 409)
- Modify: `server.js` (require near other route requires; body-parser skip in the gate ~line 230-246; pre-auth mount after `avatarRoutes` ~line 451; authed mount after `reportAiRoutes` ~line 538)
- Test: `tests/report-snapshots.test.js` (new)

**Interfaces:**
- Consumes: Task 1's table; Task 3's `reportAi.getCached` (returns `{ narrative, highlights, risks, owners, model, generatedAt, ... }`); `appAccess.getAppForUser`, `appAdmins.canManageApp`.
- Produces (Task 6's frontend relies on these exact shapes):
  - `GET /api/apps/:slug/report-snapshots` → `{ snapshots: [{ id, lockedAt, lockedBy, shared, sharePath, htmlPath }], canManage }` (newest first)
  - `POST /api/apps/:slug/report-snapshots` body `{ html }` → `{ snapshot: {same row shape} }` (403 non-admin, 400 bad/oversized html)
  - `GET /api/apps/:slug/report-snapshots/:id/html` → the stored HTML (sandbox CSP)
  - `POST /api/apps/:slug/report-snapshots/:id/share` → `{ sharePath: "/reports/<32hex>" }` (idempotent)
  - `POST /api/apps/:slug/report-snapshots/:id/unshare` → `{ ok: true }`
  - `GET /reports/:token` (pre-auth) → stored HTML or 404

- [ ] **Step 1: Add the rate limiter** — in `src/middleware/rate-limits.js`, insert after the `reportAiLimiter` block:

```js
// Locking a report writes a multi-hundred-KB row per click; share and
// unshare are cheap but share the same per-user budget so a stuck client
// can't hammer any of the three verbs. Per-user keyed like report-ai.
const reportSnapshotLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 10,
  name: 'report-snapshot',
  keyByUser: true,
  message: 'Please wait a minute before locking or sharing more reports.',
});
```

In the `module.exports` list, insert `reportSnapshotLimiter,` immediately after `reportAiLimiter,` (keeping `waitlistJoinLimiter, mailTestLimiter` as the tail).

- [ ] **Step 2: Write the failing route tests** — create `tests/report-snapshots.test.js`:

```js
// routes/report-snapshots.js — locked report snapshots + public share
// links. Properties locked in:
//
//   * Lock/share/unshare are canManageApp-gated (403 for a plain member);
//     list/read need only 'view' (404 on unknown app, the appAccess deny).
//   * The lock POST validates the payload is a standalone report document
//     and caps it at 2 MB; ai_json comes from the SERVER's own draft
//     cache, never from the request body.
//   * Snapshot HTML is only ever served with the sandbox CSP and
//     no-store — on the authed /html route AND the public /reports/:token
//     route — and a revoked/unknown/malformed token 404s.
//   * The share token is minted once (idempotent share) and unshare
//     nulls it.
//
// Harness: same as tests/report-ai.test.js — getPool overridden before
// requires, github/topic-attributes stubbed, ephemeral express app.
//
// Run with: node --test tests/report-snapshots.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}
stub(require.resolve('../src/services/github'), {
  fetchPublicIssues: async () => ({ issues: [], truncatedList: false }),
});
stub(require.resolve('../src/services/topic-attributes'), {
  summarizeForTargets: async () => new Map(),
});

const poolMod = require('../src/db/pool');
let queryHandler = async () => ({ rows: [] });
const queries = [];
poolMod.getPool = () => ({
  query: (sql, params) => { queries.push({ sql, params }); return queryHandler(sql, params); },
});

const express = require('express');
const { reportSnapshotRoutes, reportShareRoutes } = require('../src/routes/report-snapshots');

function dispatch(map) {
  queryHandler = async (sql) => {
    for (const [re, rows] of map) if (re.test(sql)) return { rows };
    return { rows: [] };
  };
}

// NOTE: reportSnapshotLimiter is per-user, 10/min, and its window
// persists across the tests in this file (module-level limiter state).
// The file currently issues ~8 gated POSTs; if you add more, reset
// `currentUser` to a fresh id for the new tests.
let currentUser = { id: 42, username: 'member', isAdmin: false };
function startServer() {
  const app = express();
  app.use(reportShareRoutes({}));
  // Mirror server.js's parser gate: the lock POST is skipped by the
  // global 100kb parser (the route owns a 3mb one) — without this skip
  // the oversized-payload test would 413 in the wrong layer.
  app.use((req, res, next) => {
    if (req.method === 'POST' && /^\/api\/apps\/[^/]+\/report-snapshots$/.test(req.path)) return next();
    express.json()(req, res, next);
  });
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(reportSnapshotRoutes({}));
  return new Promise((r) => { const s = app.listen(0, () => r(s)); });
}
const base = (s) => `http://127.0.0.1:${s.address().port}`;

// created_by 1: currentUser 42 is a plain member; switching currentUser
// to id 1 makes canManageApp pass on the creator branch with no
// app_admins lookup (which the app-admins TTL cache would otherwise
// bleed across tests).
const appRow = {
  id: 7, slug: 'demo', name: 'Demo', created_by: 1, self_hosted: false,
  collab_visibility: 'open', view_visibility: 'public',
};
const SNAP = {
  id: 3, locked_at: '2026-08-11T10:00:00Z', share_token: null,
  locked_by_username: 'alice',
};
const DOC = '<!doctype html><html><head><title>r</title></head><body>report</body></html>';

test('GET list returns rows newest-first shape and canManage=false for a member', async () => {
  currentUser = { id: 42, username: 'member', isAdmin: false };
  dispatch([
    [/FROM apps WHERE slug/i, [appRow]],
    [/FROM app_report_snapshots/i, [
      { ...SNAP, id: 4, share_token: 'a'.repeat(32) },
      SNAP,
    ]],
  ]);
  const s = await startServer();
  try {
    const res = await fetch(`${base(s)}/api/apps/demo/report-snapshots`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.canManage, false);
    assert.equal(body.snapshots.length, 2);
    assert.equal(body.snapshots[0].shared, true);
    assert.equal(body.snapshots[0].sharePath, `/reports/${'a'.repeat(32)}`);
    assert.equal(body.snapshots[1].shared, false);
    assert.equal(body.snapshots[1].sharePath, null);
    assert.equal(body.snapshots[1].lockedBy, 'alice');
    assert.equal(body.snapshots[1].htmlPath, '/api/apps/demo/report-snapshots/3/html');
    assert.equal(body.snapshots[1].html, undefined, 'list must not carry html');
  } finally { s.close(); }
});

test('POST lock 403s for a non-admin member', async () => {
  currentUser = { id: 42, username: 'member', isAdmin: false };
  dispatch([[/FROM apps WHERE slug/i, [appRow]]]);
  const s = await startServer();
  try {
    const res = await fetch(`${base(s)}/api/apps/demo/report-snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: DOC }),
    });
    assert.equal(res.status, 403);
  } finally { s.close(); }
});

test('POST lock inserts with server-cached ai_json for the creator', async () => {
  currentUser = { id: 1, username: 'creator', isAdmin: false };
  dispatch([
    [/FROM apps WHERE slug/i, [appRow]],
    [/FROM app_report_ai/i, [{
      input_hash: 'h', narrative: 'n', highlights_json: ['h1'], risks_json: [],
      owners_json: [], model: 'claude-haiku-4-5', generated_by: 1,
      generated_at: '2026-08-10T00:00:00Z',
    }]],
    [/INSERT INTO app_report_snapshots/i, [{ id: 9, locked_at: '2026-08-11T12:00:00Z', share_token: null }]],
  ]);
  queries.length = 0;
  const s = await startServer();
  try {
    const res = await fetch(`${base(s)}/api/apps/demo/report-snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: DOC, ai: { narrative: 'CLIENT SUPPLIED' } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.snapshot.id, 9);
    assert.equal(body.snapshot.shared, false);
    const ins = queries.find((q) => /INSERT INTO app_report_snapshots/i.test(q.sql));
    assert.ok(ins, 'must insert');
    // params: [app_id, html, ai_json, locked_by] — ai_json from the
    // server cache, ignoring the client-posted `ai`.
    assert.equal(ins.params[0], 7);
    assert.equal(ins.params[1], DOC);
    assert.match(ins.params[2], /"narrative":"n"/);
    assert.ok(!/CLIENT SUPPLIED/.test(ins.params[2]));
    assert.equal(ins.params[3], 1);
  } finally { s.close(); }
});

test('POST lock rejects junk and oversized payloads', async () => {
  currentUser = { id: 1, username: 'creator', isAdmin: false };
  dispatch([[/FROM apps WHERE slug/i, [appRow]], [/FROM app_report_ai/i, []]]);
  const s = await startServer();
  try {
    let res = await fetch(`${base(s)}/api/apps/demo/report-snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: '<script>alert(1)</script>' }),
    });
    assert.equal(res.status, 400);
    res = await fetch(`${base(s)}/api/apps/demo/report-snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: `<!doctype html>${'x'.repeat(2 * 1024 * 1024)}` }),
    });
    assert.equal(res.status, 400);
  } finally { s.close(); }
});

test('authed /html serves the doc with the sandbox CSP', async () => {
  currentUser = { id: 42, username: 'member', isAdmin: false };
  dispatch([
    [/FROM apps WHERE slug/i, [appRow]],
    [/SELECT html FROM app_report_snapshots/i, [{ html: DOC }]],
  ]);
  const s = await startServer();
  try {
    const res = await fetch(`${base(s)}/api/apps/demo/report-snapshots/3/html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(await res.text(), DOC);
  } finally { s.close(); }
});

test('share mints an idempotent token and unshare revokes; both are admin-gated', async () => {
  currentUser = { id: 42, username: 'member', isAdmin: false };
  dispatch([[/FROM apps WHERE slug/i, [appRow]]]);
  let s = await startServer();
  try {
    const res = await fetch(`${base(s)}/api/apps/demo/report-snapshots/3/share`, { method: 'POST' });
    assert.equal(res.status, 403);
  } finally { s.close(); }

  currentUser = { id: 1, username: 'creator', isAdmin: false };
  dispatch([
    [/FROM apps WHERE slug/i, [appRow]],
    [/UPDATE app_report_snapshots[\s\S]*COALESCE/i, [{ share_token: 'b'.repeat(32) }]],
  ]);
  s = await startServer();
  try {
    const res = await fetch(`${base(s)}/api/apps/demo/report-snapshots/3/share`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sharePath, `/reports/${'b'.repeat(32)}`);
    const upd = queries.find((q) => /COALESCE\(share_token/i.test(q.sql));
    assert.ok(upd, 'share must COALESCE the existing token (idempotent)');
  } finally { s.close(); }

  // Direct handler: unshare checks rowCount, which dispatch() doesn't carry.
  queryHandler = async (sql, params) => {
    queries.push({ sql, params });
    if (/FROM apps WHERE slug/i.test(sql)) return { rows: [appRow] };
    if (/SET share_token = NULL/i.test(sql)) return { rows: [], rowCount: 1 };
    return { rows: [] };
  };
  s = await startServer();
  try {
    const res = await fetch(`${base(s)}/api/apps/demo/report-snapshots/3/unshare`, { method: 'POST' });
    assert.equal(res.status, 200);
  } finally { s.close(); }
});

test('public /reports/:token serves shared html and 404s malformed/unknown tokens', async () => {
  dispatch([[/WHERE share_token/i, [{ html: DOC }]]]);
  const s = await startServer();
  try {
    let res = await fetch(`${base(s)}/reports/${'c'.repeat(32)}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(await res.text(), DOC);

    res = await fetch(`${base(s)}/reports/not-a-token`);
    assert.equal(res.status, 404);

    dispatch([[/WHERE share_token/i, []]]);
    res = await fetch(`${base(s)}/reports/${'d'.repeat(32)}`);
    assert.equal(res.status, 404);
  } finally { s.close(); }
});

test('list/lock 404 on unknown app', async () => {
  currentUser = { id: 1, username: 'creator', isAdmin: false };
  dispatch([[/FROM apps WHERE slug/i, []]]);
  const s = await startServer();
  try {
    let res = await fetch(`${base(s)}/api/apps/nope/report-snapshots`);
    assert.equal(res.status, 404);
    res = await fetch(`${base(s)}/api/apps/nope/report-snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: DOC }),
    });
    assert.equal(res.status, 404);
  } finally { s.close(); }
});
```

Note: the unshare branch drives `queryHandler` directly because the `dispatch` helper does not carry `rowCount`.

- [ ] **Step 3: Run to verify failure**

Run: `node --test tests/report-snapshots.test.js`
Expected: FAIL — `Cannot find module '../src/routes/report-snapshots'`.

- [ ] **Step 4: Create `src/routes/report-snapshots.js`**

```js
'use strict';

const crypto = require('crypto');
const express = require('express');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const appAccess = require('../services/app-access');
const appAdmins = require('../services/app-admins');
const reportAi = require('../services/report-ai');
const { reportSnapshotLimiter } = require('../middleware/rate-limits');
const log = require('../services/logger');

// Locked report snapshots (Reporting tab). Locking freezes the client's
// self-contained standalone report document (the same HTML the download
// button produces) as an immutable dated row; the app_report_ai draft
// keeps being overwritten by regeneration. Lock/share/unshare are
// canManageApp-gated (creator, declared app admins, platform admins);
// list/read need only 'view' — the document contains nothing a viewer
// can't already see on the board.
//
// The posted html is UNTRUSTED USER CONTENT: the only defenses are the
// admin gate, the shape/size checks, and — decisively — the sandbox CSP
// on every route that serves it. The sandbox directive gives the
// document an opaque origin and blocks all script execution, so even a
// malicious admin's markup cannot run code or reach the platform
// origin. Never embed snapshot html in any other page.
//
// ai_json is the SERVER's own draft cache at lock time (never the
// client's): it feeds the next generation's `previousReport` input
// (services/report-ai.js), so it must be data the server itself
// produced.

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const SANDBOX_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

function sendSnapshotHtml(res, html) {
  res.set('Content-Security-Policy', SANDBOX_CSP);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'no-store');
  res.type('text/html; charset=utf-8');
  res.send(html);
}

function rowShape(r) {
  return {
    id: Number(r.id),
    lockedAt: r.locked_at,
    lockedBy: r.locked_by_username || null,
    shared: !!r.share_token,
    sharePath: r.share_token ? `/reports/${r.share_token}` : null,
  };
}

function reportSnapshotRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  const APP_COLS = `${appAccess.ACCESS_COLUMNS}, name`;

  const getApp = (req) =>
    appAccess.getAppForUser(pool, req.params.slug, req.user, 'view', APP_COLS);

  router.get('/api/apps/:slug/report-snapshots', async (req, res) => {
    try {
      const app = await getApp(req);
      if (!app) return res.status(404).json({ error: 'App not found' });
      const { rows } = await pool.query(
        `SELECT s.id, s.locked_at, s.share_token, u.username AS locked_by_username
           FROM app_report_snapshots s
           LEFT JOIN users u ON u.id = s.locked_by
          WHERE s.app_id = $1
          ORDER BY s.locked_at DESC, s.id DESC`,
        [app.id]
      );
      res.json({
        snapshots: rows.map((r) => ({
          ...rowShape(r),
          htmlPath: `/api/apps/${app.slug}/report-snapshots/${r.id}/html`,
        })),
        canManage: await appAdmins.canManageApp(pool, app, req.user),
      });
    } catch (err) {
      log.error('report-snapshots', 'list failed', { message: err.message });
      res.status(500).json({ error: 'Failed to load reports' });
    }
  });

  // The standalone report HTML routinely exceeds the global 100kb JSON
  // parser cap, so server.js's parser gate skips this exact path and the
  // route owns a 3mb parser (headroom over MAX_HTML_BYTES: the byte cap
  // below is the real limit; the parser cap only bounds hostile bodies).
  router.post('/api/apps/:slug/report-snapshots',
    reportSnapshotLimiter,
    express.json({ limit: '3mb' }),
    async (req, res) => {
      try {
        const app = await getApp(req);
        if (!app) return res.status(404).json({ error: 'App not found' });
        if (!(await appAdmins.canManageApp(pool, app, req.user))) {
          return res.status(403).json({ error: 'Only app admins can lock reports' });
        }
        const html = req.body && req.body.html;
        if (typeof html !== 'string' || !/^<!doctype html>/i.test(html.trim())) {
          return res.status(400).json({ error: 'Not a report document' });
        }
        if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
          return res.status(400).json({ error: 'Report too large to lock' });
        }
        const cached = await reportAi.getCached(pool, app.id);
        const ai = cached ? {
          narrative: cached.narrative,
          highlights: cached.highlights,
          risks: cached.risks,
          owners: cached.owners,
          model: cached.model,
          generatedAt: cached.generatedAt,
        } : null;
        const { rows } = await pool.query(
          `INSERT INTO app_report_snapshots (app_id, html, ai_json, locked_by)
           VALUES ($1, $2, $3::jsonb, $4)
           RETURNING id, locked_at, share_token`,
          [app.id, html, ai ? JSON.stringify(ai) : null, req.user.id]
        );
        res.json({
          snapshot: {
            ...rowShape({ ...rows[0], locked_by_username: req.user.username }),
            htmlPath: `/api/apps/${app.slug}/report-snapshots/${rows[0].id}/html`,
          },
        });
      } catch (err) {
        log.error('report-snapshots', 'lock failed', { message: err.message });
        res.status(500).json({ error: 'Failed to lock the report' });
      }
    });

  router.get('/api/apps/:slug/report-snapshots/:id/html', async (req, res) => {
    try {
      const app = await getApp(req);
      if (!app) return res.status(404).end();
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(404).end();
      const { rows } = await pool.query(
        'SELECT html FROM app_report_snapshots WHERE id = $1 AND app_id = $2',
        [id, app.id]
      );
      if (!rows.length) return res.status(404).end();
      sendSnapshotHtml(res, rows[0].html);
    } catch (err) {
      log.error('report-snapshots', 'html serve failed', { message: err.message });
      res.status(500).end();
    }
  });

  router.post('/api/apps/:slug/report-snapshots/:id/share',
    reportSnapshotLimiter,
    async (req, res) => {
      try {
        const app = await getApp(req);
        if (!app) return res.status(404).json({ error: 'App not found' });
        if (!(await appAdmins.canManageApp(pool, app, req.user))) {
          return res.status(403).json({ error: 'Only app admins can share reports' });
        }
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(404).json({ error: 'Report not found' });
        // COALESCE keeps an existing token: clicking Share twice must not
        // rotate a link someone already sent around.
        const token = crypto.randomBytes(16).toString('hex');
        const { rows } = await pool.query(
          `UPDATE app_report_snapshots
              SET share_token = COALESCE(share_token, $3),
                  shared_at = COALESCE(shared_at, NOW())
            WHERE id = $1 AND app_id = $2
            RETURNING share_token`,
          [id, app.id, token]
        );
        if (!rows.length) return res.status(404).json({ error: 'Report not found' });
        res.json({ sharePath: `/reports/${rows[0].share_token}` });
      } catch (err) {
        log.error('report-snapshots', 'share failed', { message: err.message });
        res.status(500).json({ error: 'Failed to share the report' });
      }
    });

  router.post('/api/apps/:slug/report-snapshots/:id/unshare',
    reportSnapshotLimiter,
    async (req, res) => {
      try {
        const app = await getApp(req);
        if (!app) return res.status(404).json({ error: 'App not found' });
        if (!(await appAdmins.canManageApp(pool, app, req.user))) {
          return res.status(403).json({ error: 'Only app admins can unshare reports' });
        }
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(404).json({ error: 'Report not found' });
        const result = await pool.query(
          `UPDATE app_report_snapshots SET share_token = NULL, shared_at = NULL
            WHERE id = $1 AND app_id = $2`,
          [id, app.id]
        );
        if (!result.rowCount) return res.status(404).json({ error: 'Report not found' });
        res.json({ ok: true });
      } catch (err) {
        log.error('report-snapshots', 'unshare failed', { message: err.message });
        res.status(500).json({ error: 'Failed to unshare the report' });
      }
    });

  return router;
}

// Public serving — mounted BEFORE authMiddleware in server.js (the
// visuals.js pattern): a share link must open for anyone, so the only
// access control is the unguessable 32-hex token. no-store, because
// unshare must bite immediately (an intermediary cache holding a revoked
// report would defeat revocation).
function reportShareRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/reports/:token', async (req, res) => {
    const token = String(req.params.token || '');
    if (!/^[a-f0-9]{32}$/.test(token)) return res.status(404).end();
    try {
      const { rows } = await pool.query(
        'SELECT html FROM app_report_snapshots WHERE share_token = $1',
        [token]
      );
      if (!rows.length) return res.status(404).end();
      sendSnapshotHtml(res, rows[0].html);
    } catch (err) {
      log.error('report-snapshots', 'share serve failed', { message: err.message });
      res.status(500).end();
    }
  });

  return router;
}

module.exports = { reportSnapshotRoutes, reportShareRoutes };
```

- [ ] **Step 5: Wire `server.js`**

Add the require next to the existing route requires (search for `reportAiRoutes` require):

```js
const { reportSnapshotRoutes, reportShareRoutes } = require('./src/routes/report-snapshots');
```

In the body-parser gate (the `app.use` around line 230-246, next to the agent-files skip):

```js
  // Locked report snapshots (report-lock-share) carry the full standalone
  // report HTML, which routinely exceeds 100kb; the route mounts its own
  // 3mb parser (routes/report-snapshots.js).
  if (req.method === 'POST' && /^\/api\/apps\/[^/]+\/report-snapshots$/.test(req.path)) return next();
```

After `app.use(avatarRoutes(config));` (~line 451):

```js
// Publicly shared locked report snapshots (report-lock-share). Mounted
// before authMiddleware like visuals: access control is the unguessable
// 32-hex share token, and the HTML is served under a sandbox CSP.
app.use(reportShareRoutes(config));
```

After `app.use(reportAiRoutes(config));` (~line 538):

```js
app.use(reportSnapshotRoutes(config));
```

- [ ] **Step 6: Run to verify pass**

Run: `node --test tests/report-snapshots.test.js && node --test tests/admin-mail-console.test.js`
Expected: PASS (including the rate-limits export-tail pin).

- [ ] **Step 7: Commit**

```bash
git add src/routes/report-snapshots.js src/middleware/rate-limits.js server.js tests/report-snapshots.test.js
git commit -m "feat(report-snapshots): lock/list/share routes + public sandboxed /reports/:token"
```

---

### Task 5: Frontend — render bullet highlights

**Files:**
- Modify: `public/js/app-view.js` (`_renderReportAiHtml` ~line 5693; `REPORT_CSS` ~line 5762)
- Test: `tests/dev-report.test.js`

**Interfaces:**
- Consumes: Task 3's `summary.highlights` (arrives on `AppView._reportAi` via the existing `_ensureReportAi`/`generateReportAi` — no fetch changes needed).
- Produces: a `data-section="ai-highlights"` section other tests may select on.

- [ ] **Step 1: Write the failing tests** — append to `tests/dev-report.test.js` (uses the existing `makeAppView()` helper):

```js
test('AI highlights render as an escaped bullet list above the narrative', () => {
  const AppView = makeAppView();
  const html = AppView._renderReportAiHtml({
    narrative: 'All good.',
    highlights: ['Shipped <payments>', 'Review queue cleared'],
    risks: [], owners: [],
  }, []);
  assert.match(html, /data-section="ai-highlights"/);
  assert.match(html, /Progress highlights/);
  assert.match(html, /Shipped &lt;payments&gt;/);
  assert.ok(!html.includes('<payments>'));
  assert.ok(
    html.indexOf('data-section="ai-highlights"') < html.indexOf('data-section="ai-summary"'),
    'highlights come before the narrative'
  );
});

test('AI highlights section is omitted when empty or absent', () => {
  const AppView = makeAppView();
  const none = AppView._renderReportAiHtml({ narrative: 'n', risks: [], owners: [] }, []);
  assert.ok(!none.includes('ai-highlights'));
  const empty = AppView._renderReportAiHtml({ narrative: 'n', highlights: [], risks: [], owners: [] }, []);
  assert.ok(!empty.includes('ai-highlights'));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/dev-report.test.js`
Expected: the two new tests FAIL.

- [ ] **Step 3: Implement** — in `_renderReportAiHtml`, insert between `let html = '';` and the narrative section:

```js
    // Progress highlights — the skimmable layer, placed first. Rendered
    // only when the summary carries bullets (older cached summaries
    // predate the field).
    const bullets = (Array.isArray(ai.highlights) ? ai.highlights : [])
      .map((b) => (b == null ? '' : String(b).trim())).filter(Boolean);
    if (bullets.length) {
      html += `<section class="ur-rpt-section" data-section="ai-highlights">`
        + `<h2 class="ur-rpt-h2">Progress highlights</h2>`
        + `<ul class="ur-rpt-bullets">${bullets.map((b) => `<li>${eh(b)}</li>`).join('')}</ul>`
        + `</section>`;
    }
```

In `REPORT_CSS`, add after the `.ur-rpt-ai-note` line:

```js
    '.ur-rpt-bullets{list-style:disc;margin:0.75rem 0 0;padding-left:1.25rem;}',
    '.ur-rpt-bullets li{margin:0.25rem 0;}',
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/dev-report.test.js`
Expected: PASS (all, including the existing export/invariant tests).

- [ ] **Step 5: Commit**

```bash
git add public/js/app-view.js tests/dev-report.test.js
git commit -m "feat(report): render AI progress highlights as a bullet list"
```

---

### Task 6: Frontend — Lock button, Previous reports list, share/copy wiring

**Files:**
- Modify: `public/js/app-view.js` (`_resetReportCaches` ~5253; `_repaintReportView` ~5352; `_renderReportToolbar` ~5389; new methods next to `_ensureReportAi`/`generateReportAi` ~6087-6125; `REPORT_CSS`)
- Test: `tests/dev-report.test.js`

**Interfaces:**
- Consumes: Task 4's list/lock/share/unshare responses (`snapshots: [{ id, lockedAt, lockedBy, shared, sharePath, htmlPath }]`); `AppView.appData.can_manage` (already delivered by `accessFlags` in `src/routes/apps.js`); existing `_renderReportHtml(model, { standalone: true, ai })`.
- Produces: `#dev-report-lock` toolbar button; pure `_renderReportSnapshotsHtml(snaps, canManage)`; `lockReport()`, `_ensureReportSnapshots()`, `shareReportSnapshot(id)`, `unshareReportSnapshot(id)`, `copyReportShareLink(path, msg)`.

- [ ] **Step 1: Write the failing tests** — append to `tests/dev-report.test.js`:

```js
test('report toolbar shows Lock report only for managers', () => {
  const canManage = makeAppView();
  canManage.appData = { slug: 'demo', can_manage: true };
  assert.match(canManage._renderReportToolbar(), /id="dev-report-lock"/);
  assert.match(canManage._renderReportToolbar(), /Lock report/);

  const viewer = makeAppView();
  viewer.appData = { slug: 'demo', can_manage: false };
  assert.ok(!viewer._renderReportToolbar().includes('dev-report-lock'));
});

test('snapshots list renders dates, badges, and admin-only actions', () => {
  const AppView = makeAppView();
  const snaps = [
    { id: 4, lockedAt: '2026-08-11T10:00:00Z', lockedBy: 'ali<ce', shared: true,
      sharePath: `/reports/${'a'.repeat(32)}`, htmlPath: '/api/apps/demo/report-snapshots/4/html' },
    { id: 3, lockedAt: '2026-08-01T09:00:00Z', lockedBy: 'bob', shared: false,
      sharePath: null, htmlPath: '/api/apps/demo/report-snapshots/3/html' },
  ];
  const admin = AppView._renderReportSnapshotsHtml(snaps, true);
  assert.match(admin, /data-section="snapshots"/);
  assert.match(admin, /Previous reports/);
  assert.match(admin, /ali&lt;ce/);
  assert.ok(!admin.includes('ali<ce'));
  assert.match(admin, /Shared/);
  assert.match(admin, /data-snap-copy="\/reports\/a{32}"/);
  assert.match(admin, /data-snap-unshare="4"/);
  assert.match(admin, /data-snap-share="3"/);
  assert.match(admin, /href="\/api\/apps\/demo\/report-snapshots\/4\/html"/);
  // Read-only document rules still hold: no live-card hooks, no inline handlers.
  assert.ok(!/onclick=/.test(admin));
  assert.ok(!/data-issue-row|data-proposal-row|data-gov-row|data-session-chip/.test(admin));

  const viewer = AppView._renderReportSnapshotsHtml(snaps, false);
  assert.ok(!viewer.includes('data-snap-share'));
  assert.ok(!viewer.includes('data-snap-unshare'));
  assert.ok(!viewer.includes('data-snap-copy'));
  assert.match(viewer, /href="\/api\/apps\/demo\/report-snapshots\/3\/html"/);
});

test('snapshots list renders nothing when empty', () => {
  const AppView = makeAppView();
  assert.equal(AppView._renderReportSnapshotsHtml([], true), '');
  assert.equal(AppView._renderReportSnapshotsHtml(undefined, true), '');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/dev-report.test.js`
Expected: the three new tests FAIL (`_renderReportSnapshotsHtml` undefined; no lock button).

- [ ] **Step 3: Implement in `public/js/app-view.js`**

`_resetReportCaches` — add before the closing brace:

```js
    // Locked snapshots (report-lock-share): undefined = never fetched.
    AppView._reportSnapshots = undefined;
    AppView._reportLocking = false;
```

`_renderReportToolbar` — add before the `return`:
`const canManage = !!(AppView.appData && AppView.appData.can_manage);`
`const locking = AppView._reportLocking;`
and insert after the `#dev-report-ai` button line, inside the flex div:

```js
        ${canManage ? `<button id="dev-report-lock" class="gc-vote-btn"${locking || busy ? ' disabled' : ''} title="Freeze this report as a permanent dated snapshot in Previous reports">${locking ? 'Locking…' : 'Lock report'}</button>` : ''}
```

`_repaintReportView` — change the painted body so the snapshots section renders inside the report root, above the report header:

```js
    el.innerHTML = `<style id="dev-report-style">${AppView.REPORT_CSS}</style>`
      + AppView._renderReportToolbar()
      + `<div class="${AppView._reportRootCls()}">`
      + AppView._renderReportSnapshotsHtml(
        AppView._reportSnapshots, !!(AppView.appData && AppView.appData.can_manage)
      )
      + `${AppView._renderReportHtml(model, { standalone: false, ai: AppView._reportAi === undefined ? null : AppView._reportAi })}</div>`;
```

and extend the post-paint wiring (after the `#dev-report-ai` lines):

```js
    const lk = el.querySelector('#dev-report-lock');
    if (lk && lk.addEventListener) lk.addEventListener('click', () => AppView.lockReport());
    const wire = (sel, fn) => {
      const nodes = el.querySelectorAll(sel);
      if (nodes && nodes.forEach) {
        nodes.forEach((b) => b.addEventListener('click', () => fn(b)));
      }
    };
    wire('[data-snap-share]', (b) => AppView.shareReportSnapshot(b.getAttribute('data-snap-share')));
    wire('[data-snap-unshare]', (b) => AppView.unshareReportSnapshot(b.getAttribute('data-snap-unshare')));
    wire('[data-snap-copy]', (b) => AppView.copyReportShareLink(b.getAttribute('data-snap-copy')));
    AppView._ensureReportAi();
    AppView._ensureReportSnapshots();
```

New pure renderer, placed right after `_renderReportAiHtml`:

```js
  // ── Previous reports (locked snapshots): pure, DOM-free ─────────────
  // snaps (server list rows) + canManage in → HTML out. Same read-only
  // document rules as the report: no live-card data-* hooks, no inline
  // handlers — the share/unshare/copy buttons carry data-snap-* markers
  // that _repaintReportView wires after each paint. Rendered ONLY into
  // the on-screen view (never the standalone export/lock document).
  _renderReportSnapshotsHtml(snaps, canManage) {
    const eh = (s) => escapeHtml(s == null ? '' : String(s));
    const ea = (s) => escapeAttr(s == null ? '' : String(s));
    const list = Array.isArray(snaps) ? snaps : [];
    if (!list.length) return '';
    const rows = list.map((s) => {
      const ms = Date.parse(s.lockedAt || '');
      const when = Number.isFinite(ms)
        ? `${new Date(ms).toLocaleDateString()} ${new Date(ms).toLocaleTimeString()}`
        : 'undated';
      let actions = `<span><a href="${ea(s.htmlPath)}" target="_blank" rel="noopener">Open</a></span>`;
      if (canManage) {
        actions += s.shared
          ? `<span><button type="button" class="ur-rpt-linklike" data-snap-copy="${ea(s.sharePath)}">Copy link</button></span>`
            + `<span><button type="button" class="ur-rpt-linklike" data-snap-unshare="${ea(s.id)}">Unshare</button></span>`
          : `<span><button type="button" class="ur-rpt-linklike" data-snap-share="${ea(s.id)}">Share</button></span>`;
      }
      return `<li class="ur-rpt-row">`
        + `<div class="ur-rpt-title">${eh(when)}`
        + (s.lockedBy ? `<span class="ur-rpt-tag">locked by ${eh(s.lockedBy)}</span>` : '')
        + (s.shared ? `<span class="ur-rpt-tag">Shared</span>` : '')
        + `</div>`
        + `<div class="ur-rpt-meta">${actions}</div>`
        + `</li>`;
    }).join('');
    return `<section class="ur-rpt-section" data-section="snapshots">`
      + `<h2 class="ur-rpt-h2">Previous reports</h2>`
      + `<ul class="ur-rpt-list">${rows}</ul></section>`;
  },
```

New methods, placed right after `generateReportAi` (~line 6125):

```js
  // Fetch the locked-snapshot list once per report visit; errors degrade
  // to an empty list (the section simply doesn't render).
  async _ensureReportSnapshots() {
    if (AppView._reportSnapshotsFetching || AppView._reportSnapshots !== undefined) return;
    if (!AppView.appData) return;
    AppView._reportSnapshotsFetching = true;
    try {
      const res = await fetch(`/api/apps/${AppView.appData.slug}/report-snapshots`);
      const data = res.ok ? await res.json() : null;
      AppView._reportSnapshots = data && Array.isArray(data.snapshots) ? data.snapshots : [];
    } catch {
      AppView._reportSnapshots = [];
    } finally {
      AppView._reportSnapshotsFetching = false;
    }
    if (AppView._getViewMode() === 'report') AppView._repaintReportView();
  },

  // Freeze the current report (same document the download builds) as a
  // permanent dated snapshot. Admin-gated server-side; the button only
  // renders for managers.
  async lockReport() {
    if (AppView._reportLocking || !AppView.appData) return;
    if (!AppView._reportMerged) { AppView._ensureReportData(); return; }
    AppView._reportLocking = true;
    AppView._repaintReportView();
    try {
      const model = AppView._buildReportModel(AppView._reportInputs());
      const doc = AppView._renderReportHtml(
        model,
        AppView._reportAi
          ? { standalone: true, ai: AppView._reportAi }
          : { standalone: true }
      );
      const res = await fetch(`/api/apps/${AppView.appData.slug}/report-snapshots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: doc }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.snapshot) {
        AppView._reportSnapshots = undefined; // refetch the list on repaint
        if (window.PlatformUI && PlatformUI.toast) PlatformUI.toast('Report locked');
      } else if (window.PlatformUI && PlatformUI.toast) {
        PlatformUI.toast(data.error || 'Could not lock the report');
      }
    } catch {
      if (window.PlatformUI && PlatformUI.toast) PlatformUI.toast('Could not lock the report');
    } finally {
      AppView._reportLocking = false;
      if (AppView._getViewMode() === 'report') AppView._repaintReportView();
    }
  },

  async shareReportSnapshot(id) {
    if (!AppView.appData) return;
    try {
      const res = await fetch(
        `/api/apps/${AppView.appData.slug}/report-snapshots/${encodeURIComponent(id)}/share`,
        { method: 'POST' }
      );
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.sharePath) {
        AppView._reportSnapshots = undefined;
        AppView.copyReportShareLink(data.sharePath, 'Share link copied');
      } else if (window.PlatformUI && PlatformUI.toast) {
        PlatformUI.toast(data.error || 'Could not share the report');
      }
    } catch {
      if (window.PlatformUI && PlatformUI.toast) PlatformUI.toast('Could not share the report');
    }
    if (AppView._getViewMode() === 'report') AppView._repaintReportView();
  },

  async unshareReportSnapshot(id) {
    if (!AppView.appData) return;
    try {
      const res = await fetch(
        `/api/apps/${AppView.appData.slug}/report-snapshots/${encodeURIComponent(id)}/unshare`,
        { method: 'POST' }
      );
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        AppView._reportSnapshots = undefined;
        if (window.PlatformUI && PlatformUI.toast) PlatformUI.toast('Share link revoked');
      } else if (window.PlatformUI && PlatformUI.toast) {
        PlatformUI.toast(data.error || 'Could not unshare the report');
      }
    } catch {
      if (window.PlatformUI && PlatformUI.toast) PlatformUI.toast('Could not unshare the report');
    }
    if (AppView._getViewMode() === 'report') AppView._repaintReportView();
  },

  // Absolute URL built at click time (location.origin), so the pure list
  // renderer stays origin-free. Clipboard failure falls back to toasting
  // the URL itself so the admin can copy it by hand.
  async copyReportShareLink(path, msg) {
    const url = `${location.origin}${path}`;
    try {
      await navigator.clipboard.writeText(url);
      if (window.PlatformUI && PlatformUI.toast) PlatformUI.toast(msg || 'Link copied');
    } catch {
      if (window.PlatformUI && PlatformUI.toast) PlatformUI.toast(url);
    }
  },
```

`REPORT_CSS` — add after the `.ur-rpt-bullets` lines from Task 5:

```js
    '.ur-rpt-linklike{background:none;border:0;padding:0;color:var(--rpt-accent);cursor:pointer;font:inherit;font-size:inherit;}',
    '.ur-rpt-linklike:hover{text-decoration:underline;}',
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/dev-report.test.js`
Expected: PASS — including the pre-existing "report toolbar offers the AI generate button" and standalone-export invariant tests (the snapshots section renders only in `_repaintReportView`, so the export stays clean; the toolbar test uses no `appData.can_manage`, so the lock button doesn't disturb it).

- [ ] **Step 5: Commit**

```bash
git add public/js/app-view.js tests/dev-report.test.js
git commit -m "feat(report): Lock report button, Previous reports list, share links"
```

---

### Task 7: Spec alignment, full suite, wrap-up

**Files:**
- Modify: `docs/superpowers/specs/2026-08-11-report-lock-share-design.md`

- [ ] **Step 1: Record the two implementation refinements in the spec** (edit the Backend section):
  - The lock POST body is `{ html }` only; `ai_json` is taken from the server's own `app_report_ai` draft cache at lock time, never from the client (stronger than the spec's "validate posted ai").
  - "App admins" is implemented as `appAdmins.canManageApp` — platform admins, the app creator, and declared app admins — matching every other management gate.

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: all green. If `tests/dapp-selectors-resolve.test.js` or shell suites fail, something touched shell markup — this plan must not; investigate rather than refreshing baselines.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-08-11-report-lock-share-design.md
git commit -m "docs: align report-lock-share spec with implementation"
```
