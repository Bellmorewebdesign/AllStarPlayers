/* ==========================================================================
   Background refresh, and a storefront that never waits for one
   --------------------------------------------------------------------------
   Production has 844 products and 5,869 variations. Paging all of that out of
   Square takes minutes; API Gateway gives up at thirty seconds. So the rule
   these tests pin down is simple:

     a browsing request reads what the scheduled refresh published, and
     never, under any circumstance, builds a catalog itself.

   Plus everything that can go wrong around the handover: no snapshot yet,
   an old one, two refreshes at once, a refresh that fails, and a refresh
   killed halfway through writing.
   ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fakeDynamo, fakeSquareFetch, squareHandlers, LOCATION, baseEnv, secretsFake, catalogFixture
} from './helpers.mjs';

const ORIGIN = 'https://bellmorewebdesign.github.io';

async function bootstrap({ env = {}, handlers, ddb: shared } = {}) {
  for (const [k, v] of Object.entries({ ...baseEnv(), ...env })) {
    if (v === null) delete process.env[k]; else process.env[k] = v;
  }
  const stamp = '?t=' + Math.random() + Math.random();
  const config = await import('../lib/config.mjs' + stamp);
  const square = await import('../lib/square.mjs' + stamp);
  const store = await import('../lib/store.mjs' + stamp);
  const ddb = shared || fakeDynamo();
  const fetchImpl = fakeSquareFetch(handlers || squareHandlers());
  config.resetSecretCache();
  const { makeHandler } = await import('./harness.mjs' + stamp);
  const handler = await makeHandler({
    configMod: { ...config, loadSecrets: () => config.loadSecrets({ client: secretsFake() }) },
    squareMod: { ...square, createSquareClient: (cfg) => square.createSquareClient(cfg, { fetchImpl }) },
    storeMod: { ...store, createStore: (o) => store.createStore({ ...o, client: ddb.client }) },
    stamp
  });
  return { handler, ddb, calls: fetchImpl.calls };
}

const ev = (method, path, { body, query, headers } = {}) => ({
  rawPath: '/default' + path,
  requestContext: { stage: 'default', http: { method }, requestId: 'r' },
  headers: { origin: ORIGIN, ...(headers || {}) },
  queryStringParameters: query || null,
  body: body === undefined ? undefined : JSON.stringify(body)
});
const J = r => JSON.parse(r.body);
const ADMIN = { 'x-admin-key': 'admin-test-key' };
const CONTACT = { firstName: 'Dav', lastName: 'Capo', email: 'dav@example.com', phone: '7185051038' };
const PICKUP = { type: 'pickup', contact: CONTACT };
const refresh = (handler) => handler({ task: 'refresh-catalog' });
const catalogCalls = (calls) => calls.filter(c => c.path === '/v2/catalog/list').length;

/* ======================================================================
   1. Browsing never builds
   ====================================================================== */

test('a browsing request makes no Square catalog call at all', async () => {
  const { handler, calls } = await bootstrap();
  await refresh(handler);
  const afterBuild = catalogCalls(calls);

  for (let i = 0; i < 5; i++) await handler(ev('GET', '/catalog'));
  await handler(ev('POST', '/cart/validate', { body: { lines: [{ variationId: 'VAR_TEE_S', quantity: 1 }] } }));

  assert.equal(catalogCalls(calls), afterBuild,
    'browsing must read the published snapshot and nothing else');
});

test('an expired snapshot is still served, labelled as old', async () => {
  const { handler, ddb } = await bootstrap({ env: { CATALOG_TTL_SECONDS: '900' } });
  await refresh(handler);

  const fresh = J(await handler(ev('GET', '/catalog')));
  assert.equal(fresh.stale, false);
  assert.ok(fresh.ageSeconds >= 0);

  /* Two hours later, with no refresh having run, on a cold container. */
  const pointer = ddb.find('CATALOG#production').find(r => r.sk === 'CURRENT');
  pointer.builtAt = Date.now() - 2 * 3600 * 1000;
  const cold = await bootstrap({ ddb, env: { CATALOG_TTL_SECONDS: '900' } });

  const old = await cold.handler(ev('GET', '/catalog'));
  assert.equal(old.statusCode, 200, 'an old catalog beats no catalog');
  const b = J(old);
  assert.equal(b.stale, true, 'and it says so');
  assert.ok(b.ageSeconds > 7000, b.ageSeconds);
  assert.equal(b.total, 2, 'the products are all still there');
});

