import { AuthError } from './auth';
import { ArtifactsTokenProvider } from './artifacts-token-provider';
import { ArtifactsRemoteResolver } from './remote-resolver';
import type { BrokerEnv, Repo, TokenProvider } from './broker';
import { buildInitialCommit, seedReportOutcome } from './git-seed';
export interface SeedIntent {
    id: string;
    project_id: string;
    principal: string;
    provider_namespace: string;
    name: string;
    provider_repo_id: string | null;
    target_ref: string;
    created_at: string;
}
interface SeedRow {
    intent_id: string;
    project_id: string;
    principal: string;
    provider_namespace: string;
    name: string;
    provider_repo_id: string;
    target_ref: string;
    commit_sha: string;
    outcome: 'admitted' | 'written' | 'rejected' | 'ambiguous';
    provider_token_id: string | null;
    expires_at: string;
    revoked_at: string | null;
}
const repoOf = (row: SeedIntent | SeedRow): Repo => ({ id: 'id' in row ? row.id : row.intent_id, provider: 'artifacts',
    project_id: row.project_id, provider_namespace: row.provider_namespace, name: row.name, provider_repo_id: row.provider_repo_id! });
function seedRemote(value: string, intent: SeedIntent) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
        !/^[a-z0-9]{32}\.artifacts\.cloudflare\.net$/.test(url.hostname) ||
        url.pathname !== `/git/${encodeURIComponent(intent.provider_namespace)}/${encodeURIComponent(intent.name)}.git`)
        throw new AuthError('broker-provider-invalid-response', 503);
    return url.href;
}
async function reportBytes(response: Response): Promise<Uint8Array | null> {
    if (!response.body)
        return null;
    const reader = response.body.getReader(), parts: Uint8Array[] = [];
    let length = 0, timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 30000); });
    try {
        for (;;) {
            const part = await Promise.race([reader.read(), deadline]);
            if (!part)
                return null;
            if (part.done)
                break;
            length += part.value.length;
            if (length > 65536)
                return null;
            parts.push(part.value);
        }
        const out = new Uint8Array(length);
        let offset = 0;
        for (const part of parts) {
            out.set(part, offset);
            offset += part.length;
        }
        return out;
    }
    finally {
        clearTimeout(timer!);
        await reader.cancel().catch(() => { });
    }
}
export class RepositorySeedWriter {
    private tokens: TokenProvider;
    constructor(private env: BrokerEnv, private http: typeof fetch = (input, init) => fetch(input, init), tokens?: TokenProvider) {
        this.tokens = tokens ?? new ArtifactsTokenProvider(env, http);
    }
    async written(intent: SeedIntent): Promise<string | null> {
        const row = await this.env.DB.prepare('SELECT * FROM repository_seed_pushes WHERE intent_id=?').bind(intent.id).first<SeedRow>();
        return row?.outcome === 'written' && row.provider_repo_id === intent.provider_repo_id && row.target_ref === intent.target_ref ? row.commit_sha : null;
    }
    async seed(intent: SeedIntent, projectName: string, cloneUrl: string | undefined, recheck: () => Promise<void>) {
        if (!intent.provider_repo_id)
            throw new AuthError('broker-provider-unavailable', 503);
        const existing = await this.env.DB.prepare('SELECT * FROM repository_seed_pushes WHERE intent_id=?').bind(intent.id).first<SeedRow>();
        if (existing) {
            const sha = await this.written(intent);
            if (sha)
                return sha;
            throw new AuthError('upstream-ambiguous', 502);
        }
        const seed = await buildInitialCommit({ projectName, principal: intent.principal, createdAt: intent.created_at, targetRef: intent.target_ref });
        const repo = repoOf(intent);
        const remote = seedRemote(cloneUrl ?? (await new ArtifactsRemoteResolver(this.env, this.http).resolve(repo)).pushUrl, intent);
        await recheck();
        const expires = new Date(Date.now() + 70000).toISOString();
        const admission = await this.env.DB.prepare(`INSERT INTO repository_seed_pushes(intent_id,project_id,principal,provider_namespace,name,
      provider_repo_id,target_ref,commit_sha,admitted_at,outcome,expires_at,revoke_pending)
      SELECT ?,?,?,?,?,?,?,?,?, 'admitted',?,1 WHERE EXISTS(SELECT 1 FROM repository_creations WHERE id=? AND state='pending' AND seed=1 AND provider_repo_id=?)`)
            .bind(intent.id, intent.project_id, intent.principal, intent.provider_namespace, intent.name, intent.provider_repo_id, intent.target_ref, seed.commitSha, new Date().toISOString(), expires, intent.id, intent.provider_repo_id).run();
        if (!admission.meta.changes)
            throw new AuthError('broker-provider-unavailable', 503);
        let outcome: SeedRow['outcome'] = 'rejected', token: Awaited<ReturnType<TokenProvider['createToken']>> | undefined;
        try {
            token = await this.tokens.createToken(repo, 'write', 60);
            if (!token || typeof token.id !== 'string' || !token.id)
                throw new AuthError('broker-provider-invalid-response', 503);
            const providerExpiry = Number.isFinite(Date.parse(token.expires_at)) ? token.expires_at : expires;
            await this.env.DB.prepare('UPDATE repository_seed_pushes SET provider_token_id=?,expires_at=? WHERE intent_id=?')
                .bind(token.id, providerExpiry, intent.id).run();
            if (token.scope !== 'write' || typeof token.plaintext !== 'string' || !token.plaintext ||
                !Number.isFinite(Date.parse(token.expires_at)) || Date.parse(token.expires_at) <= Date.now() || Date.parse(token.expires_at) > Date.parse(expires))
                throw new AuthError('broker-provider-invalid-response', 503);
            await recheck();
            outcome = 'ambiguous';
            const response = await this.http(`${remote}/git-receive-pack`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000),
                headers: { Authorization: `Bearer ${token.plaintext}`, 'Content-Type': 'application/x-git-receive-pack-request', Accept: 'application/x-git-receive-pack-result' }, body: seed.body });
            if (response.status === 200) {
                const bytes = await reportBytes(response);
                outcome = bytes ? seedReportOutcome(bytes, intent.target_ref) : 'ambiguous';
            }
            else {
                outcome = response.status >= 400 && response.status < 500 && response.status !== 408 ? 'rejected' : 'ambiguous';
                await response.body?.cancel();
            }
            if (outcome !== 'written')
                throw new AuthError(outcome === 'rejected' ? 'upstream-rejected' : 'upstream-ambiguous', 502);
            return seed.commitSha;
        }
        catch (error) {
            if (error instanceof AuthError)
                throw error;
            throw new AuthError(outcome === 'ambiguous' ? 'upstream-ambiguous' : 'broker-provider-unavailable', 503);
        }
        finally {
            await this.env.DB.prepare("UPDATE repository_seed_pushes SET outcome=?,settled_at=? WHERE intent_id=? AND outcome='admitted'")
                .bind(outcome, new Date().toISOString(), intent.id).run().catch(() => console.warn('repository-seed-settle-failed', { intentId: intent.id }));
            if (token?.id) {
                try {
                    await this.tokens.revokeToken(repo, token.id);
                    await this.env.DB.prepare('UPDATE repository_seed_pushes SET revoked_at=?,revoke_pending=0 WHERE intent_id=?')
                        .bind(new Date().toISOString(), intent.id).run();
                }
                catch {
                    console.warn('repository-seed-revoke-pending', { intentId: intent.id });
                }
            }
        }
    }
    async drainRevocations() {
        const rows = (await this.env.DB.prepare('SELECT * FROM repository_seed_pushes WHERE revoke_pending=1 AND revoked_at IS NULL LIMIT 10').all<SeedRow>()).results;
        for (const row of rows) {
            try {
                if (Date.parse(row.expires_at) > Date.now()) {
                    if (!row.provider_token_id)
                        continue;
                    await this.tokens.revokeToken(repoOf(row), row.provider_token_id);
                }
                await this.env.DB.prepare('UPDATE repository_seed_pushes SET revoked_at=?,revoke_pending=0 WHERE intent_id=?')
                    .bind(new Date().toISOString(), row.intent_id).run();
            }
            catch { }
        }
    }
}
