import { decodeProtectedHeader, importJWK, jwtVerify, type JWTPayload } from 'jose';
import { validReceiptRef, RECEIPT_PREFIX } from './protocol/receipt-ref.mjs';
import { validTargetRef } from './protocol/target-ref.mjs';
import { verifyPackAncestry } from './pack-ancestry';
import { ProviderTokenProvider, remoteResolver } from './remote-resolver';
import { stagedFollowUp, reserveCanonicalRead } from './canonical-head';
import { AuthError, AuthService, type AuthEnv, type Principal } from './auth';
import { assertRepositoryEligible } from './repositories';
export interface BrokerEnv extends AuthEnv {
    LOCAL_GIT_URL?: string;
    LOCAL_GIT_TOKEN?: string;
    BYO_CREDENTIALS?: Fetcher;
    ARTIFACTS_ACCOUNT_ID?: string;
    ARTIFACTS_API_TOKEN?: string;
    LEGACY_BROKER_WRITE_PROJECTS?: string;
    HELPER_RUNTIME_PUBLIC_JWKS?: string;
}
export interface Repo {
    id: string;
    provider_namespace: string;
    name: string;
    provider?: 'artifacts' | 'github' | 'forgejo';
    project_id?: string;
    provider_repo_id?: string;
}
export interface TokenProvider {
    createToken(repo: Repo, scope: 'read' | 'write', ttl: number): Promise<{
        id: string;
        plaintext: string;
        scope: string;
        expires_at: string;
        username?: string;
    }>;
    revokeToken(repo: Repo, id: string): Promise<void>;
}
export { ArtifactsTokenProvider } from './artifacts-token-provider';
type Lane = 'ref' | 'repo' | 'chain';
interface LegacyExport {
    project: string;
    lane: Lane;
}
const legacyWriteExport = (env: BrokerEnv, project: string, lane: Lane) => lane !== 'chain' &&
    (env.LEGACY_BROKER_WRITE_PROJECTS ?? '').split(',').map(id => id.trim()).filter(Boolean).includes(project);
const owner = (p: Principal) => JSON.stringify(p.type === 'human' ? ['human', p.issuer, p.sub] : ['agent', p.delegationId]);
interface Grant extends Repo {
    grant_id: string;
    task_id: string;
    claim_id: string | null;
    kind: string;
    max_scope: 'read' | 'write';
    max_ttl: number;
    expires_at: string;
    revoked_at: string | null;
    fence_id: string | null;
    run_id: string | null;
    ref_family?: string;
    target_ref?: string;
    renewed_expires_at?: string | null;
}
const renewedExpiry = (ledger: 'broker' | 'candidate', alias: string) => `(SELECT n.expires_at FROM job_grant_renewals n
  WHERE n.ledger='${ledger}' AND n.grant_id=${alias}.id ORDER BY n.generation DESC LIMIT 1) AS renewed_expires_at`;
