import { it, expect } from 'vitest';
import { stat } from 'node:fs/promises';
import { localEnvironment } from './conformance-fixture';

it('starts a secret-free local environment and a protected CLI setup helper, then removes both', async () => {
  const env = await localEnvironment();
  try {
    expect(env.apiUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    const socket = await env.helperSocket('setup-attempt', 'setup-repository');
    expect((await stat(socket)).isSocket()).toBe(true);
    expect((await stat(socket)).mode & 0o777).toBe(0o600);
  } finally {
    expect(await env.close()).toMatchObject({confirmed:true,liveResourcesCreated:0});
  }
  await expect(stat(env.directory)).rejects.toMatchObject({code:'ENOENT'});
}, 60000);

it('refuses new dispatch after a deadline and still confirms teardown', async () => {
  const controller = new AbortController();
  const env = await localEnvironment(controller.signal);
  controller.abort(new Error('cell-deadline-exceeded'));
  try {
    await expect(env.transport('/v1/tasks')).rejects.toThrow('cell-deadline-exceeded');
    await expect(env.repository('cancelled', 'artifacts')).rejects.toThrow('cell-deadline-exceeded');
    await expect(env.helperSocket('cancelled', 'cancelled')).rejects.toThrow('cell-deadline-exceeded');
  } finally {
    expect(await env.close()).toMatchObject({confirmed:true,localDirectoryRemoved:true});
  }
  await expect(stat(env.directory)).rejects.toMatchObject({code:'ENOENT'});
}, 60000);
