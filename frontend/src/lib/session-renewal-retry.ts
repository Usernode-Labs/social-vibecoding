/**
 * A request refused only because the web session was being renewed is sent
 * again (#5049).
 *
 * In the mobile app the web session is renewed through the native bridge
 * (NativeChrome.restoreWebSession, public/js/native-chrome.js), and the server
 * ROTATES it: it deletes the old session and mints a new one
 * (src/services/topochain/native-web-session.js), so late requests carrying
 * the old token can neither authenticate nor touch the new session. The app
 * installs the new cookie only once the answer is back. Any request the
 * server reached in between carried the old token and was answered 401,
 * although nobody was signed out.
 *
 * Every document the app opened used to renew, beside the boot's first reads:
 * a link to a change looked its number up inside that gap, read the 401 as
 * "no such change" and dropped the viewer on the project's hub instead.
 * Renewal is daily now (NativeChrome._renewedRecently), but the daily one, a
 * resume and a forced one still open the same gap, and this closes it.
 *
 * ── The rule ───────────────────────────────────────────────────────────
 *
 * A same-origin 401 is sent again, once, when a renewal finished while the
 * request was out, or is still running when its answer arrives (it is
 * waited for first). The count it reads (`webSessionRenewal().epoch`) moves
 * only when a renewal succeeded, so:
 *
 *   - outside the app, or when no renewal ran, nothing changes: the 401
 *     comes back as it arrived, unread;
 *   - a renewal that failed retries nothing, and the caller sees the 401;
 *   - the retry goes out with the ORIGINAL fetch, so a second 401 is
 *     returned to the caller, never retried again.
 *
 * Sending a write again is safe here: a 401 is the auth middleware refusing
 * the request before any route handled it. A Request object is cloned before
 * it is first sent, because a consumed body cannot be sent twice; a streamed
 * body is never retried for the same reason.
 */

type Renewal = { epoch: number; settled: Promise<unknown> | null };

function renewalOf(win: any): Renewal | null {
  try {
    const state = win.NativeChrome?.webSessionRenewal?.();
    return state && typeof state.epoch === 'number' ? state : null;
  } catch {
    return null;
  }
}

function sameOrigin(win: any, input: RequestInfo | URL): boolean {
  try {
    const raw = typeof Request !== 'undefined' && input instanceof Request ? input.url : String(input);
    return new URL(raw, win.location.href).origin === win.location.origin;
  } catch {
    return false;
  }
}

function streamed(init?: RequestInit): boolean {
  return typeof ReadableStream !== 'undefined' && init?.body instanceof ReadableStream;
}

/**
 * Wrap `window.fetch` once. Exported for the test, which hands in its own
 * window; the browser installs it from main.tsx.
 */
export function installSessionRenewalRetry(win: any = typeof window !== 'undefined' ? window : null): void {
  if (!win || typeof win.fetch !== 'function' || win.__sessionRenewalRetryInstalled) return;
  const send: typeof fetch = win.fetch.bind(win);
  win.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const before = renewalOf(win);
    if (!before || streamed(init) || !sameOrigin(win, input)) return send(input, init);
    const again = typeof Request !== 'undefined' && input instanceof Request ? input.clone() : input;
    const res = await send(input, init);
    if (res.status !== 401) return res;
    const running = renewalOf(win)?.settled;
    if (running) {
      try {
        await running;
      } catch {
        return res;
      }
    }
    const after = renewalOf(win);
    if (!after || after.epoch === before.epoch) return res;
    return send(again, init);
  };
  win.__sessionRenewalRetryInstalled = true;
}
