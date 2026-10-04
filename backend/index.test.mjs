// Run: node --experimental-vm-modules --test backend/index.test.mjs
// Exercise the deployed handler contract without credentials or network access.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

const source = await readFile(new URL('./index.mjs', import.meta.url), 'utf8');
const variationId = 'T2APLGR5UFWGFELNUHGVNVI2';
const valid = { variationId, quantity: 1, idempotencyKey: 'test-attempt-123456' };

async function harness({ environment = 'sandbox', squareStatus = 200 } = {}) {
  const calls = [];
  const context = createContext({
    process: { env: { SECRET_ID: 'test-secret' } },
    console: { error() {} }, Buffer, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
      return {
        ok: squareStatus === 200, status: squareStatus,
        text: async () => JSON.stringify(squareStatus === 200 ? {
          payment_link: { id: 'test-link', order_id: 'test-order', url: 'https://sandbox.square.link/u/test' },
          objects: []
        } : { errors: [{ code: 'TEST_ERROR', detail: 'Test failure' }] })
      };
    }
  });
  const sdk = new SyntheticModule(['SecretsManagerClient', 'GetSecretValueCommand'], function () {
    this.setExport('SecretsManagerClient', class {
      async send() {
        return { SecretString: JSON.stringify({
          SQUARE_ENVIRONMENT: environment,
          SQUARE_ACCESS_TOKEN: 'fake-test-secret-token', SQUARE_LOCATION_ID: 'test-location'
        }) };
      }
    });
    this.setExport('GetSecretValueCommand', class {});
  }, { context });
  const crypto = new SyntheticModule(['createHash'], function () {
    this.setExport('createHash', createHash);
  }, { context });
  const module = new SourceTextModule(source, { context });
  await module.link(name => {
    if (name === '@aws-sdk/client-secrets-manager') return sdk;
    if (name === 'node:crypto') return crypto;
    throw new Error('Unexpected import: ' + name);
  });
  await module.evaluate();
  return {
    calls,
    async request(body, overrides = {}) {
      const response = await module.namespace.handler({
        rawPath: '/default/checkout',
        requestContext: { stage: 'default', http: { method: 'POST' } },
        body: JSON.stringify(body), ...overrides
      });
      assert.ok(!response.body.includes('fake-test-secret-token'));
      return { status: response.statusCode, data: JSON.parse(response.body) };
    }
  };
}

test('shipping collects an address; pickup sends a real fulfillment, with no browser price/fee/location overrides', async () => {
  const h = await harness();
  for (const fulfillment of ['shipping', 'pickup']) {
    const result = await h.request({ ...valid, fulfillment, price: 1, shipping_fee: 1,
      locationId: 'attacker', pickup_at: '2099-01-01', checkout_options: { allow_tipping: true } });
    assert.equal(result.status, 200);
    assert.equal(result.data.fulfillment, fulfillment);
    const call = h.calls.at(-1);
    assert.equal(call.url, 'https://connect.squareupsandbox.com/v2/online-checkout/payment-links');
    assert.deepEqual(call.body.order.line_items, [{ catalog_object_id: variationId, quantity: '1' }]);
    assert.equal(call.body.order.location_id, 'test-location');
    assert.deepEqual(call.body.checkout_options, {
      allow_tipping: false, ask_for_shipping_address: fulfillment === 'shipping'
    });
    if (fulfillment === 'pickup') {
      assert.equal(call.body.order.fulfillments.length, 1);
      const pickup = call.body.order.fulfillments[0];
      assert.equal(pickup.type, 'PICKUP');
      assert.equal(pickup.state, 'PROPOSED');
      assert.equal(pickup.pickup_details.schedule_type, 'ASAP');
      assert.equal(pickup.pickup_details.prep_time_duration, 'PT1H');
      assert.equal(pickup.pickup_details.pickup_at, undefined);
    } else assert.equal(call.body.order.fulfillments, undefined);
  }
});

test('unchanged retries are identical; reusing a browser key for the other choice cannot return the old link', async () => {
  const h = await harness();
  await h.request({ ...valid, fulfillment: 'pickup' });
  await h.request({ ...valid, fulfillment: 'pickup' });
  assert.deepEqual(h.calls[0].body, h.calls[1].body);
  await h.request({ ...valid, fulfillment: 'shipping' });
  assert.notEqual(h.calls[0].body.idempotency_key, h.calls[2].body.idempotency_key);
  assert.ok(h.calls[0].body.idempotency_key.length <= 192);
});

test('old pages still get shipping; invalid choices and item/quantity tampering never reach Square', async () => {
  const h = await harness();
  assert.equal((await h.request(valid)).data.fulfillment, 'shipping');
  const invalid = [null, [], { ...valid, fulfillment: 'delivery' }, { ...valid, fulfillment: null },
    { ...valid, fulfillment: {} }, { ...valid, variationId: 'other' }, { ...valid, quantity: 2 }];
  for (const body of invalid) assert.equal((await h.request(body)).status, 400);
  assert.equal(h.calls.length, 1);
});

test('production secrets are refused and Square failures stay inside the JSON handler', async () => {
  const production = await harness({ environment: 'production' });
  assert.equal((await production.request({ ...valid, fulfillment: 'pickup' })).data.error, 'CONFIG_ERROR');
  assert.equal(production.calls.length, 0);
  const failing = await harness({ squareStatus: 500 });
  const result = await failing.request({ ...valid, fulfillment: 'pickup' });
  assert.equal(result.status, 502);
  assert.equal(result.data.error, 'SQUARE_ERROR');
});
