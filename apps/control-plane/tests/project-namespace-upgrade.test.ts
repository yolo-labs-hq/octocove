import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { exportJWK, generateKeyPair } from 'jose';
import { AuthService, bindingName, random } from '../src/auth';
import { createApp, type Env } from '../src/index';
import { TokenBroker, type TokenProvider } from '../src/broker';
import { TaskLifecycle } from '../src/lifecycle';
import { repositoryIneligible } from '../src/repositories';
import { projectNamespace } from '../src/projects';
import { mockIssuer } from './fixtures/oidc';
import { bearer } from './helpers/fixtures';

// ADR 0017: a database populated through 0043 upgrades through 0044. Namespaces are backfilled
// `oc-<id>`, references and verification history survive, and every repository outside its project's namespace is
// refused at verify, claim, provisioning and broker whatever its verification state. Artifacts is a stubbed
// global fetch: no network.
const api = 'http://localhost:8787';
const app = createApp();
const key = () => `key-${random()}`;
const ACCOUNT = 'example-account';
const directory = new URL('../migrations/', import.meta.url);
const migrations = readdirSync(directory).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
function statements(sql: string) {
  let pending = ''; const result: string[] = [];
  for (const line of sql.split('\n')) {
    pending += line.replace(/--.*$/, '') + '\n';
    if (pending.trim() && line.trim().endsWith(';') && (!/^\s*CREATE TRIGGER/i.test(pending) || /END;\s*$/.test(pending))) { result.push(pending); pending = ''; }
  }
  return result;
}
async function apply(db: D1Database, names: string[], from = directory) {
  for (const name of names) for (const sql of statements(readFileSync(new URL(name, from), 'utf8'))) await db.prepare(sql).run();
}
const before0044 = migrations.filter((name) => name < '0044');
const from0044 = migrations.filter((name) => name >= '0044');
const after0044 = migrations.filter((name) => name >= '0045');
/** A variant of 0044, statement for statement, that does not enforce the namespace shape on every write. */
const original0044 = new URL('./fixtures/migrations-baseline/', import.meta.url);
const artifacts = vi.fn(async (url: string) => { throw new Error(`unexpected fetch ${url}`); });
const dbs: Miniflare[] = [];
async function database() {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}', compatibilityDate: '2026-07-02', d1Databases: ['DB'] });
  dbs.push(mf);
  return await mf.getD1Database('DB') as unknown as D1Database;
}

// One project per repository: [project id, repository id, provider, namespace, verification row state].
const at = '2026-10-01T00:00:00.000Z', verifiedAt = '2026-10-02T00:00:00.000Z';
const seed = [
  ['alpha', 'own-trusted', 'artifacts', 'oc-alpha', 'none'],
  ['bravo', 'own-verified', 'artifacts', 'oc-bravo', 'verified'],
  ['charlie', 'own-unverified', 'artifacts', 'oc-charlie', 'unverified'],
  ['0b0c4f7e-1d2a-4c3b-9e8f-112233445566', 'own-uuid', 'artifacts', 'oc-0b0c4f7e-1d2a-4c3b-9e8f-112233445566', 'none'],
  ['delta', 'foreign-trusted', 'artifacts', 'octocove-ns', 'none'],
  ['echo', 'foreign-verified', 'artifacts', 'octocove-ns', 'verified'],
  ['foxtrot', 'foreign-unverified', 'artifacts', 'octocove-ns', 'unverified'],
  ['golf', 'foreign-other-project', 'artifacts', 'oc-alpha', 'verified'],
  ['hotel', 'byo', 'github', 'octo-org', 'none'],
] as const;
const expected: Record<string, string | null> = {
  'own-trusted': null, 'own-verified': null, 'own-unverified': 'repository-unverified', 'own-uuid': null, byo: null,
  'foreign-trusted': 'repository-namespace-mismatch', 'foreign-verified': 'repository-namespace-mismatch',
  'foreign-unverified': 'repository-namespace-mismatch', 'foreign-other-project': 'repository-namespace-mismatch',
};
const foreign = seed.filter(([, id]) => id.startsWith('foreign-'));
const snapshot = async (db: D1Database) => Promise.all(['repositories', 'target_refs', 'repository_verifications', 'audit_log', 'tasks']
  .map(async (table) => (await db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()).results));

