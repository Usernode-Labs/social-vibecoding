'use strict';

// The model can choose text, existing result references, and a small set of next-step
// suggestions. It cannot choose component code, Classic URLs, arbitrary
// actions, or the always-present More suggestions control; the server/client
// derive those from the capability registry.

const MAX_MESSAGE_CHARS = 2_000;
const MAX_RESULT_REFS = 5;
const MIN_SUGGESTIONS_PER_RESPONSE = 5;
const MAX_SUGGESTIONS_PER_RESPONSE = 6;
// Kept as the deterministic page size for older callers. Model responses may
// use five or six; curated first-use pages use six when six distinct actions
// are genuinely available.
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
  allowEmptySuggestions = false,
  allowShortSuggestions = false,
  dropRepeatedSuggestions = false,
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

  const minimumSuggestions = allowShortSuggestions
    ? 0
    : allowEmptySuggestions && value.suggestions?.length === 0
    ? 0
    : MIN_SUGGESTIONS_PER_RESPONSE;
  if (!Array.isArray(value.suggestions)
      || value.suggestions.length < minimumSuggestions
      || value.suggestions.length > MAX_SUGGESTIONS_PER_RESPONSE) {
    throw new PresentationError(
      'invalid_presentation',
      allowShortSuggestions
        ? `suggestions must contain at most ${MAX_SUGGESTIONS_PER_RESPONSE} options`
        : allowEmptySuggestions
        ? `suggestions must be empty or contain ${MIN_SUGGESTIONS_PER_RESPONSE} to ${MAX_SUGGESTIONS_PER_RESPONSE} options`
        : `suggestions must contain ${MIN_SUGGESTIONS_PER_RESPONSE} to ${MAX_SUGGESTIONS_PER_RESPONSE} options`,
    );
  }
  const normalizedSuggestions = value.suggestions.map(normalizeSuggestion);
  const suggestions = [];
  const seenSuggestions = new Set();
  const seenLabels = new Set();
  const seenPrompts = new Set();
  for (const suggestion of normalizedSuggestions) {
    const labelKey = suggestion.label.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const promptKey = suggestion.prompt.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (dropRepeatedSuggestions && (seenSuggestions.has(suggestion.id)
        || excludedSuggestions.has(suggestion.id)
        || seenLabels.has(labelKey) || seenPrompts.has(promptKey))) continue;
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
    if (seenLabels.has(labelKey) || seenPrompts.has(promptKey)) {
      throw new PresentationError(
        'duplicate_suggestion',
        `Suggestion ${suggestion.id} repeats another option`,
        { suggestionId: suggestion.id },
      );
    }
    seenSuggestions.add(suggestion.id);
    seenLabels.add(labelKey);
    seenPrompts.add(promptKey);
    suggestions.push(suggestion);
  }

  const message = text(value.message, 'message', MAX_MESSAGE_CHARS, { optional: true });
  if (!message && !resultRefs.length && !suggestions.length) {
    throw new PresentationError(
      'invalid_presentation',
      'A response needs text, a result, or at least one option',
    );
  }

  return {
    message,
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
    ['next.apps.activity', 'Recent app activity', 'Show recent activity across my apps.', 'apps.activity', 'apps'],
    ['next.apps.issues', 'Find app issues', 'Show open issues across apps I can access.', 'issues.choose_app', 'issues'],
    ['next.apps.development', 'Active development', 'Show active development work across my apps.', 'development.active', 'development'],
  ]),
  issues: Object.freeze([
    ['next.issues.open', 'Open issues', 'Show open issues I can work on.', 'issues.choose_app', 'issues'],
    ['next.issues.search', 'Search issues', 'Help me search issues by text, tag, or status.'],
    ['next.issues.mine', 'Issues in my work', 'Show issues linked to my active development sessions or proposals.', null, 'issues'],
    ['next.issues.proposals', 'Related proposals', 'Show proposals related to open issues.'],
    ['next.issues.development', 'Start development', 'Help me choose an issue and start development work.'],
  ]),
  governance: Object.freeze([
    ['next.governance.review', 'Review proposals', 'Show my current proposals.', 'governance.mine', 'governance'],
    ['next.governance.votes', 'My votes', 'Show proposals I can vote on.'],
    ['next.governance.recent', 'Recent proposals', 'Show recently updated proposals.'],
    ['next.governance.issues', 'Related issues', 'Show issues related to current proposals.'],
    ['next.governance.completed', 'Completed work', 'Show recently completed proposals.', 'governance.completed', 'governance'],
  ]),
  development: Object.freeze([
    ['next.development.active', 'Active development', 'Show my active development work.', 'development.active', 'development'],
    ['next.development.continue', 'Continue work', 'Help me choose development work to continue.', 'development.continue', 'development'],
    ['next.development.issues', 'Choose an issue', 'Show issues ready for development.', 'issues.choose_app', 'issues'],
    ['next.development.proposals', 'View proposals', 'Show proposals created from development work.', 'governance.mine', 'governance'],
    ['next.development.status', 'Check status', 'Show the status of my current development work.', 'development.status', 'development'],
  ]),
  messages: Object.freeze([
    ['next.messages.unread', 'Unread messages', 'Show my unread messages.', 'messages.unread', 'messages'],
    ['next.messages.recent', 'Recent conversations', 'Show my recent conversations.', 'messages.recent', 'messages'],
    ['next.messages.search', 'Find a conversation', 'Help me find a conversation.'],
    ['next.messages.notifications', 'Notifications', 'Show my recent notifications.', 'notifications.list', 'messages'],
    ['next.messages.apps', 'App discussions', 'Show recent app discussions I can access.', 'messages.choose_app', 'messages'],
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
    ['next.general.proposals', 'Review proposals', 'Show my current proposals.', 'governance.mine', 'governance'],
    ['next.general.messages', 'Check messages', 'Show my recent conversations and unread messages.', 'messages.overview', 'messages'],
    ['next.general.activity', 'Recent activity', 'Show recent activity across my apps.', 'apps.activity', 'apps'],
    ['next.general.development', 'Development work', 'Show my active development work.', 'development.active', 'development'],
    ['next.general.notifications', 'Notifications', 'Show my recent notifications.', 'notifications.list', 'messages'],
    ['next.general.settings', 'Open settings', 'Show settings I can configure.', 'settings.catalog', 'settings'],
    ['next.general.spending', 'AI spending', 'Show my Global Chat usage and spending limits.', 'settings.spending', 'settings'],
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

const RELATED_SUGGESTION_IDS = Object.freeze({
  'next.general.work': ['next.development.active', 'next.issues.mine', 'next.governance.review', 'next.apps.activity', 'next.messages.unread'],
  'next.general.apps': ['next.apps.activity', 'next.apps.issues', 'next.apps.development', 'next.messages.apps', 'next.general.work'],
  'next.general.issues': ['next.issues.search', 'next.issues.mine', 'next.issues.proposals', 'next.issues.development', 'next.apps.activity'],
  'next.general.proposals': ['next.governance.votes', 'next.governance.recent', 'next.governance.completed', 'next.governance.issues', 'next.development.active'],
  'next.general.messages': ['next.messages.unread', 'next.messages.recent', 'next.messages.search', 'next.messages.apps', 'next.general.notifications'],
  'next.general.activity': ['next.apps.issues', 'next.apps.development', 'next.governance.recent', 'next.messages.apps', 'next.general.work'],
  'next.general.development': ['next.development.continue', 'next.development.status', 'next.development.issues', 'next.development.proposals', 'next.general.work'],
  'next.general.settings': ['next.settings.global-chat', 'next.settings.development', 'next.settings.budget', 'next.settings.notifications', 'next.settings.more'],
  'next.general.spending': ['next.settings.global-chat', 'next.settings.development', 'next.settings.budget', 'next.settings.more', 'next.general.settings'],
  'next.apps.activity': ['next.apps.issues', 'next.apps.development', 'next.governance.recent', 'next.messages.apps', 'next.general.work'],
  'next.apps.issues': ['next.issues.search', 'next.issues.mine', 'next.issues.development', 'next.issues.proposals', 'next.apps.activity'],
  'next.issues.open': ['next.issues.search', 'next.issues.mine', 'next.issues.proposals', 'next.issues.development', 'next.general.apps'],
  'next.governance.review': ['next.governance.votes', 'next.governance.recent', 'next.governance.completed', 'next.governance.issues', 'next.development.active'],
  'next.development.active': ['next.development.continue', 'next.development.status', 'next.development.issues', 'next.development.proposals', 'next.general.work'],
  'next.settings.global-chat': ['next.settings.budget', 'next.settings.development', 'next.settings.notifications', 'next.settings.more', 'next.general.settings'],
});

function relatedSuggestions(value) {
  const context = value?.[4];
  const explicit = RELATED_SUGGESTION_IDS[value?.[0]] || [];
  const fallbacks = context && SUGGESTION_CATALOG[context]
    ? [...SUGGESTION_CATALOG[context], ...SUGGESTION_CATALOG.general].map((entry) => entry[0])
    : [];
  return [...explicit, ...fallbacks]
    .map((suggestionId) => SUGGESTIONS_BY_ID.get(suggestionId))
    .filter((candidate, index, all) => (
      candidate
      && candidate[0] !== value[0]
      && all.findIndex((entry) => entry?.[0] === candidate[0]) === index
      && candidate[3] !== value[3]
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

function plainSuggestionsForContext(domain = 'general', excludedSuggestionIds = [], {
  limit = SUGGESTIONS_PER_RESPONSE,
  excludedActionIds = [],
} = {}) {
  const excluded = new Set(excludedSuggestionIds || []);
  const excludedActions = new Set(excludedActionIds || []);
  const boundedLimit = Math.max(
    MIN_SUGGESTIONS_PER_RESPONSE,
    Math.min(MAX_SUGGESTIONS_PER_RESPONSE, Number(limit) || SUGGESTIONS_PER_RESPONSE),
  );
  const primary = SUGGESTION_CATALOG[domain] || SUGGESTION_CATALOG.general;
  const choices = [...primary, ...SUGGESTION_CATALOG.general]
    .filter((value, index, all) => (
      !excluded.has(value[0])
      && !excludedActions.has(value[3])
      && all.findIndex((candidate) => candidate[0] === value[0]) === index
      && (!value[3]
        || all.findIndex((candidate) => candidate[3] === value[3]) === index)
    ))
    .slice(0, boundedLimit)
    .map(plainSuggestion);
  if (choices.length < MIN_SUGGESTIONS_PER_RESPONSE) {
    throw new PresentationError(
      'suggestions_exhausted',
      'No complete built-in suggestion batch remains for this conversation.',
    );
  }
  return choices;
}

function suggestionsForContext(domain = 'general', excludedSuggestionIds = [], options = {}) {
  return plainSuggestionsForContext(domain, excludedSuggestionIds, options).map(enrichSuggestion);
}

function automaticPresentation({
  domain = 'general',
  resultRefs = [],
  excludedSuggestionIds = [],
  confirmationRequired = false,
  message = null,
  excludedActionIds = [],
  suggestionLimit = SUGGESTIONS_PER_RESPONSE,
} = {}) {
  const validated = validatePresentation({
    message: message || (confirmationRequired ? 'Review this action before confirming.' : 'Here\u2019s what I found.'),
    resultRefs,
    suggestions: plainSuggestionsForContext(domain, excludedSuggestionIds, {
      limit: suggestionLimit,
      excludedActionIds,
    }),
  }, { availableResultIds: resultRefs, excludedSuggestionIds });
  return enrichPresentation(validated, { context: domain });
}

function firstUsePresentation() {
  return enrichPresentation(validatePresentation({
    message: 'What would you like to do?',
    resultRefs: [],
    suggestions: plainSuggestionsForContext('general', [], {
      limit: MAX_SUGGESTIONS_PER_RESPONSE,
    }),
  }), { context: 'general' });
}

function nextPredeterminedPresentation({ domain = 'general', excludedSuggestionIds = [] } = {}) {
  try {
    return enrichPresentation(validatePresentation({
      message: 'Here are more options.',
      resultRefs: [],
      suggestions: plainSuggestionsForContext(domain, excludedSuggestionIds, {
        limit: MAX_SUGGESTIONS_PER_RESPONSE,
      }),
    }, { excludedSuggestionIds }), { context: domain });
  } catch (error) {
    if (error instanceof PresentationError && error.code === 'suggestions_exhausted') return null;
    throw error;
  }
}

module.exports = {
  MAX_MESSAGE_CHARS,
  MAX_RESULT_REFS,
  MAX_SUGGESTIONS_PER_RESPONSE,
  MIN_SUGGESTIONS_PER_RESPONSE,
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
