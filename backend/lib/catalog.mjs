/* ==========================================================================
   All Star Players / catalog and inventory
   --------------------------------------------------------------------------
   Turns Square's catalog into the shape the storefront draws, and decides the
   one question that matters: can this variation actually be sold right now?

   The rules, in the order they bite:

     1. The item has to exist at OUR location. Square items can be present at
        all locations, at a named list, or absent from a named list.
     2. A variation priced VARIABLE_PRICING has no price to charge. It is
        never given an invented one; it is marked unsellable and the item says
        "ask in store".
     3. A location override wins over the item-level setting, for price, for
        inventory tracking and for the sold-out flag.
     4. If Square is not counting a variation, its quantity is UNKNOWN. Unknown
        is not "lots". By default unknown cannot be bought online at all.
     5. Confirmed stock means Square counted it and the number is above zero.

   Nothing in here invents a price, a quantity or an availability.
   ========================================================================== */

import { cents, quantity, chunk } from './square.mjs';

/* Which Square types we need. CATEGORY for the filter chips, IMAGE for the
   photographs, ITEM_OPTION for real size/colour pickers, TAX so the checkout
   can apply the shop's own tax rules rather than a guessed rate. */
const CATALOG_TYPES = 'ITEM,CATEGORY,IMAGE,ITEM_OPTION,TAX';

/* ------------------------------------------------------------- location */

function presentAtLocation(obj, locationId) {
  if (obj.absent_at_location_ids && obj.absent_at_location_ids.includes(locationId)) return false;
  if (obj.present_at_all_locations) return true;
  const list = obj.present_at_location_ids;
  return Array.isArray(list) ? list.includes(locationId) : false;
}

function overrideFor(variationData, locationId) {
  const list = variationData.location_overrides;
  if (!Array.isArray(list)) return null;
  return list.find(o => o && o.location_id === locationId) || null;
}

/* ---------------------------------------------------------------- fetch */

/* One pass over the whole catalog, following cursors until Square stops
   handing them out. Everything is bucketed by type on the way past so the
   normalise step never has to search a flat list. */
export async function fetchCatalogObjects(square, { pageLimit = 100 } = {}) {
  const objects = await square.paginateGet('/v2/catalog/list', {
    query: { types: CATALOG_TYPES, limit: String(pageLimit) },
    collect: json => json.objects || []
  });

  const buckets = { items: [], categories: new Map(), images: new Map(), options: new Map(), taxes: new Map() };
  for (const o of objects) {
    if (o.is_deleted) continue;
    switch (o.type) {
      case 'ITEM': buckets.items.push(o); break;
      case 'CATEGORY': buckets.categories.set(o.id, o.category_data?.name || ''); break;
      case 'IMAGE': if (o.image_data?.url) buckets.images.set(o.id, o.image_data.url); break;
      case 'ITEM_OPTION': buckets.options.set(o.id, o); break;
      case 'TAX': buckets.taxes.set(o.id, o); break;
      default: break;
    }
  }
  return buckets;
}

/* Inventory for a list of variation ids, in batches. Square answers with one
   row per (object, location, state); we only want IN_STOCK at our location.

   A variation Square has never counted simply does not come back. That is the
   whole reason `trackInventory` is read from the catalog rather than inferred
   from a missing row: "no row" and "not counted" are different facts. */
export async function fetchInventory(square, variationIds, { locationId, batchSize = 250 } = {}) {
  const counts = new Map();
  if (!variationIds.length) return counts;

  for (const ids of chunk(variationIds, batchSize)) {
    const rows = await square.paginatePost('/v2/inventory/counts/batch-retrieve', {
      body: { catalog_object_ids: ids, location_ids: [locationId], states: ['IN_STOCK'] },
      collect: json => json.counts || []
    });
    for (const row of rows) {
      if (row.location_id !== locationId) continue;
      if (row.state !== 'IN_STOCK') continue;
      const q = quantity(row.quantity);
      if (q === null) continue;
      /* Square can return more than one row for the same pair; the later one
         is the newer calculated_at, so take the larger of what we have seen
         rather than letting ordering decide. */
      const prev = counts.get(row.catalog_object_id);
      counts.set(row.catalog_object_id, prev === undefined ? q : Math.max(prev, q));
    }
  }
  return counts;
}

