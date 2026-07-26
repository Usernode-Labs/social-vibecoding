'use strict';

// Parsing for the optional "==== TESTING ====" block the coding agent is
// asked to append to its final build-turn message (#127). The block carries
// bot-generated testing guidance for the PR's staging preview:
//
//   ==== TESTING ====
//   path: /board?demo-pr=1
//   path: /settings
//   1. Open the board view.
//   2. Drag a card — snap-to-grid should kick in.
//   ==== END TESTING ====
//
// `extract` pulls the block out of the agent's final text so the raw
// markers never leak into chat history, the Mayor's tool_result, or the
// PR-metadata LLM prompt. The parsed pieces land on
// chat_sessions.testing_md / testing_path / testing_paths and drive the
// "Test this change" button + "How to test" panel in the staging preview
// overlay, plus the multi-route before/after capture pipeline (#270).
//
// The block may carry MORE THAN ONE `path:` line (consecutive leading
// lines of the block): the capture step shoots an ordered before/after
// pair per path so a change spanning several views shows each one. The
// list is validated per-line, deduped preserving order, and capped at
// CAPTURE_MAX_PATHS. `testingPath` (the first path) is retained unchanged
// for the single-valued consumers — the "Test this change" deep-link
// button and buildTestingBlock's "Deep link:" line.
//
// A `path:` line may also carry a whitespace-separated annotation after
// the path (#768):
//
//   path: /board?demo=1 @mobile
//
// `@mobile` asks the capture step to shoot that route in a phone-sized
// viewport (for changes only visible on narrow screens). `testingPaths`
// entries are therefore objects — { path, viewport: 'desktop'|'mobile' } —
// and chat_sessions.testing_paths stores that object form. Rows written
// before #768 hold plain strings; normalizeStoredPath() maps either form
// onto { path, viewport } so readers stay back-compatible in one place.

const log = require('./logger');

const TESTING_MD_MAX = 4000;
const TESTING_PATH_MAX = 512;

// Max before/after capture routes per proposal. RUN_TIMEOUT_MS (240s) in
// services/visuals.js budgets ~35-40s per path for the desktop pair
// (before+after, settle + scroll pass + GIF transcode) plus ~10-15s for
// the automatic phone-frame PNG pair, so 3 paths (~160s worst case) stays
// inside it. Extras are dropped and logged — never silently truncated.
const CAPTURE_MAX_PATHS = 3;

// Marker lines are matched whole-line and tolerate variable `=` runs and
// surrounding whitespace, but require the exact TESTING / END TESTING label.
const OPEN_RE = /^[ \t]*={2,}[ \t]*TESTING[ \t]*={2,}[ \t]*$/gm;
const CLOSE_RE = /^[ \t]*={2,}[ \t]*END TESTING[ \t]*={2,}[ \t]*$/gm;

// Viewport labels a capture path may carry (#768). Desktop is the default
// (the capture container's fixed 1280x800); `@mobile` opts one route into
// a phone-sized frame for changes only visible on narrow screens. The
// label→pixel mapping lives in services/visuals.js — this module only
// deals in the labels.
const VIEWPORT_DESKTOP = 'desktop';
const VIEWPORT_MOBILE = 'mobile';

// Normalize one stored chat_sessions.testing_paths element into
// { path, viewport }. Rows written before #768 hold plain path strings;
// newer rows hold { path, viewport } objects. Anything unusable (empty,
// wrong type, malformed object) returns null so callers can filter.
// Deliberately does NOT re-run validatePath — stored rows were validated
// at extract time, and re-validating here would silently drop a stored
// capture route on a rules change.
function normalizeStoredPath(entry) {
  if (typeof entry === 'string') {
    return entry ? { path: entry, viewport: VIEWPORT_DESKTOP } : null;
  }
  if (entry && typeof entry === 'object' && typeof entry.path === 'string' && entry.path) {
    return {
      path: entry.path,
      viewport: entry.viewport === VIEWPORT_MOBILE ? VIEWPORT_MOBILE : VIEWPORT_DESKTOP,
    };
  }
  return null;
}

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
//   { cleanedText, testingMd, testingPath, testingPaths }
// with testingMd null when the block is absent or carries no instructions,
// testingPaths the ordered (deduped, capped) list of validated
// { path, viewport } entries, and testingPath = the first entry's plain
// path string (or null) for the single-valued consumers.
function extract(text) {
  const none = (t) => ({ cleanedText: t, testingMd: null, testingPath: null, testingPaths: [] });
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

  // Optional `path:` lines — the consecutive leading lines of the block
  // (blank lines tolerated between them). Each line's value splits on
  // whitespace: the first token is the path (validated independently;
  // invalid ones are dropped), the rest are annotations — `@mobile` sets
  // the entry's viewport, anything unrecognized is logged and ignored so
  // a typo'd annotation degrades to a desktop shot rather than losing the
  // route. Duplicates collapse by path+viewport preserving first-seen
  // order (the same path may legitimately appear once per viewport), and
  // the list is capped at CAPTURE_MAX_PATHS (extras logged, not silently
  // truncated). The first non-blank line that isn't a `path:` line begins
  // the markdown instructions.
  const testingPaths = [];
  const seenKeys = new Set();
  let droppedForCap = 0;
  let mdStart = 0;
  for (let i = 0; i < blockLines.length; i++) {
    const line = blockLines[i].trim();
    if (!line) { mdStart = i + 1; continue; }
    const pm = line.match(/^path:\s*(.+)$/i);
    if (!pm) { mdStart = i; break; }
    mdStart = i + 1;
    const tokens = pm[1].trim().split(/\s+/);
    const valid = validatePath(tokens[0]);
    if (!valid) continue;
    let viewport = VIEWPORT_DESKTOP;
    for (const annotation of tokens.slice(1)) {
      if (/^@mobile$/i.test(annotation)) {
        viewport = VIEWPORT_MOBILE;
      } else {
        log.warn('testing-notes', 'Unknown path annotation ignored', {
          annotation: annotation.slice(0, 32), path: valid,
        });
      }
    }
    const key = `${viewport} ${valid}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    if (testingPaths.length < CAPTURE_MAX_PATHS) testingPaths.push({ path: valid, viewport });
    else droppedForCap++;
  }
  if (droppedForCap > 0) {
    log.warn('testing-notes', 'Capture path list over cap — extras dropped', {
      kept: testingPaths.length, dropped: droppedForCap, cap: CAPTURE_MAX_PATHS,
    });
  }

  let testingMd = blockLines.slice(mdStart).join('\n').trim();
  if (testingMd.length > TESTING_MD_MAX) testingMd = testingMd.slice(0, TESTING_MD_MAX);

  return {
    cleanedText,
    testingMd: testingMd || null,
    testingPath: testingPaths.length ? testingPaths[0].path : null,
    testingPaths,
  };
}

module.exports = {
  extract,
  validatePath,
  normalizeStoredPath,
  TESTING_MD_MAX,
  TESTING_PATH_MAX,
  CAPTURE_MAX_PATHS,
  VIEWPORT_DESKTOP,
  VIEWPORT_MOBILE,
};
