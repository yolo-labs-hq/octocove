import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checked, readConfig, sleep, state } from './common.mjs';
import { login } from './login.mjs';

test('production chain handlers provision, stage, compute, approve and CAS land into bare Git', { timeout: 240_000 }, async () => {
  const config = await readConfig(), author = await login('author'), approver = await login('approver');
  const call = async (session, path, body) => (await checked(`${session.apiUrl}${path}`, {
    headers: { Authorization: `Bearer ${session.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
    ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}),
  })).json();
  const poll = async (action, predicate) => {
    const deadline = Date.now() + 90_000; let result;
    while (Date.now() < deadline) { result = await action(); if (predicate(result)) return result; await sleep(500); }
    throw new Error(`Polling timed out: ${JSON.stringify(result)}`);
  };
  const task = await call(author, '/tasks', { projectId: 'demo', repositoryId: 'demo-canonical', targetRef: 'refs/heads/main', key: randomUUID(),
    title: 'Local runtime verification', description: 'Land a real commit', acceptanceCriteria: ['Canonical matches the receipt'] });
  await call(author, `/tasks/${task.id}/publish`, {});
  const claim = await call(author, `/tasks/${task.id}/claim`, { intentVersion: 1, chain: { id: `demo-${randomUUID()}`, baseSha: config.baseSha } });
  const claimId = claim.claim?.id ?? claim.claimAttemptId;
  assert.ok(claimId);
  const lane = await poll(() => call(author, `/tasks/${task.id}/lane`), row => row.status === 'ready');
  assert.equal(lane.proofSha, config.baseSha);
  const work = join(state, 'work');
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Local author', '-c', 'user.email=author@example.invalid', '-C', work, ...args],
    { encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  await writeFile(join(work, 'change.txt'), 'Produced by the local runtime verification\n'); git('add', '.'); git('commit', '-m', 'Verify local runtime');
  const sourceSha = git('rev-parse', 'HEAD'), pushId = randomUUID();
  const staged = await (await checked(`${config.issuer}/stage`, { method: 'POST', headers: {
    Authorization: `Bearer ${config.dispatchToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId: task.id, claimId, pushId, sourceSha, sourceRemote: work, sourceRef: 'refs/heads/main' }) })).json();
  assert.equal(staged.sourceSha, sourceSha);
  await call(author, `/tasks/${task.id}/lane/pushes`, { claimAttemptId: claimId, pushId, sourceSha });
  await poll(() => call(author, `/tasks/${task.id}/lane`), row => row.pushes.some(push => push.pushId === pushId && push.status === 'delivered'));
  const submission = await call(author, `/tasks/${task.id}/submissions`, { sourceSha, baseSha: config.baseSha, intentVersion: 1 });
  const candidateStatus = await poll(() => call(author, `/submissions/${submission.id}/candidate`), row => row.candidate?.candidateSha);
  const candidate = candidateStatus.candidate;
  const approval = await call(approver, `/candidates/${candidate.id}/approve`, { boundTo: { candidateSha: candidate.candidateSha, baseSha: candidate.baseSha, intentVersion: 1 } });
  const landing = await call(approver, `/candidates/${candidate.id}/land`, { approvalId: approval.id });
  const receipt = await poll(() => call(approver, `/receipts/${landing.receiptId ?? landing.fenceId}`), row => row.outcome === 'landed');
  assert.equal(receipt.landedSha, git('ls-remote', join(state, 'repos/canonical.git'), 'refs/heads/main').split(/\s/)[0]);
  assert.notEqual(receipt.landedSha, config.baseSha);
  console.log(`Native Git CAS and production receipt agree: ${receipt.landedSha}`);
});
