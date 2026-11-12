# Browser site and session isolation

Status: implementation and local validation; deployment acceptance is separate.

Target layout: the platform stays on `onhomeroom.com` (`app.onhomeroom.com`),
and production apps and their previews move to `onhomeroom.app`. Two ICANN
sites, not one: the Public Suffix List's private section would give each app
its own site, but it holds only in browsers that already ship an entry, and
the list's maintainers decline projects of our size. Previews share the apps'
site by default. That keeps the platform out of their reach, but a preview's
unreviewed code is same-site with every production app; only a previews
domain of its own protects apps from their previews. `config.previewsDomain`
(`USERNODE_PREVIEWS_DOMAIN`, `src/services/previews-domain.js`) gives them
one, planned as `onhomeroom.dev`, after the apps move. This change prepares the
cutover and leaves it disabled. It is not a declaration that deployment
isolation is complete.
The strict cutover in this change targets Kubernetes. The stock Compose edge
still routes one wildcard site and captures production over private HTTP;
startup refuses strict mode there until that edge and capture transport are
migrated. Ordinary Compose and plain HTTP development remain in legacy mode.

## Boundary

The platform keeps authentication, OAuth callbacks and its API on its canonical
host. Generated apps and previews belong on a different HTTPS site, determined
with the ICANN section of the Public Suffix List only: different ICANN
registrable domains are different sites in every browser, whatever copy of the
list it ships, while a private entry separates sites only where it has already
shipped. Changing only the subdomain does not establish that boundary. Strict
startup probes the hosts `caddy.js` actually builds (a production app and a
preview), not the configured domain alone. Custom app domains must obey the
same rule. App identities remain scoped tokens; the platform session must never
be forwarded to an app.

The session and cache-partition cookies use host-only `__Host-` names, `Secure`, path
`/`, and no Domain attribute. The session is HttpOnly; the cache partition label
is readable but grants no authentication. HTTPS clients read only the protected
cache label, with no fallback to the old name. Plain HTTP development retains
unprefixed cookies. The sign-up, OAuth, phone, invite and invite-tracking
cookies take `__Host-` names on HTTPS now, independently of strict mode: no
host on the shared site can plant one. The native handoff cookie keeps its
name until native clients read the protected one, like the session.

## Request hardening that needs no layout change

These ship with this change, in every mode, and protect browsers on today's
shared site too:

- WebSocket handshakes accept the session cookie only from the platform's
  own pages (Fetch Metadata, else Origin). Handshakes with neither header
  come from clients that are not browsers and pass.
- Every write that carries the session cookie must come from the platform's
  own pages, whatever route it reaches (`sameOriginCookieWrites`, mounted
  ahead of every router; the anonymous `/api/public/` tier excepted). Writes
  with neither Origin nor Fetch Metadata are logged once per shape and still
  pass, until the native inventory shows no client depends on that.
- The shell document may be framed only by the platform itself (and, for a
  preview of Homeroom, by the production platform).
- Preview frames get the production app frame's sandbox before every
  navigation, so unreviewed code cannot navigate the Homeroom tab.
- App-host sign-in codes are bound to the browser that started the hop.

## Delivery and cutover

1. Deploy the protected cache label independently of the session-name cutover.
   A fresh authenticated identity read establishes the new label. Old tabs may
   lose offline caching until refreshed; old cache labels never become a
   fallback for new clients. Keep identity-switch and late-response fences.
2. Prepare the host-only session reader/writer and an explicit isolation mode.
   Helm's `config.browserSiteIsolation` maps to `BROWSER_SITE_ISOLATION`:
   `legacy` is the default; `strict` is the explicit cutover.
   The existing session name remains the deployment default while native
   prerequisites are outstanding. Strict mode reads only the protected name;
   it neither upgrades nor falls back to legacy cookies. All HTTP, WebSocket,
   OAuth, stream, account-management and app-authorization consumers agree.
3. Release compatible native clients before enabling strict mode. iOS and
   Android currently construct `session` when restoring a web session. They
   must install and inspect the protected cookie on HTTPS, clear both names
   at sign-out, and handle the one-time browser reauthentication below.
4. Provision `onhomeroom.app` for production apps and previews: DNS at a
   provider cert-manager can drive (wildcards need DNS-01), wildcard TLS,
   shared assets, gate, preview and custom-domain routes, network policy and
   ingress, and the iOS App-Bound Domains list. Private apps in shell frames
   are ready for it (the frame door, below). Strict mode needs apps and
   previews off the platform's site, not apart from each other. The switch
   is `config.appsDomain: onhomeroom.app` with
   `config.legacyAppsDomain: onhomeroom.com`
   (`src/services/apps-domain-move.js`): the release moves every production
   app Ingress to the new domain, a preview moves on its next build and keeps
   serving at the old one until then, a custom domain's CNAME may still point
   at an app's old address, and the infrastructure redirects old addresses
   nothing serves any more. Retire the previews left on the old domain, then
   clear `legacyAppsDomain`. Inventory and retire old app/preview routes on the
   platform site, including old captures and custom domains. A configuration
   check cannot prove their absence. Do not leave an alias serving untrusted
   content on the old site. `git.onhomeroom.com` and the marketing apex stay
   on the platform's site, so the request hardening above stays necessary.
