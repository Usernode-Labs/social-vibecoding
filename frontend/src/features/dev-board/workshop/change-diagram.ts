/**
 * What the Needs-you card draws when its change has no before & after shots:
 * the pure half. `diagramFor(row)` picks the diagram from what the row
 * already carries, and `renamePairs(texts)` finds the renames to show; the
 * drawing half is `ChangeDiagram` in workshop.tsx.
 *
 * No React and no DOM, so a test can load this module with `loadTsx` and
 * run the picking against the same texts the component renders.
 */

/** A renamed pair: the word that went, and the word that replaced it. */
export interface RenamePair {
  from: string;
  to: string;
}

/** What `diagramFor` picked, from the three kinds the card can draw. */
export type ChangeDiagram =
  | { kind: 'renames'; pairs: RenamePair[] }
  | { kind: 'changes'; tiles: { n: number; text: string }[] }
  | { kind: 'unseen' };

/**
 * The row shape diagramFor reads. `changes` is the proposal's declared
 * changes, numbered the way the shots number them (`row.changes` on a queue
 * row, the feeds' `changes` field); `impact` is the declared visibility.
 */
export interface DiagramRow {
  card: { title: { text?: string; title?: string } };
  summary?: string | null;
  changes?: { n: number; text: string }[];
  impact?: 'ui' | 'motion' | 'none' | null;
}

/** How many pairs, and how many tiles, one panel shows. */
const MAX_PAIRS = 3;
const MAX_TILES = 3;

/**
 * A quoted term: an opening quote at a word boundary, then one to forty
 * characters with no quote or newline in them, then a closing quote no
 * letter follows. The word-boundary opening keeps an apostrophe such as
 * `user's` from matching as a quote.
 */
const TERM = '["“‘`]([^"\'”’`\\n]{1,40})["”’`](?![A-Za-z])';

/** Forward: `spec` to/into/becomes/with `plan`, or an arrow between them. */
const FORWARD_RE = new RegExp(
  `(^|\\s|\\()${TERM}\\s*(?:to|into|becomes|with|\\u2192|->|=>)\\s*${TERM}`, 'gi'
);
/** Reverse: `plan` instead of `spec`: the new word comes first. */
const INSTEAD_RE = new RegExp(`(^|\\s|\\()${TERM}\\s*instead of\\s*${TERM}`, 'gi');
/**
 * Bare arrow: spec -> plan, spec → plan. Arrows only, never "to": an
 * unquoted "Rename Workshop to Studio" is too easy to misread.
 */
const BARE_ARROW_RE = /\b([\w-]{1,30})\s*(?:→|->)\s*([\w-]{1,30})\b/g;

/**
 * The rename pairs a set of texts names, in the order they are found.
 * Duplicates (case-insensitive on both sides) are dropped across all texts,
 * as is a pair whose sides are the same word, and at most three come back.
 */
export function renamePairs(texts: string[]): RenamePair[] {
  const pairs: RenamePair[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string) => {
    from = from.trim();
    to = to.trim();
    if (!from || !to) return;
    if (from.toLowerCase() === to.toLowerCase()) return;
    const key = `${from.toLowerCase()}\n${to.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ from, to });
  };
  for (const text of texts) {
    const source = String(text || '');
    if (!source) continue;
    for (const m of source.matchAll(FORWARD_RE)) add(m[2], m[3]);
    for (const m of source.matchAll(INSTEAD_RE)) add(m[3], m[2]);
    for (const m of source.matchAll(BARE_ARROW_RE)) add(m[1], m[2]);
    if (pairs.length >= MAX_PAIRS) break;
  }
  return pairs.slice(0, MAX_PAIRS);
}

/**
 * The diagram for a Needs-you row, or null when nothing true can be drawn
 * and the card keeps its empty space. Renames win, then the declared
 * changes, then the change that says nothing on screen changes.
 */
export function diagramFor(row: DiagramRow): ChangeDiagram | null {
  if (!row) return null;
  const texts = [
    row.card?.title?.text || row.card?.title?.title || '',
    row.summary || '',
    ...(Array.isArray(row.changes) ? row.changes.map((c) => c?.text || '') : []),
  ];
  const pairs = renamePairs(texts);
  if (pairs.length) return { kind: 'renames', pairs };
  const tiles = (Array.isArray(row.changes) ? row.changes : []).filter((c) => c && c.text).slice(0, MAX_TILES);
  if (tiles.length) return { kind: 'changes', tiles };
  if (row.impact === 'none') return { kind: 'unseen' };
  return null;
}
