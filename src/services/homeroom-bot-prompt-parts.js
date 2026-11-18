'use strict';

// #6777: the triage prompt's size rule, one budget per part.
//
// The single `prompt.length < 30550` assertion in tests/homeroom-bot.test.js
// was a line every change that added triage wording rewrote: two changes
// running at once raised it from the same old value, conflicted on it, and
// then failed again once merged (PR 6748 used all three of the bot's fix
// tries on exactly that). A part's budget is now a comment line beside its
// own text in the prompt file, so a change that grows one part edits only
// that part's marker, and the total is held by a separate ceiling.
//
// The marker is one line, immediately before the part it covers:
//
//   <!-- prompt-part: ready | budget: 3950 | 17 Nov 2026 #6772: data-safe database changes -->
//
// A part runs from its marker to the next marker, or the end of the file,
// and its size is the character count of that span with markers removed.
// Every marker line is stripped before the model reads the file.

const MARKER_LINE = /^<!-- prompt-part: [^\n]*-->\n/gm;
const MARKER = /^<!-- prompt-part: (.*) -->\n/gm;

/** Every marker line, and its newline, gone: the text the model reads. */
function stripPartMarkers(text) {
  return String(text).replace(MARKER_LINE, '');
}

/**
 * The parts of a prompt file. Throws, naming the file, on text before the
 * first marker, a duplicate part name, or a budget that is not a number.
 */
function parseParts(text, source) {
  const src = String(text);
  const markers = [];
  MARKER.lastIndex = 0;
  let match;
  while ((match = MARKER.exec(src))) {
    const fields = /^(.+?) \| budget: (\S+) \| (.*)$/.exec(match[1]);
    if (!fields) throw new Error(`malformed prompt-part marker in ${source}: ${match[0].trim()}`);
    const name = fields[1].trim();
    const budget = Number(fields[2]);
    if (!Number.isInteger(budget) || budget <= 0) {
      throw new Error(`prompt-part "${name}" in ${source} has a non-numeric budget: ${fields[2]}`);
    }
    markers.push({ index: match.index, end: MARKER.lastIndex, name, budget, note: fields[3].trim() });
  }
  if (!markers.length) throw new Error(`no prompt-part markers in ${source}`);
  if (src.slice(0, markers[0].index).trim()) {
    throw new Error(`text before the first prompt-part marker in ${source}`);
  }
  const seen = new Set();
  return markers.map((marker, i) => {
    if (seen.has(marker.name)) throw new Error(`duplicate prompt-part "${marker.name}" in ${source}`);
    seen.add(marker.name);
    const end = i + 1 < markers.length ? markers[i + 1].index : src.length;
    return {
      name: marker.name,
      budget: marker.budget,
      note: marker.note,
      chars: src.slice(marker.end, end).length,
      source,
    };
  });
}

/**
 * Each part with how far it is over, and a message a failing assertion can
 * read: the part, the file, its size and its budget.
 */
function checkParts(parts) {
  return parts.map((part) => {
    const over = part.chars - part.budget;
    const size = part.chars.toLocaleString('en-US');
    const budget = part.budget.toLocaleString('en-US');
    const amount = Math.abs(over).toLocaleString('en-US');
    const tail = over > 0
      ? `${amount} over its budget of ${budget}`
      : over === 0
        ? `exactly its budget of ${budget}`
        : `${amount} under its budget of ${budget}`;
    return {
      ...part,
      over,
      message: `triage prompt part "${part.name}" (${part.source}) is ${size} chars, ${tail}`,
    };
  });
}

module.exports = { parseParts, stripPartMarkers, checkParts };
