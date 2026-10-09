/**
 * A C comment's pin, drawn over its screenshot in the request view (#4482).
 *
 * The screenshot filed with a C comment is the page as it looked, with the
 * pin's spot and the comment's words saved beside it as data (see
 * ../../comment-pin/picture.ts). The request's body HTML embeds those
 * images as plain `<img>` markdown; these helpers find them, read their
 * pins, and wrap each pinned image in an overlay that draws the dot and
 * the bubble where they were, so the clean picture stays underneath and a
 * button can take the overlay away. Pure, and exported for tests.
 *
 * The markup arrives from `DevChat.renderMarkdown`, already sanitised; the
 * comment's words are escaped again here because they are data, not markup.
 */

export interface Pin {
  x: number;
  y: number;
  comment: string;
}

/** How many images one request may carry, exactly as the server caps it (src/routes/feedback.js). */
const MAX_IMAGES = 3;
const IMAGE_ID_RE = /<img[^>]*\ssrc="[^"]*\/issue-images\/([a-f0-9]{32})[^"]*"/g;

/** The issue-image ids a request's body embeds, in order, deduped, at most 3. */
export function issueImageIds(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of String(html || '').matchAll(IMAGE_ID_RE)) {
    if (out.length >= MAX_IMAGES) break;
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push(m[1]);
  }
  return out;
}

/** Escape the comment's words for the bubble, which is built as markup. */
function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Wrap each embedded image that has a pin in the overlay that draws it.
 * Images without a pin are left untouched, and html with no pins comes
 * back byte-identical. The bubble flips left when it would run past the
 * right edge (x > 0.55) and up when it would run past the bottom
 * (y > 0.6) — the same roughly-half rules the on-screen box applies.
 */
export function withPins(html: string, pins: Record<string, Pin>): string {
  let out = String(html || '');
  for (const [id, pin] of Object.entries(pins || {})) {
    if (!pin || typeof pin.x !== 'number' || typeof pin.y !== 'number') continue;
    const re = new RegExp(`<img[^>]*\\ssrc="[^"]*\\/issue-images\\/${id}[^"]*"[^>]*>`);
    const img = out.match(re);
    if (!img) continue;
    const x = pin.x * 100;
    const y = pin.y * 100;
    const dot = `<span class="dev-request-pin-dot" style="left:${x}%;top:${y}%"></span>`;
    const bubble = `<span class="dev-request-pin-bubble${pin.x > 0.55 ? ' is-left' : ''}${pin.y > 0.6 ? ' is-up' : ''}" style="left:${x}%;top:${y}%">${escapeText(String(pin.comment || ''))}</span>`;
    out = out.replace(re, `<span class="dev-request-pin-shot">${img[0]}<span class="dev-request-pin-overlay" aria-hidden="true">${dot}${bubble}</span></span>`);
  }
  return out;
}

/** Read the pin saved with each image id; a failed or empty read is just no pin. */
export async function fetchPins(ids: string[]): Promise<Record<string, Pin>> {
  const out: Record<string, Pin> = {};
  await Promise.all(ids.map(async (id) => {
    try {
      const res = await window.fetch(`/issue-images/${id}/pin`);
      if (!res.ok) return;
      const data = (await res.json()) as { pin?: Pin | null };
      if (data?.pin && typeof data.pin.x === 'number' && typeof data.pin.y === 'number') {
        out[id] = data.pin;
      }
    } catch { /* the request renders exactly as today */ }
  }));
  return out;
}
