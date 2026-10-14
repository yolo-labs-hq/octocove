import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { compareTrees } from '../src/code-compare';
import type { ArtifactsContent } from '../src/code-view';

const id = (n: number) => n.toString(16).padStart(40, '0');

// A small object DAG represents exponentially many repository paths.
it.each([17, 64])('bounds repeated subtree expansion at depth %i, including cache revisits', async depth => {
  let reads = 0;
  const content = { tree: async (hash: string) => {
    reads++;
    if (hash === id(99)) return [];
    const level = parseInt(hash, 16);
    return level === depth
      ? [{ name: 'leaf', type: 'file', hash: 'f'.repeat(40), size: 0 }]
      : [{ name: 'a', type: 'dir', hash: id(level + 1) }, { name: 'b', type: 'dir', hash: id(level + 1) }];
  } };
  await expect(compareTrees(content as unknown as ArtifactsContent, id(99), id(0)))
    .rejects.toMatchObject({ status: 413, code: 'comparison-too-large' });
  expect(reads).toBeLessThanOrEqual(depth + 2);
}, 10_000);

it('counts each shared subtree path while reading each object once within budget', async () => {
  const reads: string[] = [];
  const content = { tree: async (hash: string) => {
    reads.push(hash);
    if (hash === id(99)) return [];
    if (hash === id(1)) return [{ name: 'leaf', type: 'file', hash: 'f'.repeat(40), size: 0 }];
    return [{ name: 'a', type: 'dir', hash: id(1) }, { name: 'b', type: 'dir', hash: id(1) }];
  } };
  const result = await compareTrees(content as unknown as ArtifactsContent, id(99), id(0));
  expect(result.listed.map(file => file.path)).toEqual(['a/leaf', 'b/leaf']);
  expect(result.omittedFiles).toBe(0);
  expect(reads.sort()).toEqual([id(0), id(1), id(99)].sort());
});

it('validates canonical compare, history and person response fixtures against the published schemas', () => {
  const spec = parse(readFileSync(new URL('../../spec/openapi.yaml', import.meta.url), 'utf8'));
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const name of ['code-compare', 'code-commits', 'people-get']) {
    const fixture = JSON.parse(readFileSync(new URL(`../../spec/fixtures/contract/${name}.json`, import.meta.url), 'utf8'));
    const schema = spec.paths[fixture.path][fixture.method].responses[String(fixture.status)].content['application/json'].schema;
    const validate = ajv.compile({ ...schema, components: spec.components });
    expect(validate(fixture.body), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...fixture.body, unexpected: true })).toBe(false);
    if (name === 'people-get') {
      expect(validate({ ...fixture.body, email: 'person@example.invalid' })).toBe(false);
      expect(validate({ ...fixture.body, profile: { ...fixture.body.profile, email: 'person@example.invalid' } })).toBe(false);
    }
  }
});