/* ======================================================================
   2. No snapshot yet
   ====================================================================== */

test('with no snapshot, browsing says so and asks to be retried', async () => {
  const { handler, calls } = await bootstrap();
  const r = await handler(ev('GET', '/catalog'));
  assert.equal(r.statusCode, 503);
  const b = J(r);
  assert.equal(b.error, 'CATALOG_WARMING');
  assert.match(b.message, /try again/i);
  assert.ok(b.retryAfterSeconds > 0, 'the storefront needs to know how long to wait');
  assert.equal(catalogCalls(calls), 0, 'and it did not try to build one inline');
});

test('the cart page gets the same answer rather than an empty cart', async () => {
  const { handler } = await bootstrap();
  const r = await handler(ev('POST', '/cart/validate', {
    body: { lines: [{ variationId: 'VAR_TEE_S', quantity: 1 }] }
  }));
  assert.equal(r.statusCode, 503);
  assert.equal(J(r).error, 'CATALOG_WARMING',
    'telling somebody their cart is empty because the cache is cold would be a lie');
});

test('once the refresh has run, the shop comes up', async () => {
  const { handler } = await bootstrap();
  assert.equal((await handler(ev('GET', '/catalog'))).statusCode, 503);
  const built = await refresh(handler);
  assert.equal(built.refreshed, true);
  assert.ok(built.buildId);
  const r = await handler(ev('GET', '/catalog'));
  assert.equal(r.statusCode, 200);
  assert.equal(J(r).buildId, built.buildId);
});

test('a pointer whose chunks are gone is reported as unavailable, not as an empty shop', async () => {
  const { handler, ddb } = await bootstrap();
  const built = await refresh(handler);
  for (const row of ddb.find('CATALOG#production#B' + built.buildId)) {
    ddb.rows.delete(row.pk + '\u0000' + row.sk);
  }
  const r = await handler(ev('GET', '/catalog'));
  assert.equal(r.statusCode, 503);
  assert.equal(J(r).error, 'CATALOG_UNAVAILABLE');
  assert.ok(J(r).retryAfterSeconds > 0);
});

/* ======================================================================
   3. Two refreshes at once
   ====================================================================== */

test('a second refresh standing on the first is skipped, not run twice', async () => {
  const ddb = fakeDynamo();
  const a = await bootstrap({ ddb });
  const b = await bootstrap({ ddb });

  const first = await refresh(a.handler);
  assert.equal(first.refreshed, true);

  /* The lease is released at the end, so a sequential second run is fine.
     What must not happen is two running at once. */
  const held = await a.handler({ task: 'refresh-catalog' });
  assert.equal(held.refreshed, true, 'the lease was released cleanly');

  /* Now hold the lease open and try again. */
  ddb.rows.set('CATALOG#production\u0000LOCK', {
    pk: 'CATALOG#production', sk: 'LOCK', holder: 'someone-else',
    startedAt: Date.now(), leaseUntil: Math.floor(Date.now() / 1000) + 600
  });
  const skipped = await refresh(b.handler);
  assert.equal(skipped.refreshed, false);
  assert.equal(skipped.reason, 'already_running');
  assert.equal(skipped.heldBy, 'someone-else');
});

test('two refreshes fired together produce one build, not two', async () => {
  const ddb = fakeDynamo({ delay: true });
  const a = await bootstrap({ ddb });
  const b = await bootstrap({ ddb });

  const [ra, rb] = await Promise.all([refresh(a.handler), refresh(b.handler)]);
  const built = [ra, rb].filter(r => r.refreshed);
  const skipped = [ra, rb].filter(r => !r.refreshed);
  assert.equal(built.length, 1, 'exactly one did the work: ' + JSON.stringify([ra, rb]));
  assert.equal(skipped[0].reason, 'already_running');

  /* And only one build's worth of chunks is left behind. */
  const builds = new Set(ddb.dump()
    .filter(r => String(r.pk).startsWith('CATALOG#production#B'))
    .map(r => r.pk));
  assert.equal(builds.size, 1, 'no orphan partition: ' + [...builds].join(', '));
});

