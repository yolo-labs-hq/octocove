import { timingSafeEqual } from 'node:crypto';
import { verifyLane, verifySource } from './git.mjs';

/** Mount at the configured trusted gateway's POST /verify-source, alongside
 * dispatch and checks. Never expose this credential-bearing route publicly. */
export async function verifySourceRequest(request, dispatchToken) {
  const supplied = Buffer.from(request.headers.get('Authorization') ?? '');
  const expected = Buffer.from(`Bearer ${dispatchToken}`);
  if (!dispatchToken || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    return Response.json({ code: 'unauthorized' }, { status: 401 });
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  try {
    const input = await request.json();
    if (!input || typeof input.runId !== 'string' || typeof input.repoId !== 'string' ||
        typeof input.ref !== 'string' || typeof input.remote !== 'string' || typeof input.canonicalRepoId !== 'string' ||
        typeof input.canonicalRemote !== 'string' || typeof input.targetRef !== 'string') throw new Error('invalid-input');
    return Response.json(await (input.mode === 'lane' ? verifyLane(input) : verifySource(input)));
  } catch {
    // Missing objects, provider refusal and Git diagnostics never expose tokens.
    return Response.json({ code: 'source-verification-unavailable' }, { status: 503 });
  }
}
