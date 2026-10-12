import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
function check(source: string) {
  const fixture = mkdtempSync(join(tmpdir(), 'octocove-invariant-checker-'));
  try {
    mkdirSync(join(fixture, 'docs'));
    mkdirSync(join(fixture, 'tests'));
    writeFileSync(join(fixture, 'docs/COLLABORATION_RECORD.md'), '**INV-01**');
    writeFileSync(join(fixture, 'tests/record-invariants.todo.md'),
      '| INV-01 | schema | covered | `tests/invariant.test.ts` | `covered invariant` |');
    writeFileSync(join(fixture, 'tests/invariant.test.ts'), source);
    return spawnSync(process.execPath, [join(root, 'tools/check-record-invariants.mjs'), '--root', fixture], { encoding: 'utf8' });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

it.each(['commented', 'skip-if', 'ancestor-skip', 'missing-title', 'it-skip', 'options-skip'])
  ('checker rejects false coverage from %s fixture', name => {
    const result = check(readFileSync(join(root, `tools/fixtures/record-invariants/${name}.ts`), 'utf8'));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/INV-01: (no test titled|test .* is skipped or todo)/);
    expect(result.stdout).not.toContain('covered by existing tests (verified)');
  });

it('checker verifies the active options-object fixture', () => {
  const result = check(readFileSync(join(root, 'tools/fixtures/record-invariants/options-active.ts'), 'utf8'));
  expect(result.status, result.stderr).toBe(0);
});

const signatures = [
  "'covered invariant', async () => {}",
  "'covered invariant', { timeout: 20_000 }, async () => {}",
  "'covered invariant', async () => {}, 20_000",
];
it.each(['it', 'test'].flatMap(kind => signatures.flatMap(args => [
  { source: `${kind}(${args});`, active: true },
  { source: `${kind}.each([1, 2])(${args});`, active: true },
  ...['skip', 'todo', 'only'].map(modifier => ({ source: `${kind}.${modifier}(${args});`, active: false })),
  { source: `${kind}.skip.each([1, 2])(${args});`, active: false },
  { source: `${kind}.each([])(${args});`, active: false },
  { source: `describe.skip('suite', () => { ${kind}(${args}); });`, active: false },
  { source: `// ${kind}(${args});`, active: false },
  { source: `${kind}(${args}); test.only('focused', { timeout: 20_000 }, () => {});`, active: false },
])))('checker handles Vitest signature $source', ({ source, active }) => {
  const result = check(source);
  expect(result.status, result.stderr).toBe(active ? 0 : 1);
});

it.each([
  "it.todo('covered invariant');",
  "it('covered invariant', { timeout: 20_000, skip: true }, () => {});",
  "test('covered invariant', { todo: true }, () => {});",
  "test('covered invariant', { skip: flag }, () => {});",
  "it('covered invariant', { ...options }, () => {});",
  "it('covered invariant', options, () => {});",
  "it('covered invariant', () => {}); test('focused', { only: true }, () => {});",
  "describe.todo('suite', () => { it('covered invariant', () => {}); });",
  "describe.only('suite', () => { it('covered invariant', () => {}); });",
  "it('covered invariant', () => {}); it.only('focused', () => {});",
  "describe.skipIf(flag)('suite', () => { it('covered invariant', () => {}); });",
  "describe.runIf(false)('suite', () => { it('covered invariant', () => {}); });",
  "it.each([])('covered invariant', () => {});",
  "const cases = []; it.each(cases)('covered invariant', () => {});",
  "function unused() { it('covered invariant', () => {}); }",
])('checker fails closed for %s', source => {
  expect(check(source).status).toBe(1);
});

it.each([
  "describe('suite', () => { it('covered invariant', () => {}); });",
  "test('covered invariant', { timeout: 20_000, skip: false, todo: false, only: false }, () => {});",
  "describe.skipIf(false)('suite', () => { it('covered invariant', () => {}); });",
  "describe.runIf(true)('suite', () => { it('covered invariant', () => {}); });",
  "it.each([1, 2])('covered invariant', () => {});",
  "describe.skip('unrelated', () => {}); it('covered invariant', () => {});",
])('checker verifies executable coverage for %s', source => {
  const result = check(source);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('1 covered by existing tests (verified)');
});

it('checker verifies the repository coverage ledger', () => {
  const ledger = readFileSync(join(root, 'tests/record-invariants.todo.md'), 'utf8');
  // Primary rows count invariants; supplemental references are additional coverage.
  const statuses = [...ledger.matchAll(/^\| INV-\d{2} \| [^|]+ \| (covered|planned) \|/gm)].map(row => row[1]);
  const defined = new Set([...readFileSync(join(root, 'docs/COLLABORATION_RECORD.md'), 'utf8')
    .matchAll(/\*\*(INV-\d{2})\*\*/g)].map(row => row[1])).size;
  const covered = statuses.filter(status => status === 'covered').length;
  const todo = statuses.filter(status => status === 'planned').length;
  expect(defined).toBe(covered + todo);

  const result = spawnSync(process.execPath, [join(root, 'tools/check-record-invariants.mjs')], { encoding: 'utf8' });
  // Successful verification requires zero skipped primary or supplemental references.
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain(`record invariants: ${defined} defined, ${covered} covered by existing tests (verified), ${todo} planned (no test yet)`);
});
