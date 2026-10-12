import test from 'node:test';
import assert from 'node:assert/strict';
import { bindGrant, sameGrant, serviceAllowed, renewedExpiry, validRef, GrantError } from '../src/grant.mjs';

const base = { tenant: 't', project: 'p', attempt: 'a', repo: 'r', ref: 'refs/heads/lane/alpha', operation: 'write', policyVersion: 'v1', expiresAt: 1000 };

test('bindGrant freezes identity and rejects partial/forged/unowned grants', () => {
  const g = bindGrant(base);
  assert.ok(Object.isFrozen(g));
  assert.throws(() => { g.ref = 'refs/heads/main'; }, TypeError);
  for (const bad of [
    {}, { ...base, ref: 'refs/heads/main' }, { ...base, ref: 'refs/heads/lane/../main' },
    { ...base, operation: 'admin' }, { ...base, expiresAt: 0 }, { ...base, tenant: '' },
    { ...base, ref: 'refs/heads/lane/%61' },
  ]) assert.throws(() => bindGrant(bad), GrantError);
  // A read grant may be bound to a non-lane ref.
  assert.doesNotThrow(() => bindGrant({ ...base, operation: 'read', ref: 'refs/heads/main' }));
});

test('sameGrant requires every immutable field to match (no drift admitted)', () => {
  const g = bindGrant(base);
  assert.ok(sameGrant(g, bindGrant(base)));
  for (const drift of [{ ref: 'refs/heads/lane/beta' }, { attempt: 'b' }, { repo: 'r2' }, { policyVersion: 'v2' }, { expiresAt: 1001 }, { operation: 'read' }])
    assert.equal(sameGrant(g, bindGrant({ ...base, ...drift, ...(drift.operation === 'read' ? { ref: 'refs/heads/main' } : {}) })), false);
});

test('serviceAllowed: write grant permits receive-pack; read grant does not escalate', () => {
  assert.equal(serviceAllowed(bindGrant(base), 'git-receive-pack'), true);
  assert.equal(serviceAllowed(bindGrant(base), 'git-upload-pack'), true);
  const read = bindGrant({ ...base, operation: 'read', ref: 'refs/heads/main' });
  assert.equal(serviceAllowed(read, 'git-receive-pack'), false);
  assert.equal(serviceAllowed(read, 'git-upload-pack'), true);
  assert.equal(serviceAllowed(bindGrant(base), 'git-shell'), false);
});

test('renewedExpiry never exceeds the live authority ceiling or the grant', () => {
  const g = bindGrant({ ...base, expiresAt: 10_000 });
  assert.equal(renewedExpiry(g, 1000, 60_000, 5_000), 6_000); // ceiling binds
  assert.equal(renewedExpiry(g, 1000, 2_000, 60_000), 3_000); // ttl binds
  assert.equal(renewedExpiry(g, 9_000, 60_000, 60_000), 10_000); // grant binds
  assert.throws(() => renewedExpiry(g, 1000, 0, 0), GrantError);
});

test('validRef rejects traversal, controls, normalization bait and lock files', () => {
  assert.ok(validRef('refs/heads/lane/alpha'));
  for (const bad of ['refs/heads/lane/..', 'refs/heads/lane/a b', 'refs/heads/lane/%61', 'heads/x', 'refs/heads/x.lock', 'refs/heads/.hidden'])
    assert.equal(validRef(bad), false);
});

// Repo-lane write custody: a repo-lane (allocated task repository) write grant owns its mapping's
// working branch; the ref-lane rule for shared repositories is unchanged.
test('repo-lane write grants own the task repository working branch, and nothing else', () => {
  const repoLane = { ...base, repo: 'task-a', ref: 'refs/heads/main', lane: 'repo' };
  const g = bindGrant(repoLane);
  assert.equal(g.lane, 'repo');
  assert.equal(serviceAllowed(g, 'git-receive-pack'), true);
  for (const ref of ['refs/tags/v1', 'refs/octocove/receipts/x', 'refs/notes/commits', 'refs/heads/.x', 'refs/heads/a..b', 'HEAD'])
    assert.throws(() => bindGrant({ ...repoLane, ref }), GrantError, ref);
  assert.throws(() => bindGrant({ ...repoLane, lane: 'chain' }), GrantError);
  // A shared-repo ref lane still cannot own main, and the default lane is `ref`.
  assert.throws(() => bindGrant({ ...base, ref: 'refs/heads/main' }), GrantError);
  assert.throws(() => bindGrant({ ...base, ref: 'refs/heads/main', lane: 'ref' }), GrantError);
  assert.equal(bindGrant(base).lane, 'ref');
  // Lane kind is immutable identity: a re-pointed lane kind is drift.
  assert.equal(sameGrant(g, bindGrant({ ...repoLane, ref: 'refs/heads/lane/alpha', lane: 'ref' })), false);
  assert.equal(sameGrant(bindGrant({ ...base, lane: 'repo' }), bindGrant(base)), false);
  assert.ok(sameGrant(g, bindGrant(repoLane)));
});
