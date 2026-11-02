# Project apps offline: your data

2 Nov 2026. Follows `docs/plans/project-apps-offline.md` ("Next,
separately: data") and PR 6151 (proposal 12245), which makes an app's page
and code open offline from the browser's own cache. Read against canonical
main `15003ee9` and PR 6151's branch (`1c8bdbd6`).

## The gap

With PR 6151 an app opens offline, but its `/api/*` reads fail, so it draws
its own error state where the data goes. In the trial Chore list drew its
header and nothing else, and Gym Tracker showed "Load failed" and "Failed to
fetch". The one starter that opens offline with its data, the grocery list,
does it by hand: about 60 lines that keep the last list in the app's own
localStorage under the token's user id, remember who last opened it for
token-less loads, and delete other people's copies on a load that knows who
it is (`app-templates/grocery-list/public/app.js` ~215-275).

What the brief asks of a helper that every app can use:

1. **Per person.** A second account on the device never sees the first's data.
2. **Gone at sign-out.** The shell triggers it or the bridge detects it.
3. **Capped** in size.
4. **Honest** about being offline and how old the data is.

## What every option shares

**One bridge call that an app wraps its read in:**

```js
usernode.offline.read('chores', () => api('GET', '/api/chores'))
  .then(({ value, fromCopy, savedAt }) => {
    render(value);
    showSaved(fromCopy, savedAt); // "Offline. Showing what was saved at 10:42."
  });
```

- The read succeeds: the value is kept (in the background) and returned with
  `fromCopy: false`.
- The read fails without a "no" from the server: the kept copy is returned
  with `fromCopy: true` and `savedAt`. With no copy, the original error is
  thrown, so the app's own error state still shows.
- **When the copy is used.** On any failure except a 4xx answer: a network
  error, a timeout, a 5xx (the gate answers 502/503 when the app's server is
  down), a 408 or 429. A 401 on a load that had no token (an offline mount
  that came back online) also uses the copy. A 403, 404 or 410 is a real
  answer: the copy is not shown, and is deleted. So an app's `api()` should set `err.status` when it
  throws for a server answer; one that does not is treated as unreachable,
  which shows an old copy with its age rather than nothing.
- Also `usernode.offline.get(name)`, `.put(name, value)`, `.remove(name)`
  for an app that manages its own, and `usernode.offline.available()` (a
  promise of true or false) so an app can say "nothing is saved on this
  device" only when that is true.
- **Caps.** One copy at most 250,000 characters; all of an app's copies
  together at most 1,000,000 (about 2 MB of the origin's ~5 MB of
  localStorage, leaving the rest to the app). Copies older than 30 days (the
  page cache's own lifetime) are not shown. A copy that does not fit first
  pushes out the copies kept longest ago; if it still does not fit, it is
  not kept and its older copy goes.
- **Outside Homeroom** (the app opened at its own address, or a staging
  preview) nothing is kept and the call is a plain read.
- **Honest UI** is the app's, because only the app knows what on the screen
  is old. The starters get a strip under their header: "Offline. Showing
  what was saved at 10:42." (or "yesterday at 18:05"; "Can't reach the
  server." in place of "Offline." when the device is online). It names no
  data, because a starter's script carries none of its project's words
  (they are in words.json). It goes when a
  read succeeds, which the shell's reconnect reload and the starters' minute
  refresh both bring.

What differs is where the copy lives and how it goes at sign-out.

## Options

### A. The app's storage, keyed by the token (the grocery list's way)

The bridge reads the person's id from the token, remembers the last person
on the app's origin for token-less loads, keeps copies under that id, and
deletes everyone else's on a load that knows who it is.

- No shell change.
- **Fails "gone at sign-out".** Nothing happens until that app next opens
  with someone else's token. Until then the copy sits in the app's storage in
  plain text, and an offline load of the app at its own address, outside
  Homeroom, would show the last person's copy (the token-less fallback has
  no way to know they signed out).

### B. The app's storage, sealed with a key the shell holds (recommended)

The shell keeps one random 256-bit key per person on this device, in its
own storage, and deletes it at sign-out (`App._dropCachedSession`). The
bridge asks for its app's key when the app first uses the helper. The shell
answers only the production app frame it mounted, checked the way the
locale request is (`AppView._bridgeRequest`: the frame's window, its
origin, the slug and the signed-in id), with a key derived for that app's
origin (HKDF). The bridge encrypts each copy with it (AES-GCM) before it
goes into the app's own localStorage, tagged with the key's id.

- **Per person:** another account has another key. Its copies cannot be
  read, and the bridge deletes them on sight.
- **Gone at sign-out, for every app at once:** without the key no copy can
  be read, on any app, without opening any of them. The bridge deletes the
  unreadable ones the next time that app opens.
- **Who it is offline** comes from the shell, which knows who is signed in
  with no network, so the app does not have to remember the last person.
- **Outside Homeroom** there is no shell to ask, so nothing is kept or
  shown.
- Each app keeps its own storage quota; the shell keeps 32 bytes.
- Costs: one message to the shell per app load (answered at once; a 3 s
  limit, after which nothing is kept on that load), and WebCrypto in the
  bridge (about a millisecond for a large copy). WebCrypto needs a secure
  context, which an https app frame is; where it is missing, nothing is
  kept.
- The native app's restored session (a new token for the same person,
  `_dropCachedSession({ keepUnsent: true })`) keeps the key, as it keeps
  unsent messages. The key is stored with the person's id and is never given
  for another.

### C. The shell's storage, for every app

The bridge sends each copy to the shell, which keeps it with the person's
other kept copies and hands it back. Sign-out already clears those.

