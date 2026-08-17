#!/usr/bin/env node
'use strict';

// Validate the backend's statically resolvable node-postgres queries against
// a real PostgreSQL parser and catalog without executing them. The platform
// backend is CommonJS JavaScript, so the TypeScript compiler is used only as
// an AST and symbol resolver; no application source is compiled or emitted.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const postgres = require('postgres');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const DYNAMIC_BASELINE = path.join(ROOT, 'sql-dynamic-baseline.json');
const DEFAULT_CONNECTION_URL = 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const VALIDATION_CONCURRENCY = 8;

function walkJs(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkJs(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

function unwrap(node) {
  while (node && (
    ts.isParenthesizedExpression(node)
    || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node)
    || ts.isNonNullExpression(node)
  )) node = node.expression;
  return node;
}

function unique(values) {
  return [...new Set(values)];
}

function combine(left, right) {
  if (!left || !right || left.length * right.length > 32) return null;
  return unique(left.flatMap((a) => right.map((b) => a + b)));
}

function collectQueryInventory(root = ROOT) {
  const sourceFiles = [path.join(root, 'server.js'), ...walkJs(path.join(root, 'src'))]
    .filter((file) => fs.existsSync(file))
    .sort();

  const program = ts.createProgram(sourceFiles, {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
  });
  const checker = program.getTypeChecker();

  function declarationInitializer(symbol) {
    const declarations = symbol && symbol.declarations ? symbol.declarations : [];
    for (const declaration of declarations) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return declaration.initializer;
      }
      if (ts.isPropertyAssignment(declaration)) return declaration.initializer;
      if (ts.isPropertyDeclaration(declaration) && declaration.initializer) {
        return declaration.initializer;
      }
    }
    return null;
  }

  // Return every unconditional finite string value an expression can take.
  // Conditional query builders stay in the reviewed dynamic inventory:
  // independently expanding their fragments would create branch combinations
  // that the application can never emit.
  function staticStrings(input, seen = new Set()) {
    const node = unwrap(input);
    if (!node) return null;

    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return [node.text];
    }
    if (ts.isNumericLiteral(node)) return [node.text];
    if (node.kind === ts.SyntaxKind.TrueKeyword) return ['true'];
    if (node.kind === ts.SyntaxKind.FalseKeyword) return ['false'];

    if (ts.isTemplateExpression(node)) {
      let values = [node.head.text];
      for (const span of node.templateSpans) {
        values = combine(values, staticStrings(span.expression, seen));
        if (!values) return null;
        values = values.map((value) => value + span.literal.text);
      }
      return unique(values);
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return combine(staticStrings(node.left, seen), staticStrings(node.right, seen));
    }

    if (ts.isTaggedTemplateExpression(node)) {
      return staticStrings(node.template, seen);
    }

    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (!symbol || seen.has(symbol)) return null;
      const initializer = declarationInitializer(symbol);
      if (!initializer) return null;
      const nextSeen = new Set(seen);
      nextSeen.add(symbol);
      return staticStrings(initializer, nextSeen);
    }

    return null;
  }

  function queryTextExpression(input) {
    const node = unwrap(input);
    if (!node) return null;
    if (ts.isObjectLiteralExpression(node)) {
      const textProperty = node.properties.find((property) => (
        ts.isPropertyAssignment(property)
        && ((ts.isIdentifier(property.name) && property.name.text === 'text')
          || (ts.isStringLiteralLike(property.name) && property.name.text === 'text'))
      ));
      return textProperty ? textProperty.initializer : null;
    }
    return node;
  }

  function isQueryCall(node) {
    if (!ts.isCallExpression(node)) return false;
    const callee = unwrap(node.expression);
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 'query';
    if (ts.isElementAccessExpression(callee) && callee.argumentExpression) {
      const key = staticStrings(callee.argumentExpression);
      return key && key.length === 1 && key[0] === 'query';
    }
    return false;
  }

  function lineOf(sourceFile, node) {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  }

  function hash(text) {
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 20);
  }

  function dynamicKind(node) {
    const value = unwrap(node);
    if (value && ts.isTemplateExpression(value)) return 'structural-template';
    if (value && (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value))) {
      return 'runtime-built-identifier';
    }
    if (value && ts.isObjectLiteralExpression(value)) return 'query-config-expression';
    return 'runtime-expression';
  }

  const queries = [];
  const dynamic = [];
  let queryCalls = 0;

  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFiles.includes(sourceFile.fileName)) continue;
    const source = path.relative(root, sourceFile.fileName).split(path.sep).join('/');

    function visit(node) {
      if (isQueryCall(node)) {
        queryCalls += 1;
        const argument = node.arguments[0];
        const expression = queryTextExpression(argument);
        const values = expression ? staticStrings(expression) : null;
        if (values) {
          for (let index = 0; index < values.length; index += 1) {
            queries.push({
              source,
              line: lineOf(sourceFile, node),
              variant: values.length > 1 ? `${index + 1}/${values.length}` : null,
              text: values[index],
            });
          }
        } else {
          const original = argument ? argument.getText(sourceFile) : '<missing first argument>';
          dynamic.push({
            source,
            kind: dynamicKind(expression || argument),
            fingerprint: hash(original),
            count: 1,
            preview: original.replace(/\s+/g, ' ').slice(0, 160),
            line: lineOf(sourceFile, node),
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  const dynamicQueries = [...dynamic.reduce((map, entry) => {
    const key = `${entry.source}:${entry.kind}:${entry.fingerprint}`;
    const existing = map.get(key);
    if (existing) existing.count += 1;
    else map.set(key, { ...entry, line: undefined });
    return map;
  }, new Map()).values()].sort((a, b) => (
    a.source.localeCompare(b.source)
    || a.kind.localeCompare(b.kind)
    || a.fingerprint.localeCompare(b.fingerprint)
  ));

  return {
    queryCalls,
    queries,
    dynamicCalls: dynamic.length,
    dynamicQueries,
  };
}

function baselineFor(inventory) {
  return {
    version: 1,
    description: 'Runtime-built .query() calls reviewed outside the static PostgreSQL validator.',
    queries: inventory.dynamicQueries.map(({ source, kind, fingerprint, count, preview }) => ({
      source, kind, fingerprint, count, preview,
    })),
  };
}

function checkDynamicBaseline(inventory, { write = false } = {}) {
  const actual = baselineFor(inventory);
  if (write) {
    fs.writeFileSync(DYNAMIC_BASELINE, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }

  let expected;
  try {
    expected = JSON.parse(fs.readFileSync(DYNAMIC_BASELINE, 'utf8'));
  } catch {
    throw new Error(
      'SQL dynamic-query baseline is missing or invalid. Review the inventory, then run:\n'
      + '  node scripts/check-sql.js --write-dynamic-baseline'
    );
  }

  if (JSON.stringify(expected.queries) === JSON.stringify(actual.queries)) return;

  const expectedKeys = new Set(expected.queries.map((entry) => JSON.stringify(entry)));
  const actualKeys = new Set(actual.queries.map((entry) => JSON.stringify(entry)));
  const changes = ['SQL dynamic-query inventory changed. Review every added or changed query.'];
  for (const entry of actual.queries) {
    if (!expectedKeys.has(JSON.stringify(entry))) changes.push(`  added: ${entry.source} ${entry.preview}`);
  }
  for (const entry of expected.queries) {
    if (!actualKeys.has(JSON.stringify(entry))) changes.push(`  removed: ${entry.source} ${entry.preview}`);
  }
  changes.push('After review, refresh with:');
  changes.push('  node scripts/check-sql.js --write-dynamic-baseline');
  throw new Error(changes.join('\n'));
}

function inventorySummary(inventory) {
  return `${inventory.queries.length} static query variants from ${inventory.queryCalls} .query() calls; `
    + `${inventory.dynamicCalls} dynamic calls (${inventory.dynamicQueries.length} fingerprints)`;
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function createShadowDatabase(connectionUrl) {
  let parsed;
  try {
    parsed = new URL(connectionUrl);
  } catch {
    throw new Error('SQL_CHECK_CONNECTION_URL must be a valid PostgreSQL URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('SQL_CHECK_CONNECTION_URL must use the postgres: or postgresql: protocol.');
  }

  const databaseName = `sql_check_${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
  const admin = new Client({ connectionString: connectionUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  } catch (error) {
    await admin.end();
    throw new Error(`Could not create PostgreSQL shadow database: ${error.message}`);
  }

  parsed.pathname = `/${databaseName}`;
  const shadowUrl = parsed.toString();
  return {
    databaseName,
    shadowUrl,
    async cleanup() {
      try {
        await admin.query(`DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    },
  };
}

async function applySchema(connectionUrl) {
  const client = new Client({ connectionString: connectionUrl });
  await client.connect();
  try {
    const schema = fs.readFileSync(path.join(ROOT, 'src', 'db', 'schema.sql'), 'utf8');
    await client.query(schema);
  } finally {
    await client.end();
  }
}

async function mapConcurrent(items, concurrency, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await fn(items[index], index);
    }
  });
  await Promise.all(workers);
}

function conciseError(error) {
  return String(error && error.message ? error.message : error).replace(/\s+/g, ' ').trim();
}

async function validateQueries(inventory, connectionUrl) {
  const referencesByText = new Map();
  for (const query of inventory.queries) {
    const references = referencesByText.get(query.text) || [];
    references.push(query);
    referencesByText.set(query.text, references);
  }
  const uniqueQueries = [...referencesByText.entries()];
  const sql = postgres(connectionUrl, {
    max: VALIDATION_CONCURRENCY,
    connect_timeout: 10,
    idle_timeout: 5,
    onnotice: () => {},
  });
  const failures = [];

  try {
    await mapConcurrent(uniqueQueries, VALIDATION_CONCURRENCY, async ([queryText, references]) => {
      try {
        // Parse + Describe asks PostgreSQL to resolve relations, columns and
        // parameter types, but deliberately sends no Bind or Execute message.
        const result = await sql.unsafe(queryText, [], { prepare: true }).describe();
        const counts = new Map();
        for (const column of result.columns || []) {
          counts.set(column.name, (counts.get(column.name) || 0) + 1);
        }
        const duplicates = [...counts].filter(([, count]) => count > 1).map(([name]) => name);
        if (duplicates.length) {
          throw new Error(`duplicate result column${duplicates.length === 1 ? '' : 's'}: ${duplicates.join(', ')}`);
        }
      } catch (error) {
        failures.push({ references, message: conciseError(error) });
      }
    });
  } finally {
    await sql.end({ timeout: 5 });
  }

  failures.sort((a, b) => (
    a.references[0].source.localeCompare(b.references[0].source)
    || a.references[0].line - b.references[0].line
  ));
  if (failures.length) {
    for (const failure of failures) {
      const shown = failure.references.slice(0, 5);
      for (const reference of shown) {
        const variant = reference.variant ? ` (variant ${reference.variant})` : '';
        console.error(`${reference.source}:${reference.line}${variant}: ${failure.message}`);
      }
      if (failure.references.length > shown.length) {
        console.error(`  and ${failure.references.length - shown.length} other call site(s)`);
      }
    }
    throw new Error(`${failures.length} unique SQL statement(s) failed PostgreSQL validation.`);
  }

  return uniqueQueries.length;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const supported = new Set(['--inventory-only', '--write-dynamic-baseline']);
  const unknown = [...args].filter((arg) => !supported.has(arg));
  if (unknown.length) throw new Error(`Unknown argument: ${unknown.join(', ')}`);

  const inventory = collectQueryInventory();
  const writeBaseline = args.has('--write-dynamic-baseline');
  checkDynamicBaseline(inventory, { write: writeBaseline });
  console.log(`SQL inventory: ${inventorySummary(inventory)}.`);
  if (writeBaseline) {
    console.log(`Updated ${path.basename(DYNAMIC_BASELINE)} after review.`);
    return;
  }
  if (args.has('--inventory-only')) return;

  const baseUrl = process.env.SQL_CHECK_CONNECTION_URL || DEFAULT_CONNECTION_URL;
  const shadow = await createShadowDatabase(baseUrl);
  try {
    await applySchema(shadow.shadowUrl);
    const uniqueCount = await validateQueries(inventory, shadow.shadowUrl);
    console.log(
      `PostgreSQL validation passed for ${uniqueCount} unique statements `
      + `(${inventory.queries.length} static variants).`
    );
  } finally {
    await shadow.cleanup();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(conciseError(error));
    process.exitCode = 1;
  });
}

module.exports = {
  baselineFor,
  checkDynamicBaseline,
  collectQueryInventory,
  inventorySummary,
  validateQueries,
};
