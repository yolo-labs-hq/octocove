import worker, { type Env } from '../src/index';
import { deliverDue, drainWebhookAlerts } from '../src/webhooks';
let clock = 0;
export default {
    async fetch(request: Request, env: Env & {
        RECEIVER: string;
    }, ctx: ExecutionContext) {
        const path = new URL(request.url).pathname;
        if (!path.startsWith('/__fixture/'))
            return worker.fetch(request, env, ctx);
        const options = await request.json() as {
            now?: number;
            addresses?: string[];
            gate?: boolean;
            realDeadline?: boolean;
        };
        if (options.now !== undefined)
            clock = options.now;
        if (path === '/__fixture/tick') {
            await deliverDue(env, {
                now: () => clock,
                random: () => 1,
                ...(options.realDeadline ? {} : { deadline: () => () => { } }),
                resolve: async (_host, signal) => {
                    if (options.gate)
                        await fetch(`${env.RECEIVER}/dns-gate`, { signal });
                    return options.addresses ?? ['93.184.216.34'];
                },
                fetch: async (url, init, address) => {
                    if (address !== '93.184.216.34')
                        throw new Error('unexpected-fixture-peer');
                    return fetch(`${env.RECEIVER}${new URL(url).pathname}`, init);
                },
            });
        }
        else if (path === '/__fixture/alerts') {
            await drainWebhookAlerts({ ...env, RECOVERY_ALERT_URL: 'https://operations.example/alerts',
                RECOVERY_ALERT_TOKEN: 'local-fixture' }, clock, (_url, init) => fetch(`${env.RECEIVER}/alerts`, init));
        }
        return Response.json({ now: clock });
    },
};
