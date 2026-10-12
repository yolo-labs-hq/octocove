/** Generic client composition fixture; record IDs are opaque. */
type Id<K extends string> = string & { readonly __kind: K };
export type RepositoryId = Id<'repository'>;
export type SubmissionId = Id<'submission'>;
export type CandidateId = Id<'candidate'>;
export type ReceiptId = Id<'receipt'>;
export type WorkflowSubject = { kind: 'provider-pr'; number: number } |
  { kind: 'octocove-submission'; submissionId: SubmissionId; candidateId?: CandidateId; receiptId?: ReceiptId };
export interface VerifiedMapping {
  verified: true; tenantId: string; attemptId: string; generation: number;
  sourceRepoId: RepositoryId; sourceRemote: string; sourceRef: string;
  canonicalRepoId: RepositoryId; canonicalRemote: string; targetRef: string; policyVersion: string;
}
export interface PreviewSource {
  kind: 'submission' | 'candidate'; repoId: RepositoryId; remote: string;
  ref: string; sha: string; credentialRef: string; generation: number;
}
export class ContractDenied extends Error {}
export function verifyMapping(registered: VerifiedMapping, presented: VerifiedMapping): Readonly<VerifiedMapping>;
export function recordId(kind: 'submission' | 'candidate' | 'receipt', value: string): Readonly<{ kind: string; id: string }>;
export interface Storage {
  kind: string;
  read(mapping: VerifiedMapping, sha: string): Promise<unknown>;
  compare(mapping: VerifiedMapping, base: string, head: string): Promise<unknown>;
  preview(descriptor: PreviewSource): Promise<{ sha: string }>;
}
export interface Workflow {
  submit(mapping: VerifiedMapping, input: unknown): Promise<unknown>;
  candidate(mapping: VerifiedMapping, input: unknown): Promise<unknown>;
  approve(mapping: VerifiedMapping, input: unknown): Promise<unknown>;
  land(mapping: VerifiedMapping, input: unknown): Promise<unknown>;
  cleanup(mapping: VerifiedMapping, receipt: unknown): Promise<unknown>;
}
export interface Policy { octocoveLanding?: boolean; exactHumanApproval?: boolean; version?: string }
export function selectProvider(policy: Policy, storage: Storage, workflow?: Workflow): Storage | Readonly<{ kind: string; storage: Storage; workflow: Workflow; policyVersion?: string }>;
export class ClientContractFixture {
  constructor(input: { policy: Policy; storage: Storage; workflow: Workflow; mapping: VerifiedMapping });
  authority(presented: VerifiedMapping): Readonly<VerifiedMapping>;
  read(presented: VerifiedMapping, sha: string): Promise<unknown>;
  compare(presented: VerifiedMapping, base: string, head: string): Promise<unknown>;
  submit(presented: VerifiedMapping, input: unknown): Promise<unknown>;
  candidate(presented: VerifiedMapping, input: unknown): Promise<unknown>;
  approve(presented: VerifiedMapping, input: unknown): Promise<unknown>;
  land(presented: VerifiedMapping, input: unknown): Promise<unknown>;
  preview(presented: VerifiedMapping, descriptor: PreviewSource): Promise<{ sha: string; cacheKey: string }>;
  cleanup(presented: VerifiedMapping, receipt: unknown): Promise<unknown>;
}
