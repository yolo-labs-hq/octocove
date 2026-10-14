import { AuthError, allowedOrigins, type AuthEnv } from './auth';
export function authFailureRedirect(request: Request, env: AuthEnv, requestId: string): string | undefined {
    const path = new URL(request.url).pathname;
    const start = request.method === 'GET' && ['/auth/callback', '/auth/login', '/auth/cli/start'].includes(path);
    if (!start && !(request.method === 'POST' && path === '/v1/auth/login'))
        return;
    const mode = request.headers.get('Sec-Fetch-Mode');
    if ((mode && mode !== 'navigate') || request.headers.get('X-Requested-With')?.toLowerCase() === 'xmlhttprequest')
        return;
    let html = 0, json = 0;
    for (const entry of (request.headers.get('Accept') ?? '').toLowerCase().split(',')) {
        const [media, ...parameters] = entry.split(';').map(part => part.trim());
        const weight = parameters.find(part => part.startsWith('q='));
        const quality = weight === undefined ? 1 : Number(weight.slice(2));
        if (!Number.isFinite(quality) || quality < 0 || quality > 1)
            continue;
        if (media === 'text/html')
            html = Math.max(html, quality);
        if (media === 'application/json' || media === 'application/problem+json')
            json = Math.max(json, quality);
    }
    if (html <= 0 || html <= json)
        return;
    try {
        const callback = new URL(env.OIDC_REDIRECT_URI!);
        if (callback.username || callback.password || callback.pathname !== '/auth/callback' || callback.search || callback.hash ||
            (callback.protocol !== 'https:' && !(env.AUTH_DEV_LOCAL === 'true' && callback.protocol === 'http:' && callback.hostname === 'localhost')))
            return;
        let origin = callback.origin;
        origin = configuredWebOrigin(env) ?? origin;
        const target = new URL('/login', origin);
        target.searchParams.set('error', 'sign-in-failed');
        if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId))
            target.searchParams.set('requestId', requestId);
        return target.href;
    }
    catch {
        return;
    }
}
export function configuredWebOrigin(env: AuthEnv): string | undefined {
    if (!env.AUTH_CLI_CONSENT_ORIGIN)
        return;
    try {
        const ui = new URL(env.AUTH_CLI_CONSENT_ORIGIN);
        if (ui.href !== ui.origin + '/' || !allowedOrigins(env).includes(ui.origin) ||
            (ui.protocol !== 'https:' && !(env.AUTH_DEV_LOCAL === 'true' && ui.protocol === 'http:' &&
                ['localhost', '127.0.0.1', '[::1]'].includes(ui.hostname))))
            throw new Error('invalid UI origin');
        return ui.origin;
    }
    catch {
        throw new AuthError('temporarily-unavailable', 503);
    }
}
