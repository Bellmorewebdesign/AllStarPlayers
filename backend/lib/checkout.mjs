/* ==========================================================================
   All Star Players / checkout
   --------------------------------------------------------------------------
   Builds the Square order and asks Square for a hosted checkout page.

   What the browser supplies: variation ids, quantities, a fulfillment choice
   and the customer's contact details. That is the whole list.

   What the browser never supplies: a price, a discount, a shipping charge, a
   tax rate or a total. Line items name a catalog variation and Square prices
   them from its own catalog, the shipping charge comes from the shop's
   configured zones, and tax comes from the shop's own Square tax rules.

   VERIFY BEFORE GOING LIVE (see DEPLOY.md, "Sandbox checks"): Square's hosted
   checkout renders a pre-set SHIPMENT recipient rather than asking for one
   again. This code sends the address it validated and leaves
   `ask_for_shipping_address` off so there is one source of truth. If a
   sandbox run shows the address is not carried through, turn
   SQUARE_ASK_FOR_SHIPPING_ADDRESS on and the hosted page will collect it.
   ========================================================================== */

import { squareRecipient } from './fulfillment.mjs';

const ASK_FOR_SHIPPING_ADDRESS = /^(1|true|yes|on)$/i.test(process.env.SQUARE_ASK_FOR_SHIPPING_ADDRESS || '');

/* ------------------------------------------------------------- the order */

export function buildOrder({ locationId, lines, fulfillment, settings, taxes, referenceId }) {
  const lineItems = lines.map((l, i) => {
    const item = {
      uid: 'line-' + i,
      quantity: String(l.quantity),
      /* The only thing that sets the price. */
      catalog_object_id: l.variationId
    };
    /* Square applies a catalog tax to a line only when the line says so.
       Taxes come from the item's own tax_ids, so the shop's rules in Square
       are what decide, not a number typed in here. */
    if (settings.applyCatalogTaxes && l.taxIds?.length) {
      item.applied_taxes = l.taxIds
        .filter(id => taxes.has(id))
        .map(id => ({ uid: 'applied-' + i + '-' + id, tax_uid: 'tax-' + id }));
      if (!item.applied_taxes.length) delete item.applied_taxes;
    }
    return item;
  });

  const order = {
    location_id: locationId,
    reference_id: referenceId,
    line_items: lineItems
  };

  /* Every catalog tax any line uses, declared once at order level and
     referred to by uid from the lines above. */
  if (settings.applyCatalogTaxes) {
    const used = new Set();
    for (const l of lines) for (const id of l.taxIds || []) if (taxes.has(id)) used.add(id);
    if (used.size) {
      order.taxes = [...used].map(id => ({
        uid: 'tax-' + id,
        catalog_object_id: id,
        scope: 'LINE_ITEM'
      }));
    }
  }

  if (fulfillment.type === 'pickup') {
    order.fulfillments = [{
      type: 'PICKUP',
      state: 'PROPOSED',
      pickup_details: {
        recipient: squareRecipient(fulfillment),
        /* ASAP means "as soon as it is ready", not "within N minutes". No
           pickup_at is sent, because no time has been promised. */
        schedule_type: 'ASAP',
        note: 'Store pickup. Contact the customer when the order is ready; they collect after that. ' +
              'No pickup time has been promised to them.'
      }
    }];
  } else {
    order.fulfillments = [{
      type: 'SHIPMENT',
      state: 'PROPOSED',
      shipment_details: {
        recipient: squareRecipient(fulfillment),
        /* No carrier, no tracking number and no shipping_note promising a
           service level: none of that is integrated. Staff choose the
           carrier and add tracking in Square by hand. */
        shipping_note: 'Parcel shipping. Carrier and tracking are added by staff; no carrier rate was quoted.'
      }
    }];

    const charge = fulfillment.shipping;
    if (charge && charge.amount > 0) {
      /* A service charge rather than a line item, so it is not mistaken for
         something from the catalog and is not taxed as merchandise. */
      order.service_charges = [{
        uid: 'shipping',
        name: settings.shipping.serviceChargeName + ' — ' + charge.label,
        amount_money: { amount: charge.amount, currency: charge.currency },
        calculation_phase: 'SUBTOTAL_PHASE',
        taxable: false
      }];
    }
  }

  return order;
}

/* ------------------------------------------------------- the payment link */

export async function createPaymentLink(square, {
  order, idempotencyKey, returnUrl, description
}) {
  const body = {
    idempotency_key: idempotencyKey,
    order,
    checkout_options: {
      allow_tipping: false,
      /* Off by default: we validated the address ourselves and put it on the
         fulfillment, so asking again would give two answers. */
      ask_for_shipping_address: ASK_FOR_SHIPPING_ADDRESS,
      /* Where Square sends the buyer afterwards. The token in this URL is the
         only thing that lets that page read the order, and the page still
         asks our API what really happened rather than believing the redirect. */
      redirect_url: returnUrl
    }
  };
  if (description) body.description = description;

  const created = await square.call('/v2/online-checkout/payment-links', { method: 'POST', body, idempotent: true });
  const link = created.payment_link;
  if (!link?.url) {
    console.error('payment_link_missing_url', JSON.stringify({ keys: Object.keys(created || {}) }));
    throw new Error('Square did not return a checkout URL.');
  }
  return {
    checkoutUrl: link.url,
    longUrl: link.long_url || null,
    orderId: link.order_id || null,
    paymentLinkId: link.id || null
  };
}

/* ------------------------------------------------- what actually happened */

/* A redirect is not a receipt and a payment link is not a payment. The only
   answer this service will give about an order is the one Square just gave
   about it. */
export async function readOrderStatus(square, orderId) {
  const res = await square.call('/v2/orders/' + encodeURIComponent(orderId));
  const order = res.order;
  if (!order) return { status: 'unknown' };

  const tenders = order.tenders || [];
  const totalPaid = Number(order.net_amount_due_money?.amount ?? NaN);

  let status;
  if (order.state === 'COMPLETED') status = 'paid';
  else if (order.state === 'CANCELED') status = 'canceled';
  else if (tenders.length && Number.isFinite(totalPaid) && totalPaid <= 0) status = 'paid';
  else if (tenders.length) status = 'pending';
  else status = 'pending';

  return {
    status,
    state: order.state || null,
    orderId: order.id,
    createdAt: order.created_at || null,
    closedAt: order.closed_at || null,
    totals: {
      total: Number(order.total_money?.amount ?? 0),
      tax: Number(order.total_tax_money?.amount ?? 0),
      discount: Number(order.total_discount_money?.amount ?? 0),
      serviceCharge: Number(order.total_service_charge_money?.amount ?? 0),
      currency: order.total_money?.currency || 'USD'
    },
    lines: (order.line_items || []).map(li => ({
      name: li.name || null,
      variationName: li.variation_name || null,
      quantity: li.quantity,
      total: Number(li.total_money?.amount ?? 0),
      currency: li.total_money?.currency || 'USD'
    })),
    fulfillment: (order.fulfillments || []).map(f => ({
      type: f.type || null,
      state: f.state || null
    }))
  };
}
