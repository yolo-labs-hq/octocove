import { fork } from 'node:child_process';
import { createServer } from 'node:https';
import { Readable } from 'node:stream';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGateway, createGrantCache } from '../../src/worker.mjs';
import { ProofBroker } from '../../src/proof-broker.mjs';
import { ProofKeyring } from '../../src/proof.mjs';
import { JournalStore } from '../../src/journal-store.mjs';
import { UpstreamWriter } from '../../src/upstream-writer.mjs';
const SELF = fileURLToPath(import.meta.url);
export async function startService(init) {
    const child = fork(SELF, ['--service'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let next = 0, output = '';
    const pending = new Map();
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { output += d; });
    child.on('message', m => { const p = pending.get(m.id); if (p) {
        pending.delete(m.id);
        m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
    } });
    const exited = new Promise(r => child.on('exit', (code, signal) => { for (const p of pending.values())
        p.reject(new Error('service-exited')); pending.clear(); r({ code, signal }); }));
    const call = (op, args) => new Promise((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode)
            return reject(new Error('service-exited'));
        const id = ++next;
        pending.set(id, { resolve, reject });
        child.send({ id, op, args });
    });
    const ports = await call('init', init);
    return { ...ports, pid: child.pid, call, exited, output: () => output,
        kill: async () => { if (child.exitCode === null && !child.signalCode)
            child.kill('SIGKILL'); return exited; } };
}
if (process.argv[2] === '--service') {
    let broker, writer, keyring, flags = { brokerDown: false, crashAfterConsume: false }, audits = [], servers = [];
    const grants = new Map();
    const audit = file => async (event) => { audits.push(event); if (file)
        appendFileSync(file, `${JSON.stringify(event)}\n`); };
    const handlers = {
        async init({ ledgerPath, auditLog, keyConfig, audience, providerUrl, writerCredential, tls, debugTiming = true }) {
            keyring = await ProofKeyring.fromConfig(keyConfig);
            writer = new UpstreamWriter({ remote: providerUrl, credential: writerCredential, audit: audit(auditLog) });
            const authority = {
                resolve: async (principal) => { const g = grants.get(principal); if (!g)
                    throw new Error('denied'); return g; },
                current: async (lease) => grants.get(lease.principal),
                upstream: async (grant, operation, context) => writer.ticket(grant, operation, context),
                observe: async ({ ref }) => {
                    const { ticket } = writer.ticket({ repo: 'canonical', attempt: 'reconciler' }, 'read');
                    const res = await writer.forward(ticket, { route: 'info/refs', search: '?service=git-upload-pack', method: 'GET' });
                    const text = await res.text();
                    return [...text.matchAll(/([0-9a-f]{40}) (refs\/[^\0\n]+)/g)].find(m => m[2] === ref)?.[1] ?? null;
                },
            };
            broker = new ProofBroker({ store: new JournalStore(ledgerPath), authority, keyring, audience, audit: audit(auditLog) });
            const guard = fn => async (input) => { if (flags.brokerDown)
                throw new Error('broker-unreachable'); return fn(input); };
            const transport = new WeakMap();
            const proofGateway = createGateway({ debugTiming, grantCache: createGrantCache(),
                authorize: guard(i => broker.authorizeChannel(i)),
                admit: guard(async (i) => {
                    const admission = await broker.admitProof(i);
                    if (flags.crashAfterConsume && i.mutating)
                        process.kill(process.pid, 'SIGKILL');
                    return admission;
                }),
                writer,
                proof: { keyring, audience, channel: r => transport.get(r) ?? null, issue: guard(i => broker.issueProof(i)), complete: guard(i => broker.completeWrite(i)) } });
            const legacyGateway = createGateway({ debugTiming, grantCache: createGrantCache(),
                authorize: guard(i => broker.authorize(i)),
                admit: guard(async (i) => { const admission = await broker.authorize(i, true); return { ...admission, ...writer.ticket(admission, i.operation, { mutating: i.mutating }) }; }),
                writer });
            const listen = gateway => new Promise(resolve => {
                const server = createServer({ key: tls.key, cert: tls.cert, ca: tls.ca, requestCert: true, rejectUnauthorized: false }, async (req, res) => {
                    try {
                        const headers = new Headers();
                        for (const [k, v] of Object.entries(req.headers))
                            if (typeof v === 'string')
                                headers.set(k, v);
                        const request = new Request(`https://gateway.local${req.url}`, { method: req.method, headers, duplex: 'half',
                            ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Readable.toWeb(req) }) });
                        const cert = req.socket.authorized ? req.socket.getPeerCertificate() : null;
                        if (cert?.fingerprint256)
                            transport.set(request, `mtls-sha256:${cert.fingerprint256.replace(/:/g, '').toLowerCase()}`);
                        const response = await gateway(request);
                        res.writeHead(response.status, Object.fromEntries(response.headers));
                        if (response.body)
                            for await (const chunk of response.body)
                                res.write(chunk);
                        res.end();
                    }
                    catch {
                        res.destroy();
                    }
                });
                server.keepAliveTimeout = 60000;
                server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server.address().port); });
            });
            return { proofPort: await listen(proofGateway), legacyPort: await listen(legacyGateway) };
        },
        grant: ({ principal, grant }) => { grants.set(principal, grant); },
        mint: ({ principal, ttl }) => broker.mint(principal, { ttl }),
        openChannel: ({ principal, token, channel }) => broker.openChannel(principal, token, channel),
        closeChannel: ({ principal, channel }) => broker.closeChannel(principal, channel),
        revoke: ({ principal, token }) => broker.revoke(principal, token),
        reconcile: ({ nonce }) => broker.reconcile(nonce),
        release: ({ nonce, operator, reason }) => broker.release({ nonce, operator, reason }),
        flag: ({ name, value }) => { flags[name] = value; },
        audits: () => audits,
        writer: () => writer.describe(),
        keys: () => keyring.describe(),
        rotateKey: async ({ kid, secret, overlapMs }) => keyring.rotate(kid, Buffer.from(secret, 'base64url'), { overlapMs }),
        disableKey: ({ kid }) => keyring.disable(kid),
        rotateWriter: credential => writer.rotate(credential),
        retireWriter: async ({ id, providerUrl }) => writer.retire(id, { revoke: async () => { },
            probe: async (authorization) => (await fetch(`${providerUrl}/info/refs?service=git-upload-pack`, { headers: { authorization } })).status === 401 }),
    };
    process.on('message', async ({ id, op, args }) => {
        try {
            process.send({ id, ok: true, result: await handlers[op](args) });
        }
        catch (error) {
            process.send({ id, ok: false, error: error.message });
        }
    });
    process.on('disconnect', () => { for (const s of servers)
        s.close(); process.exit(0); });
}
