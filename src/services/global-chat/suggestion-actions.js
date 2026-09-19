'use strict';

// Fixed suggestion and inline-result buttons resolve here, on the server, to
// exact read-only capabilities. The browser supplies only an allowlisted
// action id plus bounded object identifiers; it never supplies a route,
// method, capability id, renderer, or Classic path.

const inventory = require('./classic-inventory.generated.json');
const {
  directActionIdForSuggestion,
  suggestionLabelForId,
} = require('./presentation');

const ACTION_ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;
const APP_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NUMERIC_ID_RE = /^[1-9]\d{0,18}$/;
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const SETTING_KEYS = new Set(inventory.settings.map((item) => item.key));
const COMPACT_APP_QUERY = Object.freeze([{ name: 'view', value: 'global-chat' }]);

class SuggestionActionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SuggestionActionError';
    this.code = code;
  }
}

function routeCapability(method, path) {
  const route = inventory.routes.find((item) => (
    item.status === 'mapped' && item.method === method && item.path === path
  ));
  if (!route) throw new Error(`Global Chat direct action route is missing: ${method} ${path}`);
  return route.capabilityId;
}

function routeStep(method, path, pathParameters = {}, query = []) {
  return {
    capabilityId: routeCapability(method, path),
    input: { pathParameters, query, bodyJson: null },
  };
}

function manualStep(capabilityId, input = {}) {
  return { capabilityId, input };
}

function noParameters(value) {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) {
    throw new SuggestionActionError('invalid_direct_action', 'This action does not accept parameters.');
  }
  return {};
}

function exactParameters(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SuggestionActionError('invalid_direct_action', 'Action parameters are required.');
  }
  const keys = Object.keys(value);
  const expected = Object.keys(fields);
  if (keys.length !== expected.length || keys.some((key) => !Object.hasOwn(fields, key))) {
    throw new SuggestionActionError('invalid_direct_action', 'Action parameters are invalid.');
  }
  const out = {};
  for (const [key, pattern] of Object.entries(fields)) {
    const text = String(value[key] ?? '');
    if (!pattern.test(text)) {
      throw new SuggestionActionError('invalid_direct_action', `Action parameter ${key} is invalid.`);
    }
    out[key] = text;
  }
  return out;
}

function settingParameters(value) {
  const result = exactParameters(value, { group: /^[a-z][a-z0-9-]{0,63}$/ });
  if (!SETTING_KEYS.has(result.group)) {
    throw new SuggestionActionError('invalid_direct_action', 'That settings group is unavailable.');
  }
  return result;
}

function fixed({ label, message, domain, steps }) {
  return Object.freeze({
    label,
    message,
    domain,
    parameters: noParameters,
    steps: () => steps,
  });
}

