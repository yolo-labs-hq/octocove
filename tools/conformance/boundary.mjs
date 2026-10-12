import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ts = createRequire(new URL('./package.json', import.meta.url))('typescript');
// Detect executable dependencies, symbols and persisted payload keys, not prose
// mentions or generic visual Card components. See the semantic review in README.
// The built-in detector rejects generic work-item payload keys. Additional forbidden symbols
// (`boundary_symbols`) and module specifiers (`boundary_modules`) can be supplied in a rules file
// whose path OCTOCOVE_PRIVATE_PATTERNS names (relative to the repository root, or absolute).
const privatePath = process.env.OCTOCOVE_PRIVATE_PATTERNS;
const privateFile = privatePath && resolve(fileURLToPath(new URL('../../', import.meta.url)), privatePath);
const privateRules = privateFile && existsSync(privateFile) ? JSON.parse(readFileSync(privateFile, 'utf8')) : {};
/** Detectors for `rules` ({boundary_symbols, boundary_modules}: regular-expression sources). */
export function detectors(rules = {}) {
  const symbols = [...rules.boundary_symbols ?? [], 'cardId', 'card_id'];
  const modules = rules.boundary_modules ?? [];
  return { symbol: new RegExp(`^(?:${symbols.join('|')})$`, 'i'), module: modules.length ? new RegExp(modules.join('|'), 'i') : null };
}
const defaults = detectors(privateRules);
export function inspectSource(source, fileName, { symbol: forbiddenSymbol, module: forbiddenModule } = defaults) {
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, /tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const findings = [];
  function add(node, reason) { findings.push({ file:fileName,line:tree.getLineAndCharacterOfPosition(node.getStart()).line+1,reason }); }
  function visit(node) {
    if (ts.isIdentifier(node) && forbiddenSymbol.test(node.text)) add(node,'client-specific-symbol');
    if (ts.isStringLiteralLike(node)) {
      const parent = node.parent;
      const module = ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent) ||
        (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) ||
        (ts.isCallExpression(parent) && (parent.expression.kind === ts.SyntaxKind.ImportKeyword || parent.expression.getText(tree) === 'require'));
      if (module && forbiddenModule?.test(node.text)) add(node,'client-specific-import');
      if (((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node || ts.isElementAccessExpression(parent) && parent.argumentExpression === node) && forbiddenSymbol.test(node.text)) add(node,'client-specific-payload-key');
    }
    ts.forEachChild(node,visit);
  }
  visit(tree); return findings;
}
export function boundary(root) {
  const findings = [];
  function walk(dir) {
    for (const entry of readdirSync(dir,{withFileTypes:true})) {
      if (['node_modules','dist','.wrangler','.next','.git'].includes(entry.name)) continue;
      const file = join(dir,entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:[cm]?js|tsx?|mts|cts)$/.test(entry.name)) findings.push(...inspectSource(readFileSync(file,'utf8'),relative(root,file)));
    }
  }
  for (const dir of ['apps','packages']) if (existsSync(join(root,dir))) walk(join(root,dir));
  return {status:findings.length?'FAIL':'PASS',findings,semanticReview:'tools/conformance/README.md#boundary-review'};
}