let env: Env, auth: AuthService, issuer: Awaited<ReturnType<typeof mockIssuer>>, preUpgrade: unknown[];
beforeAll(async () => {
  const db = await database();
  await apply(db, before0044);
  for (const [project, repository, provider, namespace, state] of seed) {
    await db.prepare("INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,?,?,'human',?)").bind(project, `slug-${repository}`, project, at).run();
    await db.prepare('INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,NULL)').bind(repository, project, provider, namespace, `id-${repository}`, repository, 'canonical', at).run();
    await db.prepare("INSERT INTO target_refs(repository_id,ref_name) VALUES(?,'refs/heads/main')").bind(repository).run();
    if (state !== 'none') await db.prepare('INSERT INTO repository_verifications VALUES(?,?,?,?)')
      .bind(repository, at, state === 'verified' ? verifiedAt : null, state === 'verified' ? 'legacy|operator' : null).run();
  }
  preUpgrade = await snapshot(db);
  await apply(db, from0044);
  issuer = await mockIssuer();
  const keys = await generateKeyPair('RS256', { extractable: true });
  env = { DB: db, OIDC_ISSUER: issuer.issuer, OIDC_CLIENT_ID: 'octocove-local',
    ...Object.fromEntries([['OIDC_CLIENT_SECRET', 'development-only'], ['ARTIFACTS_API_TOKEN', 'example-artifacts-token']]),
    ARTIFACTS_ACCOUNT_ID: ACCOUNT,
    OIDC_REDIRECT_URI: `${api}/auth/callback`, AUTH_DEV_LOCAL: 'true', AUTH_ALLOWED_ORIGINS: api, OCTOCOVE_ISSUER: 'https://api.octocove.invalid',
    DELEGATION_PRIVATE_JWK: JSON.stringify({ ...await exportJWK(keys.privateKey), kid: 'control-plane' }),
    DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'control-plane', alg: 'RS256', use: 'sig' }] }),
    AUTH_RECOVERY_KEY: random() } as Env;
  auth = new AuthService(env, issuer.fetcher);
  vi.stubGlobal('fetch', artifacts);
}, 60000);
afterEach(() => { artifacts.mockClear(); });
afterAll(async () => { vi.unstubAllGlobals(); for (const mf of dbs) await mf.dispose(); });

async function login() {
  const binding = random(), start = await auth.startLogin({ mode: 'browser' }, binding);
  const authorized = await issuer.fetcher(start.authorizationUrl!);
  return auth.completeLogin(new Request(authorized.headers.get('location')!, { headers: { cookie: `${bindingName}=${binding}` } }));
}

