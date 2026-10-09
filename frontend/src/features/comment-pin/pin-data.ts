/**
 * A comment's pin, kept as data on its screenshot (#4482) rather than drawn
 * into it, so the request's page can show the page clean or with the
 * comment, and the person reading it chooses.
 *
 * ── Where it lives ────────────────────────────────────────────────────
 *
 * On the screenshot's own link in the request, as the URL's fragment:
 *
 *   ![Screenshot](https://<platform>/issue-images/<id>#pin=0.4213,0.3180&note=Make%20it%20bigger)
 *
 * The server writes it (src/routes/feedback.js `pinFragment`, the same rule
 * as `pinFragment` here; tests/comment-pin.test.js holds the two together)
 * from the `screenshotPins` a post carries. A fragment never reaches a
 * server, so GitHub's image proxy, coding agents and everything else that
 * fetches the picture get the plain screenshot, and the comment's words and
 * the where line are in the request's text for them. It travels with the
 * request's body, so nothing else has to be stored or looked up.
 *
 * `pin` is the point as fractions of the picture's width and height, 0 to 1,
 * four places; `note` is the comment's words as they were posted, cut at
 * NOTE_MAX characters and then, encoded, at NOTE_ENCODED_MAX (the route keeps
 * only FEEDBACK_BODY_RESERVE characters of the issue body for its own lines,
 * src/services/issue-body-limit.js, and a request carries one pin). Brackets
 * and the characters encodeURIComponent leaves alone are escaped too, so the
 * link survives inside Markdown's parentheses.
 */

export const NOTE_MAX = 280;
export const NOTE_ENCODED_MAX = 800;

export interface PinData { x: number; y: number; note: string }

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round4 = (n: number) => Math.round(clamp01(n) * 10000) / 10000;

/** encodeURIComponent, plus the five characters it leaves that Markdown or a fragment reader could trip on. */
export function encodeNote(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The words as a note: one line's worth of spaces, at most NOTE_MAX characters. */
export function noteFor(text: string): string {
  // By code point, so a cut never splits a pair (encodeURIComponent throws on half of one).
  const chars = Array.from(String(text || '').replace(/\s+/g, ' ').trim());
  return chars.length > NOTE_MAX ? `${chars.slice(0, NOTE_MAX - 1).join('').trimEnd()}…` : chars.join('');
}

/** The note as it goes on the link: noteFor's, shortened until its encoding fits. */
export function fitNote(text: string): string {
  let note = noteFor(text);
  while (note && encodeNote(note).length > NOTE_ENCODED_MAX) note = `${Array.from(note).slice(0, -2).join('').trimEnd()}…`;
  return note;
}

/** The fragment for a pin, `#` included. */
export function pinFragment(pin: PinData): string {
  const note = fitNote(pin.note);
  return `#pin=${round4(pin.x)},${round4(pin.y)}${note ? `&note=${encodeNote(note)}` : ''}`;
}

/**
 * The pin a screenshot's link carries, or null: no fragment, another
 * fragment, or numbers that are not a point on the picture.
 */
export function readPin(url: string | null | undefined): PinData | null {
  const s = String(url || '');
  const hash = s.indexOf('#');
  if (hash < 0) return null;
  const parts = new Map<string, string>();
  for (const part of s.slice(hash + 1).split('&')) {
    const eq = part.indexOf('=');
    if (eq > 0) parts.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const m = /^(\d(?:\.\d+)?),(\d(?:\.\d+)?)$/.exec(parts.get('pin') || '');
  if (!m) return null;
  const x = Number(m[1]);
  const y = Number(m[2]);
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
  let note = '';
  try {
    note = decodeURIComponent(parts.get('note') || '');
  } catch {
    note = '';
  }
  return { x, y, note: noteFor(note) };
}
