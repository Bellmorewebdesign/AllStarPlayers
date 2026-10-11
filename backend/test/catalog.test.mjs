import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSquareClient } from '../lib/square.mjs';
import { buildCatalogSnapshot, indexVariations } from '../lib/catalog.mjs';
import { settings } from '../lib/config.mjs';
import { fakeSquareFetch, squareHandlers, LOCATION, withEnv, baseEnv, catalogFixture } from './helpers.mjs';

function client(handlers = squareHandlers()) {
  const fetchImpl = fakeSquareFetch(handlers);
  const c = createSquareClient(
    { host: 'https://connect.squareup.com', token: 'tok', squareVersion: '2026-09-16', locationId: LOCATION },
    { fetchImpl }
  );
  c.fetchImpl = fetchImpl;
  return c;
}

const snap = (env = {}) => withEnv(baseEnv(env), async () => buildCatalogSnapshot(client(), settings()));

test('only items sellable at this location reach the storefront', async () => {
  const s = await snap();
  const names = s.products.map(p => p.name).sort();
  assert.deepEqual(names, ['Fitted Cap', 'Horseshoe Tee']);

  /* Each exclusion for its own reason. */
  assert.ok(!names.includes('Other Store Only'), 'a different location');
  assert.ok(!names.includes('Last Season'), 'archived');
  assert.ok(!names.includes('Gift Card'), 'not a REGULAR product');
  assert.ok(!names.includes('Custom Stitch'), 'variable price, so nothing to charge');
  assert.ok(!names.includes('Sticker Pack'), 'untracked and SELL_UNTRACKED_VARIATIONS is off');
});

test('a variable-price variation is never given an invented price', async () => {
  const s = await withEnv(baseEnv({ SELL_UNTRACKED_VARIATIONS: 'true' }), async () =>
    buildCatalogSnapshot(client(), settings()));
  const custom = s.products.find(p => p.name === 'Custom Stitch');
  /* Even with untracked selling switched on, a variable price stays unsellable. */
  assert.equal(custom, undefined);
});

test('untracked stock reads as UNKNOWN, never as plenty', async () => {
  const off = await snap();
  assert.equal(off.products.find(p => p.name === 'Sticker Pack'), undefined);

  const on = await withEnv(baseEnv({ SELL_UNTRACKED_VARIATIONS: 'true' }), async () =>
    buildCatalogSnapshot(client(), settings()));
  const sticker = on.products.find(p => p.name === 'Sticker Pack');
  assert.ok(sticker, 'sellable once the shop opts in');
  const v = sticker.variations[0];
  assert.equal(v.inventory.state, 'UNKNOWN');
  assert.equal(v.inventory.quantity, null, 'null, not 0 and not Infinity');
  assert.equal(v.sellable, true);
  assert.equal(sticker.hasUnknownStock, true);
});

test('a location price override wins over the item price', async () => {
  const s = await snap();
  const hat = s.products.find(p => p.name === 'Fitted Cap');
  const navy = hat.variations.find(v => v.name === 'Navy');
  assert.equal(navy.price.amount, 3900, 'the override, not the 3500 base price');
});

test('a location sold_out override beats a positive inventory count', async () => {
  const s = await snap();
  const hat = s.products.find(p => p.name === 'Fitted Cap');
  const red = hat.variations.find(v => v.name === 'Red');
  assert.equal(red.sellable, false);
  assert.equal(red.unsellableReason, 'SOLD_OUT');
  assert.equal(red.inventory.quantity, 0, 'despite Square counting 7 on hand');
});

test('a tracked variation at zero is out of stock but still listed on its product', async () => {
  const s = await snap();
  const tee = s.products.find(p => p.name === 'Horseshoe Tee');
  const medium = tee.variations.find(v => v.name === 'Medium / Black');
  assert.equal(medium.inventory.state, 'OUT_OF_STOCK');
  assert.equal(medium.inventory.quantity, 0);
  assert.equal(medium.sellable, false);
  /* The product survives because other sizes can be sold. */
  assert.equal(tee.variations.filter(v => v.sellable).length, 2);
});

test('size and colour axes are built from Square item options', async () => {
  const s = await snap();
  const tee = s.products.find(p => p.name === 'Horseshoe Tee');
  const axes = tee.optionAxes.map(a => a.name);
  assert.deepEqual(axes, ['Size', 'Color']);
  const size = tee.optionAxes[0];
  assert.deepEqual(size.values.map(v => v.name), ['Small', 'Medium', 'Large']);
});

