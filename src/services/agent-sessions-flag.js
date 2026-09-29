'use strict';

// The experimental agent-sessions flag (#2779), as pure functions so the
// auth middleware can read it without loading the agent-sessions service.
//
// users.agent_sessions_enabled is NULL until the user chooses. NULL follows
// the deployment default (config.agentSessionsDefault, AGENT_SESSIONS_DEFAULT);
// TRUE or FALSE is the user's own choice and wins over the default, so an
// opt-out survives the day the default flips for everyone.
//
// Who may make that choice is a separate question
// (config.agentSessionsOptIn, AGENT_SESSIONS_OPT_IN). The deployment default
// in config.js is every user; AGENT_SESSIONS_OPT_IN=admins closes it to
// admins again. canChoose() itself still reads a config that does not carry
// the key as admins-only, so a partial config fails closed.

function choiceOf(stored) {
  return stored === true || stored === false ? stored : null;
}

function effective(config, stored) {
  const choice = choiceOf(stored);
  if (choice !== null) return choice;
  return !!(config && config.agentSessionsDefault);
}

function canChoose(config, user) {
  if (!user) return false;
  const audience = config && config.agentSessionsOptIn === 'all' ? 'all' : 'admins';
  return audience === 'all' || !!user.isAdmin;
}

module.exports = { choiceOf, effective, canChoose };
