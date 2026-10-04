# Platform language catalogs

Issue #3659 is **in progress**. The language picker and catalog infrastructure
are implemented; the rest of the platform UI migration is not complete. Do not
promote this checkpoint as full platform language support.

English lives in `en/<namespace>.json`. Other locales store each translated
message as `{ "text": "…", "source": "<sha256 of the English message>" }`.
The source digest records the exact English wording that was translated.
After changing English, update each translation and its source digest together.
Do not automatically refresh digests without reviewing the translations.

`node scripts/language-packs.js --check` rejects absent or empty entries,
outdated source digests, unknown entries and differing interpolation parameters.
The shell build runs this validation too. `buildLanguagePacks` emits immutable
JSON files under ignored `public/locales/` and a generated runtime manifest.
Only message text is shipped; translator source digests stay in the repository.

Use `useMessages(namespace)` in React owners and `Message` for isolated text.
Classic owners can call `window.PlatformI18n.t(key, options)` for plain text or
`htmlText(key, options)` when building HTML. User content must remain data and
must never be searched/replaced with translations. The whole Shell must remain
static; no document-wide text-rewriting observer is permitted.

Call `ensureNamespace` before revealing a feature that needs another pack.
Switching loads all currently needed namespaces before saving and activation.
English fallback is permitted. Missing translations are still build failures.
The generated release manifest lists packs for integrity verification and
offline reuse, with `precache: false`, so installing/updating a service worker
does not download other languages.

## Remaining work before submission

- Settle the initial supported language list; config currently retains all
  20 existing picker languages, with translations for the picker only.
- Register and translate every remaining ordinary-user UI message, including
  legacy writers, errors, system templates and standalone public pages.
- Extend the syntax-aware audit through dynamic expressions, message keys,
  public HTML and server message contracts, then enable it as a required
  whole-tree build/validation check. It currently reports outstanding literals;
  do not baseline them away to make the migration pass.
- Complete plural/rich-text handling, active-locale formatting and RTL review.
- Verify initial translated paint, account preference reconciliation, signed-out
  selection, forms/focus/scroll, overlays and embedded-app locale propagation
  in a real browser/WebView.
- Measure production network traffic and pack sizes after extraction, declare
  before/after checkpoints, upload the finished commit and run staging checks.

Keep proposal session 6284 and request ID `platform-i18n-3659-20261005` throughout
the remaining work. This is one proposal, not a series of replacement sessions.
