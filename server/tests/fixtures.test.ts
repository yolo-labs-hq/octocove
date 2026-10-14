import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authHeaders, bearer, membershipRow, seedMembership, syntheticToken } from './helpers/fixtures';
const directories: string[] = [];
afterEach(() => { directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
function sqlite() {
    const dir = mkdtempSync(join(tmpdir(), 'oc-fixtures-'));
    directories.push(dir);
    const run = (request: object): any => {
        const result = JSON.parse(execFileSync('python3', [new URL('./sqlite.py', import.meta.url).pathname], { input: JSON.stringify({ path: join(dir, 'db'), ...request }), encoding: 'utf8' }));
        if (result.error)
            throw new Error(result.error);
        return result;
    };
    run({ script: ['0001_record.sql', '0003_auth.sql'].map(name => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8')).join('\n') });
    return run;
}
it('seeds a membership idempotently, the last seed deciding verbs and delegated land', () => {
    const run = sqlite();
    const alice = { project: 'p', issuer: 'https://idp.example', sub: 'alice' };
    const statements = [
        { sql: "INSERT INTO projects(id,slug,name,created_by,created_at) VALUES('p','p','Project','human','2026-10-08T00:00:00Z')", params: [] },
        { sql: 'INSERT INTO auth_users(issuer,sub) VALUES(?,?)', params: [alice.issuer, alice.sub] },
        membershipRow({ ...alice, verbs: ['tasks:read'] }),
        seedMembership({ prepare: sql => ({ bind: (...params: unknown[]) => ({ sql, params }) }) }, { ...alice, verbs: ['tasks:read'] }),
        membershipRow({ ...alice, verbs: ['tasks:claim', 'submissions:create'], delegatedLand: true }),
        { sql: 'SELECT * FROM auth_memberships', params: [] },
    ];
    expect(run({ statements }).at(-1).results).toEqual([
        { project_id: 'p', issuer: alice.issuer, sub: 'alice', verbs: '["tasks:claim","submissions:create"]', allow_delegated_land: 1 },
    ]);
    expect(membershipRow({ ...alice, verbs: [] }).params).toEqual(['p', alice.issuer, 'alice', '[]', 0]);
});
it('builds plain bearer and idempotency headers', () => {
    const plain = (headers: Record<string, string>) => Object.entries(headers);
    const alice = syntheticToken('ocs', 'alice');
    expect(alice.split('_')).toEqual(['ocs', 'alice']);
    expect(plain(bearer(alice))).toEqual([['Authorization', 'Bearer ' + alice]]);
    expect(plain(authHeaders(alice))).toEqual([['Authorization', 'Bearer ' + alice]]);
    expect(plain(authHeaders(alice, { idempotencyKey: 'key-0123456789abcdef' })))
        .toEqual([['Authorization', 'Bearer ' + alice], ['Idempotency-Key', 'key-0123456789abcdef']]);
});
