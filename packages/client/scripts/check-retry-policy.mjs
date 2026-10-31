#!/usr/bin/env node
// Validates packages/client/retry-policy.json: every operationId of the generated routing table exactly
// once, one of the two entry shapes, values from the closed sets, `replay: null` only on reads, and the
// same classes the README's "Retry classes by operation" table assigns (so coverage cannot pass with
// invented values).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

export const AUTO_RETRY = ['never', 'network-only'];
export const REPLAY = ['stored-result', 'guarded-result', 'bounded-recovery', 'metadata-without-token', 'state', 'none', null];
export const REASONS = ['navigation', 'excluded'];
export const EXPECTED_IDS = 152;

const same = (keys, expected) => keys.length === expected.length && expected.every((key) => keys.includes(key));

function retryClass(value, where, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !same(Object.keys(value), ['autoRetry', 'replay'])) {
    errors.push(`${where}: must be exactly {autoRetry, replay}`);
    return;
  }
  if (!AUTO_RETRY.includes(value.autoRetry)) errors.push(`${where}: autoRetry ${JSON.stringify(value.autoRetry)} not in ${AUTO_RETRY.join('|')}`);
  if (!REPLAY.includes(value.replay)) errors.push(`${where}: replay ${JSON.stringify(value.replay)} not in the replay set`);
}

/** Top-level keys in source order, including duplicates JSON.parse would silently collapse. */
export function topLevelKeys(text) {
  const keys = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (depth === 1 && /^\s*:/.test(text.slice(j + 1))) keys.push(JSON.parse(text.slice(i, j + 1)));
      i = j;
    } else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }
  return keys;
}

export const TABLE_HEADING = '### Retry classes by operation';
const TABLE = 'the README retry table';

