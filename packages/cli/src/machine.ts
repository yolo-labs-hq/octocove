import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { Api, ApiError, type ApprovalGrant, type ApprovalGrantScope, type SubmitGrant, type SubmitGrantScope } from './http.js';
import { configDir, loadCredentials, storedOrigin, ConfigError } from './config.js';
import { resolveApiOrigin } from './origin.js';
import { atomicSecret, readSecret } from './store.js';
import type { Deps } from './cli.js';

const fail = (code: string, detail: string, status = 400): never => { throw new ApiError({ code, detail, status }); };
const pathFor = (d: Deps, id: string) => {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new ConfigError('invalid grant ID');
  return join(configDir(d.env), 'grants', id + '.json');
};
const flags = ['as','scope','grant','purpose','timeout','idempotency-key'];
/** Dedicated headless path: no session lookup for exchange or grant use. */
export async function machineCommand(d: Deps, command: string, args: string[]): Promise<boolean> {
  if (command !== 'auth exchange' && !(args.includes('--grant') && ['approve','auth approve','submit','auth revoke'].includes(command))) return false;
  let parsed;
  try { parsed = parseArgs({ args, allowPositionals:true, options:Object.fromEntries([
    ...flags.map(k => [k,{type:'string'}]), ['json',{type:'boolean'}], ['token-stdin',{type:'boolean'}],
  ]) as any }); } catch { return fail('usage','invalid machine command options'); }
  const v = parsed.values as Record<string, any>, pos = parsed.positionals;
  const seconds = v.timeout === undefined ? 30 : Number(v.timeout);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) fail('usage','--timeout must be 1–300 seconds');
  const deadline = Date.now() + seconds * 1000;
  const api = (apiUrl: string, credential?: { token: string; kind: 'human' }) => new Api({ apiUrl,credential,fetch:d.fetch,sleep:d.sleep,deadline,signal:d.signal });
  const secrets: string[] = [];
  const output = (value: unknown) => {
    const text = JSON.stringify(value);
    d.stdout(secrets.reduce((s,secret) => s.split(secret).join('[redacted]'),text) + '\n');
  };
  if (command === 'auth exchange') {
    if (pos.length) fail('usage','exchange takes no positional arguments');
    if (!v.as || !v.scope) fail('usage','--as and --scope JSON are required');
    let scope;
    try { scope = JSON.parse(v.scope); } catch { return fail('usage','--scope must be JSON'); }
    const purpose = v.purpose ?? 'approve';
    if (!['submit','approve'].includes(purpose)) fail('usage','--purpose must be submit or approve');
    // The workload proof is the only credential sent, so the origin resolves exactly as for login: the stored
    // origin is read, never the session token, and OCTOCOVE_API_URL still wins.
    const apiUrl = resolveApiOrigin(d.env, d.credentials ?? (d.env.OCTOCOVE_API_URL ? undefined : await storedOrigin(d.env)));
    const inputController = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let input: string;
    try {
      input = v['token-stdin'] ? await Promise.race([d.stdin(inputController.signal),new Promise<string>((_resolve,reject) => {
        timer = setTimeout(() => {
          const error = new ApiError({status:0,code:'deadline-exceeded',detail:'stdin deadline reached'});
          reject(error); inputController.abort(error);
        },Math.max(1,deadline-Date.now()));
      })]) : d.env.OCTOCOVE_WORKLOAD_TOKEN ?? '';
    } finally { clearTimeout(timer); }
    const proof = input.trim();
    if (proof.length > 65536) fail('usage','workload proof too large');
    secrets.push(proof);
    if (!proof) fail('usage','workload proof required via OCTOCOVE_WORKLOAD_TOKEN or --token-stdin');
    // Grant exchanges are never resent (autoRetry: never); the proof travels only as this call's credential.
    const exchange = api(apiUrl), options = { ...exchange.until(deadline),idempotencyKey:v['idempotency-key'] };
    const exchanged = purpose === 'submit' ? await exchange.j.grants.exchangeSubmit(proof,scope as SubmitGrantScope,options)
      : await exchange.j.grants.exchangeApproval(proof,scope as ApprovalGrantScope,options);
    // A recovered exchange carries metadata without a token and can never authorize a call.
    const g = exchanged.outcome === 'issued' ? exchanged.grant : undefined;
    if (g) secrets.push(g.token);
    if (!g || g.principalId !== v.as ||
        !g.token.startsWith(purpose === 'submit' ? 'ocsg_' : 'ocg_')) return fail('machine-authority-denied','exchange principal or grant kind does not match',403);
    await atomicSecret(pathFor(d,g.id),{id:g.id,principalId:g.principalId,token:g.token,scope:g.scope,expiresAt:g.expiresAt,policyVersion:g.policyVersion,apiUrl,purpose});
    output({id:g.id,expiresAt:g.expiresAt,scope:g.scope,policyVersion:g.policyVersion,principalId:g.principalId,purpose});
    return true;
  }
  const id = v.grant;
  pathFor(d,id); // Validate identifiers before URL or filesystem use.
  if (command === 'auth revoke') {
    if (pos.length) fail('usage','grant revoke takes no positional arguments');
    const creds = d.credentials ?? await loadCredentials(d.env);
    if (creds.kind !== 'human') fail('human-required','grant revocation requires a human administrator',403);
    let cached;
    try { cached = JSON.parse(await readSecret(pathFor(d,id))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ConfigError('grant file unreadable or unprotected'); }
    if (cached && cached.apiUrl !== creds.apiUrl) throw new ConfigError('administrator API does not match grant');
    const purpose = v.purpose ?? cached?.purpose ?? 'approve';
    if (!['submit','approve'].includes(purpose)) fail('usage','--purpose must be submit or approve');
    // An administrator write (`stored-result`): a lost answer is replayed under the same key, never revoked afresh.
    const admin = api(creds.apiUrl,{ token:creds.token,kind:'human' }), options = { ...admin.until(deadline),idempotencyKey:v['idempotency-key'] };
    await admin.j.command(purpose === 'submit' ? 'submitGrantRevoke' : 'approvalGrantRevoke',{ path:{ id } },options);
    output({id,revoked:true}); return true;
  }
  let g;
  try { g = JSON.parse(await readSecret(pathFor(d,id))); } catch { throw new ConfigError('grant file unreadable or unprotected'); }
  if (!g || typeof g.token !== 'string' || !g.token || typeof g.apiUrl !== 'string' || typeof g.principalId !== 'string' || !g.scope || !['submit','approve'].includes(g.purpose)) throw new ConfigError('invalid grant file');
  secrets.push(g.token);
  if (v.as && v.as !== g.principalId) fail('machine-authority-denied','grant principal does not match --as',403);
  const purpose = command === 'submit' ? 'submit' : 'approve';
  if (g.purpose !== purpose) fail('machine-authority-denied','submit and approval grants are independent',403);
  const target = purpose === 'submit' ? g.scope.taskId : g.scope.candidateId;
  if (pos.length > 1 || pos[0] && pos[0] !== target) fail('machine-authority-denied','grant target does not match command',403);
  // The server compares canonical immutable submitter/on-behalf-of provenance.
  // --as is an expectation, never an actor override. The grant routes to the target its scope names.
  const metadata = { token:g.token,id:g.id,principalId:g.principalId,expiresAt:g.expiresAt,scope:g.scope,policyVersion:g.policyVersion };
  const spend = api(g.apiUrl), options = { ...spend.until(deadline),idempotencyKey:v['idempotency-key'] };
  output(purpose === 'submit' ? await spend.j.submissions.createWithGrant({ kind:'submit-grant',...metadata } as SubmitGrant,options)
    : await spend.j.approvals.approveWithGrant({ kind:'approval-grant',...metadata } as ApprovalGrant,options));
  return true;
}
