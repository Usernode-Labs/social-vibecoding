# Email templates in the admin console: design

Read against canonical main `626ad3a10ca84da695f8dc6ab8a50af29e7e18c7`. Status: owner said go ahead on 5 Nov 2026, including the four recommendations below. Marked "(builder's call)" where it's open, "(assumed, not confirmed)" where the owner heard the assumption and didn't object or correct it.

## Why

Changing any email's wording or look today means a code change and a group vote. The owner hit this with the waitlist release and OTP emails. Admins should be able to write, translate and replace every email Homeroom sends from the admin console, with no email content left in code.

## Goals

1. A new **Email templates** section in the admin console (group Platform, beside Email delivery): create, edit, delete.
2. Every template names its **target action** (sign-in code, waitlist release, and so on).
3. Each template has a subject, an HTML version and a text version. Images can be added to the HTML.
4. A **layout** feature: a reusable structure (header, footer, shared styling, a content slot). A template picks a layout from a dropdown and writes only the middle, or opts out and is complete HTML itself.
5. A **Translate** button on each template and layout that fills in every other language.
6. No hard-coded email templates remain in the code.

## Non-goals

- Admins defining new actions. An action needs code to trigger it, so the list stays in code (assumed, not confirmed).
- Editing templates through a proposal or vote. Console changes go live straight away. This deliberately takes email wording out of group review and out of what tests pin.
- Scheduling, campaigns, audience targeting or A/B tests.
- Designing emails in Brevo. Brevo remains a delivery provider only.

## Must not happen

- A sign-in, password reset or other code email goes out without its code or link.
- An action ends up with no live template.
- A person's name, project title or other supplied value injects markup into an email.
- Old translated wording goes out after the English changed.
- An activity email goes out without its unsubscribe link and `List-Unsubscribe` header.

## Decisions the owner made

- **Translation:** a Translate button per template fills in the remaining languages.
- **One live template per action:** creating a new template for an action makes it live immediately and archives the previous one.
- **No hard-coded templates:** today's built-in emails are removed from the code.
- **Deleting a live template:** the admin must choose what replaces it. There is no automatic fallback.
- **Editor:** a visual editor where you type on the email itself, with HTML and Text as further tabs. Option B in the mockup; the list page and editor mockups are the reference for layout.
- **Layouts:** exist, are selected per template by dropdown, and a template may opt out.
- **Brevo:** remove `BREVO_MAIL_TEMPLATES` (`src/services/mail/transports/brevo.js`) and the provider-template path. Console templates always decide the content.

## Assumed, stated to the owner, not objected to

- Today's emails become the first templates, with the translations they already have, so readers see no change on the day this ships.
- View-only admins can read but not change (`requireAdminWrite` on writes).
- Images are uploaded in the editor and hosted by Homeroom at a public address.
- Each action allows its own placeholders. A template missing a required one can't be saved.
- Click tracking keeps working, and activity emails keep their unsubscribe link even if the template omits it.
- A language whose translation is out of date falls back to English rather than sending stale wording.
- Pressing Translate after an English edit refreshes the other languages. An admin can review and correct a translation.
- Saving an edit to a live template creates a new version and archives the previous one.
- Saving a layout updates every template using it immediately, and archives its previous version.
- Deleting a layout in use makes the admin choose a replacement layout for those templates.
- Today's shared frame becomes one layout, "Homeroom standard".

## What exists today

- `src/services/mail/templates.js` (894 lines): 13 kinds: `otp`, `account_email`, `username_change`, `waitlist_joined`, `waitlist_code`, `waitlist_released`, `password_reset`, `admin_test`, `content_report`, `project_invite`, `build_ready`, `invite_activity`, `project_opened`. `admin_test` and `content_report` are English only (`ENGLISH_ONLY_KINDS`).
- Wording comes from `frontend/locales/en/email.json` (110 messages), translated by the background step (`src/services/language-sync.js`, `language-sync-runner.js`, `language-cache.js`). 13 languages are configured in `frontend/locales/config.json`.
- `HTML_SHELL` is the shared frame: preheader, 520px card, logo, body, footer with a "why you got this" line. The logo and release illustration are absolute URLs on the production origin.
- Templates have logic: `waitlist_joined` prints a code and a confirm link only if present, `waitlist_released` varies by `hasAccount` and `mobile`, activity kinds take `notice`, `count`, `notWorking`. `build_ready` can take `subject` and `lead` from callers (`homeroom-bot-notify-copy.js`).
- `buildMessage(kind, payload)` is **synchronous** and is called by every transport (`gmail.js`, `http-api.js`, `brevo.js`, `log.js`), by `send()` and `sendTest()` in `mail/index.js`, and re-exported by `topochain/mail-transport.js`. Templates in a database mean this has to change: for example `send()` loads the template first and passes it down.
- `tracking.decorate` rewrites links and adds the open pixel. `keepsWhatItCarries` refuses a translation that loses the code or a link. `lastResort` is a bare-minimum body when the catalog is lost.
- About 20 test files pin this code (`tests/platform-mail.test.js`, `mail-branding`, `mail-cta`, `mail-language`, `mail-brevo`, `activity-mail`, `content-report-mail` and others). Many pin the rendered text and will need rewriting.
- The challenge illustration upload (`src/routes/topochain/challenge-illustrations.js`) is the pattern for admin image upload: public bytes route with an unguessable id, no real deletes, strict SVG handling.
- The frontend has no rich-text editor dependency. `dompurify` is present in the root `package.json`.
- A new admin section follows AGENTS.md's "The console is React" rules: `AdminUI` recipes, `render`/`destroy`, scoped in `scripts/audit-react-ownership.mjs`.

