/* ==========================================================================
   Regressions found in review of the first store release.
   --------------------------------------------------------------------------
   Each test here reproduces a specific way the shop could take money it
   should not have, or lose an order. They drive the real handler with a fake
   Square and an in-memory DynamoDB; only those two edges are doubles.
   ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  fakeDynamo, fakeSquareFetch, squareHandlers, LOCATION, baseEnv, secretsFake,
  catalogFixture, inventoryResponse, INVENTORY, batchRetrieveResponse
, warmCatalog } from './helpers.mjs';

const ORIGIN = 'https://bellmorewebdesign.github.io';
const NOTIFICATION_URL = 'https://n9ecaydkv4.execute-api.us-east-1.amazonaws.com/default/webhooks/square';

/* A mutable stock table the tests move under the handler's feet. */
function stockTable(initial = {}) {
  const counts = { ...INVENTORY, ...initial };
  return {
    counts,
    set(id, qty) { counts[id] = String(qty); },
    handlers(extra = {}) {
      return squareHandlers({
        'POST /v2/inventory/counts/batch-retrieve': ({ body }) => ({
          json: {
            counts: (body.catalog_object_ids || [])
              .filter(id => counts[id] !== undefined)
              .map(id => ({ catalog_object_id: id, location_id: LOCATION, state: 'IN_STOCK', quantity: String(counts[id]) }))
          }
        }),
        ...extra
      });
    }
  };
}

async function bootstrap({ env = {}, handlers, ddb: shared, secrets, seed = true } = {}) {
  for (const [k, v] of Object.entries({ ...baseEnv(), WEBHOOK_NOTIFICATION_URL: NOTIFICATION_URL, ...env })) {
    if (v === null) delete process.env[k]; else process.env[k] = v;
  }
  const stamp = '?t=' + Math.random() + Math.random();
  const config = await import('../lib/config.mjs' + stamp);
  const square = await import('../lib/square.mjs' + stamp);
  const store = await import('../lib/store.mjs' + stamp);

  const ddb = shared || fakeDynamo();
  const fetchImpl = fakeSquareFetch(handlers || stockTable().handlers());
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
  return { handler, ddb, calls: fetchImpl.calls };
}

const ev = (method, path, { body, query, headers } = {}) => ({
  rawPath: '/default' + path,
  requestContext: { stage: 'default', http: { method }, requestId: 'req-' + Math.random() },
  headers: { origin: ORIGIN, ...(headers || {}) },
  queryStringParameters: query || null,
  body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
});
const J = r => JSON.parse(r.body);

const CONTACT = { firstName: 'Dav', lastName: 'Capo', email: 'dav@example.com', phone: '7185051038' };
const PICKUP = { type: 'pickup', contact: CONTACT };
const ADDRESS = { line1: '96-03 37th Ave', line2: '', city: 'Queens', state: 'NY', postalCode: '11368', country: 'US' };
const SHIP = { type: 'shipping', contact: CONTACT, address: ADDRESS };

let linkSeq = 0;
const LINK = ({ body }) => {
  linkSeq++;
  const k = (body.idempotency_key || '').slice(0, 10);
  return { json: { payment_link: { id: 'PL_' + k, order_id: 'ORDER_' + k, url: 'https://square.link/u/' + k } } };
};
/* Square's real idempotency: the same key always returns the same link. */
function stickyLink() {
  const byKey = new Map();
  const fn = ({ body }) => {
    const k = body.idempotency_key;
    if (!byKey.has(k)) {
      const n = byKey.size + 1;
      byKey.set(k, { id: 'PL_' + n, order_id: 'ORDER_' + n, url: 'https://square.link/u/link' + n });
    }
    return { json: { payment_link: byKey.get(k) } };
  };
  fn.byKey = byKey;
  return fn;
}

/* ======================================================================
   1. Checkout must re-read stock and price from Square, not from a cache
   ====================================================================== */

