/**
 * A fetch that authorizes requests with a {@link CredentialProvider}, for code that sends its own HTTP requests to
 * the API outside the typed client (a Git smart-HTTP preflight, a credential helper). A request to `origin` that
 * presents a bearer the provider owns is sent with the provider's current token; after a 401
 * `credential-expired`/`credential-revoked` it is sent once more with the provider's replacement. Every other request
 * passes through untouched. Answers to owned requests are scrubbed of the provider's tokens (headers, status text
 * and JSON or text bodies); binary and streamed bodies pass through as the same bytes.
 */
import { CREDENTIAL_REFUSALS, CredentialUnavailableError, type CredentialProvider, type CredentialRefusal } from './credential-provider.js';
import type { FetchLike } from './client.js';
import { REDACTED, sanitizeCause } from './redact.js';

export interface AuthorizedFetchOptions {
  /** Only requests to this origin carry the provider's bearer. */
  readonly origin: string;
  /** Whether a presented bearer is the provider's to replace; default: a token the provider handed out (`knownTokens`). */
  readonly owns?: (token: string) => boolean | Promise<boolean>;
  /** Requests sent exactly as given, unscrubbed (for example the renewal route, which carries the predecessor). */
  readonly bypass?: (url: URL) => boolean;
}

/** JSON (including `+json`, such as problem details) and `text/*`: the bodies a credential could be echoed in. */
function textual(contentType: string) {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  return type.startsWith('text/') || type === 'application/json' || type.endsWith('+json');
}

/**
 * The response with header values and status text scrubbed, and a JSON or text body scrubbed too. Any other body
 * (a Git pack, octet-stream, any binary or streamed type) passes through as the same stream, never decoded. A body
 * without a content type is scrubbed only when it is valid UTF-8.
 */
export async function scrubbedResponse(response: Response, scrub: (text: string) => string): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.forEach((value, key) => headers.set(key, scrub(value)));
  const init = { status: response.status, statusText: scrub(response.statusText), headers };
  // A body passed through unchanged keeps its declared length, so a reader can still detect a truncated one; only a
  // rewritten body drops it.
  const rewritten = (text: string) => { headers.delete('content-length'); return new Response(text, init); };
  if ([204, 205, 304].includes(response.status) || response.body === null) return new Response(null, init);
  const type = response.headers.get('content-type');
  if (type !== null && !textual(type)) return new Response(response.body, init);
  if (type === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { return new Response(bytes, init); }
    return rewritten(scrub(text));
  }
  return rewritten(scrub(await response.text()));
}

/** Exact replacement of each token (and its JSON-escaped form), longest first. */
export function tokenScrubber(tokens: readonly string[]): (text: string) => string {
  const known = [...new Set(tokens.filter(Boolean))].sort((a, b) => b.length - a.length);
  return (text) => known.reduce((value, token) => value.split(JSON.stringify(token).slice(1, -1)).join(REDACTED).split(token).join(REDACTED), text);
}

export function authorizedFetch(provider: CredentialProvider, fetch: FetchLike, options: AuthorizedFetchOptions): FetchLike {
  const origin = new URL(options.origin).origin;
  const owns = options.owns ?? ((token: string) => (provider.knownTokens?.() ?? []).includes(token));
  return async (url, init) => {
    const target = new URL(url);
    const headers = new Headers(init.headers);
    const presented = headers.get('authorization');
    if (target.origin !== origin || !presented?.startsWith('Bearer ') || options.bypass?.(target)) return fetch(url, init);
    const bearerValue = presented.slice('Bearer '.length);
    if (!(await owns(bearerValue))) return fetch(url, init);
    const seen = new Set<string>([bearerValue]);
    const signal = init.signal ?? undefined;
    try {
      let token = await provider.token({ attempt: 1, signal });
      seen.add(token);
      const send = () => {
        headers.set('authorization', `Bearer ${token}`);
        return fetch(url, { ...init, headers: Object.fromEntries(headers) });
      };
      let response = await send();
      if (response.status === 401 && provider.refresh) {
        const code = await response.clone().json().then((b: unknown) => (b as { code?: unknown } | null)?.code, () => undefined);
        if ((CREDENTIAL_REFUSALS as readonly unknown[]).includes(code)) {
          token = await provider.refresh({ attempt: 2, signal, rejected: token, code: code as CredentialRefusal });
          seen.add(token);
          response = await send();
        }
      }
      for (const t of provider.knownTokens?.() ?? []) seen.add(t);
      return await scrubbedResponse(response, tokenScrubber([...seen]));
    } catch (error) {
      for (const t of provider.knownTokens?.() ?? []) seen.add(t);
      // Callers treat a thrown fetch error as a lost answer and may resend: a credential refusal answers instead.
      if (error instanceof CredentialUnavailableError) {
        return Response.json({ type: `urn:octocove:problem:${error.code}`, title: error.code, status: 401, code: error.code, detail: tokenScrubber([...seen])(error.message) },
          { status: 401, headers: { 'content-type': 'application/problem+json' } });
      }
      throw new TypeError('the request failed before any HTTP response', { cause: sanitizeCause(error, [...seen]) });
    }
  };
}
