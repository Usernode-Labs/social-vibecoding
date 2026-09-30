'use strict';

// Parsing for the "==== PLATFORM ISSUE ====" block an OpenRouter coding agent
// may put in its final message when the cause of a problem lies outside the
// app's repository:
//
//   ==== PLATFORM ISSUE ====
//   The bridge answers 401 in the preview
//   What is broken or missing, how the agent hit it, what the app needs.
//   ==== END PLATFORM ISSUE ====
//
// Why a block and not the helper. Claude Code turns on the platform's own
// model reach `usernode-report-platform-issue`, which posts a draft report
// card with the general worker token. An OpenRouter turn — Codex or Claude
// Code driving the user's OpenRouter model (#3296) — deliberately gets only
// a push-scoped token (worker.js buildTurnSecretEnv), and the route refuses
// it. That left those turns told to "escalate, don't work around" with no
// way to escalate, and Sheep countrr's bridge and stylesheet workarounds all
// came from such turns (usernode-bot/sheep-countrr-a08857#48). The platform
// now reads the block after the turn and files the same draft card itself
// (issue-draft.createDraft): the turn still holds no token that can write,
// and a person still taps the card before anything reaches the tracker.
//
// `extract` removes the block, so the raw markers never reach chat history,
// and returns its first line as the title and the rest as the body. It runs
// on the text the testing and description extractors have already cleaned.

const TITLE_MAX = 160;
const BODY_MAX = 10000;

// Same marker grammar as proposal-description.js: the exact upper-case label
// on its own line, fenced by `=` runs or markdown emphasis.
const OPEN_RE = markerRe('PLATFORM ISSUE');
const CLOSE_RE = markerRe('END PLATFORM ISSUE');

function markerRe(label) {
  return new RegExp(
    `^[ \\t]*(?=\\*\\*|__|=)(?:\\*\\*|__)?[ \\t]*(?:={2,}[ \\t]*)?${label}(?:[ \\t]*={2,})?[ \\t]*(?:\\*\\*|__)?[ \\t]*:?[ \\t]*$`,
    'gm',
  );
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// Find the LAST block in `text`, remove it, and return { cleanedText, issue }
// where issue is { title, body } or null (absent, or no title line).
function extract(text) {
  if (typeof text !== 'string' || !text) {
    return { cleanedText: typeof text === 'string' ? text : '', issue: null };
  }
  let open = null;
  OPEN_RE.lastIndex = 0;
  for (let m; (m = OPEN_RE.exec(text)) !== null; ) open = m;
  if (!open) return { cleanedText: text, issue: null };

  const blockStart = open.index + open[0].length;
  CLOSE_RE.lastIndex = blockStart;
  const close = CLOSE_RE.exec(text);
  const blockEnd = close ? close.index : text.length;
  const afterBlock = close ? close.index + close[0].length : text.length;

  const cleanedText = `${text.slice(0, open.index).trimEnd()}\n\n${text.slice(afterBlock).trim()}`.trim();
  const lines = text.slice(blockStart, blockEnd).split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  const title = (lines.shift() || '').trim()
    // "Title: …" and a markdown heading are the two shapes a model reaches for.
    .replace(/^#{1,6}\s+/, '')
    .replace(/^title\s*:\s*/i, '')
    .trim();
  const body = lines.join('\n').trim();
  if (!title) return { cleanedText, issue: null };
  return {
    cleanedText,
    issue: { title: clip(title, TITLE_MAX), body: clip(body, BODY_MAX) },
  };
}

module.exports = {
  extract,
  TITLE_MAX,
  BODY_MAX,
};
