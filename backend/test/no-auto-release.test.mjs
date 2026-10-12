/* ==========================================================================
   Stock is never freed without proof
   --------------------------------------------------------------------------
   One rule, tested from every angle it can be broken from: a unit goes back
   on the website only when Square has confirmed the order behind it is paid
   or cancelled, or when a person has looked and said so.

   Not when a clock runs out. Not when DynamoDB's TTL sweeps a row. Not when
   our own code hits an error path. An unresolved hold stays held and gets
   flagged for somebody to deal with, because the alternative is selling a
   unit that a live payment link can still buy.
   ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fakeDynamo, fakeSquareFetch, squareHandlers, LOCATION, baseEnv, secretsFake, INVENTORY
, warmCatalog } from './helpers.mjs';
import { createStore } from '../lib/store.mjs';

const ORIGIN = 'https://bellmorewebdesign.github.io';
const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);

const mk = (opts) => {
  const d = fakeDynamo(opts);
  return { d, store: createStore({ tableName: 't', client: d.client }) };
};
const holdRow = (d, v) => d.find('HOLD#' + v)[0];

/* ------------------------------------------------------------------------
   1. The reviewer's reproduction
   ------------------------------------------------------------------------ */

test('an unresolved hold eight days old still holds the stock', async () => {
  const { d, store } = mk();
  await store.acquireHolds('abandoned-eight-days', [{ variationId: 'V1', quantity: 1 }],
    { availability: new Map([['V1', 1]]), holdSeconds: 900 });
  assert.equal(await store.heldQuantity('V1'), 1);

  /* Eight days later nothing has settled it: Square was never asked, or was
     asked and would not answer. The payment link is still out there. */
  holdRow(d, 'V1').entries.forEach(e => { e.expiresAt = nowSec() - 8 * DAY; });

  assert.equal(await store.heldQuantity('V1'), 1,
    'age is not evidence; the link may still be payable');
});

test('a hold a year old still holds the stock', async () => {
  const { d, store } = mk();
  await store.acquireHolds('ancient', [{ variationId: 'V1', quantity: 2 }],
    { availability: new Map([['V1', 2]]), holdSeconds: 900 });
  holdRow(d, 'V1').entries.forEach(e => { e.expiresAt = nowSec() - 365 * DAY; });
  assert.equal(await store.heldQuantity('V1'), 2, 'there is no age at which guessing becomes safe');
});

test('HOLD_BACKSTOP_SECONDS cannot be set to anything that frees stock', async () => {
  const saved = process.env.HOLD_BACKSTOP_SECONDS;
  process.env.HOLD_BACKSTOP_SECONDS = '1';           /* try to re-arm it */
  try {
    const { d, store } = mk();
    await store.acquireHolds('try-to-expire', [{ variationId: 'V1', quantity: 1 }],
      { availability: new Map([['V1', 1]]), holdSeconds: 1 });
    holdRow(d, 'V1').entries.forEach(e => { e.expiresAt = nowSec() - 3600; });
    assert.equal(await store.heldQuantity('V1'), 1,
      'no environment variable may switch automatic release back on');
  } finally {
    if (saved === undefined) delete process.env.HOLD_BACKSTOP_SECONDS;
    else process.env.HOLD_BACKSTOP_SECONDS = saved;
  }
});

/* ------------------------------------------------------------------------
   2. DynamoDB must not delete the evidence either
   ------------------------------------------------------------------------ */

test('a hold row carries no TTL while it still holds something', async () => {
  const { d, store } = mk();
  await store.acquireHolds('no-ttl-please', [{ variationId: 'V1', quantity: 1 }],
    { availability: new Map([['V1', 5]]), holdSeconds: 900 });
  const row = holdRow(d, 'V1');
  assert.equal(row.ttl, undefined,
    'a TTL on this row is DynamoDB quietly releasing the stock on a timer');
  assert.equal(row.entries.length, 1);
});

test('a hold row is only given a TTL once it is empty', async () => {
  const { d, store } = mk();
  await store.acquireHolds('tidy-up', [{ variationId: 'V1', quantity: 1 }],
    { availability: new Map([['V1', 5]]), holdSeconds: 900 });
  await store.releaseHolds('tidy-up', ['V1']);
  const row = holdRow(d, 'V1');
  assert.equal(row.entries.length, 0);
  assert.ok(Number(row.ttl) > nowSec(), 'an empty row may be tidied away');
});

