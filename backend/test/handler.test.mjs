/* Drives the real Lambda handler end to end with a fake Square and an
   in-memory DynamoDB. Everything the handler does — routing, secrets,
   catalog caching, cart reconciliation, order construction, idempotency,
   webhooks — is the shipping code. Only the two network edges are doubles. */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  fakeDynamo, fakeSquareFetch, squareHandlers, LOCATION, baseEnv, secretsFake, catalogFixture, inventoryResponse
, warmCatalog } from './helpers.mjs';

const ORIGIN = 'https://bellmorewebdesign.github.io';
const NOTIFICATION_URL = 'https://n9ecaydkv4.execute-api.us-east-1.amazonaws.com/default/webhooks/square';

/* The handler builds its own clients, so the modules it imports are patched
   before it is loaded. Each test gets a fresh module graph. */
async function bootstrap({ env = {}, squareOverrides = {}, secrets, ddb: sharedDdb, seed = true } = {}) {
  for (const [k, v] of Object.entries({ ...baseEnv(), WEBHOOK_NOTIFICATION_URL: NOTIFICATION_URL, ...env })) {
    if (v === null) delete process.env[k]; else process.env[k] = v;
  }
  const stamp = '?t=' + Math.random();

  const config = await import('../lib/config.mjs' + stamp);
  const square = await import('../lib/square.mjs' + stamp);
  const store = await import('../lib/store.mjs' + stamp);

  const ddb = sharedDdb || fakeDynamo();
  const fetchImpl = fakeSquareFetch(squareHandlers(squareOverrides));

  config.resetSecretCache();
  const realLoad = config.loadSecrets;
  const secretsClient = secrets || secretsFake();

  const realCreateSquare = square.createSquareClient;
  const realCreateStore = store.createStore;

  /* Point the two edges at the doubles without changing the handler. */
  const configMod = { ...config, loadSecrets: () => realLoad({ client: secretsClient }) };
  const squareMod = { ...square, createSquareClient: (cfg) => realCreateSquare(cfg, { fetchImpl }) };
  const storeMod = { ...store, createStore: (o) => realCreateStore({ ...o, client: ddb.client }) };

  const { makeHandler } = await import('./harness.mjs' + stamp);
  const handler = await makeHandler({ configMod, squareMod, storeMod, stamp });
  if (seed) await warmCatalog(handler);
  if (seed) await warmCatalog(handler);
  return { handler, ddb, fetchImpl, calls: fetchImpl.calls };
}

const ev = (method, path, { body, query, headers } = {}) => ({
  rawPath: '/default' + path,
  requestContext: { stage: 'default', http: { method }, requestId: 'req-test' },
  headers: { origin: ORIGIN, ...(headers || {}) },
  queryStringParameters: query || null,
  body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
});
const J = r => JSON.parse(r.body);

const CONTACT = { firstName: 'Dav', lastName: 'Capo', email: 'dav@example.com', phone: '7185051038' };
const PICKUP = { type: 'pickup', contact: CONTACT };
const SHIP = {
  type: 'shipping', contact: CONTACT,
  address: { line1: '96-03 37th Ave', city: 'Queens', state: 'NY', postalCode: '11368', country: 'US' }
};

const LINK = ({ body }) => ({
  json: {
    payment_link: {
      id: 'PL_' + (body.idempotency_key || '').slice(0, 8),
      order_id: 'ORDER_' + (body.idempotency_key || '').slice(0, 8),
      url: 'https://square.link/u/' + (body.idempotency_key || '').slice(0, 6),
      long_url: 'https://checkout.square.site/long'
    }
  }
});

/* ------------------------------------------------------------- catalog */

test('GET /catalog serves the sellable catalog and paginates', async () => {
  const { handler } = await bootstrap();
  const first = await handler(ev('GET', '/catalog', { query: { limit: '1' } }));
  assert.equal(first.statusCode, 200);
  const a = J(first);
  assert.equal(a.success, true);
  assert.equal(a.total, 2);
  assert.equal(a.products.length, 1);
  assert.ok(a.categories, 'categories ride along on the first page');
  /* The cursor names the build it belongs to, so page two cannot land on a
     different generation of the catalog. */
  assert.equal(a.cursor, a.buildId + '~1');

  const second = await handler(ev('GET', '/catalog', { query: { limit: '1', cursor: a.cursor } }));
  const b = J(second);
  assert.equal(b.products.length, 1);
  assert.equal(b.cursor, null, 'the walk ends');
  assert.equal(b.buildId, a.buildId, 'and both pages came from one build');
  assert.notEqual(a.products[0].id, b.products[0].id);
});

