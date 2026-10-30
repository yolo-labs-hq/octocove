import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { saveCredentials } from '../src/config.js';
import { run } from '../src/cli.js';

const ORG = 'org_00000000-0000-4000-8000-000000000001';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

it('--log-json prints each request, response and retry as a redacted JSON line on stderr, and stdout keeps the command output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-log-json-')); dirs.push(dir);
  const env = { OCTOCOVE_CONFIG_DIR: dir, OCTOCOVE_ORG: ORG };
  await saveCredentials(env, { apiUrl: 'https://api.example.invalid/v1', kind: 'human', token: 'stored-session-secret' });
  let stdout = '', stderr = '', n = 0;
  const code = await run({ argv: ['--log-json', 'task', 'list', '--project', 'P1', '--json'], env, stdin: async () => '', git: async () => '',
    stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; },
    fetch: async () => {
      if (n++ === 0) throw new TypeError('fetch failed stored-session-secret');
      return Response.json({ items: [] }, { headers: { 'x-request-id': 'srv-1' } });
    } });
  expect(code, stderr).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ items: [] });
  const events = stderr.trim().split('\n').map((line) => JSON.parse(line));
  expect(events.map((e) => e.event)).toEqual(['request', 'retry', 'request', 'response']);
  expect(events.at(-1)).toMatchObject({ operationId: 'tasksList', status: 200, requestId: 'srv-1', credential: 'session', attempt: 2 });
  expect(new Set(events.map((e) => e.clientRequestId)).size).toBe(1);
  expect(stderr).not.toContain('stored-session-secret');
});
