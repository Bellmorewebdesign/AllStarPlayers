/* Test doubles. The DynamoDB fake implements enough of the real API that
   lib/store.mjs runs unmodified against it — marshalling, conditional writes
   and all — so the tests exercise the real persistence code rather than a
   stub of it. */

import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

/* `delay` yields to the event loop on every call, which makes two concurrent
   handler invocations genuinely interleave rather than running to completion
   one after the other. `failOnce` makes one named command throw, to stand in
   for a transient DynamoDB failure or a Lambda killed mid-flight. */
export function fakeDynamo({ delay = false, failOnce = null, rows: seed } = {}) {
  const rows = seed || new Map();               /* "pk\u0000sk" -> plain object */
  const key = (pk, sk) => pk + '\u0000' + sk;
  const calls = [];
  const failures = { ...(failOnce || {}) };
  const unprocessOnce = new Set();

  function conditionHolds(expr, existing, input) {
    if (!expr) return true;
    if (expr === 'attribute_not_exists(pk)') return existing === undefined;
    if (expr === 'attribute_exists(pk)') return existing !== undefined;
    /* The optimistic-concurrency check the hold rows use. */
    const version = expr.match(/^#?(\w+) = :(\w+)$/);
    if (version) {
      const names = input.ExpressionAttributeNames || {};
      const attr = names['#' + version[1]] || version[1];
      const values = unmarshall(input.ExpressionAttributeValues || {});
      return existing !== undefined && existing[attr] === values[':' + version[2]];
    }
    throw new Error('fakeDynamo does not implement condition: ' + expr);
  }

  function fail() {
    const err = new Error('The conditional request failed');
    err.name = 'ConditionalCheckFailedException';
    return err;
  }

  const client = {
    async send(cmd) {
      const name = cmd.constructor.name;
      const input = cmd.input;
      calls.push(name);
      if (delay) await new Promise(r => setTimeout(r, 0));

      /* A targeted one-shot failure: { UpdateItemCommand: 'ORDER#' } throws the
         first time an UpdateItem touches a key starting with that prefix. */
      const trigger = failures[name];
      if (trigger !== undefined) {
        const k = input.Key ? unmarshall(input.Key) : (input.Item ? unmarshall(input.Item) : {});
        if (trigger === true || String(k.pk || '').startsWith(trigger)) {
          delete failures[name];
          const err = new Error('simulated DynamoDB failure on ' + name);
          err.name = 'ProvisionedThroughputExceededException';
          throw err;
        }
      }

      if (name === 'PutItemCommand') {
        const item = unmarshall(input.Item);
        const k = key(item.pk, item.sk);
        if (!conditionHolds(input.ConditionExpression, rows.get(k), input)) throw fail();
        rows.set(k, item);
        return {};
      }

      if (name === 'GetItemCommand') {
        const { pk, sk } = unmarshall(input.Key);
        const found = rows.get(key(pk, sk));
        return found ? { Item: marshall(found, { removeUndefinedValues: true }) } : {};
      }

      if (name === 'DeleteItemCommand') {
        const { pk, sk } = unmarshall(input.Key);
        rows.delete(key(pk, sk));
        return {};
      }

      if (name === 'QueryCommand') {
        const values = unmarshall(input.ExpressionAttributeValues);
        const pk = values[':pk'];
        const items = [...rows.values()].filter(r => r.pk === pk)
          .sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
        return { Items: items.map(i => marshall(i, { removeUndefinedValues: true })) };
      }

      if (name === 'UpdateItemCommand') {
        const { pk, sk } = unmarshall(input.Key);
        const k = key(pk, sk);
        const existing = rows.get(k);
        if (!conditionHolds(input.ConditionExpression, existing, input)) throw fail();
        const values = unmarshall(input.ExpressionAttributeValues);
        const names = input.ExpressionAttributeNames || {};
        const next = { ...(existing || { pk, sk }) };
        for (const assign of input.UpdateExpression.replace(/^SET\s+/i, '').split(',')) {
          const [lhs, rhs] = assign.split('=').map(s => s.trim());
          next[names[lhs] ?? lhs.replace(/^#/, '')] = values[rhs];
        }
        rows.set(k, next);
        return {};
      }

      if (name === 'BatchWriteItemCommand') {
        /* The real BatchWriteItem is allowed to silently drop writes and hand
           them back in UnprocessedItems. Callers that ignore that field lose
           data, so the fake does it too on the first call per table. */
        const out = {};
        for (const [table, reqs] of Object.entries(input.RequestItems)) {
          let todo = reqs;
          if (unprocessOnce.has(table)) {
            unprocessOnce.delete(table);
            const held = reqs.slice(0, Math.min(1, reqs.length));
            todo = reqs.slice(held.length);
            if (held.length) out[table] = held;
          }
          for (const r of todo) {
            if (r.PutRequest) {
              const item = unmarshall(r.PutRequest.Item);
              rows.set(key(item.pk, item.sk), item);
            } else if (r.DeleteRequest) {
              const { pk, sk } = unmarshall(r.DeleteRequest.Key);
              rows.delete(key(pk, sk));
            }
          }
        }
        return Object.keys(out).length ? { UnprocessedItems: out } : {};
      }

      throw new Error('fakeDynamo does not implement ' + name);
    }
  };

  return {
    client, calls,
    rows,
    /* Make the next BatchWriteItem for this table leave one write undone. */
    dropNextBatchWrite: (table = 'asp-store-test') => unprocessOnce.add(table),
    dump: () => [...rows.values()],
    find: (prefix) => [...rows.values()].filter(r => String(r.pk).startsWith(prefix))
  };
}

/* A fetch stand-in for the Square client. `handlers` maps
   "METHOD /path" (the path without a query string) to a function that gets
   { body, url, query } and returns { status, json } or throws. */
export function fakeSquareFetch(handlers) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const bodyText = init.body;
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    const call = { method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, headers: init.headers };
    calls.push(call);

    /* Exact match first, then a "METHOD /prefix/*" wildcard, so routes with an
       id in the path (an order, say) can be stubbed without knowing the id. */
    let route = handlers[method + ' ' + u.pathname];
    if (!route) {
      for (const [key, fn] of Object.entries(handlers)) {
        if (!key.endsWith('/*')) continue;
        const [m, prefix] = key.split(' ');
        if (m === method && u.pathname.startsWith(prefix.slice(0, -1))) { route = fn; break; }
      }
    }
    if (!route) {
      return { ok: false, status: 404, text: async () => JSON.stringify({ errors: [{ code: 'NOT_FOUND' }] }) };
    }
    const res = await route(call);
    const status = res.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(res.json ?? {})
    };
  };
  impl.calls = calls;
  return impl;
}

