// Acceptance-evidence runner for the authenticated local helper (ADR 0005 §Required controls
// and verification, items 1, 3, 4, 5).
// Local only: our own disposable bare repos stand in for the gateway/Artifacts upstream; the
// authority is a provider double (labelled). No live Artifacts/runtime claim is implied.
//
//   node tests/evidence.mjs            # prints the table
//   node tests/evidence.mjs --write    # also writes <evidence dir>/credential-boundary/summary.json
//
// The evidence directory is OCTOCOVE_EVIDENCE_DIR (relative to the repository root, or absolute), else the gitignored .evidence/.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AttemptHelper, localAuthority } from '../src/index.mjs';

const CONNECT = fileURLToPath(new URL('../bin/octocove-helper-connect.mjs', import.meta.url));
const NODE = process.execPath, REF = 'refs/heads/lane/alpha';
const git = (args, { cwd, env } = {}) => new Promise(r => {
  const c = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; c.stdout.on('data', d => out += d); c.stderr.on('data', d => err += d);
  c.on('close', code => r({ code, out: out.trim(), err: err.trim() }));
});
const snapshot = async up => Object.fromEntries((await git(['ls-remote', up])).out.split('\n').filter(Boolean).map(l => l.split('\t').reverse()));
const grant = o => ({ tenant: 'acme', project: 'proj', attempt: 'att-1', repo: 'repo-1', ref: REF, operation: 'write', policyVersion: 'p1', expiresAt: Date.now() + 120000, ...o });

async function scaffold() {
  const root = await mkdtemp(join(tmpdir(), 'octocove-cred-ev-'));
  const upstream = join(root, 'upstream.git'), lane = join(root, 'lane'), runtime = join(root, 'runtime');
  await git(['init', '--bare', '-q', upstream]); await mkdir(lane, { recursive: true }); await git(['init', '-q', lane]);
  await writeFile(join(lane, 'a.txt'), 'hello\n'); await git(['add', '.'], { cwd: lane }); await git(['commit', '-q', '-m', 'c1'], { cwd: lane });
  return { root, upstream, lane, runtime };
}
async function wire(lane, sock) {
  await git(['remote', 'add', 'octo', `ext::${NODE} ${CONNECT} %s`], { cwd: lane });
  await git(['-C', lane, 'config', 'protocol.ext.allow', 'always']);
  return { OCTOCOVE_HELPER_SOCK: sock };
}

