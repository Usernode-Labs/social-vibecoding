/**
 * Join, in place of a refusal (communities).
 *
 * Taking part in an app — starting a change, proposing it, filing a request,
 * voting, posting in its chat — is for the members of the community it
 * belongs to (src/services/communities.js). A non-member's write is answered
 * 403 with `code: 'join_required'` and the app it is about. That answer is a
 * QUESTION, and this module is the one place it is asked: "Join <app>?", and
 * on a yes the membership is written (Home.setMembership, the same call
 * Discover's pill makes) and the refused request is sent again, so the press
 * that met the refusal simply lands.
 *
 * ── Why a fetch wrapper, not a handler per caller ──────────────────────
 *
 * The gated writes are reached from a dozen places — the vote buttons, New
 * change, the request dialogs, a proposal's thread composer, Put up for vote
 * on a change page — in both the legacy scripts and the React islands, and
 * every new write route of that kind joins the list. A handler per caller is
 * a list that is incomplete the day a caller is added. Wrapping `fetch` once
 * makes the rule the platform's: any non-GET that comes back
 * `join_required` is offered Join, whoever sent it.
 *
 * What it does NOT change is what a caller sees when the viewer says no: the
 * original 403 comes back untouched, with its sentence in `error`, and the
 * caller's own error path says it the way it says every refusal.
 *
 * ── The rules it keeps ─────────────────────────────────────────────────
 *
 *   - Only a 403 whose JSON says `join_required`, on a method that writes.
 *     Every other response passes through as it arrived, unread: the body is
 *     read from a CLONE, so the caller's own `.json()` still works.
 *   - One question per app at a time. Two refusals landing together (a vote
 *     and its thread's post) share one prompt and one answer.
 *   - The retry is sent with the ORIGINAL fetch, so a second refusal is
 *     returned to the caller rather than asked about again — there is no
 *     loop, whatever the server says.
 *   - A Request object is cloned before it is first sent, because a body a
 *     request has already consumed cannot be sent twice.
 *
 * The WebSocket chat write cannot come through here; public/js/group-chat.js
 * handles its `join_required` frame and asks through `offerJoin`, published
 * below as window.UsernodeReact.offerJoin, so both paths share the one
 * prompt and the one in-flight question.
 */

export type JoinRequired = {
  code: 'join_required';
  error?: string;
  app?: { slug?: string; name?: string };
};

export function isJoinRequired(body: unknown): body is JoinRequired {
  return !!body && typeof body === 'object' && (body as { code?: unknown }).code === 'join_required';
}

const asking = new Map<string, Promise<boolean>>();

/**
 * Ask whether to join the app the refusal names, and join it on a yes.
 * Resolves true when the viewer is now a member. Concurrent calls for one app
 * share the question.
 */
export function offerJoin(body: JoinRequired): Promise<boolean> {
  const slug = body?.app?.slug;
  if (!slug) return Promise.resolve(false);
  const pending = asking.get(slug);
  if (pending) return pending;
  const question = (async () => {
    const w = window as any;
    const name = body.app?.name || slug;
    const ok = await w.ConfirmModal?.show?.({
      title: `Join ${name}?`,
      message: 'Members start changes, file requests, vote and chat here. Join to take part.',
      confirmLabel: 'Join',
      cancelLabel: 'Not now',
    });
    if (!ok) return false;
    if (typeof w.Home?.setMembership !== 'function') return false;
    // The name rides along for the toast: Home may not have loaded this app
    // (a channel opened cold from a link), and "Joined notes-9206f8" is the
    // slug, not the thing the person just joined.
    return !!(await w.Home.setMembership(slug, true, undefined, { name }));
  })().catch(() => false).finally(() => { asking.delete(slug); });
  asking.set(slug, question);
  return question;
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  const own = init?.method || (typeof Request !== 'undefined' && input instanceof Request ? input.method : '');
  return String(own || 'GET').toUpperCase();
}

/**
 * Wrap `window.fetch` once. Exported for the test, which hands in its own
 * window; the browser installs it from main.tsx.
 */
export function installJoinRequired(win: any = typeof window !== 'undefined' ? window : null): void {
  if (!win || typeof win.fetch !== 'function' || win.__joinRequiredInstalled) return;
  const send: typeof fetch = win.fetch.bind(win);
  win.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = methodOf(input, init);
    if (method === 'GET' || method === 'HEAD') return send(input, init);
    const again = typeof Request !== 'undefined' && input instanceof Request ? input.clone() : input;
    const res = await send(input, init);
    if (res.status !== 403) return res;
    let body: unknown = null;
    try {
      body = await res.clone().json();
    } catch {
      return res;
    }
    if (!isJoinRequired(body)) return res;
    if (await offerJoin(body)) return send(again, init);
    return res;
  };
  win.__joinRequiredInstalled = true;
  const bridge = (win.UsernodeReact ||= {});
  bridge.offerJoin = offerJoin;
}
