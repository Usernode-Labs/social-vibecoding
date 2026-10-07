/**
 * Structured blocks inside a change's explanation (#4098), for the browser.
 *
 * A MIRROR of src/services/explain-blocks.js: the same schema, the same
 * all-or-nothing validation per block, the same split of a summary into its
 * words and its `explain` fence, and the same Markdown form of the blocks.
 * The server is the authority; tests/explain-blocks.test.js runs both over
 * one fixture list and fails when they drift. Change the two together.
 */

export const VERSION = 1;
export const MAX_BLOCKS = 2;
export const MAX_TEXT = 120;
export const MAX_TITLE = 60;
export const FENCE_LANG = 'explain';

export const LIMITS = Object.freeze({
  comparisonRows: [1, 6] as const,
  comparisonTerms: [0, 4] as const,
  steps: [2, 7] as const,
  tableColumns: [2, 4] as const,
  tableRows: [1, 6] as const,
});

export type ComparisonBlock = {
  kind: 'comparison';
  title?: string;
  rows: { who: string; before: string; after: string }[];
  terms?: { term: string; meaning: string }[];
};
export type StepsBlock = { kind: 'steps'; title?: string; steps: string[] };
export type TableBlock = { kind: 'table'; title?: string; columns: string[]; rows: string[][] };
export type ExplainBlock = ComparisonBlock | StepsBlock | TableBlock;

type Range = readonly [number, number];

function cell(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const s = value.replace(/\s+/g, ' ').trim();
  if (!s || s.length > max) return null;
  return s;
}

function title(value: unknown): string | undefined | false {
  if (value == null) return undefined;
  if (typeof value !== 'string') return false;
  if (!value.trim()) return undefined;
  const s = cell(value, MAX_TITLE);
  return s == null ? false : s;
}

function within(list: unknown, [min, max]: Range): list is unknown[] {
  return Array.isArray(list) && list.length >= min && list.length <= max;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function validateBlock(input: unknown): ExplainBlock | null {
  if (!isRecord(input)) return null;
  const t = title(input.title);
  if (t === false) return null;
  switch (input.kind) {
    case 'comparison': {
      if (!within(input.rows, LIMITS.comparisonRows)) return null;
      const rows: ComparisonBlock['rows'] = [];
      for (const r of input.rows) {
        if (!isRecord(r)) return null;
        const who = cell(r.who, MAX_TEXT);
        const before = cell(r.before, MAX_TEXT);
        const after = cell(r.after, MAX_TEXT);
        if (who == null || before == null || after == null) return null;
        rows.push({ who, before, after });
      }
      const rawTerms = input.terms == null ? [] : input.terms;
      if (!within(rawTerms, LIMITS.comparisonTerms)) return null;
      const terms: NonNullable<ComparisonBlock['terms']> = [];
      for (const x of rawTerms) {
        if (!isRecord(x)) return null;
        const term = cell(x.term, MAX_TEXT);
        const meaning = cell(x.meaning, MAX_TEXT);
        if (term == null || meaning == null) return null;
        terms.push({ term, meaning });
      }
      const out: ComparisonBlock = t === undefined ? { kind: 'comparison', rows } : { kind: 'comparison', title: t, rows };
      if (terms.length) out.terms = terms;
      return out;
    }
    case 'steps': {
      if (!within(input.steps, LIMITS.steps)) return null;
      const steps: string[] = [];
      for (const s of input.steps) {
        const v = cell(s, MAX_TEXT);
        if (v == null) return null;
        steps.push(v);
      }
      return t === undefined ? { kind: 'steps', steps } : { kind: 'steps', title: t, steps };
    }
    case 'table': {
      if (!within(input.columns, LIMITS.tableColumns)) return null;
      const columns: string[] = [];
      for (const c of input.columns) {
        const v = cell(c, MAX_TEXT);
        if (v == null) return null;
        columns.push(v);
      }
      if (!within(input.rows, LIMITS.tableRows)) return null;
      const rows: string[][] = [];
      for (const r of input.rows) {
        if (!Array.isArray(r) || r.length !== columns.length) return null;
        const row: string[] = [];
        for (const c of r) {
          const v = cell(c, MAX_TEXT);
          if (v == null) return null;
          row.push(v);
        }
        rows.push(row);
      }
      return t === undefined ? { kind: 'table', columns, rows } : { kind: 'table', title: t, columns, rows };
    }
    default:
      return null;
  }
}

/** The canonical array: valid blocks in order, the first MAX_BLOCKS. Never throws. */
export function validate(input: unknown): ExplainBlock[] {
  if (!Array.isArray(input)) return [];
  const out: ExplainBlock[] = [];
  for (const b of input) {
    const v = validateBlock(b);
    if (v) out.push(v);
    if (out.length >= MAX_BLOCKS) break;
  }
  return out;
}

function parseFenceBody(body: string): ExplainBlock[] {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return []; }
  if (!isRecord(parsed)) return [];
  if (parsed.v !== VERSION) return [];
  return validate(parsed.blocks);
}

