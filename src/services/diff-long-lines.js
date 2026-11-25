// Very long lines in a diff, cut short for a reader with a character budget.
//
// A minified bundle is a few lines of tens of thousands of characters each.
// An app that commits its bundle beside its source (SOLfun's
// public/build/app.js: 540 KB in 156 lines) turns a twenty-line change into
// about 1 MB of diff, nearly all of it in fourteen bundle lines. A reader
// that stops at a budget spent the whole of it there, never reached the
// source that sorted after it, and reported the change as cut off. That is
// what sent the admins "Not read in full" for every change to such an app.
//
// A line past LONG_LINE characters is kept to its first KEEP, with a note of
// its real length, so the budget goes to lines a person wrote. The start of
// the line stays, with its +, - or space, so a diff parser reads it as the
// same kind of line. Nobody writes a 2,000-character line by hand; a line
// that long which does matter (one-line JSON, an inlined image) still shows
// its start and says how much was left out.

'use strict';

const LONG_LINE = 2000;
const KEEP = 300;

/**
 * Pure. `{ text, clipped }`: the patch with every line longer than `max` cut
 * to its first `keep` characters, and how many lines were cut.
 */
function clipLongLines(patch, max = LONG_LINE, keep = KEEP) {
  const text = String(patch || '');
  const limit = Number(max) > 0 ? Number(max) : LONG_LINE;
  if (text.length <= limit) return { text, clipped: 0 };
  let clipped = 0;
  const lines = text.split('\n').map((line) => {
    if (line.length <= limit) return line;
    clipped += 1;
    return `${line.slice(0, keep)} … (a line of ${line.length} characters, not read past here)`;
  });
  return { text: clipped ? lines.join('\n') : text, clipped };
}

module.exports = { clipLongLines, LONG_LINE, KEEP };
