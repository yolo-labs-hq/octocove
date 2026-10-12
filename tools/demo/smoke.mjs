import assert from 'node:assert/strict';
import { checked, readConfig, prerequisite } from './common.mjs';
import { login } from './login.mjs';
prerequisite();
const config = await readConfig();
assert.equal((await (await checked(`${config.api}/healthz`)).json()).ok, true);
const author = await login('author'), approver = await login('approver');
assert.notEqual(author.token, approver.token);
for (const [identity, session] of [['author', author], ['approver', approver]]) {
  // Membership is checked by a production record route, beyond just issuing a cookie.
  const response = await checked(`${session.apiUrl}/tasks?projectId=demo`, { headers: { Authorization: `Bearer ${session.token}` } });
  assert.equal(response.status, 200);
  // Audit cursors bind the server-authenticated principal, even with an empty log.
  const audit = await (await checked(`${session.apiUrl}/audit?projectId=demo&limit=1`, { headers: { Authorization: `Bearer ${session.token}` } })).json();
  const cursor = JSON.parse(Buffer.from(audit.nextCursor.split('.')[0], 'base64url').toString());
  assert.equal(JSON.parse(cursor.binding)[1], `${config.issuer}|${identity}`);
  console.log(`Health + OIDC/PKCE + CLI consent/exchange + seeded membership: ${identity}`);
}
