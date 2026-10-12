// Handler for the gateway's private BROKER service binding (wrangler.jsonc). It exposes
// `ProofBroker` and `UpstreamWriter` over the binding contract: the provider credential stays
// inside this service, and only single-use writer tickets cross to the gateway.
//
//   POST /authorize | /admit | /proof | /complete   JSON; denials are 403 {"error": "<code>"}
//   GET|POST /forward/<git route>[?service=...]      redeems the ticket in TICKET_HEADER
//
// The deployment owns persistence (transactional storage serializing every gateway replica)
// and the live authority; both are injected into `ProofBroker` before this handler is built.
import { AuthorityDenied } from './protocol.mjs';
import { WriterDenied } from './upstream-writer.mjs';

export const TICKET_HEADER = 'x-octocove-writer-ticket';
// Set only by this service when the writer refused before any provider request.
export const WRITER_DENIED_HEADER = 'x-octocove-writer-denied';
const AUTH_HEADER = 'authorization';
const CALLS = new Map([['authorize', 'authorizeChannel'], ['admit', 'admitProof'], ['proof', 'issueProof'], ['complete', 'completeWrite']]);

export function createBrokerService({ broker, writer }) {
  return async function brokerService(request) {
    const url = new URL(request.url), path = url.pathname.slice(1);
    try {
      if (path.startsWith('forward/')) {
        const headers = new Headers();
        for (const name of ['content-type', 'git-protocol']) if (request.headers.has(name)) headers.set(name, request.headers.get(name));
        const body = request.method === 'POST' ? new Uint8Array(await request.arrayBuffer()) : undefined;
        const response = await writer.forward(request.headers.get(TICKET_HEADER) ?? '', { route: path.slice('forward/'.length), search: url.search,
          method: request.method, headers, body, signal: request.signal });
        // Provider headers (auth challenges, cookies, locations) never cross the binding.
        return new Response(response.body, { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/octet-stream' } });
      }
      if (request.method !== 'POST' || !CALLS.has(path)) return Response.json({ error: 'not-found' }, { status: 404 });
      // The lease travels only in the authorization header, never in the JSON body.
      const input = await request.json(), authHeader = request.headers.get(AUTH_HEADER);
      delete input[AUTH_HEADER];
      return Response.json(await broker[CALLS.get(path)]({ ...input, ...(authHeader ? { [AUTH_HEADER]: authHeader } : {}) }) ?? {});
    } catch (error) {
      if (error instanceof WriterDenied) return Response.json({ error: error.message }, { status: 503, headers: { [WRITER_DENIED_HEADER]: '1' } });
      if (error instanceof AuthorityDenied) return Response.json({ error: error.message }, { status: 403 });
      return Response.json({ error: 'broker-unavailable' }, { status: 503 });
    }
  };
}
