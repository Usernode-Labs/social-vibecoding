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

// The backend's sources: CommonJS .js, plus the workflow foundation's .ts
// (src/workflow/, loaded through Node's type stripping).
function walkJs(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkJs(full));
    else if (entry.isFile() && (entry.name.endsWith('.js')
      || (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')))) files.push(full);
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
    // The maintenance-only role helper is deployed by the bootstrap Job,
    // outside schema.sql. Validate its callers against its actual declaration
    // in this throwaway catalog; never invoke its administrative body here.
    const { adoptionFunctionSql } = require('./bootstrap-database-roles');
    await client.query(adoptionFunctionSql(require('../src/services/database-role-access').names(), 'sql_check_platform'));

  } finally {
    await client.end();
  }
}

// Reuse lint:sql's complete shadow schema: no second server or schema load.
// A fresh, isolated role avoids touching any role used outside this fixture.
async function validatePlatformPreviewPolicy(connectionUrl) {
  const started = performance.now();
  const preview = require('../src/services/platform-preview-data-policy');
  const client = new Client({ connectionString: connectionUrl });
  await client.connect();
  try {
    await client.query('SET search_path = pg_catalog');
    const { rows } = await client.query(preview.CATALOG_SQL);
    const catalog = JSON.parse(rows[0].inventory);
    preview.verifyCatalog(catalog);
    return { tables: catalog.relations.length, durationMs: Math.round(performance.now() - started) };
  } finally { await client.end(); }
}

async function validateDebugAccess(connectionUrl) {
  const started = performance.now();
  const { buildGrantStatements, READABLE_COLUMNS } = require('../src/services/debug-access');
  const { verifyDebugRole } = require('../src/services/debug-role-policy');
  const role = `debug_check_${crypto.randomBytes(8).toString('hex')}`;
  const password = crypto.randomBytes(24).toString('hex');
  const admin = new Client({ connectionString: connectionUrl, connectionTimeoutMillis: 5000 });
  const options = new URL(connectionUrl);
  options.username = role;
  options.password = password;
  const reader = new Client({ connectionString: options.href, connectionTimeoutMillis: 5000 });
  let created = false;
  let result;
  await admin.connect();
  try {
    await admin.query(`CREATE ROLE ${quoteIdentifier(role)} LOGIN NOINHERIT PASSWORD '${password}'`);
    created = true;
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(role)}`);
    const { rows } = await admin.query(`SELECT c.relname AS table, c.relkind AS kind,
        array_agg(a.attname::text ORDER BY a.attnum) AS columns
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND a.attnum > 0 AND NOT a.attisdropped GROUP BY c.relname, c.relkind`);
    for (const sql of buildGrantStatements(rows, role)) await admin.query(sql);
    result = await verifyDebugRole(admin, { role, readableColumns: READABLE_COLUMNS, requireAllColumns: true });

    await reader.connect();
    const { rows: [identity] } = await reader.query('SELECT current_user AS role');
    if (identity.role !== role) throw new Error('debug policy probe did not use its restricted login');
    await reader.query('SELECT id, slug, status FROM public.apps LIMIT 0');
    for (const sql of [
      'SELECT password FROM public.users LIMIT 0',
      'SELECT row_to_json(u) FROM public.users u LIMIT 0',
      'SELECT content FROM public.conversation_messages LIMIT 0',
      'SELECT payload FROM public.wf_events LIMIT 0',
      'UPDATE public.apps SET status = status WHERE FALSE',
    ]) {
      try {
        await reader.query(sql);
      } catch (error) {
        if (error.code === '42501') continue;
        throw error;
      }
      throw new Error(`debug role unexpectedly permitted: ${sql}`);
    }
  } finally {
    await reader.end();
    try {
      if (created) {
        await admin.query(`DROP OWNED BY ${quoteIdentifier(role)}`);
        await admin.query(`DROP ROLE ${quoteIdentifier(role)}`);
      }
    } finally { await admin.end(); }
  }
  return { ...result, durationMs: Math.round(performance.now() - started) };
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
    const previewPolicy = await validatePlatformPreviewPolicy(shadow.shadowUrl);
    console.log(`Platform preview policy verified for ${previewPolicy.tables} tables (${previewPolicy.durationMs} ms).`);
    const debugPolicy = await validateDebugAccess(shadow.shadowUrl);
    console.log(`Debug SQL policy verified for ${debugPolicy.columns} reviewed columns (${debugPolicy.durationMs} ms).`);
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
  validateDebugAccess,
  validatePlatformPreviewPolicy,
  validateQueries,
};
