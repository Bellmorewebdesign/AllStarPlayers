/* ==========================================================================
   All Star Players / cart reconciliation
   --------------------------------------------------------------------------
   The browser sends variation ids and quantities. That is all it is trusted
   with. Everything else — the name, the photograph, the price, whether the
   thing can be bought at all — is read back out of the catalog here.

   A cart arriving from localStorage may be weeks old, so this is also the
   place that notices the shop has moved on: a sold-out size, a price change,
   an item taken off the website. Each of those becomes a structured problem
   the storefront can explain, rather than a flat failure.
   ========================================================================== */

import { indexVariations } from './catalog.mjs';

export const PROBLEM = {
  UNAVAILABLE: 'UNAVAILABLE',
  OUT_OF_STOCK: 'OUT_OF_STOCK',
  QUANTITY_REDUCED: 'QUANTITY_REDUCED',
  PRICE_CHANGED: 'PRICE_CHANGED',
  NOT_SELLABLE: 'NOT_SELLABLE',
  UNKNOWN_STOCK: 'UNKNOWN_STOCK'
};

/* The browser may send a price it was showing. It is never used to charge
   anybody — only to notice that what the customer saw is no longer true. */
function parseLines(raw, { maxCartLines, maxLineQuantity }) {
  if (!Array.isArray(raw)) return { error: 'Send a `lines` array.' };
  if (!raw.length) return { error: 'The cart is empty.' };
  if (raw.length > maxCartLines) return { error: 'That is more than ' + maxCartLines + ' different items.' };

  const merged = new Map();
  for (const line of raw) {
    if (!line || typeof line !== 'object') return { error: 'Every cart line must be an object.' };
    const variationId = typeof line.variationId === 'string' ? line.variationId.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(variationId)) return { error: 'A cart line has an unusable variation id.' };

    const quantity = Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) return { error: 'Quantities must be whole numbers of at least 1.' };

    const displayedPrice = Number.isInteger(line.displayedPrice) ? line.displayedPrice : null;

    /* Two lines for the same variation are one line. The storefront merges
       them too, but a hand-rolled request must not get two bites. */
    const existing = merged.get(variationId);
    if (existing) existing.quantity += quantity;
    else merged.set(variationId, { variationId, quantity, displayedPrice });
  }

  for (const line of merged.values()) {
    if (line.quantity > maxLineQuantity) line.quantity = maxLineQuantity;
  }
  return { lines: [...merged.values()] };
}

/* How many of a variation this customer may actually have, once other
   in-flight checkouts on this website are taken off the shelf.

   `available` is null when Square is not counting the variation. Null means
   unknown, and unknown is never treated as plenty. */
function availableFor(variation, held) {
  if (variation.inventory.state === 'UNKNOWN') return null;
  const onHand = variation.inventory.quantity ?? 0;
  return Math.max(0, onHand - held);
}

