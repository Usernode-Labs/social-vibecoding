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

function searchTerms(query) {
  return [...new Set(normalizeSearchText(query).split(/\s+/).filter(Boolean))].slice(0, 20);
}

function searchScore(definition, terms) {
  if (!terms.length) return 1;
  const fields = {
    id: normalizeSearchText(definition.id),
    title: normalizeSearchText(definition.title),
    domain: normalizeSearchText(definition.domain),
    keywords: normalizeSearchText(definition.keywords.join(' ')),
    summary: normalizeSearchText(definition.summary),
  };
  let score = 0;
  for (const term of terms) {
    let matched = false;
    if (fields.id.includes(term)) { score += 8; matched = true; }
    if (fields.title.includes(term)) { score += 6; matched = true; }
    if (fields.keywords.includes(term)) { score += 4; matched = true; }
    if (fields.domain.includes(term)) { score += 3; matched = true; }
    if (fields.summary.includes(term)) { score += 1; matched = true; }
    if (!matched) return 0;
  }
  return score;
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
    return [...this._byId.values()]
      .filter((definition) => isAuthorized(definition, executionContext))
      .map((definition) => ({ definition, score: searchScore(definition, terms) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.definition.id.localeCompare(b.definition.id))
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
