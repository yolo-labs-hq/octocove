export const LEGACY_TENANT_ID = 'octocove';
export const LEGACY_WEBHOOK_DISPATCHER = LEGACY_TENANT_ID;
export const LEGACY_SWEEP_REGISTRY = 'all';
declare const tenantIdBrand: unique symbol;
export type TenantId = string & {
    readonly [tenantIdBrand]: true;
};
const tenantPattern = /^org_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class TenantRoutingError extends Error {
    constructor(public readonly code: 'tenant-not-found' | 'route-unavailable' | 'route-mismatch') {
        super(code);
    }
}
export function tenantId(value: unknown): TenantId {
    if (typeof value !== 'string' || (value !== LEGACY_TENANT_ID && !tenantPattern.test(value))) {
        throw new TenantRoutingError('tenant-not-found');
    }
    return value as TenantId;
}
export function legacyTenantId(): TenantId { return tenantId(LEGACY_TENANT_ID); }
export interface TenantRoute {
    readonly tenantId: TenantId;
    readonly provider: 'd1' | 'postgres';
    readonly databaseId: string;
    readonly workerGroup: string;
    readonly binding: string;
    readonly routingEpoch: number;
    readonly schemaVersion: number;
    readonly status: 'pending' | 'active' | 'draining' | 'disabled';
}
export interface ShardMetadata {
    readonly tenantId: TenantId;
    readonly routingEpoch: number;
    readonly schemaVersion: number;
    readonly readEnabled: boolean;
    readonly writeEnabled: boolean;
}
export interface D1RecordBinding {
    readonly databaseId: string;
    readonly schemaVersion: number;
    readonly db: D1Database;
    readonly readMetadata: () => Promise<ShardMetadata>;
}
export interface RecordContext {
    readonly tenantId: TenantId;
    readonly routingEpoch: number;
    readonly schemaVersion: number;
    readonly db: D1Database;
}
const positiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0;
export function assertShardRoute(route: TenantRoute, shard: ShardMetadata, access: 'read' | 'write'): void {
    tenantId(route.tenantId);
    if (route.status !== 'active' || !positiveInteger(route.routingEpoch) || !positiveInteger(route.schemaVersion)) {
        throw new TenantRoutingError('route-unavailable');
    }
    if (shard.tenantId !== route.tenantId || shard.routingEpoch !== route.routingEpoch ||
        shard.schemaVersion !== route.schemaVersion) {
        throw new TenantRoutingError('route-mismatch');
    }
    if (shard.readEnabled !== true || (access === 'write' && shard.writeEnabled !== true)) {
        throw new TenantRoutingError('route-unavailable');
    }
}
export async function resolveD1RecordContext(selectedTenant: TenantId, directory: (id: TenantId) => Promise<TenantRoute | null>, workerGroup: string, bindings: ReadonlyMap<string, D1RecordBinding>, access: 'read' | 'write'): Promise<RecordContext> {
    tenantId(selectedTenant);
    const found = await directory(selectedTenant);
    if (!found)
        throw new TenantRoutingError('tenant-not-found');
    const route = { ...found };
    if (route.tenantId !== selectedTenant)
        throw new TenantRoutingError('route-mismatch');
    if (route.provider !== 'd1' || route.status !== 'active' || !workerGroup || route.workerGroup !== workerGroup ||
        !route.databaseId || !positiveInteger(route.routingEpoch) || !positiveInteger(route.schemaVersion)) {
        throw new TenantRoutingError('route-unavailable');
    }
    const binding = bindings.get(route.binding);
    if (!binding || binding.databaseId !== route.databaseId || binding.schemaVersion !== route.schemaVersion) {
        throw new TenantRoutingError('route-unavailable');
    }
    const { db, readMetadata } = binding;
    assertShardRoute(route, await readMetadata(), access);
    return Object.freeze({ tenantId: selectedTenant, routingEpoch: route.routingEpoch,
        schemaVersion: route.schemaVersion, db });
}
