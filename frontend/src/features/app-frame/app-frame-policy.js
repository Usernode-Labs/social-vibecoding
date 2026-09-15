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
