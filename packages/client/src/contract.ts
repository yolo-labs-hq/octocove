/**
 * Contract locks: a consumer states exactly which published operation contracts it accepts, and a locked client sends
 * only those, states them on every call and verifies every answer. Nothing here grants anything: the server authorizes
 * every call, a lock can only narrow what this client sends, and a listed operation is not thereby callable.
 */
import { CONTRACT_TABLE } from './generated/contract.js';
import { ContractRefusedError } from './errors.js';

/** What a response said about the contract that served it; `id` is absent on a path that is no operation. */
export interface ResponseContract {
  readonly id: string | undefined;
  readonly meta: string | undefined;
  /** The build commit: provenance only, never a compatibility signal. */
  readonly revision: string | undefined;
}

export const contractOf = (headers: { get(name: string): string | null }): ResponseContract | null => {
  const id = headers.get('x-octocove-contract') ?? undefined, meta = headers.get('x-octocove-meta') ?? undefined;
  const revision = headers.get('x-octocove-revision') ?? undefined;
  return id === undefined && meta === undefined && revision === undefined ? null : Object.freeze({ id, meta, revision });
};

export interface ContractRequirement {
  /** Capability name → the `ocap1:` ids accepted. Explicit ids only: there is no wildcard, and an empty list refuses. */
  readonly capabilities?: Readonly<Record<string, readonly string[]>>;
  /** Operation id → the `oc1:` ids accepted, beyond or instead of capability members. */
  readonly operations?: Readonly<Record<string, readonly string[]>>;
}

/** A verified lock: for each operation, the ids accepted, each one supported by this build. */
export interface ContractLock {
  readonly operations: Readonly<Record<string, readonly string[]>>;
}

const verified = new WeakSet<object>();
/** Only `requireCapabilities` makes a lock: a hand-built object is not one. */
export const isContractLock = (value: unknown): value is ContractLock => !!value && typeof value === 'object' && verified.has(value);

const META_VERSION = 1, ALGORITHM = 'oc1';
const MAX_META_BYTES = 1 << 20;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const own = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined => (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined);
const refuse = (reason: string, subject?: string): never => { throw new ContractRefusedError(reason, subject); };
const listed = (value: readonly string[] | undefined, subject: string): readonly string[] => {
  if (!Array.isArray(value) || value.length === 0 || !value.every((id) => typeof id === 'string' && id)) refuse('an accepted list must name explicit ids', subject);
  return value!;
};

interface MetaOperation { readonly contract: string; readonly epochs: Readonly<Record<string, number>> }
interface MetaDocument {
  readonly epochFamilies: readonly string[];
  readonly operations: Readonly<Record<string, MetaOperation>>;
  readonly capabilities: Readonly<Record<string, { readonly id: string; readonly operations: readonly string[] }>>;
}

/** The document, bounded and shape-checked: a value this client cannot read is a refusal, never a default. */
function metaDocument(text: string): MetaDocument {
  if (text.length > MAX_META_BYTES) refuse('the metadata document is too large');
  let document: unknown;
  try { document = JSON.parse(text); } catch { refuse('the metadata document is not JSON'); }
  if (!record(document)) return refuse('the metadata document is not an object');
  if (document.metaVersion !== META_VERSION) refuse('unknown metaVersion');
  if (document.algorithm !== ALGORITHM) refuse('unknown algorithm');
  const families = document.epochFamilies;
  if (!Array.isArray(families) || !families.every((family) => typeof family === 'string')) refuse('the epoch families are not readable');
  for (const family of families as string[]) if (!CONTRACT_TABLE.epochFamilies.includes(family)) refuse('unknown epoch family', family);
  if (!record(document.operations) || !record(document.capabilities)) refuse('the metadata document is not readable');
  return document as unknown as MetaDocument;
}

function operationIds(meta: MetaDocument, requirement: ContractRequirement) {
  const accepted = new Map<string, Set<string>>();
  const accept = (operationId: string, id: string) => {
    const set = accepted.get(operationId) ?? new Set<string>();
    set.add(id);
    accepted.set(operationId, set);
  };
  const supported = (operationId: string) => own(CONTRACT_TABLE.operations, operationId)?.supported ?? [];
  for (const [name, ids] of Object.entries(requirement.capabilities ?? {})) {
    const wanted = listed(ids, name);
    const served = own(meta.capabilities, name);
    if (!record(served)) return refuse('a required capability is absent', name);
    if (typeof served.id !== 'string' || !wanted.includes(served.id)) refuse('the served capability is not in the accepted list', name);
    const known = own(CONTRACT_TABLE.capabilities, name)?.supported ?? [];
    for (const id of wanted) {
      const entry = known.find((candidate) => candidate.id === id);
      if (!entry) return refuse('this build does not support an accepted capability id', name);
      for (const [operationId, contract] of Object.entries(entry.members)) accept(operationId, contract);
    }
    if (!Array.isArray(served.operations)) refuse('the served capability is not readable', name);
    for (const operationId of served.operations) if (!accepted.has(operationId)) refuse('a served member is not in the accepted capability', operationId);
  }
  for (const [operationId, ids] of Object.entries(requirement.operations ?? {})) {
    for (const id of listed(ids, operationId)) accept(operationId, id);
  }
  if (!accepted.size) refuse('the requirement names nothing');
  const operations: Record<string, readonly string[]> = {};
  for (const [operationId, ids] of accepted) {
    const served = own(meta.operations, operationId);
    if (!record(served)) return refuse('a required operation is absent', operationId);
    if (!ids.has(served.contract)) refuse('the served operation is not in the accepted list', operationId);
    if (!record(served.epochs)) refuse('the served epochs are not readable', operationId);
    for (const family of Object.keys(served.epochs)) if (!CONTRACT_TABLE.epochFamilies.includes(family)) refuse('unknown epoch family', operationId);
    const build = supported(operationId);
    for (const id of ids) if (!build.includes(id)) refuse('this build does not support an accepted id', operationId);
    operations[operationId] = Object.freeze([...ids]);
  }
  return operations;
}

/** Verifies a requirement against the metadata text and this build's own table. Fails closed with `ContractRefusedError`. */
export function lockFrom(text: string, requirement: ContractRequirement): ContractLock {
  if (!record(requirement)) return refuse('the requirement is not an object');
  const lock = Object.freeze({ operations: Object.freeze(operationIds(metaDocument(text), requirement)) });
  verified.add(lock);
  return lock;
}
