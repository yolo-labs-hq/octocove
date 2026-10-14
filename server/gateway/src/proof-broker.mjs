import { AttemptBroker, digest } from './broker.mjs';
import { AuthorityDenied, ownedRef } from './protocol.mjs';
import { CHANNEL_PROOF_TTL_MS, channelTag, formatProof, nonceId, randomHex } from './proof.mjs';
export class ProofDenied extends AuthorityDenied {
}
const SHA = /^[0-9a-f]{40}$/, ZERO = '0'.repeat(40);
const snapshot = (l, expiresAt = l.expiresAt) => ({ id: l.id, attempt: l.attempt, tenant: l.tenant, project: l.project,
    repo: l.repo, lane: l.lane, scope: l.scope, policyVersion: l.policyVersion, expiresAt, active: true, revoked: false });
const normalize = commands => {
    if (!Array.isArray(commands) || commands.length < 1 || commands.length > 128)
        return null;
    const out = commands.map(c => ({ old: c?.old, next: c?.next ?? c?.new, ref: c?.ref }));
    return out.every(c => SHA.test(c.old) && SHA.test(c.next) && typeof c.ref === 'string' && !(c.old === ZERO && c.next === ZERO)) ? out : null;
};
const sameCommands = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const refFence = (repo, ref) => `ref-fence:${JSON.stringify([repo, ref])}`;
const unfence = async (t, rec, nonce) => {
    await t.delete(`fence:${rec.attempt}`);
    const key = refFence(rec.repo, rec.commands[0].ref);
    if ((await t.get(key)) === nonce)
        await t.delete(key);
};
export const UPSTREAM_WRITE_DEADLINE_MS = 30000;
const PROVIDER_OUTCOMES = ['written', 'rejected'];
const text = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 512;
export class ProofBroker extends AttemptBroker {
    constructor({ keyring, audience, proofTtlMs = CHANNEL_PROOF_TTL_MS, retainMs = 600000, ...rest }) {
        super(rest);
        if (typeof this.store?.transaction !== 'function' || !keyring || typeof audience !== 'string' || !audience ||
            !(proofTtlMs > 0 && proofTtlMs <= CHANNEL_PROOF_TTL_MS))
            throw new Error('proof-broker-misconfigured');
        Object.assign(this, { keyring, audience, proofTtlMs, retainMs });
        const sink = this.audit;
        this.audit = event => sink({ at: this.now(), ...event });
    }
    async #deny(stage, reason, ids = {}) {
        await this.audit({ type: 'proof-refused', stage, reason, ...ids });
        throw new ProofDenied(reason);
    }
    async #seq(t) { const seq = ((await t.get('seq')) ?? 0) + 1; await t.put('seq', seq); return seq; }
    #leaseLive(lease) { return !!lease && !lease.revoked && lease.expiresAt > this.now(); }
    async #channelOk(t, ctag, lease) {
        const rec = await t.get(`channel:${ctag}`);
        return !!rec && rec.open === true && rec.leaseId === lease.id && rec.attempt === lease.attempt;
    }
    async #lease(stage, input, operation) {
        try {
            return await super.authorize({ ...input, operation });
        }
        catch (error) {
            return this.#deny(stage, error.message === 'lease-denied' ? 'lease-denied' : 'grant-denied');
        }
    }
    async openChannel(principal, token, channel) {
        if (typeof channel !== 'string' || !channel)
            throw new ProofDenied('channel-required');
        const key = await digest(token), ctag = await channelTag(channel);
        return this.store.transaction(async (t) => {
            const lease = await t.get(key);
            if (!this.#leaseLive(lease) || lease.principal !== principal)
                return this.#deny('channel', 'lease-denied', { channel: ctag });
            const existing = await t.get(`channel:${ctag}`);
            if (existing?.open && existing.attempt !== lease.attempt)
                return this.#deny('channel', 'channel-bound-elsewhere', { channel: ctag, attempt: lease.attempt });
            await t.put(`channel:${ctag}`, { leaseId: lease.id, attempt: lease.attempt, principal, open: true, at: this.now() });
            await this.audit({ type: 'channel-opened', channel: ctag, lease: lease.id, attempt: lease.attempt, seq: await this.#seq(t) });
            return { channel: ctag };
        });
    }
    async closeChannel(principal, channel) {
        const ctag = await channelTag(channel);
        return this.store.transaction(async (t) => {
            const rec = await t.get(`channel:${ctag}`);
            if (!rec || rec.principal !== principal)
                return this.#deny('channel', 'channel-denied', { channel: ctag });
            if (rec.open) {
                await t.put(`channel:${ctag}`, { ...rec, open: false, closedAt: this.now() });
                await this.audit({ type: 'channel-closed', channel: ctag, lease: rec.leaseId, attempt: rec.attempt, seq: await this.#seq(t) });
            }
        });
    }
    async authorizeChannel(input) {
        if (!input.channel)
            return this.#deny('authorize', 'channel-required');
        const lease = await this.#lease('authorize', input, input.operation), ctag = await channelTag(input.channel);
        if (!(await this.store.transaction(t => this.#channelOk(t, ctag, lease))))
            return this.#deny('authorize', 'channel-denied', { channel: ctag, lease: lease.id, attempt: lease.attempt });
        return snapshot(lease);
    }
    async issueProof(input) {
        if (!input?.channel)
            return this.#deny('issue', 'channel-required');
        const commands = normalize(input.commands), ctag = await channelTag(input.channel);
        if (!commands || !/^[0-9a-f]{64}$/.test(input.bodyDigest ?? ''))
            return this.#deny('issue', 'proof-request-invalid', { channel: ctag });
        const grant = await this.#lease('issue', input, 'write'), ref = ownedRef(grant.lane);
        const ids = { channel: ctag, lease: grant.id, attempt: grant.attempt };
        if (!ref || commands.length !== 1 || commands[0].ref !== ref)
            return this.#deny('issue', 'ref-not-owned', ids);
        const key = await digest(input.authorization.slice(7));
        return this.store.transaction(async (t) => {
            const lease = await t.get(key), now = this.now();
            if (!this.#leaseLive(lease))
                return this.#deny('issue', 'grant-denied', ids);
            if (!(await this.#channelOk(t, ctag, lease)))
                return this.#deny('issue', 'channel-denied', ids);
            if ((await t.get(`fence:${lease.attempt}`))?.length || await t.get(refFence(lease.repo, ref)))
                return this.#deny('issue', 'reconcile-required', ids);
            const expiresAt = Math.min(now + this.proofTtlMs, lease.expiresAt, grant.expiresAt);
            if (expiresAt <= now)
                return this.#deny('issue', 'grant-expiring', ids);
            const nonce = randomHex(32), nid = await nonceId(nonce);
            let signed;
            try {
                signed = await this.keyring.sign({ audience: this.audience, tenant: lease.tenant, project: lease.project, leaseId: lease.id,
                    attempt: lease.attempt, repo: lease.repo, commands, bodyDigest: input.bodyDigest, channel: input.channel, nonce, expiresAt });
            }
            catch {
                return this.#deny('issue', 'proof-key-unavailable', ids);
            }
            for (const k of await t.list('nonce:')) {
                const old = await t.get(k);
                if (old.expiresAt + this.retainMs < now && !['admitted', 'ambiguous'].includes(old.state))
                    await t.delete(k);
            }
            const seq = await this.#seq(t);
            await t.put(`nonce:${nid}`, { state: 'issued', leaseId: lease.id, attempt: lease.attempt, repo: lease.repo, channel: ctag,
                kid: signed.kid, bodyDigest: input.bodyDigest, commands, expiresAt, issuedAt: now, seq });
            await this.audit({ type: 'proof-issued', nonce: nid, kid: signed.kid, bodyDigest: input.bodyDigest, ref, expiresAt, seq, ...ids });
            return { proof: formatProof({ kid: signed.kid, nonce, expiresAt, mac: signed.mac }), expiresAt, nonce: nid, kid: signed.kid };
        });
    }
    async admitProof(input) {
        if (!input?.channel)
            return this.#deny('admit', 'channel-required');
        const ctag = await channelTag(input.channel), grant = await this.#lease('admit', input, input.operation);
        const nid = input.mutating && input.proof?.nonce ? await nonceId(input.proof.nonce) : null;
        const ids = { channel: ctag, lease: grant.id, attempt: grant.attempt, ...(nid ? { nonce: nid } : {}) };
        if (input.mutating && (input.operation !== 'write' || !nid))
            return this.#deny('admit', 'proof-required', ids);
        const commands = input.mutating ? normalize(input.commands) : null;
        if (input.mutating && !commands)
            return this.#deny('admit', 'proof-mismatch', ids);
        const upstream = await this.authority.upstream(grant, input.operation, { mutating: !!input.mutating, nonce: nid });
        const key = await digest(input.authorization.slice(7));
        return this.store.transaction(async (t) => {
            const lease = await t.get(key), now = this.now();
            if (!this.#leaseLive(lease))
                return this.#deny('admit', 'grant-denied', ids);
            if (!(await this.#channelOk(t, ctag, lease)))
                return this.#deny('admit', 'channel-denied', ids);
            let rec;
            if (input.mutating) {
                rec = await t.get(`nonce:${nid}`);
                if (!rec)
                    return this.#deny('admit', 'proof-unknown', ids);
                if (rec.state !== 'issued')
                    return this.#deny('admit', 'proof-replayed', ids);
                if (rec.expiresAt <= now || rec.expiresAt !== input.proof.expiresAt)
                    return this.#deny('admit', 'proof-expired', ids);
                if (rec.leaseId !== lease.id || rec.channel !== ctag || rec.kid !== input.proof.kid || rec.repo !== input.repo ||
                    rec.bodyDigest !== input.bodyDigest || !sameCommands(rec.commands, commands))
                    return this.#deny('admit', 'proof-mismatch', ids);
                if ((await t.get(`fence:${lease.attempt}`))?.length || await t.get(refFence(rec.repo, commands[0].ref)))
                    return this.#deny('admit', 'reconcile-required', ids);
            }
            const current = await this.authority.current(lease);
            if (!this.matches(lease, current))
                return this.#deny('admit', 'grant-denied', ids);
            const seq = input.mutating ? await this.#seq(t) : null;
            if (input.mutating) {
                await t.put(`nonce:${nid}`, { ...rec, state: 'admitted', admittedAt: now, seq });
                await t.put(`fence:${lease.attempt}`, [nid]);
                await t.put(refFence(rec.repo, commands[0].ref), nid);
            }
            await this.audit({ type: input.mutating ? 'proof-admitted' : 'gateway-admitted', operation: input.operation, seq, ...ids });
            return { ...snapshot(lease, Math.min(lease.expiresAt, current.expiresAt)), ...(nid ? { nonce: nid, seq } : {}), ...upstream };
        });
    }
    async completeWrite({ nonce, outcome }) {
        if (!['written', 'rejected', 'ambiguous'].includes(outcome))
            throw new ProofDenied('outcome-invalid');
        return this.store.transaction(async (t) => {
            const rec = await t.get(`nonce:${nonce}`);
            if (!rec || rec.state !== 'admitted')
                return this.#deny('complete', 'proof-state', { nonce });
            const settled = outcome !== 'ambiguous';
            await t.put(`nonce:${nonce}`, { ...rec, state: settled ? 'settled' : 'ambiguous', outcome, settledAt: this.now() });
            if (settled)
                await unfence(t, rec, nonce);
            await this.audit({ type: 'proof-completed', nonce, attempt: rec.attempt, outcome, seq: await this.#seq(t) });
        });
    }
    async #settle(nonce, stage, state, outcome, event) {
        return this.store.transaction(async (t) => {
            const latest = await t.get(`nonce:${nonce}`);
            if (!['admitted', 'ambiguous'].includes(latest?.state))
                return this.#deny(stage, 'proof-state', { nonce });
            await t.put(`nonce:${nonce}`, { ...latest, state, outcome, settledAt: this.now() });
            await unfence(t, latest, nonce);
            await this.audit({ ...event, nonce, attempt: latest.attempt, outcome, seq: await this.#seq(t) });
            return outcome;
        });
    }
    async #held(nonce) {
        const rec = await this.store.get(`nonce:${nonce}`);
        if (!rec || !['admitted', 'ambiguous'].includes(rec.state))
            throw new ProofDenied('nothing-to-reconcile');
        return rec;
    }
    async #observedWritten(rec) {
        const [c] = rec.commands, tip = await this.authority.observe({ repo: rec.repo, ref: c.ref });
        return c.next === ZERO ? tip == null : tip === c.next;
    }
    async reconcile(nonce) {
        const rec = await this.#held(nonce);
        if (!(await this.#observedWritten(rec)))
            return this.#deny('reconcile', 'outcome-unresolved', { nonce, attempt: rec.attempt, state: rec.state });
        return this.#settle(nonce, 'reconcile', 'reconciled', 'written', { type: 'proof-reconciled' });
    }
    async providerOutcome({ nonce, outcome, source }) {
        if (!PROVIDER_OUTCOMES.includes(outcome) || !text(source))
            throw new ProofDenied('outcome-invalid');
        await this.#held(nonce);
        return this.#settle(nonce, 'provider', 'settled', outcome, { type: 'proof-provider-settled', source });
    }
    async release({ nonce, operator, reason }) {
        if (!text(operator) || !text(reason))
            throw new ProofDenied('release-invalid');
        const rec = await this.#held(nonce);
        if (await this.#observedWritten(rec))
            return this.#settle(nonce, 'release', 'reconciled', 'written', { type: 'proof-reconciled', operator });
        return this.#settle(nonce, 'release', 'released', 'operator-released', { type: 'proof-fence-released', operator, reason });
    }
    async fences() {
        return this.store.transaction(async (t) => {
            const out = [];
            for (const k of await t.list('fence:'))
                for (const nonce of (await t.get(k)) ?? []) {
                    const rec = await t.get(`nonce:${nonce}`);
                    out.push({ attempt: k.slice('fence:'.length), nonce, state: rec?.state ?? 'missing', admittedAt: rec?.admittedAt ?? null,
                        ambiguousAt: rec?.state === 'ambiguous' ? rec.settledAt : null });
                }
            return out;
        });
    }
    async revoke(principal, token) {
        const key = await digest(token);
        return this.store.transaction(async (t) => {
            const lease = await t.get(key);
            if (!lease || lease.principal !== principal)
                return this.#deny('revoke', 'lease-denied');
            const seq = await this.#seq(t);
            if (!lease.revoked)
                await t.put(key, { ...lease, revoked: true, revokedAt: this.now(), revokedSeq: seq });
            for (const k of await t.list('channel:')) {
                const rec = await t.get(k);
                if (rec.leaseId === lease.id && rec.open)
                    await t.put(k, { ...rec, open: false, closedAt: this.now() });
            }
            const inFlight = (await t.get(`fence:${lease.attempt}`)) ?? [];
            await this.audit({ type: 'gateway-lease-revoked', id: lease.id, attempt: lease.attempt, seq, inFlight: inFlight.length });
            return { seq, inFlight };
        });
    }
}
