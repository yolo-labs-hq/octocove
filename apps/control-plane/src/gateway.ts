import type { MiddlewareHandler } from "hono";
import { AuthError, requireRecentSignIn, type AuthEnv, type Principal } from "./auth";

/** Typed collaboration conflicts. Statuses are fixed here so every transport answers alike. */
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
      detail: error.code,
      requestId,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

/**
 * How a caller may reach a route.
 * - public: no credential (login start, callback, exchange, health).
 * - self: the module authenticates with its own credential (signed integrator jobs, helper/broker bootstrap;
 *   audit reads, where the injected AuthorizeAudit adapter authenticates and scopes, failing closed;
 *   webhooks, whose handlers apply ADR-0009 event authority).
 * - bootstrap: one-use `Bearer ocb_` claim bootstrap OR a human session.
 * - human: Octocove human session only; agent delegations always get 403.
 * - verb: human session, or an agent delegation carrying `agent` (the module still checks membership/task binding).
 * A rule with `machineGrant` also lets a machine grant bearer (ADR 0001) (`ocg_`/`ocsg_`) through to its handler,
 * which authenticates it with the grant routes' own lookup.
 */
export type Access = "public" | "self" | "bootstrap" | "human" | "verb";
export interface RouteRule {
  method: "GET" | "POST" | "DELETE";
  path: string;
  access: Access;
  agent?: string;
  /** POSTs are idempotency-keyed unless the route is signed/helper-authenticated. */
  noKey?: boolean;
  /** The mounted auth handler validates predecessors against the exact recovery operation. */
  recoveryAuth?: boolean;
  /** The handler authenticates a machine grant bearer itself (like `bootstrap` for `ocb_`). */
  machineGrant?: boolean;
  /**
   * Recent sign-in (ADR 0023): a human session caller needs a recent sign-in (`requireRecentSignIn`), else 403
   * `reauth-required`. Agent delegations are unaffected. Handler-authenticated sensitive routes (webhook writes,
   * revoking another sign-in) call the same function themselves.
   */
  recentSignIn?: true;
}

