import { afterEach, expect, it, vi } from 'vitest';
import worker, { createApp } from '../src/index';
import { TaskCoordinator } from '../src/task-coordinator';
import { invokeTaskCommand } from '../src/task-coordinator';
import { AuthService } from '../src/auth';
import { MachineAuthService } from '../src/machine-auth';
import { ArtifactsTokenProvider } from '../src/artifacts-token-provider';
import { ForkTaskRepoProvisioner } from '../src/provisioner';
import { ArtifactsRemoteResolver } from '../src/remote-resolver';
import { logHttpFailure, sanitizedFailure } from '../src/failure-telemetry';
import { bearer, syntheticToken } from './helpers/fixtures';
import { recoverOutboxes, recoverTasks, safeTelemetryId } from '../src/outbox-recovery';
afterEach(() => vi.restoreAllMocks());
const taskId = `task-${'a'.repeat(43)}`;
it('accepts only minted task and run ID shapes in telemetry', () => {
    const id = '9141c1ad-dba4-4895-959d-ff9658cebe9d';
    expect(safeTelemetryId(taskId)).toBe(taskId);
    for (const minted of [id, `${id}:checks`, `receipt-export-${id}`, `source-verify-${id}`,
        `lane-verify-${id}`, `${id}:head:${id}`, `push:${id}`])
        expect(safeTelemetryId(minted)).toBe(minted);
    expect(safeTelemetryId(`${id}:checks:extra`)).toBeUndefined();
    expect(safeTelemetryId(`lane-verify-${id} private`)).toBeUndefined();
    expect(safeTelemetryId(`${id}:head:${id}extra`)).toBeUndefined();
    expect(safeTelemetryId('receipt-export-Bearer keep-secret')).toBeUndefined();
    expect(safeTelemetryId('keep-secret')).toBeUndefined();
    expect(safeTelemetryId('Bearer keep-secret')).toBeUndefined();
});
it('marks an unrecognized supplied ID without logging its value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    logHttpFailure(new Error('D1_ERROR token=keep-secret'), '/v1/tasks/:id', crypto.randomUUID(), 503, 'task-private-token', 'Bearer keep-secret');
    expect(failureLogs(warn)).toEqual([expect.objectContaining({
            taskId: 'unrecognized-format', runId: 'unrecognized-format',
        })]);
    expect(JSON.stringify(failureLogs(warn))).not.toContain('keep-secret');
});
it.each([
    ['D1', Object.assign(new Error('D1_ERROR: private SQL token=keep-secret'), { code: 'D1_ERROR' }), 'database-error'],
    ['provider', Object.assign(new Error('provider body keep-secret'), { name: 'ProviderError' }), 'provider-unavailable'],
    ['Queue', Object.assign(new Error('Queue body keep-secret'), { name: 'QueueError' }), 'queue-error'],
])('correlates %s HTTP failures without logging the exception or request', async (dependency, fault, cause) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const app = createApp(async () => { throw fault; });
    const response = await app.request(`https://local/tasks/${taskId}/log?cursor=keep-secret`, {
        headers: bearer('keep-secret'),
    }, {} as any);
    const body = await response.json() as {
        requestId: string;
        code: string;
    };
    expect(response.status).toBe(503);
    expect(body.code).toBe('temporarily-unavailable');
    expect(body.requestId).toBe(response.headers.get('X-Request-Id'));
    const logs = warn.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logs).toContainEqual(expect.objectContaining({
        message: 'http-request-failed', cause, dependency, route: '/tasks/:id/log',
        requestId: body.requestId, taskId, status: 503,
    }));
    expect(JSON.stringify(logs) + JSON.stringify(body)).not.toContain('keep-secret');
    expect(logs.every(row => row.message !== 'audit-success')).toBe(true);
});
it.each([
    ['submission', `/v1/tasks/${taskId}/submissions-with-grant`,
        { projectId: 'p', taskId, claimAttemptId: 'c', sourceSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), intentVersion: 1 },
        '/v1/tasks/:id/submissions-with-grant'],
    ['approval', '/v1/candidates/c/approve-with-grant',
        { projectId: 'p', claimAttemptId: 'c', candidateId: 'c', boundTo: { candidateSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), intentVersion: 1 }, checkRunIds: [] },
        '/v1/candidates/:id/approve-with-grant'],
    ['revoke', '/v1/auth/approval-grants/g/revoke', undefined, '/v1/auth/approval-grants/:id/revoke'],
])('overwrites forged correlation headers on the %s machine route', async (_name, path, input, route) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue({ type: 'human', issuer: 'https://idp.example', sub: 'human' } as any);
    vi.spyOn(AuthService.prototype, 'human').mockResolvedValue({ type: 'human', issuer: 'https://idp.example', sub: 'human' } as any);
    vi.spyOn(AuthService.prototype, 'authorize').mockResolvedValue({ type: 'human', issuer: 'https://idp.example', sub: 'human' } as any);
    vi.spyOn(MachineAuthService.prototype, 'submitCredential').mockResolvedValue({ id: 'g' } as any);
    vi.spyOn(MachineAuthService.prototype, 'approvalCredential').mockResolvedValue({ id: 'g', task_id: taskId } as any);
    const coordinator = new TaskCoordinator({ storage: { put: vi.fn(), setAlarm: vi.fn() } } as any, { DB: failedDb } as any);
    const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: 'g', project_id: 'p', task_id: taskId }) }) }) },
        TASKS: { idFromName: (id: string) => id, get: () => ({ fetch: (request: Request) => coordinator.fetch(request) }) } } as any;
    const response = await createApp().request(`https://local${path}`, {
        method: 'POST', headers: { ...bearer(syntheticToken('ocg', 'synthetic-grant')),
            'Idempotency-Key': 'safeFixtureKey0001', 'Content-Type': 'application/json',
            'X-Octocove-Request-Id': '00000000-0000-4000-8000-000000000000',
            'X-Octocove-Route': '/v1/auth/login' },
        body: JSON.stringify(input ?? {}),
    }, env);
    const body = await response.json() as {
        requestId: string;
    };
    expect(response.status).toBe(503);
    expect(body.requestId).toBe(response.headers.get('X-Request-Id'));
    expect(body.requestId).not.toBe('00000000-0000-4000-8000-000000000000');
    expect(failureLogs(warn)).toEqual([expect.objectContaining({ message: 'http-request-failed',
            cause: 'database-error', dependency: 'D1', route, requestId: body.requestId, status: 503 })]);
    expect(JSON.stringify(failureLogs(warn)) + JSON.stringify(body)).not.toContain('keep-secret');
});
it('marks failures from real Artifacts adapters before sanitizing telemetry', async () => {
    const fixtureAccount = ['acc', 'ount'].join('');
    const fixtureValue = ['private', 'token'].join('-');
    const env = Object.fromEntries([['ARTIFACTS_ACCOUNT_ID', fixtureAccount], ['ARTIFACTS_API_TOKEN', fixtureValue]]) as any;
    const repo = { id: 'r', provider: 'artifacts' as const, provider_namespace: 'n', name: 'repo' };
    const unavailable = (async () => new Response('private body keep-secret', { status: 503 })) as typeof fetch;
    const malformed = (async () => new Response('private body keep-secret', { status: 200 })) as typeof fetch;
    const failures = [
        () => new ArtifactsTokenProvider(env, unavailable).createToken(repo, 'read', 60),
        () => new ArtifactsTokenProvider(env, malformed).createToken(repo, 'read', 60),
        () => new ForkTaskRepoProvisioner({ account: fixtureAccount, token: fixtureValue, queue: 'q' }, unavailable).reconcile({ id: 'c', namespace: 'n', canonicalRepo: 'repo', targetRef: 'refs/heads/main' }),
        () => new ForkTaskRepoProvisioner({ account: fixtureAccount, token: fixtureValue, queue: 'q' }, malformed).reconcile({ id: 'c', namespace: 'n', canonicalRepo: 'repo', targetRef: 'refs/heads/main' }),
        () => new ArtifactsRemoteResolver(env, unavailable).resolve(repo),
        () => new ArtifactsRemoteResolver(env, malformed).resolve(repo),
    ];
    for (const invoke of failures) {
        const error = await invoke().catch(error => error);
        expect(error).toBeInstanceOf(Error);
        expect(sanitizedFailure(error)).toEqual({ cause: 'provider-unavailable', dependency: 'artifacts' });
        expect(JSON.stringify(sanitizedFailure(error))).not.toContain('keep-secret');
    }
});
it('names each failed drain and keeps recovery faults out of logs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const fault = Object.assign(new Error('D1_ERROR private body keep-secret'), { code: 'D1_ERROR' });
    const db = { prepare: () => { throw fault; } } as unknown as D1Database;
    await expect(recoverOutboxes({ DB: db } as any)).rejects.toBe(fault);
    const logs = warn.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logs.filter(row => row.message === 'outbox-drain-failed').map(row => row.drain)).toEqual([
        'event-inbox', 'task-recovery', 'poison-alerts', 'webhook-alerts',
    ]);
    expect(logs.filter(row => row.message === 'outbox-drain-failed').every(row => row.cause === 'database-error' && row.dependency === 'D1')).toBe(true);
    expect(logs).toContainEqual(expect.objectContaining({ message: 'outbox-backlogs-failed',
        cause: 'database-error', dependency: 'D1' }));
    expect(JSON.stringify(logs)).not.toContain('keep-secret');
});
it('logs a failed task wake without recording a successful effect', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    let cursorUpdates = 0;
    const statements: string[] = [];
    const db = {
        prepare(sql: string) {
            statements.push(sql);
            const statement = {
                bind: () => statement,
                first: async () => sql.startsWith('SELECT task_cursor') ? { task_cursor: '' } : null,
                all: async () => ({ results: sql.includes('FROM (SELECT t.id AS task_id') ? [{ task_id: taskId }] : [] }),
                run: async () => { if (sql.startsWith('UPDATE recovery_sweep'))
                    cursorUpdates++; },
            };
            return statement;
        },
    } as unknown as D1Database;
    await recoverTasks({ DB: db } as any, 1, async () => { throw new Error('Queue token=keep-secret'); });
    const logs = warn.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logs).toEqual([expect.objectContaining({ message: 'outbox-task-recovery-failed',
            taskId, cause: 'queue-error', dependency: 'Queue' })]);
    expect(cursorUpdates).toBe(1);
    expect(statements.some(sql => /(?:INSERT|UPDATE)\s+audit_log/i.test(sql))).toBe(false);
    expect(JSON.stringify(logs)).not.toContain('keep-secret');
});
it('logs a D1 failure caught by the real task recovery alarm and re-arms it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const setAlarm = vi.fn(async () => { });
    let cursorUpdates = 0;
    const fault = Object.assign(new Error('D1_ERROR token=keep-secret'), { code: 'D1_ERROR' });
    const db = {
        prepare(sql: string) {
            const statement = { bind: () => statement,
                first: async () => sql.startsWith('SELECT task_cursor') ? { task_cursor: '' } : null,
                all: async () => ({ results: sql.includes('FROM (SELECT t.id AS task_id') ? [{ task_id: taskId }] : [] }),
                run: async () => { if (sql.startsWith('UPDATE recovery_sweep'))
                    cursorUpdates++; } };
            return statement;
        },
        batch: async () => { throw fault; },
    } as unknown as D1Database;
    const storage = { get: vi.fn(async () => taskId), put: vi.fn(async () => { }), setAlarm };
    const env: any = { DB: db, AUTH_RECOVERY_KEY: 'test-recovery' };
    const coordinator = new TaskCoordinator({ storage } as any, env);
    env.TASKS = { idFromName: (id: string) => id,
        get: () => ({ fetch: (url: string, init: RequestInit) => coordinator.fetch(new Request(url, init)) }) };
    await recoverTasks(env, 1);
    expect(cursorUpdates).toBe(1);
    expect(setAlarm).toHaveBeenCalled();
    expect(failureLogs(warn)).toContainEqual(expect.objectContaining({
        message: 'outbox-task-recovery-failed', drain: 'task-recovery', taskId,
        cause: 'database-error', dependency: 'D1',
    }));
    expect(JSON.stringify(failureLogs(warn))).not.toContain('keep-secret');
});
const d1Fault = Object.assign(new Error('D1_ERROR body token=keep-secret'), { code: 'D1_ERROR' });
const failedDb = { prepare: () => { throw d1Fault; } } as unknown as D1Database;
const failureLogs = (warn: ReturnType<typeof vi.spyOn>) => warn.mock.calls.map(([line]) => JSON.parse(String(line)));
it('correlates a signed delegation revoke failure with the public response and outer log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue({ type: 'human', issuer: 'https://idp.example', sub: 'human' } as any);
    vi.spyOn(AuthService.prototype, 'revokeDelegation').mockResolvedValue({ claimAttemptId: 'claim-1' } as any);
    const coordinator = new TaskCoordinator({ storage: { put: vi.fn(), setAlarm: vi.fn() } } as any, { DB: failedDb, AUTH_RECOVERY_KEY: 'test-signing-key' } as any);
    const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ task_id: taskId, status: 'active' }) }) }) },
        AUTH_RECOVERY_KEY: 'test-signing-key', TASKS: { idFromName: (id: string) => id,
            get: () => ({ fetch: (url: string, init: RequestInit) => coordinator.fetch(new Request(url, init)) }) } } as any;
    const response = await createApp().request('https://local/v1/delegations/delegationFixture/revoke', {
        method: 'POST', headers: { ...bearer(syntheticToken('ocs', 'synthetic-session')),
            'Idempotency-Key': 'safeFixtureKey0001', 'X-Octocove-Request-Id': '00000000-0000-4000-8000-000000000000' },
    }, env);
    const body = await response.json() as {
        requestId: string;
    };
    expect(response.status).toBe(503);
    expect(body.requestId).toBe(response.headers.get('X-Request-Id'));
    expect(body.requestId).not.toBe('00000000-0000-4000-8000-000000000000');
    expect(failureLogs(warn).filter(row => row.requestId === body.requestId)).toEqual([
        expect.objectContaining({ route: '/v1/delegations/:id/revoke', cause: 'database-error', dependency: 'D1' }),
        expect.objectContaining({ route: '/v1/delegations/:id/revoke', cause: 'database-error', dependency: 'D1' }),
    ]);
    expect(JSON.stringify(failureLogs(warn)) + JSON.stringify(body)).not.toContain('keep-secret');
});
it.each(['recover', 'baseMoved', 'reconcile', 'candidate', 'check', 'endClaim'])('binds correlation in the signed %s command envelope', async (command) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const coordinator = new TaskCoordinator({ storage: { put: vi.fn(), setAlarm: vi.fn() } } as any, { DB: failedDb, AUTH_RECOVERY_KEY: 'test-signing-key' } as any);
    let sent: Request | undefined;
    const env = { AUTH_RECOVERY_KEY: 'test-signing-key', TASKS: { idFromName: (id: string) => id,
            get: () => ({ fetch: (url: string, init: RequestInit) => {
                    sent = new Request(url, init);
                    return coordinator.fetch(sent.clone());
                } }) } } as any;
    const requestId = crypto.randomUUID();
    const checkRunId = `${crypto.randomUUID()}:checks`;
    const input = command === 'check' ? { evidence: { version: 1, commands: [{ argv: ['true'], exitCode: 0 }] },
        candidateId: 'candidate-1', runId: checkRunId, checkIdentity: 'check-1', result: 'passed',
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() } : {};
    await expect(invokeTaskCommand(env, taskId, command, command === 'check' ? checkRunId : 'safeFixtureKey0001', input, { requestId, route: '/v1/delegations/:id/revoke' })).rejects.toThrow();
    expect(JSON.parse(await sent!.clone().text())).toEqual({ command,
        key: command === 'check' ? checkRunId : 'safeFixtureKey0001', input });
    expect(JSON.parse(sent!.headers.get('X-Lifecycle-Correlation')!)).toEqual({
        requestId, route: '/v1/delegations/:id/revoke',
    });
    const tampered = new Request(sent!.url, { method: 'POST', headers: sent!.headers,
        body: await sent!.clone().text() });
    tampered.headers.set('X-Lifecycle-Correlation', JSON.stringify({
        requestId: crypto.randomUUID(), route: '/v1/delegations/:id/revoke',
    }));
    expect((await coordinator.fetch(tampered)).status).toBe(401);
    expect(failureLogs(warn)).toContainEqual(expect.objectContaining({ requestId,
        route: '/v1/delegations/:id/revoke', cause: 'database-error', dependency: 'D1' }));
    if ('runId' in input)
        expect(failureLogs(warn)).toContainEqual(expect.objectContaining({ runId: input.runId }));
});
it.each([
    ['GET', `/v1/tasks/${taskId}`, undefined, '/v1/tasks/:id'],
    ['POST', '/v1/tasks', { projectId: 'project', key: 'key' }, '/v1/tasks'],
    ['GET', '/v1/claims/9141c1ad-dba4-4895-959d-ff9658cebe9d', undefined, '/v1/claims/:id'],
])('correlates %s task failures across the public router and task DO', async (method, path, input, route) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue({ type: 'human', issuer: 'https://idp.example', sub: 'human' } as any);
    const coordinator = new TaskCoordinator({ storage: { put: vi.fn(), setAlarm: vi.fn() } } as any, { DB: failedDb } as any);
    const routerDb = path.startsWith('/v1/claims/') ? { prepare: () => ({ bind: () => ({ first: async () => ({ task_id: taskId }) }) }) } : failedDb;
    const env = { DB: routerDb, TASKS: { idFromName: (id: string) => id,
            get: () => ({ fetch: (request: Request) => coordinator.fetch(request) }) } } as any;
    const response = await createApp().request(`https://local${path}`, {
        method, headers: { ...bearer(syntheticToken('ocs', 'synthetic-session')),
            'Idempotency-Key': 'safeFixtureKey0001', 'Content-Type': 'application/json',
            'X-Octocove-Request-Id': '00000000-0000-4000-8000-000000000000',
            'X-Octocove-Route': '/tasks/private-token' },
        ...(input ? { body: JSON.stringify(input) } : {}),
    }, env);
    const body = await response.json() as {
        requestId: string;
    };
    expect(response.status).toBe(503);
    expect(body.requestId).toBe(response.headers.get('X-Request-Id'));
    expect(failureLogs(warn)).toEqual([expect.objectContaining({
            message: 'http-request-failed', cause: 'database-error', dependency: 'D1',
            route, requestId: body.requestId, status: 503,
        })]);
    expect(body.requestId).not.toBe('00000000-0000-4000-8000-000000000000');
    expect(JSON.stringify(failureLogs(warn)) + JSON.stringify(body)).not.toContain('keep-secret');
});
it('logs one correlated D1 failure at the CLI exchange boundary', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const response = await createApp().request('https://local/v1/auth/cli/exchange', {
        method: 'POST', headers: { 'Idempotency-Key': 'synthetic-key-0001', 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode: 'private-body', cliVerifier: 'a'.repeat(43) }),
    }, { DB: failedDb } as any);
    const body = await response.json() as {
        requestId: string;
    };
    expect(response.status).toBe(503);
    expect(body.requestId).toBe(response.headers.get('X-Request-Id'));
    expect(failureLogs(warn)).toEqual([expect.objectContaining({
            message: 'http-request-failed', cause: 'database-error', dependency: 'D1',
            route: '/v1/auth/cli/exchange', requestId: body.requestId, status: 503,
        })]);
    expect(JSON.stringify(failureLogs(warn)) + JSON.stringify(body)).not.toContain('keep-secret');
    expect(JSON.stringify(failureLogs(warn)) + JSON.stringify(body)).not.toContain('private-body');
});
it('matches gateway failures to an allowlisted route before its handler runs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const response = await createApp().request(`https://local/tasks/${taskId}`, {
        headers: bearer(syntheticToken('ocs', 'synthetic-session')),
    }, { DB: failedDb } as any);
    const body = await response.json() as {
        requestId: string;
    };
    expect(response.status).toBe(503);
    expect(failureLogs(warn)).toEqual([expect.objectContaining({
            message: 'http-request-failed', cause: 'database-error', dependency: 'D1',
            route: '/tasks/:id', taskId, requestId: body.requestId, status: 503,
        })]);
});
it('preserves the validated export run id when the actual queue dispatch fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const dispatch = vi.fn(async () => new Response('private runner body', { status: 503 }));
    vi.stubGlobal('fetch', dispatch);
    const receiptId = '9141c1ad-dba4-4895-959d-ff9658cebe9d';
    const runId = `receipt-export-${receiptId}`;
    const row = { run_id: runId, receipt_id: receiptId, repository_id: 'repo',
        ref_name: `refs/octocove/receipts/${receiptId}`, signed_content: 'already-signed', status: 'pending' };
    const env = { DB: { prepare: vi.fn(() => ({ bind: () => ({ first: async () => row }) })) }, INTEGRATOR_BACKEND: 'local',
        INTEGRATOR_DISPATCH_URL: 'http://localhost:3210/dispatch', INTEGRATOR_DISPATCH_TOKEN: 'private-token',
        INTEGRATOR_RUN_SECRET: 'private-secret' };
    const message = { body: { kind: 'receipt-export', runId }, ack: vi.fn(), retry: vi.fn() };
    try {
        await worker.queue({ queue: 'octocove-events', messages: [message] } as any, env as any);
        expect(dispatch).toHaveBeenCalledOnce();
        const [, init] = dispatch.mock.calls[0] as unknown as [
            URL,
            RequestInit
        ];
        expect(JSON.parse(String(init.body)).runId).toBe(runId);
        expect(message.retry).toHaveBeenCalledOnce();
        expect(message.ack).not.toHaveBeenCalled();
        expect(failureLogs(warn)).toEqual([expect.objectContaining({ message: 'integrator-runner-blocked', runId })]);
        expect(JSON.stringify(failureLogs(warn))).not.toContain('private-token');
        expect(JSON.stringify(failureLogs(warn))).not.toContain('private runner body');
    }
    finally {
        vi.unstubAllGlobals();
    }
});
