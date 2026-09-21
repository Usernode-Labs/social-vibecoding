'use strict';

const crypto = require('crypto');
const { validateJsonSchema, JsonSchemaValidationError } = require('./json-schema');

// The registry is the server-owned bridge between model-selected intent and
// existing Homeroom domain logic. It contains no model calls and no ambient
// authorization assumptions: every discovery, description, execution, and
// Classic-path lookup receives the authenticated execution context.

const DOMAINS = Object.freeze([
  'navigation',
  'apps',
  'issues',
  'governance',
  'development',
  'community_chat',
  'messages',
  'notifications',
  'profile',
  'leaderboards',
  'settings',
  'admin',
  'native',
]);

const RISK_LEVELS = Object.freeze([
  'read',
  'reversible_write',
  'external_write',
  'destructive',
]);

const CONFIRMATION_POLICIES = Object.freeze(['never', 'required']);

const RENDERERS = Object.freeze([
  'app',
  'issue',
  'proposal',
  'session',
  'conversation',
  'notification',
  'profile',
  'leaderboard',
  'challenge',
  'wallet',
  'staking',
  'setting',
  'admin_record',
  'status',
  'error',
  'form',
  'confirmation',
  'grouped_list',
]);

const DOMAIN_SET = new Set(DOMAINS);
const RISK_SET = new Set(RISK_LEVELS);
const CONFIRMATION_SET = new Set(CONFIRMATION_POLICIES);
const RENDERER_SET = new Set(RENDERERS);
const CAPABILITY_ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;
const SAFE_CLASSIC_PATH_RE = /^#[A-Za-z0-9][A-Za-z0-9_./?=&%-]*$/;

class CapabilityRegistryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CapabilityRegistryError';
    this.code = code;
    this.details = details;
  }
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value, field, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new CapabilityRegistryError(
      'invalid_definition',
      `${field} must be a non-empty string up to ${max} characters`,
      { field },
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new CapabilityRegistryError(
      'invalid_definition',
      `${field} contains control characters`,
      { field },
    );
  }
  return value.trim();
}

