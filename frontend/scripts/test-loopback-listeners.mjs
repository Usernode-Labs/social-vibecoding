import ts from "typescript"

export function wildcardEphemeralListeners(source, filePath = "test.js") {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  )
  const violations = []

  function visit(node) {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "listen"
      && ts.isNumericLiteral(node.arguments[0])
      && node.arguments[0].text === "0"
    ) {
      const host = node.arguments[1]
      if (!host || !ts.isStringLiteralLike(host) || host.text !== "127.0.0.1") {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        violations.push({
          column: position.character + 1,
          file: filePath,
          line: position.line + 1,
        })
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}
