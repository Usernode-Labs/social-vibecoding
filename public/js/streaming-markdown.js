// streaming-markdown — pure helpers behind the dev-chat live-streaming
// assistant bubble and the inline spec-preview snippet. They exist to stop
// the GFM-task-checkbox flicker described in the proposal/dev-session spec:
// while Claude Code output streams in, a half-typed `- [ ]` line would
// momentarily parse as a checkbox row and then re-flow, and a spec-preview
// snippet clipped mid-task-item would pop a checkbox in and out across
// redrafts.
//
// Two exports do the work; both are deterministic and side-effect-free so
// they can be unit-tested under `node --test` without a DOM, `marked`, or
// `DOMPurify` (which only load in the browser):
//
//   splitStreamingMarkdown(fullText)
//     → { committed, tail } — everything up to and INCLUDING the last
//       newline is `committed` (safe to hand to a markdown renderer); the
//       trailing, still-being-typed line is `tail` (rendered as escaped
//       plaintext). A `- [` / `- [ ]` fragment therefore lives in `tail`
//       until its line is finished, so it never parses as a task item
//       early.
//
//   renderStreamingHtml(fullText, renderMarkdown, escapeHtml)
//     → HTML string: rendered markdown for the committed portion plus an
//       escaped-plaintext node for the held-back trailing line. The two
//       collaborators are injected so this stays pure: dev-chat passes its
//       real DOMPurify-backed `renderMarkdown` and `escapeHtml`; tests pass
//       lightweight stand-ins.
//
//   clipSpecSnippet(text, maxLen)
//     → text clipped to WHOLE LINES only (never mid-line), so a partial
//       task item can never half-appear in the inline preview card. Falls
//       back to a whitespace-boundary clip only for a single over-long line
//       with no newline in range (no task item to bisect there).
//
// Loaded as a plain script before dev-chat.js (see public/index.html); the
// browser gets the functions as globals, Node gets module.exports.

'use strict';

// Split streamed markdown into the completed prefix (safe to parse) and the
// trailing in-progress line (held back as plaintext). The split point is the
// LAST newline: a line is only "complete" once its terminating newline has
// arrived, which is exactly when a `- [ ] item` line can be trusted to be a
// task item rather than a `- [` fragment mid-keystroke.
function splitStreamingMarkdown(fullText) {
  var text = fullText == null ? '' : String(fullText);
  var nl = text.lastIndexOf('\n');
  if (nl === -1) {
    return { committed: '', tail: text };
  }
  return { committed: text.slice(0, nl + 1), tail: text.slice(nl + 1) };
}

// Render streamed markdown with the trailing incomplete line held back.
// `renderMarkdown(committed)` produces sanitized HTML for the finished
// portion; the in-progress tail is appended as an escaped-plaintext node so
// it shows as the literal characters typed so far (no premature checkbox,
// heading, fence, or table). Returns the combined HTML string.
function renderStreamingHtml(fullText, renderMarkdown, escapeHtml) {
  var parts = splitStreamingMarkdown(fullText);
  var html = parts.committed ? renderMarkdown(parts.committed) : '';
  if (parts.tail) {
    html += '<span class="dc-streaming-tail">' + escapeHtml(parts.tail) + '</span>';
  }
  return html;
}

// Clip a spec-preview snippet to whole lines so a partial task item never
// half-appears in the inline card. When the text is longer than `maxLen` we
// keep only the lines that fully fit (up to the last newline within range)
// and append the existing `…` marker on its own line. If the very first line
// already exceeds `maxLen` (a single long paragraph, no task item to
// bisect), fall back to the legacy whitespace-boundary clip.
function clipSpecSnippet(text, maxLen) {
  var src = text == null ? '' : String(text);
  var limit = typeof maxLen === 'number' && maxLen > 0 ? maxLen : 200;
  if (src.length <= limit) return src;

  var cut = src.slice(0, limit);
  var nl = cut.lastIndexOf('\n');
  if (nl > 0) {
    // Whole-line clip: src.slice(0, nl) ends exactly on an original line
    // boundary, so every line it contains is a complete original line — a
    // truncated `- [ ]` can never survive here.
    return src.slice(0, nl) + '\n…';
  }

  // No newline in range — a single over-long line. There's no task item to
  // bisect, so preserve the old whitespace-boundary behaviour.
  var sp = cut.lastIndexOf(' ');
  if (sp > limit * 0.8) cut = cut.slice(0, sp);
  return cut + '…';
}

// Node (tests) — browsers just get the globals above.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { splitStreamingMarkdown, renderStreamingHtml, clipSpecSnippet };
}