export const routeRules: RouteRule[] = [
  { method: "GET", path: "/tasks/:id/lane", access: "verb", agent: "tasks:read" },
  { method: "POST", path: "/tasks/:id/lane/pushes", access: "verb", agent: "submissions:create" },
  { method: "POST", path: "/tasks/:id/lane/retry", access: "verb", agent: "submissions:create" },
  { method: "POST", path: "/tasks/:id/lane/retire", access: "human" },
  { method: "GET", path: "/healthz", access: "public" },
  // Machine authentication (ADR 0001) authenticates these with dedicated proof/grant/admin gates.
  // Ordinary agent sessions never approve through these dedicated gates.
  { method: "POST", path: "/auth/submit-grants", access: "self" },
  { method: "POST", path: "/auth/submit-grants/:id/revoke", access: "human" },
  { method: "POST", path: "/tasks/:id/submissions-with-grant", access: "self" },
  { method: "POST", path: "/auth/approval-grants", access: "self" },
  { method: "POST", path: "/auth/approval-grants/:id/revoke", access: "self" },
  { method: "POST", path: "/candidates/:id/approve-with-grant", access: "self" },
  { method: "POST", path: "/projects/:project/approval-principals", access: "human", recentSignIn: true },
  // ADR-0009: humans administer machine event authority; handlers enforce project:admin.
  { method: "POST", path: "/projects/:project/event-permissions", access: "human", recentSignIn: true },
  { method: "POST", path: "/projects/:project/event-permissions/:id/revoke", access: "human" },
  { method: "POST", path: "/projects/:project/approval-policies", access: "human", recentSignIn: true },
  { method: "POST", path: "/projects/:project/approval-principals/:id/trust-bindings", access: "human", recentSignIn: true },
  { method: "POST", path: "/projects/:project/approval-principals/:id/disable", access: "human" },
  { method: "POST", path: "/projects/:project/approval-policies/:id/disable", access: "human" },
  { method: "POST", path: "/projects/:project/approval-trust-bindings/:id/disable", access: "human" },
  // Single-use challenge and write-once activation are retry-safe without a request key.
  { method: "POST", path: "/projects/:project/approval-trust-bindings/:id/activation-challenge", access: "human", noKey: true },
  { method: "POST", path: "/projects/:project/approval-trust-bindings/:id/activate", access: "human", noKey: true, recentSignIn: true },
  { method: "POST", path: "/internal/integrator/*", access: "self", noKey: true },
  { method: "POST", path: "/broker/token", access: "self", noKey: true },
  // ADR-0005 repo-lane write custody: runtime-signed, single-use push proof instead of an idempotency key.
  { method: "POST", path: "/broker/push/:taskId", access: "self", noKey: true },
  { method: "DELETE", path: "/broker/token/:id", access: "self" },
  // Identity read: any human session, agent delegation or machine grant may ask who it is; no verb narrows it.
  { method: "GET", path: "/me", access: "verb", machineGrant: true },
  // The dashboard summary is a human's; a machine grant bearer reaches the handler only to be authenticated
  // and refused 403 like a delegation (rather than 401 from the session lookup).
  { method: "GET", path: "/me/projects", access: "human", machineGrant: true },
  // Self-serve first project: human only; the handler applies the PROJECT_CREATORS bootstrap gate.
  { method: "POST", path: "/projects", access: "human", recentSignIn: true },
  // A project:admin human registers the canonical repository (the handler checks the membership);
  // any member, or an agent with tasks:list in its own project, lists them.
  { method: "POST", path: "/projects/:project/repositories", access: "human", recentSignIn: true },
  { method: "GET", path: "/projects/:project/repositories", access: "verb", agent: "tasks:list" },
  { method: "POST", path: "/projects/:project/repositories/:repository/verify", access: "human", recentSignIn: true },
  // ADR 0022: the canonical repository's content, read by any member or an agent with tasks:read in its own project.
  { method: "GET", path: "/projects/:project/tree", access: "verb", agent: "tasks:read" },
  { method: "GET", path: "/projects/:project/blob", access: "verb", agent: "tasks:read" },
  // Project members (ADR 0020): human sessions only. Any member lists; the handlers check membership and, to add or
  // remove, project:admin.
  { method: "GET", path: "/projects/:project/members", access: "human" },
  { method: "POST", path: "/projects/:project/members", access: "human", recentSignIn: true },
  { method: "POST", path: "/projects/:project/members/:principalId/remove", access: "human", recentSignIn: true },
  // Whoever may read GET /receipts/{id} reads the project's landings (an agent: its own task's only).
  { method: "GET", path: "/projects/:project/landings", access: "verb", agent: "receipts:read" },
  { method: "GET", path: "/tasks", access: "verb", agent: "tasks:list" },
  { method: "POST", path: "/tasks", access: "human" },
  { method: "GET", path: "/tasks/:id", access: "verb", agent: "tasks:read" },
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
  // Owning-claimant exception (docs/API.md): the module checks the claimant; the gateway admits the verb.
  { method: "POST", path: "/candidates/:id/withdraw", access: "verb", agent: "submissions:create" },
  { method: "POST", path: "/candidates/:id/reject", access: "human" },
  { method: "POST", path: "/approvals/:id/withdraw", access: "human" },
  { method: "GET", path: "/receipts/:id", access: "verb", agent: "receipts:read" },
  { method: "GET", path: "/audit", access: "self", agent: "audit:read", noKey: true },
  { method: "GET", path: "/events", access: "self", agent: "events:read", noKey: true },
  // ADR-0009: webhook handlers authenticate through eventAuthority, which admits a human session
  // or a registered machine assertion and refuses agent delegations; POSTs stay idempotency-keyed.
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
  // A human's own sign-ins. Revoke recovers like logout (revoking the current family revokes the
  // calling session), so its handler authenticates, refusing delegations and machine grants itself.
  { method: "GET", path: "/me/sessions", access: "human" },
  { method: "POST", path: "/me/sessions/:id/revoke", access: "human", recoveryAuth: true },
  // A human's own agent grants. A valid machine grant bearer reaches the handler, which answers it
  // 403 human-required (an unknown one 401), as the gateway answers a delegation.
  { method: "GET", path: "/me/delegations", access: "human", machineGrant: true },
];

const compiled = routeRules.map((rule) => ({
  rule,
  pattern: new RegExp(
    `^${rule.path.replace(/\*$/, ".*").replace(/:[A-Za-z]+/g, "[^/]+")}$`,
  ),
}));

/** Path with an optional `/v1` prefix removed; the unprefixed form is the canonical rule key. */
export const stripVersion = (path: string) => path.replace(/^\/v1(?=\/)/, "");

export function findRule(method: string, path: string): RouteRule | undefined {
  const bare = stripVersion(path);
  return compiled.find((c) => c.rule.method === method && c.pattern.test(bare))?.rule;
}

