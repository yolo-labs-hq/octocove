import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { dispatchIntegrator, verifyCompletion, RunnerBlocked } from '../src/integrator-runner';
import { runSecret, integratorRequest } from '../src/integrator-control';
import { BrokerSourceAccess } from '../src/external-source';
import { checksSatisfyPolicy } from '../src/check-policy';
async function completion(body: string, secret: string, timestamp = '1791115200') {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name:'HMAC',hash:'SHA-256' },false,['sign']);
  const signed = [...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${timestamp}.${body}`)))].map(b=>b.toString(16).padStart(2,'0')).join('');
  return new Request('https://api.example/internal/integrator/completion',{method:'POST',body,headers:{'X-Octocove-Timestamp':timestamp,'X-Octocove-Signature':signed}});
}
describe('single configured runner contract', () => {
  const job = { repoId: 'canonical', targetRef: 'refs/heads/main', runId:'run',candidateId:'candidate',step:'land' as const };
  it('blocks missing runner credentials without dispatch or fallback', async () => {
    const http = vi.fn();
    await expect(dispatchIntegrator({backend:'http'},job,http)).rejects.toBeInstanceOf(RunnerBlocked);
    await expect(dispatchIntegrator({backend:'cloudflare',dispatchUrl:'https://runner.example',dispatchToken:'token',completionSecret:'secret'},job,http)).rejects.toBeInstanceOf(RunnerBlocked);
    expect(http).not.toHaveBeenCalled();
    await expect(integratorRequest(new Request('https://api.example/internal/integrator/runs/run/load'),{} as any)).rejects.toMatchObject({code:'runner-blocked'});
  });
  it.each(['http', 'gke', 'local'])('dispatches an explicit repository/target binding with stable idempotency (%s)', async backend => {
    const http = vi.fn(async () => new Response(null,{status:202}));
    const config = {backend,dispatchUrl:'https://runner.example/dispatch',dispatchToken:'token',completionSecret:'secret'};
    await dispatchIntegrator(config,job,http); await dispatchIntegrator(config,job,http);
    expect(http.mock.calls[0]?.[1]).toMatchObject({redirect:'error',body:JSON.stringify(job),headers:{'Idempotency-Key':'run'}});
    expect(http.mock.calls[1]?.[1].body).toBe(JSON.stringify(job));
  });
  it('allows local loopback transport and rejects remote plaintext before HTTP', async () => {
    const http = vi.fn(async () => new Response(null, { status: 202 }));
    const config = { backend: 'local', dispatchUrl: 'http://127.0.0.1:8788/dispatch', dispatchToken: 'token', completionSecret: 'secret' };
    await dispatchIntegrator(config, job, http);
    expect(http).toHaveBeenCalledTimes(1);
    for (const patch of [{ backend: 'gke' }, { dispatchUrl: 'http://runner.example/dispatch' }])
      await expect(dispatchIntegrator({ ...config, ...patch }, job, http)).rejects.toThrow('invalid-runner-url');
    expect(http).toHaveBeenCalledTimes(1);
    await expect(integratorRequest(new Request('https://api.example/internal/integrator/runs/run/load'), {
      INTEGRATOR_BACKEND: 'local', INTEGRATOR_DISPATCH_URL: config.dispatchUrl,
      INTEGRATOR_DISPATCH_TOKEN: 'token', INTEGRATOR_RUN_SECRET: 'root',
    } as any)).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it('both source verification paths accept local configuration and block unsafe transport before SQL or credentials', async () => {
    const first = vi.fn(async () => null);
    const statement = { bind: () => statement, first };
    const prepare = vi.fn(() => statement);
    const http = vi.fn();
    const env = { DB: { prepare }, INTEGRATOR_BACKEND: 'local',
      INTEGRATOR_DISPATCH_URL: 'http://127.0.0.1:8788', INTEGRATOR_DISPATCH_TOKEN: 'token' } as any;
    const input = { taskId: 'task', claimId: 'claim', canonical: { id: 'canonical' } } as any;
    const access = new BrokerSourceAccess(env, undefined, http);
    await expect(access.ready(input)).rejects.toMatchObject({ code: 'source-registration-denied' });
    await expect(access.verify('task', 'source', 'refs/heads/lane', 'a'.repeat(40)))
      .rejects.toMatchObject({ code: 'source-registration-denied' });
    expect(prepare).toHaveBeenCalledTimes(3);
    prepare.mockClear();
    for (const patch of [{ INTEGRATOR_BACKEND: 'gke' }, { INTEGRATOR_DISPATCH_URL: 'http://remote.example' }]) {
      const blocked = new BrokerSourceAccess({ ...env, ...patch }, undefined, http);
      await expect(blocked.ready(input)).rejects.toMatchObject({ code: 'runner-blocked' });
      await expect(blocked.verify('task', 'source', 'refs/heads/lane', 'a'.repeat(40)))
        .rejects.toMatchObject({ code: 'runner-blocked' });
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
  });
  it('verifies exact signed webhook bytes and rejects tampering, expiry and run mismatch', async () => {
    const data = {...job,result:{runId:'run',candidateId:'candidate',outcome:'landed'}};
    const body = JSON.stringify(data), now = 1791115200000;
    expect(await verifyCompletion(await completion(body,'secret'),'secret',now)).toEqual(data);
    const original = await completion(body,'secret');
    await expect(verifyCompletion(new Request(original,{body:body+' '}),'secret',now)).rejects.toThrow('invalid-completion-signature');
    await expect(verifyCompletion(await completion(body,'secret'),'secret',now+301000)).rejects.toThrow('invalid-completion-signature');
    await expect(verifyCompletion(await completion(JSON.stringify({...data,result:{...data.result,runId:'other'}}),'secret'),'secret',now)).rejects.toThrow('invalid-completion');
    await expect(verifyCompletion(await completion(JSON.stringify({ ...data, targetRef: undefined }), 'secret'), 'secret', now)).rejects.toThrow('invalid-completion');
    await expect(verifyCompletion(await completion(body,'secret'),'wrong',now)).rejects.toThrow('invalid-completion-signature');
  });
  it('refuses missing or malformed dispatch targets before HTTP', async () => {
    const http = vi.fn();
    const config = { backend: 'http', dispatchUrl: 'https://runner.example', dispatchToken: 'token', completionSecret: 'secret' };
    for (const targetRef of [undefined, '', 'main', 'refs/heads/a..b'])
      await expect(dispatchIntegrator(config, { ...job, targetRef } as any, http)).rejects.toThrow('invalid-target');
    expect(http).not.toHaveBeenCalled();
  });
  it('derives different run access and completion keys', async () => {
    expect(await runSecret('root','one','access')).not.toBe(await runSecret('root','two','access'));
    expect(await runSecret('root','one','access')).not.toBe(await runSecret('root','one','completion'));
  });
});

it('dispatches in Workers and refuses redirects without forwarding runner credentials', async () => {
  const requests: { path: string; authorization?: string; idempotencyKey?: string; body: unknown }[] = [];
  let status = 202;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ path: request.url!, authorization: request.headers.authorization,
      idempotencyKey: request.headers['idempotency-key'] as string | undefined,
      body: body ? JSON.parse(body) : null });
    response.writeHead(status, { Location: '/redirect-target' });
    response.end();
  });
  let mf: Miniflare | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const bundle = await build({
      stdin: { contents: `
        import { dispatchIntegrator } from './integrator-runner';
        export default { async fetch(request, env) {
          try {
            await dispatchIntegrator({ backend: 'local', dispatchUrl: env.DISPATCH_URL,
              dispatchToken: 'runner-token', completionSecret: 'secret' }, await request.json());
            return Response.json({ accepted: true });
          } catch (error) {
            return Response.json({ error: error.message }, { status: 503 });
          }
        } };
      `, resolveDir: new URL('../src/', import.meta.url).pathname },
      bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022',
    });
    mf = new Miniflare({ modules: true, script: bundle.outputFiles![0]!.text,
      compatibilityDate: '2026-07-02', bindings: { DISPATCH_URL: `http://127.0.0.1:${address.port}/dispatch` } });
    for (const step of ['candidate', 'land', 'receipt-export']) {
      const job = { repoId: 'canonical', runId: `run-${step}`, step,
        ...(step === 'receipt-export' ? { receiptId: 'receipt', targetRef: 'refs/octocove/receipts/receipt' } :
          { candidateId: 'candidate', targetRef: 'refs/heads/main' }) };
      const dispatch = () => mf!.dispatchFetch('https://worker/dispatch', { method: 'POST', body: JSON.stringify(job) });
      status = 202;
      const accepted = await dispatch();
      expect(await accepted.json()).toEqual({ accepted: true });
      expect(accepted.status).toBe(200);
      expect(requests.at(-1)).toEqual({ path: '/dispatch', authorization: 'Bearer runner-token',
        idempotencyKey: job.runId, body: job });
      for (const unavailable of [301, 302, 303, 307, 308, 503]) {
        status = unavailable;
        const count = requests.length;
        const refused = await dispatch();
        expect(await refused.json()).toEqual({ error: 'runner-dispatch-unavailable' });
        expect(refused.status).toBe(503);
        expect(requests.length).toBe(count + 1);
        expect(requests.at(-1)?.path).toBe('/dispatch');
      }
    }
  } finally {
    await mf?.dispose();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

describe("shared check-policy authorization", () => {
  it("permits explicit no-check policies without a recorded run", () => {
    expect(checksSatisfyPolicy({ kind: "none" }, "identity", null)).toBe(true);
    expect(checksSatisfyPolicy({ mode: "none" }, "identity", null)).toBe(true);
  });
  it("fails closed for missing, failed, skipped or mismatched configured checks", () => {
    const policy = { kind: "commands" };
    expect(checksSatisfyPolicy(policy, "identity", null)).toBe(false);
    for (const result of ["failed", "error", "skipped"])
      expect(
        checksSatisfyPolicy(policy, "identity", {
          result,
          check_identity: "identity",
        }),
      ).toBe(false);
    expect(
      checksSatisfyPolicy(policy, "identity", {
        result: "passed",
        check_identity: "other",
      }),
    ).toBe(false);
    expect(
      checksSatisfyPolicy(policy, "identity", {
        result: "passed",
        check_identity: "identity",
      }),
    ).toBe(true);
    expect(checksSatisfyPolicy(null, "identity", null)).toBe(false);
    expect(checksSatisfyPolicy({}, "identity", null)).toBe(false);
  });
});
