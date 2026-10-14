import { applyNextReleaseSchema } from './helpers/next-release-schema';
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import { exportJWK, generateKeyPair } from "jose";
import { AuthService, hash, type AuthEnv } from "../src/auth";
import type { AuditRow } from "../src/audit";
import { listLandings } from "../src/landings";
import { TaskLifecycle, type Actor } from "../src/lifecycle";
import { deriveReceipt } from "../src/receipt";
import { creationId } from "../src/task-coordinator";
import type { TaskRepoProvisioner } from "../src/provisioner";
import { syntheticSourceAccess } from "./lifecycle-adapter";
import { authHeaders, seedMembership, syntheticToken } from "./helpers/fixtures";
const spec = parse(readFileSync(new URL("../../spec/openapi.yaml", import.meta.url), "utf8"));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validators = new Map();
async function conform(response: Response, status = 200) {
    expect(response.status, await response.clone().text()).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const documented = spec.paths["/projects/{project}/landings"].get.responses[String(status)];
    expect(documented, `status ${status}`).toBeDefined();
    const resolved = documented.$ref ? spec.components.responses[documented.$ref.split("/").at(-1)] : documented;
    const schema = resolved.content[response.headers.get("Content-Type")!.split(";")[0]!].schema;
    if (!validators.has(status))
        validators.set(status, ajv.compile({ ...schema, components: spec.components }));
    const validate = validators.get(status), body = await response.json() as any;
    expect(validate(body), JSON.stringify(validate.errors, null, 2)).toBe(true);
    return body;
}
let mf: Miniflare, db: D1Database, env: AuthEnv, life: TaskLifecycle;
const actor: Actor = { type: "human", id: "https://identity.example|alice" };
const session = syntheticToken("ocs", "landings-alice"), outsider = syntheticToken("ocs", "landings-bob");
const seed = "a".repeat(40);
const key = (text: string) => text.padEnd(20, "-");
const sha = (n: number, digit: string) => `${digit}${n.toString(16).padStart(39, "0")}`;
const intent = { title: "Ship the task", description: "A complete task contract", acceptanceCriteria: ["All checks pass"] };
const adapter: TaskRepoProvisioner = {
    async provision(c) { return { taskRepo: { id: c.id, name: `oc-${c.id}`, namespace: c.namespace }, remote: `https://artifacts.example/git/${c.id}.git`, targetRef: c.targetRef }; },
    async subscribe(r) { return `subscription-${r.id}`; },
    async release() { },
};
const call = (path: string, token = session) => mf.dispatchFetch(`https://control.example${path}`, { headers: authHeaders(token) }) as unknown as Promise<Response>;
const heads = new Map<string, string>();
async function land(project: string, name: string, n: number, delegated = false) {
    const id = await creationId(project, name), base = heads.get(project) ?? seed, candidate = sha(n, "c");
    await life.create(id, actor, key(`create-${name}`), { ...intent, projectId: project, repositoryId: `canonical-${project}`, targetRef: "refs/heads/main", key: name, dependsOn: [] });
    await life.publish(id, actor, key(`publish-${name}`));
    const auth = new AuthService(env), human = delegated ? await auth.human(new Request('https://control.example/v1/test', { headers: authHeaders(session) })) : undefined;
    const grant = human ? await auth.preauthorize(human, project, id, 'work-agent', ['tasks:read', 'claims:read', 'submissions:create', 'candidates:read', 'receipts:read'], 3600) : undefined;
    const worker: Actor = delegated ? { type: 'agent', id: 'work-agent' } : actor;
    const claimId = grant?.claimAttemptId ?? `claim-${await hash(`${id}:${actor.id}:${name}`)}`;
    await life.claim(id, key(`claim-${name}`), { id: claimId, actor: worker, ...(grant ? { authorizedBy: actor.id, delegationId: grant.delegationId, authorizationId: grant.id } : {}), authorized: true, intentVersion: 1, expiresAt: new Date(Date.now() + 3600000).toISOString() });
    await life.provision(claimId);
    const credential = human && grant ? await auth.issueDelegation({ authorizer: human, project, task: id, claimAttempt: claimId, verbs: grant.verbs, ttl: 900 }) : undefined;
    const submission = (await life.submit(id, worker, claimId, key(`submit-${name}`), { sourceSha: sha(n, "b"), baseSha: base, intentVersion: 1 })).body;
    const submissionId = submission.id as string;
    const job = await life.one("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute' ORDER BY rowid DESC LIMIT 1", id);
    await life.candidate(id, key(`compute-${name}`), { runId: job.run_id, submissionId, baseSha: base, checkIdentity: "checks-v1", checkPolicy: { mode: "none" }, candidateSha: candidate, candidateRef: `refs/candidates/${submissionId}` });
    await life.approve(id, actor, key(`approve-${name}`), { boundTo: { candidateSha: candidate, baseSha: base, intentVersion: 1 } });
    const approval = await life.one("SELECT id FROM approvals WHERE task_id=? AND status='active'", id);
    const fence = (await life.land(id, actor, key(`land-${name}`), { approvalId: approval.id })).body;
    await life.reconcile(id, key(`reconcile-${name}`), { fenceId: fence.fenceId, runId: fence.runId, outcome: "landed", canonicalSha: candidate, landedSha: candidate, ancestryVerified: true, writerTerminated: true, eventIds: [] });
    heads.set(project, candidate);
    await new Promise(resolve => setTimeout(resolve, 5));
    return { taskId: id, receiptId: fence.fenceId as string, submission, credential, claimId };
}
beforeAll(async () => {
    const bundle = await build({ entryPoints: [new URL("./http-projections-worker.ts", import.meta.url).pathname], bundle: true, external: ["cloudflare:sockets"], write: false, format: "esm", platform: "neutral", target: "es2022" });
    const pair = await generateKeyPair("RS256", { extractable: true });
    const bindings = {
        AUTH_RECOVERY_KEY: btoa("x".repeat(32)), WEBHOOK_SECRET_KEY: btoa("v".repeat(32)), OCTOCOVE_ISSUER: "https://control.example",
        DELEGATION_PRIVATE_JWK: JSON.stringify({ ...await exportJWK(pair.privateKey), kid: "test" }),
        DELEGATION_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...await exportJWK(pair.publicKey), kid: "test" }] }),
    };
    mf = new Miniflare({ modules: true, script: bundle.outputFiles![0]!.text, bindings, compatibilityDate: "2026-07-02", d1Databases: { DB: "landings" }, durableObjects: { TASKS: "ProjectionTaskCoordinator" }, queueProducers: { EVENTS: "events" } });
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
    const projects = ["landed", "empty", "elsewhere", "attribution"];
    for (const project of projects) {
        await db.batch([
            db.prepare("INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,?,?,?,?)").bind(project, project, project, actor.id, now),
            db.prepare("INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,NULL)").bind(`canonical-${project}`, project, "artifacts", `oc-${project}`, `provider-${project}`, `canonical-${project}`, "canonical", now),
            db.prepare("INSERT INTO target_refs VALUES(?,?,?,?,?)").bind(`canonical-${project}`, "refs/heads/main", seed, now, "seed"),
        ]);
    }
    const verbs = ["tasks:edit", "tasks:create", "tasks:publish", "tasks:claim", "tasks:list", "tasks:read", "claims:read", "receipts:read", "submissions:create", "candidates:read", "candidates:approve"];
    for (const [sub, token, memberOf] of [["alice", session, projects], ["bob", outsider, ["elsewhere"]]] as const) {
        await db.batch([
            db.prepare("INSERT INTO auth_users VALUES(?,?,NULL,NULL)").bind("https://identity.example", sub),
            db.prepare("INSERT INTO auth_families VALUES(?,?,?,?,?,0)").bind(`family-${sub}`, "https://identity.example", sub, expiry - 86400, expiry),
            db.prepare("INSERT INTO auth_sessions VALUES(?,?,?,?,0)").bind(await hash(token), `family-${sub}`, await hash("csrf"), expiry),
            ...memberOf.map(project => seedMembership(db, { project, issuer: "https://identity.example", sub, verbs })),
        ]);
    }
    env = { DB: db, ...bindings };
    life = new TaskLifecycle(db, adapter, syntheticSourceAccess);
}, 30000);
afterAll(async () => { await mf?.dispose(); });
describe("GET /v1/projects/{project}/landings", () => {
    const landed: {
        taskId: string;
        receiptId: string;
    }[] = [];
    beforeAll(async () => {
        for (let n = 1; n <= 5; n++)
            landed.push(await land("landed", `landing-${n}`, n));
        const id = await creationId("landed", "unlanded");
        await life.create(id, actor, key("create-unlanded"), { ...intent, projectId: "landed", repositoryId: "canonical-landed", targetRef: "refs/heads/main", key: "unlanded", dependsOn: [] });
    }, 60000);
    it("answers an empty page for a project with no landings", async () => {
        expect(await conform(await call("/v1/projects/empty/landings"))).toEqual({ items: [], nextCursor: null });
    });
    it("lists every landing newest first", async () => {
        const page = await conform(await call("/v1/projects/landed/landings"));
        expect(page.nextCursor).toBeNull();
        expect(page.items.map((item: any) => item.taskId)).toEqual(landed.map(l => l.taskId).reverse());
        expect(page.items.map((item: any) => item.receiptId)).toEqual(landed.map(l => l.receiptId).reverse());
        const times = page.items.map((item: any) => item.landedAt);
        expect([...times].sort().reverse()).toEqual(times);
        expect(page.items[0]).toMatchObject({ landedSha: sha(5, "c"), candidateSha: sha(5, "c"), baseShaBefore: sha(4, "c"),
            intentVersion: 1, approvedBy: actor.id, actor: { type: "human", id: actor.id }, ancestryVerified: true });
    });
    it("pages across a boundary with a stable, bound cursor", async () => {
        const first = await conform(await call("/v1/projects/landed/landings?limit=2"));
        expect(first.items).toHaveLength(2);
        expect(first.nextCursor).toEqual(expect.any(String));
        expect((await conform(await call("/v1/projects/landed/landings?limit=2"))).nextCursor).toBe(first.nextCursor);
        const cursor = encodeURIComponent(first.nextCursor);
        const second = await conform(await call(`/v1/projects/landed/landings?limit=2&cursor=${cursor}`));
        expect(await conform(await call(`/v1/projects/landed/landings?limit=2&cursor=${cursor}`))).toEqual(second);
        landed.push(await land("landed", "landing-6", 6));
        expect(await conform(await call(`/v1/projects/landed/landings?limit=2&cursor=${cursor}`))).toEqual(second);
        const third = await conform(await call(`/v1/projects/landed/landings?limit=2&cursor=${encodeURIComponent(second.nextCursor)}`));
        expect(third.nextCursor).toBeNull();
        const all = (await conform(await call("/v1/projects/landed/landings"))).items;
        expect(all.map((i: any) => i.receiptId)).toEqual(landed.map(l => l.receiptId).reverse());
        expect([...first.items, ...second.items, ...third.items]).toEqual(all.slice(1));
        await conform(await call(`/v1/projects/empty/landings?cursor=${cursor}`), 400);
        await conform(await call(`/v1/projects/landed/landings?cursor=${encodeURIComponent(first.nextCursor.slice(0, -2))}`), 400);
        await conform(await call("/v1/projects/landed/landings?limit=0"), 400);
    }, 30000);
    it("reports each landing exactly as GET /receipts/{id} and its audit evidence do", async () => {
        const items = (await conform(await call("/v1/projects/landed/landings"))).items;
        expect(items.length).toBeGreaterThanOrEqual(5);
        for (const item of items) {
            const receipt = await (await call(`/v1/receipts/${item.receiptId}`)).json() as any;
            const validateReceipt = ajv.compile({ $ref: '#/components/schemas/Receipt', components: spec.components });
            expect(validateReceipt(receipt), JSON.stringify(validateReceipt.errors)).toBe(true);
            const stored = await life.one('SELECT work_attribution,future_metadata FROM landing_receipts WHERE id=?', item.receiptId);
            expect(stored.future_metadata).toBe('not-public');
            expect(receipt.workAttribution).toEqual(JSON.parse(stored.work_attribution));
            expect(receipt).not.toHaveProperty('futureMetadata');
            expect(item).toMatchObject({ receiptId: receipt.id, taskId: receipt.taskId, landedSha: receipt.landedSha, candidateSha: receipt.candidateSha,
                baseShaBefore: receipt.baseShaBefore, intentVersion: receipt.intentVersion, landedAt: receipt.reconciledAt,
                integratorRunId: receipt.integratorRunId, ancestryVerified: receipt.ancestryVerified });
            const audit = (await db.prepare("SELECT CAST(id AS TEXT) AS id,at,actor_type AS actorType,actor_id AS actorId,project_id AS projectId,task_id AS taskId,type,refs,idempotency_key AS idempotencyKey FROM audit_log WHERE task_id=? ORDER BY id")
                .bind(item.taskId).all<any>()).results.map(row => ({ ...row, refs: JSON.parse(row.refs) })) as AuditRow[];
            const derived = deriveReceipt(audit, item.receiptId);
            expect(item).toMatchObject({ approvedBy: derived.approvedBy, approvedAt: derived.approvedAt, actor: derived.actor });
            const approval = await db.prepare("SELECT approved_by,approved_at FROM approvals WHERE id=?").bind(receipt.approvalId).first<any>();
            expect(item).toMatchObject({ approvedBy: approval.approved_by, approvedAt: approval.approved_at });
        }
    });
    it("reads a page in two statements whatever its size (no per-task query)", async () => {
        for (const limit of [1, 6]) {
            let statements = 0;
            const counted = new Proxy(db, { get: (target, prop) => prop === "prepare"
                    ? (sql: string) => { if (/landing_receipts|audit_log/.test(sql))
                        statements++; return target.prepare(sql); }
                    : Reflect.get(target, prop).bind?.(target) ?? Reflect.get(target, prop) });
            const page = await listLandings(new Request(`https://control.example/v1/projects/landed/landings?limit=${limit}`, { headers: authHeaders(session) }), { ...env, DB: counted }, "landed");
            expect(page.items).toHaveLength(limit);
            expect(statements).toBe(2);
        }
    });
    it("retains delegated work attribution after claim completion in submission, receipt, audit and landing contracts", async () => {
        const work = await land('attribution', 'delegated-attribution', 17, true);
        const expected = { kind: 'agent', id: 'work-agent', delegatedBy: actor.id };
        const validateSubmission = ajv.compile({ $ref: '#/components/schemas/Submission', components: spec.components });
        expect(validateSubmission(work.submission), JSON.stringify(validateSubmission.errors)).toBe(true);
        expect(work.submission.workAttribution).toEqual(expected);
        expect(work.submission.context.workAttribution).toEqual(expected);
        const response = await call(`/v1/submissions/${work.submission.id}/candidate`, work.credential!.accessToken);
        expect(response.status).toBe(200);
        const candidateResult = await response.json() as any;
        const validateCandidate = ajv.compile({ $ref: '#/components/schemas/CandidateResult', components: spec.components });
        expect(validateCandidate(candidateResult), JSON.stringify(validateCandidate.errors)).toBe(true);
        expect(candidateResult.workAttribution).toEqual(expected);
        expect(candidateResult.candidate.submissionId).toBe(work.submission.id);
        expect((await call(`/v1/submissions/${work.submission.id}/candidate`, outsider)).status).toBe(403);
        expect(JSON.parse((await life.one('SELECT work_attribution FROM submissions WHERE id=?', work.submission.id)).work_attribution)).toEqual(expected);
        expect((await life.one('SELECT status FROM claims WHERE id=?', work.claimId)).status).toBe('completed');
        const task = await (await call(`/v1/tasks/${work.taskId}`)).json() as any;
        expect(task.claimedBy).toBeNull();
        const receipt = await (await call(`/v1/receipts/${work.receiptId}`, work.credential!.accessToken)).json() as any;
        const validateReceipt = ajv.compile({ $ref: '#/components/schemas/Receipt', components: spec.components });
        expect(validateReceipt(receipt), JSON.stringify(validateReceipt.errors)).toBe(true);
        expect(receipt.workAttribution).toEqual(expected);
        const page = await conform(await call('/v1/projects/attribution/landings'));
        expect(page.items).toHaveLength(1);
        expect(page.items[0]).toMatchObject({ workAttribution: expected, approvedBy: actor.id, actor: { type: 'human', id: actor.id } });
        const agentPage = await conform(await call('/v1/projects/attribution/landings', work.credential!.accessToken));
        expect(agentPage.items[0].workAttribution).toEqual(expected);
        const audit = (await db.prepare("SELECT CAST(id AS TEXT) AS id,at,actor_type AS actorType,actor_id AS actorId,project_id AS projectId,task_id AS taskId,type,refs,idempotency_key AS idempotencyKey FROM audit_log WHERE task_id=? ORDER BY id")
            .bind(work.taskId).all<any>()).results.map(row => ({ ...row, refs: JSON.parse(row.refs) })) as AuditRow[];
        expect(deriveReceipt(audit, work.receiptId).workAttribution).toEqual(expected);
        await db.prepare("UPDATE auth_users SET display_name='Renamed' WHERE issuer='https://identity.example' AND sub='alice'").run();
        expect((await (await call(`/v1/receipts/${work.receiptId}`)).json() as any).workAttribution).toEqual(expected);
        await expect(db.prepare("UPDATE submissions SET work_attribution='{}' WHERE id=?").bind(work.submission.id).run()).rejects.toThrow(/immutable/);
    }, 30000);
    it("answers 404 for an unknown project and 403 for a non-member", async () => {
        expect(await conform(await call("/v1/projects/no-such-project/landings"), 404)).toMatchObject({ code: "not-found" });
        expect(await conform(await call("/v1/projects/landed/landings", outsider), 403)).toMatchObject({ code: "forbidden" });
        expect(await conform(await call("/v1/projects/elsewhere/landings", outsider))).toEqual({ items: [], nextCursor: null });
        await conform(await mf.dispatchFetch("https://control.example/v1/projects/landed/landings") as unknown as Response, 401);
    });
});
