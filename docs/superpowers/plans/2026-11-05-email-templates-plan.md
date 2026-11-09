# Email Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every email Homeroom sends comes from admin-editable templates and layouts in the database, managed from a new admin console section, with images and per-template translation.

**Architecture:** Templates and layouts are versioned database rows, held in an in-memory snapshot on each server. `send()` resolves the snapshot entry and passes it to `buildMessage`, which stays synchronous so transports don't change. A small logic-less language renders values, and the console writes through validated admin routes.

**Tech Stack:** Node/Express, PostgreSQL migrations, React admin section (`AdminUI`), `node:test`. No new runtime dependencies.

**Spec:** `2026-11-05-email-templates-design.md`, beside this file. Commit both under `docs/superpowers/` on the first proposal's branch.

## Global Constraints

- Each proposal below (P1 to P7) is a separate work order: `prepare_work`, branch at its exact base SHA, `submit_work` with `visibleChanges`. Later proposals wait for earlier ones to merge. Task line numbers refer to `626ad3a10`; re-check them against each proposal's base.
- Sign-in mail keeps working at every stage. P1 to P6 keep `TEMPLATES` in place; only P7 deletes it.
- `send()` never throws and never adds more than `READ_PATIENCE_MS` (250 ms) waiting on templates.
- Run named suites or `npm run test:changed -- --base <sha>`, not `npm test`. Commit before running tests.
- Schema: new SQL files plus `node scripts/record-schema-migration.js <name>`; manifest conflicts via `--onto`. Applied files are immutable.
- Admin console text stays in code in English, with `AdminUI` recipes only and no `@/components/ui` imports. Add the section to `OWNED` and `ROUTES` in `scripts/audit-react-ownership.mjs`. A demo-fixture GET must answer 200, not 404.
- No em dashes in code comments or copy. No new `dapp.json` check unless one can't be folded into an existing check.
- Write routes use `requireAdminWrite`; reads use `adminMiddleware`. Log changes with `events.record`.
- Editing takes effect on every server within 30 seconds.

## Review Focus

- A value containing `{{code}}`, `<script>` or `$&` (a project named that way) renders literally, escaped, and is never expanded. Test in Task 1.
- Two admins save the same action at once: the second gets 409 and no action ever has two live templates or none. Test in Task 3.
- A layout edit that removes `{{content}}` or `{{unsubscribeUrl}}`, or restoring an archived version that no longer meets its action's requirements, is refused with the reason. Tests in Task 7.
- A machine translation that drops a `{{#if}}` block, a required placeholder or a link is rejected for that language; the others still save. Test in Task 12.
- A restart must not bring deleted or replaced seed templates back. Test in Task 4.

---

## P1: Store and seed (nothing visible changes)

### Task 1: Template language

**Files:** Create `src/services/mail/template-language.js`, `tests/mail-template-language.test.js`

**Interfaces:** Produces `parse(source) -> { nodes } | throws TemplateSyntaxError{ message, offset }`, `render(source, values, { mode: 'html'|'text', raw: ['content'] }) -> string`, `placeholdersIn(source) -> Set<string>`.

Syntax: `{{name}}`, `{{#if name}}…{{else}}…{{/if}}`, `{{#unless name}}…{{/unless}}`. Names match `[A-Za-z][A-Za-z0-9_]*`. Nothing else exists: no helpers, no paths, no triple braces.

- [ ] **Step 1: Write failing tests**

`escapes in html, not in text`: `render('{{a}}',{a:'<b>&"'},{mode:'html'})` is `&lt;b&gt;&amp;&quot;`; `mode:'text'` returns the input. `is a single pass`: `render('{{a}}',{a:'{{b}}',b:'x'},{mode:'text'})` is `{{b}}`. `dollar patterns are literal`: value `$&` renders `$&`. `conditionals`: empty string, null, false and undefined are false; `0` is true. `nested if works`. `raw names are unescaped`: `raw:['content']`. `unknown value renders empty`. `syntax errors`: `{{#if a}}` unclosed, `{{/if}}` unopened and `{{a b}}` throw with offsets. `placeholdersIn` includes names used only in conditions.

- [ ] **Step 2: Run, expect FAIL**: `node --test tests/mail-template-language.test.js`
- [ ] **Step 3: Implement** as a one-pass tokenizer and tree walk. Escape as `esc` does in `templates.js:26`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit.**

### Task 2: Action registry

**Files:** Create `src/services/mail/actions.js`, `tests/mail-actions.test.js`

**Interfaces:** Produces `ACTIONS: { [kind]: { label, placeholders: { name: { description, kind: 'text'|'url'|'flag', fromCode?: true } }, required: { html: [], text: [] }, englishOnly: boolean, sample: object, values(payload) -> object } }` and `actionFor(kind)`.

