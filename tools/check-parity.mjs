#!/usr/bin/env node
// CLI and client parity gate (CI: repo-hygiene).
//
// 1. One version line: packages/cli and packages/client carry the same version, the client's CLIENT_VERSION
//    matches, and the CLI pins exactly that client (`devDependencies["@yolo-labs/octocove-client"]` is
//    `workspace:<version>`; the CLI bundles the client's sources, so the pin is never a runtime install).
// 2. The parity manifest (packages/cli/parity.json) lists every CLI command and the client methods it uses.
//    Each command's handler is scanned for direct client calls (`api.j.<journey>(`, `api.root.<journey>(`,
//    `.command("<operationId>"`, `.call("<operationId>"`, a client function such as `meritPolicyStanding(`); its
//    entry's `client` must be exactly that set, so the manifest cannot drift from the code. Calls inside CLI helper
//    modules are listed by hand under `helpers`, and each must be called somewhere in packages/cli/src. Every name
//    must be a client journey, function or operation, or (`lanes:<method>`) a method of the client's lane engine
//    (`Lanes` in packages/client/src/lanes/engine.ts), which the lane directory binding calls.
// 3. A generic call (`.command(...)`, `.call(...)`) anywhere in packages/cli/src must name its operation with a
//    string literal and have an entry under `generic` with the reason it has no shaped journey (or why it is exempt);
//    an entry nothing calls fails too.
//
// `node tools/check-parity.mjs --write` adds missing entries (keeping existing ones) for review.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');
const errors = [];
const fail = (message) => errors.push(message);

// ---- 1. versions ----
const cli = JSON.parse(read('packages/cli/package.json'));
const client = JSON.parse(read('packages/client/package.json'));
if (cli.version !== client.version) fail(`CLI ${cli.version} and client ${client.version} must share one version`);
const pin = cli.devDependencies?.['@yolo-labs/octocove-client'];
if (pin !== `workspace:${client.version}`) fail(`the CLI must pin the client exactly: devDependencies["@yolo-labs/octocove-client"] = "workspace:${client.version}" (found ${JSON.stringify(pin)})`);
if (cli.dependencies?.['@yolo-labs/octocove-client']) fail('the CLI bundles the client sources: no runtime dependency on the client');
const clientVersion = /CLIENT_VERSION = '([^']+)'/.exec(read('packages/client/src/version.ts'))?.[1];
if (clientVersion !== client.version) fail(`packages/client/src/version.ts CLIENT_VERSION ${clientVersion} differs from package.json ${client.version}`);

// ---- 2. commands ----
const source = read('packages/cli/src/cli.ts');
const start = source.indexOf('const COMMANDS: Record<string, Handler> = {');
if (start < 0) fail('packages/cli/src/cli.ts: the COMMANDS table was not found');
const end = source.indexOf('\n};', start);
const table = source.slice(start, end);
const handlers = new Map();
const keys = [...table.matchAll(/^ {2}"([a-z][a-z -]*)": /gm)];
keys.forEach((m, i) => handlers.set(m[1], table.slice(m.index, i + 1 < keys.length ? keys[i + 1].index : table.length)));
const extra = /COMMAND_NAMES[^=]*=\s*Object\.freeze\(\[\s*\.\.\.Object\.keys\(COMMANDS\),([^\]]*)\]/.exec(source)?.[1] ?? '';
const names = [...handlers.keys(), ...[...extra.matchAll(/"([^"]+)"/g)].map((m) => m[1])];

// Client functions the CLI calls directly (the value re-exports of http.ts from the client).
const http = read('packages/cli/src/http.ts');
const clientFunctions = new Set([...http.matchAll(/^export \{([^}]*)\} from "\.\.\/\.\.\/client\/src\/node\.js";/gm)]
  .flatMap((m) => m[1].split(',').map((name) => name.trim())).filter((name) => /^[a-z]/.test(name)));

