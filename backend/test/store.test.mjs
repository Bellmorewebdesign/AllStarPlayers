import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, sha256, newToken, tokensMatch } from '../lib/store.mjs';
import { fakeDynamo } from './helpers.mjs';

const mk = () => { const d = fakeDynamo(); return { d, store: createStore({ tableName: 't', client: d.client }) }; };

test('the catalog survives a round trip through gzipped chunks', async () => {
  const { store } = mk();
  const snapshot = {
    products: Array.from({ length: 900 }, (_, i) => ({
      id: 'ITEM' + i, name: 'Product ' + i, description: 'x'.repeat(200),
      variations: [{ id: 'V' + i, price: { amount: 1000 + i, currency: 'USD' } }]
    })),
    categories: [{ id: 'C', name: 'Tees' }], taxes: [], fetchedAt: '2026-10-11T00:00:00Z',
    counts: { products: 900 }
  };
  const written = await store.writeCatalog('production', snapshot, 600);
  assert.ok(written.chunkCount >= 1);

  const read = await store.readCatalog('production');
  assert.deepEqual(read.snapshot.products.length, 900);
  assert.equal(read.snapshot.products[899].name, 'Product 899');
  assert.equal(read.snapshot.products[500].variations[0].price.amount, 1500);
});

test('an expired cache reads as missing, but is still there as stale', async () => {
  const { d, store } = mk();
  await store.writeCatalog('production', { products: [{ id: 'A' }], fetchedAt: 'then', counts: {} }, 600);
  const manifest = d.find('CATALOG#production').find(r => r.sk === 'MANIFEST');
  manifest.expiresAt = Math.floor(Date.now() / 1000) - 10;

  assert.equal(await store.readCatalog('production'), null, 'too old to serve as fresh');
  const stale = await store.readCatalogStale('production');
  assert.equal(stale.stale, true);
  assert.equal(stale.snapshot.products[0].id, 'A');
});

test('a half-written cache is never stitched together', async () => {
  const { d, store } = mk();
  /* Random text so gzip cannot squeeze it into a single chunk. */
  const noise = n => Array.from({ length: n }, () => Math.random().toString(36).slice(2)).join('');
  await store.writeCatalog('production', {
    products: Array.from({ length: 4000 }, (_, i) => ({ id: 'I' + i, blob: noise(40) })),
    fetchedAt: 'now', counts: {}
  }, 600);
  const chunks = d.find('CATALOG#production').filter(r => String(r.sk).startsWith('CHUNK#'));
  assert.ok(chunks.length > 1, 'this snapshot really did need more than one chunk');
  d.rows.delete(chunks[0].pk + '\u0000' + chunks[0].sk);
  assert.equal(await store.readCatalog('production'), null);
});

test('only the first claim on an idempotency key wins', async () => {
  const { store } = mk();
  const first = await store.claimIdempotency('key-1');
  assert.equal(first.claimed, true);

  const second = await store.claimIdempotency('key-1');
  assert.equal(second.claimed, false);
  assert.equal(second.record.status, 'PENDING');

  await store.completeIdempotency('key-1', { checkoutUrl: 'https://square.link/u/abc', orderId: 'O1' });
  const third = await store.claimIdempotency('key-1');
  assert.equal(third.claimed, false);
  assert.equal(third.record.status, 'DONE');
  assert.equal(third.record.result.checkoutUrl, 'https://square.link/u/abc');
});

test('a released key can be claimed again', async () => {
  const { store } = mk();
  await store.claimIdempotency('key-2');
  await store.releaseIdempotency('key-2');
  assert.equal((await store.claimIdempotency('key-2')).claimed, true);
});

test('a status token reaches exactly one order and nothing else does', async () => {
  const { store } = mk();
  const token = newToken();
  await store.saveOrder({ orderId: 'ORDER_A', statusTokenHash: sha256(token), status: 'pending', lines: [] });
  assert.equal(await store.getOrderIdForToken(sha256(token)), 'ORDER_A');
  assert.equal(await store.getOrderIdForToken(sha256(newToken())), null, 'another token reaches nothing');
  assert.equal(await store.getOrderIdForToken(sha256('ORDER_A')), null, 'the order id is not a token');
});

test('an order status can only be updated on an order we created', async () => {
  const { store } = mk();
  await store.saveOrder({ orderId: 'O1', statusTokenHash: 'h', status: 'pending', lines: [] });
  await store.updateOrderStatus('O1', { status: 'paid' });
  assert.equal((await store.getOrder('O1')).status, 'paid');

  await assert.rejects(
    () => store.updateOrderStatus('ORDER_WE_NEVER_MADE', { status: 'paid' }),
    err => err.name === 'ConditionalCheckFailedException'
  );
});

test('a webhook event is only ever claimed once', async () => {
  const { store } = mk();
  assert.equal(await store.claimWebhookEvent('evt-1'), true);
  assert.equal(await store.claimWebhookEvent('evt-1'), false);
  assert.equal(await store.claimWebhookEvent('evt-2'), true);
});

test('holds add up, exclude their own attempt and expire', async () => {
  const { d, store } = mk();
  await store.placeHolds('a1', [{ variationId: 'V1', quantity: 2 }], { holdSeconds: 900 });
  await store.placeHolds('a2', [{ variationId: 'V1', quantity: 3 }], { holdSeconds: 900 });
  assert.equal(await store.heldQuantity('V1'), 5);
  assert.equal(await store.heldQuantity('V1', { excludeAttempt: 'a1' }), 3);

  /* DynamoDB deletes expired rows late, so the reader has to check the TTL. */
  const row = d.find('HOLD#V1').find(r => r.sk === 'ATTEMPT#a2');
  row.ttl = Math.floor(Date.now() / 1000) - 1;
  assert.equal(await store.heldQuantity('V1'), 2);

  await store.releaseHolds('a1', ['V1']);
  assert.equal(await store.heldQuantity('V1'), 0);
});

test('token comparison does not leak length or content through an exception', () => {
  const t = newToken();
  assert.equal(tokensMatch(t, t), true);
  assert.equal(tokensMatch(t, t.slice(0, -1)), false);
  assert.equal(tokensMatch(t, newToken()), false);
});
