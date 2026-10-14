import type { MiddlewareHandler } from "hono";
import { AuthError, requireRecentSignIn, type AuthEnv, type Principal } from "./auth";
export const errorVocabulary = {
    "stale-base": 409,
    "approval-invalidated": 409,
    "dependency-unlanded": 409,
    conflict: 409,
    fenced: 409,
} as const;
export function problemBody(error: AuthError, requestId: string | null) {
    const status = (errorVocabulary as Record<string, number>)[error.code] ?? error.status;
    return {
        status,
        body: {
            type: `urn:octocove:problem:${error.code}`,
            title: error.code,
            status,
            code: error.code,
            detail: error.code === 'local-repository-setup-unavailable'
                ? 'Local development does not create or import repositories yet. Use the seeded project demo and repository demo-canonical.'
                : error.code,
            requestId,
            ...(error.details ? { details: error.details } : {}),
        },
    };
}
export type Access = "public" | "self" | "bootstrap" | "human" | "verb";
export interface RouteRule {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    access: Access;
    agent?: string;
    noKey?: boolean;
    recoveryAuth?: boolean;
    machineGrant?: boolean;
    recentSignIn?: true;
}
export const routeRules: RouteRule[] = [
    { method: "GET", path: "/tasks/:id/lane/receive-pack/refs", access: "self" },
    { method: "POST", path: "/tasks/:id/lane/receive-pack", access: "self", noKey: true },
    { method: "GET", path: "/tasks/:id/lane", access: "verb", agent: "tasks:read" },
    { method: "POST", path: "/tasks/:id/lane/pushes", access: "verb", agent: "submissions:create" },
    { method: "POST", path: "/tasks/:id/lane/retry", access: "verb", agent: "submissions:create" },
    { method: "POST", path: "/tasks/:id/lane/retire", access: "human" },
    { method: "GET", path: "/healthz", access: "public" },
    { method: "POST", path: "/auth/submit-grants", access: "self" },
    { method: "POST", path: "/auth/submit-grants/:id/revoke", access: "human" },
    { method: "POST", path: "/tasks/:id/submissions-with-grant", access: "self" },
    { method: "POST", path: "/auth/approval-grants", access: "self" },
    { method: "POST", path: "/auth/approval-grants/:id/revoke", access: "self" },
    { method: "POST", path: "/candidates/:id/approve-with-grant", access: "self" },
    { method: "POST", path: "/projects/:project/approval-principals", access: "human", recentSignIn: true },
    { method: "POST", path: "/projects/:project/event-permissions", access: "human", recentSignIn: true },
    { method: "POST", path: "/projects/:project/event-permissions/:id/revoke", access: "human" },
    { method: "POST", path: "/projects/:project/approval-policies", access: "human", recentSignIn: true },
    { method: "POST", path: "/projects/:project/approval-principals/:id/trust-bindings", access: "human", recentSignIn: true },
    { method: "POST", path: "/projects/:project/approval-principals/:id/disable", access: "human" },
    { method: "POST", path: "/projects/:project/approval-policies/:id/disable", access: "human" },
    { method: "POST", path: "/projects/:project/approval-trust-bindings/:id/disable", access: "human" },
    { method: "POST", path: "/projects/:project/approval-trust-bindings/:id/activation-challenge", access: "human", noKey: true },
    { method: "POST", path: "/projects/:project/approval-trust-bindings/:id/activate", access: "human", noKey: true, recentSignIn: true },
    { method: "POST", path: "/internal/integrator/*", access: "self", noKey: true },
    { method: "POST", path: "/broker/token", access: "self", noKey: true },
    { method: "POST", path: "/broker/push/:taskId", access: "self", noKey: true },
    { method: "DELETE", path: "/broker/token/:id", access: "self" },
    { method: "GET", path: "/me", access: "verb", machineGrant: true },
    { method: "GET", path: "/me/projects", access: "human", machineGrant: true },
    { method: "POST", path: "/projects", access: "human", recentSignIn: true },
    { method: "POST", path: "/projects/:project/repositories", access: "human", recentSignIn: true },
    { method: "GET", path: "/projects/:project/repositories", access: "verb", agent: "tasks:list" },
    { method: "POST", path: "/projects/:project/repositories/:repository/verify", access: "human", recentSignIn: true },
    { method: "GET", path: "/projects/:project/tree", access: "verb", agent: "tasks:read" },
    { method: "GET", path: "/projects/:project/blob", access: "verb", agent: "tasks:read" },
    { method: "GET", path: "/projects/:project/members", access: "human" },
    { method: "POST", path: "/projects/:project/members", access: "human", recentSignIn: true },
    { method: "POST", path: "/projects/:project/members/:principalId/remove", access: "human", recentSignIn: true },
    { method: "GET", path: "/projects/:project/landings", access: "verb", agent: "receipts:read" },
    { method: "GET", path: "/tasks", access: "verb", agent: "tasks:list" },
    { method: "POST", path: "/tasks", access: "human" },
    { method: "GET", path: "/tasks/:id", access: "verb", agent: "tasks:read" },
    { method: "GET", path: "/tasks/:id/local-diff-content", access: "verb", agent: "tasks:read" },
    { method: "POST", path: "/tasks/:id/intent", access: "human" },
    { method: "POST", path: "/tasks/:id/publish", access: "human" },
    { method: "POST", path: "/tasks/:id/claim", access: "bootstrap" },
    { method: "POST", path: "/tasks/:id/release", access: "verb", agent: "tasks:claim" },
    { method: "POST", path: "/tasks/:id/submissions", access: "verb", agent: "submissions:create" },
    { method: "POST", path: "/tasks/:id/unpublish", access: "human" },
    { method: "POST", path: "/tasks/:id/dependencies/add", access: "human" },
    { method: "POST", path: "/tasks/:id/dependencies/remove", access: "human" },
    { method: "POST", path: "/tasks/:id/reject", access: "human" },
    { method: "POST", path: "/tasks/:id/supersede", access: "human" },
    { method: "POST", path: "/tasks/:id/claim/replace", access: "human" },
    { method: "POST", path: "/tasks/:id/approve", access: "human", recentSignIn: true },
    { method: "POST", path: "/tasks/:id/land", access: "verb", agent: "candidates:land", recentSignIn: true },
    { method: "POST", path: "/tasks/:id/authorizations", access: "human", recentSignIn: true },
    { method: "GET", path: "/tasks/:id/log", access: "self", agent: "audit:read", noKey: true },
    { method: "GET", path: "/claims/:id", access: "verb", agent: "claims:read" },
    { method: "GET", path: "/submissions/:id/candidate", access: "verb", agent: "candidates:read" },
    { method: "POST", path: "/candidates/:id/approve", access: "human", recentSignIn: true },
    { method: "POST", path: "/candidates/:id/land", access: "verb", agent: "candidates:land", recentSignIn: true },
    { method: "POST", path: "/candidates/:id/withdraw", access: "verb", agent: "submissions:create" },
    { method: "POST", path: "/candidates/:id/reject", access: "human" },
    { method: "POST", path: "/approvals/:id/withdraw", access: "human" },
    { method: "GET", path: "/receipts/:id", access: "verb", agent: "receipts:read" },
    { method: "GET", path: "/audit", access: "self", agent: "audit:read", noKey: true },
    { method: "GET", path: "/events", access: "self", agent: "events:read", noKey: true },
    { method: "GET", path: "/webhooks/:id/deliveries", access: "self" },
    { method: "POST", path: "/webhooks/:id/deliveries/:deliveryId/redrive", access: "self" },
    { method: "POST", path: "/webhooks/:id/rotate-secret", access: "self" },
    { method: "POST", path: "/webhooks", access: "self" },
    { method: "POST", path: "/webhooks/:id/replays", access: "self" },
    { method: "POST", path: "/webhooks/:id/disable", access: "self" },
    { method: "POST", path: "/webhooks/:id/reactivate", access: "self" },
    { method: "POST", path: "/delegations/:id/renew", access: "verb", recoveryAuth: true },
    { method: "POST", path: "/delegations/:id/revoke", access: "verb" },
    { method: "POST", path: "/auth/login", access: "public" },
    { method: "GET", path: "/auth/login", access: "public" },
    { method: "GET", path: "/auth/callback", access: "public" },
    { method: "GET", path: "/auth/cli/start", access: "public" },
    { method: "POST", path: "/auth/cli/exchange", access: "public" },
    { method: "POST", path: "/auth/cli/confirm", access: "human" },
    { method: "POST", path: "/auth/session/renew", access: "human", recoveryAuth: true },
    { method: "POST", path: "/auth/logout", access: "human", recoveryAuth: true },
    { method: "GET", path: "/me/sessions", access: "human" },
    { method: "POST", path: "/me/sessions/:id/revoke", access: "human", recoveryAuth: true },
    { method: "GET", path: "/me/delegations", access: "human", machineGrant: true },
    { method: "GET", path: "/me/notifications", access: "human", machineGrant: true },
    { method: "POST", path: "/me/notifications/read", access: "human", machineGrant: true },
    { method: "GET", path: "/me/notification-preferences", access: "human", machineGrant: true },
    { method: "PUT", path: "/me/notification-preferences", access: "human", machineGrant: true },
    { method: "PATCH", path: "/me/profile", access: "human", machineGrant: true },
];
const compiled = routeRules.map((rule) => ({
    rule,
    pattern: new RegExp(`^${rule.path.replace(/\*$/, ".*").replace(/:[A-Za-z]+/g, "[^/]+")}$`),
}));
export const stripVersion = (path: string) => path.replace(/^\/v1(?=\/)/, "");
export function findRule(method: string, path: string): RouteRule | undefined {
    const bare = stripVersion(path);
    return compiled.find((c) => c.rule.method === method && c.pattern.test(bare))?.rule;
}
const keyFormat = /^[\x21-\x7e]{16,128}$/;
export function missingIdempotencyKey(method: string, path: string, key: string | undefined): boolean {
    if ((method !== "POST" && method !== "PUT" && method !== "PATCH") || findRule(method, path)?.noKey)
        return false;
    return !keyFormat.test(key ?? "");
}
export const HSTS = "max-age=31536000; includeSubDomains";
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/;
const local = (request: Request) => LOOPBACK.test(new URL(request.url).hostname) || LOOPBACK.test(request.headers.get("cf-connecting-ip") ?? "");
export function insecureTransport(request: Request): boolean {
    if (local(request))
        return false;
    let visitor: unknown;
    try {
        visitor = (JSON.parse(request.headers.get("cf-visitor") ?? "{}") as {
            scheme?: unknown;
        })?.scheme;
    }
    catch { }
    const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    return new URL(request.url).protocol === "http:" || visitor === "http" || forwarded === "http";
}
export function httpsOnly(): MiddlewareHandler {
    return async (c, next) => {
        if (insecureTransport(c.req.raw)) {
            if (c.req.method !== "GET" && c.req.method !== "HEAD")
                throw new AuthError("https-required", 403);
            const target = new URL(c.req.url);
            target.protocol = "https:";
            target.port = "";
            return c.redirect(target.href, 301);
        }
        if (!local(c.req.raw))
            c.header("Strict-Transport-Security", HSTS);
        await next();
    };
}
export type Authenticate = (request: Request) => Promise<Principal>;
export function gateway(authenticate: Authenticate, { recoveryRoutesMounted = false }: {
    recoveryRoutesMounted?: boolean;
} = {}): MiddlewareHandler {
    return async (c, next) => {
        const rule = findRule(c.req.method, c.req.path);
        if (!rule || rule.access === "public" || rule.access === "self") {
            if (rule && missingIdempotencyKey(c.req.method, c.req.path, c.req.header("Idempotency-Key")))
                throw new AuthError("idempotency-key-required", 400);
            return next();
        }
        const handlerCredential = (rule.access === "bootstrap" && /^Bearer ocb_/.test(c.req.header("Authorization") ?? "")) ||
            (!!rule.machineGrant && /^Bearer ocs?g_/.test(c.req.header("Authorization") ?? ""));
        if (!handlerCredential && !(recoveryRoutesMounted && rule.recoveryAuth)) {
            const principal = await authenticate(c.req.raw);
            if (principal.type === "agent") {
                if (rule.access === "human")
                    throw new AuthError("human-required", 403);
                if (rule.access !== "verb" || (rule.agent && !principal.verbs.includes(rule.agent)))
                    throw new AuthError("forbidden", 403);
            }
            if (rule.recentSignIn)
                requireRecentSignIn(principal, c.req.raw, (c.env ?? {}) as AuthEnv);
        }
        if (missingIdempotencyKey(c.req.method, c.req.path, c.req.header("Idempotency-Key")))
            throw new AuthError("idempotency-key-required", 400);
        return next();
    };
}
