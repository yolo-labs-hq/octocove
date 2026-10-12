import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasTreeSeed as local } from '../src/tree-seed.mjs';
import { hasTreeSeed as shared } from '../../../packages/shared/src/tree-seed.mjs';

// The image build context is apps/integrator, so it carries its own copy of the shared helper.
test('container-local tree-seed helper matches packages/shared', () => {
  assert.equal(local.toString(), shared.toString());
});
