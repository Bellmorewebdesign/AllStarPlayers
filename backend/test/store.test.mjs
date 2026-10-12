import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, sha256, newToken, tokensMatch } from '../lib/store.mjs';
import { fakeDynamo } from './helpers.mjs';

const mk = () => { const d = fakeDynamo(); return { d, store: createStore({ tableName: 't', client: d.client }) }; };

const bigSnapshot = (n = 900) => ({
  products: Array.from({ length: n }, (_, i) => ({
    id: 'ITEM' + i, name: 'Product ' + i, description: 'x'.repeat(200),
    variations: [{ id: 'V' + i, price: { amount: 1000 + i, currency: 'USD' } }]
  })),
  categories: [{ id: 'C', name: 'Tees' }], taxes: [],
  fetchedAt: '2026-10-12T00:00:00Z', counts: { products: n }
});

const publish = async (store, env, snapshot) => {
  const buildId = store.newBuildId();
  await store.noteCatalogBuild(env, buildId);
  const written = await store.writeCatalogBuild(env, buildId, snapshot);
  await store.publishCatalogBuild(env, {
    buildId, chunkCount: written.chunkCount, bytes: written.bytes,
    fetchedAt: snapshot.fetchedAt, counts: snapshot.counts
  });
  await store.pruneCatalogBuilds(env, buildId);
  return { buildId, written };
};

test('a published catalog survives a round trip through gzipped chunks', async () => {
  const { store } = mk();
  const snapshot = bigSnapshot(900);
  const { buildId } = await publish(store, 'production', snapshot);

  const read = await store.readCatalogSnapshot('production');
  assert.equal(read.buildId, buildId);
  assert.equal(read.snapshot.products.length, 900);
  assert.equal(read.snapshot.products[899].name, 'Product 899');
  assert.equal(read.snapshot.products[500].variations[0].price.amount, 1500);
});

test('a half-written build is invisible: the old catalog keeps serving', async () => {
  const { d, store } = mk();
  const first = await publish(store, 'production', bigSnapshot(50));

  /* A refresh starts, writes some of its chunks, and the container dies. */
  const buildId = store.newBuildId();
  await store.noteCatalogBuild('production', buildId);
  await store.writeCatalogBuild('production', buildId, noisySnapshot(4000));
  /* publishCatalogBuild is never reached. */

  const read = await store.readCatalogSnapshot('production');
  assert.equal(read.buildId, first.buildId, 'still the complete one');
  assert.equal(read.snapshot.products.length, 50);
  assert.equal(read.unreadable, false);

  /* And the next successful refresh sweeps the orphan away. */
  const third = await publish(store, 'production', bigSnapshot(60));
  assert.equal(d.find('CATALOG#production#B' + buildId).length, 0, 'the abandoned build is gone');
  assert.equal((await store.readCatalogSnapshot('production')).buildId, third.buildId);
});

test('a build with fewer chunks than its predecessor is still readable', async () => {
  /* The old design wrote every build to the same keys, so shrinking left
     orphan chunks behind and the count never matched again. */
  const { store } = mk();
  await publish(store, 'production', noisySnapshot(4000));
  const small = await publish(store, 'production', bigSnapshot(5));
  const read = await store.readCatalogSnapshot('production');
  assert.equal(read.buildId, small.buildId);
  assert.equal(read.snapshot.products.length, 5);
});

/* Random text, because gzip squeezes repeated filler into a single chunk. */
const noisySnapshot = (n) => ({
  products: Array.from({ length: n }, (_, i) => ({
    id: 'I' + i, blob: Array.from({ length: 8 }, () => Math.random().toString(36).slice(2)).join('')
  })),
  categories: [], taxes: [], fetchedAt: 'now', counts: { products: n }
});

test('a pointer to chunks that will not read back is reported, not guessed at', async () => {
  const { d, store } = mk();
  const { buildId } = await publish(store, 'production', noisySnapshot(4000));
  const chunks = d.find('CATALOG#production#B' + buildId);
  assert.ok(chunks.length > 1, 'this snapshot needed more than one chunk');
  d.rows.delete(chunks[0].pk + '\u0000' + chunks[0].sk);

  const read = await store.readCatalogSnapshot('production');
  assert.equal(read.unreadable, true);
  assert.equal(read.snapshot, null);
});

test('no catalog at all reads as nothing, not as an empty shop', async () => {
  const { store } = mk();
  assert.equal(await store.readCatalogSnapshot('production'), null);
  assert.equal(await store.readCatalogPointer('production'), undefined ?? null);
});

test('the refresh lease admits one holder and expires on its own', async () => {
  const { d, store } = mk();
  assert.equal((await store.acquireCatalogLock('production', { holder: 'a', leaseSeconds: 600 })).acquired, true);

  const second = await store.acquireCatalogLock('production', { holder: 'b', leaseSeconds: 600 });
  assert.equal(second.acquired, false);
  assert.equal(second.heldBy, 'a');

  /* A container killed mid-refresh must not wedge the schedule forever. */
  d.find('CATALOG#production').find(r => r.sk === 'LOCK').leaseUntil = Math.floor(Date.now() / 1000) - 1;
  assert.equal((await store.acquireCatalogLock('production', { holder: 'c' })).acquired, true);
});

test('releasing somebody else\'s lease does nothing', async () => {
  const { store } = mk();
  await store.acquireCatalogLock('production', { holder: 'a', leaseSeconds: 600 });
  await store.releaseCatalogLock('production', 'someone-else');
  assert.equal((await store.acquireCatalogLock('production', { holder: 'b' })).acquired, false,
    'a stray release must not hand the lease to the next caller');
  await store.releaseCatalogLock('production', 'a');
  assert.equal((await store.acquireCatalogLock('production', { holder: 'b' })).acquired, true);
});

test('sandbox and production keep entirely separate catalogs', async () => {
  const { store } = mk();
  await publish(store, 'production', bigSnapshot(10));
  await publish(store, 'sandbox', bigSnapshot(3));
  assert.equal((await store.readCatalogSnapshot('production')).snapshot.products.length, 10);
  assert.equal((await store.readCatalogSnapshot('sandbox')).snapshot.products.length, 3);
  assert.equal((await store.acquireCatalogLock('sandbox', { holder: 'x' })).acquired, true);
  assert.equal((await store.acquireCatalogLock('production', { holder: 'x' })).acquired, true,
    'the two leases are independent');
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
  const buildId = store.newBuildId();
  const written = await store.writeCatalogBuild('production', buildId, snapshot);
  await store.publishCatalogBuild('production', {
    buildId, chunkCount: written.chunkCount, fetchedAt: 'now', counts: snapshot.counts
  });
  const read = await store.readCatalogSnapshot('production');
  assert.ok(read && !read.unreadable, 'a dropped chunk would make the build unreadable');
  assert.equal(read.snapshot.products.length, 4000);
});

test('token comparison does not leak length or content through an exception', () => {
  const t = newToken();
  assert.equal(tokensMatch(t, t), true);
  assert.equal(tokensMatch(t, t.slice(0, -1)), false);
  assert.equal(tokensMatch(t, newToken()), false);
});
