import { it, expect } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync, readdirSync } from 'node:fs';

function statements(sql: string) {
  const result: string[] = [];
  let rest = sql.replace(/--[^\n]*/g, '').trim();
  while (rest) {
    const next = rest.match(rest.startsWith('CREATE TRIGGER') ? /^CREATE TRIGGER[\s\S]*?END;/ : /^(?:'[^']*'|[^;])+;/)![0];
    result.push(next); rest = rest.slice(next.length).trim();
  }
  return result;
}
const now = '2026-10-10T00:00:00.000Z';
async function chain(apply: (db: D1Database, files: string[], dir: URL) => Promise<void>) {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'], compatibilityDate: '2026-07-02' });
  try {
    const dir = new URL('../migrations/', import.meta.url);
    await apply(await mf.getD1Database('DB'), readdirSync(dir).filter(f => f.endsWith('.sql')).sort(), dir);
  } finally { await mf.dispose(); }
}
const run = (db: D1Database, file: string, dir: URL) => db.batch(statements(readFileSync(new URL(file, dir), 'utf8')).map(sql => db.prepare(sql)));

// 0041 adds the Artifacts address UNIQUE (namespace + name) and repository_verifications.
it('0041 applies to an empty repositories table and to distinct rows, backfilling only API-registered rows as unverified', async () => {
  await chain(async (db, files, dir) => {
    const next = files.find(f => f.endsWith('_repository_identity.sql'))!;
    expect(next).toBe('0041_repository_identity.sql');
    for (const file of files.filter(f => f < next)) await run(db, file, dir);
    await db.batch([
      db.prepare("INSERT INTO projects(id,slug,name,created_by,created_at) VALUES('p','p','Project','human',?)").bind(now),
      // A trusted-path canonical (seed/migration), an API-registered canonical, a task repository and a BYO row named alike.
      db.prepare("INSERT INTO repositories VALUES('seeded','p','artifacts','ns','id-seeded','seeded','canonical',?,NULL)").bind(now),
      db.prepare("INSERT INTO repositories VALUES('registered','p','artifacts','ns','id-registered','registered','canonical',?,NULL)").bind(now),
      db.prepare("INSERT INTO repositories VALUES('task','p','artifacts','ns','id-task','oc-task','task',?,NULL)").bind(now),
      db.prepare("INSERT INTO repositories VALUES('byo','p','github','ns','id-byo','registered','canonical',?,NULL)").bind(now),
      db.prepare(`INSERT INTO audit_log(at,actor_type,actor_id,project_id,type,refs) VALUES(?,'human','alice','p','repository.registered',json_object('repositoryId','registered'))`).bind(now),
      db.prepare(`INSERT INTO audit_log(at,actor_type,actor_id,project_id,type,refs) VALUES(?,'system','seed','p','repository.registered',json_object('repositoryId','seeded'))`).bind(now),
    ]);
    await run(db, next, dir);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect((await db.prepare('SELECT repository_id,registered_at,verified_at,verified_by FROM repository_verifications').all()).results)
      .toEqual([{ repository_id: 'registered', registered_at: now, verified_at: null, verified_by: null }]);
    // The address is unique for Artifacts rows only; the repo-id identity still holds for every provider.
    await expect(db.prepare("INSERT INTO repositories VALUES('alias','p','artifacts','ns','invented','registered','canonical',?,NULL)").bind(now).run())
      .rejects.toThrow(/duplicate immutable identity|UNIQUE/);
    await expect(db.prepare("INSERT INTO repositories VALUES('twin','p','github','ns','id-byo','other','canonical',?,NULL)").bind(now).run())
      .rejects.toThrow(/duplicate immutable identity|UNIQUE/);
    await db.prepare("INSERT INTO repositories VALUES('byo-2','p','github','ns','id-byo-2','registered','canonical',?,NULL)").bind(now).run();
    await db.prepare("INSERT INTO repositories VALUES('other-ns','p','artifacts','ns-2','id-other','registered','canonical',?,NULL)").bind(now).run();
    // Every later migration still applies on top.
    for (const file of files.filter(f => f > next)) await run(db, file, dir);
  });
}, 30000);

it('0041 on a fresh, empty production table: the index, trigger and table exist and nothing is backfilled', async () => {
  await chain(async (db, files, dir) => {
    for (const file of files) await run(db, file, dir);
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='repositories_artifacts_address'").first()).toBeTruthy();
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='repositories_no_replace'").first()).toBeTruthy();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM repository_verifications').first()).toEqual({ n: 0 });
  });
}, 30000);
