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
  const first = await store.claimIdempotency('key-1', { statusToken: 'tok-1' });
  assert.equal(first.claimed, true);
  assert.equal(first.statusToken, 'tok-1');

  const second = await store.claimIdempotency('key-1', { statusToken: 'tok-2' });
  assert.equal(second.claimed, false);
  assert.equal(second.state, 'in_progress');

  await store.completeIdempotency('key-1', { checkoutUrl: 'https://square.link/u/abc', orderId: 'O1' });
  const third = await store.claimIdempotency('key-1', { statusToken: 'tok-3' });
  assert.equal(third.claimed, false);
  assert.equal(third.state, 'done');
  assert.equal(third.record.result.checkoutUrl, 'https://square.link/u/abc');
});

test('the status token is written down before Square is ever called', async () => {
  const { d, store } = mk();
  await store.claimIdempotency('key-token', { statusToken: 'the-original-token' });
  const row = d.find('IDEM#key-token')[0];
  assert.equal(row.status, 'PENDING');
  assert.equal(row.statusToken, 'the-original-token',
    'a container killed after Square answers must be able to find this again');
});

test('a reservation left by a dead container is taken over, token and all', async () => {
  const { d, store } = mk();
  await store.claimIdempotency('key-stale', { statusToken: 'original-token' });

  const warm = await store.claimIdempotency('key-stale', { statusToken: 'new-token' });
  assert.equal(warm.claimed, false);
  assert.equal(warm.state, 'in_progress', 'still warm: wait rather than double-order');

  d.find('IDEM#key-stale')[0].createdAt = Date.now() - 60000;
  const recovered = await store.claimIdempotency('key-stale', { statusToken: 'new-token' });
  assert.equal(recovered.claimed, true);
  assert.equal(recovered.state, 'recovered');
  assert.equal(recovered.statusToken, 'original-token', 'the original token is kept, not replaced');
});