test('stock going to zero after browsing stops the checkout', async () => {
  const stock = stockTable();
  const link = stickyLink();
  const { handler, calls } = await bootstrap({ handlers: stock.handlers({ 'POST /v2/online-checkout/payment-links': link }) });

  /* Warm the browsing catalog while there are four. */
  const browse = await handler(ev('GET', '/catalog'));
  assert.equal(browse.statusCode, 200);

  /* The shop sells the last of them over the counter. */
  stock.set('VAR_TEE_S', 0);

  const r = await handler(ev('POST', '/checkout', {
    body: { attemptId: 'attempt-stockzero', lines: [{ variationId: 'VAR_TEE_S', quantity: 1 }], fulfillment: PICKUP }
  }));
  assert.equal(r.statusCode, 409, 'must refuse: ' + r.body);
  assert.ok(['CART_CHANGED', 'CART_EMPTY_AFTER_REVIEW'].includes(J(r).error), J(r));
  assert.equal(calls.filter(c => c.path.includes('payment-links')).length, 0, 'no payment link may be created');
});

test('a price raised after browsing is the price the order is built on', async () => {
  const stock = stockTable();
  const link = stickyLink();
  let raised = false;
  const handlers = stock.handlers({
    'POST /v2/online-checkout/payment-links': link,
    'POST /v2/catalog/batch-retrieve': ({ body }) => {
      const wanted = new Set(body.object_ids || []);
      const objects = []; const related = [];
      for (const item of catalogFixture().objects) {
        if (item.type !== 'ITEM') continue;
        const hits = (item.item_data.variations || []).filter(v => wanted.has(v.id));
        if (!hits.length) continue;
        for (const v of hits) {
          const copy = JSON.parse(JSON.stringify(v));
          if (raised && copy.id === 'VAR_TEE_S') copy.item_variation_data.price_money.amount = 9900;
          objects.push(copy);
        }
        related.push(item);
      }
      return { json: { objects, related_objects: related } };
    }
  });
  const { handler } = await bootstrap({ handlers });

  await handler(ev('GET', '/catalog'));          /* browsed at 4500 */
  raised = true;

  const r = await handler(ev('POST', '/checkout', {
    body: {
      attemptId: 'attempt-priceup',
      lines: [{ variationId: 'VAR_TEE_S', quantity: 1, displayedPrice: 4500 }],
      fulfillment: PICKUP
    }
  }));
  assert.equal(r.statusCode, 409, 'the customer must see the new price first: ' + r.body);
  const problem = J(r).cart.problems.find(p => p.code === 'PRICE_CHANGED');
  assert.ok(problem, J(r).cart.problems);
  assert.equal(problem.now, 9900, 'the live price, not the browsed one');
});

test('checkout fails safely when Square cannot confirm availability', async () => {
  const stock = stockTable();
  const link = stickyLink();
  let broken = false;
  const { handler, calls } = await bootstrap({
    handlers: stock.handlers({
      'POST /v2/online-checkout/payment-links': link,
      'POST /v2/inventory/counts/batch-retrieve': ({ body }) => broken
        ? { status: 503, json: { errors: [{ category: 'API_ERROR', code: 'SERVICE_UNAVAILABLE' }] } }
        : { json: { counts: (body.catalog_object_ids || []).filter(id => stock.counts[id] !== undefined)
            .map(id => ({ catalog_object_id: id, location_id: LOCATION, state: 'IN_STOCK', quantity: String(stock.counts[id]) })) } }
    })
  });

  await handler(ev('GET', '/catalog'));
  broken = true;

  const r = await handler(ev('POST', '/checkout', {
    body: { attemptId: 'attempt-nocheck', lines: [{ variationId: 'VAR_TEE_S', quantity: 1 }], fulfillment: PICKUP }
  }));
  assert.ok(r.statusCode >= 500, 'must not authorise a purchase it could not verify: ' + r.statusCode);
  assert.equal(J(r).error, 'AVAILABILITY_UNVERIFIED', J(r));
  assert.equal(calls.filter(c => c.path.includes('payment-links')).length, 0);
});

