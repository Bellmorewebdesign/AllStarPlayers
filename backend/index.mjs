/* ==========================================================================
   All Star Players / Square API Lambda
   --------------------------------------------------------------------------
   One function behind the HTTP API `n9ecaydkv4`, stage `default`.

     GET  /products   the sandbox catalog, prices in cents, no credentials
     POST /checkout   creates a Square-hosted sandbox checkout page and hands
                      back its URL

   The Square access token never leaves this function. It is read from AWS
   Secrets Manager (the secret named by the SECRET_ID environment variable)
   and is never written to a response or to a log line.

   Routing note: API Gateway hands us paths with the stage in front of them,
   e.g. `/default/products`. routePath() takes the stage off before matching,
   so both `/default/products` and `/products` land on the same handler.

   Runtime: Node.js 24. The AWS SDK v3 ships with the managed runtime and
   `fetch` is global, so this file has no dependencies to bundle: upload it on
   its own and it runs.
   ========================================================================== */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createHash } from 'node:crypto';

/* ---------------------------------------------------------------- config */

/* The one variation this endpoint is allowed to sell, and the only quantity
   it will accept. This is a test integration: anything else is refused
   rather than quietly charged. */
const ALLOWED_VARIATION_ID = process.env.ALLOWED_VARIATION_ID || 'T2APLGR5UFWGFELNUHGVNVI2';
const ALLOWED_QUANTITY = 1;

/* Browsers that may call this API. The GitHub Pages origin has no repository
   path on it — an Origin header is only ever scheme + host + port. */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://bellmorewebdesign.github.io,http://localhost:8000,http://127.0.0.1:8000')
  .split(',').map(s => s.trim()).filter(Boolean);

const SQUARE_VERSION = process.env.SQUARE_VERSION || '2026-09-16';
const SECRET_ID = process.env.SECRET_ID;
const SQUARE_TIMEOUT_MS = 10000;

/* This build is sandbox-only on purpose. Pointing it at production would
   take real money, so it refuses to run against anything else. */
const REQUIRED_ENVIRONMENT = 'sandbox';
const SQUARE_BASE = 'https://connect.squareupsandbox.com';

/* --------------------------------------------------------------- secrets */

/* Cached for the life of the container so a warm invocation does not pay for
   a Secrets Manager round trip. A failure is not cached. */
const secrets = new SecretsManagerClient({});
let secretCache = null;

async function loadConfig() {
  if (secretCache) return secretCache;
  if (!SECRET_ID) throw new ConfigError('SECRET_ID is not set on the function.');

  const res = await secrets.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
  let parsed;
  try {
    parsed = JSON.parse(res.SecretString || '{}');
  } catch {
    throw new ConfigError('The secret is not valid JSON.');
  }

  const environment = parsed.SQUARE_ENVIRONMENT;
  if (environment !== REQUIRED_ENVIRONMENT) {
    throw new ConfigError(
      'SQUARE_ENVIRONMENT is "' + environment + '". This function only runs against ' + REQUIRED_ENVIRONMENT + '.'
    );
  }
  if (!parsed.SQUARE_ACCESS_TOKEN) throw new ConfigError('SQUARE_ACCESS_TOKEN is missing from the secret.');
  if (!parsed.SQUARE_LOCATION_ID) throw new ConfigError('SQUARE_LOCATION_ID is missing from the secret.');

  secretCache = {
    token: parsed.SQUARE_ACCESS_TOKEN,
    locationId: parsed.SQUARE_LOCATION_ID,
    environment
  };
  return secretCache;
}

class ConfigError extends Error {}

/* ----------------------------------------------------------- square call */