test('a cleanup job carries no TTL while it is unresolved', async () => {
  const { d, store } = mk();
  await store.enqueueSweep({
    attemptId: 'keep-the-evidence', dueAt: nowSec() + 60,
    orderId: 'ORDER_1', paymentLinkId: 'PL_1', idemKey: 'k', variationIds: ['V1'], createdAt: Date.now()
  });
  const job = d.find('SWEEP')[0];
  assert.equal(job.ttl, undefined,
    'losing this row leaves a hold with nothing left to settle it');
});

test('a rescheduled job still carries no TTL', async () => {
  const { d, store } = mk();
  await store.enqueueSweep({
    attemptId: 'rescheduled', dueAt: nowSec() - 10,
    orderId: 'ORDER_1', paymentLinkId: 'PL_1', idemKey: 'k', variationIds: ['V1'], createdAt: Date.now()
  });
  const [job] = d.find('SWEEP');
  await store.rescheduleSweep(job, { dueAt: nowSec() + 3600, patch: { attempts: 4, stuck: true } });
  const after = d.find('SWEEP')[0];
  assert.equal(after.ttl, undefined);
  assert.equal(after.stuck, true);
  assert.equal(after.attempts, 4);
  assert.equal(d.find('SWEEP').length, 1, 'and it did not get duplicated');
});

/* ------------------------------------------------------------------------
   3. Stuck work has to be findable and resolvable by a person
   ------------------------------------------------------------------------ */

test('stuck jobs can be listed', async () => {
  const { d, store } = mk();
  await store.enqueueSweep({ attemptId: 'fine', dueAt: nowSec() + 600, orderId: 'O1', variationIds: ['V1'] });
  await store.enqueueSweep({
    attemptId: 'stuck-one', dueAt: nowSec() + 600, orderId: 'O2', paymentLinkId: 'PL2',
    variationIds: ['V2'], stuck: true, stuckSince: Date.now(), attempts: 12, lastError: 'order still live'
  });
  const stuck = await store.stuckSweeps();
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].attemptId, 'stuck-one');
  assert.equal(stuck[0].orderId, 'O2');
  assert.equal(stuck[0].lastError, 'order still live');
});

/* ------------------------------------------------------------------------
   4. Our own error paths must not free a unit a live link can buy
   ------------------------------------------------------------------------ */

async function bootstrap({ env = {}, handlers, ddb: shared, seed = true } = {}) {
  for (const [k, v] of Object.entries({ ...baseEnv(), ...env })) {
    if (v === null) delete process.env[k]; else process.env[k] = v;
  }
  const stamp = '?t=' + Math.random() + Math.random();
  const config = await import('../lib/config.mjs' + stamp);
  const square = await import('../lib/square.mjs' + stamp);
  const store = await import('../lib/store.mjs' + stamp);
  const ddb = shared || fakeDynamo();
  const fetchImpl = fakeSquareFetch(handlers);
  config.resetSecretCache();
  const { makeHandler } = await import('./harness.mjs' + stamp);
  const handler = await makeHandler({
    configMod: { ...config, loadSecrets: () => config.loadSecrets({ client: secretsFake() }) },
    squareMod: { ...square, createSquareClient: (cfg) => square.createSquareClient(cfg, { fetchImpl }) },
    storeMod: { ...store, createStore: (o) => store.createStore({ ...o, client: ddb.client }) },
    stamp
  });
  if (seed) await warmCatalog(handler);
  return { handler, ddb, calls: fetchImpl.calls };
}

const ev = (method, path, { body, headers, query } = {}) => ({
  rawPath: '/default' + path,
  requestContext: { stage: 'default', http: { method }, requestId: 'r' },
  headers: { origin: ORIGIN, ...(headers || {}) },
  queryStringParameters: query || null,
  body: body === undefined ? undefined : JSON.stringify(body)
});
const J = r => JSON.parse(r.body);
const CONTACT = { firstName: 'Dav', lastName: 'Capo', email: 'dav@example.com', phone: '7185051038' };
const PICKUP = { type: 'pickup', contact: CONTACT };
const ADMIN = { 'x-admin-key': 'admin-test-key' };

