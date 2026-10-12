import { it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childRun, expectExit, groupMembers } from './helpers/child-run';
// tests/helpers/tracked-work.ts settles a failed test's held work before its Miniflare is disposed, so
// nothing from that test (a late D1 call, its rejection) reaches the next one. A child vitest run whose
// first test throws while its tick is held proves it; the dispose-first control proves the check can fail.
// A second fixture proves a tracked rejection fails its owning test even when that test's body passed.
// Each child run has exactly its fixture's failing test, so it must exit 1 by itself before its reports count.

async function child(fixture: 'teardown' | 'rejection', order: 'settle-first' | 'dispose-first' = 'settle-first',
  hang?: { marker: string; timeoutMs: number; onSpawn: (pgid: number) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'tracked-teardown-'));
  try {
    const run = await childRun('tests/fixtures/tracked-teardown/vitest.config.ts', {
      args: [`${fixture}.fixture.ts`], signal: AbortSignal.timeout(hang?.timeoutMs ?? 35_000), onSpawn: hang?.onSpawn,
      env: { TRACKED_TEARDOWN_ORDER: order, TRACKED_TEARDOWN_JSON: join(dir, 'report.json'), TRACKED_TEARDOWN_UNHANDLED: join(dir, 'unhandled.json'),
        ...(hang && { TRACKED_TEARDOWN_HANG: hang.marker }) } });
    expectExit(run, 1);
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as {
      testResults: { assertionResults: { title: string; status: string; failureMessages: string[] }[] }[] };
    const results = Object.fromEntries(report.testResults.flatMap(file => file.assertionResults).map(r => [r.title, r]));
    return { results, unhandled: JSON.parse(readFileSync(join(dir, 'unhandled.json'), 'utf8')) as string[], output: run.output };
  } finally { rmSync(dir, { recursive: true, force: true }); } // only after the child run has exited
}

it('a test that fails while its tick is held leaks nothing into the next test', async () => {
  const { results, unhandled, output } = await child('teardown');
  const failed = results['fails while its delivery tick is held']!, next = results['runs clean after the failed test']!;
  expect(failed.status, output).toBe('failed');
  expect(failed.failureMessages).toHaveLength(1);
  expect(failed.failureMessages[0]).toMatch(/^Error: injected failure while the tick is held\n/);
  expect(next.status, next.failureMessages.join('\n')).toBe('passed');
  expect(unhandled).toEqual([]);
}, 40_000);

it('control: disposing before settling is caught by the same check', async () => {
  const { results } = await child('teardown', 'dispose-first');
  expect(results['fails while its delivery tick is held']!.status).toBe('failed');
  const next = results['runs clean after the failed test']!;
  expect(next.status).toBe('failed');
  expect(next.failureMessages[0]).toContain('rejected: Cannot use disposed instance');
}, 40_000);

it('a passing test whose tracked work rejects in teardown fails with that rejection, and the next runs clean', async () => {
  const { results, unhandled, output } = await child('rejection');
  const owner = results['passes while its tracked work is held, then the work rejects']!, next = results['runs clean after the rejected tracked work']!;
  expect(owner.status, output).toBe('failed');
  expect(owner.failureMessages).toHaveLength(1);
  expect(owner.failureMessages[0]).toMatch(/^AggregateError: tracked work rejected: Error: injected tracked rejection after release\n/);
  expect(next.status, next.failureMessages.join('\n')).toBe('passed');
  expect(unhandled).toEqual([]);
}, 40_000);

// The same passing teardown run, but its coordinator blocks forever once both reports are on disk. The
// reports alone would pass the assertions above; the stop must fail the owning test, naming the timeout,
// and leave nothing of the child's process group behind.
it('a child run that writes its reports and then hangs fails its owning test, naming the timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracked-teardown-hang-')), marker = join(dir, 'hung');
  try {
    let pgid = 0;
    await expect(child('teardown', 'settle-first', { marker, timeoutMs: 10_000, onSpawn: id => { pgid = id; } }))
      .rejects.toThrow(/^child vitest run timed out and was killed; its reports are not trusted\n/);
    expect(existsSync(marker), 'the child hung only after writing its reports').toBe(true);
    for (let i = 0; i < 40 && groupMembers(pgid).length; i++) await new Promise(resolve => setTimeout(resolve, 50));
    expect(groupMembers(pgid)).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 20_000);
