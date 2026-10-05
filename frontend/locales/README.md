# Platform language catalogs

Homeroom supports the 20 languages in `config.json`. English remains the
prerender and offline fallback. Ordinary platform UI, accessibility labels,
standalone authorization pages, and registered HTTP error messages belong in
catalogs. User content, embedded apps' own interfaces, and the admin console do
not. Embedded apps still receive the platform's locale through the existing
bridge; this does not reload their frames or translate their content.

## Adding or changing UI text

1. Add the complete English message to `en/<namespace>.json`. Use a stable,
   descriptive key. Keep sentences whole; do not concatenate translated verbs,
   plural suffixes, or word fragments. Pass names and user content as values.
   Use complete message IDs in code, including conditional branches. Do not
   construct IDs by interpolating strings: the build must be able to check
   every possible ID against the catalogs.
2. Add its translation to **every** other language. Each entry is
   `{ "text": "…", "source": "<SHA-256 of the exact English message>" }`.
   Update text and digest together when English changes. Do not refresh a
   digest merely to silence a stale-translation error.
3. Render through the existing adapters described below. Register error copy
   in `en/server.json` when adding an ordinary HTTP error response.
4. Run `node scripts/check-ui-messages.js`,
   `node scripts/server-messages.js --check`,
   `node scripts/language-packs.js --check`, then `npm run ensure:shell`.
   Test the affected interaction in English and another language; include Arabic
   when alignment or layout changes.

Every shell build runs these gates, including Docker builds. Missing, blank,
stale, and unknown translation entries fail the build. Interpolation parameters,
numbered rich-text tags, and the target language's plural categories must match.
The source audit rejects uncatalogued JSX text, display props, DOM text writes,
legacy HTML, feedback calls, and the authorization pages' text. It has no
untranslated-text baseline. Like any static audit, it cannot infer every
arbitrary data flow: review display strings passed through model variables and
helper returns as well. Do not add broad suppressions to bypass translation.

## Rendering and ownership

React owners use `useMessages(namespace)` and `t('namespace:key', values)`.
`Message` owns an isolated text node, `Localized` owns translated props, and
`LocalizedValue` / `LocalizedDynamic` preserve computed labels at their existing
React owner. Do not subscribe the whole static `Shell`, rewrite text across the
DOM, or let React reconcile a legacy-owned subtree.

Use `RichMessage` for links and emphasis. Catalogs contain numbered tags such as
`Read <0>the terms</0>, {{name}}.`; components, URLs, and event handlers remain in
code. Parameters are rendered as text, never interpreted as markup. Keep
punctuation and spaces in the message instead of joining translated fragments.

Legacy owners use `globalThis.PlatformI18n.t(key, values)` for plain text and
`htmlText(key, values)` when inserting into an HTML string. The latter escapes
the entire result, including user parameters. Translate at render time rather
than capturing translated strings at module initialization. A visible legacy
owner should repaint from its existing state on `homeroom:language-changed`,
preserving drafts, selection, focus, scroll, and open surfaces.

For plurals, author `key_one` and `key_other`, and pass numeric `count` when
requesting `key`. Other languages must provide every category selected by
`Intl.PluralRules(locale)`, including Arabic's six categories. A separately
formatted value may be used for the visible count. Use the active locale for
numbers, dates, relative times, and lists; keep identifiers and technical values
unchanged.

## Loading, caching, and preference

Build output contains same-origin, content-hashed JSON packs per language and
namespace under ignored `public/locales/`. The generated manifest includes each
pack's integrity hash. URLs are immutable. Translation source digests are not
included in downloaded packs; server error catalogs are not bundled into the
browser runtime.

English is bundled so hydration and recovery work without a pack request.
Other languages load only when selected. Namespace requests are deduplicated,
time-limited, integrity-checked, and retried after failures. Mounted shell
surfaces currently register most UI namespaces during startup, including hidden
panels. The split allows later features to register on demand; it does not
promise that only the visible panel's pack is fetched today.

The service worker caches requested packs for offline reuse but does **not**
precache every language. Switching back can reuse the immutable browser/SW
cache. No translation CDN or third-party translation request is used at runtime.

Signed-in selection is saved on the account. Signed-out selection is stored on
the device. Auto follows the device's preferred supported language. A switch
loads the needed packs, saves the preference, and activates it in that order;
a failed save leaves the current UI intact. Concurrent saves are serialized.
Startup hydrates English behind the language-loading mask, then activates the
resolved language before revealing the page. Failed pack loading recovers to
English rather than leaving sign-in hidden. Arabic sets `dir="rtl"`; the excluded
admin screen explicitly keeps `lang="en" dir="ltr"`.

## Translation provenance and review

The initial catalog migration was machine-assisted with local M2M100-418M
translation, with targeted corrections to common controls, consent notices,
parameters, and plural forms. Traditional Chinese conversion used OpenCC.
No user content or credentials were sent to a translation service. The model
and translation environment are development tools, not runtime dependencies.

These catalogs have not had native-speaker review in all 19 non-English
languages. Completeness and structural checks do not establish linguistic
quality. Review contextual terminology and longer instructions when editing
copy, and correct the catalog directly without changing stable message keys.

## Generated files and tests

Do not commit `public/locales/`, `catalogs.generated.json`, shell bundles,
`public/index.html`, or generated CSS. Build them from the versioned catalogs.
The ordinary root tests cover preference races, pack loading and integrity,
plural/tag contracts, escaping, server errors, source auditing, and existing UI
behavior. Tests that pin English source copy use `tests/lib/english-ui-source.js`
only for static assertions; runtime tests execute the actual translated code.
