'use strict';

// Replaying a session transcript as the Mayor's message history, and the
// harness-only completion marker that history uses.
//
// Moved verbatim out of routes/sessions.js (#2779) so the Mayor turn can run
// for a conversation that is not one change (see docs/agent-sessions.md).
// The classic dev-chat route, headless runs and interrupted-turn recovery
// import it from here; routes/sessions.js re-exports it for existing callers.

const attachmentsSvc = require('../attachments');
const log = require('../logger');

// The synthetic label the harness folds a REAL coding-agent run under
// when replaying history into the Mayor's context (see buildMayorMessages
// below). It is reserved for the harness — the system prompt forbids the
// Mayor from ever typing it, and stripFakeCompletionMarker enforces that
// server-side. Centralized so the generator, the scrub, and the system
// prompt can't drift apart.
const CODING_AGENT_COMPLETED_MARKER = '[CODING AGENT COMPLETED]';

const COMPLETION_MARKER_RE = /\[CODING AGENT COMPLETED\][\s\S]*$/i;

// Defense in depth (#358): remove a hallucinated completion marker (and
// anything after it) from Mayor-authored text. The marker is ONLY ever
// legitimately produced by buildMayorMessages from a ccOutput system row,
// so it must never survive in a persisted assistant row — if the Mayor
// reproduces it, it is faking a coding-agent run that never happened. Pure
// + trims; returns the input unchanged when no marker is present. Pass
// sessionId to have the (rare) regression logged.
function stripFakeCompletionMarker(text, { sessionId } = {}) {
  if (typeof text !== 'string') return '';
  // Fast path: most Mayor turns never contain the marker, so bail early.
  if (!COMPLETION_MARKER_RE.test(text)) return text;
  if (sessionId) {
    log.warn('sessions', 'Mayor wrote fake [CODING AGENT COMPLETED] without a real run — stripping', {
      sessionId, preview: text.substring(0, 300),
    });
  }
  return text.replace(COMPLETION_MARKER_RE, '').trim();
}

// Build the Mayor's message history from chat_session_messages rows.
// Folds each CC output (persisted as a system row with metadata.ccOutput)
// into the preceding assistant turn with a [CODING AGENT COMPLETED] tag
// so the Mayor knows what got built previously without us having to feed
// it as a synthetic user message. Merges consecutive assistant rows
// (which now happen routinely — phase-1 plan + phase-2 summary per
// tool-use turn) so Anthropic's alternating-roles contract is preserved.
function buildMayorMessages(history, attachmentsByMessageId = new Map()) {
  const CC_SUMMARY_MAX = 2000;
  const messages = [];
  const pushAssistant = (text) => {
    if (messages.length && messages[messages.length - 1].role === 'assistant') {
      messages[messages.length - 1].content += `\n\n${text}`;
    } else {
      messages.push({ role: 'assistant', content: text });
    }
  };

  // #450: image replay plan. Only user turns within the replay window
  // re-send their images as vision blocks (all-or-nothing per turn, max
  // total per request); older turns degrade to a textual placeholder.
  // Text-file attachments are inlined for ALL turns, consistent with the
  // uncapped text history replay.
  const userRows = history.filter((r) => r.role === 'user');
  const imageCounts = userRows.map((r) => (
    (attachmentsByMessageId.get(r.id) || []).filter((a) => a.kind === 'image').length
  ));
  const includeImagesPlan = attachmentsSvc.planImageInclusion(imageCounts);
  const includeByRowId = new Map(userRows.map((r, i) => [r.id, includeImagesPlan[i]]));

  for (const row of history) {
    if (row.role === 'system' && row.metadata?.ccOutput) {
      const summary = String(row.metadata.ccOutput).slice(0, CC_SUMMARY_MAX);
      // Outcome-aware label (#358): only a run that actually changed code is
      // folded under the "COMPLETED" marker. No-op / error runs carry a
      // distinct label so the Mayor doesn't see (and imitate) a "completed"
      // entry for work that never landed. Rows without ccOutcome — legacy
      // history and the staging seeds — keep the legacy completed label.
      const outcome = row.metadata.ccOutcome;
      const label = outcome === 'no_changes'
        ? '[CODING AGENT RAN — NO CHANGES]'
        : outcome === 'error'
          ? '[CODING AGENT FAILED]'
          : CODING_AGENT_COMPLETED_MARKER;
      pushAssistant(`${label}:\n${summary}`);
    } else if (row.role === 'assistant') {
      if (row.metadata?.handoffSummary) {
        // A native CLI handoff summary was authored by the local coding
        // agent, not by this Mayor. Label it in model context (while keeping
        // the stored/web-visible transcript clean) so a later web Dev turn
        // understands which local phase already happened and does not mistake
        // the summary for its own conversational reply.
        const phase = row.metadata.phase ? ` — ${String(row.metadata.phase).slice(0, 64)}` : '';
        pushAssistant(`[LOCAL AGENT HANDOFF${phase}]\n${row.content}`);
      } else {
        pushAssistant(row.content);
      }
    } else if (row.role === 'user') {
      // #450: rows with attachments become content-block arrays (image
      // blocks + one text block); plain rows stay strings. Assistant-row
      // merging above only ever touches strings, so this is safe.
      const atts = attachmentsByMessageId.get(row.id) || [];
      messages.push({
        role: 'user',
        content: attachmentsSvc.buildUserMessageContent({
          text: row.content,
          attachments: atts,
          includeImages: includeByRowId.get(row.id) === true,
        }),
      });
    }
  }
  return messages;
}

module.exports = {
  CODING_AGENT_COMPLETED_MARKER,
  COMPLETION_MARKER_RE,
  stripFakeCompletionMarker,
  buildMayorMessages,
};
