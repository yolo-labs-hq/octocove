// Shared git hygiene for the helper and its authorities: config text quoting, credentialed
// remote validation and the allowlisted environment every git child runs with.
import { GrantError } from './grant.mjs';

// A git config value or subsection name as a quoted string. Control characters are refused
// rather than escaped, so a token or path can never end the value and start a new key.
export function quote(value) {
  const text = String(value);
  if (/[\0-\x1f\x7f]/.test(text)) throw new GrantError('invalid-git-config-value');
  return `"${text.replace(/[\\"]/g, c => `\\${c}`)}"`;
}

// Private auth config for exactly one remote. Redirects are never followed, so the header
// cannot be replayed to a redirect target, and the header and channel settings apply only to
// the remote's own URL prefix (`[http "<url>"]`), never to any other host git contacts.
export function remoteAuthConfig(remote, bearer, settings = {}) {
  const entries = [['extraHeader', `Authorization: Bearer ${bearer}`], ...Object.entries(settings)];
  const lines = entries.filter(([, v]) => v !== undefined).map(([k, v]) => `\t${k} = ${quote(v)}\n`);
  return `[http]\n\tfollowRedirects = false\n[http ${quote(remote)}]\n${lines.join('')}`;
}

// The Artifacts task-repository form the control plane's broker sends write tokens to: an
// account host and a `/git/<namespace>/<repo>.git` path, no port.
export const ARTIFACTS_REMOTE_HOST = /^([a-z0-9]{32})\.artifacts\.cloudflare\.net$/;
export const ARTIFACTS_REMOTE_PATH = /^\/git\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git$/;

// A remote a credential may be attached to: HTTPS, no userinfo, query or fragment.
// `artifacts` additionally pins the host and path to the Artifacts task-repository form.
export function credentialedRemote(value, { artifacts = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new GrantError('invalid-remote'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname)
    throw new GrantError('invalid-remote');
  if (artifacts && (url.port || !ARTIFACTS_REMOTE_HOST.test(url.hostname) || !ARTIFACTS_REMOTE_PATH.test(url.pathname)))
    throw new GrantError('invalid-remote');
  return value;
}

// Git children never inherit the runtime's environment (workload tokens, the operator's
// ~/.gitconfig, credential helpers): only PATH and locale pass through.
export function gitEnv(extra = {}) {
  const env = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1' };
  for (const k of ['PATH', 'LANG', 'LC_ALL', 'TZ']) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}