- [ ] **Step 1: Write failing tests**: `covers every kind`: keys deep-equal `templates.KINDS` (13). `otp` requires `code` in both forms. `password_reset` requires its link. `build_ready`, `invite_activity`, `project_opened` require `unsubscribeUrl`. `build_ready.subject`, `lead` and `invite_activity.line` carry `fromCode: true`. Only `admin_test` and `content_report` have `englishOnly`. `url values are checked`: `values()` turns a `javascript:` URL into `''`. `sample` satisfies `required`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Read each template in `templates.js` for its payload fields. `values()` derives what the templates compute today (flags like `hasAccount`, `isOne` for a count, signed-in link variants) and reuses `destination` from `tracking.js` (export it) for url kinds. Label strings match the design: "Sign-in code (OTP)", "Waitlist release", and so on.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit.**

### Task 3: Schema and store

**Files:** Create `src/db/migrations/email-templates.sql`, `src/services/mail/template-store.js`, `tests/mail-template-store-postgres.test.js`; modify `src/db/migrations/manifest.json`

**Interfaces:**
- Tables:
  - `email_layouts(id, family_id, name, version, status CHECK live|archived, html, text, created_by, created_at, deleted_at)`, partial unique on `family_id WHERE status='live' AND deleted_at IS NULL`.
  - `email_templates(id, action, name, layout_family_id NULL, version, status, subject, preheader, why, html, text, created_by, created_at, deleted_at)`, partial unique on `action WHERE status='live' AND deleted_at IS NULL`.
  - `email_layout_translations(layout_id, locale, html, text, origin CHECK machine|admin, updated_at)`.
  - `email_template_translations(template_id, locale, subject, preheader, why, html, text, origin, updated_at)`.
  - `email_images(id VARCHAR(32) PK, content_type, data BYTEA, filename, created_by, created_at)`.
- Produces: `snapshot(pool) -> Snapshot`, `saveTemplate(pool, { action, name, layoutFamilyId, subject, preheader, why, html, text, expectedLiveId }, userId) -> row`, `saveLayout(pool, {...}, userId)`, `deleteTemplate(pool, id, { replacementId }, userId)`, `deleteLayout(pool, familyId, { replacementFamilyId }, userId)`, `restoreTemplate(pool, id, userId)`, `saveTranslation(pool, 'template'|'layout', id, locale, fields, origin)`, `listAll(pool)`. A translation belongs to one version row, so a new version has none: that is "out of date".

- [ ] **Step 1: Write failing Postgres tests** (`vibecoding-db-dev`, localhost:5440): `saving archives the previous version`; `concurrent saves`: two saves with the same `expectedLiveId` give one success and one `conflict` error, and exactly one live row; `deleting a live template without a replacement is refused`; `deleting with an archived replacement makes it live`; `the replacement must be the same action`; `deleting a layout in use requires a replacement and moves its templates`; `delete is soft`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Write the migration and record it; implement the store** with each write in one transaction, locking the action's live row `FOR UPDATE`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit.**

### Task 4: First templates, seeded and proven identical

**Files:** Create `src/db/email-template-seeds.js`, `tests/mail-seed-equivalence.test.js`; modify the boot path that applies `src/db/reference-data.js`

**Interfaces:** Produces `SEEDS: { layouts: [...], templates: { [kind]: { name, subject, preheader, why, html, text, layout } } }` with catalog references as `{{t:email:otp.subject}}` expanded at seed time; `seedEmailTemplates(pool)`. Consumes the store and `language-cache`/`push-language` for translations.

- [ ] **Step 1: Write the failing equivalence test.** For each kind and each payload in a matrix (every conditional branch: `waitlist_joined` with and without code and `confirmUrl`; `waitlist_released` across `hasAccount`, `signInLink`, `mobile`; `project_invite` with and without inviter; activity kinds with `notice`, `count`, `notWorking`, `subject`/`lead`), in English and in French from the committed catalog: seeded render deep-equals `buildMessage` for `subject`, `html`, `text`, `headers`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Write the seeds** by hand from `templates.js`, using "Homeroom standard" for `HTML_SHELL`. Keep any inline style strings exact.
- [ ] **Step 4: Implement `seedEmailTemplates`**: for each action with no rows at all, deleted included, insert version 1 and every language the translation lookup can supply. Call at boot. Test `re-seeding after delete adds nothing`.
- [ ] **Step 5: Run, expect PASS** (equivalence, seed, `tests/platform-mail.test.js`).
- [ ] **Step 6: Commit; submit P1** with `impact: none` and the rationale that no sender reads the tables yet.

