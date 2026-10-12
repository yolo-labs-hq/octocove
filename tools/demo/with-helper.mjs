// One-operator LOCAL adapter for the production AttemptHelper chain-stage protocol.
// Unsafe control: the explicit peer callback admits this demo's same-UID client.
// This mode can never establish an ADR-0005 credential-boundary PASS.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { AttemptHelper } from '../../packages/helper/src/attempt-helper.mjs';
import { checked, prerequisite, readConfig, root, state } from './common.mjs';

prerequisite();
const config = await readConfig();
const cwd = resolve(process.cwd());
assert.ok(cwd.startsWith(state + sep), 'Run this helper inside the disposable demo clone');
console.error('Credential boundary: unsafe-control (same UID); runtime qualification BLOCKED.');
const identity = process.env.OCTOCOVE_DEMO_IDENTITY ?? 'author';
assert.ok(['author', 'author-a', 'author-b'].includes(identity));
const credential = JSON.parse(await readFile(join(state, identity, 'credentials/cli.json'), 'utf8'));
assert.equal(credential.apiUrl, `${config.api}/v1`);
const gitConfig = key => execFileSync('git', ['config', '--local', '--get', `octocove.${key}`], { encoding: 'utf8' }).trim();
const taskId = gitConfig('taskId'), claimId = gitConfig('claimId'), baseSha = gitConfig('baseSha');
const headers = { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json' };
const api = async (path, method = 'GET', body) => {
  const response = await checked(`${credential.apiUrl}${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return response.status === 204 ? undefined : response.json();
};
const leases = [];
let helper, child;
try {
  const claim = await api(`/claims/${claimId}`);
  assert.equal(claim.taskId, taskId); assert.equal(claim.status, 'active');
  assert.equal(claim.lane.baseSha, baseSha); assert.equal(claim.provisioningState, 'ready');
  // Production broker checks authenticated ownership, live claim and server-owned mapping.
  const mint = async () => {
    const lease = await api('/broker/token', 'POST', { taskId, scope: 'read', ttl: 900 });
    leases.push(lease.id); return lease;
  };
  const lease = await mint();
  assert.equal(lease.scope, 'read');
  const grant = { tenant: 'octocove', project: gitConfig('projectId'), attempt: claimId, repo: lease.repo,
    ref: claim.workspace.ref, operation: lease.scope, policyVersion: String(claim.intentVersion), expiresAt: Date.parse(lease.expiresAt) };
  helper = new AttemptHelper({ grant, runtimeDir: join(state, `helper-${identity}`),
    peer: { authenticate: async () => {} }, // Explicit local-only bypass; ADR 0005 remains unqualified.
    authority: {
      async live() {
        const live = await mint();
        assert.equal(live.repo, grant.repo); assert.equal(live.scope, grant.operation);
        const current = await api(`/claims/${claimId}`);
        assert.equal(current.status, 'active'); assert.equal(current.workspace.ref, grant.ref);
        assert.equal(current.lane.baseSha, baseSha);
        return grant;
      },
      async seed() { throw new Error('demo-stage-only'); },
      async deliver() { throw new Error('chain-push-queue-required'); },
    },
    chain: { taskId, baseSha, async stage(input) {
      await checked(`${config.issuer}/stage`, { method: 'POST',
        headers: { Authorization: `Bearer ${config.dispatchToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input) });
    } },
  });
  await helper.start();
  child = spawn(process.execPath, [join(root, 'packages/cli/dist/octocove.mjs'), ...process.argv.slice(2)], {
    stdio: 'inherit', env: { ...process.env, OCTOCOVE_CONFIG_DIR: join(state, identity), OCTOCOVE_HELPER_SOCK: helper.socketPath },
  });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', code => resolve(code ?? 1));
  });
} finally {
  if (helper) await helper.close();
  for (const id of leases) await api(`/broker/token/${id}`, 'DELETE');
}
