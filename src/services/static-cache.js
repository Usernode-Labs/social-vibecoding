// Cache policy for the platform shell's own static assets (HTML / JS / CSS
// under public/).
//
// Why this exists: mobile WebViews (and some intermediary proxies) cache JS
// and CSS aggressively. A PR's staging preview lives at a STABLE URL across
// pushes to that PR's branch, so once a WebView cached `/js/app.js` it kept
// serving the pre-fix copy on every subsequent load — a shipped fix never
// actually ran, and the bug looked completely unchanged ("same as before")
// no matter how many times the code was corrected.
//
// The platform already learned this for the centrally-hosted bridge, which
// is served with `no-cache, must-revalidate` (see the /usernode-bridge
// middleware in server.js). The shell's own HTML/JS/CSS need the same
// treatment: revalidate on every load so a redeploy reaches users on the
// next page load instead of whenever the WebView decides to drop its cache.
// This is cheap — ETag / Last-Modified still yield 304s when the file is
// unchanged, so only genuinely-changed assets re-download.
//
// Long-lived immutable assets (e.g. /visuals/:id, the versioned bridge URL)
// set their own headers on their own routes and never reach this helper.
const REVALIDATE = 'no-cache, must-revalidate';

// Returns the Cache-Control value for a shell asset path, or null if the
// path isn't a revalidate-every-load shell asset (let the default apply).
function shellAssetCacheControl(filePath) {
  return /\.(?:html|js|css|webmanifest)$/i.test(String(filePath)) ? REVALIDATE : null;
}

// ── Which BUILD an asset belongs to ──────────────────────────────────────
//
// The revalidation above is right and stays. What it costs is a ROUND TRIP
// PER ASSET, and the shell is ~34 of them: measured warm on a 150ms link,
// every one was answered by the service worker out of its cache — after
// spending 200ms+ discovering that, because networkFirstShell races each
// asset against a deadline. 483ms of waiting for an answer the cache had
// the whole time, on a load where nothing had been deployed at all.
//
// The worker already has the shortcut (shellFromCacheThisLoad: if the
// DOCUMENT lost its race, serve every asset from cache outright). But the
// document only loses on a connection slower than 200ms — so the
// optimisation fired only when the network was bad and the cost was paid
// only when it was good.
//
// This header is what lets the worker ask the question it actually wants
// to ask: is the cached copy of this asset from the SAME BUILD as the
// document being parsed? If yes, the network has nothing to add and the
// cache answers immediately. If no, a deploy has happened and the asset
// races exactly as before, so a redeploy still reaches a WebView on the
// next load — the thing this whole file exists to guarantee.
//
// Deliberately ABSENT when the deploy identity is unknown. `dev` is not a
// build id — it never changes, so serving on it would pin a local checkout
// to whatever the worker cached first, and an edit to public/js/app.js
// would stop showing up. No header means the worker falls back to the race
// it does today, which is exactly right for a checkout.
const SHELL_BUILD_HEADER = 'X-Platform-Build';

/**
 * The deployed build id, or null when this process has no deploy identity
 * (a checkout, or a staging preview built without GIT_SHA — /api/version
 * reports the same value as the literal "dev" there).
 */
function shellBuildId(env = process.env) {
  const raw = String(env.GIT_SHA == null ? '' : env.GIT_SHA).trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(raw) ? raw : null;
}

/** Set the build header on a shell-asset response, when there is one to set. */
function applyShellBuildHeader(res, env = process.env) {
  const id = shellBuildId(env);
  if (id) res.setHeader(SHELL_BUILD_HEADER, id);
  return id;
}

module.exports = {
  shellAssetCacheControl,
  shellBuildId,
  applyShellBuildHeader,
  SHELL_BUILD_HEADER,
  REVALIDATE,
};
