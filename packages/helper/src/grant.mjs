// Immutable broker-grant identity/scope for the authenticated local helper (ADR 0005).
//
// A "lease" is an existing broker grant, not a new substrate noun. The broker derives
// it from live attempt authority plus the server-owned mapping; a client can never
// supply, widen or re-point it. Identity/scope is immutable and bound to
// {tenant, project, attempt, repo, ref, operation, expiry} plus its lane kind. Revocation
// is a validity change (AttemptHelper rechecks its authority's live() grant before every
// transport), never an edit to this evidence.

const OPERATIONS = new Set(['read', 'write']);
// `ref`: a ref lane in a shared repository (the default). `repo`: an allocated task
// repository, single-writer by construction (ADR 0005 "Repo-lane write delivery").
const LANES = new Set(['ref', 'repo']);

// A ref-lane write grant owns exactly one `refs/heads/lane/<lane>` ref. A repo-lane write
// grant owns exactly the mapping's working branch in its own task repository; tags,
// `refs/octocove/*` and other namespaces are never writable. The helper resolves
// the exact registered ref itself and never trusts a ref named by the lane. Reads
// may name a registered ref they are bound to. Keep ref syntax strict and literal:
// no percent-decoding, Unicode normalization, `..`, lock files or control bytes.
export function validRef(ref) {
  return typeof ref === 'string' && ref.length <= 512 && /^refs\/[\x21-\x7e]+$/.test(ref) &&
    !/[ ~^:?*\[\\%]/.test(ref) && !ref.includes('..') && !ref.includes('@{') &&
    !ref.endsWith('.') && ref.split('/').every(p => p && !p.startsWith('.') && !p.endsWith('.lock'));
}

const nonempty = v => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\0\r\n]/.test(v);

// Freeze an authority-derived grant into its immutable identity/scope. Throws if any
// field is missing or malformed so a partial/forged grant can never authorize I/O.
// `expiresAt` is epoch milliseconds; `policyVersion` carries the attempt's ref policy.
export function bindGrant(input) {
  if (!input || typeof input !== 'object') throw new GrantError('grant-denied');
  const { tenant, project, attempt, repo, ref, operation, policyVersion, expiresAt, lane = 'ref' } = input;
  if (![tenant, project, attempt, repo, policyVersion].every(nonempty) ||
      !OPERATIONS.has(operation) || !LANES.has(lane) || !validRef(ref) ||
      !Number.isFinite(expiresAt) || expiresAt <= 0)
    throw new GrantError('grant-denied');
  // A ref-lane write grant must own a `refs/heads/lane/<lane>` ref; a repo-lane write grant
  // its task repository's working branch. Nothing else is writable.
  if (operation === 'write' && !(lane === 'ref' ? /^refs\/heads\/lane\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/ : /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,200}$/).test(ref))
    throw new GrantError('grant-denied');
  return Object.freeze({ tenant, project, attempt, repo, ref, operation, policyVersion, expiresAt, lane });
}

// Two grants are the same identity only if every immutable field matches. The helper
// re-binds the authority's current grant on every admission and compares; any drift
// (re-pointed ref, widened scope, rotated policy, changed attempt) fails closed.
export function sameGrant(a, b) {
  return !!a && !!b &&
    a.tenant === b.tenant && a.project === b.project && a.attempt === b.attempt &&
    a.repo === b.repo && a.ref === b.ref && a.operation === b.operation && a.lane === b.lane &&
    a.policyVersion === b.policyVersion && a.expiresAt === b.expiresAt;
}

// The git transport service a peer may request for a grant's operation. A write grant
// permits receive-pack (and the advertisement upload-pack read it depends on); a read
// grant permits only upload-pack. Read→write escalation is refused here, before any I/O.
export function serviceAllowed(grant, service) {
  if (service === 'git-upload-pack') return true;
  if (service === 'git-receive-pack') return grant.operation === 'write';
  return false;
}

// Renewal issues a fresh validity window under the *current* authority ceiling; it can
// never extend identity or scope. `ceilingMs` is the live grant's remaining lifetime.
export function renewedExpiry(grant, now, ttlMs, ceilingMs) {
  const requested = now + ttlMs;
  const ceiling = now + ceilingMs;
  const expiresAt = Math.min(requested, ceiling, grant.expiresAt);
  if (expiresAt <= now) throw new GrantError('grant-expiring');
  return expiresAt;
}

export class GrantError extends Error {}
