/* ==========================================================================
   Which Square we talk to, and who decides a credential is valid
   --------------------------------------------------------------------------
   The environment named in the secret is the only thing that chooses the
   host. Nothing here inspects what a token looks like.

   An earlier build did: it refused any token starting "EAAAl" in a production
   secret, on the theory that sandbox tokens are prefixed. Production tokens
   start "EAAA" as well, so it rejected a real production credential and
   blocked the deployment. Square's own authentication response is the
   authority on whether a credential works against a host, and these tests
   pin that down from both sides — a valid credential with an awkward-looking
   prefix must work, and a credential Square refuses must be reported as
   refused.
   ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fakeDynamo, fakeSquareFetch, squareHandlers, LOCATION, baseEnv, secretsFake
, warmCatalog } from './helpers.mjs';

const ORIGIN = 'https://bellmorewebdesign.github.io';

async function bootstrap({ env = {}, handlers, secrets, seed = false } = {}) {
  for (const [k, v] of Object.entries({ ...baseEnv(), ...env })) {
    if (v === null) delete process.env[k]; else process.env[k] = v;
  }
  const stamp = '?t=' + Math.random() + Math.random();
  const config = await import('../lib/config.mjs' + stamp);
  const square = await import('../lib/square.mjs' + stamp);
  const store = await import('../lib/store.mjs' + stamp);
  const ddb = fakeDynamo();
  const fetchImpl = fakeSquareFetch(handlers || squareHandlers());
  config.resetSecretCache();
  const { makeHandler } = await import('./harness.mjs' + stamp);
  const handler = await makeHandler({
    configMod: { ...config, loadSecrets: () => config.loadSecrets({ client: secrets || secretsFake() }) },
    squareMod: { ...square, createSquareClient: (cfg) => square.createSquareClient(cfg, { fetchImpl }) },
    storeMod: { ...store, createStore: (o) => store.createStore({ ...o, client: ddb.client }) },
    stamp
  });
  if (seed) await warmCatalog(handler);
  if (seed) await warmCatalog(handler);
  return { handler, ddb, calls: fetchImpl.calls, config, loadSecrets: (c) => config.loadSecrets({ client: c }) };
}

const ev = (method, path, { body, query, headers } = {}) => ({
  rawPath: '/default' + path,
  requestContext: { stage: 'default', http: { method }, requestId: 'r' },
  headers: { origin: ORIGIN, ...(headers || {}) },
  queryStringParameters: query || null,
  body: body === undefined ? undefined : JSON.stringify(body)
});
const J = r => JSON.parse(r.body);
const CONTACT = { firstName: 'Dav', lastName: 'Capo', email: 'dav@example.com', phone: '7185051038' };
const PICKUP = { type: 'pickup', contact: CONTACT };

const refuse = (status = 401) => () => ({
  status, json: { errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED', detail: 'This request could not be authorized.' }] }
});

/* ------------------------------------------------------------------------
   1. A prefix is not evidence
   ------------------------------------------------------------------------ */

const AMBIGUOUS = [
  ['EAAAl prefixed', 'EAAAlPRODUCTIONTOKENTHATISREAL'],
  ['EAAA prefixed', 'EAAAPRODUCTIONTOKENTHATISREAL'],
  ['containing the word sandbox', 'EAAAsandboxishlooking-but-real'],
  ['containing -sandbox-', 'EAAA-sandbox-shaped-but-real'],
  ['short and odd', 'EAAAl']
];

for (const [label, token] of AMBIGUOUS) {
  test('a production token ' + label + ' is accepted', async () => {
    const { handler, calls } = await bootstrap({
      secrets: secretsFake({ SQUARE_ACCESS_TOKEN: token, SQUARE_ENVIRONMENT: 'production' })
    });
    /* The Square call lives in the scheduled refresh now, not in a request. */
    const result = await handler({ task: 'refresh-catalog' });
    assert.equal(result.refreshed, true, 'the catalog must build: ' + JSON.stringify(result));
    assert.equal(calls[0].headers.Authorization, 'Bearer ' + token, 'and the token is used as given');

    const r = await handler(ev('GET', '/catalog'));
    assert.equal(r.statusCode, 200, 'and the shop serves it: ' + r.body);
  });
}

