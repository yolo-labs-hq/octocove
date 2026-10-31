// Re-delegation onto a live claim: the re-arm and switch journeys, the plan helper, the runner session and its
// journal, against the testing module's fake server; and the bound transport refusing both steps.
import {
  ApiError,
  bearer,
  bound,
  BoundTransportError,
  clientRedelegation,
  createClient,
  journeys,
  MAX_JOURNEY_REPLAYS,
  MAX_RESENDS,
  memoryCredentialStore,
  memoryRedelegationJournal,
  PROBLEM_CODES,
  redelegationPlan,
  runnerSession,
  TransportError,
  type AgentDelegation,
  type CredentialStore,
  type RedelegationEntry,
  type RedelegationJournal,
} from '../../src/index.js';
import { fakeServer, problem, type FakeServer } from '../../src/testing.js';
import { equal, json, ok, rejects, scriptedFetch, test, type Case } from '../harness.js';

const ORG = 'org_00000000-0000-4000-8000-000000000001';
const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-10-31T00:00:00Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
/** Lost answers enough to end one step with an unknown outcome: every transport resend of every journey replay. */
const LOST = Array.from({ length: (MAX_RESENDS + 1) * (MAX_JOURNEY_REPLAYS + 1) }, () => 'lost-answer' as const);
const opts = (extra: Record<string, unknown> = {}) => ({ deadline: Date.now() + 60_000, sleep: async () => {}, ...extra });

/** A fake with a live claim near its ceiling, the human authorizer's journeys and the agent's credential record. */
function world(o: { ceilingInMs?: number; capInMs?: number } = {}) {
  const server = fakeServer();
  const { claim, delegation } = server.claim('T1', { ceilingInMs: o.ceilingInMs ?? 5 * MIN, capInMs: o.capInMs });
  const session = server.issue({ kind: 'session', principalId: 'human-1', expiresInMs: 24 * HOUR });
  const human = journeys(createClient({ baseUrl: server.baseUrl, transport: bearer({ token: session.token }), fetch: server.fetch, retryDelayMs: () => 1 })).org(ORG);
  const credential: AgentDelegation = { kind: 'agent-delegation', token: delegation.token, delegationId: claim.delegationId, revocationId: 'rev-0',
    expiresAt: new Date(delegation.expiresAt).toISOString(), ceilingAt: new Date(claim.ceilingAt).toISOString(), claimExpiresAt: new Date(claim.claimExpiresAt).toISOString() };
  const store = memoryCredentialStore<AgentDelegation>(credential);
  const journal = memoryRedelegationJournal();
  const target = { taskId: 'T1', claimAttemptId: claim.claimAttemptId, agentId: claim.agentId, verbs: claim.verbs, intentVersion: 3 };
  return { server, claim, human, credential, store, journal, target };
}

type World = ReturnType<typeof world>;
const sessionOf = (w: World, extra: { journal?: RedelegationJournal; store?: CredentialStore<AgentDelegation> } = {}) =>
  runnerSession<AgentDelegation>({ claim: w.target, store: extra.store ?? w.store, journal: extra.journal ?? w.journal, redelegate: clientRedelegation(w.human) });
const keysOf = (server: FakeServer, operationId: 'claimAuthorize' | 'taskClaim') => server.requests.filter((r) => r.operationId === operationId).map((r) => r.idempotencyKey);
/** The agent's view: a call with its token. */
const agentCall = (w: World, token: string) => createClient({ baseUrl: w.server.baseUrl, transport: bearer({ token, kind: 'delegation' }), fetch: w.server.fetch })
  .call('meGet', {}).then(() => 'ok', (error: unknown) => (error instanceof ApiError ? error.code : String(error)));

