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
  ASK: 'ask_user_for_input',
  PRESENT: 'present_response',
});

const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$';
const CAPABILITY_PATTERN = '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$';

const SUGGESTION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    id: {
      type: 'string', minLength: 1, maxLength: 160, pattern: ID_PATTERN,
      description: 'Stable unique id for this option. It must not appear in context.excludedSuggestionIds.',
    },
    label: {
      type: 'string', minLength: 1, maxLength: MAX_SUGGESTION_LABEL_CHARS,
      description: 'Short button text only. Do not add a bullet, number, subtitle, or description.',
    },
    prompt: {
      type: 'string', minLength: 1, maxLength: MAX_SUGGESTION_PROMPT_CHARS,
      description: 'Complete next user instruction sent when the button is clicked. Include the target id or name when needed; never use a context-free phrase such as "Do it".',
    },
    capabilityHint: {
      type: ['string', 'null'],
      maxLength: 160,
      pattern: CAPABILITY_PATTERN,
      description: 'Exact known capability id for this next action, or null when no exact capability is known.',
    },
  },
  required: ['id', 'label', 'prompt', 'capabilityHint'],
});

const PRESENTATION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    message: {
      type: 'string', maxLength: MAX_MESSAGE_CHARS,
      description: 'At most two short sentences. State only facts supported by Homeroom tools; rendered results carry list details.',
    },
    resultRefs: {
      type: 'array',
      maxItems: MAX_RESULT_REFS,
      items: { type: 'string', minLength: 1, maxLength: 160, pattern: ID_PATTERN },
      description: 'Use [] for results created in this turn; Homeroom attaches them. Only list known result ids from earlier turns.',
    },
    suggestions: {
      type: 'array',
      minItems: SUGGESTIONS_PER_RESPONSE,
      maxItems: SUGGESTIONS_PER_RESPONSE,
      items: SUGGESTION_SCHEMA,
      description: 'Exactly five relevant, new button options. Never include More suggestions, Fewer suggestions, Back, Cancel, or Open in Classic.',
    },
  },
  required: ['message', 'resultRefs', 'suggestions'],
});

const CLARIFICATION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    question: {
      type: 'string', minLength: 1, maxLength: MAX_MESSAGE_CHARS,
      description: 'One short, specific question asking only for the required value that is missing. End with a question mark and make no platform claim.',
    },
    suggestions: {
      type: 'array',
      minItems: SUGGESTIONS_PER_RESPONSE,
      maxItems: SUGGESTIONS_PER_RESPONSE,
      items: SUGGESTION_SCHEMA,
      description: 'Exactly five compact answer or discovery options relevant to the question.',
    },
  },
  required: ['question', 'suggestions'],
});

const BASE_TOOLS = Object.freeze([
  {
    type: 'function',
    function: {
      name: BASE_TOOL_NAMES.SEARCH,
      description: 'Find the exact authorized Homeroom operation needed for the user request. Use this when no currently exposed capability tool clearly matches. A returned match contains an id and toolName; call that tool on the next step. An empty result describes only this search, not every Homeroom feature.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: {
            type: 'string', minLength: 1, maxLength: 240,
            description: 'Short action plus object, for example "list apps", "find open issues", or "edit notification settings". Do not copy the entire user message.',
          },
          context: {
            type: ['string', 'null'], maxLength: 400,
            description: 'Known active app slug or active object relevant to the search. Use null when there is no relevant context.',
          },
        },
        required: ['query', 'context'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: BASE_TOOL_NAMES.DESCRIBE,
      description: 'Inspect one authorized capability before executing it when its required inputs or effect are unclear. Use the exact capability id returned by search_capabilities; then call the returned toolName with only schema-approved inputs.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          capabilityId: {
            type: 'string', minLength: 3, maxLength: 120, pattern: CAPABILITY_PATTERN,
            description: 'Exact capability id previously exposed in metadata or returned by search_capabilities. Never invent an id.',
          },
        },
        required: ['capabilityId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: BASE_TOOL_NAMES.ASK,
      description: 'Stop and ask the user for one required input that is absent from the user request, runtime metadata, and authoritative results. Use only when the capability cannot be called safely without that value. Do not use this tool to answer a platform question, claim an action failed, or replace a required confirmation.',
      strict: true,
      parameters: CLARIFICATION_SCHEMA,
    },
  },
  {
    type: 'function',
    function: {
      name: BASE_TOOL_NAMES.PRESENT,
      description: 'Finish the turn after all required platform tools have completed. Call exactly once. Keep the message compact, leave resultRefs empty for this turn, and supply exactly five new button suggestions. Homeroom renders authoritative results and adds More suggestions and Open in Classic controls itself.',
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
      description: `Execute this exact Homeroom capability. Title: ${definition.title}. Purpose: ${definition.summary} Capability id: ${definition.id}. Risk: ${definition.risk}. Confirmation: ${definition.confirmation}. Supply every required parameter from runtime metadata, the user, or an earlier tool result. Never guess a value and never add fields outside the schema.`,
      strict: true,
      parameters: structuredClone(definition.inputSchema),
    },
  };
}

function toolSet(definitions, {
  includeSearch = true,
  includeDescribe = true,
  includeAsk = false,
  includePresent = true,
} = {}) {
  const enabledBaseTools = BASE_TOOLS.filter((tool) => {
    if (tool.function.name === BASE_TOOL_NAMES.SEARCH) return includeSearch;
    if (tool.function.name === BASE_TOOL_NAMES.DESCRIBE) return includeDescribe;
    if (tool.function.name === BASE_TOOL_NAMES.ASK) return includeAsk;
    if (tool.function.name === BASE_TOOL_NAMES.PRESENT) return includePresent;
    return true;
  });
  const names = new Set(enabledBaseTools.map((tool) => tool.function.name));
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
    tools: [...enabledBaseTools.map((tool) => structuredClone(tool)), ...dynamic],
    capabilityByToolName: byName,
  };
}

module.exports = {
  BASE_TOOL_NAMES,
  BASE_TOOLS,
  CLARIFICATION_SCHEMA,
  PRESENTATION_SCHEMA,
  SUGGESTION_SCHEMA,
  capabilityTool,
  capabilityToolName,
  toolSet,
};
