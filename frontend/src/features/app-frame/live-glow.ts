/**
 * #4449: what is NEW in Live (./live-band.tsx), so only that glows. Every
 * restart of the app rebuilds the whole page, and a page that lit up on
 * every rebuild would say nothing; so an element glows only when nothing
 * like it was on the screen before.
 *
 * "Like it" is its SIGNATURE: the tag path from <body> and the element's own
 * direct text, trimmed to 60 characters. The last shown state is kept as a
 * count per signature. A rebuilt page (rrweb's 'fullsnapshot-rebuilded')
 * consumes one count per matching element, in document order, and the
 * top-most elements left unmatched glow; a MutationObserver on the rebuilt
 * document does the same for the elements each change adds, against the
 * counts less what is still on the screen (changeBudget), so a list drawn
 * again matches itself and one row more glows. The counts are taken again
 * after every change. The first page shown glows nothing.
 *
 * The glow is the attribute GLOW_ATTR for GLOW_MS, drawn by GLOW_RULES in the
 * replayed document: a fade-in and a fading 4px accent ring, or a static
 * outline with prefers-reduced-motion.
 */

export const GLOW_ATTR = 'data-usernode-new';
export const GLOW_MS = 1600;
const TEXT_MAX = 60;
// The shell's accent (violet-600, the blue: tailwind.config.js).
const ACCENT = '10, 110, 224';

export const GLOW_RULES: string[] = [
  `@keyframes usernode-live-glow { 0% { opacity: 0; box-shadow: 0 0 0 4px rgba(${ACCENT}, 0.9); } 30% { opacity: 1; box-shadow: 0 0 0 4px rgba(${ACCENT}, 0.8); } 100% { opacity: 1; box-shadow: 0 0 0 4px rgba(${ACCENT}, 0); } }`,
  `[${GLOW_ATTR}] { animation: usernode-live-glow ${GLOW_MS}ms ease-out both; }`,
  `@media (prefers-reduced-motion: reduce) { [${GLOW_ATTR}] { animation: none; outline: 4px solid rgba(${ACCENT}, 0.9); outline-offset: -2px; } }`,
];

/** An element's own text, not its children's: collapsed and cut to 60. */
export function directText(el: Element): string {
  let text = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) text += ` ${node.nodeValue || ''}`;
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
}

/** "div>ul>li|Water the fern": the tag path from <body>, and its own text. */
export function signature(el: Element): string {
  const tags: string[] = [];
  let at: Element | null = el;
  while (at && at.tagName && at.tagName.toLowerCase() !== 'body') {
    tags.unshift(at.tagName.toLowerCase());
    at = at.parentElement;
  }
  return `${tags.join('>')}|${directText(el)}`;
}

/** Elements under <body>, in document order, `root` included when it is one. */
export function elementsUnder(root: Element | null, self = false): Element[] {
  if (!root) return [];
  const out: Element[] = self ? [root] : [];
  out.push(...Array.from(root.querySelectorAll('*')));
  return out;
}

/** How many of each signature a document's body holds. */
export function countSignatures(doc: Document | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const el of elementsUnder(doc?.body || null)) {
    const sig = signature(el);
    counts.set(sig, (counts.get(sig) || 0) + 1);
  }
  return counts;
}

/**
 * The elements to glow: of `elements` (document order), the ones `remaining`
 * has no count left for, each consuming one, and of those only the
 * top-most (none of its ancestors is also new). Consumes `remaining`.
 */
export function newTops(elements: Element[], remaining: Map<string, number>): Element[] {
  const fresh = new Set<Element>();
  for (const el of elements) {
    const sig = signature(el);
    const left = remaining.get(sig) || 0;
    if (left > 0) remaining.set(sig, left - 1);
    else fresh.add(el);
  }
  const tops: Element[] = [];
  for (const el of fresh) {
    let parent = el.parentElement;
    let nested = false;
    while (parent) {
      if (fresh.has(parent)) { nested = true; break; }
      parent = parent.parentElement;
    }
    if (!nested) tops.push(el);
  }
  return tops;
}

/**
 * What a change's added elements may match: each signature's count before
 * the change, less the elements of it that are still there and were not
 * added. A list re-rendered whole matches itself; one row more glows. Pure.
 */
export function changeBudget(before: Map<string, number>, after: Map<string, number>, added: Element[]): Map<string, number> {
  const addedCounts = new Map<string, number>();
  for (const el of added) {
    const sig = signature(el);
    addedCounts.set(sig, (addedCounts.get(sig) || 0) + 1);
  }
  const budget = new Map<string, number>();
  for (const [sig, n] of before) {
    const stayed = (after.get(sig) || 0) - (addedCounts.get(sig) || 0);
    budget.set(sig, Math.max(0, n - Math.max(0, stayed)));
  }
  return budget;
}

/** Keeps the counts across rebuilds and changes, and lights what is new. */
export class GlowTracker {
  private counts: Map<string, number> | null = null;

  private observer: MutationObserver | null = null;

  private timers = new Set<number>();

  /** A page was rebuilt (a restart, or the first frame): compare, then watch it. */
  rebuilt(doc: Document | null): void {
    this.observer?.disconnect();
    this.observer = null;
    if (!doc || !doc.body) return;
    if (this.counts) this.glow(newTops(elementsUnder(doc.body), new Map(this.counts)));
    this.counts = countSignatures(doc);
    const View = doc.defaultView?.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    if (!View) return;
    this.observer = new View((records) => {
      const added: Element[] = [];
      const seen = new Set<Element>();
      for (const r of records) {
        for (const node of Array.from(r.addedNodes)) {
          if (node.nodeType !== 1 || !(node as Element).isConnected) continue;
          for (const el of elementsUnder(node as Element, true)) {
            if (!seen.has(el)) { seen.add(el); added.push(el); }
          }
        }
      }
      const after = countSignatures(doc);
      if (added.length && this.counts) this.glow(newTops(added, changeBudget(this.counts, after, added)));
      this.counts = after;
    });
    this.observer.observe(doc.documentElement, { childList: true, subtree: true });
  }

  private glow(elements: Element[]): void {
    for (const el of elements) {
      el.setAttribute(GLOW_ATTR, '');
      const t = window.setTimeout(() => {
        this.timers.delete(t);
        el.removeAttribute(GLOW_ATTR);
      }, GLOW_MS + 100);
      this.timers.add(t);
    }
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
    for (const t of this.timers) window.clearTimeout(t);
    this.timers.clear();
  }
}
