/**
 * Build-scoped asset URLs — the browser-side twin of
 * scripts/shell-stamp.js's buildScopedAssetUrl(), which it has to match byte
 * for byte.
 *
 * A deployed document addresses every script and stylesheet it loads as
 * `/b/<build sha>/…` rather than `/js/…` (the "Build-scoped asset URLs" note
 * in scripts/shell-stamp.js is the full account). The URL changes exactly
 * when the build does, which is what lets src/services/static-cache.js answer
 * those requests `immutable` — and the browser keep V8's compiled-code cache
 * for them across loads instead of rebuilding it on every one.
 *
 * Why the shell tree needs its own copy of the rule: the 25 legacy <script>
 * tags at the end of <body> are rendered by Shell.tsx, twice. The prerender
 * pass (frontend/scripts/build-shell.mjs, in Node) renders them with the
 * GIT_SHA the image is built with; the browser then hydrates that same tree
 * and must produce the same strings from the document it was handed. It can,
 * because build-shell.mjs writes that same GIT_SHA into the document as
 * `<meta name="platform-build">` — so both renders read one value, and the
 * attributes agree.
 *
 * `dev` — a checkout, or a staging preview built without GIT_SHA — means no
 * prefix. The paths stay `/js/…` under today's revalidate-every-load policy,
 * so an edit to public/js/app.js still shows up on the next reload.
 */

const BUILD_META_NAME = 'platform-build';
const BUILD_SHA_RE = /^[0-9a-f]{7,40}$/;

function normalizeBuildSha(value: unknown): string | null {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  return BUILD_SHA_RE.test(raw) ? raw : null;
}

let cachedBuildId: string | null | undefined;

/** The build this document belongs to, or null outside a deploy. */
export function documentBuildId(): string | null {
  if (cachedBuildId !== undefined) return cachedBuildId;
  if (typeof document === 'undefined') {
    // The prerender pass: the same GIT_SHA the document's <meta> is written
    // from, read the same way scripts/shell-stamp.js normalizes it.
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    cachedBuildId = normalizeBuildSha(env?.GIT_SHA);
  } else {
    const meta = document.querySelector(`meta[name="${BUILD_META_NAME}"]`);
    cachedBuildId = normalizeBuildSha(meta && meta.getAttribute('content'));
  }
  return cachedBuildId;
}

/**
 * Scripts and stylesheets are what a build owns. The worker is excluded by
 * name: /sw.js is the registration URL, and a per-build worker URL would
 * register a new worker per deploy instead of updating the one there is.
 */
export function isBuildScopedAssetPath(path: string): boolean {
  if (path === '/sw.js') return false;
  return /\.(?:js|css)$/i.test(path);
}

/** `/js/app.js` → `/b/<sha>/js/app.js` in a deployed document; unchanged otherwise. */
export function assetUrl(path: string): string {
  const id = documentBuildId();
  if (!id || !isBuildScopedAssetPath(path)) return path;
  return `/b/${id}${path}`;
}

/** Test seam: forget the memoized id so a test can vary the meta or env between calls. */
export function resetDocumentBuildIdForTests(): void {
  cachedBuildId = undefined;
}
