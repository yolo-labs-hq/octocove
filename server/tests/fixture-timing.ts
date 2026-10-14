import { performance } from 'node:perf_hooks';
export async function timedFixture(file: string, phase: 'setup' | 'teardown', work: () => unknown) {
    const start = performance.now();
    try {
        return await work();
    }
    finally {
        console.info('CI_FIXTURE_TIMING ' + JSON.stringify({ file, phase, ms: performance.now() - start }));
    }
}
