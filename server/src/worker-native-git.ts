import { AuthError } from './auth';
const encoder = new TextEncoder(), decoder = new TextDecoder();
export const ZERO_OID = '0'.repeat(40);
export function packet(text: string) {
    const bytes = encoder.encode(text), prefix = encoder.encode((bytes.length + 4).toString(16).padStart(4, '0'));
    const out = new Uint8Array(bytes.length + 4);
    out.set(prefix);
    out.set(bytes, 4);
    return out;
}
function concat(...arrays: Uint8Array[]) {
    const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
    let at = 0;
    for (const a of arrays) {
        out.set(a, at);
        at += a.length;
    }
    return out;
}
const digest = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
export async function emptyPack() {
    const header = new Uint8Array([80, 65, 67, 75, 0, 0, 0, 2, 0, 0, 0, 0]);
    return concat(header, await digest(header));
}
export async function blobPack(text: string) {
    const content = encoder.encode(text), objectHeader: number[] = [];
    let size = content.length;
    objectHeader.push((3 << 4) | (size & 15) | (size > 15 ? 128 : 0));
    size = Math.floor(size / 16);
    while (size) {
        objectHeader.push((size & 127) | (size > 127 ? 128 : 0));
        size = Math.floor(size / 128);
    }
    const compressed = new Uint8Array(await new Response(new Blob([content]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    const pack = concat(new Uint8Array([80, 65, 67, 75, 0, 0, 0, 2, 0, 0, 0, 1]), new Uint8Array(objectHeader), compressed);
    return concat(pack, await digest(pack));
}
export function receivePack(oldSha: string, newSha: string, ref: string, pack: Uint8Array) {
    if (!/^[a-f0-9]{40}$/.test(oldSha) || !/^[a-f0-9]{40}$/.test(newSha) || !/^refs\/[!-~]+$/.test(ref) || /[\0\r\n ]/.test(ref))
        throw new AuthError('invalid-native-target', 403);
    return concat(packet(`${oldSha} ${newSha} ${ref}\0report-status\n`), encoder.encode('0000'), pack);
}
export async function gitResponse(response: Response, max = 1024 * 1024) {
    if (!response.body)
        throw new AuthError('native-git-unavailable', 503);
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0, timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AuthError('native-git-unavailable', 503)), 10000); });
    try {
        for (;;) {
            const next = await Promise.race([reader.read(), deadline]);
            if (next.done)
                break;
            size += next.value.length;
            if (size > max)
                throw new AuthError('native-git-unavailable', 503);
            chunks.push(next.value);
        }
        return concat(...chunks);
    }
    finally {
        clearTimeout(timer!);
        void reader.cancel().catch(() => { });
    }
}
function packets(bytes: Uint8Array) {
    const lines: string[] = [];
    let at = 0, flushed = false;
    while (at < bytes.length) {
        const prefix = decoder.decode(bytes.subarray(at, at + 4));
        if (!/^[0-9a-f]{4}$/i.test(prefix))
            throw new AuthError('native-git-unavailable', 503);
        const length = parseInt(prefix, 16);
        if (!length) {
            at += 4;
            flushed = true;
            continue;
        }
        if (length < 4 || at + length > bytes.length)
            throw new AuthError('native-git-unavailable', 503);
        lines.push(decoder.decode(bytes.subarray(at + 4, at + length)).replace(/\n$/, ''));
        at += length;
    }
    if (!flushed)
        throw new AuthError('native-git-unavailable', 503);
    return lines;
}
export function advertisedHead(bytes: Uint8Array, ref: string) {
    const lines = packets(bytes);
    if (lines[0] !== '# service=git-upload-pack')
        throw new AuthError('native-git-unavailable', 503);
    const matches = lines.slice(1).map(line => /^([a-f0-9]{40}) ([^\0]+)(?:\0.*)?$/.exec(line)).filter(m => m?.[2] === ref);
    if (matches.length > 1)
        throw new AuthError('native-git-unavailable', 503);
    return matches[0]?.[1] ?? null;
}
export function receiveReport(bytes: Uint8Array, ref: string): 'ok' | 'rejected' | 'ambiguous' {
    try {
        const lines = packets(bytes), reports = lines.filter(line => line.startsWith('ok ') || line.startsWith('ng '));
        if (lines[0] === 'unpack ok' && reports.length === 1 && reports[0] === `ok ${ref}`)
            return 'ok';
        if (lines[0]?.startsWith('unpack ') && reports.length === 1 && reports[0]?.startsWith(`ng ${ref} `))
            return 'rejected';
    }
    catch { }
    return 'ambiguous';
}
export function nativeRemote(value: string) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port ||
        !/^[a-z0-9]{32}\.artifacts\.cloudflare\.net$/.test(url.hostname) || !/^\/git\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git$/.test(url.pathname))
        throw new AuthError('broker-grant-denied', 403);
    return url.href.replace(/\/$/, '');
}
export async function readHead(remote: string, ref: string, token: string) {
    const response = await fetch(`${remote}/info/refs?service=git-upload-pack`, { redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/x-git-upload-pack-advertisement' } });
    if (!response.ok || !(response.headers.get('Content-Type') ?? '').startsWith('application/x-git-upload-pack-advertisement')) {
        void response.body?.cancel().catch(() => { });
        throw new AuthError('native-git-unavailable', 503);
    }
    return advertisedHead(await gitResponse(response), ref);
}
