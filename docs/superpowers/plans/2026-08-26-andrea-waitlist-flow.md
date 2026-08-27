# Andrea's Waitlist Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the shipped platform waitlist in line with the "Simpler waitlist flow proposal" in the *Onboarding / Waitlist Flow* doc — join with an email, answer everything else afterwards, and make the invite mechanic real.

**Architecture:** All five tasks work on the existing two-stage waitlist rather than replacing it. Stage 1 loses its two required questions so joining is email-first; a verification code joins the existing confirm link; the stage-2 "Want in sooner?" form gains a real share link whose joins are attributed back through a new `invited_by` self-reference on `waitlist_signups`; LinkedIn joins the existing OAuth connect plumbing; and the admin screen surfaces the per-signup signals a future scorer will weigh.

**Tech Stack:** Node 20 + Express (CommonJS, `src/`), React 18 + TypeScript islands (`frontend/src/features/`), Postgres via an idempotent `src/db/schema.sql` applied on boot, `node:test` + `node:assert/strict`, Tailwind 3.4.17 pinned.

**Spec:** *Onboarding / Waitlist Flow* — https://docs.google.com/document/d/1FTGJ4KWCLY_mq6O9FYl0LWgC2OSASFfhS1WggHCZev0/edit — section "Simpler waitlist flow proposal", plus the comment threads from Andrea Rodriguez dated 16–22 Jul 2026. Gap analysis: https://claude.ai/code/artifact/35438172-7433-4cd7-81fb-6935c402c9f8

---

## Global Constraints

- **Scoring is out of scope.** Build the storage, the API shape and the admin surfaces that a future scorer will read. Do NOT invent weights, do NOT add a `score` column, do NOT reorder the queue by anything but the existing FIFO or an explicit admin sort. The queue's default order stays `ORDER BY (released_at IS NOT NULL), submitted_at ASC, id ASC`.
- **Cohorts are out of scope.** `invited_by` records who invited whom; nothing consumes it to form a group, and release stays one row at a time.
- **Never edit `public/index.html` or `public/shell/assets/shell.js`.** Both are generated and gitignored. Edit `frontend/src/**`. Run `npm run ensure:shell` before any browser check.
- **Never refresh a baseline to go green.** Every id this plan retires or adds is recorded in `RETIRED_IDS` / `ADDED_IDS` in `tests/shell-id-inventory.test.js`, with a reason, in the same commit as the markup change.
- **No `gray-*` or `indigo-*` Tailwind classes anywhere.** The palette is `zinc` / `violet`, both overridden in `tailwind.config.js`. Every class string is a complete literal — Tailwind's extractor is a regex over source text and a computed class name never compiles.
- **Island rule:** initial render must emit exactly the empty/hidden markup the prerender emits. Data loads in effects, never in initial render — a hydration mismatch `console.error`s, and a console error on any route fails proposal checks.
- **A new table or column holding a secret or personal data needs a `COMMENT ... IS 'staging:private'` AND a matching entry in `src/services/debug-access.js`** (`DENIED_TABLES` for whole tables, `DENIED_COLUMNS` for columns), or `tests/prod-debug-access.test.js` fails.
- **Schema changes are appended to `src/db/schema.sql`** as `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. There are no numbered migration files. Append below the last section, never inside the "Topochain Task 2" block.
- **Run a single suite with** `node --test tests/<name>.test.js`. Run everything with `npm test`.
- **`npm run lint:sql` parses every statically resolvable query against a real Postgres catalog.** Tasks 2, 3 and 5 add SQL, so run it after each. It needs a local Postgres — the default is `postgres://postgres:postgres@127.0.0.1:5432/postgres`. A query built by string concatenation (Task 5's `order` and `where` are both assembled this way, following the handler's existing shape) cannot be resolved statically and lands in `sql-dynamic-baseline.json`; update that baseline in the same commit rather than reshaping the query to satisfy the linter.
- **Copy rule:** never write "verified follow", "we checked", or any wording that claims a follow was confirmed. See Task 4 for why.
- **No em dashes in new user-facing strings** (see commit 77240322).

---

## File Structure

**Modified — server**
- `src/services/waitlist-questions.js` — the two validators and `publicOptions()`. Stage 1 loses its required fields; stage 2 gains `made_url` / `made_note`. One source of truth for what the SPA renders and what the server accepts.
- `src/services/waitlist.js` — the email-keyed waitlist service. Gains verification-code issue/confirm, invite-code minting, and invite attribution.
- `src/services/mail/templates.js` — the `waitlist_joined` mail gains the code.
- `src/services/mail/index.js` — `sendWaitlistJoinMail` gains a `code` argument.
- `src/routes/public-api.js` — the four public waitlist endpoints; gains `POST /api/public/waitlist/confirm`.
- `src/routes/waitlist-connect.js` — OAuth connect; gains the `linkedin` provider.
- `src/routes/topochain/admin/waitlist.js` — admin list; gains signals on each row plus sort and filter.
- `src/config.js` — two LinkedIn OAuth keys.
- `src/services/debug-access.js` — deny entries for the new private table and columns.
- `src/db/schema.sql` — one new table, two new columns.

**Created — server**
- `src/services/waitlist-signals.js` — a pure function turning a signup row into the countable facts a scorer would weigh. No weights, no total.

**Modified — frontend**
- `frontend/src/features/auth/waitlist.tsx` — the join screen. Loses the "link something you've made" block; discovery becomes optional; gains the code entry on the success state.
- `frontend/src/features/auth/more.tsx` — the "Want in sooner?" form. Gains the made-something block, the share link, the referral count; loses the five typed-email rows.
- `frontend/src/features/auth/shared.ts` — shared fetch helpers if a new one is needed.
- `frontend/src/features/admin/topochain/waitlist.tsx` — admin screen; renders the signals column and the new filters.
- `scripts/audit-react-ownership.mjs` — no change expected; verify the waitlist hosts are already scoped.

**Modified — tests**
- `tests/waitlist-questions.test.js`, `tests/onboarding-waitlist.test.js`, `tests/topochain-admin-api.test.js`, `tests/waitlist-connect-config.test.js`, `tests/shell-id-inventory.test.js`, `tests/prod-debug-access.test.js`

**Created — tests**
- `tests/waitlist-verification-code.test.js`, `tests/waitlist-invites.test.js`, `tests/waitlist-signals.test.js`

---

### Task 1: Join with an email, answer the rest later

The doc's stage 1 is "Email + verification code (no questions), Country, How did you hear about us (optional)". The shipped stage 1 rejects a join without `made_url` ("Please link something you have made") **and** without `discovery_source`. Andrea and Evan settled this in a comment thread — Evan asked whether joining needed more than an email and Andrea answered "Just an email!".

This task makes country and discovery optional and moves the made-something question to stage 2, where it becomes one of the things that helps you move up.

