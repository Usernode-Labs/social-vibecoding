'use strict';

// Parsing for the "==== DESCRIPTION ====" block an OpenRouter coding agent is
// asked to put at the end of its final message on every turn (#2820):
//
//   ==== DESCRIPTION ====
//   Adds a dark-mode toggle to the settings page. The choice is remembered
//   on this device and applies to every screen.
//   ==== END DESCRIPTION ====
//
// OpenRouter sessions never buy a model call to write their proposal text
// (see deterministicPrMetadataDraft in pr-metadata.js), so the only prose the
// proposal can carry is what the coding agent itself wrote. Its final message
// is a log of the turn ("Done. Committed as e1d33fa…"), which is not a
// description of the change. This block is: it describes the WHOLE change so
// far, and each turn's block replaces the previous one as the proposal's
// description.
//
// `extract` works like testing-notes.extract: it removes the block so the
// raw markers never reach chat history, and returns the parsed text. It runs
// on the text testing-notes has already cleaned, because the testing block is
// the one that must come last.

const DESCRIPTION_MAX = 4000;
// How much of a turn's raw message the fallback keeps when no block was given.
const FALLBACK_MAX = 1500;

// The markers as testing-notes matches its own: the exact upper-case label,
// on a line that starts with `=` or markdown emphasis. A model sometimes
// writes "**DESCRIPTION**" for the marker; unmatched, the whole reply
// ("The change is committed. Here is the summary. **DESCRIPTION** …")
// became the description the group voted on (#2779 follow-up).
const OPEN_RE = markerRe('DESCRIPTION');
const CLOSE_RE = markerRe('END DESCRIPTION');

function markerRe(label) {
  return new RegExp(
    `^[ \\t]*(?=\\*\\*|__|=)(?:\\*\\*|__)?[ \\t]*(?:={2,}[ \\t]*)?${label}(?:[ \\t]*={2,})?[ \\t]*(?:\\*\\*|__)?[ \\t]*:?[ \\t]*$`,
    'gm',
  );
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// Find the LAST description block in `text`, remove it and return its body.
// A missing END marker means the block runs to the end of the text. Returns
// { cleanedText, description } with description null when the block is
// absent or empty.
function extract(text) {
  if (typeof text !== 'string' || !text) {
    return { cleanedText: typeof text === 'string' ? text : '', description: null };
  }
  let open = null;
  OPEN_RE.lastIndex = 0;
  for (let m; (m = OPEN_RE.exec(text)) !== null; ) open = m;
  if (!open) return { cleanedText: text, description: null };

  const blockStart = open.index + open[0].length;
  CLOSE_RE.lastIndex = blockStart;
  const close = CLOSE_RE.exec(text);
  const blockEnd = close ? close.index : text.length;
  const afterBlock = close ? close.index + close[0].length : text.length;

  const cleanedText = `${text.slice(0, open.index).trimEnd()}\n\n${text.slice(afterBlock).trim()}`.trim();
  const description = text.slice(blockStart, blockEnd).trim();
  return {
    cleanedText,
    description: description ? clip(description, DESCRIPTION_MAX) : null,
  };
}

// Filler an agent opens its final message with. Only whole leading words
// followed by punctuation, so a message that starts "Done buttons now…" is
// left alone.
const LEADING_FILLER_RE = /^(?:(?:all\s+)?done|finished|complete|ok(?:ay)?|great|sure|alright)\s*[.!:,—-]+\s*/i;
// A line whose point is the git bookkeeping: "Committed as e1d33fa.",
// "Commit 3f2a9c1 pushed to …". Readers of a proposal cannot use a SHA.
const COMMIT_LINE_RE = /\b(?:commit(?:ted)?|pushed)\b[^\n]*\b[0-9a-f]{7,40}\b/i;

// The fallback when a turn gave no description block: the turn's own message,
// with the leading filler and commit bookkeeping removed, clipped. Returns ''
// when nothing is left.
function cleanTurnMessage(text) {
  if (typeof text !== 'string') return '';
  const lines = extract(text).cleanedText
    .split('\n')
    .map((line) => {
      if (!COMMIT_LINE_RE.test(line)) return line;
      // Keep the rest of a line that only mentions the commit in passing:
      // drop the sentence carrying the SHA, not the whole paragraph.
      return line
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => !COMMIT_LINE_RE.test(sentence))
        .join(' ');
    });
  const cleaned = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().replace(LEADING_FILLER_RE, '').trim();
  return cleaned ? clip(cleaned, FALLBACK_MAX) : '';
}

module.exports = {
  extract,
  cleanTurnMessage,
  DESCRIPTION_MAX,
  FALLBACK_MAX,
};
