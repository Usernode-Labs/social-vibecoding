'use strict';

// A deliberately small validator for the JSON-Schema subset used by the
// capability registry and provider tools. Schemas are trusted source code;
// values are model-controlled. Keeping validation local avoids executing a
// model-selected URL/body merely because the provider claimed strict mode.

const MAX_DEPTH = 32;
const MAX_NODES = 20_000;

class JsonSchemaValidationError extends Error {
  constructor(path, message) {
    super(`${path} ${message}`);
    this.name = 'JsonSchemaValidationError';
    this.code = 'schema_validation_failed';
    this.path = path;
  }
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function matchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return plainObject(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateNode(schema, value, path, state, depth) {
  state.nodes += 1;
  if (depth > MAX_DEPTH || state.nodes > MAX_NODES) {
    throw new JsonSchemaValidationError(path, 'exceeds validation limits');
  }
  if (schema === true) return;
  if (schema === false) throw new JsonSchemaValidationError(path, 'is not allowed');
  if (!plainObject(schema) || Object.keys(schema).length === 0) return;

  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => sameJson(entry, value))) {
    throw new JsonSchemaValidationError(path, 'is not an allowed value');
  }
  if (Object.hasOwn(schema, 'const') && !sameJson(schema.const, value)) {
    throw new JsonSchemaValidationError(path, 'does not match the required value');
  }
  if (Array.isArray(schema.anyOf)) {
    const valid = schema.anyOf.some((candidate) => {
      try {
        validateNode(candidate, value, path, { nodes: state.nodes }, depth + 1);
        return true;
      } catch { return false; }
    });
    if (!valid) throw new JsonSchemaValidationError(path, 'does not match any allowed shape');
  }
  if (Array.isArray(schema.oneOf)) {
    let valid = 0;
    for (const candidate of schema.oneOf) {
      try {
        validateNode(candidate, value, path, { nodes: state.nodes }, depth + 1);
        valid += 1;
      } catch {}
    }
    if (valid !== 1) throw new JsonSchemaValidationError(path, 'must match exactly one allowed shape');
  }

  if (schema.type != null) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      throw new JsonSchemaValidationError(path, `must be ${types.join(' or ')}`);
    }
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      throw new JsonSchemaValidationError(path, 'is too short');
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      throw new JsonSchemaValidationError(path, 'is too long');
    }
    if (typeof schema.pattern === 'string') {
      let expression;
      try { expression = new RegExp(schema.pattern, 'u'); } catch {
        throw new JsonSchemaValidationError(path, 'uses an invalid source schema');
      }
      if (!expression.test(value)) throw new JsonSchemaValidationError(path, 'has an invalid format');
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      throw new JsonSchemaValidationError(path, 'is below the minimum');
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      throw new JsonSchemaValidationError(path, 'is above the maximum');
    }
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      throw new JsonSchemaValidationError(path, 'has too few items');
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      throw new JsonSchemaValidationError(path, 'has too many items');
    }
    if (schema.uniqueItems === true) {
      const keys = value.map((entry) => JSON.stringify(entry));
      if (new Set(keys).size !== keys.length) {
        throw new JsonSchemaValidationError(path, 'must contain unique items');
      }
    }
    if (schema.items != null) {
      value.forEach((entry, index) => {
        validateNode(schema.items, entry, `${path}[${index}]`, state, depth + 1);
      });
    }
  }

  if (plainObject(value)) {
    const properties = plainObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.hasOwn(value, key)) {
        throw new JsonSchemaValidationError(`${path}.${key}`, 'is required');
      }
    }
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
      if (unknown) throw new JsonSchemaValidationError(`${path}.${unknown}`, 'is not supported');
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        validateNode(properties[key], child, `${path}.${key}`, state, depth + 1);
      } else if (plainObject(schema.additionalProperties)) {
        validateNode(schema.additionalProperties, child, `${path}.${key}`, state, depth + 1);
      }
    }
  }
}

function validateJsonSchema(schema, value, { path = '$' } = {}) {
  validateNode(schema, value, path, { nodes: 0 }, 0);
  return value;
}

module.exports = {
  JsonSchemaValidationError,
  validateJsonSchema,
};