**Files:**
- Modify: `src/services/waitlist-questions.js:189-220` (`validateStage1`), `:225-310` (`validateStage2`)
- Modify: `frontend/src/features/auth/waitlist.tsx:108-160` (submit + preflight), `:196-270` (markup)
- Modify: `frontend/src/features/auth/more.tsx`
- Modify: `tests/waitlist-questions.test.js:29-72`
- Modify: `tests/shell-id-inventory.test.js` (`RETIRED_IDS`, `ADDED_IDS`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `validateStage1(body) -> { ok: true, value } | { ok: false, error }` where `value` may now be `{}`. `validateStage2` additionally accepts `made_url` (string, max 2000, must match `/^https?:\/\/\S+\.\S+/i`) and `made_note` (string, max 140), emitting them as `value.made_url` / `value.made_note`.

- [ ] **Step 1: Write the failing tests**

Replace the first two tests in `tests/waitlist-questions.test.js` (currently `'stage 1 requires a plausible made_url'` and `'stage 1 requires a KNOWN discovery source'`) with:

```js
test('stage 1 accepts an email-only join — every survey field is optional', () => {
  const bare = q.validateStage1({});
  assert.equal(bare.ok, true);
  assert.deepEqual(bare.value, {});
});

test('stage 1 still rejects unknown enum values it is given', () => {
  assert.equal(q.validateStage1({ discovery_source: 'carrier-pigeon' }).ok, false);
  assert.equal(q.validateStage1({ country: 'ZZ' }).ok, false);
  for (const key of Object.keys(q.DISCOVERY_SOURCES)) {
    assert.equal(q.validateStage1({ discovery_source: key }).ok, true);
  }
});

test('stage 1 no longer accepts made_url — it belongs to stage 2 now', () => {
  const r = q.validateStage1({ made_url: 'https://example.com', made_note: 'a bot' });
  assert.equal(r.ok, true);
  assert.equal(r.value.made_url, undefined);
  assert.equal(r.value.made_note, undefined);
});

test('stage 2 takes made_url and validates it looks like a link', () => {
  assert.equal(q.validateStage2({ made_url: 'not a link' }).ok, false);
  const r = q.validateStage2({ made_url: 'https://example.com/repo', made_note: '  A Discord bot  ' });
  assert.equal(r.ok, true);
  assert.equal(r.value.made_url, 'https://example.com/repo');
  assert.equal(r.value.made_note, 'A Discord bot');
});
```

In the existing `'stage 1 cleans optional fields and rejects unknown countries'` test, delete the `made_note` assertion and the `made_url` key from its `base`; keep the country, city, discovery-detail and referrer assertions.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/waitlist-questions.test.js`
Expected: FAIL — the email-only join returns `ok: false` with "Please link something you have made", and `validateStage2` ignores `made_url`.

- [ ] **Step 3: Rewrite `validateStage1`**

Replace the whole function in `src/services/waitlist-questions.js`:

```js
// Stage 1: email plus a couple of optional context questions. Nothing
// here is required — the doc's "Simpler waitlist flow proposal" settled
// on an email-only join, so a bare POST with just an address is a valid
// signup and returns an empty answers object. Unknown enum values are
// still rejected rather than stored.
function validateStage1(body) {
  const country = str(body?.country, 2);
  if (country && !countryCodes().includes(country.toUpperCase())) {
    return { ok: false, error: 'Unknown country.' };
  }

  const source = str(body?.discovery_source, 32);
  if (source && !Object.prototype.hasOwnProperty.call(DISCOVERY_SOURCES, source)) {
    return { ok: false, error: 'Unknown discovery source.' };
  }

  const detail = str(body?.discovery_detail, 255);
  const city = str(body?.city, 120);
  const referrer = str(body?.referrer_handle, 255);

  const value = {};
  if (source) value.discovery = detail ? { source, detail } : { source };
  if (country) value.country = country.toUpperCase();
  if (city) value.city = city;
  if (referrer) value.referrer_handle = referrer;
  return { ok: true, value };
}
```

- [ ] **Step 4: Teach `validateStage2` the made-something question**

In `src/services/waitlist-questions.js`, immediately after `function validateStage2(body) {` and its `const value = {};` line, insert:

```js
  // Moved here from stage 1: "link something you've made" is one of the
  // things that helps you move up, not a gate on joining at all.
  const madeUrl = str(body?.made_url, 2000);
  if (madeUrl) {
    if (!/^https?:\/\/\S+\.\S+/i.test(madeUrl)) {
      return { ok: false, error: 'That does not look like a link — it should start with https://' };
    }
    value.made_url = madeUrl;
    const madeNote = str(body?.made_note, 140);
    if (madeNote) value.made_note = madeNote;
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/waitlist-questions.test.js`
Expected: PASS, all tests.

- [ ] **Step 6: Strip the made-something block out of the join form**

In `frontend/src/features/auth/waitlist.tsx`:

Delete the entire `<div>` containing `<label htmlFor="waitlist-made-url">` through the closing `</div>` after `id="waitlist-made-note"` (around lines 200-232). Delete the `madeUrl` and `madeNote` refs and their declarations.

In `onSubmit`, delete these lines:

```js
      const madeUrlVal = madeUrl.current?.value.trim() || '';
      if (!madeUrlVal) {
        return setMsg({ text: 'Please link something you have made.', tone: 'error' });
      }
      if (!discovery) {
        return setMsg({ text: 'Please tell us how you found us.', tone: 'error' });
      }
```

and remove `made_url` and `made_note` from the request body, leaving:

```js
          body: JSON.stringify({
            email: emailVal,
            country: country.current?.value || undefined,
            city: city.current?.value.trim() || undefined,
            discovery_source: discovery || undefined,
            discovery_detail: discoveryDetail.current?.value.trim() || undefined,
            referrer_handle: referrer.current?.value.trim() || undefined,
          }),
```

- [ ] **Step 7: Mark discovery optional and fix the intro copy**

In the same file, on the "How did you hear about us" label, replace the required marker with the optional one — matching the "Where are you?" block exactly:

```jsx
              <span className="text-zinc-500 font-normal dark:text-zinc-400">
                Optional
              </span>
```

And replace the sentence fragment `Four questions to join.` with:

```jsx
          <span className="font-medium text-zinc-700 dark:text-zinc-200">
            Just your email to join.
          </span>
```

- [ ] **Step 8: Use Andrea's success copy**

The success state at `#waitlist-joined` currently reads "You're on the waitlist — we'll email you when your spot opens." Andrea's proposal words this moment deliberately: the reassurance is that access opens in *small groups*, which is what makes the invite mechanic in Task 3 make sense.

In `frontend/src/features/auth/waitlist.tsx`, replace that paragraph with:

```jsx
          <p className="text-sm text-emerald-700 dark:text-emerald-400 font-medium">
            You&rsquo;re on the list 🎉
          </p>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            We&rsquo;re opening access in small groups. We&rsquo;ll email you when yours comes up.
          </p>
```

Note the em dash goes with it — new user-facing strings do not use them (commit 77240322).

- [ ] **Step 9: Add the made-something block to the stage-2 form**

In `frontend/src/features/auth/more.tsx`, add a `madeUrl` and `madeNote` ref alongside the existing refs, add the two fields to the section list rendered by the form, and include them in the POST body. Use the ids `more-made-url` and `more-made-note` (NOT the retired `waitlist-` names) and copy the class strings verbatim from the block deleted in Step 6:

```jsx
          <div>
            <label
              htmlFor="more-made-url"
              className="block text-sm font-medium text-zinc-700 dark:text-zinc-200"
            >
              Link something you&rsquo;ve made
            </label>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-1.5">
              A repo, a site, a bot, a mod, a newsletter, a spreadsheet that runs your fantasy league. Built with AI counts, we care that it exists, not how you made it.
            </p>
            <input
              ref={madeUrl}
              id="more-made-url"
              type="url"
              maxLength={2000}
              placeholder="https://"
              className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
            />
            <input
              ref={madeNote}
              id="more-made-note"
              type="text"
              maxLength={140}
              placeholder="What is it, in one line? — optional"
              className="mt-2 w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
            />
          </div>
```

The stage-2 loader already hydrates fields from `data.answers`; add `if (madeUrl.current) madeUrl.current.value = a.made_url || '';` and the matching `made_note` line beside the existing `referrer_handle` hydration.

- [ ] **Step 10: Record the id moves in the baseline**

In `tests/shell-id-inventory.test.js`, add to `RETIRED_IDS`:

```js
  // ── Andrea's simpler waitlist flow: joining is email-only ─────────
  // "Link something you've made" was a REQUIRED stage-1 field, which
  // contradicted the flow the doc settled on ("Just an email!"). The
  // question is not gone — it moved to the stage-2 "Want in sooner?"
  // form as #more-made-url / #more-made-note, where it is one of the
  // things that helps you move up rather than a gate on joining.
  'waitlist-made-url': 'Moved to the stage-2 survey as #more-made-url; joining no longer asks it.',
  'waitlist-made-note': 'Moved to the stage-2 survey as #more-made-note, with its url field.',
```

and to `ADDED_IDS`:

```js
  'more-made-url': 'The "link something you\'ve made" field, relocated from the join form (was #waitlist-made-url).',
  'more-made-note': 'Its one-line description (was #waitlist-made-note).',
```

- [ ] **Step 11: Run the shell baselines and the full suite**

Run: `npm run ensure:shell && node --test tests/shell-id-inventory.test.js tests/dapp-selectors-resolve.test.js tests/shell-script-order.test.js`
Expected: PASS. `dapp.json` selects only on `waitlist-email`, `waitlist-form`, `waitlist-joined` and `waitlist-screen`, none of which this task touches.

Run: `npm test`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add src/services/waitlist-questions.js frontend/src/features/auth/waitlist.tsx frontend/src/features/auth/more.tsx tests/waitlist-questions.test.js tests/shell-id-inventory.test.js
git commit -m "Join the waitlist with an email; the rest is stage 2"
```

---

### Task 2: A verification code beside the confirm link

The doc says "Email + verification code". What ships is a one-click confirm link, which is one click on desktop and awkward on a phone, where leaving for the mail app loses your place in the WebView.

Add the code and keep the link. Both stamp the same `confirmed_at`; whichever arrives first wins. The machinery already exists — `mobile_otp_codes` stores bcrypt-hashed codes with an attempt cap and an expiry, and `sendOtpMail` already sends them — so this task copies a proven shape rather than inventing one.

**Files:**
- Modify: `src/db/schema.sql` (append)
- Modify: `src/services/debug-access.js:49` (`DENIED_TABLES`)
- Modify: `src/services/waitlist.js`
- Modify: `src/services/mail/templates.js:171` (`waitlistJoined`), `src/services/mail/index.js:382`
- Modify: `src/routes/public-api.js:179-209`
- Modify: `frontend/src/features/auth/waitlist.tsx` (success state)
- Modify: `tests/prod-debug-access.test.js` if it asserts an exact table count
- Test: `tests/waitlist-verification-code.test.js` (create)

**Interfaces:**
- Consumes: `normalizeEmail(raw) -> string | null` from `src/services/waitlist.js`.
- Produces:
  - `issueVerificationCode(pool, email) -> Promise<string>` — returns the plaintext six-digit code; stores only its bcrypt hash. Deletes any unconsumed code for that email first.
  - `confirmSignupByCode(pool, email, code) -> Promise<{ id, email, confirmed_at, more_token } | null>` — null on unknown email, wrong code, expired code, or too many attempts. Never distinguishes between them to the caller.
  - `sendWaitlistJoinMail(config, email, { moreToken, code })` — `code` is optional; when present the mail carries it.

- [ ] **Step 1: Write the failing test**

Create `tests/waitlist-verification-code.test.js`. Model the mock pool on the one in `tests/onboarding-waitlist.test.js` — read that file first and reuse its `collapse(sql)` helper and its `state.signups` map, adding a `state.codes` array.

```js
// src/services/waitlist.js — the email verification CODE that rides
// beside the one-click confirm link (Andrea's "Email + verification
// code"). Same shape as mobile_otp_codes: bcrypt-hashed, attempt-capped,
// expiring, single-use.
//
// Contracts guarded here:
//
//   1. The plaintext code is returned to the caller and NEVER stored —
//      only its bcrypt hash lands in the table.
//   2. Issuing a second code invalidates the first (one live code per
//      email), so a forwarded older mail cannot confirm.
//   3. A wrong code increments attempts and, past the cap, the right
//      code stops working too — the same null every other failure
//      returns, so the endpoint can never be used as an oracle.
//   4. Confirming by code is idempotent with confirming by link: both
//      stamp confirmed_at and the FIRST timestamp wins.
//
// Run with: node --test tests/waitlist-verification-code.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { issueVerificationCode, confirmSignupByCode, joinWaitlist } = require('../src/services/waitlist');

// ... mock pool copied from tests/onboarding-waitlist.test.js, extended
// with a `codes` array ...

test('the plaintext code is returned but never stored', async () => {
  const { pool, state } = makePool();
  await joinWaitlist(pool, { email: 'a@example.com' });
  const code = await issueVerificationCode(pool, 'a@example.com');
  assert.match(code, /^[0-9]{6}$/);
  assert.equal(state.codes.length, 1);
  assert.notEqual(state.codes[0].code_hash, code);
});

test('issuing a second code invalidates the first', async () => {
  const { pool } = makePool();
  await joinWaitlist(pool, { email: 'a@example.com' });
  const first = await issueVerificationCode(pool, 'a@example.com');
  await issueVerificationCode(pool, 'a@example.com');
  assert.equal(await confirmSignupByCode(pool, 'a@example.com', first), null);
});

test('the right code confirms the signup and returns its stage-2 token', async () => {
  const { pool } = makePool();
  await joinWaitlist(pool, { email: 'a@example.com' });
  const code = await issueVerificationCode(pool, 'a@example.com');
  const row = await confirmSignupByCode(pool, 'a@example.com', code);
  assert.ok(row);
  assert.ok(row.confirmed_at);
  assert.match(row.more_token, /^[a-f0-9]{48}$/);
});

test('a used code cannot be used twice', async () => {
  const { pool } = makePool();
  await joinWaitlist(pool, { email: 'a@example.com' });
  const code = await issueVerificationCode(pool, 'a@example.com');
  await confirmSignupByCode(pool, 'a@example.com', code);
  assert.equal(await confirmSignupByCode(pool, 'a@example.com', code), null);
});

test('too many wrong guesses kill the code even for the right answer', async () => {
  const { pool } = makePool();
  await joinWaitlist(pool, { email: 'a@example.com' });
  const code = await issueVerificationCode(pool, 'a@example.com');
  for (let i = 0; i < 5; i += 1) {
    assert.equal(await confirmSignupByCode(pool, 'a@example.com', '000000'), null);
  }
  assert.equal(await confirmSignupByCode(pool, 'a@example.com', code), null);
});

test('an unknown email returns the same null a wrong code does', async () => {
  const { pool } = makePool();
  assert.equal(await confirmSignupByCode(pool, 'nobody@example.com', '123456'), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/waitlist-verification-code.test.js`
Expected: FAIL with "issueVerificationCode is not a function".

- [ ] **Step 3: Add the table to the schema**

Append to the end of `src/db/schema.sql`:

```sql
-- ── Waitlist email verification codes ──────────────────────────────────
--
-- The six-digit code that rides beside the one-click confirm link in the
-- join mail (the doc's "Email + verification code"). Same shape and same
-- guarantees as `mobile_otp_codes`: only the bcrypt hash is stored, one
-- live code per email, capped attempts, and a short expiry. Keyed by
-- email like the waitlist itself, so a code can exist before any account
-- does.
CREATE TABLE IF NOT EXISTS waitlist_verification_codes (
  id           BIGSERIAL PRIMARY KEY,
  email        VARCHAR(255) NOT NULL,
  code_hash    VARCHAR(255) NOT NULL,
  attempts     SMALLINT NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_waitlist_verification_codes_email
  ON waitlist_verification_codes (email);
COMMENT ON TABLE waitlist_verification_codes IS 'staging:private';
```

In `src/services/debug-access.js`, add to `DENIED_TABLES`:

```js
  'waitlist_verification_codes', // one-time waitlist email codes, same treatment as mobile_otp_codes
```

- [ ] **Step 4: Implement the two service functions**

In `src/services/waitlist.js`, add `const bcrypt = require('bcrypt');` beside the existing requires, and these constants and functions after `confirmSignupByMoreToken`:

```js
// How long a verification code lives, and how many wrong guesses it
// survives. Both mirror mobile_otp_codes rather than inventing new
// numbers — a person reading a code out of their mail is the same
// person in the same hurry either way.
const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

// Mint a six-digit verification code for an email on the waitlist.
// Returns the PLAINTEXT code for the caller to mail; only its bcrypt
// hash is stored. Any unconsumed code for the address is deleted first,
// so exactly one code is ever live and a forwarded older mail is dead.
async function issueVerificationCode(pool, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error('invalid email');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const hash = await bcrypt.hash(code, 10);
  await pool.query(
    'DELETE FROM waitlist_verification_codes WHERE email = $1 AND consumed_at IS NULL',
    [normalized]
  );
  await pool.query(
    `INSERT INTO waitlist_verification_codes (email, code_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '15 minutes')`,
    [normalized, hash]
  );
  return code;
}

// Confirm a signup with its emailed code. Returns the signup row (with
// more_token, so the caller can hand back the stage-2 capability) or
// null. EVERY failure returns the same null — unknown email, wrong code,
// expired, consumed, too many attempts — so this endpoint can never be
// used to test whether an address is on the list.
async function confirmSignupByCode(pool, email, code) {
  const normalized = normalizeEmail(email);
  if (!normalized || typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) return null;

  const { rows } = await pool.query(
    `SELECT id, code_hash, attempts, expires_at
       FROM waitlist_verification_codes
      WHERE email = $1 AND consumed_at IS NULL
      ORDER BY id DESC
      LIMIT 1`,
    [normalized]
  );
  const entry = rows[0];
  if (!entry) return null;
  if (new Date(entry.expires_at) < new Date()) return null;
  if (entry.attempts >= MAX_CODE_ATTEMPTS) return null;

  const matches = await bcrypt.compare(code, entry.code_hash);
  if (!matches) {
    await pool.query(
      'UPDATE waitlist_verification_codes SET attempts = attempts + 1 WHERE id = $1',
      [entry.id]
    );
    return null;
  }

  await pool.query(
    'UPDATE waitlist_verification_codes SET consumed_at = NOW() WHERE id = $1',
    [entry.id]
  );
  const { rows: signup } = await pool.query(
    `UPDATE waitlist_signups
        SET confirmed_at = COALESCE(confirmed_at, NOW())
      WHERE email = $1
      RETURNING id, email, confirmed_at, more_token`,
    [normalized]
  );
  return signup[0] || null;
}
```

Add both to `module.exports`, plus `MAX_CODE_ATTEMPTS` for the tests.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/waitlist-verification-code.test.js`
Expected: PASS.

- [ ] **Step 6: Put the code in the mail**

In `src/services/mail/templates.js`, inside `waitlistJoined`, insert this immediately after the two opening `text` / `html` assignments and BEFORE the `if (confirmUrl)` block, so the code is the first thing in the mail:

```js
  if (payload.code) {
    text += `\n\nYour verification code is ${payload.code}. It works for 15 minutes.`;
    html += p(`Your verification code is <strong>${payload.code}</strong>. It works for 15 minutes.`);
  }
```

In `src/services/mail/index.js`, widen the sender:

```js
async function sendWaitlistJoinMail(config, email, { moreToken = null, code = null } = {}) {
  await send(config, {
    kind: 'waitlist_joined',
    to: email,
    code,
    url: moreToken ? `${PRODUCTION_ORIGIN}/#more/${moreToken}` : null,
    confirmUrl: moreToken
      ? `${PRODUCTION_ORIGIN}/api/public/waitlist/confirm/${moreToken}`
      : null,
  });
}
```

- [ ] **Step 7: Issue the code on join and add the confirm endpoint**

In `src/routes/public-api.js`, inside the `POST /api/public/waitlist` handler, replace the `if (created) { ... }` block with:

```js
      if (created) {
        log.info('public-api', 'Waitlist join', {});
        const code = await waitlist.issueVerificationCode(pool, email).catch(() => null);
        sendWaitlistJoinMail(config, email, { moreToken, code }); // fire-and-forget, never throws
      }
```

Then add a new endpoint immediately after the existing `confirm/:token` route:

```js
  // POST /api/public/waitlist/confirm — the same confirmation as the
  // one-click link, by the code carried in the same mail. It exists for
  // the phone, where leaving the app for the mail client loses the
  // WebView's place; on desktop the link is still one click.
  //
  // Always-200 on a valid-looking body: a 404 here would answer "is this
  // address on the waitlist?" for anyone who asks.
  router.post('/api/public/waitlist/confirm', waitlistTokenLimiter, async (req, res) => {
    const email = waitlist.normalizeEmail(req.body?.email);
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    if (!email || !/^[0-9]{6}$/.test(code)) {
      return res.status(422).json({ error: 'Enter the six-digit code from your email.' });
    }
    try {
      const row = await waitlist.confirmSignupByCode(pool, email, code);
      if (!row) {
        return res.status(422).json({ error: 'That code is wrong or has expired. Ask for a new one.' });
      }
      return res.json({ ok: true, more_token: row.more_token || null });
    } catch (err) {
      log.error('public-api', 'waitlist code confirm failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
```

- [ ] **Step 8: Add the code entry to the join success state**

In `frontend/src/features/auth/waitlist.tsx`, add a ref, a state flag and a handler beside the existing ones:

```jsx
  const code = useRef<HTMLInputElement>(null);
  const [confirmed, setConfirmed] = useState(false);

  const onConfirmCode = useCallback(async () => {
    const codeVal = code.current?.value.trim() || '';
    if (!/^[0-9]{6}$/.test(codeVal)) {
      return setMsg({ text: 'Enter the six-digit code from your email.', tone: 'error' });
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/public/waitlist/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.current?.value.trim() || '', code: codeVal }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        setMsg(null);
        setConfirmed(true);
        const token = (data && data.more_token) || null;
        if (token) {
          setMoreToken(token);
          setOffer(true);
        }
      } else {
        setMsg({ text: (data && data.error) || 'That code did not work.', tone: 'error' });
      }
    } catch {
      setMsg({ text: 'Connection issue — try again.', tone: 'error' });
    }
    setSubmitting(false);
  }, []);
```

The email input keeps its value after a join (the form is hidden, not cleared), so `email.current` is still the address the code was mailed to. Do not clear it in `onSubmit`.

Render this inside the `#waitlist-joined` block, directly under the two copy paragraphs from Task 1 and above the stage-2 offer:

```jsx
          <div id="waitlist-confirm" className={hiddenLast(confirmed, 'mt-4')}>
            <label htmlFor="waitlist-code" className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
              Confirm your email
            </label>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-1.5">
              We sent a six-digit code. You can also just click the link in that email.
            </p>
            <div className="flex gap-2">
              <input
                ref={code}
                id="waitlist-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-mono placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
              <button
                id="waitlist-code-submit"
                type="button"
                disabled={submitting}
                onClick={onConfirmCode}
                className="shrink-0 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-60 px-3 py-2 text-sm font-medium text-white focus:outline-none focus:ring-2 focus:ring-violet-500"
              >
                Confirm
              </button>
            </div>
          </div>
```

`hiddenLast` is already imported in this file and used by `#waitlist-form`. The block renders visible on the success state and hides once confirmed, so the initial (form-visible) render is unaffected and there is no hydration concern.

- [ ] **Step 9: Record the new id**

In `tests/shell-id-inventory.test.js`, add to `ADDED_IDS`:

```js
  'waitlist-confirm': 'The confirm-your-email block on the join success state. Hides once the code is accepted.',
  'waitlist-code': 'Six-digit email verification code; confirms the same row the mailed link does.',
  'waitlist-code-submit': 'Submits the verification code.',
```

- [ ] **Step 10: Run the suites**

Run: `node --test tests/waitlist-verification-code.test.js tests/prod-debug-access.test.js tests/platform-mail.test.js tests/shell-id-inventory.test.js`
Expected: PASS. If `tests/prod-debug-access.test.js` asserts an exact denied-table count, bump it and note the new table in the comment beside the number.

Run: `npm test`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/db/schema.sql src/services/debug-access.js src/services/waitlist.js src/services/mail/templates.js src/services/mail/index.js src/routes/public-api.js frontend/src/features/auth/waitlist.tsx tests/waitlist-verification-code.test.js tests/shell-id-inventory.test.js tests/prod-debug-access.test.js
git commit -m "Confirm a waitlist email by code as well as by link"
```

---

### Task 3: A real invite link, and joins attributed back to it

This is the heart of Andrea's proposal, and the part the current form only mimes. Today stage 2 collects up to five typed email addresses and a free-text "who referred you" — none of which sends anything, links anything, or is ever read back.

Her design is a **share link**: "Share your invite link. If they join, we'll connect your applications so we can try to bring you in together", with the page updating to "# people from your invite joined 🎉". The typed rows are retired, because a field that accepts an address and does nothing with it is a promise the product does not keep.

**Note on scope:** this task records the invite graph and shows it. Nothing consumes it to form a cohort, and release remains one row at a time — that is deliberate, per the Global Constraints.

**Files:**
- Modify: `src/db/schema.sql` (append), `src/services/debug-access.js:112` (`DENIED_COLUMNS.waitlist_signups`)
- Modify: `src/services/waitlist.js`, `src/services/waitlist-questions.js` (drop `MAX_INVITES` and the `invites` branch)
- Modify: `src/routes/public-api.js`
- Modify: `frontend/src/features/auth/more.tsx`
- Modify: `tests/waitlist-questions.test.js:102` (the invites-cap test)
- Modify: `tests/shell-id-inventory.test.js`
- Test: `tests/waitlist-invites.test.js` (create)

**Interfaces:**
- Consumes: `joinWaitlist(pool, { email, ip, answers })` and `getSignupByMoreToken(pool, token)` from Task 2's file.
- Produces:
  - `joinWaitlist(pool, { email, ip = null, answers = null, inviteCode = null })` — unchanged return `{ created, moreToken }`; when `inviteCode` resolves to another signup, the new row's `invited_by` is set to that signup's id. A code that does not resolve is ignored silently, never an error.
  - `inviteCodeFor(pool, signupId) -> Promise<string>` — returns the row's `invite_code`, minting and storing a 10-char lowercase-alphanumeric one on first call. Idempotent.
  - `invitedBySignup(pool, signupId) -> Promise<{ count: number, emails: string[] }>` — how many signups this one brought in, with their emails masked as `al***@example.com`.

- [ ] **Step 1: Write the failing test**

Create `tests/waitlist-invites.test.js`, reusing the mock-pool idiom from `tests/onboarding-waitlist.test.js`:

```js
// src/services/waitlist.js — the invite link and its attribution
// (Andrea's "Bring someone you'd build with" / "we'll connect your
// applications").
//
// Contracts guarded here:
//
//   1. inviteCodeFor mints once and is idempotent — a signup's link is
//      stable, because it has already been shared by the time it is
//      asked for a second time.
//   2. Joining with a valid invite code records invited_by; joining with
//      a bogus one is a NORMAL join, never an error. A stranger typing
//      ?ref=garbage must still be able to sign up.
//   3. A signup can never be its own inviter, and attribution is
//      recorded only on a FIRST join — re-joining with someone else's
//      code cannot re-parent an existing row.
//   4. invitedBySignup masks the emails it reports. The inviter is told
//      how many people joined, not who they are in full.
//
// Run with: node --test tests/waitlist-invites.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { joinWaitlist, inviteCodeFor, invitedBySignup } = require('../src/services/waitlist');

// ... mock pool, extended so waitlist_signups rows carry invite_code and invited_by ...

test('an invite code is minted once and stays stable', async () => {
  const { pool, state } = makePool();
  await joinWaitlist(pool, { email: 'a@example.com' });
  const id = state.signups.get('a@example.com').id;
  const first = await inviteCodeFor(pool, id);
  assert.match(first, /^[a-z0-9]{10}$/);
  assert.equal(await inviteCodeFor(pool, id), first);
});

test('joining with a valid code records who invited you', async () => {
  const { pool, state } = makePool();
  await joinWaitlist(pool, { email: 'a@example.com' });
  const inviter = state.signups.get('a@example.com').id;
  const code = await inviteCodeFor(pool, inviter);

  await joinWaitlist(pool, { email: 'b@example.com', inviteCode: code });
  assert.equal(state.signups.get('b@example.com').invited_by, inviter);
});

test('a bogus invite code is ignored, not rejected', async () => {
  const { pool, state } = makePool();
  const { created } = await joinWaitlist(pool, { email: 'b@example.com', inviteCode: 'nonsense99' });
  assert.equal(created, true);
  assert.equal(state.signups.get('b@example.com').invited_by, null);
});

test('re-joining with a code cannot re-parent an existing row', async () => {
  const { pool, state } = makePool();
  await joinWaitlist(pool, { email: 'a@example.com' });
  const code = await inviteCodeFor(pool, state.signups.get('a@example.com').id);
  await joinWaitlist(pool, { email: 'b@example.com' });
  await joinWaitlist(pool, { email: 'b@example.com', inviteCode: code });
  assert.equal(state.signups.get('b@example.com').invited_by, null);
});

test('the inviter is told a count and masked addresses', async () => {
  const { pool, state } = makePool();
  await joinWaitlist(pool, { email: 'a@example.com' });
  const inviter = state.signups.get('a@example.com').id;
  const code = await inviteCodeFor(pool, inviter);
  await joinWaitlist(pool, { email: 'alice@example.com', inviteCode: code });
  await joinWaitlist(pool, { email: 'bob@example.com', inviteCode: code });

  const invited = await invitedBySignup(pool, inviter);
  assert.equal(invited.count, 2);
  assert.deepEqual(invited.emails.sort(), ['al***@example.com', 'bo***@example.com']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/waitlist-invites.test.js`
Expected: FAIL with "inviteCodeFor is not a function".

- [ ] **Step 3: Add the two columns**

Append to `src/db/schema.sql`:

```sql
-- ── Waitlist invite links ──────────────────────────────────────────────
--
-- `invite_code` is the shareable half of a signup's link
-- (/#waitlist?ref=<code>), minted on demand the first time the stage-2
-- form asks for it. `invited_by` is who that link brought in, recorded
-- at join time and only on a FIRST join, so an existing row can never be
-- re-parented by someone re-submitting the form with a different code.
--
-- The graph is recorded and displayed; NOTHING consumes it to form a
-- cohort yet. Admitting people together is a later, separate decision.
ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS invite_code VARCHAR(32);
CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_signups_invite_code
  ON waitlist_signups (invite_code) WHERE invite_code IS NOT NULL;
ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS invited_by BIGINT
  REFERENCES waitlist_signups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_waitlist_signups_invited_by
  ON waitlist_signups (invited_by);
COMMENT ON COLUMN waitlist_signups.invite_code IS 'staging:private';
```

In `src/services/debug-access.js`, add to the `waitlist_signups` entry in `DENIED_COLUMNS`:

```js
    'invite_code', // shareable capability — anyone holding it is attributed as this signup's invitee
```

- [ ] **Step 4: Implement the three service functions**

In `src/services/waitlist.js`, change `joinWaitlist` to accept and resolve an invite code:

```js
async function joinWaitlist(pool, { email, ip = null, answers = null, inviteCode = null }) {
  const moreToken = crypto.randomBytes(24).toString('hex');
  const stored = answers
    ? { _version: ANSWERS_VERSION, ...answers }
    : null;

  // Resolve the inviter BEFORE the insert, and treat an unresolvable
  // code as no code at all: someone arriving on a stale or mistyped
  // ?ref= link must still be able to join.
  let invitedBy = null;
  if (typeof inviteCode === 'string' && /^[a-z0-9]{10}$/.test(inviteCode)) {
    const { rows } = await pool.query(
      'SELECT id FROM waitlist_signups WHERE invite_code = $1',
      [inviteCode]
    );
    if (rows[0]) invitedBy = rows[0].id;
  }

  const { rowCount } = await pool.query(
    `INSERT INTO waitlist_signups (email, ip, answers, more_token, invited_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email) DO NOTHING`,
    [email, ip, stored ? JSON.stringify(stored) : null, moreToken, invitedBy]
  );
  const created = rowCount > 0;
  return { created, moreToken: created ? moreToken : null };
}
```

Because the attribution rides on the INSERT, contract 3 (no re-parenting) falls out of `ON CONFLICT DO NOTHING` for free — do not add a separate UPDATE path.

Then add:

```js
// The shareable half of a signup's invite link. Minted on first ask and
// stable thereafter — by the second call the link may already be in
// somebody's group chat.
async function inviteCodeFor(pool, signupId) {
  const { rows } = await pool.query(
    'SELECT invite_code FROM waitlist_signups WHERE id = $1',
    [signupId]
  );
  if (!rows[0]) return null;
  if (rows[0].invite_code) return rows[0].invite_code;

  const code = crypto.randomBytes(8).toString('hex').slice(0, 10);
  const { rows: updated } = await pool.query(
    `UPDATE waitlist_signups
        SET invite_code = COALESCE(invite_code, $1)
      WHERE id = $2
      RETURNING invite_code`,
    [code, signupId]
  );
  return updated[0] ? updated[0].invite_code : null;
}

// Who this signup brought in. The inviter is shown a count and masked
// addresses — enough to recognise a friend who joined, not enough to
// harvest the list.
function maskEmail(email) {
  const [local, domain] = String(email).split('@');
  if (!domain) return '***';
  return `${local.slice(0, 2)}***@${domain}`;
}

async function invitedBySignup(pool, signupId) {
  const { rows } = await pool.query(
    'SELECT email FROM waitlist_signups WHERE invited_by = $1 ORDER BY submitted_at ASC',
    [signupId]
  );
  return { count: rows.length, emails: rows.map((r) => maskEmail(r.email)) };
}
```

Export `inviteCodeFor`, `invitedBySignup` and `maskEmail`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/waitlist-invites.test.js`
Expected: PASS.

- [ ] **Step 6: Retire the typed invite rows from the validator**

In `src/services/waitlist-questions.js`, delete the `MAX_INVITES` constant, the `invites` branch inside `validateStage2`, and `max_invites` from `publicOptions()`. Remove `MAX_INVITES` from `module.exports`.

In `tests/waitlist-questions.test.js`, rewrite `'stage 2 shapes handles/invites and caps invites at MAX_INVITES'` as:

```js
test('stage 2 shapes handles and no longer accepts typed invites', () => {
  const r = q.validateStage2({
    discord: '  someone#1  ',
    other_handle: '@elsewhere',
    invites: ['a@example.com', 'b@example.com'],
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.handles.discord, 'someone#1');
  assert.equal(r.value.handles.other, '@elsewhere');
  // The invite link replaced the typed rows — a stray `invites` key from
  // an old client is dropped, not stored.
  assert.equal(r.value.invites, undefined);
});
```

Update `'publicOptions exposes exactly the option sets the validators accept'` to drop `max_invites`.

- [ ] **Step 7: Serve the link and the count**

In `src/routes/public-api.js`, extend the `GET /api/public/waitlist/more/:token` handler so its response includes the invite state:

```js
      const inviteCode = await waitlist.inviteCodeFor(pool, row.id);
      const invited = await waitlist.invitedBySignup(pool, row.id);
      res.json({
        ok: true,
        answers: row.answers || {},
        options: questions.publicOptions(),
        connect: {
          github: !!(config.waitlistGithubClientId && config.waitlistGithubClientSecret),
          x: !!(config.waitlistXClientId && config.waitlistXClientSecret),
          linkedin: !!(config.waitlistLinkedinClientId && config.waitlistLinkedinClientSecret),
        },
        invite: {
          url: inviteCode ? `${PRODUCTION_ORIGIN}/#waitlist?ref=${inviteCode}` : null,
          count: invited.count,
          emails: invited.emails,
        },
      });
```

`PRODUCTION_ORIGIN` is not yet imported in this file — add it beside the existing requires at the top:

```js
const { PRODUCTION_ORIGIN } = require('../services/cli-auth-constants');
```

which is the same import `src/services/mail/index.js` already uses for the confirm and survey links. The `linkedin` key is added here in advance of Task 4; it reads `false` until that task adds the config.

In the `POST /api/public/waitlist` handler, read the code off the body and pass it through:

```js
      const { created, moreToken } = await waitlist.joinWaitlist(pool, {
        email,
        ip: clientIp(req),
        answers: stage1.value,
        inviteCode: typeof req.body?.invite_code === 'string' ? req.body.invite_code : null,
      });
```

- [ ] **Step 8: Replace the typed rows with the link in the form**

In `frontend/src/features/auth/more.tsx`:

Delete the `invites` state, `InviteRow`, `invitesRef`, `setInviteRows`, `inviteRows`, `addInvite`, `removeInvite`, `inviteEls`, `nextInviteId`, the `#more-invites` container and the `#more-invite-add` button, and the `invites: typed` key in the POST body.

In their place render the share link and its result, using Andrea's copy. The whole block reads from `data.invite` loaded in the existing effect, so its initial render must be the empty shell:

```jsx
          <div>
            <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
              Bring someone you&rsquo;d build with
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-1.5">
              We try to admit people together. Things are more fun with people you know. Share your link, and if they join we&rsquo;ll connect your applications so we can try to bring you in together.
            </p>
            <div className="flex gap-2">
              <input
                id="more-invite-url"
                type="text"
                readOnly={true}
                value={inviteUrl}
                className="w-full rounded-lg bg-zinc-50 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-mono text-zinc-700 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
              <button
                id="more-invite-copy"
                type="button"
                onClick={onCopyInvite}
                className="shrink-0 rounded-lg bg-violet-600 hover:bg-violet-500 px-3 py-2 text-sm font-medium text-white focus:outline-none focus:ring-2 focus:ring-violet-500"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div id="more-invite-joined" className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              {inviteCount > 0 ? (
                <>
                  <span className="font-medium text-zinc-700 dark:text-zinc-200">
                    {`${inviteCount} ${inviteCount === 1 ? 'person' : 'people'} from your invite joined 🎉`}
                  </span>
                  {` ${inviteEmails.join(', ')}`}
                </>
              ) : null}
            </div>
          </div>
```

`inviteUrl` starts `''`, `inviteCount` starts `0`, `inviteEmails` starts `[]` — so the first render is an empty read-only input and an empty status div, matching the prerender. All three are filled by the existing stage-2 load effect, from the `invite` object Step 7 added to the payload:

```js
      setInviteUrl(data.invite?.url || '');
      setInviteCount(data.invite?.count || 0);
      setInviteEmails(Array.isArray(data.invite?.emails) ? data.invite.emails : []);
```

And the copy handler, beside the other callbacks:

```js
  const [copied, setCopied] = useState(false);

  // clipboard.writeText rejects on an insecure origin and is absent in
  // some in-app WebViews, so a failure falls back to selecting the text
  // for the person to copy by hand rather than silently doing nothing.
  const onCopyInvite = useCallback(async () => {
    const el = document.getElementById('more-invite-url') as HTMLInputElement | null;
    if (!el || !el.value) return;
    try {
      await navigator.clipboard.writeText(el.value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      el.select();
    }
  }, []);
```

- [ ] **Step 9: Carry `?ref=` from the landing route into the join POST**

In `frontend/src/features/auth/waitlist.tsx`, read the ref out of the hash query segment on mount and include it in the POST body:

```js
  // The invite link is /#waitlist?ref=<code> — the code rides in the
  // hash's query segment (after '?' INSIDE the fragment), the same place
  // waitlist-connect.js puts its status, so it never reaches a server log.
  const inviteRef = useRef<string | null>(null);
  useEffect(() => {
    try {
      const q = window.location.hash.split('?')[1] || '';
      const ref = new URLSearchParams(q).get('ref');
      inviteRef.current = /^[a-z0-9]{10}$/.test(ref || '') ? ref : null;
    } catch {
      inviteRef.current = null;
    }
  }, []);
```

and add `invite_code: inviteRef.current || undefined,` to the request body.

- [ ] **Step 10: Record the id changes**

In `tests/shell-id-inventory.test.js`, add to `RETIRED_IDS`:

```js
  // ── Andrea's simpler waitlist flow: the invite link is real now ────
  // The five typed-address rows collected emails and did nothing with
  // them: no invite was sent, no attribution recorded, no count shown.
  // They are replaced by a share link whose joins ARE attributed
  // (waitlist_signups.invited_by), which is the mechanic the doc asks
  // for. Nothing that worked was removed, because nothing worked.
  'more-invites': 'Typed-address invite rows retired for the share link (#more-invite-url); they sent nothing.',
  'more-invite-add': 'The "add another" button for the retired invite rows.',
```

and to `ADDED_IDS`:

```js
  'more-invite-url': "The signup's shareable invite link; joins through it set waitlist_signups.invited_by.",
  'more-invite-copy': 'Copies the invite link to the clipboard.',
  'more-invite-joined': 'How many people joined through this link. Empty until the stage-2 effect loads.',
```

- [ ] **Step 11: Run the suites**

Run: `node --test tests/waitlist-invites.test.js tests/waitlist-questions.test.js tests/onboarding-waitlist.test.js tests/shell-id-inventory.test.js tests/prod-debug-access.test.js`
Expected: PASS.

Run: `npm run ensure:shell && npm test`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add src/db/schema.sql src/services/debug-access.js src/services/waitlist.js src/services/waitlist-questions.js src/routes/public-api.js frontend/src/features/auth/more.tsx frontend/src/features/auth/waitlist.tsx tests/waitlist-invites.test.js tests/waitlist-questions.test.js tests/shell-id-inventory.test.js
git commit -m "Give each waitlist signup a real invite link, and attribute the joins"
```

---

### Task 4: LinkedIn connect, and copy that does not overclaim

Andrea's item is "Follow & verify follow on X, LinkedIn, and MAYBE IG? / Should verify that the follow action was completed."

**That last line cannot be built as written, and the plan does not pretend otherwise.** What the existing OAuth proves is *handle ownership*: the person controls that account. Learning whether they follow a given account is a different question, and the three networks answer it differently:

- **X** can answer it, with the `follows.read` scope and `GET /2/users/:id/following` — but that endpoint sits on a paid API tier. The current scope is `users.read tweet.read`. This is a budget decision, not a code decision, and it is deliberately left out.
- **LinkedIn** has no API for it at all. There is no endpoint that reports whether a member follows a company page.
- **Instagram** likewise.

So this task adds LinkedIn to the connect plumbing, links out to the follow, and fixes the copy so it says what actually happened. Do not write "verified follow" anywhere.

**Files:**
- Modify: `src/routes/waitlist-connect.js:63-75` (`providerConfig`), `:110-150` (`resolveHandle`), `:159-200` (authorize + callback)
- Modify: `src/config.js`
- Modify: `dapp.json` (two `platform_env` declarations)
- Modify: `frontend/src/features/auth/more.tsx` (connect row + copy)
- Modify: `tests/waitlist-connect-config.test.js`

**Interfaces:**
- Consumes: `setVerifiedHandle(pool, token, provider, handle)` from `src/services/waitlist.js` — already provider-agnostic, stores under `answers.verified[provider]`.
- Produces: nothing new is exported. `providerConfig` and `resolveHandle` stay module-private; `waitlistConnectRoutes(config)` gains a third provider on the routes it already serves.

**Read `tests/waitlist-connect-config.test.js` in full before starting.** It pins two contracts this task must satisfy, and both are easy to miss: every `process.env.WAITLIST_*` the platform reads must be declared in `dapp.json`'s `platform_env` block (an undeclared read is invisible in the admin panel), and an unconfigured provider must degrade to `?connect=unavailable` rather than erroring. That file tests behaviour through a mounted router — `providerConfig` is not exported, and this task must not export it.

- [ ] **Step 1: Write the failing test**

In `tests/waitlist-connect-config.test.js`, add `linkedin` to the two provider loops that currently read `['github', 'x']`, add the empty LinkedIn keys to `UNSET` and real ones to `CONFIGURED`:

```js
const UNSET = {
  env: 'production',
  port: 3000,
  waitlistGithubClientId: '',
  waitlistGithubClientSecret: '',
  waitlistXClientId: '',
  waitlistXClientSecret: '',
  waitlistLinkedinClientId: '',
  waitlistLinkedinClientSecret: '',
  waitlistOauthOrigin: '',
};

const CONFIGURED = {
  ...UNSET,
  waitlistGithubClientId: 'gh-id',
  waitlistGithubClientSecret: 'gh-secret',
  waitlistXClientId: 'x-id',
  waitlistXClientSecret: 'x-secret',
  waitlistLinkedinClientId: 'li-id',
  waitlistLinkedinClientSecret: 'li-secret',
};
```

and add:

```js
test('a configured linkedin sends the signer to LinkedIn with the minimum scope', async () => {
  const res = await get(configured.base, `/waitlist/connect/linkedin?token=${TOKEN}`);
  assert.equal(res.status, 302);
  const url = new URL(res.headers.get('location'));
  assert.equal(url.origin + url.pathname, 'https://www.linkedin.com/oauth/v2/authorization');
  assert.equal(url.searchParams.get('client_id'), 'li-id');
  assert.equal(url.searchParams.get('response_type'), 'code');
  // `openid profile` is the smallest scope that returns a name. We ask
  // for no email — the waitlist row already has one — and there is no
  // follow scope to ask for, on LinkedIn or anywhere.
  assert.equal(url.searchParams.get('scope'), 'openid profile');
  assert.equal(
    url.searchParams.get('redirect_uri'),
    `${PRODUCTION_ORIGIN}/waitlist/connect/linkedin/callback`,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/waitlist-connect-config.test.js`
Expected: FAIL — a configured LinkedIn still redirects to `?connect=unavailable`, and the manifest test fails on two undeclared `WAITLIST_LINKEDIN_*` reads once Step 3 lands.

- [ ] **Step 3: Add the config keys**

In `src/config.js`, beside the existing `waitlistXClientId` / `waitlistXClientSecret` entries, add `waitlistLinkedinClientId` and `waitlistLinkedinClientSecret`, reading `WAITLIST_LINKEDIN_CLIENT_ID` and `WAITLIST_LINKEDIN_CLIENT_SECRET`. Follow the exact shape of the two entries above them.

- [ ] **Step 4: Declare both variables in `dapp.json`**

A `WAITLIST_*` read with no declaration cannot be discovered by an admin, and `tests/waitlist-connect-config.test.js` fails on it. Add to the `platform_env` array, in the `Waitlist` group, immediately after the two `WAITLIST_X_*` entries. `required` MUST be `false` — a `required: true` declaration with no value blocks the merge, and these credentials come from a human with the owning LinkedIn account, so no pull request can supply them:

```json
    {
      "key": "WAITLIST_LINKEDIN_CLIENT_ID",
      "group": "Waitlist",
      "required": false,
      "description": "Client ID of the LinkedIn OpenID Connect app that confirms a waitlist signer controls their LinkedIn account. Needs the openid and profile scopes. Callback: https://<your-domain>/waitlist/connect/linkedin/callback. Unset: the Connect LinkedIn button is hidden. It confirms account ownership only, never whether the member follows a page: LinkedIn has no API that reports that."
    },
    {
      "key": "WAITLIST_LINKEDIN_CLIENT_SECRET",
      "group": "Waitlist",
      "required": false,
      "private": true,
      "description": "Client secret paired with WAITLIST_LINKEDIN_CLIENT_ID. Private: encrypted at rest and never returned by any API. Both halves must be set together or the Connect LinkedIn button stays hidden."
    },
```

Also extend the `WAITLIST_OAUTH_ORIGIN` description so it names LinkedIn alongside GitHub and X — all three validate `redirect_uri` before any platform code runs, so changing the origin means re-registering with all three.

- [ ] **Step 5: Add the provider**

In `src/routes/waitlist-connect.js`, extend `providerConfig`:

```js
  if (provider === 'linkedin') {
    return config.waitlistLinkedinClientId && config.waitlistLinkedinClientSecret
      ? { id: config.waitlistLinkedinClientId, secret: config.waitlistLinkedinClientSecret }
      : null;
  }
```

In the authorize handler, beside the `github` and `x` branches:

```js
    if (provider === 'linkedin') {
      // OpenID Connect. `openid profile` is the smallest scope that
      // returns a name from /v2/userinfo — we ask for nothing else, and
      // in particular no email: the waitlist row already has one.
      const url = 'https://www.linkedin.com/oauth/v2/authorization?' + new URLSearchParams({
        response_type: 'code',
        client_id: creds.id,
        redirect_uri: callbackUrl(config, provider),
        state: nonce,
        scope: 'openid profile',
      });
      return res.redirect(url);
    }
```

In `resolveHandle`:

```js
  if (provider === 'linkedin') {
    const tokenResp = await fetchJson('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: creds.id,
        client_secret: creds.secret,
      }).toString(),
    });
    if (!tokenResp || !tokenResp.access_token) throw new Error('no access token');
    const me = await fetchJson('https://api.linkedin.com/v2/userinfo', {
      headers: { authorization: `Bearer ${tokenResp.access_token}` },
    });
    const name = me && (me.name || [me.given_name, me.family_name].filter(Boolean).join(' '));
    if (!name) throw new Error('no linkedin profile');
    return name;
  }
```

LinkedIn does not use PKCE here, so the `verifier` argument is unused for this provider — mirror how the `github` branch ignores it.

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test tests/waitlist-connect-config.test.js`
Expected: PASS.

- [ ] **Step 7: Fix the copy and add the follow links**

In `frontend/src/features/auth/more.tsx`, find the connect row's heading and body text. Replace whatever claims verification of a follow with:

```jsx
            <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
              Follow along
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-1.5">
              Connecting an account confirms it&rsquo;s yours. Following us is up to you, and we can&rsquo;t check it, so we won&rsquo;t claim we did.
            </p>
```

Add a LinkedIn connect button beside the GitHub and X ones, rendered on the same `connect.linkedin` flag the stage-2 payload now carries, with id `more-connect-linkedin` and the same class string as `#more-connect-x`.

- [ ] **Step 8: Record the new id**

In `tests/shell-id-inventory.test.js`, add to `ADDED_IDS`:

```js
  'more-connect-linkedin': 'LinkedIn OAuth connect on the stage-2 waitlist form. Proves handle ownership only; no API reports whether a member follows a page.',
```

- [ ] **Step 9: Run the suites**

Run: `node --test tests/waitlist-connect-config.test.js tests/shell-id-inventory.test.js && npm test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/config.js dapp.json src/routes/waitlist-connect.js frontend/src/features/auth/more.tsx tests/waitlist-connect-config.test.js tests/shell-id-inventory.test.js
git commit -m "Add LinkedIn connect, and stop implying we check follows"
```

---

### Task 5: Show admins what each signup actually did

The doc's premise is that answering more moves you up. Nothing scores anything yet, and by the Global Constraints nothing will in this plan. What an admin needs first is to **see** the signals — and what a future scorer needs is for those signals to be derived in one place rather than recomputed in the screen.

This task adds a pure signals function, puts it on every admin row, and gives the list a sort and two filters. Release order still defaults to FIFO.

**Files:**
- Create: `src/services/waitlist-signals.js`
- Modify: `src/routes/topochain/admin/waitlist.js:27-45` (`formatSignup`), `:66-95` (list handler)
- Modify: `frontend/src/features/admin/topochain/waitlist.tsx:255-305` (`WAITLIST_COLUMNS`)
- Test: `tests/waitlist-signals.test.js` (create)
- Modify: `tests/topochain-admin-api.test.js`

**Interfaces:**
- Consumes: `formatSignup(row)`'s `answers` object, and the `invited_by` column from Task 3.
- Produces: `signalsFor(row) -> { confirmed: boolean, verified: string[], sections: string[], invited: number }` where `verified` is the sorted keys of `answers.verified`, and `sections` is the sorted subset of `['made', 'where', 'found', 'group', 'loss', 'handles']` the signup has filled in. **No weights and no total** — a scorer is a later, separate decision.

- [ ] **Step 1: Write the failing test**

Create `tests/waitlist-signals.test.js`:

```js
// src/services/waitlist-signals.js — the countable facts about a waitlist
// signup, derived in ONE place so the admin screen and any future scorer
// read the same thing.
//
// Contracts guarded here:
//
//   1. It reports facts, never a score. There is deliberately no total
//      and no weighting — what each signal is worth is an unmade
//      product decision, and baking a number in here would quietly make
//      it.
//   2. A section counts as answered only when it holds real content, so
//      an empty object left behind by a partial save is not a signal.
//   3. It never throws on a malformed or null answers blob — these rows
//      come from a public endpoint and predate several schema versions.
//
// Run with: node --test tests/waitlist-signals.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { signalsFor } = require('../src/services/waitlist-signals');

test('an empty signup has no signals at all', () => {
  assert.deepEqual(signalsFor({}), {
    confirmed: false, verified: [], sections: [], invited: 0,
  });
});

test('a null or malformed answers blob is survivable', () => {
  assert.deepEqual(signalsFor({ answers: null }).sections, []);
  assert.deepEqual(signalsFor({ answers: 'nonsense' }).sections, []);
  assert.deepEqual(signalsFor({ answers: [] }).sections, []);
});

test('sections count only when they hold real content', () => {
  assert.deepEqual(signalsFor({ answers: { group: {} } }).sections, []);
  assert.deepEqual(signalsFor({ answers: { group: { name: 'Chess club' } } }).sections, ['group']);
});

test('every section is recognised, and the list is sorted', () => {
  const answers = {
    made_url: 'https://example.com',
    country: 'DE',
    discovery: { source: 'x' },
    group: { name: 'Chess club' },
    loss: { had: 'yes' },
    handles: { discord: 'someone#1' },
  };
  assert.deepEqual(signalsFor({ answers }).sections,
    ['found', 'group', 'handles', 'loss', 'made', 'where']);
});

test('verified handles are listed by provider, sorted', () => {
  const answers = { verified: { x: '@someone', github: 'someone', linkedin: 'Some One' } };
  assert.deepEqual(signalsFor({ answers }).verified, ['github', 'linkedin', 'x']);
});

test('confirmation and invite count come off the row, not the answers', () => {
  const s = signalsFor({ confirmed_at: '2026-08-01T00:00:00Z', invited_count: 3 });
  assert.equal(s.confirmed, true);
  assert.equal(s.invited, 3);
});

test('there is no score — adding one is a product decision, not a refactor', () => {
  assert.equal(signalsFor({}).score, undefined);
  assert.equal(signalsFor({}).total, undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/waitlist-signals.test.js`
Expected: FAIL with "Cannot find module '../src/services/waitlist-signals'".

- [ ] **Step 3: Implement the signals module**

Create `src/services/waitlist-signals.js`:

```js
// The countable facts about a waitlist signup.
//
// This module reports what somebody DID — confirmed their address,
// verified a social account, filled in a section, brought people in —
// and deliberately stops there. It computes no score and applies no
// weights: what each signal is worth decides who gets in first, and
// that is an unmade product decision. Baking a number in here would
// quietly make it, in the place nobody would think to look.
//
// One source of truth so the admin screen and whatever eventually ranks
// the queue cannot disagree about what "answered the group question"
// means.
'use strict';

// The stage-2 sections, mapped to the answers keys that carry them. A
// section counts only when it holds real content: a partial save can
// leave an empty object behind, and an empty object is not a signal.
const SECTIONS = [
  ['made', (a) => !!a.made_url],
  ['where', (a) => !!(a.country || a.city)],
  ['found', (a) => !!(a.discovery && a.discovery.source)],
  ['group', (a) => !!(a.group && Object.keys(a.group).length)],
  ['loss', (a) => !!(a.loss && Object.keys(a.loss).length)],
  ['handles', (a) => !!(a.handles && Object.keys(a.handles).length)],
];

function signalsFor(row) {
  const raw = row && row.answers;
  // Arrays and strings both pass a bare typeof check; neither is an
  // answers blob. These rows come from a public endpoint and predate
  // several versions of this schema, so nothing here may throw.
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  const verified = a.verified && typeof a.verified === 'object' && !Array.isArray(a.verified)
    ? Object.keys(a.verified).filter((k) => a.verified[k]).sort()
    : [];

  const sections = SECTIONS.filter(([, has]) => has(a)).map(([name]) => name).sort();

  return {
    confirmed: !!(row && row.confirmed_at),
    verified,
    sections,
    invited: Number((row && row.invited_count) || 0),
  };
}

module.exports = { signalsFor, SECTIONS };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/waitlist-signals.test.js`
Expected: PASS.

- [ ] **Step 5: Put the signals on every admin row**

In `src/routes/topochain/admin/waitlist.js`, require the module and extend `formatSignup`:

```js
const { signalsFor } = require('../../../services/waitlist-signals');
```

```js
    // What this signup actually did — derived in one place
    // (services/waitlist-signals.js) so the screen and any future
    // ranking read the same facts. Facts only: there is no score here.
    signals: signalsFor(row),
```

In the list query, add the invite count as a correlated subquery so `signalsFor` can see it, and support the new sort and filters:

```js
      const status = typeof req.query.status === 'string' ? req.query.status : '';
      const only = typeof req.query.only === 'string' ? req.query.only : '';
      const clauses = [];
      if (status === 'pending') clauses.push('w.released_at IS NULL');
      else if (status === 'released') clauses.push('w.released_at IS NOT NULL');
      if (only === 'confirmed') clauses.push('w.confirmed_at IS NOT NULL');
      else if (only === 'invited') {
        clauses.push('EXISTS (SELECT 1 FROM waitlist_signups c WHERE c.invited_by = w.id)');
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

      // Default stays FIFO — "the natural release order for a queue", and
      // the only order this plan ships. `sort=answered` is an admin's
      // manual lens over the same rows, never an automatic ranking: it
      // sorts by how much someone filled in, which is a coarse proxy and
      // deliberately not a score.
      //
      // The key count has to be computed in SQL rather than from
      // signalsFor, because the list is paginated — sorting the 200 rows
      // a page happens to contain would order each page against itself.
      // jsonb_object_keys rejects a non-object, and these rows come from
      // a public endpoint across several schema versions, so the typeof
      // guard is load-bearing. `_version` is counted along with the real
      // sections; for a coarse ordering that is fine.
      const answeredCount = `
        CASE WHEN jsonb_typeof(w.answers) = 'object'
             THEN (SELECT COUNT(*) FROM jsonb_object_keys(w.answers))
             ELSE 0 END`;
      const order = req.query.sort === 'answered'
        ? `ORDER BY (w.released_at IS NOT NULL),
                    (w.confirmed_at IS NOT NULL) DESC,
                    ${answeredCount} DESC,
                    w.submitted_at ASC, w.id ASC`
        : `ORDER BY (w.released_at IS NOT NULL), w.submitted_at ASC, w.id ASC`;
```

and add to the SELECT list:

```sql
                (SELECT COUNT(*)::int FROM waitlist_signups c WHERE c.invited_by = w.id) AS invited_count,
```

Both `COUNT` subqueries hit `idx_waitlist_signups_invited_by` from Task 3.

- [ ] **Step 6: Render the signals column**

In `frontend/src/features/admin/topochain/waitlist.tsx`, add a `Signals` column to `WAITLIST_COLUMNS`, placed after `Joined`. Use the console's density, not the shell's — small text, no cards:

```jsx
  {
    label: 'Signals',
    cell: (w) => {
      const s = w.signals;
      if (!s) return <span className="text-zinc-500 dark:text-zinc-400">—</span>;
      const bits: string[] = [];
      if (s.sections.length) bits.push(`${s.sections.length}/6 answered`);
      if (s.verified.length) bits.push(s.verified.join(', '));
      if (s.invited) bits.push(`invited ${s.invited}`);
      return bits.length
        ? <span className="text-xs text-zinc-600 dark:text-zinc-300">{bits.join(' · ')}</span>
        : <span className="text-xs text-zinc-500 dark:text-zinc-400">nothing yet</span>;
    },
  },
```

Add `signals?: { confirmed: boolean; verified: string[]; sections: string[]; invited: number }` to the `WaitlistRow` type, and add the two filter options to the existing status filter control so `?only=confirmed` and `?only=invited` are reachable. Do NOT import from `@/components/ui/` here — this is the admin surface and `tests/admin-ui-registry.test.js` enforces the boundary.

- [ ] **Step 7: Scope the host in the ownership audit**

Confirm `scripts/audit-react-ownership.mjs` already carries an entry for the waitlist admin host. If it does not, add:

```js
  { sel: '#admin-topo-content', when: '#admin/topochain/waitlist' },
```

and the route to `ROUTES`. The `when` clause is load-bearing — the host is shared between programme screens, so an unscoped entry would report a sibling screen's writes as a violation.

- [ ] **Step 8: Extend the admin API test**

In `tests/topochain-admin-api.test.js`, add a case asserting that a listed signup carries `signals` with the four keys and no `score`, and that `?only=confirmed` narrows the set.

- [ ] **Step 9: Run everything**

Run: `node --test tests/waitlist-signals.test.js tests/topochain-admin-api.test.js tests/admin-ui-registry.test.js tests/topochain-admin-screens.test.js`
Expected: PASS.

Run: `npm run ensure:shell && npm test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/services/waitlist-signals.js src/routes/topochain/admin/waitlist.js frontend/src/features/admin/topochain/waitlist.tsx scripts/audit-react-ownership.mjs tests/waitlist-signals.test.js tests/topochain-admin-api.test.js
git commit -m "Show admins what each waitlist signup actually did"
```

---

## Deliberately not in this plan

- **The scoring formula.** Task 5 stores and shows every fact a scorer would read. Choosing the weights decides who gets in first and needs its own decision.
- **Cohorts.** Task 3 records the invite graph. Forming a group from it, balancing across the regions the country data already buckets, and releasing a batch is a separate plan.
- **A "join the waitlist" button on shared app pages** — Andrea's most recent comment, 22 Jul, still unanswered. It is a share-link change, and the share-link flow is out of scope here.
- **The X follow check.** Needs `follows.read` and a paid X API tier. A budget decision, not a code one. See Task 4.
- **Mobile.** The Flutter app is a separate repository. The server contracts this plan adds are additive, so nothing in the app breaks — but `GET /api/v4/mobile/me` still returns `is_in_waitlist` from a `users` column that nothing has written since the one-time grandfather backfill, so it is permanently `false` for every account created since. That is a live bug, unrelated to Andrea's proposal, and wants its own fix.