test('a failed attempt is handed straight back rather than wedged', async () => {
  const { store } = mk();
  await store.claimIdempotency('key-2', { statusToken: 'tok' });
  await store.markIdempotencyRecoverable('key-2');
  const again = await store.claimIdempotency('key-2', { statusToken: 'other' });
  assert.equal(again.claimed, true, 'no waiting around after a failure');
  assert.equal(again.statusToken, 'tok', 'still the first token');
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

test('a webhook is skipped only once it has actually finished', async () => {
  const { store } = mk();
  assert.equal(await store.beginWebhookEvent('evt-1'), 'new');
  assert.equal(await store.beginWebhookEvent('evt-1'), 'in_progress', 'claimed is not finished');

  await store.completeWebhookEvent('evt-1');
  assert.equal(await store.beginWebhookEvent('evt-1'), 'done');
  assert.equal(await store.beginWebhookEvent('evt-2'), 'new');
});

test('a webhook whose processing failed can be claimed again at once', async () => {
  const { store } = mk();
  assert.equal(await store.beginWebhookEvent('evt-boom'), 'new');
  await store.releaseWebhookEvent('evt-boom');
  assert.equal(await store.beginWebhookEvent('evt-boom'), 'new', 'the retry must get to do the work');
});

test('a webhook claim abandoned by a dead container is taken over', async () => {
  const { d, store } = mk();
  await store.beginWebhookEvent('evt-stuck');
  d.find('EVENT#evt-stuck')[0].startedAt = Date.now() - 60000;
  assert.equal(await store.beginWebhookEvent('evt-stuck'), 'new');
});

test('holds add up, exclude their own attempt and expire', async () => {
  const { d, store } = mk();
  const cap = new Map([['V1', 10]]);
  assert.equal((await store.acquireHolds('a1', [{ variationId: 'V1', quantity: 2 }], { availability: cap })).ok, true);
  assert.equal((await store.acquireHolds('a2', [{ variationId: 'V1', quantity: 3 }], { availability: cap })).ok, true);
  assert.equal(await store.heldQuantity('V1'), 5);
  assert.equal(await store.heldQuantity('V1', { excludeAttempt: 'a1' }), 3);

  /* A lapsed hold keeps holding: the payment link behind it is still live
     until cleanup has killed it. Only an explicit release frees the stock. */
  const row = d.find('HOLD#V1')[0];
  row.entries.find(e => e.attemptId === 'a2').expiresAt = Math.floor(Date.now() / 1000) - 1;
  assert.equal(await store.heldQuantity('V1'), 5, 'still held after the clock ran out');

  await store.releaseHolds('a2', ['V1']);
  assert.equal(await store.heldQuantity('V1'), 2);
  await store.releaseHolds('a1', ['V1']);
  assert.equal(await store.heldQuantity('V1'), 0);
});

test('nothing ever settled is nothing ever released', async () => {
  const { d, store } = mk();
  await store.acquireHolds('forgotten', [{ variationId: 'VB', quantity: 1 }],
    { availability: new Map([['VB', 5]]) });
  assert.equal(await store.heldQuantity('VB'), 1);

  /* Eight days on, with no confirmation from Square either way. The payment
     link behind this is still payable, so the unit is still spoken for. */
  d.find('HOLD#VB')[0].entries.forEach(e => {
    e.expiresAt = Math.floor(Date.now() / 1000) - (8 * 86400);
  });
  assert.equal(await store.heldQuantity('VB'), 1,
    'there is no age at which releasing unverified stock becomes safe');

  /* And DynamoDB must not do it for us behind our backs. */
  assert.equal(d.find('HOLD#VB')[0].ttl, undefined);
});

test('a hold is refused when there is no room, and takes nothing', async () => {
  const { store } = mk();
  const cap = new Map([['V1', 1]]);
  assert.equal((await store.acquireHolds('first', [{ variationId: 'V1', quantity: 1 }], { availability: cap })).ok, true);

  const second = await store.acquireHolds('second', [{ variationId: 'V1', quantity: 1 }], { availability: cap });
  assert.equal(second.ok, false);
  assert.equal(second.conflict.variationId, 'V1');
  assert.equal(second.conflict.available, 0);
  assert.equal(await store.heldQuantity('V1'), 1, 'the refused attempt left nothing behind');
});

test('a cart is held all or nothing', async () => {
  const { store } = mk();
  const cap = new Map([['V1', 5], ['V2', 0]]);
  const r = await store.acquireHolds('both', [
    { variationId: 'V1', quantity: 1 },
    { variationId: 'V2', quantity: 1 }
  ], { availability: cap });
  assert.equal(r.ok, false);
  assert.equal(await store.heldQuantity('V1'), 0,
    'the line that succeeded is rolled back, so nobody is half-reserved');
});

test('two concurrent acquisitions of the last unit: one wins', async () => {
  const d = fakeDynamo({ delay: true });
  const a = createStore({ tableName: 't', client: d.client });
  const b = createStore({ tableName: 't', client: d.client });
  const cap = new Map([['V9', 1]]);
  const [ra, rb] = await Promise.all([
    a.acquireHolds('racer-a', [{ variationId: 'V9', quantity: 1 }], { availability: cap }),
    b.acquireHolds('racer-b', [{ variationId: 'V9', quantity: 1 }], { availability: cap })
  ]);
  assert.equal([ra.ok, rb.ok].filter(Boolean).length, 1,
    'the compare-and-swap must settle it: ' + JSON.stringify([ra, rb]));
  assert.equal(await a.heldQuantity('V9'), 1);
});

test('stock that is not counted has no ceiling to enforce', async () => {
  const { store } = mk();
  const unknown = new Map([['VU', null]]);
  assert.equal((await store.acquireHolds('x', [{ variationId: 'VU', quantity: 3 }], { availability: unknown })).ok, true);
  assert.equal((await store.acquireHolds('y', [{ variationId: 'VU', quantity: 3 }], { availability: unknown })).ok, true);
});

test('BatchWriteItem leftovers are driven to completion, not dropped', async () => {
  const { d, store } = mk();
  d.dropNextBatchWrite('t');
  const snapshot = {
    products: Array.from({ length: 4000 }, (_, i) => ({
      id: 'I' + i, blob: Array.from({ length: 4 }, () => Math.random().toString(36).slice(2)).join('')
    })),
    fetchedAt: 'now', counts: { products: 4000 }
  };
  await store.writeCatalog('production', snapshot, 600);
  const read = await store.readCatalog('production');
  assert.ok(read, 'a dropped chunk would make the snapshot unreadable');
  assert.equal(read.snapshot.products.length, 4000);
});

test('token comparison does not leak length or content through an exception', () => {
  const t = newToken();
  assert.equal(tokensMatch(t, t), true);
  assert.equal(tokensMatch(t, t.slice(0, -1)), false);
  assert.equal(tokensMatch(t, newToken()), false);
});