test('a warm catalog is not refetched from Square on every request', async () => {
  const { handler, calls } = await bootstrap();
  await handler(ev('GET', '/catalog'));
  const after = calls.filter(c => c.path === '/v2/catalog/list').length;
  await handler(ev('GET', '/catalog'));
  await handler(ev('GET', '/catalog'));
  assert.equal(calls.filter(c => c.path === '/v2/catalog/list').length, after, 'served from cache');
});

test('a failed refresh leaves the last good catalog serving', async () => {
  let broken = false;
  const { handler } = await bootstrap({
    squareOverrides: {
      'GET /v2/catalog/list': () => broken
        ? { status: 503, json: { errors: [{ code: 'SERVICE_UNAVAILABLE' }] } }
        : { json: catalogFixture() }
    }
  });
  const warm = await handler(ev('GET', '/catalog'));
  assert.equal(J(warm).total, 2);
  const buildId = J(warm).buildId;

  /* Square falls over and the scheduled refresh fails. */
  broken = true;
  const result = await handler({ task: 'refresh-catalog' });
  assert.equal(result.refreshed, false);
  assert.equal(result.reason, 'failed');

  /* The shop carries on, on exactly the build it had. */
  const after = await handler(ev('GET', '/catalog'));
  assert.equal(after.statusCode, 200);
  assert.equal(J(after).total, 2);
  assert.equal(J(after).buildId, buildId, 'the pointer never moved');
});

test('GET /config says what is actually configured, and leaks nothing', async () => {
  const { handler } = await bootstrap();
  const r = await handler(ev('GET', '/config'));
  const c = J(r).config;
  assert.equal(c.fulfillment.pickup.available, true);
  assert.equal(c.fulfillment.shipping.available, true);
  assert.equal(c.fulfillment.shipping.zones.length, 2);
  assert.ok(!r.body.includes('TOP-SECRET'), 'no token');
  assert.ok(!r.body.includes(LOCATION), 'no internal location id');
  assert.ok(!r.body.includes('asp-store-test'), 'no table name');
});

/* ------------------------------------------------------------ checkout */

test('a single-item pickup checkout builds the right Square order', async () => {
  const { handler, calls } = await bootstrap({ squareOverrides: { 'POST /v2/online-checkout/payment-links': LINK } });
  const r = await handler(ev('POST', '/checkout', {
    body: { attemptId: 'attempt-0000001', lines: [{ variationId: 'VAR_TEE_S', quantity: 2 }], fulfillment: PICKUP }
  }));
  assert.equal(r.statusCode, 200, r.body);
  const b = J(r);
  assert.ok(b.checkoutUrl.startsWith('https://square.link/u/'));
  assert.equal(b.paymentConfirmed, false, 'a link is not a payment');
  assert.match(b.pickupPolicy, /contact you when your order is ready/i);

  const sent = calls.find(c => c.path === '/v2/online-checkout/payment-links').body;
  assert.equal(sent.order.location_id, LOCATION);
  assert.deepEqual(sent.order.line_items.map(l => [l.catalog_object_id, l.quantity]), [['VAR_TEE_S', '2']]);
  assert.equal(sent.order.fulfillments[0].type, 'PICKUP');
  assert.equal(sent.order.fulfillments[0].pickup_details.schedule_type, 'ASAP');
  assert.equal(sent.order.fulfillments[0].pickup_details.pickup_at, undefined, 'no time is promised');
  assert.equal(sent.order.fulfillments[0].pickup_details.recipient.email_address, 'dav@example.com');
  assert.equal(sent.checkout_options.allow_tipping, false);
  assert.ok(sent.checkout_options.redirect_url.includes('order.html?t='), 'the return page carries a token');
});

