/* ==========================================================================
   All Star Players / store API
   --------------------------------------------------------------------------
   One AWS Lambda behind an HTTP API. Everything the storefront needs, and
   nothing it could use to cheat.

     GET  /config            what the shop offers: pickup, shipping zones, limits
     GET  /catalog           the sellable catalog, paginated, cached
     POST /catalog/refresh   force a refetch (needs the admin key)
     POST /cart/validate     reconcile a cart against live prices and stock
     POST /checkout          build the order and get a Square checkout page
     GET  /order             what Square says about an order, by status token
     POST /webhooks/square   signed Square notifications

   The Square access token lives in Secrets Manager and never appears in a
   response, a log line or the frontend. Prices always come from Square's
   catalog. Shipping comes from the shop's configured zones. Tax comes from
   the shop's own Square tax rules. None of those is ever read from the
   browser.

   Runtime: Node.js 24. Dependencies are bundled by `npm run package`.
   ========================================================================== */

import { randomUUID, createHash } from 'node:crypto';

import { loadSecrets, settings, publicConfig, ConfigError } from './lib/config.mjs';
import { createSquareClient, SquareError } from './lib/square.mjs';
import { buildCatalogSnapshot } from './lib/catalog.mjs';
import { createStore, sha256, newToken, StoreError } from './lib/store.mjs';
import { reconcileCart, cartFingerprint } from './lib/cart.mjs';
import { validateFulfillment } from './lib/fulfillment.mjs';
import { buildOrder, createPaymentLink, readOrderStatus } from './lib/checkout.mjs';
import { verifySignature, interpret, shouldApply, SIGNATURE_HEADER } from './lib/webhook.mjs';
import {
  methodOf, routePath, rawBody, header, query, reply, parseJsonBody, corsHeaders
} from './lib/http.mjs';

/* A warm container keeps the catalog in memory so most requests touch neither
   DynamoDB nor Square. */
let warmCatalog = null;

/* ------------------------------------------------------------- catalog */

async function getCatalog(square, s, store, { force = false } = {}) {
  const env = square.host.includes('sandbox') ? 'sandbox' : 'production';
  const freshEnough = warmCatalog && Date.now() - warmCatalog.at < s.catalogTtlSeconds * 1000;
  if (!force && freshEnough) return warmCatalog.snapshot;

  if (!force) {
    const cached = await store.readCatalog(env);
    if (cached) {
      warmCatalog = { snapshot: cached.snapshot, at: Date.now() };
      return cached.snapshot;
    }
  }

  try {
    const snapshot = await buildCatalogSnapshot(square, s);
    warmCatalog = { snapshot, at: Date.now() };
    await store.writeCatalog(env, snapshot, s.catalogTtlSeconds)
      .catch(err => console.error('catalog_cache_write_failed', err?.message));
    return snapshot;
  } catch (err) {
    /* Square being down should not empty the shop. An old catalog, clearly
       labelled as old, beats a blank page — and checkout revalidates against
       Square anyway, so nothing stale can actually be sold at a stale price. */
    const stale = await store.readCatalogStale(env).catch(() => null);
    if (stale) {
      console.error('catalog_serving_stale', err?.message);
      warmCatalog = { snapshot: { ...stale.snapshot, stale: true }, at: Date.now() };
      return warmCatalog.snapshot;
    }
    throw err;
  }
}

async function handleCatalog(event, ctx) {
  const { square, s, store } = ctx;
  const snapshot = await getCatalog(square, s, store);

  const limit = Math.min(Math.max(Number.parseInt(query(event, 'limit') || '', 10) || s.catalogPageSize, 1), 300);
  const offset = Math.max(Number.parseInt(query(event, 'cursor') || '', 10) || 0, 0);
  const page = snapshot.products.slice(offset, offset + limit);
  const next = offset + limit < snapshot.products.length ? String(offset + limit) : null;

  return reply(200, event, {
    success: true,
    environment: ctx.cfg.environment,
    fetchedAt: snapshot.fetchedAt,
    stale: snapshot.stale === true,
    total: snapshot.products.length,
    /* Categories and counts ride along on the first page only, so later pages
       stay small. */
    ...(offset === 0 ? { categories: snapshot.categories, counts: snapshot.counts } : {}),
    products: page,
    cursor: next
  }, {
    allowedOrigins: s.allowedOrigins,
    /* Short browser cache: the storefront is allowed to be a minute behind,
       because nothing it shows is what gets charged. */
    cache: 'public, max-age=60'
  });
}