test('the host comes from SQUARE_ENVIRONMENT, never from the token', async () => {
  /* The same byte-identical token, two environments. The only thing that
     moves is the host — which is why a sandbox credential cannot reach
     production: it is sent to the production host and refused there. */
  const token = 'EAAAlTHESAMETOKENBOTHTIMES';

  const prod = await bootstrap({
    secrets: secretsFake({ SQUARE_ACCESS_TOKEN: token, SQUARE_ENVIRONMENT: 'production' })
  });
  await prod.handler({ task: 'refresh-catalog' });
  assert.equal(prod.calls[0].host, 'connect.squareup.com');

  const sand = await bootstrap({
    secrets: secretsFake({ SQUARE_ACCESS_TOKEN: token, SQUARE_ENVIRONMENT: 'sandbox' })
  });
  await sand.handler({ task: 'refresh-catalog' });
  assert.equal(sand.calls[0].host, 'connect.squareupsandbox.com');

  assert.equal(prod.calls[0].headers.Authorization, sand.calls[0].headers.Authorization,
    'the credential was not inspected or altered either time');
});

test('SQUARE_ENVIRONMENT is still validated strictly', async () => {
  for (const bad of ['Production', 'PRODUCTION', 'prod', 'live', '', null, undefined, 'sandbox ']) {
    const { handler } = await bootstrap({
      secrets: { send: async () => ({ SecretString: JSON.stringify({
        SQUARE_ACCESS_TOKEN: 'tok', SQUARE_LOCATION_ID: LOCATION,
        ...(bad === undefined ? {} : { SQUARE_ENVIRONMENT: bad })
      }) }) }
    });
    /* "sandbox " with a trailing space is trimmed and accepted; everything
       else is refused outright, on every entry point. */
    if (bad === 'sandbox ') {
      const built = await handler({ task: 'refresh-catalog' });
      assert.equal(built.refreshed, true, 'a trailing space is a paste artefact, not a new environment');
      assert.equal((await handler(ev('GET', '/catalog'))).statusCode, 200);
    } else {
      const r = await handler(ev('GET', '/catalog'));
      assert.equal(r.statusCode, 500, JSON.stringify(bad));
      assert.equal(J(r).error, 'CONFIG_ERROR');
      assert.match(J(r).message, /SQUARE_ENVIRONMENT must be/);
    }
  }
});

/* ------------------------------------------------------------------------
   2. Whitespace from a console paste
   ------------------------------------------------------------------------ */

test('a token pasted with whitespace still authenticates', async () => {
  const { handler, calls } = await bootstrap({
    secrets: secretsFake({ SQUARE_ACCESS_TOKEN: '  EAAAREALTOKEN\n', SQUARE_ENVIRONMENT: 'production' })
  });
  assert.equal((await handler({ task: 'refresh-catalog' })).refreshed, true);
  assert.equal(calls[0].headers.Authorization, 'Bearer EAAAREALTOKEN',
    'a stray newline in the header would read as a wrong token');
});

test('the location id is trimmed too', async () => {
  const { handler, calls } = await bootstrap({
    secrets: secretsFake({ SQUARE_LOCATION_ID: '  ' + LOCATION + '\n' })
  });
  assert.equal((await handler({ task: 'refresh-catalog' })).refreshed, true);
  const inventory = calls.find(c => c.path.includes('inventory'));
  assert.deepEqual(inventory.body.location_ids, [LOCATION],
    'an untrimmed location matches nothing and the whole shop looks empty');
});

test('a token that is only whitespace counts as missing', async () => {
  const { handler } = await bootstrap({
    secrets: secretsFake({ SQUARE_ACCESS_TOKEN: '   ' })
  });
  const r = await handler(ev('GET', '/catalog'));
  assert.equal(r.statusCode, 500);
  assert.match(J(r).message, /SQUARE_ACCESS_TOKEN is missing/);
});

test('the webhook key and admin key are trimmed as well', async () => {
  const { handler } = await bootstrap({
    secrets: secretsFake({ ADMIN_REFRESH_KEY: ' admin-test-key \n' })
  });
  const r = await handler(ev('GET', '/admin/catalog', { headers: { 'x-admin-key': 'admin-test-key' } }));
  assert.equal(r.statusCode, 200, 'a pasted newline must not lock the operator out: ' + r.body);
  /* And a wrong key still does. */
  assert.equal((await handler(ev('GET', '/admin/catalog', { headers: { 'x-admin-key': 'nope' } }))).statusCode, 403);
});

/* ------------------------------------------------------------------------
   3. Square's answer is what decides
   ------------------------------------------------------------------------ */

