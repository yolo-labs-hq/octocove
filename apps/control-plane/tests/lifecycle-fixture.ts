import { timedFixture } from './fixture-timing';
import { expect, afterAll, beforeAll, beforeEach, describe, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthError, AuthService, hash, type Human } from "../src/auth";
import { exportJWK, generateKeyPair } from "jose";
import { deriveReceipt } from "../src/receipt";
import { integratorRequest, runSecret } from "../src/integrator-control";
import { seedMembership } from "./helpers/fixtures";
import { BrokerRemoteReader } from "../src/events";
import { TaskLifecycle, type Actor } from "../src/lifecycle";
import { TaskCoordinator, type LifecycleEnv } from "../src/task-coordinator";
import { TokenBroker } from "../src/broker";
import {
  ForkTaskRepoProvisioner,
  type TaskRepoProvisioner,
} from "../src/provisioner";
import { createServer, type Server } from "node:http";
import { adapter, syntheticSourceAccess } from "./lifecycle-adapter";
// Shared fixture for the lifecycle shards (lifecycle-*.test.ts). Each shard file
// imports this module, so it gets its own Miniflare/D1 and runs in its own worker,
// letting vitest overlap the fixed per-call D1 latency across files.
export let mf: Miniflare, db: D1Database, upgradeDb: D1Database, life: TaskLifecycle, auth: AuthService;
export const human: Actor = { type: "human", id: "human" },
  agent: Actor = { type: "agent", id: "agent" };
/** Authorizer of every fixture agent claim; a member of project "p". */
export const fixtureAuthorizer = { issuer: "https://idp.example", sub: "authorizer" };
export const base = "a".repeat(40),
  source = "b".repeat(40),
  candidateSha = "c".repeat(40),
  key = (x: string) => x.padEnd(20, "-");
export const intent = {
  title: "First intent",
  description: "Do the work",
  acceptanceCriteria: ["It works"],
};
export { adapter } from "./lifecycle-adapter";

