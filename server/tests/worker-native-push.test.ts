import { enqueueIntegrator } from '../src/integrator-control';
import { beforeAll, afterAll, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { TaskCoordinator } from '../src/task-coordinator';
import { TaskLifecycle } from '../src/lifecycle';
import { TokenBroker, readPushBody } from '../src/broker';
import { AuthService, hash } from '../src/auth';
import { unfinishedLifecycle } from '../src/outbox-state';
import { reserveCanonicalRead } from '../src/canonical-head';
import { verifyPackAncestry } from '../src/pack-ancestry';
import { db, mf, auth, human, intent, key, claimInput, fixtureAuthorizer } from './lifecycle-fixture';
let root: string, base: string, source: string, full: Buffer, env: any, life: TaskLifecycle;
const remote = `https://${'a'.repeat(32)}.artifacts.cloudflare.net/git/ns/canonical.git`;
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: root, env: { PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const pkt = (s: string) => Buffer.from((Buffer.byteLength(s) + 4).toString(16).padStart(4, '0') + s);
const body = (claim: string, pack = full, old = '0'.repeat(40), sha = source, ref = `refs/octocove/claims/${claim}`) => Buffer.concat([pkt(`${old} ${sha} ${ref}\0report-status ofs-delta object-format=sha1\n`), Buffer.from('0000'), pack]);
const req = (token: string) => new Request('https://api.example/tasks/task/lane/receive-pack', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
let seq = 0;
const extraPaths: string[] = [];
async function claim(verbs = ['submissions:create']) {
    const task = `native-${++seq}`, c = `claim-${task}`;
    await db.prepare('UPDATE target_refs SET known_head_sha=? WHERE repository_id=?').bind(base, 'canonical').run();
    await life.create(task, human, key(`create-${task}`), { ...intent, projectId: 'p', repositoryId: 'canonical', targetRef: 'refs/heads/main', key: task });
    await life.publish(task, human, key(`publish-${task}`));
    await life.claim(task, key(`claim-${task}`), { ...claimInput(c), chain: { id: `chain-${task}`, baseSha: base } });
    if (verbs.includes('tasks:read')) {
        await db.prepare('UPDATE auth_authorizations SET verbs=? WHERE id=?').bind(JSON.stringify(verbs), `d-${c}`).run();
        await db.prepare('UPDATE auth_memberships SET verbs=? WHERE project_id=? AND issuer=? AND sub=?').bind(JSON.stringify(['tasks:claim', 'tasks:read', 'submissions:create']), 'p', fixtureAuthorizer.issuer, fixtureAuthorizer.sub).run();
    }
    const delegation = await auth.issueDelegation({ authorizer: { ...fixtureAuthorizer, familyId: 'fixture-family' } as any, project: 'p', task, claimAttempt: c, verbs, ttl: 900 });
    return { task, c, token: delegation.accessToken };
}
function broker(tip?: string, outcome: 'written' | 'rejected' | 'ambiguous' | 'sideband' | 'malformed' = 'written', head = base) {
    const provider = { createToken: vi.fn(async (_repo: any, scope: string, ttl: number) => ({ id: crypto.randomUUID(), plaintext: 'server-only', scope, expires_at: new Date(Date.now() + ttl * 1000).toISOString() })), revokeToken: vi.fn(async () => { }) };
    let report = Buffer.alloc(0), sent: Uint8Array | undefined;
    const http = vi.fn(async (url: any, options: any) => {
        if (String(url).includes('/info/refs'))
            return new Response(Buffer.concat([pkt('# service=git-upload-pack\n'), Buffer.from('0000'), pkt(`${head} refs/heads/main\0report-status\n`), ...(tip ? [pkt(`${tip} refs/octocove/claims/${currentClaim}\n`)] : []), Buffer.from('0000')]), { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } });
        sent = options.body;
        if (outcome === 'ambiguous')
            throw new Error('lost response');
        report = Buffer.concat([pkt('unpack ok\n'), pkt(`${outcome === 'written' ? 'ok' : 'ng'} refs/octocove/claims/${currentClaim}${outcome === 'written' ? '' : ' rejected'}\n`), Buffer.from('0000')]);
        if (outcome === 'sideband') {
            const inner = Buffer.concat([pkt('unpack ok\n'), pkt(`ok refs/octocove/claims/${currentClaim}\n`), Buffer.from('0000')]);
            report = Buffer.concat([pkt('\x02progress\n'), pkt('\x01' + inner.subarray(0, 9).toString()), pkt('\x01' + inner.subarray(9).toString()), Buffer.from('0000')]);
        }
        if (outcome === 'malformed')
            report = Buffer.from(`unpack ok\nok refs/octocove/claims/${currentClaim}\n`);
        return new Response(report);
    });
    return { service: new TokenBroker(env, provider as any, http as any), provider, http, get report() { return report; }, get sent() { return sent; } };
}
let currentClaim = '';
beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'worker-push-'));
    git('init', '-b', 'main');
    writeFileSync(join(root, 'README'), 'base');
    git('add', '.');
    git('commit', '-m', 'base');
    base = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'change'), 'source');
    git('add', '.');
    git('commit', '-m', 'source');
    source = git('rev-parse', 'HEAD');
    full = execFileSync('git', ['pack-objects', '--stdout', '--revs', '--no-reuse-delta', '--window=0'], { cwd: root, input: `${source}\n^${base}\n` });
    env = { ...await mf.getBindings(), DB: db, ARTIFACTS_ACCOUNT_ID: 'a'.repeat(32), ARTIFACTS_API_TOKEN: 'management' };
    life = new TaskLifecycle(db, undefined, { resolve: async () => remote, verify: async () => { throw new Error('runtime proof forbidden'); } } as any, undefined, true);
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); for (const path of extraPaths)
    rmSync(path, { recursive: true, force: true }); });