test('a stale browsing snapshot is never used to authorise a purchase', async () => {
  const stock = stockTable();
  const link = stickyLink();
  let catalogDown = false;
  const { handler, calls } = await bootstrap({
    handlers: stock.handlers({
      'POST /v2/online-checkout/payment-links': link,
      'GET /v2/catalog/list': () => catalogDown
        ? { status: 503, json: { errors: [{ code: 'SERVICE_UNAVAILABLE' }] } }
        : { json: catalogFixture() }
    })
  });

  /* Browsing is served from the published snapshot and keeps working even
     when Square is unreachable and refreshes are failing. */
  catalogDown = true;
  const failed = await handler({ task: 'refresh-catalog' });
  assert.equal(failed.refreshed, false);
  const browse = await handler(ev('GET', '/catalog'));
  assert.equal(browse.statusCode, 200, 'the shop stays up');

  /* Buying does not get the same latitude. The per-variation verification is
     a live read, so a unit that has sold cannot be bought off an old page. */
  catalogDown = false;
  stock.set('VAR_TEE_S', 0);
  const r = await handler(ev('POST', '/checkout', {
    body: { attemptId: 'attempt-stalecache', lines: [{ variationId: 'VAR_TEE_S', quantity: 1 }], fulfillment: PICKUP }
  }));
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(calls.filter(c => c.path.includes('payment-links')).length, 0);
});

/* ======================================================================
   2. Two shoppers, one unit
   ====================================================================== */

test('two simultaneous checkouts for the last unit: exactly one wins', async () => {
  const stock = stockTable();
  stock.set('VAR_HAT_A', 1);
  const link = stickyLink();
  /* One table, two "Lambda containers", and a fake that yields on every call
     so the two flows genuinely interleave. */
  const ddb = fakeDynamo({ delay: true });
  const a = await bootstrap({ ddb, handlers: stock.handlers({ 'POST /v2/online-checkout/payment-links': link }) });
  const b = await bootstrap({ ddb, handlers: stock.handlers({ 'POST /v2/online-checkout/payment-links': link }) });

  const body = id => ({ attemptId: id, lines: [{ variationId: 'VAR_HAT_A', quantity: 1 }], fulfillment: PICKUP });
  const [ra, rb] = await Promise.all([
    a.handler(ev('POST', '/checkout', { body: body('shopper-aaaaaaaa') })),
    b.handler(ev('POST', '/checkout', { body: body('shopper-bbbbbbbb') }))
  ]);

  const codes = [ra.statusCode, rb.statusCode].sort();
  assert.deepEqual(codes, [200, 409],
    'exactly one must win, got ' + JSON.stringify(codes) + ' ' + ra.body + ' | ' + rb.body);

  const holds = ddb.find('HOLD#VAR_HAT_A');
  const totalHeld = holds.reduce((n, row) =>
    n + (Array.isArray(row.entries) ? row.entries.reduce((m, e) => m + Number(e.qty || 0), 0) : Number(row.qty || 0)), 0);
  assert.equal(totalHeld, 1, 'only one unit may be held: ' + JSON.stringify(holds));

  const links = (a.calls.concat(b.calls)).filter(c => c.path.includes('payment-links'));
  assert.equal(links.length, 1, 'only the winner may get a payment link');
});

test('five simultaneous checkouts for two units: exactly two win', async () => {
  const stock = stockTable();
  stock.set('VAR_TEE_L', 2);
  const link = stickyLink();
  const ddb = fakeDynamo({ delay: true });
  const boots = [];
  for (let i = 0; i < 5; i++) {
    boots.push(await bootstrap({ ddb, handlers: stock.handlers({ 'POST /v2/online-checkout/payment-links': link }) }));
  }
  const results = await Promise.all(boots.map((bt, i) =>
    bt.handler(ev('POST', '/checkout', {
      body: { attemptId: 'racer-' + i + '-aaaaaaa', lines: [{ variationId: 'VAR_TEE_L', quantity: 1 }], fulfillment: PICKUP }
    }))));
  const won = results.filter(r => r.statusCode === 200).length;
  assert.equal(won, 2, 'two units, two winners, got ' + won + ': ' +
    results.map(r => r.statusCode + ' ' + (J(r).error || '')).join(' | '));
});

