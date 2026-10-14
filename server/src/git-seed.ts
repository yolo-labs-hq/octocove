const utf8 = new TextEncoder();
export function concatenate(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}
const hex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
const sha1 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
export async function gitObjectId(type: 'blob' | 'tree' | 'commit', body: Uint8Array) {
    return hex(await sha1(concatenate(utf8.encode(`${type} ${body.length}\0`), body)));
}
export function packetLine(text: string) {
    const body = utf8.encode(text), length = body.length + 4;
    if (length > 65520)
        throw new Error('git-packet-too-large');
    return concatenate(utf8.encode(length.toString(16).padStart(4, '0')), body);
}
const rawOid = (id: string) => new Uint8Array(id.match(/../g)!.map(byte => parseInt(byte, 16)));
async function packedObject(type: number, body: Uint8Array) {
    const header = [(type << 4) | (body.length & 15)];
    let size = Math.floor(body.length / 16);
    while (size) {
        header[header.length - 1]! |= 128;
        header.push(size & 127);
        size = Math.floor(size / 128);
    }
    const compressed = await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer();
    return concatenate(new Uint8Array(header), new Uint8Array(compressed));
}
export async function buildInitialCommit(input: {
    projectName: string;
    principal: string;
    createdAt: string;
    targetRef: string;
}) {
    if (!input.targetRef.startsWith('refs/heads/') || /[\0\r\n ]/.test(input.targetRef))
        throw new Error('invalid-seed-ref');
    const timestamp = Math.floor(Date.parse(input.createdAt) / 1000);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0)
        throw new Error('invalid-seed-time');
    const name = input.projectName.replace(/[\0\r\n]/g, ' ');
    const readme = `# ${name}\n\nCreated with Octocove.\n`;
    const blob = utf8.encode(readme), blobSha = await gitObjectId('blob', blob);
    const tree = concatenate(utf8.encode('100644 README.md\0'), rawOid(blobSha)), treeSha = await gitObjectId('tree', tree);
    const commitText = `tree ${treeSha}\nauthor Octocove <noreply@example.org> ${timestamp} +0000\ncommitter Octocove <noreply@example.org> ${timestamp} +0000\n\nInitialize ${name}\n\nCreated by ${JSON.stringify(input.principal)}.\n`;
    const commit = utf8.encode(commitText), commitSha = await gitObjectId('commit', commit);
    const header = new Uint8Array(12);
    header.set(utf8.encode('PACK'));
    const view = new DataView(header.buffer);
    view.setUint32(4, 2);
    view.setUint32(8, 3);
    const content = concatenate(header, await packedObject(1, commit), await packedObject(2, tree), await packedObject(3, blob));
    const pack = concatenate(content, await sha1(content));
    const body = concatenate(packetLine(`${'0'.repeat(40)} ${commitSha} ${input.targetRef}\0report-status\n`), utf8.encode('0000'), pack);
    return { commitSha, treeSha, blobSha, readme, commitText, commit, tree, blob, pack, body };
}
export function seedReportOutcome(bytes: Uint8Array, targetRef: string): 'written' | 'rejected' | 'ambiguous' {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }), lines: string[] = [];
    try {
        let offset = 0, flushed = false;
        while (offset + 4 <= bytes.length) {
            const prefix = decoder.decode(bytes.subarray(offset, offset + 4));
            if (!/^[0-9a-f]{4}$/.test(prefix))
                return 'ambiguous';
            const length = parseInt(prefix, 16);
            if (!length) {
                offset += 4;
                flushed = true;
                break;
            }
            if (length < 4 || offset + length > bytes.length)
                return 'ambiguous';
            lines.push(decoder.decode(bytes.subarray(offset + 4, offset + length)));
            offset += length;
        }
        if (!flushed || offset !== bytes.length)
            return 'ambiguous';
        if (lines.length === 2 && lines[0] === 'unpack ok\n' && lines[1] === `ok ${targetRef}\n`)
            return 'written';
        if (lines.some(line => line.startsWith(`ng ${targetRef} `)) || (lines[0]?.startsWith('unpack ') && lines[0] !== 'unpack ok\n'))
            return 'rejected';
    }
    catch { }
    return 'ambiguous';
}
