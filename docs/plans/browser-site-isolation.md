# Browser site and session isolation

Status: implementation and local validation; deployment acceptance is separate.

The app domain will be selected later. This change prepares the cutover and
leaves it disabled. It is not a declaration that deployment isolation is complete.
The strict cutover in this change targets Kubernetes. The stock Compose edge
still routes one wildcard site and captures production over private HTTP;
startup refuses strict mode there until that edge and capture transport are
migrated. Ordinary Compose and plain HTTP development remain in legacy mode.

## Boundary

The platform keeps authentication, OAuth callbacks and its API on its canonical
host. Generated apps and previews belong on a different HTTPS site, determined
with the Public Suffix List, including private suffixes. Changing only the
subdomain does not establish that boundary. Custom app domains must obey the
same rule. App identities remain scoped tokens; the platform session must never
be forwarded to an app.

The session and cache-partition cookies use host-only `__Host-` names, `Secure`, path
`/`, and no Domain attribute. The session is HttpOnly; the cache partition label
is readable but grants no authentication. HTTPS clients read only the protected
cache label, with no fallback to the old name. Plain HTTP development retains
unprefixed cookies.

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
4. Choose and provision the separate app domain: DNS, wildcard TLS, shared
   assets, gate, preview and custom-domain routes, network policy and ingress.
   Inventory and retire old app/preview routes on the platform site, including
   old captures and custom domains. A configuration check cannot prove their
   absence. Do not leave an alias serving untrusted content on the old site.
5. Enable strict isolation only after those prerequisites. Startup must refuse
   an invalid mode or a same-site app domain. Custom-domain admission and
   resolution must refuse the platform site. Do not automatically trust a
   legacy cookie: schedule a one-time sign-in for existing browser sessions.
   Keep the platform origin and OAuth registrations stable.

## Acceptance

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
