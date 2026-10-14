export class ProviderCallMeter {
    readonly counts: Record<string, number> = {};
    wrap(http: typeof fetch): typeof fetch {
        return async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
            const shape = url.pathname.endsWith('/info/refs')
                ? `${method} info/refs?service=${url.searchParams.get('service')}`
                : /\/tokens\/[^/]+$/.test(url.pathname) ? `${method} tokens/:id`
                    : url.pathname.endsWith('/tokens') ? `${method} tokens` : `${method} other`;
            this.counts[shape] = (this.counts[shape] ?? 0) + 1;
            return http(input, init);
        };
    }
    get total() { return Object.values(this.counts).reduce((a, b) => a + b, 0); }
}
