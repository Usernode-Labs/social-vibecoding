'use strict';

const REDUCER_VERSION = 10;

// Domain state and guards remain separate from persistence and external I/O.
function reduce(state, action, facts) {
  const preparation = require('./actions').isPreparationRequest(action)
    || action.type === 'RequestCandidatePreview';
  if (preparation && state.cliAdmission && (action.type !== 'RequestCandidatePreview'
      || action.actionId !== state.cliAdmission.actionId || action.headSha !== state.cliAdmission.headSha)) {
    return {
      accepted: false,
      reason: 'durable_owner_required',
      flow: state.flow,
      projection: 'unchanged',
      effects: [],
    };
  }
  return require('./candidate-reducer').reduceCandidate(state, action, facts);
}

function replayDecision(entry) {
  if (entry.reducer_version !== REDUCER_VERSION) {
    throw new Error(`Unsupported preview-flow reducer version: ${entry.reducer_version}; use the offline historical archive`);
  }
  return reduce(entry.pre_state, entry.action, entry.facts);
}

module.exports = {
  reduce,
  replayDecision,
  REDUCER_VERSION,
};