describe('0044 on a database populated through 0043', () => {
  it('backfills every project oc-<id> and keeps every reference and verification row as it was', async () => {
    const projects = await env.DB.prepare('SELECT id,artifacts_namespace FROM projects ORDER BY id').all<{ id: string; artifacts_namespace: string }>();
    expect(projects.results).toHaveLength(seed.length);
    for (const row of projects.results) expect(row.artifacts_namespace, row.id).toBe(projectNamespace(row.id));
    expect(await snapshot(env.DB)).toEqual(preUpgrade);
    // The backfilled namespace is as immutable as one assigned at creation.
    await expect(env.DB.prepare("UPDATE projects SET artifacts_namespace='oc-delta' WHERE id='echo'").run()).rejects.toThrow(/immutable|must be oc-<id>/);
  });

  it('reports each repository\'s eligibility from the one rule, and lists the mismatched ones as namespace-mismatch', async () => {
    for (const [, repository] of seed) expect(await repositoryIneligible(env.DB, repository), repository).toBe(expected[repository]);
    const session = await login();
    for (const [project, repository] of seed) {
      await env.DB.prepare('INSERT INTO auth_memberships(project_id,issuer,sub,verbs,allow_delegated_land) VALUES(?,?,?,?,0) ON CONFLICT DO NOTHING')
        .bind(project, issuer.issuer, 'human-1', JSON.stringify(['tasks:list', 'project:admin'])).run();
      const response = await app.request(`${api}/v1/projects/${encodeURIComponent(project)}/repositories`, { headers: bearer(session.sessionToken) }, env);
      expect(response.status, repository).toBe(200);
      const [item] = (await response.json() as { items: any[] }).items;
      const verification = expected[repository] === 'repository-namespace-mismatch' ? 'namespace-mismatch' : expected[repository] ? 'unverified' : 'verified';
      expect(item, repository).toMatchObject({ id: repository, verification });
      // The historical verification time is still reported, also for a mismatched repository.
      expect(item.verifiedAt, repository).toBe(seed.find(([, id]) => id === repository)![4] === 'verified' ? verifiedAt : null);
    }
  });

  it('refuses every mismatched repository at verify (before the trusted and already-verified answers), and writes nothing', async () => {
    const session = await login(), before = await snapshot(env.DB);
    for (const [project, repository] of foreign) {
      await env.DB.prepare('INSERT INTO auth_memberships(project_id,issuer,sub,verbs,allow_delegated_land) VALUES(?,?,?,?,0) ON CONFLICT DO NOTHING')
        .bind(project, issuer.issuer, 'human-1', JSON.stringify(['tasks:list', 'project:admin'])).run();
      const response = await app.request(`${api}/v1/projects/${encodeURIComponent(project)}/repositories/${repository}/verify`,
        { method: 'POST', headers: { ...bearer(session.sessionToken), 'Idempotency-Key': key() } }, env);
      expect(response.status, repository).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'repository-namespace-mismatch' });
    }
    expect(artifacts).not.toHaveBeenCalled();
    expect(await snapshot(env.DB)).toEqual(before);
  });

  it('refuses every mismatched repository at claim and at the broker; matching ones claim and mint', async () => {
    const principal = { type: 'human' as const, id: `${issuer.issuer}|human-1` };
    const provision = vi.fn(async () => { throw new Error('must not be called'); });
    const life = new TaskLifecycle(env.DB, { provision, reconcile: provision } as any);
    const minted: string[] = [];
    const provider: TokenProvider = { createToken: async (repo) => { minted.push(repo.id); return { id: random(), plaintext: 'fixture-token', scope: 'read',
      expires_at: new Date(Date.now() + 60_000).toISOString() }; }, revokeToken: async () => {} };
    const broker = new TokenBroker(env as any, provider);
    for (const [project, repository] of seed.filter(([, id]) => id !== 'byo')) {
      const task = random();
      await life.create(task, principal, key(), { projectId: project, repositoryId: repository, targetRef: 'refs/heads/main', key: task, title: 'T', description: 'D', acceptanceCriteria: ['A'] });
      await life.publish(task, principal, key());
      const claimId = random();
      const claim = life.claim(task, key(), { id: claimId, actor: { type: 'agent', id: 'bot' }, authorizedBy: principal.id,
        delegationId: `d-${claimId}`, intentVersion: 1, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } as any);
      // Each promise is awaited as soon as it exists: an un-awaited rejecting mint would surface as an unhandled rejection.
      if (expected[repository]) {
        await expect(claim, repository).rejects.toMatchObject({ code: expected[repository], status: 409 });
        await expect(broker.mintForObservation(repository, 'refs/heads/main'), repository).rejects.toMatchObject({ code: expected[repository], status: 409 });
      } else {
        expect(await claim, repository).toMatchObject({ status: 202 });
        expect((await broker.mintForObservation(repository, 'refs/heads/main')).token, repository).toBe('fixture-token');
      }
    }
    expect(minted.sort()).toEqual(['own-trusted', 'own-uuid', 'own-verified']);
  });

  it('blocks provisioning of a claim granted before the rule, for good: no provider call, no resume', async () => {
    const principal = { type: 'human' as const, id: `${issuer.issuer}|human-1` };
    const provision = vi.fn(async () => { throw new Error('must not be called'); });
    const life = new TaskLifecycle(env.DB, { provision, reconcile: provision } as any);
    // A claim on a repository that has to be in its project's namespace to be granted; then the repository is moved
    // out of it, as a repository outside it looked to a claim granted before per-project namespaces (the identity trigger is
    // lifted for this one fixture write only).
    const project = 'india', repository = 'moved-out', task = random(), claimId = random();
    await env.DB.prepare("INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,?,?,'human',?)").bind(project, project, project, at).run();
    await env.DB.prepare("INSERT INTO repositories VALUES(?,?,'artifacts',?,?,?,'canonical',?,NULL)").bind(repository, project, projectNamespace(project), `id-${repository}`, repository, at).run();
    await env.DB.prepare("INSERT INTO target_refs(repository_id,ref_name) VALUES(?,'refs/heads/main')").bind(repository).run();
    await life.create(task, principal, key(), { projectId: project, repositoryId: repository, targetRef: 'refs/heads/main', key: task, title: 'T', description: 'D', acceptanceCriteria: ['A'] });
    await life.publish(task, principal, key());
    expect(await life.claim(task, key(), { id: claimId, actor: { type: 'agent', id: 'bot' }, authorizedBy: principal.id,
      delegationId: `d-${claimId}`, intentVersion: 1, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } as any)).toMatchObject({ status: 202 });
    const trigger = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='repository_provider_identity_immutable'").first<{ sql: string }>();
    await env.DB.batch([env.DB.prepare('DROP TRIGGER repository_provider_identity_immutable'),
      env.DB.prepare("UPDATE repositories SET provider_namespace='octocove-ns' WHERE id=?").bind(repository), env.DB.prepare(trigger!.sql)]);
    await life.provision(claimId);
    expect((await life.claimStatus(claimId)).body).toMatchObject({ provisioningState: 'blocked', blockedReason: 'repository-namespace-mismatch' });
    await life.provision(claimId, undefined, undefined, true);
    expect((await life.claimStatus(claimId)).body).toMatchObject({ provisioningState: 'blocked', blockedReason: 'repository-namespace-mismatch' });
    expect(provision).not.toHaveBeenCalled();
  });

  it('fails loudly on a legacy project id that cannot name a namespace, rather than storing an unusable one', async () => {
    // Each id needs its own database through 0043 (0044 cannot be re-run on a database it half-applied).
    for (const id of ['has/slash', 'x'.repeat(61), 'ünïcode']) {
      const db = await database();
      await apply(db, before0044);
      await db.prepare("INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,'slug','P','human',?)").bind(id, at).run();
      await expect(apply(db, from0044), id).rejects.toThrow(/invalid artifacts namespace/);
    }
  }, 120000);
});

