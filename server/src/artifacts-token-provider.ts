import { AuthError } from './auth';
import type { BrokerEnv, Repo, TokenProvider } from './broker';
import { artifactsFailure } from './failure-telemetry';
export type ArtifactsCredentialStatus = 'missing' | 'rejected' | 'rate-limited' | 'unavailable';
export class ArtifactsProviderError extends AuthError {
    constructor(public readonly credentialStatus: ArtifactsCredentialStatus, code: string, public readonly retryAfterMs?: number) { super(code, 503); }
}
function retryAfterMs(value: string | null): number | undefined {
    if (value === null)
        return undefined;
    const trimmed = value.trim();
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
        const milliseconds = Number(trimmed) * 1000;
        return Number.isFinite(milliseconds) ? milliseconds : undefined;
    }
    const date = Date.parse(trimmed);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
export function artifactsCredentialFailure(method: 'GET' | 'POST', code: string, status?: number | null, retryAfter?: string | null): ArtifactsProviderError {
    const kind: ArtifactsCredentialStatus = status === undefined ? 'missing'
        : status === 401 || status === 403 ? 'rejected'
            : status === 429 ? 'rate-limited' : 'unavailable';
    const error = artifactsFailure(new ArtifactsProviderError(kind, code, kind === 'rate-limited' ? retryAfterMs(retryAfter ?? null) : undefined)) as ArtifactsProviderError;
    console.warn(JSON.stringify({ event: 'artifacts-credential-failure', credentialStatus: kind, method,
        ...(typeof status === 'number' ? { upstreamStatus: status } : {}) }));
    return error;
}
export class ArtifactsTokenProvider implements TokenProvider {
    constructor(private env: BrokerEnv, private http: typeof fetch = (input, init) => fetch(input, init)) { }
    private async request(repo: Repo, suffix: string, method: string, body?: unknown) {
        if (repo.provider && repo.provider !== 'artifacts')
            throw new AuthError('broker-grant-denied', 403);
        if (!this.env.ARTIFACTS_ACCOUNT_ID || !this.env.ARTIFACTS_API_TOKEN)
            throw method === 'POST' ? artifactsCredentialFailure('POST', 'broker-unavailable') : new AuthError('broker-unavailable', 503);
        const path = `/accounts/${encodeURIComponent(this.env.ARTIFACTS_ACCOUNT_ID)}/artifacts/namespaces/${encodeURIComponent(repo.provider_namespace)}/tokens${suffix}`;
        try {
            const response = await this.http(`https://api.cloudflare.com/client/v4${path}`, {
                method, redirect: 'manual', signal: AbortSignal.timeout(10000),
                headers: { Authorization: `Bearer ${this.env.ARTIFACTS_API_TOKEN}`, 'Content-Type': 'application/json' },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            if (method === 'DELETE' && response.status === 404)
                return;
            if (!response.ok)
                throw method === 'POST'
                    ? artifactsCredentialFailure('POST', 'broker-provider-unavailable', response.status, response.headers.get('Retry-After'))
                    : new AuthError('broker-provider-unavailable', 503);
            const envelope = await response.json() as any;
            if (envelope.success !== true)
                throw method === 'POST'
                    ? artifactsCredentialFailure('POST', 'broker-provider-unavailable', response.status)
                    : new AuthError('broker-provider-unavailable', 503);
            return envelope.result;
        }
        catch (error) {
            if (method === 'POST' && !(error instanceof ArtifactsProviderError))
                throw artifactsCredentialFailure('POST', 'broker-provider-unavailable', null);
            throw artifactsFailure(error);
        }
    }
    createToken(repo: Repo, scope: 'read' | 'write', ttl: number) {
        return this.request(repo, '', 'POST', { repo: repo.name, scope, ttl });
    }
    async revokeToken(repo: Repo, id: string) { await this.request(repo, `/${encodeURIComponent(id)}`, 'DELETE'); }
}
