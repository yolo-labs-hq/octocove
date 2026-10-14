import { AuthError } from './auth';
const unverifiable = (): never => { throw new AuthError('candidate-ancestry-unverifiable', 422); };
const MAX_INFLATED = 32 << 20, MAX_COMMIT = 1 << 20;
function zlibEnd(bytes: Uint8Array, start: number) {
    let bit = (start + 2) * 8, output = 0;
    const read = (n: number) => {
        if (bit + n > bytes.length * 8)
            return unverifiable();
        let value = 0;
        for (let i = 0; i < n; i++, bit++)
            value |= ((bytes[bit >>> 3]! >>> (bit & 7)) & 1) << i;
        return value;
    };
    const cmf = bytes[start], flags = bytes[start + 1];
    if (cmf === undefined || flags === undefined || (cmf & 15) !== 8 || cmf >>> 4 > 7 || ((cmf << 8) + flags) % 31 || (flags & 32))
        unverifiable();
    const table = (lengths: number[]) => {
        const counts = Array(16).fill(0), next = Array(16).fill(0), map = new Map<number, number>();
        for (const n of lengths) {
            if (n < 0 || n > 15)
                unverifiable();
            if (n)
                counts[n]++;
        }
        let code = 0;
        for (let n = 1; n <= 15; n++) {
            code = (code + counts[n - 1]) << 1;
            next[n] = code;
            if (code + counts[n] > 1 << n)
                unverifiable();
        }
        lengths.forEach((n, symbol) => { if (n) {
            let c = next[n]++, reversed = 0;
            for (let i = 0; i < n; i++) {
                reversed = reversed << 1 | c & 1;
                c >>>= 1;
            }
            map.set((1 << n) | reversed, symbol);
        } });
        return map;
    };
    const symbol = (codes: Map<number, number>) => {
        let code = 0;
        for (let n = 1; n <= 15; n++) {
            code |= read(1) << (n - 1);
            const value = codes.get((1 << n) | code);
            if (value !== undefined)
                return value;
        }
        return unverifiable();
    };
    const lengthBase = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    const lengthExtra = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    const distanceBase = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    let final = 0;
    do {
        final = read(1);
        const kind = read(2);
        if (kind === 0) {
            bit = Math.ceil(bit / 8) * 8;
            const size = read(16);
            if ((size ^ read(16)) !== 65535)
                unverifiable();
            bit += size * 8;
            output += size;
            if (bit > bytes.length * 8)
                unverifiable();
        }
        else {
            if (kind === 3)
                unverifiable();
            let literal: Map<number, number>, distance: Map<number, number>;
            if (kind === 1) {
                literal = table(Array.from({ length: 288 }, (_, n) => n < 144 ? 8 : n < 256 ? 9 : n < 280 ? 7 : 8));
                distance = table(Array(32).fill(5));
            }
            else {
                const hlit = read(5) + 257, hdist = read(5) + 1, hclen = read(4) + 4;
                if (hlit > 286)
                    unverifiable();
                const codeOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
                const lengths = Array(19).fill(0);
                for (let i = 0; i < hclen; i++)
                    lengths[codeOrder[i]!] = read(3);
                const codeLengths = table(lengths), all: number[] = [];
                while (all.length < hlit + hdist) {
                    const value = symbol(codeLengths);
                    if (value < 16)
                        all.push(value);
                    else {
                        if (value === 16 && !all.length)
                            unverifiable();
                        const count = value === 16 ? read(2) + 3 : value === 17 ? read(3) + 3 : read(7) + 11;
                        all.push(...Array(count).fill(value === 16 ? all.at(-1) : 0));
                    }
                    if (all.length > hlit + hdist)
                        unverifiable();
                }
                if (!all[256])
                    unverifiable();
                literal = table(all.slice(0, hlit));
                distance = table(all.slice(hlit));
            }
            for (;;) {
                const value = symbol(literal);
                if (value === 256)
                    break;
                if (value < 256)
                    output++;
                else {
                    if (value > 285)
                        unverifiable();
                    const n = value - 257, length = lengthBase[n]! + read(lengthExtra[n]!);
                    const d = symbol(distance);
                    if (d > 29)
                        unverifiable();
                    const offset = distanceBase[d]! + read(d < 4 ? 0 : (d >>> 1) - 1);
                    if (offset > output)
                        unverifiable();
                    output += length;
                }
                if (output > MAX_INFLATED)
                    unverifiable();
            }
        }
        if (output > MAX_INFLATED)
            unverifiable();
    } while (!final);
    const end = Math.ceil(bit / 8) + 4;
    if (end > bytes.length)
        unverifiable();
    return end;
}
const hex = (data: ArrayBuffer) => Array.from(new Uint8Array(data), n => n.toString(16).padStart(2, '0')).join('');
export async function verifyPackAncestry(body: Uint8Array, source: string, base: string, head?: string | null, anchor?: {
    sha: string;
    base: string;
}) {
    try {
        let offset = parseInt(new TextDecoder().decode(body.subarray(0, 4)), 16) + 4;
        const pack = body.subarray(offset);
        if (!pack.length) {
            if (source === head)
                return head;
            if (source === anchor?.sha)
                return anchor.base;
            if (source === base)
                return base;
            unverifiable();
        }
        const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
        if (pack.length < 32 || new TextDecoder().decode(pack.subarray(0, 4)) !== 'PACK' || ![2, 3].includes(view.getUint32(4)))
            unverifiable();
        if (hex(await crypto.subtle.digest('SHA-1', pack.subarray(0, -20))) !== hex(new Uint8Array(pack.subarray(-20)).buffer))
            unverifiable();
        const count = view.getUint32(8);
        if (count > 10000)
            unverifiable();
        offset = 12;
        let total = 0;
        const parents = new Map<string, string[]>();
        for (let i = 0; i < count; i++) {
            let b = pack[offset++]!;
            const type = b >>> 4 & 7;
            let size = b & 15, shift = 4;
            while (b & 128) {
                if (shift > 28)
                    unverifiable();
                b = pack[offset++]!;
                size += (b & 127) * 2 ** shift;
                shift += 7;
            }
            if (![1, 2, 3, 4, 6, 7].includes(type) || size > MAX_INFLATED || type === 1 && size > MAX_COMMIT)
                unverifiable();
            if (type === 6) {
                do {
                    b = pack[offset++]!;
                    if (offset >= pack.length - 20)
                        unverifiable();
                } while (b & 128);
            }
            if (type === 7)
                offset += 20;
            const end = zlibEnd(pack.subarray(0, -20), offset);
            const stream = new Blob([pack.slice(offset, end)]).stream().pipeThrough(new DecompressionStream('deflate'));
            const reader = stream.getReader(), chunks: Uint8Array[] = [];
            let length = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                length += value.length;
                total += value.length;
                if (length > size || total > MAX_INFLATED) {
                    await reader.cancel();
                    unverifiable();
                }
                if (type === 1)
                    chunks.push(value);
            }
            if (length !== size)
                unverifiable();
            if (type === 1) {
                const content = new Uint8Array(size);
                let at = 0;
                for (const chunk of chunks) {
                    content.set(chunk, at);
                    at += chunk.length;
                }
                const header = new TextEncoder().encode(`commit ${size}\0`), object = new Uint8Array(header.length + size);
                object.set(header);
                object.set(content, header.length);
                const oid = hex(await crypto.subtle.digest('SHA-1', object));
                const lines = new TextDecoder().decode(content).split('\n\n', 1)[0]!.split('\n');
                if (!/^tree [a-f0-9]{40}$/.test(lines[0] ?? ''))
                    unverifiable();
                const links: string[] = [];
                let parentSection = true;
                for (const line of lines.slice(1)) {
                    if (line.startsWith('parent ')) {
                        if (!parentSection || !/^parent [a-f0-9]{40}$/.test(line))
                            unverifiable();
                        links.push(line.slice(7));
                    }
                    else
                        parentSection = false;
                }
                parents.set(oid, links);
            }
            offset = end;
        }
        if (offset !== pack.length - 20)
            unverifiable();
        const pending = [source], seen = new Set<string>();
        let missing = false, reachedBase = false, anchorBase: string | undefined;
        while (pending.length) {
            const oid = pending.pop()!;
            if (oid === head)
                return head;
            if (oid === anchor?.sha) {
                anchorBase = anchor.base;
                continue;
            }
            if (oid === base) {
                reachedBase = true;
                continue;
            }
            if (seen.has(oid))
                continue;
            seen.add(oid);
            const links = parents.get(oid);
            if (!links)
                missing = true;
            else
                pending.push(...links);
        }
        if (anchorBase)
            return anchorBase;
        if (reachedBase)
            return base;
        if (missing)
            unverifiable();
        throw new AuthError('chain-push-non-fast-forward', 409);
    }
    catch (error) {
        if (error instanceof AuthError)
            throw error;
        unverifiable();
    }
}
