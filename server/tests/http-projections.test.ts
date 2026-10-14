import { applyNextReleaseSchema } from './helpers/next-release-schema';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import { exportJWK, generateKeyPair } from "jose";
import { AuthService, hash, type AuthEnv } from "../src/auth";
import { TaskLifecycle, type Actor } from "../src/lifecycle";
import { creationId } from "../src/task-coordinator";
import type { TaskRepoProvisioner } from "../src/provisioner";
import { syntheticSourceAccess } from './lifecycle-adapter';
import { authHeaders, bearer, seedMembership, syntheticToken } from './helpers/fixtures';
const spec = parse(readFileSync(new URL("../../spec/openapi.yaml", import.meta.url), "utf8"));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: "octocove", components: spec.components });
const validators = new Map();
async function conform(response: Response, path: string, method = "get", status = 200) {
    expect(response.status, await response.clone().text()).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Request-Id")).toBeTruthy();
    const documented = spec.paths[path][method].responses[String(response.status)];
    expect(documented, `${method} ${path} status ${response.status}`).toBeDefined();
    const resolved = documented.$ref ? spec.components.responses[documented.$ref.split("/").at(-1)] : documented;
    const contentType = response.headers.get("Content-Type")!.split(";")[0];
    const schema = resolved.content[contentType].schema;
    const key = `${method}:${path}:${response.status}`;
    if (!validators.has(key))
        validators.set(key, ajv.compile({ ...schema, components: spec.components }));
    const validate = validators.get(key), body = await response.json() as any;
    expect(validate(body), JSON.stringify(validate.errors, null, 2)).toBe(true);
    return body;
}
let mf: Miniflare, db: D1Database, env: AuthEnv, auth: AuthService, life: TaskLifecycle;
const actor: Actor = { type: "human", id: "https://identity.example|alice" };
const session = syntheticToken("ocs", "projection-alice"), otherSession = syntheticToken("ocs", "projection-bob");
const base = "a".repeat(40), source = "b".repeat(40), sha = "c".repeat(40);
const key = (text: string) => text.padEnd(20, "-");
const intent = { title: "Ship the task", description: "A complete task contract", acceptanceCriteria: ["All checks pass"] };
const adapter: TaskRepoProvisioner = {
    async provision(c) { return { taskRepo: { id: c.id, name: `oc-${c.id}`, namespace: c.namespace }, remote: `https://artifacts.example/git/${c.id}.git`, targetRef: c.targetRef }; },
    async subscribe(r) { return `subscription-${r.id}`; },
    async release() { },
};
function call(path: string, token = session, method = "GET", body?: unknown, operationKey = key(path)) {
    return mf.dispatchFetch(`https://control.example${path}`, {
        method, headers: { ...authHeaders(token, { idempotencyKey: operationKey }), "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }) as unknown as Promise<Response>;
}
async function create(name: string, projectId = "project", dependsOn: string[] = []) {
    const id = await creationId(projectId, name);
    await life.create(id, actor, key(`create-${name}`), { ...intent, projectId, repositoryId: `canonical-${projectId}`, targetRef: "refs/heads/main", key: name, dependsOn });
    await life.publish(id, actor, key(`publish-${name}`));
    return id;
}
async function claim(id: string, operationKey: string, ready = true) {
    const claimId = `claim-${await hash(`${id}:${actor.id}:${operationKey}`)}`;
    await life.claim(id, operationKey, { id: claimId, actor, authorized: true, intentVersion: 1, expiresAt: new Date(Date.now() + 3600000).toISOString() });
    if (ready)
        await life.provision(claimId);
    return claimId;
}
async function submit(id: string, claimId: string, name: string) {
    return (await life.submit(id, actor, claimId, key(name), { sourceSha: source, baseSha: base, intentVersion: 1 })).body.id as string;
}
async function compute(id: string, submissionId: string, outcome = "computed", checkPolicy: object = { mode: "none" }) {
    const job = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute' AND json_extract(payload,'$.submissionId')=? ORDER BY rowid DESC LIMIT 1", id, submissionId);
    return (await life.candidate(id, key(`compute-${submissionId}`), {
        runId: job.run_id, submissionId, baseSha: base, checkIdentity: "checks-v1", checkPolicy,
        ...(outcome === "computed" ? { candidateSha: sha, candidateRef: `refs/candidates/${submissionId}` } : { outcome: "conflict", conflictFiles: ["src/file.ts"] }),
    })).body.id as string;
}
beforeAll(async () => {
    const bundle = await build({ entryPoints: [new URL("./http-projections-worker.ts", import.meta.url).pathname], bundle: true, external: ["cloudflare:sockets"], write: false, format: "esm", platform: "neutral", target: "es2022" });
    const pair = await generateKeyPair("RS256", { extractable: true });
    const bindings = {
        AUTH_RECOVERY_KEY: btoa("x".repeat(32)), WEBHOOK_SECRET_KEY: btoa("v".repeat(32)), OCTOCOVE_ISSUER: "https://control.example",
        DELEGATION_PRIVATE_JWK: JSON.stringify({ ...await exportJWK(pair.privateKey), kid: "test" }),
        DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...await exportJWK(pair.publicKey), kid: "test" }] }),
    };
    mf = new Miniflare({ modules: true, script: bundle.outputFiles![0]!.text, bindings, compatibilityDate: "2026-07-02", d1Databases: { DB: "projections" }, durableObjects: { TASKS: "ProjectionTaskCoordinator" }, queueProducers: { EVENTS: "events" } });
    db = await mf.getD1Database("DB") as unknown as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(n => n.endsWith(".sql")).sort()) {
        let rest = readFileSync(new URL(name, directory), "utf8").replace(/--[^\n]*/g, "").trim();
        const statements = [];
        while (rest) {
            const next = rest.match(rest.startsWith("CREATE TRIGGER") ? /^CREATE TRIGGER[\s\S]*?END;/ : /^(?:'[^']*'|[^;])+;/)![0];
            statements.push(db.prepare(next));
            rest = rest.slice(next.length).trim();
        }
        await db.batch(statements);
    }
    await applyNextReleaseSchema(db);
    const now = new Date().toISOString(), expiry = Math.floor(Date.now() / 1000) + 86400;
    for (const project of ["project", "other-project", "listing", "submissions", "task-fields"]) {
        await db.batch([
            db.prepare("INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,?,?,?,?)").bind(project, project, project, actor.id, now),
            db.prepare("INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,NULL)").bind(`canonical-${project}`, project, "artifacts", `oc-${project}`, `provider-${project}`, `canonical-${project}`, "canonical", now),
            db.prepare("INSERT INTO target_refs VALUES(?,?,?,?,?)").bind(`canonical-${project}`, "refs/heads/main", base, now, "seed"),
        ]);
    }
    const verbs = ["tasks:edit", "tasks:create", "tasks:publish", "tasks:claim", "tasks:list", "tasks:read", "claims:read", "receipts:read", "submissions:create", "candidates:read", "candidates:approve", "webhooks:create", "webhooks:replay", "webhooks:disable"];
    for (const [sub, token] of [["alice", session], ["bob", otherSession]]) {
        await db.batch([
            db.prepare("INSERT INTO auth_users VALUES(?,?,NULL,NULL)").bind("https://identity.example", sub),
            db.prepare("INSERT INTO auth_families VALUES(?,?,?,?,?,0)").bind(`family-${sub}`, "https://identity.example", sub, expiry - 86400, expiry),
            db.prepare("INSERT INTO auth_sessions VALUES(?,?,?,?,0)").bind(await hash(token), `family-${sub}`, await hash("csrf"), expiry),
            ...["project", "other-project", "listing", "submissions", "task-fields"].map(project => seedMembership(db, { project, issuer: "https://identity.example", sub, verbs })),
        ]);
    }
    env = { DB: db, ...bindings };
    auth = new AuthService(env);
    life = new TaskLifecycle(db, adapter, syntheticSourceAccess);
}, 30000);
afterAll(async () => { await mf?.dispose(); });
describe("authenticated HTTP projections conform to OpenAPI on local D1", () => {
    it('current Worker lists repository creations without next-schema seed or unknown columns', async () => {
        const at = new Date().toISOString();
        await db.prepare(`INSERT INTO repository_creations(id,project_id,provider_namespace,name,mode,state,principal,requester_family_id,operation_key,request_digest,target_ref,next_check_at,created_at,updated_at,seed)
      VALUES(?,'project','oc-project','future-canonical','create','needs-operator',?,'family-alice',?,?,'refs/heads/main',?,?,?,1)`)
            .bind('future-creation', actor.id, key('future-creation'), 'request-digest', at, at, at).run();
        const response = await call('/v1/projects/project/repositories');
        expect(response.status).toBe(200);
        const body = await response.json() as any;
        expect(body.creations).toContainEqual({ id: 'future-creation', name: 'future-canonical', mode: 'create', state: 'needs-operator', createdAt: at, updatedAt: at });
        const validate = ajv.compile({ $ref: '#/components/schemas/RepositoryList', components: spec.components });
        expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
        expect(body.creations[0]).not.toHaveProperty('seed');
        expect(body.creations[0]).not.toHaveProperty('futureMetadata');
    });
    it("sums gateway and coordinator authentication on a task route", async () => {
        const taskId = 'timing-secret-task-id';
        const response = await mf.dispatchFetch(`https://control.example/v1/tasks/${taskId}`, {
            headers: { ...authHeaders(session), 'X-Test-Auth-Timing': '1' },
        }) as unknown as Response;
        expect(response.status).toBe(404);
        const coordinatorAuth = Number(response.headers.get('X-Test-Coordinator-Auth-Ms'));
        const header = response.headers.get('Server-Timing') ?? '';
        const totalAuth = Number(/auth;dur=([\d.]+)/.exec(header)?.[1]);
        expect(coordinatorAuth).toBeGreaterThanOrEqual(100);
        expect(totalAuth).toBeGreaterThan(coordinatorAuth);
        expect(header).not.toContain(taskId);
        expect(response.headers.get('X-Octocove-Internal-Timing')).toBeNull();
    });
    it("conforms missing-resource, authentication and persisted claim-refusal problems", async () => {
        for (const [path, contract] of [["/tasks/missing", "/tasks/{id}"], ["/claims/missing", "/claims/{id}"], ["/submissions/missing/candidate", "/submissions/{id}/candidate"], ["/receipts/missing", "/receipts/{id}"]]) {
            const response = await call(path);
            if (path === "/tasks/missing") {
                const timing = response.headers.get("Server-Timing") ?? "";
                expect(timing).toContain('d1_count;desc="2"');
                expect(timing).not.toMatch(/missing|internal|email|token/i);
                expect(response.headers.get("X-Octocove-Internal-Timing")).toBeNull();
            }
            await conform(response, contract, "get", 404);
            await conform(await mf.dispatchFetch(`https://control.example${path}`) as unknown as Response, contract, "get", 401);
        }
        for (const action of ["approve", "land", "withdraw", "reject"])
            expect(await conform(await call(`/v1/candidates/missing/${action}`, session, "POST", {}, key(`missing-${action}`)), `/candidates/{id}/${action}`, "post", 404)).toMatchObject({ code: "not-found" });
        const id = await create("refused-claim");
        await claim(id, key("existing-claim"));
        const refused = await conform(await call(`/tasks/${id}/claim`, session, "POST", { intentVersion: 1 }, key("refused-claim")), "/tasks/{id}/claim", "post", 409);
        expect(refused).toMatchObject({ code: "already-claimed", details: { claimAttemptId: expect.any(String), claimResult: "refused-already-claimed" } });
    });
    it("projects tasks with canonical head, dependencies and live attempts", async () => {
        const upstream = await create("upstream");
        const id = await create("dependent", "project", [upstream]);
        const task = await conform(await call(`/v1/tasks/${id}`), "/tasks/{id}");
        expect(task).toMatchObject({ key: "dependent", canonicalHeadSha: base, dependencies: [{ upstreamTaskId: upstream, status: "ready", acceptedResult: null }], liveAttempt: { claimId: null, submissionId: null, candidateId: null, approvalId: null, fenceId: null } });
        const liveId = await create("live");
        const claimId = await claim(liveId, key("live-claim"));
        const submissionId = await submit(liveId, claimId, "live-submit");
        const candidateId = await compute(liveId, submissionId);
        const approval = await life.approve(liveId, actor, key("live-approve"), { boundTo: { candidateSha: sha, baseSha: base, intentVersion: 1 } });
        expect((await conform(await call(`/tasks/${liveId}`), "/tasks/{id}")).liveAttempt).toEqual({ claimId, submissionId, candidateId, approvalId: approval.body.id, fenceId: null });
    });
    it.each([undefined, "Reviewed the candidate"])("projects human approval creation and replay against the Approval schema (note: %s)", async (note) => {
        const id = await create(`approval-projection-${note === undefined ? "no-note" : "note"}`);
        const claimId = await claim(id, key(`claim-${id}`));
        const submissionId = await submit(id, claimId, `submit-${id}`);
        const candidateId = await compute(id, submissionId);
        const input = { boundTo: { candidateSha: sha, baseSha: base, intentVersion: 1 }, ...(note === undefined ? {} : { note }) };
        const approve = (prefix: string) => call(`${prefix}/candidates/${candidateId}/approve`, session, "POST", input, key(`approve-${id}`));
        const fresh = await conform(await approve("/v1"), "/candidates/{id}/approve", "post", 201);
        const row = await life.one("SELECT * FROM approvals WHERE id=?", fresh.id);
        expect(row).toMatchObject({ task_id: id, candidate_id: candidateId, note: note ?? null });
        expect(fresh).toEqual({
            id: row.id, taskId: row.task_id, candidateId: row.candidate_id,
            approvedBy: row.approved_by, approvedAt: row.approved_at, note: row.note,
            boundTo: { candidateSha: row.bound_candidate_sha, baseSha: row.bound_base_sha, intentVersion: row.bound_intent_version },
            status: row.status,
        });
        expect(await conform(await approve(""), "/candidates/{id}/approve", "post", 201)).toEqual(fresh);
        await life.withdrawApproval(id, actor, key(`withdraw-${id}`), {
            approvalId: row.id, expectedStatus: "approved", expectedIntentVersion: 1,
        });
        expect((await life.one("SELECT status FROM approvals WHERE id=?", row.id)).status).toBe("invalidated");
        expect(await conform(await approve("/v1"), "/candidates/{id}/approve", "post", 201)).toEqual(fresh);
        expect(await life.rows("SELECT id FROM approvals WHERE task_id=?", id)).toEqual([{ id: row.id }]);
    });
    it("normalizes pending, blocked, ready and ended claims and keeps POST retries stable", async () => {
        const freshId = await create("fresh-human-claim");
        const fresh = await conform(await call(`/tasks/${freshId}/claim`, session, "POST", { intentVersion: 1 }, key("fresh-human-claim")), "/tasks/{id}/claim", "post", 202);
        expect(fresh.claim).toMatchObject({ taskId: freshId, status: "active", provisioningState: "pending", workspace: null });
        await new TaskLifecycle(db).provision(fresh.claim.id);
        expect(await conform(await call(`/claims/${fresh.claim.id}`), "/claims/{id}")).toMatchObject({ provisioningState: "blocked", blockedReason: "provisioner-unconfigured" });
        const id = await create("pending-claim"), operationKey = key("claim-pending");
        const pendingId = await claim(id, operationKey, false);
        const pending = await conform(await call(`/claims/${pendingId}`), "/claims/{id}", "get", 202);
        expect(pending).toMatchObject({ id: pendingId, provisioningState: "pending", workspace: null, blockedReason: null });
        const post = await conform(await call(`/tasks/${id}/claim`, session, "POST", { intentVersion: 1 }, operationKey), "/tasks/{id}/claim", "post", 202);
        expect(post.claim).toMatchObject({ id: pendingId, provisioningState: "pending", workspace: null, blockedReason: null });
        await conform(await call(`/v1/claims/${pendingId}`), "/claims/{id}", "get", 202);
        await life.provision(pendingId);
        const ready = await conform(await call(`/claims/${pendingId}`), "/claims/{id}");
        expect(ready.workspace.credentialSource).toMatchObject({ brokerUrl: "https://control.example/v1/broker/token", identitySource: "octocove-session", helper: "octocove-helper-connect", scope: "write" });
        expect(JSON.stringify(ready)).not.toContain("git-credential-artifacts");
        expect(ready.workspace.credentialSource).not.toHaveProperty("useHttpPath");
        expect(await conform(await call(`/tasks/${id}/claim`, session, "POST", { intentVersion: 1 }, operationKey), "/tasks/{id}/claim", "post", 202)).toEqual(post);
        const readyId = await create("ready-claim"), readyKey = key("claim-ready");
        const readyClaim = await claim(readyId, readyKey);
        const granted = await conform(await call(`/v1/tasks/${readyId}/claim`, session, "POST", { intentVersion: 1 }, readyKey), "/tasks/{id}/claim", "post", 201);
        expect(granted.claim).toMatchObject({ id: readyClaim, provisioningState: "ready", workspace: { kind: "task-repo" } });
        expect(granted.claim.workspace.credentialSource.helper).toBe("octocove-helper-connect");
        const legacy = structuredClone(granted);
        legacy.claim.workspace.credentialSource.helper = "git-credential-artifacts";
        legacy.claim.workspace.credentialSource.useHttpPath = true;
        await db.prepare("UPDATE claim_http_results SET body=? WHERE claim_id=?").bind(JSON.stringify(legacy), readyClaim).run();
        expect(await conform(await call(`/tasks/${readyId}/claim`, session, "POST", { intentVersion: 1 }, readyKey), "/tasks/{id}/claim", "post", 201)).toEqual(granted);
        await db.prepare("UPDATE claim_http_results SET body=? WHERE claim_id=?").bind(JSON.stringify({ claimAttemptId: readyClaim, provisioningState: "ready" }), readyClaim).run();
        expect((await conform(await call(`/tasks/${readyId}/claim`, session, "POST", { intentVersion: 1 }, readyKey), "/tasks/{id}/claim", "post", 201)).claim).toEqual(granted.claim);
        await life.endClaim(readyId, actor, key("ready-release"), readyClaim);
        await life.cleanup(readyClaim);
        expect(await conform(await call(`/claims/${readyClaim}`), "/claims/{id}")).toMatchObject({ status: "released", provisioningState: "blocked", workspace: null, blockedReason: "workspace-released" });
    });
    it("validates bootstrap claim credentials on POST and excludes them from polling", async () => {
        const id = await create("bootstrap");
        const human = await auth.human(new Request("https://control.example", { headers: bearer(session) }));
        const authorization = await auth.preauthorize(human, "project", id, "agent-a", ["tasks:list", "tasks:read", "claims:read", "candidates:read"], 3600);
        const response = await conform(await call(`/tasks/${id}/claim`, authorization.bootstrapToken, "POST", { intentVersion: 1 }, key("bootstrap-claim")), "/tasks/{id}/claim", "post", 202);
        expect(response.claim.workspace).toBeNull();
        expect(response.delegation.accessToken).toBeTruthy();
        await conform(await call(`/claims/${response.claim.id}`, response.delegation.accessToken), "/claims/{id}", "get", 202);
        await life.provision(response.claim.id);
        const ready = await conform(await call(`/claims/${response.claim.id}`, response.delegation.accessToken), "/claims/{id}");
        expect(ready.workspace.credentialSource.identitySource).toBe("octocove-delegation");
        const page = await conform(await call("/tasks?projectId=project", response.delegation.accessToken), "/tasks");
        expect(page.items.map((t: any) => t.id)).toEqual([id]);
        expect(page.nextCursor).toBeNull();
        await conform(await call("/tasks?projectId=other-project", response.delegation.accessToken), "/tasks", "get", 403);
        await db.prepare("DELETE FROM auth_memberships WHERE project_id=? AND sub=?").bind("project", "alice").run();
        await conform(await call("/tasks?projectId=project", response.delegation.accessToken), "/tasks", "get", 401);
        await seedMembership(db, { project: "project", issuer: "https://identity.example", sub: "alice", verbs: ["tasks:claim", "tasks:list", "tasks:read", "claims:read", "candidates:read", "receipts:read", "submissions:create"] }).run();
    });
    it("projects candidate pending/superseded/complete/conflict and latest check evidence", async () => {
        const id = await create("candidate"), claimId = await claim(id, key("candidate-claim"));
        const first = await submit(id, claimId, "candidate-first");
        expect(await conform(await call(`/submissions/${first}/candidate`), "/submissions/{id}/candidate", "get", 202)).toMatchObject({ state: "pending", submissionId: first, jobId: expect.any(String) });
        const second = await submit(id, claimId, "candidate-second");
        expect(await conform(await call(`/submissions/${first}/candidate`), "/submissions/{id}/candidate")).toEqual({ state: "superseded", submissionId: first, replacementSubmissionId: second, workAttribution: { kind: actor.type, id: actor.id } });
        const candidateId = await compute(id, second);
        const complete = await conform(await call(`/v1/submissions/${second}/candidate`), "/submissions/{id}/candidate");
        expect(complete).toMatchObject({ state: "complete", candidate: { id: candidateId, latestCheck: null, reviewBoundTo: { candidateSha: sha, baseSha: base, intentVersion: 1 } } });
        const timestamp = new Date().toISOString();
        for (const result of ["failed", "passed"] as const)
            await life.check(id, key(`check-${result}`), { candidateId, runId: crypto.randomUUID(), checkIdentity: "checks-v1", result, evidence: { version: 1, commands: [{ argv: ["true"], exitCode: 0 }] }, startedAt: timestamp, finishedAt: timestamp });
        expect((await conform(await call(`/submissions/${second}/candidate`), "/submissions/{id}/candidate")).candidate.latestCheck.result).toBe("passed");
        const third = await submit(id, claimId, "candidate-third");
        await compute(id, third, "conflict");
        expect((await conform(await call(`/submissions/${third}/candidate`), "/submissions/{id}/candidate")).candidate).toMatchObject({ outcome: "conflict", status: "failed", candidateSha: null, conflictFiles: ["src/file.ts"], reviewBoundTo: null });
        expect((await conform(await call(`/submissions/${second}/candidate`), "/submissions/{id}/candidate")).candidate.status).toBe("superseded");
    });
    it("lists only project members' tasks with keyset pages and filter/principal-bound cursors", async () => {
        const ids = await Promise.all([create("list-a", "listing"), create("list-b", "listing"), create("list-c", "listing")]);
        const first = await conform(await call("/v1/tasks?projectId=listing&limit=1"), "/tasks");
        expect(first.items.map((t: any) => t.id)).toEqual([ids.sort()[0]]);
        expect(first.nextCursor).toBeTruthy();
        const second = await conform(await call(`/tasks?projectId=listing&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`), "/tasks");
        expect(second.items.map((t: any) => t.id)).toEqual(ids.slice(1));
        expect(second.nextCursor).toBeNull();
        expect((await conform(await call("/tasks?projectId=listing&limit=200&status=ready"), "/tasks")).items.map((t: any) => t.id)).toEqual(ids);
        expect((await conform(await call("/tasks?projectId=listing&status=draft"), "/tasks")).items).toEqual([]);
        for (const query of ["", "?projectId=listing&limit=0", "?projectId=listing&limit=201", "?projectId=listing&limit=1.5", "?projectId=listing&limit=", "?projectId=listing&status=bogus", "?projectId=listing&cursor=broken", `?projectId=listing&status=ready&cursor=${encodeURIComponent(first.nextCursor)}`, `?projectId=other-project&cursor=${encodeURIComponent(first.nextCursor)}`, `?projectId=listing&cursor=${encodeURIComponent(first.nextCursor.slice(0, -1) + "x")}`])
            await conform(await call(`/tasks${query}`), "/tasks", "get", 400);
        await conform(await call(`/tasks?projectId=listing&cursor=${encodeURIComponent(first.nextCursor)}`, otherSession), "/tasks", "get", 400);
        await db.prepare("DELETE FROM auth_memberships WHERE project_id=? AND sub=?").bind("listing", "alice").run();
        await conform(await call(`/tasks?projectId=listing&cursor=${encodeURIComponent(first.nextCursor)}`), "/tasks", "get", 403);
        await conform(await mf.dispatchFetch("https://control.example/tasks?projectId=listing") as unknown as Response, "/tasks", "get", 401);
    });
    it("projects claimant, intent edit time, last change and the live candidate's check state", async () => {
        const P = "task-fields", item = async (id: string) => {
            const page = await conform(await call(`/tasks?projectId=${P}&limit=200`), "/tasks");
            const listed = page.items.find((t: any) => t.id === id);
            expect(await conform(await call(`/tasks/${id}`), "/tasks/{id}")).toEqual(listed);
            return listed;
        };
        const intentAt = async (id: string) => (await life.one("SELECT i.created_at FROM tasks t JOIN intents i ON i.task_id=t.id AND i.version=t.current_intent_version WHERE t.id=?", id)).created_at;
        const row = (id: string) => life.one("SELECT status_changed_at,updated_at FROM tasks WHERE id=?", id);
        const unclaimed = await create("fields-unclaimed", P);
        const fresh = await item(unclaimed);
        expect(fresh).toMatchObject({ claimedBy: null, candidate: null, intentEditedAt: await intentAt(unclaimed) });
        const created = await life.one("SELECT created_at FROM tasks WHERE id=?", unclaimed);
        expect(fresh.intentEditedAt).toBe(created.created_at);
        const before = await row(unclaimed);
        expect(fresh.updatedAt).toBe([before.status_changed_at, before.updated_at].sort().at(-1));
        await new Promise(resolve => setTimeout(resolve, 5));
        await life.edit(unclaimed, actor, key("fields-edit"), { ...intent, title: "Edited intent" });
        const edited = await item(unclaimed);
        expect(edited.intentVersion).toBe(2);
        expect(edited.intentEditedAt).toBe(await intentAt(unclaimed));
        expect(edited.intentEditedAt > fresh.intentEditedAt).toBe(true);
        expect(edited.updatedAt).toBe((await row(unclaimed)).updated_at);
        expect(edited.updatedAt > fresh.updatedAt).toBe(true);
        const humanTask = await create("fields-human", P);
        const humanClaim = await claim(humanTask, key("fields-human-claim"));
        const human = await item(humanTask);
        expect(human.liveAttempt.claimId).toBe(humanClaim);
        expect(human.claimedBy).toEqual({ id: actor.id, kind: "human" });
        expect(human.updatedAt).toBe((await row(humanTask)).status_changed_at);
        const agentTask = await create("fields-agent", P);
        const principal = await auth.human(new Request("https://control.example", { headers: bearer(session) }));
        const preauth = await auth.preauthorize(principal, P, agentTask, "agent-fields", ["tasks:list", "tasks:read", "claims:read"], 3600);
        await conform(await call(`/tasks/${agentTask}/claim`, preauth.bootstrapToken, "POST", { intentVersion: 1 }, key("fields-agent-claim")), "/tasks/{id}/claim", "post", 202);
        expect((await item(agentTask)).claimedBy).toEqual({ id: "agent-fields", kind: "agent", delegatedBy: "https://identity.example|alice" });
        const checked = await create("fields-checked", P), checkedClaim = await claim(checked, key("fields-checked-claim"));
        const candidateId = await compute(checked, await submit(checked, checkedClaim, "fields-checked-submit"), "computed", { mode: "required" });
        expect((await item(checked)).candidate).toEqual({ sha, checks: "running" });
        const timestamp = new Date().toISOString();
        const check = (result: "passed" | "failed") => life.check(checked, key(`fields-check-${result}`), { candidateId, runId: crypto.randomUUID(), checkIdentity: "checks-v1", result, evidence: { version: 1, commands: [{ argv: ["true"], exitCode: 0 }] }, startedAt: timestamp, finishedAt: timestamp });
        await check("failed");
        expect((await item(checked)).candidate).toEqual({ sha, checks: "failed" });
        await check("passed");
        const passed = await item(checked);
        expect(passed.candidate).toEqual({ sha, checks: "passed" });
        expect(passed.liveAttempt.candidateId).toBe(candidateId);
        const unchecked = await create("fields-no-policy", P), uncheckedClaim = await claim(unchecked, key("fields-no-policy-claim"));
        await compute(unchecked, await submit(unchecked, uncheckedClaim, "fields-no-policy-submit"));
        expect((await item(unchecked)).candidate).toEqual({ sha, checks: "passed" });
        const conflicted = await create("fields-conflict", P), conflictClaim = await claim(conflicted, key("fields-conflict-claim"));
        await compute(conflicted, await submit(conflicted, conflictClaim, "fields-conflict-submit"), "conflict");
        expect((await item(conflicted)).candidate).toBeNull();
        let statements = 0;
        const counted = new Proxy(db, { get: (target, prop) => prop === "prepare"
                ? (sql: string) => { statements++; return target.prepare(sql); }
                : Reflect.get(target, prop).bind?.(target) ?? Reflect.get(target, prop) });
        const page = await new TaskLifecycle(counted).listTasks(P, "", 201, null);
        expect(page.length).toBeGreaterThanOrEqual(6);
        expect(statements).toBe(1);
    });
    it("ADR 0021: a tasks:list-only member sees this project's principal ids, and none reachable only through another project", async () => {
        const P = "disclosure", I = "https://identity.example", expiry = Math.floor(Date.now() / 1000) + 86400;
        const carol = session.replace("alice", "carol"), dave = `${I}|dave`;
        await db.batch([
            db.prepare("INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,?,?,?,?)").bind(P, P, P, actor.id, new Date().toISOString()),
            db.prepare("INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,NULL)").bind(`canonical-${P}`, P, "artifacts", `oc-${P}`, `provider-${P}`, `canonical-${P}`, "canonical", new Date().toISOString()),
            db.prepare("INSERT INTO target_refs VALUES(?,?,?,?,?)").bind(`canonical-${P}`, "refs/heads/main", base, new Date().toISOString(), "seed"),
            seedMembership(db, { project: P, issuer: I, sub: "alice", verbs: ["tasks:create", "tasks:publish", "tasks:claim", "tasks:list", "tasks:read", "claims:read", "submissions:create"] }),
            ...["carol", "dave"].map(sub => db.prepare("INSERT INTO auth_users VALUES(?,?,NULL,NULL)").bind(I, sub)),
            db.prepare("INSERT INTO auth_families VALUES(?,?,?,?,?,0)").bind("family-carol", I, "carol", expiry - 86400, expiry),
            db.prepare("INSERT INTO auth_sessions VALUES(?,?,?,?,0)").bind(await hash(carol), "family-carol", await hash("csrf"), expiry),
            seedMembership(db, { project: P, issuer: I, sub: "carol", verbs: ["tasks:list"] }),
            seedMembership(db, { project: "other-project", issuer: I, sub: "dave", verbs: ["tasks:list", "tasks:claim"] }),
        ]);
        const claimAs = (id: string, name: string, claimant: Actor, extra: {
            authorizedBy?: string;
            delegationId?: string;
        } = {}) => life.claim(id, key(name), { id: `claim-${name}`, actor: claimant, authorized: true, intentVersion: 1, expiresAt: new Date(Date.now() + 3600000).toISOString(), ...extra });
        const alice = await auth.human(new Request("https://control.example", { headers: bearer(session) }));
        const delegation = async (project: string, task: string, agent: string) => {
            await auth.preauthorize(alice, project, task, agent, ["tasks:list"], 3600);
            return (await life.one("SELECT id FROM auth_authorizations WHERE agent_id=? AND project_id=?", agent, project)).id as string;
        };
        const member = await create("disclose-member", P);
        await claimAs(member, "disclose-member", actor);
        const outsider = await create("disclose-outsider", P);
        await claimAs(outsider, "disclose-outsider", { type: "human", id: dave });
        const foreign = await create("disclose-foreign", P), elsewhere = await create("disclose-elsewhere", "other-project");
        await claimAs(foreign, "disclose-foreign", { type: "agent", id: "agent-elsewhere" }, { authorizedBy: actor.id, delegationId: await delegation("other-project", elsewhere, "agent-elsewhere") });
        const local = await create("disclose-local", P);
        await claimAs(local, "disclose-local", { type: "agent", id: "agent-local" }, { authorizedBy: dave, delegationId: await delegation(P, local, "agent-local") });
        const response = await call(`/tasks?projectId=${P}&limit=200`, carol), text = await response.clone().text();
        const byId = new Map((await conform(response, "/tasks")).items.map((t: any) => [t.id, t]));
        expect(byId.get(member).claimedBy).toEqual({ id: actor.id, kind: "human" });
        for (const id of [outsider, foreign]) {
            expect(byId.get(id).liveAttempt.claimId).toBeTruthy();
            expect(byId.get(id).claimedBy).toBeNull();
        }
        expect(byId.get(local).claimedBy).toEqual({ id: "agent-local", kind: "agent" });
        expect(text).not.toContain(dave);
        expect(text).not.toContain("agent-elsewhere");
        for (const id of [member, outsider, foreign, local])
            expect(await conform(await call(`/tasks/${id}`), "/tasks/{id}")).toEqual(byId.get(id));
        await conform(await call(`/tasks/${member}`, carol), "/tasks/{id}", "get", 403);
        await conform(await call("/tasks?projectId=other-project", carol), "/tasks", "get", 403);
        await db.prepare("DELETE FROM auth_memberships WHERE project_id=? AND sub=?").bind(P, "alice").run();
        const after = await conform(await call(`/tasks?projectId=${P}&limit=200`, carol), "/tasks");
        expect(after.items.find((t: any) => t.id === member).claimedBy).toBeNull();
        expect(JSON.stringify(after)).not.toContain(actor.id);
    });
    it("marks staged computation pending and projects a held fence and accepted dependency receipts", async () => {
        const id = await create("staged"), claimId = await claim(id, key("staged-claim"));
        const submissionId = await submit(id, claimId, "staged-first"), candidateId = await compute(id, submissionId);
        const approval = await life.approve(id, actor, key("staged-approve"), { boundTo: { candidateSha: sha, baseSha: base, intentVersion: 1 } });
        const fence = await life.land(id, actor, key("staged-land"), { approvalId: approval.body.id });
        const staged = await submit(id, claimId, "staged-second");
        expect(await conform(await call(`/submissions/${staged}/candidate`), "/submissions/{id}/candidate", "get", 202)).toEqual({ state: "pending", submissionId: staged, jobId: null, workAttribution: { kind: actor.type, id: actor.id } });
        expect((await conform(await call(`/tasks/${id}`), "/tasks/{id}")).liveAttempt).toMatchObject({ fenceId: fence.body.fenceId, candidateId, approvalId: approval.body.id });
        await life.reconcile(id, key("staged-reconcile"), { fenceId: fence.body.fenceId, runId: fence.body.runId, outcome: "landed", canonicalSha: sha, landedSha: sha, ancestryVerified: true, writerTerminated: true, eventIds: [] });
        const dependent = await create("accepted-dependent", "project", [id]);
        const dependentClaim = await claim(dependent, key("accepted-claim"), false);
        const receipt = { upstreamTaskId: id, receiptId: fence.body.fenceId, landedSha: sha };
        expect((await conform(await call(`/receipts/${fence.body.fenceId}`), "/receipts/{id}")).approverKind).toBe("human");
        expect((await conform(await call(`/tasks/${dependent}`), "/tasks/{id}")).dependencies).toEqual([{ upstreamTaskId: id, status: "landed", acceptedResult: receipt }]);
        expect((await conform(await call(`/claims/${dependentClaim}`), "/claims/{id}", "get", 202)).dependencyResults).toEqual([receipt]);
    });
    it("returns the documented immutable Submission from ordinary POST and its replays", async () => {
        const post = (id: string, name: string, body: Record<string, unknown>) => call(`/tasks/${id}/submissions`, session, "POST", body, key(name));
        const persisted = async (submissionId: string) => {
            const c = await life.one("SELECT c.*,s.work_attribution FROM submission_contexts c JOIN submissions s ON s.id=c.submission_id WHERE c.submission_id=?", submissionId);
            return { workAttribution: JSON.parse(c.work_attribution), intentVersion: c.intent_version, intentTitle: c.intent_title, acceptanceCriteria: JSON.parse(c.acceptance_criteria),
                baseSha: c.base_sha, canonicalHeadSha: c.canonical_head_sha, actorType: c.actor_type, actorId: c.actor_id,
                claimId: c.claim_id, dependencyResults: JSON.parse(c.dependency_results), snapshotAt: c.snapshot_at };
        };
        const input = { sourceSha: source, baseSha: base, intentVersion: 1 };
        const upstream = await create("post-upstream", "submissions"), upstreamClaim = await claim(upstream, key("post-upstream-claim"));
        const plain = await conform(await post(upstream, "post-plain", input), "/tasks/{id}/submissions", "post", 201);
        expect(plain).toMatchObject({ taskId: upstream, claimId: upstreamClaim, seq: 1, ...input, message: null, stagedBehindFenceId: null });
        expect(plain).not.toHaveProperty("staged");
        expect(plain.context).toEqual(await persisted(plain.id));
        expect(plain.context).toMatchObject({ intentTitle: intent.title, acceptanceCriteria: intent.acceptanceCriteria, dependencyResults: [] });
        await compute(upstream, plain.id);
        const approval = await life.approve(upstream, actor, key("post-approve"), { boundTo: { candidateSha: sha, baseSha: base, intentVersion: 1 } });
        const fence = await life.land(upstream, actor, key("post-land"), { approvalId: approval.body.id });
        const fenced = await conform(await post(upstream, "post-fenced", { ...input, sourceSha: sha, message: "Staged note" }), "/tasks/{id}/submissions", "post", 201);
        expect(fenced).toMatchObject({ seq: 2, sourceSha: sha, message: "Staged note", stagedBehindFenceId: fence.body.fenceId });
        expect(fenced.context).toEqual(await persisted(fenced.id));
        await life.reconcile(upstream, key("post-reconcile"), { fenceId: fence.body.fenceId, runId: fence.body.runId, outcome: "landed", canonicalSha: sha, landedSha: sha, ancestryVerified: true, writerTerminated: true, eventIds: [] });
        const dependent = await create("post-dependent", "submissions", [upstream]), dependentClaim = await claim(dependent, key("post-dependent-claim"));
        const noted = { ...input, message: "Note for successors" };
        const first = await conform(await post(dependent, "post-dependent", noted), "/tasks/{id}/submissions", "post", 201);
        expect(first.context.dependencyResults).toEqual([{ upstreamTaskId: upstream, receiptId: fence.body.fenceId, landedSha: sha }]);
        expect(first.context).toEqual(await persisted(first.id));
        expect(first).toMatchObject({ claimId: dependentClaim, message: "Note for successors" });
        const scope = `${actor.type}:${actor.id}:${dependent}:submit`;
        expect(JSON.parse((await life.one("SELECT response FROM lifecycle_operations WHERE scope=? AND key=?", scope, key("post-dependent"))).response))
            .toEqual({ status: 201, body: { id: first.id, seq: 1, staged: false } });
        await life.edit(dependent, actor, key("post-dependent-edit"), { ...intent, title: "Edited after submission", acceptanceCriteria: ["Changed"] });
        const task = await life.task(dependent);
        await db.prepare("UPDATE target_refs SET known_head_sha=? WHERE repository_id=? AND ref_name=?").bind("e".repeat(40), task.repository_id, task.target_ref).run();
        expect(await conform(await post(dependent, "post-dependent", noted), "/tasks/{id}/submissions", "post", 201)).toEqual(first);
        await db.prepare("INSERT INTO lifecycle_operations VALUES(?,?,?,?)").bind(scope, key("post-historical"), JSON.stringify({ baseSha: base, intentVersion: 1, message: noted.message, sourceSha: source }), JSON.stringify({ status: 201, body: { id: first.id, seq: 1, staged: false } })).run();
        expect(await conform(await post(dependent, "post-historical", noted), "/tasks/{id}/submissions", "post", 201)).toEqual(first);
        expect((await life.one("SELECT COUNT(*) AS n FROM submissions WHERE task_id=?", dependent)).n).toBe(1);
        expect((await life.one("SELECT COUNT(*) AS n FROM submission_contexts c JOIN submissions s ON s.id=c.submission_id WHERE s.task_id=?", dependent)).n).toBe(1);
    });
    it("serves webhook create, replay, disable and reactivation and conforms to OpenAPI", async () => {
        const signingSecret = btoa("s".repeat(32));
        const hook = await conform(await call("/webhooks", session, "POST", { projectId: "other-project", url: "https://hooks.example/in", types: ["task.landed"], signingSecret }, key("hook-create")), "/webhooks", "post", 201);
        expect(JSON.stringify(hook)).not.toContain(signingSecret);
        const job = await conform(await call(`/v1/webhooks/${hook.id}/replays`, session, "POST", { after: "0" }, key("hook-replay")), "/webhooks/{id}/replays", "post", 202);
        expect(job).toMatchObject({ webhookId: hook.id, after: "0", status: "queued" });
        const off = await call(`/webhooks/${hook.id}/disable`, session, "POST", {}, key("hook-disable"));
        expect(off.status).toBe(204);
        expect(await off.text()).toBe("");
        expect(await conform(await call("/webhooks", session, "POST", { projectId: "other-project", url: "https://hooks.example/in", types: ["task.landed"], signingSecret }, key("hook-create")), "/webhooks", "post", 201)).toEqual(hook);
        const reactivated = await conform(await call(`/v1/webhooks/${hook.id}/reactivate`, session, "POST", {}, key("hook-reactivate")), "/webhooks/{id}/reactivate", "post", 200);
        expect(reactivated).toEqual(hook);
        expect((await call(`/webhooks/${hook.id}/reactivate`, session, "POST", {}, "")).status).toBe(400);
        expect((await call(`/webhooks/${hook.id}/reactivate`, otherSession, "POST", {}, key("hook-denied"))).status).toBe(404);
        expect((await call(`/webhooks/${hook.id}/disable`, session, "POST", {}, key("hook-disable-later"))).status).toBe(204);
        expect(await conform(await call(`/webhooks/${hook.id}/reactivate`, session, "POST", {}, key("hook-reactivate")), "/webhooks/{id}/reactivate", "post", 200)).toEqual(reactivated);
        expect((await db.prepare("SELECT status FROM webhooks WHERE id=?").bind(hook.id).first<any>())!.status).toBe("disabled");
    }, 15000);
    it("does not document webhook operations as not-implemented", () => {
        for (const path of ["/webhooks", "/webhooks/{id}/replays", "/webhooks/{id}/disable", "/webhooks/{id}/reactivate"])
            expect(spec.paths[path].post.responses["501"]).toBeUndefined();
        expect(spec.webhooks.collaborationEvent.post.responses["501"]).toBeUndefined();
    });
    it("records the contract fixtures that web and CLI clients are tested against", async () => {
        const P = "other-project", dir = new URL("../../spec/fixtures/contract/", import.meta.url);
        const recorded: Record<string, {
            path: string;
            method: string;
            status: number;
            body: any;
        }> = {};
        const rec = async (name: string, response: Response, path: string, method = "get", status = 200) => {
            const body = await conform(response, path, method, status);
            recorded[name] = { path, method, status, body };
            return body;
        };
        const pendingTask = await create("fx-pending", P), pendingKey = key("fx-claim-pending");
        const pendingClaim = await claim(pendingTask, pendingKey, false);
        await rec("claim-get-pending", await call(`/claims/${pendingClaim}`), "/claims/{id}", "get", 202);
        await rec("claim-post-pending", await call(`/tasks/${pendingTask}/claim`, session, "POST", { intentVersion: 1 }, pendingKey), "/tasks/{id}/claim", "post", 202);
        await life.provision(pendingClaim);
        await rec("claim-get-ready", await call(`/claims/${pendingClaim}`), "/claims/{id}");
        const readyTask = await create("fx-ready", P), readyKey = key("fx-claim-ready");
        await claim(readyTask, readyKey);
        await rec("claim-post-ready", await call(`/tasks/${readyTask}/claim`, session, "POST", { intentVersion: 1 }, readyKey), "/tasks/{id}/claim", "post", 201);
        const bootTask = await create("fx-bootstrap", P);
        const human = await auth.human(new Request("https://control.example", { headers: bearer(session) }));
        const authorization = await auth.preauthorize(human, P, bootTask, "agent-a", ["tasks:list", "tasks:read", "claims:read", "candidates:read"], 3600);
        const boot = await rec("claim-post-bootstrap", await call(`/tasks/${bootTask}/claim`, authorization.bootstrapToken, "POST", { intentVersion: 1 }, key("fx-bootstrap-claim")), "/tasks/{id}/claim", "post", 202);
        boot.delegation.accessToken = "fixture-access-token";
        await rec("task-fresh", await call(`/tasks/${bootTask}`), "/tasks/{id}");
        const liveTask = await create("fx-live", P), liveClaim = await claim(liveTask, key("fx-live-claim"));
        const first = await submit(liveTask, liveClaim, "fx-first");
        await rec("candidate-pending", await call(`/submissions/${first}/candidate`), "/submissions/{id}/candidate", "get", 202);
        await rec("task-submitted", await call(`/tasks/${liveTask}`), "/tasks/{id}");
        const second = await submit(liveTask, liveClaim, "fx-second");
        await rec("candidate-superseded", await call(`/submissions/${first}/candidate`), "/submissions/{id}/candidate");
        const candidateId = await compute(liveTask, second), timestamp = new Date().toISOString();
        await rec("candidate-complete", await call(`/submissions/${second}/candidate`), "/submissions/{id}/candidate");
        await life.check(liveTask, key("fx-check"), { candidateId, runId: crypto.randomUUID(), checkIdentity: "checks-v1", result: "passed", evidence: { version: 1, commands: [{ argv: ["true"], exitCode: 0 }] }, startedAt: timestamp, finishedAt: timestamp });
        await rec("candidate-complete-checked", await call(`/submissions/${second}/candidate`), "/submissions/{id}/candidate");
        await rec("task-candidate", await call(`/tasks/${liveTask}`), "/tasks/{id}");
        const third = await submit(liveTask, liveClaim, "fx-third");
        await compute(liveTask, third, "conflict");
        await rec("candidate-conflict", await call(`/submissions/${third}/candidate`), "/submissions/{id}/candidate");
        await rec("tasks-list", await call(`/tasks?projectId=${P}&limit=200`), "/tasks");
        if (process.env.OCTOCOVE_RECORD_FIXTURES === "1") {
            mkdirSync(dir, { recursive: true });
            for (const [name, r] of Object.entries(recorded))
                writeFileSync(new URL(`${name}.json`, dir), JSON.stringify(r, null, 2) + "\n");
        }
        else {
            for (const name of Object.keys(recorded)) {
                const stored = JSON.parse(readFileSync(new URL(`${name}.json`, dir), "utf8"));
                const documented = spec.paths[stored.path][stored.method].responses[String(stored.status)];
                const resolved = documented.$ref ? spec.components.responses[documented.$ref.split("/").at(-1)] : documented;
                const validate = ajv.compile({ ...resolved.content["application/json"].schema, components: spec.components });
                expect(validate(stored.body), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
            }
        }
    }, 15000);
});
describe("governance HTTP contracts", () => {
    beforeEach(async () => {
        await db.prepare("UPDATE target_refs SET known_head_sha=? WHERE repository_id='canonical-project'").bind(base).run();
        const verbs = ["tasks:edit", "tasks:create", "tasks:publish", "tasks:claim", "tasks:list", "tasks:read", "claims:read", "submissions:create", "candidates:read", "candidates:approve"];
        for (const sub of ["alice", "bob"])
            await seedMembership(db, { project: "project", issuer: "https://identity.example", sub, verbs }).run();
    });
    const expected = (expectedStatus: string) => ({ expectedStatus, expectedIntentVersion: 1 });
    it("routes task unpublish, dependency edits and closure with OpenAPI responses", async () => {
        const a = await create("governance-a"), b = await create("governance-b");
        const foreign = await create("governance-foreign", "other-project");
        await conform(await call(`/tasks/${a}/dependencies/add`, session, "POST", { ...expected("ready"), upstreamTaskId: foreign }, key("foreign-dependency")), "/tasks/{id}/dependencies/add", "post", 404);
        await conform(await call(`/v1/tasks/${a}/unpublish`, session, "POST", expected("ready")), "/tasks/{id}/unpublish", "post");
        await conform(await call(`/tasks/${a}/dependencies/add`, session, "POST", { ...expected("draft"), upstreamTaskId: b }), "/tasks/{id}/dependencies/add", "post");
        await conform(await call(`/tasks/${a}/dependencies/remove`, session, "POST", { ...expected("draft"), upstreamTaskId: b }), "/tasks/{id}/dependencies/remove", "post");
        await conform(await call(`/tasks/${a}/supersede`, session, "POST", { ...expected("draft"), replacementTaskId: b }), "/tasks/{id}/supersede", "post");
        await conform(await call(`/tasks/${b}/reject`, session, "POST", expected("ready")), "/tasks/{id}/reject", "post");
        await conform(await call(`/tasks/${b}/reject`, session, "POST", expected("rejected"), key("terminal-reject")), "/tasks/{id}/reject", "post", 409);
    });
    it("routes takeover and approval/candidate withdrawal with durable replay", async () => {
        const id = await create("governance-review"), old = await claim(id, key("governance-old-claim"));
        const takeoverPath = `/tasks/${id}/claim/replace`;
        const takeoverInput = { ...expected("claimed"), claimId: old, expiresAt: new Date(Date.now() + 3600000).toISOString() };
        const result = await conform(await call(takeoverPath, session, "POST", takeoverInput), "/tasks/{id}/claim/replace", "post", 202);
        expect(await conform(await call(takeoverPath, session, "POST", takeoverInput), "/tasks/{id}/claim/replace", "post", 202)).toEqual(result);
        await life.provision(result.claimAttemptId);
        const submissionId = await submit(id, result.claimAttemptId, "governance-submit");
        const candidateId = await compute(id, submissionId);
        const approved = await life.approve(id, actor, key("governance-approve"), { boundTo: { candidateSha: sha, baseSha: base, intentVersion: 1 } });
        await conform(await call(`/candidates/${candidateId}/withdraw`, session, "POST", expected("approved")), "/candidates/{id}/withdraw", "post", 409);
        await conform(await call(`/v1/approvals/${approved.body.id}/withdraw`, session, "POST", expected("approved")), "/approvals/{id}/withdraw", "post");
        await conform(await call(`/candidates/${candidateId}/reject`, session, "POST", expected("candidate")), "/candidates/{id}/reject", "post", 409);
        await conform(await call(`/v1/candidates/${candidateId}/withdraw`, session, "POST", expected("candidate")), "/candidates/{id}/withdraw", "post");
    });
    it("routes successful follow-up rejection while preserving the accepted receipt", async () => {
        const id = await create("governance-followup"), claimId = await claim(id, key("governance-followup-claim"));
        const submissionId = await submit(id, claimId, "governance-followup-first");
        const candidateId = await compute(id, submissionId);
        const approved = await life.approve(id, actor, key("governance-followup-approve"), { boundTo: { candidateSha: sha, baseSha: base, intentVersion: 1 } });
        const fence = await life.land(id, actor, key("governance-followup-land"), { approvalId: approved.body.id });
        const staged = await submit(id, claimId, "governance-followup-staged");
        await life.reconcile(id, key("governance-followup-reconcile"), { fenceId: fence.body.fenceId, runId: fence.body.runId,
            outcome: "landed", canonicalSha: sha, landedSha: sha, ancestryVerified: true, writerTerminated: true, eventIds: [] });
        const job = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute' AND json_extract(payload,'$.submissionId')=?", id, staged);
        const followup = await life.candidate(id, key("governance-followup-compute"), { runId: job.run_id, submissionId: staged,
            candidateSha: source, baseSha: sha, candidateRef: `refs/candidates/${staged}`, checkIdentity: "none", checkPolicy: { mode: "none" } });
        const result = await conform(await call(`/v1/candidates/${followup.body.id}/reject`, session, "POST", expected("landed")), "/candidates/{id}/reject", "post");
        expect(result).toEqual({ id: followup.body.id, status: "rejected" });
        expect(await life.task(id)).toMatchObject({ status: "landed", accepted_receipt_id: fence.body.receiptId });
    }, 15000);
    it("requires human rights for governance and allows only the owning claimant to withdraw", async () => {
        const id = await create("governance-auth");
        const authorization = await auth.preauthorize({ type: "human", issuer: "https://identity.example", sub: "alice", familyId: "family-alice",
            sessionHash: "", absoluteExpiry: Math.floor(Date.now() / 1000) + 7200, cookie: false }, "project", id, "governance-agent", ["tasks:read", "submissions:create"], 3600);
        const claimed = await call(`/tasks/${id}/claim`, authorization.bootstrapToken, "POST", { intentVersion: 1 }, key("governance-agent-claim"));
        const grant = await claimed.json() as any;
        expect(grant.delegation.accessToken).toBeTruthy();
        const token = grant.delegation.accessToken;
        for (const [action, input] of [["unpublish", expected("claimed")], ["dependencies/add", { ...expected("claimed"), upstreamTaskId: id }],
            ["dependencies/remove", { ...expected("claimed"), upstreamTaskId: id }], ["reject", expected("claimed")],
            ["supersede", { ...expected("claimed"), replacementTaskId: id }], ["claim/replace", { ...expected("claimed"), claimId: grant.claim.id, expiresAt: new Date(Date.now() + 3600000).toISOString() }]] as const) {
            const body = await conform(await call(`/tasks/${id}/${action}`, token, "POST", input), `/tasks/{id}/${action}`, "post", 403);
            expect(body.code).toBe("human-required");
        }
        await life.provision(grant.claim.id);
        const submitted = await life.submit(id, { type: "agent", id: "governance-agent" }, grant.claim.id, key("governance-agent-submit"), { sourceSha: source, baseSha: base, intentVersion: 1 });
        const candidateId = await compute(id, submitted.body.id);
        const approved = await life.approve(id, actor, key("governance-agent-approve"), { boundTo: { candidateSha: sha, baseSha: base, intentVersion: 1 } });
        const withdrawal = await conform(await call(`/approvals/${approved.body.id}/withdraw`, token, "POST", expected("approved")), "/approvals/{id}/withdraw", "post", 403);
        expect(withdrawal.code).toBe("human-required");
        const rejection = await conform(await call(`/candidates/${candidateId}/reject`, token, "POST", expected("approved")), "/candidates/{id}/reject", "post", 403);
        expect(rejection.code).toBe("human-required");
        await call(`/approvals/${approved.body.id}/withdraw`, session, "POST", expected("approved"), key("governance-human-withdraw"));
        await conform(await call(`/candidates/${candidateId}/withdraw`, token, "POST", expected("candidate")), "/candidates/{id}/withdraw", "post");
        const other = await create("governance-membership");
        await db.prepare("UPDATE auth_memberships SET verbs=? WHERE project_id='project' AND sub='bob'").bind(JSON.stringify(["tasks:read"])).run();
        await conform(await call(`/tasks/${other}/reject`, otherSession, "POST", expected("ready")), "/tasks/{id}/reject", "post", 403);
    }, 15000);
});
