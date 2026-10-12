// Attacker process for the local acceptance harness: a separate OS process (its own process
// domain) that holds only what was stolen — a copied lease and, in some cases, a captured proof
// and request body — plus optionally its own enrolled client certificate and a different source
// address (127.0.0.2) standing in for another host. It never has the victim's channel key.
import { send } from './net.mjs';

process.once('message', async ({ actions }) => {
  const results = [];
  for (const a of actions) {
    const body = a.bodyB64 !== undefined ? Buffer.from(a.bodyB64, 'base64') : a.json ? Buffer.from(JSON.stringify(a.json)) : undefined;
    if (a.concurrent) results.push(await Promise.all(Array.from({ length: a.concurrent }, () => send({ ...a, body }))));
    else results.push(await send({ ...a, body }));
  }
  process.send({ results, pid: process.pid });
  process.disconnect();
});
