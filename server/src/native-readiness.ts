export function nativeReadiness(env: Record<string, unknown>) {
    const required = ['ARTIFACTS_ACCOUNT_ID', 'ARTIFACTS_API_TOKEN', 'OIDC_ISSUER', 'OIDC_CLIENT_ID',
        'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI', 'OCTOCOVE_ISSUER', 'DELEGATION_PRIVATE_JWK',
        'DELEGATION_PUBLIC_JWKS', 'AUTH_ALLOWED_ORIGINS', 'PROJECT_CREATORS', 'DB', 'TASKS', 'EVENTS'];
    const present = (name: string) => typeof env[name] === 'string' ? Boolean((env[name] as string).trim()) : Boolean(env[name]);
    const backend = env.INTEGRATOR_BACKEND === undefined || env.INTEGRATOR_BACKEND === 'worker-native' ? 'worker-native' : 'other';
    const missing = required.filter(name => !present(name));
    return { ready: backend === 'worker-native' && missing.length === 0, backend, missing,
        receiptExport: present('INTEGRATOR_RUN_SECRET') ? 'configured' : 'pending-signing-secret' };
}