test('a stale lease does not wedge the schedule forever', async () => {
  const { handler, ddb } = await bootstrap();
  ddb.rows.set('CATALOG#production\u0000LOCK', {
    pk: 'CATALOG#production', sk: 'LOCK', holder: 'a-container-that-died',
    startedAt: Date.now() - 3600000, leaseUntil: Math.floor(Date.now() / 1000) - 60
  });
  const r = await refresh(handler);
  assert.equal(r.refreshed, true, 'the lease had run out, so this one may proceed');
});

/* ======================================================================
   4. A refresh that fails
   ====================================================================== */

test('a failed refresh leaves the live catalog exactly as it was', async () => {
  let broken = false;
  const { handler, ddb } = await bootstrap({
    handlers: squareHandlers({
      'GET /v2/catalog/list': () => broken
        ? { status: 500, json: { errors: [{ code: 'INTERNAL_SERVER_ERROR' }] } }
        : { json: catalogFixture() }
    })
  });
  const good = await refresh(handler);
  const before = J(await handler(ev('GET', '/catalog')));

  broken = true;
  const bad = await refresh(handler);
  assert.equal(bad.refreshed, false);
  assert.equal(bad.reason, 'failed');

  const after = J(await handler(ev('GET', '/catalog')));
  assert.equal(after.buildId, good.buildId, 'the pointer never moved');
  assert.deepEqual(after.products.map(p => p.id), before.products.map(p => p.id));

  /* The failure is on the record for whoever looks. */
  const status = J(await handler(ev('GET', '/admin/catalog', { headers: ADMIN })));
  assert.ok(status.lastRefresh.lastError, status.lastRefresh);
  assert.equal(status.live.buildId, good.buildId);

  /* And the lease was let go, so the next scheduled run can try again. */
  assert.equal(ddb.find('CATALOG#production').some(r => r.sk === 'LOCK'), false);
  broken = false;
  assert.equal((await refresh(handler)).refreshed, true);
});

test('a catalog that comes back empty is refused rather than published', async () => {
  const { handler } = await bootstrap();
  const good = await refresh(handler);

  /* Square answering with nothing is far more likely to be a broken read
     than a shop that sold everything, and publishing it would empty the
     website. */
  const empty = await bootstrap({
    handlers: squareHandlers({ 'GET /v2/catalog/list': () => ({ json: { objects: [] } }) })
  });
  const r = await refresh(empty.handler);
  assert.equal(r.refreshed, false);
  assert.match(r.error, /no sellable products/i);
  assert.ok(good.buildId);
});

test('a refresh that throws still releases its lease', async () => {
  const { handler, ddb } = await bootstrap({
    handlers: squareHandlers({ 'GET /v2/catalog/list': () => ({ status: 500, json: { errors: [] } }) })
  });
  await refresh(handler);
  assert.equal(ddb.find('CATALOG#production').some(r => r.sk === 'LOCK'), false,
    'otherwise one bad run would stop every later one');
});

/* ======================================================================
   5. A refresh interrupted mid-write
   ====================================================================== */

test('a refresh killed while writing cannot replace the live catalog', async () => {
  const ddb = fakeDynamo();
  const { handler } = await bootstrap({ ddb });
  const good = await refresh(handler);
  const before = J(await handler(ev('GET', '/catalog')));

  /* The container dies between the last chunk and the pointer flip. */
  const killer = await bootstrap({
    ddb: fakeDynamo({ rows: ddb.rows, failOnce: { PutItemCommand: { pk: 'CATALOG#production', sk: 'CURRENT' } } })
  });
  const crashed = await refresh(killer.handler);
  assert.equal(crashed.refreshed, false, 'it did not get to publish');

  const after = await handler(ev('GET', '/catalog'));
  assert.equal(after.statusCode, 200, 'the shop is still up');
  assert.equal(J(after).buildId, good.buildId, 'on the build it already had');
  assert.deepEqual(J(after).products.map(p => p.id), before.products.map(p => p.id));
});