## P2: Sending switches over (byte-identical mail)

### Task 5: Renderer and send path

**Files:** Create `src/services/mail/render.js`, `tests/mail-render.test.js`, `tests/mail-template-fallback.test.js`; modify `src/services/mail/index.js:201-300`, `src/services/mail/templates.js:875` (`buildMessage`)

**Interfaces:**
- `renderMessage(kind, resolved, payload) -> { subject, html, text, why, preheader, headers }`
- Store adds `resolve(snapshot, kind, locale) -> { template, layout }`, choosing per part: the current translation if there is one, else English.
- `getSnapshot(pool) -> Promise<Snapshot|null>`: memory first, refreshed at most every 30 s, racing a first load against `READ_PATIENCE_MS`, never rejecting. Loaded at server start.
- `buildMessage(kind, payload)` uses `payload.resolved` when present, then continues through `tracking.decorate` unchanged. No transport changes: `send()` passes `resolved` in `worded`.

- [ ] **Step 1: Write failing tests.** `mail-render`: an English body in a translated layout and the reverse (per-part fallback); `opted-out templates render their own html with no layout`; `a translation losing a required value falls back to English` (the `keepsWhatItCarries` rule); `subject control characters are stripped`. `mail-template-fallback`, the owner's order: `database down with a loaded snapshot uses it`; `no snapshot and otp sends a plain mail with the code and logs an error`; `no snapshot and project_opened sends nothing, records status 'no_template' and logs`; `a template that throws on render goes the same way`; `send() still resolves undefined`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Adapt `lastResort` (`templates.js:836`) for step 2 of the failure order, with its `headers` kept. In `send()`, replace `language.translatorFor` with `getSnapshot` and `resolve`; keep suppression, rate limits and `record` as they are. `sendTest` uses the same path for `admin_test`.
- [ ] **Step 4: Run** `tests/mail-render.test.js tests/mail-template-fallback.test.js tests/platform-mail.test.js tests/mail-language.test.js tests/mail-cta.test.js tests/mail-branding.test.js tests/activity-mail.test.js tests/content-report-mail.test.js tests/mail-events.test.js`; expect PASS, updating only tests that mock the translator path.
- [ ] **Step 5: Commit.**

### Task 6: Remove the Brevo template setting

**Files:** Modify `src/services/mail/transports/brevo.js:48-103,148-175`, `src/services/mail/index.js:272`, `tests/mail-brevo.test.js`, and any deploy docs naming `BREVO_MAIL_TEMPLATES`

- [ ] **Step 1: Update tests**: `BREVO_MAIL_TEMPLATES is ignored`: with it set, the request body has `subject` and `htmlContent` and no `templateId`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Delete** `parseTemplates`, `templatePayload`, `templateFor`, `usesProviderTemplate` and the `ownWords` branch; `trackingEnabled` becomes `!!pool && !!tracking.secret()`.
- [ ] **Step 4: Run, expect PASS.** Grep confirms the setting is gone from the repo. Tell the owner if any infra config still sets it.
- [ ] **Step 5: Commit; submit P2** with `impact: none`, citing the equivalence test. Rationale: mail unchanged, no screen changes.

## P3: Console: list, HTML and text editing

### Task 7: Validation and admin routes

**Files:** Create `src/services/mail/html-safety.js`, `src/services/mail/template-validation.js`, `src/routes/admin-email-templates.js`, `tests/mail-html-safety.test.js`, `tests/admin-email-templates.test.js`; modify `src/routes/admin.js` (mount), `src/services/events.js` (new event type near line 120)

**Interfaces:**
- `validateEmailHtml(html) -> { ok } | { ok:false, reason }`: refuses, never rewrites. Like `svg-safety.js`, a tag tokenizer with a blocklist: `script`, `iframe`, `object`, `embed`, `form`, `link`, `meta`, `base`, `on*` attributes, `javascript:`/`data:` URLs, external `@import`. Over 100 KB is refused, since Gmail clips near 102 KB.
- `validateTemplate(action, fields, layout) -> { ok } | { ok:false, errors:[{ field, message }] }`: syntax, unknown placeholders, required placeholders counted across template plus layout, non-empty subject and text.
- `validateLayout(fields, liveTemplates)`: must contain `{{content}}` in both forms, and every template using it must still validate.
- Routes: `GET /api/admin/email-templates`; `POST /api/admin/email-templates`; `POST …/:id/restore`; `DELETE …/:id` body `{replacementId}`; `POST /api/admin/email-templates/preview` body `{action, fields, locale}`; `POST /api/admin/email-templates/test` (reuses `mailTestLimiter`, sends to the signed-in admin); the same set under `/api/admin/email-layouts`.

