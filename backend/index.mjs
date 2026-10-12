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
     POST /admin/sweep       run the abandoned-checkout cleanup by hand
     GET  /admin/stuck       holds cleanup could not settle, awaiting a person
     POST /admin/holds/release   free one of those, after a human has checked

   It is also invoked off an HTTP request entirely: EventBridge sends
   { task: 'sweep-abandoned-checkouts' } on a schedule to cancel abandoned
   payment links and free the stock they were holding. See lib/cleanup.mjs.

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
import { verifyVariationsLive, AvailabilityUnverifiedError } from './lib/catalog.mjs';
import { createStore, sha256, newToken, StoreError } from './lib/store.mjs';
import { reconcileCart, cartFingerprint } from './lib/cart.mjs';
import { validateFulfillment } from './lib/fulfillment.mjs';
import { buildOrder, createPaymentLink, readOrderStatus } from './lib/checkout.mjs';
import { sweepAbandonedCheckouts } from './lib/cleanup.mjs';
import { refreshCatalog } from './lib/refresh.mjs';
import { verifySignature, interpret, shouldApply, SIGNATURE_HEADER, isTerminal } from './lib/webhook.mjs';
import {
  methodOf, routePath, rawBody, header, query, reply, parseJsonBody, corsHeaders
} from './lib/http.mjs';

/* A warm container keeps recently-read builds in memory, keyed by build id.
   More than one, because a client paging through the shop stays pinned to the
   build it started on while a refresh publishes a newer one. */
const warmBuilds = new Map();
const WARM_LIMIT = 3;

function rememberBuild(entry) {
  warmBuilds.set(entry.buildId, entry);
  while (warmBuilds.size > WARM_LIMIT) warmBuilds.delete(warmBuilds.keys().next().value);
  return entry;
}

/* Nothing reachable over HTTP is allowed to rebuild the catalog. Rebuilding
   means paging all of Square, which took longer than the function's timeout
   and far longer than API Gateway's thirty seconds. Browsing reads the
   snapshot the scheduled refresh left behind, or says it is not ready yet. */
export class CatalogNotReadyError extends Error {
  constructor(reason) {
    super(reason === 'unreadable'
      ? 'The shop catalog is being rebuilt. Please try again in a moment.'
      : 'The shop is still loading its catalog for the first time. Please try again in a moment.');
    this.name = 'CatalogNotReadyError';
    this.reason = reason;
  }
}

/* The page the client asked to continue belongs to a build that has since
   been cleaned up. Mixing it with the current one would hand them a list with
   products missing or repeated, so they are told to start again instead. */
export class CursorExpiredError extends Error {
  constructor(currentBuildId) {
    super('The product list was updated while you were browsing. Loading it again.');
    this.name = 'CursorExpiredError';
    this.currentBuildId = currentBuildId || null;
  }
}

/* Whatever build the pointer names right now. */
async function getCurrentCatalog(ctx) {
  const { store, cfg } = ctx;
  const env = cfg.environment;

  const pointer = await store.readCatalogPointer(env);
  if (!pointer?.buildId) throw new CatalogNotReadyError('no_snapshot');
  const warm = warmBuilds.get(pointer.buildId);
  if (warm) return warm;

  const read = await store.readCatalogSnapshot(env);
  if (!read || !read.snapshot) {
    /* The pointer names a build whose chunks will not read back, and reading
       again did not help. Builds are published atomically and kept for a
       grace period after they are replaced, so this should not happen. */
    console.error('catalog_pointer_unreadable', JSON.stringify({ env, buildId: pointer.buildId }));
    throw new CatalogNotReadyError('unreadable');
  }
  return rememberBuild({
    snapshot: read.snapshot,
    buildId: read.buildId,
    fetchedAt: read.fetchedAt || null,
    builtAt: Number(read.builtAt || 0) || null
  });
}

