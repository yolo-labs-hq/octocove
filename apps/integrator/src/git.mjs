import { validReceiptRef, RECEIPT_PREFIX } from './receipt-ref.mjs';
import { writeFile } from 'node:fs/promises';
import { validTargetRef } from './target-ref.mjs';
import { hasTreeSeed } from './tree-seed.mjs';
import { spawn } from 'node:child_process';
import { credentialFd } from './credentials.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
// Every integrator git command: never follow a redirect (a credential header would follow it)
// and never run the command-executing ext:: transport.
const TRANSPORT = ['-c', 'http.followRedirects=false', '-c', 'protocol.ext.allow=never'];
function execGit(args, { cwd, env, binary, auth, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...TRANSPORT, ...args], { cwd, env, stdio: auth.stdio, signal });
    const chunks = []; let bytes = 0, killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, 120_000);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) { killed = true; child.kill('SIGKILL'); }
      else chunks.push(chunk);
    });
    // Classify bounded diagnostics in memory; only the boolean leaves this function.
    let diagnostic = '';
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-8192); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) return reject(Object.assign(new Error('git-command-failed'), { code, signal, killed, providerRestricted: /protected branch|branch protection|protected ref|GH006|GH013|repository rule|hook declined|pre-receive hook declined/i.test(diagnostic) }));
      const stdout = Buffer.concat(chunks);
      resolve(binary ? stdout : stdout.toString('utf8'));
    });
  });
}
export class Blocked extends Error {
  constructor(code) { super(code); this.code = code; }
}
const sha = value => { if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('invalid-sha'); return value; };
export function candidateRef(id) {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error('invalid-candidate-id');
  return `refs/candidates/${id}`;
}
/** ADR 0003 source custody writer: the exact submitted commit, retained in canonical after the task repo retires. */
export const SOURCE_CUSTODY_PREFIX = 'refs/sources/';
export function sourceCustodyRef(id) {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error('invalid-submission-id');
  return `${SOURCE_CUSTODY_PREFIX}${id}`;
}
export function checkIdentity(policy, candidateSha, baseSha) {
  return createHash('sha256').update(JSON.stringify(policy) + (candidateSha ?? '') + baseSha).digest('hex');
}
// A DNS host name with a letter-led top-level label: no IP literal, single label or port.
const REMOTE_HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Local absolute bare repos are for tests and the local runtime only; deployments never set these. */
export const localRemotesAllowed = () => process.env.OCTOCOVE_INTEGRATOR_LOCAL_GIT === '1' ||
  process.env.OCTOCOVE_RUNNER === 'local' || process.env.VITEST === 'true' || process.env.NODE_TEST_CONTEXT !== undefined;
/** Validate a remote before any credentialed git command. Production accepts credential-free
 * HTTPS only. `internal` admits an absolute path the integrator itself (or its trusted pod
 * ingress) owns, such as a spool or mirror repository. */
