// Parse declarations rather than matching source text: comments and strings are
// never tests. Only direct file/suite statements are proven executable; opaque
// conditions, helper functions, and focused declarations fail closed.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/control-plane/package.json', import.meta.url));
const ts = require('typescript');

export function collectTests(source) {
  const file = ts.createSourceFile('coverage.test.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const tests = new Map();
  let focused = false;
  function nonemptyCases(node, bindings) {
    while (node && (ts.isAsExpression(node) || ts.isParenthesizedExpression(node))) node = node.expression;
    if (node && ts.isIdentifier(node)) return bindings.get(node.text) === true;
    return node && ts.isArrayLiteralExpression(node) && node.elements.some(element => !ts.isSpreadElement(element));
  }
  function declaration(expression, bindings) {
    let node = expression, enabled = true;
    while (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node)) {
      if (ts.isCallExpression(node)) {
        if (!ts.isPropertyAccessExpression(node.expression)) return null;
        const modifier = node.expression.name.text;
        if (modifier === 'skipIf') enabled &&= node.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword;
        else if (modifier === 'runIf') enabled &&= node.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword;
        else if (modifier === 'each') enabled &&= !!nonemptyCases(node.arguments[0], bindings);
        else enabled = false;
        node = node.expression.expression;
      } else {
        const modifier = node.name.text;
        if (modifier === 'only') focused = true;
        if (!['concurrent', 'sequential'].includes(modifier)) enabled = false;
        node = node.expression;
      }
    }
    return ts.isIdentifier(node) && ['it', 'test', 'describe'].includes(node.text)
      ? { kind: node.text, enabled } : null;
  }
  function statements(nodes, ancestorsEnabled, parentBindings = new Map()) {
    const bindings = new Map(parentBindings);
    for (const statement of nodes) {
      if (ts.isVariableStatement(statement)) {
        for (const binding of statement.declarationList.declarations) {
          if (ts.isIdentifier(binding.name)) bindings.set(binding.name.text, !!(statement.declarationList.flags & ts.NodeFlags.Const) && !!nonemptyCases(binding.initializer, bindings));
        }
      }
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
      const call = statement.expression, decl = declaration(call.expression, bindings);
      if (!decl) continue;
      const title = call.arguments[0];
      if (!title || !(ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))) continue;
      // Vitest accepts (title, fn[, timeout]) and (title, options, fn).
      // Select by callback syntax so a timeout/options argument is never
      // mistaken for a missing test body. Modifiers still gate execution above.
      const isCallback = node => node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
      const callback = isCallback(call.arguments[1]) ? call.arguments[1] : call.arguments[2];
      const hasCallback = isCallback(callback);
      let optionsEnabled = true;
      if (hasCallback && callback === call.arguments[2]) {
        const options = call.arguments[1];
        // Unknown options may hide skip/todo/only; prove these flags inactive.
        optionsEnabled = !!options && ts.isObjectLiteralExpression(options);
        if (!optionsEnabled) focused = true;
        else for (const property of options.properties) {
          if (ts.isSpreadAssignment(property) || ts.isComputedPropertyName(property.name)) {
            optionsEnabled = false;
            focused = true;
            continue;
          }
          const name = property.name?.text;
          if (!['skip', 'todo', 'only'].includes(name)) continue;
          const inactive = ts.isPropertyAssignment(property) && property.initializer.kind === ts.SyntaxKind.FalseKeyword;
          if (!inactive) {
            optionsEnabled = false;
            if (name === 'only') focused = true;
          }
        }
      }
      const enabled = ancestorsEnabled && decl.enabled && optionsEnabled && !!hasCallback;
      if (decl.kind === 'describe') {
        if (hasCallback && ts.isBlock(callback.body)) statements(callback.body.statements, enabled, bindings);
      } else {
        tests.set(title.text, tests.get(title.text) === 'found' || enabled ? 'found' : 'skipped');
      }
    }
  }
  statements(file.statements, true);
  // An only anywhere in executable declarations can suppress other coverage.
  if (focused || file.parseDiagnostics.length) for (const title of tests.keys()) tests.set(title, 'skipped');
  return tests;
}