/* One named build, for continuing a page run that started on it. */
async function getPinnedCatalog(ctx, buildId) {
  const { store, cfg } = ctx;
  const env = cfg.environment;

  const warm = warmBuilds.get(buildId);
  if (warm) {
    /* Having it in memory is not permission to serve it. Builds are kept for
       a retention window after they are replaced, and once that has passed
       and the build is deleted, every other container stops being able to
       serve these pages. This one should answer the same way, rather than
       being the single box that still hands out a build nobody else has. */
    const retained = await store.readBuildLedger(env).catch(() => null);
    if (retained && retained.length && !retained.some(b => b.id === buildId)) {
      warmBuilds.delete(buildId);
      const pointer = await store.readCatalogPointer(env).catch(() => null);
      throw new CursorExpiredError(pointer?.buildId);
    }
    return warm;
  }

  const snapshot = await store.readCatalogBuild(env, buildId);
  if (!snapshot) {
    const pointer = await store.readCatalogPointer(env).catch(() => null);
    throw new CursorExpiredError(pointer?.buildId);
  }
  /* The pointer only carries timings for the build it names, so an older
     build's age comes from the timestamp inside the snapshot itself. */
  const pointer = await store.readCatalogPointer(env).catch(() => null);
  const live = pointer?.buildId === buildId;
  return rememberBuild({
    snapshot, buildId,
    fetchedAt: (live ? pointer.fetchedAt : null) || snapshot.fetchedAt || null,
    builtAt: live ? Number(pointer.builtAt || 0) || null : null
  });
}

/* The cursor carries the build it belongs to, not just a position. An offset
   on its own is meaningless once the catalog has been rebuilt underneath it:
   page one from the old build plus page two from the new one is a list with
   products repeated and products missing. */
function encodeCursor(buildId, offset) { return buildId + '~' + offset; }

function decodeCursor(raw) {
  if (!raw) return { first: true };
  const at = String(raw).indexOf('~');
  /* No build in it: the pre-pinning format, or something hand-made. There is
     no safe way to place it, so it is expired rather than guessed at. */
  if (at < 1) return { invalid: true };
  const buildId = raw.slice(0, at);
  const offset = Number.parseInt(raw.slice(at + 1), 10);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(buildId)) return { invalid: true };
  if (!Number.isInteger(offset) || offset < 0) return { invalid: true };
  return { buildId, offset };
}

/* Age is reported from when the build was taken, not from when this container
   happened to read it. */
function freshness(entry, s) {
  const basis = entry.builtAt || Date.parse(entry.fetchedAt || '') || 0;
  const ageSeconds = basis ? Math.max(0, Math.round((Date.now() - basis) / 1000)) : null;
  return {
    fetchedAt: entry.fetchedAt,
    buildId: entry.buildId,
    ageSeconds,
    /* Stale means "older than we aim for", not "wrong". It is still served,
       and checkout re-reads prices and stock from Square regardless. */
    stale: ageSeconds !== null && ageSeconds > s.catalogTtlSeconds
  };
}

