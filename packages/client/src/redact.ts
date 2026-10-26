/** Keys whose values are secret wherever they appear, in every transport. */
export const SECRET_KEY = /token|secret|verifier|deviceCode|assertion|cookie/i;
export const REDACTED = '[redacted]';

/** Collects string values under secret-named keys, at any depth, so they can be scrubbed from free text. */
export function secretValues(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 32 || !value || typeof value !== 'object') return out;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key) && typeof item === 'string' && item) out.push(item);
    else secretValues(item, out, depth + 1);
  }
  return out;
}

/** Nesting beyond this depth is masked whole rather than traversed. */
const MAX_DEPTH = 32;

/**
 * Stands in for `[redacted]` while later rules still run, so an emitted marker can never be read as
 * the `[` of a nested value; `settle` turns it into the marker. A literal U+E000 in the input is
 * rendered as the marker too (over-redaction, never a leak).
 */
const PENDING = '\uE000';
const settle = (text: string) => text.replaceAll(PENDING, REDACTED);

/**
 * Known secrets (longest first, so a secret containing another is replaced whole), bearer and Basic credential
 * values, and Octocove's prefixed opaque credentials (`ocs_` sessions, `ocb_` bootstraps, `occ_` authorization
 * codes, `oca_` access tokens, `ocf_` refresh tokens), wherever they appear.
 */
function scrubValue(text: string, secrets: readonly string[]): string {
  return secrets.reduce((out, secret) => out.split(secret).join(PENDING), text)
    .replace(BEARER, `$1${PENDING}`)
    .replace(BASIC, `$1${PENDING}`)
    .replace(PREFIXED_CREDENTIAL, `$1${PENDING}`);
}

const usable = (secrets: readonly string[]) =>
  secrets.filter((s) => typeof s === 'string' && s.length > 0).sort((a, b) => b.length - a.length);

/**
 * Returns a copy with values under secret-named keys replaced, and every known secret string, bearer
 * value and secret assignment (`secret=…`, `token: …`) scrubbed from the remaining strings (keys
 * included), whatever its length. Structure nested beyond the traversal limit is masked. Strings are
 * sanitized one at a time, never as a serialized document, so no rule can reach past the end of the
 * string value it matched in.
 */
export function redact<T>(value: T, secrets: readonly string[] = [], depth = 0): T {
  const scrub = usable(secrets);
  return walk(value, (text) => settle(scrubValue(text, scrub).replace(VALUE_ASSIGNED_SECRET, `$1${REDACTED}`)), depth) as T;
}

function walk(value: unknown, text: (s: string) => string, depth: number): unknown {
  if (typeof value === 'string') return text(value);
  if (!value || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => walk(item, text, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    text(key),
    SECRET_KEY.test(key) && item !== null && item !== undefined ? REDACTED : walk(item, text, depth + 1),
  ]));
}