async function handleRefresh(event, ctx) {
  const { cfg, square, s, store } = ctx;
  if (!cfg.adminKey) {
    return reply(404, event, { success: false, error: 'NOT_FOUND', message: 'Refresh is switched off.' },
      { allowedOrigins: s.allowedOrigins });
  }
  const provided = header(event, 'x-admin-key') || '';
  if (sha256(provided) !== sha256(cfg.adminKey)) {
    return reply(403, event, { success: false, error: 'FORBIDDEN', message: 'Wrong admin key.' },
      { allowedOrigins: s.allowedOrigins });
  }
  warmCatalog = null;
  const snapshot = await getCatalog(square, s, store, { force: true });
  return reply(200, event, {
    success: true, fetchedAt: snapshot.fetchedAt, counts: snapshot.counts
  }, { allowedOrigins: s.allowedOrigins });
}

/* ---------------------------------------------------------------- cart */

async function handleCartValidate(event, ctx) {
  const { s, square, store } = ctx;
  const { body, error } = parseJsonBody(event);
  if (error) return reply(400, event, { success: false, error: 'BAD_JSON', message: error }, { allowedOrigins: s.allowedOrigins });

  const snapshot = await getCatalog(square, s, store);
  const result = await reconcileCart(body.lines, { snapshot, settings: s, store });
  if (!result.ok) {
    return reply(400, event, { success: false, error: result.error, message: result.message },
      { allowedOrigins: s.allowedOrigins });
  }
  return reply(200, event, { success: true, cart: result }, { allowedOrigins: s.allowedOrigins });
}

/* ------------------------------------------------------------ checkout */

async function handleCheckout(event, ctx) {
  const { cfg, s, square, store } = ctx;
  const { body, error } = parseJsonBody(event);
  if (error) return reply(400, event, { success: false, error: 'BAD_JSON', message: error }, { allowedOrigins: s.allowedOrigins });

  const attemptId = typeof body.attemptId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.attemptId)
    ? body.attemptId : null;
  if (!attemptId) {
    return reply(400, event, {
      success: false, error: 'BAD_ATTEMPT_ID',
      message: 'Send an attemptId of 8 to 64 url-safe characters.'
    }, { allowedOrigins: s.allowedOrigins });
  }

  const snapshot = await getCatalog(square, s, store);

  /* Holds placed by this same attempt are excluded, so pressing Pay twice
     does not make the customer compete with themselves for the last unit. */
  const cart = await reconcileCart(body.lines, { snapshot, settings: s, store, attemptId });
  if (!cart.ok) {
    return reply(400, event, { success: false, error: cart.error, message: cart.message },
      { allowedOrigins: s.allowedOrigins });
  }

  if (!cart.payableLines.length) {
    return reply(409, event, {
      success: false, error: 'CART_EMPTY_AFTER_REVIEW',
      message: 'Nothing in the cart can be bought right now.',
      cart
    }, { allowedOrigins: s.allowedOrigins });
  }

  /* Anything changed since the customer last looked gets sent back for them
     to approve. This is a 409, not a failure: the cart in the body is the
     corrected one. */
  if (cart.changed) {
    return reply(409, event, {
      success: false, error: 'CART_CHANGED',
      message: 'Some items changed. Review the updated cart before paying.',
      cart
    }, { allowedOrigins: s.allowedOrigins });
  }

  const fulfillmentResult = validateFulfillment(body.fulfillment, {
    settings: s, subtotal: cart.totals.subtotal
  });
  if (!fulfillmentResult.ok) {
    return reply(400, event, {
      success: false, error: 'FULFILLMENT_INVALID',
      message: 'Check the delivery details.',
      fieldErrors: fulfillmentResult.errors
    }, { allowedOrigins: s.allowedOrigins });
  }
  const fulfillment = fulfillmentResult.fulfillment;

  /* The idempotency key is the attempt plus a fingerprint of exactly what is
     being bought and how it is getting there. A retried request reuses it and
     gets the same link back; an edited cart produces a different key and a
     genuinely new order. It lives in DynamoDB, so it survives the container. */
  const fingerprint = cartFingerprint(cart.payableLines, fulfillment);
  const idemKey = createHash('sha256').update(attemptId + '::' + fingerprint).digest('hex');

  const claim = await store.claimIdempotency(idemKey);
  if (!claim.claimed) {
    const rec = claim.record;
    if (rec?.status === 'DONE' && rec.result?.checkoutUrl) {
      return reply(200, event, { success: true, replayed: true, ...rec.result },
        { allowedOrigins: s.allowedOrigins });
    }
    /* Another request for this exact attempt is mid-flight. Telling the
       customer to wait a moment is better than opening a second order. */
    return reply(409, event, {
      success: false, error: 'CHECKOUT_IN_PROGRESS',
      message: 'This checkout is already being created. Give it a moment and try again.'
    }, { allowedOrigins: s.allowedOrigins });
  }

  const taxIndex = new Map((snapshot.taxes || []).filter(t => t.enabled).map(t => [t.id, t]));
  const statusToken = newToken();

  try {
    if (s.holdsEnabled) {
      await store.placeHolds(attemptId, cart.payableLines.map(l => ({
        variationId: l.variationId, quantity: l.quantity
      })), { holdSeconds: s.holdSeconds }).catch(err => console.error('hold_place_failed', err?.message));
    }

    const referenceId = ('web-' + attemptId).slice(0, 40);
    const order = buildOrder({
      locationId: square.locationId,
      lines: cart.payableLines,
      fulfillment, settings: s, taxes: taxIndex, referenceId
    });

    const returnUrl = s.returnUrl + (s.returnUrl.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(statusToken);
    const link = await createPaymentLink(square, {
      order,
      idempotencyKey: idemKey,
      returnUrl,
      description: s.storeName + ' online order'
    });

    const record = {
      checkoutUrl: link.checkoutUrl,
      orderId: link.orderId,
      paymentLinkId: link.paymentLinkId,
      statusToken,
      environment: cfg.environment,
      fulfillmentType: fulfillment.type,
      /* So the storefront can clear exactly the lines that were bought and
         leave anything else alone. */
      purchasedVariationIds: cart.payableLines.map(l => l.variationId)
    };

    if (link.orderId) {
      await store.saveOrder({
        orderId: link.orderId,
        statusTokenHash: sha256(statusToken),
        status: 'pending',
        attemptId,
        environment: cfg.environment,
        fulfillmentType: fulfillment.type,
        contactEmail: fulfillment.contact.email,
        createdAt: Date.now(),
        lines: cart.payableLines.map(l => ({
          variationId: l.variationId, productName: l.productName,
          name: l.name, quantity: l.quantity, unitPrice: l.unitPrice
        })),
        subtotal: cart.totals.subtotal,
        shippingAmount: fulfillment.shipping?.amount ?? 0,
        currency: cart.totals.currency
      }, { retentionDays: s.orderRetentionDays });
    }

    await store.completeIdempotency(idemKey, record);

    return reply(200, event, {
      success: true,
      ...record,
      /* Said plainly, because the next thing that happens is a redirect and
         a redirect proves nothing. */
      paymentConfirmed: false,
      pickupPolicy: fulfillment.type === 'pickup' ? s.pickup.policy : null,
      shipping: fulfillment.shipping
    }, { allowedOrigins: s.allowedOrigins });

  } catch (err) {
    /* A failed attempt must not wedge the key, or the customer can never try
       again with the same cart. */
    await store.releaseIdempotency(idemKey);
    if (s.holdsEnabled) {
      await store.releaseHolds(attemptId, cart.payableLines.map(l => l.variationId));
    }
    throw err;
  }
}