async function handleCatalog(event, ctx) {
  const { s } = ctx;
  const cursor = decodeCursor(query(event, 'cursor'));
  if (cursor.invalid) {
    const pointer = await ctx.store.readCatalogPointer(ctx.cfg.environment).catch(() => null);
    throw new CursorExpiredError(pointer?.buildId);
  }

  const entry = cursor.first ? await getCurrentCatalog(ctx) : await getPinnedCatalog(ctx, cursor.buildId);
  const snapshot = entry.snapshot;

  const limit = Math.min(Math.max(Number.parseInt(query(event, 'limit') || '', 10) || s.catalogPageSize, 1), 300);
  const offset = cursor.first ? 0 : cursor.offset;
  const page = snapshot.products.slice(offset, offset + limit);
  const next = offset + limit < snapshot.products.length
    ? encodeCursor(entry.buildId, offset + limit)
    : null;

  return reply(200, event, {
    success: true,
    environment: ctx.cfg.environment,
    ...freshness(entry, s),
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

/* Asks for a refresh; does not perform one. A full rebuild takes minutes and
   would be cut off by API Gateway long before it finished, so this hands the
   job to a background invocation of this same function and answers at once. */
async function handleRefresh(event, ctx) {
  const { cfg, s, store } = ctx;
  const refused = adminRejection(event, cfg, s);
  if (refused) return refused;

  const status = await store.readCatalogStatus(cfg.environment).catch(() => null);
  const triggered = await triggerBackgroundRefresh(cfg.environment);

  return reply(triggered.ok ? 202 : 503, event, {
    success: triggered.ok,
    accepted: triggered.ok,
    message: triggered.ok
      ? 'Refresh started in the background. It takes a few minutes; the current catalog keeps serving until it finishes.'
      : 'Could not start a background refresh: ' + triggered.error,
    lastSuccessAt: status?.lastSuccessAt ?? null,
    lastError: status?.lastError ?? null
  }, { allowedOrigins: s.allowedOrigins });
}

/* Invokes this same Lambda again, asynchronously, with the refresh task. The
   function name comes from the runtime, so there is nothing to configure
   beyond the IAM permission to invoke itself. */
async function triggerBackgroundRefresh(environment) {
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!functionName) return { ok: false, error: 'not running in Lambda' };
  try {
    const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
    const client = new LambdaClient({});
    await client.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event',          /* fire and forget */
      Payload: Buffer.from(JSON.stringify({ task: 'refresh-catalog', environment }))
    }));
    return { ok: true };
  } catch (err) {
    console.error('refresh_trigger_failed', err?.message);
    return { ok: false, error: String(err?.message || err) };
  }
}

/* What the scheduled refresh last did, for the launch checklist and for
   working out why the shop is showing something old. */
async function handleCatalogStatusRoute(event, ctx) {
  const { cfg, s, store } = ctx;
  const refused = adminRejection(event, cfg, s);
  if (refused) return refused;

  const env = cfg.environment;
  const [pointer, status] = await Promise.all([
    store.readCatalogPointer(env).catch(() => null),
    store.readCatalogStatus(env).catch(() => null)
  ]);
  const builtAt = Number(pointer?.builtAt || 0);

  return reply(200, event, {
    success: true,
    environment: env,
    live: pointer ? {
      buildId: pointer.buildId, chunkCount: pointer.chunkCount, bytes: pointer.bytes ?? null,
      fetchedAt: pointer.fetchedAt, builtAt: builtAt || null,
      ageSeconds: builtAt ? Math.round((Date.now() - builtAt) / 1000) : null,
      counts: pointer.counts ?? null
    } : null,
    lastRefresh: status ? {
      lastAttemptAt: status.lastAttemptAt ?? null,
      lastSuccessAt: status.lastSuccessAt ?? null,
      lastDurationMs: status.lastDurationMs ?? null,
      lastError: status.lastError ?? null,
      lastErrorAt: status.lastErrorAt ?? null,
      running: status.running === true
    } : null
  }, { allowedOrigins: s.allowedOrigins });
}

/* ---------------------------------------------------------------- cart *//* ---------------------------------------------------------------- cart */