// Migrations are never re-run, so a database that applied the variant 0044 keeps it and only gains
// 0045 onwards. Such a database must still give every behaviour of the eligibility rule; it lacks exactly two
// triggers of the current 0044, and no others.
describe('a database populated through 0043, migrated through a variant 0044, then upgraded', () => {
  let db: D1Database, before: unknown[];
  beforeAll(async () => {
    db = await database();
    await apply(db, before0044);
    for (const [project, repository, provider, namespace, state] of seed) {
      await db.prepare("INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,?,?,'human',?)").bind(project, `slug-${repository}`, project, at).run();
      await db.prepare('INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,NULL)').bind(repository, project, provider, namespace, `id-${repository}`, repository, 'canonical', at).run();
      await db.prepare("INSERT INTO target_refs(repository_id,ref_name) VALUES(?,'refs/heads/main')").bind(repository).run();
      if (state !== 'none') await db.prepare('INSERT INTO repository_verifications VALUES(?,?,?,?)')
        .bind(repository, at, state === 'verified' ? verifiedAt : null, state === 'verified' ? 'legacy|operator' : null).run();
    }
    before = await snapshot(db);
    await apply(db, ['0044_project_artifacts_namespace.sql'], original0044);
    await apply(db, after0044);
  }, 60000);

  it('backfills oc-<id>, keeps every reference, and gives each repository the same eligibility as the current chain', async () => {
    const projects = await db.prepare('SELECT id,artifacts_namespace FROM projects ORDER BY id').all<{ id: string; artifacts_namespace: string }>();
    for (const row of projects.results) expect(row.artifacts_namespace, row.id).toBe(projectNamespace(row.id));
    expect(await snapshot(db)).toEqual(before);
    for (const [, repository] of seed) expect(await repositoryIneligible(db, repository), repository).toBe(expected[repository]);
    await expect(db.prepare("UPDATE projects SET artifacts_namespace='oc-delta' WHERE id='echo'").run()).rejects.toThrow(/immutable/);
    // 0045 onwards applied on top: the creation reservation and the widened audit vocabulary are there.
    const has = async (type: string, name: string) => !!await db.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').bind(type, name).first();
    expect(await has('table', 'repository_creations')).toBe(true);
    expect(await has('trigger', 'repositories_address_reserved')).toBe(true);
    expect((await db.prepare("SELECT sql FROM sqlite_master WHERE name='audit_log'").first<{ sql: string }>())!.sql).toContain('repository.creation_needs_operator');
  });

  it('lacks exactly the two guarantees the current 0044 adds: such a database must be recreated, not trusted', async () => {
    const triggers = async (of: D1Database) => new Map((await of.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='projects'")
      .all<{ name: string; sql: string }>()).results.map((t) => [t.name, t.sql]));
    const current = await database();
    await apply(current, migrations);
    const amended = await triggers(current), original = await triggers(db);
    expect([...amended.keys()].filter((name) => !original.has(name))).toEqual(['projects_no_replace']);
    expect([...amended.keys()].filter((name) => original.has(name) && original.get(name) !== amended.get(name)).sort())
      .toEqual(['projects_artifacts_namespace_shape', 'projects_artifacts_namespace_shape_insert']);
    // What that means: an explicit insert may still name another namespace, which the current chain refuses.
    await expect(current.prepare("INSERT INTO projects(id,slug,name,created_by,created_at,artifacts_namespace) VALUES('kilo','kilo','k','human',?,'oc-other')").bind(at).run())
      .rejects.toThrow(/must be oc-<id>/);
    await db.prepare("INSERT INTO projects(id,slug,name,created_by,created_at,artifacts_namespace) VALUES('kilo','kilo','k','human',?,'oc-other')").bind(at).run();
    expect(await db.prepare("SELECT artifacts_namespace FROM projects WHERE id='kilo'").first()).toEqual({ artifacts_namespace: 'oc-other' });
  }, 60000);
});
