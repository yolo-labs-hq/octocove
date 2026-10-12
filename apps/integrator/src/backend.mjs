/** Compute adapters share one private dispatch/control protocol. No fallback. */
const DEPRECATED = { gke: 'http' };
let warned = false;
/** Canonical backend for a configured value, or null. Deprecated aliases are accepted for one release. */
export function canonicalBackend(backend) {
  if (backend === 'http' || backend === 'local') return backend;
  if (typeof backend === 'string' && Object.hasOwn(DEPRECATED, backend)) {
    if (!warned) {
      warned = true;
      console.warn(`integrator backend '${backend}' is deprecated and will be removed in the next release; use '${DEPRECATED[backend]}'`);
    }
    return DEPRECATED[backend];
  }
  return null;
}
export function validBackend(backend) {
  return canonicalBackend(backend) !== null;
}
/** Local plaintext transport is limited to explicit loopback development. */
export function validRunnerUrl(value, backend) {
  const canonical = canonicalBackend(backend);
  if (!canonical) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash &&
      (url.protocol === 'https:' || (canonical === 'local' && url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  } catch { return false; }
}