/* --------------------------------------------------------- order status */

async function handleOrderStatus(event, ctx) {
  const { s, square, store } = ctx;
  const token = query(event, 't') || '';
  if (!token || token.length < 20 || token.length > 128) {
    return reply(400, event, { success: false, error: 'BAD_TOKEN', message: 'Missing order token.' },
      { allowedOrigins: s.allowedOrigins });
  }

  /* Lookup is by the hash of the token only. There is no way to ask this
     endpoint about an order by its id, so one customer cannot read another's. */
  const orderId = await store.getOrderIdForToken(sha256(token));
  if (!orderId) {
    return reply(404, event, { success: false, error: 'NOT_FOUND', message: 'No order matches that link.' },
      { allowedOrigins: s.allowedOrigins });
  }

  const stored = await store.getOrder(orderId);
  let live = null;
  try {
    live = await readOrderStatus(square, orderId);
  } catch (err) {
    console.error('order_status_lookup_failed', err?.message);
  }

  /* Square is the authority. The stored row is a fallback for when Square is
     briefly unreachable, and it says so. */
  const status = live?.status || stored?.status || 'pending';
  if (live && stored && shouldApply(stored.status, live.status)) {
    await store.updateOrderStatus(orderId, { status: live.status })
      .catch(err => console.error('order_status_write_failed', err?.message));
  }

  return reply(200, event, {
    success: true,
    verified: Boolean(live),
    status,
    fulfillmentType: stored?.fulfillmentType || null,
    pickupPolicy: stored?.fulfillmentType === 'pickup' ? s.pickup.policy : null,
    pickupAddress: stored?.fulfillmentType === 'pickup' ? s.pickup.address : null,
    purchasedVariationIds: (stored?.lines || []).map(l => l.variationId),
    order: live ? {
      createdAt: live.createdAt, totals: live.totals, lines: live.lines, fulfillment: live.fulfillment
    } : null
  }, { allowedOrigins: s.allowedOrigins });
}

/* -------------------------------------------------------------- webhook */