// Opt in only for the SQL-heavy files. Keep callback-based commands in Node.
let workerLifecycle = false;
export function useWorkerLifecycle() { workerLifecycle = true; }
export async function create(id: string, dependsOn: string[] = [], targetRef = "refs/heads/main") {
  await life.create(id, human, key(`create-${id}`), {
    ...intent,
    projectId: "p",
    repositoryId: "canonical",
    targetRef,
    key: id,
    dependsOn,
  });
  await life.publish(id, human, key(`publish-${id}`));
}
export function claimInput(id: string) {
  return {
    id,
    actor: agent,
    authorizedBy: "human",
    delegationId: `d-${id}`,
    intentVersion: 1,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}
export async function submitted(id: string, expiresAt?: string, checkPolicy: object = { mode: "none" }, targetRef = "refs/heads/main") {
  await create(id, [], targetRef);
  const claim = `claim-${id}`;
  await life.claim(id, key(claim), { ...claimInput(claim), ...(expiresAt ? { expiresAt } : {}) });
  await life.provision(claim);
  const submission = await life.submit(id, agent, claim, key(`submit-${id}`), {
    sourceSha: source,
    baseSha: base,
    intentVersion: 1,
  });
  const job = await life.one(
    "SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute'",
    id,
  );
  const candidate = await life.candidate(id, key(`candidate-${id}`), {
    runId: job.run_id,
    candidateId: `candidate-${job.run_id}`,
    submissionId: submission.body.id,
    candidateSha,
    baseSha: base,
    candidateRef: `refs/candidates/candidate-${job.run_id}`,
    checkIdentity: "no-check",
    checkPolicy,
  });
  return { claim, submission, candidate };
}
export async function fenced(id: string, expiresAt?: string, targetRef = "refs/heads/main") {
  const records = await submitted(id, expiresAt, { mode: "none" }, targetRef);
  const approval = await life.approve(id, human, key(`approve-${id}`), {
    boundTo: { candidateSha, baseSha: base, intentVersion: 1 },
  });
  const landing = await life.land(id, human, key(`land-${id}`), {
    approvalId: approval.body.id,
  });
  return { ...records, approval, landing };
}
// Production custody is written by the integrator's compute run after a native-Git
// push and fetch-back (source-custody.test.ts). These record fixtures use synthetic
// SHAs with no Git objects and record candidates directly, so no compute run can
// supply it; they insert the row that run would have written. Candidate row
// creation alone never supplies this proof.
export async function retainSources(id: string) {
  for (const source of await life.rows('SELECT id,source_sha FROM submissions WHERE task_id=?', id))
    await db.prepare('INSERT INTO source_object_custody(submission_id,source_sha,repository_id,protected_ref,verified_at) VALUES(?,?,?,?,?)')
      .bind(source.id, source.source_sha, 'canonical', `refs/sources/${source.id}`, new Date().toISOString()).run();
}
export function coordinator(id: string, send = vi.fn(async (_payload: any) => {})) {
  const setAlarm = vi.fn(async (_at: number) => {});
  const instance = new TaskCoordinator(
    { storage: { get: async () => id, setAlarm } } as unknown as DurableObjectState,
    { DB: db, EVENTS: { send } } as unknown as LifecycleEnv,
  );
  // Keep the production alarm and real D1 transitions, with the fake repo adapter.
  (instance as any).lifecycle = () => life;
  return { instance, send, setAlarm };
}
beforeAll(() => timedFixture(expect.getState().testPath!.split('/control-plane/')[1], 'setup', async () => {
  const bundle = await build({
    entryPoints: [new URL("./lifecycle-worker.ts", import.meta.url).pathname],
    bundle: true,
    // Workerd resolves built-ins; esbuild cannot resolve them from node_modules.
    external: ["cloudflare:*"],
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
  });
  const pair = await generateKeyPair("RS256", { extractable: true }),
    privateJwk = await exportJWK(pair.privateKey),
    publicJwk = await exportJWK(pair.publicKey);
  const bindings = {
    DELEGATION_PRIVATE_JWK: JSON.stringify({ ...privateJwk, kid: "test" }),
    DELEGATION_PUBLIC_JWKS: JSON.stringify({
      keys: [{ ...publicJwk, kid: "test" }],
    }),
    OCTOCOVE_ISSUER: "https://octocove.example",
    AUTH_RECOVERY_KEY: btoa("x".repeat(32)),
  };
  mf = new Miniflare({
    bindings,
    queueProducers: { EVENTS: "events" },
    modules: true,
    script: bundle.outputFiles![0]!.text,
    compatibilityDate: "2026-07-02",
    d1Databases: { DB: "local", UPGRADE_DB: "upgrade" },
    durableObjects: {
      TASKS: "TestTaskCoordinator",
      PROD_TASKS: "TaskCoordinator",
      MANUAL_PROD_TASKS: "ManuallyProvisionedTaskCoordinator",
    },
  });
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  upgradeDb = (await mf.getD1Database("UPGRADE_DB")) as unknown as D1Database;
  // Fresh-schema tests follow production; the upgrade DB deliberately retains
  // the historical integrity/authority exclusions below.
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter(name => /^\d{4}_.*\.sql$/.test(name)).sort()) {
    // D1 exec does not parse multiline trigger bodies; use complete statements.
    const sql = readFileSync(
      new URL(`../migrations/${name}`, import.meta.url),
      "utf8",
    );
    const statements: string[] = [];
    let rest = sql.replace(/--[^\n]*/g, "").trim();
    while (rest) {
      const next = rest.match(
        rest.startsWith("CREATE TRIGGER")
          ? /^CREATE TRIGGER[\s\S]*?END;/
          : /^(?:'[^']*'|[^;])+;/,
      )![0];
      statements.push(next);
      rest = rest.slice(next.length).trim();
    }
    // One D1 request per migration avoids hundreds of per-statement round trips
    // in every importing file, including receipt-export under shard contention.
    await db.batch(statements.map(statement => db.prepare(statement)));
    // Any migration that rebuilds audit_log (0042, 0045, 0047, ...) drops and recreates the audit triggers on the
    // authority tables (0019 on) that this DB never has, so it cannot apply here either. Detected by content, so a
    // new audit_log rebuild is skipped here without being added to the list.
    if (name !== "0009_record_integrity.sql" && name !== "0019_machine_approval_authority.sql" && name !== "0020_machine_trust.sql" && name !== "0027_webhook_operations.sql" && name !== "0028_machine_event_permissions.sql" && name !== "0034_trust_activation.sql" && name !== "0035_machine_auth_hardening.sql" && name !== "0042_repository_verified_audit.sql" && name !== "0045_repository_creation.sql" && !/DROP TABLE audit_log;/.test(sql))
      await upgradeDb.batch(statements.map(statement => upgradeDb.prepare(statement)));
  }
  await db.batch([
    db
      .prepare("INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,?,?,?,?)")
      .bind("p", "p", "Project", "human", new Date().toISOString()),
    db
      .prepare("INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,NULL)")
      .bind(
        "canonical",
        "p",
        "artifacts",
        // The project's own Artifacts namespace (0044, `oc-<id>`): claims refuse a canonical outside it.
        "oc-p",
        "provider-canonical",
        "canonical",
        "canonical",
        new Date().toISOString(),
      ),
    db
      .prepare("INSERT INTO target_refs VALUES(?,?,?,?,?)")
      .bind(
        "canonical",
        "refs/heads/main",
        base,
        new Date().toISOString(),
        "seed",
      ),
  ]);
  // Production bootstrap records an agent claim's authorization before the claim,
  // and admission resolves the authorizer's project membership through it. Fixture
  // claims skip bootstrap, so record the same shape for any agent claim without one.
  const at = Math.floor(Date.now() / 1000);
  await db.batch([
    db.prepare("INSERT INTO auth_users(issuer,sub) VALUES(?,?)").bind(fixtureAuthorizer.issuer, fixtureAuthorizer.sub),
    db.prepare("INSERT INTO auth_families(id,issuer,sub,authenticated_at,absolute_expiry) VALUES(?,?,?,?,?)")
      .bind("fixture-family", fixtureAuthorizer.issuer, fixtureAuthorizer.sub, at, at + 86_400),
    seedMembership(db, { project: "p", issuer: fixtureAuthorizer.issuer, sub: fixtureAuthorizer.sub, verbs: ["submissions:create"] }),
    db.prepare(`CREATE TRIGGER fixture_claim_authorization AFTER INSERT ON claims
      WHEN NEW.actor_type='agent' AND NEW.delegation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM auth_authorizations WHERE id=NEW.delegation_id)
      BEGIN INSERT INTO auth_authorizations(id,family_id,project_id,task_id,agent_id,claim_attempt_id,verbs,ceiling,bootstrap_hash,bootstrap_expiry,consumed)
        SELECT NEW.delegation_id,'fixture-family',t.project_id,t.id,NEW.actor_id,NEW.id,'["submissions:create"]',unixepoch()+86400,'fixture-'||NEW.id,0,1
        FROM tasks t WHERE t.id=NEW.task_id; END`),
  ]);
  const localLife = new TaskLifecycle(db, adapter, syntheticSourceAccess);
  life = workerLifecycle ? new Proxy(localLife, {
    get(target, method, receiver) {
      const value = Reflect.get(target, method, receiver);
      if (typeof value !== "function") return value;
      // dispatch and its Queue helper accept callbacks; those cannot travel over JSON.
      if (method === "dispatch" || method === "sendRun") return value.bind(receiver);
      return async (...args: unknown[]) => {
        const response = await mf.dispatchFetch("https://fixture.test/fixture-lifecycle", {
          method: "POST",
          body: JSON.stringify({ method, args }),
        });
        const result: any = await response.json();
        if (!response.ok) {
          if (result.name === "AuthError") throw new AuthError(result.code, result.status, result.details);
          throw new Error(result.message);
        }
        return result.value;
      };
    },
  }) : localLife;
  auth = new AuthService({ DB: db, ...bindings });
}), 30_000);
beforeEach(async () => {
  await db
    .prepare("UPDATE target_refs SET known_head_sha=? WHERE repository_id=?")
    .bind(base, "canonical")
    .run();
});
// Tests share D1 for speed. Resolve earlier fixtures before admitting another
// writer on this target; real production keeps the unique target fence held.
beforeEach(async () => {
  for (const fence of await life.rows("SELECT * FROM landing_fences WHERE status='held'"))
    await life.reconcile(fence.task_id, key(`fixture-release-${fence.id}`), {
      fenceId: fence.id, runId: fence.integrator_run_id, outcome: 'error',
      canonicalSha: fence.base_sha, ancestryVerified: false, writerTerminated: true, eventIds: [],
      errorDetail: 'fixture teardown',
    });
});
afterAll(() => timedFixture(expect.getState().testPath!.split('/control-plane/')[1], 'teardown', async () => {
  await mf?.dispose();
}));
