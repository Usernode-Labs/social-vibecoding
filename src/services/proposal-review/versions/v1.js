'use strict';

const REDUCER_VERSION = 1;

function returnCondition(state, action, facts) {
  const session = state.session;
  if (!session || session.headless) return 'not_found';
  if (session.userId !== action.userId) {
    return ['promoted', 'merging', 'merged'].includes(session.status) ? 'forbidden' : 'not_found';
  }
  if (session.status === 'active' || session.status === 'paused') return null;
  if (session.status === 'merging' || session.status === 'merged') return 'merging';
  if (session.status !== 'promoted') return 'closed';
  if (facts.busyNow || session.turnRunning) return 'busy';
  if (state.pendingSecret) return 'pending_secret';
  return null;
}

function reduce(state, action, facts) {
  const condition = returnCondition(state, action, facts);
  if (condition) return { accepted: false, reason: condition, change: null, effects: [] };

  const session = state.session;
  if (session.status === 'active' || session.status === 'paused') {
    return { accepted: true, reason: 'already_underway', change: null, effects: [] };
  }
  const status = session.source === 'imported' ? 'active' : 'paused';
  const change = { status, approvalEpoch: session.approvalEpoch + 1 };
  const effects = [];
  if (session.source !== 'imported') {
    effects.push({
      type: 'StopDevelopmentWorker',
      effectKey: `${action.actionId}:stop-worker`,
      causedBy: action.actionId,
      sessionId: action.sessionId,
    });
  }
  effects.push({
    type: 'AnnounceReturnToDevelopment',
    effectKey: `${action.actionId}:announce`,
    causedBy: action.actionId,
    sessionId: action.sessionId,
    appId: session.appId,
    appSlug: state.appSlug,
    prNumber: session.prNumber,
    prTitle: session.prTitle,
    actorUsername: action.actorUsername,
    status,
  });
  return { accepted: true, reason: 'returned_to_development', change, effects };
}

function replayDecision(entry) {
  if (entry.reducer_version !== REDUCER_VERSION) {
    throw new Error(`Unsupported proposal review reducer version: ${entry.reducer_version}`);
  }
  return reduce(entry.pre_state, entry.action, entry.facts);
}

module.exports = { reduce, returnCondition, replayDecision, REDUCER_VERSION };
