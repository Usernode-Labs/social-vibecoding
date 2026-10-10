/**
 * Filing a C comment: the same requests "Suggest an improvement" makes
 * (../dialogs/feedback-controller.js submitFeedback), without its dialog.
 *
 *   POST /api/feedback/screenshot   raw PNG/JPEG body → { id }, once per picture
 *   POST /api/feedback              { description, target, appSlug?, title?,
 *                                     bounty?, screenshotIds?, screenshotPins? }
 *
 * The page's pictures go first and are CLEAN: the pins are not drawn into
 * them but sent beside them, as `screenshotPins` (#4482), and the server
 * writes them onto each picture's link in the request (./pin-data.ts). A
 * request of several comments has a picture for each view they were pinned
 * on, each with its comments' pins, numbered. The person's own images follow,
 * up to the server's three in all.
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
 * the dialog, words, title, pictures (the pins still beside the pages),
 * Kudos and destination, where the outbox (#1054) keeps it and sends it when
 * it can. Only a refusal the person can act on (a 4xx with a reason) is said
 * in the box itself, with their words still in it.
 */

import { t } from '../../lib/i18n/runtime';
import type { ElementInfo } from './picture';
import { noteFor } from './pin-data';

export type Target = 'app' | 'platform';

/** A comment's pin on a picture: fractions of its width and height, its number when there are several, its words. */
export interface ShotPin { x: number; y: number; n?: number | null; note: string }

/** The page as it was when pins went down, clean, with the pins beside it. */
export interface CommentShot { blob: Blob; pins: ShotPin[] }

export interface CommentPost {
  /** The request's words: the comment's, or the comments' numbered. */
  text: string;
  target: Target;
  appSlug: string | null;
  /** The pages, each with its pins. */
  shots?: CommentShot[];
  /** The person's own images, after the pages. */
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

/** The server's own limit on pins per request (MAX_PINS_PER_ISSUE): the most comments one request takes. */
export const MAX_COMMENTS = 8;

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

/** Where one comment was pinned, for `whereLines`. */
export interface Spot { inApp: boolean; screen: string; at: ElementInfo | null }

/**
 * The where line for several comments, numbered as their words are: one
 * place said once when they share it, else each comment's own.
 */
export function whereLines(spots: Spot[]): string {
  if (spots.length === 1) return whereLine(spots[0]);
  const place = (s: Spot) => (s.inApp ? `in the app at ${s.screen || '/'}` : `on Homeroom at ${s.screen || '#home'}`);
  const places = new Set(spots.map(place));
  if (places.size === 1) {
    return `Pinned with C ${place(spots[0])}: ${spots.map((s, i) => `${i + 1} ${describeTarget(s.at) || 'on the page'}`).join('; ')}.`;
  }
  return `Pinned with C: ${spots.map((s, i) => {
    const on = describeTarget(s.at);
    return `${i + 1} ${place(s)}${on ? `, ${on}` : ''}`;
  }).join('; ')}.`;
}

/** Several comments' words, numbered, a paragraph each; one comment's, as they are. */
export function numberedWords(texts: string[]): string {
  const words = texts.map((t) => String(t || '').trim()).filter(Boolean);
  return words.length === 1 ? words[0] : words.map((w, i) => `${i + 1}. ${w}`).join('\n\n');
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
  const pins: Array<ShotPin & { id: string }> = [];
  const pictures: Array<{ blob: Blob; pins: ShotPin[] }> = [
    ...(post.shots || []),
    ...(post.images || []).map((blob) => ({ blob, pins: [] })),
  ].filter((p) => !!p.blob).slice(0, MAX_PICTURES);
  for (const picture of pictures) {
    const id = await upload(picture.blob);
    if (id === 'handover') return { ok: false, handover: true };
    if (!id) continue;
    ids.push(id);
    for (const pin of picture.pins) pins.push({ ...pin, id });
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
  if (pins.length) {
    body.screenshotPins = pins.slice(0, MAX_COMMENTS).map((p) => {
      const out: Record<string, unknown> = { id: p.id, x: p.x, y: p.y, note: noteFor(p.note) };
      if (p.n) out.n = p.n;
      return out;
    });
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
  const reason = typeof data.error === 'string' && data.error ? data.error : t('devchat:commentPin.postFailed');
  return { ok: false, handover: false, error: reason };
}

/** What the dialog's open takes for a picture: its bytes, and the pins beside it. */
export interface HandedPicture { blob: Blob; pins?: ShotPin[] }

/** The comment as the dialog takes it (feedback-controller.js `_open`). */
export function handOverOptions(post: CommentPost): Record<string, unknown> {
  const screenshots: HandedPicture[] = [];
  for (const shot of post.shots || []) {
    screenshots.push(shot.pins.length
      ? { blob: shot.blob, pins: shot.pins.map((p) => ({ x: p.x, y: p.y, n: p.n ?? null, note: noteFor(p.note) })) }
      : { blob: shot.blob });
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
