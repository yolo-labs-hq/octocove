export function canonicalBackend(backend) {
  return backend === "http" || backend === "local" ? backend : null;
}
export function validBackend(backend) {
    return canonicalBackend(backend) !== null;
}
export function validRunnerUrl(value, backend) {
    const canonical = canonicalBackend(backend);
    if (!canonical)
        return false;
    try {
        const url = new URL(value);
        return !url.username && !url.password && !url.search && !url.hash &&
            (url.protocol === 'https:' || (canonical === 'local' && url.protocol === 'http:' &&
                ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
    }
    catch {
        return false;
    }
}
