'use strict';

// Structured blocks inside a change's explanation (#4098).
//
// A change's plain-language summary (chat_sessions.pr_summary_md) is one to
// three sentences every voter reads first. Some changes explain better with
// a before/after comparison, a numbered path of steps, or a small table: who
// keeps their vote and who is asked to verify, what "verified" means. The
// metadata model emits those as DATA (a `blocks` array in the JSON it already
// answers), this module validates them all-or-nothing per block, and the
// change page draws the valid ones with the shell's own list primitives
// (frontend/src/features/dev-board/topic/explain-blocks.tsx). Nothing half
// valid is ever stored or drawn.
//
// The blocks travel INSIDE the summary column, as a trailing fenced code
// block with language `explain` holding canonical JSON, so the freshness
// columns, the history trigger and every reader of the column stay as they
// are. A reader that does not know the fence shows it as a code block, which
// is the plain-text degradation; a plain-text reader already strips fences.
//
// frontend/src/lib/explain-blocks.ts MIRRORS validate, split and toMarkdown
// for the browser; tests/explain-blocks.test.js runs both over one fixture
// list and fails when they drift. Change the two together.

const VERSION = 1;
const MAX_BLOCKS = 2;
const MAX_TEXT = 120;
const MAX_TITLE = 60;
const FENCE_LANG = 'explain';

const LIMITS = Object.freeze({
  comparisonRows: [1, 6],
  comparisonTerms: [0, 4],
  steps: [2, 7],
  tableColumns: [2, 4],
  tableRows: [1, 6],
});

// A cell: a non-empty single line of plain text within its length. Internal
// whitespace runs (a stray newline the model wrote) collapse to one space.
// Null means the block it belongs to is dropped.
function cell(value, max) {
  if (typeof value !== 'string') return null;
  const s = value.replace(/\s+/g, ' ').trim();
  if (!s || s.length > max) return null;
  return s;
}

// An optional title: absent, null or blank means no title; a present string
// past its length means the block is dropped (`false`).
function title(value) {
  if (value == null) return undefined;
  if (typeof value !== 'string') return false;
  if (!value.trim()) return undefined;
  const s = cell(value, MAX_TITLE);
  return s == null ? false : s;
}

function within(list, [min, max]) {
  return Array.isArray(list) && list.length >= min && list.length <= max;
}

function withTitle(block, t) {
  return t === undefined ? block : { ...block, title: t };
}

function validateBlock(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const t = title(input.title);
  if (t === false) return null;
  switch (input.kind) {
    case 'comparison': {
      if (!within(input.rows, LIMITS.comparisonRows)) return null;
      const rows = [];
      for (const r of input.rows) {
        if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
        const who = cell(r.who, MAX_TEXT);
        const before = cell(r.before, MAX_TEXT);
        const after = cell(r.after, MAX_TEXT);
        if (who == null || before == null || after == null) return null;
        rows.push({ who, before, after });
      }
      const rawTerms = input.terms == null ? [] : input.terms;
      if (!within(rawTerms, LIMITS.comparisonTerms)) return null;
      const terms = [];
      for (const x of rawTerms) {
        if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
        const term = cell(x.term, MAX_TEXT);
        const meaning = cell(x.meaning, MAX_TEXT);
        if (term == null || meaning == null) return null;
        terms.push({ term, meaning });
      }
      const out = withTitle({ kind: 'comparison' }, t);
      out.rows = rows;
      if (terms.length) out.terms = terms;
      return out;
    }
    case 'steps': {
      if (!within(input.steps, LIMITS.steps)) return null;
      const steps = [];
      for (const s of input.steps) {
        const v = cell(s, MAX_TEXT);
        if (v == null) return null;
        steps.push(v);
      }
      const out = withTitle({ kind: 'steps' }, t);
      out.steps = steps;
      return out;
    }
    case 'table': {
      if (!within(input.columns, LIMITS.tableColumns)) return null;
      const columns = [];
      for (const c of input.columns) {
        const v = cell(c, MAX_TEXT);
        if (v == null) return null;
        columns.push(v);
      }
      if (!within(input.rows, LIMITS.tableRows)) return null;
      const rows = [];
      for (const r of input.rows) {
        if (!Array.isArray(r) || r.length !== columns.length) return null;
        const row = [];
        for (const c of r) {
          const v = cell(c, MAX_TEXT);
          if (v == null) return null;
          row.push(v);
        }
        rows.push(row);
      }
      const out = withTitle({ kind: 'table' }, t);
      out.columns = columns;
      out.rows = rows;
      return out;
    }
    default:
      return null;
  }
}

