export function trackedWork() {
    const inflight: {
        work: Promise<unknown>;
        release: () => void;
    }[] = [];
    return {
        track<T>(work: Promise<T>, release: () => void) { inflight.push({ work, release }); return work; },
        async settleThen(dispose: () => unknown) {
            const left = inflight.splice(0);
            for (const { release } of left)
                release();
            const rejected = (await Promise.allSettled(left.map(({ work }) => work)))
                .flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []);
            if (!rejected.length)
                return await dispose();
            const describe = (reason: unknown) => reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
            try {
                await dispose();
            }
            catch (error) {
                rejected.push(error);
            }
            throw new AggregateError(rejected, 'tracked work rejected: ' + rejected.map(describe).join('; '));
        },
    };
}