const OPEN_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/;

/**
 * The summary's words and its blocks. An `explain` fence that yields at least
 * one block is removed; one that yields none, or never closes, stays in the
 * text so the renderer shows it as the code block it is.
 */
export function split(md: unknown): { text: string; blocks: ExplainBlock[] } {
  const src = typeof md === 'string' ? md : '';
  if (!src.includes('```') && !src.includes('~~~')) return { text: src, blocks: [] };
  const lines = src.split('\n');
  const keep: string[] = [];
  const blocks: ExplainBlock[] = [];
  let i = 0;
  let removed = false;
  while (i < lines.length) {
    const m = OPEN_RE.exec(lines[i]);
    if (!m) { keep.push(lines[i]); i += 1; continue; }
    const marker = m[1];
    const lang = m[2];
    const closeRe = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`);
    let j = i + 1;
    while (j < lines.length && !closeRe.test(lines[j])) j += 1;
    const closed = j < lines.length;
    if (closed && lang === FENCE_LANG && blocks.length < MAX_BLOCKS) {
      const found = parseFenceBody(lines.slice(i + 1, j).join('\n'));
      if (found.length) {
        for (const b of found) if (blocks.length < MAX_BLOCKS) blocks.push(b);
        removed = true;
        i = j + 1;
        continue;
      }
    }
    const end = closed ? j : lines.length - 1;
    for (let k = i; k <= end; k += 1) keep.push(lines[k]);
    i = end + 1;
  }
  if (!removed) return { text: src, blocks: [] };
  const text = keep.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return { text, blocks };
}

const gfmCell = (s: string) => s.replace(/\|/g, '\\|');
const gfmTable = (columns: string[], rows: string[][]) => [
  `| ${columns.map(gfmCell).join(' | ')} |`,
  `| ${columns.map(() => '---').join(' | ')} |`,
  ...rows.map((r) => `| ${r.map(gfmCell).join(' | ')} |`),
].join('\n');

/** The blocks as GitHub Markdown, for a sink that can only show HTML. */
export function toMarkdown(blocks: unknown): string {
  const valid = validate(blocks);
  const parts: string[] = [];
  for (const b of valid) {
    const out: string[] = [];
    if (b.title) out.push(`**${b.title}**`);
    if (b.kind === 'comparison') {
      out.push(gfmTable([' ', 'Before', 'After'], b.rows.map((r) => [r.who, r.before, r.after])));
      if (b.terms && b.terms.length) out.push(b.terms.map((x) => `- **${x.term}**: ${x.meaning}`).join('\n'));
    } else if (b.kind === 'steps') {
      out.push(b.steps.map((s, n) => `${n + 1}. ${s}`).join('\n'));
    } else {
      out.push(gfmTable(b.columns, b.rows));
    }
    parts.push(out.join('\n\n'));
  }
  return parts.join('\n\n');
}