## How it should work

**Data.** Tracked migrations for templates, layouts, their versions and per-language content, and images. A partial unique index or equivalent guarantees one live template per action. Archived versions are kept and can be chosen as replacements. Exact schema is the builder's call.

**Template language.** Placeholders such as `{{code}}`, HTML-escaped by default, plus simple conditional blocks, because existing emails need them. It must be logic-less apart from conditionals, and must not be able to run code. Library or hand-rolled is the builder's call.

**Action registry in code.** For each action: its label, allowed placeholders, required placeholders (`otp` requires `code`, for example), a sample payload for preview and test send, and whether it's English only. This is configuration, not email content.

**Sending.** `send()` loads the live template for the action in the reader's language, or English if that translation is missing or out of date, and renders it inside its layout unless it opted out. Tracking, unsubscribe headers and the existing rate limits and suppression stay as they are. Reads may be cached briefly, with an edit taking effect within a stated short time (builder's call).

**Mixed translation states.** Owner's decision: fall back per part. The template body and the layout each use the reader's language if that part's translation is current, else English, so a German body with an English footer is allowed. Saving a layout offers to re-translate immediately. The list page counts a template as out of date on its own translations, and shows its layout's state separately.

**Words supplied by code.** Owner's decision: `build_ready`'s `subject` and `lead`, and `invite_activity`'s `line`, become placeholders the template can see and move. Their wording stays in code (`homeroom-bot-notify-copy.js`, `activity-mail.js`), a known small exception to goal 6. Any `email:` catalog entries these still read stay until a later change moves them. An admin editing these templates is told in the placeholder list that this wording comes from code.

**When a template can't be loaded or rendered.** Owner's decision, in order: (1) use the last copy this server loaded, so a database problem doesn't stop sign-in mail, as today; (2) otherwise, if the email carries a code or link, send a plain undesigned message with just that and log an error (the one email text left in code, a deliberate exception); (3) otherwise don't send, and log an error. Activity emails fall under (3), since they must not go out without an unsubscribe link. To make (1) work on a cold server, load templates at startup.

**Saving.** Refuse to save a template that uses an unknown placeholder, lacks a required one, doesn't parse, or has an empty subject or text version. Sanitize the HTML server-side (no scripts, event handlers or external stylesheets).

**Translating.** Translate sends the subject, HTML and text to the same model the language step uses, keeping placeholders and markup intact and applying the glossary. Output failing the same checks as a save (all required placeholders present, and so on) is rejected for that language and the admin sees which failed. The English version has a revision, and each translation records the revision it came from: that's what "out of date" means. Runs in the background with progress shown, since 12 languages takes a while. Template translation does not go through the catalog files.

**Editor.** Owner's decision: the design and conditions always survive the visual tab. Its model is editing in place on the real HTML: click and retype text, add images, links and buttons, insert placeholders. Conditional blocks and structure are shown but protected, and structural changes happen in the HTML tab. Opening and saving in the visual tab must not rewrite anything the admin didn't touch, tested on all 13 seeded emails, `waitlist_released` first. Not a drag-and-drop builder. The editor's implementation is the builder's call; a schema-based editor that normalises HTML, such as plain Tiptap, doesn't meet this unless proven against the seeds. Lazy-load it. The HTML tab is always the full truth. Live preview uses sample data, in a sandboxed iframe, with a language selector and "Send test to me".

**Images.** Upload from the toolbar, following the illustration pattern: size and type limits, unguessable public URLs, and never deleted while any version, archived included, references them. Images must work on staging copies and production, so stored URLs must be absolute and reachable by mail clients (builder's call how).

**First templates.** A migration or seed writes the 13 kinds, "Homeroom standard" and the existing translations, so rendering matches today's output for representative payloads. Verify with a before and after comparison test, then remove `TEMPLATES` and the `email:` catalog usage. Translations currently live in the language cache and any committed catalogs, so the seed needs both, at a point where the data exists (builder's call). Staging copies must get them too.

**Removal comes last.** Build in stages small enough to review and vote on: store and renderer with the seed; sending switched over; console list and editor; images; Translate; remove old code and the Brevo setting. Each stage keeps sign-in mail working.

**Audit.** Record who changed what in `events`, or wherever admin actions are logged today (builder's call).

## Known exceptions to "no hard-coded templates"

Accepted by the owner: the plain code-or-link message in the failure path, and the code-supplied wording in `build_ready` and `invite_activity`.

Builder's default, not raised with the owner: `admin_test` is editable like the rest, though an existing comment says it exists to show the exact words it says it sent. Its test-send path should show what it actually rendered.

## Left to the builder

Schema, template syntax, editor library, cache timing, stage boundaries, how the first templates are generated, test rewrites, shots for the new section.
