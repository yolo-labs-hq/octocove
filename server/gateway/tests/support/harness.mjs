import { fork, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPki } from './pki.mjs';
import { startProvider } from './provider.mjs';
import { startService } from './service.mjs';
import { send } from './net.mjs';
import { AttemptHelper, proofAuthority } from '../../../../packages/helper/src/index.mjs';
const CONNECT = fileURLToPath(new URL('../../../../packages/helper/bin/octocove-helper-connect.mjs', import.meta.url));
const ATTACKER = fileURLToPath(new URL('./attacker.mjs', import.meta.url));
export const AUDIENCE = 'octocove-gateway:local-acceptance', REPO = 'canonical', ZERO = '0'.repeat(40);
export const PRINCIPALS = ['alpha', 'beta', 'preview', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'lat-legacy', 'lat-proof', 'attacker'];
const gitEnv = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Octocove test', GIT_AUTHOR_EMAIL: 't@octocove.invalid',
    GIT_COMMITTER_NAME: 'Octocove test', GIT_COMMITTER_EMAIL: 't@octocove.invalid', GIT_AUTHOR_DATE: '2026-10-05T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-05T00:00:00Z' };
export function git(args, { cwd, env, input } = {}) {
    return new Promise(resolve => {
        const child = spawn('git', args, { cwd, env: { ...process.env, ...gitEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
        const out = [], err = [];
        child.stdout.on('data', d => out.push(d));
        child.stderr.on('data', d => err.push(d));
        child.on('close', code => resolve({ code, out: Buffer.concat(out), stdout: Buffer.concat(out).toString().trim(), stderr: Buffer.concat(err).toString().trim() }));
        child.stdin.end(input);
    });
}
const pkt = text => { const b = Buffer.from(text); return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]); };
export async function createHarness({ repos = [REPO] } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'octocove-proof-acceptance-'));
    const manifest = { root, created: [], processes: [], removed: false };
    const dirs = { pki: join(root, 'pki'), provider: join(root, 'provider'), ledger: join(root, 'ledger'), work: join(root, 'work') };
    for (const d of Object.values(dirs)) {
        await mkdir(d, { recursive: true, mode: 0o700 });
        manifest.created.push(d);
    }
    const pki = await createPki(dirs.pki, PRINCIPALS);
    const seed = join(dirs.work, 'seed');
    await git(['init', '-q', seed]);
    await writeFile(join(seed, 'README'), 'octocove local acceptance\n');
    await git(['add', '.'], { cwd: seed });
    await git(['commit', '-qm', 'base'], { cwd: seed });
    const base = (await git(['rev-parse', 'HEAD'], { cwd: seed })).stdout;
    for (const repo of repos) {
        const bare = join(dirs.provider, `${repo}.git`);
        await git(['init', '--bare', '-q', bare]);
        await git(['-C', bare, 'config', 'http.receivepack', 'true']);
        await git(['push', '-q', bare, 'HEAD:refs/heads/main', 'HEAD:refs/heads/lane/beta'], { cwd: seed });
    }
    const writerCredential = { id: 'w1', secret: `art_v1_${randomBytes(24).toString('hex')}` };
    const keyConfig = { active: 'k1', keys: [{ kid: 'k1', secret: randomBytes(32).toString('base64url') }] };
    const secrets = new Set([writerCredential.secret, keyConfig.keys[0].secret, ...PRINCIPALS.map(n => pki[n].key.split('\n')[1])]);
    const provider = await startProvider({ root: dirs.provider, credentials: [writerCredential.secret] });
    const grants = new Map(), helpers = new Set();
    const launch = async () => {
        const svc = await startService({ ledgerPath: join(dirs.ledger, 'ledger.json'), auditLog: join(dirs.ledger, 'audit.jsonl'), keyConfig, audience: AUDIENCE,
            providerUrl: provider.url(REPO), writerCredential, tls: { key: pki.server.key, cert: pki.server.cert, ca: pki.ca.pem } });
        manifest.processes.push({ role: 'service', pid: svc.pid });
        for (const [principal, grant] of grants)
            await svc.call('grant', { principal, grant });
        return svc;
    };
    const h = {
        root, dirs, pki, provider, base, manifest, secrets, writerCredential, keyConfig, svc: await launch(), logs: [],
        url: (port, path = '') => `https://127.0.0.1:${port}/repos/${REPO}/${path}`,
        async grant(principal, overrides = {}) {
            const grant = { id: `grant-${principal}`, attempt: `attempt-${principal}`, tenant: 'acme', project: 'proj', repo: REPO, lane: principal,
                scope: 'write', policyVersion: 'p1', expiresAt: Date.now() + 1800000, active: true, ...overrides };
            grants.set(principal, grant);
            await h.svc.call('grant', { principal, grant });
            return grant;
        },
        async attempt(principal, { ttl = 900, cert = principal, ...overrides } = {}) {
            const grant = await h.grant(principal, overrides);
            const lease = await h.svc.call('mint', { principal, ttl });
            secrets.add(lease.token);
            await h.svc.call('openChannel', { principal, token: lease.token, channel: pki[cert].channel });
            return { principal, grant, token: lease.token, lease, tls: pki[cert], channel: pki[cert].channel, ref: `refs/heads/lane/${grant.lane}` };
        },
        async lane(who, { port = h.svc.proofPort, proof = true, name = who.principal, onTiming } = {}) {
            const dir = join(dirs.work, `lane-${name}-${randomBytes(3).toString('hex')}`), runtime = join(dirs.work, `runtime-${name}-${randomBytes(3).toString('hex')}`);
            await git(['clone', '-q', join(dirs.provider, `${REPO}.git`), dir]);
            await git(['remote', 'remove', 'origin'], { cwd: dir });
            const authority = proofAuthority({ grant: helperGrant(who), gatewayUrl: `https://127.0.0.1:${port}`, repoId: REPO, lease: async () => who.token,
                tls: { key: who.tls.key, cert: who.tls.cert, ca: pki.ca.pem, keyFile: who.tls.keyFile, certFile: who.tls.certFile, caFile: pki.ca.certFile }, proof, onTiming });
            const helper = new AttemptHelper({ grant: authority.grant, runtimeDir: runtime, authority, peer: { domainConfinedByRuntime: true } });
            await helper.start();
            const handle = { helper, authority, close: async () => { authority.close(); await helper.close(); } };
            helpers.add(handle);
            await git(['remote', 'add', 'octo', `ext::${process.execPath} ${CONNECT} %s`], { cwd: dir });
            await git(['config', 'protocol.ext.allow', 'always'], { cwd: dir });
            const env = { OCTOCOVE_HELPER_SOCK: helper.socketPath };
            return { dir, env, handle,
                commit: async (label) => { await writeFile(join(dir, 'change.txt'), `${label} ${randomBytes(4).toString('hex')}\n`); await git(['add', '.'], { cwd: dir }); await git(['commit', '-qm', label], { cwd: dir }); return (await git(['rev-parse', 'HEAD'], { cwd: dir })).stdout; },
                push: async (...args) => { const t = performance.now(); const r = await git(['push', ...args], { cwd: dir, env }); return { ...r, ms: performance.now() - t }; } };
        },
        async body(dir, ref, oldSha, newSha) {
            const pack = newSha === ZERO ? Buffer.alloc(0) : (await git(['pack-objects', '--stdout', '--revs', '-q'], { cwd: dir, input: `${newSha}\n${oldSha === ZERO ? '' : `^${oldSha}\n`}` })).out;
            return Buffer.concat([pkt(`${oldSha} ${newSha} ${ref}\0report-status\n`), Buffer.from('0000'), pack]);
        },
        async issue(who, body, { tls = who.tls, commands, port = h.svc.proofPort, localAddress } = {}) {
            const line = body.subarray(4, 4 + 81 + who.ref.length + 1).toString('latin1');
            const [oldSha, newSha] = line.split(' ');
            const r = await send({ url: h.url(port, 'push-proof'), headers: { authorization: `Bearer ${who.token}`, 'content-type': 'application/json' },
                body: Buffer.from(JSON.stringify({ v: 1, commands: commands ?? [{ old: oldSha, new: newSha, ref: who.ref }], bodyDigest: createHash('sha256').update(body).digest('hex') })),
                tls, ca: pki.ca.pem, localAddress });
            return r.status === 200 ? { status: 200, proof: JSON.parse(r.text).proof } : { status: r.status, error: r.text };
        },
        async push(who, body, proof, { tls = who.tls, port = h.svc.proofPort, token = who.token, localAddress } = {}) {
            const r = await send({ url: h.url(port, 'git-receive-pack'), body, tls, ca: pki.ca.pem, localAddress,
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-git-receive-pack-request', ...(proof ? { 'x-octocove-push-proof': proof } : {}) } });
            return { ...r, outcome: outcome(r) };
        },
        async attacker(actions) {
            const child = fork(ATTACKER, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
            manifest.processes.push({ role: 'attacker', pid: child.pid });
            const result = new Promise(r => child.once('message', r));
            child.send({ actions: actions.map(a => ({ ca: pki.ca.pem, ...a, ...(a.body ? { bodyB64: a.body.toString('base64'), body: undefined } : {}) })) });
            const { results, pid } = await result;
            await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r));
            return { pid, results: results.map(x => Array.isArray(x) ? x.map(y => ({ ...y, outcome: outcome(y) })) : { ...x, outcome: outcome(x) }) };
        },
        snapshot: async (repo = REPO) => Object.fromEntries((await git(['for-each-ref', '--format=%(refname) %(objectname)'], { cwd: join(dirs.provider, `${repo}.git`) }))
            .stdout.split('\n').filter(Boolean).map(l => l.split(' '))),
        async counters() { const w = await h.svc.call('writer').catch(() => null); return { providerWrites: provider.state.upstreamWrites, providerDenied: provider.state.deniedWrites, gatewayWrites: w?.counters.writes ?? null }; },
        async restart() { h.logs.push(h.svc.output()); await h.svc.kill(); h.svc = await launch(); },
        async cleanup() {
            for (const handle of helpers)
                await handle.close().catch(() => { });
            h.logs.push(h.svc.output());
            const exit = await h.svc.kill();
            await provider.close();
            await rm(root, { recursive: true, force: true });
            manifest.removed = true;
            manifest.serviceExit = exit;
            return manifest;
        },
    };
    return h;
}
function helperGrant(who) {
    return { tenant: who.grant.tenant, project: who.grant.project, attempt: who.grant.attempt, repo: REPO, ref: who.ref,
        operation: who.grant.scope, policyVersion: who.grant.policyVersion, expiresAt: who.lease.expiresAt };
}
export function outcome(r) {
    if (r.status === 0)
        return `net-${r.text}`;
    const unpack = /unpack ([a-z-]+)/.exec(r.text)?.[1];
    if (r.status === 200 && unpack === 'ok')
        return /ng refs\//.test(r.text) || !/ok refs\//.test(r.text) ? 'ng' : 'ok';
    if (unpack)
        return unpack;
    return r.status >= 400 ? (/^[a-z][a-z0-9-]{1,40}$/.test(r.text.trim()) ? r.text.trim() : `http-${r.status}`) : `http-${r.status}`;
}
