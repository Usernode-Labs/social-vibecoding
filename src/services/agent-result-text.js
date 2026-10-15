// #1204: an agent run that dies on the wire reports it in its final message,
// not its exit code. The detector, agentApiFailure, lives with the worker
// (worker/agent-api-failure.js), which reads it to decide whether to keep a
// Homeroom bot turn; the host, the CLI and the scout path read the same one.
const { agentApiFailure } = require('../../worker/agent-api-failure');

// One plain-terms sentence for the dev chat. Carries the runtime's own
// wording so the user (and the Mayor's wrap-up turn) can see what
// actually happened rather than a generic "something went wrong".
// Callers append what it means for their turn.
function describeAgentApiFailure(failure) {
  if (!failure) return '';
  return failure.kind === 'truncated'
    ? `The coding agent's API connection dropped mid-response, so its answer was cut off. ${failure.line}`
    : `The coding agent's API connection failed. ${failure.line}`;
}

// ── A final answer written in several pieces ───────────────────────────
//
// A turn's final message is what the runner reports as its result, and under
// Claude Code that is the LAST assistant message only. An answer that hits
// the model's output-token limit is continued by Claude Code itself in a new
// message, after a note telling the model to go on from where it was cut
// ("begin at the start of the line, table row, list item or sentence that
// was cut, writing it again in full", or "Resume directly ... pick up
// mid-thought"). The result then holds only the continuation: App bench run
// 9, trial 1246, stored the last 2,200 characters of a spec, starting at the
// start of a list item. The worker keeps every text block since the turn's
// last tool call (worker.js `answerParts`); this puts them back together.

// The shortest repeat taken for the continuation writing again the end of
// what was cut; anything shorter is as likely to be a coincidence.
const MIN_OVERLAP = 8;
const MAX_OVERLAP = 4000;

function commonPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

/** Two pieces of one answer, the second continuing the first. Pure. */
function joinContinuation(prev, next) {
  // The continuation wrote again exactly what was cut: the end of `prev`.
  for (let k = Math.min(prev.length, next.length, MAX_OVERLAP); k >= MIN_OVERLAP; k -= 1) {
    if (prev.endsWith(next.slice(0, k))) return prev + next.slice(k);
  }
  // It wrote the cut line again in full: the unfinished last line goes.
  const nl = prev.lastIndexOf('\n');
  const cut = prev.slice(nl + 1).trimStart();
  const again = next.trimStart();
  if (cut && commonPrefix(cut, again) >= Math.min(12, cut.length)) return prev.slice(0, nl + 1) + again;
  // It picked up mid-thought: as written, with a line break after a
  // finished sentence or tag, where one costs nothing.
  if (/\s$/.test(prev) || /^\s/.test(next) || !/[.!?:;)>]$/.test(prev)) return prev + next;
  return `${prev}\n${next}`;
}

/**
 * The whole final answer from its pieces (`parts`, oldest first), starting
 * at the first piece that opens a document (`opens`, when given: a piece
 * before it is narration, "Writing the spec now."; a later one that only
 * looks like an opening, a "# " comment in a code block, is part of it).
 * '' with none. Pure.
 */
function finalAnswerText(parts, { opens = null } = {}) {
  const list = (Array.isArray(parts) ? parts : []).filter((p) => typeof p === 'string' && p.length);
  if (!list.length) return '';
  const at = typeof opens === 'function' ? list.findIndex((p) => opens(p)) : 0;
  return list.slice(Math.max(at, 0)).reduce((acc, next) => joinContinuation(acc, next));
}

module.exports = { agentApiFailure, describeAgentApiFailure, finalAnswerText, joinContinuation };