test('a hold write that DynamoDB drops does not silently grant stock', async () => {
  const stock = stockTable();
  stock.set('VAR_HAT_A', 1);
  const ddb = fakeDynamo();
  ddb.dropNextBatchWrite();        /* the next BatchWriteItem leaves one write undone */
  const { handler } = await bootstrap({ ddb, handlers: stock.handlers({ 'POST /v2/online-checkout/payment-links': stickyLink() }) });
  const r = await handler(ev('POST', '/checkout', {
    body: { attemptId: 'attempt-droppedhold', lines: [{ variationId: 'VAR_HAT_A', quantity: 1 }], fulfillment: PICKUP }
  }));
  /* Either the hold landed (200) or it did not and we refused. What must not
     happen is a 200 with no hold recorded. */
  if (r.statusCode === 200) {
    const holds = ddb.find('HOLD#VAR_HAT_A');
    const total = holds.reduce((n, row) =>
      n + (Array.isArray(row.entries) ? row.entries.reduce((m, e) => m + Number(e.qty || 0), 0) : Number(row.qty || 0)), 0);
    assert.equal(total, 1, 'a successful checkout must leave its hold behind');
  } else {
    assert.ok(r.statusCode >= 409, r.body);
  }
});

/* ======================================================================
   3. The checkout fingerprint must notice every meaningful change
   ====================================================================== */

test('changing the apartment number makes a new checkout', async () => {
  const link = stickyLink();
  const { handler } = await bootstrap({ handlers: stockTable().handlers({ 'POST /v2/online-checkout/payment-links': link }) });
  const go = (address) => handler(ev('POST', '/checkout', {
    body: {
      attemptId: 'attempt-apartment1', lines: [{ variationId: 'VAR_TEE_L', quantity: 1 }],
      fulfillment: { type: 'shipping', contact: CONTACT, address }
    }
  }));
  const first = J(await go({ ...ADDRESS, line2: 'Apt 1' }));
  const second = J(await go({ ...ADDRESS, line2: 'Apt 2' }));
  assert.notEqual(first.checkoutUrl, second.checkoutUrl,
    'Apt 1 and Apt 2 are different parcels and must be different orders');
  assert.equal(link.byKey.size, 2);
});

test('changing the phone number makes a new checkout', async () => {
  const link = stickyLink();
  const { handler } = await bootstrap({ handlers: stockTable().handlers({ 'POST /v2/online-checkout/payment-links': link }) });
  const go = (phone) => handler(ev('POST', '/checkout', {
    body: {
      attemptId: 'attempt-phone0001', lines: [{ variationId: 'VAR_TEE_L', quantity: 1 }],
      fulfillment: { type: 'pickup', contact: { ...CONTACT, phone } }
    }
  }));
  const a = J(await go('7185051038'));
  const b = J(await go('9175550123'));
  assert.notEqual(a.checkoutUrl, b.checkoutUrl, 'staff ring a different number, so it is a different order');
});

test('every meaningful recipient and address field is in the fingerprint', async () => {
  const link = stickyLink();
  const { handler } = await bootstrap({ handlers: stockTable().handlers({ 'POST /v2/online-checkout/payment-links': link }) });
  const base = { type: 'shipping', contact: { ...CONTACT }, address: { ...ADDRESS } };
  const variants = [
    ['firstName', f => { f.contact.firstName = 'Dave'; }],
    ['lastName', f => { f.contact.lastName = 'Caponi'; }],
    ['email', f => { f.contact.email = 'other@example.com'; }],
    ['phone', f => { f.contact.phone = '9175550199'; }],
    ['line1', f => { f.address.line1 = '1 Other Street'; }],
    ['line2', f => { f.address.line2 = 'Floor 3'; }],
    ['city', f => { f.address.city = 'Brooklyn'; }],
    ['state', f => { f.address.state = 'NJ'; }],
    ['postalCode', f => { f.address.postalCode = '11369'; }]
  ];
  const seen = new Set();
  const run = async (fulfillment, tag) => {
    const r = await handler(ev('POST', '/checkout', {
      body: { attemptId: 'attempt-allfields', lines: [{ variationId: 'VAR_TEE_L', quantity: 1 }], fulfillment }
    }));
    assert.equal(r.statusCode, 200, tag + ': ' + r.body);
    return J(r).checkoutUrl;
  };
  seen.add(await run(JSON.parse(JSON.stringify(base)), 'base'));
  for (const [name, mutate] of variants) {
    const f = JSON.parse(JSON.stringify(base));
    mutate(f);
    const url = await run(f, name);
    assert.ok(!seen.has(url), 'changing ' + name + ' must create a distinct checkout');
    seen.add(url);
  }
});

