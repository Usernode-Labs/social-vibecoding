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

module.exports = { agentApiFailure, describeAgentApiFailure };