function stringList(value, field, { maxItems = 30, maxChars = 120 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new CapabilityRegistryError(
      'invalid_definition',
      `${field} must be an array with at most ${maxItems} entries`,
      { field },
    );
  }
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const normalized = requiredText(item, field, maxChars);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

function strictObjectSchema(value, field) {
  if (!plainObject(value) || value.type !== 'object' || !plainObject(value.properties)) {
    throw new CapabilityRegistryError(
      'invalid_definition',
      `${field} must be a JSON schema with an object root and properties`,
      { field },
    );
  }
  if (value.additionalProperties !== false) {
    throw new CapabilityRegistryError(
      'invalid_definition',
      `${field} must set additionalProperties to false`,
      { field },
    );
  }
  return structuredClone(value);
}

function discoveryPriority(value, field) {
  if (value == null) return 0;
  if (!Number.isInteger(value) || value < -100 || value > 100) {
    throw new CapabilityRegistryError(
      'invalid_definition',
      `${field} must be an integer from -100 to 100`,
      { field },
    );
  }
  return value;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!plainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function normalizeDefinition(definition) {
  if (!plainObject(definition)) {
    throw new CapabilityRegistryError('invalid_definition', 'Capability must be an object');
  }
  const id = requiredText(definition.id, 'id', 120);
  if (!CAPABILITY_ID_RE.test(id)) {
    throw new CapabilityRegistryError('invalid_definition', `Invalid capability id: ${id}`, { id });
  }
  const domain = requiredText(definition.domain, `${id}.domain`, 40);
  if (!DOMAIN_SET.has(domain)) {
    throw new CapabilityRegistryError('invalid_definition', `Unknown capability domain: ${domain}`, { id });
  }
  const risk = requiredText(definition.risk, `${id}.risk`, 40);
  if (!RISK_SET.has(risk)) {
    throw new CapabilityRegistryError('invalid_definition', `Unknown risk level: ${risk}`, { id });
  }
  const confirmation = requiredText(definition.confirmation, `${id}.confirmation`, 40);
  if (!CONFIRMATION_SET.has(confirmation)) {
    throw new CapabilityRegistryError(
      'invalid_definition',
      `Unknown confirmation policy: ${confirmation}`,
      { id },
    );
  }
  if ((risk === 'external_write' || risk === 'destructive') && confirmation !== 'required') {
    throw new CapabilityRegistryError(
      'invalid_definition',
      `${risk} capability ${id} must require confirmation`,
      { id },
    );
  }
  const renderer = requiredText(definition.renderer, `${id}.renderer`, 40);
  if (!RENDERER_SET.has(renderer)) {
    throw new CapabilityRegistryError('invalid_definition', `Unknown renderer: ${renderer}`, { id });
  }
  if (typeof definition.access !== 'function') {
    throw new CapabilityRegistryError('invalid_definition', `${id}.access must be a function`, { id });
  }
  if (typeof definition.handler !== 'function') {
    throw new CapabilityRegistryError('invalid_definition', `${id}.handler must be a function`, { id });
  }
  if (typeof definition.classicPath !== 'function') {
    throw new CapabilityRegistryError(
      'invalid_definition',
      `${id}.classicPath must be a function`,
      { id },
    );
  }
  if (definition.confirmationPreview != null
      && typeof definition.confirmationPreview !== 'function') {
    throw new CapabilityRegistryError(
      'invalid_definition',
      `${id}.confirmationPreview must be a function when provided`,
      { id },
    );
  }
  if (typeof definition.mobileSupported !== 'boolean') {
    throw new CapabilityRegistryError(
      'invalid_definition',
      `${id}.mobileSupported must be a boolean`,
      { id },
    );
  }

  return Object.freeze({
    id,
    domain,
    title: requiredText(definition.title, `${id}.title`, 80),
    summary: requiredText(definition.summary, `${id}.summary`, 400),
    keywords: Object.freeze(stringList(definition.keywords || [], `${id}.keywords`)),
    discoveryPriority: discoveryPriority(definition.discoveryPriority, `${id}.discoveryPriority`),
    searchRequires: Object.freeze(stringList(
      definition.searchRequires || [],
      `${id}.searchRequires`,
      { maxItems: 8, maxChars: 40 },
    ).map(searchTerm).filter(Boolean)),
    inputSchema: Object.freeze(strictObjectSchema(definition.inputSchema, `${id}.inputSchema`)),
    resultSchema: Object.freeze(strictObjectSchema(definition.resultSchema, `${id}.resultSchema`)),
    renderer,
    access: definition.access,
    risk,
    confirmation,
    confirmationPreview: definition.confirmationPreview || null,
    classicPath: definition.classicPath,
    mobileSupported: definition.mobileSupported,
    sensitiveFields: Object.freeze(
      stringList(definition.sensitiveFields || [], `${id}.sensitiveFields`, {
        maxItems: 50,
        maxChars: 160,
      }),
    ),
    handler: definition.handler,
    tests: Object.freeze(stringList(definition.tests || [], `${id}.tests`, {
      maxItems: 50,
      maxChars: 220,
    })),
  });
}

function descriptorForHash(definition) {
  return {
    id: definition.id,
    domain: definition.domain,
    title: definition.title,
    summary: definition.summary,
    keywords: definition.keywords,
    discoveryPriority: definition.discoveryPriority,
    searchRequires: definition.searchRequires,
    inputSchema: definition.inputSchema,
    resultSchema: definition.resultSchema,
    renderer: definition.renderer,
    risk: definition.risk,
    confirmation: definition.confirmation,
    hasConfirmationPreview: typeof definition.confirmationPreview === 'function',
    mobileSupported: definition.mobileSupported,
    sensitiveFields: definition.sensitiveFields,
    tests: definition.tests,
  };
}

function registryVersion(definitions) {
  const serializable = definitions
    .map(descriptorForHash)
    .sort((a, b) => a.id.localeCompare(b.id));
  const digest = crypto.createHash('sha256').update(stableStringify(serializable)).digest('hex');
  return `global-chat-capabilities-v1:${digest.slice(0, 20)}`;
}

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Discovery queries are natural-language prompts, not exact boolean searches.
// Requiring every word in "show me the current issues" to occur in a route
// descriptor made the useful noun lose to harmless filler such as "me" and
// "current", returning an empty registry even though hundreds of authorized
// capabilities existed. Keep action words (open/edit/delete) because they
// distinguish risk, but discard conversational filler and standalone ids.
const SEARCH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'can', 'could', 'current', 'do', 'for', 'from',
  'give', 'i', 'in', 'is', 'me', 'my', 'of', 'on', 'please', 'show', 'some',
  'tell', 'that', 'the', 'these', 'this', 'to', 'what', 'which', 'with',
  'would', 'you',
]);
const SEARCH_TERM_ALIASES = Object.freeze({
  closed: 'close',
  closing: 'close',
  completed: 'complete',
  completing: 'complete',
  configuring: 'configure',
  creating: 'create',
  deleting: 'delete',
  developed: 'develop',
  developer: 'develop',
  developing: 'develop',
  development: 'develop',
  editing: 'edit',
  listing: 'list',
  merged: 'merge',
  merging: 'merge',
  opening: 'open',
  searching: 'search',
  viewing: 'view',
  voting: 'vote',
});
const SEARCH_ACTION_TERMS = new Set([
  'change', 'close', 'complete', 'configure', 'continue', 'create', 'delete', 'edit',
  'find', 'get', 'list', 'merge', 'open', 'remove', 'run', 'search', 'start',
  'update', 'view', 'vote',
]);

