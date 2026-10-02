'use strict';

const REDUCER_VERSION = 2;

function returnCondition(state, action, facts) {
  const session = state.session;
  if (!session || session.headless) return 'not_found';
  if (session.userId !== action.userId) {
    return ['promoted', 'merging', 'merged'].includes(session.status) ? 'forbidden' : 'not_found';
  }
  if (action.type === 'RequestImportedReturnToDevelopment' && session.source !== 'imported') {
    return 'native_execution_not_enrolled';
  }
  if (session.status === 'active' || session.status === 'paused') return null;
  if (session.status === 'merging' || session.status === 'merged') return 'merging';
  if (session.status !== 'promoted') return 'closed';
  if (facts.busyNow || session.turnRunning) return 'busy';
  if (state.pendingSecret) return 'pending_secret';
  return null;
}

function announceReturn(state, action) {
  const original = state.sourceReturn;
  const effect = original?.effects.find(value => value.type === 'AnnounceReturnToDevelopment');
  let reason = null;
  if (!state.session) reason = 'not_found';
  else if (!original?.accepted || original.reason !== 'returned_to_development'
      || !effect || effect.causedBy !== action.returnActionId || effect.sessionId !== action.sessionId) {
    reason = 'return_receipt_missing';
  } else if (effect.appId !== state.session.appId) reason = 'announcement_project_changed';
  if (reason) return { accepted: false, reason, change: null, effects: [] };
  if (state.returnAnnouncementId) {
    return { accepted: true, reason: 'already_announced', change: null, effects: [] };
  }

  const label = effect.prNumber
    ? (effect.prTitle ? `PR #${effect.prNumber}: ${effect.prTitle}` : `PR #${effect.prNumber}`)
    : `Proposal #${effect.sessionId}`;
  return {
    accepted: true,
    reason: 'return_announcement_authorized',
    change: null,
    effects: [],
    announcement: {
      appId: effect.appId,
      sessionId: action.sessionId,
      returnActionId: action.returnActionId,
      content: `${effect.actorUsername || 'The author'} moved ${label} back to Underway. Its votes were cleared, and it goes up for a fresh vote when it is proposed again`,
    },
  };
}

function reduce(state, action, facts) {
  if (action.type === 'RequestReturnAnnouncement') return announceReturn(state, action);
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
    throw new Error(`Unsupported proposal-review reducer version: ${entry.reducer_version}; use the offline historical archive`);
  }
  return reduce(entry.pre_state, entry.action, entry.facts);
}

module.exports = { reduce, returnCondition, replayDecision, REDUCER_VERSION };
