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
  return /\.(?:html|js|css)$/i.test(String(filePath)) ? REVALIDATE : null;
}

module.exports = { shellAssetCacheControl, REVALIDATE };
