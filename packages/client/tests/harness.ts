// Runtime-neutral test harness: no `node:` imports, so the same cases run under vitest on Node and
// bundled inside a workerd isolate (scripts/test-workerd.mjs).

export interface Case {
  readonly name: string;
  readonly run: () => unknown | Promise<unknown>;
}

export function test(name: string, run: Case['run']): Case {
  return { name, run };
}

export class AssertionError extends Error {
  override readonly name = 'AssertionError';
}

export function ok(condition: unknown, message = 'expected condition to hold'): asserts condition {
  if (!condition) throw new AssertionError(message);
}

const stable = (value: unknown): string => JSON.stringify(value, (_, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));

export function equal<T>(actual: T, expected: T, message?: string): void {
  if (stable(actual) !== stable(expected)) {
    throw new AssertionError(`${message ? `${message}: ` : ''}expected ${stable(expected)}, got ${stable(actual)}`);
  }
}

export async function rejects<E>(work: () => Promise<unknown>, kind: abstract new (...args: never[]) => E, message?: string): Promise<E> {
  try {
    await work();
  } catch (error) {
    if (error instanceof kind) return error;
    throw new AssertionError(`${message ? `${message}: ` : ''}expected ${kind.name}, got ${String(error)}`);
  }
  throw new AssertionError(`${message ? `${message}: ` : ''}expected ${kind.name}, but the call resolved`);
}

// The scripted fetch and answer builders are the package's own testing module (`@yolo-labs/octocove-client/testing`).
export { scriptedFetch, json, problem, type Recorded } from '../src/testing.js';

/** Never settles and ignores abort, like a stuck socket. */
export const hang = () => new Promise<Response>(() => {});

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Everything reachable from an error: message, stack, own properties (enumerable or not) and the cause chain. */
export function dumpError(value: unknown, depth = 0, seen = new Set<unknown>()): string {
  if (value === null || value === undefined || depth > 8 || seen.has(value)) return '';
  if (typeof value !== 'object') return String(value);
  seen.add(value);
  const parts: string[] = [];
  for (const key of new Set([...Object.getOwnPropertyNames(value), 'message', 'stack', 'cause'])) {
    const item = (value as Record<string, unknown>)[key];
    parts.push(`${key}=${typeof item === 'object' ? dumpError(item, depth + 1, seen) : String(item)}`);
  }
  return parts.join('\n');
}
