import { send } from './net.mjs';
process.once('message', async ({ actions }) => {
    const results = [];
    for (const a of actions) {
        const body = a.bodyB64 !== undefined ? Buffer.from(a.bodyB64, 'base64') : a.json ? Buffer.from(JSON.stringify(a.json)) : undefined;
        if (a.concurrent)
            results.push(await Promise.all(Array.from({ length: a.concurrent }, () => send({ ...a, body }))));
        else
            results.push(await send({ ...a, body }));
    }
    process.send({ results, pid: process.pid });
    process.disconnect();
});