test('an identical retry replays the same link rather than ordering twice', async () => {
  const link = stickyLink();
  const { handler } = await bootstrap({ handlers: stockTable().handlers({ 'POST /v2/online-checkout/payment-links': link }) });
  const body = {
    attemptId: 'attempt-identical1', lines: [{ variationId: 'VAR_TEE_L', quantity: 1 }],
    fulfillment: { type: 'shipping', contact: { ...CONTACT }, address: { ...ADDRESS, line2: 'Apt 4B' } }
  };
  const a = J(await handler(ev('POST', '/checkout', { body })));
  const b = J(await handler(ev('POST', '/checkout', { body: JSON.parse(JSON.stringify(body)) })));
  assert.equal(a.checkoutUrl, b.checkoutUrl);
  assert.equal(b.replayed, true);
  assert.equal(link.byKey.size, 1, 'Square was asked once');
});

test('cosmetic differences are not a new order', async () => {
  const link = stickyLink();
  const { handler } = await bootstrap({ handlers: stockTable().handlers({ 'POST /v2/online-checkout/payment-links': link }) });
  const go = (contact, address) => handler(ev('POST', '/checkout', {
    body: {
      attemptId: 'attempt-cosmetic1', lines: [{ variationId: 'VAR_TEE_L', quantity: 1 }],
      fulfillment: { type: 'shipping', contact, address }
    }
  }));
  const a = J(await go({ ...CONTACT }, { ...ADDRESS }));
  const b = J(await go({ ...CONTACT, email: '  DAV@Example.com  ' }, { ...ADDRESS, state: 'ny' }));
  assert.equal(a.checkoutUrl, b.checkoutUrl, 'case and padding are not a different customer');
  assert.equal(link.byKey.size, 1);
});

/* ======================================================================
   4. Crash between Square and DynamoDB
   ====================================================================== */

test('a checkout that died after Square made the link recovers on retry', async () => {
  const link = stickyLink();
  const stock = stockTable();
  const ddb = fakeDynamo();
  const first = await bootstrap({ ddb, handlers: stock.handlers({ 'POST /v2/online-checkout/payment-links': link }) });

  const body = {
    attemptId: 'attempt-crashtest', lines: [{ variationId: 'VAR_TEE_L', quantity: 1 }], fulfillment: PICKUP
  };

  /* Kill the container the moment the order row is being written: the Square
     link exists, nothing local does. */
  ddb.rows.set('__kill__', true);
  const killer = await bootstrap({
    ddb: fakeDynamo({ rows: ddb.rows, failOnce: { PutItemCommand: 'ORDER#' } }),
    handlers: stock.handlers({ 'POST /v2/online-checkout/payment-links': link })
  });
  const crashed = await killer.handler(ev('POST', '/checkout', { body }));
  assert.ok(crashed.statusCode >= 500, 'the crashed attempt reports a failure: ' + crashed.statusCode);
  assert.equal(link.byKey.size, 1, 'Square did make a link');

  /* A retry must land on that same Square link and finish the job. */
  const retry = await first.handler(ev('POST', '/checkout', { body }));
  assert.equal(retry.statusCode, 200, 'the retry must recover, not wedge: ' + retry.body);
  const b = J(retry);
  assert.equal(link.byKey.size, 1, 'the same Square request, not a second order');
  assert.equal(b.checkoutUrl, [...link.byKey.values()][0].url);

  /* And the order is now knowable: the token resolves. */
  const status = await first.handler(ev('GET', '/order', { query: { t: b.statusToken } }));
  assert.equal(status.statusCode, 200, 'the status token must reach the order: ' + status.body);
});

test('a half-finished checkout keeps its original status token', async () => {
  const link = stickyLink();
  const ddb = fakeDynamo();
  const { handler } = await bootstrap({ ddb, handlers: stockTable().handlers({ 'POST /v2/online-checkout/payment-links': link }) });
  const body = { attemptId: 'attempt-tokenkeep', lines: [{ variationId: 'VAR_TEE_L', quantity: 1 }], fulfillment: PICKUP };

  const good = J(await handler(ev('POST', '/checkout', { body })));
  /* The reservation row must carry the token from the moment it is claimed,
     so a recovering retry hands back the same one rather than orphaning it. */
  const idemRows = ddb.find('IDEM#');
  assert.equal(idemRows.length, 1, 'one reservation row');
  assert.equal(idemRows[0].statusToken, good.statusToken,
    'the token is written when the attempt is claimed, before Square is called');
});

