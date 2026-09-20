/**
 * Security policy for the production App-tab iframe.
 *
 * The frame is mounted before its app URL is available so the launch animation
 * can keep one stable DOM element. While it has no source it must stay fully
 * restricted: giving that same-origin blank document both `allow-scripts` and
 * `allow-same-origin` is what makes browsers report an escapable sandbox.
 *
 * Immediately before a verified cross-origin HTTP(S) navigation, the bridge
 * switches the SAME element to APP_FRAME_SANDBOX. Sandbox changes apply to the
 * next navigation, so the app keeps its origin-backed storage and APIs without
 * granting those permissions to the pending blank document.
 */

export const PENDING_FRAME_SANDBOX = '';
export const APP_FRAME_SANDBOX =
  'allow-scripts allow-forms allow-same-origin allow-popups allow-pointer-lock';

/**
 * ── The permission policy (#2219) ──────────────────────────────────────
 *
 * `allow` behaves exactly like `sandbox` above: a frame's container policy
 * is computed when it NAVIGATES, so the attribute has to be right on the
 * line before `src` is assigned and cannot be widened afterwards. That is
 * why the granted set rides the iframe-token response and why `setSrc`
 * takes it — see ./app-frame-bridge.js.
 *
 * The browser copy of services/app-permissions.js. Two copies because one
 * runs in node and one in the bundle; tests/app-permissions.test.js pins
 * them against each other, the same arrangement the `allow` attribute's own
 * two copies have always had.
 */

/**
 * Delegated to every app frame, gate or no gate: a copy button and a game.
 * `geolocation` used to be the third entry and is deliberately not here.
 */
export const UNGATED_CAPABILITIES = ['clipboard-write', 'pointer-lock'];

/**
 * The capabilities that need a per-user, per-app grant. Names are
 * Permissions Policy tokens and the order is the catalogue's, so the
 * attribute built from a given grant set is stable.
 */
export const GATED_CAPABILITIES = [
  'geolocation',
  'microphone',
  'camera',
  'display-capture',
  'usb',
  'serial',
  'hid',
  'bluetooth',
  'midi',
];

/**
 * What a frame with no grants at all gets, and the whole story for the
 * landing viewer and the staging preview.
 *
 * Neither of those delegates a gated capability. The landing viewer serves
 * signed-out visitors, so there is no user to hold a grant; the staging
 * preview shows a build the group has not voted in yet, and handing
 * unreviewed code a camera is the thing the gate exists to stop. Both still
 * relay the permission prompt (the shell answers them through
 * `ownedFrameFor`), so an app can tell WHY it was refused there.
 */
export const BASE_ALLOW = UNGATED_CAPABILITIES.join('; ');

const GATED_SET = new Set(GATED_CAPABILITIES);

/**
 * The `allow` attribute for a granted set: the ungated base first, then
 * whatever of `granted` is a real gated capability, in catalogue order.
 *
 * `granted` is filtered rather than trusted. This is the last line before a
 * capability name reaches a live DOM attribute, and what it is handed came
 * over the network.
 */
export function allowAttribute(granted) {
  const wanted = new Set(Array.isArray(granted) ? granted.filter((c) => GATED_SET.has(c)) : []);
  return UNGATED_CAPABILITIES.concat(GATED_CAPABILITIES.filter((c) => wanted.has(c))).join('; ');
}

/**
 * Only a real web origin distinct from the platform may enter #app-iframe.
 * Both arguments are explicit so the policy stays pure and directly testable.
 */
export function isSafeAppFrameSrc(src, platformOrigin) {
  if (!src || !platformOrigin) return false;
  try {
    const target = new URL(src);
    const platform = new URL(platformOrigin);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
    if (platform.protocol !== 'http:' && platform.protocol !== 'https:') return false;
    return target.origin !== platform.origin;
  } catch {
    return false;
  }
}

/**
 * ── Which URLs an app frame may be pointed at (#2514) ──────────────────
 *
 * Absolute http(s), and NEVER the platform's own origin. The second half is
 * the load-bearing one: `src=""` or a platform URL loads the shell inside its
 * own app frame, and on the staging path the URL carries the app-identity
 * JWT as `?token=`, so a frame pointed at the platform would put that token
 * in a document that can read the session cookie.
 *
 * The production frame has always checked this (`_isSafeAppIframeSrc` in
 * public/js/app-view.js). The STAGING preview did not — `setSrc` was a bare
 * `el.src = src` — so a server-side regression that set `staging_url` to the
 * platform origin would have been framed without complaint.
 *
 * This is the browser-bundle copy, for the same reason the `allow` policy
 * above has two: one runs in a classic `public/js/**` script that cannot
 * import, and one in the bundle. tests/client-trust-gaps.test.js pins them
 * against each other, exactly as tests/app-permissions.test.js does for the
 * other pair — change one and the test names the other.
 */
export function isSafeAppIframeSrc(src, platformOrigin) {
  if (!src || !platformOrigin) return false;
  try {
    const target = new URL(src);
    const platform = new URL(platformOrigin);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
    if (platform.protocol !== 'http:' && platform.protocol !== 'https:') return false;
    return target.origin !== platform.origin;
  } catch {
    return false;
  }
}