test('a credential Square refuses is reported as a credential problem', async () => {
  const { handler, calls } = await bootstrap({
    handlers: squareHandlers({ 'POST /v2/catalog/batch-retrieve': refuse(401) })
  });
  const r = await handler(ev('POST', '/checkout', {
    body: { attemptId: 'auth-check-001', lines: [{ variationId: 'VAR_TEE_L', quantity: 1 }], fulfillment: PICKUP }
  }));
  assert.equal(r.statusCode, 500, 'not a 401 passed through to the shopper');
  assert.equal(J(r).error, 'SQUARE_AUTH_FAILED');
  assert.match(J(r).message, /could not authenticate with Square/i);
  assert.match(J(r).message, /production/, 'and it names the environment to look at');
  assert.ok(!r.body.includes('TOP-SECRET'), 'never the token');

  assert.equal(calls.filter(c => c.path === '/v2/catalog/batch-retrieve').length, 1,
    'a refused credential is not worth retrying');
});

test('a refused credential fails the scheduled refresh without publishing', async () => {
  const { handler } = await bootstrap({
    handlers: squareHandlers({ 'GET /v2/catalog/list': refuse(401) })
  });
  const result = await handler({ task: 'refresh-catalog' });
  assert.equal(result.refreshed, false);
  assert.equal(result.reason, 'failed');
  assert.match(result.error, /credentials/i);
  assert.ok(!JSON.stringify(result).includes('TOP-SECRET'));
});

test('a 403 is treated the same way', async () => {
  const { handler } = await bootstrap({
    handlers: squareHandlers({ 'POST /v2/catalog/batch-retrieve': refuse(403) })
  });
  const r = await handler(ev('POST', '/checkout', {
    body: { attemptId: 'auth-check-403', lines: [{ variationId: 'VAR_TEE_L', quantity: 1 }], fulfillment: PICKUP }
  }));
  assert.equal(J(r).error, 'SQUARE_AUTH_FAILED');
});

test('a sandbox token sent to production is refused by Square, not by us', async () => {
  /* Nothing in the service looks at the token. It goes to the production
     host because the secret says production, and Square says no. */
  const { handler, calls } = await bootstrap({
    secrets: secretsFake({ SQUARE_ACCESS_TOKEN: 'EAAAl-a-real-sandbox-token', SQUARE_ENVIRONMENT: 'production' }),
    handlers: squareHandlers({ 'GET /v2/catalog/list': refuse(401) })
  });
  const result = await handler({ task: 'refresh-catalog' });
  assert.equal(result.refreshed, false, 'Square refused it, we did not');
  assert.equal(calls[0].host, 'connect.squareup.com', 'the call was made; we did not pre-judge it');
  assert.equal(calls.length, 1);
});

test('checkout refuses outright on an auth failure rather than saying "try again"', async () => {
  const { handler, calls } = await bootstrap({
    handlers: squareHandlers({ 'POST /v2/catalog/batch-retrieve': refuse(401) })
  });
  const r = await handler(ev('POST', '/checkout', {
    body: { attemptId: 'auth-fails-here', lines: [{ variationId: 'VAR_TEE_L', quantity: 1 }], fulfillment: PICKUP }
  }));
  assert.equal(J(r).error, 'SQUARE_AUTH_FAILED',
    'retrying cannot help, so the customer must not be told to');
  assert.equal(calls.filter(c => c.path.includes('payment-links')).length, 0, 'and nothing was ordered');
});

test('an ordinary Square rejection is still an ordinary Square rejection', async () => {
  const { handler } = await bootstrap({
    handlers: squareHandlers({
      'GET /v2/orders/*': () => ({ status: 400, json: { errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'BAD_REQUEST', detail: 'nope' }] } }),
      'POST /v2/online-checkout/payment-links': () => ({
        json: { payment_link: { id: 'PL1', order_id: 'ORDER1', url: 'https://square.link/u/a' } }
      })
    }), seed: true
  });
  const made = J(await handler(ev('POST', '/checkout', {
    body: { attemptId: 'ordinary-reject', lines: [{ variationId: 'VAR_TEE_L', quantity: 1 }], fulfillment: PICKUP }
  })));
  /* A 400 from Square is not an authentication problem: the order lookup
     fails, the page says so, and nothing claims a credential is wrong. */
  const r = await handler(ev('GET', '/order', { query: { t: made.statusToken } }));
  assert.equal(r.statusCode, 200);
  assert.equal(J(r).verified, false);
});

test('a 500 from Square is still retried', async () => {
  let tries = 0;
  const { handler } = await bootstrap({
    handlers: squareHandlers({
      'GET /v2/catalog/list': () => {
        tries++;
        return { status: 500, json: { errors: [{ code: 'INTERNAL_SERVER_ERROR' }] } };
      }
    })
  });
  await handler({ task: 'refresh-catalog' });
  assert.ok(tries > 1, 'a server error is worth another go, unlike a refused credential');
});
