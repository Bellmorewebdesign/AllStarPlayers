/* ==========================================================================
   Abandoned checkouts: cancelling the link before freeing the stock.
   --------------------------------------------------------------------------
   The thing being guarded against is a Square payment link that outlives the
   hold on its stock. Every test here asks the same question in a different
   way: did we free a unit that something could still buy?
   ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  fakeDynamo, fakeSquareFetch, squareHandlers, LOCATION, baseEnv, secretsFake, INVENTORY
, warmCatalog } from './helpers.mjs';

const ORIGIN = 'https://bellmorewebdesign.github.io';
const NOTIFICATION_URL = 'https://n9ecaydkv4.execute-api.us-east-1.amazonaws.com/default/webhooks/square';

/* A Square stand-in that keeps order state, so a delete can be made to
   "succeed" without actually cancelling anything — the behaviour the
   developer forums report and the reason the code re-reads. */
function squareWorld({ stock = {}, deleteBehaviour = 'cancels' } = {}) {
  const counts = { ...INVENTORY, ...stock };
  const orders = new Map();          /* orderId -> { state, tenders, version } */
  const links = new Map();           /* linkId  -> orderId */
  const log = [];
  let seq = 0;

  const world = {
    counts, orders, links, log,
    setOrderState(orderId, state) { orders.get(orderId).state = state; },
    addTender(orderId) { orders.get(orderId).tenders = [{ id: 'T' }]; },
    deleteBehaviour,
    /* A hook that runs the moment the delete is processed, for racing a
       payment against cleanup. */
    onDelete: null,
    handlers(extra = {}) {
      return squareHandlers({
        'POST /v2/inventory/counts/batch-retrieve': ({ body }) => ({
          json: {
            counts: (body.catalog_object_ids || [])
              .filter(id => counts[id] !== undefined)
              .map(id => ({ catalog_object_id: id, location_id: LOCATION, state: 'IN_STOCK', quantity: String(counts[id]) }))
          }
        }),
        'POST /v2/online-checkout/payment-links': () => {
          seq++;
          const orderId = 'ORDER_' + seq;
          const linkId = 'PL_' + seq;
          orders.set(orderId, { state: 'OPEN', tenders: [], version: 1 });
          links.set(linkId, orderId);
          return { json: { payment_link: { id: linkId, order_id: orderId, url: 'https://square.link/u/l' + seq } } };
        },
        'GET /v2/orders/*': ({ path }) => {
          const id = decodeURIComponent(path.split('/').pop());
          const o = orders.get(id);
          if (!o) return { status: 404, json: { errors: [{ code: 'NOT_FOUND' }] } };
          return { json: { order: {
            id, state: o.state, version: o.version,
            tenders: o.tenders,
            total_money: { amount: 4500, currency: 'USD' },
            net_amount_due_money: { amount: o.state === 'COMPLETED' ? 0 : 4500, currency: 'USD' },
            line_items: [], fulfillments: []
          } } };
        },
        'DELETE /v2/online-checkout/payment-links/*': ({ path }) => {
          const linkId = decodeURIComponent(path.split('/').pop());
          log.push('DELETE ' + linkId);
          if (world.onDelete) world.onDelete(links.get(linkId));
          if (world.deleteBehaviour === 'error') {
            return { status: 500, json: { errors: [{ code: 'INTERNAL_SERVER_ERROR' }] } };
          }
          if (world.deleteBehaviour === 'gone') {
            return { status: 404, json: { errors: [{ code: 'NOT_FOUND' }] } };
          }
          const orderId = links.get(linkId);
          if (world.deleteBehaviour === 'cancels') {
            links.delete(linkId);
            if (orders.has(orderId)) orders.get(orderId).state = 'CANCELED';
            return { json: { id: linkId, cancelled_order_id: orderId } };
          }
          /* 'lies': 200, no cancelled_order_id, order untouched and the link
             still payable. Exactly what the forum reports describe. */
          return { json: { id: linkId } };
        },
        ...extra
      });
    }
  };
  return world;
}