/* --------------------------------------------------------- catalog fixture */

export const LOCATION = 'LPRODLOC1234';

/* Shaped the way Square's /v2/catalog/list actually answers, including the
   awkward parts the normaliser has to get right: a location override that
   changes a price, an item present only at another location, a variable-price
   variation, an untracked variation and a sold-out flag. */
export function catalogFixture() {
  const image = (id, url) => ({ type: 'IMAGE', id, image_data: { url } });
  const category = (id, name) => ({ type: 'CATEGORY', id, category_data: { name } });

  const option = (id, name, values) => ({
    type: 'ITEM_OPTION', id,
    item_option_data: { name, values: values.map(([vid, vname]) => ({ id: vid, item_option_value_data: { name: vname } })) }
  });

  const variation = (id, name, opts = {}) => ({
    type: 'ITEM_VARIATION', id,
    present_at_all_locations: opts.presentAll !== false,
    ...(opts.presentAt ? { present_at_all_locations: false, present_at_location_ids: opts.presentAt } : {}),
    item_variation_data: {
      name,
      sku: opts.sku ?? null,
      ordinal: opts.ordinal ?? 0,
      pricing_type: opts.pricingType || 'FIXED_PRICING',
      ...(opts.price !== undefined ? { price_money: { amount: opts.price, currency: 'USD' } } : {}),
      track_inventory: opts.track ?? false,
      ...(opts.optionValues ? { item_option_values: opts.optionValues } : {}),
      ...(opts.overrides ? { location_overrides: opts.overrides } : {})
    }
  });

  return {
    objects: [
      category('CAT_TEES', 'T-Shirts'),
      category('CAT_HATS', 'Hats'),
      image('IMG_TEE', 'https://items.sandbox.example/tee.jpg'),
      image('IMG_HAT', 'https://items.sandbox.example/hat.jpg'),
      option('OPT_SIZE', 'Size', [['V_S', 'Small'], ['V_M', 'Medium'], ['V_L', 'Large']]),
      option('OPT_COLOR', 'Color', [['V_BLK', 'Black'], ['V_GLD', 'Gold']]),

      /* A normal item: two sizes tracked, one of them out of stock. */
      {
        type: 'ITEM', id: 'ITEM_TEE', present_at_all_locations: true,
        item_data: {
          name: 'Horseshoe Tee', description: 'Gold horseshoe on black.',
          category_id: 'CAT_TEES', image_ids: ['IMG_TEE'], tax_ids: ['TAX_NYC'],
          product_type: 'REGULAR',
          variations: [
            variation('VAR_TEE_S', 'Small / Black', {
              price: 4500, track: true, ordinal: 0,
              optionValues: [{ item_option_id: 'OPT_SIZE', item_option_value_id: 'V_S' },
                             { item_option_id: 'OPT_COLOR', item_option_value_id: 'V_BLK' }]
            }),
            variation('VAR_TEE_M', 'Medium / Black', {
              price: 4500, track: true, ordinal: 1,
              optionValues: [{ item_option_id: 'OPT_SIZE', item_option_value_id: 'V_M' },
                             { item_option_id: 'OPT_COLOR', item_option_value_id: 'V_BLK' }]
            }),
            variation('VAR_TEE_L', 'Large / Gold', {
              price: 4500, track: true, ordinal: 2,
              optionValues: [{ item_option_id: 'OPT_SIZE', item_option_value_id: 'V_L' },
                             { item_option_id: 'OPT_COLOR', item_option_value_id: 'V_GLD' }]
            })
          ]
        }
      },

      /* A location override that raises the price here and marks one sold out. */
      {
        type: 'ITEM', id: 'ITEM_HAT', present_at_all_locations: true,
        item_data: {
          name: 'Fitted Cap', description: '', category_id: 'CAT_HATS', image_ids: ['IMG_HAT'],
          product_type: 'REGULAR',
          variations: [
            variation('VAR_HAT_A', 'Navy', {
              price: 3500, track: true,
              overrides: [{ location_id: LOCATION, price_money: { amount: 3900, currency: 'USD' }, track_inventory: true }]
            }),
            variation('VAR_HAT_B', 'Red', {
              price: 3500, track: true,
              overrides: [{ location_id: LOCATION, sold_out: true, track_inventory: true }]
            })
          ]
        }
      },

      /* Priced in store only. Must never get an invented price. */
      {
        type: 'ITEM', id: 'ITEM_CUSTOM', present_at_all_locations: true,
        item_data: {
          name: 'Custom Stitch', product_type: 'REGULAR',
          variations: [variation('VAR_CUSTOM', 'Regular', { pricingType: 'VARIABLE_PRICING', track: false })]
        }
      },

      /* Square is not counting this one. Unknown, not unlimited. */
      {
        type: 'ITEM', id: 'ITEM_UNTRACKED', present_at_all_locations: true,
        item_data: {
          name: 'Sticker Pack', product_type: 'REGULAR',
          variations: [variation('VAR_STICKER', 'Regular', { price: 500, track: false })]
        }
      },

      /* Belongs to a different store. */
      {
        type: 'ITEM', id: 'ITEM_OTHER_STORE',
        present_at_all_locations: false, present_at_location_ids: ['LSOMEWHEREELSE'],
        item_data: {
          name: 'Other Store Only', product_type: 'REGULAR',
          variations: [variation('VAR_OTHER', 'Regular', { price: 1000, track: true, presentAt: ['LSOMEWHEREELSE'] })]
        }
      },

      /* Archived, and a gift card: neither belongs in a storefront grid. */
      {
        type: 'ITEM', id: 'ITEM_ARCHIVED', present_at_all_locations: true,
        item_data: { name: 'Last Season', is_archived: true, product_type: 'REGULAR',
          variations: [variation('VAR_ARCH', 'Regular', { price: 100, track: true })] }
      },
      {
        type: 'ITEM', id: 'ITEM_GIFTCARD', present_at_all_locations: true,
        item_data: { name: 'Gift Card', product_type: 'GIFT_CARD',
          variations: [variation('VAR_GC', 'Regular', { price: 2500, track: true })] }
      },

      { type: 'TAX', id: 'TAX_NYC', tax_data: { name: 'NYC Sales Tax', percentage: '8.875', enabled: true, inclusion_type: 'ADDITIVE' } }
    ]
  };
}

