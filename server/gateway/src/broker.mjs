import { ownedRef } from './protocol.mjs';
export const digest = async (token) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map(b => b.toString(16).padStart(2, '0')).join('');
const random = () => [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
export class AttemptBroker {
    constructor({ store, authority, now = () => Date.now(), audit = async () => { } }) {
        this.store = store;
        this.authority = authority;
        this.now = now;
        this.audit = audit;
    }
    async mint(authenticatedPrincipal, request) {
        const grant = await this.authority.resolve(authenticatedPrincipal, request);
        const ttl = request.ttl ?? 60;
        if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 900 ||
            !this.valid(grant) || (grant.scope === 'write' && !ownedRef(grant.lane)))
            throw new Error('grant-denied');
        const token = `ocg_${random()}`, id = random(), now = this.now();
        const lease = { id, grantId: grant.id, principal: authenticatedPrincipal,
            tenant: grant.tenant, project: grant.project, attempt: grant.attempt,
            repo: grant.repo, lane: grant.lane, scope: grant.scope, policyVersion: grant.policyVersion,
            expiresAt: Math.min(now + ttl * 1000, grant.expiresAt), revoked: false };
        if (lease.expiresAt - now < 60000)
            throw new Error('grant-expiring');
        await this.store.put(await digest(token), lease);
        try {
            const current = await this.authority.current(lease);
            if (!this.matches(lease, current))
                throw new Error('grant-changed');
            await this.audit({ type: 'gateway-lease-issued', id, grantId: lease.grantId, attempt: lease.attempt, expiresAt: lease.expiresAt });
        }
        catch (error) {
            await this.store.delete(await digest(token));
            throw error;
        }
        return { id, token, expiresAt: lease.expiresAt, repo: lease.repo, scope: lease.scope };
    }
    valid(g) {
        return !!g && g.active === true && !g.revoked && Number.isFinite(g.expiresAt) && g.expiresAt > this.now() &&
            !!g.id && !!g.attempt && !!g.repo && !!g.policyVersion && ['read', 'write'].includes(g.scope);
    }
    matches(l, g) {
        return this.valid(g) && l.grantId === g.id && l.attempt === g.attempt && l.repo === g.repo &&
            l.lane === g.lane && l.scope === g.scope && l.policyVersion === g.policyVersion &&
            l.tenant === g.tenant && l.project === g.project;
    }
    async authorize({ authorization, repo, operation }, admission = false) {
        if (!/^Bearer ocg_[A-Za-z0-9_-]{32,128}$/.test(authorization))
            throw new Error('lease-denied');
        const lease = await this.store.get(await digest(authorization.slice(7)));
        if (!lease || lease.revoked || lease.expiresAt <= this.now() || lease.repo !== repo ||
            !['read', 'write'].includes(operation) || (operation === 'write' && lease.scope !== 'write'))
            throw new Error('lease-denied');
        const grant = await this.authority.current(lease);
        if (!this.matches(lease, grant))
            throw new Error('grant-denied');
        const result = { ...lease, active: true, expiresAt: Math.min(lease.expiresAt, grant.expiresAt) };
        if (admission) {
            const upstream = await this.authority.upstream(grant, operation);
            const current = await this.authority.current(lease);
            const latest = await this.store.get(await digest(authorization.slice(7)));
            if (!latest || latest.revoked || lease.expiresAt <= this.now() || !this.matches(lease, current))
                throw new Error('grant-denied');
            await this.audit({ type: 'gateway-admitted', id: lease.id, attempt: lease.attempt, repo, operation });
            return { ...result, expiresAt: Math.min(lease.expiresAt, current.expiresAt), ...upstream };
        }
        return result;
    }
    async revoke(authenticatedPrincipal, token) {
        const key = await digest(token), lease = await this.store.get(key);
        if (!lease || lease.principal !== authenticatedPrincipal)
            throw new Error('lease-denied');
        if (!lease.revoked) {
            await this.store.put(key, { ...lease, revoked: true });
            await this.audit({ type: 'gateway-lease-revoked', id: lease.id, attempt: lease.attempt });
        }
    }
}