const stockHandlers = (stock, extra = {}) => squareHandlers({
  'POST /v2/inventory/counts/batch-retrieve': ({ body }) => ({
    json: {
      counts: (body.catalog_object_ids || [])
        .filter(id => ({ ...INVENTORY, ...stock })[id] !== undefined)
        .map(id => ({ catalog_object_id: id, location_id: LOCATION, state: 'IN_STOCK',
                      quantity: String({ ...INVENTORY, ...stock }[id]) }))
    }
  }),
  ...extra
});
const heldIn = (ddb, v) => ddb.find('HOLD#' + v)
  .reduce((n, row) => n + (row.entries || []).reduce((m, e) => m + Number(e.qty || 0), 0), 0);

test('a checkout that breaks AFTER Square made the link keeps its hold', async () => {
  /* The order row fails to save. A payment link exists and is payable, so
     handing the unit back to the next shopper would oversell it. */
  const ddb = fakeDynamo({ failOnce: { PutItemCommand: 'ORDER#' } });
  const { handler } = await bootstrap({
    ddb,
    handlers: stockHandlers({ VAR_HAT_A: 1 }, {
      'POST /v2/online-checkout/payment-links': () => ({
        json: { payment_link: { id: 'PL_live', order_id: 'ORDER_live', url: 'https://square.link/u/live' } }
      })
    })
  });

  const r = await handler(ev('POST', '/checkout', {
    body: { attemptId: 'breaks-after-link', lines: [{ variationId: 'VAR_HAT_A', quantity: 1 }], fulfillment: PICKUP }
  }));
  assert.ok(r.statusCode >= 500, 'the customer is told it failed: ' + r.statusCode);

  assert.equal(heldIn(ddb, 'VAR_HAT_A'), 1,
    'the link Square made is still payable, so the unit stays held');

  const jobs = ddb.find('SWEEP');
  assert.equal(jobs.length, 1, 'and cleanup is told to go and settle it');
  assert.equal(jobs[0].paymentLinkId, 'PL_live');
  assert.equal(jobs[0].orderId, 'ORDER_live');
});

test('a checkout that breaks BEFORE Square is called gives the stock straight back', async () => {
  const ddb = fakeDynamo();
  const { handler } = await bootstrap({
    ddb,
    handlers: stockHandlers({ VAR_HAT_A: 1 }, {
      'POST /v2/online-checkout/payment-links': () =>
        ({ status: 500, json: { errors: [{ code: 'INTERNAL_SERVER_ERROR' }] } })
    })
  });
  const r = await handler(ev('POST', '/checkout', {
    body: { attemptId: 'breaks-before-ln', lines: [{ variationId: 'VAR_HAT_A', quantity: 1 }], fulfillment: PICKUP }
  }));
  assert.ok(r.statusCode >= 400);
  assert.equal(heldIn(ddb, 'VAR_HAT_A'), 0,
    'no link was ever made, so nothing can buy it and the unit is free');
  assert.equal(ddb.find('SWEEP').length, 0);
});

/* ------------------------------------------------------------------------
   5. The admin escape hatch: a person, having looked, says so
   ------------------------------------------------------------------------ */