/* ======================================================================
   5. A webhook that fails after the event id is claimed
   ====================================================================== */

test('a webhook whose work fails is retried, not swallowed as a duplicate', async () => {
  const link = stickyLink();
  const ddb = fakeDynamo({ failOnce: { UpdateItemCommand: 'ORDER#' } });
  const { handler } = await bootstrap({ ddb, handlers: stockTable().handlers({ 'POST /v2/online-checkout/payment-links': link }) });

  const made = J(await handler(ev('POST', '/checkout', {
    body: { attemptId: 'attempt-webhookfail', lines: [{ variationId: 'VAR_TEE_L', quantity: 1 }], fulfillment: PICKUP }
  })));

  const payload = JSON.stringify({
    event_id: 'evt-flaky-1', type: 'payment.updated',
    data: { object: { payment: { id: 'PAY1', order_id: made.orderId, status: 'COMPLETED' } } }
  });
  const sig = { 'x-square-hmacsha256-signature': createHmac('sha256', 'whsec-test-key').update(NOTIFICATION_URL + payload, 'utf8').digest('base64') };

  const firstTry = await handler(ev('POST', '/webhooks/square', { body: payload, headers: sig }));
  assert.ok(firstTry.statusCode >= 500, 'a failed delivery must be a non-2xx so Square retries: ' + firstTry.statusCode);

  const secondTry = await handler(ev('POST', '/webhooks/square', { body: payload, headers: sig }));
  assert.equal(secondTry.statusCode, 200, secondTry.body);
  assert.notEqual(JSON.parse(secondTry.body).duplicate, true, 'the retry must do the work, not skip it');

  const status = J(await handler(ev('GET', '/order', { query: { t: made.statusToken } })));
  assert.equal(status.status, 'paid', 'the order must end up paid');
});

test('a genuinely repeated webhook is still only applied once', async () => {
  const link = stickyLink();
  const { handler, ddb } = await bootstrap({ handlers: stockTable().handlers({ 'POST /v2/online-checkout/payment-links': link }) });
  const made = J(await handler(ev('POST', '/checkout', {
    body: { attemptId: 'attempt-webhookdup', lines: [{ variationId: 'VAR_TEE_L', quantity: 1 }], fulfillment: PICKUP }
  })));
  const payload = JSON.stringify({
    event_id: 'evt-dup-1', type: 'payment.updated',
    data: { object: { payment: { id: 'PAY1', order_id: made.orderId, status: 'COMPLETED' } } }
  });
  const sig = { 'x-square-hmacsha256-signature': createHmac('sha256', 'whsec-test-key').update(NOTIFICATION_URL + payload, 'utf8').digest('base64') };
  const one = await handler(ev('POST', '/webhooks/square', { body: payload, headers: sig }));
  const two = await handler(ev('POST', '/webhooks/square', { body: payload, headers: sig }));
  assert.equal(one.statusCode, 200);
  assert.equal(two.statusCode, 200);
  assert.equal(JSON.parse(two.body).duplicate, true);
});

/* ======================================================================
   6. Buy now must not eat the saved cart
   ====================================================================== */

test('the order record says whether it was a cart or a buy-now purchase', async () => {
  const link = stickyLink();
  const { handler } = await bootstrap({ handlers: stockTable().handlers({ 'POST /v2/online-checkout/payment-links': link }) });
  const made = J(await handler(ev('POST', '/checkout', {
    body: {
      attemptId: 'attempt-buynow001', source: 'buynow',
      lines: [{ variationId: 'VAR_TEE_L', quantity: 1 }], fulfillment: PICKUP
    }
  })));
  const status = J(await handler(ev('GET', '/order', { query: { t: made.statusToken } })));
  assert.equal(status.purchaseSource, 'buynow',
    'the return page needs this to know not to touch the saved cart');
});

/* ======================================================================
   7. Holds are released when an order resolves
   ====================================================================== */

