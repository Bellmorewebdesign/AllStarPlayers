/* ==========================================================================
   Reading a catalog while it is being replaced
   --------------------------------------------------------------------------
   Publishing is atomic, but the things around it were not. A reader that had
   already decided which build to read could have it deleted underneath them,
   and a client paging through the shop could be handed two pages from two
   different builds and quietly stitch them together.

   Plus the opposite mistake: refusing to publish a catalog that is empty
   because everything genuinely sold out, and leaving yesterday's products on
   the website instead.
   ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fakeDynamo, fakeSquareFetch, squareHandlers, LOCATION, baseEnv, secretsFake, catalogFixture, INVENTORY
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
  return { handler, ddb, calls: fetchImpl.calls, storeMod: store };
}

const ev = (method, path, { query, body, headers } = {}) => ({
  rawPath: '/default' + path,
  requestContext: { stage: 'default', http: { method }, requestId: 'r' },
  headers: { origin: ORIGIN, ...(headers || {}) },
  queryStringParameters: query || null,
  body: body === undefined ? undefined : JSON.stringify(body)
});
const J = r => JSON.parse(r.body);
const refresh = (handler) => handler({ task: 'refresh-catalog' });

/* A catalog of N plain items, so page boundaries are easy to reason about. */
function itemsFixture(names) {
  const variation = (id) => ({
    type: 'ITEM_VARIATION', id: 'VAR_' + id, present_at_all_locations: true,
    item_variation_data: {
      name: 'Regular', pricing_type: 'FIXED_PRICING',
      price_money: { amount: 1000, currency: 'USD' }, track_inventory: true
    }
  });
  return {
    objects: names.map(n => ({
      type: 'ITEM', id: 'ITEM_' + n, present_at_all_locations: true,
      item_data: { name: n, product_type: 'REGULAR', variations: [variation(n)] }
    }))
  };
}
const stockFor = (names) => ({
  json: { counts: names.map(n => ({
    catalog_object_id: 'VAR_' + n, location_id: LOCATION, state: 'IN_STOCK', quantity: '5'
  })) }
});

/* ======================================================================
   1. Pruning must not pull a build out from under a reader
   ====================================================================== */

test('a build that has just been superseded is kept for readers still using it', async () => {
  const ddb = fakeDynamo();
  const { handler } = await bootstrap({ ddb });
  const a = await refresh(handler);
  assert.equal(a.refreshed, true);

  const b = await refresh(handler);
  assert.equal(b.refreshed, true);
  assert.notEqual(b.buildId, a.buildId);

  /* A reader that read the pointer a moment before the flip is still mid-way
     through fetching A's chunks. Those chunks must still be there. */
  const chunksOfA = ddb.find('CATALOG#production#B' + a.buildId);
  assert.ok(chunksOfA.length > 0,
    'the build just replaced was deleted immediately, which strands anybody reading it');
});

test('a reader whose build vanishes retries against the new pointer', async () => {
  const ddb = fakeDynamo();
  const { handler, storeMod } = await bootstrap({ ddb });
  const a = await refresh(handler);
  let b = null;

  /* Interleave for real. The reader is given a client that, the first time it
     asks for build A's chunks, lets a refresh publish B and delete A before
     answering. So the reader has already chosen A, and A is gone by the time
     it looks: exactly the race that used to surface as a broken catalog. */
  let interrupted = false;
  const client = {
    async send(cmd) {
      const pk = cmd.input?.ExpressionAttributeValues?.[':pk']?.S;
      if (!interrupted && cmd.constructor.name === 'QueryCommand'
          && pk === 'CATALOG#production#B' + a.buildId) {
        interrupted = true;
        b = await refresh(handler);
        for (const row of ddb.find('CATALOG#production#B' + a.buildId)) {
          ddb.rows.delete(row.pk + '\u0000' + row.sk);
        }
      }
      return ddb.client.send(cmd);
    }
  };

  const store = storeMod.createStore({ tableName: 'asp-store-test', client });
  const read = await store.readCatalogSnapshot('production');
  assert.ok(interrupted, 'the test did not actually interleave, so it proves nothing');
  assert.ok(read && read.snapshot, 'a pointer change mid-read must not look like a broken catalog');
  assert.equal(read.buildId, b.buildId);
  assert.notEqual(read.buildId, a.buildId);
});

test('browsing survives a publish and prune happening underneath it', async () => {
  const ddb = fakeDynamo();
  const { handler } = await bootstrap({ ddb });
  const a = await refresh(handler);

  /* A cold container: it will read the pointer, then the chunks. */
  const cold = await bootstrap({ ddb });

  /* Between those two reads, a refresh publishes and prunes as hard as it can. */
  const b = await refresh(handler);
  await refresh(handler);
  await refresh(handler);

  const r = await cold.handler(ev('GET', '/catalog'));
  assert.equal(r.statusCode, 200, 'the shop must not 503 because a refresh happened: ' + r.body);
  assert.ok(J(r).total > 0);
});

