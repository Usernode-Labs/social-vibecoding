'use strict';

// Guards that keep a Mayor reply from ending silent: salvaging tool-only
// replies, the one-shot data-summary re-prompt and the empty-reply check.
//
// Moved verbatim out of routes/sessions.js (#2779) so the Mayor turn can run
// for a conversation that is not one change (see docs/agent-sessions.md).
// The classic dev-chat route, headless runs and interrupted-turn recovery
// import it from here; routes/sessions.js re-exports it for existing callers.


// Silent-turn salvage (session 2383): when the Mayor's reply is a lone
// suggest_answers/suggest_replies tool_use with NO text block, the
// content used to be dropped entirely (the persist path is text-gated)
// and the turn ended with nothing visible. Synthesize assistant text
// from the sanitized tool content instead: the questions become a
// numbered message the answer chips attach to; bare pills get a short
// generic line. Returns the original text untouched when it's non-empty,
// and '' when there's nothing to salvage (caller falls through to the
// generic empty-reply fallback). Exported for tests.
function salvageAssistantText(mayorText, suggestions, quickReplies) {
  if ((mayorText || '').trim()) return mayorText;
  if (Array.isArray(suggestions) && suggestions.length) {
    const labels = suggestions
      .map((s) => (s && typeof s.question === 'string' ? s.question.trim() : ''))
      .filter(Boolean);
    if (labels.length) {
      return labels.map((q, i) => `${i + 1}. ${q}`).join('\n');
    }
    // sanitizeSuggestedAnswers allows empty question labels when the
    // answers themselves survived — the chips still render, so anchor
    // them to a generic ask.
    return 'I have a couple of clarifying questions. Pick an answer below.';
  }
  if (Array.isArray(quickReplies) && quickReplies.length) {
    return 'What would you like to do next?';
  }
  return '';
}

// Data-informed silent turn (session 2426): the model serviced one or
// more read-only data tools this turn (get_prod_status in the observed
// incident), then ended with a tool-only reply — the findings it fetched
// would be discarded, since salvage can only anchor chips with a generic
// line, not reconstruct the findings. Worth ONE re-prompt: the tool
// results are still in the turn's conversation, so a short continuation
// telling the model to write the summary as text usually recovers the
// answer. Dispatch turns are excluded (needsEmptyReplyFallback) — a
// dispatch produces its own phase-2 wrap-up. Exported for tests.
function shouldRepromptForDataSummary(mayorText, toolUses, dataIters, rawContent) {
  if (!dataIters) return false;
  // The re-prompt replays the reply verbatim so its tool_use ids
  // resolve; without raw content there is nothing valid to replay.
  if (!Array.isArray(rawContent) || !rawContent.length) return false;
  return needsEmptyReplyFallback(mayorText, toolUses);
}

// The two messages a data-summary re-prompt appends to the phase-1
// conversation: the model's tool-only reply verbatim (so its tool_use
// ids resolve), then a user message that closes off EVERY dangling
// tool_use with a stub tool_result and instructs the model to write the
// summary as plain text. Closing all of them matters — the tool-only
// reply may carry suggest_replies AND a dangling data call (the
// data-loop cap break), and any unanswered tool_use is an Anthropic 400.
// Exported for tests.
function buildDataSummaryReprompt(rawContent, toolUses) {
  const calls = (Array.isArray(toolUses) ? toolUses : []).filter((t) => t && t.id);
  return [
    { role: 'assistant', content: rawContent },
    {
      role: 'user',
      content: [
        ...calls.map((tu) => ({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: 'Acknowledged.',
        })),
        {
          type: 'text',
          text: 'Your reply had no text, so the user saw nothing. In plain text, summarize what the data you fetched this turn showed and answer the user\'s question directly. Do not call any tools.',
        },
      ],
    },
  ];
}

// Explicit fallback for a data-informed turn whose re-prompt ALSO
// produced no text — the generic "What would you like to do next?"
// would mask that findings were fetched and lost. Exported for tests.
const DATA_SUMMARY_FALLBACK_TEXT = '_I fetched the data but failed to summarize it. Please ask again._';

// Would the turn end with nothing visible? True when no text survived
// (after salvage) AND no dispatch tool ran — a dispatch produces its own
// persisted statuses plus a guaranteed phase-2 wrap-up, so it never needs
// the fallback. Deliberately ignores whether OTHER tool_uses exist: a
// dangling data call (the data-loop cap break) or an unusable suggest
// call still leaves the user staring at silence. Exported for tests.
function needsEmptyReplyFallback(mayorText, toolUses) {
  if ((mayorText || '').trim()) return false;
  const calls = Array.isArray(toolUses) ? toolUses : [];
  return !calls.some((t) => t && (t.name === 'dispatch_claude_code' || t.name === 'dispatch_scout'));
}

module.exports = {
  salvageAssistantText,
  shouldRepromptForDataSummary,
  buildDataSummaryReprompt,
  DATA_SUMMARY_FALLBACK_TEXT,
  needsEmptyReplyFallback,
};
