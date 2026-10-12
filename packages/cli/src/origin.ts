/**
 * The one place the CLI decides which API origin a command talks to. Precedence: `OCTOCOVE_API_URL` when
 * set and non-empty, then the origin stored with the current credentials, then the hosted service.
 */
import { checkBaseUrl } from "../../client/src/client.js";
import { ConfigError, type Credentials } from "./config.js";
import { baseUrlOf } from "./http.js";

/** The hosted Octocove API, used when neither the environment nor stored credentials name an origin. */
export const DEFAULT_API_ORIGIN = "https://api.octocove.com";

/**
 * `start` resolves the origin for a call that sends no stored credential (login, workload exchange).
 * `credential` resolves it for a call that sends `credentials`: a credential goes only to the origin it was
 * issued for, so its stored origin wins and a differing `OCTOCOVE_API_URL` never redirects it.
 * An explicit override is validated either way: absolute `https:`, `http:` only for loopback.
 */
export function resolveApiOrigin(env: NodeJS.ProcessEnv, credentials: Pick<Credentials, "apiUrl">, use: "credential"): string;
export function resolveApiOrigin(env: NodeJS.ProcessEnv, credentials?: Pick<Credentials, "apiUrl">, use?: "start"): string;
export function resolveApiOrigin(env: NodeJS.ProcessEnv, credentials?: Pick<Credentials, "apiUrl">, use: "start" | "credential" = "start"): string {
  const override = env.OCTOCOVE_API_URL;
  if (override) {
    try { checkBaseUrl(baseUrlOf(override)); }
    catch { throw new ConfigError("OCTOCOVE_API_URL must be an absolute https:// URL without credentials, query or fragment (http:// only for localhost, 127.0.0.1 or [::1])"); }
  }
  if (use === "credential") return credentials!.apiUrl;
  return override || credentials?.apiUrl || DEFAULT_API_ORIGIN;
}
