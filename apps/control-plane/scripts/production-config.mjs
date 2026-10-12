#!/usr/bin/env node
// Generates the production Wrangler config for octocove-control-plane from the
// committed local/test config (wrangler.jsonc), so the two cannot drift: DOs,
// DO migrations, queues, cron and compatibility settings are copied verbatim.
// Used by the production deploy (docs/OPERATIONS.md).
//
//   node scripts/production-config.mjs [--database-id <uuid>] [--out <path>]
//
// The D1 id comes from --database-id or OCTOCOVE_D1_DATABASE_ID; the output
// defaults to dist/wrangler.production.json. Wrangler resolves `main` and
// `migrations_dir` relative to the config file, so both are rebased onto the
// output directory and still name the same files.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const HOSTNAME = 'api.octocove.com';
// The OIDC callback and the CLI's browser leg are served on the web host with
// the URL preserved: these zone routes take precedence over the web Worker's
// app.octocove.com custom domain for their paths (docs/OPERATIONS.md). Each
// trailing `*` is a prefix match. The CLI consent POST goes to the confirm
// endpoint the callback advertises, resolved against the web host, where the
// host-only binding and session cookies live.
export const WEB_HOST_ROUTES = [
  { pattern: 'app.octocove.com/auth/callback*', zone_name: 'octocove.com' },
  { pattern: 'app.octocove.com/auth/cli/start*', zone_name: 'octocove.com' },
  { pattern: 'app.octocove.com/v1/auth/cli/confirm*', zone_name: 'octocove.com' },
];
const PLACEHOLDER = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Production `vars` are safe to commit; secrets go in with `wrangler secret put`.
// OIDC_REDIRECT_URI is the URL the browser hits on the callback, which the
// routes above deliver to this Worker; the API host's /auth/callback is not it.
export const PRODUCTION_VARS = {
  AUTH_ALLOWED_ORIGINS: 'https://app.octocove.com',
  OCTOCOVE_ISSUER: `https://${HOSTNAME}`,
  OIDC_REDIRECT_URI: 'https://app.octocove.com/auth/callback',
  // Projects one creator may create (src/projects.ts; docs/OPERATIONS.md#first-project).
  PROJECT_CREATE_MAX_PER_CREATOR: '20',
};

/** Removes // and block comments outside strings; JSONC has nothing else. */
export function stripComments(source) {
  let out = '', i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '"') {
      const start = i++;
      while (i < source.length && source[i] !== '"') i += source[i] === '\\' ? 2 : 1;
      out += source.slice(start, ++i);
    } else if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new Error('unterminated block comment in wrangler.jsonc');
      i = end + 2;
    } else {
      out += c; i++;
    }
  }
  return out;
}

export function productionConfig(source, { databaseId, configDir = '.', outDir = 'dist' }) {
  const id = (databaseId ?? '').trim();
  if (!id) throw new Error('OCTOCOVE_D1_DATABASE_ID is empty: resolve the production D1 id first');
  if (PLACEHOLDER.test(id)) throw new Error('OCTOCOVE_D1_DATABASE_ID is the placeholder id from wrangler.jsonc');
  if (!UUID.test(id)) throw new Error('OCTOCOVE_D1_DATABASE_ID is not a D1 database UUID');
  const local = JSON.parse(stripComments(source));
  const rebase = path => relative(resolve(outDir), resolve(configDir, path)).replaceAll('\\', '/');
  if (local.d1_databases?.length !== 1) throw new Error('expected exactly one D1 binding in wrangler.jsonc');
  // The `artifacts` binding is dropped: no code reads env.ARTIFACTS (all
  // Artifacts access is REST via ARTIFACTS_ACCOUNT_ID/ARTIFACTS_API_TOKEN), and
  // a production binding would require provisioning a namespace for nothing.
  const { artifacts: _unused, ...config } = local;
  return {
    ...config,
    main: rebase(config.main),
    routes: [{ pattern: HOSTNAME, custom_domain: true }, ...WEB_HOST_ROUTES.map(route => ({ ...route }))],
    workers_dev: false,
    d1_databases: [{ ...config.d1_databases[0], database_id: id,
      migrations_dir: rebase(config.d1_databases[0].migrations_dir ?? 'migrations') }],
    vars: { ...PRODUCTION_VARS },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { values } = parseArgs({ options: { 'database-id': { type: 'string' }, out: { type: 'string' } } });
  const out = resolve(values.out ?? resolve(packageDir, 'dist/wrangler.production.json'));
  try {
    const config = productionConfig(readFileSync(resolve(packageDir, 'wrangler.jsonc'), 'utf8'), {
      databaseId: values['database-id'] ?? process.env.OCTOCOVE_D1_DATABASE_ID, configDir: packageDir, outDir: dirname(out) });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`Wrote ${relative(process.cwd(), out)} (D1 ${config.d1_databases[0].database_id}, routes ${config.routes.map(r => r.pattern).join(', ')}).`);
  } catch (error) {
    console.error(`production-config: ${error.message}`);
    process.exit(1);
  }
}