test('the orphan a crashed refresh left behind is swept up by the next one', async () => {
  const ddb = fakeDynamo();
  const { handler } = await bootstrap({ ddb });
  await refresh(handler);

  const killer = await bootstrap({
    ddb: fakeDynamo({ rows: ddb.rows, failOnce: { PutItemCommand: { pk: 'CATALOG#production', sk: 'CURRENT' } } })
  });
  await refresh(killer.handler);

  const partitionsBefore = new Set(ddb.dump()
    .filter(r => String(r.pk).startsWith('CATALOG#production#B')).map(r => r.pk));
  assert.ok(partitionsBefore.size >= 1);

  const next = await refresh(handler);
  assert.equal(next.refreshed, true);
  const partitionsAfter = new Set(ddb.dump()
    .filter(r => String(r.pk).startsWith('CATALOG#production#B')).map(r => r.pk));
  assert.equal(partitionsAfter.size, 1, 'only the live build is left: ' + [...partitionsAfter].join(', '));
  assert.ok([...partitionsAfter][0].endsWith(next.buildId));
});

/* ======================================================================
   6. Everything that must keep working regardless
   ====================================================================== */

test('checkout verifies against Square even with no snapshot at all', async () => {
  /* Checkout never reads the cache — it does its own live per-variation
     read — so a cold cache must not stop somebody buying. */
  const { handler, calls } = await bootstrap({
    handlers: squareHandlers({
      'POST /v2/online-checkout/payment-links': () => ({
        json: { payment_link: { id: 'PL1', order_id: 'ORDER1', url: 'https://square.link/u/a' } }
      })
    })
  });
  assert.equal((await handler(ev('GET', '/catalog'))).statusCode, 503, 'no snapshot');

  const r = await handler(ev('POST', '/checkout', {
    body: { attemptId: 'cold-cache-buy', lines: [{ variationId: 'VAR_TEE_L', quantity: 1 }], fulfillment: PICKUP }
  }));
  assert.equal(r.statusCode, 200, 'checkout does its own live read: ' + r.body);
  assert.ok(calls.some(c => c.path === '/v2/catalog/batch-retrieve'));
  assert.equal(catalogCalls(calls), 0, 'and still never pages the whole catalog');
});

test('stock holds and cleanup are untouched by the refresh change', async () => {
  const ddb = fakeDynamo();
  const { handler } = await bootstrap({
    ddb,
    handlers: squareHandlers({
      'POST /v2/online-checkout/payment-links': () => ({
        json: { payment_link: { id: 'PL2', order_id: 'ORDER2', url: 'https://square.link/u/b' } }
      })
    })
  });
  await refresh(handler);
  const r = await handler(ev('POST', '/checkout', {
    body: { attemptId: 'holds-still-work', lines: [{ variationId: 'VAR_HAT_A', quantity: 1 }], fulfillment: PICKUP }
  }));
  assert.equal(r.statusCode, 200, r.body);

  const heldRows = ddb.find('HOLD#VAR_HAT_A');
  assert.equal(heldRows[0].entries.length, 1, 'the hold was taken');
  assert.equal(ddb.find('SWEEP').length, 1, 'and cleanup was queued');

  /* And a refresh running over the top changes neither. */
  await refresh(handler);
  assert.equal(ddb.find('HOLD#VAR_HAT_A')[0].entries.length, 1);
  assert.equal(ddb.find('SWEEP').length, 1);
});

test('the refresh route asks for a rebuild instead of doing one', async () => {
  const { handler, calls } = await bootstrap();
  await refresh(handler);
  const before = catalogCalls(calls);

  const r = await handler(ev('POST', '/catalog/refresh', { headers: ADMIN }));
  assert.ok([202, 503].includes(r.statusCode), r.body);
  assert.equal(catalogCalls(calls), before,
    'it must answer at once, not page Square inside the request');
});

test('an unknown scheduled task is refused rather than ignored', async () => {
  const { handler } = await bootstrap();
  const r = await handler({ task: 'something-nobody-wrote' });
  assert.equal(r.error, 'UNKNOWN_TASK');
});

test('a DynamoDB failure taking the lease is reported, not thrown', async () => {
  const { handler } = await bootstrap({
    ddb: fakeDynamo({ failOnce: { PutItemCommand: { pk: 'CATALOG#production', sk: 'LOCK' } } })
  });
  /* A scheduled invocation that throws is a stack trace nobody reads. */
  const r = await refresh(handler);
  assert.equal(r.refreshed, false);
  assert.equal(r.reason, 'lock_failed');
});
