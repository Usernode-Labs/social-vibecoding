/**
 * 1 Nov 2026 (threads, one loop: phase B): a private thread about a request
 * or a change, in the viewer's own chat with Homeroom bot
 * (POST /api/apps/:slug/threads/:number/private, src/routes/threads.js).
 * "Work on this with Homeroom bot" under a change
 * (../features/dev-board/topic/work-with-bot.tsx) and "Work on it with
 * Homeroom bot" after filing a request (../features/dialogs/
 * feedback-controller.js) start one and open the bot tab at it; the request
 * page's own button is AppView.workOnIssueWithBot. Opened on their own
 * request, the bot waits for their plan before it builds it. A second tap
 * opens the same thread.
 */

export type ThreadAboutKind = 'request' | 'change';

export interface ThreadAbout {
  rootId: number;
  /** Where it opens: `#homeroom-bot/thread/<rootId>`. */
  href: string;
  /** The bot waits for their plan (their own request). */
  holds: boolean;
}

const HREF = /^#homeroom-bot\/thread\/[1-9][0-9]*$/;

/** Start the thread (or find the open one). Throws with the server's words when it cannot. */
export async function startThreadAbout(slug: string, number: number, kind: ThreadAboutKind): Promise<ThreadAbout> {
  const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/threads/${Number(number)}/private`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind }),
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  const href = typeof data.href === 'string' ? data.href : '';
  const rootId = Number(data.rootId);
  if (!res.ok || !HREF.test(href) || !Number.isSafeInteger(rootId) || rootId <= 0) {
    throw new Error(typeof data.error === 'string' && data.error ? data.error : `HTTP ${res.status}`);
  }
  return { rootId, href, holds: data.holds === true };
}

/**
 * Start it and open the bot tab at it. Resolves false (and says `failed`)
 * when it could not. `after` runs once the address is written: a dialog
 * closes there, because closing spends its back-button record with a
 * history.back() that would undo an address written after it
 * (../features/dialogs/feedback-controller.js, #3683).
 */
export async function openThreadAbout(
  slug: string,
  number: number,
  kind: ThreadAboutKind,
  { failed, after }: { failed: string; after?: () => void },
): Promise<boolean> {
  try {
    const thread = await startThreadAbout(slug, number, kind);
    window.location.hash = thread.href;
    after?.();
    return true;
  } catch {
    (window as any).PlatformUI?.toast?.(failed);
    return false;
  }
}