export async function reconcileCart(rawLines, {
  snapshot, settings, store, attemptId = null
}) {
  const parsed = parseLines(rawLines, settings);
  if (parsed.error) return { ok: false, error: 'BAD_CART', message: parsed.error };

  const index = indexVariations(snapshot);
  const lines = [];
  const problems = [];
  let subtotal = 0;
  let currency = settings.currency;

  for (const requested of parsed.lines) {
    const found = index.get(requested.variationId);

    if (!found) {
      problems.push({
        code: PROBLEM.UNAVAILABLE, variationId: requested.variationId,
        message: 'One item is no longer on the website.'
      });
      lines.push({
        variationId: requested.variationId, requestedQuantity: requested.quantity,
        quantity: 0, available: 0, removed: true, name: null, productName: null
      });
      continue;
    }

    const { product, variation } = found;

    if (!variation.sellable) {
      const code = variation.unsellableReason === 'OUT_OF_STOCK' || variation.unsellableReason === 'SOLD_OUT'
        ? PROBLEM.OUT_OF_STOCK
        : variation.unsellableReason === 'UNTRACKED' ? PROBLEM.UNKNOWN_STOCK : PROBLEM.NOT_SELLABLE;
      problems.push({
        code, variationId: variation.id, productName: product.name,
        message: messageForUnsellable(product, variation)
      });
      lines.push({
        variationId: variation.id, productName: product.name, name: variation.name,
        requestedQuantity: requested.quantity, quantity: 0, available: 0, removed: true,
        imageUrl: product.imageUrls[0] || variation.imageUrls[0] || null,
        options: variation.options.map(o => ({ name: o.optionName, value: o.valueName }))
      });
      continue;
    }

    const held = (settings.holdsEnabled && store)
      ? await store.heldQuantity(variation.id, { excludeAttempt: attemptId })
      : 0;
    const available = availableFor(variation, held);

    let quantity = requested.quantity;
    if (available !== null && quantity > available) {
      quantity = available;
      if (quantity === 0) {
        problems.push({
          code: PROBLEM.OUT_OF_STOCK, variationId: variation.id, productName: product.name,
          message: product.name + ' has just sold out.'
        });
      } else {
        problems.push({
          code: PROBLEM.QUANTITY_REDUCED, variationId: variation.id, productName: product.name,
          requested: requested.quantity, available: quantity,
          message: 'Only ' + quantity + ' of ' + product.name + ' left, so the quantity has been reduced.'
        });
      }
    }

    const unitPrice = variation.price.amount;
    currency = variation.price.currency || currency;

    if (requested.displayedPrice !== null && requested.displayedPrice !== unitPrice) {
      problems.push({
        code: PROBLEM.PRICE_CHANGED, variationId: variation.id, productName: product.name,
        was: requested.displayedPrice, now: unitPrice,
        message: 'The price of ' + product.name + ' has changed.'
      });
    }

    subtotal += unitPrice * quantity;

    lines.push({
      variationId: variation.id,
      productId: product.id,
      productName: product.name,
      name: variation.name,
      sku: variation.sku,
      options: variation.options.map(o => ({ name: o.optionName, value: o.valueName })),
      imageUrl: product.imageUrls[0] || variation.imageUrls[0] || null,
      unitPrice,
      currency: variation.price.currency,
      requestedQuantity: requested.quantity,
      quantity,
      /* `available` is what THIS shopper can have: the shelf count minus what
         other in-flight checkouts are holding. It is the number the cart page
         caps its stepper at.

         `onHand` is the raw shelf count, with nothing subtracted. The hold
         acquisition needs that one, because it subtracts the other holds
         itself — handing it `available` would take them off twice and refuse
         a sale that was perfectly possible. */
      available,
      onHand: variation.inventory.state === 'UNKNOWN' ? null : (variation.inventory.quantity ?? 0),
      inventoryState: variation.inventory.state,
      taxIds: product.taxIds,
      removed: quantity === 0
    });
  }

  const payable = lines.filter(l => l.quantity > 0);

  return {
    ok: true,
    lines,
    payableLines: payable,
    problems,
    /* Changed means "the customer must look at this again before paying". */
    changed: problems.length > 0,
    totals: {
      subtotal,
      currency,
      itemCount: payable.reduce((n, l) => n + l.quantity, 0),
      lineCount: payable.length
    },
    /* Deliberately absent: tax and shipping. Tax is Square's to compute from
       the shop's own catalog tax rules, and shipping depends on a destination
       the customer has not necessarily given yet. Quoting either here would
       be a guess. */
    estimatedOnly: true
  };
}

function messageForUnsellable(product, variation) {
  switch (variation.unsellableReason) {
    case 'VARIABLE_PRICE':
      return product.name + ' is priced in store, so it cannot be bought online.';
    case 'NO_PRICE':
      return product.name + ' has no online price set.';
    case 'SOLD_OUT':
    case 'OUT_OF_STOCK':
      return product.name + ' has sold out.';
    case 'UNTRACKED':
      return product.name + ' is not counted in our stock system, so it cannot be bought online.';
    default:
      return product.name + ' is not available online.';
  }
}

/* A stable fingerprint of what is being bought, and of where it is going.

   Two requests with the same fingerprint are the same attempt, so a retried
   fetch replays one order instead of placing two. Change anything that would
   alter the parcel, the receipt or who gets telephoned, and it becomes a
   different attempt.

   That means every field that reaches Square's order has to be in here. A
   missed one — the apartment number, say — meant two genuinely different
   deliveries collapsing onto a single order. Cosmetic differences are
   normalised away first, so trailing spaces and capital letters are not
   mistaken for a different customer.

   `source` is deliberately absent: buying the same thing from the cart or
   from Buy Now is the same purchase and must not double up. */
function norm(v) {
  return String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function cartFingerprint(payableLines, fulfillment) {
  const items = payableLines
    .map(l => l.variationId + 'x' + l.quantity)
    .sort()
    .join('|');

  const f = fulfillment || {};
  const c = f.contact || {};
  const a = f.address || {};
  const parts = [
    norm(f.type),
    norm(f.zoneId),
    norm(c.firstName), norm(c.lastName), norm(c.email),
    /* Punctuation in a phone number is not a different phone number. */
    String(c.phone ?? '').replace(/\D/g, ''),
    norm(a.line1), norm(a.line2), norm(a.city), norm(a.state), norm(a.postalCode), norm(a.country)
  ];
  return items + '::' + parts.join('~');
}
