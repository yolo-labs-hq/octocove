// Peer authentication for the per-attempt helper socket (credential boundary).
//
// The helper authenticates local peers with kernel-enforced identity/isolation plus the
// trusted runtime's mapping to the attempt. A container/user-namespace label alone, a
// shared host UID, a socket pathname, or SO_PEERCRED reporting the same UID does NOT
// establish an attempt identity. The runtime is therefore responsible for confining the
// socket to the attempt's isolated process domain (distinct host UID + namespaces, a
// correctly mapped user namespace, or a microVM). This module fails closed unless the
// trusted runtime asserts that confinement; it never treats same-UID reachability as proof.
//
// Node cannot read SO_PEERCRED portably, so the runtime injects its own kernel-identity
// check as `verifyPeer`. The defaults here encode the policy, not a substitute for it.

import { GrantError } from './grant.mjs';

export class PeerDenied extends GrantError {
  constructor(reason = 'peer-denied') { super(reason); }
}

// Build the peer authenticator the AttemptHelper uses on every connection.
//
//   domainConfinedByRuntime: the trusted runtime attests that this socket is reachable
//     ONLY from the attempt's isolated process domain (not merely the shared UID). Without
//     this attestation and without a verifyPeer hook, every connection is denied.
//   verifyPeer(socket): optional async kernel-identity check (e.g. SO_PEERCRED read by a
//     trusted native shim, or a namespace/PID-domain probe). It must throw/return false to
//     deny. It is the only thing that may admit a peer when the domain is not attested.
export function peerAuthenticator({ domainConfinedByRuntime = false, verifyPeer } = {}) {
  if (verifyPeer !== undefined && typeof verifyPeer !== 'function') throw new GrantError('invalid-verify-peer');
  return async socket => {
    // A forwarded/inherited channel never carries the attempt's isolation; refuse any
    // peer the authenticator cannot positively tie to this attempt's domain.
    let ok = false;
    if (verifyPeer) {
      try { ok = (await verifyPeer(socket)) !== false; } catch { ok = false; }
    } else {
      ok = domainConfinedByRuntime === true;
    }
    if (!ok) throw new PeerDenied();
  };
}
