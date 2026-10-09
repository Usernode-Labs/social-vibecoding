# Platform language catalogs

Homeroom's own screens are in English. This directory and
`frontend/src/lib/i18n/` are what let them be shown in other languages: the
English source, the runtime that loads a language on demand, and the build
that turns catalogs into packs. `config.json` lists the languages that ship.
Today that is English only. The shell's text is in the catalogs here, one
namespace per surface (`core` and `shell` for what every screen has, then
`auth`, `home`, `messages`, `project`, `settings` and the rest), so another
language loads only what the screen on show needs.

Outside all of this: user content, an embedded app's own interface, the admin
console, sentences the server composes (API errors, push and email text), and
the few standalone pages that load no shell bundle (the CLI and connector
consent pages among them). Dates and numbers are still formatted as they
were; only the words around them are catalog entries. Apps still receive the
person's locale through the bridge (`usernode.getUserLocale()`), unchanged.

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

A message id is always written whole, as one literal: `'namespace:area.element'`.
The key has at least one dot, and the namespace is in the id even where the
`t` in hand is already bound to it. That is what lets
`node scripts/language-inventory.js --ids` (and `tests/language-extraction.test.js`)
check every id the code asks for against the catalogs. Never build an id by
joining strings; a table of ids (`{ app: 'core:recents.row.app', … }`) is fine.

- **React:** `const t = useMessages('namespace')`, then `t('namespace:key', values)`;
  or `<Message id="namespace:key" />`; or `<RichMessage>` for numbered tags.
  All three are in `frontend/src/lib/i18n/react.tsx`. Subscribe the component
  that renders the text. Never the static `Shell`, and never a subtree a
  `public/js/**` module also writes into.
- **A module with imports** (`frontend/src/**`): `import { t } from '…/lib/i18n/runtime'`
  for text read outside a component, in a store, a label table's reader or a
  pure helper. It does not subscribe anything, so the component that shows
  the result calls `useMessages` too.
- **A classic script** (`public/js/**`, and the import-free modules under
  `frontend/src` that tests evaluate on their own): `PlatformI18n.t(id, values)`
  for text; `PlatformI18n.htmlText(id, values)` when building an HTML string,
  which escapes the whole result, parameters included; and
  `PlatformI18n.htmlRich(id, values, [wrap0, wrap1])` for a sentence with a
  link or emphasis inside it, where each wrapper is a function from the
  already escaped inner HTML to the element. Translate at render time, not at
  module initialization, and repaint from existing state on
  `homeroom:language-changed`. It fires when the language switches, and again
  when the pack for a namespace arrives after a screen first read it
  (`detail.namespace` names it): that first read was English.

## Moving a screen's text into a catalog

The rule under all of these: a translator sees one entry at a time, with its
description and nothing else, and must be able to write a correct sentence
from it. So the code never assembles a sentence.

- **One entry per message, per place.** "Leave" on a community's menu and
  "Leave" on a call are two entries. Text is shared only through the closed
  set under `core:common.*` (generic buttons such as Cancel, Close, Back and
  Retry), and only where the control is exactly that generic control.
- **Two wordings are two messages.** `open ? t('…hide') : t('…show')`, never a
  shared stem with a word swapped in. The same goes for a word the code
  lower-cased or capitalized to fit a sentence: give the sentence its own
  entry.
- **A count is a plural pair.** `key_one` and `key_other`, asked for as `key`
  with a numeric `count`, even where English reads the same both ways. Never
  `count === 1 ? … : …`, and never a hand-built "s": Russian, Ukrainian and
  Polish have more forms than two.
- **A table of labels holds ids.** A module-level constant is read once, in
  English, before any language is known. Keep the table and store the message
  id in it; the component reads it with `t` when it renders.
- **Several independent facts** in one accessible name ("App: Recipe Box,
  still open, unread") are each a whole entry, joined by `listText([...])`
  from the runtime. Never `', '` in code.
- **A link or emphasis inside a sentence** is numbered tags in one entry:
  `RichMessage` in React, `htmlRich` in a classic script.
- **Text the code compares or parses is not text.** Where code read a label
  back (`button.textContent === 'Save'`), make it read state instead.
- **Names are parameters.** A person's, an app's or a community's name, a
  number, a date: `{{community}}`, named for what it holds. "Homeroom" is the
  product's name and stays in the text; say so in the description when it
  could be mistaken for a word.
- **A description says where and what.** "Button on the sign-in sheet: sends
  the code to the phone number." Not "Button label", and not the text again.
  Say what each parameter holds, and anything a translator must keep (a
  leading name, a check mark, a keyboard key).
- **What stays in code:** text a person wrote, a server's own error sentence
  (the client's fallback for a missing one is an entry), developer-only
  console and thrown-error messages, test ids, and the admin console.

English must read exactly as it did, the ids, classes and `data-*` attributes
stay as they were, and an island's first render must equal the prerendered
document: the runtime starts in English and activates a language after
hydration, so nothing here changes that.

`node scripts/language-inventory.js --literals [path…]` lists what still
looks like interface English in the client sources, less
`literal-allowlist.json` (each exception with its reason). It is a report over
syntax, not a gate: it drives a conversion and counts what is left.

A test that runs a classic script in a sandbox gives it the real English
runtime: `PlatformI18n: englishPlatformI18n()` from
`tests/lib/platform-i18n.js`. `message(id, values)` from the same file is the
English text for an assertion that names the message by id, and
`loadInSpanish` in `tests/lib/language-fixture.js` renders a real module in a
second language.

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
  screen as it was. The screen follows the last choice that was saved: when a
  newer choice fails after an older one was saved, the older one is shown. A
  saved choice never waits on an older one still loading, and once the person
  has chosen again an older choice failing is not reported.
- The first time the language was picked from the device rather than chosen,
  a notice above the tab bar says so once ("Showing Homeroom in Español")
  with a "Switch to English" button. There is no language picker on the
  sign-in screen.

## Adding a language

Add it to `config.json` with its own name, and its catalogs. Settings offers
every language in `config.json`. Two things are not built yet and belong with
the first language that needs them: right-to-left layout, and hiding the first
paint while a pack loads.
