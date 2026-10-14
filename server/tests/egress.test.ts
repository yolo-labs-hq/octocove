import { describe, expect, it, vi } from 'vitest';
import { boundedText, pinnedHttpsFetch, publicAddress } from '../src/egress';
const encoder = new TextEncoder();
function socketFixture(chunks: string[], opened: Promise<unknown> = Promise.resolve({})) {
    const writes: Uint8Array[] = [];
    opened.catch(() => { });
    const tls = {
        readable: new ReadableStream({ start(c) { for (const chunk of chunks)
                c.enqueue(encoder.encode(chunk)); c.close(); } }),
        writable: new WritableStream({ write(chunk) { writes.push(chunk); } }),
        opened, closed: Promise.resolve(), close: vi.fn(async () => { }),
    };
    const startTls = vi.fn(() => tls);
    const connect = vi.fn(() => ({ closed: Promise.resolve(), startTls, close: vi.fn(async () => { }) }));
    return { connect, startTls, tls, request: () => writes.map(b => new TextDecoder().decode(b)).join('') };
}
const get = (f: ReturnType<typeof socketFixture>, url = 'https://keys.example/jwks', address = '93.184.216.34', maxBodyBytes = 1024) => pinnedHttpsFetch(url, { method: 'GET' }, address, f.connect as any, { maxBodyBytes });
const document = '{"keys":[]}';
describe('pinned JWKS egress (verification on local fixtures)', () => {
    it('connects only to the validated address, with TLS identity and Host of the original hostname', async () => {
        const f = socketFixture([`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${document.length}\r\n\r\n${document}`]);
        const r = await get(f, 'https://keys.example/jwks?v=1');
        expect(r.status).toBe(200);
        expect(await r.text()).toBe(document);
        expect(f.connect).toHaveBeenCalledExactlyOnceWith({ hostname: '93.184.216.34', port: 443 }, { secureTransport: 'starttls', allowHalfOpen: false });
        expect(f.startTls).toHaveBeenCalledExactlyOnceWith({ expectedServerHostname: 'keys.example' });
        expect(f.request()).toMatch(/^GET \/jwks\?v=1 HTTP\/1\.1\r\n/);
        expect(f.request()).toContain('host: keys.example\r\n');
        expect(f.request()).not.toContain('content-length');
        expect(f.tls.close).toHaveBeenCalledTimes(1);
    });
    it('expected: refused — certificate/hostname identity mismatch fails the TLS handshake before any request', async () => {
        const f = socketFixture([], Promise.reject(new Error('TLS peer certificate does not match keys.example')));
        await expect(get(f)).rejects.toThrow('does not match');
        expect(f.startTls).toHaveBeenCalledExactlyOnceWith({ expectedServerHostname: 'keys.example' });
        expect(f.request()).toBe('');
        expect(f.tls.close).toHaveBeenCalled();
    });
    it('expected: refused — private, loopback, link-local and mixed DNS answers', async () => {
        const url = new URL('https://keys.example/jwks');
        for (const answers of [['127.0.0.1'], ['10.0.0.7'], ['169.254.169.254'], ['::1'], ['fd00::1'], ['93.184.216.34', '10.0.0.1'], ['2606:4700::1', '::ffff:127.0.0.1'], []]) {
            await expect(publicAddress(url, { resolve: async () => answers })).rejects.toThrow('destination-not-public');
        }
        for (const literal of ['https://127.0.0.1/jwks', 'https://[::1]/jwks', 'https://10.1.2.3/jwks'])
            await expect(publicAddress(new URL(literal), { resolve: async () => ['93.184.216.34'] })).rejects.toThrow('destination-not-public');
        expect(await publicAddress(url, { resolve: async () => ['93.184.216.34', '2606:4700::1'] })).toBe('93.184.216.34');
    });
    it('expected: refused — a rebound (non-public) address handed to the transport never connects', async () => {
        for (const address of ['10.0.0.1', '127.0.0.1', '::1', '169.254.169.254', '0177.0.0.1']) {
            const f = socketFixture([`HTTP/1.1 200 OK\r\nContent-Length: ${document.length}\r\n\r\n${document}`]);
            await expect(get(f, undefined, address)).rejects.toThrow('destination-not-public');
            expect(f.connect).not.toHaveBeenCalled();
        }
    });
    it('expected: refused — redirects are returned as-is and never followed', async () => {
        const f = socketFixture(['HTTP/1.1 302 Found\r\nLocation: https://169.254.169.254/latest/meta-data\r\nContent-Length: 0\r\n\r\n']);
        const r = await get(f);
        expect(r.status).toBe(302);
        expect(f.connect).toHaveBeenCalledTimes(1);
    });
    it('expected: refused — oversized bodies under every framing; bounded bodies decode', async () => {
        const big = 'x'.repeat(1025);
        for (const response of [
            `HTTP/1.1 200 OK\r\nContent-Length: ${big.length}\r\n\r\n${big}`,
            `HTTP/1.1 200 OK\r\nContent-Length: 999999999\r\n\r\n`,
            `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n200\r\n${'x'.repeat(512)}\r\n201\r\n${'x'.repeat(513)}\r\n0\r\n\r\n`,
            `HTTP/1.1 200 OK\r\n\r\n${big}`,
        ])
            await expect(get(socketFixture([response]))).rejects.toThrow('response-body-too-large');
        for (const response of [
            `HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 4\r\n\r\nabcd`,
            `HTTP/1.1 200 OK\r\nContent-Length: 4\r\nContent-Length: 5\r\n\r\nabcd`,
            `HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n0\r\n\r\n`,
            `HTTP/1.1 200 OK\r\nContent-Length: 40\r\n\r\ntruncated`,
        ])
            await expect(get(socketFixture([response]))).rejects.toThrow('invalid-http-response');
        const chunked = await get(socketFixture(['HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;ext=1\r\n{"ke', 'y\r\n6\r\ns":[]}\r\n0\r\nX-Trailer: 1\r\n\r\n']));
        expect(await chunked.text()).toBe(document);
        const delimited = await get(socketFixture(['HTTP/1.1 200 OK\r\n\r\n{"keys"', ':[]}']));
        expect(await delimited.text()).toBe(document);
    });
    it('cancels before connecting when already aborted, and boundedText refuses rather than truncates', async () => {
        const f = socketFixture([]), controller = new AbortController();
        controller.abort(new Error('timeout'));
        await expect(pinnedHttpsFetch('https://keys.example/jwks', { signal: controller.signal }, '93.184.216.34', f.connect as any, { maxBodyBytes: 1024 })).rejects.toThrow('timeout');
        expect(f.connect).not.toHaveBeenCalled();
        await expect(boundedText(new Response('x'.repeat(11)), 10)).rejects.toThrow('response-body-too-large');
        expect(await boundedText(new Response('x'.repeat(10)), 10)).toBe('x'.repeat(10));
    });
});
