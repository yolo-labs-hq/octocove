import { AuthError } from './auth';
export interface PinnedEgress {
    fetch: (url: string, init: RequestInit, address: string) => Promise<Response>;
    resolve: (host: string, signal?: AbortSignal) => Promise<string[]>;
}
type Connect = typeof import('cloudflare:sockets')['connect'];
const MAX_HEADER_BYTES = 32768;
const encoder = new TextEncoder();
const bad = (code = 'invalid-request', status = 400): never => { throw new AuthError(code, status); };
export function isPublicAddress(address: string): boolean {
    const v4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
        const [a, b, c] = v4.slice(1).map(Number) as [
            number,
            number,
            number
        ];
        if (v4.slice(1).some(part => Number(part) > 255 || String(Number(part)) !== part))
            return false;
        return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c <= 2) || (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19)) ||
            (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
    }
    const lower = address.toLowerCase().replace(/^\[|\]$/g, '');
    if (!lower.includes(':') || !/^[0-9a-f:]+$/.test(lower))
        return false;
    let canonical: string;
    try {
        canonical = new URL(`https://[${lower}]/`).hostname.slice(1, -1);
    }
    catch {
        return false;
    }
    const groups = canonical.split(':'), first = parseInt(groups[0]!, 16), second = parseInt(groups[1] || '0', 16);
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && first !== 0x3fff &&
        !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
}
export function validateDestination(value: unknown): URL {
    if (typeof value !== 'string' || value.length > 2048)
        return bad();
    let url: URL;
    try {
        url = new URL(value);
    }
    catch {
        return bad();
    }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port)
        return bad('invalid-destination');
    const literal = /^[\d.]+$/.test(host) || host.includes(':');
    if (literal ? !isPublicAddress(host)
        : !host.includes('.') || /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/.test(host))
        return bad('invalid-destination');
    return url;
}
export async function resolveOverHttps(host: string, signal?: AbortSignal): Promise<string[]> {
    const out: string[] = [];
    for (const [type, code] of [['A', 1], ['AAAA', 28]] as const) {
        const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { signal, headers: { accept: 'application/dns-json' } });
        if (!r.ok)
            throw new Error('dns-failure');
        for (const a of (await r.json() as any).Answer ?? [])
            if (a.type === code && typeof a.data === 'string')
                out.push(a.data);
    }
    return out;
}
export async function publicAddress(url: URL, deps: Pick<PinnedEgress, 'resolve'>, signal?: AbortSignal) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = /^[\d.]+$/.test(host) || host.includes(':') ? [host] : await deps.resolve(host, signal);
    if (!addresses.length || !addresses.every(isPublicAddress))
        throw new Error('destination-not-public');
    return addresses[0]!;
}
const join = (a: Uint8Array, b: Uint8Array) => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };
const headerEnd = (bytes: Uint8Array) => {
    for (let i = 0; i + 3 < bytes.length; i++)
        if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10)
            return i;
    return -1;
};
const latin1 = (bytes: Uint8Array) => { let s = ''; for (const b of bytes)
    s += String.fromCharCode(b); return s; };
