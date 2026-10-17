'use strict';

// System rows whose content is a sentence, not markup.
//
// The dev chat has always drawn a system row's content as HTML, and every
// server line it shows was written for that. A sync's outcome is different:
// its sentence can carry a worker's reason (an agent's words, a file name a
// check left behind), so it is stored as plain text with metadata
// `plainText: true` (services/sync-main.js), and the shared transcript
// escapes it once like any other row.
//
// The owner's dev chat is the one place that renders a system row as HTML,
// and a tab opened before this shipped keeps that renderer across a deploy
// (the platform offers a reload, it does not force one). Such a tab reads
// `content` (from GET /api/sessions/:id) and a status event's `text`. So on
// those two transports a plain row's content goes HTML-escaped, which the
// old renderer shows once as the sentence, and the plain sentence rides
// beside it as `plainContent`, which a current dev chat draws as text
// (DevChat._asPlainText) and escapes once through React. The stored row
// stays plain: nothing re-escapes it, and nothing unescapes anything.
//
// Review round 4 of proposal 8758 (Codex) showed the old tab's renderer
// turning a refused sync's artifact name into a live <img onerror>.

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function isPlainTextRow(metadata) {
  return !!metadata && typeof metadata === 'object' && metadata.plainText === true;
}

// A stored message row as the owner's dev chat receives it.
function forOwnerHistory(row) {
  if (!row || row.role !== 'system' || typeof row.content !== 'string' || !isPlainTextRow(row.metadata)) return row;
  return { ...row, content: escapeHtml(row.content), plainContent: row.content };
}

// A live `status` event's payload for a row with this text and metadata.
function statusEvent(text, metadata) {
  const meta = metadata || {};
  if (!isPlainTextRow(meta)) return { text, ...meta };
  return { ...meta, text: escapeHtml(text), plainContent: String(text) };
}

module.exports = { escapeHtml, isPlainTextRow, forOwnerHistory, statusEvent };
