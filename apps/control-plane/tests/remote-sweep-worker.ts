// Local-only harness: real D1, real task DOs, production advertisement reader;
// token service is synthetic and every Git advertisement comes from a bare repo.
import { bindHintFromSource } from '../src/event-binding';
import { TokenBroker } from '../src/broker';
import { BrokerRemoteReader, EventsConsumer, type EventsDeps } from '../src/events';
import { RemoteSweep, RemoteSweeper } from '../src/remote-sweep';
import { TaskLifecycle } from '../src/lifecycle';
import { syntheticSourceAccess } from './lifecycle-adapter';
import { seedMembership } from './helpers/fixtures';
import { TaskCoordinator, invokeTaskCommand } from '../src/task-coordinator';
export { TaskCoordinator };
export class ArmOnlyRemoteSweeper extends RemoteSweeper { async alarm() {} }
function broker(env: any) {
  return new TokenBroker(env, {
    async createToken(_repo, scope, ttl) { return { id: crypto.randomUUID(), plaintext: 'local-read', scope, expires_at: new Date(Date.now()+ttl*1000).toISOString(), username: 'x' }; },
    async revokeToken() {},
  });
}
function deps(env: any, fail = false): EventsDeps {
  return {
    remote: new BrokerRemoteReader({ ...env, ARTIFACTS_GIT_REMOTE_TEMPLATE: `${env.REMOTE_URL}/{name}.git` }, broker(env),
      (input, init) => {
        const url = new URL(String(input));
        const name = url.pathname.split('/').at(-3)!.replace(/\.git$/, '');
        return fetch(`${env.REMOTE_URL}/${name}/info/refs?service=git-upload-pack`, init);
      }),
    async baseMoved(id, key, head) {
      const result = await invokeTaskCommand(env, id, 'baseMoved', key, { headSha: head });
      if (fail) throw new Error('crash-after-recipient-commit');
      return result;
    },
  };
}
export class LocalRemoteSweeper extends RemoteSweeper {
  constructor(private localState: DurableObjectState, private localEnv: any) { super(localState, localEnv); }
  protected sweep() { return new RemoteSweep(this.localEnv.DB, deps(this.localEnv)); }
  protected cleanup() { return broker(this.localEnv).drainObservationReads(); }
  async fetch(request?: Request) {
    if (request && new URL(request.url).pathname === '/stop') {
      await this.localState.storage.deleteAlarm(); return new Response('stopped');
    }
    return super.fetch();
  }
}
export default {
  async fetch(request: Request, env: any) {
    const url = new URL(request.url), db = env.DB as D1Database;
    if (url.pathname === '/setup') {
      const now = new Date().toISOString(), base = env.SEED_SHA;
      await db.batch([
        db.prepare('INSERT INTO projects(id,slug,name,created_by,created_at) VALUES(?,?,?,?,?)').bind('load', 'load', 'Load', 'test', now),
        // Submission admission reads the claimant's live project membership.
        db.prepare('INSERT INTO auth_users(issuer,sub) VALUES(?,?)').bind('https://idp.example', 'test'),
        seedMembership(db, { project: 'load', issuer: 'https://idp.example', sub: 'test', verbs: ['submissions:create'] }),
        ...['canonical', 'orphan', 'byo', 'chain'].map(id => db.prepare('INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,NULL)')
          .bind(id, 'load', id==='byo' ? 'github' : 'artifacts', id==='byo' ? 'local' : 'oc-load', id, id, id==='chain' ? 'task' : 'canonical', now)),
        ...['canonical', 'orphan', 'byo'].map(id => db.prepare('INSERT INTO target_refs VALUES(?,?,?,?,?)').bind(id, 'refs/heads/main', base, now, 'seed')),
        db.prepare(`INSERT INTO repository_provider_bindings VALUES('byo','github','https://byo.invalid','https://byo.invalid','owner','byo','local-credential')`),
        db.prepare(`INSERT INTO chain_lanes(id,canonical_id,target_ref,repository_id,phase) VALUES('chain-binding','canonical','refs/heads/main','chain','attached')`),
      ]);
      const life = new TaskLifecycle(db, {
        async provision(c) { return { taskRepo: { id: c.id, name: c.id, namespace: c.namespace }, remote: `${env.REMOTE_URL}/${c.id}.git`, targetRef: c.targetRef }; },
        async subscribe() { throw new Error('all-hints-disabled'); }, async release() {},
      }, syntheticSourceAccess);
      const actor = { type: 'human' as const, id: 'https://idp.example|test' };
      for (let i=0; i<10; i++) {
        const id = `load-${i}`, claim = `lane-${i}`;
        await life.create(id, actor, `create-${id}`.padEnd(20,'-'), { projectId: 'load', repositoryId: 'canonical', targetRef: 'refs/heads/main', key: id, title: id, description: 'local', acceptanceCriteria: ['verified'] });
        await life.publish(id, actor, `publish-${id}`.padEnd(20,'-'));
        await life.claim(id, `claim-${id}`.padEnd(20,'-'), { id: claim, actor, authorizedBy: actor.id, intentVersion: 1, expiresAt: new Date(Date.now()+3600_000).toISOString() });
        await life.provision(claim);
      }
      await db.prepare(`INSERT INTO inbound_hint_bindings SELECT 'source-'||provider_repo_id,'load',provider,'local-account',provider_namespace,
        provider_repo_id,0,id,?,NULL FROM repositories`).bind(now).run();
      return Response.json({ ready: true });
    }
    if (url.pathname === '/approval') {
      const life = new TaskLifecycle(db, undefined, syntheticSourceAccess), id='load-2', actor={type:'human' as const,id:'https://idp.example|test'};
      const head = await db.prepare("SELECT known_head_sha FROM target_refs WHERE repository_id='canonical'").first<any>();
      const submission = await life.submit(id,actor,'lane-2','deletion-submission--',{sourceSha:head.known_head_sha,baseSha:head.known_head_sha,intentVersion:1});
      const job = await db.prepare("SELECT run_id FROM lifecycle_outbox WHERE task_id=? AND kind='compute' ORDER BY rowid DESC").bind(id).first<any>();
      await life.candidate(id,'deletion-candidate---',{runId:job.run_id,submissionId:submission.body.id,candidateSha:head.known_head_sha,baseSha:head.known_head_sha,
        candidateRef:'refs/candidates/deletion',checkIdentity:'none',checkPolicy:{mode:'none'}});
      return Response.json((await life.approve(id,actor,'deletion-approval----',{boundTo:{candidateSha:head.known_head_sha,baseSha:head.known_head_sha,intentVersion:1}})).body);
    }
    if (url.pathname === '/run') {
      const sweep = new RemoteSweep(db, deps(env, url.searchParams.has('fail')));
      await sweep.run();
      return Response.json(await sweep.metrics());
    }
    if (url.pathname === '/verify') {
      const { repositoryId, ref, eventId } = await request.json() as any;
      await new EventsConsumer(db, deps(env)).verifyBinding(repositoryId, ref, eventId);
      return Response.json({ verified: true });
    }
    if (url.pathname === '/hint') {
      const raw = await request.json() as any;
      const body = await bindHintFromSource(db,'source-'+raw.repo,raw);
      await new EventsConsumer(db, deps(env)).process({ id: crypto.randomUUID(), body, attempts: 1, ack() {}, retry() {} });
      return Response.json({ verified: true });
    }
    return new Response('local fixture');
  },
};
