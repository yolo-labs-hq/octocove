const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export const LIMITS = Object.freeze({ body: 8 * 1024 * 1024, commands: 64 * 1024, refs: 128, ms: 15000 });
export class PolicyError extends Error {
    constructor(reason, commands = [], capabilities = []) {
        super(reason);
        this.commands = commands;
        this.capabilities = capabilities;
    }
}
export function validRef(ref) {
    return typeof ref === 'string' && ref.length <= 512 && /^refs\/[\x21-\x7e]+$/.test(ref) &&
        !/[ ~^:?*\[\\%]/.test(ref) && !ref.includes('..') && !ref.includes('@{') &&
        !ref.endsWith('.') && ref.split('/').every(p => p && !p.startsWith('.') && !p.endsWith('.lock'));
}
export function ownedRef(lane) {
    const ref = `refs/heads/lane/${lane}`;
    return typeof lane === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(lane) && validRef(ref) ? ref : null;
}
export function pkt(value) {
    const payload = typeof value === 'string' ? encoder.encode(value) : value;
    if (payload.length > 65516)
        throw new Error('pkt-too-large');
    const result = new Uint8Array(payload.length + 4);
    result.set(encoder.encode(result.length.toString(16).padStart(4, '0')));
    result.set(payload, 4);
    return result;
}
export function concat(parts) {
    const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}
const allowedCaps = new Set(['report-status', 'report-status-v2', 'side-band-64k', 'delete-refs', 'ofs-delta', 'atomic', 'quiet', 'object-format=sha1']);
export function parsePush(body) {
    const commands = [], capabilities = [];
    let offset = 0, flushed = false;
    const fail = reason => { throw new PolicyError(reason, commands, capabilities); };
    if (body.length > LIMITS.body)
        fail('body-too-large');
    while (offset < body.length) {
        if (offset + 4 > body.length)
            fail('truncated-length');
        const lengthText = String.fromCharCode(...body.subarray(offset, offset + 4));
        if (!/^[0-9a-fA-F]{4}$/.test(lengthText))
            fail('malformed-length');
        const size = Number.parseInt(lengthText, 16);
        if (size === 0) {
            offset += 4;
            flushed = true;
            break;
        }
        if (size < 5 || size > 65520)
            fail('invalid-length');
        if (offset + size > LIMITS.commands)
            fail('commands-too-large');
        if (offset + size > body.length)
            fail('truncated-packet');
        let line;
        try {
            line = decoder.decode(body.subarray(offset + 4, offset + size));
        }
        catch {
            fail('invalid-encoding');
        }
        offset += size;
        if (line.endsWith('\n'))
            line = line.slice(0, -1);
        const nul = line.indexOf('\0');
        if (nul !== -1) {
            if (commands.length || line.indexOf('\0', nul + 1) !== -1)
                fail('misplaced-capabilities');
            const caps = line.slice(nul + 1).replace(/^ /, '').split(' ');
            capabilities.push(...caps.filter(c => allowedCaps.has(c)));
            if (!caps.length || caps.some(c => !c || (!allowedCaps.has(c) && !/^agent=[!-~]{1,128}$/.test(c))))
                fail('unsupported-capability');
            if (new Set(caps).size !== caps.length)
                fail('duplicate-capability');
            for (const cap of caps)
                if (!capabilities.includes(cap))
                    capabilities.push(cap);
            line = line.slice(0, nul);
        }
        const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(line);
        if (!match || !validRef(match[3]))
            fail('invalid-command');
        const [, old, next, ref] = match;
        if (/^0+$/.test(old) && /^0+$/.test(next))
            fail('empty-update');
        if (commands.some(c => c.ref === ref))
            fail('duplicate-ref');
        commands.push({ old, next, ref, delete: /^0+$/.test(next) });
        if (commands.length > LIMITS.refs)
            fail('too-many-refs');
    }
    if (!flushed || !commands.length)
        fail('missing-command-flush');
    const pack = body.subarray(offset);
    if (commands.every(c => c.delete)) {
        if (pack.length)
            fail('delete-with-pack');
    }
    else if (pack.length < 32 || String.fromCharCode(...pack.subarray(0, 4)) !== 'PACK' ||
        new DataView(pack.buffer, pack.byteOffset, pack.byteLength).getUint32(4) < 2 ||
        new DataView(pack.buffer, pack.byteOffset, pack.byteLength).getUint32(4) > 3)
        fail('invalid-pack-envelope');
    return { commands, capabilities };
}
export function enforce(push, grant) {
    const ref = ownedRef(grant.lane);
    if (grant.scope !== 'write' || !ref || push.commands.some(c => c.ref !== ref))
        throw new PolicyError('ref-not-owned', push.commands, push.capabilities);
}
export function rejection(error) {
    const reason = error instanceof PolicyError ? error.message : 'gateway-unavailable';
    const parts = [pkt(`unpack ${reason}\n`), ...((error.commands ?? []).map(c => pkt(`ng ${c.ref} ${reason}\n`))), encoder.encode('0000')];
    const report = concat(parts);
    if (!(error.capabilities ?? []).includes('side-band-64k'))
        return report;
    const sideband = [];
    for (let offset = 0; offset < report.length; offset += 65515)
        sideband.push(pkt(concat([new Uint8Array([1]), report.subarray(offset, offset + 65515)])));
    return concat([...sideband, encoder.encode('0000')]);
}
export async function boundedBody(request) {
    const encoding = request.headers.get('content-encoding') ?? 'identity';
    if (!['identity', 'gzip'].includes(encoding))
        throw new PolicyError('unsupported-encoding');
    const length = request.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > LIMITS.body))
        throw new PolicyError('body-too-large');
    if (!request.body)
        throw new PolicyError('empty-body');
    let encoded = 0;
    const bounded = request.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
            encoded += chunk.byteLength;
            if (encoded > LIMITS.body)
                throw new PolicyError('body-too-large');
            controller.enqueue(chunk);
        },
    }));
    const stream = encoding === 'gzip' ? bounded.pipeThrough(new DecompressionStream('gzip')) : bounded;
    const reader = stream.getReader();
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new PolicyError('body-timeout'));
            void reader.cancel().catch(() => { });
        }, LIMITS.ms);
    });
    try {
        const read = async () => {
            const parts = [];
            let decoded = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                decoded += value.byteLength;
                if (decoded > LIMITS.body) {
                    void reader.cancel().catch(() => { });
                    throw new PolicyError('body-too-large');
                }
                parts.push(value);
            }
            return concat(parts);
        };
        return await Promise.race([read(), timeout]);
    }
    catch (error) {
        if (error instanceof PolicyError)
            throw error;
        throw new PolicyError('invalid-body');
    }
    finally {
        clearTimeout(timer);
    }
}
export class AuthorityDenied extends Error {
}
export const REASONS = new Set(['grant-denied', 'lease-denied', 'channel-required', 'channel-denied', 'proof-required',
    'proof-unknown', 'proof-replayed', 'proof-expired', 'proof-mismatch', 'proof-invalid', 'proof-request-invalid',
    'reconcile-required', 'ref-not-owned', 'grant-expiring', 'proof-key-unavailable']);
