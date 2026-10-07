# Platform language catalogs

Homeroom's own screens are in English. This directory and
`frontend/src/lib/i18n/` are what let them be shown in other languages: the
English source, the runtime that loads a language on demand, and the build
that turns catalogs into packs. `config.json` lists the languages that ship.
Today that is English only, and most of the shell's text has not been moved
into a catalog yet. It moves one surface at a time.

User content, an embedded app's own interface and the admin console are
outside all of this. Apps still receive the person's locale through the bridge
(`usernode.getUserLocale()`), unchanged.

## The English source

`en/<namespace>.json` is what a contributor writes. Each entry is:

```json
"language.notice.showing": {
  "text": "Showing Homeroom in {{language}}",
  "description": "Notice shown once after Homeroom picked the device's language automatically. {{language}} is that language's own name, for example Español."
}
```

- **A whole message.** Never a fragment to be joined to another: word order
  differs between languages, and a fragment with a space on its edge is the
  first thing a translator loses. For a link or emphasis inside a sentence,
  use numbered tags (`Read <0>the terms</0>, {{name}}.`) and `RichMessage`.
- **Named parameters.** `{{email}}`, never `{{value1}}`: the name is the only
  thing that tells a translator what will be there.
- **A description.** One line saying where the message appears and what it
  does ("Button: signs the person out"). A translator sees the entry alone,
  and "Block", "Post" and "Leave" each mean several things.
- **Plurals** are `key_one` and `key_other`; ask for `key` with a numeric
  `count`.

`node scripts/language-packs.js --check` validates the source, and every shell
build and `tests/language-packs.test.js` run the same check. A mistake here is
a mistake in your change, so it fails.

## Translations

`<language>/<namespace>.json` holds a language's translations:

```json
"language.notice.showing": {
  "text": "Mostrando Homeroom en {{language}}",
  "source": "<SHA-256 of the English text this was translated from>"
}
```

**Contributors do not write these, edit them or compute a hash.** They come
from the translation step, not from the person changing the UI. `"locked":
true` marks an entry a person corrected, which that step must leave alone.

A translation never fails a build. An entry that is missing, whose `source`
no longer matches the English text, or whose parameters, tags or plural forms
do not match is left out of that language's pack, and the runtime shows
English for that one message. `node scripts/language-packs.js --report` lists
what each language is missing and why.

## Using a message

- **React:** `const t = useMessages('namespace')`, then `t('key', values)`;
  or `<Message id="namespace:key" />`; or `<RichMessage>` for numbered tags.
  All three are in `frontend/src/lib/i18n/react.tsx`. Subscribe the component
  that renders the text. Never the static `Shell`, and never a subtree a
  `public/js/**` module also writes into.
- **Legacy modules:** `PlatformI18n.t(key, values)` for text, and
  `PlatformI18n.htmlText(key, values)` when building an HTML string: it
  escapes the whole result, parameters included. Translate at render time, not
  at module initialization, and repaint from existing state on
  `homeroom:language-changed`.

Use complete message ids in code. Do not build one by joining strings.

## How a language reaches the screen

- The build writes `frontend/src/lib/i18n/catalogs.generated.json` (the
  English messages, bundled into the shell) and one pack per language and
  namespace at `public/locales/<language>.<namespace>.<sha256>.json`. Both are
  ignored by git and Docker and rebuilt by every shell build.
- English needs no request. Another language's pack is fetched only when that
  language is active, checked against the SHA-256 in the bundled manifest
  before it is used, and served immutable. The service worker keeps a pack once
  it has been requested and never downloads a language on install.
- The language is the person's saved preference when Homeroom ships it,
  otherwise the first of the device's languages it ships, otherwise English.
  Signed in, the preference is `users.locale` (Settings → Language). A change
  loads the packs, then saves, then switches, so a failed save leaves the
  screen as it was.
- The first time the language was picked from the device rather than chosen,
  a notice above the tab bar says so once ("Showing Homeroom in Español")
  with a "Switch to English" button. There is no language picker on the
  sign-in screen.

## Adding a language

Add it to `config.json` with its own name, and its catalogs. Settings offers
every language in `config.json`. Two things are not built yet and belong with
the first language that needs them: right-to-left layout, and hiding the first
paint while a pack loads.