test('images, categories and tax ids come through', async () => {
  const s = await snap();
  const tee = s.products.find(p => p.name === 'Horseshoe Tee');
  assert.deepEqual(tee.imageUrls, ['https://items.sandbox.example/tee.jpg']);
  assert.deepEqual(tee.taxIds, ['TAX_NYC']);
  assert.deepEqual(s.categories.map(c => c.name).sort(), ['Hats', 'T-Shirts']);
  assert.equal(s.taxes.find(t => t.id === 'TAX_NYC').percentage, '8.875');
});

test('only tracked variations are sent to the inventory API', async () => {
  const c = client();
  await withEnv(baseEnv(), async () => buildCatalogSnapshot(c, settings()));
  const invCall = c.fetchImpl.calls.find(x => x.path === '/v2/inventory/counts/batch-retrieve');
  assert.ok(invCall, 'inventory was fetched');
  assert.ok(!invCall.body.catalog_object_ids.includes('VAR_STICKER'), 'untracked is not asked about');
  assert.ok(!invCall.body.catalog_object_ids.includes('VAR_OTHER'), 'another location is not asked about');
  assert.deepEqual(invCall.body.location_ids, [LOCATION]);
  assert.deepEqual(invCall.body.states, ['IN_STOCK']);
});

test('catalog pagination follows cursors to the end', async () => {
  const all = catalogFixture().objects;
  const pages = [all.slice(0, 4), all.slice(4, 9), all.slice(9)];
  let served = 0;
  const c = client(squareHandlers({
    'GET /v2/catalog/list': ({ query }) => {
      const i = query.cursor ? Number(query.cursor) : 0;
      served++;
      return { json: { objects: pages[i], ...(i + 1 < pages.length ? { cursor: String(i + 1) } : {}) } };
    }
  }));
  const s = await withEnv(baseEnv(), async () => buildCatalogSnapshot(c, settings()));
  assert.equal(served, 3, 'every page was fetched');
  assert.deepEqual(s.products.map(p => p.name).sort(), ['Fitted Cap', 'Horseshoe Tee']);
});

test('inventory pagination follows cursors too', async () => {
  let served = 0;
  const c = client(squareHandlers({
    'POST /v2/inventory/counts/batch-retrieve': ({ body }) => {
      served++;
      if (!body.cursor) {
        return { json: { counts: [{ catalog_object_id: 'VAR_TEE_S', location_id: LOCATION, state: 'IN_STOCK', quantity: '4' }], cursor: 'more' } };
      }
      return { json: { counts: [{ catalog_object_id: 'VAR_TEE_L', location_id: LOCATION, state: 'IN_STOCK', quantity: '9' }] } };
    }
  }));
  const s = await withEnv(baseEnv(), async () => buildCatalogSnapshot(c, settings()));
  assert.equal(served, 2);
  const tee = s.products.find(p => p.name === 'Horseshoe Tee');
  assert.equal(tee.variations.find(v => v.name === 'Large / Gold').inventory.quantity, 9);
});

test('inventory rows for another location are ignored', async () => {
  const c = client(squareHandlers({
    'POST /v2/inventory/counts/batch-retrieve': () => ({
      json: { counts: [
        { catalog_object_id: 'VAR_TEE_S', location_id: 'LSOMEWHEREELSE', state: 'IN_STOCK', quantity: '99' },
        { catalog_object_id: 'VAR_TEE_S', location_id: LOCATION, state: 'IN_STOCK', quantity: '1' }
      ] }
    })
  }));
  const s = await withEnv(baseEnv(), async () => buildCatalogSnapshot(c, settings()));
  const tee = s.products.find(p => p.name === 'Horseshoe Tee');
  assert.equal(tee.variations.find(v => v.name === 'Small / Black').inventory.quantity, 1);
});

test('indexVariations finds a variation and the product it belongs to', async () => {
  const s = await snap();
  const idx = indexVariations(s);
  const hit = idx.get('VAR_TEE_S');
  assert.equal(hit.product.name, 'Horseshoe Tee');
  assert.equal(hit.variation.price.amount, 4500);
});
