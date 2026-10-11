import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSquareClient } from '../lib/square.mjs';
import { buildCatalogSnapshot } from '../lib/catalog.mjs';
import { settings } from '../lib/config.mjs';
import { reconcileCart, cartFingerprint, PROBLEM } from '../lib/cart.mjs';
import { createStore } from '../lib/store.mjs';
import { fakeSquareFetch, squareHandlers, fakeDynamo, LOCATION, withEnv, baseEnv } from './helpers.mjs';

async function fixture(env = {}) {
  return withEnv(baseEnv(env), async () => {
    const square = createSquareClient(
      { host: 'https://connect.squareup.com', token: 't', squareVersion: 'v', locationId: LOCATION },
      { fetchImpl: fakeSquareFetch(squareHandlers()) }
    );
    const s = settings();
    const snapshot = await buildCatalogSnapshot(square, s);
    const ddb = fakeDynamo();
    const store = createStore({ tableName: 'asp-store-test', client: ddb.client });
    return { snapshot, s, store, ddb };
  });
}

test('a good cart prices itself from the catalog', async () => {
  const { snapshot, s, store } = await fixture();
  const r = await reconcileCart([{ variationId: 'VAR_TEE_S', quantity: 2 }], { snapshot, settings: s, store });
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.equal(r.totals.subtotal, 9000);          /* 2 x 4500, from Square */
  assert.equal(r.totals.itemCount, 2);
  assert.equal(r.lines[0].productName, 'Horseshoe Tee');
  assert.equal(r.lines[0].imageUrl, 'https://items.sandbox.example/tee.jpg');
  assert.deepEqual(r.lines[0].options, [{ name: 'Size', value: 'Small' }, { name: 'Color', value: 'Black' }]);
});

test('a price sent by the browser is reported, never charged', async () => {
  const { snapshot, s, store } = await fixture();
  const r = await reconcileCart(
    [{ variationId: 'VAR_TEE_S', quantity: 1, displayedPrice: 1 }],
    { snapshot, settings: s, store }
  );
  assert.equal(r.totals.subtotal, 4500, 'the catalog price, not the 1 cent the browser asked for');
  const problem = r.problems.find(p => p.code === PROBLEM.PRICE_CHANGED);
  assert.ok(problem);
  assert.equal(problem.was, 1);
  assert.equal(problem.now, 4500);
});

test('two lines for the same variation merge into one', async () => {
  const { snapshot, s, store } = await fixture();
  const r = await reconcileCart(
    [{ variationId: 'VAR_TEE_S', quantity: 1 }, { variationId: 'VAR_TEE_S', quantity: 2 }],
    { snapshot, settings: s, store }
  );
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].quantity, 3);
});

test('different variations of one product stay separate lines', async () => {
  const { snapshot, s, store } = await fixture();
  const r = await reconcileCart(
    [{ variationId: 'VAR_TEE_S', quantity: 1 }, { variationId: 'VAR_TEE_L', quantity: 1 }],
    { snapshot, settings: s, store }
  );
  assert.equal(r.payableLines.length, 2);
  assert.equal(r.totals.subtotal, 9000);
});

test('asking for more than there is reduces the line and says so', async () => {
  const { snapshot, s, store } = await fixture();
  const r = await reconcileCart([{ variationId: 'VAR_HAT_A', quantity: 10 }], { snapshot, settings: s, store });
  assert.equal(r.lines[0].quantity, 2, 'only 2 on hand');
  assert.equal(r.changed, true);
  const p = r.problems.find(x => x.code === PROBLEM.QUANTITY_REDUCED);
  assert.equal(p.requested, 10);
  assert.equal(p.available, 2);
});

test('a sold-out variation is removed with a reason', async () => {
  const { snapshot, s, store } = await fixture();
  const r = await reconcileCart([{ variationId: 'VAR_TEE_M', quantity: 1 }], { snapshot, settings: s, store });
  assert.equal(r.payableLines.length, 0);
  assert.equal(r.lines[0].removed, true);
  assert.equal(r.problems[0].code, PROBLEM.OUT_OF_STOCK);
});

test('a variation that has left the catalog is removed, not guessed at', async () => {
  const { snapshot, s, store } = await fixture();
  const r = await reconcileCart([{ variationId: 'VAR_GONE_FOREVER', quantity: 1 }], { snapshot, settings: s, store });
  assert.equal(r.problems[0].code, PROBLEM.UNAVAILABLE);
  assert.equal(r.lines[0].removed, true);
  assert.equal(r.totals.subtotal, 0);
});