export const RUNTIME_PUSH_PROOF_TYP = 'octocove-push-proof+jwt';
const ZERO_OID = '0'.repeat(40), MAX_PUSH_BYTES = 8 << 20;
const PUSH_CAPABILITIES = /^(report-status|ofs-delta|side-band-64k|quiet|object-format=sha1|agent=[\x21-\x7e]{1,128})$/;
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (data: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', data));
export function receivePackCommand(body: Uint8Array) {
    const text = (start: number, end: number) => new TextDecoder().decode(body.subarray(start, end));
    const length = text(0, 4);
    if (!/^[0-9a-f]{4}$/.test(length))
        return null;
    const end = parseInt(length, 16);
    if (end < 5 || end > body.length || text(end, end + 4) !== '0000')
        return null;
    const [command, capabilities, ...rest] = text(4, end).replace(/\n$/, '').split('\0');
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[\x21-\x7e]{1,500})$/.exec(command ?? '');
    const caps = (capabilities ?? '').split(' ').filter(Boolean);
    if (!m || rest.length || !caps.includes('report-status') || !caps.every(c => PUSH_CAPABILITIES.test(c)))
        return null;
    return { old: m[1]!, new: m[2]!, ref: m[3]! };
}
export const PUSH_BODY_DEADLINE_MS = 10000;
function workerPushOutcome(report: Uint8Array, ref: string): 'written' | 'rejected' | 'ambiguous' {
    const packets = (bytes: Uint8Array): Uint8Array[] | null => {
        let at = 0;
        const out: Uint8Array[] = [], decoder = new TextDecoder();
        while (at < bytes.length) {
            const prefix = decoder.decode(bytes.subarray(at, at + 4));
            if (!/^[a-f0-9]{4}$/.test(prefix))
                return null;
            const length = parseInt(prefix, 16);
            if (!length) {
                at += 4;
                continue;
            }
            if (length < 4 || at + length > bytes.length)
                return null;
            out.push(bytes.subarray(at + 4, at + length));
            at += length;
        }
        return out;
    };
    let frames = packets(report);
    if (!frames?.length)
        return 'ambiguous';
    if (frames[0]![0] === 1 || frames[0]![0] === 2 || frames[0]![0] === 3) {
        if (frames.some(frame => ![1, 2, 3].includes(frame[0]!)))
            return 'ambiguous';
        if (frames.some(frame => frame[0] === 3))
            return 'rejected';
        const status = frames.filter(frame => frame[0] === 1).map(frame => frame.subarray(1));
        const joined = new Uint8Array(status.reduce((n, frame) => n + frame.length, 0));
        let at = 0;
        for (const frame of status) {
            joined.set(frame, at);
            at += frame.length;
        }
        frames = packets(joined);
        if (!frames?.length)
            return 'ambiguous';
    }
    const lines = frames.map(frame => new TextDecoder().decode(frame));
    if (lines[0] !== 'unpack ok\n')
        return lines[0]?.startsWith('unpack ') ? 'rejected' : 'ambiguous';
    if (lines.length !== 2)
        return 'ambiguous';
    return lines[1] === `ok ${ref}\n` ? 'written' : lines[1]?.startsWith(`ng ${ref} `) ? 'rejected' : 'ambiguous';
}
export type PushBody = Uint8Array | 'too-large' | 'timeout' | 'incomplete';
export async function readPushBody(request: Request, max = MAX_PUSH_BYTES, deadlineMs = PUSH_BODY_DEADLINE_MS): Promise<PushBody> {
    if (Number(request.headers.get('content-length') ?? 0) > max)
        return 'too-large';
    if (!request.body)
        return new Uint8Array();
    const reader = request.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0, timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), deadlineMs); });
    try {
        for (;;) {
            const next = await Promise.race([reader.read(), deadline]).catch(() => 'incomplete' as const);
            if (typeof next === 'string') {
                await reader.cancel().catch(() => { });
                return next;
            }
            if (next.done)
                break;
            size += next.value.length;
            if (size > max) {
                await reader.cancel().catch(() => { });
                return 'too-large';
            }
            chunks.push(next.value);
        }
    }
    finally {
        clearTimeout(timer);
    }
    const out = new Uint8Array(size);
    chunks.reduce((offset, chunk) => (out.set(chunk, offset), offset + chunk.length), 0);
    return out;
}
const ARTIFACTS_REMOTE_HOST = /^([a-z0-9]{32})\.artifacts\.cloudflare\.net$/;
const ARTIFACTS_REMOTE_PATH = /^\/git\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git$/;
export const RUNTIME_PUSH_PROOF_CLOCK_TOLERANCE_S = 5;
export interface HelperTokenRequest {
    origin: string;
    path: string;
    scope?: 'read' | 'write';
    ttl?: number;
}
export async function resolveHelperRequest(env: BrokerEnv, request: Request, input: any): Promise<TokenRequest> {
    if (input?.origin === undefined && input?.path === undefined)
        return input;
    if (Object.keys(input).some(key => !['origin', 'path', 'scope', 'ttl'].includes(key)) || typeof input.origin !== 'string' || typeof input.path !== 'string' || !input.path || input.path.startsWith('/') ||
        input.taskId !== undefined || input.grantId !== undefined || input.repo !== undefined)
        throw new AuthError('invalid-request', 400);
    let origin: URL;
    try {
        origin = new URL(input.origin);
    }
    catch {
        throw new AuthError('invalid-request', 400);
    }
    if (origin.protocol !== 'https:' || origin.origin !== input.origin || origin.username || origin.password)
        throw new AuthError('invalid-request', 400);
    const p = await new AuthService(env).authenticate(request);
    const rows = (await env.DB.prepare(`SELECT c.task_id,p.remote FROM claims c JOIN task_provisioning p ON p.claim_id=c.id
    WHERE c.status='active' AND p.state='ready' AND c.actor_type=? AND c.actor_id=?`)
        .bind(p.type, p.type === 'human' ? `${p.issuer}|${p.sub}` : p.sub.slice(6)).all<{
        task_id: string;
        remote: string;
    }>()).results;
    const matches = rows.filter(row => {
        if (p.type === 'agent' && row.task_id !== p.taskId)
            return false;
        try {
            const u = new URL(row.remote);
            return !u.username && !u.password && !u.search && !u.hash && u.origin === input.origin && u.pathname.slice(1) === input.path;
        }
        catch {
            return false;
        }
    });
    if (matches.length !== 1)
        throw new AuthError('broker-grant-denied', 403);
    return { taskId: matches[0]!.task_id, scope: input.scope, ttl: input.ttl };
}
export interface TokenRequest {
    taskId: string;
    grantId?: string;
    repo?: string;
    scope?: 'read' | 'write';
    ttl?: number;
}
export class TokenBroker {
    constructor(private env: BrokerEnv, private provider: TokenProvider = new ProviderTokenProvider(env), private http: typeof fetch = (input, init) => fetch(input, init)) { }
    private stmt(sql: string, ...args: unknown[]) { return this.env.DB.prepare(sql).bind(...args); }
    private async grant(id: string) {
        const g = await this.stmt(`SELECT g.*,g.id AS grant_id,${renewedExpiry('broker', 'g')},r.id,r.provider_namespace,r.name,r.provider,r.project_id,r.provider_repo_id FROM broker_grants g
      JOIN repositories r ON r.id=g.repository_id WHERE g.id=? AND r.deleted_at IS NULL`, id).first<Grant>();
        if (g?.renewed_expires_at)
            g.expires_at = g.renewed_expires_at;
        if (!g || g.revoked_at || !Number.isFinite(Date.parse(g.expires_at)) || Date.parse(g.expires_at) <= Date.now())
            throw new AuthError('broker-grant-denied', 403);
        if (g.kind === 'agent') {
            const c = await this.stmt(`SELECT c.id FROM claims c JOIN task_provisioning p ON p.claim_id=c.id
        JOIN tasks t ON t.id=c.task_id WHERE c.id=? AND c.result='granted' AND c.status='active'
        AND p.state='ready' AND t.status NOT IN ('landed','rejected','superseded')
        AND julianday(c.expires_at)>julianday('now')`, g.claim_id).first();
            if (!c)
                throw new AuthError('broker-grant-denied', 403);
        }
        else if (g.fence_id) {
            const f = await this.stmt("SELECT id FROM landing_fences WHERE id=? AND integrator_run_id=? AND status='held'", g.fence_id, g.run_id).first();
            if (!f)
                throw new AuthError('broker-grant-denied', 403);
        }
        return g;
    }
    async mintForObservation(repositoryId: string, ref: string) {
        const repo = await this.stmt(`SELECT r.* FROM repositories r JOIN bound_remote_refs b ON b.repository_id=r.id
      WHERE r.id=? AND b.ref_name=? AND r.deleted_at IS NULL`, repositoryId, ref).first<Repo>();
        if (!repo)
            throw new AuthError('broker-grant-denied', 403);
        await assertRepositoryEligible(this.env.DB, repo.id);
        const id = crypto.randomUUID(), expiresAt = new Date(Date.now() + 70000).toISOString();
        await this.stmt('INSERT INTO observation_read_tokens(id,repository_id,ref_name,expires_at) VALUES(?,?,?,?)', id, repositoryId, ref, expiresAt).run();
        const token = await this.provider.createToken(repo, 'read', 60);
        if (typeof token?.id !== 'string' || !token.id)
            throw new AuthError('broker-provider-invalid-response', 503);
        try {
            await this.stmt('UPDATE observation_read_tokens SET provider_id=? WHERE id=?', token.id, id).run();
            const bound = await this.stmt(`SELECT 1 FROM bound_remote_refs b JOIN repositories r ON r.id=b.repository_id
        WHERE b.repository_id=? AND b.ref_name=? AND r.deleted_at IS NULL`, repositoryId, ref).first();
            if (!bound || token.scope !== 'read' || !token.plaintext || !(Date.parse(token.expires_at) > Date.now()) || Date.parse(token.expires_at) > Date.parse(expiresAt) ||
                (repo.provider !== 'artifacts' && (!token.username || /[\r\n\0:]/.test(token.username))))
                throw new AuthError('broker-provider-invalid-response', 503);
            await this.stmt('UPDATE observation_read_tokens SET expires_at=? WHERE id=?', token.expires_at, id).run();
            return { id, token: token.plaintext, expiresAt: token.expires_at, credential: { username: token.username ?? 'x' } };
        }
        catch (error) {
            await this.provider.revokeToken(repo, token.id);
            await this.stmt('UPDATE observation_read_tokens SET revoked_at=? WHERE id=?', new Date().toISOString(), id).run();
            throw error;
        }
    }
    async releaseObservationRead(id: string) {
        await this.stmt('UPDATE observation_read_tokens SET revoke_pending=1 WHERE id=?', id).run();
    }
    async drainObservationReads() {
        for (const t of (await this.stmt(`SELECT t.*,r.* ,t.id AS token_id FROM observation_read_tokens t
      JOIN repositories r ON r.id=t.repository_id WHERE t.revoked_at IS NULL AND (t.revoke_pending=1 OR julianday(t.expires_at)<=julianday('now'))`).all<any>()).results) {
            if (t.provider_id && Date.parse(t.expires_at) > Date.now())
                await this.provider.revokeToken(t, t.provider_id);
            await this.stmt('UPDATE observation_read_tokens SET revoked_at=? WHERE id=?', new Date().toISOString(), t.token_id).run();
        }
    }
    async mint(request: Request, input: TokenRequest | HelperTokenRequest) {
        input = await resolveHelperRequest(this.env, request, input);
        if (!input || typeof input.taskId !== 'string' || (input.grantId !== undefined && typeof input.grantId !== 'string') ||
            (input.repo !== undefined && typeof input.repo !== 'string'))
            throw new AuthError('invalid-request', 400);
        const auth = new AuthService(this.env), p = await auth.authenticate(request);
        const { claim, g, project } = await this.claimGrant(p, input.taskId, input.grantId);
        const lane = await this.lane(claim.id), legacy = legacyWriteExport(this.env, project, lane);
        const scope = input.scope ?? (legacy ? g.max_scope : 'read');
        if (scope === 'write' && !legacy) {
            const code = lane === 'chain' ? 'chain-push-queue-required' : 'protected-runtime-required';
            await this.admission(g, project, lane, owner(p), 'refused', code).run();
            throw new AuthError(code, 403);
        }
        const native = lane === 'chain' && await this.stmt("SELECT 1 FROM task_repo_mappings WHERE claim_id=? AND repository_id=? AND ref_name='refs/octocove/claims/'||claim_id AND retired_at IS NULL", claim.id, g.id).first();
        if (native && p.type !== 'agent') {
            await this.admission(g, project, lane, owner(p), 'refused', 'chain-writer-denied', null, 'read').run();
            throw new AuthError('chain-writer-denied', 403);
        }
        await auth.authorize(request, project, input.taskId, scope === 'write' ? 'submissions:create' : 'tasks:read');
        return this.issue(g, owner(p), { ...input, scope }, async () => { await auth.authorize(request, project, g.task_id, scope === "write" ? "submissions:create" : "tasks:read"); }, legacy ? { project, lane } : undefined);
    }
    private async claimGrant(p: Principal, taskId: string, grantId?: string) {
        const claim = await this.stmt(`SELECT id,actor_type,actor_id,delegation_id FROM claims WHERE task_id=? AND status='active'`, taskId).first<any>();
        if (!claim || (p.type === 'human' ? claim.actor_type !== 'human' || claim.actor_id !== `${p.issuer}|${p.sub}` :
            claim.actor_type !== 'agent' || claim.id !== p.claimAttemptId || claim.delegation_id !== p.delegationId || claim.actor_id !== p.sub.slice(6)))
            throw new AuthError('broker-grant-denied', 403);
        const g = await this.grant(grantId ?? `grant-${claim.id}`);
        if (g.kind !== 'agent' || g.claim_id !== claim.id || g.task_id !== taskId)
            throw new AuthError('broker-grant-denied', 403);
        const project: string = (await this.stmt("SELECT project_id FROM tasks WHERE id=?", g.task_id).first<any>()).project_id;
        return { claim, g, project };
    }
    async admitPush(request: Request, taskId: string) {
        const auth = new AuthService(this.env), p = await auth.authenticate(request);
        const { claim, g, project } = await this.claimGrant(p, taskId);
        const lane = await this.lane(claim.id), principal = owner(p);
        const refuse = async (code: string, status = 403): Promise<never> => {
            await this.admission(g, project, lane, principal, 'refused', code).run();
            throw new AuthError(code, status);
        };
        if (lane === 'chain')
            return refuse('chain-push-queue-required');
        if (lane === 'ref')
            return refuse('gateway-proof-required');
        const mapping = await this.stmt(`SELECT m.ref_name,p.remote FROM task_repo_mappings m
      JOIN task_provisioning p ON p.mapping_id=m.id AND p.claim_id=m.claim_id JOIN repositories r ON r.id=m.repository_id
      WHERE m.claim_id=? AND m.kind='task-repo' AND m.repository_id=? AND m.retired_at IS NULL AND p.state='ready'
      AND r.role='task' AND r.provider='artifacts' AND r.deleted_at IS NULL`, claim.id, g.id).first<{
            ref_name: string;
            remote: string;
        }>();
        let remote: URL | null = null;
        try {
            remote = mapping ? new URL(mapping.remote) : null;
        }
        catch { }
        if (!mapping || !remote || remote.protocol !== 'https:' || remote.username || remote.password || remote.search || remote.hash ||
            !ARTIFACTS_REMOTE_HOST.test(remote.hostname) || remote.port || !ARTIFACTS_REMOTE_PATH.test(remote.pathname))
            return refuse('broker-grant-denied');
        await auth.authorize(request, project, taskId, 'submissions:create');
        const proof = await this.runtimePushProof(request.headers.get('X-Octocove-Runtime-Proof'), project).catch(error => refuse(error instanceof AuthError ? error.code : 'runtime-proof-invalid', error instanceof AuthError ? error.status : 403));
        const c = proof.payload;
        if (c.v !== 1 || c.project !== project || c.task !== taskId || c.claim !== claim.id || c.grant !== g.grant_id ||
            c.repo !== g.id || c.ref !== mapping.ref_name)
            return refuse('proof-mismatch');
        return { auth, claim, g, project, principal, refuse, mapping, remote, proof };
    }
    async pushForHelper(request: Request, taskId: string, preread?: PushBody, deferRevocation?: (tokenId: string) => Promise<void>): Promise<Response> {
        const { auth, claim, g, project, principal, refuse, mapping, remote, proof } = await this.admitPush(request, taskId);
        const c = proof.payload;
        const body = preread ?? await readPushBody(request);
        if (body === 'too-large')
            return refuse('push-too-large', 413);
        if (body === 'timeout')
            return refuse('push-body-timeout', 408);
        if (body === 'incomplete')
            return refuse('push-malformed', 400);
        const command = receivePackCommand(body);
        if (!command)
            return refuse('push-malformed', 400);
        if (command.ref !== mapping.ref_name)
            return refuse('ref-not-owned');
        if (command.new === ZERO_OID)
            return refuse('ref-delete-refused');
        if (command.old !== c.old || command.new !== c.new || await sha256(body) !== c.bodyDigest)
            return refuse('proof-mismatch');
        const nonce = await sha256(new TextEncoder().encode(`octocove-push-proof/v1:${c.jti}`));
        if (await this.stmt('SELECT 1 FROM broker_push_admissions WHERE nonce_hash=?', nonce).first())
            return refuse('proof-replayed');
        await this.stmt(`INSERT INTO broker_push_admissions(nonce_hash,at,project_id,task_id,claim_id,grant_id,repository_id,ref_name,old_oid,new_oid,
      body_digest,runtime_kid,principal,proof_expires_at,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'admitted')`, nonce, new Date().toISOString(), project, taskId, claim.id, g.grant_id, g.id, mapping.ref_name, command.old, command.new, c.bodyDigest, proof.kid, principal, new Date(c.exp! * 1000).toISOString()).run().catch(() => refuse('proof-replayed'));
        let outcome: 'written' | 'rejected' | 'ambiguous' = 'rejected';
        try {
            const token = await this.issue(g, principal, { scope: 'write', ttl: 60 }, async () => { await auth.authorize(request, project, taskId, 'submissions:create'); }, undefined, 'helper-push');
            let upstream: Response;
            try {
                const headers = new Headers({ 'Content-Type': 'application/x-git-receive-pack-request', Accept: 'application/x-git-receive-pack-result' });
                headers.set('Authorization', `Bearer ${token.token}`);
                outcome = 'ambiguous';
                upstream = await this.http(`${remote.href.replace(/\/$/, '')}/git-receive-pack`, {
                    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000), body, headers,
                });
                const report = upstream.status === 200 ? new Uint8Array(await upstream.arrayBuffer()) : null;
                if (upstream.status !== 200)
                    await upstream.body?.cancel();
                const text = report ? new TextDecoder().decode(report) : '';
                if (report && text.includes('unpack ok\n') && text.includes(`ok ${mapping.ref_name}\n`))
                    outcome = 'written';
                else if (report || (upstream.status >= 400 && upstream.status < 500))
                    outcome = 'rejected';
                if (!report)
                    throw new AuthError(outcome === 'rejected' ? 'upstream-rejected' : 'upstream-ambiguous', 502);
                return new Response(report, { status: 200, headers: { 'Content-Type': 'application/x-git-receive-pack-result', 'Cache-Control': 'no-store' } });
            }
            catch (error) {
                if (error instanceof AuthError)
                    throw error;
                throw new AuthError('upstream-ambiguous', 502);
            }
            finally {
                await this.stmt('UPDATE broker_tokens SET revoke_pending=1 WHERE id=?', token.id).run().catch(async () => {
                    console.warn('broker-push-revoke-mark-failed', { taskId, claimId: claim.id });
                    await deferRevocation?.(token.id).catch(() => console.warn('broker-push-revoke-defer-failed', { taskId, claimId: claim.id }));
                });
                await this.drainRevocations(taskId).catch(() => { });
            }
        }
        finally {
            await this.stmt("UPDATE broker_push_admissions SET outcome=?,settled_at=? WHERE nonce_hash=? AND outcome='admitted'", outcome, new Date().toISOString(), nonce).run()
                .catch(() => console.warn('broker-push-settle-failed', { taskId, claimId: claim.id, outcome }));
        }
    }
    async admitWorkerPush(request: Request, taskId: string) {
        const task = await this.stmt('SELECT * FROM tasks WHERE id=?', taskId).first<any>();
        if (!task)
            throw new AuthError('not-found', 404);
        let p: Principal | undefined;
        const refuse = async (code: string, status = 403): Promise<never> => {
            await this.stmt(`INSERT INTO broker_admission_audit(id,at,project_id,task_id,claim_id,grant_id,lane,principal,scope,decision,code)
        VALUES(?,?,?,?,?,?,'chain',?,'write','refused',?)`, crypto.randomUUID(), new Date().toISOString(), task.project_id, taskId, p?.type === 'agent' ? p.claimAttemptId : 'none', p?.type === 'agent' ? `grant-${p.claimAttemptId}` : 'none', p ? owner(p) : 'unauthenticated', code).run();
            throw new AuthError(code, status);
        };
        const auth = new AuthService(this.env);
        try {
            p = await auth.authenticate(request);
        }
        catch (error) {
            if (error instanceof AuthError && error.status >= 500)
                throw error;
            return refuse('unauthenticated', 401);
        }
        if (p.type !== 'agent' || p.taskId !== taskId)
            return refuse('chain-writer-denied');
        const claim = await this.stmt(`SELECT c.*,a.base_sha FROM claims c JOIN chain_lane_attempts a ON a.claim_id=c.id
      JOIN chain_lanes l ON l.id=a.chain_id JOIN task_provisioning provision ON provision.claim_id=c.id
      JOIN task_repo_mappings m ON m.id=provision.mapping_id
      WHERE c.id=? AND c.task_id=? AND c.actor_type='agent' AND c.actor_id=? AND c.delegation_id=?
      AND c.status='active' AND julianday(c.expires_at)>julianday('now') AND l.writer_claim_id=c.id
      AND l.phase IN ('pending','attached') AND provision.state='ready' AND m.claim_id=c.id AND m.task_id=c.task_id AND m.repository_id=?
      AND m.ref_name='refs/octocove/claims/'||c.id AND m.retired_at IS NULL`, p.claimAttemptId, taskId, p.sub.slice(6), p.delegationId, task.repository_id).first<any>();
        if (!claim)
            return refuse('chain-writer-denied');
        if (await this.stmt("SELECT 1 FROM landing_fences WHERE task_id=? AND status='held'", taskId).first())
            return refuse('fenced', 409);
        try {
            await auth.authorize(request, task.project_id, taskId, 'submissions:create');
        }
        catch (error) {
            return refuse(error instanceof AuthError ? error.code : 'forbidden', error instanceof AuthError ? error.status : 403);
        }
        const g = await this.grant(`grant-${claim.id}`);
        if (g.id !== task.repository_id || g.provider !== 'artifacts' || !(await this.stmt("SELECT 1 FROM repositories WHERE id=? AND role='canonical'", g.id).first()))
            return refuse('broker-grant-denied');
        return { claim, g, p, refuse, task };
    }
    private async workerRefs(request: Request, taskId: string, reserve = false) {
        const admission = await this.admitWorkerPush(request, taskId), { g, p, task } = admission;
        const remote = new URL((await remoteResolver(this.env, g).resolve(g)).pushUrl);
        if (remote.protocol !== 'https:' || remote.username || remote.password || remote.search || remote.hash || remote.port ||
            !ARTIFACTS_REMOTE_HOST.test(remote.hostname) || !ARTIFACTS_REMOTE_PATH.test(remote.pathname))
            return admission.refuse('broker-grant-denied');
        const generation = reserve ? await reserveCanonicalRead(this.env.DB, g.id, task.target_ref) : undefined;
        const token = await this.issue(g, owner(p), { scope: 'read', ttl: 60 }, async () => { await this.admitWorkerPush(request, taskId); });
        try {
            await this.stmt('UPDATE broker_tokens SET revoke_pending=1 WHERE id=?', token.id).run();
            const upstream = await this.http(`${remote.href.replace(/\/$/, '')}/info/refs?service=git-upload-pack`, {
                redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { Authorization: `Basic ${btoa(`x:${token.token}`)}` },
            });
            if (!upstream.ok || !(upstream.headers.get('Content-Type') ?? '').startsWith('application/x-git-upload-pack-advertisement'))
                throw new AuthError('upstream-unavailable', 503);
            const body = await readPushBody(upstream as unknown as Request, 1 << 20);
            if (typeof body === 'string')
                throw new AuthError('upstream-unavailable', 503);
            const heads = new Map<string, string>(), decoder = new TextDecoder();
            let at = 0, service = false, flushed = false;
            while (at < body.length) {
                const prefix = decoder.decode(body.subarray(at, at + 4));
                if (!/^[a-f0-9]{4}$/.test(prefix))
                    throw new AuthError('upstream-unavailable', 503);
                const length = parseInt(prefix, 16);
                if (!length) {
                    at += 4;
                    flushed = true;
                    continue;
                }
                if (length < 4 || at + length > body.length)
                    throw new AuthError('upstream-unavailable', 503);
                const line = decoder.decode(body.subarray(at + 4, at + length)).replace(/\n$/, '');
                at += length;
                if (line === '# service=git-upload-pack') {
                    service = true;
                    continue;
                }
                const match = /^([a-f0-9]{40}) ([^\0]+)(?:\0.*)?$/.exec(line);
                if (!match)
                    throw new AuthError('upstream-unavailable', 503);
                heads.set(match[2]!, match[1]!);
            }
            if (!service || !flushed || !heads.has(task.target_ref))
                throw new AuthError('upstream-unavailable', 503);
            return { ...admission, heads, remote, generation };
        }
        finally {
            await this.stmt('UPDATE broker_tokens SET revoke_pending=1 WHERE id=?', token.id).run().catch(() => { });
            await this.drainRevocations(taskId).catch(() => { });
        }
    }
    async advertiseWorkerPush(request: Request, taskId: string) {
        const { claim, heads, task } = await this.workerRefs(request, taskId);
        const ref = `refs/octocove/claims/${claim.id}`, tip = heads.get(ref);
        const pkt = (line: string) => (new TextEncoder().encode(line).length + 4).toString(16).padStart(4, '0') + line;
        const caps = 'report-status ofs-delta object-format=sha1';
        const body = pkt('# service=git-receive-pack\n') + '0000' + pkt(`${tip ?? ZERO_OID} ${tip ? ref : 'capabilities^{}'}\0${caps}\n`) +
            [...new Set([claim.base_sha, heads.get(task.target_ref)!])].map(sha => pkt(`${sha} .have\n`)).join('') + '0000';
        return new Response(body, { headers: { 'Content-Type': 'application/x-git-receive-pack-advertisement', 'Cache-Control': 'no-store' } });
    }
    async pushWorkerNative(request: Request, taskId: string, body: PushBody, written: (claim: any, sha: string, pushId: string, candidateBase: string) => Promise<void>, deferRevocation?: (id: string) => Promise<void>, observeHead?: (head: string, generation: number) => Promise<void>) {
        const { claim, g, p, refuse } = await this.admitWorkerPush(request, taskId);
        if (body === 'too-large')
            return refuse('push-too-large', 413);
        if (body === 'timeout')
            return refuse('push-body-timeout', 408);
        if (body === 'incomplete')
            return refuse('push-malformed', 400);
        if (body.byteLength > MAX_PUSH_BYTES)
            return refuse('push-too-large', 413);
        const command = receivePackCommand(body), ref = `refs/octocove/claims/${claim.id}`;
        if (!command)
            return refuse('push-malformed', 400);
        if (command.ref !== ref)
            return refuse('ref-not-owned');
        if (command.new === ZERO_OID)
            return refuse('ref-delete-refused');
        const pushId = await sha256(new TextEncoder().encode(`worker-native-push:${claim.id}:${command.new}`)), digest = await sha256(body);
        const prior = await this.stmt('SELECT * FROM worker_native_pushes WHERE id=?', pushId).first<any>();
        const response = (report: ArrayBuffer | Uint8Array) => new Response(report, { headers: { 'Content-Type': 'application/x-git-receive-pack-result', 'Cache-Control': 'no-store' } });
        if (prior) {
            if (prior.body_digest !== digest)
                return refuse('idempotency-conflict', 409);
            if (prior.status === 'written') {
                await written(claim, command.new, pushId, prior.base_sha);
                return response(new Uint8Array(prior.report));
            }
            if (prior.status === 'rejected') {
                if (prior.report)
                    return response(new Uint8Array(prior.report));
                throw new AuthError('upstream-rejected', 502);
            }
            throw new AuthError('upstream-ambiguous', 502);
        }
        const { heads, remote, task, generation } = await this.workerRefs(request, taskId, true);
        const currentTip = heads.get(ref) ?? ZERO_OID;
        if (command.old !== currentTip)
            return refuse('chain-push-non-fast-forward', 409);
        const anchor = await this.stmt("SELECT source_sha,base_sha FROM worker_native_pushes WHERE claim_id=? AND source_sha=? AND status='written'", claim.id, currentTip).first<any>();
        let candidateBase: string;
        try {
            candidateBase = (await verifyPackAncestry(body, command.new, claim.base_sha, heads.get(task.target_ref), anchor ? { sha: anchor.source_sha, base: anchor.base_sha } : undefined))!;
        }
        catch (error) {
            return refuse(error instanceof AuthError ? error.code : 'candidate-ancestry-unverifiable', error instanceof AuthError ? error.status : 422);
        }
        const observedHead = heads.get(task.target_ref)!;
        if ((await this.stmt('SELECT known_head_sha FROM target_refs WHERE repository_id=? AND ref_name=?', g.id, task.target_ref).first<any>()).known_head_sha !== observedHead) {
            if (!observeHead)
                throw new AuthError('canonical-observation-required', 503);
            await observeHead(observedHead, generation!);
        }
        await this.stmt(`INSERT INTO worker_native_pushes VALUES(?,?,?,?,?,?,'cli-same-user','admitted',NULL,?)`, pushId, taskId, claim.id, command.new, candidateBase, digest, new Date().toISOString()).run();
        const token = await this.issue(g, owner(p), { scope: 'write', ttl: 60 }, async () => { await this.admitWorkerPush(request, taskId); }, undefined, 'worker-native-push');
        let report: Uint8Array | undefined, outcome = 'ambiguous';
        try {
            await this.stmt('UPDATE broker_tokens SET revoke_pending=1 WHERE id=?', token.id).run();
            const upstream = await this.http(`${remote.href.replace(/\/$/, '')}/git-receive-pack`, {
                method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000), body,
                headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/x-git-receive-pack-request', Accept: 'application/x-git-receive-pack-result' },
            });
            if (upstream.status !== 200) {
                await upstream.body?.cancel();
                if (upstream.status >= 400 && upstream.status < 500)
                    outcome = 'rejected';
                throw new AuthError(outcome === 'rejected' ? 'upstream-rejected' : 'upstream-ambiguous', 502);
            }
            const raw = await readPushBody(upstream as unknown as Request, 1 << 20, 10000);
            if (typeof raw === 'string')
                throw new AuthError('upstream-ambiguous', 502);
            report = raw;
            outcome = workerPushOutcome(report, ref);
            await this.stmt('UPDATE worker_native_pushes SET status=?,report=? WHERE id=?', outcome, report, pushId).run();
        }
        catch (error) {
            await this.stmt("UPDATE worker_native_pushes SET status=? WHERE id=? AND status='admitted'", outcome === 'rejected' ? 'rejected' : 'ambiguous', pushId).run().catch(() => { });
            throw error instanceof AuthError ? error : new AuthError('upstream-ambiguous', 502);
        }
        finally {
            await this.stmt('UPDATE broker_tokens SET revoke_pending=1 WHERE id=?', token.id).run().catch(async () => { await deferRevocation?.(token.id).catch(() => { }); });
            await this.drainRevocations(taskId).catch(() => { });
        }
        if (outcome === 'ambiguous')
            throw new AuthError('upstream-ambiguous', 502);
        if (outcome === 'written')
            await written(claim, command.new, pushId, candidateBase);
        return response(report!);
    }
    async pruneSettledPushAdmissions(limit = 200) {
        await this.stmt(`DELETE FROM broker_push_admissions WHERE nonce_hash IN (SELECT nonce_hash FROM broker_push_admissions
      WHERE outcome<>'admitted' AND julianday(proof_expires_at)<=julianday('now','-60 seconds') LIMIT ?)`, limit).run();
    }
    private async runtimePushProof(proof: string | null, project: string): Promise<{
        kid: string;
        payload: JWTPayload & Record<string, unknown>;
    }> {
        if (!proof)
            throw new AuthError('protected-runtime-required', 403);
        if (!this.env.OCTOCOVE_ISSUER || !this.env.HELPER_RUNTIME_PUBLIC_JWKS)
            throw new AuthError('runtime-proof-unconfigured', 503);
        let header: ReturnType<typeof decodeProtectedHeader>, keys: unknown = [];
        try {
            header = decodeProtectedHeader(proof);
        }
        catch {
            throw new AuthError('runtime-proof-invalid', 403);
        }
        try {
            keys = JSON.parse(this.env.HELPER_RUNTIME_PUBLIC_JWKS).keys;
        }
        catch { }
        const jwk = Array.isArray(keys) ? keys.find(k => k && typeof k === 'object' && k.kid === header.kid && k.kty === 'EC' && k.crv === 'P-256' &&
            Array.isArray(k.octocove_projects) && k.octocove_projects.includes(project)) : undefined;
        if (header.alg !== 'ES256' || header.typ !== RUNTIME_PUSH_PROOF_TYP || typeof header.kid !== 'string' || !jwk)
            throw new AuthError('runtime-key-denied', 403);
        try {
            const { payload } = await jwtVerify(proof, await importJWK({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, 'ES256'), {
                audience: this.env.OCTOCOVE_ISSUER, typ: RUNTIME_PUSH_PROOF_TYP, algorithms: ['ES256'], requiredClaims: ['iat', 'exp', 'jti'],
                clockTolerance: RUNTIME_PUSH_PROOF_CLOCK_TOLERANCE_S, maxTokenAge: 120
            });
            if (payload.exp! - payload.iat! > 120 || !/^[A-Za-z0-9_-]{22,128}$/.test(payload.jti!))
                throw new Error();
            return { kid: header.kid, payload: payload as JWTPayload & Record<string, unknown> };
        }
        catch {
            throw new AuthError('runtime-proof-invalid', 403);
        }
    }
    private async lane(claimId: string): Promise<Lane> {
        if (await this.stmt('SELECT claim_id FROM chain_lane_attempts WHERE claim_id=?', claimId).first())
            return 'chain';
        const m = await this.stmt('SELECT kind FROM task_repo_mappings WHERE claim_id=? ORDER BY created_at DESC LIMIT 1', claimId).first<{
            kind: string;
        }>();
        return m?.kind === 'lane-ref' ? 'ref' : 'repo';
    }
    private admission(g: Grant, project: string, lane: Lane, principal: string, decision: 'refused' | 'legacy-export', code: string, tokenId: string | null = null, scope: 'read' | 'write' = 'write') {
        return this.stmt(`INSERT INTO broker_admission_audit(id,at,project_id,task_id,claim_id,grant_id,lane,principal,scope,decision,code,broker_token_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, crypto.randomUUID(), new Date().toISOString(), project, g.task_id, g.claim_id, g.grant_id, lane, principal, scope, decision, code, tokenId);
    }
    async mintForJob(runId: string, grantId: string, input: Omit<TokenRequest, 'taskId'> & {
        repo: string;
        targetRef: string;
    }) {
        const g = await this.grant(grantId);
        await this.jobTarget(g, input);
        if (g.kind === 'agent' || g.run_id !== runId)
            throw new AuthError('broker-grant-denied', 403);
        return this.issue(g, JSON.stringify(['integrator', runId]), input);
    }
    private async candidateGrant(runId: string) {
        const g = await this.stmt(`SELECT c.id AS grant_id,c.task_id,c.run_id,c.expires_at,c.revoked_at,${renewedExpiry('candidate', 'c')},
      c.ref_family,c.target_ref,r.id,r.provider_namespace,r.name,r.provider,r.project_id,r.provider_repo_id FROM integrator_candidate_grants c
      JOIN repositories r ON r.id=c.repository_id JOIN lifecycle_outbox j ON j.run_id=c.run_id AND j.task_id=c.task_id
      JOIN tasks t ON t.id=c.task_id JOIN submissions s ON s.id=json_extract(j.payload,'$.submissionId') AND s.task_id=t.id
      WHERE c.run_id=? AND j.kind='compute' AND r.deleted_at IS NULL AND t.status NOT IN ('rejected','superseded')
      AND (t.status<>'landed' OR ${stagedFollowUp('c.run_id')})`, runId).first<any>();
        if (g?.renewed_expires_at)
            g.expires_at = g.renewed_expires_at;
        return g;
    }
    async mintCandidateForJob(runId: string, input: {
        repo: string;
        targetRef: string;
    }) {
        const g = await this.candidateGrant(runId);
        if (!g || g.revoked_at || Date.parse(g.expires_at) <= Date.now())
            throw new AuthError('broker-grant-denied', 403);
        await this.jobTarget(g, input);
        const grant: Grant = { ...g, kind: 'integrator-candidate-write', max_scope: 'write', max_ttl: 900, claim_id: null, fence_id: null };
        const result = await this.issue(grant, JSON.stringify(['integrator', runId]), { ...input, scope: 'write' });
        return { ...result, refFamily: g.ref_family };
    }
    private async receiptGrant(runId: string) {
        return this.stmt(`SELECT o.receipt_id AS grant_id,o.task_id,o.run_id,o.ref_name AS target_ref,
      'refs/octocove/receipts/' AS ref_family,r.id,r.provider_namespace,r.name,r.provider,r.project_id,r.provider_repo_id
      FROM receipt_export_outbox o JOIN landing_receipts l ON l.id=o.receipt_id
      JOIN repositories r ON r.id=o.repository_id
      WHERE o.run_id=? AND o.status='pending' AND o.signed_content IS NOT NULL AND r.deleted_at IS NULL`, runId).first<any>();
    }
    async mintReceiptForJob(runId: string, input: {
        repo: string;
        targetRef: string;
        ttl?: number;
    }) {
        const g = await this.receiptGrant(runId);
        if (!g || input.repo !== g.id || input.targetRef !== g.target_ref ||
            !validReceiptRef(input.targetRef))
            throw new AuthError('broker-grant-denied', 403);
        const grant: Grant = { ...g, kind: 'receipt-export', max_scope: 'write', max_ttl: 900,
            claim_id: null, fence_id: null, revoked_at: null, expires_at: new Date(Date.now() + 900000).toISOString() };
        return { ...await this.issue(grant, JSON.stringify(['receipt-export', runId]), { ...input, scope: 'write' }), refFamily: RECEIPT_PREFIX };
    }
    private async jobTarget(g: Grant, input: {
        repo: string;
        targetRef: string;
    }) {
        if (!validTargetRef(input?.targetRef) || g.target_ref !== input.targetRef || g.id !== input.repo)
            throw new AuthError('broker-grant-denied', 403);
        const target = await this.stmt(`SELECT t.id FROM tasks t JOIN target_refs r ON r.repository_id=t.repository_id AND r.ref_name=t.target_ref
      WHERE t.id=? AND t.target_ref=?`, g.task_id, input.targetRef).first();
        if (!target)
            throw new AuthError('broker-grant-denied', 403);
    }
    private async issue(g: Grant, principal: string, input: Omit<TokenRequest, 'taskId'> & {
        targetRef?: string;
    }, recheck?: () => Promise<void>, legacy?: LegacyExport, delivery?: 'helper-push' | 'worker-native-push') {
        const chain = g.kind === 'agent' && await this.stmt('SELECT claim_id FROM chain_lane_attempts WHERE claim_id=?', g.claim_id).first();
        const scope = input.scope ?? (g.kind === 'agent' && !legacy ? 'read' : g.max_scope);
        if (chain && scope === 'write' && delivery !== 'worker-native-push')
            throw new AuthError('chain-push-queue-required', 403);
        if (g.kind === 'agent' && scope === 'write' && !legacy && delivery !== 'helper-push' && delivery !== 'worker-native-push')
            throw new AuthError('protected-runtime-required', 403);
        if (!['read', 'write'].includes(scope) || (scope === 'write' && g.max_scope === 'read') || (input.repo !== undefined && input.repo !== g.id))
            throw new AuthError('broker-grant-denied', 403);
        const requested = input.ttl ?? g.max_ttl;
        if (!Number.isSafeInteger(requested) || requested < 60)
            throw new AuthError('invalid-request', 400);
        const now = Math.floor(Date.now() / 1000), ttl = Math.min(requested, g.max_ttl, 900, 31536000, Math.floor(Date.parse(g.expires_at) / 1000) - now - 10);
        if (ttl < 60)
            throw new AuthError('broker-grant-expiring', 403);
        const ledger = g.kind === 'receipt-export' ? 'receipt_export_tokens' : g.kind === 'integrator-candidate-write' ? 'integrator_candidate_tokens' : 'broker_tokens';
        const id = crypto.randomUUID(), expiresAt = new Date(Math.min(Date.parse(g.expires_at), (now + ttl + 10) * 1000)).toISOString();
        await assertRepositoryEligible(this.env.DB, g.id);
        const record = this.stmt(`INSERT INTO ${ledger}(id,grant_id,owner,scope,expires_at) VALUES(?,?,?,?,?)`, id, g.grant_id, principal, scope, expiresAt);
        if (legacy && scope === 'write')
            await this.env.DB.batch([record, this.admission(g, legacy.project, legacy.lane, principal, 'legacy-export', 'legacy-write-export', id)]);
        else
            await record.run();
        const token = await this.provider.createToken(g, scope, ttl);
        if (typeof token?.id !== 'string' || !token.id)
            throw new AuthError('broker-provider-unavailable', 503);
        try {
            await this.stmt(`UPDATE ${ledger} SET provider_id=? WHERE id=?`, token.id, id).run();
            if ((g.provider !== 'artifacts' && g.provider !== undefined && (typeof token.username !== 'string' || !token.username || /[\r\n\0:]/.test(token.username))) || typeof token.plaintext !== 'string' || !token.plaintext || token.scope !== scope || !Number.isFinite(Date.parse(token.expires_at)) || Date.parse(token.expires_at) > Math.min(Date.parse(g.expires_at), (now + ttl + 10) * 1000) || Date.parse(token.expires_at) <= Date.now())
                throw new AuthError('broker-provider-invalid-response', 503);
            if (g.kind === 'receipt-export') {
                if (!await this.receiptGrant(g.run_id!))
                    throw new AuthError('broker-grant-denied', 403);
            }
            else if (g.kind === 'integrator-candidate-write') {
                const live = await this.candidateGrant(g.run_id!);
                if (!live || live.revoked_at || Date.parse(live.expires_at) <= Date.now())
                    throw new AuthError('broker-grant-denied', 403);
            }
            else
                await this.grant(g.grant_id);
            if (g.kind !== 'agent' && g.kind !== 'receipt-export')
                await this.jobTarget(g, { repo: input.repo!, targetRef: input.targetRef! });
            await recheck?.();
            await this.stmt(`UPDATE ${ledger} SET expires_at=? WHERE id=?`, token.expires_at, id).run();
            return { id, token: token.plaintext, expiresAt: token.expires_at, repo: g.id, scope,
                ...(token.username ? { credential: { username: token.username, password: token.plaintext } } : {}),
                ...(g.kind !== 'agent' ? { targetRef: g.target_ref } : {}),
                ...(g.fence_id && scope === 'write' ? { refFamily: g.target_ref } : {}) };
        }
        catch (error) {
            try {
                await this.stmt(`UPDATE ${ledger} SET provider_id=?,revoke_pending=1 WHERE id=?`, token.id, id).run();
            }
            catch {
                try {
                    await this.provider.revokeToken(g, token.id);
                }
                catch { }
                throw error;
            }
            try {
                await this.drainRevocations(g.task_id);
            }
            catch {
                try {
                    await this.provider.revokeToken(g, token.id);
                }
                catch { }
            }
            throw error;
        }
    }
    async revoke(request: Request, id: string) {
        const p = await new AuthService(this.env).authenticate(request);
        const t = await this.stmt(`SELECT t.*,g.task_id FROM broker_tokens t JOIN broker_grants g ON g.id=t.grant_id WHERE t.id=? AND t.owner=?`, id, owner(p)).first<any>();
        if (!t)
            throw new AuthError('broker-token-not-found', 404);
        if (!t.revoked_at) {
            await this.stmt('UPDATE broker_tokens SET revoke_pending=1 WHERE id=?', id).run();
            await this.drainRevocations(t.task_id);
        }
    }
    async markRevocations(ids: string[]) {
        if (ids.length)
            await this.env.DB.batch(ids.map(id => this.stmt('UPDATE broker_tokens SET revoke_pending=1 WHERE id=? AND revoked_at IS NULL', id)));
    }
    async drainRevocations(taskId: string) {
        for (const ledger of ['broker_tokens', 'integrator_candidate_tokens', 'receipt_export_tokens'] as const) {
            const grants = ledger === 'receipt_export_tokens' ? 'receipt_export_outbox' : ledger === 'broker_tokens' ? 'broker_grants' : 'integrator_candidate_grants';
            const grantKey = ledger === 'receipt_export_tokens' ? 'receipt_id' : 'id';
            const tokens = (await this.stmt(`SELECT t.*,r.id AS repo_id,r.provider_namespace,r.name,r.provider,r.project_id,r.provider_repo_id FROM ${ledger} t
        JOIN ${grants} g ON g.${grantKey}=t.grant_id JOIN repositories r ON r.id=g.repository_id
        WHERE g.task_id=? AND t.revoke_pending=1 AND t.revoked_at IS NULL`, taskId).all<any>()).results;
            for (const t of tokens) {
                if (t.provider_id && Date.parse(t.expires_at) > Date.now())
                    await this.provider.revokeToken({ ...t, id: t.repo_id }, t.provider_id);
                await this.stmt(`UPDATE ${ledger} SET revoked_at=?,revoke_pending=0 WHERE id=?`, new Date().toISOString(), t.id).run();
            }
        }
    }
}