/* ======================================================================
   2. Pages must come from one build
   ====================================================================== */

test('pages are pinned to the build the first page came from', async () => {
  let names = ['A', 'B', 'C'];
  const ddb = fakeDynamo();
  const { handler } = await bootstrap({
    ddb,
    handlers: squareHandlers({
      'GET /v2/catalog/list': () => ({ json: itemsFixture(names) }),
      'POST /v2/inventory/counts/batch-retrieve': () => stockFor(names)
    })
  });
  await refresh(handler);

  const first = J(await handler(ev('GET', '/catalog', { query: { limit: '2' } })));
  assert.deepEqual(first.products.map(p => p.name), ['A', 'B']);
  assert.ok(first.cursor);

  /* The shop gets a new item at the front and a refresh lands. */
  names = ['X', 'A', 'B', 'C'];
  await refresh(handler);

  const second = J(await handler(ev('GET', '/catalog', { query: { limit: '2', cursor: first.cursor } })));
  assert.deepEqual(second.products.map(p => p.name), ['C'],
    'page two must continue the build page one came from, not the new one');
  assert.equal(second.buildId, first.buildId);

  const all = first.products.concat(second.products).map(p => p.name);
  assert.deepEqual(all, ['A', 'B', 'C'], 'no duplicates, no omissions: ' + all.join(','));
});

test('a cursor for a build that is long gone is refused, not rebased', async () => {
  const ddb = fakeDynamo();
  const { handler } = await bootstrap({ ddb, env: { BUILD_RETENTION_SECONDS: '0' } });
  await refresh(handler);
  const first = J(await handler(ev('GET', '/catalog', { query: { limit: '1' } })));
  assert.ok(first.cursor);

  /* Retention is zero here, so the next refresh really does delete it. */
  await refresh(handler);
  await refresh(handler);

  const second = await handler(ev('GET', '/catalog', { query: { limit: '1', cursor: first.cursor } }));
  assert.equal(second.statusCode, 409, second.body);
  assert.equal(J(second).error, 'CATALOG_CURSOR_EXPIRED');
  assert.ok(J(second).buildId, 'and it says which build is current now, so the client can restart');
});

test('a bare numeric cursor is treated as expired rather than mixed in', async () => {
  const { handler } = await bootstrap();
  await refresh(handler);
  /* The old format carried no build, so there is no way to know which
     generation it belonged to. Guessing would be how pages get stitched
     together out of two catalogs. */
  const r = await handler(ev('GET', '/catalog', { query: { limit: '1', cursor: '1' } }));
  assert.equal(r.statusCode, 409);
  assert.equal(J(r).error, 'CATALOG_CURSOR_EXPIRED');
});

test('a nonsense cursor is refused too', async () => {
  const { handler } = await bootstrap();
  await refresh(handler);
  for (const cursor of ['', 'nonsense', '~~', 'B123~notanumber', 'B123~-5']) {
    const r = await handler(ev('GET', '/catalog', { query: { limit: '1', cursor } }));
    assert.ok([200, 409].includes(r.statusCode), cursor + ' -> ' + r.statusCode);
    if (r.statusCode === 200) assert.equal(J(r).products.length <= 1, true);
  }
});

test('walking every page of a stable catalog gives each product exactly once', async () => {
  const names = Array.from({ length: 17 }, (_, i) => 'P' + String(i).padStart(2, '0'));
  const { handler } = await bootstrap({
    handlers: squareHandlers({
      'GET /v2/catalog/list': () => ({ json: itemsFixture(names) }),
      'POST /v2/inventory/counts/batch-retrieve': () => stockFor(names)
    })
  });
  await refresh(handler);

  const seen = []; let cursor = null; let guard = 0;
  do {
    const page = J(await handler(ev('GET', '/catalog', {
      query: cursor ? { limit: '5', cursor } : { limit: '5' }
    })));
    seen.push(...page.products.map(p => p.name));
    cursor = page.cursor;
  } while (cursor && ++guard < 20);

  assert.deepEqual(seen, names);
  assert.equal(new Set(seen).size, seen.length, 'no duplicates');
});

/* ======================================================================
   3. An empty shop is a real shop
   ====================================================================== */

