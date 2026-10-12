import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json',import.meta.url));
const { generateKeyPair, exportJWK, SignJWT } = await import(require.resolve('jose'));
import { cliDriver } from './cli.mjs';
import { manifest } from '../protocol.mjs';
const origin = 'https://machine.conformance.invalid', issuer = 'https://fake-issuer.conformance.invalid';
export const machineVariants = manifest.machineVariants;
const must = r => { if (![200,201,204].includes(r.status)) throw new Error('machine-setup-' + r.body?.code); return r.body; };
/** Local signed fake issuers; production verification and actual CLI, never live qualification. */
export async function machineDriver({ env, repository, operator, claim, task, sourceRepositoryId, target, identity, tag, signal }) {
  const secrets = [];
  const cli = await cliDriver({ binary:env.binary, work:repository.work, apiUrl:env.apiUrl,
    root:repository.dir, identity, gitTransport:env.cliGit, signal,
    onOutput:({stdout,stderr}) => {
      const text = stdout + stderr;
      if (secrets.some(secret => text.includes(secret)) || /oc(?:sg|g)_[a-zA-Z0-9_-]+/.test(text))
        throw new Error('machine-credential-leaked');
    } });
  const expiresAt = new Date(Date.now()+3600000).toISOString();
  // The check identity is supplied by the real candidate before approval registration.
  async function register(variant, identityId, suffix, checkIdentity, operations) {
    const algorithm = variant === 'signed_cli' ? 'EdDSA' : variant === 'workers_cron' ? 'ES256' : 'RS256';
    const pair = await generateKeyPair(algorithm,{extractable:true}), keyId = 'key-' + suffix + '-' + tag;
    const claims = variant === 'github_actions' ? { repository_id:repository.repoId,repository:'local/repo',
      workflow_ref:'local/repo/.github/workflows/approve.yml@refs/heads/main',ref:target,environment:'integration' }
      : variant === 'workers_cron' ? {worker_id:'local-worker',schedule:'*/5 * * * *'} : {};
    const subject = suffix + '-' + tag;
    const humanIdentity = {issuer:'https://identity.invalid',subject:'signed-' + tag};
    if (variant === 'signed_cli') {
      // Trusted local membership bootstrap, distinct from the submission authorizer.
      // No approval/check/custody evidence is inserted here.
      await env.db.batch([
        env.db.prepare('INSERT INTO auth_users VALUES(?,?,NULL,NULL)').bind(humanIdentity.issuer,humanIdentity.subject),
        env.db.prepare('INSERT INTO auth_memberships VALUES(?,?,?,?,1)').bind('p',humanIdentity.issuer,humanIdentity.subject,'["candidates:approve"]')
      ]);
    }
    const principal = must(await operator.call('/v1/projects/p/approval-principals','POST',{
      kind:variant === 'signed_cli' ? 'human' : variant === 'policy_bot' ? 'policy_bot' : 'workload',
      identityId:variant === 'signed_cli' ? humanIdentity.issuer + '|' + humanIdentity.subject : identityId,expiresAt,
      ...(variant === 'signed_cli' ? {humanIdentity} : {}),
      trustBindings:[{issuer,subject,algorithm,keyId,publicJwk:await exportJWK(pair.publicKey),claims,variant,expiresAt}]
    },'machine-principal-' + subject));
    const p = must(await operator.call('/v1/projects/p/approval-policies','POST',{
      principalId:principal.id,repositoryId:repository.repoId,sourceRepositoryId,targetRef:target,checkIdentity,
      acceptableEvidence:{version:1,requireSuccessfulCommands:true},operations,allowMachine:true,version:1,expiresAt
    },'machine-policy-' + subject));
    return {principal,policy:p, async proof(patch = {}) {
      const now = Math.floor(Date.now()/1000);
      return new SignJWT({iss:issuer,sub:subject,aud:origin+'/auth/approval-grants',iat:now,nbf:now,exp:now+240,
        jti:crypto.randomUUID(),...claims,...(variant === 'github_actions' ? {run_id:'123'} : {}),...patch})
        .setProtectedHeader({alg:algorithm,kid:keyId}).sign(pair.privateKey);
    }};
  }
  const outputs = [];
  const command = async (argv, proof) => {
    if (proof) secrets.push(proof);
    const result = await cli.command(argv,{stdin:proof});
    const text = JSON.stringify(result);
    if (secrets.some(secret => text.includes(secret)) || /oc(?:sg|g)_[a-zA-Z0-9_-]+/.test(text))
      throw new Error('machine-credential-leaked');
    outputs.push(text);
    return result;
  };
  const exchange = (r, scope, proof, purpose = 'approve') => command(['auth','exchange','--as',r.principal.id,
    '--purpose',purpose,'--scope',JSON.stringify(scope),'--token-stdin'],proof);
  let submitter;
  return {
    info:{archetype:'c',version:'1.0.0',kind:'actual-headless-octocove-bin',developmentDouble:false,issuer:'local-signed-fake'},
    cli, register, exchange, command,
    async scan() {
      const audits = await env.db.prepare('SELECT refs FROM audit_log WHERE task_id=?').bind(task).all();
      const text = JSON.stringify(audits);
      if (secrets.some(secret => text.includes(secret)) || /oc(?:sg|g)_[a-zA-Z0-9_-]+/.test(text)) throw new Error('machine-audit-credential-leaked');
      return {outputsScanned:outputs.length,auditRowsScanned:audits.results.length,matchesFound:0};
    },
    async submit(sourceSha,baseSha) {
      submitter = await register('policy_bot',tag,'submitter','submit-source',['submit','approve']);
      must(await operator.call('/v1/projects/p/approval-policies','POST',{
        principalId:null,repositoryId:repository.repoId,sourceRepositoryId,targetRef:target,checkIdentity:'submit-source',
        acceptableEvidence:{version:1,requireSuccessfulCommands:true},operations:['submit'],allowMachine:true,version:1,expiresAt
      },'machine-submit-target-' + tag));
      const scope = {projectId:'p',taskId:task,claimAttemptId:claim.id,sourceSha,baseSha,intentVersion:1};
      const g = await exchange(submitter,scope,await submitter.proof(),'submit');
      if (g.exit !== 0) throw new Error('machine-submit-exchange-' + g.body?.error?.code);
      const result = await command(['submit','--grant',g.body.id]);
      if (result.exit !== 0) throw new Error('machine-submit-' + result.body?.error?.code);
      return result.body;
    },
    async approve(candidate, add) {
      const scope = {projectId:'p',claimAttemptId:claim.id,candidateId:candidate.id,boundTo:candidate.reviewBoundTo,
        checkRunIds:(await env.db.prepare('SELECT id FROM candidate_checks WHERE candidate_id=? ORDER BY recorded_at DESC,id DESC LIMIT 1').bind(candidate.id).all()).results.map(r => r.id)};
      const targetPolicy = must(await operator.call('/v1/projects/p/approval-policies','POST',{
        principalId:null,repositoryId:repository.repoId,sourceRepositoryId,targetRef:target,checkIdentity:candidate.checkIdentity,
        acceptableEvidence:{version:1,requireSuccessfulCommands:true},operations:['approve'],allowMachine:true,version:submitter ? 2 : 1,expiresAt
      },'machine-target-' + tag));
      // Revocation is a real CLI action by the trusted local administrator.
      // It does not supply any approval authority to the machine client.
      await cliDriver({binary:env.binary,work:repository.work,apiUrl:env.apiUrl,root:repository.dir,
        identity:{kind:'human',token:env.session},configName:identity.kind,signal});
      let chosen;
      for (const variant of machineVariants) {
        const r = await register(variant,'approver-' + variant + '-' + tag,variant,candidate.checkIdentity,['approve']);
        for (const [name,patch] of [['expired',{exp:Math.floor(Date.now()/1000)-1}],['wrong-audience',{aud:'wrong'}]]) {
          const denied = await exchange(r,scope,await r.proof(patch));
          add('approval-denials','machine-' + variant + '-' + name,denied.exit !== 0 && denied.body?.error?.code === 'machine-authority-denied');
        }
        const proof = await r.proof(), g = await exchange(r,scope,proof);
        if (g.exit !== 0) throw new Error('machine-exchange-' + variant + '-' + g.body?.error?.code);
        const replay = await exchange(r,scope,proof);
        add('approval-denials','machine-' + variant + '-replayed',replay.exit !== 0 && replay.body?.error?.code === 'machine-authority-denied');
        const approved = await command(['approve','--as',r.principal.id,'--grant',g.body.id]);
        add('approval-denials','machine-' + variant + '-positive',approved.exit === 0 && approved.body?.approvedBy === r.principal.id &&
          approved.body?.approverKind === r.principal.kind);
        const revoke = await command(['auth','revoke','--grant',g.body.id]);
        if (revoke.exit !== 0) throw new Error('machine-revoke-' + revoke.body?.error?.code);
        const again = await command(['auth','revoke','--grant',g.body.id]);
        if (again.exit !== 0) throw new Error('machine-revoke-retry-' + again.body?.error?.code);
        const revoked = await command(['approve','--grant',g.body.id]);
        add('approval-denials','machine-' + variant + '-revoked',revoked.exit !== 0 && ['machine-authority-denied','authority-revoked'].includes(revoked.body?.error?.code));
        chosen = r;
      }
      let self = submitter;
      if (self) must(await operator.call('/v1/projects/p/approval-policies','POST',{
        principalId:self.principal.id,repositoryId:repository.repoId,sourceRepositoryId,targetRef:target,checkIdentity:candidate.checkIdentity,
        acceptableEvidence:{version:1,requireSuccessfulCommands:true},operations:['approve'],allowMachine:true,version:2,expiresAt
      },'machine-self-policy-' + tag));
      else self = await register('policy_bot',tag,'self',candidate.checkIdentity,['approve']);
      const deniedSelf = await exchange(self,scope,await self.proof());
      add('approval-denials','machine-self-approval',deniedSelf.exit !== 0 && deniedSelf.body?.error?.code === 'machine-authority-denied');
      const ordinary = await exchange(chosen,scope,identity.token);
      add('approval-denials','machine-ordinary-agent',ordinary.exit !== 0 && ordinary.body?.error?.code === 'machine-authority-denied');
      // Exercise a policy bot for the complete landing journey.
      chosen = await register('policy_bot','final-approver-' + tag,'final',candidate.checkIdentity,['approve']);
      const g = await exchange(chosen,scope,await chosen.proof());
      if (g.exit !== 0) throw new Error('machine-final-exchange-' + g.body?.error?.code);
      const approval = await command(['auth','approve','--as',chosen.principal.id,'--grant',g.body.id]);
      if (approval.exit !== 0) throw new Error('machine-approve-' + approval.body?.error?.code);
      return {approval:approval.body,principalId:chosen.principal.id,policyId:chosen.policy.id,targetPolicy:targetPolicy.id};
    },
    timings:cli.timings
  };
}
