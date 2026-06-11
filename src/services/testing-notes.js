'use strict';

// Parsing for the optional "==== TESTING ====" block the coding agent is
// asked to append to its final build-turn message (#127). The block carries
// bot-generated testing guidance for the PR's staging preview:
//
//   ==== TESTING ====
//   path: /board?demo-pr=1
//   1. Open the board view.
//   2. Drag a card — snap-to-grid should kick in.
//   ==== END TESTING ====
//
// `extract` pulls the block out of the agent's final text so the raw
// markers never leak into chat history, the Mayor's tool_result, or the
// PR-metadata LLM prompt. The parsed pieces land on
// chat_sessions.testing_md / testing_path and drive the "Test this change"
// button + "How to test" panel in the staging preview overlay.

const TESTING_MD_MAX = 4000;
const TESTING_PATH_MAX = 512;

// Marker lines are matched whole-line and tolerate variable `=` runs and
// surrounding whitespace, but require the exact TESTING / END TESTING label.
const OPEN_RE = /^[ \t]*={2,}[ \t]*TESTING[ \t]*={2,}[ \t]*$/gm;
const CLOSE_RE = /^[ \t]*={2,}[ \t]*END TESTING[ \t]*={2,}[ \t]*$/gm;

// Validate a deep-link path emitted by the agent. The path is later joined
// onto the staging origin and loaded in the preview iframe, so anything
// that could steer the iframe off that origin is rejected outright:
//  - must start with '/' (relative to the app), but not '//' (protocol-
//    relative URLs resolve to a different host)
//  - no whitespace, backslashes, backticks, quotes, or angle brackets
//    (defense-in-depth against attribute/markup injection)
//  - no scheme smuggling (`:` before the first `/` can't happen once the
//    leading-slash rule holds, but reject control chars regardless)
// Returns the trimmed path, or null when invalid (instructions are kept).
function validatePath(p) {
  if (typeof p !== 'string') return null;
  const path = p.trim();
  if (!path || path.length > TESTING_PATH_MAX) return null;
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  if (/[\s\\`'"<>]/.test(path)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(path)) return null;
  return path;
}

// Find the LAST "==== TESTING ====" block in `text`, remove it, and parse
// its contents. Tolerates a missing END marker at end-of-text (everything
// after the opening marker is the block). Returns:
//   { cleanedText, testingMd, testingPath }
// with testingMd null when the block is absent or carries no instructions,
// and testingPath null when absent or invalid.
function extract(text) {
  const none = (t) => ({ cleanedText: t, testingMd: null, testingPath: null });
  if (typeof text !== 'string' || !text) return none(typeof text === 'string' ? text : '');

  // Last opening marker wins — the agent is told the block must be the
  // final thing in its message, so a stray earlier example (e.g. quoted in
  // prose) is superseded by the real one.
  let open = null;
  OPEN_RE.lastIndex = 0;
  for (let m; (m = OPEN_RE.exec(text)) !== null; ) open = m;
  if (!open) return none(text);

  const blockStart = open.index + open[0].length;

  // First closing marker AFTER the opening one; absent → block runs to EOF.
  CLOSE_RE.lastIndex = blockStart;
  const close = CLOSE_RE.exec(text);
  const blockEnd = close ? close.index : text.length;
  const afterBlock = close ? close.index + close[0].length : text.length;

  const cleanedText = (text.slice(0, open.index) + text.slice(afterBlock)).replace(/\s+$/, '');

  const blockLines = text.slice(blockStart, blockEnd).split('\n');

  // Optional `path:` line — first non-empty line of the block.
  let testingPath = null;
  let mdStart = 0;
  for (let i = 0; i < blockLines.length; i++) {
    const line = blockLines[i].trim();
    if (!line) { mdStart = i + 1; continue; }
    const pm = line.match(/^path:\s*(.+)$/i);
    if (pm) {
      testingPath = validatePath(pm[1]);
      mdStart = i + 1;
    } else {
      mdStart = i;
    }
    break;
  }

  let testingMd = blockLines.slice(mdStart).join('\n').trim();
  if (testingMd.length > TESTING_MD_MAX) testingMd = testingMd.slice(0, TESTING_MD_MAX);

  return { cleanedText, testingMd: testingMd || null, testingPath };
}

module.exports = { extract, validatePath, TESTING_MD_MAX, TESTING_PATH_MAX };
