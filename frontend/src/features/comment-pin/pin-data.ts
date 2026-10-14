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
 * A request with several comments numbers them, and a picture with several
 * of their pins carries each in turn, with its number:
 *
 *   …/issue-images/<id>#pin=0.42,0.31&n=1&note=…&pin=0.11,0.22&n=2&note=…
 *
 * The server writes it (src/routes/feedback.js `pinsFragment`, the same rule
 * as `pinsFragment` here; tests/comment-pin.test.js holds the two together)
 * from the `screenshotPins` a post carries. A fragment never reaches a
 * server, so GitHub's image proxy, coding agents and everything else that
 * fetches the picture get the plain screenshot, and the comment's words and
 * the where line are in the request's text for them. It travels with the
 * request's body, so nothing else has to be stored or looked up.
 *
 * `pin` is the point as fractions of the picture's width and height, 0 to 1,
 * four places; `note` is the comment's words as they were posted, cut at
 * NOTE_MAX characters and then, encoded, at an equal share of NOTE_ENCODED_MAX
 * among the request's pins (the route keeps only FEEDBACK_BODY_RESERVE
 * characters of the issue body for its own lines,
 * src/services/issue-body-limit.js). `n` is the comment's number in the
 * request, present only when it has more than one. Brackets
 * and the characters encodeURIComponent leaves alone are escaped too, so the
 * link survives inside Markdown's parentheses.
 */

export const NOTE_MAX = 280;
export const NOTE_ENCODED_MAX = 600;

export interface PinData { x: number; y: number; note: string; n?: number | null }

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

/** The note as it goes on the link: noteFor's, shortened until its encoding fits `budget`. */
export function fitNote(text: string, budget = NOTE_ENCODED_MAX): string {
  let note = noteFor(text);
  while (note && encodeNote(note).length > budget) note = `${Array.from(note).slice(0, -2).join('').trimEnd()}…`;
  return note;
}

/** One budget each: the request's share of NOTE_ENCODED_MAX for every one of its `total` pins. */
export function noteBudget(total: number): number {
  return Math.floor(NOTE_ENCODED_MAX / Math.max(1, total));
}

/** The fragment for a picture's pins, `#` included; `budget` is each note's (noteBudget). */
export function pinsFragment(pins: PinData[], budget = noteBudget(pins.length)): string {
  if (!pins.length) return '';
  return `#${pins.map((pin) => {
    const note = fitNote(pin.note, budget);
    const n = Number.isInteger(pin.n) && (pin.n as number) > 0 ? `&n=${pin.n}` : '';
    return `pin=${round4(pin.x)},${round4(pin.y)}${n}${note ? `&note=${encodeNote(note)}` : ''}`;
  }).join('&')}`;
}

/** The fragment for one pin, `#` included. */
export function pinFragment(pin: PinData): string {
  return pinsFragment([pin]);
}

/**
 * The pins a screenshot's link carries, in order: each `pin=` starts one,
 * and the `n=` and `note=` after it are its own. Empty for no fragment,
 * another fragment, or numbers that are not a point on the picture.
 */
export function readPins(url: string | null | undefined): PinData[] {
  const s = String(url || '');
  const hash = s.indexOf('#');
  if (hash < 0) return [];
  const pins: PinData[] = [];
  let current: PinData | null = null;
  for (const part of s.slice(hash + 1).split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === 'pin') {
      current = null;
      const m = /^(\d(?:\.\d+)?),(\d(?:\.\d+)?)$/.exec(value);
      if (!m) continue;
      const x = Number(m[1]);
      const y = Number(m[2]);
      if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) continue;
      current = { x, y, note: '', n: null };
      pins.push(current);
    } else if (current && key === 'n' && /^\d{1,2}$/.test(value) && Number(value) > 0) {
      current.n = Number(value);
    } else if (current && key === 'note') {
      try {
        current.note = noteFor(decodeURIComponent(value));
      } catch {
        current.note = '';
      }
    }
  }
  return pins;
}

/** The first pin a screenshot's link carries, or null. */
export function readPin(url: string | null | undefined): PinData | null {
  const first = readPins(url)[0];
  return first ? { x: first.x, y: first.y, note: first.note } : null;
}
