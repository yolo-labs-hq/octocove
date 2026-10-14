export interface HintBinding {
    tenant: string;
    provider: 'artifacts' | 'github' | 'forgejo';
    accountId: string;
    namespace: string;
    repoId: string;
    generation: number;
}
export function hintBinding(body: unknown): HintBinding | null {
    const b = (body as any)?.binding;
    if (!b || typeof b !== 'object' || Array.isArray(b) ||
        !['tenant', 'accountId', 'namespace', 'repoId'].every(k => typeof b[k] === 'string' && b[k].length > 0) ||
        !['artifacts', 'github', 'forgejo'].includes(b.provider) ||
        !Number.isSafeInteger(b.generation) || b.generation < 0)
        return null;
    return { tenant: b.tenant, provider: b.provider, accountId: b.accountId,
        namespace: b.namespace, repoId: b.repoId, generation: b.generation };
}
export function scopedHintId(b: HintBinding, eventId: string): string {
    return JSON.stringify([b.tenant, b.provider, b.accountId, b.namespace, b.repoId, b.generation, eventId]);
}
export const bindingParams = (b: HintBinding) => [b.tenant, b.provider, b.accountId, b.namespace, b.repoId, b.generation];
export const boundRepositories = `SELECT r.*, b.source_id, b.account_id, b.tenant_id, b.generation
  FROM inbound_hint_bindings b JOIN repositories r ON r.id=b.repository_id
  WHERE b.tenant_id=? AND b.provider=? AND b.account_id=? AND b.namespace=? AND b.provider_repo_id=? AND b.generation=?
    AND b.retired_at IS NULL AND r.deleted_at IS NULL
    AND r.provider=b.provider AND r.provider_namespace=b.namespace AND r.provider_repo_id=b.provider_repo_id`;
export async function bindHintFromSource(db: D1Database, sourceId: string, body: unknown): Promise<unknown> {
    const source = await db.prepare(`SELECT b.* FROM inbound_hint_bindings b JOIN repositories r ON r.id=b.repository_id
    WHERE b.source_id=? AND b.retired_at IS NULL AND r.deleted_at IS NULL
    AND r.provider=b.provider AND r.provider_namespace=b.namespace AND r.provider_repo_id=b.provider_repo_id`).bind(sourceId).first<any>();
    if (!source)
        throw new Error('unknown-inbound-source');
    if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new Error('invalid-hint-body');
    return { ...body, binding: { tenant: source.tenant_id, provider: source.provider, accountId: source.account_id,
            namespace: source.namespace, repoId: source.provider_repo_id, generation: source.generation } satisfies HintBinding };
}
