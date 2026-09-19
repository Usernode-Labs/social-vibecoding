'use strict';

// The model can choose text, existing result references, and five next-step
// suggestions. It cannot choose component code, Classic URLs, arbitrary
// actions, or the always-present More suggestions control; the server/client
// derive those from the capability registry.

const MAX_MESSAGE_CHARS = 600;
const MAX_RESULT_REFS = 5;
const SUGGESTIONS_PER_RESPONSE = 5;
const MAX_SUGGESTION_LABEL_CHARS = 36;
const MAX_SUGGESTION_PROMPT_CHARS = 500;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const CAPABILITY_ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;

class PresentationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PresentationError';
    this.code = code;
    this.details = details;
  }
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new PresentationError(
      'invalid_presentation',
      `${field} contains unsupported fields: ${unknown.join(', ')}`,
      { field, unknown },
    );
  }
}

function text(value, field, max, { optional = false } = {}) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new PresentationError(
      'invalid_presentation',
      `${field} must be a non-empty string up to ${max} characters`,
      { field },
    );
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new PresentationError(
      'invalid_presentation',
      `${field} contains control characters`,
      { field },
    );
  }
  return value.trim();
}

function id(value, field, pattern = ID_RE) {
  const normalized = text(value, field, 160);
  if (!pattern.test(normalized)) {
    throw new PresentationError('invalid_presentation', `${field} is invalid`, { field });
  }
  return normalized;
}

function normalizeKnownIds(value, field, maxItems) {
  const list = value == null ? [] : value;
  if (!(list instanceof Set) && !Array.isArray(list)) {
    throw new PresentationError('invalid_context', `${field} must be a Set or array`);
  }
  const out = new Set();
  for (const entry of list) {
    out.add(id(entry, field));
    if (out.size > maxItems) {
      throw new PresentationError('invalid_context', `${field} has too many entries`);
    }
  }
  return out;
}

function normalizeSuggestion(value, index) {
  const field = `suggestions[${index}]`;
  if (!plainObject(value)) {
    throw new PresentationError('invalid_presentation', `${field} must be an object`, { field });
  }
  assertExactKeys(value, new Set(['id', 'label', 'prompt', 'capabilityHint']), field);
  const label = text(value.label, `${field}.label`, MAX_SUGGESTION_LABEL_CHARS);
  if (/\r|\n/.test(label)) {
    throw new PresentationError(
      'invalid_presentation',
      `${field}.label must be a single short button label`,
      { field },
    );
  }
  return {
    id: id(value.id, `${field}.id`),
    label,
    prompt: text(value.prompt, `${field}.prompt`, MAX_SUGGESTION_PROMPT_CHARS),
    capabilityHint: value.capabilityHint == null || value.capabilityHint === ''
      ? null
      : id(value.capabilityHint, `${field}.capabilityHint`, CAPABILITY_ID_RE),
  };
}

function validatePresentation(value, {
  availableResultIds = [],
  excludedSuggestionIds = [],
} = {}) {
  if (!plainObject(value)) {
    throw new PresentationError('invalid_presentation', 'Presentation must be an object');
  }
  assertExactKeys(value, new Set(['message', 'resultRefs', 'suggestions']), 'presentation');

  const knownResults = normalizeKnownIds(availableResultIds, 'availableResultIds', 500);
  const excludedSuggestions = normalizeKnownIds(
    excludedSuggestionIds,
    'excludedSuggestionIds',
    500,
  );

  if (!Array.isArray(value.resultRefs) || value.resultRefs.length > MAX_RESULT_REFS) {
    throw new PresentationError(
      'invalid_presentation',
      `resultRefs must be an array with at most ${MAX_RESULT_REFS} entries`,
    );
  }
  const resultRefs = [];
  const seenResults = new Set();
  for (const raw of value.resultRefs) {
    const resultId = id(raw, 'resultRefs');
    if (!knownResults.has(resultId)) {
      throw new PresentationError(
        'unknown_result_reference',
        `Unknown result reference: ${resultId}`,
        { resultId },
      );
    }
    if (!seenResults.has(resultId)) {
      seenResults.add(resultId);
      resultRefs.push(resultId);
    }
  }

  if (!Array.isArray(value.suggestions)
      || value.suggestions.length !== SUGGESTIONS_PER_RESPONSE) {
    throw new PresentationError(
      'invalid_presentation',
      `suggestions must contain exactly ${SUGGESTIONS_PER_RESPONSE} options`,
    );
  }
  const suggestions = value.suggestions.map(normalizeSuggestion);
  const seenSuggestions = new Set();
  for (const suggestion of suggestions) {
    if (seenSuggestions.has(suggestion.id)) {
      throw new PresentationError(
        'duplicate_suggestion',
        `Suggestion ${suggestion.id} is repeated in this response`,
        { suggestionId: suggestion.id },
      );
    }
    if (excludedSuggestions.has(suggestion.id)) {
      throw new PresentationError(
        'repeated_suggestion',
        `Suggestion ${suggestion.id} was already shown`,
        { suggestionId: suggestion.id },
      );
    }
    seenSuggestions.add(suggestion.id);
  }

  return {
    message: text(value.message, 'message', MAX_MESSAGE_CHARS, { optional: true }),
    resultRefs,
    suggestions,
  };
}

