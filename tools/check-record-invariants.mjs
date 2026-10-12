#!/usr/bin/env node
// Verifies tests/record-invariants.todo.md against docs/COLLABORATION_RECORD.md and the test sources:
//  - the doc and the list agree on the set of INV-nn identifiers;
//  - every primary row is `covered` or `planned`; supplemental rows must be covered;
//  - every `covered` primary/supplemental row names an existing test file that contains an un-skipped it/test with exactly that title.
// `planned` rows are reported as planned; they verify nothing.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectTests } from "./record-test-declarations.mjs";

// --root supports isolated checker regression fixtures.
const root = resolve(process.argv[2] === "--root" ? process.argv[3] : new URL("..", import.meta.url).pathname);
const doc = readFileSync(resolve(root, "docs/COLLABORATION_RECORD.md"), "utf8");
const todo = readFileSync(resolve(root, "tests/record-invariants.todo.md"), "utf8");

const defined = new Set([...doc.matchAll(/\*\*(INV-\d{2})\*\*/g)].map((m) => m[1]));
const listed = new Set([...todo.matchAll(/^\| (INV-\d{2}) \|/gm)].map((m) => m[1]));
const primaryRows = [...todo.matchAll(/^\| (INV-\d{2}) \| ([^|]+) \| (covered|planned) \| `([^`]+)` \| `([^`]+)` \|$/gm)]
  .map((m) => ({ id: m[1], status: m[3], file: m[4], title: m[5] }));

const supplementalRows = [...todo.matchAll(/^\| (INV-\d{2}) extra \| ([^|]+) \| (covered) \| `([^`]+)` \| `([^`]+)` \|$/gm)]
  .map((m) => ({ id: m[1], status: m[3], file: m[4], title: m[5] }));
const rows = [...primaryRows, ...supplementalRows];
const errors = [];
for (const row of supplementalRows) if (!defined.has(row.id)) errors.push(`supplemental reference for unknown invariant ${row.id}`);
if ((todo.match(/^\| INV-\d{2} extra \|/gm) ?? []).length !== supplementalRows.length) errors.push('malformed supplemental reference');
const missingInTodo = [...defined].filter((id) => !listed.has(id)).sort();
const missingInDoc = [...listed].filter((id) => !defined.has(id)).sort();
if (missingInTodo.length) errors.push(`invariants defined in the doc but without a row: ${missingInTodo.join(", ")}`);
if (missingInDoc.length) errors.push(`rows for invariants the doc does not define: ${missingInDoc.join(", ")}`);
if (primaryRows.length !== listed.size) errors.push(`malformed rows in tests/record-invariants.todo.md (${primaryRows.length} parsed, ${listed.size} ids)`);

const declarations = new Map();

const counts = { covered: 0, planned: 0 };
for (const row of rows) {
  counts[row.status]++;
  if (row.status === "planned") continue;
  const path = resolve(root, row.file);
  if (!existsSync(path)) { errors.push(`${row.id}: test file ${row.file} does not exist`); continue; }
  if (!declarations.has(path)) declarations.set(path, collectTests(readFileSync(path, "utf8")));
  const found = declarations.get(path).get(row.title) ?? "missing";
  if (found === "skipped") errors.push(`${row.id}: test "${row.title}" in ${row.file} is skipped or todo`);
  else if (found === "missing") errors.push(`${row.id}: no test titled "${row.title}" in ${row.file}`);
}

if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
const planned = rows.filter((r) => r.status === "planned").map((r) => r.id);
console.log(`record invariants: ${defined.size} defined, ${primaryRows.filter(r => r.status === "covered").length} covered by existing tests (verified), ${counts.planned} planned (no test yet)`);
console.log(`supplemental references: ${supplementalRows.length} verified`);
console.log(`planned: ${planned.join(", ")}`);
