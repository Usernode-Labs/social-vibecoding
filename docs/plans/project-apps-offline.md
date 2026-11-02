# Project apps offline: design

2 Nov 2026. Read against canonical main `ce8b4c53`; built as option E
(see "Decided, and what was built" at the end of the plan).

## Where things stand

- Offline, the shell mounts an app's frame only if the bridge once said a
  service worker controls the app's page (`__usernode_offline_ready`,
  `public/usernode-bridge/v1/bridge.js` ~7485-7533; stored per slug in
  `public/js/app-view.js` ~1707-1815). Otherwise the app shows "This app
  needs a connection" (~4165-4192).
- Only the grocery-list starter has a worker. The scaffold and the other
  starters have none, a version of a ready-made copies its original's tree,
  and existing apps get nothing. So almost every app shows the placeholder.
- A starter app with no data shows its own error state, for example the
  chore list's "The chores did not load. Nothing is lost. Check your
  connection and try again." Opening the page alone is not much better than
  the placeholder. What makes it like a native app is **seeing your last
  data**.

## The finding that decides it: iOS allows 3 service workers in all

In a WKWebView with app-bound domains, WebKit allows **3 service worker
registrations in total, across every origin**, unless the app holds
`com.apple.developer.web-browser` (default-browser apps) or Apple's private
`com.apple.developer.WebKit.ServiceWorkers`. Homeroom holds neither.

- `Source/WebCore/workers/service/server/SWServer.cpp`:
  `defaultMaxRegistrationCount = 3`. `validateRegistrationDomain` lets a
  new registration through only while `m_uniqueRegistrationCount < 3`. The
  count is per network session (the app's one data store), and registrations
  restored from disk are checked against it too.
- `Source/WebKit/NetworkProcess/ios/NetworkProcessIOS.mm`: the two
  entitlements above are the only way around it.
- WebKit called it intended behaviour (bug 227531).

The domain check uses the **top** document's registrable domain. An app
frame inside `app.onhomeroom.com` counts as `onhomeroom.com`, which
`WKAppBoundDomains` lists, so app frames can register. But Homeroom's own
worker takes one of the three, which leaves **two** for every project app
on the phone together. The third app's registration fails with "Job
rejected for non app-bound domain". Android WebView and desktop browsers
have no such cap.

This also limits what we have today: at most two apps with their own
worker can open offline in the iOS app. A staging preview that registered a
worker while opened in the iOS app keeps its slot until it is unregistered.

### Measured on the simulator (2 Nov, iPhone 17, iOS 26.4, production)

The production Homeroom build, driven through the simulator's Web
Inspector socket. Test workers were a vendored script with no fetch
handler, registered under `/vendor/swcap-N/` and removed afterwards.

- **The cap is real and app frames share it.** Homeroom's page held its
  own worker; Todo List's frame held its own
  (`todo-list-b91765.onhomeroom.com/sw.js`). One test worker registered,
  and the next was refused: "Job rejected for non app-bound domain". With
  those three slots full, **Gym Tracker's own frame** was refused with the
  same error. With one slot freed, its registration got past the check
  (and failed only because Gym Tracker has no `/sw.js`).
- **Safari has no cap.** The same probe in mobile Safari on the same
  simulator registered all four test workers.
- **Of the two apps, only Todo List ships a worker.** Gym Tracker has none
  (`/sw.js` answers 401, and its page never mentions `serviceWorker`).
- **Todo List's worker skips the first open after launch.** After
  launching Homeroom, the first Todo List frame load had `workerStart` 0
  and no controller, though its registration was active. A reload of the
  frame was controlled. Seen on two launches. The bridge then announces
  "not-ready", and the shell drops Todo List's offline-ready flag (the map
  went from `{"todo-list-b91765": …}` to `{}`). So today even Todo List
  only opens offline if the last open before going offline was not the
  first after a launch. Not yet checked: whether an offline cold launch
  can open it at all.