async function bootstrap({ env = {}, world, ddb: shared, seed = true } = {}) {
  for (const [k, v] of Object.entries({ ...baseEnv(), WEBHOOK_NOTIFICATION_URL: NOTIFICATION_URL, ...env })) {
    if (v === null) delete process.env[k]; else process.env[k] = v;
  }
  const stamp = '?t=' + Math.random() + Math.random();
  const config = await import('../lib/config.mjs' + stamp);
  const square = await import('../lib/square.mjs' + stamp);
  const store = await import('../lib/store.mjs' + stamp);

  const ddb = shared || fakeDynamo();
  const fetchImpl = fakeSquareFetch(world.handlers());
  config.resetSecretCache();

  const { makeHandler } = await import('./harness.mjs' + stamp);
  const handler = await makeHandler({
    configMod: { ...config, loadSecrets: () => config.loadSecrets({ client: secretsFake() }) },
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
const ADMIN = { 'x-admin-key': 'admin-test-key' };

const held = (ddb, v) => ddb.find('HOLD#' + v)
  .reduce((n, row) => n + (row.entries || []).reduce((m, e) => m + Number(e.qty || 0), 0), 0);

/* Make every queued job due now. */
function makeDue(ddb) {
  for (const row of ddb.find('SWEEP')) {
    const old = row.sk;
    ddb.rows.delete(row.pk + '\u0000' + old);
    row.sk = '000000000001#' + row.attemptId;
    row.dueAt = 1;
    ddb.rows.set(row.pk + '\u0000' + row.sk, row);
  }
}

async function buy(handler, { attemptId, variationId = 'VAR_HAT_A', quantity = 1 }) {
  return handler(ev('POST', '/checkout', {
    body: { attemptId, lines: [{ variationId, quantity }], fulfillment: PICKUP }
  }));
}
const sweep = (handler) => handler(ev('POST', '/admin/sweep', { headers: ADMIN }));

/* ====================================================================== */

test('a checkout leaves a cleanup job behind', async () => {
  const world = squareWorld({ stock: { VAR_HAT_A: 2 } });
  const { handler, ddb } = await bootstrap({ world });
  await buy(handler, { attemptId: 'leaves-a-job1' });

  const jobs = ddb.find('SWEEP');
  assert.equal(jobs.length, 1, 'a hold that outlives its clock needs something to settle it');
  assert.equal(jobs[0].attemptId, 'leaves-a-job1');
  assert.ok(jobs[0].orderId && jobs[0].paymentLinkId, jobs[0]);
  assert.deepEqual(jobs[0].variationIds, ['VAR_HAT_A']);
  /* Due after the hold plus the grace period, not immediately. */
  assert.ok(jobs[0].dueAt > Math.floor(Date.now() / 1000) + 900, jobs[0].dueAt);
});

test('a job that is not due yet is left alone', async () => {
  const world = squareWorld({ stock: { VAR_HAT_A: 2 } });
  const { handler, ddb } = await bootstrap({ world });
  await buy(handler, { attemptId: 'not-due-yet1' });

  const tally = J(await sweep(handler)).swept;
  assert.equal(tally.considered, 0, 'the customer is still inside their window');
  assert.equal(held(ddb, 'VAR_HAT_A'), 1, 'and still holds the unit');
  assert.equal(world.log.length, 0, 'nothing was cancelled');
});

test('an abandoned checkout is cancelled, and only then is the stock freed', async () => {
  const world = squareWorld({ stock: { VAR_HAT_A: 1 } });
  const { handler, ddb } = await bootstrap({ world });
  await buy(handler, { attemptId: 'abandoned-001' });
  assert.equal(held(ddb, 'VAR_HAT_A'), 1);

  makeDue(ddb);
  const tally = J(await sweep(handler)).swept;
  assert.equal(tally.canceled, 1, JSON.stringify(tally));
  assert.equal(world.log.length, 1, 'the link was deleted');
  assert.equal([...world.orders.values()][0].state, 'CANCELED');
  assert.equal(held(ddb, 'VAR_HAT_A'), 0, 'now, and only now, the unit goes back');
  assert.equal(ddb.find('SWEEP').length, 0, 'the job is finished with');

  /* And the next shopper can have it. */
  const next = await buy(handler, { attemptId: 'next-shopper1' });
  assert.equal(next.statusCode, 200, next.body);
});

test('a delete that answers 200 but cancels nothing does NOT free the stock', async () => {
  /* The behaviour reported on Square's developer forums: 200, no
     cancelled_order_id, order still live, link still payable. */
  const world = squareWorld({ stock: { VAR_HAT_A: 1 }, deleteBehaviour: 'lies' });
  const { handler, ddb } = await bootstrap({ world });
  await buy(handler, { attemptId: 'lying-delete1' });
  makeDue(ddb);

  const tally = J(await sweep(handler)).swept;
  assert.equal(tally.stillLive, 1, JSON.stringify(tally));
  assert.equal(held(ddb, 'VAR_HAT_A'), 1,
    'the link can still be paid, so the unit must stay held');
  assert.equal([...world.orders.values()][0].state, 'OPEN');

  const blocked = await buy(handler, { attemptId: 'other-shopper' });
  assert.equal(blocked.statusCode, 409, 'nobody else may be sold it');

  const job = ddb.find('SWEEP')[0];
  assert.ok(job, 'the job survives to be tried again');
  assert.equal(job.attempts, 1);
});

test('an order already paid frees its hold without any cancelling', async () => {
  const world = squareWorld({ stock: { VAR_HAT_A: 1 } });
  const { handler, ddb } = await bootstrap({ world });
  await buy(handler, { attemptId: 'already-paid1' });
  const orderId = ddb.find('SWEEP')[0].orderId;
  world.setOrderState(orderId, 'COMPLETED');
  makeDue(ddb);

  const tally = J(await sweep(handler)).swept;
  assert.equal(tally.paid, 1, JSON.stringify(tally));
  assert.equal(world.log.length, 0, 'you do not cancel an order somebody paid for');
  /* Square decremented the catalog itself, so holding it too would keep the
     same unit off the shelf twice. */
  assert.equal(held(ddb, 'VAR_HAT_A'), 0);
});

test('a payment in flight is left well alone', async () => {
  const world = squareWorld({ stock: { VAR_HAT_A: 1 } });
  const { handler, ddb } = await bootstrap({ world });
  await buy(handler, { attemptId: 'in-flight-01' });
  const orderId = ddb.find('SWEEP')[0].orderId;
  world.addTender(orderId);                 /* money moving, not yet complete */
  makeDue(ddb);

  const tally = J(await sweep(handler)).swept;
  assert.equal(tally.retried, 1, JSON.stringify(tally));
  assert.equal(world.log.length, 0, 'the link must not be pulled mid-payment');
  assert.equal(held(ddb, 'VAR_HAT_A'), 1);
});

test('a payment that lands between the delete and the check counts as paid', async () => {
  const world = squareWorld({ stock: { VAR_HAT_A: 1 }, deleteBehaviour: 'lies' });
  const { handler, ddb } = await bootstrap({ world });
  await buy(handler, { attemptId: 'race-the-pay' });
  /* The customer pays at the exact moment we ask for the link to go. */
  world.onDelete = (orderId) => { world.setOrderState(orderId, 'COMPLETED'); };
  makeDue(ddb);

  const tally = J(await sweep(handler)).swept;
  assert.equal(tally.paid, 1, JSON.stringify(tally));
  assert.equal(tally.canceled, 0, 'it must never be reported as cancelled');
  assert.equal(held(ddb, 'VAR_HAT_A'), 0, 'Square has the stock now');
  assert.equal(ddb.find('SWEEP').length, 0);
});

test('Square being unreachable retries and frees nothing', async () => {
  const world = squareWorld({ stock: { VAR_HAT_A: 1 }, deleteBehaviour: 'error' });
  const { handler, ddb } = await bootstrap({ world });
  await buy(handler, { attemptId: 'square-is-out' });
  makeDue(ddb);

  const tally = J(await sweep(handler)).swept;
  assert.equal(tally.retried, 1, JSON.stringify(tally));
  assert.equal(held(ddb, 'VAR_HAT_A'), 1, 'we could not confirm, so we hold');
  const job = ddb.find('SWEEP')[0];
  assert.equal(job.attempts, 1);
  assert.ok(job.dueAt > Math.floor(Date.now() / 1000), 'and it comes back later');
});

test('a link already gone still has to prove its order is dead', async () => {
  const world = squareWorld({ stock: { VAR_HAT_A: 1 }, deleteBehaviour: 'gone' });
  const { handler, ddb } = await bootstrap({ world });
  await buy(handler, { attemptId: 'link-is-gone' });
  makeDue(ddb);

  /* 404 on the delete means the link is not there. The order, though, is
     still OPEN — so there is nothing proving a payment cannot land. */
  const tally = J(await sweep(handler)).swept;
  assert.equal(tally.stillLive, 1, JSON.stringify(tally));
  assert.equal(held(ddb, 'VAR_HAT_A'), 1);

  /* Once the order really is cancelled, the next pass frees it. */
  world.setOrderState([...world.orders.keys()][0], 'CANCELED');
  makeDue(ddb);
  const second = J(await sweep(handler)).swept;
  assert.equal(second.canceled, 1, JSON.stringify(second));
  assert.equal(held(ddb, 'VAR_HAT_A'), 0);
});

test('an order Square has never heard of is not worth holding stock for', async () => {
  const world = squareWorld({ stock: { VAR_HAT_A: 1 } });
  const { handler, ddb } = await bootstrap({ world });
  await buy(handler, { attemptId: 'ghost-order1' });
  world.orders.clear();                      /* Square 404s it */
  makeDue(ddb);

  const tally = J(await sweep(handler)).swept;
  assert.equal(tally.gone, 1, JSON.stringify(tally));
  assert.equal(held(ddb, 'VAR_HAT_A'), 0);
});

test('a job that will not settle is retried, then flagged, and never silently freed', async () => {
  const world = squareWorld({ stock: { VAR_HAT_A: 1 }, deleteBehaviour: 'lies' });
  const { handler, ddb } = await bootstrap({ world, env: { CLEANUP_MAX_ATTEMPTS: '3' } });
  await buy(handler, { attemptId: 'never-settles' });

  for (let i = 0; i < 5; i++) {
    makeDue(ddb);
    await sweep(handler);
  }
  const job = ddb.find('SWEEP')[0];
  assert.ok(job, 'it is still on the list');
  assert.equal(job.stuck, true, 'and flagged for a person to look at');
  assert.ok(job.attempts >= 3, job.attempts);
  assert.equal(held(ddb, 'VAR_HAT_A'), 1,
    'an un-cancelled link is worse than a unit off the shelf, so it stays held');
});

test('running the sweep twice does not double up', async () => {
  const world = squareWorld({ stock: { VAR_HAT_A: 2 } });
  const { handler, ddb } = await bootstrap({ world });
  await buy(handler, { attemptId: 'twice-is-fine' });
  makeDue(ddb);
  const a = J(await sweep(handler)).swept;
  const b = J(await sweep(handler)).swept;
  assert.equal(a.canceled, 1);
  assert.equal(b.considered, 0, 'nothing left to do');
  assert.equal(held(ddb, 'VAR_HAT_A'), 0);
});

/* ---------------- a cancelled link must never come back ----------------- */

test('idempotency replay cannot hand back a cancelled checkout', async () => {
  const world = squareWorld({ stock: { VAR_HAT_A: 3 } });
  const { handler, ddb } = await bootstrap({ world });
  const body = { attemptId: 'replay-after-x', lines: [{ variationId: 'VAR_HAT_A', quantity: 1 }], fulfillment: PICKUP };

  const first = J(await handler(ev('POST', '/checkout', { body })));
  const deadUrl = first.checkoutUrl;

  /* While the customer was away, cleanup killed that link. */
  makeDue(ddb);
  assert.equal(J(await sweep(handler)).swept.canceled, 1);

  /* They come back and press Pay on the same cart. */
  const second = J(await handler(ev('POST', '/checkout', { body })));
  assert.notEqual(second.checkoutUrl, deadUrl, 'the dead link must not be replayed');
  assert.equal(second.renewed, true);
  assert.notEqual(second.orderId, first.orderId, 'a new order, not the cancelled one');
  assert.notEqual(second.statusToken, first.statusToken, 'and its own status token');

  /* The new link really is alive. */
  assert.equal(world.orders.get(second.orderId).state, 'OPEN');
  assert.equal(world.orders.get(first.orderId).state, 'CANCELED');

  /* And a retry of the NEW attempt still replays properly. */
  const third = J(await handler(ev('POST', '/checkout', { body })));
  assert.equal(third.checkoutUrl, second.checkoutUrl);
  assert.equal(third.replayed, true);
});

test('the status token of a cancelled order reports cancelled, and keeps the cart', async () => {
  const world = squareWorld({ stock: { VAR_HAT_A: 2 } });
  const { handler, ddb } = await bootstrap({ world });
  const made = J(await buy(handler, { attemptId: 'token-cancelled' }));
  makeDue(ddb);
  await sweep(handler);

  const status = J(await handler(ev('GET', '/order', { query: { t: made.statusToken } })));
  assert.equal(status.status, 'canceled');
  assert.equal(status.verified, true, 'confirmed with Square, not assumed');
});

test('a webhook arriving after cleanup does not resurrect anything', async () => {
  const world = squareWorld({ stock: { VAR_HAT_A: 2 } });
  const { handler, ddb } = await bootstrap({ world });
  const made = J(await buy(handler, { attemptId: 'late-webhook1' }));
  makeDue(ddb);
  await sweep(handler);

  const payload = JSON.stringify({
    event_id: 'evt-late-open', type: 'order.updated',
    data: { object: { order_updated: { order_id: made.orderId, state: 'OPEN' } } }
  });
  const r = await handler(ev('POST', '/webhooks/square', {
    body: payload,
    headers: { 'x-square-hmacsha256-signature':
      createHmac('sha256', 'whsec-test-key').update(NOTIFICATION_URL + payload, 'utf8').digest('base64') }
  }));
  assert.equal(r.statusCode, 200);
  const status = J(await handler(ev('GET', '/order', { query: { t: made.statusToken } })));
  assert.equal(status.status, 'canceled', 'still cancelled');
});

/* ------------------------- how it gets invoked -------------------------- */

test('EventBridge can run the sweep without any public route', async () => {
  const world = squareWorld({ stock: { VAR_HAT_A: 2 } });
  const { handler, ddb } = await bootstrap({ world });
  await buy(handler, { attemptId: 'scheduled-run' });
  makeDue(ddb);

  /* A plain object, not an HTTP event. */
  const tally = await handler({ task: 'sweep-abandoned-checkouts' });
  assert.equal(tally.canceled, 1, JSON.stringify(tally));
  assert.equal(held(ddb, 'VAR_HAT_A'), 0);
});

test('the manual sweep route needs the admin key', async () => {
  const world = squareWorld();
  const { handler } = await bootstrap({ world });
  assert.equal((await handler(ev('POST', '/admin/sweep'))).statusCode, 403);
  assert.equal((await handler(ev('POST', '/admin/sweep', { headers: { 'x-admin-key': 'nope' } }))).statusCode, 403);
  assert.equal((await handler(ev('POST', '/admin/sweep', { headers: ADMIN }))).statusCode, 200);
});
