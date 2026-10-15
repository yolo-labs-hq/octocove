# Human canonical Git reads

Status: Accepted

Human project members holding `tasks:read` may clone or fetch the canonical
repository without creating a task or claim. A smart-HTTP proxy serves only
upload-pack advertisement and stateless upload-pack requests. It grants no Git
write authority. Agents retain their existing claim-bound path.

Each request authenticates a live human session and checks current membership
and repository ownership, eligibility and import status. The two Git routes
accept a human CLI Bearer session or HTTP Basic with fixed username `octocove`
and that same human session as password. Basic is route-local transport wrapping;
it is not accepted as another API login mechanism. Cookies are not accepted.

A dedicated human credential helper supplies credentials through the Git
credential pipe from the explicitly selected CLI configuration. Git configuration
stores only non-secret helper settings and the proxy URL. No human credential
fallback is available to agents. Provider READ tokens remain server-side, expire
in 60 seconds and are revoked after use with durable retry on failure.

Every read and authenticated refusal is audited. No credential or Git request
body is recorded. Admission fails closed when its durable audit cannot be
recorded. Principal and repository rate/concurrency limits bound resource use.
Pack bytes stream with backpressure, byte limits and a 120-second deadline;
disconnection or truncation aborts the transfer. Named refs and packs are never
cached by the proxy. Repository access includes its advertised candidate/audit
refs; it is not a branch-level confidentiality boundary.

The proxy derives its upstream solely from stored repository metadata, confines
it to the provider HTTPS endpoint and refuses redirects. Membership removal
blocks new requests; an already admitted stream is bounded by its deadline.
