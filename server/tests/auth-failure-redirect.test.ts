import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthError, AuthService, bindingName } from '../src/auth';
import { authRoutes } from '../src/auth-routes';
import { createApp } from '../src/index';
const web = 'https://web.example';
const env = { OIDC_REDIRECT_URI: `${web}/auth/callback`, AUTH_ALLOWED_ORIGINS: web } as any;
afterEach(() => vi.restoreAllMocks());
const failed = (code: string, status: number) => new AuthError(code, status, { provider: 'private provider diagnostic' });
function setup(code: string, status: number, expired = false) {
    vi.spyOn(AuthService.prototype, 'callbackTransaction').mockImplementation(async () => {
        if (expired)
            throw failed('invalid-login', 400);
        return { device_hash: null };
    });
    vi.spyOn(AuthService.prototype, 'completeLogin').mockRejectedValue(failed(code, status));
}
async function redirect(response: Response, origin = web) {
    expect(response.status).toBe(303);
    const target = new URL(response.headers.get('Location')!);
    expect(target.origin).toBe(origin);
    expect(target.pathname).toBe('/login');
    expect([...target.searchParams.keys()].sort()).toEqual(['error', 'requestId']);
    expect(target.searchParams.get('error')).toBe('sign-in-failed');
    expect(target.searchParams.get('requestId')).toBe(response.headers.get('X-Request-Id'));
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(target.href).not.toContain('private');
    expect(await response.text()).not.toContain('private');
}
for (const [code, status, expired] of [
    ['invalid-id-token', 401, false], ['invalid-login', 400, false], ['issuer-unavailable', 503, false], ['invalid-login', 400, true],
] as const)
    for (const accept of ['text/html', 'application/json']) {
        it(`${expired ? 'expired transaction' : code}: ${accept}`, async () => {
            setup(code, status, expired);
            const response = await authRoutes().request('https://untrusted.example/auth/callback?state=untrusted&code=untrusted&return_path=https://untrusted.example', { headers: { Accept: accept, Referer: 'https://untrusted.example' } }, env);
            if (accept === 'text/html')
                await redirect(response);
            else {
                expect(response.status).toBe(status);
                expect(response.headers.get('Content-Type')).toContain('application/problem+json');
                expect(response.headers.has('Location')).toBe(false);
                expect(await response.json()).toEqual({ type: `urn:octocove:problem:${code}`, title: code, status, code, detail: code,
                    requestId: response.headers.get('X-Request-Id'), details: { provider: 'private provider diagnostic' } });
            }
            if (expired)
                expect(AuthService.prototype.completeLogin).not.toHaveBeenCalled();
        });
    }
for (const accept of ['text/html', 'application/json']) {
    it(`CLI browser start failure: ${accept}`, async () => {
        vi.spyOn(AuthService.prototype, 'startCliBrowser').mockRejectedValue(failed('issuer-unavailable', 503));
        const response = await authRoutes().request(`${web}/auth/cli/start?userCode=untrusted`, { headers: { Accept: accept } }, env);
        if (accept === 'text/html')
            await redirect(response);
        else {
            expect(response.status).toBe(503);
            expect((await response.json()).code).toBe('issuer-unavailable');
        }
    });
    it(`browser login / reauthentication start failure: ${accept}`, async () => {
        vi.spyOn(AuthService.prototype, 'discovery').mockRejectedValue(failed('issuer-unavailable', 503));
        for (const query of ['', '?reauth=1&return_path=%2F']) {
            const response = await authRoutes().request(`${web}/v1/auth/login${query}`, { method: 'POST',
                headers: { Accept: accept, 'Content-Type': 'application/json', 'Idempotency-Key': 'retry-start-00000000001', Origin: web, Cookie: `${bindingName}=binding` }, body: '{"mode":"browser"}' }, env);
            if (accept === 'text/html')
                await redirect(response);
            else {
                expect(response.status).toBe(503);
                expect((await response.json()).code).toBe('issuer-unavailable');
            }
        }
    });
}
it('gateway login-start failures use the same browser redirect', async () => {
    const response = await createApp().request('https://untrusted.example/v1/auth/login?reauth=1&return_path=%2F%2Funtrusted.example', { method: 'POST', headers: { Accept: 'text/html' }, body: '{}' }, env);
    await redirect(response);
});
it.each([
    {}, { Accept: '*/*' }, { Accept: 'text/html;q=0, application/json' },
    { Accept: 'text/html', 'X-Requested-With': 'XMLHttpRequest' }, { Accept: 'text/html', 'Sec-Fetch-Mode': 'cors' },
    { Accept: 'application/json;q=1, text/html;q=0.5' },
])('API/XHR content negotiation stays JSON: %j', async (headers) => {
    setup('invalid-id-token', 401);
    const response = await authRoutes().request(`${web}/auth/callback`, { headers }, env);
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('invalid-id-token');
});
it.each(['https://user:password@untrusted.example/auth/callback', 'https://untrusted.example/other', 'javascript:alert(1)', '', undefined])('invalid web-origin configuration fails closed instead of using the request origin: %s', async (configured) => {
    setup('invalid-id-token', 401);
    const response = await authRoutes().request(`${web}/auth/callback`, { headers: { Accept: 'text/html' } }, { ...env, OIDC_REDIRECT_URI: configured });
    expect(response.status).toBe(401);
    expect(response.headers.has('Location')).toBe(false);
});
it('HTML Accept on unrelated API mutations retains problem JSON', async () => {
    const response = await authRoutes().request(`${web}/v1/auth/logout`, { method: 'POST', headers: { Accept: 'text/html' }, body: '{}' }, env);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('idempotency-key-required');
});
it.each([
    { callback: 'http://localhost:8787/auth/callback', configured: 'http://localhost:3100', origin: 'http://localhost:3100', local: true },
    { callback: 'http://localhost:8787/auth/callback', configured: undefined, origin: 'http://localhost:8787', local: true },
    { callback: `${web}/auth/callback`, configured: 'https://ui.example', origin: 'https://ui.example', local: false },
    { callback: `${web}/auth/callback`, configured: undefined, origin: web, local: false },
])('uses configured UI origin or registered callback fallback: %j', async ({ callback, configured, origin, local }) => {
    setup('invalid-login', 400, true);
    const response = await authRoutes().request('https://untrusted.example/auth/callback?return_path=https://untrusted.example', { headers: { Accept: 'text/html', Referer: 'https://untrusted.example' } }, { ...env, OIDC_REDIRECT_URI: callback,
        AUTH_DEV_LOCAL: local ? 'true' : undefined, AUTH_CLI_CONSENT_ORIGIN: configured, AUTH_ALLOWED_ORIGINS: origin });
    await redirect(response, origin);
});
it.each([
    'https://unlisted.example', 'https://ui.example/path', 'https://ui.example?query=1',
    'https://ui.example#fragment', 'https://user:password@ui.example', 'javascript:alert(1)', 'http://ui.example',
])('invalid explicit UI origin stays JSON, without a request-origin fallback: %s', async (origin) => {
    setup('invalid-login', 400, true);
    const response = await authRoutes().request(`${web}/auth/callback`, { headers: { Accept: 'text/html' } }, { ...env, AUTH_CLI_CONSENT_ORIGIN: origin, AUTH_ALLOWED_ORIGINS: 'https://ui.example,http://ui.example' });
    expect(response.status).toBe(400);
    expect(response.headers.has('Location')).toBe(false);
});
