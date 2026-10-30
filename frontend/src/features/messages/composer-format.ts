/**
 * The formatting the channel composer's row applies (#6035).
 *
 * A message is stored as the text people type and drawn by the shared
 * markdown renderer, so a formatting button edits the message source: it
 * wraps the selection in the markers marked already understands (`**`, `_`,
 * `++`) or prefixes a line (`# `, `> `, `- `). Pure, so the same rules can be
 * read without a DOM: `composer.tsx` passes the textarea's value and
 * selection, and puts the returned selection back.
 */

export type FormatKind = 'bold' | 'italic' | 'underline' | 'heading' | 'quote' | 'bullet';

export interface FormatSelection {
  value: string;
  start: number;
  end: number;
}

/** The composer's own limit, so a press cannot grow a message past it. */
const LIMIT = 8000;

const MARKERS: Record<'bold' | 'italic' | 'underline', string> = {
  bold: '**',
  italic: '_',
  underline: '++',
};

/** A line's leading quote/list markers, which a heading sits after. */
const BLOCK_PREFIX = /^(?:>[ \t]?|[-*+][ \t]+)*/;
const HEADING_PREFIX = /^#{1,3}[ \t]+/;

function finish(value: string, start: number, end: number): FormatSelection {
  const next = value.slice(0, LIMIT);
  return { value: next, start: Math.min(start, next.length), end: Math.min(end, next.length) };
}

/** The current heading level of a line, reading only the `#` run at its start. */
function headingLevel(line: string): number {
  const block = BLOCK_PREFIX.exec(line)?.[0] || '';
  const prefix = HEADING_PREFIX.exec(line.slice(block.length))?.[0] || '';
  return prefix ? prefix.trimEnd().length : 0;
}

function inline(value: string, start: number, end: number, marker: string): FormatSelection {
  if (start === end) {
    const next = value.slice(0, start) + marker + marker + value.slice(end);
    return finish(next, start + marker.length, start + marker.length);
  }
  const selected = value.slice(start, end);
  const lead = (selected.match(/^\s*/) || [''])[0].length;
  const trail = (selected.match(/\s*$/) || [''])[0].length;
  if (lead + trail >= selected.length) {
    // Nothing but whitespace is selected: insert the pair at the caret.
    return inline(value, start, start, marker);
  }
  const coreStart = start + lead;
  const coreEnd = end - trail;
  const core = value.slice(coreStart, coreEnd);
  // Already wrapped from the inside (`**word**`), or from the outside
  // (`**` before the selection and after it): pressing again unwraps.
  if (core.length >= marker.length * 2 && core.startsWith(marker) && core.endsWith(marker)) {
    const inner = core.slice(marker.length, core.length - marker.length);
    return finish(value.slice(0, coreStart) + inner + value.slice(coreEnd), coreStart, coreStart + inner.length);
  }
  if (coreStart >= marker.length
    && value.slice(coreStart - marker.length, coreStart) === marker
    && value.slice(coreEnd, coreEnd + marker.length) === marker) {
    const next = value.slice(0, coreStart - marker.length) + core + value.slice(coreEnd + marker.length);
    return finish(next, coreStart - marker.length, coreStart - marker.length + core.length);
  }
  const next = value.slice(0, coreStart) + marker + core + marker + value.slice(coreEnd);
  return finish(next, coreStart + marker.length, coreEnd + marker.length);
}

/** The block of whole lines the selection touches. */
function lineBlock(value: string, start: number, end: number): { lineStart: number; blockEnd: number; lines: string[] } {
  const lineStart = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
  const at = end > start ? end - 1 : end;
  const newline = value.indexOf('\n', at);
  const blockEnd = newline === -1 ? value.length : newline;
  return { lineStart, blockEnd, lines: value.slice(lineStart, blockEnd).split('\n') };
}