function pktPayloads(bytes) {
    const out = [];
    let offset = 0;
    while (offset + 4 <= bytes.length) {
        const size = Number.parseInt(String.fromCharCode(...bytes.subarray(offset, offset + 4)), 16);
        if (!Number.isInteger(size) || (size > 0 && size < 4) || offset + Math.max(size, 4) > bytes.length)
            return null;
        if (size === 0) {
            offset += 4;
            continue;
        }
        out.push(bytes.subarray(offset + 4, offset + size));
        offset += size;
    }
    return offset === bytes.length ? out : null;
}
export function reportOutcome(bytes, sideband) {
    let payloads = pktPayloads(bytes);
    if (payloads && sideband) {
        if (payloads.some(p => ![1, 2, 3].includes(p[0])))
            return null;
        payloads = pktPayloads(concat(payloads.filter(p => p[0] === 1).map(p => p.subarray(1))));
    }
    if (!payloads)
        return null;
    let lines;
    try {
        lines = payloads.map(p => decoder.decode(p).replace(/\n$/, ''));
    }
    catch {
        return null;
    }
    if (!lines[0]?.startsWith('unpack '))
        return null;
    if (lines[0] !== 'unpack ok')
        return 'rejected';
    const statuses = lines.filter(l => /^(ok|ng) /.test(l));
    if (!statuses.length)
        return null;
    return statuses.some(l => l.startsWith('ok ')) ? 'written' : 'rejected';
}