export const INVENTORY = {
  VAR_TEE_S: '4',
  VAR_TEE_M: '0',
  VAR_TEE_L: '12',
  VAR_HAT_A: '2',
  VAR_HAT_B: '7'      /* on hand, but the location override says sold out */
};

export function inventoryResponse(ids) {
  return {
    counts: ids
      .filter(id => INVENTORY[id] !== undefined)
      .map(id => ({
        catalog_object_id: id, location_id: LOCATION, state: 'IN_STOCK',
        quantity: INVENTORY[id], calculated_at: '2026-10-11T00:00:00Z'
      }))
  };
}

/* Square answers a batch-retrieve of variation ids with the variations
   themselves (each naming its parent in item_id) plus the parent items in
   related_objects. This is the call the checkout verification makes. */
export function batchRetrieveResponse(objectIds) {
  const wanted = new Set(objectIds || []);
  const objects = []; const related = [];
  for (const obj of catalogFixture().objects) {
    if (obj.type === 'ITEM') {
      const hits = (obj.item_data.variations || []).filter(v => wanted.has(v.id));
      if (hits.length) {
        objects.push(...hits.map(v => ({
          ...v, item_variation_data: { ...v.item_variation_data, item_id: obj.id }
        })));
        related.push(obj);
      }
    }
    if (wanted.has(obj.id)) objects.push(obj);
  }
  return { objects, related_objects: related };
}