- [ ] **Step 1: Write failing tests**: safety cases above, including `ONCLICK=` and `java&#115;cript:`. Routes: `view-only admin gets 403 on every write`; `saving otp without {{code}} is 400 naming code`; `restoring a version that fails validation is 400`; `layout edit dropping {{content}} is 400`; `layout edit dropping {{unsubscribeUrl}} is 400 and names the templates`; `stale expectedLiveId is 409`; `preview never stores or sends`; `every write records an event`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit.**

### Task 8: Admin section with HTML and Text tabs

**Files:** Create `frontend/src/features/admin/admin-email-templates.tsx`, `frontend/src/features/admin/email-templates/{list,editor,layouts,replace-dialog,preview}.tsx`, `tests/admin-email-templates-section.test.js`; modify `frontend/src/features/admin/admin-console.js:390` (`{ key: 'email-templates', label: 'Email templates', group: 'Platform' }` and an icon), `sections.ts`, `scripts/audit-react-ownership.mjs:347,427`

**Interfaces:** Publishes `window.AdminEmailTemplates` with `render`/`destroy` as in `admin-mail.tsx`. Consumes Task 7's routes.

Follows the mockup: list per action (name, Live, languages status, edited), New template, Show archived, Layouts tab. Editor: action, name, layout dropdown including "None (complete HTML)", subject, preheader, why, tabs, allowed placeholder list with `fromCode` notes, preview iframe with `sandbox=""` and a language selector, Send test to me. Delete and layout delete open the replacement chooser. A view-only admin sees everything with write controls disabled.

- [ ] **Step 1: Write failing render tests** using `loadTsx` patterns from existing admin tests: `lists 13 actions`, `delete requires choosing a replacement`, `view-only hides writes`, `server errors show beside their field`, `conflict tells the admin to reload`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new suite plus `tests/admin-ui-registry.test.js`; `npm run ensure:shell`; run the app locally and walk create, edit, delete. Expect PASS.
- [ ] **Step 5: Commit; submit P3** declaring the list and editor as a `ui` change at `#admin/email-templates` for an admin persona.

## P4: Visual editor

### Task 9: Lossless text-run mapping

**Files:** Create `frontend/src/features/admin/email-templates/html-runs.ts`, `tests/email-html-runs.test.js`

**Interfaces:** `editableBlocks(source) -> [{ start, end, html }]`: leaf blocks (`p`, `h1-6`, `td`, `li`, `div`, `a` with only inline content) by source offset; conditional tags are never inside a block. `spliceBlock(source, block, html) -> string`. `insertAfterBlock(source, block, snippet) -> string`.

- [ ] **Step 1: Write failing tests**: `for all 13 seeds and the layout, replacing every block with itself is byte-identical`; `editing one block changes only that range`; `{{#if}} tags and table markup are outside every block`; `waitlist_released chip text is editable`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** by tokenizing source, not via DOM serialization.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit.**

### Task 10: Visual tab

**Files:** Create `frontend/src/features/admin/email-templates/visual-tab.tsx`, `tests/email-visual-tab.test.js`; modify `editor.tsx`

**Interfaces:** `<VisualTab source onChange />`, consuming Task 9. Draws the HTML in a same-origin `srcdoc` iframe with `sandbox="allow-same-origin"` (no scripts). Each block is `contenteditable`, placeholders are non-editable chips, conditional regions carry a marked outline and label. Toolbar: Bold, Italic, Link, Button, Image, Insert placeholder. Visual is the default tab. Pasted content is reduced to plain text.

- [ ] **Step 1: Write failing tests**: `opening and saving with no edit sends source unchanged`; `chips serialize back to {{name}}`; `paste strips markup`; `a block edit reaches onChange with only that range changed`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.** Then in a real browser, edit `waitlist_released`'s headline and chip text and send a test to your own inbox, confirming the design survives.
- [ ] **Step 5: Commit; submit P4.**

## P5: Images

### Task 11: Upload and hosting

**Files:** Create `src/routes/email-images.js`, `tests/email-images.test.js`; modify `server.js:642` (mount near it), `src/middleware/auth.js:10` (`/email-images/`), `visual-tab.tsx`, `editor.tsx`

**Interfaces:** `GET /email-images/:id` public, 32-hex id, `IMAGE_CSP`, long cache. `POST /api/admin/email-images` with `requireAdminWrite`, `attachmentUploadLimiter`, raw body: returns `{ id, url }`, with `url` absolute on `config`'s public origin. PNG, JPEG, GIF, WebP via `sniffImageType`; 1 MB; no SVG, since mail clients don't draw it reliably. There's no delete route.