test('stuck holds are listed for a person to deal with', async () => {
  const ddb = fakeDynamo();
  const { handler } = await bootstrap({
    ddb,
    handlers: stockHandlers({ VAR_HAT_A: 2 }, {
      'POST /v2/online-checkout/payment-links': () => ({
        json: { payment_link: { id: 'PL_s', order_id: 'ORDER_s', url: 'https://square.link/u/s' } }
      }),
      /* A delete that answers but cancels nothing, forever. */
      'GET /v2/orders/*': () => ({ json: { order: { id: 'ORDER_s', state: 'OPEN', version: 1, tenders: [] } } }),
      'DELETE /v2/online-checkout/payment-links/*': () => ({ json: { id: 'PL_s' } })
    }),
    env: { CLEANUP_MAX_ATTEMPTS: '2' }
  });
  await handler(ev('POST', '/checkout', {
    body: { attemptId: 'will-get-stuck', lines: [{ variationId: 'VAR_HAT_A', quantity: 1 }], fulfillment: PICKUP }
  }));

  for (let i = 0; i < 3; i++) {
    for (const row of ddb.find('SWEEP')) {
      ddb.rows.delete(row.pk + '\u0000' + row.sk);
      row.sk = '000000000001#' + row.attemptId; row.dueAt = 1;
      ddb.rows.set(row.pk + '\u0000' + row.sk, row);
    }
    await handler(ev('POST', '/admin/sweep', { headers: ADMIN }));
  }

  const listed = J(await handler(ev('GET', '/admin/stuck', { headers: ADMIN })));
  assert.equal(listed.success, true);
  assert.equal(listed.stuck.length, 1, JSON.stringify(listed));
  assert.equal(listed.stuck[0].attemptId, 'will-get-stuck');
  assert.equal(listed.stuck[0].paymentLinkId, 'PL_s');
  assert.ok(listed.stuck[0].variationIds.includes('VAR_HAT_A'));
  assert.equal(heldIn(ddb, 'VAR_HAT_A'), 1, 'and the unit is still held while it waits');

  /* The listing is not public. */
  assert.equal((await handler(ev('GET', '/admin/stuck'))).statusCode, 403);
});

test('a person can release a stuck hold, but only deliberately', async () => {
  const ddb = fakeDynamo();
  const { handler } = await bootstrap({
    ddb,
    handlers: stockHandlers({ VAR_HAT_A: 1 }, {
      'POST /v2/online-checkout/payment-links': () => ({
        json: { payment_link: { id: 'PL_m', order_id: 'ORDER_m', url: 'https://square.link/u/m' } }
      })
    })
  });
  await handler(ev('POST', '/checkout', {
    body: { attemptId: 'manual-release1', lines: [{ variationId: 'VAR_HAT_A', quantity: 1 }], fulfillment: PICKUP }
  }));
  assert.equal(heldIn(ddb, 'VAR_HAT_A'), 1);

  /* No key: nothing happens. */
  assert.equal((await handler(ev('POST', '/admin/holds/release', {
    body: { attemptId: 'manual-release1', confirm: 'I-CHECKED-SQUARE' }
  }))).statusCode, 403);

  /* Key but no confirmation: still nothing, because this is the one place a
     unit is freed without Square having said so. */
  const noConfirm = await handler(ev('POST', '/admin/holds/release', {
    headers: ADMIN, body: { attemptId: 'manual-release1' }
  }));
  assert.equal(noConfirm.statusCode, 400);
  assert.equal(heldIn(ddb, 'VAR_HAT_A'), 1);

  const done = await handler(ev('POST', '/admin/holds/release', {
    headers: ADMIN, body: { attemptId: 'manual-release1', confirm: 'I-CHECKED-SQUARE' }
  }));
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(heldIn(ddb, 'VAR_HAT_A'), 0);
  assert.equal(ddb.find('SWEEP').length, 0, 'the job is finished with too');
});

test('a stuck hold keeps blocking shoppers until somebody resolves it', async () => {
  const ddb = fakeDynamo();
  const { handler } = await bootstrap({
    ddb,
    handlers: stockHandlers({ VAR_HAT_A: 1 }, {
      'POST /v2/online-checkout/payment-links': () => ({
        json: { payment_link: { id: 'PL_b', order_id: 'ORDER_b', url: 'https://square.link/u/b' } }
      })
    })
  });
  await handler(ev('POST', '/checkout', {
    body: { attemptId: 'blocks-others1', lines: [{ variationId: 'VAR_HAT_A', quantity: 1 }], fulfillment: PICKUP }
  }));

  /* Months pass. Nothing settles it. */
  for (const row of ddb.find('HOLD#VAR_HAT_A')) {
    row.entries.forEach(e => { e.expiresAt = nowSec() - 90 * DAY; });
  }
  const other = await handler(ev('POST', '/checkout', {
    body: { attemptId: 'someone-else1', lines: [{ variationId: 'VAR_HAT_A', quantity: 1 }], fulfillment: PICKUP }
  }));
  assert.equal(other.statusCode, 409, 'the old link may still be payable: ' + other.body);
});