test('a multi-item shipping checkout carries every line and the configured rate', async () => {
  const { handler, calls } = await bootstrap({ squareOverrides: { 'POST /v2/online-checkout/payment-links': LINK } });
  const r = await handler(ev('POST', '/checkout', {
    body: {
      attemptId: 'attempt-0000002',
      lines: [{ variationId: 'VAR_TEE_S', quantity: 1 }, { variationId: 'VAR_TEE_L', quantity: 2 }, { variationId: 'VAR_HAT_A', quantity: 1 }],
      fulfillment: SHIP
    }
  }));
  assert.equal(r.statusCode, 200, r.body);
  const sent = calls.find(c => c.path === '/v2/online-checkout/payment-links').body;
  assert.deepEqual(
    sent.order.line_items.map(l => [l.catalog_object_id, l.quantity]).sort(),
    [['VAR_HAT_A', '1'], ['VAR_TEE_L', '2'], ['VAR_TEE_S', '1']]
  );
  assert.equal(sent.order.fulfillments[0].type, 'SHIPMENT');
  assert.equal(sent.order.fulfillments[0].shipment_details.recipient.address.postal_code, '11368');
  /* 4500 + 9000 + 3900 = 17400, over the configured 15000 free threshold, so
     no charge is added at all. */
  assert.equal(sent.order.service_charges, undefined, 'free over the threshold');
  assert.equal(J(r).shipping.free, true);
});

test('an under-threshold shipping order carries the configured charge', async () => {
  const { handler, calls } = await bootstrap({ squareOverrides: { 'POST /v2/online-checkout/payment-links': LINK } });
  const r = await handler(ev('POST', '/checkout', {
    body: {
      attemptId: 'attempt-000002b',
      lines: [{ variationId: 'VAR_TEE_S', quantity: 1 }, { variationId: 'VAR_HAT_A', quantity: 1 }],
      fulfillment: SHIP
    }
  }));
  assert.equal(r.statusCode, 200, r.body);
  const sent = calls.find(c => c.path === '/v2/online-checkout/payment-links').body;
  const charge = sent.order.service_charges[0];
  assert.equal(charge.amount_money.amount, 800, 'the NY zone rate from configuration');
  assert.equal(charge.calculation_phase, 'SUBTOTAL_PHASE');
  assert.equal(charge.taxable, false);
});

test('catalog taxes are applied from the shop’s own rules, never a typed-in rate', async () => {
  const { handler, calls } = await bootstrap({ squareOverrides: { 'POST /v2/online-checkout/payment-links': LINK } });
  await handler(ev('POST', '/checkout', {
    body: { attemptId: 'attempt-0000003', lines: [{ variationId: 'VAR_TEE_S', quantity: 1 }], fulfillment: PICKUP }
  }));
  const sent = calls.find(c => c.path === '/v2/online-checkout/payment-links').body;
  assert.deepEqual(sent.order.taxes, [{ uid: 'tax-TAX_NYC', catalog_object_id: 'TAX_NYC', scope: 'LINE_ITEM' }]);
  assert.equal(sent.order.line_items[0].applied_taxes[0].tax_uid, 'tax-TAX_NYC');
  assert.ok(!JSON.stringify(sent).includes('8.875'), 'no rate is sent; Square owns the number');
});

test('a product with no tax rule gets no tax block invented for it', async () => {
  const { handler, calls } = await bootstrap({ squareOverrides: { 'POST /v2/online-checkout/payment-links': LINK } });
  await handler(ev('POST', '/checkout', {
    body: { attemptId: 'attempt-0000004', lines: [{ variationId: 'VAR_HAT_A', quantity: 1 }], fulfillment: PICKUP }
  }));
  const sent = calls.find(c => c.path === '/v2/online-checkout/payment-links').body;
  assert.equal(sent.order.taxes, undefined);
  assert.equal(sent.order.line_items[0].applied_taxes, undefined);
});

test('no price, discount or total from the browser reaches Square', async () => {
  const { handler, calls } = await bootstrap({ squareOverrides: { 'POST /v2/online-checkout/payment-links': LINK } });
  const r = await handler(ev('POST', '/checkout', {
    body: {
      attemptId: 'attempt-0000005',
      lines: [{ variationId: 'VAR_TEE_S', quantity: 1, displayedPrice: 4500, price: 1, unitPrice: 1,
                base_price_money: { amount: 1, currency: 'USD' } }],
      fulfillment: SHIP,
      discounts: [{ amount: 99999 }], total: 1, shippingAmount: 0, taxAmount: 0
    }
  }));
  assert.equal(r.statusCode, 200, r.body);
  const sent = calls.find(c => c.path === '/v2/online-checkout/payment-links').body;
  const text = JSON.stringify(sent);
  assert.equal(sent.order.discounts, undefined);
  assert.ok(!text.includes('99999'));
  assert.ok(!/"base_price_money"/.test(text), 'no price on any line item');
  assert.equal(sent.order.service_charges[0].amount_money.amount, 800, 'the configured rate, not the browser’s 0');
  /* A line may only ever name the catalog object, a quantity, a uid and the
     shop's own tax rules. Anything that could set a price is absent. */
  const allowed = new Set(['catalog_object_id', 'quantity', 'uid', 'applied_taxes']);
  for (const li of sent.order.line_items) {
    for (const key of Object.keys(li)) {
      assert.ok(allowed.has(key), 'unexpected key on a line item: ' + key);
    }
    assert.equal(li.base_price_money, undefined);
    assert.equal(li.applied_discounts, undefined);
  }
});