## Options

### A. Give the templates a worker (the app brings its own)

Copy grocery-list's worker into the scaffold and every starter, and have
the bot add one to existing apps on request.

- Reaches new projects only. Versions of ready-mades need their originals
  changed. Existing apps need a change each.
- Every copy is app code the bot can break, and a platform fix cannot reach
  it.
- On iPhone only two apps can have one. **Not recommended.**

### B. A platform worker on every app's origin

The platform serves `/usernode-bridge/v1/sw.js` with
`Service-Worker-Allowed: /` (no new route: every app host already routes
`/usernode-bridge/` to the platform). The bridge registers it at `/` when
the app has no worker of its own. It keeps the page and its files,
network-first.

This answers the brief's questions (details in the appendix). But on
iPhone, the target, it works for two apps and then fails, and Android would
behave differently from iPhone. **Not recommended**, unless Apple's limit
changes.

### C. The shell keeps a "last view" of each app (recommended)

No service worker on the app's origin at all. While online, the shell asks
the app's bridge for a copy of the page the person is looking at. The
bridge already does this for design threads (`__usernode_capture`, #6071):
a static HTML copy, with the app's own CSS written in, scripts and frames
removed, what was typed into fields kept, password fields never. It answers
only Homeroom's origin.

The shell keeps the copy on its own origin, with the person's other saved
data. Offline, an app with no worker of its own opens on that copy: read
only, in a sealed frame, under a strip that says it is offline and how old
the copy is.

- **Works the same on iPhone, Android and desktop.** No worker, so no cap
  and no app-bound-domain question.
- **Every app gets it on its next online open, existing ones included,
  with no app change.** The capture block is already live in the hosted
  bridge, so the first version changes the shell only.
- **Apps that ship their own worker still open live**, as today. The live
  app is always better than a picture of it. (On iPhone that path has the
  first-open problem measured above; it is a separate fix.)
- **Limits.** Read only. One screen per app, the last one seen. Images that
  load by address do not show offline until the bridge writes small ones
  in (follow-up). The app's own scripts do not run.

### D. Each app in its own native web view, with its own storage (iOS 17+)

The cap's counter lives on WebKit's `SWServer`, and there is one per
network session, which is one per `WKWebsiteDataStore`
(`NetworkSession.cpp` creates it). iOS 17 lets an app make as many
persistent stores as it likes (`WKWebsiteDataStore(forIdentifier:)`). So if
the native app shows each project app in its own web view with its own
store, every app gets three slots of its own. Then B's platform worker can
run in every app, and the app opens live offline, as many apps as you like.

- **Data offline too.** The native app can delete an app's store at
  sign-out, keyed per account, so the worker may keep the app's own API
  reads on the app's origin with no cross-account risk.
- **Cost.** A native app screen on the phone (a native header, like
  Telegram's mini apps) instead of the iframe inside the shell's page. The
  ~20 kinds of message the bridge and shell exchange (theme, safe area,
  locale, storage, LLM, permissions, comment pin, issue state, …) go
  through the native channel instead of the parent page. Flutter's WebKit
  plugin only exposes the default store, so it needs a small fork. Data
  apps saved on the phone does not carry over to the new stores, once.
- **Android** has no cap. The same native screen keeps the two apps alike.
  Desktop browsers keep the iframe and B's worker.
- **Unverified:** that a second store really gets its own three slots, and
  that app-bound domains allow workers in it. A small test build on the
  simulator settles both.

### E. No worker at all: the browser's HTTP cache

Storage is not what the cap limits: each app's own address can keep its
data on the phone (localStorage, IndexedDB) with no worker. A worker is
needed only to hand out the app's page and code with no network. The
browser's ordinary HTTP cache can do that for any number of apps, if the
saved copies are **fresh**: every engine uses a fresh copy without asking
the server. So the app's page and files are sent fresh for a long time
(`Cache-Control: max-age=2592000`, 30 days), and the shell refreshes an
app's copies once whenever it sees the app's version change (it knows each
app's version). That refresh is what makes a merged change show online.

#### The scheme that works everywhere (tested 2 Nov)

Same test as below, with page and files fresh for 30 days, on three
engines: the iOS in-app web view (iPhone 17 simulator, iOS 26.4), Safari
on the same simulator, and Chrome 134 on the Android 16 emulator (the
engine of Android's web view).

| Case | iOS app web view | Safari | Android (Chrome) |
|---|---|---|---|
| Server stopped, app open | whole app, 8 ms | whole app, 13 ms | whole app, 158 ms |
| Server stopped, cold launch | whole app, 24 ms | whole app, 23 ms | whole app, 430 ms |
| Open after a merge | all old (no request at all) | all old | all old |
| Then the frame reloads | all new | all new | **new page, old script** |
| Then "refresh everything" | all new | all new | all new |

"Refresh everything" re-downloads, bypassing the cache, every file of the
app's address the page has loaded (`performance` entries) and the page,
then reloads. Chrome's plain reload only re-checks the page, so it is
needed. It covers the files this open loaded; files loaded only on other
screens need the bridge to remember every file it has seen and refresh
those too. `Clear-Site-Data: "cache"` from the app's address did not clear
the script in Chrome (tested over http; not tried on https).

#### With two real apps (2 Nov)

Copies of two public production apps, every file they load, served from
their own addresses with the scheme's headers; Homeroom's shared files
from a stand-in Homeroom address, as each app loads them. The API answered
"unavailable", so this tests the apps' code and files, not their data.

- **Chore list** (`homeroom-chore-list`, the ready-made starter): page,
  `app.js`, `tailwind.css`, `live-updates.js`, and the hosted bridge and
  native kit at its own address.
- **Gym Tracker** (`gym-tracker-9de81f`, older, 166 KB page with inline
  code): the bridge, native kit and Tailwind runtime from Homeroom's
  address. Its page answers 401 without a sign-in token (curl), so it
  loads only when its server sees the person: through the gate's cookie
  once the token leaves the query.

| | iOS app web view | Safari | Android (Chrome) |
|---|---|---|---|
| Every server down, app open | both start, no file failed | both start | both start |
| Every server down, cold launch | both start | both start | both start |
| Open after a merge | old version, no request | old version | old version |
| Plain reload | n/a | n/a | Chore list: new page, old `app.js` |
| "Refresh everything" | new page and `app.js` | new | new |

Offline, Chore list drew its header and layout. Gym Tracker started and
showed the browser's own error text where its data goes ("Load failed" in
WebKit, "Failed to fetch" in Chrome): the code is there, the data is not.
The bridge moved a token from after `#` into the query before the apps'
code ran, and both apps read it as before.

#### The first test: the stale-copy shortcut

`stale-while-revalidate` (use a stale copy now, check behind it) was tried
first. It works in the iOS app's web view only: Chrome never uses it for a
page (Blink marks only subresource requests, `SetAllowStaleResponse` in
`resource_request_utils.cc`; the cache honours it only for marked requests,
`LOAD_SUPPORT_ASYNC_REVALIDATION` in `http_cache_transaction.cc`), so on
Android nothing opened; Safari brought back the page but not its files.

#### Stale-copy test, 2 Nov on the iPhone 17 simulator (iOS 26.4)

A test "platform" page framed a test "app" (another origin) whose page
loads a script and a stylesheet; the app reports which versions arrived.
"Offline" is the app server stopped (refused) or silent (accepts, never
answers). Run in a small native test app whose WKWebView is set up like
Homeroom's (app-bound domains on, default store), and in Safari.

In the in-app web view:

| Case | Today's headers (`max-age=0, must-revalidate`) | `max-age=0, stale-while-revalidate=86400` |
|---|---|---|
| Server stopped, app open | nothing opens | whole app, 11–15 ms |
| Server stopped, cold launch | nothing opens | whole app, 22 ms |
| Silent server | nothing after 6 s | whole app, 13 ms |
| After a merge | n/a | 1st open all old, 2nd open all new, never mixed |
| Token in the query, offline | n/a | nothing (new token, or none) |
| Token after `#`, offline | n/a | opens (any token, or none) |

In Safari only the page came back; its script and stylesheet failed unless
still fresh, and with a fresh period a merge gave a new page with an old
script until the frame reloaded. Safari turns on extra WebKit loading
(likely its look-ahead revalidation); the app's web view does not. This
matters for people using Homeroom in Safari, not in the app.

#### What building E takes

- **The token moves after `#`.** That part is never sent and is not part
  of the cache key. The gate turns today's query token into a cookie on the
  app's host (`src/services/edge-gate.js`, a redirect to itself), so a
  private app needs another way to get that cookie (the bridge hands the
  token over, or the cookie already set does). Template apps read the
  token from the query too; the bridge can put it where they look.
- **The offline address must equal the online one.** `un-theme` is in the
  query, so a theme change would miss; it moves after `#` too. A deep link
  (`pendingInnerPath`) opens offline only if that exact path was opened.
- **Cache headers on every app's page and files** (fresh for 30 days),
  including the hosted `/usernode-*` files (`must-revalidate` today), set
  at the gate or the asset server. `/api/*` keeps today's headers. No app
  change.
- **Refresh on a new version.** The shell compares the app's version with
  the one this device last opened; when it changed and the phone is
  online, the bridge refreshes everything before the app's own code runs
  (it loads first in the page), so a person never sees the old version
  after the first open that knows of the merge.
- **Access.** A fresh page opens without asking the gate, so someone
  removed from a private project could still open its page (not its data,
  which `/api/*` still checks) until the copy expires or the shell drops
  the project from their list.
- **The shell mounts offline** for an app opened online since the headers
  shipped, and swaps in today's placeholder if the bridge does not say
  hello within a few seconds (the cache was cleared).
- **Your data** is not in this cache. An app shows your data offline only
  if it keeps a copy at its own address (as the grocery list does); a
  bridge helper and the templates can make that the default.
- **Not tested:** a real app's many files, eviction under storage
  pressure, and the gate's redirects and cookies in the path.

Not workable, for the record: one origin for all apps (no isolation
between apps; encrypting each app's data does not help, because whatever
decrypts it runs at the shared origin too), and a custom URL scheme or a
local server in the native app (apps change origin, lose their storage and
secure context, and WebKit blocks `http://localhost` frames inside an https
page).

## How C answers the brief's questions

- **Never clobbering an app's worker.** C registers nothing. An app with
  its own worker keeps today's offline-ready path and opens live.
- **Freshness after merges.** The copy is shown only while offline. Online,
  the live app always loads. Each visit takes a new copy, so the first
  visit after a merge refreshes it. The strip gives the copy's time.
- **No per-person data on the app's origin.** Nothing is stored there. The
  copy is kept on Homeroom's origin, in the same per-person partition as
  `frontend/src/lib/kept-copies.ts`, and cleared by
  `App._dropCachedSession` (sign out, ended session). It is never shown to
  another account.
- **The offline-ready claim.** Its meaning stays "the app's own worker
  serves it". Offline, the shell picks, in order: the live app (own
  worker), else the last view (the shell holds a copy), else today's
  placeholder. The second step is the shell's own knowledge, not something
  the app says.
- **iOS app-bound domains.** No effect on C. The conventions should say
  that at most two apps can have their own worker in the iOS app.
- **Opt-out.** `dapp.json` `"offline": { "lastView": false }`: the shell
  never asks that app for a copy (a game, where a still means nothing, or
  an app showing something sensitive). A follow-up bridge change adds
  `data-usernode-private` to leave out one element, such as a balance.
- **The local rig.** C uses no worker, so the shell's logic can be tested
  in desktop Chrome offline on the local stack, then on the iOS simulator
  with the findings rig's `off` and `quiet` modes. The rig could not open
  project apps (plain-http frames inside an https page). That has to be
  fixed for the simulator pass, or that pass done against a preview.

## What C changes (first proposal)

1. **Take the copy.** Ask the production frame (never a staging preview)
   for a copy about 8 s after it loads, when the person leaves the App tab,
   and when the shell is hidden. At most once a minute per app. A copy
   over the bridge's 900 KB cap is skipped.
2. **Keep it.** IndexedDB on Homeroom's origin, partitioned and cleared
   like kept-copies. One copy per app, about 6 MB in all; the
   least recently opened goes first.
3. **Show it.** Offline, with no own worker: the copy in
   `<iframe sandbox srcdoc>` with no scripts and no same-origin, behind a
   CSP of `default-src 'none'; style-src 'unsafe-inline'; img-src data:`,
   so it can neither run nor fetch. Images that cannot load are hidden. A
   strip above it, words to agree, for example "Offline. This is how
   *Chores* looked at 10:42. Read only." When the connection returns, the
   live app replaces it, as the placeholder's reconnect does today.
4. **Opt-out** read from `manifest_snapshot`, validated in
   `src/services/app-manifest.js`.
5. **Conventions.** Rewrite "Offline: apps that open with no connection"
   in `src/prompts/app-conventions.md`: the last view, the opt-out, the iOS
   limit of two.
6. **Tests.** Store budget, partition and clearing; the offline order in
   `renderAppTab`; the sandbox and CSP; when copies are asked for, and
   never from a preview.

Follow-ups, each small: the bridge writes small same-origin images in and
records the scroll position; `data-usernode-private`.

Separate fix, for apps with their own worker: a first open that the worker
skipped should not withdraw the offline-ready flag while the app's
registration is active, and an offline cold launch with Todo List needs
checking with the findings rig.

Shots: the shots agent cannot take a device offline, so this is likely
`impact: none` with that reason, as with earlier offline work.

## Recommendation

**E, with long-fresh copies and a refresh on each new version.** On the
iOS app's web view, Safari and Android's engine alike it opened the whole
app with no network, cold or warm, for any number of apps, with no service
worker, no native change and no app change; "refresh everything" brought a
merge in cleanly on all three. Next: try it on one real app (its many
files, the gate's cookie, the token after `#`), then plan the proposal:
token and theme after `#`, cache headers at the gate and the asset server,
the shell's version check and offline mount, the bridge's refresh, and a
bridge helper for apps to keep their data. Two real apps' code and files
have now passed the same tests on all three engines; what is left
untested is the gate's cookie in place of the query token, real https,
and the Homeroom apps themselves, which the proposal's preview and the
simulator pass would cover. D stays the route for running apps offline
with service workers if E falls short; C is no longer needed.

## The plan for E

### What production does today (checked 2 Nov, main `d697cfe7`)

- **The app gate is off.** `/__usernode_gate/health` on an app host
  reaches the app (401), and the chart defaults `config.appGate: "off"`.
  So an app's page and files come straight from the app's own server
  through the ingress. The platform serves only the shared `/usernode-*`
  files (`scripts/serve-platform-assets.js`).
- **Every frame load has a new `?token=`**, set in `buildAppIframeSrc`
  (`public/js/app-view.js` ~1851). Every 45 minutes `_startTokenRefreshInterval`
  points the frame at a new token, which reloads the app.
- **Apps read the token from the query at start-up** (`params.get('token')`
  in the starters and in Gym Tracker).
- **Some pages need the token.** Gym Tracker answers 401 without one, and
  the template's catch-all page does too. Starter pages and the Empty
  template's static `index.html` load without one.
- **With the gate on**, an iframe page load would carry a person's identity
  only through the query token: `identityAllowed` in
  `src/services/edge-gate.js` refuses cookie identity to a same-site frame
  load.

### Decision 1: who sends the cache headers

- **(a) The app gate.** Turn it on (`config.appGate: "on"`, after the app
  namespace's network policy in the infra repository allows it, as
  `docs/kubernetes-operations.md` "App-host gate" lists) and add the cache
  rule there. Every app at once, no app change. It also makes private apps
  members-only at the edge. Its cost is a hop and a platform check per
  request, though cached files skip the network entirely.
- **(b) The apps' own servers.** The template (`src/services/template.js`:
  `express.static` and the page handler) and the starters send the headers;
  each existing app needs a change. New and starter-made projects get it
  first; reach grows app by app.

Recommended: (a), unless the gate is off for a reason not written down.
Everything below holds for both; only step 1 moves.

### The proposal (platform repository), behind a switch

`APP_OFFLINE_CACHE` (default off), so it ships dark, is turned on once
checked on the simulator, and is turned off without a deploy if needed.

1. **Cache headers.** For GET 200 answers on production app hosts, outside
   `/api/` and `/__`: `Cache-Control: max-age=2592000`, only where the app
   sent none or a revalidate-always one (`max-age=0`, `no-cache`), never
   over `no-store` or `private`, never on a preview, never for an app with
   `"offline": false`. At the gate (`scripts/app-gate.js`; the access answer
   from `edge-gate.js` says whether the app opted out) or in the template.
2. **Shared files.** The same header from `serve-platform-assets.js` and
   `server.js`'s `/usernode-*`. They change with the platform's build,
   which the version check below includes.
3. **Which apps.** A check after each deploy loads the app's `/` with no
   token; a 200 page marks the app `page_open`, sent with the app's row.
   Only those apps get the new frame address. The rest, like Gym Tracker,
   keep today's address and today's offline behaviour until their page
   loads without a token.
4. **The shell** (`public/js/app-view.js`):
   - The frame address for a `page_open` app carries the token and
     `un-theme` after `#`, so online and offline use one address.
   - It remembers, per app on this device, the app version and platform
     build last opened. When either changed, the address also carries
     `un-refresh`.
   - The 45-minute token refresh reloads the frame with the new token
     after `#` (a new hash alone would not reload it).
   - Offline, it mounts any `page_open` app opened online since the switch
     went on, and swaps in today's placeholder if the bridge has not said
     hello within about four seconds (the copy was dropped).
5. **The bridge** (`public/usernode-bridge/v1/bridge.js`), at the top of
   the file, before the app's own code runs:
   - It moves a token after `#` into the query (`history.replaceState`), so
     apps read it where they always have.
   - It records every file the app loads (a `PerformanceObserver`, kept in
     the app's own storage, capped).
   - On `un-refresh`, it hides the page, downloads every recorded file and
     the page again, bypassing the cache, then reloads without the flag.
     Chrome needs this: a plain reload left a new page with an old script.
   - It tells the shell the page opened, for the offline check.
6. **`dapp.json` `"offline": false`**, validated in
   `src/services/app-manifest.js`.
7. **Conventions** (`src/prompts/app-conventions.md`, "Offline"): pages
   load without the token; a page that differs per person sends
   `Cache-Control: no-store` or `private`; keep your own copy of the data.
8. **Tests:** the header rule and its exceptions; the bridge's token move,
   file list and refresh (in the existing vm sandbox for the bridge); the
   shell's address, version flag, token refresh and offline mount;
   `serve-platform-assets.js` headers; the deploy check. Suites that pin
   `?token=` in the frame address change with it.

Shots: online nothing changes on screen; offline cannot be shown by the
shots agent, so `impact: none` with that reason.

### Checking it

A preview cannot show it: app hosts and their shared files are served by
production's image, not the preview's. So: unit tests before merge, then
after merge, with the switch on for a test window, the same tests as above
on the simulator and the emulator against real apps (the inspector rig in
this session's notes).

### Next, separately: data

A bridge helper for apps to keep their last reads at their own address and
show them offline, cleared when the person signs out, then the starters
using it. Until then, apps open offline with their own "couldn't load"
state, as Chore list and Gym Tracker did in the trial.

### Risks

- After a merge, the first open downloads the app's files again (online
  only), behind the hidden page.
- A dropped copy falls back to today's placeholder.
- A fresh page opens without asking the server, so someone removed from a
  private project can open its page, not its data, until the copy expires.
- A page that changes without a deploy (built per request) shows its last
  copy unless it sends its own `no-store`.

## Decided, and what was built

Evan, 2 Nov 2026: **option E, with the headers from the app gate.** The
other three took their defaults: ship dark behind `APP_OFFLINE_CACHE`, the
data helper as its own proposal later, and `"offline": false` as the
opt-out.

Built (`src/services/offline-cache.js` has the overview), with three
departures from the plan above, each for a reason found while building:

- **The shared `/usernode-*` files are served
  `max-age=0, stale-while-revalidate=2592000`, not 30 days fresh.** An app
  opened at its own address, outside the shell, gets no refresh from the
  shell, so a platform fix must still reach it on its next loads; and a
  refresh keyed to the platform's build would re-download every app's files
  several times a day. Both in-app engines use a stale copy of a file with
  no network (measured for WebKit; Blink marks every subresource request
  for it).
- **No deploy-time check for which apps' pages load without a token.** The
  shell learns it on each device instead: a frame at the new address whose
  bridge never says it opened (a page that answered 401, or an app with no
  hosted bridge) is framed the old way on that device for a week. No column,
  no deploy hook, and it covers apps that vendor an old bridge too.
- **The 45-minute token refresh needed no change.** Once the bridge has
  moved the token into the query, an address with a new token after `#` is
  a full navigation, which reloads the app from the cache with the new
  token.

Evan, later the same day: **on by default.** The chart now defaults both
`config.appGate` and `config.appOfflineCache` to `"on"`. Production sets
neither (infra `feat/k8s`, workloads/social-vibecoding/values/platform.yaml)
and follows the chart's `0.1.*` releases, so both go on at the first release
after this merges. The gate's network rules are already in production's
tenant network policy (foundation chart, `tenantNetworkPolicy.enabled: true`,
rules for `usernode-app-gate` since 23 Oct). Outside the chart (a local or
standalone run) both stay off unless set. Either goes off again with a value
and a sync (`docs/kubernetes-operations.md`).

Still to do, outside this proposal:

1. After the release: the simulator and emulator pass against real apps
   (the inspector rig from these tests), private apps included.
2. The data helper.

## Appendix: B in detail, if it is ever wanted

- Served at `/usernode-bridge/v1/sw.js` with `Service-Worker-Allowed: /`
  from `server.js` and `scripts/serve-platform-assets.js`. Registered by
  the bridge with `updateViaCache: 'none'`, only after the shell's go-ahead
  (so never in a preview, and never outside Homeroom), after `load`, and
  only if the origin has no other registration. An app that registers its
  own worker replaces ours (same scope, different script), and the bridge
  then stands aside for good. Caches are named `usernode-*` and never touch
  the app's.
- A navigation with `?token=` (an online mount) goes to the network with no
  deadline, so an old page never meets a newer API. A tokenless one (an
  offline mount) gets a 3 s deadline, then the kept copy. Subresources
  follow their document: a page from the network loads from the network, a
  kept page loads kept files. Copies are rebuilt without their address, so
  a token never lands on disk.
- Never kept: non-GET, `/api/*`, event streams, `/__*` gate paths, Range
  requests, non-200, `no-store` or `private`.
- Data would come from the shell (the bridge passes reads between the
  worker and the shell) so nothing per-person sits on the app's origin.
- A kill switch is a worker that unregisters itself, shipped by a platform
  deploy.
