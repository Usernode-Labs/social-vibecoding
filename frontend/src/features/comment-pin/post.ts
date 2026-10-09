/**
 * Filing a C comment: the same two requests "Suggest an improvement" makes
 * (../dialogs/feedback-controller.js submitFeedback), without its dialog.
 *
 *   POST /api/feedback/screenshot   raw PNG/JPEG body, plus the pin's
 *                                   spot and words as ?pinX&pinY&pinComment
 *                                   when a pin is stored with it (#4482) → { id }
 *   POST /api/feedback              { description, target, appSlug?, screenshotIds? }
 *
 * The title is left to the server, which writes one from the words, as it
 * does for a dialog post whose title was never touched. A project the
 * person has not joined answers 403 `join_required`, which the shell's fetch
 * wrapper (lib/join-required.ts) turns into a Join prompt and a retry, so
 * nothing here handles it.
 *
 * ── Nothing is lost ───────────────────────────────────────────────────
 *
 * Offline, a network failure or a server error HANDS THE COMMENT OVER to
 * the dialog, words, picture and destination, where the outbox (#1054)
 * keeps it and sends it when it can. Only a refusal the person can act on
 * (a 4xx with a reason) is said in the box itself, with their words still
 * in it.
 */

import { PIN_COMMENT_MAX, type ElementInfo } from './picture';

export type Target = 'app' | 'platform';

export interface CommentPost {
  text: string;
  target: Target;
  appSlug: string | null;
  picture: Blob | null;
  /** Where it was pinned, said in words under the comment. */
  where: string;
  /** The pin saved with the picture, as fractions of it (#4482); null when there is no picture. */
  pin: { x: number; y: number; comment: string } | null;
}

export type PostOutcome =
  | { ok: true; botWillBuild: boolean }
  | { ok: false; handover: true }
  | { ok: false; handover: false; error: string };

/** "on button "Save" (#settings-save)", or '' when nothing useful is known. */
export function describeTarget(info: ElementInfo | null): string {
  if (!info || !info.tag) return '';
  const words = info.text ? ` "${info.text}"` : '';
  const id = info.id ? ` (#${info.id})` : '';
  return `on ${info.tag}${words}${id}`;
}

/**
 * The line under the comment that says where it was pinned, for whoever
 * picks the request up: the screen (the shell's route, or the app's path)
 * and the element under the pin.
 */
export function whereLine(opts: { inApp: boolean; screen: string; at: ElementInfo | null }): string {
  const place = opts.inApp
    ? `in the app at ${opts.screen || '/'}`
    : `on Homeroom at ${opts.screen || '#home'}`;
  const on = describeTarget(opts.at);
  return `Pinned with C ${place}${on ? `, ${on}` : ''}.`;
}

/** The request's description: the words, then the where line. */
export function descriptionFor(text: string, where: string): string {
  const words = String(text || '').trim();
  return where ? `${words}\n\n${where}` : words;
}

function telemetryHeaders(): Record<string, string> {
  try {
    const h = (window as unknown as { UITelemetry?: { contextHeaders?: unknown } }).UITelemetry?.contextHeaders;
    return h && typeof h === 'object' ? (h as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function postComment(post: CommentPost): Promise<PostOutcome> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: false, handover: true };

  let screenshotId: string | null = null;
  if (post.picture) {
    // The pin rides in the URL, not the body: the body is the raw bytes.
    const params = post.pin
      ? `?${new URLSearchParams({
        pinX: String(post.pin.x),
        pinY: String(post.pin.y),
        pinComment: post.pin.comment.slice(0, PIN_COMMENT_MAX),
      })}`
      : '';
    const upload = `/api/feedback/screenshot${params}`;
    let res: Response;
    try {
      res = await window.fetch(upload, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: post.picture,
      });
    } catch {
      return { ok: false, handover: true };
    }
    if (res.status >= 500) return { ok: false, handover: true };
    const data = await readJson(res);
    // A picture the server will not take (its type, its size, a rate limit)
    // is not a reason to lose the words: they go without it.
    if (res.ok && typeof data.id === 'string') screenshotId = data.id;
  }

  const body: Record<string, unknown> = {
    description: descriptionFor(post.text, post.where),
    target: post.target,
  };
  if (post.target === 'app' && post.appSlug) body.appSlug = post.appSlug;
  if (screenshotId) body.screenshotIds = [screenshotId];

  let res: Response;
  try {
    res = await window.fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...telemetryHeaders() },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, handover: true };
  }
  const data = await readJson(res);
  if (res.ok) {
    const bot = data.homeroomBot as { botWillBuild?: boolean } | undefined;
    return { ok: true, botWillBuild: !!bot?.botWillBuild };
  }
  if (res.status >= 500) return { ok: false, handover: true };
  const reason = typeof data.error === 'string' && data.error ? data.error : "That couldn't be posted.";
  return { ok: false, handover: false, error: reason };
}

/**
 * Give the comment to "Suggest an improvement": its words (with the where
 * line), its picture and its destination, already chosen.
 */
export function handOver(post: CommentPost): void {
  const app = (window as unknown as { App?: { openFeedbackModal?: (opts: unknown) => void } }).App;
  app?.openFeedbackModal?.({
    target: post.target,
    description: descriptionFor(post.text, post.where),
    screenshotBlob: post.picture || undefined,
  });
}