const usesOf = (text) => {
  const found = new Set();
  for (const m of text.matchAll(/\bapi\.(j|root)\.([A-Za-z]+(?:\.[A-Za-z]+)*)\s*\(/g)) if (m[2] !== 'command') found.add(`${m[1] === 'j' ? 'org' : 'root'}.${m[2]}`);
  // Shared handler factories: governance commands (one journey each) and the lane directory (lane-materialize.ts).
  for (const m of text.matchAll(/\bgovernance\(\s*"([A-Za-z]+)"/g)) found.add(`governance:${m[1]}`);
  for (const m of text.matchAll(/\bmaterializedLane\(\s*"([a-z-]+)"/g)) found.add(`lane-directory:${m[1]}`);
  for (const m of text.matchAll(/\.(command|call)\(\s*["']([A-Za-z]+)["']/g)) found.add(`${m[1]}:${m[2]}`);
  for (const m of text.matchAll(/(?<![.\w])([a-z][A-Za-z]+)\s*\(/g)) if (clientFunctions.has(m[1])) found.add(`fn:${m[1]}`);
  return found;
};

// What a manifest name may refer to: a journey path whose every segment the client's journey sources define, a
// client function, an operation id, a governance operation or a lane-directory action.
const journeySource = ['journeys.ts', 'auth.ts', 'events.ts', 'journey-core.ts'].map((f) => read(`packages/client/src/${f}`)).join('\n');
const operations = new Set([...read('packages/client/src/generated/routing.ts').matchAll(/^ {2}"(\w+)": \{/gm)].map((m) => m[1]));
// The lane engine's methods: the members of its `Lanes` interface.
const engine = read('packages/client/src/lanes/engine.ts');
const lanesInterface = engine.slice(engine.indexOf('export interface Lanes {'), engine.indexOf('\n}', engine.indexOf('export interface Lanes {')));
const laneMethods = new Set([...lanesInterface.matchAll(/^ {2}([a-zA-Z]+)\(/gm)].map((m) => m[1]));
const actions = new Set([...(/const MATERIALIZED_FLAGS[^{]*\{([\s\S]*?)\n\};?/.exec(source)?.[1] ?? '').matchAll(/^ {2}"?([a-z-]+)"?:/gm)].map((m) => m[1]));
const known = (name) => {
  const [kind, rest] = name.includes(':') ? name.split(/:(.*)/) : ['journey', name];
  if (kind === 'journey') return /^(org|root)\./.test(rest) && rest.split('.').slice(1).every((seg) => new RegExp(`\\b${seg}\\b`).test(journeySource));
  if (kind === 'fn') return clientFunctions.has(rest);
  if (kind === 'call' || kind === 'command' || kind === 'governance') return operations.has(rest);
  if (kind === 'lane-directory') return actions.has(rest);
  if (kind === 'lanes') return laneMethods.has(rest);
  return false;
};

// A hand-listed helper must be called somewhere in the CLI: `owner.method(` (any receiver, such as a local alias),
// or `owner[...](` with the method's name a string literal in the command's handler (a verb-selected journey).
const cliSource = readdirSync(join(root, 'packages/cli/src')).filter((f) => /\.(ts|mjs)$/.test(f)).map((f) => read(`packages/cli/src/${f}`)).join('\n');
const helperCalled = (helper, handler) => {
  if (helper.startsWith('fn:')) return new RegExp(`(?<![.\\w])${helper.slice(3)}\\s*\\(`).test(cliSource);
  // A lane engine method: called on the engine (`lanes.<method>(`, or on `lanesOf(...)` directly).
  if (helper.startsWith('lanes:')) return new RegExp(`(\\blanes|\\blanesOf\\([^)]*\\))\\.${helper.slice(6)}\\s*\\(`).test(cliSource);
  const segments = helper.split('.');
  const [owner, method] = segments.slice(-2);
  return new RegExp(`\\b${owner}\\.${method}\\s*\\(`).test(cliSource)
    || (new RegExp(`\\b${owner}\\[[^\\]]+\\]\\s*\\(`).test(cliSource) && handler.includes(`"${method}"`));
};

const manifestPath = 'packages/cli/parity.json';
let manifest;
try { manifest = JSON.parse(read(manifestPath)); } catch { manifest = { commands: {}, generic: {} }; }
manifest.commands ??= {};
manifest.generic ??= {};
const write = process.argv.includes('--write');

for (const name of names) {
  const used = [...usesOf(handlers.get(name) ?? '')].sort();
  const entry = manifest.commands[name] ?? (write ? (manifest.commands[name] = { client: used }) : undefined);
  if (!entry) { fail(`${manifestPath}: no entry for the CLI command "${name}"`); continue; }
  if (write) entry.client = used;
  // `client` is exactly what the handler calls; `helpers` lists the client methods reached through CLI helper modules.
  const listed = entry.client ?? [];
  for (const use of used) if (!listed.includes(use)) fail(`${manifestPath}: "${name}" calls ${use}, which its entry does not list`);
  for (const use of listed) if (!used.includes(use)) fail(`${manifestPath}: "${name}" lists ${use}, which its handler does not call`);
  for (const use of [...listed, ...(entry.helpers ?? [])]) if (!known(use)) fail(`${manifestPath}: "${name}" names ${use}, which is not a client method, operation or CLI action`);
  if (!listed.length && !(entry.helpers ?? []).length) fail(`${manifestPath}: "${name}" names no client method`);
  for (const helper of entry.helpers ?? []) if (!helperCalled(helper, handlers.get(name) ?? '')) fail(`${manifestPath}: "${name}" lists the helper ${helper}, which nothing in packages/cli/src calls`);
}
for (const name of Object.keys(manifest.commands)) if (!names.includes(name)) fail(`${manifestPath}: "${name}" is not a CLI command`);

// ---- 3. generic calls ----
const dir = 'packages/cli/src';
const genericSeen = new Set();
for (const file of readdirSync(join(root, dir)).filter((f) => /\.(ts|mjs)$/.test(f))) {
  const text = read(`${dir}/${file}`);
  for (const m of text.matchAll(/\.(command|call)\(\s*([^,)\s]+)/g)) {
    // `Function.prototype.call` (hasOwnProperty.call and the like) is not an API call.
    if (m[1] === 'call' && /(prototype|hasOwnProperty|\bFunction)$/.test(text.slice(Math.max(0, m.index - 40), m.index))) continue;
    const literal = /^["']([A-Za-z]+)["']$/.exec(m[2]);
    const line = text.slice(0, m.index).split('\n').length;
    if (!literal) {
      // The Api's own definitions and pass-throughs are not calls of an operation.
      if (file === 'http.ts') continue;
      fail(`${dir}/${file}:${line}: a generic .${m[1]}(...) must name its operation with a string literal`);
      continue;
    }
    const id = `${m[1]}:${literal[1]}`;
    genericSeen.add(id);
    if (!manifest.generic[id]) {
      if (write) manifest.generic[id] = 'TODO: why there is no shaped journey';
      else fail(`${dir}/${file}:${line}: ${id} has no "generic" entry in ${manifestPath} (a reason, or an exemption)`);
    }
  }
}

for (const id of Object.keys(manifest.generic)) if (!genericSeen.has(id)) fail(`${manifestPath}: the generic entry ${id} is not called anywhere`);
for (const id of Object.keys(manifest.generic)) if (!known(id)) fail(`${manifestPath}: ${id} is not an operation`);

if (write) {
  const sorted = { $comment: manifest.$comment, commands: Object.fromEntries(Object.entries(manifest.commands).sort(([a], [b]) => a.localeCompare(b))),
    generic: Object.fromEntries(Object.entries(manifest.generic).sort(([a], [b]) => a.localeCompare(b))) };
  writeFileSync(join(root, manifestPath), `${JSON.stringify(sorted, null, 2)}\n`);
}
if (errors.length) {
  for (const e of errors) process.stderr.write(`parity: ${e}\n`);
  process.exit(1);
}
process.stdout.write(`parity: CLI and client ${client.version}; ${names.length} commands and ${Object.keys(manifest.generic).length} generic calls in the manifest\n`);
