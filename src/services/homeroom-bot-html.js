'use strict';

// Formatted replies (task 2020, from the owner's task-assistant v1): the
// Homeroom bot's chat answer may come laid out as a small HTML fragment
// (short headings, lists, steps, a table, option cards, a timeline, a small
// inline SVG diagram) beside its plain words.
//
//   reply { text, html? }  →  message.content = text
//                             message.metadata.homeroomBot.html = html
//
// The words stay the message. Everything that reads a message's text keeps
// reading them: the push, the bell and the email (homeroom-bot-notify-copy),
// tap-to-translate, search, the inbox preview, Copy, and the model's own
// history. Only the chat draws the fragment, in place of the words
// (frontend/src/features/messages/bot-html.tsx): cleaned there with the
// vendored DOMPurify, in a frame with scripts off whose content security
// policy loads nothing, coloured by the chat's own tokens.
//
// The server holds no HTML parser (spec-html.js says why it needs none), so
// this side only bounds what is stored: a string with markup in it, no
// wrapper fence, no invisible characters, no em dash, under a size. The
// cleaning that keeps a reader safe is the browser's, against an allowlist,
// in a frame that runs no script; what is stored is never drawn anywhere
// else.

const { stripInvisible, decodeEntities } = require('./spec-html');
const { withoutEmDashes } = require('./em-dashes');

// About 7,500 tokens: room for a long answer's table or timeline inside one
// round (bot-profiles CHAT_LIMITS.outputTokens), with the text beside it.
const MAX_REPLY_HTML_CHARS = 30000;

// ```html … ``` around the whole fragment: the model's habit with code.
const FENCE_RE = /^([`~]{3,})[ \t]*(?:html?)?[ \t]*\n([\s\S]*?)\n\1[`~]*\s*$/i;
// Some markup: an element's opening tag.
const TAG_RE = /<[a-z][a-z0-9-]*(?:\s[^>]*)?\/?>/i;

/**
 * Pure: the fragment a reply's `html` argument stores, or null when there is
 * none to store (not a string, empty, no markup in it, or too long: a cut
 * fragment would be broken markup, so it is dropped and the words are drawn).
 */
function cleanReplyHtml(value) {
  if (typeof value !== 'string') return null;
  let html = stripInvisible(value).trim();
  const fenced = FENCE_RE.exec(html);
  if (fenced) html = fenced[2].trim();
  if (!html || html.length > MAX_REPLY_HTML_CHARS || !TAG_RE.test(html)) return null;
  return withoutEmDashes(html);
}

/**
 * Pure: the words a fragment shows, as one string, for the checks a reply's
 * words go through (reply-claims.js checkReply): its styles, any
 * script and comments left out, every tag a space, entities read.
 */
function htmlWords(html) {
  if (typeof html !== 'string' || !html) return '';
  const words = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(style|script|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(words).replace(/\s+/g, ' ').trim();
}

/** Pure: a reply's words with the words its laid-out copy shows after them, for the claim checks. */
function withHtmlWords(said, html) {
  const shown = html ? htmlWords(html) : '';
  const text = String(said ?? '');
  return shown ? `${text}\n\n${shown}` : text;
}

// How the reply's `html` is written: the reply tool's field, in the chat
// (homeroom-bot-mayor.js) and in a project's threads (homeroom-bot-voice.js).
// The chat draws it in place of the words, in a frame with scripts off that
// loads nothing, with these colour names set to its own tokens for light and
// dark (frontend/src/features/messages/bot-html.tsx REPLY_TOKENS).
const REPLY_HTML_DESCRIPTION = [
  'For any reply longer than two short lines: the same answer, laid out, as an HTML fragment. The chat shows it in',
  'place of text. Use what fits: short headings, short paragraphs, lists, steps, a table, option cards, a timeline or',
  `a small inline SVG diagram. Self-contained and under ${MAX_REPLY_HTML_CHARS} characters: no scripts (they never run), no buttons or`,
  'forms (nothing in it can be tapped but a link), no images, fonts or anything else from another address. Styles',
  'inline or in one <style> block, and colours only as var(--ink) var(--ink-2) var(--muted) var(--line)',
  'var(--surface) var(--surface-2) var(--accent) var(--accent-tint) var(--green) var(--red) var(--orange), so it',
  'follows light and dark mode. It is drawn 280 to 680 px wide: it must read well on a phone. Calm: mostly neutral,',
  'one accent at most, the font the chat gives it. A link only as a short labelled <a href>, to a link a tool',
  'returned, never a raw address. It says exactly what text says, no more: text stays the plain version that',
  'notifications, search and translation read. Small talk, short answers and a line under a draft have no html.',
].join(' ');

module.exports = {
  MAX_REPLY_HTML_CHARS,
  REPLY_HTML_DESCRIPTION,
  cleanReplyHtml,
  htmlWords,
  withHtmlWords,
};