async function square(path, { token, method = 'GET', body }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SQUARE_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(SQUARE_BASE + path, {
      method,
      signal: ctl.signal,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Square-Version': SQUARE_VERSION,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (err) {
    clearTimeout(timer);
    throw new SquareError(
      err.name === 'AbortError' ? 'Square did not answer in time.' : 'Could not reach Square.',
      502, []
    );
  }
  clearTimeout(timer);

  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* handled below */ }

  if (!res.ok) {
    /* Square's own error objects carry no credentials, so they are safe to
       pass on and they are what makes a failure debuggable. */
    const errors = Array.isArray(json.errors) ? json.errors.map(e => ({
      category: e.category, code: e.code, detail: e.detail, field: e.field
    })) : [];
    console.error('Square ' + method + ' ' + path + ' failed', { status: res.status, errors });
    throw new SquareError('Square rejected the request.', res.status >= 500 ? 502 : 400, errors);
  }
  return json;
}

class SquareError extends Error {
  constructor(message, status, errors) {
    super(message);
    this.status = status;
    this.errors = errors || [];
  }
}

/* -------------------------------------------------------------- handlers */

async function getProducts(cfg) {
  const data = await square('/v2/catalog/list?types=ITEM', { token: cfg.token });

  const products = (data.objects || [])
    .filter(o => o.type === 'ITEM' && !o.is_deleted)
    .map(o => {
      const item = o.item_data || {};
      return {
        id: o.id,
        name: item.name ?? null,
        description: item.description ?? null,
        imageIds: item.image_ids || [],
        variations: (item.variations || [])
          .filter(v => !v.is_deleted)
          .map(v => {
            const vd = v.item_variation_data || {};
            return {
              id: v.id,
              name: vd.name ?? null,
              sku: vd.sku ?? null,
              /* Square speaks in the smallest currency unit. It is passed on
                 exactly as given; the browser is what formats it. */
              price: vd.price_money
                ? { amount: Number(vd.price_money.amount), currency: vd.price_money.currency }
                : null
            };
          })
      };
    });

  return { success: true, environment: cfg.environment, count: products.length, products };
}