const ACTIONS = Object.freeze({
  'work.overview': fixed({
    label: 'Show my work',
    message: 'Here is your current work.',
    domain: 'development',
    steps: [
      routeStep('GET', '/api/me/active-sessions'),
      manualStep('governance.mine'),
    ],
  }),
  'apps.list': fixed({
    label: 'Explore apps',
    message: 'Here are the apps you can access.',
    domain: 'apps',
    steps: [routeStep('GET', '/api/apps', {}, COMPACT_APP_QUERY)],
  }),
  'apps.activity': fixed({
    label: 'Recent app activity',
    message: 'Here are your apps with their recent activity.',
    domain: 'apps',
    steps: [manualStep('apps.activity')],
  }),
  'issues.choose_app': fixed({
    label: 'Open issues',
    message: 'Choose an app to view its issues.',
    domain: 'issues',
    steps: [routeStep('GET', '/api/apps', {}, COMPACT_APP_QUERY)],
  }),
  'development.active': fixed({
    label: 'Active development',
    message: 'Here is your active development work.',
    domain: 'development',
    steps: [routeStep('GET', '/api/me/active-sessions')],
  }),
  'development.continue': fixed({
    label: 'Continue work',
    message: 'Choose development work to continue.',
    domain: 'development',
    steps: [routeStep('GET', '/api/me/active-sessions')],
  }),
  'development.status': fixed({
    label: 'Check status',
    message: 'Choose development work to inspect.',
    domain: 'development',
    steps: [routeStep('GET', '/api/me/active-sessions')],
  }),
  'governance.mine': fixed({
    label: 'Review proposals',
    message: 'Here are your current proposals.',
    domain: 'governance',
    steps: [manualStep('governance.mine')],
  }),
  'messages.recent': fixed({
    label: 'Recent conversations',
    message: 'Here are your recent conversations.',
    domain: 'messages',
    steps: [routeStep('GET', '/api/conversations')],
  }),
  'messages.unread': fixed({
    label: 'Unread messages',
    message: 'Here are your conversations with unread messages.',
    domain: 'messages',
    steps: [manualStep('messages.unread')],
  }),
  'messages.overview': fixed({
    label: 'Check messages',
    message: 'Here are your unread conversations and recent notifications.',
    domain: 'messages',
    steps: [
      manualStep('messages.unread'),
      routeStep('GET', '/api/notifications', {}, [{ name: 'limit', value: '20' }]),
    ],
  }),
  'messages.choose_app': fixed({
    label: 'App discussions',
    message: 'Choose an app to view its discussions.',
    domain: 'messages',
    steps: [routeStep('GET', '/api/apps', {}, COMPACT_APP_QUERY)],
  }),
  'notifications.list': fixed({
    label: 'Notifications',
    message: 'Here are your recent notifications.',
    domain: 'messages',
    steps: [routeStep('GET', '/api/notifications', {}, [{ name: 'limit', value: '20' }])],
  }),
  'settings.global_chat': fixed({
    label: 'Chat settings',
    message: 'Here are your Global Chat settings.',
    domain: 'settings',
    steps: [manualStep('settings.inspect', { group: 'global-chat' })],
  }),
  'settings.development': fixed({
    label: 'Development AI',
    message: 'Here are your Development AI settings.',
    domain: 'settings',
    steps: [manualStep('settings.inspect', { group: 'openrouter' })],
  }),
  'settings.spending': fixed({
    label: 'AI spending',
    message: 'Here is your Global Chat usage and spending limit.',
    domain: 'settings',
    steps: [manualStep('settings.spending')],
  }),
  'settings.notifications': fixed({
    label: 'Notification settings',
    message: 'Here are your notification settings.',
    domain: 'settings',
    steps: [manualStep('settings.inspect', { group: 'alerts' })],
  }),
  'settings.catalog': fixed({
    label: 'Open settings',
    message: 'Choose a settings group.',
    domain: 'settings',
    steps: [manualStep('settings.catalog')],
  }),
  'settings.inspect': Object.freeze({
    label: 'View setting', message: 'Here are the current settings for this group.', domain: 'settings',
    parameters: settingParameters,
    steps: ({ group }) => [manualStep('settings.inspect', { group })],
  }),
  'profile.me': fixed({
    label: 'View my profile',
    message: 'Here is your profile.',
    domain: 'general',
    steps: [routeStep('GET', '/api/me/public-profile')],
  }),
  'leaderboard.users': fixed({
    label: 'View leaderboard',
    message: 'Here is the leaderboard.',
    domain: 'general',
    steps: [routeStep('GET', '/api/leaderboard/users')],
  }),

  // Inline result actions. These carry exact ids from an authoritative result
  // and remain read-only; writes continue through the model + confirmation
  // path until a dedicated fixed action defines every required input.
  'apps.detail': Object.freeze({
    label: 'App details', message: 'Here are the app details.', domain: 'apps',
    parameters: (value) => exactParameters(value, { appSlug: APP_SLUG_RE }),
    steps: ({ appSlug }) => [routeStep('GET', '/api/apps/:slug', { slug: appSlug })],
  }),
  'issues.for_app': Object.freeze({
    label: 'App issues', message: 'Here are the issues for this app.', domain: 'issues',
    parameters: (value) => exactParameters(value, { appSlug: APP_SLUG_RE }),
    steps: ({ appSlug }) => [
      routeStep('GET', '/api/apps/:slug/issues', { slug: appSlug }),
      routeStep('GET', '/api/apps/:slug/github-issues', { slug: appSlug }),
    ],
  }),
  'development.for_app': Object.freeze({
    label: 'App development', message: 'Here is the development work for this app.', domain: 'development',
    parameters: (value) => exactParameters(value, { appSlug: APP_SLUG_RE }),
    steps: ({ appSlug }) => [routeStep('GET', '/api/apps/:slug/sessions', { slug: appSlug })],
  }),
  'governance.for_app': Object.freeze({
    label: 'App proposals', message: 'Here are the proposals for this app.', domain: 'governance',
    parameters: (value) => exactParameters(value, { appSlug: APP_SLUG_RE }),
    steps: ({ appSlug }) => [routeStep('GET', '/api/apps/:slug/promoted', { slug: appSlug })],
  }),
  'messages.for_app': Object.freeze({
    label: 'App discussions', message: 'Here are the discussions for this app.', domain: 'messages',
    parameters: (value) => exactParameters(value, { appSlug: APP_SLUG_RE }),
    steps: ({ appSlug }) => [manualStep('messages.for_app', { appSlug })],
  }),
  'issue.detail': Object.freeze({
    label: 'Issue details', message: 'Here are the issue details.', domain: 'issues',
    parameters: (value) => exactParameters(value, {
      appSlug: APP_SLUG_RE, issueNumber: NUMERIC_ID_RE,
    }),
    steps: ({ appSlug, issueNumber }) => [routeStep(
      'GET', '/api/apps/:slug/github-issues/:number',
      { slug: appSlug, number: issueNumber },
    )],
  }),
  'issue.comments': Object.freeze({
    label: 'Issue comments', message: 'Here are the issue comments.', domain: 'issues',
    parameters: (value) => exactParameters(value, {
      appSlug: APP_SLUG_RE, issueNumber: NUMERIC_ID_RE,
    }),
    steps: ({ appSlug, issueNumber }) => [routeStep(
      'GET', '/api/apps/:slug/github-issues/:number/comments',
      { slug: appSlug, number: issueNumber },
    )],
  }),
  'governance.detail': Object.freeze({
    label: 'Governance details', message: 'Here are the governance item details.', domain: 'governance',
    parameters: (value) => exactParameters(value, {
      appSlug: APP_SLUG_RE, governanceId: NUMERIC_ID_RE,
    }),
    steps: ({ appSlug, governanceId }) => [routeStep(
      'GET', '/api/apps/:slug/governance/:id',
      { slug: appSlug, id: governanceId },
    )],
  }),
  'proposal.detail': Object.freeze({
    label: 'Proposal details', message: 'Here are the proposal details.', domain: 'governance',
    parameters: (value) => exactParameters(value, {
      appSlug: APP_SLUG_RE, proposalId: NUMERIC_ID_RE,
    }),
    steps: ({ appSlug, proposalId }) => [routeStep(
      'GET', '/api/apps/:slug/proposals/:id',
      { slug: appSlug, id: proposalId },
    )],
  }),
  'proposal.evidence': Object.freeze({
    label: 'Proposal evidence', message: 'Here is the proposal evidence.', domain: 'governance',
    parameters: (value) => exactParameters(value, {
      appSlug: APP_SLUG_RE, proposalId: NUMERIC_ID_RE,
    }),
    steps: ({ appSlug, proposalId }) => [routeStep(
      'GET', '/api/apps/:slug/proposals/:sessionId/evidence',
      { slug: appSlug, sessionId: proposalId },
    )],
  }),
  'session.detail': Object.freeze({
    label: 'Development details', message: 'Here are the development details.', domain: 'development',
    parameters: (value) => exactParameters(value, { sessionId: NUMERIC_ID_RE }),
    steps: ({ sessionId }) => [routeStep('GET', '/api/sessions/:id/details', { id: sessionId })],
  }),
  'session.checks': Object.freeze({
    label: 'Development checks', message: 'Here are the development checks.', domain: 'development',
    parameters: (value) => exactParameters(value, { sessionId: NUMERIC_ID_RE }),
    steps: ({ sessionId }) => [routeStep('GET', '/api/sessions/:id/checks', { id: sessionId })],
  }),
  'conversation.detail': Object.freeze({
    label: 'Conversation details', message: 'Here are the conversation details.', domain: 'messages',
    parameters: (value) => exactParameters(value, { conversationId: NUMERIC_ID_RE }),
    steps: ({ conversationId }) => [routeStep('GET', '/api/conversations/:id', { id: conversationId })],
  }),
  'notification.detail': Object.freeze({
    label: 'Notification details', message: 'Here are the notification details.', domain: 'messages',
    parameters: (value) => exactParameters(value, { notificationId: NUMERIC_ID_RE }),
    steps: ({ notificationId }) => [routeStep(
      'GET', '/api/notifications/:id', { id: notificationId },
    )],
  }),
  'leaderboard.profile': Object.freeze({
    label: 'Profile', message: 'Here is the leaderboard profile.', domain: 'general',
    parameters: (value) => exactParameters(value, { userId: NUMERIC_ID_RE }),
    steps: ({ userId }) => [routeStep(
      'GET', '/api/v4/users/:userId/profile', { userId },
    )],
  }),
  'leaderboard.prs': Object.freeze({
    label: 'Merged work', message: 'Here is this contributor’s merged work.', domain: 'general',
    parameters: (value) => exactParameters(value, { username: USERNAME_RE }),
    steps: ({ username }) => [routeStep(
      'GET', '/api/leaderboard/users/:username/prs', { username },
    )],
  }),
});

