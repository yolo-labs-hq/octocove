import { generateKeyPairSync, randomBytes, createHash, sign } from 'node:crypto';
const encode = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
export function oidc(config) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'disposable', alg: 'RS256', use: 'sig' };
  const codes = new Map();
  const issuer = config.issuer, redirectUri = `${config.api}/auth/callback`;
  return async request => {
    const url = new URL(request.url);
    if (url.pathname === '/.well-known/openid-configuration') return Response.json({ issuer,
      authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
      id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_basic'] });
    if (url.pathname === '/jwks') return Response.json({ keys: [jwk] });
    if (url.pathname === '/authorize' && request.method === 'GET') {
      const q = Object.fromEntries(url.searchParams);
      if (q.client_id !== 'octocove-local' || q.redirect_uri !== redirectUri || q.response_type !== 'code' ||
          q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge ?? '') || !q.state || !q.nonce)
        return Response.json({ error: 'invalid_request' }, { status: 400 });
      if (!(config.liveProvider ? ['author', 'author-a', 'author-b', 'approver'] : ['author', 'approver']).includes(q.identity)) return new Response(
        'Disposable local login: append &identity=author or &identity=approver to this URL.\nOr run pnpm demo:login author / pnpm demo:login approver.\n',
        { headers: { 'Content-Type': 'text/plain' } });
      for (const [code, grant] of codes) if (grant.expires < Date.now()) codes.delete(code);
      const code = randomBytes(32).toString('base64url');
      codes.set(code, { ...q, expires: Date.now() + 60_000 });
      const callback = new URL(redirectUri); callback.searchParams.set('state', q.state); callback.searchParams.set('code', code);
      return Response.redirect(callback, 302);
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      if (request.headers.get('authorization') !== `Basic ${Buffer.from(`octocove-local:${config.clientSecret}`).toString('base64')}`)
        return Response.json({ error: 'invalid_client' }, { status: 401 });
      const body = new URLSearchParams(await request.text()), grant = codes.get(body.get('code')); codes.delete(body.get('code'));
      if (!grant || grant.expires < Date.now() || body.get('grant_type') !== 'authorization_code' || body.get('redirect_uri') !== redirectUri ||
          createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url') !== grant.code_challenge)
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const now = Math.floor(Date.now() / 1000);
      const data = `${encode({ alg: 'RS256', kid: jwk.kid })}.${encode({ iss: issuer, sub: grant.identity, aud: 'octocove-local',
        iat: now, auth_time: now, exp: now + 300, nonce: grant.nonce, email: `${grant.identity}@example.invalid`, name: grant.identity })}`;
      return Response.json({ id_token: `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`, token_type: 'Bearer' });
    }
    return new Response('Not found', { status: 404 });
  };
}