// The fourth tuple item is an allowlisted direct-action id. The fifth is the
// context opened by press-and-hold. Neither value is accepted from a model:
// they are attached only after the model-facing presentation has passed the
// strict four-field validator above.
const SUGGESTION_CATALOG = Object.freeze({
  apps: Object.freeze([
    ['next.general.apps', 'Explore apps', 'Show me apps I can explore.', 'apps.list', 'apps'],
    ['next.apps.mine', 'Show my apps', 'Show the apps I currently work with.', 'apps.list', 'apps'],
    ['next.apps.activity', 'Recent app activity', 'Show recent activity across my apps.', 'apps.activity', 'apps'],
    ['next.apps.issues', 'Find app issues', 'Show open issues across apps I can access.', 'issues.choose_app', 'issues'],
    ['next.apps.development', 'Active development', 'Show active development work across my apps.', 'development.active', 'development'],
  ]),
  issues: Object.freeze([
    ['next.issues.open', 'Open issues', 'Show open issues I can work on.', 'issues.choose_app', 'issues'],
    ['next.issues.search', 'Search issues', 'Help me search issues by text, tag, or status.'],
    ['next.issues.mine', 'My issue work', 'Show issues connected to my current work.', 'issues.choose_app', 'issues'],
    ['next.issues.proposals', 'Related proposals', 'Show proposals related to open issues.', 'governance.mine', 'governance'],
    ['next.issues.development', 'Start development', 'Help me choose an issue and start development work.'],
  ]),
  governance: Object.freeze([
    ['next.governance.review', 'Review proposals', 'Show proposals that need my attention.', 'governance.mine', 'governance'],
    ['next.governance.votes', 'My votes', 'Show proposals I can vote on.', 'governance.mine', 'governance'],
    ['next.governance.recent', 'Recent proposals', 'Show recently updated proposals.', 'governance.mine', 'governance'],
    ['next.governance.issues', 'Related issues', 'Show issues related to current proposals.', 'issues.choose_app', 'issues'],
    ['next.governance.completed', 'Completed work', 'Show recently completed proposals.'],
  ]),
  development: Object.freeze([
    ['next.development.active', 'Active development', 'Show my active development work.', 'development.active', 'development'],
    ['next.development.continue', 'Continue work', 'Help me choose development work to continue.', 'development.active', 'development'],
    ['next.development.issues', 'Choose an issue', 'Show issues ready for development.', 'issues.choose_app', 'issues'],
    ['next.development.proposals', 'View proposals', 'Show proposals created from development work.', 'governance.mine', 'governance'],
    ['next.development.status', 'Check status', 'Show the status of my current development work.', 'development.active', 'development'],
  ]),
  messages: Object.freeze([
    ['next.messages.unread', 'Unread messages', 'Show my unread messages.', 'messages.recent', 'messages'],
    ['next.messages.recent', 'Recent conversations', 'Show my recent conversations.', 'messages.recent', 'messages'],
    ['next.messages.search', 'Find a conversation', 'Help me find a conversation.'],
    ['next.messages.notifications', 'Notifications', 'Show my recent notifications.', 'notifications.list', 'messages'],
    ['next.messages.apps', 'App discussions', 'Show recent app discussions I can access.', 'apps.list', 'apps'],
  ]),
  settings: Object.freeze([
    ['next.settings.global-chat', 'Chat settings', 'Show my Global Chat settings.', 'settings.global_chat', 'settings'],
    ['next.settings.development', 'Development AI', 'Show my Development AI settings.', 'settings.development', 'settings'],
    ['next.settings.budget', 'AI spending', 'Show my AI usage and spending limits.', 'settings.spending', 'settings'],
    ['next.settings.notifications', 'Notification settings', 'Show my notification settings.', 'settings.notifications', 'settings'],
    ['next.settings.more', 'Other settings', 'Show other settings I can configure.', 'settings.catalog', 'settings'],
  ]),
  general: Object.freeze([
    ['next.general.work', 'Show my work', 'Show my current work across Homeroom.', 'work.overview', 'development'],
    ['next.general.apps', 'Explore apps', 'Show me apps I can explore.', 'apps.list', 'apps'],
    ['next.general.issues', 'Find issues', 'Show open issues I can work on.', 'issues.choose_app', 'issues'],
    ['next.general.proposals', 'Review proposals', 'Show proposals that need my attention.', 'governance.mine', 'governance'],
    ['next.general.messages', 'Check messages', 'Show my recent conversations and unread messages.', 'messages.recent', 'messages'],
    ['next.general.notifications', 'Notifications', 'Show my recent notifications.', 'notifications.list', 'messages'],
    ['next.general.development', 'Development work', 'Show my active development work.', 'development.active', 'development'],
    ['next.general.settings', 'Open settings', 'Show settings I can configure.', 'settings.catalog', 'settings'],
    ['next.general.profile', 'View my profile', 'Show my Homeroom profile.', 'profile.me', 'general'],
    ['next.general.leaderboard', 'View leaderboard', 'Show the Homeroom leaderboard.', 'leaderboard.users', 'general'],
  ]),
});