/** Parses the README table into operationId → {autoRetry, replay} or {callable:false, reason}. */
export function readmeTable(markdown) {
  const start = markdown.indexOf(`\n${TABLE_HEADING}\n`);
  if (start < 0) throw new Error(`${TABLE_HEADING} not found in packages/client/README.md`);
  const end = markdown.indexOf('\n#', start + TABLE_HEADING.length + 2);
  const section = markdown.slice(start, end < 0 ? markdown.length : end);
  const expected = new Map();
  for (const line of section.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const [ops, retry, replay] = line.split(' | ').map((cell) => cell.replace(/^\| /, ''));
    const value = (cell) => {
      const match = /^`([^`]+)`$/.exec(cell.trim());
      if (!match) throw new Error(`unparsed ${TABLE} cell: ${cell}`);
      return match[1] === 'null' ? null : match[1];
    };
    const klass = value(retry) === 'callable: false'
      ? { callable: false, reason: value(replay) }
      : { autoRetry: value(retry), replay: value(replay) };
    for (const match of ops.matchAll(/`(\w+)`/g)) {
      const key = match[1];
      if (expected.has(key)) throw new Error(`${TABLE} lists ${key} twice`);
      expected.set(key, klass);
    }
  }
  return expected;
}

export function check({ policyText, spec, readme }) {
  const errors = [];
  let policy;
  try { policy = JSON.parse(policyText); } catch (error) { return [`retry-policy.json is not JSON: ${error.message}`]; }
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return ['retry-policy.json must be an object keyed by operationId'];

  const keys = topLevelKeys(policyText);
  for (const key of new Set(keys.filter((key, i) => keys.indexOf(key) !== i))) errors.push(`${key}: listed more than once`);

  const methods = new Map();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) if (op?.operationId) methods.set(op.operationId, method);
  }
  for (const item of Object.values(spec.webhooks ?? {})) {
    for (const [method, op] of Object.entries(item)) if (op?.operationId) methods.set(op.operationId, method);
  }
  for (const id of methods.keys()) if (!(id in policy)) errors.push(`${id}: OpenAPI operation missing from retry-policy.json`);
  for (const id of Object.keys(policy)) if (!methods.has(id)) errors.push(`${id}: not an OpenAPI operationId`);
  if (methods.size !== EXPECTED_IDS) errors.push(`OpenAPI declares ${methods.size} operationIds; ${TABLE} covers ${EXPECTED_IDS}`);
  if (keys.length !== EXPECTED_IDS) errors.push(`retry-policy.json has ${keys.length} entries; expected exactly ${EXPECTED_IDS}`);

  const flat = new Map();
  for (const [id, entry] of Object.entries(policy)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { errors.push(`${id}: entry must be an object`); continue; }
    const fields = Object.keys(entry);
    if (entry.callable === false) {
      if (!same(fields, ['callable', 'reason'])) errors.push(`${id}: uncallable shape is exactly {callable:false, reason}`);
      if (!REASONS.includes(entry.reason)) errors.push(`${id}: reason ${JSON.stringify(entry.reason)} not in ${REASONS.join('|')}`);
      flat.set(id, { callable: false, reason: entry.reason });
    } else if (entry.callable === true) {
      if (!same(fields, ['callable', 'autoRetry', 'replay'])) errors.push(`${id}: callable shape is exactly {callable:true, autoRetry, replay}`);
      retryClass({ autoRetry: entry.autoRetry, replay: entry.replay }, id, errors);
      flat.set(id, { autoRetry: entry.autoRetry, replay: entry.replay });
    } else errors.push(`${id}: callable must be true or false`);
  }
  for (const [key, klass] of flat) {
    const id = key;
    if (klass && 'replay' in klass && klass.replay === null && methods.get(id) !== 'get') errors.push(`${key}: replay null is reserved for reads`);
    if (methods.get(id) === 'get' && klass?.replay !== null && klass?.callable !== false && id !== 'authLoginBinding') {
      errors.push(`${key}: reads replay null (only authLoginBinding, a cookie-replacing GET, is classified otherwise)`);
    }
  }
  if (readme) {
    const expected = readmeTable(readme);
    for (const [key, klass] of expected) {
      if (!flat.has(key)) errors.push(`${key}: classified by ${TABLE} but not by retry-policy.json`);
      else if (JSON.stringify(flat.get(key)) !== JSON.stringify(klass)) {
        errors.push(`${key}: retry-policy.json ${JSON.stringify(flat.get(key))} differs from ${TABLE} ${JSON.stringify(klass)}`);
      }
    }
    for (const key of flat.keys()) if (!expected.has(key)) errors.push(`${key}: not classified by ${TABLE}`);
  }
  return errors;
}

/**
 * The operations the generated routing table declares, shaped like the OpenAPI `paths`/`webhooks` that
 * `check` reads. The routing table is generated from the API contract, which is not in this repository.
 */
export function operationsFromRouting(text) {
  const start = text.indexOf('export const routing = ');
  const end = text.indexOf(' as const satisfies');
  if (start === -1 || end === -1) throw new Error('routing.ts does not carry a routing table');
  const table = JSON.parse(text.slice(start + 'export const routing = '.length, end));
  const doc = { paths: {}, webhooks: {} };
  for (const route of Object.values(table)) {
    const into = route.kind === 'webhook' ? doc.webhooks : doc.paths;
    (into[route.path] ??= {})[route.method.toLowerCase()] = { operationId: route.operationId };
  }
  return doc;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = check({
    policyText: readFileSync(here('../retry-policy.json'), 'utf8'),
    spec: operationsFromRouting(readFileSync(here('../src/generated/routing.ts'), 'utf8')),
    readme: readFileSync(here('../README.md'), 'utf8'),
  });
  if (errors.length) {
    process.stderr.write(`retry-policy.json check failed:\n${errors.map((e) => `  ${e}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(`retry-policy.json covers all ${EXPECTED_IDS} operationIds once, in the two shapes, matching the README retry table.\n`);
}