function searchTerm(value) {
  if (!value || SEARCH_STOP_WORDS.has(value) || /^\d+$/.test(value)) return '';
  if (SEARCH_TERM_ALIASES[value]) return SEARCH_TERM_ALIASES[value];
  // A small, deterministic plural fold is enough for route vocabulary such
  // as apps/issues/proposals without introducing a language-model dependency
  // into the authorization-sensitive registry.
  if (value.endsWith('ies') && value.length > 4) return `${value.slice(0, -3)}y`;
  if (value.endsWith('s') && !value.endsWith('ss') && value.length > 3) {
    return value.slice(0, -1);
  }
  return value;
}

function searchTerms(query) {
  return [...new Set(normalizeSearchText(query).split(/\s+/).map(searchTerm).filter(Boolean))]
    .slice(0, 20);
}

function searchScore(definition, terms, { hasNumericIdentifier = false } = {}) {
  // A greeting or generic help request must not preload arbitrary tools. In
  // particular, sorting an empty query by capability id used to expose delete
  // operations first and then force the model to call one.
  if (!terms.length) return 0;
  if (definition.searchRequires.length
      && !definition.searchRequires.every((required) => terms.includes(required))) return 0;
  const fields = {
    id: new Set(searchTerms(definition.id)),
    title: new Set(searchTerms(definition.title)),
    domain: new Set(searchTerms(definition.domain)),
    keywords: new Set(searchTerms(definition.keywords.join(' '))),
    summary: new Set(searchTerms(definition.summary)),
  };
  let score = 0;
  let matchedTerms = 0;
  let strongMatchedTerms = 0;
  for (const term of terms) {
    let matched = false;
    let strongMatched = false;
    if (fields.id.has(term)) { score += 8; matched = true; strongMatched = true; }
    if (fields.title.has(term)) { score += 6; matched = true; strongMatched = true; }
    if (fields.keywords.has(term)) { score += 4; matched = true; strongMatched = true; }
    if (fields.domain.has(term)) { score += 3; matched = true; strongMatched = true; }
    if (fields.summary.has(term)) { score += 1; matched = true; }
    if (matched) matchedTerms += 1;
    if (strongMatched) strongMatchedTerms += 1;
  }
  if (!matchedTerms) return 0;
  // A semantic capability may outrank a raw route only when it covers the
  // complete normalized request. Otherwise a generic word such as "app"
  // must not make "app discussions" beat the actual app-list operation.
  if (strongMatchedTerms === terms.length) score += definition.discoveryPriority;
  const requestedActions = terms.filter((term) => SEARCH_ACTION_TERMS.has(term));
  const requestedObjects = terms.filter((term) => !SEARCH_ACTION_TERMS.has(term));
  if (requestedObjects.length && !requestedObjects.some(
    (term) => Object.values(fields).some((field) => field.has(term)),
  )) return 0;
  for (const action of requestedActions) {
    const actionMatched = Object.values(fields).some((field) => field.has(action));
    // Action verbs carry more intent than object nouns. Without this boost,
    // "start developing issue 2377" ranked unrelated issue-link reads above
    // the purpose-built Start development work capability.
    score += actionMatched ? 16 : -6;
  }
  const pathParameters = definition.inputSchema?.properties?.pathParameters?.required || [];
  if (definition.risk === 'read') score += 5;
  else if (definition.risk === 'destructive') score -= 5;
  else if (definition.risk === 'external_write') score -= 2;
  if (hasNumericIdentifier
      && pathParameters.some((name) => ['id', 'number', 'issueId'].includes(name))) {
    score += 6;
  } else if (pathParameters.length === 0) {
    score += 3;
  }
  const titleWords = normalizeSearchText(definition.title).split(/\s+/).filter(Boolean).length;
  score += Math.max(0, 5 - titleWords);
  // Partial matching is intentional: the strongest matching descriptor wins,
  // while a small coverage bonus keeps multi-word intent above generic routes.
  return score + matchedTerms * 2;
}

