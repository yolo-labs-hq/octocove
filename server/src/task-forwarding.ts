import type { Context } from 'hono';
import { findRule } from './gateway';
import type { LifecycleEnv } from './task-coordinator';
export function forwardTask<E extends LifecycleEnv>(c: Context<{
    Bindings: E;
}>, taskId: string, request: Request) {
    const headers = new Headers(request.headers);
    headers.set('X-Octocove-Request-Id', c.res.headers.get('X-Request-Id')!);
    const rule = findRule(c.req.method, c.req.path);
    headers.set('X-Octocove-Route', rule ? `${c.req.path.startsWith('/v1/') ? '/v1' : ''}${rule.path}` : 'unmatched');
    return c.env.TASKS.get(c.env.TASKS.idFromName(taskId)).fetch(new Request(request, { headers }));
}