/** Map a position in the old text onto the same character in the new one. */
function shifted(position: number, lineStart: number, oldLines: string[], newLines: string[]): number {
  let delta = 0;
  let at = lineStart;
  for (let i = 0; i < oldLines.length; i += 1) {
    if (at > position) break;
    delta += newLines[i].length - oldLines[i].length;
    at += oldLines[i].length + 1;
  }
  return position + delta;
}

function lines(value: string, start: number, end: number, transform: (line: string, lines: string[]) => string): FormatSelection {
  const { lineStart, blockEnd, lines: oldLines } = lineBlock(value, start, end);
  const newLines = oldLines.map((line) => transform(line, oldLines));
  const next = value.slice(0, lineStart) + newLines.join('\n') + value.slice(blockEnd);
  return finish(next, shifted(start, lineStart, oldLines, newLines), shifted(end, lineStart, oldLines, newLines));
}

function heading(value: string, start: number, end: number): FormatSelection {
  const { lines: block } = lineBlock(value, start, end);
  const first = block.find((line) => line.trim() !== '') || '';
  const level = headingLevel(first);
  // No prefix, then large (#), medium (##), small (###), then plain again.
  const target = level >= 3 ? 0 : level + 1;
  // A blank line is still a line: the prefix goes in, so the heading shows
  // before a word is typed (Drea, #6035). Only a selection that has words in
  // it leaves its blank lines alone, as a list and a quote do.
  const onlyBlank = !first;
  return lines(value, start, end, (line) => {
    if (!line.trim() && !onlyBlank) return line;
    const blockPrefix = BLOCK_PREFIX.exec(line)?.[0] || '';
    const rest = line.slice(blockPrefix.length);
    const body = rest.replace(HEADING_PREFIX, '');
    return blockPrefix + (target ? `${'#'.repeat(target)} ` : '') + body;
  });
}

function prefixLines(value: string, start: number, end: number, prefix: string): FormatSelection {
  const { lines: block } = lineBlock(value, start, end);
  const nonEmpty = block.filter((line) => line.trim() !== '');
  const remove = nonEmpty.length > 0 && nonEmpty.every((line) => line.startsWith(prefix));
  // Clicking Quote or Bulleted list on an empty line puts the marker there,
  // ready to type after (Drea, #6035), the way the inline buttons put their
  // pair at the caret. A selection with words in it keeps blank lines blank.
  const onlyBlank = nonEmpty.length === 0;
  return lines(value, start, end, (line) => {
    if (!line.trim() && !onlyBlank) return line;
    if (remove) return line.startsWith(prefix) ? line.slice(prefix.length) : line;
    return line.startsWith(prefix) ? line : prefix + line;
  });
}

/**
 * The text after `kind` was applied to `value`'s selection, and the selection
 * to put back: the same words, with the markers around or before them.
 */
export function applyFormat(value: string, start: number, end: number, kind: FormatKind): FormatSelection {
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  if (kind === 'heading') return heading(value, from, to);
  if (kind === 'quote') return prefixLines(value, from, to, '> ');
  if (kind === 'bullet') return prefixLines(value, from, to, '- ');
  return inline(value, from, to, MARKERS[kind]);
}

// What a formatted draft carries: the inline markers the row writes, the
// markers marked also reads (`~~`, a code span), and the line prefixes that
// start a heading, a quote or a bullet. A draft with none of these is drawn
// the same either way, so the composer keeps its preview away (Drea, #6035).
const PAIR_MARKERS = [/\*\*[^\n]*\*\*/, /__[^\n]*__/, /\+\+[^\n]*\+\+/, /~~[^\n]*~~/, /`[^`\n]+`/];
const EMPHASIS = /(?:^|[\s(])[_*][^\s_*][^\n]*[_*](?=$|[\s).,!?;:])/;
const LINE_MARKERS = /(?:^|\n)[ \t]{0,3}(?:#{1,3}[ \t]|>[ \t]?|[-*+][ \t])/;

/** Whether `value` holds formatting worth showing back to its writer. */
export function hasFormatting(value: string): boolean {
  return LINE_MARKERS.test(value) || EMPHASIS.test(value) || PAIR_MARKERS.some((rule) => rule.test(value));
}