test('a cart that changed comes back as 409 with the corrected cart', async () => {
  const { handler } = await bootstrap({ squareOverrides: { 'POST /v2/online-checkout/payment-links': LINK } });
  const r = await handler(ev('POST', '/checkout', {
    body: { attemptId: 'attempt-0000006', lines: [{ variationId: 'VAR_HAT_A', quantity: 5 }], fulfillment: PICKUP }
  }));
  assert.equal(r.statusCode, 409);
  const b = J(r);
  assert.equal(b.error, 'CART_CHANGED');
  assert.equal(b.cart.lines[0].quantity, 2, 'the corrected quantity is in the body to review');
  assert.equal(b.cart.problems[0].code, 'QUANTITY_REDUCED');
});

test('an entirely sold-out cart is 409 CART_EMPTY_AFTER_REVIEW', async () => {
  const { handler, calls } = await bootstrap({ squareOverrides: { 'POST /v2/online-checkout/payment-links': LINK } });
  const r = await handler(ev('POST', '/checkout', {
    body: { attemptId: 'attempt-0000007', lines: [{ variationId: 'VAR_TEE_M', quantity: 1 }], fulfillment: PICKUP }
  }));
  assert.equal(r.statusCode, 409);
  assert.equal(J(r).error, 'CART_EMPTY_AFTER_REVIEW');
  assert.equal(calls.filter(c => c.path.includes('payment-links')).length, 0, 'Square was never asked');
});

test('retrying the same attempt returns the same link, not a second order', async () => {
  let created = 0;
  const { handler } = await bootstrap({
    squareOverrides: { 'POST /v2/online-checkout/payment-links': (c) => { created++; return LINK(c); } }
  });
  const body = { attemptId: 'attempt-0000008', lines: [{ variationId: 'VAR_TEE_S', quantity: 1 }], fulfillment: PICKUP };
  const a = J(await handler(ev('POST', '/checkout', { body })));
  const b = J(await handler(ev('POST', '/checkout', { body })));
  const c = J(await handler(ev('POST', '/checkout', { body })));
  assert.equal(created, 1, 'Square was called once');
  assert.equal(a.checkoutUrl, b.checkoutUrl);
  assert.equal(b.checkoutUrl, c.checkoutUrl);
  assert.equal(b.replayed, true);
  assert.equal(a.orderId, c.orderId);
});

test('editing the cart makes a distinct attempt', async () => {
  let created = 0;
  const { handler } = await bootstrap({
    squareOverrides: { 'POST /v2/online-checkout/payment-links': (c) => { created++; return LINK(c); } }
  });
  const a = J(await handler(ev('POST', '/checkout', {
    body: { attemptId: 'attempt-0000009', lines: [{ variationId: 'VAR_TEE_S', quantity: 1 }], fulfillment: PICKUP }
  })));
  const b = J(await handler(ev('POST', '/checkout', {
    body: { attemptId: 'attempt-0000009', lines: [{ variationId: 'VAR_TEE_S', quantity: 2 }], fulfillment: PICKUP }
  })));
  assert.equal(created, 2);
  assert.notEqual(a.checkoutUrl, b.checkoutUrl);
  assert.notEqual(a.orderId, b.orderId);
});

test('switching pickup to shipping makes a distinct attempt', async () => {
  let created = 0;
  const { handler } = await bootstrap({
    squareOverrides: { 'POST /v2/online-checkout/payment-links': (c) => { created++; return LINK(c); } }
  });
  const lines = [{ variationId: 'VAR_TEE_S', quantity: 1 }];
  await handler(ev('POST', '/checkout', { body: { attemptId: 'attempt-0000010', lines, fulfillment: PICKUP } }));
  await handler(ev('POST', '/checkout', { body: { attemptId: 'attempt-0000010', lines, fulfillment: SHIP } }));
  assert.equal(created, 2);
});

