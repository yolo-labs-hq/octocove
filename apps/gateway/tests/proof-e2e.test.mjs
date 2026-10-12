// Push-time proof real-process smoke (subset of tests/proof-evidence.mjs): lane git through
// the AttemptHelper, mTLS channel identity, a separate attacker process, SIGKILL restart on the
// durable ledger, and the labelled git http-backend provider double. Local repos only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './support/harness.mjs';

test('helper push writes once; stolen lease/proof from another process and replay after restart write nothing', async () => {
  const h = await createHarness();
  try {
    const alpha = await h.attempt('alpha'), lane = await h.lane(alpha);
    const sha = await lane.commit('one');
    const pushed = await lane.push('octo', `HEAD:${alpha.ref}`);
    assert.equal(pushed.code, 0, pushed.stderr);
    assert.equal((await h.snapshot())[alpha.ref], sha);
    const next = await lane.commit('two'), body = await h.body(lane.dir, alpha.ref, sha, next);
    const { proof } = await h.issue(alpha, body);
    const headers = { authorization: `Bearer ${alpha.token}`, 'content-type': 'application/x-git-receive-pack-request', 'x-octocove-push-proof': proof };
    const stolen = await h.attacker([
      { url: h.url(h.svc.proofPort, 'git-receive-pack'), headers, body },
      { url: h.url(h.svc.proofPort, 'git-receive-pack'), headers, body, tls: { key: h.pki.attacker.key, cert: h.pki.attacker.cert }, localAddress: '127.0.0.2' },
    ]);
    assert.deepEqual(stolen.results.map(r => r.outcome), ['channel-required', 'channel-denied']);
    assert.equal(h.provider.state.upstreamWrites, 1);
    assert.equal((await h.push(alpha, body, proof)).outcome, 'ok');
    await h.restart();
    assert.equal((await h.push(alpha, body, proof)).outcome, 'proof-replayed');
    assert.equal(h.provider.state.upstreamWrites, 2);
    assert.equal((await h.snapshot())[alpha.ref], next);
  } finally {
    const manifest = await h.cleanup();
    assert.equal(manifest.removed, true);
  }
});
