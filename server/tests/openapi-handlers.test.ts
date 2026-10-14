import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
const spec = parse(readFileSync(new URL("../../spec/openapi.yaml", import.meta.url), "utf8"));
const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];
const exported = (node: ts.Node) => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const hidden = (node: ts.Node) => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword)
    || ((node as ts.MethodDeclaration).name !== undefined && ts.isPrivateIdentifier((node as ts.MethodDeclaration).name));
function handlerNames(source: string, fileName = "module.ts"): Set<string> {
    const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const names = new Set<string>();
    const local = new Map<string, ts.Node>();
    const listed: string[] = [];
    for (const statement of file.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name)
            local.set(statement.name.text, statement);
        if (ts.isClassDeclaration(statement) && statement.name)
            local.set(statement.name.text, statement);
        if (ts.isVariableStatement(statement))
            for (const d of statement.declarationList.declarations)
                if (ts.isIdentifier(d.name))
                    local.set(d.name.text, d);
        if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause))
            for (const e of statement.exportClause.elements)
                listed.push((e.propertyName ?? e.name).text);
    }
    const add = (node: ts.Node) => {
        if (ts.isFunctionDeclaration(node) && node.name)
            names.add(node.name.text);
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
            names.add(node.name.text);
        if (ts.isClassDeclaration(node))
            for (const member of node.members)
                if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && !hidden(member))
                    names.add(member.name.text);
    };
    for (const statement of file.statements) {
        if (!exported(statement))
            continue;
        if (ts.isVariableStatement(statement))
            statement.declarationList.declarations.forEach(add);
        else
            add(statement);
    }
    for (const name of listed)
        if (local.has(name))
            add(local.get(name)!);
    return names;
}
function handlers() {
    const found: {
        operationId: string;
        handler: string;
    }[] = [];
    for (const [path, item] of Object.entries<any>(spec.paths))
        for (const method of METHODS) {
            const operation = item?.[method];
            if (operation && "x-authoritative-handler" in operation)
                found.push({ operationId: operation.operationId ?? `${method.toUpperCase()} ${path}`, handler: operation["x-authoritative-handler"] });
        }
    return found;
}
const cache = new Map<string, Set<string> | null>();
function resolves(handler: unknown): boolean {
    if (typeof handler !== "string")
        return false;
    const match = /^([a-z][a-z0-9-]*)\.([A-Za-z_$][\w$]*)$/.exec(handler);
    if (!match)
        return false;
    const [, module, name] = match;
    if (!cache.has(module)) {
        const url = new URL(`../src/${module}.ts`, import.meta.url);
        cache.set(module, existsSync(url) ? handlerNames(readFileSync(url, "utf8"), `${module}.ts`) : null);
    }
    return cache.get(module)?.has(name) ?? false;
}
describe("openapi x-authoritative-handler", () => {
    it("names an exported function, or a public method of an exported class, in the named src module", () => {
        const all = handlers();
        expect(all.length).toBeGreaterThan(0);
        expect(all.filter(({ handler }) => !resolves(handler))).toEqual([]);
    });
    it("rejects names the convention does not admit", () => {
        const names = handlerNames(`
      export function a() {}
      export async function b() {}
      export const c = () => {};
      function d() {}
      function e() {}
      export { e };
      class Hidden { visible() {} }
      export class Service { async m() {} private p() {} #q() {} }
    `);
        expect([...names].sort()).toEqual(["a", "b", "c", "e", "m"]);
        for (const bogus of ["lifecycle.claimTask", "audit.createWebhook", "nope.claim", "lifecycle", "lifecycle.TaskLifecycle.claim"])
            expect(resolves(bogus), bogus).toBe(false);
        for (const real of ["lifecycle.claim", "webhooks.createWebhook", "auth.bindingCookie", "code-view.readTree"])
            expect(resolves(real), real).toBe(true);
    });
});