test('the durable key survives a cold Lambda', async () => {
  let created = 0;
  const shared = fakeDynamo();
  const make = async () => {
    const b = await bootstrap({
      squareOverrides: { 'POST /v2/online-checkout/payment-links': (c) => { created++; return LINK(c); } }
    });
    return b;
  };
  /* Two bootstraps share one table by handing the second the first's rows. */
  const first = await make();
  const body = { attemptId: 'attempt-0000011', lines: [{ variationId: 'VAR_TEE_S', quantity: 1 }], fulfillment: PICKUP };
  const a = J(await first.handler(ev('POST', '/checkout', { body })));

  const second = await make();
  for (const [k, v] of first.ddb.rows) second.ddb.rows.set(k, v);
  const b = J(await second.handler(ev('POST', '/checkout', { body })));

  assert.equal(created, 1, 'a fresh container did not create a second order');
  assert.equal(a.checkoutUrl, b.checkoutUrl);
  assert.equal(b.replayed, true);
});

test('a failed Square call releases the key so the customer can retry', async () => {
  let attempt = 0;
  const { handler } = await bootstrap({
    squareOverrides: {
      'POST /v2/online-checkout/payment-links': (c) => {
        attempt++;
        if (attempt === 1) return { status: 400, json: { errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'BAD_REQUEST', detail: 'nope' }] } };
        return LINK(c);
      }
    }
  });
  const body = { attemptId: 'attempt-0000012', lines: [{ variationId: 'VAR_TEE_S', quantity: 1 }], fulfillment: PICKUP };
  const bad = await handler(ev('POST', '/checkout', { body }));
  assert.equal(bad.statusCode, 400);
  assert.equal(J(bad).error, 'SQUARE_ERROR');
  assert.ok(!bad.body.includes('TOP-SECRET'));

  const good = await handler(ev('POST', '/checkout', { body }));
  assert.equal(good.statusCode, 200, 'the same cart can be tried again');
});

test('a soft hold stops the website promising the last unit twice', async () => {
  const { handler } = await bootstrap({ squareOverrides: { 'POST /v2/online-checkout/payment-links': LINK } });
  const lines = [{ variationId: 'VAR_HAT_A', quantity: 2 }];
  const first = await handler(ev('POST', '/checkout', { body: { attemptId: 'shopper-aaaaaaa', lines, fulfillment: PICKUP } }));
  assert.equal(first.statusCode, 200);

  const second = await handler(ev('POST', '/checkout', { body: { attemptId: 'shopper-bbbbbbb', lines, fulfillment: PICKUP } }));
  assert.equal(second.statusCode, 409, 'the second shopper is told, not silently oversold');
  assert.equal(J(second).error, 'CART_EMPTY_AFTER_REVIEW');
});

test('bad checkout input is refused before Square is touched', async () => {
  const { handler, calls } = await bootstrap({ squareOverrides: { 'POST /v2/online-checkout/payment-links': LINK } });
  const cases = [
    [{ lines: [{ variationId: 'VAR_TEE_S', quantity: 1 }], fulfillment: PICKUP }, 'BAD_ATTEMPT_ID'],
    [{ attemptId: 'short', lines: [{ variationId: 'VAR_TEE_S', quantity: 1 }], fulfillment: PICKUP }, 'BAD_ATTEMPT_ID'],
    [{ attemptId: 'attempt-00000zz', lines: [], fulfillment: PICKUP }, 'BAD_CART'],
    [{ attemptId: 'attempt-00000yy', lines: [{ variationId: 'VAR_TEE_S', quantity: 1 }], fulfillment: { type: 'courier', contact: CONTACT } }, 'FULFILLMENT_INVALID'],
    [{ attemptId: 'attempt-00000xx', lines: [{ variationId: 'VAR_TEE_S', quantity: 1 }], fulfillment: { type: 'shipping', contact: CONTACT, address: { line1: '', city: '', state: 'ZZ', postalCode: 'x', country: 'US' } } }, 'FULFILLMENT_INVALID']
  ];
  for (const [body, code] of cases) {
    const r = await handler(ev('POST', '/checkout', { body }));
    assert.equal(r.statusCode, 400, JSON.stringify(body));
    assert.equal(J(r).error, code, JSON.stringify(J(r)));
  }
  const bad = await handler(ev('POST', '/checkout', { body: '{not json' }));
  assert.equal(J(bad).error, 'BAD_JSON');
  assert.equal(calls.filter(c => c.path.includes('payment-links')).length, 0);
});