/* The handler map most tests want. */
export function squareHandlers(overrides = {}) {
  return {
    'GET /v2/catalog/list': () => ({ json: catalogFixture() }),
    'POST /v2/inventory/counts/batch-retrieve': ({ body }) =>
      ({ json: inventoryResponse(body.catalog_object_ids || []) }),
    'POST /v2/catalog/batch-retrieve': ({ body }) =>
      ({ json: batchRetrieveResponse(body.object_ids || []) }),
    ...overrides
  };
}

export function baseEnv(extra = {}) {
  return {
    SECRET_ID: 'all-star-players/square/production',
    TABLE_NAME: 'asp-store-test',
    ALLOWED_ORIGINS: 'https://bellmorewebdesign.github.io',
    PICKUP_ENABLED: 'true',
    PICKUP_ADDRESS: '96-03 37th Ave, Queens, NY 11368',
    SHIPPING_ENABLED: 'true',
    SHIPPING_RATES: JSON.stringify([
      { id: 'ny', label: 'New York', amount: 800, currency: 'USD', countries: ['US'], states: ['NY'], freeOver: 15000 },
      { id: 'us', label: 'United States', amount: 1400, currency: 'USD', countries: ['US'], states: [] }
    ]),
    RETURN_URL: 'https://bellmorewebdesign.github.io/AllStarPlayers/order.html',
    STOCK_HOLDS_ENABLED: 'true',
    ...extra
  };
}

export function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return fn(); }
  finally {
    for (const [k] of Object.entries(vars)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

export const secretsFake = (overrides = {}) => ({
  send: async () => ({
    SecretString: JSON.stringify({
      SQUARE_ACCESS_TOKEN: 'EAAAprod-TOP-SECRET-TOKEN',
      SQUARE_APPLICATION_ID: 'sq0idp-app',
      SQUARE_LOCATION_ID: LOCATION,
      SQUARE_ENVIRONMENT: 'production',
      SQUARE_WEBHOOK_SIGNATURE_KEY: 'whsec-test-key',
      ADMIN_REFRESH_KEY: 'admin-test-key',
      ...overrides
    })
  })
});
