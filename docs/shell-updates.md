# Automatic shell updates

Production and previews use the same release protocol. After the shell and
Tailwind builds, `scripts/build-shell-release.js` hashes the finished assets
and writes ignored `public/shell/release.json` and `public/shell/worker.js`.
The server exposes the generated worker at the fixed `/sw.js` URL. Editing a
shell asset changes that worker automatically; no manual SW_VERSION bump is
needed. Both image paths supply GIT_SHA, and startup rejects inconsistent or
unstamped hosted artifacts.

The worker stores assets by content hash. Only newly downloaded bytes are
verified in the browser; ordinary cached reads perform no hashing or network
revalidation. A complete required shell must be downloaded before its release
is published. Lazy chunks stay lazy. Identical files survive backend-only
updates, and reused responses keep relative imports scoped to the requested
build. The manifest costs a few kilobytes per update; there is no new polling
loop or runtime dependency.

The current and previous releases are retained, plus releases still used by
open tabs. Web Locks coordinate cache mutations between installing and active
workers; a per-worker queue supports older browsers without that API. Migration
retains legacy shell caches while unidentified old tabs are open. API/auth,
image caches and unrelated storage are preserved. The existing unsaved-input
and reload-loop protections still govern page reloads. An already open tab is
not forcibly refreshed: drafts survive until the user accepts an update or
navigates. A first visit still needs connectivity; unavailable old lazy chunks
fail explicitly instead of receiving another revision's code.

Required checks always include `tests/shell-release.test.js`: generated
identity, build wiring, warm upgrades, failed downloads, mixed-build responses,
offline access, cached authentication, old tabs, cleanup, migration, activation
races and rollback. Visual evidence also checks a stamped document against the
expected commit before recording its checkpoint. Historical `dev` documents
and ordinary apps without the shell marker remain supported.

For real-browser upgrade verification, run `npm run test:shell-upgrade:browser`
with an available Puppeteer installation. `PUPPETEER_MODULE` and
`BROWSER_EXECUTABLE` select existing local installations. This uses a disposable
browser profile and a loopback fixture, with no platform database or external
server access. It exercises multiple revisions at one origin without clearing
caches, including a CSS-only update that reuses JavaScript with relative lazy
imports. The fixture supplements the required deterministic lifecycle tests;
it does not test every browser engine or live user data.