const keyFormat = /^[\x21-\x7e]{16,128}$/;

/**
 * The one decision on whether a request must carry a well-formed Idempotency-Key. Every layer that
 * checks the header asks this, so a route's `noKey` holds wherever it is mounted. An unlisted POST
 * still needs a key.
 */
export function missingIdempotencyKey(method: string, path: string, key: string | undefined): boolean {
  if (method !== "POST" || findRule(method, path)?.noKey) return false;
  return !keyFormat.test(key ?? "");
}

/** One year, every subdomain; no `preload` until the whole zone is known to be HTTPS-only. */
export const HSTS = "max-age=31536000; includeSubDomains";
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/;
/**
 * Local serving is plain HTTP and exempt: tests and Miniflare use a loopback URL, and `wrangler dev`
 * rewrites the URL to a route host but reports a loopback client. In production Cloudflare
 * overwrites cf-connecting-ip with the visitor's address.
 */
const local = (request: Request) =>
  LOOPBACK.test(new URL(request.url).hostname) || LOOPBACK.test(request.headers.get("cf-connecting-ip") ?? "");

/** A public host reached over plain HTTP: by the URL, or by the scheme the edge reports. */
export function insecureTransport(request: Request): boolean {
  if (local(request)) return false;
  let visitor: unknown;
  try { visitor = (JSON.parse(request.headers.get("cf-visitor") ?? "{}") as { scheme?: unknown })?.scheme; } catch { /* malformed: ignore */ }
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  return new URL(request.url).protocol === "http:" || visitor === "http" || forwarded === "http";
}

/**
 * HTTPS enforcement for api.octocove.com and the routes served on the web host: plain-HTTP GET/HEAD
 * gets a 301 to the same URL on https:, any other method a 403 `https-required` (never replayed across
 * schemes); every HTTPS response carries HSTS. Runs before authentication, so no credential sent in
 * the clear is ever acted on.
 */
export function httpsOnly(): MiddlewareHandler {
  return async (c, next) => {
    if (insecureTransport(c.req.raw)) {
      if (c.req.method !== "GET" && c.req.method !== "HEAD") throw new AuthError("https-required", 403);
      const target = new URL(c.req.url);
      target.protocol = "https:"; target.port = "";
      return c.redirect(target.href, 301);
    }
    if (!local(c.req.raw)) c.header("Strict-Transport-Security", HSTS);
    await next();
  };
}

export type Authenticate = (request: Request) => Promise<Principal>;

/**
 * Edge allow-list. Authenticates once, rejects a principal that may not use the verb at all,
 * and requires an Idempotency-Key on every POST. Modules still make the fine-grained
 * membership/task-binding decision; this layer only narrows, it never grants.
 */
export function gateway(
  authenticate: Authenticate,
  { recoveryRoutesMounted = false }: { recoveryRoutesMounted?: boolean } = {},
): MiddlewareHandler {
  return async (c, next) => {
    const rule = findRule(c.req.method, c.req.path);
    if (!rule || rule.access === "public" || rule.access === "self") {
      if (rule && missingIdempotencyKey(c.req.method, c.req.path, c.req.header("Idempotency-Key")))
        throw new AuthError("idempotency-key-required", 400);
      return next();
    }
    // A claim bootstrap or a machine grant bearer is authenticated by its handler, not here.
    const handlerCredential =
      (rule.access === "bootstrap" && /^Bearer ocb_/.test(c.req.header("Authorization") ?? "")) ||
      (!!rule.machineGrant && /^Bearer ocs?g_/.test(c.req.header("Authorization") ?? ""));
    // Only the app mounting authRoutes opts in: those handlers authenticate even on
    // retries, including CSRF, operation key, family and replacement validity.
    if (!handlerCredential && !(recoveryRoutesMounted && rule.recoveryAuth)) {
      const principal = await authenticate(c.req.raw);
      if (principal.type === "agent") {
        if (rule.access === "human") throw new AuthError("human-required", 403);
        if (rule.access !== "verb" || (rule.agent && !principal.verbs.includes(rule.agent)))
          throw new AuthError("forbidden", 403);
      }
      if (rule.recentSignIn) requireRecentSignIn(principal, c.req.raw, (c.env ?? {}) as AuthEnv);
    }
    if (missingIdempotencyKey(c.req.method, c.req.path, c.req.header("Idempotency-Key")))
      throw new AuthError("idempotency-key-required", 400);
    return next();
  };
}