export function remote(url, { internal = false } = {}) {
  if (typeof url !== 'string') throw new Error('invalid-remote');
  if (url.startsWith('/')) {
    if (!internal && !localRemotesAllowed()) throw new Error('invalid-remote');
    return url;
  }
  let u;
  try { u = new URL(url); } catch { throw new Error('invalid-remote'); }
  if (!url.startsWith('https://') || u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.port ||
      !REMOTE_HOST.test(u.hostname)) throw new Error('invalid-remote');
  return url;
}
export async function workspace(fn, signal) {
  const dir = await mkdtemp(join(tmpdir(), 'octocove-integrator-'));
  // Never inherit an operator's git config, credential helper, hooks or runner secrets.
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1' };
  const git = async (args, token, url, binary = false, extraEnv = {}) => {
    const auth = credentialFd(token && url?.startsWith('https://') ? [[url, token]] : []);
    try {
      const stdout = await execGit([...auth.args, '-c', 'pack.threads=1', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Octocove Integrator', '-c', 'user.email=integrator@octocove.com', ...args], {
        cwd: dir, env: { ...env, ...extraEnv }, binary, auth, signal,
      });
      return binary ? stdout : stdout.trim();
    } catch (error) {
      // Git errors may include remote headers/URLs. Do not return raw stderr to the record.
      const failure = new Error('git-command-failed'); failure.code = error.code; failure.providerRestricted = error.providerRestricted === true; failure.unknownWriter = Boolean(error.killed || error.signal); throw failure;
    } finally { auth.close(); }
  };
  try { await git(['init', '-q']); return await fn(git); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
export async function fetchRef(git, url, ref, local, token, { internal = false } = {}) {
  remote(url, { internal });
  await git(['check-ref-format', ref]);
  await git(['fetch', '--no-tags', '--', url, `+${ref}:${local}`], token, url);
  return sha(await git(['rev-parse', local]));
}
/** Fetch the registered source and canonical target before submission.
 * Broker read credentials only; exact source identity plus shared-history proof. */
export async function verifySource(input) {
  sha(input.expectedSha);
  return workspace(async git => {
    const objectSha = await fetchRef(git, input.remote, input.ref, 'refs/input/source', input.credential);
    const commit = await git(['rev-parse', '--verify', 'refs/input/source^{commit}']);
    const canonicalSha = await fetchRef(git, input.canonicalRemote, input.targetRef, 'refs/input/base', input.canonicalCredential);
    let relatedHistory = true;
    try { await git(['merge-base', canonicalSha, commit]); }
    catch (error) { if (error.code !== 1) throw error; relatedHistory = false; }
    return { runId: input.runId, repoId: input.repoId, ref: input.ref, expectedSha: input.expectedSha,
      canonicalRepoId: input.canonicalRepoId, targetRef: input.targetRef, canonicalSha, relatedHistory,
      objectSha, verified: objectSha === input.expectedSha && commit === objectSha };
  });
}
/** Own lane readiness: fetch commits, prove the pinned base, and for BYO create
 * only an absent deterministic ref. No platform event supplies evidence. */
export async function verifyLane(input) {
  sha(input.baseSha);
  if (input.expectedSha !== undefined) sha(input.expectedSha);
  if (input.createRef && !/^refs\/heads\/oc\/[a-zA-Z0-9_-]+$/.test(input.ref)) throw new Error('lane-ref-denied');
  return workspace(async git => {
    await fetchRef(git, input.canonicalRemote, input.targetRef, 'refs/input/base', input.canonicalCredential);
    if (await git(['rev-parse', `${input.baseSha}^{commit}`]) !== input.baseSha) throw new Error('base-not-commit');
    await git(['merge-base', '--is-ancestor', input.baseSha, 'refs/input/base']);
    if (input.createRef) {
      const rows = await git(['ls-remote', '--', remote(input.remote), input.ref], input.credential, input.remote);
      if (!rows) await git(['push', `--force-with-lease=${input.ref}:`, '--', input.remote, `${input.baseSha}:${input.ref}`], input.credential, input.remote);
    }
    const objectSha = await fetchRef(git, input.remote, input.ref, 'refs/input/proof', input.credential);
    const commit = await git(['rev-parse', 'refs/input/proof^{commit}']);
    await git(['merge-base', '--is-ancestor', input.baseSha, commit]);
    return { runId: input.runId, repoId: input.repoId, ref: input.ref,
      canonicalRepoId: input.canonicalRepoId, targetRef: input.targetRef,
      baseSha: input.baseSha, objectSha, headSha: objectSha, containsBase: true,
      verified: commit === objectSha && (!input.expectedSha || objectSha === input.expectedSha) && (!input.createRef || objectSha === input.baseSha) };
  });
}
async function conflicts(git) {
  return (await git(['diff', '--name-only', '--diff-filter=U', '-z'], undefined, undefined, true)).toString('utf8').split('\0').filter(Boolean).sort();
}
async function mergeSquash(git, base, source) {
  await git(['checkout', '--detach', '-f', base]);
  try { await git(['merge', '--squash', '--no-commit', source]); }
  catch (error) { const files = await conflicts(git); if (files.length) return files; throw error; }
  return [];
}
function target(job) {
  if (!validTargetRef(job.targetRef) || typeof job.repoId !== 'string' || !job.repoId)
    throw new Blocked('invalid-target');
  return job.targetRef;
}
function scopedGrant(grant, job, refFamily) {
  if (!grant || grant.repo !== job.repoId || grant.targetRef !== job.targetRef || grant.refFamily !== refFamily)
    throw new Blocked('target-grant-mismatch');
}
/** Push the exact submitted commit to its create-only custody ref in canonical, fetch
 * it back, then record it. Absent (rewritten) or disconnected objects are not
 * preserved: cleanup keeps refusing `source-custody-pending` for that submission. */
async function preserveSource(git, job, io, reads, base) {
  const ref = sourceCustodyRef(job.submissionId);
  if (job.sourceCustodyRef !== ref) throw new Blocked('source-custody-ref-mismatch');
  // A moved source head still carries the submitted commit when it is an ancestor.
  try { if (await git(['rev-parse', '--verify', '--quiet', `${job.sourceSha}^{commit}`]) !== job.sourceSha) return; }
  catch { return; }
  try { await git(['merge-base', base, job.sourceSha]); }
  catch (error) { if (error.code === 1) return; throw error; }
  let durable;
  try { durable = await fetchRef(git, job.canonicalUrl, ref, 'refs/input/custody', reads.canonical); }
  catch { /* missing ref; the create-only lease below arbitrates */ }
  if (durable === undefined) {
    const grant = await io.sourceCustodyToken(job, ref);
    scopedGrant(grant, job, SOURCE_CUSTODY_PREFIX);
    try { await git(['push', `--force-with-lease=${ref}:`, '--', remote(job.canonicalUrl), `${job.sourceSha}:${ref}`], grant.token, job.canonicalUrl); }
    catch (error) { if (error.unknownWriter) throw error; /* a lost acknowledgement may have created it */ }
    durable = await fetchRef(git, job.canonicalUrl, ref, 'refs/input/custody', reads.canonical);
  }
  // Never record, and never overwrite, a custody ref naming another object.
  if (durable !== job.sourceSha) throw new Blocked('source-custody-mismatch');
  await io.persistSourceCustody({ repoId: job.repoId, targetRef: job.targetRef, runId: job.runId,
    submissionId: job.submissionId, sourceSha: job.sourceSha, protectedRef: ref });
}
/** io is a trusted, run-bound broker/record/isolated-check adapter. No submitted code runs here. */
export async function compute(job, io) {
  // Reject unsupported seed evidence before workspace creation or any broker call.
  if (hasTreeSeed(job)) throw new Blocked('unrelated-history');
  const targetRef = target(job);
  const ref = candidateRef(job.candidateId);
  sha(job.sourceSha); sha(job.baseSha);
  if (job.persistedCandidate && (job.persistedCandidate.repoId !== job.repoId || job.persistedCandidate.targetRef !== targetRef))
    throw new Blocked('candidate-target-mismatch');
  return workspace(async git => {
    const reads = await io.readTokens(job);
    if (job.persistedCandidate) {
      const result = job.persistedCandidate;
      const durable = await fetchRef(git, job.canonicalUrl, ref, 'refs/input/candidate', reads.canonical);
      if (durable !== result.candidateSha || await git(['show', '-s', '--format=%P', durable]) !== result.baseSha)
        throw new Blocked('candidate-ref-mismatch');
      const archive = await git(['archive', '--format=tar', durable], undefined, undefined, true);
      const check = await io.runChecks({ runId: `${job.runId}:checks`, candidateId: job.candidateId,
        candidateSha: durable, baseSha: result.baseSha, checkIdentity: result.checkIdentity, policy: result.checkPolicy }, archive);
      if (!['passed', 'failed', 'error', 'skipped'].includes(check.result)) throw new Error('invalid-check-result');
      await io.persistCheck({ ...check, candidateId: job.candidateId, runId: `${job.runId}:checks`, checkIdentity: result.checkIdentity });
      return { ...result, checkResult: check.result, evidence: check.evidence };
    }
    const source = await fetchRef(git, job.sourceUrl, job.sourceRef, 'refs/input/source', reads.source);
    const base = await fetchRef(git, job.canonicalUrl, targetRef, 'refs/input/base', reads.canonical);
    // Custody is recorded before any candidate evidence, unless the submitted commit cannot be preserved.
    if (job.sourceCustodyRef !== undefined) await preserveSource(git, job, io, reads, base);
    const receipt = { repoId: job.repoId, targetRef, runId: job.runId, candidateId: job.candidateId, submissionId: job.submissionId,
      baseSha: base, checkPolicy: job.checkPolicy, computedAt: job.createdAt,
      ...(job.recomputedFromCandidateId ? { recomputedFromCandidateId: job.recomputedFromCandidateId, recomputeReason: job.recomputeReason } : {}) };
    async function blocked(outcome, files, errorDetail = null) {
      const result = { ...receipt, outcome, candidateSha: null, candidateRef: null,
        checkIdentity: checkIdentity(job.checkPolicy, null, base), conflictFiles: files ?? null,
        errorDetail };
      await io.persistCandidate(result); return result;
    }
    if (source !== job.sourceSha) return blocked('stale-head');
    if (base !== job.baseSha) return blocked('stale-base');
    // Undeclared disconnected history also fails closed. Object reads are needed
    // to prove ancestry; never mint a write grant, push or publish a candidate.
    try { await git(['merge-base', base, source]); }
    catch (error) {
      if (error.code === 1) throw new Blocked('unrelated-history');
      throw error;
    }
    // A resumed compute uses the durable object, never creates a second squash SHA.
    let candidate;
    try {
      candidate = await fetchRef(git, job.canonicalUrl, ref, 'refs/input/candidate', reads.canonical);
    } catch { /* missing ref; a later create-only lease arbitrates concurrent retries */ }
    if (candidate) {
      const parents = await git(['show', '-s', '--format=%P', candidate]);
      const message = await git(['show', '-s', '--format=%B', candidate]);
      if (parents !== base || message !== `Octocove candidate ${job.candidateId}\n\nSubmission ${job.submissionId}\nSource ${source}`)
        throw new Error('candidate-ref-mismatch');
    } else {
      const files = await mergeSquash(git, base, source);
      if (files.length) return blocked('conflict', files);
      const tree = await git(['write-tree']);
      // Fixed run timestamp makes retry construction deterministic. Single parent = squash.
      if (!Number.isFinite(Date.parse(job.createdAt))) throw new Error('invalid-run-time');
      candidate = await git(['-c', 'user.name=Octocove Integrator', '-c', 'user.email=integrator@octocove.com',
        'commit-tree', tree, '-p', base, '-m', `Octocove candidate ${job.candidateId}\n\nSubmission ${job.submissionId}\nSource ${source}`,
      ], undefined, undefined, false, { GIT_AUTHOR_DATE: job.createdAt, GIT_COMMITTER_DATE: job.createdAt });
      const grant = await io.candidateWriteToken(job, ref);
      scopedGrant(grant, job, 'refs/candidates/');
      try { await git(['push', `--force-with-lease=${ref}:`, '--', remote(job.canonicalUrl), `${candidate}:${ref}`], grant.token, job.canonicalUrl); }
      catch (error) {
        if (error.providerRestricted) return blocked('error', null, 'provider-restricted');
        const durable = await fetchRef(git, job.canonicalUrl, ref, 'refs/input/candidate', reads.canonical);
        if (durable !== candidate) throw error;
      }
      // Verify custody by fetching objects before publishing record evidence.
      if (await fetchRef(git, job.canonicalUrl, ref, 'refs/input/candidate', reads.canonical) !== candidate)
        throw new Error('candidate-persistence-mismatch');
    }
    const result = { ...receipt, outcome: 'computed', candidateSha: candidate, candidateRef: ref,
      checkIdentity: checkIdentity(job.checkPolicy, candidate, base), conflictFiles: null, errorDetail: null };
    await io.persistCandidate(result);
    // Archive is source-only; the separate executor gets no git directory, URL or broker token.
    const archive = await git(['archive', '--format=tar', candidate], undefined, undefined, true);
    const check = await io.runChecks({ runId: `${job.runId}:checks`, candidateId: job.candidateId,
      candidateSha: candidate, baseSha: base, checkIdentity: result.checkIdentity, policy: job.checkPolicy }, archive);
    if (!['passed', 'failed', 'error', 'skipped'].includes(check.result)) throw new Error('invalid-check-result');
    await io.persistCheck({ ...check, candidateId: job.candidateId, runId: `${job.runId}:checks`, checkIdentity: result.checkIdentity });
    return { ...result, checkResult: check.result, evidence: check.evidence };
  });
}
export async function land(job, io) {
  const targetRef = target(job);
  const ref = candidateRef(job.candidateId);
  sha(job.candidateSha); sha(job.baseSha);
  // Authorize the held fence, not mutable current task intent (new edits may be staged).
  const binding = await io.authorizeLanding(job);
  if (!binding || binding.repoId !== job.repoId || binding.targetRef !== targetRef || binding.runId !== job.runId || binding.candidateId !== job.candidateId ||
      binding.candidateSha !== job.candidateSha || binding.baseSha !== job.baseSha ||
      binding.intentVersion !== job.intentVersion || binding.fenceId !== job.fenceId ||
      binding.approvalId !== job.approvalId || !binding.held || !binding.checksPassed)
    throw new Blocked('approval-mismatch');
  return workspace(async git => {
    const reads = await io.readTokens(job);
    const persisted = await fetchRef(git, job.canonicalUrl, ref, 'refs/input/candidate', reads.canonical);
    if (persisted !== job.candidateSha || await git(['show', '-s', '--format=%P', persisted]) !== job.baseSha)
      throw new Blocked('candidate-ref-mismatch');
    async function reconcile(pushError = false, restricted = false) {
      const head = await fetchRef(git, job.canonicalUrl, targetRef, 'refs/input/target', reads.canonical);
      let contains = false;
      try { await git(['merge-base', '--is-ancestor', job.candidateSha, head]); contains = true; }
      catch (error) { if (error.code !== 1) throw error; }
      const files = !contains && head !== job.baseSha ? await mergeSquash(git, head, job.candidateSha) : [];
      const outcome = contains ? 'landed' : files.length ? 'conflict' : head !== job.baseSha ? 'raced' : 'error';
      return { repoId: job.repoId, targetRef, runId: job.runId, candidateId: job.candidateId, fenceId: job.fenceId, outcome,
        landedSha: contains ? job.candidateSha : null, baseShaBefore: job.baseSha, baseShaAfter: head,
        reconciledAgainstSha: head, reconciledAt: new Date().toISOString(), ancestryVerified: contains,
        writerTerminated: true, eventIdsConsumed: [], conflictFiles: files.length ? files : null,
        errorDetail: restricted && !contains ? 'provider-restricted' : outcome === 'error' ? (pushError ? 'canonical-push-failed' : 'canonical-unchanged') : null };
    }
    let result = await reconcile();
    if (result.outcome === 'error') {
      // Mint canonical write only after exact approval validation and ancestry reconciliation.
      const grant = await io.landWriteToken(job);
      scopedGrant(grant, job, targetRef);
      let failed = false, restricted = false;
      try { await git(['push', `--force-with-lease=${targetRef}:${job.baseSha}`, '--',
        remote(job.canonicalUrl), `${job.candidateSha}:${targetRef}`], grant.token, job.canonicalUrl); }
      catch (error) { if (error.unknownWriter) throw error; failed = true; restricted = error.providerRestricted === true; }
      // Even a failed push can have landed before transport failure. Fetch, then prove ancestry.
      result = await reconcile(failed, restricted);
    }
    await io.persistLanding(result); return result;
  });
}

/** Deterministic signed blob projection. Never updates any record/approval. */
export async function exportReceipt(job, io) {
  if (!validReceiptRef(job.targetRef) || job.targetRef !== `${RECEIPT_PREFIX}${job.receiptId}` ||
      typeof job.signedContent !== 'string' || !job.repoId) throw new Blocked('invalid-receipt-export');
  remote(job.canonicalUrl);
  const dir = await mkdtemp(join(tmpdir(), 'octocove-receipt-'));
  try {
    const path = join(dir, 'receipt.json'); await writeFile(path, job.signedContent);
    return await workspace(async git => {
      const objectSha = sha(await git(['hash-object', '-w', path]));
      if (objectSha !== job.objectSha) throw new Blocked('receipt-content-mismatch');
      const grant = await io.receiptWriteToken(job);
      if (!grant || grant.repo !== job.repoId || grant.targetRef !== job.targetRef || grant.refFamily !== RECEIPT_PREFIX)
        throw new Blocked('receipt-grant-mismatch');
      const observe = async () => {
        const output = await git(['ls-remote', '--refs', '--', job.canonicalUrl, job.targetRef], grant.credential ?? grant.token, job.canonicalUrl);
        return output ? output.split(/\s+/)[0] : null;
      };
      let current = await observe();
      if (current === null) {
        try {
          // Expected absence CAS: a concurrent creation can never be overwritten.
          await git(['push', `--force-with-lease=${job.targetRef}:`, '--', job.canonicalUrl, `${objectSha}:${job.targetRef}`], grant.credential ?? grant.token, job.canonicalUrl);
          current = objectSha;
        } catch (error) { current = await observe(); if (current === null) throw error; }
      }
      return { runId: job.runId, receiptId: job.receiptId, repoId: job.repoId, targetRef: job.targetRef,
        objectSha, outcome: current === objectSha ? 'exported' : 'export-conflict' };
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