function holdTotal(ddb, variationId) {
  return ddb.find('HOLD#' + variationId).reduce((n, row) =>
    n + (Array.isArray(row.entries)
      ? row.entries.reduce((m, e) => m + Number(e.qty || 0), 0)
      : Number(row.qty || 0)), 0);
}

test('a paid order releases its hold, so the shelf is not held twice', async () => {
  const link = stickyLink();
  const { handler, ddb } = await bootstrap({ handlers: stockTable().handlers({ 'POST /v2/online-checkout/payment-links': link }) });
  const made = J(await handler(ev('POST', '/checkout', {
    body: { attemptId: 'attempt-holdpaid1', lines: [{ variationId: 'VAR_TEE_L', quantity: 1 }], fulfillment: PICKUP }
  })));
  assert.equal(holdTotal(ddb, 'VAR_TEE_L'), 1, 'held while the customer is paying');

  const payload = JSON.stringify({
    event_id: 'evt-paid-release', type: 'payment.updated',
    data: { object: { payment: { id: 'P', order_id: made.orderId, status: 'COMPLETED' } } }
  });
  await handler(ev('POST', '/webhooks/square', {
    body: payload,
    headers: { 'x-square-hmacsha256-signature': createHmac('sha256', 'whsec-test-key').update(NOTIFICATION_URL + payload, 'utf8').digest('base64') }
  }));
  /* Square has now decremented the real stock, so holding it as well would
     take the same unit off the shelf twice. */
  assert.equal(holdTotal(ddb, 'VAR_TEE_L'), 0, 'the hold must be let go once Square owns the sale');
});

test('a cancelled order releases its hold straight away', async () => {
  const link = stickyLink();
  const { handler, ddb } = await bootstrap({ handlers: stockTable().handlers({ 'POST /v2/online-checkout/payment-links': link }) });
  const made = J(await handler(ev('POST', '/checkout', {
    body: { attemptId: 'attempt-holdcanc1', lines: [{ variationId: 'VAR_TEE_L', quantity: 1 }], fulfillment: PICKUP }
  })));
  assert.equal(holdTotal(ddb, 'VAR_TEE_L'), 1);

  const payload = JSON.stringify({
    event_id: 'evt-cancel-release', type: 'payment.updated',
    data: { object: { payment: { id: 'P', order_id: made.orderId, status: 'CANCELED' } } }
  });
  await handler(ev('POST', '/webhooks/square', {
    body: payload,
    headers: { 'x-square-hmacsha256-signature': createHmac('sha256', 'whsec-test-key').update(NOTIFICATION_URL + payload, 'utf8').digest('base64') }
  }));
  assert.equal(holdTotal(ddb, 'VAR_TEE_L'), 0, 'a cancelled order must put the stock back immediately');
});

test('an expired hold keeps holding until cleanup has settled it', async () => {
  const stock = stockTable();
  stock.set('VAR_HAT_A', 1);
  const link = stickyLink();
  const ddb = fakeDynamo();
  const { handler } = await bootstrap({
    ddb, env: { STOCK_HOLD_SECONDS: '900' },
    handlers: stock.handlers({ 'POST /v2/online-checkout/payment-links': link })
  });

  const first = await handler(ev('POST', '/checkout', {
    body: { attemptId: 'attempt-expiry001', lines: [{ variationId: 'VAR_HAT_A', quantity: 1 }], fulfillment: PICKUP }
  }));
  assert.equal(first.statusCode, 200);

  const blocked = await handler(ev('POST', '/checkout', {
    body: { attemptId: 'attempt-expiry002', lines: [{ variationId: 'VAR_HAT_A', quantity: 1 }], fulfillment: PICKUP }
  }));
  assert.equal(blocked.statusCode, 409, 'held by the first shopper');

  /* Wind the hold into the past. The first shopper's Square link is still
     payable, so the unit must NOT go back on sale on a timer alone — that
     was the overselling hole. */
  for (const row of ddb.find('HOLD#VAR_HAT_A')) {
    row.entries.forEach(e => { e.expiresAt = Math.floor(Date.now() / 1000) - 5; });
  }

  const stillBlocked = await handler(ev('POST', '/checkout', {
    body: { attemptId: 'attempt-expiry003', lines: [{ variationId: 'VAR_HAT_A', quantity: 1 }], fulfillment: PICKUP }
  }));
  assert.equal(stillBlocked.statusCode, 409,
    'the clock running out is not proof the link is dead: ' + stillBlocked.body);
});

