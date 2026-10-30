/**
 * Merit policy bodies between their two wire forms. A registration (`meritPolicyRegister`'s body) names durations
 * as ISO-8601 (`approvalTtl`, `evaluation.deadline`); the read routes answer the stored body, with durations in
 * seconds (`approvalTtlSeconds`, `evaluation.deadlineSeconds`) under `body` beside the version's metadata. Re-posting a
 * read is refused, so `meritPolicyInputFromRead` turns either form back into a registration. Pure: no I/O.
 */
import type { components } from './generated/openapi.js';

type Schemas = components['schemas'];
type Registration = Schemas['MeritPolicyRegistration'];

/** A registration whose `version` is still to be chosen (`merit.policies.prepare` takes the next one). */
export type MeritPolicyDraft = Omit<Registration, 'version'> & { readonly version?: number };

/** What replaces the source's own values: its repository, target ref, expiry, version and decision model. */
export interface MeritPolicyOverrides {
  readonly repositoryId?: string;
  readonly targetRef?: string;
  readonly expiresAt?: string;
  readonly version?: number;
  /** `evaluation.model`: the decision model (`jev`, `clef`, ...). */
  readonly evaluator?: string;
}

/** The fields of a registration that describe the policy itself (everything but the version's identity). */
const BODY_FIELDS = ['checkPolicyDigest', 'requireCheckRun', 'land', 'approvalTtl', 'diff', 'paths', 'reviewer', 'evaluation', 'attempts', 'evidence', 'humanSampleRate'] as const;
/** What a read answers about a version that a registration never carries. */
const READ_ONLY = ['id', 'projectId', 'principalId', 'registeredAt', 'registeredBy', 'paused', 'revokedAt', 'expired', 'latest', 'live'];

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Seconds as the shortest ISO-8601 duration the registration route reads (`86400` → `P1D`, `600` → `PT10M`). */
export function isoDuration(seconds: number): string {
  if (!Number.isInteger(seconds) || seconds <= 0) throw new TypeError(`a duration is a positive whole number of seconds, not ${String(seconds)}`);
  const d = Math.floor(seconds / 86_400), h = Math.floor((seconds % 86_400) / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  const time = `${h ? `${h}H` : ''}${m ? `${m}M` : ''}${s ? `${s}S` : ''}`;
  return `P${d ? `${d}D` : ''}${time ? `T${time}` : ''}`;
}

/** One duration field from either form: the ISO value as given, or the seconds converted; both is ambiguous. */
function duration(from: Record<string, unknown>, iso: string, seconds: string, where: string): string | undefined {
  if (from[iso] !== undefined && from[seconds] !== undefined) throw new TypeError(`${where}: give ${iso} or ${seconds}, not both`);
  if (from[seconds] !== undefined) {
    if (typeof from[seconds] !== 'number') throw new TypeError(`${where}${seconds} must be a number of seconds`);
    return isoDuration(from[seconds]);
  }
  return from[iso] as string | undefined;
}

/**
 * A registration body from a merit policy in either form: a read (`merit.policies.get`, a `list` item, a `register`
 * answer: its `body` with the version's `repositoryId`, `targetRef` and `expiresAt`), a stored body, or a registration.
 * `...Seconds` durations become ISO-8601; the read-only fields (`id`, `version` of a read, `principalId`, the
 * registration's time and author, the standing) are dropped; unknown fields are kept, so the server names them.
 * `overrides` then replace the repository, target ref, expiry, version and `evaluation.model`. A draft without a
 * `version` takes the next one in `merit.policies.prepare`. Throws `TypeError` for a list, a non-object, a malformed
 * duration, or a draft still missing `repositoryId`, `targetRef`, `expiresAt` or `checkPolicyDigest`.
 */
export function meritPolicyInputFromRead(source: unknown, overrides: MeritPolicyOverrides = {}): MeritPolicyDraft {
  if (!isObject(source)) throw new TypeError('a merit policy is a JSON object');
  if (Array.isArray(source.items)) throw new TypeError('this is a list of merit policy versions; pass one of its items (or `merit policy get`)');
  const read = isObject(source.body);
  const flat: Record<string, unknown> = read ? { ...(source.body as Record<string, unknown>) } : { ...source };
  for (const k of READ_ONLY) delete flat[k];
  if (read) {
    for (const k of ['repositoryId', 'targetRef', 'expiresAt'] as const) if (source[k] !== undefined && flat[k] === undefined) flat[k] = source[k];
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flat)) if (k !== 'approvalTtlSeconds') out[k] = v;
  // A read's version is the source's own; a registration names the one it appends.
  if (read) delete out.version;
  const ttl = duration(flat, 'approvalTtl', 'approvalTtlSeconds', '');
  if (ttl !== undefined) out.approvalTtl = ttl;
  if (isObject(flat.evaluation)) {
    const rest: Record<string, unknown> = { ...flat.evaluation };
    delete rest.deadlineSeconds;
    const deadline = duration(flat.evaluation, 'deadline', 'deadlineSeconds', 'evaluation.');
    out.evaluation = { ...rest, ...(deadline === undefined ? {} : { deadline }) };
  }
  if (overrides.repositoryId !== undefined) out.repositoryId = overrides.repositoryId;
  if (overrides.targetRef !== undefined) out.targetRef = overrides.targetRef;
  if (overrides.expiresAt !== undefined) out.expiresAt = overrides.expiresAt;
  if (overrides.version !== undefined) out.version = overrides.version;
  if (overrides.evaluator !== undefined) out.evaluation = { ...(isObject(out.evaluation) ? out.evaluation : {}), model: overrides.evaluator };
  for (const k of ['repositoryId', 'targetRef', 'expiresAt', 'checkPolicyDigest'] as const) {
    if (typeof out[k] !== 'string' || !out[k]) throw new TypeError(`the merit policy has no ${k}${k === 'checkPolicyDigest' ? '' : ' (pass it as an override)'}`);
  }
  // Keys in the registration's order, unknown ones last.
  const ordered: Record<string, unknown> = {};
  for (const k of ['repositoryId', 'targetRef', 'version', 'expiresAt', ...BODY_FIELDS]) if (out[k] !== undefined) ordered[k] = out[k];
  for (const [k, v] of Object.entries(out)) if (!(k in ordered)) ordered[k] = v;
  return ordered as MeritPolicyDraft;
}

/** Why `merit.policies.copySource` found no single version to copy. */
export class MeritPolicySourceError extends Error {
  constructor(
    /** `no-live-policy`: the project has no live version (narrowed by the repository and target ref, when given);
     * `ambiguous-live-policy`: more than one is live, one per repository and target ref (`policyIds`). */
    readonly code: 'no-live-policy' | 'ambiguous-live-policy',
    readonly projectId: string,
    readonly policyIds: readonly string[],
  ) {
    super(code === 'no-live-policy' ? `project ${projectId} has no live merit policy to copy`
      : `project ${projectId} has ${policyIds.length} live merit policies (${policyIds.join(', ')}); name one`);
    this.name = 'MeritPolicySourceError';
  }
}
