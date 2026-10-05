'use strict';

/**
 * No em dashes in what a model writes for people (5 Oct 2026).
 *
 * The platform's copy has none (#1389, tests/no-em-dash-in-copy.test.js),
 * and the prompts that write copy say so, but a model still writes them. The
 * Homeroom bot's change descriptions, shown on the change page to every
 * member and as the pull request's body, kept saying "Members do nothing
 * extra — finishing a book happens by picking the next one." and
 * "Everything else on the card — the hosting label, the date, the 7:00 pm
 * time and the countdown — is unchanged". So the text is made dash-free
 * before it is saved, whatever the model did with the prompt.
 *
 * Conservative on purpose. Only an em dash (and its HTML entities) is
 * touched: an en dash in a range ("6:30–8pm"), a hyphen and "--" are left as
 * they are. Code (fenced blocks, `inline code`), URLs and markdown link
 * targets are never touched. A dash between words becomes what fits there,
 * read from the words around it:
 *
 *   - a pair in one sentence is an aside: in brackets when the aside is a
 *     list ("the card (the label, the date) is unchanged"), else in commas;
 *   - a dash before a joining word (and, but, which, with, ...) is a comma;
 *   - a dash before a new clause that starts with a pronoun ("... — it
 *     updates every minute") is a full stop, the next word capitalised;
 *   - a dash after a short label ("**Countdown** — shows ...", "Next
 *     session — Wednesday") is a colon;
 *   - otherwise a colon, or a comma when the sentence already has a colon.
 *
 * A dash between two numbers, times, weekdays or months with no space
 * around it is a range, and becomes an en dash. A dash that starts a line is
 * a bullet ("- "); one that ends a line introduces what follows (":"). A dash
 * standing alone (a table's empty cell, a line of its own) is a glyph, and is
 * left as it is. Pure, and the same text comes back when there is no dash.
 */

const EM = '\u2014';
const EN = '\u2013';
const HAS_DASH_RE = /\u2014|&mdash;|&#8212;|&#x2014;/i;
const ENTITY_RE = /&mdash;|&#8212;|&#x2014;/gi;

// A protected span is swapped for one of these while the rest is read, so it
// still counts as a word between dashes and can never be changed.
const OPEN = '\uE000';
const CLOSE = '\uE001';
const PLACEHOLDER_RE = /\uE000(\d+)\uE001/g;

const INLINE_CODE_RE = /(`+)[^\n]*?\1/g;
// A URL is everything up to the next space, as it was written, whatever is
// in it.
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const LINK_TARGET_RE = /\]\([^)\n]*\)/g;
const FENCE_OPEN_RE = /^[ \t]*(`{3,}|~{3,})/;

