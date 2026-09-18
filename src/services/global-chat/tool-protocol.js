'use strict';

// Provider-facing tool names are deliberately decoupled from capability ids.
// Some providers accept only short alphanumeric function names, while the
// registry uses descriptive dotted ids. The hash mapping is deterministic and
// is never accepted from the browser or model as authority.

const crypto = require('node:crypto');
const { CAPABILITY_ID_RE } = require('./capability-registry');
const {
  MAX_MESSAGE_CHARS,
  MAX_RESULT_REFS,
  MAX_SUGGESTION_LABEL_CHARS,
  MAX_SUGGESTION_PROMPT_CHARS,
  SUGGESTIONS_PER_RESPONSE,
} = require('./presentation');

const BASE_TOOL_NAMES = Object.freeze({
  SEARCH: 'search_capabilities',
  DESCRIBE: 'describe_capability',
  MORE: 'request_more_suggestions',
  PRESENT: 'present_response',
});

const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$';
const CAPABILITY_PATTERN = '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$';

const SUGGESTION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 160, pattern: ID_PATTERN },
    label: { type: 'string', minLength: 1, maxLength: MAX_SUGGESTION_LABEL_CHARS },
    prompt: { type: 'string', minLength: 1, maxLength: MAX_SUGGESTION_PROMPT_CHARS },
    capabilityHint: {
      type: ['string', 'null'],
      maxLength: 160,
      pattern: CAPABILITY_PATTERN,
    },
  },
  required: ['id', 'label', 'prompt', 'capabilityHint'],
});

const PRESENTATION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string', maxLength: MAX_MESSAGE_CHARS },
    resultRefs: {
      type: 'array',
      maxItems: MAX_RESULT_REFS,
      items: { type: 'string', minLength: 1, maxLength: 160, pattern: ID_PATTERN },
    },
    suggestions: {
      type: 'array',
      minItems: SUGGESTIONS_PER_RESPONSE,
      maxItems: SUGGESTIONS_PER_RESPONSE,
      items: SUGGESTION_SCHEMA,
    },
  },
  required: ['message', 'resultRefs', 'suggestions'],
});

const BASE_TOOLS = Object.freeze([
  {
    type: 'function',
    function: {
      name: BASE_TOOL_NAMES.SEARCH,
      description: 'Find authorized Homeroom capabilities before claiming an operation is unavailable.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 240 },
          context: { type: ['string', 'null'], maxLength: 400 },
        },
        required: ['query', 'context'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: BASE_TOOL_NAMES.DESCRIBE,
      description: 'Inspect the exact inputs, risk, and output contract of one authorized capability.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          capabilityId: {
            type: 'string', minLength: 3, maxLength: 120, pattern: CAPABILITY_PATTERN,
          },
        },
        required: ['capabilityId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: BASE_TOOL_NAMES.MORE,
      description: 'Request two new short options that do not repeat any previously shown suggestion.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          topic: { type: ['string', 'null'], maxLength: 240 },
          excludedIds: {
            type: 'array', maxItems: 100,
            items: { type: 'string', minLength: 1, maxLength: 160, pattern: ID_PATTERN },
          },
        },
        required: ['topic', 'excludedIds'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: BASE_TOOL_NAMES.PRESENT,
      description: 'Finish the turn with compact text, authoritative result references, and exactly two button labels.',
      strict: true,
      parameters: PRESENTATION_SCHEMA,
    },
  },
]);

function capabilityToolName(capabilityId) {
  if (typeof capabilityId !== 'string' || !CAPABILITY_ID_RE.test(capabilityId)) {
    throw new Error('global-chat tools: invalid capability id');
  }
  return `cap_${crypto.createHash('sha256').update(capabilityId).digest('hex').slice(0, 24)}`;
}

function capabilityTool(definition) {
  if (!definition || typeof definition !== 'object') {
    throw new Error('global-chat tools: capability definition required');
  }
  return {
    type: 'function',
    function: {
      name: capabilityToolName(definition.id),
      description: `${definition.title}. ${definition.summary} Capability id: ${definition.id}. Risk: ${definition.risk}.`,
      strict: true,
      parameters: structuredClone(definition.inputSchema),
    },
  };
}

function toolSet(definitions) {
  const names = new Set(BASE_TOOLS.map((tool) => tool.function.name));
  const dynamic = [];
  const byName = new Map();
  for (const definition of definitions) {
    const tool = capabilityTool(definition);
    if (names.has(tool.function.name)) {
      throw new Error(`global-chat tools: duplicate provider tool ${tool.function.name}`);
    }
    names.add(tool.function.name);
    dynamic.push(tool);
    byName.set(tool.function.name, definition.id);
  }
  return {
    tools: [...BASE_TOOLS.map((tool) => structuredClone(tool)), ...dynamic],
    capabilityByToolName: byName,
  };
}

module.exports = {
  BASE_TOOL_NAMES,
  BASE_TOOLS,
  PRESENTATION_SCHEMA,
  SUGGESTION_SCHEMA,
  capabilityTool,
  capabilityToolName,
  toolSet,
};
