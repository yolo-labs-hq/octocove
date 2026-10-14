import { afterEach, expect, it, vi } from 'vitest';
import { AuthService } from '../src/auth';
import { authRoutes } from '../src/auth-routes';
afterEach(() => vi.restoreAllMocks());
function setup(returnPath = '/projects?view=mine') {
    vi.spyOn(AuthService.prototype, 'callbackTransaction').mockResolvedValue({ device_hash: null } as any);
    vi.spyOn(AuthService.prototype, 'completeLogin').mockResolvedValue({ sessionToken: 'fixture-session', csrfToken: 'fixture-csrf',
        idleExpiresAt: new Date(Date.now() + 600000).toISOString(), absoluteExpiresAt: new Date(Date.now() + 1200000).toISOString(), returnPath } as any);
}
it.each([
    { api: 'http://localhost:8787', web: 'http://localhost:3100', local: true },
    { api: 'https://app.example', web: 'https://web.example', local: false },
    { api: 'https://app.example', web: undefined, local: false },
    { api: 'http://localhost:8787', web: undefined, local: true },
])('successful browser callback uses configured web origin or retains relative return: %j', async ({ api, web, local }) => {
    setup();
    const response = await authRoutes().request(`${api}/auth/callback?return_path=https://untrusted.example`, { headers: { Accept: 'text/html', Referer: 'https://untrusted.example' } }, { OIDC_REDIRECT_URI: `${api}/auth/callback`,
        AUTH_CLI_CONSENT_ORIGIN: web, AUTH_ALLOWED_ORIGINS: web ?? api, AUTH_DEV_LOCAL: local ? 'true' : undefined } as any);
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(web ? `${web}/projects?view=mine` : '/projects?view=mine');
    expect(response.headers.get('Set-Cookie')).toContain('fixture-session');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
});
it.each(['https://unlisted.example', 'https://web.example/path', 'https://web.example?x=1', 'https://user:pass@web.example', 'http://web.example', 'javascript:alert(1)'])('invalid configured origin retains the existing relative redirect: %s', async (web) => {
    setup();
    const response = await authRoutes().request('https://app.example/auth/callback', {}, { AUTH_CLI_CONSENT_ORIGIN: web, AUTH_ALLOWED_ORIGINS: 'https://web.example,http://web.example' } as any);
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/projects?view=mine');
    expect(AuthService.prototype.completeLogin).toHaveBeenCalledOnce();
});
it.each(['//untrusted.example', 'https://untrusted.example', '/\\untrusted.example'])('unsafe stored return path is refused: %s', async (path) => {
    setup(path);
    const response = await authRoutes().request('https://app.example/auth/callback', {}, { AUTH_CLI_CONSENT_ORIGIN: 'https://web.example', AUTH_ALLOWED_ORIGINS: 'https://web.example' } as any);
    expect(response.status).toBe(400);
    expect(response.headers.has('Location')).toBe(false);
});