/* ------------------------------------------------------------ normalise */

function optionValuesFor(variationData, optionObjects) {
  const refs = variationData.item_option_values;
  if (!Array.isArray(refs) || !refs.length) return [];
  const out = [];
  for (const ref of refs) {
    const opt = optionObjects.get(ref.item_option_id);
    if (!opt) continue;
    const optName = opt.item_option_data?.name || '';
    const value = (opt.item_option_data?.values || [])
      .find(v => v.id === ref.item_option_value_id);
    out.push({
      optionId: ref.item_option_id,
      optionName: optName,
      valueId: ref.item_option_value_id,
      /* A value Square has since deleted leaves the reference behind. Showing
         the raw id would be nonsense, so the selector falls back to the
         variation's own name instead of pretending. */
      valueName: value?.item_option_value_data?.name || null
    });
  }
  return out.filter(o => o.valueName !== null);
}

function normaliseVariation(variation, { locationId, images, options, inventoryCounts, sellUntracked }) {
  const vd = variation.item_variation_data || {};
  const override = overrideFor(vd, locationId);

  /* Price: the location override wins, then the variation's own price. */
  const priceMoney = override?.price_money || vd.price_money;
  const amount = cents(priceMoney);
  const currency = priceMoney?.currency || null;
  const pricingType = override?.pricing_type || vd.pricing_type || 'FIXED_PRICING';
  const variablePrice = pricingType === 'VARIABLE_PRICING';

  /* Inventory tracking: the override wins. Square's default when neither is
     set is "not tracked". */
  const trackInventory = override
    ? (override.track_inventory ?? vd.track_inventory ?? false)
    : (vd.track_inventory ?? false);

  const counted = inventoryCounts.get(variation.id);
  const soldOut = override?.sold_out === true;

  let state, qty;
  if (trackInventory) {
    qty = counted === undefined ? 0 : counted;
    state = qty > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK';
  } else {
    /* Square is not counting this one. We do not know how many there are, and
       we refuse to call that "unlimited". */
    qty = null;
    state = 'UNKNOWN';
  }
  if (soldOut) { state = 'OUT_OF_STOCK'; qty = 0; }

  let sellable = true;
  let reason = null;
  if (variablePrice)            { sellable = false; reason = 'VARIABLE_PRICE'; }
  else if (amount === null)     { sellable = false; reason = 'NO_PRICE'; }
  else if (soldOut)             { sellable = false; reason = 'SOLD_OUT'; }
  else if (state === 'OUT_OF_STOCK') { sellable = false; reason = 'OUT_OF_STOCK'; }
  else if (state === 'UNKNOWN' && !sellUntracked) { sellable = false; reason = 'UNTRACKED'; }

  const variationImages = (vd.image_ids || []).map(id => images.get(id)).filter(Boolean);

  return {
    id: variation.id,
    name: vd.name || null,
    sku: vd.sku || null,
    ordinal: Number.isFinite(vd.ordinal) ? vd.ordinal : 0,
    options: optionValuesFor(vd, options),
    price: amount === null ? null : { amount, currency: currency || 'USD' },
    pricingType,
    trackInventory,
    /* `quantity` is null whenever we genuinely do not know. The storefront
       must not render null as zero or as plenty. */
    inventory: { state, quantity: qty },
    sellable,
    unsellableReason: reason,
    imageUrls: variationImages
  };
}