afterEach(() => vi.unstubAllGlobals());
function resolveRemote() { vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, result: { remote } }))); }
it('makes canonical chain claims ready without provisioner and projects immutable base/candidate ref', async () => {
    const { c } = await claim(), status = (await life.claimStatus(c)).body;
    expect(status.provisioningState).toBe('ready');
    expect(status.lane.readiness).toBe('ready');
    expect(status.workspace).toMatchObject({ remote, ref: `refs/octocove/claims/${c}`, baseSha: base });
    expect(await life.rows('SELECT * FROM repositories WHERE role=\'task\'')).toEqual([]);
    expect(await life.provision(c)).toMatchObject({ body: { provisioningState: 'ready' } });
});
it('writes exact bytes with server-only 60s token, records candidate and replays exact report without a second write', async () => {
    const { task, c, token } = await claim();
    currentClaim = c;
    resolveRemote();
    const b = broker();
    const intake = body(c), record = vi.fn(async (claim: any, sha: string, pushId: string, candidateBase: string) => { await life.recordWrittenCandidate(task, claim, sha, pushId, candidateBase); });
    const response = await b.service.pushWorkerNative(req(token), task, intake, record);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(b.report);
    expect(b.sent).toEqual(intake);
    const candidate = await life.one('SELECT * FROM candidates WHERE task_id=?', task);
    expect(candidate).toMatchObject({ candidate_sha: source, base_sha: base, candidate_ref: `refs/octocove/claims/${c}`, status: 'active' });
    expect(await life.rows("SELECT * FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", task)).toEqual([]);
    expect(b.provider.createToken.mock.calls.map(c => [c[1], c[2]])).toEqual([['read', 60], ['write', 60]]);
    expect(b.provider.revokeToken).toHaveBeenCalledTimes(2);
    const replay = await b.service.pushWorkerNative(req(token), task, intake, record);
    expect(Buffer.from(await replay.arrayBuffer())).toEqual(b.report);
    expect(b.http.mock.calls.filter(c => String(c[0]).endsWith('/git-receive-pack'))).toHaveLength(1);
    expect(await life.rows("SELECT * FROM worker_native_pushes WHERE runtime='cli-same-user' AND task_id=?", task)).toHaveLength(1);
    expect((await life.approve(task, human, key(`approve-${task}`), { candidateId: candidate.id, boundTo: { candidateSha: source, baseSha: base, intentVersion: 1 } })).status).toBe(201);
});
it('refuses sibling task agent, human session and expired delegation and audits each without provider writes', async () => {
    const one = await claim(), sibling = await claim();
    currentClaim = one.c;
    const b = broker();
    await expect(b.service.admitWorkerPush(req(sibling.token), one.task)).rejects.toMatchObject({ status: 403 });
    const humanToken = ['ocs', 'native-human'].join('_');
    await db.prepare('INSERT INTO auth_sessions(hash,family_id,csrf_hash,expires) VALUES(?,?,?,?)').bind(await hash(humanToken), 'fixture-family', 'csrf', Math.floor(Date.now() / 1000) + 600).run();
    await expect(b.service.admitWorkerPush(req(humanToken), one.task)).rejects.toMatchObject({ status: 403 });
    await db.prepare('UPDATE auth_delegations SET expires=0 WHERE id=?').bind(`d-${one.c}`).run();
    await expect(b.service.admitWorkerPush(req(one.token), one.task)).rejects.toMatchObject({ status: 401 });
    expect(await life.rows('SELECT * FROM broker_admission_audit WHERE task_id=?', one.task)).toHaveLength(3);
    expect(b.provider.createToken).not.toHaveBeenCalled();
});
it('refuses wrong ref and oversized intake before upstream I/O', async () => {
    const { task, c, token } = await claim();
    const b = broker();
    await expect(b.service.pushWorkerNative(req(token), task, body(c, full, undefined, undefined, 'refs/heads/main'), vi.fn())).rejects.toMatchObject({ status: 403, code: 'ref-not-owned' });
    await expect(b.service.pushWorkerNative(req(token), task, 'too-large', vi.fn())).rejects.toMatchObject({ status: 413 });
    expect(await readPushBody(new Request('https://api.example', { method: 'POST', body: new Uint8Array((8 << 20) + 1) }))).toBe('too-large');
    expect(b.provider.createToken).not.toHaveBeenCalled();
});
it.each(['rejected', 'ambiguous'] as const)('never creates candidate on upstream %s and revokes all tokens', async (outcome) => {
    const { task, c, token } = await claim();
    currentClaim = c;
    resolveRemote();
    const b = broker(undefined, outcome), record = vi.fn();
    if (outcome === 'ambiguous')
        await expect(b.service.pushWorkerNative(req(token), task, body(c), record)).rejects.toMatchObject({ code: 'upstream-ambiguous' });
    else
        expect(Buffer.from(await (await b.service.pushWorkerNative(req(token), task, body(c), record)).arrayBuffer())).toEqual(b.report);
    expect(record).not.toHaveBeenCalled();
    expect(b.provider.revokeToken).toHaveBeenCalledTimes(2);
});
it('advertises only own ref plus base/head haves and enforces old-tip CAS', async () => {
    const { task, c, token } = await claim();
    currentClaim = c;
    resolveRemote();
    const b = broker(source);
    const ad = await (await b.service.advertiseWorkerPush(req(token), task)).text();
    expect(ad).toContain(`${source} refs/octocove/claims/${c}\0report-status ofs-delta object-format=sha1`);
    expect(ad).toContain(`${base} .have`);
    await expect(b.service.pushWorkerNative(req(token), task, body(c), vi.fn())).rejects.toMatchObject({ code: 'chain-push-non-fast-forward', status: 409 });
});
function rawPack(type: number, content: Buffer, level = 6) { const header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(1, 8); let size = content.length, first = (type << 4) | (size & 15); size >>>= 4; const bytes = [first | (size ? 128 : 0)]; while (size) {
    const n = size & 127;
    size >>>= 7;
    bytes.push(n | (size ? 128 : 0));
} const raw = Buffer.concat([header, Buffer.from(bytes), ...(type === 7 ? [Buffer.alloc(20)] : []), deflateSync(content, { level })]); return Buffer.concat([raw, createHash('sha1').update(raw).digest()]); }
it('verifies real pack ancestry; distinguishes disconnected root409 from missing/deltified422 and selects observed-head base', async () => {
    expect(await verifyPackAncestry(body('c'), source, base)).toBe(base);
    expect(await verifyPackAncestry(body('c', Buffer.alloc(0), undefined, base), base, base)).toBe(base);
    await expect(verifyPackAncestry(body('c', Buffer.alloc(0)), source, base)).rejects.toMatchObject({ status: 422 });
    expect(await verifyPackAncestry(body('c'), source, 'f'.repeat(40), base)).toBe(base);
    const root = Buffer.from(`tree ${'a'.repeat(40)}\nauthor Test <test@example.com> 0 +0000\ncommitter Test <test@example.com> 0 +0000\n\nroot\n`);
    const oid = createHash('sha1').update(Buffer.concat([Buffer.from(`commit ${root.length}\0`), root])).digest('hex');
    await expect(verifyPackAncestry(body('c', rawPack(1, root), undefined, oid), oid, base)).rejects.toMatchObject({ status: 409 });
    await expect(verifyPackAncestry(body('c', rawPack(7, Buffer.from([0, 0]))), source, base)).rejects.toMatchObject({ status: 422 });
    await expect(verifyPackAncestry(body('c'), 'f'.repeat(40), base)).rejects.toMatchObject({ status: 422 });
});
it('Worker route authenticates before reading a raw body and GET refs reaches the same owning-claim gate', async () => {
    const one = await claim(), sibling = await claim();
    const stored = new Map(), state = { storage: { put: async (k: string, v: any) => stored.set(k, v), get: async (k: string) => stored.get(k), setAlarm: async () => { }, getAlarm: async () => null } } as any;
    const coordinator = new TaskCoordinator(state, env);
    let read = false;
    const request = new Request(`https://api.example/v1/tasks/${one.task}/lane/receive-pack`, { method: 'POST', headers: { Authorization: `Bearer ${sibling.token}` }, body: new ReadableStream({ pull() { read = true; throw new Error('must not read'); } }), duplex: 'half' } as any);
    const spy = vi.spyOn(request.body!, 'getReader');
    const response = await coordinator.fetch(request);
    expect(response.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
    expect((await coordinator.fetch(new Request(`https://api.example/tasks/${one.task}/lane/receive-pack/refs`, { headers: { Authorization: `Bearer ${sibling.token}` } }))).status).toBe(403);
});
it('fails closed on truncated or checksum-corrupt packs and safely scans large dynamic/stored DEFLATE blocks', async () => {
    const content = Buffer.alloc(100000);
    for (let i = 0; i < content.length; i++)
        content[i] = i % 251;
    const pack = rawPack(3, content);
    await expect(verifyPackAncestry(body('c', pack), source, base)).rejects.toMatchObject({ status: 422 });
    const corrupt = Buffer.from(full);
    corrupt[corrupt.length - 1] ^= 1;
    await expect(verifyPackAncestry(body('c', corrupt), source, base)).rejects.toMatchObject({ status: 422 });
    await expect(verifyPackAncestry(body('c', full.subarray(0, -7)), source, base)).rejects.toMatchObject({ status: 422 });
});
it.each(['sideband', 'malformed'] as const)('classifies framed %s report without matching diagnostics and returns raw report unchanged', async (outcome) => {
    const { task, c, token } = await claim();
    currentClaim = c;
    resolveRemote();
    const b = broker(undefined, outcome), record = vi.fn();
    if (outcome === 'malformed') {
        await expect(b.service.pushWorkerNative(req(token), task, body(c), record)).rejects.toMatchObject({ code: 'upstream-ambiguous' });
        expect(record).not.toHaveBeenCalled();
    }
    else {
        const response = await b.service.pushWorkerNative(req(token), task, body(c), record);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(b.report);
        expect(record).toHaveBeenCalledOnce();
    }
    expect(b.provider.revokeToken).toHaveBeenCalledTimes(2);
});
it('HTTP end-to-end: plain receive-pack, minimal second push, merged-main push and guarded base observation', async () => {
    const { task, c, token } = await claim(), canonical = mkdtempSync(join(tmpdir(), 'worker-push-canonical-'));
    extraPaths.push(canonical);
    git('clone', '--bare', root, canonical);
    git('--git-dir', canonical, 'update-ref', 'refs/heads/main', base);
    let issued = 0, revoked = 0, writes = 0, advertisements = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: any, options: any = {}) => {
        const path = new URL(String(url)).pathname;
        if (path.includes('/tokens')) {
            if (options.method === 'DELETE') {
                revoked++;
                return Response.json({ success: true, result: {} });
            }
            const input = JSON.parse(options.body);
            issued++;
            return Response.json({ success: true, result: { id: `provider-${issued}`, plaintext: 'server-only', scope: input.scope, expires_at: new Date(Date.now() + input.ttl * 1000).toISOString() } });
        }
        if (path.endsWith('/info/refs')) {
            advertisements++;
            const refs = execFileSync('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', canonical]);
            return new Response(Buffer.concat([pkt('# service=git-upload-pack\n'), Buffer.from('0000'), refs]), { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } });
        }
        if (path.endsWith('/git-receive-pack')) {
            writes++;
            expect(options.headers.Authorization).toBe('Bearer server-only');
            return new Response(execFileSync('git', ['receive-pack', '--stateless-rpc', canonical], { input: options.body }));
        }
        return Response.json({ success: true, result: { remote } });
    }));
    const stored = new Map(), coordinator = new TaskCoordinator({ storage: { put: async (k: string, v: any) => stored.set(k, v), get: async (k: string) => stored.get(k), setAlarm: async () => { }, getAlarm: async () => null } } as any, env);
    const push = async (pack: Buffer, sha: string, old: string) => {
        const response = await coordinator.fetch(new Request(`https://api.example/v1/tasks/${task}/lane/receive-pack`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-git-receive-pack-request' }, body: body(c, pack, old, sha) }));
        expect(response.status, await response.clone().text()).toBe(200);
        const report = await response.text();
        expect(report).toContain(`ok refs/octocove/claims/${c}\n`);
        return report;
    };
    const ad = await coordinator.fetch(new Request(`https://api.example/v1/tasks/${task}/lane/receive-pack/refs`, { headers: { Authorization: `Bearer ${token}` } }));
    expect(ad.status).toBe(200);
    expect(await ad.text()).toContain('capabilities^{}');
    await push(full, source, '0'.repeat(40));
    git('checkout', '-B', `second-${task}`, source);
    writeFileSync(join(root, 'second-change'), 'second');
    git('add', '.');
    git('commit', '-m', 'second');
    const second = git('rev-parse', 'HEAD');
    const pack = (sha: string, excludes: string[]) => execFileSync('git', ['pack-objects', '--stdout', '--revs', '--no-reuse-delta', '--window=0'], { cwd: root, input: [sha, ...excludes.map(s => `^${s}`), ''].join('\n') });
    const secondPack = pack(second, [source]), secondReport = await push(secondPack, second, source);
    git('checkout', '-B', `other-${task}`, base);
    writeFileSync(join(root, 'other-change'), 'canonical move');
    git('add', '.');
    git('commit', '-m', 'canonical advanced');
    const head = git('rev-parse', 'HEAD');
    git('--git-dir', canonical, 'fetch', root, `${head}:refs/heads/main`);
    git('checkout', `second-${task}`);
    git('merge', '--no-ff', '--no-edit', head);
    const merged = git('rev-parse', 'HEAD');
    await push(pack(merged, [second, head]), merged, second);
    expect(git('--git-dir', canonical, 'rev-parse', `refs/octocove/claims/${c}`)).toBe(merged);
    const candidate = await life.one("SELECT * FROM candidates WHERE task_id=? AND status='active'", task);
    expect(candidate).toMatchObject({ candidate_sha: merged, base_sha: head });
    expect((await life.one('SELECT known_head_sha FROM target_refs WHERE repository_id=?', 'canonical')).known_head_sha).toBe(head);
    expect((await life.one('SELECT base_sha FROM chain_lane_attempts WHERE claim_id=?', c)).base_sha).toBe(base);
    expect(await life.rows("SELECT * FROM lifecycle_outbox WHERE task_id=? AND kind='compute'", task)).toEqual([]);
    expect((await life.approve(task, human, key(`final-approve-${task}`), { candidateId: candidate.id, boundTo: { candidateSha: merged, baseSha: head, intentVersion: 1 } })).status).toBe(201);
    expect(writes).toBe(3);
    expect(revoked).toBe(issued);
    const before = await life.one('SELECT generation FROM canonical_generations WHERE repository_id=? AND ref_name=?', 'canonical', 'refs/heads/main');
    const readCount = advertisements, tokenCount = issued;
    expect(await push(secondPack, second, source)).toBe(secondReport);
    expect(writes).toBe(3);
    expect(advertisements).toBe(readCount);
    expect(issued).toBe(tokenCount);
    expect(await life.one('SELECT generation FROM canonical_generations WHERE repository_id=? AND ref_name=?', 'canonical', 'refs/heads/main')).toEqual(before);
    const conflicting = body(c, secondPack, '0'.repeat(40), second);
    const denied = await coordinator.fetch(new Request(`https://api.example/v1/tasks/${task}/lane/receive-pack`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: conflicting }));
    expect(denied.status).toBe(409);
    expect((await denied.json() as any).code).toBe('idempotency-conflict');
    expect(advertisements).toBe(readCount);
    expect(writes).toBe(3);
}, 60000);
it('accepts bounded commit streams across zlib strategies and rejects parent headers outside the Git parent section', async () => {
    for (const length of [0, 32, 512, 8192, 65536])
        for (const level of [0, 6, 9]) {
            const commit = Buffer.from(`tree ${'a'.repeat(40)}\nparent ${base}\nauthor Test <test@example.com> 0 +0000\ncommitter Test <test@example.com> 0 +0000\n\n${'message '.repeat(length)}`);
            const oid = createHash('sha1').update(Buffer.concat([Buffer.from(`commit ${commit.length}\0`), commit])).digest('hex');
            expect(await verifyPackAncestry(body('c', rawPack(1, commit, level), undefined, oid), oid, base)).toBe(base);
        }
    const invalid = Buffer.from(`tree ${'a'.repeat(40)}\nauthor Test <test@example.com> 0 +0000\nparent ${base}\n\nmessage`);
    const oid = createHash('sha1').update(Buffer.concat([Buffer.from(`commit ${invalid.length}\0`), invalid])).digest('hex');
    await expect(verifyPackAncestry(body('c', rawPack(1, invalid), undefined, oid), oid, base)).rejects.toMatchObject({ status: 422 });
});
it('refuses a stale canonical observation generation before minting a write token', async () => {
    const { task, c, token } = await claim();
    currentClaim = c;
    resolveRemote();
    const b = broker(undefined, 'written', source), record = vi.fn();
    await expect(b.service.pushWorkerNative(req(token), task, body(c), record, undefined, async (head, generation) => {
        await reserveCanonicalRead(db, 'canonical', 'refs/heads/main');
        await life.baseMoved(task, key(`stale-${task}`), head, false, generation);
    })).rejects.toMatchObject({ code: 'operation-in-progress' });
    expect(b.provider.createToken.mock.calls.map(c => c[1])).toEqual(['read']);
    expect(record).not.toHaveBeenCalled();
    expect((await life.one('SELECT known_head_sha FROM target_refs WHERE repository_id=?', 'canonical')).known_head_sha).toBe(base);
});
it('exposes stale plus currentHead to CLI polling and retains the approval refusal', async () => {
    const { task, c, token } = await claim();
    currentClaim = c;
    resolveRemote();
    const b = broker(undefined, 'written', 'f'.repeat(40));
    await b.service.pushWorkerNative(req(token), task, body(c), async (claim, sha, pushId, candidateBase) => { await life.recordWrittenCandidate(task, claim, sha, pushId, candidateBase); }, undefined, async (head, generation) => { await life.baseMoved(task, key(`observe-${task}`), head, false, generation); });
    const candidate = await life.one('SELECT * FROM candidates WHERE task_id=?', task), view = (await life.candidateStatus(task, candidate.submission_id)).body.candidate;
    expect(view).toMatchObject({ status: 'stale', currentHead: 'f'.repeat(40), baseSha: base });
    await expect(life.approve(task, human, key(`stale-approve-${task}`), { candidateId: candidate.id, boundTo: { candidateSha: source, baseSha: base, intentVersion: 1 } })).rejects.toMatchObject({ status: 409 });
});
it('bootstrap HTTP claim returns ready canonical workspace with no Artifacts queue or provisioner', async () => {
    const task = `bootstrap-native-${++seq}`;
    await db.prepare('UPDATE target_refs SET known_head_sha=? WHERE repository_id=?').bind(base, 'canonical').run();
    await life.create(task, human, key(`create-${task}`), { ...intent, projectId: 'p', repositoryId: 'canonical', targetRef: 'refs/heads/main', key: task });
    await life.publish(task, human, key(`publish-${task}`));
    await db.prepare('UPDATE auth_memberships SET verbs=? WHERE project_id=? AND issuer=? AND sub=?').bind(JSON.stringify(['tasks:claim', 'submissions:create']), 'p', fixtureAuthorizer.issuer, fixtureAuthorizer.sub).run();
    const authorization = await auth.preauthorize({ ...fixtureAuthorizer, familyId: 'fixture-family', absoluteExpiry: Math.floor(Date.now() / 1000) + 3600 } as any, 'p', task, 'http-agent', ['submissions:create'], 1800);
    resolveRemote();
    const stored = new Map(), coordinator = new TaskCoordinator({ storage: { put: async (k: string, v: any) => stored.set(k, v), get: async (k: string) => stored.get(k), setAlarm: async () => { }, getAlarm: async () => null } } as any, env);
    expect(env.ARTIFACTS_QUEUE_ID).toBeUndefined();
    const response = await coordinator.fetch(new Request(`https://api.example/v1/tasks/${task}/claim`, { method: 'POST', headers: { Authorization: `Bearer ${authorization.bootstrapToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': key(`claim-${task}`) }, body: JSON.stringify({ intentVersion: 1, chain: { id: `chain-${task}`, baseSha: base } }) }));
    const result: any = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(201);
    expect(result.claim).toMatchObject({ provisioningState: 'ready', workspace: { remote, ref: `refs/octocove/claims/${authorization.claimAttemptId}`, baseSha: base } });
    await expect(new TokenBroker(env).admitWorkerPush(req(result.delegation.accessToken), task)).resolves.toMatchObject({ claim: { id: authorization.claimAttemptId } });
});
it('alarm recovers a durably written source after lifecycle interruption without another provider write', async () => {
    const { task, c, token } = await claim();
    currentClaim = c;
    resolveRemote();
    const b = broker();
    await expect(b.service.pushWorkerNative(req(token), task, body(c), async () => { throw new Error('interrupted lifecycle recording'); })).rejects.toThrow('interrupted lifecycle recording');
    expect(await life.rows('SELECT * FROM candidates WHERE task_id=?', task)).toEqual([]);
    expect(await life.rows("SELECT * FROM worker_native_pushes WHERE task_id=? AND status='written'", task)).toHaveLength(1);
    const stored = new Map<string, any>([['taskId', task]]), coordinator = new TaskCoordinator({ storage: { put: async (k: string, v: any) => stored.set(k, v), get: async (k: string) => stored.get(k), setAlarm: async () => { }, getAlarm: async () => null } } as any, env);
    await coordinator.alarm();
    expect(await life.one('SELECT candidate_sha FROM candidates WHERE task_id=?', task)).toMatchObject({ candidate_sha: source });
    expect(b.http.mock.calls.filter(c => String(c[0]).endsWith('/git-receive-pack'))).toHaveLength(1);
    expect(b.provider.revokeToken).toHaveBeenCalledTimes(2);
});
it('native no-check candidate is final to the outbox oracle and is never redriven', async () => {
    const { task, c, token } = await claim();
    currentClaim = c;
    resolveRemote();
    const b = broker();
    await b.service.pushWorkerNative(req(token), task, body(c), async (claim, sha, pushId, candidateBase) => { await life.recordWrittenCandidate(task, claim, sha, pushId, candidateBase); });
    const candidate = await life.one('SELECT * FROM candidates WHERE task_id=?', task);
    const check = await life.one('SELECT * FROM candidate_checks WHERE candidate_id=?', candidate.id);
    expect(check).toMatchObject({ run_id: `${candidate.compute_run_id}:checks`, result: 'skipped', check_identity: candidate.check_identity });
    expect(JSON.parse(check.evidence)).toEqual({ version: 1, commands: [] });
    await db.prepare('INSERT INTO lifecycle_outbox VALUES(?,?,?,?,NULL)').bind(candidate.compute_run_id, task, 'compute', JSON.stringify({ submissionId: candidate.submission_id, intentVersion: 1, expectedBaseSha: base })).run();
    expect((await life.one(`SELECT ${unfinishedLifecycle} AS unfinished FROM lifecycle_outbox j WHERE run_id=?`, candidate.compute_run_id)).unfinished).toBe(0);
    const queue = { send: vi.fn() };
    await life.dispatch(queue as any, task);
    await life.dispatch(queue as any, task);
    expect(queue.send).not.toHaveBeenCalled();
});
it('mints audited canonical READ credentials for the owning agent with TTL at most900 and still refuses WRITE', async () => {
    const { task, c, token } = await claim(['submissions:create', 'tasks:read']), b = broker();
    const result = await b.service.mint(req(token), { taskId: task, scope: 'read', ttl: 3600 });
    expect(result).toMatchObject({ repo: 'canonical', scope: 'read', token: 'server-only' });
    expect(b.provider.createToken).toHaveBeenCalledWith(expect.objectContaining({ id: 'canonical', provider: 'artifacts' }), 'read', 900);
    expect(Date.parse(result.expiresAt) - Date.now()).toBeLessThanOrEqual(900000);
    const ledger = await life.one('SELECT * FROM broker_tokens WHERE id=?', result.id);
    expect(ledger).toMatchObject({ grant_id: `grant-${c}`, scope: 'read', owner: JSON.stringify(['agent', `d-${c}`]), provider_id: expect.any(String) });
    expect(JSON.stringify(ledger)).not.toContain('server-only');
    await expect(b.service.mint(req(token), { taskId: task, scope: 'write' })).rejects.toMatchObject({ status: 403, code: 'chain-push-queue-required' });
    const sibling = await claim(['submissions:create', 'tasks:read']);
    await expect(b.service.mint(req(sibling.token), { taskId: task, scope: 'read' })).rejects.toMatchObject({ status: 403 });
    expect(b.provider.createToken).toHaveBeenCalledOnce();
    await b.service.revoke(req(token), result.id);
    expect(b.provider.revokeToken).toHaveBeenCalledOnce();
});
it('refuses a human owner canonical native READ token and audits it, leaving provider untouched', async () => {
    const task = `native-human-read-${++seq}`, c = `claim-${task}`;
    await db.prepare('UPDATE target_refs SET known_head_sha=? WHERE repository_id=?').bind(base, 'canonical').run();
    await life.create(task, human, key(`create-${task}`), { ...intent, projectId: 'p', repositoryId: 'canonical', targetRef: 'refs/heads/main', key: task });
    await life.publish(task, human, key(`publish-${task}`));
    await life.claim(task, key(`claim-${task}`), { id: c, actor: { type: 'human', id: `${fixtureAuthorizer.issuer}|${fixtureAuthorizer.sub}` }, intentVersion: 1, expiresAt: new Date(Date.now() + 3600000).toISOString(), chain: { id: `chain-${task}`, baseSha: base } });
    const humanToken = ['ocs', 'native-human'].join('_');
    await db.prepare('INSERT INTO auth_sessions(hash,family_id,csrf_hash,expires) VALUES(?,?,?,?) ON CONFLICT(hash) DO NOTHING').bind(await hash(humanToken), 'fixture-family', 'csrf', Math.floor(Date.now() / 1000) + 600).run();
    const b = broker();
    await expect(b.service.mint(req(humanToken), { taskId: task, scope: 'read' })).rejects.toMatchObject({ status: 403, code: 'chain-writer-denied' });
    expect(b.provider.createToken).not.toHaveBeenCalled();
    expect(await life.rows('SELECT scope FROM broker_admission_audit WHERE task_id=? AND code=?', task, 'chain-writer-denied')).toEqual([{ scope: 'read' }]);
});
it('HTTP broker token route returns canonical read scope to the delegated helper without exposing write authority', async () => {
    const { task, token } = await claim(['submissions:create', 'tasks:read']);
    const provider = vi.fn(async (_url: any, options: any) => { const input = JSON.parse(options.body); expect(input.repo).toBe('canonical'); expect(input.scope).toBe('read'); expect(input.ttl).toBeLessThanOrEqual(900); return Response.json({ success: true, result: { id: 'http-read', plaintext: 'read-only', scope: 'read', expires_at: new Date(Date.now() + input.ttl * 1000).toISOString() } }); });
    vi.stubGlobal('fetch', provider);
    const stored = new Map(), coordinator = new TaskCoordinator({ storage: { put: async (k: string, v: any) => stored.set(k, v), get: async (k: string) => stored.get(k), setAlarm: async () => { }, getAlarm: async () => null } } as any, env);
    const response = await coordinator.fetch(new Request(`https://api.example/tasks/${task}/broker/token`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: task, scope: 'read' }) }));
    const result: any = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(201);
    expect(result).toMatchObject({ repo: 'canonical', scope: 'read', token: 'read-only' });
    expect(provider).toHaveBeenCalledOnce();
});
it('two-agent native HTTP push and land advances canonical for the second approval', async () => {
    const a = await claim(), b = await claim();
    const canonical = mkdtempSync(join(tmpdir(), 'native-two-agent-'));
    extraPaths.push(canonical);
    git('clone', '--bare', root, canonical);
    git('--git-dir', canonical, 'update-ref', 'refs/heads/main', base);
    let issued = 0, revoked = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: any, options: any = {}) => {
        const path = new URL(String(url)).pathname;
        if (path.includes('/tokens')) {
            if (options.method === 'DELETE') {
                revoked++;
                return Response.json({ success: true, result: {} });
            }
            const input = JSON.parse(options.body);
            issued++;
            return Response.json({ success: true, result: { id: `two-agent-${issued}`, plaintext: 'server-only',
                    scope: input.scope, expires_at: new Date(Date.now() + input.ttl * 1000).toISOString() } });
        }
        if (path.endsWith('/info/refs'))
            return new Response(Buffer.concat([pkt('# service=git-upload-pack\n'), Buffer.from('0000'),
                execFileSync('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', canonical])]), { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } });
        if (path.endsWith('/git-receive-pack'))
            return new Response(execFileSync('git', ['receive-pack', '--stateless-rpc', canonical], { input: options.body }), { headers: { 'Content-Type': 'application/x-git-receive-pack-result' } });
        return Response.json({ success: true, result: { remote } });
    }));
    const nativeEnv = { ...env };
    const coordinators = new Map<string, TaskCoordinator>();
    for (const actor of [a, b]) {
        const stored = new Map();
        coordinators.set(actor.task, new TaskCoordinator({ storage: { put: async (k: string, v: any) => stored.set(k, v),
                get: async (k: string) => stored.get(k), setAlarm: async () => { }, getAlarm: async () => null } } as any, nativeEnv));
    }
    nativeEnv.TASKS = { idFromName: (id: string) => id, get: (id: string) => ({
            fetch: (url: string, init: any) => coordinators.get(id)!.fetch(new Request(url, init))
        }) };
    const push = async (actor: typeof a, pack: Buffer, sha: string) => {
        const response = await coordinators.get(actor.task)!.fetch(new Request(`https://api.example/v1/tasks/${actor.task}/lane/receive-pack`, {
            method: 'POST', headers: { Authorization: `Bearer ${actor.token}`, 'Content-Type': 'application/x-git-receive-pack-request' },
            body: body(actor.c, pack, '0'.repeat(40), sha)
        }));
        expect(response.status, await response.clone().text()).toBe(200);
    };
    const land = async (actor: typeof a, sha: string, candidateBase: string) => {
        const candidate = await life.one("SELECT * FROM candidates WHERE task_id=? AND status='active'", actor.task);
        expect(candidate).toMatchObject({ candidate_sha: sha, base_sha: candidateBase });
        const approval = await life.approve(actor.task, human, key(`two-approve-${actor.task}`), {
            candidateId: candidate.id, boundTo: { candidateSha: sha, baseSha: candidateBase, intentVersion: 1 }
        });
        const landing = await life.land(actor.task, human, key(`two-land-${actor.task}`), { approvalId: approval.body.id });
        await enqueueIntegrator(nativeEnv, { kind: 'land', runId: landing.body.runId });
        expect(await life.one('SELECT outcome,landed_sha FROM landing_receipts WHERE id=?', landing.body.receiptId))
            .toEqual({ outcome: 'landed', landed_sha: sha });
        expect((await life.one("SELECT known_head_sha FROM target_refs WHERE repository_id='canonical' AND ref_name='refs/heads/main'")).known_head_sha).toBe(sha);
    };
    await push(a, full, source);
    await land(a, source, base);
    git('checkout', '-B', `pair-${b.task}`, source);
    writeFileSync(join(root, 'second-change'), 'agent B');
    git('add', '.');
    git('commit', '-m', 'agent B');
    const second = git('rev-parse', 'HEAD');
    const pack = execFileSync('git', ['pack-objects', '--stdout', '--revs', '--no-reuse-delta', '--window=0'], { cwd: root, input: `${second}\n^${source}\n` });
    await push(b, pack, second);
    await land(b, second, source);
    expect(git('--git-dir', canonical, 'rev-parse', 'refs/heads/main')).toBe(second);
    expect((await life.one('SELECT base_sha FROM chain_lane_attempts WHERE claim_id=?', b.c)).base_sha).toBe(base);
    expect(revoked).toBe(issued);
});