5. Enable strict isolation only after those prerequisites. Startup must refuse
   an invalid mode or a same-site app domain. Custom-domain admission and
   resolution must refuse the platform site. Do not automatically trust a
   legacy cookie: schedule a one-time sign-in for existing browser sessions.
   Keep the platform origin and OAuth registrations stable.

## Private apps in a cross-site frame (the frame door)

The gate's door cookie is SameSite=Lax, so it is never sent to a cross-site
frame, and with third-party cookies blocked no unpartitioned cookie is kept
there; the in-frame sign-in hop cannot run either, because its state cookie
would be a third-party cookie. Once the configured hosts put apps on another
ICANN registrable domain than the platform (`edge-gate.js`
`framesCrossSite`; today's layout answers no and is unchanged):

- A frame's token opens a partitioned door (CHIPS: `__Host-`, `Secure`,
  `SameSite=None`, `Partitioned`), kept only under the platform's top-level
  site. It covers the frame's assets, cookie-only fetches, WebSocket
  handshakes and in-frame navigations. It stays door-only; the app's identity
  is still the token it forwards. Top-level visits keep the Lax cookie.
- A frame navigation holding nothing valid gets the frame door page (401,
  framed only by the platform) instead of the hop. It asks the shell by
  postMessage, to the platform origin only, for a fresh token; the shell
  (`app-view.js` `handleFrameDoorMessage`) answers only its own App-tab or
  preview frame, for that frame's app, at the origin the frame was pointed
  at. The page trades the token at `/__usernode_access?frame=` and returns
  to the page asked for, fragment included (an offline app's `#un-token`).
- A browser that keeps no cookie in the frame (WebKit shipped partitioned
  cookies in Safari 18.4, switched them off in 18.5 to 26.1, and brought them
  back in 26.2) is shown that the app cannot open inside Homeroom, with a link
  that opens it in its own tab, where the top-level hop works.

The Storage Access API was not used: WebKit grants it only after a user
gesture in the frame, a prompt, and prior first-party interaction with the
apps' site. Neither platform cookie changes.

## Acceptance

`node scripts/verify-framed-private-app.js --browser chrome --layout cross
--expect pass` runs a synthetic shell on one registrable domain framing a
private app behind the real gate on another, with third-party cookies blocked
(confirmed by a probe frame), and checks assets, fetches, a WebSocket and an
in-frame navigation, for a token frame and an offline app's tokenless one.
`--layout same` checks today's layout; `--no-frame-cookies --expect blocked`
checks the page a browser without partitioned cookies gets. `--serve` keeps it
up for a hand-driven browser such as the iOS Simulator's Safari.

Run `node scripts/verify-browser-site-isolation.js` with Chrome (or set
`CHROME_EXECUTABLE`) and capture's pinned `puppeteer-core` installed. The
synthetic local HTTPS harness uses the real page guard and service worker. It
checks cookie injection from a sibling, browser-observed cross-site requests,
same-session offline replay and refusal after changing sessions. Its temporary
certificate, server and browser are removed when the run ends. Database and
WebSocket tests are selected by `npm run test:changed -- --base <base-sha>`.

Use fake accounts and synthetic data. Record the exact server image, client
versions, configuration and browser versions with each result.

- Browser login, email/phone onboarding, OAuth (including Apple form POST),
  logout, renewal, linked-browser revocation and account deletion work.
- A sibling app cannot set either protected platform cookie using Domain or
  a narrower Path. Legacy cookies cannot override or authenticate strict mode.
- HTTP and WebSocket authentication agree, including duplicate-cookie refusal.
- Account switching, offline boot, worker upgrade, native renewal and delayed
  responses cannot disclose another session's cache. Same-session offline use
  still works. Test an already-installed old worker as well as a fresh one.
- Native iOS/Android establishment, restore, handoff, logout and recovery work
  with the protected name; an obsolete native client is not silently accepted.
- Production apps, previews, custom hosts and the platform's own empty-data
  preview work when third-party cookies are blocked. Use app tokens/parent
  relays for embedded identity; never widen platform cookies or use
  `SameSite=None` merely to restore an iframe's ambient session.
- The app-host sign-in hop works as a top-level cross-site navigation. App
  access revocation and private-host refusal still hold.
- Browser-observed Fetch Metadata confirms cross-site app/platform requests.
  Inspect live ingress inventory separately for retired same-site app routes.

## Recovery

Before cutover, reverting this code leaves the legacy deployment unchanged.
After cutover, prefer fixing forward or returning to a known strict-capable
release. Re-enabling legacy authentication explicitly weakens the boundary and
requires a fresh operational decision; no reader silently makes that choice.
DNS rollback must not restore untrusted content to the platform site. Preserve
app databases, files and identity keys through the domain move.

References: [cookie prefixes](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#cookie_prefixes),
[browser sites](https://web.dev/articles/same-site-same-origin).
