'use strict';
// test:changed: when frontend/ (every name the frontend's TypeScript uses; about a second)

// Every name the frontend's TypeScript uses at run time is declared in its
// file, imported into it, or a global the page has.
//
// #6100 called dirSign() in features/nav-drawer/header-drawer.tsx without
// importing it. The shell's bundler strips types file by file and never looks
// a name up, so the bare call shipped. It threw a ReferenceError the first
// time a phone opened Communities or Messages, and React took the whole header
// down until a reload. `tsc --noEmit` (frontend/package.json's typecheck)
// reports it as TS2304, but no check runs that, and it cannot simply be
// switched on: on 2 Nov 2026 it found 68 errors on main, the other 66 mostly
// null checks and declared types that have drifted from the code, and the
// whole program held about 1 GB of heap (1.3 GB at its peak). A unit-suite
// shard runs seven test files at once in 3 GiB (UNIT_SUITE_SHARD_MEMORY,
// src/services/unit-suite.js).
//
// So this asks the compiler only the question that crashes. It parses and
// binds frontend/tsconfig.json's files without following imports (an import
// declares its local name whether or not its module resolves, and the bundler
// already fails on a module that does not), then resolves every identifier in
// a value position through the checker. A lookup in scope type-checks
// nothing: about a second, and half of tsc's peak memory. A name in a type is
// erased before the code runs, so it is left to tsc. The `.js` modules under
// src/ are verbatim moves of classic scripts that talk to globals by design,
// and tsconfig.json leaves them unchecked (checkJs).
//
// What it reports is what tsc reports as TS2304 and TS2552 (no such name),
// TS2663 (a member called without `this.`), TS18004 (a shorthand property
// with nothing behind it), TS2693 (a type used as a value) and TS2686 (React
// used as a global: the UMD global exists only in the types, so a module must
// import it).
//
// Run with: node --test tests/frontend-unresolved-names.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');
// The frontend's own compiler, the version its typecheck script runs. The
// root install carries a different major. The suite's pretest installs this
// one (scripts/ensure-shell-artifacts.js).
const ts = require(path.join(FRONTEND, 'node_modules', 'typescript'));

// Positions where an identifier is not a lookup in scope: a member's name, a
// declaration's own name, an import's or export's names, a label, the `meta`
// of import.meta, a JSX attribute, and an intrinsic element such as <div>.
function notALookup(id) {
  const p = id.parent;
  if (ts.isShorthandPropertyAssignment(p)) return false;
  if (ts.isPropertyAccessExpression(p)) return p.name === id;
  if (ts.isQualifiedName(p)) return p.right === id;
  if (ts.isBindingElement(p) || ts.isImportSpecifier(p)) return true;
  if (ts.isExportSpecifier(p) || ts.isMetaProperty(p) || ts.isJsxAttribute(p) || ts.isImportTypeNode(p)) return true;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return p.label === id;
  if (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) return /^[a-z]/.test(id.text);
  return ts.getNameOfDeclaration(p) === id;
}

// In a type, an interface or a type alias: gone before the code runs. A
// class's `extends` is the one heritage clause that stays.
function erased(id) {
  for (let n = id.parent; n && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isExpressionWithTypeArguments(n)) {
      if (!ts.isHeritageClause(n.parent)) return false;
      return !(n.parent.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(n.parent.parent));
    }
    if (ts.isTypeNode(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) return true;
  }
  return false;
}

// `extra` maps a repo-relative path to source text, checked as though it were
// one more file in frontend/src.
function unresolvedNames(extra = {}) {
  const parsed = ts.getParsedCommandLineOfConfigFile(path.join(FRONTEND, 'tsconfig.json'), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); },
  });
  assert.deepEqual(parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')), [], 'frontend/tsconfig.json parses');
  const options = { ...parsed.options, noResolve: true };
  const virtual = new Map(Object.entries(extra).map(([rel, text]) => [path.join(ROOT, rel), text]));
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists } = host;
  host.getSourceFile = (name, version, ...rest) => (virtual.has(name)
    ? ts.createSourceFile(name, virtual.get(name), version, true, ts.ScriptKind.TSX)
    : getSourceFile.call(host, name, version, ...rest));
  host.fileExists = (name) => virtual.has(name) || fileExists.call(host, name);

  const files = [...parsed.fileNames.filter((f) => /\.tsx?$/.test(f)), ...virtual.keys()];
  const program = ts.createProgram({ rootNames: files, options, host });
  const checker = program.getTypeChecker();
  const found = [];
  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (sf.isDeclarationFile) continue;
    const visit = (node) => {
      if (ts.isIdentifier(node) && !notALookup(node) && !erased(node)) {
        const symbol = ts.isShorthandPropertyAssignment(node.parent)
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : checker.getSymbolAtLocation(node);
        if (!symbol) {
          const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          found.push(`${path.relative(ROOT, file)}:${line + 1}:${character + 1} ${node.text}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { files: files.map((f) => path.relative(ROOT, f)), found };
}

// #6100's mistake, and the same file with its imports. Under noResolve an
// import needs no module behind it, so the twin can import names from
// anywhere.
const BODY = `
export function Slide({ x }: { x: number }): React.ReactNode {
  React.useEffect(() => {});
  const shift = { x: x * dirSign(), missingOffset };
  return <div style={{ transform: \`translate3d(\${shift.x}px, 0, 0)\` }}><DrawerBack /></div>;
}
`;
const BAD = 'frontend/src/features/nav-drawer/unimported-name-fixture.tsx';
const GOOD = 'frontend/src/features/nav-drawer/imported-name-fixture.tsx';
const FIXTURES = {
  [BAD]: BODY,
  [GOOD]: `import * as React from 'react';
import { dirSign } from '../../lib/i18n/direction';
import { DrawerBack, missingOffset } from './somewhere';
${BODY}`,
};

let result;
const check = () => (result ??= unresolvedNames(FIXTURES));

test('the check finds a name nothing declares or imports, as #6100\'s dirSign() was', () => {
  const { found } = check();
  assert.deepEqual(found.filter((f) => f.startsWith(BAD)), [
    `${BAD}:3:3 React`,
    `${BAD}:4:26 dirSign`,
    `${BAD}:4:37 missingOffset`,
    `${BAD}:5:73 DrawerBack`,
  ], 'a call, a UMD global, a shorthand property and a component, while React.ReactNode in a type passes');
  assert.deepEqual(found.filter((f) => f.startsWith(GOOD)), [], 'the same code with its imports passes');
});

test('every name the frontend\'s TypeScript uses at run time is declared, imported or global', () => {
  const { files, found } = check();
  assert.ok(files.length > 500, `checked ${files.length} files: frontend/tsconfig.json's include still finds the sources`);
  assert.ok(files.includes('frontend/src/features/nav-drawer/header-drawer.tsx'), 'the file #6100 broke is among them');
  assert.deepEqual(found.filter((f) => !f.startsWith(BAD)), [],
    'each of these is a ReferenceError when that line runs (the bundler keeps the bare name): '
    + 'import it, or declare a real page global in frontend/src/legacy-globals.d.ts');
});