export async function pinnedHttpsFetch(value: string, init: RequestInit, address: string, connectSocket?: Connect, limits: {
    maxBodyBytes?: number;
} = {}): Promise<Response> {
    const url = validateDestination(value);
    if (!isPublicAddress(address))
        throw new Error('destination-not-public');
    const connect = connectSocket ?? (await import('cloudflare:sockets')).connect;
    const signal = init.signal, method = (init.method ?? 'GET').toUpperCase();
    signal?.throwIfAborted();
    let socket = connect({ hostname: address.replace(/^\[|\]$/g, ''), port: 443 }, { secureTransport: 'starttls' as const, allowHalfOpen: false });
    socket.closed.catch(() => { });
    let rejectAbort: (error: unknown) => void = () => { };
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => { rejectAbort(signal?.reason ?? new Error('timeout')); void socket.close().catch(() => { }); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        socket = socket.startTls({ expectedServerHostname: url.hostname.replace(/^\[|\]$/g, '') });
        socket.closed.catch(() => { });
        return await Promise.race([aborted, (async () => {
                await socket.opened;
                const body = encoder.encode(String(init.body ?? ''));
                const headers = new Headers(init.headers);
                headers.set('Host', url.host);
                if (method !== 'GET' || body.length)
                    headers.set('Content-Length', String(body.length));
                headers.set('Connection', 'close');
                const head = `${method} ${url.pathname}${url.search} HTTP/1.1\r\n` +
                    [...headers].map(([name, value]) => `${name}: ${value}\r\n`).join('') + '\r\n';
                const writer = socket.writable.getWriter();
                await writer.write(encoder.encode(head));
                if (body.length || method !== 'GET')
                    await writer.write(body);
                const reader = socket.readable.getReader();
                let buffer = new Uint8Array(0), eof = false;
                const more = async () => {
                    if (eof)
                        return false;
                    const { value, done } = await reader.read();
                    if (done) {
                        eof = true;
                        return false;
                    }
                    buffer = join(buffer, value);
                    return true;
                };
                async function readBody(fields: Map<string, string[]>, max: number) {
                    const tooLarge = () => { throw new Error('response-body-too-large'); };
                    if ((fields.get('content-encoding') ?? []).some(v => v.toLowerCase() !== 'identity'))
                        throw new Error('invalid-http-response');
                    const coding = fields.get('transfer-encoding');
                    if (coding) {
                        if (coding.length !== 1 || coding[0]!.toLowerCase() !== 'chunked' || fields.has('content-length'))
                            throw new Error('invalid-http-response');
                        let out = new Uint8Array(0);
                        for (;;) {
                            let line: number;
                            while ((line = buffer.findIndex((b, i) => b === 13 && buffer[i + 1] === 10)) < 0) {
                                if (buffer.length > 1024)
                                    throw new Error('invalid-http-response');
                                if (!await more())
                                    throw new Error('invalid-http-response');
                            }
                            const size = /^([0-9a-fA-F]{1,8})(?:;.*)?$/.exec(latin1(buffer.subarray(0, line)));
                            if (!size)
                                throw new Error('invalid-http-response');
                            const n = parseInt(size[1]!, 16);
                            if (out.length + n > max)
                                tooLarge();
                            buffer = buffer.slice(line + 2);
                            if (n === 0)
                                return out;
                            while (buffer.length < n + 2)
                                if (!await more())
                                    throw new Error('invalid-http-response');
                            if (buffer[n] !== 13 || buffer[n + 1] !== 10)
                                throw new Error('invalid-http-response');
                            out = join(out, buffer.subarray(0, n));
                            buffer = buffer.slice(n + 2);
                        }
                    }
                    const lengths = new Set(fields.get('content-length') ?? []);
                    if (lengths.size > 1 || [...lengths].some(v => !/^\d{1,15}$/.test(v)))
                        throw new Error('invalid-http-response');
                    const length = lengths.size ? Number([...lengths][0]) : null;
                    if (length !== null && length > max)
                        tooLarge();
                    while (length === null ? true : buffer.length < length) {
                        if (buffer.length > max)
                            tooLarge();
                        if (!await more()) {
                            if (length !== null)
                                throw new Error('invalid-http-response');
                            break;
                        }
                    }
                    return buffer.slice(0, length ?? buffer.length);
                }
                for (;;) {
                    let end: number;
                    while ((end = headerEnd(buffer)) >= 0) {
                        if (end > MAX_HEADER_BYTES)
                            throw new Error('response-headers-too-large');
                        const lines = latin1(buffer.subarray(0, end)).split('\r\n');
                        const match = /^HTTP\/1\.[01] ([1-5]\d\d)(?: |$)/.exec(lines[0]!);
                        if (!match)
                            throw new Error('invalid-http-response');
                        const status = Number(match[1]);
                        if (status >= 200) {
                            const headers = new Headers(), fields = new Map<string, string[]>();
                            for (const line of lines.slice(1)) {
                                const colon = line.indexOf(':');
                                if (colon <= 0)
                                    throw new Error('invalid-http-response');
                                const name = line.slice(0, colon).toLowerCase(), value = line.slice(colon + 1).trim();
                                fields.set(name, [...fields.get(name) ?? [], value]);
                                if (name === 'retry-after')
                                    headers.append('Retry-After', value);
                            }
                            const max = limits.maxBodyBytes;
                            if (max === undefined || [204, 205, 304].includes(status))
                                return new Response(null, { status, headers });
                            buffer = buffer.slice(end + 4);
                            return new Response(await readBody(fields, max), { status, headers });
                        }
                        if (status === 101)
                            throw new Error('invalid-http-response');
                        buffer = buffer.slice(end + 4);
                    }
                    if (buffer.length > MAX_HEADER_BYTES)
                        throw new Error('response-headers-too-large');
                    if (!await more())
                        throw new Error('invalid-http-response');
                }
            })()]);
    }
    finally {
        signal?.removeEventListener('abort', onAbort);
        await socket.close().catch(() => { });
    }
}
export async function boundedText(response: Response, max: number) {
    const reader = response.body?.getReader();
    let out = new Uint8Array(0);
    if (reader)
        for (;;) {
            const { value, done } = await reader.read();
            if (done)
                break;
            out = join(out, value);
            if (out.length > max) {
                await reader.cancel().catch(() => { });
                throw new Error('response-body-too-large');
            }
        }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(out);
}
