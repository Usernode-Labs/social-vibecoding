/**
 * Filing a C comment: the same requests "Suggest an improvement" makes
 * (../dialogs/feedback-controller.js submitFeedback), without its dialog.
 *
 *   POST /api/feedback/screenshot   raw PNG/JPEG body → { id }, once per picture
 *   POST /api/feedback              { description, target, appSlug?, title?,
 *                                     bounty?, screenshotIds?, screenshotPins? }
 *
 * The page's picture goes first and is CLEAN: the pin is not drawn into it
 * but sent beside it, as `screenshotPins` (#4482), and the server writes it
 * onto that picture's link in the request (./pin-data.ts). The person's own
 * images follow it, up to the server's three.
 *
 * The title is the one the box showed (its suggestion, or the person's own),
 * sent only when it was named from these very words, as the dialog does
 * (#732); otherwise the server writes one from the words. `bounty` is the
 * box's Kudos (#964), which the server places after the request is filed and
 * answers for in `bounty`. A project the person has not joined answers 403
 * `join_required`, which the shell's fetch wrapper (lib/join-required.ts)
 * turns into a Join prompt and a retry, so nothing here handles it.
 *
 * ── Nothing is lost ───────────────────────────────────────────────────
 *
 * Offline, a network failure or a server error HANDS THE COMMENT OVER to
 * the dialog, words, title, pictures (the pin still beside the page's),
 * Kudos and destination, where the outbox (#1054) keeps it and sends it when
 * it can. Only a refusal the person can act on (a 4xx with a reason) is said
 * in the box itself, with their words still in it.
 */

import type { ElementInfo } from './picture';
import { noteFor } from './pin-data';

export type Target = 'app' | 'platform';

export interface CommentPost {
  text: string;
  target: Target;
  appSlug: string | null;
  /** The page as it was when the pin went down, clean. */
  picture: Blob | null;
  /** Where the pin is on `picture`, as fractions of its width and height. */
  pin?: { x: number; y: number } | null;
  /** The person's own images, after the picture. */
  images?: Blob[];
  /** The box's title; '' leaves it to the server. */
  title?: string;
  /** Put a kudos on it (#964). */
  bounty?: boolean;
  /** Where it was pinned, said in words under the comment. */
  where: string;
}

export interface BountyOutcome { placed: boolean; remaining?: number; error?: string }

export type PostOutcome =
  | { ok: true; botWillBuild: boolean; url: string; title: string; bounty: BountyOutcome | null }
  | { ok: false; handover: true }
  | { ok: false; handover: false; error: string };

/** The server's own limit on images per request (MAX_SCREENSHOTS_PER_ISSUE). */
export const MAX_PICTURES = 3;

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

/** The request's number, read off its GitHub link; null when there is none. */
export function numberFromUrl(url: string): number | null {
  const m = /\/issues\/(\d+)(?:[?#].*)?$/.exec(String(url || ''));
  return m ? Number(m[1]) : null;
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

/**
 * Upload one picture. Its id; null when the server will not take it (its
 * type, its size, a rate limit), which is not a reason to lose the words;
 * 'handover' when the server or the network failed.
 */
async function upload(blob: Blob): Promise<string | null | 'handover'> {
  let res: Response;
  try {
    res = await window.fetch('/api/feedback/screenshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    });
  } catch {
    return 'handover';
  }
  if (res.status >= 500) return 'handover';
  const data = await readJson(res);
  return res.ok && typeof data.id === 'string' ? data.id : null;
}

export async function postComment(post: CommentPost): Promise<PostOutcome> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: false, handover: true };

  const ids: string[] = [];
  let pictureId: string | null = null;
  const pictures = [post.picture, ...(post.images || [])].filter((b): b is Blob => !!b).slice(0, MAX_PICTURES);
  for (const blob of pictures) {
    const id = await upload(blob);
    if (id === 'handover') return { ok: false, handover: true };
    if (!id) continue;
    ids.push(id);
    if (blob === post.picture) pictureId = id;
  }

  const body: Record<string, unknown> = {
    description: descriptionFor(post.text, post.where),
    target: post.target,
  };
  if (post.target === 'app' && post.appSlug) body.appSlug = post.appSlug;
  const title = String(post.title || '').trim();
  if (title) body.title = title.slice(0, 200);
  if (post.bounty) body.bounty = true;
  if (ids.length) body.screenshotIds = ids;
  if (pictureId && post.pin) {
    body.screenshotPins = [{ id: pictureId, x: post.pin.x, y: post.pin.y, note: noteFor(post.text) }];
  }

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
    const b = data.bounty as BountyOutcome | undefined;
    return {
      ok: true,
      botWillBuild: !!bot?.botWillBuild,
      url: typeof data.url === 'string' ? data.url : '',
      title: typeof data.title === 'string' ? data.title : title,
      bounty: b && typeof b === 'object' ? { placed: !!b.placed, remaining: b.remaining, error: b.error } : null,
    };
  }
  if (res.status >= 500) return { ok: false, handover: true };
  const reason = typeof data.error === 'string' && data.error ? data.error : "That couldn't be posted.";
  return { ok: false, handover: false, error: reason };
}

/** What the dialog's open takes for a picture: its bytes, and the pin beside it. */
export interface HandedPicture { blob: Blob; pin?: { x: number; y: number; note: string } }

/** The comment as the dialog takes it (feedback-controller.js `_open`). */
export function handOverOptions(post: CommentPost): Record<string, unknown> {
  const screenshots: HandedPicture[] = [];
  if (post.picture) {
    screenshots.push(post.pin
      ? { blob: post.picture, pin: { x: post.pin.x, y: post.pin.y, note: noteFor(post.text) } }
      : { blob: post.picture });
  }
  for (const blob of post.images || []) screenshots.push({ blob });
  const opts: Record<string, unknown> = {
    target: post.target,
    description: descriptionFor(post.text, post.where),
  };
  if (screenshots.length) opts.screenshots = screenshots.slice(0, MAX_PICTURES);
  const title = String(post.title || '').trim();
  if (title) opts.title = title;
  if (post.bounty) opts.bounty = true;
  return opts;
}

/**
 * Give the comment to "Suggest an improvement": its words (with the where
 * line), its title, its pictures, its Kudos and its destination, already
 * chosen.
 */
export function handOver(post: CommentPost): void {
  const app = (window as unknown as { App?: { openFeedbackModal?: (opts: unknown) => void } }).App;
  app?.openFeedbackModal?.(handOverOptions(post));
}
