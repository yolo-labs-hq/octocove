import { deliverDue, WebhookDispatcher, type WebhookEnv } from '../src/webhooks';
import profile from './fixtures/webhook-load.json';
export class TestDispatcher extends WebhookDispatcher {
    constructor(state: DurableObjectState, private fixtureEnv: WebhookEnv) { super(state, fixtureEnv); }
    protected dispatch() {
        return deliverDue(this.fixtureEnv, {
            resolve: async () => ['93.184.216.34'],
            fetch: async (_url, init) => {
                await new Promise(resolve => setTimeout(resolve, profile.receiverLatencyMs));
                const body = JSON.parse(String(init.body));
                await this.fixtureEnv.DB.prepare('INSERT INTO fixture_receipts(event_id,lag_ms) VALUES(?,?)')
                    .bind(body.id, Date.now() - Date.parse(body.occurredAt)).run();
                return new Response(null, { status: 204 });
            },
        });
    }
}
export default { async fetch(_request: Request, env: {
        DISPATCH: DurableObjectNamespace;
    }) {
        return env.DISPATCH.get(env.DISPATCH.idFromName('octocove')).fetch('https://delivery.internal/arm');
    } };