export const redelegationCases: Case[] = [
  // ---- the plan ----
  test('redelegationPlan: renew inside the ceiling, re-delegate ahead of it while it is before the cap, cap-reached at the cap', () => {
    const c = { expiresAt: at(15 * MIN), ceilingAt: at(8 * HOUR), claimExpiresAt: at(72 * HOUR) };
    const o = { renewAheadMs: MIN, redelegateAheadMs: 10 * MIN };
    equal(redelegationPlan(c, T0, o), { action: 'none', at: T0 + 14 * MIN });
    equal(redelegationPlan(c, T0 + 14 * MIN - 1, o), { action: 'none', at: T0 + 14 * MIN });
    equal(redelegationPlan(c, T0 + 14 * MIN, o), { action: 'renew', at: T0 + 14 * MIN }, 'due exactly at the margin');
    // A token whose expiry is the ceiling cannot be renewed further: nothing until the re-delegation edge.
    const last = { ...c, expiresAt: at(8 * HOUR) };
    equal(redelegationPlan(last, T0 + 7 * HOUR, o), { action: 'none', at: T0 + 8 * HOUR - 10 * MIN });
    equal(redelegationPlan(last, T0 + 8 * HOUR - 10 * MIN - 1, o).action, 'none');
    equal(redelegationPlan(last, T0 + 8 * HOUR - 10 * MIN, o), { action: 'redelegate', at: T0 + 8 * HOUR - 10 * MIN });
    // Both due: the re-delegation wins (its switch issues a new token too).
    const both = { ...c, expiresAt: at(8 * HOUR - 9 * MIN) };
    equal(redelegationPlan(both, T0 + 8 * HOUR - 9 * MIN, o).action, 'redelegate');
    // The ceiling at the cap: nothing extends it.
    const capped = { expiresAt: at(72 * HOUR), ceilingAt: at(72 * HOUR), claimExpiresAt: at(72 * HOUR) };
    equal(redelegationPlan(capped, T0 + 72 * HOUR - 11 * MIN, o).action, 'none');
    equal(redelegationPlan(capped, T0 + 72 * HOUR - 10 * MIN, o), { action: 'cap-reached', at: T0 + 72 * HOUR });
    // A re-delegation must gain at least the bootstrap's five minutes plus the margin before the cap.
    const near = (gain: number) => redelegationPlan({ ...capped, ceilingAt: T0 + 72 * HOUR - gain }, T0 + 72 * HOUR - gain - 10 * MIN, o).action;
    equal([near(15 * MIN), near(15 * MIN - 1), near(1)], ['redelegate', 'cap-reached', 'cap-reached']);
    // Past the ceiling: expired, whatever the cap.
    equal(redelegationPlan(last, T0 + 8 * HOUR, o), { action: 'expired', at: T0 + 8 * HOUR });
    equal(redelegationPlan(capped, T0 + 73 * HOUR, o), { action: 'expired', at: T0 + 72 * HOUR });
    // Unknown cap: the server decides; unknown ceiling: renewal only.
    equal(redelegationPlan({ ...last, claimExpiresAt: null }, T0 + 8 * HOUR - 5 * MIN, o).action, 'redelegate');
    equal(redelegationPlan({ expiresAt: T0 + 15 * MIN }, T0 + 20 * HOUR, o), { action: 'renew', at: T0 + 14 * MIN });
    // Defaults: 60 s and 10 min.
    equal(redelegationPlan(c, T0 + 14 * MIN), { action: 'renew', at: T0 + 14 * MIN });
    equal(redelegationPlan(last, T0 + 8 * HOUR - 10 * MIN).action, 'redelegate');
    for (const bad of [() => redelegationPlan({ expiresAt: 'soon' }, T0), () => redelegationPlan(c, NaN), () => redelegationPlan(c, T0, { renewAheadMs: -1 }), () => redelegationPlan(c, T0, { redelegateAheadMs: 8 * HOUR })]) {
      let threw = false;
      try { bad(); } catch (error) { threw = error instanceof TypeError; }
      ok(threw, 'invalid input is a TypeError');
    }
  }),
  test('the re-delegation codes are classified: retryable conflicts, terminal cap and ceiling refusals, reauth for a stale sign-in', () => {
    const of = (code: string, status: number, details?: unknown) => new ApiError({ status, code, details });
    const view = (e: ApiError) => [e.disposition, e.outcome, e.endsAttempt, e.endsAuthority];
    equal(view(of('switch-conflict', 409, { retryable: true })), ['retryable', 'refused', false, false]);
    equal(view(of('switch-conflict', 409)), ['retryable', 'refused', false, false], 'retryable even without the flag');
    equal(view(of('redelegation-pending', 409)), ['retryable', 'refused', false, false]);
    equal(view(of('claim-cap-reached', 409)), ['terminal', 'refused', false, false]);
    equal(view(of('ceiling-not-extended', 409)), ['terminal', 'refused', false, false]);
    equal(view(of('reauth-required', 403)), ['reauth', 'refused', false, false]);
    equal(view(of('human-required', 403)), ['terminal', 'refused', false, false]);
    equal(view(of('claim-inactive', 409)), ['terminal', 'refused', true, false]);
    for (const code of ['claim-cap-reached', 'ceiling-not-extended', 'redelegation-pending', 'switch-conflict']) ok(PROBLEM_CODES[code]?.area === 'claim', code);
  }),

  // ---- the journeys ----
  test('re-arm then switch: the same delegation, a new ceiling, the old token refused, the claim moved; the list shows ceiling, cap and count', async () => {
    const w = world();
    const before = w.claim.ceilingAt;
    const expiresAt = new Date(Date.now() + 8 * HOUR).toISOString();
    const armed = await w.human.claims.rearm('T1', { claimAttemptId: w.target.claimAttemptId, agentId: w.target.agentId, verbs: ['tasks:read'], expiresAt }, opts());
    equal([armed.kind, armed.claimAttemptId, armed.delegationId, armed.redelegations, armed.claimExpiresAt, armed.verbs],
      ['claim-bootstrap', w.target.claimAttemptId, w.claim.delegationId, 1, new Date(w.claim.claimExpiresAt).toISOString(), ['tasks:read']]);
    ok(Date.parse(armed.authorizationExpiresAt) > before, 'a later ceiling is armed');
    equal(await agentCall(w, w.credential.token), 'ok', 'nothing changes for the running token before the switch');
    const next = await w.human.claims.switch('T1', { bootstrapToken: armed.token, intentVersion: 3 }, opts());
    equal([next.kind, next.delegationId, next.ceilingAt, next.claimExpiresAt], ['agent-delegation', w.claim.delegationId, armed.authorizationExpiresAt, armed.claimExpiresAt]);
    ok(Date.parse(next.expiresAt) <= Date.parse(next.ceilingAt!));
    equal([await agentCall(w, w.credential.token), await agentCall(w, next.token)], ['credential-revoked', 'ok']);
    equal([w.claim.ceilingAt, w.claim.redelegations, w.claim.verbs], [Date.parse(armed.authorizationExpiresAt), 1, ['tasks:read']]);
    const page = await journeys(createClient({ baseUrl: w.server.baseUrl, transport: bearer({ token: w.server.issue({ kind: 'session' }).token }), fetch: w.server.fetch })).auth.delegations.list(opts());
    equal(page.items.map((i) => [i.id, i.ceilingAt, i.claimExpiresAt, i.redelegations]), [[w.claim.delegationId, armed.authorizationExpiresAt, armed.claimExpiresAt, 1]]);
  }),
  test('a renewal keeps the ceiling and the cap; only the switch moves the ceiling', async () => {
    const w = world({ ceilingInMs: 2 * HOUR });
    const agent = journeys(createClient({ baseUrl: w.server.baseUrl, transport: bearer({ token: w.credential.token, kind: 'delegation' }), fetch: w.server.fetch })).org(ORG);
    const renewed = await agent.auth.delegation.renew(w.credential, opts());
    equal([renewed.ceilingAt, renewed.claimExpiresAt], [w.credential.ceilingAt, w.credential.claimExpiresAt]);
    ok(renewed.token !== w.credential.token);
  }),
  test('switch-conflict is retryable: the retry with the same bootstrap and key switches once', async () => {
    const w = world();
    w.server.fail('taskClaim', problem(409, 'switch-conflict', { details: { retryable: true } }));
    const armed = await w.human.claims.rearm('T1', { ...w.target, verbs: [...w.target.verbs] as never, expiresAt: new Date(Date.now() + 8 * HOUR).toISOString() }, opts());
    const key = 'switch-key-fixture-0001';
    const error = await rejects(() => w.human.claims.switch('T1', { bootstrapToken: armed.token, intentVersion: 3 }, opts({ idempotencyKey: key })), ApiError);
    equal([error.code, error.disposition, error.outcome], ['switch-conflict', 'retryable', 'refused']);
    const next = await w.human.claims.switch('T1', { bootstrapToken: armed.token, intentVersion: 3 }, opts({ idempotencyKey: key }));
    equal([w.claim.redelegations, w.claim.token], [1, next.token]);
    equal(keysOf(w.server, 'taskClaim'), [key, key]);
    // Another key on the redeemed bootstrap is refused, never a second switch.
    const other = await rejects(() => w.human.claims.switch('T1', { bootstrapToken: armed.token, intentVersion: 3 }, opts({ idempotencyKey: 'another-key-fixture' })), ApiError);
    equal(other.code, 'bootstrap-consumed');
    equal(w.claim.token, next.token);
  }),
  test('a lost answer on either step is recovered under the same key: the same bootstrap, the same credential', async () => {
    const w = world();
    w.server.fail('claimAuthorize', 'lost-answer');
    w.server.fail('taskClaim', 'lost-answer');
    const armed = await w.human.claims.rearm('T1', { ...w.target, verbs: [...w.target.verbs] as never, expiresAt: new Date(Date.now() + 8 * HOUR).toISOString() }, opts());
    equal(armed.token, w.claim.rearm!.bootstrap, 'the replay answered the one bootstrap issued');
    const next = await w.human.claims.switch('T1', { bootstrapToken: armed.token, intentVersion: 3 }, opts());
    equal([next.token, w.claim.redelegations], [w.claim.token, 1], 'one switch');
    const [a, b] = keysOf(w.server, 'claimAuthorize');
    ok(a === b && keysOf(w.server, 'claimAuthorize').length === 2);
    equal(new Set(keysOf(w.server, 'taskClaim')).size, 1);
  }),
  test('re-arm refusals: the cap is spent, a stale sign-in, another human, an agent token, a past expiresAt, a pending re-arm', async () => {
    const capped = world({ ceilingInMs: 5 * MIN, capInMs: 5 * MIN });
    const input = (w: World, extra = {}) => ({ ...w.target, verbs: [...w.target.verbs] as never, expiresAt: new Date(Date.now() + 8 * HOUR).toISOString(), ...extra });
    const cap = await rejects(() => capped.human.claims.rearm('T1', input(capped), opts()), ApiError);
    equal([cap.status, cap.code, cap.disposition], [409, 'claim-cap-reached', 'terminal']);
    const w = world();
    w.server.fail('claimAuthorize', problem(403, 'reauth-required'));
    const stale = await rejects(() => w.human.claims.rearm('T1', input(w), opts()), ApiError);
    equal([stale.status, stale.code, stale.disposition], [403, 'reauth-required', 'reauth']);
    const other = journeys(createClient({ baseUrl: w.server.baseUrl, transport: bearer({ token: w.server.issue({ kind: 'session', principalId: 'human-2' }).token }), fetch: w.server.fetch })).org(ORG);
    equal((await rejects(() => other.claims.rearm('T1', input(w), opts()), ApiError)).code, 'forbidden');
    const agent = journeys(createClient({ baseUrl: w.server.baseUrl, transport: bearer({ token: w.credential.token, kind: 'delegation' }), fetch: w.server.fetch })).org(ORG);
    await rejects(() => agent.claims.rearm('T1', input(w), opts()), TypeError, 'an agent delegation is refused before sending');
    const past = await rejects(() => w.human.claims.rearm('T1', input(w, { expiresAt: new Date(Date.now() - MIN).toISOString() }), opts()), ApiError);
    equal([past.code, (past.details as { field?: string }).field], ['invalid-request', 'expiresAt']);
    await w.human.claims.rearm('T1', input(w), opts());
    const pending = await rejects(() => w.human.claims.rearm('T1', input(w), opts()), ApiError);
    equal([pending.code, pending.disposition, typeof (pending.details as { bootstrapExpiresAt?: string }).bootstrapExpiresAt], ['redelegation-pending', 'retryable', 'string']);
  }),

  // ---- the session ----
  test('session: nothing due, then a renewal inside the ceiling, then a re-delegation; one re-arm and one switch', async () => {
    const w = world({ ceilingInMs: 2 * HOUR });
    let now = Date.now();
    let renewals = 0;
    const session = runnerSession<AgentDelegation>({
      claim: w.target, store: w.store, journal: w.journal, redelegate: clientRedelegation(w.human), now: () => now,
      renew: async (current, context) => {
        renewals++;
        const agent = journeys(createClient({ baseUrl: w.server.baseUrl, transport: bearer({ token: current.token, kind: 'delegation' }), fetch: w.server.fetch })).org(ORG);
        return agent.auth.delegation.renew(current, opts({ idempotencyKey: context.idempotencyKey }));
      },
    });
    const first = await session.step();
    equal(first.action, 'none');
    now = Date.parse(w.credential.expiresAt) - 30_000;
    const renewed = await session.step();
    equal([renewed.action, renewals, w.store.current!.ceilingAt], ['renewed', 1, w.credential.ceilingAt]);
    now = Date.parse(w.credential.ceilingAt!) - 5 * MIN;
    const moved = await session.step();
    if (moved.action !== 'redelegated') throw new Error(`expected redelegated, got ${moved.action}`);
    equal([moved.redelegations, w.store.current!.token, w.server.count('claimAuthorize'), w.server.count('taskClaim')], [1, w.claim.token, 1, 1]);
    ok(Date.parse(w.store.current!.ceilingAt!) > Date.parse(w.credential.ceilingAt!));
    equal(await session.pending(), undefined, 'the entry is dropped once the credential is stored');
  }),
  test('session: switch-conflict and lost answers keep the entry; the next steps resend the same keys and switch once', async () => {
    const w = world();
    w.server.fail('claimAuthorize', ...LOST);
    w.server.fail('taskClaim', problem(409, 'switch-conflict', { details: { retryable: true } }), ...LOST);
    const session = sessionOf(w);
    const one = await session.step();
    equal([one.action, one.action === 'kept' && one.step, one.action === 'kept' && one.outcome], ['kept', 'rearm', 'unknown'], 'every answer lost: unknown, kept');
    ok(one.action === 'kept' && one.error instanceof TransportError);
    const two = await session.step();
    equal([two.action, two.action === 'kept' && two.step, two.action === 'kept' && two.outcome], ['kept', 'switch', 'refused'], 'the re-arm replayed, then switch-conflict');
    const three = await session.step();
    equal([three.action, three.action === 'kept' && three.outcome], ['kept', 'unknown'], 'the switch applied, its answers lost');
    const four = await session.step();
    equal(four.action, 'redelegated');
    equal(new Set(keysOf(w.server, 'claimAuthorize')).size, 1, 'one re-arm key');
    equal(new Set(keysOf(w.server, 'taskClaim')).size, 1, 'one switch key');
    equal([w.claim.redelegations, w.store.current!.token], [1, w.claim.token], 'one switch, its credential stored');
    equal(await agentCall(w, w.store.current!.token), 'ok');
  }),
  test('session: a crash between the re-arm and the switch resumes with the journaled bootstrap and key, never re-arming', async () => {
    const w = world();
    let crash = true;
    const crashing: RedelegationJournal = {
      get: (id) => w.journal.get(id),
      delete: (id) => w.journal.delete(id),
      async put(entry: RedelegationEntry) {
        await w.journal.put(entry);
        if (crash && entry.step === 'switch') { crash = false; throw new Error('process died'); }
      },
    };
    await rejects(() => sessionOf(w, { journal: crashing }).step(), Error);
    const entry = await w.journal.get(`T1:${w.target.claimAttemptId}`);
    equal([entry?.step, entry?.bootstrap?.token, w.server.count('taskClaim')], ['switch', w.claim.rearm!.bootstrap, 0]);
    const resumed = await sessionOf(w).step();
    equal([resumed.action, w.server.count('claimAuthorize'), w.server.count('taskClaim'), keysOf(w.server, 'taskClaim')[0]], ['redelegated', 1, 1, entry!.switchKey]);
  }),
  test('session: a crash after the switch answered, before the credential was stored, replays the same credential', async () => {
    const w = world();
    let fail = true;
    const store: CredentialStore<AgentDelegation> = {
      load: (c) => w.store.load(c), save: (r, c) => w.store.save(r, c),
      async compareAndSet(expected, next, c) { if (fail) { fail = false; throw new Error('process died'); } return w.store.compareAndSet(expected, next, c); },
    };
    await rejects(() => sessionOf(w, { store }).step(), Error);
    const switched = w.claim.token;
    const resumed = await sessionOf(w).step();
    equal([resumed.action, w.store.current!.token, w.claim.redelegations, w.server.count('taskClaim')], ['redelegated', switched, 1, 2]);
    equal(new Set(keysOf(w.server, 'taskClaim')).size, 1);
  }),
  test('session: the cap is reached without a call; a forced re-delegation is refused and kept as a record', async () => {
    const w = world({ ceilingInMs: 5 * MIN, capInMs: 5 * MIN });
    const session = sessionOf(w);
    const step = await session.step();
    equal([step.action, step.action === 'cap-reached' && step.at], ['cap-reached', w.claim.ceilingAt]);
    equal(w.server.requests.length, 0);
    const forced = await session.step({ redelegate: true });
    equal([forced.action, forced.action === 'refused' && forced.refusal.code], ['refused', 'claim-cap-reached']);
    const again = await session.step({ redelegate: true });
    equal([again.action, w.server.count('claimAuthorize')], ['refused', 1], 'a refused entry is never resent');
  }),
  test('session: reauth-required is refused and kept until discarded; then a fresh re-arm under a new key', async () => {
    const w = world();
    w.server.fail('claimAuthorize', problem(403, 'reauth-required'));
    const session = sessionOf(w);
    const refused = await session.step();
    equal([refused.action, refused.action === 'refused' && refused.refusal.disposition, refused.action === 'refused' && refused.refusal.code], ['refused', 'reauth', 'reauth-required']);
    equal((await session.step()).action, 'refused');
    equal(w.server.count('claimAuthorize'), 1);
    await session.discard();
    equal((await session.step()).action, 'redelegated');
    const keys = keysOf(w.server, 'claimAuthorize');
    ok(keys.length === 2 && keys[0] !== keys[1], 'a new key after a refusal');
  }),
  test('session: a switch whose credential stopped authenticating restarts with a recovery re-arm', async () => {
    const w = world();
    w.server.fail('taskClaim', ...LOST);
    const session = sessionOf(w);
    equal((await session.step()).action, 'kept');
    w.server.expire(w.claim.token);
    const restarted = await session.step();
    equal([restarted.action, restarted.action === 'restart' && restarted.step], ['restart', 'switch']);
    equal((await session.step()).action, 'redelegated');
    equal([w.claim.redelegations, w.store.current!.token], [2, w.claim.token]);
    equal(await agentCall(w, w.store.current!.token), 'ok');
  }),

  test('an answer without ceilingAt and claimExpiresAt is adopted, never refused: renew, first claim and switch carry them over', async () => {
    const bare = { accessToken: 'bare-replacement-0123456789', delegationId: 'del-1', revocationId: 'rev-1', tokenType: 'Bearer', expiresAt: at(15 * MIN) };
    const human = (fetch: Parameters<typeof createClient>[0]['fetch'], token = 'session-fixture-0123456789') =>
      journeys(createClient({ baseUrl: 'https://cp.test', transport: bearer({ token }), fetch, retryDelayMs: () => 1 })).org(ORG);
    const renewed = await human(scriptedFetch(json(200, bare)).fetch, 'delegation-fixture-0123').auth.delegation.renew(
      { token: 'delegation-fixture-0123', delegationId: 'del-1', ceilingAt: at(8 * HOUR), claimExpiresAt: at(72 * HOUR) }, opts());
    equal([renewed.token, renewed.ceilingAt, renewed.claimExpiresAt], [bare.accessToken, at(8 * HOUR), at(72 * HOUR)], 'a renewal never moves them');
    const bootstrap = { kind: 'claim-bootstrap' as const, token: 'bootstrap-fixture-0123', authorizationId: 'a', projectId: 'p', taskId: 'T1', claimAttemptId: 'cla_1',
      delegationId: 'del-1', expiresAt: at(5 * MIN), authorizationExpiresAt: at(8 * HOUR), verbs: ['tasks:read'] };
    const first = await human(scriptedFetch(json(201, { claim: { id: 'cla_1', taskId: 'T1', expiresAt: at(8 * HOUR) }, delegation: bare })).fetch)
      .claims.claim(bootstrap, 'T1', { intentVersion: 3 }, opts());
    equal([first.delegation.token, first.delegation.ceilingAt, first.delegation.claimExpiresAt], [bare.accessToken, at(8 * HOUR), undefined], 'a first claim\'s expiry is its ceiling');
    const switched = await human(scriptedFetch(json(200, { claim: { id: 'cla_1', taskId: 'T1', expiresAt: at(16 * HOUR) }, delegation: bare })).fetch)
      .claims.switch('T1', { bootstrapToken: 'bootstrap-fixture-0123', intentVersion: 3, claimAttemptId: 'cla_1', delegationId: 'del-1' }, opts());
    equal([switched.token, switched.ceilingAt], [bare.accessToken, at(16 * HOUR)], 'a switch moves the claim\'s expiry to the new ceiling');
    // The session stores a field-less switch with the armed ceiling and the cap, once.
    const w = world();
    const real = clientRedelegation(w.human);
    const session = runnerSession<AgentDelegation>({ claim: w.target, store: w.store, journal: w.journal, redelegate: {
      rearm: real.rearm,
      switch: async (request, context) => { const { ceilingAt: _c, claimExpiresAt: _k, ...rest } = await real.switch(request, context); return rest as AgentDelegation; },
    } });
    const step = await session.step();
    equal([step.action, w.store.current!.token, w.store.current!.ceilingAt, w.store.current!.claimExpiresAt],
      ['redelegated', w.claim.token, new Date(w.claim.ceilingAt).toISOString(), w.credential.claimExpiresAt]);
    equal(w.server.count('taskClaim'), 1, 'never replayed in a loop');
  }),
  test('a switch answer for another claim or delegation is refused before its token is used, and never resent', async () => {
    const answer = (claimId: string, delegationId: string) => json(200, { claim: { id: claimId, taskId: 'T1', expiresAt: at(16 * HOUR) },
      delegation: { accessToken: 'other-delegation-fixture-0123', delegationId, revocationId: 'r', tokenType: 'Bearer', expiresAt: at(15 * MIN) } });
    for (const [claimId, delegationId] of [['cla_2', 'del-1'], ['cla_1', 'del-2']] as const) {
      const j = journeys(createClient({ baseUrl: 'https://cp.test', transport: bearer({ token: 'session-fixture-0123456789' }), fetch: scriptedFetch(answer(claimId, delegationId)).fetch })).org(ORG);
      const error = await rejects(() => j.claims.switch('T1', { bootstrapToken: 'bootstrap-fixture-0123', intentVersion: 3, claimAttemptId: 'cla_1', delegationId: 'del-1' }, opts()), ApiError);
      ok(error.incomplete && !error.message.includes('other-delegation-fixture'), `${claimId} ${delegationId}`);
    }
    const w = world();
    const real = clientRedelegation(w.human);
    let switches = 0;
    const session = runnerSession<AgentDelegation>({ claim: w.target, store: w.store, journal: w.journal, redelegate: {
      rearm: real.rearm,
      switch: async () => { switches++; throw new ApiError({ status: 200, code: 'http-200', incomplete: true, detail: 'the switch answered for another claim' }); },
    } });
    equal((await session.step()).action, 'refused');
    equal((await session.step()).action, 'refused');
    equal([switches, w.store.current!.token], [1, w.credential.token]);
  }),
  test('session: the re-arm and the switch run inside the store\'s lock, and the switch body keeps the journaled intent version', async () => {
    const w = world();
    let held = false;
    const seen: boolean[] = [];
    const store: CredentialStore<AgentDelegation> = {
      load: (c) => w.store.load(c), save: (r, c) => w.store.save(r, c), compareAndSet: (e, n, c) => w.store.compareAndSet(e, n, c),
      async lock(work) { held = true; try { return await work(undefined); } finally { held = false; } },
    };
    const real = clientRedelegation(w.human);
    const session = runnerSession<AgentDelegation>({ claim: w.target, store, journal: w.journal, redelegate: {
      rearm: (r, c) => { seen.push(held); return real.rearm(r, c); },
      switch: (r, c) => { seen.push(held); return real.switch(r, c); },
    } });
    equal((await session.step()).action, 'redelegated');
    equal(seen, [true, true]);
    equal(w.server.requests.find((r) => r.operationId === 'taskClaim')!.body, { intentVersion: 3 });
    // An expired claim sends nothing.
    const gone = world({ ceilingInMs: 5 * MIN });
    const late = runnerSession<AgentDelegation>({ claim: gone.target, store: gone.store, journal: gone.journal, redelegate: clientRedelegation(gone.human), now: () => Date.now() + 6 * MIN });
    equal([(await late.step({ redelegate: true })).action, gone.server.requests.length], ['expired', 0]);
  }),

  // ---- the bound transport ----
  test('bound transport: the re-arm and the switch are refused before sending, by the journeys and by the client', async () => {
    const { fetch, calls } = scriptedFetch();
    const runner = journeys(createClient({ baseUrl: 'https://broker.test', transport: bound(), fetch })).org(ORG);
    const input = { claimAttemptId: 'cla_1', agentId: 'agent-1', verbs: ['tasks:read'] as never, expiresAt: new Date(Date.now() + HOUR).toISOString() };
    for (const [operationId, work] of [
      ['claimAuthorize', () => runner.claims.rearm('T1', input, opts())],
      ['taskClaim', () => runner.claims.switch('T1', { bootstrapToken: 'rearm-bootstrap-fixture-0123', intentVersion: 3 }, opts())],
      ['claimAuthorize', () => runner.client.call('claimAuthorize', { path: { id: 'T1' }, body: input })],
      ['taskClaim', () => runner.client.call('taskClaim', { path: { id: 'T1' }, body: { intentVersion: 1 } })],
    ] as const) {
      const error = await rejects(work, BoundTransportError, operationId);
      equal([error.operationId, error.outcome], [operationId, 'not-sent']);
    }
    let threw = false;
    try { clientRedelegation(runner); } catch (error) { threw = error instanceof TypeError; }
    ok(threw, 'a session is never built over a bound client');
    equal(calls.length, 0, 'nothing was sent');
  }),
];