// The canonical array for whatever the model (or a fence) said: valid blocks
// in order, the first MAX_BLOCKS of them, unknown fields dropped. Never
// throws; anything that is not an array is no blocks.
function validate(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const b of input) {
    const v = validateBlock(b);
    if (v) out.push(v);
    if (out.length >= MAX_BLOCKS) break;
  }
  return out;
}

function serialize(blocks) {
  return JSON.stringify({ v: VERSION, blocks });
}

// `text`, then the fence, when there is anything to put in it. With no valid
// blocks the text is returned exactly as given.
function embed(text, blocks) {
  const valid = validate(blocks);
  const base = text == null ? '' : String(text);
  if (!valid.length) return base;
  const fence = `\`\`\`${FENCE_LANG}\n${serialize(valid)}\n\`\`\``;
  const lead = base.replace(/\s+$/, '');
  return lead ? `${lead}\n\n${fence}` : fence;
}

// What a fence's body means: the version-1 object's blocks, validated, or
// nothing when it does not parse or is not that object.
function parseFenceBody(body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { return []; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  if (parsed.v !== VERSION) return [];
  return validate(parsed.blocks);
}

const OPEN_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/;

// The summary split into its words and its blocks. Every `explain` fence
// outside another fence is read; one that yields at least one block (up to
// MAX_BLOCKS overall) is removed from the text and its blocks collected. A
// fence that yields none, or never closes, stays in the text untouched: the
// renderer shows it as the code block it is, which is the plain-text
// degradation. A summary with no explain fence comes back as given.
function split(md) {
  const src = typeof md === 'string' ? md : '';
  if (!src.includes('```') && !src.includes('~~~')) return { text: src, blocks: [] };
  const lines = src.split('\n');
  const keep = [];
  const blocks = [];
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

const gfmCell = (s) => s.replace(/\|/g, '\\|');
const gfmTable = (columns, rows) => [
  `| ${columns.map(gfmCell).join(' | ')} |`,
  `| ${columns.map(() => '---').join(' | ')} |`,
  ...rows.map((r) => `| ${r.map(gfmCell).join(' | ')} |`),
].join('\n');

// The blocks as plain GitHub Markdown, for the pull request body and for a
// sink that can only show HTML: a comparison is a table with Before and
// After columns and one bullet per term, steps are a numbered list, a table
// is a table. A title leads its block as a bold line.
function toMarkdown(blocks) {
  const valid = validate(blocks);
  const parts = [];
  for (const b of valid) {
    const out = [];
    if (b.title) out.push(`**${b.title}**`);
    if (b.kind === 'comparison') {
      out.push(gfmTable([' ', 'Before', 'After'], b.rows.map((r) => [r.who, r.before, r.after])));
      if (b.terms && b.terms.length) out.push(b.terms.map((x) => `- **${x.term}**: ${x.meaning}`).join('\n'));
    } else if (b.kind === 'steps') {
      out.push(b.steps.map((s, n) => `${n + 1}. ${s}`).join('\n'));
    } else if (b.kind === 'table') {
      out.push(gfmTable(b.columns, b.rows));
    }
    parts.push(out.join('\n\n'));
  }
  return parts.join('\n\n');
}

// The summary as GitHub should show it: the words, then the blocks as
// Markdown. A summary with no blocks passes through unchanged.
function forGitHub(md) {
  const { text, blocks } = split(md);
  if (!blocks.length) return md;
  const tail = toMarkdown(blocks);
  return text ? `${text}\n\n${tail}` : tail;
}

// Any writer's fence re-serialised canonically; an invalid one is kept as the
// plain text it is. Anything that is not a non-empty string is returned as
// given, so a nullable summary can pass straight through.
function normalize(md) {
  if (typeof md !== 'string' || !md) return md;
  const { text, blocks } = split(md);
  if (!blocks.length) return md;
  return embed(text, blocks);
}

module.exports = {
  VERSION, MAX_BLOCKS, MAX_TEXT, MAX_TITLE, FENCE_LANG, LIMITS,
  validate, embed, split, toMarkdown, forGitHub, normalize,
};