function preciseSemanticMatch(definition, terms) {
  if (definition.discoveryPriority <= 0 || !terms.length) return false;
  if (definition.searchRequires.length
      && !definition.searchRequires.every((required) => terms.includes(required))) return false;
  const strongTerms = new Set(searchTerms([
    definition.id,
    definition.title,
    definition.domain,
    definition.keywords.join(' '),
  ].join(' ')));
  return terms.every((term) => strongTerms.has(term));
}

function isAuthorized(definition, executionContext) {
  try {
    return definition.access(executionContext) === true;
  } catch {
    return false;
  }
}

function discoveryDescriptor(definition) {
  return {
    id: definition.id,
    domain: definition.domain,
    title: definition.title,
    summary: definition.summary,
    risk: definition.risk,
    confirmation: definition.confirmation,
    renderer: definition.renderer,
  };
}

function detailDescriptor(definition) {
  return {
    ...discoveryDescriptor(definition),
    inputSchema: structuredClone(definition.inputSchema),
    resultSchema: structuredClone(definition.resultSchema),
    mobileSupported: definition.mobileSupported,
  };
}

function deepClone(value) {
  return value == null ? value : structuredClone(value);
}

function deletePath(target, path) {
  const parts = path.split('.').filter(Boolean);
  if (!parts.length) return;
  const walk = (current, index) => {
    if (current == null || typeof current !== 'object') return;
    const part = parts[index];
    if (part === '*') {
      const values = Array.isArray(current) ? current : Object.values(current);
      for (const value of values) walk(value, index + 1);
      return;
    }
    if (index === parts.length - 1) {
      delete current[part];
      return;
    }
    walk(current[part], index + 1);
  };
  walk(target, 0);
}

function redactSensitiveFields(value, sensitiveFields) {
  const copy = deepClone(value);
  for (const path of sensitiveFields) deletePath(copy, path);
  return copy;
}

function safeClassicPath(value, capabilityId) {
  if (value === '/') return value;
  if (typeof value !== 'string' || value.length > 512 || !SAFE_CLASSIC_PATH_RE.test(value)) {
    throw new CapabilityRegistryError(
      'invalid_classic_path',
      `Capability ${capabilityId} returned an invalid Classic path`,
      { capabilityId },
    );
  }
  return value;
}

class CapabilityRegistry {
  constructor(definitions = []) {
    if (!Array.isArray(definitions)) {
      throw new CapabilityRegistryError('invalid_registry', 'definitions must be an array');
    }
    this._byId = new Map();
    for (const raw of definitions) {
      const definition = normalizeDefinition(raw);
      if (this._byId.has(definition.id)) {
        throw new CapabilityRegistryError(
          'duplicate_capability',
          `Duplicate capability id: ${definition.id}`,
          { id: definition.id },
        );
      }
      this._byId.set(definition.id, definition);
    }
    this.version = registryVersion([...this._byId.values()]);
  }

  get size() {
    return this._byId.size;
  }

  ids() {
    return [...this._byId.keys()].sort();
  }

  get(id) {
    return this._byId.get(id) || null;
  }