const SECRET_WORD = '(?:token|secret|verifier|devicecode|assertion|cookie)';
// An object or array under an unquoted secret-named key cannot be bounded in free text: drop the rest.
const NESTED_SECRET = new RegExp(`(\\b[\\w-]*${SECRET_WORD}[\\w-]*\\s*[:=]\\s*)[{\\[][\\s\\S]*$`, 'i');
// `key=value` / `key: value` with an unquoted name; the value is a (possibly unterminated) quoted string or a bare word.
const ASSIGNED_SECRET = new RegExp(`(\\b[\\w-]*${SECRET_WORD}[\\w-]*\\s*[=:]\\s*)(?:"(?:[^"\\\\]|\\\\[\\s\\S])*"?|[^\\s&;,"]+)`, 'gi');
// A secret name inside a parsed string: one of the secret words as a whole name part — at the start, after
// `_`/`-`, or camel-cased (`refreshToken`) — followed by the end of the name, `_`, `-`, a digit or a
// capital, so prose such as `my secretary=Jane` is not an assignment. Case-sensitive on purpose.
const LOWER_WORD = 'secret|token|password|authorization|cookie|assertion|verifier|api[_-]?key|apiKey|device[_-]?code|deviceCode';
const CAPITAL_WORD = 'Secret|Token|Password|Authorization|Cookie|Assertion|Verifier|Api[_-]?[Kk]ey|Device[_-]?[Cc]ode';
const UPPER_WORD = 'SECRET|TOKEN|PASSWORD|AUTHORIZATION|COOKIE|ASSERTION|VERIFIER|API[_-]?KEY|DEVICE[_-]?CODE';
const SECRET_NAME = `(?<![\\w-])[\\w-]*?(?:(?<![A-Za-z0-9])(?:${LOWER_WORD})s?(?![a-z])|(?:${CAPITAL_WORD})s?(?![a-z])|(?<![A-Za-z0-9])(?:${UPPER_WORD})S?(?![A-Za-z]))[\\w-]*`;
// The assignment rule applied to one parsed string value: the value ends at `;`, `,`, `&`, whitespace
// or the end of that string. A brace placeholder such as `token: {identifier}` is not a value; any
// other value opened with `{` or `[` cannot be bounded and is masked to the end of the string value.
const VALUE_ASSIGNED_SECRET = new RegExp(`(${SECRET_NAME}\\s*[=:]\\s*)(?!\\{[\\w.-]*\\}(?![^\\s&;,]))(?:[{\\[][\\s\\S]*$|"(?:[^"\\\\]|\\\\[\\s\\S])*"?|[^\\s&;,"]+)`, 'g');
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
// HTTP Basic credentials (base64 of `id:secret`); a short word such as `realm` in a challenge is not one.
const BASIC = /\b(Basic\s+)[A-Za-z0-9+/]{8,}={0,2}(?![\w"=+/])/gi;
// Octocove's opaque credentials carry a type prefix; the value after it is the secret.
const PREFIXED_CREDENTIAL = /(?<![A-Za-z0-9])(oc[sbcaf]_)[A-Za-z0-9_-]{8,}/g;
// The end of a JSON-style key: a closing quote followed by a colon.
const KEY_END = /"\s*:/g;

/** Whether the character at `index` is escaped by an odd run of backslashes. */
function escaped(text: string, index: number): boolean {
  let run = 0;
  while (index - 1 - run >= 0 && text[index - 1 - run] === '\\') run++;
  return run % 2 === 1;
}

function decodeJsonString(body: string): string {
  try { return JSON.parse(`"${body}"`) as string; } catch { /* malformed escape: compare a best-effort decoding */ }
  return body.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(/\\(.)/g, '$1');
}

/**
 * Escape-aware scan of unparsed text for the first JSON-style key (`"…":`) whose decoded name is
 * secret. Each unescaped `":` is walked back to its unescaped opening quote, so stray quotes elsewhere
 * cannot shift the pairing. Whatever follows that key — string, number, object, array, truncated or
 * not — is masked to the end of the text: unparsed text cannot be bounded reliably, so mask more.
 */
function maskFromSecretKey(text: string): string {
  KEY_END.lastIndex = 0;
  for (let match = KEY_END.exec(text); match; match = KEY_END.exec(text)) {
    const close = match.index;
    if (escaped(text, close)) continue;
    let open = close - 1;
    while (open >= 0 && (text[open] !== '"' || escaped(text, open))) open--;
    if (open >= 0 && SECRET_KEY.test(decodeJsonString(text.slice(open + 1, close)))) {
      return `${text.slice(0, close + match[0].length)}${PENDING}…`;
    }
  }
  return text;
}

/**
 * Scrubs free text (unparsed bodies, error messages, stacks): known secrets, bearer values, everything
 * from the first secret-named JSON key onward, and `key=value` secrets. Everything after an object or
 * array opened under an unquoted secret-named key is dropped.
 */
export function redactText(text: string, secrets: readonly string[] = []): string {
  return settle(maskFromSecretKey(scrubValue(text, usable(secrets)))
    .replace(NESTED_SECRET, `$1${REDACTED}…`)
    .replace(ASSIGNED_SECRET, `$1${REDACTED}`));
}

/**
 * Diagnostic text for a response body. JSON is redacted structurally (each string value on its own)
 * and serialized once; text that does not parse goes through the free-text rules.
 */
export function redactBody(text: string, secrets: readonly string[], limit: number): string {
  let parsed: unknown;
  let json = false;
  try { parsed = JSON.parse(text); json = true; } catch { /* unparsed: scrub the text itself */ }
  const safe = json ? JSON.stringify(redact(parsed, secrets)) : redactText(text, secrets);
  return safe.length > limit ? `${safe.slice(0, limit)}…` : safe;
}

const MAX_CAUSE_DEPTH = 4;
/** Recorded in place of a field whose inspection threw (a throwing getter, a hostile proxy). */
const UNREADABLE = '[unreadable]';
const FAILED = Symbol('unreadable');

/** Runs one inspection of an external value; a throw yields FAILED instead of escaping. */
function attempt<T>(read: () => T): T | typeof FAILED {
  try { return read(); } catch { return FAILED; }
}

/**
 * A copy of an external failure (a fetch rejection, a body-read error, an abort reason) that is safe
 * to expose as `cause`. Every copied string — message, stack, name, own properties, and every string
 * inside plain-object causes, nested objects and arrays, keys included — goes through the free-text
 * rules (`redactText`), so secrets the client never knew about are still caught by shape. Values under
 * secret-named keys are masked; objects nested beyond the traversal limit are masked; error causes
 * nested deeper than four levels are dropped; functions and symbols are dropped. Every read of the
 * external value is guarded: a field whose getter (or proxy trap) throws becomes `[unreadable]`, and
 * the thrown value is never inspected or kept.
 */
export function sanitizeCause(cause: unknown, secrets: readonly string[], depth = 0): unknown {
  const text = (s: string) => redactText(s, secrets);
  return cleanCause(cause, text, depth, 0);
}

function cleanCause(value: unknown, text: (s: string) => string, errorDepth: number, depth: number): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return text(value);
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) return REDACTED;
  const isArray = attempt(() => Array.isArray(value));
  const isError = attempt(() => value instanceof Error);
  if (isArray === FAILED || isError === FAILED) return UNREADABLE;
  if (isArray) {
    const length = attempt(() => (value as unknown[]).length);
    if (length === FAILED || typeof length !== 'number') return UNREADABLE;
    const out: unknown[] = [];
    for (let i = 0; i < length; i++) {
      const item = attempt(() => (value as unknown[])[i]);
      out.push(item === FAILED ? UNREADABLE : cleanCause(item, text, errorDepth, depth + 1) ?? null);
    }
    return out;
  }
  const keys = attempt(() => Object.keys(value));
  if (keys === FAILED) return UNREADABLE;
  const copy = (target: Record<string, unknown>, skip: (key: string) => boolean = () => false) => {
    for (const key of keys) {
      if (skip(key)) continue;
      let safe: unknown;
      if (SECRET_KEY.test(key)) {
        const item = attempt(() => (value as Record<string, unknown>)[key]);
        safe = item === null || item === undefined ? item : REDACTED;
      } else safe = field(value, key, text, errorDepth, depth);
      if (safe !== undefined) target[text(key)] = safe;
    }
    return target;
  };
  if (!isError) return copy({});
  if (errorDepth >= MAX_CAUSE_DEPTH) return undefined;
  const message = attempt(() => String((value as Error).message ?? ''));
  const name = attempt(() => String((value as Error).name ?? 'Error'));
  const stack = attempt(() => (value as Error).stack);
  const safe = new Error(message === FAILED ? UNREADABLE : text(message));
  Object.defineProperty(safe, 'name', { value: name === FAILED ? UNREADABLE : text(name), writable: true, configurable: true });
  Object.defineProperty(safe, 'stack', { value: stack === FAILED ? UNREADABLE : typeof stack === 'string' ? text(stack) : undefined, writable: true, configurable: true });
  copy(safe as unknown as Record<string, unknown>, (key) => key === 'cause' || key === 'message' || key === 'stack' || key === 'name');
  const hasCause = attempt(() => 'cause' in value);
  if (hasCause === FAILED) Object.defineProperty(safe, 'cause', { value: UNREADABLE, writable: true, configurable: true });
  else if (hasCause) {
    const nested = field(value, 'cause', text, errorDepth + 1, depth, true);
    if (nested !== undefined) Object.defineProperty(safe, 'cause', { value: nested, writable: true, configurable: true });
  }
  return safe;
}

/** One guarded property read, sanitized; a nested Error counts one cause level (or `asCause` says so). */
function field(owner: object, key: string, text: (s: string) => string, errorDepth: number, depth: number, asCause = false): unknown {
  const item = attempt(() => (owner as Record<string, unknown>)[key]);
  if (item === FAILED) return UNREADABLE;
  if (asCause) return cleanCause(item, text, errorDepth, depth + 1);
  const isError = attempt(() => item instanceof Error);
  if (isError === FAILED) return UNREADABLE;
  if (!isError) return cleanCause(item, text, errorDepth, depth + 1);
  return errorDepth + 1 >= MAX_CAUSE_DEPTH ? undefined : cleanCause(item, text, errorDepth + 1, depth + 1);
}