test('shipping is refused outright when no rate is configured', async () => {
  const { handler, calls } = await bootstrap({
    env: { SHIPPING_RATES: '', SHIPPING_ENABLED: 'true' },
    squareOverrides: { 'POST /v2/online-checkout/payment-links': LINK }
  });
  const r = await handler(ev('POST', '/checkout', {
    body: { attemptId: 'attempt-0000013', lines: [{ variationId: 'VAR_TEE_S', quantity: 1 }], fulfillment: SHIP }
  }));
  assert.equal(r.statusCode, 400);
  assert.equal(J(r).error, 'FULFILLMENT_INVALID');
  assert.equal(calls.filter(c => c.path.includes('payment-links')).length, 0, 'no order at an invented price');
});

/* -------------------------------------------------------- order status */

test('order status is verified with Square, not taken from the redirect', async () => {
  const { handler } = await bootstrap({
    squareOverrides: {
      'POST /v2/online-checkout/payment-links': LINK,
      'GET /v2/orders/*': ({ path }) => ({ json: { order: {
        id: path.split('/').pop(), state: 'COMPLETED',
        total_money: { amount: 4500, currency: 'USD' },
        net_amount_due_money: { amount: 0, currency: 'USD' },
        tenders: [{ id: 'TENDER_1' }],
        line_items: [{ name: 'Horseshoe Tee', variation_name: 'Small / Black', quantity: '1', total_money: { amount: 4500, currency: 'USD' } }],
        fulfillments: [{ type: 'PICKUP', state: 'PROPOSED' }]
      } } })
    }
  });
  const made = J(await handler(ev('POST', '/checkout', {
    body: { attemptId: 'attempt-0000014', lines: [{ variationId: 'VAR_TEE_S', quantity: 1 }], fulfillment: PICKUP }
  })));

  const r = await handler(ev('GET', '/order', { query: { t: made.statusToken } }));
  assert.equal(r.statusCode, 200);
  const b = J(r);
  assert.equal(b.verified, true, 'Square was actually asked');
  assert.equal(b.status, 'paid');
  assert.equal(b.order.totals.total, 4500);
  assert.deepEqual(b.purchasedVariationIds, ['VAR_TEE_S']);
  assert.equal(b.fulfillmentType, 'pickup');
  assert.match(b.pickupPolicy, /contact you when your order is ready/i);
});

test('order status cannot be read without the right token', async () => {
  const { handler } = await bootstrap({ squareOverrides: { 'POST /v2/online-checkout/payment-links': LINK } });
  const made = J(await handler(ev('POST', '/checkout', {
    body: { attemptId: 'attempt-0000015', lines: [{ variationId: 'VAR_TEE_S', quantity: 1 }], fulfillment: PICKUP }
  })));

  /* Every one of these must fail to reveal anything: the order id itself, a
     guessed token of the right shape, no token at all, and the real token
     with one character missing. */
  const attempts = [
    made.orderId,
    made.orderId.padEnd(44, 'z'),
    'x'.repeat(43),
    made.statusToken.slice(0, -1),
    made.statusToken + 'z',
    undefined
  ];
  for (const t of attempts) {
    const r = await handler(ev('GET', '/order', { query: t === undefined ? {} : { t } }));
    assert.ok([400, 404].includes(r.statusCode), 'expected a refusal for ' + String(t).slice(0, 12));
    assert.ok(!r.body.includes(made.orderId), 'the refusal must not leak the order id');
  }

  /* And the real token still works, so the test is not passing by accident. */
  const good = await handler(ev('GET', '/order', { query: { t: made.statusToken } }));
  assert.equal(good.statusCode, 200);
});

/* ------------------------------------------------------------ webhooks */

const sign = (body, key = 'whsec-test-key', url = NOTIFICATION_URL) =>
  createHmac('sha256', key).update(url + body, 'utf8').digest('base64');