/* ======================================================================
   8. Holds must be counted once, not twice
   ====================================================================== */

test('one shopper holding one of two does not block the other shopper', async () => {
  const stock = stockTable();
  stock.set('VAR_HAT_A', 2);
  const link = stickyLink();
  const ddb = fakeDynamo();
  const { handler } = await bootstrap({ ddb, handlers: stock.handlers({ 'POST /v2/online-checkout/payment-links': link }) });

  const first = await handler(ev('POST', '/checkout', {
    body: { attemptId: 'shopper-one-aaa', lines: [{ variationId: 'VAR_HAT_A', quantity: 1 }], fulfillment: PICKUP }
  }));
  assert.equal(first.statusCode, 200, first.body);

  /* Two on the shelf, one held by somebody else: the second unit is still
     for sale. Subtracting that hold twice would wrongly refuse this. */
  const second = await handler(ev('POST', '/checkout', {
    body: { attemptId: 'shopper-two-aaa', lines: [{ variationId: 'VAR_HAT_A', quantity: 1 }], fulfillment: PICKUP }
  }));
  assert.equal(second.statusCode, 200, 'the second unit must still be buyable: ' + second.body);

  const third = await handler(ev('POST', '/checkout', {
    body: { attemptId: 'shopper-three-a', lines: [{ variationId: 'VAR_HAT_A', quantity: 1 }], fulfillment: PICKUP }
  }));
  assert.equal(third.statusCode, 409, 'but the third shopper has nothing left');
});

test('pressing Pay again on the same attempt is not competing with yourself', async () => {
  const stock = stockTable();
  stock.set('VAR_HAT_A', 1);
  const link = stickyLink();
  const ddb = fakeDynamo();
  const { handler } = await bootstrap({ ddb, handlers: stock.handlers({ 'POST /v2/online-checkout/payment-links': link }) });
  const body = { attemptId: 'samepersonaga', lines: [{ variationId: 'VAR_HAT_A', quantity: 1 }], fulfillment: PICKUP };
  assert.equal((await handler(ev('POST', '/checkout', { body }))).statusCode, 200);
  const again = await handler(ev('POST', '/checkout', { body }));
  assert.equal(again.statusCode, 200, 'their own hold must not lock them out: ' + again.body);
  assert.equal(J(again).replayed, true);
});

/* ======================================================================
   9. A container killed outright, with nothing left to clean up after it
   ====================================================================== */

test('a reservation stranded by a hard kill is taken over, not wedged for days', async () => {
  const link = stickyLink();
  const ddb = fakeDynamo();
  const { handler } = await bootstrap({ ddb, handlers: stockTable().handlers({ 'POST /v2/online-checkout/payment-links': link }) });
  const body = { attemptId: 'hardkill-aaaa', lines: [{ variationId: 'VAR_TEE_L', quantity: 1 }], fulfillment: PICKUP };

  /* Stand in for a Lambda that hit its timeout: the row exists, the token is
     on it, and no catch block ever ran. */
  const first = await handler(ev('POST', '/checkout', { body }));
  assert.equal(first.statusCode, 200);
  const original = J(first);
  const idemRow = ddb.find('IDEM#')[0];
  idemRow.status = 'PENDING';
  delete idemRow.result;

  /* Immediately afterwards another request must be told to wait, not shown a
     second order. */
  idemRow.createdAt = Date.now();
  const tooSoon = await handler(ev('POST', '/checkout', { body }));
  assert.equal(tooSoon.statusCode, 409);
  assert.equal(J(tooSoon).error, 'CHECKOUT_IN_PROGRESS');

  /* Once the in-flight window has passed, it recovers. */
  idemRow.createdAt = Date.now() - 60000;
  const recovered = await handler(ev('POST', '/checkout', { body }));
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal(J(recovered).statusToken, original.statusToken, 'the original token is reused');
  assert.equal(J(recovered).checkoutUrl, original.checkoutUrl, 'the original Square link, not a new one');
  assert.equal(link.byKey.size, 1, 'Square only ever made one link');
});
