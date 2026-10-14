import type { MiddlewareHandler } from 'hono';
import { AuthError, AuthService } from './auth';
import { MachineAuthService } from './machine-auth';
import { readJsonCommand, JSON_BODY_MAX_BYTES } from './request-body';
import { TASK_COMMAND_ACTIONS } from './task-command-actions';
import { JSON_COMMAND_ROUTES } from './json-command-routes';
import type { LifecycleEnv } from './task-coordinator';
export const INGRESS_JSON_COMMAND_ROUTES = [...new Set([...JSON_COMMAND_ROUTES, ...TASK_COMMAND_ACTIONS.map(action => `/tasks/{id}/${action}`)])];
const routes = INGRESS_JSON_COMMAND_ROUTES.map(path => new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}/?$`));
const admitted = new WeakMap<Request, Awaited<ReturnType<typeof readJsonCommand>>>();
const intake = new Map<string, number>();
const MAX_PER_IDENTITY = 2;
const resourceId = (value: string) => { try {
    return decodeURIComponent(value);
}
catch {
    return value;
} };
export function isJsonCommand(method: string, path: string) {
    return method === 'POST' && routes.some(pattern => pattern.test(path.replace(/^\/v1(?=\/)/, '')));
}
export async function jsonCommandBody(request: Request) {
    let command = admitted.get(request);
    if (!command) {
        command = await readJsonCommand(request);
        admitted.set(request, command);
    }
    return command.body;
}
export function forwardJsonCommand(url: URL, request: Request) {
    const command = admitted.get(request);
    if (!command)
        throw new AuthError('invalid-request', 400);
    const headers = new Headers(request.headers);
    headers.set('Content-Length', String(command.bytes.byteLength));
    headers.delete('Transfer-Encoding');
    return new Request(url, { method: 'POST', headers, body: command.bytes, signal: request.signal });
}
async function identity(request: Request, env: LifecycleEnv) {
    const path = new URL(request.url).pathname.replace(/^\/v1(?=\/)/, '');
    const machine = new MachineAuthService(env);
    const submit = path.match(/^\/tasks\/([^/]+)\/submissions-with-grant\/?$/);
    const approval = path.match(/^\/candidates\/([^/]+)\/approve-with-grant\/?$/);
    if (submit || approval) {
        const grant = submit ? await machine.submitCredential(request, resourceId(submit[1]!))
            : await machine.approvalCredential(request, resourceId(approval![1]!));
        await machine.checkIntakeAuthority(grant.id, submit ? 'submit' : 'approval');
        return JSON.stringify(['machine', grant.principal_id]);
    }
    const auth = new AuthService(env);
    const claim = path.match(/^\/tasks\/([^/]+)\/claim\/?$/);
    const token = /^Bearer (ocb_\S+)$/.exec(request.headers.get('Authorization') ?? '')?.[1];
    if (claim && token) {
        if (request.headers.has('Cookie'))
            throw new AuthError('unauthenticated');
        const bootstrap = await auth.bootstrap(token, resourceId(claim[1]!), request.headers.get('Idempotency-Key') ?? undefined);
        return JSON.stringify(['agent', bootstrap.authorizer.issuer, bootstrap.authorizer.sub, `agent:${bootstrap.authorization.agent_id}`]);
    }
    const principal = await auth.authenticate(request);
    return principal.type === 'human' ? JSON.stringify(['human', principal.issuer, principal.sub])
        : JSON.stringify(['agent', principal.authorizer.issuer, principal.authorizer.sub, principal.sub]);
}
export function jsonCommandIngress(): MiddlewareHandler<{
    Bindings: LifecycleEnv;
}> {
    return async (c, next) => {
        if (!isJsonCommand(c.req.method, c.req.path))
            return next();
        let owner: string | undefined, reserved = false;
        try {
            owner = await identity(c.req.raw, c.env);
            const length = c.req.header('Content-Length');
            if (length !== undefined && /^\d+$/.test(length) && Number(length) > JSON_BODY_MAX_BYTES)
                throw new AuthError('request-body-too-large', 413);
            const active = intake.get(owner) ?? 0;
            if (active >= MAX_PER_IDENTITY)
                throw new AuthError('request-body-busy', 429);
            intake.set(owner, active + 1);
            reserved = true;
            const { bytes, body } = await readJsonCommand(c.req.raw);
            if (c.req.raw.signal.aborted)
                throw new AuthError('request-disconnected', 400);
            const headers = new Headers(c.req.raw.headers);
            headers.set('Content-Length', String(bytes.byteLength));
            headers.delete('Transfer-Encoding');
            c.req.raw = new Request(c.req.raw, { body: bytes, headers, signal: c.req.raw.signal });
            admitted.set(c.req.raw, { bytes, body });
            await next();
        }
        catch (error) {
            void c.req.raw.body?.cancel().catch(() => { });
            throw error;
        }
        finally {
            admitted.delete(c.req.raw);
            if (reserved) {
                const remaining = intake.get(owner!)! - 1;
                if (remaining)
                    intake.set(owner!, remaining);
                else
                    intake.delete(owner!);
            }
        }
    };
}