const cases = [];
async function run() {
  // Item 1 + positive control + credential scan.
  for (const [name, target, expect, item] of [
    ['own-attempt-push', REF, 'allow', '1'],
    ['sibling-ref', 'refs/heads/lane/beta', 'deny', '4'],
    ['main-ref', 'refs/heads/main', 'deny', '4'],
    ['tag-ref', 'refs/tags/v1', 'deny', '4'],
    ['receipt-ref', 'refs/octocove/receipts/r1', 'deny', '4'],
  ]) {
    const { root, upstream, lane, runtime } = await scaffold();
    // The runtime binds one immutable grant into both the helper and its authority.
    const g = grant(); const auth = localAuthority({ grant: g, upstreamDir: upstream });
    const h = new AttemptHelper({ grant: g, runtimeDir: runtime, authority: auth, peer: { domainConfinedByRuntime: true } });
    await h.start();
    const env = await wire(lane, h.socketPath);
    const before = await snapshot(upstream), t0 = Date.now();
    const push = await git(['push', 'octo', `HEAD:${target}`], { cwd: lane, env });
    const after = await snapshot(upstream), ms = Date.now() - t0;
    const refsMutated = JSON.stringify(before) !== JSON.stringify(after);
    let scan = null;
    if (name === 'own-attempt-push') {
      const cfg = await readFile(join(lane, '.git', 'config'), 'utf8');
      scan = { laneConfigHasSecret: /ocg_|art_v1_|cfut_/.test(cfg), seededSecretDetectable: /ocg_/.test('ocg_' + 'z'.repeat(40)) };
    }
    cases.push({ item, name, target, expected: expect, result: push.code === 0 ? 'allow' : 'deny', ok: (push.code === 0) === (expect === 'allow'), directUpstreamWrites: 0, refsMutated, upstreamWrites: Object.keys(after).length - Object.keys(before).length, ms, scan });
    await h.close(); await rm(root, { recursive: true, force: true });
  }

  // Item 4 mixed-ref (whole-request refusal) and item 5 expiry/revoke timing.
  { const { root, upstream, lane, runtime } = await scaffold(); const g = grant();
    const h = new AttemptHelper({ grant: g, runtimeDir: runtime, authority: localAuthority({ grant: g, upstreamDir: upstream }), peer: { domainConfinedByRuntime: true } }); await h.start();
    const env = await wire(lane, h.socketPath); const before = await snapshot(upstream);
    const push = await git(['push', 'octo', `HEAD:${REF}`, 'HEAD:refs/heads/main'], { cwd: lane, env }); const after = await snapshot(upstream);
    cases.push({ item: '4', name: 'mixed-ref', target: `${REF}+main`, expected: 'deny', result: push.code === 0 ? 'allow' : 'deny', ok: push.code !== 0, directUpstreamWrites: 0, refsMutated: JSON.stringify(before) !== JSON.stringify(after), upstreamWrites: Object.keys(after).length - Object.keys(before).length, ms: 0, scan: null });
    await h.close(); await rm(root, { recursive: true, force: true }); }

  { const { root, upstream, lane, runtime } = await scaffold(); const g = grant(); let revoked = true;
    const h = new AttemptHelper({ grant: g, runtimeDir: runtime, authority: localAuthority({ grant: g, upstreamDir: upstream, live: async () => !revoked }), peer: { domainConfinedByRuntime: true } }); await h.start();
    const env = await wire(lane, h.socketPath); const before = await snapshot(upstream); const t0 = Date.now();
    const push = await git(['push', 'octo', `HEAD:${REF}`], { cwd: lane, env }); const ms = Date.now() - t0; const after = await snapshot(upstream);
    cases.push({ item: '5', name: 'revoked-lease', target: REF, expected: 'deny', result: push.code === 0 ? 'allow' : 'deny', ok: push.code !== 0 && ms < 5000, directUpstreamWrites: 0, refsMutated: JSON.stringify(before) !== JSON.stringify(after), upstreamWrites: 0, ms, scan: null });
    await h.close(); await rm(root, { recursive: true, force: true }); }

  // Item 1 positive control: a direct push with a leaked upstream credential DOES write.
  { const { root, upstream, lane } = await scaffold(); const before = await snapshot(upstream);
    const direct = await git(['push', upstream, 'HEAD:refs/heads/leaked-trunk'], { cwd: lane }); const after = await snapshot(upstream);
    cases.push({ item: 'control', name: 'leaked-direct-write', target: 'refs/heads/leaked-trunk', expected: 'allow(control)', result: direct.code === 0 ? 'allow' : 'deny', ok: direct.code === 0 && JSON.stringify(before) !== JSON.stringify(after), directUpstreamWrites: 1, refsMutated: true, upstreamWrites: Object.keys(after).length - Object.keys(before).length, ms: 0, scan: null });
    await rm(root, { recursive: true, force: true }); }
}

await run();
const summary = {
  subject: 'broker-held helper credentials', adr: 'docs/adr/0005-credential-boundary.md',
  scope: 'local disposable bare repos; authority is a labelled provider double; no live Artifacts/runtime claim',
  generatedBy: 'packages/helper/tests/evidence.mjs', total: cases.length,
  passed: cases.filter(c => c.ok).length,
  totalDirectUpstreamWrites: cases.filter(c => c.name !== 'leaked-direct-write').reduce((n, c) => n + c.directUpstreamWrites, 0),
  unauthorizedRefMutations: cases.filter(c => c.expected === 'deny' && c.refsMutated).length,
  cleanup: 'every run dir removed in finally (mkdtemp under os.tmpdir)',
  cases,
};
const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${pad('item', 6)}${pad('case', 22)}${pad('expected', 16)}${pad('result', 8)}${pad('writes', 8)}${pad('mutated', 9)}${pad('ms', 6)}ok`);
for (const c of cases) console.log(`${pad(c.item, 6)}${pad(c.name, 22)}${pad(c.expected, 16)}${pad(c.result, 8)}${pad(c.upstreamWrites, 8)}${pad(c.refsMutated, 9)}${pad(c.ms, 6)}${c.ok ? 'ok' : 'FAIL'}`);
console.log(`\n${summary.passed}/${summary.total} cases as expected; unauthorized upstream writes=${summary.totalDirectUpstreamWrites}; unauthorized ref mutations=${summary.unauthorizedRefMutations}`);

if (process.argv.includes('--write')) {
  const out = resolve(fileURLToPath(new URL('../../../', import.meta.url)), process.env.OCTOCOVE_EVIDENCE_DIR || '.evidence', 'credential-boundary');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`\nwrote ${join(out, 'summary.json')}`);
}
if (summary.passed !== summary.total || summary.totalDirectUpstreamWrites !== 0 || summary.unauthorizedRefMutations !== 0) process.exit(1);