async function postCheckout(cfg, event) {
  let body;
  try {
    body = JSON.parse(rawBody(event) || '{}');
  } catch {
    return reply(400, event, { success: false, error: 'BAD_JSON', message: 'The request body is not valid JSON.' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return reply(400, event, { success: false, error: 'BAD_JSON', message: 'The request body must be a JSON object.' });
  }

  const variationId = typeof body.variationId === 'string' ? body.variationId.trim() : '';
  const quantity = Number(body.quantity);
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
  // Older cached pages did not send a choice; keep their shipping checkout working.
  const fulfillment = body.fulfillment === undefined ? 'shipping' : body.fulfillment;

  if (fulfillment !== 'shipping' && fulfillment !== 'pickup') {
    return reply(400, event, {
      success: false, error: 'FULFILLMENT_NOT_ALLOWED',
      message: 'Choose shipping or store pickup.'
    });
  }

  if (variationId !== ALLOWED_VARIATION_ID) {
    return reply(400, event, {
      success: false, error: 'VARIATION_NOT_ALLOWED',
      message: 'This endpoint only sells the one sandbox test variation.'
    });
  }
  if (quantity !== ALLOWED_QUANTITY) {
    return reply(400, event, {
      success: false, error: 'QUANTITY_NOT_ALLOWED',
      message: 'This endpoint only sells a quantity of ' + ALLOWED_QUANTITY + '.'
    });
  }
  if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    return reply(400, event, {
      success: false, error: 'BAD_IDEMPOTENCY_KEY',
      message: 'Send an idempotencyKey between 8 and 128 characters.'
    });
  }

  /* Nothing about money is read from `body`. The line item names a catalog
     variation and Square prices it from its own catalog, so a browser cannot
     talk the total down. */
  const order = {
    location_id: cfg.locationId,
    line_items: [{ catalog_object_id: ALLOWED_VARIATION_ID, quantity: String(ALLOWED_QUANTITY) }]
  };
  if (fulfillment === 'pickup') {
    order.fulfillments = [{
      type: 'PICKUP',
      state: 'PROPOSED',
      pickup_details: {
        // Queue the order for staff to prepare. Do not promise a preparation
        // duration or reserve a pickup appointment. Staff must contact the buyer
        // when ready; this API integration does not send readiness notifications.
        schedule_type: 'ASAP',
        note: 'Notify customer when ready; collect during store hours. Staff: contact the buyer using the order contact details before pickup. Sandbox preview only; do not send real messages for this test order.'
      }
    }];
  }

  // Separate choices even if a caller reuses a key. Never reuse a shipping link
  // for pickup, or an older shipping-only build's link for this request shape.
  const squareKey = 'asp-ready-pickup-v1-' + createHash('sha256')
    .update(JSON.stringify([idempotencyKey, fulfillment, ALLOWED_VARIATION_ID, ALLOWED_QUANTITY]))
    .digest('hex');

  const created = await square('/v2/online-checkout/payment-links', {
    token: cfg.token,
    method: 'POST',
    body: {
      idempotency_key: squareKey,
      order,
      checkout_options: {
        allow_tipping: false,            /* retail test, no tip screen */
        // Collect the address on Square's hosted checkout. Shipping rates,
        // carrier labels and delivery estimates are not configured by this flag.
        ask_for_shipping_address: fulfillment === 'shipping'
      }
    }
  });

  const link = created.payment_link || {};
  if (!link.url) {
    console.error('Square returned no payment link url', { keys: Object.keys(created) });
    throw new SquareError('Square did not return a checkout URL.', 502, []);
  }

  /* A link is a link. Whether anybody paid is Square's to say, not ours. */
  return reply(200, event, {
    success: true,
    environment: cfg.environment,
    fulfillment,
    pickupPolicy: fulfillment === 'pickup' ? 'notify_when_ready' : null,
    checkoutUrl: link.url,
    orderId: link.order_id ?? null,
    paymentLinkId: link.id ?? null
  });
}

/* ----------------------------------------------------------------- http */

function rawBody(event) {
  if (!event.body) return '';
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

function methodOf(event) {
  return (event.requestContext?.http?.method || event.httpMethod || 'GET').toUpperCase();
}

/* `/default/products` -> `/products`. API Gateway puts the stage in front of
   the path; matching on the bare path keeps the routes readable and keeps
   working if the API is ever moved to the $default stage. */
function routePath(event) {
  let p = event.rawPath || event.path || '/';
  const stage = event.requestContext?.stage;
  if (stage && stage !== '$default') {
    if (p === '/' + stage) p = '/';
    else if (p.startsWith('/' + stage + '/')) p = p.slice(stage.length + 1);
  }
  p = p.replace(/\/+$/, '');
  return p || '/';
}

function originOf(event) {
  const h = event.headers || {};
  return h.origin || h.Origin || '';
}

/* API Gateway's own CORS configuration wins when it is set; these headers are
   what keeps the endpoint usable if it ever is not. */
function corsHeaders(event) {
  const origin = originOf(event);
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  };
}

function reply(status, event, payload) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(event)
    },
    body: JSON.stringify(payload)
  };
}

/* ---------------------------------------------------------------- entry */

export const handler = async (event) => {
  const method = methodOf(event);
  const path = routePath(event);

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(event), body: '' };
  }

  try {
    if (path === '/products' && method === 'GET') {
      const cfg = await loadConfig();
      return reply(200, event, await getProducts(cfg));
    }
    if (path === '/checkout' && method === 'POST') {
      const cfg = await loadConfig();
      /* awaited on purpose: a bare `return promise` here would sail past
         the catch below and surface as a raw 502 from API Gateway. */
      return await postCheckout(cfg, event);
    }
    return reply(404, event, { success: false, error: 'NOT_FOUND', message: 'No route for ' + method + ' ' + path });
  } catch (err) {
    if (err instanceof SquareError) {
      return reply(err.status, event, {
        success: false, error: 'SQUARE_ERROR', message: err.message, details: err.errors
      });
    }
    if (err instanceof ConfigError) {
      /* The message names which key is wrong, never its value. */
      console.error('Configuration problem', err.message);
      return reply(500, event, { success: false, error: 'CONFIG_ERROR', message: err.message });
    }
    console.error('Unhandled error', err);
    return reply(500, event, { success: false, error: 'SERVER_ERROR', message: 'Something went wrong.' });
  }
};