export function normaliseCatalog(buckets, {
  locationId,
  inventoryCounts = new Map(),
  sellUntracked = false,
  /* The storefront grid only wants things it can sell. The checkout
     verification wants everything it asked about, sellable or not, so it can
     tell a customer *why* their size has gone rather than just that the item
     "is no longer on the website". */
  keepUnsellable = false
}) {
  const { items, categories, images, options, taxes } = buckets;
  const products = [];
  const usedCategories = new Map();

  for (const item of items) {
    if (!presentAtLocation(item, locationId)) continue;
    const data = item.item_data || {};
    /* Square marks gift cards and archived items in ways that have no place
       in a storefront listing. */
    if (data.is_archived === true) continue;
    if (data.product_type && data.product_type !== 'REGULAR') continue;

    const rawVariations = (data.variations || [])
      .filter(v => !v.is_deleted && presentAtLocation(v, locationId));
    if (!rawVariations.length) continue;

    const variations = rawVariations
      .map(v => normaliseVariation(v, { locationId, images, options, inventoryCounts, sellUntracked }))
      .sort((a, b) => a.ordinal - b.ordinal);

    /* "Show products with at least one sellable, in-stock variation." An item
       whose every variation is out of stock, variable-priced or uncounted does
       not belong in the grid. */
    const sellableVariations = variations.filter(v => v.sellable);
    if (!sellableVariations.length && !keepUnsellable) continue;

    const categoryIds = [];
    if (data.category_id) categoryIds.push(data.category_id);
    for (const c of data.categories || []) if (c?.id) categoryIds.push(c.id);
    if (data.reporting_category?.id) categoryIds.push(data.reporting_category.id);
    const uniqueCategoryIds = [...new Set(categoryIds)].filter(id => categories.has(id));
    for (const id of uniqueCategoryIds) usedCategories.set(id, categories.get(id));

    const itemImages = (data.image_ids || []).map(id => images.get(id)).filter(Boolean);
    const priced = (sellableVariations.length ? sellableVariations : variations)
      .filter(v => v.price);
    const prices = priced.map(v => v.price.amount);

    /* The option axes this item actually varies along, in the order Square
       lists them, so the storefront can build one selector per axis. An item
       without Square item options falls back to a single variation list. */
    const axes = [];
    for (const v of variations) {
      for (const o of v.options) {
        let axis = axes.find(a => a.optionId === o.optionId);
        if (!axis) { axis = { optionId: o.optionId, name: o.optionName, values: [] }; axes.push(axis); }
        if (!axis.values.some(x => x.valueId === o.valueId)) {
          axis.values.push({ valueId: o.valueId, name: o.valueName });
        }
      }
    }

    products.push({
      id: item.id,
      name: data.name || 'Untitled',
      description: data.description_plaintext || data.description || '',
      categoryIds: uniqueCategoryIds,
      imageUrls: itemImages,
      taxIds: (data.tax_ids || []).filter(id => taxes.has(id)),
      optionAxes: axes,
      variations,
      priceRange: prices.length
        ? { min: Math.min(...prices), max: Math.max(...prices), currency: priced[0].price.currency }
        : { min: null, max: null, currency: null },
      /* True when some variation exists that we cannot price. The storefront
         says "other options in store" rather than hiding the fact. */
      hasUnpriceableVariations: variations.some(v => v.unsellableReason === 'VARIABLE_PRICE'),
      hasUnknownStock: variations.some(v => v.inventory.state === 'UNKNOWN')
    });
  }

  products.sort((a, b) => a.name.localeCompare(b.name, 'en'));

  return {
    products,
    categories: [...usedCategories.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en')),
    taxes: [...taxes.values()].map(t => ({
      id: t.id,
      name: t.tax_data?.name || '',
      percentage: t.tax_data?.percentage || null,
      inclusionType: t.tax_data?.inclusion_type || 'ADDITIVE',
      enabled: t.tax_data?.enabled !== false,
      appliesToCustomAmounts: t.tax_data?.applies_to_custom_amounts === true
    }))
  };
}

/* Everything the rest of the service needs, in one call. */
export async function buildCatalogSnapshot(square, s) {
  const locationId = square.locationId;
  const buckets = await fetchCatalogObjects(square, { pageLimit: s.squareCatalogPageLimit });

  /* Only ask Square to count the variations that could possibly be sold:
     present here, fixed price, and marked as tracked. That keeps the inventory
     call proportional to the sellable catalog rather than the whole thing. */
  const trackedIds = [];
  for (const item of buckets.items) {
    if (!presentAtLocation(item, locationId)) continue;
    for (const v of item.item_data?.variations || []) {
      if (v.is_deleted || !presentAtLocation(v, locationId)) continue;
      const vd = v.item_variation_data || {};
      const override = overrideFor(vd, locationId);
      const tracked = override ? (override.track_inventory ?? vd.track_inventory ?? false)
                               : (vd.track_inventory ?? false);
      if (tracked) trackedIds.push(v.id);
    }
  }

  const inventoryCounts = await fetchInventory(square, trackedIds, {
    locationId, batchSize: s.inventoryBatchSize
  });

  const normalised = normaliseCatalog(buckets, {
    locationId,
    inventoryCounts,
    sellUntracked: s.sellUntrackedVariations
  });

  return {
    ...normalised,
    locationId,
    fetchedAt: new Date().toISOString(),
    counts: {
      products: normalised.products.length,
      variations: normalised.products.reduce((n, p) => n + p.variations.length, 0),
      trackedVariations: trackedIds.length
    }
  };
}

/* A flat map of variation id -> { product, variation }, which is what every
   cart and checkout lookup actually wants. */
export function indexVariations(snapshot) {
  const index = new Map();
  for (const product of snapshot.products) {
    for (const variation of product.variations) {
      index.set(variation.id, { product, variation });
    }
  }
  return index;
}

/* ==========================================================================
   Checkout-time verification
   --------------------------------------------------------------------------
   Browsing may be served from a cache, and may even be served stale when
   Square is down, because nothing on the shop page is what gets charged.

   Authorising a purchase is a different matter. This path asks Square about
   exactly the variations in the cart, every time, and never consults the
   cache. If Square cannot answer, the checkout is refused rather than guessed
   at: see AvailabilityUnverifiedError.
   ========================================================================== */

export class AvailabilityUnverifiedError extends Error {
  constructor(cause) {
    super('We could not confirm availability with our store system. Nothing has been charged — please try again in a moment.');
    this.name = 'AvailabilityUnverifiedError';
    this.cause = cause;
  }
}

/* Square's batch endpoint takes up to 1000 ids; a cart is capped far below
   that, but the chunking keeps the promise honest if the cap ever moves. */
const BATCH_OBJECT_LIMIT = 500;

async function batchRetrieve(square, ids) {
  const objects = []; const related = [];
  for (const group of chunk([...new Set(ids)], BATCH_OBJECT_LIMIT)) {
    if (!group.length) continue;
    const res = await square.call('/v2/catalog/batch-retrieve', {
      method: 'POST',
      body: { object_ids: group, include_related_objects: true, include_deleted_objects: false }
    });
    objects.push(...(res.objects || []));
    related.push(...(res.related_objects || []));
  }
  return { objects, related };
}

export async function verifyVariationsLive(square, variationIds, s) {
  const locationId = square.locationId;
  const ids = [...new Set(variationIds)].filter(Boolean);
  if (!ids.length) {
    return { products: [], categories: [], taxes: [], fetchedAt: new Date().toISOString(), verified: true };
  }

  try {
    /* Pass one: the variations themselves, and whatever Square volunteers
       alongside them. */
    const first = await batchRetrieve(square, ids);
    const pool = [...first.objects, ...first.related];

    const variations = pool.filter(o => o.type === 'ITEM_VARIATION' && !o.is_deleted);
    const itemsById = new Map();
    for (const o of pool) if (o.type === 'ITEM' && !o.is_deleted) itemsById.set(o.id, o);

    const categories = new Map();
    const images = new Map();
    const options = new Map();
    const taxes = new Map();
    for (const o of pool) {
      if (o.is_deleted) continue;
      if (o.type === 'CATEGORY') categories.set(o.id, o.category_data?.name || '');
      if (o.type === 'IMAGE' && o.image_data?.url) images.set(o.id, o.image_data.url);
      if (o.type === 'ITEM_OPTION') options.set(o.id, o);
      if (o.type === 'TAX') taxes.set(o.id, o);
    }

    /* Pass two: anything the variations and their items point at that did not
       come back — the tax rules above all, because an order built without
       them would charge the wrong total. */
    const wanted = new Set();
    for (const item of itemsById.values()) {
      for (const id of item.item_data?.tax_ids || []) if (!taxes.has(id)) wanted.add(id);
      for (const id of item.item_data?.image_ids || []) if (!images.has(id)) wanted.add(id);
    }
    for (const v of variations) {
      for (const ref of v.item_variation_data?.item_option_values || []) {
        if (!options.has(ref.item_option_id)) wanted.add(ref.item_option_id);
      }
    }
    if (wanted.size) {
      const second = await batchRetrieve(square, [...wanted]);
      for (const o of [...second.objects, ...second.related]) {
        if (o.is_deleted) continue;
        if (o.type === 'TAX') taxes.set(o.id, o);
        if (o.type === 'IMAGE' && o.image_data?.url) images.set(o.id, o.image_data.url);
        if (o.type === 'ITEM_OPTION') options.set(o.id, o);
        if (o.type === 'CATEGORY') categories.set(o.id, o.category_data?.name || '');
      }
    }

    /* Rebuild each item carrying only the variations we asked about, so the
       normaliser works on exactly the cart and nothing else. */
    const wantedIds = new Set(ids);

    /* A standalone ITEM_VARIATION names its parent in item_id. Belt and
       braces: if that is missing, find the item that lists this variation.
       Losing the link would mean reporting a real variation as "no longer on
       the website", which is both wrong and alarming to a customer. */
    const parentByVariation = new Map();
    for (const item of itemsById.values()) {
      for (const v of item.item_data?.variations || []) {
        if (v?.id) parentByVariation.set(v.id, item.id);
      }
    }

    const byItem = new Map();
    for (const v of variations) {
      if (!wantedIds.has(v.id)) continue;
      const itemId = v.item_variation_data?.item_id || parentByVariation.get(v.id);
      if (!itemId) { console.error('variation_without_parent', v.id); continue; }
      if (!byItem.has(itemId)) byItem.set(itemId, []);
      byItem.get(itemId).push(v);
    }

    const items = [];
    for (const [itemId, vars] of byItem) {
      const item = itemsById.get(itemId);
      if (!item) continue;
      items.push({ ...item, item_data: { ...(item.item_data || {}), variations: vars } });
    }

    /* Only ask about stock for variations Square says it is counting. */
    const tracked = [];
    for (const v of variations) {
      if (!wantedIds.has(v.id)) continue;
      const vd = v.item_variation_data || {};
      const override = (vd.location_overrides || []).find(o => o?.location_id === locationId);
      const isTracked = override ? (override.track_inventory ?? vd.track_inventory ?? false)
                                 : (vd.track_inventory ?? false);
      if (isTracked) tracked.push(v.id);
    }
    const inventoryCounts = await fetchInventory(square, tracked, {
      locationId, batchSize: s.inventoryBatchSize
    });

    const normalised = normaliseCatalog(
      { items, categories, images, options, taxes },
      { locationId, inventoryCounts, sellUntracked: s.sellUntrackedVariations, keepUnsellable: true }
    );

    return { ...normalised, fetchedAt: new Date().toISOString(), verified: true };
  } catch (err) {
    /* A credential Square will not accept is not a passing wobble, and
       telling the customer to try again in a moment would be a lie — nothing
       will work until somebody fixes the secret. Let it through as what it
       is. */
    if (err?.authFailure === true) throw err;

    /* Square could not be asked, or would not answer. The one thing we must
       not do is fall back to a cached price or a cached stock level and let
       the sale through. */
    console.error('availability_unverified', JSON.stringify({ status: err?.status ?? null, message: err?.message }));
    throw new AvailabilityUnverifiedError(err);
  }
}
