'use strict';

const REDUCER_VERSION = 5;

// Domain state and guards remain separate from persistence and external I/O.
function reduce(state, action, facts) {
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