  search(query, executionContext, { limit = 8 } = {}) {
    const boundedLimit = Math.max(1, Math.min(20, Number.isInteger(limit) ? limit : 8));
    const terms = searchTerms(query);
    const compoundRequest = /\b(?:also|and|plus|then)\b|,/i.test(String(query || ''));
    const hasNumericIdentifier = /(?:^|\D)\d+(?:\D|$)/.test(String(query || ''));
    const ranked = [...this._byId.values()]
      .filter((definition) => isAuthorized(definition, executionContext))
      .map((definition) => ({
        definition,
        score: searchScore(definition, terms, { hasNumericIdentifier }),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.definition.id.localeCompare(b.definition.id));
    // When one or more purpose-built semantic operations cover the complete
    // request, do not also hand a weak model several lower-level API routes
    // that merely contain the same nouns. Compound requests still expose all
    // matching operations because no single definition covers every clause.
    const semantic = compoundRequest
      ? []
      : ranked.filter((entry) => preciseSemanticMatch(entry.definition, terms));
    return (semantic.length ? semantic : ranked)
      .slice(0, boundedLimit)
      .map((entry) => discoveryDescriptor(entry.definition));
  }

  describe(id, executionContext) {
    const definition = this._byId.get(id);
    if (!definition || !isAuthorized(definition, executionContext)) {
      throw new CapabilityRegistryError(
        'capability_not_found',
        'That capability does not exist or is not available to this user.',
        { id },
      );
    }
    return detailDescriptor(definition);
  }

  classicPath(id, input, executionContext) {
    const definition = this._byId.get(id);
    if (!definition || !isAuthorized(definition, executionContext)) {
      throw new CapabilityRegistryError(
        'capability_not_found',
        'That capability does not exist or is not available to this user.',
        { id },
      );
    }
    if (!plainObject(input)) {
      throw new CapabilityRegistryError(
        'invalid_capability_input',
        'Capability input must be an object.',
        { id },
      );
    }
    try {
      validateJsonSchema(definition.inputSchema, input, { path: 'input' });
    } catch (error) {
      if (!(error instanceof JsonSchemaValidationError)) throw error;
      throw new CapabilityRegistryError(
        'invalid_capability_input',
        `Capability input is invalid: ${error.message}`,
        { id, path: error.path },
      );
    }
    return safeClassicPath(definition.classicPath({
      input: structuredClone(input),
      result: null,
      context: executionContext,
    }), id);
  }

  async execute(id, input, executionContext) {
    const definition = this._byId.get(id);
    if (!definition || !isAuthorized(definition, executionContext)) {
      throw new CapabilityRegistryError(
        'capability_not_found',
        'That capability does not exist or is not available to this user.',
        { id },
      );
    }
    if (!plainObject(input)) {
      throw new CapabilityRegistryError(
        'invalid_capability_input',
        'Capability input must be an object.',
        { id },
      );
    }
    try {
      validateJsonSchema(definition.inputSchema, input, { path: 'input' });
    } catch (error) {
      if (!(error instanceof JsonSchemaValidationError)) throw error;
      throw new CapabilityRegistryError(
        'invalid_capability_input',
        `Capability input is invalid: ${error.message}`,
        { id, path: error.path },
      );
    }
    const result = await definition.handler(structuredClone(input), executionContext);
    if (!plainObject(result) || !Object.hasOwn(result, 'authoritativeResult')) {
      throw new CapabilityRegistryError(
        'invalid_capability_result',
        `Capability ${id} did not return an authoritativeResult`,
        { id },
      );
    }
    const authoritativeResult = deepClone(result.authoritativeResult);
    const rawModelResult = Object.hasOwn(result, 'modelResult')
      ? result.modelResult
      : result.authoritativeResult;
    const modelResult = redactSensitiveFields(rawModelResult, definition.sensitiveFields);
    try {
      validateJsonSchema(definition.resultSchema, modelResult, { path: 'result' });
    } catch (error) {
      if (!(error instanceof JsonSchemaValidationError)) throw error;
      throw new CapabilityRegistryError(
        'invalid_capability_result',
        `Capability ${id} returned an invalid model result: ${error.message}`,
        { id, path: error.path },
      );
    }
    const rawClassicPath = Object.hasOwn(result, 'classicPath')
      ? result.classicPath
      : definition.classicPath({
        input: structuredClone(input),
        result: authoritativeResult,
        context: executionContext,
      });

    return {
      capabilityId: id,
      renderer: definition.renderer,
      risk: definition.risk,
      confirmation: definition.confirmation,
      modelResult,
      authoritativeResult,
      classicPath: safeClassicPath(rawClassicPath, id),
    };
  }
}

module.exports = {
  CAPABILITY_ID_RE,
  CONFIRMATION_POLICIES,
  DOMAINS,
  RENDERERS,
  RISK_LEVELS,
  CapabilityRegistry,
  CapabilityRegistryError,
  normalizeSearchText,
  redactSensitiveFields,
  registryVersion,
};