test('an unsigned or wrongly signed webhook is refused', async () => {
  const { handler } = await bootstrap();
  const body = JSON.stringify({ event_id: 'e1', type: 'payment.updated', data: { object: { payment: { id: 'P', order_id: 'O', status: 'COMPLETED' } } } });

  assert.equal((await handler(ev('POST', '/webhooks/square', { body }))).statusCode, 401);
  assert.equal((await handler(ev('POST', '/webhooks/square', {
    body, headers: { 'x-square-hmacsha256-signature': 'bogus' }
  }))).statusCode, 401);
  assert.equal((await handler(ev('POST', '/webhooks/square', {
    body, headers: { 'x-square-hmacsha256-signature': sign(body, 'the-wrong-key') }
  }))).statusCode, 401);
});

test('a correctly signed webhook moves the order to paid, once', async () => {
  const { handler } = await bootstrap({ squareOverrides: { 'POST /v2/online-checkout/payment-links': LINK } });
  const made = J(await handler(ev('POST', '/checkout', {
    body: { attemptId: 'attempt-0000016', lines: [{ variationId: 'VAR_TEE_S', quantity: 1 }], fulfillment: PICKUP }
  })));

  const body = JSON.stringify({
    event_id: 'evt-paid-1', type: 'payment.updated',
    data: { object: { payment: { id: 'PAY1', order_id: made.orderId, status: 'COMPLETED', amount_money: { amount: 4500, currency: 'USD' } } } }
  });
  const h = { 'x-square-hmacsha256-signature': sign(body) };

  const first = await handler(ev('POST', '/webhooks/square', { body, headers: h }));
  assert.equal(first.statusCode, 200);
  assert.equal(JSON.parse(first.body).duplicate, undefined);

  /* Square redelivers routinely; the repeat is acknowledged and ignored. */
  const again = await handler(ev('POST', '/webhooks/square', { body, headers: h }));
  assert.equal(again.statusCode, 200);
  assert.equal(JSON.parse(again.body).duplicate, true);

  const status = J(await handler(ev('GET', '/order', { query: { t: made.statusToken } })));
  assert.equal(status.status, 'paid');
});

test('a late pending event cannot walk a paid order backwards', async () => {
  const { handler } = await bootstrap({ squareOverrides: { 'POST /v2/online-checkout/payment-links': LINK } });
  const made = J(await handler(ev('POST', '/checkout', {
    body: { attemptId: 'attempt-0000017', lines: [{ variationId: 'VAR_TEE_S', quantity: 1 }], fulfillment: PICKUP }
  })));
  const send = async (eventId, payload) => {
    const body = JSON.stringify({ event_id: eventId, ...payload });
    return handler(ev('POST', '/webhooks/square', { body, headers: { 'x-square-hmacsha256-signature': sign(body) } }));
  };
  await send('e-paid', { type: 'payment.updated', data: { object: { payment: { id: 'P', order_id: made.orderId, status: 'COMPLETED' } } } });
  await send('e-late', { type: 'order.updated', data: { object: { order_updated: { order_id: made.orderId, state: 'OPEN' } } } });

  const status = J(await handler(ev('GET', '/order', { query: { t: made.statusToken } })));
  assert.equal(status.status, 'paid');
});

test('a webhook for an order this site never made is acknowledged and ignored', async () => {
  const { handler } = await bootstrap();
  const body = JSON.stringify({
    event_id: 'evt-instore', type: 'payment.updated',
    data: { object: { payment: { id: 'P9', order_id: 'ORDER_FROM_THE_SHOP_FLOOR', status: 'COMPLETED' } } }
  });
  const r = await handler(ev('POST', '/webhooks/square', { body, headers: { 'x-square-hmacsha256-signature': sign(body) } }));
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).unknownOrder, true);
});

test('a canceled payment marks the order canceled', async () => {
  const { handler } = await bootstrap({ squareOverrides: { 'POST /v2/online-checkout/payment-links': LINK } });
  const made = J(await handler(ev('POST', '/checkout', {
    body: { attemptId: 'attempt-0000018', lines: [{ variationId: 'VAR_TEE_S', quantity: 1 }], fulfillment: PICKUP }
  })));
  const body = JSON.stringify({
    event_id: 'evt-cancel', type: 'payment.updated',
    data: { object: { payment: { id: 'P', order_id: made.orderId, status: 'CANCELED' } } }
  });
  await handler(ev('POST', '/webhooks/square', { body, headers: { 'x-square-hmacsha256-signature': sign(body) } }));
  const status = J(await handler(ev('GET', '/order', { query: { t: made.statusToken } })));
  assert.equal(status.status, 'canceled');
});

