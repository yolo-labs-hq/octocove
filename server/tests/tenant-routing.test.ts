import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index';
import { armWebhookDelivery } from '../src/webhooks';
import { armRemoteSweep } from '../src/remote-sweep';
import { LEGACY_SWEEP_REGISTRY, LEGACY_TENANT_ID, LEGACY_WEBHOOK_DISPATCHER, assertShardRoute, legacyTenantId, resolveD1RecordContext, tenantId, type ShardMetadata, type TenantRoute, } from '../src/tenant-routing';
const first = tenantId('org_12345678-1234-4234-8234-123456789abc');
const second = tenantId('org_87654321-4321-4321-b321-cba987654321');
function fixture() {
    const db = {} as D1Database;
    const route: TenantRoute = { tenantId: first, provider: 'd1', databaseId: 'physical-1',
        workerGroup: 'group-1', binding: 'RECORD_1', routingEpoch: 7, schemaVersion: 51, status: 'active' };
    const shard: ShardMetadata = { tenantId: first, routingEpoch: 7, schemaVersion: 51,
        readEnabled: true, writeEnabled: true };
    const readMetadata = vi.fn(async () => shard);
    const directory = vi.fn(async (): Promise<TenantRoute | null> => route);
    const bindings = new Map([['RECORD_1', { databaseId: 'physical-1', schemaVersion: 51, db, readMetadata }]]);
    const resolve = () => resolveD1RecordContext(first, directory, 'group-1', bindings, 'write');
    return { db, route, shard, readMetadata, directory, bindings, resolve };
}
describe('tenant identity and legacy compatibility', () => {
    it('keeps planned org creation and tenant selectors unmounted', () => {
        const routes = createApp().routes.filter(route => route.method !== 'ALL');
        expect(routes.some(route => /^\/(v1\/)?orgs(?:\/|$)/.test(route.path))).toBe(false);
        expect(routes.some(route => route.method === 'GET' && route.path === '/me')).toBe(true);
    });
    it('retains the exact org #1 cursor identity and singleton names', () => {
        expect(legacyTenantId()).toBe('octocove');
        expect(LEGACY_TENANT_ID).toBe('octocove');
        expect(LEGACY_WEBHOOK_DISPATCHER).toBe('octocove');
        expect(LEGACY_SWEEP_REGISTRY).toBe('all');
        expect(tenantId(first)).toBe(first);
        expect(tenantId(second)).toBe(second);
    });
    it('wakes the existing singleton objects rather than creating new coordinators', async () => {
        const id = {};
        const fetch = vi.fn(async () => new Response(null, { status: 200 }));
        const namespace = { idFromName: vi.fn(() => id), get: vi.fn(() => ({ fetch })) };
        await armWebhookDelivery({ WEBHOOK_DISPATCHER: namespace } as any);
        expect(namespace.idFromName).toHaveBeenLastCalledWith('octocove');
        expect(namespace.get).toHaveBeenLastCalledWith(id);
        await armRemoteSweep({ REMOTE_SWEEPER: namespace } as any);
        expect(namespace.idFromName).toHaveBeenLastCalledWith('all');
        expect(namespace.get).toHaveBeenLastCalledWith(id);
        expect(fetch).toHaveBeenCalledTimes(2);
    });
    it.each([undefined, null, '', 'Octocove', ' octocove', 'octocove\n', 'DB', {}, 1,
        'org_12345678-1234-1234-8234-123456789abc', 'org_12345678-1234-4234-7234-123456789abc',
        first.replace('abc', 'ABC'), `${first}\n`])('rejects invalid explicit tenant %j', value => {
        expect(() => tenantId(value)).toThrow('tenant-not-found');
    });
});
describe('private record resolution', () => {
    it('selects the verified allowlisted store without changing the environment', async () => {
        const f = fixture();
        const context = await f.resolve();
        expect(context).toEqual({ tenantId: first, routingEpoch: 7, schemaVersion: 51, db: f.db });
        expect(Object.isFrozen(context)).toBe(true);
        expect(f.directory).toHaveBeenCalledWith(first);
        expect(f.readMetadata).toHaveBeenCalledOnce();
    });
    it('keeps two tenants on distinct stores', async () => {
        const f = fixture();
        const secondDb = {} as D1Database;
        const otherRoute: TenantRoute = { ...f.route, tenantId: second, databaseId: 'physical-2', binding: 'RECORD_2' };
        f.bindings.set('RECORD_2', { databaseId: 'physical-2', schemaVersion: 51, db: secondDb,
            readMetadata: vi.fn(async () => ({ ...f.shard, tenantId: second })) });
        const lookup = async (id: string) => id === first ? f.route : otherRoute;
        const a = await resolveD1RecordContext(first, lookup, 'group-1', f.bindings, 'read');
        const b = await resolveD1RecordContext(second, lookup, 'group-1', f.bindings, 'read');
        expect(a.db).not.toBe(b.db);
        expect(b.tenantId).toBe(second);
    });
    it('never falls back to org #1 when a directory route is absent or unavailable', async () => {
        const f = fixture();
        f.directory.mockResolvedValueOnce(null);
        await expect(f.resolve()).rejects.toThrow('tenant-not-found');
        f.directory.mockRejectedValueOnce(new Error('directory-offline'));
        await expect(f.resolve()).rejects.toThrow('directory-offline');
        expect(f.readMetadata).not.toHaveBeenCalled();
    });
    it('refuses invalid explicit identity before reading the directory', async () => {
        const f = fixture();
        await expect(resolveD1RecordContext(undefined as any, f.directory, 'group-1', f.bindings, 'read'))
            .rejects.toThrow('tenant-not-found');
        expect(f.directory).not.toHaveBeenCalled();
    });
    it.each<Partial<TenantRoute>>([
        { tenantId: second }, { provider: 'postgres' }, { workerGroup: 'group-2' },
        { databaseId: 'physical-2' }, { binding: 'DB' }, { binding: '__proto__' },
        { status: 'pending' }, { status: 'draining' }, { status: 'disabled' },
        { routingEpoch: 0 }, { routingEpoch: NaN }, { routingEpoch: 1.5 },
        { routingEpoch: Number.MAX_SAFE_INTEGER + 1 }, { schemaVersion: 52 },
    ])('refuses directory/manifest mismatch %j before shard access', async (patch) => {
        const f = fixture();
        f.directory.mockResolvedValue({ ...f.route, ...patch });
        await expect(f.resolve()).rejects.toThrow(/route-(mismatch|unavailable)/);
        expect(f.readMetadata).not.toHaveBeenCalled();
    });
    it.each<Partial<ShardMetadata>>([
        { tenantId: second }, { routingEpoch: 6 }, { routingEpoch: 8 },
        { schemaVersion: 50 }, { readEnabled: false }, { writeEnabled: false },
    ])('refuses mismatched or fenced shard %j', async (patch) => {
        const f = fixture();
        f.readMetadata.mockResolvedValue({ ...f.shard, ...patch });
        await expect(f.resolve()).rejects.toThrow(/route-(mismatch|unavailable)/);
    });
    it('allows read-only admission while refusing writes and propagates shard outages', async () => {
        const f = fixture();
        const shard = { ...f.shard, writeEnabled: false };
        expect(() => assertShardRoute(f.route, shard, 'read')).not.toThrow();
        expect(() => assertShardRoute(f.route, shard, 'write')).toThrow('route-unavailable');
        f.readMetadata.mockRejectedValue(new Error('shard-offline'));
        await expect(f.resolve()).rejects.toThrow('shard-offline');
    });
    it('snapshots the route before metadata I/O and detects a subsequently fenced shard', async () => {
        const f = fixture();
        f.readMetadata.mockImplementation(async () => {
            Object.assign(f.route, { tenantId: second, routingEpoch: 8 });
            return f.shard;
        });
        const context = await f.resolve();
        expect(context.tenantId).toBe(first);
        expect(context.routingEpoch).toBe(7);
        expect(() => assertShardRoute({ ...f.route, ...context }, { ...f.shard, routingEpoch: 8 }, 'write'))
            .toThrow('route-mismatch');
    });
});
