import { appendTransitions } from './audit';
import { AuthError, AuthService, hash, type AuthEnv } from './auth';
import { MachineAuthService, machineGrantBearer } from './machine-auth';
import { ledgerReplay } from './repositories';
export const profileFields = ['name', 'pronouns', 'bio', 'timezone'] as const;
type Field = typeof profileFields[number];
export type Profile = Record<Field, string | null>;
const limits: Record<Field, number> = { name: 80, pronouns: 40, bio: 280, timezone: 64 };
export const profileColumns = (alias: string) => `${alias}.name AS profile_name,${alias}.pronouns AS profile_pronouns,${alias}.bio AS profile_bio,${alias}.timezone AS profile_timezone`;
type ProfileRow = {
    profile_name: string | null;
    profile_pronouns: string | null;
    profile_bio: string | null;
    profile_timezone: string | null;
};
export const profileOf = (row: Partial<ProfileRow> | null | undefined, displayName: string | null | undefined): Profile => ({
    name: row?.profile_name ?? displayName ?? null, pronouns: row?.profile_pronouns ?? null,
    bio: row?.profile_bio ?? null, timezone: row?.profile_timezone ?? null,
});
const invalid = (field: string) => new AuthError('invalid-profile', 400, { field });
const control = /\p{Cc}/u;
const zoneName = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
function timeZone(value: string) {
    if (!zoneName.test(value))
        return undefined;
    try {
        return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
    }
    catch {
        return undefined;
    }
}
export function profilePatch(raw: unknown): Partial<Profile> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((k) => !(profileFields as readonly string[]).includes(k)))
        throw new AuthError('invalid-request', 400);
    const input = raw as Record<string, unknown>, patch: Partial<Profile> = {};
    for (const field of profileFields) {
        if (!(field in input))
            continue;
        const value = input[field];
        if (value === null) {
            patch[field] = null;
            continue;
        }
        if (typeof value !== 'string' || control.test(value))
            throw invalid(field);
        const trimmed = value.trim(), length = [...trimmed].length;
        if (length > limits[field] || (field === 'name' && !length))
            throw invalid(field);
        if (!length) {
            patch[field] = null;
            continue;
        }
        if (field === 'timezone') {
            const zone = timeZone(trimmed);
            if (!zone)
                throw invalid(field);
            patch[field] = zone;
        }
        else
            patch[field] = trimmed;
    }
    return patch;
}
const read = (env: AuthEnv, issuer: string, sub: string) => env.DB.prepare(`SELECT u.display_name,${profileColumns('p')} FROM auth_users u LEFT JOIN user_profiles p ON p.issuer=u.issuer AND p.sub=u.sub
    WHERE u.issuer=? AND u.sub=?`).bind(issuer, sub).first<ProfileRow & {
    display_name: string | null;
}>();
export async function updateProfile(request: Request, env: AuthEnv, retry = true): Promise<{
    profile: Profile;
}> {
    if (machineGrantBearer.test(request.headers.get('authorization') ?? '')) {
        await new MachineAuthService(env).grantIdentity(request);
        throw new AuthError('human-required', 403);
    }
    const auth = new AuthService(env), p = await auth.human(request);
    let raw: unknown;
    try {
        raw = await request.clone().json();
    }
    catch {
        throw new AuthError('invalid-request', 400);
    }
    const patch = profilePatch(raw), fields = profileFields.filter((f) => f in patch);
    const caller = `${p.issuer}|${p.sub}`, key = request.headers.get('Idempotency-Key')!;
    const digest = await hash(JSON.stringify({ action: 'profile.update', patch: fields.map((f) => [f, patch[f]]) }));
    const replay = ledgerReplay(env.DB, caller, key, digest);
    const prior = await replay();
    if (prior)
        return prior;
    if (!fields.length) {
        const current = await read(env, p.issuer, p.sub);
        return { profile: profileOf(current, current?.display_name) };
    }
    const at = new Date().toISOString(), guard = crypto.randomUUID();
    let committed: {
        response: string;
    } | undefined;
    try {
        const results = await appendTransitions(env.DB, [{
                beforeMutations: [
                    { sql: `INSERT INTO auth_cas SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM auth_sessions s JOIN auth_families f ON f.id=s.family_id
          WHERE s.hash=? AND f.id=? AND s.revoked=0 AND f.revoked=0 AND s.expires>unixepoch() AND f.absolute_expiry>unixepoch())
          THEN 1 ELSE 0 END`, params: [guard, p.sessionHash, p.familyId] },
                    { sql: 'DELETE FROM auth_cas WHERE id=?', params: [guard] },
                ],
                mutation: { sql: `INSERT INTO user_profiles(issuer,sub,name,pronouns,bio,timezone,updated_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(issuer,sub) DO UPDATE SET ${[...fields, 'updated_at'].map((f) => `${f}=excluded.${f}`).join(',')}`,
                    params: [p.issuer, p.sub, patch.name ?? null, patch.pronouns ?? null, patch.bio ?? null, patch.timezone ?? null, at] },
                afterMutations: [{ sql: `INSERT INTO machine_admin_operations(principal,operation_key,request_digest,response)
        SELECT ?,?,?,json_object('profile',json_object('name',COALESCE(p.name,u.display_name),'pronouns',p.pronouns,'bio',p.bio,
          'timezone',p.timezone)) FROM user_profiles p LEFT JOIN auth_users u ON u.issuer=p.issuer AND u.sub=p.sub
        WHERE p.issuer=? AND p.sub=? RETURNING response`, params: [caller, key, digest, p.issuer, p.sub] }],
                audit: { at, actor: { type: 'human', id: caller }, projectId: null, taskId: null, type: 'profile.updated',
                    refs: { principalId: caller, fields }, idempotencyKey: `profile.updated:${caller}:${guard}` },
            }]);
        committed = results.at(-1)?.results[0] as {
            response: string;
        } | undefined;
    }
    catch (error) {
        if (!/UNIQUE|constraint|duplicate immutable identity/i.test(String(error)))
            throw error;
        const raced = await replay();
        if (raced)
            return raced;
        if (/CHECK constraint/i.test(String(error))) {
            await auth.human(request);
            throw new AuthError('credential-revoked');
        }
        if (retry)
            return updateProfile(request, env, false);
        throw error;
    }
    if (!committed)
        throw new Error('profile-ledger-missing');
    return JSON.parse(committed.response);
}