- [ ] **Step 1: Write failing tests**: `HTML disguised as PNG is refused`; `over 1 MB is refused with the 400 envelope`; `served without a session, with CSP`; `unknown id is 404`; `view-only admin can't upload`; `the returned url is absolute`. Add `html-safety` allows `<img src="https://…">` and refuses `data:`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** following `challenge-illustrations.js`, and connect the Image toolbar button, which inserts `<img>` with width and alt fields.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit; submit P5.**

## P6: Translate

### Task 12: Translation job

**Files:** Create `src/services/mail/template-translate.js`, `tests/mail-template-translate.test.js`; modify `src/routes/admin-email-templates.js`

**Interfaces:** `translateVersion(pool, 'template'|'layout', id, { languages, deps }) -> { perLanguage: { [locale]: 'saved'|'failed: reason' } }`. Model `language-sync.js`'s `MODEL`, its glossary via `readGlossary`, and `llm`. Sends subject, preheader, why, html and text as JSON. Routes: `POST …/:id/translate` starts the job, `GET …/:id/translate` reports progress from `platform_settings`-style state, surviving a reload. `PUT …/:id/translations/:locale` saves an admin's correction, origin `admin`, validated the same way. English-only actions refuse. Skips languages with an `admin` translation of this same version unless asked.

- [ ] **Step 1: Write failing tests** with a fake model: `saves every language but English`; `an answer dropping a required placeholder, a conditional or a link is rejected for that language and others save`; `an answer with markup a save would refuse is rejected`; `model failure on one chunk reports that language`; `a new version starts with none, so it's out of date`; `two presses don't run two jobs`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Comparison rule: same placeholder set, same conditional structure, same set of `href`/`src` values.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit.**

### Task 13: Translate in the console

**Files:** Modify `editor.tsx`, `list.tsx`, `layouts.tsx`; create `frontend/src/features/admin/email-templates/translations.tsx`; test in `tests/admin-email-templates-section.test.js`

Translate button with per-language progress, the languages list with a state per language, editing one language's fields in the same tabs (the English is the base shown alongside), and an offer to translate right after saving a layout or a template. The list's "languages" column shows the template's own state, and its layout's when that differs.

- [ ] **Step 1: Write failing tests**: `shows per-language progress and failures`, `save offers translate`, `list counts out-of-date languages`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit; submit P6.**

## P7: Remove what's hard-coded

### Task 14: Delete built-in templates

**Files:** Modify `src/services/mail/templates.js` (delete `TEMPLATES`, its helpers and wording code; keep `buildMessage`, `KINDS` from `ACTIONS`, the bare plain-message function), `src/db/email-template-seeds.js`, `frontend/locales/en/email.json`, `tests/mail-*.test.js`, `tests/platform-mail.test.js`, `tests/content-report-mail.test.js`, `tests/mail-seed-equivalence.test.js`, `tests/mail-language.test.js`, `AGENTS.md`, `frontend/locales/README.md`, `docs/`

- [ ] **Step 1: Before deleting, confirm in production** that all 13 actions have live rows and the translations came across (ask the owner to check the console's list, or `GET /api/admin/email-templates`). Stop if not.
- [ ] **Step 2: Freeze seeds**: expand `{{t:…}}` to plain English in the seeds, for fresh databases and staging copies only. Change `mail-seed-equivalence` to compare against a checked-in snapshot taken beforehand.
- [ ] **Step 3: Delete** `TEMPLATES`, then the `email:` entries nothing reads. Keep those `activity-mail.js` and `homeroom-bot-notify-copy.js` still read; `node scripts/language-inventory.js --ids` shows which. Delete `ENGLISH_ONLY_KINDS` in favour of `ACTIONS`.
- [ ] **Step 4: Move wording-pinning test assertions** onto the seeded render or the snapshot. Never delete a test that pins a code, link, or unsubscribe header reaching the mail.
- [ ] **Step 5: Add a guard** `tests/mail-no-hardcoded.test.js`: `templates.js` contains no `<p>`/`<a ` markup or `email:` ids beyond the plain-message function.
- [ ] **Step 6: Update AGENTS.md** and the locales README: emails are written in the console and don't live in catalogs.
- [ ] **Step 7: Run** every `tests/mail-*.test.js` plus `tests/language-extraction.test.js tests/language-packs.test.js tests/platform-mail.test.js tests/activity-mail.test.js tests/content-report-mail.test.js`; expect PASS.
- [ ] **Step 8: Commit; submit P7** with `impact: none`, as mail is unchanged.
