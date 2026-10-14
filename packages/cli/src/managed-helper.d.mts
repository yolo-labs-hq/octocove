import type { FetchLike } from './http.js';
export function startManagedHelper(options: {
  apiUrl: string; token: string; kind: string; fetch: FetchLike; taskId: string; claimId: string;
  projectId: string; baseSha?: string; signal?: AbortSignal; deadline?: number;
  stderr: (text: string) => void;
}): Promise<{socketPath: string; ref: string; readonly failure?: Error; close(): Promise<void>}>;

export function requireAgentCredential(kind: string): void;