- Clearing is the simplest of the three.
- **Every app shares Homeroom's own storage.** `kept-copies.ts` already
  keeps its copies under 600,000 characters because a full origin fails the
  session snapshot's writes; apps' data there would have to go to IndexedDB
  with its own budget, one app's data would push out another's, and the OS
  clearing Homeroom's storage takes every app's data with the shell's own.
- Every copy goes through the shell, so a bug there is a bug in every app.

### Not recommended: the shell visits each app at sign-out

A hidden frame per app opened on this device, at a platform page on the
app's host that wipes the copies. Real deletion, but a frame per app at
every sign-out, and none of it happens for an app whose page does not load
(a sign-out while offline, an app that is down). B gets the same result
with no visit.

## Recommendation: B

It is the only option that keeps each app's data in its own storage and
still makes it unreadable the moment the person signs out. A is B without the
key and without the guarantee; C trades the same guarantee for putting every
app's data in Homeroom's own crowded storage.

### What it changes (one proposal)

1. **Bridge** (`public/usernode-bridge/v1/bridge.js`, mirrored to
   `public/usernode-bridge.js`), one marked block: `usernode.offline` (read,
   get, put, remove, kept), the key request, the sealed store with its caps
   and its sweep of copies under another key.
2. **Shell** (`public/js/app-view.js` beside the locale handler, and a small
   `frontend/src/lib/app-data-key.ts`): the key, made on first request and
   kept per person; the answer to the bridge for the mounted production app
   frame only (never a staging preview or the platform's own preview); the
   key dropped in `App._dropCachedSession`.
3. **Starters** that read from `/api` (chore list, find a time, group
   challenge, group poll, lending library, potluck planner, sign-up sheet,
   study timer, tier list): the first read goes through
   `usernode.offline.read`, `api()` sets `err.status`, and the strip. The
   grocery list's own copy of the list moves to the helper; its queue of
   unsent changes stays as it is. The game rooms (blocks, board, space,
   trivia) keep no copy: an old game room is not something to open offline.
4. **Empty template** (`src/services/template.js`): its screen reads nothing
   yet, so it gets the rule in the CLAUDE.md it writes ("wrap each screen's
   first read in `usernode.offline.read` and show the strip"), next to the
   existing data guidance.
5. **Conventions** (`src/prompts/app-conventions.md`, "Offline"): PR 6151's
   "Keep your own copy of the data" points at the helper, with what it keeps,
   when the copy is used, and the honest strip.
6. **Tests:** the bridge block in the existing vm sandbox with Node's own
   WebCrypto (round trip, another person's key, no shell, timeout, caps and
   push-out, age, 4xx vs unreachable, the token-less 401); the shell's answer
   (only the production frame, the origin, the person; nothing when signed
   out); the key dropped at sign-out and kept across a restored session; each
   starter's first read going through the helper.

**Not in it:** writes made offline (the grocery list's queue stays its own;
a shared outbox is a later step), images, and data an app reads after its
first screen (an app can wrap any read, but the starters wrap the first).

**Order.** It builds on PR 6151's "Offline" section of the conventions, so it
is based on main once 6151 merges. It works without 6151 too: an app with its
own worker (the grocery list) opens offline today.

**Shots.** Online nothing changes on screen; offline cannot be shown by the
shots agent, so `impact: none` with that reason, as for PR 6151.

## Questions

1. **Which option?** B recommended; A is the smallest change if a copy left
   in an app's storage until its next open is acceptable.
2. **Which starters?** All the data starters above in this proposal
   (recommended), or chore list alone first and the rest after.

## Decided, and what was built

Evan, 2 Nov 2026: **B**. The starters took the default: every data
starter in this proposal, the game rooms none.

Built as planned, with these details settled while building:

- **Bridge** (`__USERNODE_OFFLINE_DATA_BEGIN__` block): the key is asked for
  once per page load, only when the app first uses `usernode.offline`. A key
  is believed only from the platform's origin as `platform.json` names it,
  remembered in the app's storage for loads that cannot fetch it (offline);
  otherwise a page that framed the app could hand it a key and have its
  copies deleted. A copy's name and time are sealed in with it (AES-GCM
  additional data), so a copy cannot be moved to another name. The newest
  keep of a name wins whichever finishes first, and a remove outranks a keep
  on its way.
- **Shell** (`public/js/app-view.js`, beside the locale handler): the key
  lives in the shell's localStorage with the person's id
  (`usernode:app-data-key`), not in a new frontend module, so the vm tests
  that load `app-view.js` exercise it with no frontend build. Only the
  mounted app frame (`app-iframe`) is given a key; a staging preview, the
  landing viewer and a signed-out shell are told there is none. A kept frame
  in the background is not the mounted one, so a reload there keeps nothing
  on that load.
- **Starters**: each gets `kept`, `savedWhen` and `showSaved` inline, the
  same lines in each, as their `api()` already is. The study timer keeps
  today's count under the day it counts, so yesterday's never shows as
  today's. The grocery list keeps its whole list, queued changes and all,
  through `put` on every change; a failed first read waits for the kept
  copy before it shows the error, and a plain-text copy an older version
  left is deleted.
- **Conventions**: a section of its own after "Offline", so it does not
  touch the lines PR 6151 rewrites. The Mayor turn golden changes with the
  conventions in both proposals; whichever merges second records it again
  (`UPDATE_GOLDEN=1`).

Not in it: writes made offline (each app's own queue, as the grocery
list's), images, a copy drawn early while a slow read is still on its way
(the shell's `kept-copies.ts` does that after 2 s; a promise answers once),
and data read after the opening screen.
