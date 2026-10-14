import { AuthError } from './auth';
import type { BrokerEnv } from './broker';
import { ArtifactsContent, BLOB_CONTENT_LIMIT, canonicalFor, decodeText, parseRef, type Entry } from './code-view';
export const COMPARE_FILE_LIMIT = 300;
const MAX_DIFF_CELLS = 1000000, CONTEXT = 3;
const MAX_TREE_READS = 256, MAX_ENTRIES = 100000, MAX_DEPTH = 64;
const MAX_TRAVERSAL_WORK = 100000;
const MAX_TEXT_BYTES = 8 * 1024 * 1024, MAX_TEXT_LINES = 50000;
interface Hunk {
    oldStart: number;
    newStart: number;
    lines: string[];
}
interface DiffFile {
    path: string;
    status: 'added' | 'modified' | 'deleted';
    added: number;
    removed: number;
    hunks?: Hunk[];
    omitted?: 'too-large' | 'binary' | 'unavailable';
    error?: string;
}
interface Changed {
    path: string;
    before?: Entry;
    after?: Entry;
}
const invalid = (parameter: string): never => { throw new AuthError('invalid-request', 400, { parameter }); };
const parseSha = (raw: string | undefined, parameter: string) => raw && /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(raw) ? raw.toLowerCase() : invalid(parameter);
type Op = {
    op: " " | "+" | "-";
    text: string;
};
function lineOps(a: string[], b: string[]): Op[] {
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head])
        head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail])
        tail++;
    const ma = a.slice(head, a.length - tail);
    const mb = b.slice(head, b.length - tail);
    const out: Op[] = a.slice(0, head).map((text) => ({ op: " ", text }));
    if (ma.length * mb.length > MAX_DIFF_CELLS) {
        for (const text of ma)
            out.push({ op: "-", text });
        for (const text of mb)
            out.push({ op: "+", text });
    }
    else {
        const w = mb.length + 1;
        const t = new Uint32Array((ma.length + 1) * w);
        for (let i = ma.length - 1; i >= 0; i--)
            for (let j = mb.length - 1; j >= 0; j--)
                t[i * w + j] = ma[i] === mb[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
        let i = 0;
        let j = 0;
        while (i < ma.length || j < mb.length) {
            if (i < ma.length && j < mb.length && ma[i] === mb[j]) {
                out.push({ op: " ", text: ma[i]! });
                i++;
                j++;
            }
            else if (j < mb.length && (i === ma.length || t[i * w + j + 1]! > t[(i + 1) * w + j]!))
                out.push({ op: "+", text: mb[j++]! });
            else
                out.push({ op: "-", text: ma[i++]! });
        }
    }
    for (let i = a.length - tail; i < a.length; i++)
        out.push({ op: " ", text: a[i]! });
    return out;
}
const split = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
export function diffText(oldText: string, newText: string): {
    hunks: Hunk[];
    added: number;
    removed: number;
} {
    const ops = lineOps(split(oldText), split(newText));
    const changed = ops.flatMap((o, i) => (o.op === " " ? [] : [i]));
    const hunks: Hunk[] = [];
    let k = 0;
    while (k < changed.length) {
        const from = Math.max(0, changed[k]! - CONTEXT);
        let last = changed[k]!;
        while (k + 1 < changed.length && changed[k + 1]! - last <= CONTEXT * 2 + 1)
            last = changed[++k]!;
        k++;
        const to = Math.min(ops.length, last + CONTEXT + 1);
        const before = ops.slice(0, from);
        hunks.push({
            oldStart: before.filter((o) => o.op !== "+").length + 1,
            newStart: before.filter((o) => o.op !== "-").length + 1,
            lines: ops.slice(from, to).flatMap((o) => o.text.endsWith("\n")
                ? [o.op + o.text.slice(0, -1)] : [o.op + o.text, "\\ No newline at end of file"]),
        });
    }
    return {
        hunks,
        added: ops.filter((o) => o.op === "+").length,
        removed: ops.filter((o) => o.op === "-").length,
    };
}
export async function compareTrees(content: ArtifactsContent, before: string, after: string) {
    const trees = new Map<string, Promise<Entry[]>>();
    let entries = 0, changed = 0, work = 0;
    const charge = (amount: number) => {
        work += amount;
        if (work > MAX_TRAVERSAL_WORK)
            throw new AuthError('comparison-too-large', 413);
    };
    const listed: Changed[] = [];
    async function tree(hash?: string): Promise<Entry[]> {
        if (!hash)
            return [];
        if (!trees.has(hash)) {
            if (trees.size >= MAX_TREE_READS)
                throw new AuthError('comparison-too-large', 413);
            trees.set(hash, content.tree(hash).then(rows => {
                entries += rows.length;
                if (entries > MAX_ENTRIES)
                    throw new AuthError('comparison-too-large', 413);
                if (new Set(rows.map(row => row.name)).size !== rows.length)
                    throw new AuthError('broker-provider-unavailable', 503);
                return rows;
            }));
        }
        return trees.get(hash)!;
    }
    const record = (path: string, before?: Entry, after?: Entry) => {
        changed++;
        if (listed.length < COMPARE_FILE_LIMIT)
            listed.push({ path, before, after });
    };
    async function walk(left: string | undefined, right: string | undefined, prefix: string, depth: number) {
        charge(1);
        if (left === right)
            return;
        if (depth > MAX_DEPTH)
            throw new AuthError('comparison-too-large', 413);
        const [a, b] = await Promise.all([tree(left), tree(right)]);
        charge(a.length + b.length);
        const old = new Map(a.map(row => [row.name, row])), next = new Map(b.map(row => [row.name, row]));
        for (const name of [...new Set([...old.keys(), ...next.keys()])].sort()) {
            const previous = old.get(name), current = next.get(name), path = prefix ? `${prefix}/${name}` : name;
            if (previous?.hash === current?.hash && previous?.type === current?.type && previous?.mode === current?.mode)
                continue;
            if (new TextEncoder().encode(path).byteLength > 4096)
                throw new AuthError('comparison-too-large', 413);
            if (previous?.type === 'dir' || current?.type === 'dir') {
                if (previous && previous.type !== 'dir')
                    record(path, previous);
                await walk(previous?.type === 'dir' ? previous.hash : undefined, current?.type === 'dir' ? current.hash : undefined, path, depth + 1);
                if (current && current.type !== 'dir')
                    record(path, undefined, current);
            }
            else
                record(path, previous, current);
        }
    }
    await walk(before, after, '', 0);
    listed.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { listed, omittedFiles: changed - listed.length };
}
export async function readCompare(request: Request, env: BrokerEnv, projectId: string, query: {
    base?: string;
    head?: string;
}, http?: typeof fetch) {
    const repo = await canonicalFor(request, env, projectId);
    const base = parseSha(query.base, 'base'), head = parseSha(query.head, 'head');
    const content = new ArtifactsContent(env, repo, http);
    const [before, after] = await Promise.all([content.rootTree(base), base === head ? Promise.resolve(null) : content.rootTree(head)]);
    if (!before || (base !== head && !after))
        throw new AuthError('not-found', 404);
    const { listed, omittedFiles } = await compareTrees(content, before, base === head ? before : after!);
    const log = base === head ? [] : await content.log(head, 100);
    const stop = log.findIndex(commit => commit.sha === base);
    const commits = (stop < 0 ? log : log.slice(0, stop)).map(commit => ({ ...commit, message: commit.message.split('\n')[0]! }));
    const files: DiffFile[] = [];
    let textBytes = 0, textLines = 0;
    for (const change of listed) {
        const { path, before: b, after: a } = change;
        const file: DiffFile = { path, status: !b ? 'added' : !a ? 'deleted' : 'modified', added: 0, removed: 0 };
        files.push(file);
        if ((b?.size ?? 0) > BLOB_CONTENT_LIMIT || (a?.size ?? 0) > BLOB_CONTENT_LIMIT) {
            file.omitted = 'too-large';
            continue;
        }
        if (b?.type === 'submodule' || a?.type === 'submodule') {
            file.omitted = 'unavailable';
            file.error = 'Submodule content is not a text blob.';
            continue;
        }
        if (textBytes >= MAX_TEXT_BYTES) {
            file.omitted = 'unavailable';
            file.error = 'Comparison content limit reached.';
            continue;
        }
        const blobs = await Promise.all([b ? content.blob(b.hash, BLOB_CONTENT_LIMIT, b.size) : null, a ? content.blob(a.hash, BLOB_CONTENT_LIMIT, a.size) : null]);
        if (blobs.some(blob => blob && blob.size > BLOB_CONTENT_LIMIT)) {
            file.omitted = 'too-large';
            continue;
        }
        const bytes = blobs.reduce((sum, blob) => sum + (blob?.bytes.byteLength ?? 0), 0);
        if (textBytes + bytes > MAX_TEXT_BYTES) {
            file.omitted = 'unavailable';
            file.error = 'Comparison content limit reached.';
            continue;
        }
        const texts = blobs.map(blob => blob ? decodeText(blob.bytes, false) : '');
        if (texts.some(text => text === null)) {
            file.omitted = 'binary';
            continue;
        }
        textBytes += bytes;
        if (texts.some(text => { let lines = 1; for (const character of text!)
            if (character === '\n')
                lines++; textLines += lines; return lines > MAX_TEXT_LINES || textLines > 100000; })) {
            file.omitted = 'too-large';
            file.error = 'Text has too many lines to render safely.';
            continue;
        }
        Object.assign(file, diffText(texts[0]!, texts[1]!));
    }
    return { body: { files, commits, omittedFiles }, sha: true };
}
export async function readCommits(request: Request, env: BrokerEnv, projectId: string, query: {
    ref?: string;
    limit?: string;
}, http?: typeof fetch) {
    const repo = await canonicalFor(request, env, projectId);
    let ref;
    try {
        ref = parseRef(query.ref, repo.ref_name);
    }
    catch {
        return invalid('ref');
    }
    const limit = query.limit === undefined ? 30 : /^\d+$/.test(query.limit) ? Number(query.limit) : invalid('limit');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        return invalid('limit');
    const commits = await new ArtifactsContent(env, repo, http).log(ref.ref, limit);
    if (!commits.length && (ref.sha || ref.ref !== repo.ref_name))
        throw new AuthError('not-found', 404);
    if (ref.sha && commits[0]!.sha !== ref.ref)
        throw new AuthError('broker-provider-unavailable', 503);
    return { body: { repositoryId: repo.id, ref: ref.ref, commitSha: commits[0]?.sha ?? null, commits }, sha: ref.sha };
}
