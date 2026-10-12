export function apiDriver(transport, identity, archetype) {
  let transportMs = 0, wallMs = 0;
  return {
    info: { archetype, version: '1.1.0', kind: 'headless-api', developmentDouble: false },
    async call(path, method = 'GET', body, key = 'conformance-operation', credential = identity.token) {
      const start = performance.now();
      const headers = { Authorization: `Bearer ${credential}`, 'Idempotency-Key': key.padEnd(20, '-'), 'Content-Type': 'application/json' };
      const input = { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
      const ioStart = performance.now();
      const response = await transport(path, input);
      const text = await response.text();
      transportMs += performance.now() - ioStart;
      const value = { status: response.status, body: text ? JSON.parse(text) : null };
      wallMs += performance.now() - start;
      return value;
    },
    timings: () => ({ adapterOnlyMs: Math.max(0, wallMs - transportMs), transportMs }),
  };
}