async function handleCartValidate(event, ctx) {
  const { s, square, store } = ctx;
  const { body, error } = parseJsonBody(event);
  if (error) return reply(400, event, { success: false, error: 'BAD_JSON', message: error }, { allowedOrigins: s.allowedOrigins });

  const { snapshot } = await getCurrentCatalog(ctx);
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

  /* Only ever a hint for the return page about which cart to tidy up. It is
     not part of the fingerprint, so buying the same thing from the cart or
     from Buy Now cannot produce two orders. */
  const source = body.source === 'buynow' ? 'buynow' : 'cart';

  /* A first pass purely to find out which variations are being asked for.
     Nothing is authorised on it. */
  const requested = Array.isArray(body.lines) ? body.lines : [];
  const ids = [...new Set(requested
    .map(l => (l && typeof l.variationId === 'string') ? l.variationId.trim() : '')
    .filter(id => /^[A-Za-z0-9_-]{1,64}$/.test(id)))];
  if (!ids.length) {
    return reply(400, event, { success: false, error: 'BAD_CART', message: 'The cart is empty.' },
      { allowedOrigins: s.allowedOrigins });
  }
  if (ids.length > s.maxCartLines) {
    return reply(400, event, {
      success: false, error: 'BAD_CART', message: 'That is more than ' + s.maxCartLines + ' different items.'
    }, { allowedOrigins: s.allowedOrigins });
  }

  /* THE authorisation read. Straight to Square, every time, for exactly
     these variations. Never the browsing cache, and never the stale
     fallback: a cached price or a cached stock level is fine for a shop
     window and not fine for taking money. */
  const verified = await verifyVariationsLive(square, ids, s);

  /* Holds placed by this same attempt are excluded, so pressing Pay twice
     does not make the customer compete with themselves for the last unit. */
  const cart = await reconcileCart(body.lines, { snapshot: verified, settings: s, store, attemptId });
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
     corrected one, priced from the live read above. */
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
     being bought and exactly where it is going. A retried request reuses it
     and gets the same link back; change a quantity, a street, an apartment
     number or a phone number and it becomes a genuinely new order. It lives
     in DynamoDB, so it survives the container. */
  const fingerprint = cartFingerprint(cart.payableLines, fulfillment);
  const idemKey = createHash('sha256').update(attemptId + '::' + fingerprint).digest('hex');

  /* The token is handed to claimIdempotency so it is written down BEFORE
     Square is called. If this container dies in between, the retry adopts
     the same token and re-sends the same Square request. */
  const claim = await store.claimIdempotency(idemKey, { statusToken: newToken() });
  if (!claim.claimed) {
    const rec = claim.record;
    if (claim.state === 'done' && rec?.result?.checkoutUrl) {
      return reply(200, event, { success: true, replayed: true, ...rec.result },
        { allowedOrigins: s.allowedOrigins });
    }
    /* Another request for this exact attempt is genuinely mid-flight. */
    return reply(409, event, {
      success: false, error: 'CHECKOUT_IN_PROGRESS',
      message: 'This checkout is already being created. Give it a moment and try again.'
    }, { allowedOrigins: s.allowedOrigins });
  }
  const statusToken = claim.statusToken;
  const recovering = claim.state === 'recovered';
  const renewed = claim.state === 'renewed';

  /* Our row key stays the same so the attempt can always be found again. The
     key Square sees carries a generation, bumped whenever cleanup has killed
     the previous link — otherwise Square's own idempotency would hand back
     the dead one. */
  const generation = Number(claim.generation || 0);
  const squareIdempotencyKey = generation === 0
    ? idemKey
    : createHash('sha256').update(idemKey + '::g' + generation).digest('hex');

  const taxIndex = new Map((verified.taxes || []).filter(t => t.enabled).map(t => [t.id, t]));

  let heldVariationIds = [];
  /* Set the moment Square answers. After that point the link is out there and
     payable, so the error paths below must NOT hand the stock back. */
  let liveLink = null;
  try {
    /* Availability straight from the verified read, so the hold is checked
       against what Square says right now. Taking the hold and checking the
       room are one atomic step inside the store, which is what stops two
       Lambdas both selling the last unit. */
    if (s.holdsEnabled) {
      const availability = new Map();
      for (const line of cart.payableLines) {
        /* The raw shelf count, not the hold-adjusted one: acquireHolds
           subtracts the other live holds itself. */
        availability.set(line.variationId, line.inventoryState === 'UNKNOWN' ? null : line.onHand);
      }
      const acquired = await store.acquireHolds(
        attemptId,
        cart.payableLines.map(l => ({ variationId: l.variationId, quantity: l.quantity })),
        { holdSeconds: s.holdSeconds, availability }
      );
      if (!acquired.ok) {
        /* Somebody else took it between the read and the hold. Send the cart
           back for review rather than creating an order we cannot fill. */
        await store.markIdempotencyRecoverable(idemKey);
        const conflict = acquired.conflict;
        const line = cart.payableLines.find(l => l.variationId === conflict.variationId);
        return reply(409, event, {
          success: false, error: 'CART_CHANGED',
          message: 'Someone else is buying the last of that. Review your cart and try again.',
          cart: {
            ...cart,
            changed: true,
            problems: cart.problems.concat([{
              code: conflict.available > 0 ? 'QUANTITY_REDUCED' : 'OUT_OF_STOCK',
              variationId: conflict.variationId,
              productName: line?.productName || null,
              available: conflict.available,
              message: conflict.available > 0
                ? 'Only ' + conflict.available + ' of ' + (line?.productName || 'that item') + ' left.'
                : (line?.productName || 'That item') + ' has just sold out.'
            }])
          }
        }, { allowedOrigins: s.allowedOrigins });
      }
      heldVariationIds = acquired.held;
    }

    const referenceId = ('web-' + attemptId).slice(0, 40);
    const order = buildOrder({
      locationId: square.locationId,
      lines: cart.payableLines,
      fulfillment, settings: s, taxes: taxIndex, referenceId
    });

    const returnUrl = s.returnUrl + (s.returnUrl.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(statusToken);
    /* Same key as last time on a recovery, which is the whole point: Square
       hands back the link it already made rather than making a second one. */
    const link = await createPaymentLink(square, {
      order,
      idempotencyKey: squareIdempotencyKey,
      returnUrl,
      description: s.storeName + ' online order'
    });
    liveLink = link;

    const record = {
      checkoutUrl: link.checkoutUrl,
      orderId: link.orderId,
      paymentLinkId: link.paymentLinkId,
      statusToken,
      environment: cfg.environment,
      fulfillmentType: fulfillment.type,
      purchaseSource: source,
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
        purchaseSource: source,
        contactEmail: fulfillment.contact.email,
        createdAt: Date.now(),
        holdsReleased: false,
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

    /* The hold now outlives its own clock on purpose, so something has to
       come back and settle it. Queue that before answering: a checkout whose
       cleanup job went missing would hold stock until the backstop. */
    if (s.holdsEnabled && heldVariationIds.length) {
      await store.enqueueSweep({
        attemptId,
        dueAt: Math.floor(Date.now() / 1000) + s.holdSeconds + s.cleanupGraceSeconds,
        orderId: link.orderId,
        paymentLinkId: link.paymentLinkId,
        idemKey,
        variationIds: heldVariationIds,
        createdAt: Date.now()
      }).catch(err => console.error('sweep_enqueue_failed', attemptId, err?.message));
    }

    return reply(200, event, {
      success: true,
      ...record,
      ...(recovering ? { recovered: true } : {}),
      ...(renewed ? { renewed: true } : {}),
      /* Said plainly, because the next thing that happens is a redirect and
         a redirect proves nothing. */
      paymentConfirmed: false,
      pickupPolicy: fulfillment.type === 'pickup' ? s.pickup.policy : null,
      shipping: fulfillment.shipping
    }, { allowedOrigins: s.allowedOrigins });

  } catch (err) {
    /* Keep the reservation row — it holds the status token, and Square may
       already have a link tied to this key — but let the next request take
       it over immediately instead of being told to wait. */
    await store.markIdempotencyRecoverable(idemKey);

    if (heldVariationIds.length) {
      if (liveLink) {
        /* Square made a link before this went wrong. It is payable right now,
           whatever happened to us afterwards, so the stock stays held and
           cleanup is told to go and settle it like any other abandoned
           checkout. Handing the unit back here would oversell it. */
        console.error('checkout_failed_after_link', JSON.stringify({
          attemptId, orderId: liveLink.orderId, paymentLinkId: liveLink.paymentLinkId
        }));
        await store.enqueueSweep({
          attemptId,
          dueAt: Math.floor(Date.now() / 1000) + s.cleanupGraceSeconds,
          orderId: liveLink.orderId,
          paymentLinkId: liveLink.paymentLinkId,
          idemKey,
          variationIds: heldVariationIds,
          createdAt: Date.now(),
          note: 'checkout failed after the link was created'
        }).catch(e => console.error('sweep_enqueue_failed', attemptId, e?.message));
      } else {
        /* Nothing was ever created, so nothing can buy it. */
        await store.releaseHolds(attemptId, heldVariationIds);
      }
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
  if (live && stored) await releaseHoldsIfSettled(store, { ...stored, status });

  return reply(200, event, {
    success: true,
    verified: Boolean(live),
    status,
    fulfillmentType: stored?.fulfillmentType || null,
    /* The return page needs this to know whether clearing the saved cart is
       the right thing to do: a Buy Now purchase must leave it alone. */
    purchaseSource: stored?.purchaseSource || 'cart',
    pickupPolicy: stored?.fulfillmentType === 'pickup' ? s.pickup.policy : null,
    pickupAddress: stored?.fulfillmentType === 'pickup' ? s.pickup.address : null,
    purchasedVariationIds: (stored?.lines || []).map(l => l.variationId),
    order: live ? {
      createdAt: live.createdAt, totals: live.totals, lines: live.lines, fulfillment: live.fulfillment
    } : null
  }, { allowedOrigins: s.allowedOrigins });
}

/* Once an order is paid, Square has taken the stock down itself, so a hold on
   top of that would keep the same unit off the shelf twice. Once it is
   cancelled, the stock was never going anywhere. Either way the hold goes,
   and the flag stops it being done twice. */
async function releaseHoldsIfSettled(store, order) {
  if (!order || order.holdsReleased) return;
  if (!isTerminal(order.status)) return;
  const ids = (order.lines || []).map(l => l.variationId).filter(Boolean);
  if (!ids.length || !order.attemptId) return;
  await store.releaseHolds(order.attemptId, ids);
  await store.updateOrderStatus(order.orderId, { holdsReleased: true })
    .catch(err => console.error('hold_flag_write_failed', err?.message));
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

  /* Claiming the id is not the same as finishing with it. A delivery that
     claimed it and then failed has to be allowed to run again, or the order
     silently never updates — so only a FINISHED event is skipped. */
  let claim = 'new';
  if (eventId) {
    claim = await store.beginWebhookEvent(eventId);
    if (claim === 'done') {
      return { statusCode: 200, body: JSON.stringify({ ok: true, duplicate: true }) };
    }
    if (claim === 'in_progress') {
      /* Another delivery of this same event is being worked on right now.
         Acknowledge; whoever holds it will finish. */
      return { statusCode: 200, body: JSON.stringify({ ok: true, inProgress: true }) };
    }
  }

  try {
    const meaning = interpret(parsed);
    if (!meaning) {
      if (eventId) await store.completeWebhookEvent(eventId);
      return { statusCode: 200, body: JSON.stringify({ ok: true, ignored: true }) };
    }

    const stored = await store.getOrder(meaning.orderId);
    if (!stored) {
      /* An order this website did not create — an in-store sale, for
         instance. Nothing to update and nothing to worry about. */
      if (eventId) await store.completeWebhookEvent(eventId);
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
       here would take the same units off the shelf twice. The soft hold,
       though, has done its job and goes back. */
    await releaseHoldsIfSettled(store, { ...stored, status: meaning.status });

    if (eventId) await store.completeWebhookEvent(eventId);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };

  } catch (err) {
    /* Hand the claim back so Square's retry starts clean, and answer with a
       failure so there IS a retry. Swallowing this would lose the update. */
    console.error('webhook_processing_failed', eventId, err?.message);
    if (eventId) await store.releaseWebhookEvent(eventId);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'WEBHOOK_PROCESSING_FAILED' }) };
  }
}

/* ------------------------------------------------------------- cleanup */

function adminRejection(event, cfg, s) {
  if (!cfg.adminKey) {
    return reply(404, event, { success: false, error: 'NOT_FOUND', message: 'Not available.' },
      { allowedOrigins: s.allowedOrigins });
  }
  if (sha256(header(event, 'x-admin-key') || '') !== sha256(cfg.adminKey)) {
    return reply(403, event, { success: false, error: 'FORBIDDEN', message: 'Wrong admin key.' },
      { allowedOrigins: s.allowedOrigins });
  }
  return null;
}

/* What cleanup has given up on. Each row here is stock sitting off the
   website because a payment link could not be confirmed dead. Somebody has to
   open the order in Square and decide. */
async function handleStuckRoute(event, ctx) {
  const { cfg, s, store } = ctx;
  const refused = adminRejection(event, cfg, s);
  if (refused) return refused;

  const stuck = await store.stuckSweeps();
  return reply(200, event, {
    success: true,
    count: stuck.length,
    stuck: stuck.map(j => ({
      attemptId: j.attemptId, orderId: j.orderId, paymentLinkId: j.paymentLinkId,
      variationIds: j.variationIds || [], attempts: j.attempts || 0,
      lastError: j.lastError || null, stuckSince: j.stuckSince || null,
      createdAt: j.createdAt || null
    }))
  }, { allowedOrigins: s.allowedOrigins });
}

/* The one place stock is freed without Square having said so — and only
   because a person has looked at the order in the Square dashboard and is
   saying so on the record. The confirmation phrase is there to make that a
   decision rather than a slip. */
async function handleManualReleaseRoute(event, ctx) {
  const { cfg, s, store } = ctx;
  const refused = adminRejection(event, cfg, s);
  if (refused) return refused;

  const { body, error } = parseJsonBody(event);
  if (error) return reply(400, event, { success: false, error: 'BAD_JSON', message: error },
    { allowedOrigins: s.allowedOrigins });

  const attemptId = typeof body.attemptId === 'string' ? body.attemptId.trim() : '';
  if (!attemptId) {
    return reply(400, event, { success: false, error: 'BAD_REQUEST', message: 'Send an attemptId.' },
      { allowedOrigins: s.allowedOrigins });
  }
  if (body.confirm !== 'I-CHECKED-SQUARE') {
    return reply(400, event, {
      success: false, error: 'CONFIRMATION_REQUIRED',
      message: 'Open the order in Square first. If it really is dead, send ' +
               'confirm: "I-CHECKED-SQUARE" to free the stock.'
    }, { allowedOrigins: s.allowedOrigins });
  }

  const job = await store.sweepForAttempt(attemptId);
  if (!job) {
    return reply(404, event, { success: false, error: 'NOT_FOUND', message: 'No cleanup job for that attempt.' },
      { allowedOrigins: s.allowedOrigins });
  }

  /* Logged loudly: this is the audit trail for a unit that went back on the
     website on a human's word rather than Square's. */
  console.error('hold_released_by_hand', JSON.stringify({
    attemptId, orderId: job.orderId, paymentLinkId: job.paymentLinkId,
    variationIds: job.variationIds || [], attempts: job.attempts || 0
  }));

  await store.releaseHolds(attemptId, job.variationIds || []);
  if (job.orderId) {
    await store.updateOrderStatus(job.orderId, { holdsReleased: true, cleanupOutcome: 'released_by_hand' })
      .catch(err => console.error('manual_release_flag_failed', err?.message));
  }
  await store.deleteSweep(job);

  return reply(200, event, {
    success: true, released: job.variationIds || [], orderId: job.orderId || null
  }, { allowedOrigins: s.allowedOrigins });
}

/* Normally driven by EventBridge on a schedule. This route is for running it
   by hand while setting the shop up, and for the sandbox checks. */
async function handleSweepRoute(event, ctx) {
  const { cfg, s, square, store } = ctx;
  const refused = adminRejection(event, cfg, s);
  if (refused) return refused;
  const tally = await sweepAbandonedCheckouts({ square, store, settings: s });
  return reply(200, event, { success: true, swept: tally }, { allowedOrigins: s.allowedOrigins });
}

/* The environment is in the error's own message (the host it was refused
   by), so this stays readable without reaching back into the config. */
function cfgEnvironment(err) {
  return String(err?.message || '').includes('squareupsandbox') ? 'sandbox' : 'production';
}

/* ----------------------------------------------------------------- entry */

const ROUTES = [
  ['GET',  '/config',          (e, c) => reply(200, e, { success: true, config: publicConfig(c.cfg, c.s) }, { allowedOrigins: c.s.allowedOrigins, cache: 'public, max-age=120' })],
  ['GET',  '/catalog',         handleCatalog],
  ['POST', '/catalog/refresh', handleRefresh],
  ['POST', '/admin/sweep',     handleSweepRoute],
  ['GET',  '/admin/stuck',     handleStuckRoute],
  ['GET',  '/admin/catalog',   handleCatalogStatusRoute],
  ['POST', '/admin/holds/release', handleManualReleaseRoute],
  ['POST', '/cart/validate',   handleCartValidate],
  ['POST', '/checkout',        handleCheckout],
  ['GET',  '/order',           handleOrderStatus],
  ['POST', '/webhooks/square', handleWebhook]
];

export const handler = async (event) => {
  /* EventBridge calls this function directly with a plain object rather than
     an HTTP request, so the cleanup sweep needs no public route and no
     internet-facing surface of its own. */
  if (event && typeof event.task === 'string') {
    try {
      const s = settings();
      const cfg = await loadSecrets();
      const square = createSquareClient(cfg);
      const store = createStore({ tableName: s.tableName });

      if (event.task === 'sweep-abandoned-checkouts') {
        return await sweepAbandonedCheckouts({ square, store, settings: s });
      }
      /* The slow one. Minutes of Square paging, with the whole Lambda timeout
         to itself and no API Gateway waiting on the other end. */
      if (event.task === 'refresh-catalog') {
        return await refreshCatalog({ square, store, settings: s, environment: cfg.environment });
      }
      return { error: 'UNKNOWN_TASK', task: event.task };
    } catch (err) {
      /* A scheduled run that throws is just a stack trace nobody reads.
         Log it as a named event so a metric filter can see it. */
      console.error('scheduled_task_failed', JSON.stringify({
        task: event.task, message: err?.message
      }));
      return { error: 'TASK_FAILED', task: event.task, message: String(err?.message || err) };
    }
  }

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
    if (err instanceof CursorExpiredError) {
      return reply(409, event, {
        success: false, error: 'CATALOG_CURSOR_EXPIRED',
        message: err.message,
        buildId: err.currentBuildId,
        requestId
      }, { allowedOrigins: s.allowedOrigins });
    }
    /* Checked by flag rather than by class, and before the general Square
       branch: a credential Square will not accept is a configuration fault,
       not something to hand the shopper a 401 about. */
    if (err instanceof CatalogNotReadyError) {
      /* Retryable and honest: the shop is not broken, it is not ready. */
      return reply(503, event, {
        success: false,
        error: err.reason === 'unreadable' ? 'CATALOG_UNAVAILABLE' : 'CATALOG_WARMING',
        message: err.message,
        retryAfterSeconds: s.catalogWarmRetrySeconds,
        requestId
      }, { allowedOrigins: s.allowedOrigins });
    }
    if (err?.authFailure === true) {
      console.error('square_auth_failed_request', requestId, err.message);
      return reply(500, event, {
        success: false, error: 'SQUARE_AUTH_FAILED',
        /* Names the environment and the host so the fault is findable, and
           nothing else. The token never appears here or in the log. */
        message: 'The store could not authenticate with Square. Check the access token in ' +
                 'the secret named by SECRET_ID is valid for the ' + cfgEnvironment(err) + ' environment.',
        requestId
      }, { allowedOrigins: s.allowedOrigins });
    }
    if (err instanceof SquareError) {
      const pub = err.toPublic();
      return reply(err.status >= 500 ? 502 : err.status, event, {
        success: false, error: 'SQUARE_ERROR', message: pub.message, details: pub.details, requestId
      }, { allowedOrigins: s.allowedOrigins });
    }
    if (err instanceof AvailabilityUnverifiedError) {
      /* The one case where refusing is the safe answer: we could not ask
         Square whether this can be sold, so we do not sell it. */
      return reply(503, event, {
        success: false, error: 'AVAILABILITY_UNVERIFIED', message: err.message, requestId
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
export const __internal = { getCurrentCatalog, handleCheckout, handleCatalog, handleWebhook, handleOrderStatus, handleCartValidate };