test('a complete read with everything sold out publishes an empty catalog', async () => {
  const ddb = fakeDynamo();
  const { handler } = await bootstrap({ ddb });
  const stocked = await refresh(handler);
  assert.equal(stocked.refreshed, true);
  assert.ok(J(await handler(ev('GET', '/catalog'))).total > 0);

  /* Both calls succeed. Square simply reports every tracked variation at
     zero. That is a shop that sold out, not a broken read. */
  const soldOut = await bootstrap({
    ddb,
    handlers: squareHandlers({
      'POST /v2/inventory/counts/batch-retrieve': ({ body }) => ({
        json: (body.catalog_object_ids || []).map(id => ({
          catalog_object_id: id, location_id: LOCATION, state: 'IN_STOCK', quantity: '0'
        })).reduce((acc, row) => { acc.counts.push(row); return acc; }, { counts: [] })
      })
    })
  });
  const empty = await refresh(soldOut.handler);
  assert.equal(empty.refreshed, true, 'it must publish: ' + JSON.stringify(empty));
  assert.equal(empty.counts.products, 0);

  const r = await soldOut.handler(ev('GET', '/catalog'));
  assert.equal(r.statusCode, 200);
  assert.equal(J(r).total, 0, 'the website must not keep showing yesterday’s products');
  assert.deepEqual(J(r).products, []);
});

test('a catalog page that fails mid-walk keeps the previous snapshot', async () => {
  const names = ['A', 'B', 'C'];
  let breakOnSecondPage = false;
  const ddb = fakeDynamo();
  const { handler } = await bootstrap({
    ddb,
    handlers: squareHandlers({
      'GET /v2/catalog/list': ({ query }) => {
        if (!query.cursor) return { json: { ...itemsFixture(names.slice(0, 1)), cursor: 'more' } };
        if (breakOnSecondPage) return { status: 500, json: { errors: [{ code: 'INTERNAL_SERVER_ERROR' }] } };
        return { json: itemsFixture(names.slice(1)) };
      },
      'POST /v2/inventory/counts/batch-retrieve': () => stockFor(names)
    })
  });
  const good = await refresh(handler);
  assert.equal(good.refreshed, true);
  assert.equal(J(await handler(ev('GET', '/catalog'))).total, 3);

  breakOnSecondPage = true;
  const bad = await refresh(handler);
  assert.equal(bad.refreshed, false, 'half a catalog must never be published');
  assert.equal(bad.reason, 'failed');

  const after = J(await handler(ev('GET', '/catalog')));
  assert.equal(after.total, 3, 'and the complete one keeps serving');
  assert.equal(after.buildId, good.buildId);
});

test('an inventory batch that fails keeps the previous snapshot', async () => {
  let broken = false;
  const ddb = fakeDynamo();
  const { handler } = await bootstrap({
    ddb,
    handlers: squareHandlers({
      'POST /v2/inventory/counts/batch-retrieve': ({ body }) => broken
        ? { status: 503, json: { errors: [{ code: 'SERVICE_UNAVAILABLE' }] } }
        : { json: { counts: (body.catalog_object_ids || [])
            .filter(id => INVENTORY[id] !== undefined)
            .map(id => ({ catalog_object_id: id, location_id: LOCATION, state: 'IN_STOCK', quantity: INVENTORY[id] })) } }
    })
  });
  const good = await refresh(handler);
  broken = true;
  const bad = await refresh(handler);
  assert.equal(bad.refreshed, false, 'stock we could not read is not stock of zero');
  assert.equal(J(await handler(ev('GET', '/catalog'))).buildId, good.buildId);
});

test('a write that fails keeps the previous snapshot', async () => {
  const ddb = fakeDynamo();
  const { handler } = await bootstrap({ ddb });
  const good = await refresh(handler);

  const killer = await bootstrap({
    ddb: fakeDynamo({ rows: ddb.rows, failOnce: { PutItemCommand: { pk: 'CATALOG#production', sk: 'CURRENT' } } })
  });
  const bad = await refresh(killer.handler);
  assert.equal(bad.refreshed, false);
  assert.equal(J(await handler(ev('GET', '/catalog'))).buildId, good.buildId);
});

test('an empty catalog is recorded loudly enough to notice', async () => {
  const { handler } = await bootstrap({
    handlers: squareHandlers({
      'GET /v2/catalog/list': () => ({ json: { objects: [] } })
    })
  });
  const r = await refresh(handler);
  assert.equal(r.refreshed, true, 'Square answered; there is simply nothing to sell');
  assert.equal(r.counts.products, 0);

  const status = J(await handler(ev('GET', '/admin/catalog', { headers: { 'x-admin-key': 'admin-test-key' } })));
  assert.equal(status.live.counts.products, 0);
  assert.equal(status.lastRefresh.lastError, null, 'an empty shop is not an error');
});