const SUGGESTIONS_BY_ID = new Map(
  Object.values(SUGGESTION_CATALOG).flat().map((value) => [value[0], value]),
);

function plainSuggestion(value) {
  return {
    id: value[0],
    label: value[1],
    prompt: value[2],
    capabilityHint: null,
  };
}

function directActionIdForSuggestion(suggestionId) {
  return SUGGESTIONS_BY_ID.get(suggestionId)?.[3] || null;
}

function suggestionLabelForId(suggestionId) {
  return SUGGESTIONS_BY_ID.get(suggestionId)?.[1] || null;
}

function relatedSuggestions(value) {
  const context = value?.[4];
  if (!context || !SUGGESTION_CATALOG[context]) return [];
  return [...SUGGESTION_CATALOG[context], ...SUGGESTION_CATALOG.general]
    .filter((candidate, index, all) => (
      candidate[0] !== value[0]
      && all.findIndex((entry) => entry[0] === candidate[0]) === index
    ))
    .slice(0, SUGGESTIONS_PER_RESPONSE)
    .map((candidate) => ({
      ...plainSuggestion(candidate),
      actionId: candidate[3] || null,
    }));
}

function enrichSuggestion(value) {
  const trusted = SUGGESTIONS_BY_ID.get(value?.id);
  if (!trusted
      || value.label !== trusted[1]
      || value.prompt !== trusted[2]) return value;
  return {
    ...value,
    actionId: trusted[3] || null,
    relatedSuggestions: relatedSuggestions(trusted),
  };
}

function enrichPresentation(value, { context = 'general' } = {}) {
  return {
    ...value,
    suggestionContext: SUGGESTION_CATALOG[context] ? context : 'general',
    suggestions: value.suggestions.map(enrichSuggestion),
  };
}

function plainSuggestionsForContext(domain = 'general', excludedSuggestionIds = []) {
  const excluded = new Set(excludedSuggestionIds || []);
  const primary = SUGGESTION_CATALOG[domain] || SUGGESTION_CATALOG.general;
  const choices = [...primary, ...SUGGESTION_CATALOG.general]
    .filter((value, index, all) => (
      !excluded.has(value[0])
      && all.findIndex((candidate) => candidate[0] === value[0]) === index
    ))
    .slice(0, SUGGESTIONS_PER_RESPONSE)
    .map(plainSuggestion);
  if (choices.length !== SUGGESTIONS_PER_RESPONSE) {
    throw new PresentationError(
      'suggestions_exhausted',
      'No complete built-in suggestion batch remains for this conversation.',
    );
  }
  return choices;
}

function suggestionsForContext(domain = 'general', excludedSuggestionIds = []) {
  return plainSuggestionsForContext(domain, excludedSuggestionIds).map(enrichSuggestion);
}

function automaticPresentation({
  domain = 'general',
  resultRefs = [],
  excludedSuggestionIds = [],
  confirmationRequired = false,
  message = null,
} = {}) {
  const validated = validatePresentation({
    message: message || (confirmationRequired ? 'Review this action before confirming.' : 'Here\u2019s what I found.'),
    resultRefs,
    suggestions: plainSuggestionsForContext(domain, excludedSuggestionIds),
  }, { availableResultIds: resultRefs, excludedSuggestionIds });
  return enrichPresentation(validated, { context: domain });
}

function firstUsePresentation() {
  return enrichPresentation(validatePresentation({
    message: 'What would you like to do?',
    resultRefs: [],
    suggestions: plainSuggestionsForContext('general'),
  }), { context: 'general' });
}

function nextPredeterminedPresentation({ domain = 'general', excludedSuggestionIds = [] } = {}) {
  try {
    return enrichPresentation(validatePresentation({
      message: 'Here are more options.',
      resultRefs: [],
      suggestions: plainSuggestionsForContext(domain, excludedSuggestionIds),
    }, { excludedSuggestionIds }), { context: domain });
  } catch (error) {
    if (error instanceof PresentationError && error.code === 'suggestions_exhausted') return null;
    throw error;
  }
}

module.exports = {
  MAX_MESSAGE_CHARS,
  MAX_RESULT_REFS,
  MAX_SUGGESTION_LABEL_CHARS,
  MAX_SUGGESTION_PROMPT_CHARS,
  SUGGESTIONS_PER_RESPONSE,
  automaticPresentation,
  directActionIdForSuggestion,
  enrichPresentation,
  nextPredeterminedPresentation,
  PresentationError,
  firstUsePresentation,
  plainSuggestionsForContext,
  suggestionLabelForId,
  suggestionsForContext,
  validatePresentation,
};
