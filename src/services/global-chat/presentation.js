'use strict';

// The model can choose text, existing result references, and two next-step
// suggestions. It cannot choose component code, Classic URLs, arbitrary
// actions, or the always-present More suggestions control; the server/client
// derive those from the capability registry.

const MAX_MESSAGE_CHARS = 600;
const MAX_RESULT_REFS = 5;
const SUGGESTIONS_PER_RESPONSE = 2;
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

function firstUsePresentation() {
  return {
    message: 'What would you like to do?',
    resultRefs: [],
    suggestions: [
      {
        id: 'first.show-my-work',
        label: 'Show my work',
        prompt: 'Show my current work across Homeroom.',
        capabilityHint: null,
      },
      {
        id: 'first.explore-apps',
        label: 'Explore apps',
        prompt: 'Show me apps I can explore.',
        capabilityHint: null,
      },
    ],
  };
}

module.exports = {
  MAX_MESSAGE_CHARS,
  MAX_RESULT_REFS,
  MAX_SUGGESTION_LABEL_CHARS,
  MAX_SUGGESTION_PROMPT_CHARS,
  SUGGESTIONS_PER_RESPONSE,
  PresentationError,
  firstUsePresentation,
  validatePresentation,
};
