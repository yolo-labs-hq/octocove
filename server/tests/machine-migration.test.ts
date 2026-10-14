import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { db, upgradeDb, life, fenced, human, base, key, useWorkerLifecycle } from './lifecycle-fixture';
useWorkerLifecycle();
function statements(sql: string) {
    const result: string[] = [];
    let rest = sql.replace(/--[^\n]*/g, '').trim();
    while (rest) {
        const next = rest.match(rest.startsWith('CREATE TRIGGER') ? /^CREATE TRIGGER[\s\S]*?END;/ : /^(?:'[^']*'|[^;])+;/)![0];
        result.push(next);
        rest = rest.slice(next.length).trim();
    }
    return result;
}
it('forward authority migration preserves populated human history foreign keys and append-only guards', async () => {
    await upgradeDb.batch(statements(readFileSync(new URL('../migrations/0009_record_integrity.sql', import.meta.url), 'utf8')).map(sql => upgradeDb.prepare(sql)));
    const records = await fenced('machine-migration-history');
    await life.reconcile('machine-migration-history', key('migration-history-release'), {
        fenceId: records.landing.body.fenceId, runId: records.landing.body.runId, outcome: 'error', canonicalSha: base,
        ancestryVerified: false, writerTerminated: true, eventIds: [], errorDetail: 'historical error',
    });
    const tables = ['projects', 'repositories', 'target_refs', 'tasks', 'intents', 'claims', 'task_repo_mappings',
        'submissions', 'submission_contexts', 'candidates', 'approvals', 'landing_fences', 'landing_receipts', 'audit_log'];
    const before: Record<string, any[]> = {};
    for (const table of tables) {
        const oldFields = ((await upgradeDb.prepare(`PRAGMA table_info(${table})`).all()).results as any[]).map(row => row.name);
        before[table] = await life.rows(`SELECT ${oldFields.join(',')} FROM ${table}`);
        for (const row of before[table]!) {
            const fields = Object.keys(row);
            await upgradeDb.prepare(`INSERT INTO ${table}(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`).bind(...Object.values(row)).run();
        }
    }
    const next = readFileSync(new URL('../migrations/0019_machine_approval_authority.sql', import.meta.url), 'utf8');
    await upgradeDb.batch(statements(next).map(sql => upgradeDb.prepare(sql)));
    const trust = readFileSync(new URL('../migrations/0020_machine_trust.sql', import.meta.url), 'utf8');
    await upgradeDb.batch(statements(trust).map(sql => upgradeDb.prepare(sql)));
    expect(await upgradeDb.prepare('SELECT submission_grant_id FROM submissions').first()).toEqual({ submission_grant_id: null });
    expect((await upgradeDb.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    for (const table of tables) {
        const rows = (await upgradeDb.prepare(`SELECT ${Object.keys(before[table]![0]!).join(',')} FROM ${table}`).all()).results;
        expect(rows).toEqual(before[table]);
    }
    expect(await upgradeDb.prepare('SELECT approver_kind,policy_version,evidence_refs,check_run_ids FROM approvals').first())
        .toEqual({ approver_kind: 'human', policy_version: null, evidence_refs: null, check_run_ids: null });
    expect(await upgradeDb.prepare('SELECT approver_kind FROM landing_receipts').first()).toEqual({ approver_kind: 'human' });
    expect(await upgradeDb.prepare('SELECT submitting_principal_id,on_behalf_of_principal_id FROM submissions').first())
        .toEqual({ submitting_principal_id: null, on_behalf_of_principal_id: null });
    await expect(upgradeDb.prepare('DELETE FROM audit_log').run()).rejects.toThrow();
    await expect(upgradeDb.prepare('UPDATE approvals SET approved_by=?').bind('machine').run()).rejects.toThrow();
    await expect(upgradeDb.prepare('UPDATE landing_receipts SET approver_kind=?').bind('policy_bot').run()).rejects.toThrow();
    expect((await upgradeDb.prepare("SELECT MAX(id) AS id FROM audit_log").first<any>())!.id).toBe(before.audit_log!.at(-1)!.id);
    expect((await db.prepare('SELECT approver_kind FROM approvals WHERE id=?').bind(records.approval.body.id).first<any>())!.approver_kind).toBe(human.type);
}, 30000);