function resolveAction({ suggestionId = null, actionId = null, parameters = null } = {}) {
  let resolvedActionId = actionId;
  let suggestionLabel = null;
  if (suggestionId != null) {
    if (typeof suggestionId !== 'string') {
      throw new SuggestionActionError('invalid_direct_action', 'Suggestion id is invalid.');
    }
    resolvedActionId = directActionIdForSuggestion(suggestionId);
    suggestionLabel = suggestionLabelForId(suggestionId);
  }
  if (typeof resolvedActionId !== 'string' || !ACTION_ID_RE.test(resolvedActionId)) {
    throw new SuggestionActionError('direct_action_not_found', 'That option requires Global Chat.');
  }
  const definition = ACTIONS[resolvedActionId];
  if (!definition) {
    throw new SuggestionActionError('direct_action_not_found', 'That direct action is unavailable.');
  }
  const normalized = definition.parameters(parameters);
  const steps = definition.steps(normalized);
  if (!Array.isArray(steps) || !steps.length || steps.length > 5) {
    throw new SuggestionActionError('invalid_direct_action', 'That direct action is invalid.');
  }
  return {
    id: resolvedActionId,
    label: suggestionLabel || definition.label,
    message: definition.message,
    domain: definition.domain,
    parameters: normalized,
    steps,
  };
}

module.exports = {
  ACTIONS,
  SuggestionActionError,
  resolveAction,
  routeCapability,
};
