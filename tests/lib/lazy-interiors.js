// The interiors that MOUNT ON FIRST REVEAL instead of shipping in the
// prerender (frontend/src/lib/mount-on-reveal.ts), rendered the way the
// browser renders them, for the tests that inventory the shell's ids.
//
// public/index.html used to carry every screen's markup — 1,485 elements, of
// which #settings-screen's sixteen panes (437) and the six anonymous-shell
// screens (244) were hidden behind roots a signed-in visitor on the board
// never reveals. Those interiors render only once their root is revealed or a
// legacy caller asks for them, so the prerendered document no longer holds
// their ids — and tests/shell-id-inventory.test.js and
// tests/dapp-selectors-resolve.test.js, which resolve the frozen baseline
// against the document, would read every one of them as LOST.
//
// They are not lost, they moved: from the prerender to a mount. This helper
// renders each INTERIOR — the children of the host, never the host or the
// chassis around it, which the document still carries — and the tests union
// that markup with the document. Every id in the baseline is still accounted
// for, in the place it now lives, and counted once.
//
// Nothing here relaxes the inventory: an id has to be in the document OR in
// exactly the interior that owns it, and shell-id-inventory pins that the
// prerender itself does NOT contain them — which is the whole point.

const { loadTsx, renderComponent } = require('./render-tsx');

/**
 * Each root whose interior mounts on reveal.
 *
 *   id         the root the legacy router reveals and the checks anchor on
 *   host       the element whose CHILDREN are the interior (the root itself
 *              for the auth screens; #settings-section-content for settings)
 *   entry /    how to render the interior. Settings' is a component of its
 *   component  own (SettingsSections). The auth screens render root and
 *              interior in one component, so the interior is sliced out of
 *              the host's tag — the component is rendered with its id
 *              marked mounted, which is what the browser's reveal does.
 *
 * Keep in step with the `useMountedOnReveal(...)` calls in these files.
 */
const MOUNT_ON_REVEAL = [
  {
    id: 'settings-screen',
    host: 'settings-section-content',
    entry: 'frontend/src/features/settings/sections/index.tsx',
    component: 'SettingsSections',
    mark: false,
  },
  { id: 'auth-landing-screen', host: 'auth-landing-screen', entry: 'frontend/src/features/auth/landing.tsx', component: 'LandingScreen', mark: true },
  { id: 'auth-login-screen', host: 'auth-login-screen', entry: 'frontend/src/features/auth/login.tsx', component: 'LoginScreen', mark: true },
  { id: 'auth-register-screen', host: 'auth-register-screen', entry: 'frontend/src/features/auth/register.tsx', component: 'RegisterScreen', mark: true },
  { id: 'auth-waiting-screen', host: 'auth-waiting-screen', entry: 'frontend/src/features/auth/waiting.tsx', component: 'WaitingScreen', mark: true },
  { id: 'auth-waitlist-screen', host: 'auth-waitlist-screen', entry: 'frontend/src/features/auth/waitlist.tsx', component: 'WaitlistScreen', mark: true },
  { id: 'auth-more-screen', host: 'auth-more-screen', entry: 'frontend/src/features/auth/more.tsx', component: 'MoreScreen', mark: true },
];

let store = null;
function mountStore() {
  // One esbuild bundle per entry, but the mark lives on globalThis under
  // MOUNTED_STORE_KEY, so a mark made through this copy is read by the copy
  // inside each screen's bundle.
  if (!store) store = loadTsx('frontend/src/lib/mount-on-reveal.ts');
  return store;
}

/**
 * The children of `<… id="host" …>` in `html`, by depth — the host's own tag
 * and everything outside it are the chassis, which the document still ships.
 */
function childrenOf(html, host) {
  const open = new RegExp(`<([a-zA-Z][a-zA-Z0-9-]*)(\\s[^>]*)?\\sid="${host}"[^>]*>`).exec(html);
  if (!open) throw new Error(`#${host} not found in the rendered markup`);
  const tag = open[1];
  const start = open.index + open[0].length;
  const re = new RegExp(`<(/?)${tag}(?=[\\s>/])[^>]*>`, 'g');
  re.lastIndex = start;
  let depth = 1;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[0].endsWith('/>')) continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index);
  }
  throw new Error(`#${host} is never closed in the rendered markup`);
}

const rendered = new Map();

/** The markup of one root's interior, mounted — host children only. */
function interiorHtmlFor(id) {
  if (rendered.has(id)) return rendered.get(id);
  const spec = MOUNT_ON_REVEAL.find((s) => s.id === id);
  if (!spec) throw new Error(`${id} is not a mount-on-reveal root`);
  if (spec.mark) mountStore().markMounted(id);
  const full = renderComponent(spec.entry, spec.component, {});
  const html = spec.host === spec.id || full.includes(`id="${spec.host}"`)
    ? childrenOf(full, spec.host)
    : full;
  rendered.set(id, html);
  return html;
}

/** Every mount-on-reveal interior, concatenated, in MOUNT_ON_REVEAL order. */
function lazyInteriorsHtml() {
  return MOUNT_ON_REVEAL.map((s) => interiorHtmlFor(s.id)).join('\n');
}

module.exports = { MOUNT_ON_REVEAL, interiorHtmlFor, lazyInteriorsHtml, childrenOf };
