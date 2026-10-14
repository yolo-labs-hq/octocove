export class MemoryStore {
    #rows = new Map();
    #tail = Promise.resolve();
    transaction(fn) {
        const run = this.#tail.then(async () => {
            const writes = new Map();
            const tx = {
                get: async (k) => structuredClone(writes.has(k) ? writes.get(k) ?? undefined : this.#rows.get(k)),
                put: async (k, v) => { writes.set(k, structuredClone(v)); },
                delete: async (k) => { writes.set(k, null); },
                list: async (prefix) => [...new Set([...this.#rows.keys(), ...writes.keys()])].filter(k => k.startsWith(prefix) && (writes.has(k) ? writes.get(k) !== null : true)),
            };
            const result = await fn(tx);
            for (const [k, v] of writes)
                v === null ? this.#rows.delete(k) : this.#rows.set(k, v);
            return result;
        });
        this.#tail = run.catch(() => { });
        return run;
    }
    get(k) { return this.transaction(tx => tx.get(k)); }
    put(k, v) { return this.transaction(tx => tx.put(k, v)); }
    delete(k) { return this.transaction(tx => tx.delete(k)); }
}