async function handleWebhook(event, ctx) {
  const { cfg, s, store } = ctx;
  const body = rawBody(event);

  if (!cfg.webhookSignatureKey) {
    console.error('webhook_rejected_no_key');
    return { statusCode: 503, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'WEBHOOKS_NOT_CONFIGURED' }) };
  }

  const notificationUrl = process.env.WEBHOOK_NOTIFICATION_URL || '';
  if (!notificationUrl) {
    console.error('webhook_rejected_no_url');
    return { statusCode: 503, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'WEBHOOK_URL_NOT_CONFIGURED' }) };
  }

  const ok = verifySignature({
    notificationUrl, rawBody: body,
    signatureKey: cfg.webhookSignatureKey,
    provided: header(event, SIGNATURE_HEADER)
  });
  if (!ok) {
    console.error('webhook_bad_signature');
    /* 401 and nothing else. An attacker learns only that it was refused. */
    return { statusCode: 401, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'BAD_SIGNATURE' }) };
  }

  let parsed;
  try { parsed = JSON.parse(body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'BAD_JSON' }) };
  }

  const eventId = parsed.event_id || parsed.id;
  if (eventId) {
    const first = await store.claimWebhookEvent(eventId);
    /* Square redelivers. A repeat is a success, not a problem: answering 200
       is what stops it being retried forever. */
    if (!first) return { statusCode: 200, body: JSON.stringify({ ok: true, duplicate: true }) };
  }

  const meaning = interpret(parsed);
  if (!meaning) return { statusCode: 200, body: JSON.stringify({ ok: true, ignored: true }) };

  const stored = await store.getOrder(meaning.orderId);
  if (!stored) {
    /* An order this website did not create — an in-store sale, for instance.
       Nothing to update and nothing to worry about. */
    return { statusCode: 200, body: JSON.stringify({ ok: true, unknownOrder: true }) };
  }

  if (shouldApply(stored.status, meaning.status)) {
    await store.updateOrderStatus(meaning.orderId, {
      status: meaning.status,
      lastEventId: eventId || null,
      lastEventSource: meaning.source
    });
  }

  /* Inventory is deliberately untouched. Square decrements catalog stock
     itself when an order with catalog line items is paid, so adjusting it
     here would take the same units off the shelf twice. */
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
}

/* ----------------------------------------------------------------- entry */

const ROUTES = [
  ['GET',  '/config',          (e, c) => reply(200, e, { success: true, config: publicConfig(c.cfg, c.s) }, { allowedOrigins: c.s.allowedOrigins, cache: 'public, max-age=120' })],
  ['GET',  '/catalog',         handleCatalog],
  ['POST', '/catalog/refresh', handleRefresh],
  ['POST', '/cart/validate',   handleCartValidate],
  ['POST', '/checkout',        handleCheckout],
  ['GET',  '/order',           handleOrderStatus],
  ['POST', '/webhooks/square', handleWebhook]
];

export const handler = async (event) => {
  const method = methodOf(event);
  const path = routePath(event);
  const s = settings();

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(event, s.allowedOrigins), body: '' };
  }

  const route = ROUTES.find(([m, p]) => m === method && p === path);
  if (!route) {
    return reply(404, event, {
      success: false, error: 'NOT_FOUND', message: 'No route for ' + method + ' ' + path
    }, { allowedOrigins: s.allowedOrigins });
  }

  const requestId = event.requestContext?.requestId || randomUUID();
  try {
    const cfg = await loadSecrets();
    const square = createSquareClient(cfg);
    const store = createStore({ tableName: s.tableName });
    return await route[2](event, { cfg, s, square, store });
  } catch (err) {
    if (err instanceof SquareError) {
      const pub = err.toPublic();
      return reply(err.status >= 500 ? 502 : err.status, event, {
        success: false, error: 'SQUARE_ERROR', message: pub.message, details: pub.details, requestId
      }, { allowedOrigins: s.allowedOrigins });
    }
    if (err instanceof ConfigError || err instanceof StoreError) {
      /* Names the setting at fault, never its value. */
      console.error('config_error', requestId, err.message);
      return reply(500, event, { success: false, error: 'CONFIG_ERROR', message: err.message, requestId },
        { allowedOrigins: s.allowedOrigins });
    }
    console.error('unhandled_error', requestId, err?.stack || err?.message || err);
    return reply(500, event, { success: false, error: 'SERVER_ERROR', message: 'Something went wrong.', requestId },
      { allowedOrigins: s.allowedOrigins });
  }
};

/* Exported for the tests, which drive the handlers directly with fakes rather
   than standing up DynamoDB and Square. */
export const __internal = { getCatalog, handleCheckout, handleCatalog, handleWebhook, handleOrderStatus, handleCartValidate };
