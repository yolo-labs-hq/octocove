// Worker module bundled by scripts/test-workerd.mjs: runs every case inside the workerd isolate and
// answers with per-case results. Nothing here touches Node APIs.
import { allCases } from './cases/index.js';

export default {
  async fetch(): Promise<Response> {
    const results: Array<{ name: string; ok: boolean; error?: string; ms: number }> = [];
    for (const testCase of allCases) {
      const started = Date.now();
      try {
        await testCase.run();
        results.push({ name: testCase.name, ok: true, ms: Date.now() - started });
      } catch (error) {
        results.push({ name: testCase.name, ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error), ms: Date.now() - started });
      }
    }
    const runtime = typeof navigator === 'object' ? navigator.userAgent : 'unknown';
    return Response.json({ runtime, results });
  },
};