/* --------------------------------------------------------------- misc */

test('the stage prefix is stripped, and unknown routes 404', async () => {
  const { handler } = await bootstrap();
  assert.equal((await handler(ev('GET', '/catalog'))).statusCode, 200);
  assert.equal((await handler({ ...ev('GET', '/catalog'), rawPath: '/catalog' })).statusCode, 200);
  assert.equal((await handler(ev('GET', '/nope'))).statusCode, 404);
  assert.equal((await handler(ev('POST', '/catalog'))).statusCode, 404);
  assert.equal((await handler(ev('GET', '/checkout'))).statusCode, 404);
});

test('CORS answers the website origin and nobody else', async () => {
  const { handler } = await bootstrap();
  const pre = await handler(ev('OPTIONS', '/checkout'));
  assert.equal(pre.statusCode, 204);
  assert.equal(pre.headers['Access-Control-Allow-Origin'], ORIGIN);
  assert.equal(pre.headers['Access-Control-Allow-Methods'], 'GET,POST,OPTIONS');

  const other = await handler({ ...ev('OPTIONS', '/checkout'), headers: { origin: 'https://evil.example' } });
  assert.equal(other.headers['Access-Control-Allow-Origin'], undefined);
});

test('the refresh route needs the admin key, and only asks for a refresh', async () => {
  const { handler } = await bootstrap();
  assert.equal((await handler(ev('POST', '/catalog/refresh'))).statusCode, 403);
  assert.equal((await handler(ev('POST', '/catalog/refresh', { headers: { 'x-admin-key': 'wrong' } }))).statusCode, 403);

  /* Not running in Lambda, so there is nothing to invoke — but it must answer
     straight away either way rather than rebuilding inline and timing out. */
  const r = await handler(ev('POST', '/catalog/refresh', { headers: { 'x-admin-key': 'admin-test-key' } }));
  assert.ok([202, 503].includes(r.statusCode), r.body);
  assert.ok(typeof J(r).message === 'string');
});

test('the catalog status route reports what is live and when it was built', async () => {
  const { handler } = await bootstrap();
  assert.equal((await handler(ev('GET', '/admin/catalog'))).statusCode, 403);

  const r = await handler(ev('GET', '/admin/catalog', { headers: { 'x-admin-key': 'admin-test-key' } }));
  assert.equal(r.statusCode, 200);
  const b = J(r);
  assert.ok(b.live.buildId);
  assert.equal(b.live.counts.products, 2);
  assert.ok(b.live.ageSeconds >= 0);
  assert.ok(b.lastRefresh.lastSuccessAt > 0);
  assert.equal(b.lastRefresh.lastError, null);
});

test('a production token is accepted whatever it happens to start with', async () => {
  /* An earlier build guessed the environment from the token's prefix and
     refused anything beginning "EAAAl" in a production secret. Production
     tokens begin "EAAA" too, so that blocked a real deployment. The prefix
     means nothing here now. */
  const { handler } = await bootstrap({
    secrets: secretsFake({ SQUARE_ACCESS_TOKEN: 'EAAAlREALPRODUCTIONTOKEN', SQUARE_ENVIRONMENT: 'production' })
  });
  const r = await handler(ev('GET', '/catalog'));
  assert.equal(r.statusCode, 200, 'the shop must come up: ' + r.body);
});

test('no response anywhere carries the access token', async () => {
  const { handler } = await bootstrap({ squareOverrides: { 'POST /v2/online-checkout/payment-links': LINK } });
  const responses = [
    await handler(ev('GET', '/config')),
    await handler(ev('GET', '/catalog')),
    await handler(ev('POST', '/cart/validate', { body: { lines: [{ variationId: 'VAR_TEE_S', quantity: 1 }] } })),
    await handler(ev('POST', '/checkout', { body: { attemptId: 'attempt-0000019', lines: [{ variationId: 'VAR_TEE_S', quantity: 1 }], fulfillment: PICKUP } })),
    await handler(ev('GET', '/order', { query: { t: 'nope'.repeat(8) } }))
  ];
  for (const r of responses) {
    assert.ok(!r.body.includes('TOP-SECRET'), 'token leaked: ' + r.body.slice(0, 120));
    assert.ok(!r.body.includes('whsec-'), 'webhook key leaked');
    assert.ok(!r.body.includes('admin-test-key'), 'admin key leaked');
  }
});