test('a variable-price item cannot be carted', async () => {
  const { snapshot, s, store } = await fixture();
  const r = await reconcileCart([{ variationId: 'VAR_CUSTOM', quantity: 1 }], { snapshot, settings: s, store });
  /* It is not in the snapshot at all, so it reads as unavailable online. */
  assert.ok([PROBLEM.UNAVAILABLE, PROBLEM.NOT_SELLABLE].includes(r.problems[0].code));
  assert.equal(r.payableLines.length, 0);
});

test('soft holds from another attempt take stock off the shelf', async () => {
  const { snapshot, s, store } = await fixture();
  await store.placeHolds('other-attempt-1', [{ variationId: 'VAR_HAT_A', quantity: 2 }], { holdSeconds: 900 });

  const blocked = await reconcileCart([{ variationId: 'VAR_HAT_A', quantity: 2 }], { snapshot, settings: s, store });
  assert.equal(blocked.payableLines.length, 0, 'both units are held by someone else');
  assert.equal(blocked.problems[0].code, PROBLEM.OUT_OF_STOCK);

  /* The attempt that placed the hold is not blocked by its own hold. */
  const mine = await reconcileCart([{ variationId: 'VAR_HAT_A', quantity: 2 }],
    { snapshot, settings: s, store, attemptId: 'other-attempt-1' });
  assert.equal(mine.payableLines[0].quantity, 2);
});

test('rubbish input is refused rather than coerced', async () => {
  const { snapshot, s, store } = await fixture();
  const cases = [
    [null, 'not an array'],
    [[], 'empty'],
    [[{ variationId: 'VAR_TEE_S', quantity: 0 }], 'zero'],
    [[{ variationId: 'VAR_TEE_S', quantity: -3 }], 'negative'],
    [[{ variationId: 'VAR_TEE_S', quantity: 1.5 }], 'fractional'],
    [[{ variationId: '', quantity: 1 }], 'no id'],
    [[{ variationId: 'bad id with spaces', quantity: 1 }], 'unusable id'],
    [['not an object'], 'not an object']
  ];
  for (const [lines, label] of cases) {
    const r = await reconcileCart(lines, { snapshot, settings: s, store });
    assert.equal(r.ok, false, label + ' should be refused');
    assert.equal(r.error, 'BAD_CART');
  }
});

test('line and quantity ceilings hold', async () => {
  const { snapshot, s, store } = await fixture();
  const capped = await reconcileCart([{ variationId: 'VAR_TEE_L', quantity: 9999 }], { snapshot, settings: s, store });
  assert.ok(capped.lines[0].quantity <= s.maxLineQuantity);

  const tooMany = Array.from({ length: s.maxCartLines + 1 }, (_, i) => ({ variationId: 'VAR_X' + i, quantity: 1 }));
  const r = await reconcileCart(tooMany, { snapshot, settings: s, store });
  assert.equal(r.ok, false);
});

test('the fingerprint changes with the cart but not with line order', async () => {
  const a = [{ variationId: 'A', quantity: 1 }, { variationId: 'B', quantity: 2 }];
  const b = [{ variationId: 'B', quantity: 2 }, { variationId: 'A', quantity: 1 }];
  const f = { type: 'pickup', contact: { email: 'x@y.com' } };
  assert.equal(cartFingerprint(a, f), cartFingerprint(b, f), 'order does not matter');

  const changed = [{ variationId: 'A', quantity: 2 }, { variationId: 'B', quantity: 2 }];
  assert.notEqual(cartFingerprint(a, f), cartFingerprint(changed, f), 'a quantity change is a new attempt');

  assert.notEqual(
    cartFingerprint(a, { type: 'pickup', contact: { email: 'x@y.com' } }),
    cartFingerprint(a, { type: 'shipping', contact: { email: 'x@y.com' }, address: { postalCode: '11368', line1: '1 A St' } }),
    'switching to shipping is a new attempt'
  );
});

test('the cart never quotes tax or shipping', async () => {
  const { snapshot, s, store } = await fixture();
  const r = await reconcileCart([{ variationId: 'VAR_TEE_S', quantity: 1 }], { snapshot, settings: s, store });
  assert.equal(r.estimatedOnly, true);
  assert.equal(r.totals.tax, undefined);
  assert.equal(r.totals.shipping, undefined);
  assert.equal(r.totals.total, undefined);
});
