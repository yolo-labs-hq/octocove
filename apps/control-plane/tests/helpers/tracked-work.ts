// Work a test leaves running (a held receiver, its delivery tick) is released and settled while that
// test's Miniflare is still alive, even when the test failed first. A late D1 call therefore cannot hit a
// disposed instance, and its rejection is observed here instead of surfacing in the next test. A rejection
// fails the owning test's teardown (after disposal, so nothing leaks), even when the test body passed.
// tests/tracked-teardown.test.ts proves the order, and the rejection report, with child fixture runs.
export function trackedWork() {
  const inflight: { work: Promise<unknown>; release: () => void }[] = [];
  return {
    track<T>(work: Promise<T>, release: () => void) { inflight.push({ work, release }); return work; },
    /** Release and settle every tracked piece of work, then run `dispose`, then throw any tracked rejection. */
    async settleThen(dispose: () => unknown) {
      const left = inflight.splice(0);
      for (const { release } of left) release();
      const rejected = (await Promise.allSettled(left.map(({ work }) => work)))
        .flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []);
      if (!rejected.length) return await dispose();
      const describe = (reason: unknown) => reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
      try { await dispose(); } catch (error) { rejected.push(error); } // reported with them, not instead of them
      throw new AggregateError(rejected, 'tracked work rejected: ' + rejected.map(describe).join('; '));
    },
  };
}
