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
  if (entry.reducer_version === 1) {
    return require('./versions/v1').reduce(entry.pre_state, entry.action, entry.facts);
  }
  if (entry.reducer_version === 2) {
    return require('./versions/v2').reduce(entry.pre_state, entry.action, entry.facts);
  }
  if (entry.reducer_version === 3) {
    return require('./versions/v3').reduce(entry.pre_state, entry.action, entry.facts);
  }
  if (entry.reducer_version === 4) {
    return require('./versions/v4').reduce(entry.pre_state, entry.action, entry.facts);
  }
  if (entry.reducer_version === 5) {
    return require('./versions/v5').reduce(entry.pre_state, entry.action, entry.facts);
  }
  if (entry.reducer_version === 6) {
    return require('./versions/v6').reduce(entry.pre_state, entry.action, entry.facts);
  }
  if (entry.reducer_version === 7) {
    return require('./versions/v7').reduce(entry.pre_state, entry.action, entry.facts);
  }
  if (entry.reducer_version === 8) {
    return require('./versions/v8').reduce(entry.pre_state, entry.action, entry.facts);
  }
  if (entry.reducer_version === 9) {
    return require('./versions/v9').reduce(entry.pre_state, entry.action, entry.facts);
  }
  if (entry.reducer_version === REDUCER_VERSION) {
    return reduce(entry.pre_state, entry.action, entry.facts);
  }
  throw new Error(`Unsupported preview reducer version: ${entry.reducer_version}`);
}

module.exports = {
  reduce,
  replayDecision,
  REDUCER_VERSION,
};
