import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendTransitions, auditTypes, listAudit, replayEvents, type AuditEntry, type AuditRow } from '../src/audit';
import { auditCursorKeys, type AuditCursorKeys } from '../src/audit-cursor-keys';
import { deriveReceipt, renderReceipt } from '../src/receipt';
import { createApp } from '../src/index';
const directories: string[] = [];
class Sqlite {
    path: string;
    constructor() {
        const dir = mkdtempSync(join(tmpdir(), 'oc-audit-'));
        directories.push(dir);
        this.path = join(dir, 'db');
        const migrations = new URL('../migrations/', import.meta.url);
        this.run({ script: readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()
                .map(name => readFileSync(new URL(name, migrations), 'utf8')).join('\n') + `
      INSERT INTO projects(id,slug,name,created_by,created_at) VALUES ('p', 'p', 'Project', 'human', '2026-10-04T00:00:00Z');
      CREATE TABLE test_state (id TEXT PRIMARY KEY, version INTEGER NOT NULL);
      INSERT INTO test_state VALUES ('one', 0), ('two', 0);` });
    }
    run(request: object): any {
        const result = JSON.parse(execFileSync('python3', [new URL('./sqlite.py', import.meta.url).pathname], {
            input: JSON.stringify({ path: this.path, ...request }), encoding: 'utf8',
        }));
        if (result.error)
            throw new Error(result.error);
        return result;
    }
    prepare(sql: string) {
        const statement = { sql, params: [] as unknown[],
            bind: (...params: unknown[]) => { statement.params = params; return statement; },
            all: async () => this.run({ statements: [statement] })[0],
            first: async () => this.run({ statements: [statement] })[0].results[0] ?? null,
        };
        return statement;
    }
    async batch(statements: unknown[]) { return this.run({ statements }); }
    get db() { return this as unknown as D1Database; }
}
afterEach(() => { directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
const scope = { principalId: 'reader', projectId: 'p' };
function entry(type: AuditEntry['type'], key: string): AuditEntry {
    return { at: '2026-10-04T00:00:00.000Z', actor: { type: 'system', id: 'cp' }, projectId: 'p', taskId: null, type,
        refs: { intentVersion: 1, sourceSha: 'source', eventIds: ['event'] }, idempotencyKey: key };
}
function transition(audit: AuditEntry, version?: number) {
    return { mutation: { sql: `UPDATE test_state SET version = version + 1 WHERE id = ?${version === undefined ? '' : ' AND version = ?'}`,
            params: version === undefined ? ['one'] : ['one', version] }, audit };
}
describe('transactional append-only log', () => {
    it('supports every COLLABORATION_RECORD §10 event exactly once and the vocabulary matches the schema and document', async () => {
        const sqlite = new Sqlite();
        const sql = (await sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='audit_log'").first()).sql as string;
        const types = [...sql.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map(m => m[1]);
        expect(new Set(auditTypes)).toEqual(new Set(types));
        const doc = readFileSync(new URL('../../docs/COLLABORATION_RECORD.md', import.meta.url), 'utf8').split('## 10. Audit log')[1]!.split('## 11.')[0]!;
        for (const type of auditTypes)
            expect(doc).toContain(type);
        await appendTransitions(sqlite.db, auditTypes.map(type => transition(entry(type, type))));
        const rows = (await sqlite.prepare('SELECT type, count(*) AS n FROM audit_log GROUP BY type').all()).results;
        expect(rows).toHaveLength(auditTypes.length);
        expect(rows.every((row: any) => row.n === 1)).toBe(true);
        expect((await sqlite.prepare("SELECT version FROM test_state WHERE id = 'one'").first()).version).toBe(auditTypes.length);
    });
    it('commits ancillary snapshot writes with one logical transition, and rolls them back on audit failure', async () => {
        const sqlite = new Sqlite();
        sqlite.run({ script: 'CREATE TABLE test_snapshot (id TEXT PRIMARY KEY, title TEXT NOT NULL);' });
        await appendTransitions(sqlite.db, [{ ...transition(entry('intent.edited', 'intent'), 0),
                afterMutations: [{ sql: 'INSERT INTO test_snapshot VALUES (?, ?)', params: ['v1', 'first'] }] }]);
        expect((await sqlite.prepare('SELECT count(*) AS n FROM audit_log').first()).n).toBe(1);
        expect((await sqlite.prepare('SELECT title FROM test_snapshot').first()).title).toBe('first');
        await expect(appendTransitions(sqlite.db, [{ ...transition(entry('intent.edited', 'intent'), 1),
                afterMutations: [{ sql: 'INSERT INTO test_snapshot VALUES (?, ?)', params: ['v2', 'second'] }] }])).rejects.toThrow();
        expect((await sqlite.prepare('SELECT count(*) AS n FROM test_snapshot').first()).n).toBe(1);
        expect((await sqlite.prepare("SELECT version FROM test_state WHERE id = 'one'").first()).version).toBe(1);
    });
    it('rejects UPDATE, DELETE, replacement, unknown types and direct application writes to audit', async () => {
        const sqlite = new Sqlite();
        await appendTransitions(sqlite.db, [transition(entry('task.ready', 'ready'))]);
        for (const sql of ["UPDATE audit_log SET actor_id = 'evil'", 'DELETE FROM audit_log',
            "INSERT OR REPLACE INTO audit_log SELECT * FROM audit_log"]) {
            await expect(sqlite.batch([sqlite.prepare(sql)])).rejects.toThrow('append-only');
        }
        await expect(appendTransitions(sqlite.db, [{ mutation: { sql: 'DELETE FROM audit_log' }, audit: entry('task.ready', 'delete') }])).rejects.toThrow('unsupported');
        await expect(appendTransitions(sqlite.db, [transition({ ...entry('task.ready', 'unknown'), type: 'invented' as any })])).rejects.toThrow('invalid-audit');
        expect((await sqlite.prepare('SELECT count(*) AS n FROM audit_log').first()).n).toBe(1);
    });
    it.each(['beforeMutations', 'afterMutations'] as const)('refuses entity status writes hidden in %s', async (position) => {
        const sqlite = new Sqlite();
        await expect(appendTransitions(sqlite.db, [{ ...transition(entry('task.ready', 'hidden')),
                [position]: [{ sql: "UPDATE tasks SET updated_at = ?, status = 'ready' WHERE id = ?", params: ['now', 't1'] }] }]))
            .rejects.toThrow('ancillary-status-transition');
        expect((await sqlite.prepare('SELECT count(*) AS n FROM audit_log').first()).n).toBe(0);
        expect((await sqlite.prepare("SELECT version FROM test_state WHERE id = 'one'").first()).version).toBe(0);
    });
    it.each([0, 1, 2])('rolls back a per-entity batch when element %i misses its expected state', async (miss) => {
        const sqlite = new Sqlite();
        sqlite.run({ script: "INSERT INTO test_state VALUES ('three', 0); CREATE TABLE test_snapshot(id TEXT PRIMARY KEY);" });
        const entities = ['one', 'two', 'three'];
        await expect(appendTransitions(sqlite.db, entities.map((id, index) => ({
            mutation: { sql: 'UPDATE test_state SET version=version+1 WHERE id=? AND version=?', params: [id, index === miss ? 99 : 0] },
            audit: { ...entry('landing.fenced', `fence:${id}`), refs: { entityId: id, fromStatus: 0, toStatus: 1 } },
            afterMutations: [{ sql: 'INSERT INTO test_snapshot VALUES (?)', params: [id] }],
        })))).rejects.toThrow();
        expect((await sqlite.prepare('SELECT version FROM test_state ORDER BY id').all()).results).toEqual(entities.map(() => ({ version: 0 })));
        expect((await sqlite.prepare('SELECT count(*) AS n FROM audit_log').first()).n).toBe(0);
        expect((await sqlite.prepare('SELECT count(*) AS n FROM test_snapshot').first()).n).toBe(0);
    });
    it('rolls back state and all audit rows on a CAS miss, multi-row mutation, duplicate or failed mutation', async () => {
        const sqlite = new Sqlite();
        await appendTransitions(sqlite.db, [transition(entry('task.ready', 'ready'), 0)]);
        for (const bad of [transition(entry('task.unready', 'miss'), 99), transition(entry('task.ready', 'ready')),
            { mutation: { sql: 'UPDATE test_state SET version = version + 1' }, audit: entry('task.unready', 'many') },
            { mutation: { sql: 'UPDATE test_state SET version = NULL WHERE id = ?', params: ['one'] }, audit: entry('task.unready', 'null') }]) {
            await expect(appendTransitions(sqlite.db, [transition(entry('intent.edited', 'earlier')), bad])).rejects.toThrow();
            expect((await sqlite.prepare("SELECT version FROM test_state WHERE id = 'one'").first()).version).toBe(1);
            expect((await sqlite.prepare('SELECT count(*) AS n FROM audit_log').first()).n).toBe(1);
        }
    });
});
describe('query routes', () => {
    it('paginates, resumes empty pages, compares timestamps and binds signed cursors to access and filters', async () => {
        const sqlite = new Sqlite();
        await appendTransitions(sqlite.db, [transition(entry('task.ready', 'one')), transition({ ...entry('task.unready', 'two'), at: '2026-10-04T00:00:01Z' })]);
        const first = await listAudit(sqlite.db, scope, { limit: '1' }, 'secret');
        expect(first.items.map(row => row.id)).toEqual(['1']);
        const next = await listAudit(sqlite.db, scope, { cursor: first.nextCursor }, 'secret');
        expect(next.items.map(row => row.id)).toEqual(['2']);
        const empty = await listAudit(sqlite.db, scope, { cursor: next.nextCursor }, 'secret');
        expect(empty.items).toEqual([]);
        expect(empty.nextCursor).toBe(next.nextCursor);
        expect((await listAudit(sqlite.db, scope, { since: '2026-10-04T00:00:00Z' }, 'secret')).items.map(row => row.id)).toEqual(['2']);
        for (const altered of [{ ...scope, principalId: 'other' }, { ...scope, projectId: 'other' }]) {
            await expect(listAudit(sqlite.db, altered, { cursor: first.nextCursor }, 'secret')).rejects.toThrow('invalid-cursor');
        }
        await expect(listAudit(sqlite.db, scope, { cursor: first.nextCursor, since: '2026-10-04T00:00:00Z' }, 'secret')).rejects.toThrow('invalid-cursor');
        await expect(listAudit(sqlite.db, scope, { cursor: first.nextCursor + 'x' }, 'secret')).rejects.toThrow('invalid-cursor');
        await expect(listAudit(sqlite.db, scope, { limit: '201' }, 'secret')).rejects.toThrow('invalid-request');
        await expect(listAudit(sqlite.db, { ...scope, taskId: 'task' }, {}, 'secret')).rejects.toThrow('forbidden');
        await expect(listAudit(sqlite.db, scope, { taskId: 'unknown' }, 'secret')).rejects.toThrow('not-found');
    });
    it('fails closed without auth and serves only authorized project rows', async () => {
        const sqlite = new Sqlite();
        const env = { DB: sqlite.db, AUDIT_CURSOR_SECRET: 'secret' } as any;
        expect((await createApp().request('/audit', {}, env)).status).toBe(401);
        const app = createApp(async () => scope);
        await appendTransitions(sqlite.db, [transition(entry('task.ready', 'ready'))]);
        expect((await (await app.request('/audit', {}, env)).json()).items).toHaveLength(1);
        expect((await app.request('/tasks/unknown/log', {}, env)).status).toBe(404);
        expect((await app.request('/audit?since=no', {}, env)).status).toBe(400);
        expect((await app.request('/audit', {}, { DB: sqlite.db } as any)).status).toBe(503);
        expect((await (await createApp(async () => ({ ...scope, projectId: 'other' })).request('/audit', {}, env)).json()).items).toEqual([]);
    });
});
function receiptRows(task: string, fence: string, base: string, candidate: string, outcome: string = 'landed'): AuditRow[] {
    const refs = { fenceId: fence, receiptId: fence, candidateId: candidate, approvalId: `approval-${candidate}`,
        repositoryId: 'canonical', targetRef: 'refs/heads/main', sourceSha: `source-${candidate}`, candidateSha: candidate,
        baseShaBefore: base, intentVersion: 1, approvedBy: 'reviewer', approvedAt: '2026-10-04T00:59:00Z', integratorRunId: `run-${fence}`,
        boundTo: { submissionId: `submission-${candidate}`, candidateSha: candidate, baseSha: base, intentVersion: 1 } };
    const final = { outcome, landedSha: outcome === 'landed' ? candidate : null,
        baseShaAfter: outcome === 'landed' ? candidate : 'winner', conflictFiles: outcome === 'conflict' ? ['src/parser.ts'] : null,
        errorDetail: null, reconciledAgainstSha: outcome === 'landed' ? candidate : 'winner', reconciledAt: '2026-10-04T01:00:00Z',
        ancestryVerified: outcome === 'landed', eventIdsConsumed: [`event-${fence}`], createdAt: '2026-10-04T01:00:00Z' };
    return ['landing.fenced', 'landing.resolved', 'landing.reconciled', 'landing.fence_released', ...(outcome === 'landed' ? ['task.landed'] : [])]
        .map((type, i) => ({ id: String(i + 1), at: '2026-10-04T01:00:00Z', actorType: 'human', actorId: 'reviewer', projectId: 'p', taskId: task,
        type, refs: i === 0 ? refs : { fenceId: fence, ...final }, idempotencyKey: `${fence}-${type}` } as AuditRow));
}
describe('audit-only landing receipts', () => {
    it('renders COLLABORATION_RECORD §10 upstream landing, explicit conflict and recompute/re-approval from stored audit rows', async () => {
        const sqlite = new Sqlite();
        sqlite.run({ script: `
      INSERT INTO repositories (id, project_id, provider_namespace, provider_repo_id, name, role, created_at)
        VALUES ('canonical', 'p', 'org', 'repo', 'repo', 'canonical', '2026-10-04T00:00:00Z');
      INSERT INTO target_refs (repository_id, ref_name) VALUES ('canonical', 'refs/heads/main');
      INSERT INTO tasks (id, project_id, repository_id, target_ref, key, status, status_changed_at, created_by, created_at, updated_at)
        VALUES ('T1', 'p', 'canonical', 'refs/heads/main', 'T1', 'draft', '2026-10-04T00:00:00Z', 'human', '2026-10-04T00:00:00Z', '2026-10-04T00:00:00Z'),
        ('T2', 'p', 'canonical', 'refs/heads/main', 'T2', 'draft', '2026-10-04T00:00:00Z', 'human', '2026-10-04T00:00:00Z', '2026-10-04T00:00:00Z');` });
        const scenario = [...receiptRows('T1', 'f1', 'b0', 'k1'), ...receiptRows('T2', 'blocked', 'k1', 'k2', 'conflict'),
            ...receiptRows('T2', 'f2', 'k1', 'k3')];
        await appendTransitions(sqlite.db, scenario.map((row, i) => transition({ at: row.at, actor: { type: row.actorType, id: row.actorId },
            projectId: row.projectId, taskId: row.taskId, type: row.type, refs: row.refs, idempotencyKey: `scenario-${i}` })));
        const page = await listAudit(sqlite.db, scope, {}, 'secret');
        const rows = page.items;
        expect(renderReceipt(rows, 'f1')).toContain('Canonical b0 → k1; landed k1');
        expect(renderReceipt(rows, 'blocked')).toContain('Conflicts: src/parser.ts');
        expect(renderReceipt(rows, 'f2')).toContain('approval approval-k3 bound to submission submission-k3');
        expect(deriveReceipt(rows, 'f2').boundTo.baseSha).toBe('k1');
        expect(deriveReceipt(rows, 'f1').eventIdsConsumed).toEqual(['event-f1']);
        expect(renderReceipt([...rows].reverse(), 'f2')).toContain('fetched-object ancestry verified');
    });
    it('refuses pending, missing or contradictory evidence and renders raced outcomes', () => {
        const rows = receiptRows('T2', 'f', 'b0', 'k2', 'raced');
        expect(deriveReceipt(rows, 'f').outcome).toBe('raced');
        expect(() => deriveReceipt(rows.slice(0, 2), 'f')).toThrow('receipt-pending');
        const invalid = receiptRows('T1', 'f', 'b0', 'k1');
        invalid[0]!.refs.boundTo = { submissionId: 's', candidateSha: 'wrong', baseSha: 'b0', intentVersion: 1 };
        expect(() => deriveReceipt(invalid, 'f')).toThrow('invalid-receipt-evidence');
        delete invalid[0]!.refs.sourceSha;
        expect(() => deriveReceipt(invalid, 'f')).toThrow('receipt-missing-sourceSha');
    });
});
describe('replay retention and cursor rotation', () => {
    const retiredAt = Date.parse('2026-10-05T00:00:00Z');
    const deadline = retiredAt + 90 * 86400000;
    const old: AuditCursorKeys = { activeKeyId: 'old', keys: { old: { secret: 'old-secret' } } };
    const rotated: AuditCursorKeys = { activeKeyId: 'new', keys: {
            new: { secret: 'new-secret' }, old: { secret: 'old-secret', verifyUntil: deadline },
            legacy: { secret: 'legacy-secret', verifyUntil: deadline },
        } };
    it('resolves old and legacy checkpoints through the verification window, rejects at its deadline without returning rows', async () => {
        const sqlite = new Sqlite();
        await appendTransitions(sqlite.db, [transition(entry('task.ready', 'one')), transition(entry('task.unready', 'two'))]);
        const first = await replayEvents(sqlite.db, scope, { limit: '1' }, old);
        const legacy = await replayEvents(sqlite.db, scope, { limit: '1' }, 'legacy-secret');
        const legacyPayload = JSON.parse(Buffer.from(legacy.nextCursor.split('.')[0]!, 'base64url').toString());
        expect(legacyPayload).toMatchObject({ v: 2, kid: 'legacy' });
        const oldBinding = JSON.stringify(['octocove', 'reader', 'p', null, null, null]);
        expect(legacyPayload.binding).toBe(oldBinding);
        const v1Body = Buffer.from(JSON.stringify({ v: 1, binding: oldBinding, after: legacyPayload.after })).toString('base64url');
        const v1Cursor = `${v1Body}.${createHmac('sha256', 'legacy-secret').update(v1Body).digest('base64')}`;
        expect((await replayEvents(sqlite.db, scope, { cursor: v1Cursor }, 'legacy-secret')).items.map(row => row.id)).toEqual(['evt_2']);
        const body = JSON.parse(Buffer.from(first.nextCursor.split('.')[0]!, 'base64url').toString());
        expect(body).toMatchObject({ v: 2, kid: 'old', after: '1' });
        const clock = vi.spyOn(Date, 'now');
        try {
            clock.mockReturnValue(deadline - 1);
            for (const cursor of [first.nextCursor, legacy.nextCursor, v1Cursor]) {
                const resumed = await replayEvents(sqlite.db, scope, { cursor }, rotated);
                expect(resumed.items.map(row => row.id)).toEqual(['evt_2']);
                expect(JSON.parse(Buffer.from(resumed.nextCursor.split('.')[0]!, 'base64url').toString()).kid).toBe('new');
            }
            clock.mockReturnValue(deadline);
            for (const cursor of [first.nextCursor, legacy.nextCursor, v1Cursor])
                await expect(replayEvents(sqlite.db, scope, { cursor }, rotated)).rejects.toThrow('invalid-cursor');
            expect((await replayEvents(sqlite.db, scope, {}, rotated)).items.map(row => row.id)).toEqual(['evt_1', 'evt_2']);
        }
        finally {
            clock.mockRestore();
        }
    });
    it('keeps IDs unique across projects and refuses foreign tenants, unknown keys and key-ID tampering', async () => {
        const sqlite = new Sqlite();
        await appendTransitions(sqlite.db, [transition(entry('task.ready', 'one'))]);
        sqlite.run({ script: "INSERT INTO projects(id,slug,name,created_by,created_at) VALUES ('q','q','Other project','human','2026-10-04T00:00:00Z');" });
        await appendTransitions(sqlite.db, [transition({ ...entry('task.ready', 'other-project'), projectId: 'q' })]);
        const page = await replayEvents(sqlite.db, scope, {}, old);
        const otherProject = await replayEvents(sqlite.db, { ...scope, projectId: 'q' }, {}, old);
        expect(page.items.map(row => row.id)).toEqual(['evt_1']);
        expect(otherProject.items.map(row => row.id)).toEqual(['evt_2']);
        await expect(replayEvents(sqlite.db, { ...scope, projectId: 'q' }, { cursor: page.nextCursor }, old))
            .rejects.toThrow('invalid-cursor');
        await expect(replayEvents(sqlite.db, scope, { cursor: page.nextCursor }, { activeKeyId: 'new', keys: { new: { secret: 'new-secret' } } }))
            .rejects.toThrow('invalid-cursor');
        const [body, mac] = page.nextCursor.split('.');
        const payload = JSON.parse(Buffer.from(body!, 'base64url').toString());
        payload.kid = 'new';
        await expect(replayEvents(sqlite.db, scope, { cursor: `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${mac}` }, rotated))
            .rejects.toThrow('invalid-cursor');
    });
    it('serves keyring-only HTTP configuration and fails closed on partial or invalid rings', async () => {
        const sqlite = new Sqlite(), app = createApp(async () => scope);
        const ring = { DB: sqlite.db, AUDIT_CURSOR_KEY_ID: old.activeKeyId, AUDIT_CURSOR_KEYRING: JSON.stringify(old.keys) };
        expect((await app.request('/events', {}, ring as any)).status).toBe(200);
        for (const config of [
            { AUDIT_CURSOR_KEY_ID: 'old' }, { AUDIT_CURSOR_KEYRING: '{}' },
            { AUDIT_CURSOR_KEY_ID: 'missing', AUDIT_CURSOR_KEYRING: JSON.stringify(old.keys) },
            { AUDIT_CURSOR_KEY_ID: 'new', AUDIT_CURSOR_KEYRING: JSON.stringify({ new: { secret: 's' }, old: { secret: 's' } }) },
            { AUDIT_CURSOR_KEY_ID: 'old', AUDIT_CURSOR_KEYRING: 'bad-json' },
        ])
            expect((await app.request('/events', {}, { DB: sqlite.db, AUDIT_CURSOR_SECRET: 'fallback', ...config } as any)).status).toBe(503);
        expect(() => auditCursorKeys({ AUDIT_CURSOR_KEY_ID: 'old', AUDIT_CURSOR_KEYRING: JSON.stringify({ old: { secret: 's', verifyUntil: deadline } }) }))
            .toThrow('audit-unavailable');
    });
    it('preserves exact IDs, old cursors and the allocator across a SQLite backup/restore fixture', async () => {
        const original = new Sqlite();
        original.run({ script: `UPDATE sqlite_sequence SET seq=9007199254740992 WHERE name='audit_log';` });
        await appendTransitions(original.db, [transition(entry('task.ready', 'one')), transition(entry('task.unready', 'two'))]);
        const before = await replayEvents(original.db, scope, {}, old);
        const checkpoint = await replayEvents(original.db, scope, { limit: '1' }, old);
        const restored = new Sqlite();
        execFileSync('python3', ['-c', 'import sqlite3,sys; source=sqlite3.connect(sys.argv[1]); dest=sqlite3.connect(sys.argv[2]); source.backup(dest); dest.close(); source.close()', original.path, restored.path]);
        const after = await replayEvents(restored.db, scope, {}, old);
        expect(after).toEqual(before);
        expect(after.items.map(row => row.id)).toEqual(['evt_9007199254740993', 'evt_9007199254740994']);
        expect((await replayEvents(restored.db, scope, { cursor: checkpoint.nextCursor }, old)).items).toEqual(before.items.slice(1));
        await appendTransitions(restored.db, [transition(entry('task.ready', 'three'))]);
        expect((await replayEvents(restored.db, scope, { cursor: before.nextCursor }, old)).items[0]!.id).toBe('evt_9007199254740995');
        await expect(replayEvents(restored.db, { ...scope, principalId: 'foreign' }, { cursor: checkpoint.nextCursor }, old)).rejects.toThrow('invalid-cursor');
    });
});