// A run of em dashes, with the spaces on each side of it.
const DASH_RUN_RE = /([ \t\u00a0]*)\u2014+([ \t\u00a0]*)/g;
// The end of a sentence inside a line: a full stop, question or exclamation
// mark (and any closing quote or bracket) followed by a space.
const SENTENCE_END_RE = /[.!?]["'\u2019\u201d)\]*_]*[ \t]+/g;
// The same, or one at the end of a stretch of text (not global: it is only tested).
const HAS_SENTENCE_END_RE = /[.!?]["'\u2019\u201d)\]*_]*(?:[ \t]+|$)/;
// What a line may start with before its words: a quote, a heading, a bullet.
const LINE_MARKER_RE = /^[ \t]*(?:>[ \t]*)*(?:#{1,6}[ \t]+|[-*+][ \t]+|\d{1,3}[.)][ \t]+)?/;
// Only those markers, and nothing else.
const ONLY_MARKER_RE = /^[ \t]*(?:>[ \t]*)*(?:#{1,6}|[-*+]|\d{1,3}[.)])?[ \t]*$/;

// Words a clause runs on with, after a comma rather than a stop or a colon.
const JOINING_WORDS = new Set([
  'and', 'but', 'or', 'nor', 'so', 'yet', 'which', 'who', 'whom', 'whose', 'where', 'when', 'while', 'whereas',
  'because', 'since', 'as', 'though', 'although', 'unless', 'until', 'till', 'if', 'whether', 'not', 'including',
  'like', 'such', 'especially', 'even', 'just', 'only', 'except', 'plus', 'instead', 'rather', 'then', 'than',
  'with', 'without', 'for', 'from', 'to', 'in', 'on', 'at', 'by', 'into', 'onto', 'over', 'under', 'after',
  'before', 'during', 'about', 'around', 'through', 'within', 'via', 'per', 'also', 'too', 'either', 'neither',
  'mostly', 'usually', 'often', 'perhaps', 'maybe', 'all', 'both', 'once', 'now',
]);
// Words a new sentence starts with: a pronoun, as a clause's subject.
const PRONOUNS = new Set([
  'i', "i'm", "i'll", "i've", "i'd", 'you', "you're", "you'll", "you've", "you'd", 'we', "we're", "we'll",
  "we've", "we'd", 'they', "they're", "they'll", "they've", "they'd", 'it', "it's", "it'll", 'he', 'she',
  "there's", "here's", "that's",
]);
// "this" and "that" start a clause only when a verb follows ("that sounds
// like a bug", not "that week").
const DEMONSTRATIVES = new Set(['this', 'that']);
const VERBISH_RE = /^(?:is|was|will|would|can|could|should|might|may|did|does|has|had|means|[a-z]+[^su']s)$/;

const WEEKDAY = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|tue|wed|thurs|thur|thu|fri|sat|sun';
const MONTH = 'january|february|march|april|may|june|july|august|september|october|november|december'
  + '|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec';
const RANGE_LEFT_RE = new RegExp(`(?:\\d|\\d(?:am|pm)|\\b(?:${WEEKDAY}|${MONTH}))$`, 'i');
const RANGE_RIGHT_RE = new RegExp(`^(?:\\d|(?:${WEEKDAY}|${MONTH})\\b)`, 'i');

function protect(text) {
  const kept = [];
  const hold = (span) => {
    kept.push(span);
    return `${OPEN}${kept.length - 1}${CLOSE}`;
  };
  // Fenced code blocks, line by line: from an opening fence to the line that
  // closes it with the same fence (or to the end, when nothing does).
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = FENCE_OPEN_RE.exec(lines[i]);
    if (!open) {
      out.push(lines[i]);
      continue;
    }
    const fence = open[1];
    let end = i + 1;
    const closes = new RegExp(`^[ \\t]*${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*\\r?$`);
    while (end < lines.length && !closes.test(lines[end])) end += 1;
    const last = Math.min(end, lines.length - 1);
    out.push(hold(lines.slice(i, last + 1).join('\n')));
    i = last;
  }
  return {
    text: out.join('\n')
      .replace(INLINE_CODE_RE, hold)
      .replace(LINK_TARGET_RE, hold)
      .replace(URL_RE, hold),
    kept,
  };
}

function restore(text, kept) {
  // A held span can hold another's placeholder only if it was taken first,
  // so restoring until none is left puts back each one exactly.
  let out = text;
  for (let i = 0; i < 4 && out.includes(OPEN); i += 1) {
    out = out.replace(PLACEHOLDER_RE, (whole, n) => (kept[Number(n)] ?? whole));
  }
  return out;
}

function wordCount(text) {
  return String(text).split(/\s+/).filter((w) => /[\p{L}\p{N}\uE000]/u.test(w)).length;
}

/** The clause a dash at `at` closes: from the line's words, or its sentence, to the dash. */
function clauseBefore(line, at) {
  let from = (LINE_MARKER_RE.exec(line) || [''])[0].length;
  if (from > at) from = 0;
  const head = line.slice(from, at);
  let lastEnd = 0;
  for (const m of head.matchAll(SENTENCE_END_RE)) lastEnd = m.index + m[0].length;
  return head.slice(lastEnd).trim();
}

/** The first two words after a dash, lower case, with a curly apostrophe made straight. */
function wordsAfter(text) {
  const words = String(text)
    .replace(/^[\s"'\u201c\u2018*_([]+/, '')
    .toLowerCase()
    .replace(/\u2019/g, "'")
    .match(/[\p{L}\p{N}']+/gu) || [];
  return [words[0] || '', words[1] || ''];
}

function isEmphasisLabel(clause) {
  return /^(\*\*|__|\*|_)[^*_\n]+\1$/.test(clause) || /^\uE000\d+\uE001$/.test(clause);
}

function startsClause(first, second) {
  if (PRONOUNS.has(first)) return true;
  return DEMONSTRATIVES.has(first) && VERBISH_RE.test(second);
}

function capitaliseFirst(text) {
  return text.replace(/^([\s"'\u201c\u2018*_([]*)([a-z])/, (whole, lead, letter) => lead + letter.toUpperCase());
}

/** What one dash between words becomes, on its own. */
function singleDash({ line, start, right }) {
  const clause = clauseBefore(line, start);
  const [first, second] = wordsAfter(right);
  if (isEmphasisLabel(clause)) return { rep: ': ' };
  if (JOINING_WORDS.has(first)) return { rep: ', ' };
  if (startsClause(first, second)) return { rep: '. ', capitalise: true };
  if (wordCount(clause) <= 2) return { rep: ': ' };
  // A colon already in the sentence (not a time's, "6:30"): a second would be one too many.
  if (/:\s/.test(clause)) return { rep: ', ' };
  return { rep: ': ' };
}

/** Whether the dash at `k` and the next one make an aside in one sentence. */
function pairedWith(line, matches, k) {
  const m = matches[k];
  const next = matches[k + 1];
  if (!next) return null;
  const end = m.index + m[0].length;
  const inner = line.slice(end, next.index);
  const after = line.slice(next.index + next[0].length);
  if (!/\S/.test(inner) || !/\S/.test(after) || /^\s*\|/.test(after)) return null;
  if (HAS_SENTENCE_END_RE.test(inner)) return null;
  // "Bins — Member 1, Dishes — Member 2" is two labels, not an aside.
  const lastPart = inner.split(/[,;]/).pop();
  if (/[,;]/.test(inner) && wordCount(lastPart) <= 3 && wordCount(clauseBefore(line, m.index)) <= 3) return null;
  return { next, inner: inner.trim(), after };
}

function fixLine(line) {
  const matches = [...line.matchAll(DASH_RUN_RE)];
  if (!matches.length) return line;
  let out = '';
  let cursor = 0;
  let upperAt = -1;
  const emit = (to) => {
    let chunk = line.slice(cursor, to);
    if (upperAt === cursor) chunk = capitaliseFirst(chunk);
    out += chunk;
    cursor = to;
  };
  for (let k = 0; k < matches.length; k += 1) {
    const m = matches[k];
    const start = m.index;
    const end = start + m[0].length;
    if (start < cursor) continue;
    const left = line.slice(0, start);
    const right = line.slice(end);
    const rightHas = /\S/.test(right);
    emit(start);
    let rep = m[0];
    let to = end;
    if (ONLY_MARKER_RE.test(left)) {
      // A dash that starts a line is a bullet; one alone on it is a glyph.
      if (rightHas) rep = /\S/.test(left) ? ' ' : `${m[1]}- `;
    } else if (/\|\s*$/.test(left) || /^\s*\|/.test(right)) {
      // A table's cell: an empty one's glyph, or the edge of one.
      rep = m[0];
    } else if (!rightHas) {
      rep = /[,.;:!?]$/.test(left) ? '' : ':';
    } else if (/[,;:]$/.test(left)) {
      rep = ' ';
    } else if (/[(\[{"'\u201c\u2018]$/.test(left)) {
      rep = '';
    } else if (/^[,.;:!?)\]]/.test(right)) {
      rep = '';
    } else if (!m[1] && !m[2] && RANGE_LEFT_RE.test(left) && RANGE_RIGHT_RE.test(right)) {
      rep = EN;
    } else {
      const pair = pairedWith(line, matches, k);
      if (pair) {
        const listed = pair.inner.includes(',');
        const punctuated = /^[.,;:!?)]/.test(pair.after);
        const open = listed ? ' (' : ', ';
        const close = listed ? `)${punctuated ? '' : ' '}` : (punctuated ? '' : ', ');
        rep = `${open}${pair.inner}${close}`;
        to = pair.next.index + pair.next[0].length;
      } else {
        const single = singleDash({ line, start, right });
        rep = single.rep;
        if (single.capitalise) upperAt = end;
      }
    }
    out += rep;
    cursor = to;
  }
  emit(line.length);
  return out;
}

/**
 * `text` with every em dash between words replaced as the header says, and
 * code, URLs and link targets as they were. Anything that is not a string,
 * and a string with no em dash, comes back as it is.
 */
function withoutEmDashes(text) {
  if (typeof text !== 'string' || !HAS_DASH_RE.test(text)) return text;
  // Text that already holds the placeholder characters is not read: it would
  // be put back wrong. No model writes them.
  if (text.includes(OPEN) || text.includes(CLOSE)) return text;
  const { text: held, kept } = protect(text);
  const plain = held.replace(ENTITY_RE, EM);
  if (!plain.includes(EM)) return text;
  const fixed = plain.split('\n').map((line) => {
    const cr = line.endsWith('\r');
    const body = cr ? line.slice(0, -1) : line;
    return fixLine(body) + (cr ? '\r' : '');
  }).join('\n');
  return restore(fixed, kept);
}

module.exports = {
  withoutEmDashes,
};
