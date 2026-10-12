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
it('forward migration preserves populated Artifacts foreign keys, triggers and provider enum on local D1', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'], compatibilityDate: '2026-07-02' });
  try {
    const db = await mf.getD1Database('DB');
    const dir = new URL('../migrations/', import.meta.url);
    const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    const next = files.find(f => f.endsWith('_byo_canonical.sql'))!;
    for (const file of files.filter(f => f < next)) await db.batch(statements(readFileSync(new URL(file, dir), 'utf8')).map(sql => db.prepare(sql)));
    await db.batch([
      db.prepare("INSERT INTO projects(id,slug,name,created_by,created_at) VALUES('p','p','Project','human','now')"),
      db.prepare("INSERT INTO repositories VALUES('canonical','p','artifacts','ns','id','repo','canonical','now',NULL)"),
      db.prepare("INSERT INTO target_refs VALUES('canonical','refs/heads/main',NULL,NULL,NULL)"),
    ]);
    await db.batch(statements(readFileSync(new URL(next, dir), 'utf8')).map(sql => db.prepare(sql)));
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect(await db.prepare("SELECT repository_id FROM target_refs WHERE repository_id='canonical'").first()).toEqual({ repository_id: 'canonical' });
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='broker_job_grants'").first()).toBeTruthy();
    for (const provider of ['artifacts', 'github', 'forgejo']) for (let i = 0; i < 20; i++)
      await db.prepare('INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,NULL)').bind(`${provider}-${i}`, 'p', provider, 'ns', `id-${i}`, 'repo', 'canonical', 'now').run();
    await expect(db.prepare("INSERT INTO repositories VALUES('bad','p','arbitrary','ns','bad','repo','canonical','now',NULL)").run()).rejects.toThrow(/CHECK constraint failed/);
    await expect(db.prepare("INSERT INTO repositories VALUES('task','p','github','ns','task','repo','task','now',NULL)").run()).rejects.toThrow(/CHECK constraint failed/);
    await expect(db.prepare("INSERT INTO repository_provider_bindings VALUES('github-0','forgejo','https://api.invalid','https://git.invalid','owner','repo','ref')").run()).rejects.toThrow(/wrong provider/);
    await expect(db.prepare("INSERT INTO repository_provider_bindings VALUES('github-0','github','http://api.invalid','https://git.invalid','owner','repo','ref')").run()).rejects.toThrow(/CHECK constraint failed/);
    await db.prepare("INSERT INTO repository_provider_bindings VALUES('github-0','github','https://api.invalid','https://git.invalid','owner','repo','ref')").run();
    await expect(db.prepare("INSERT OR REPLACE INTO repository_provider_bindings VALUES('github-0','github','https://api.invalid','https://other.invalid','owner','repo','other-ref')").run()).rejects.toThrow(/immutable identity/);
    await expect(db.prepare("DELETE FROM repository_provider_bindings WHERE repository_id='github-0'").run()).rejects.toThrow(/immutable/);
  } finally { await mf.dispose(); }
}, 30000);
