/* ==========================================================================
   All Star Players / configuration
   --------------------------------------------------------------------------
   Everything secret comes from AWS Secrets Manager. Everything operational
   (shipping rates, pickup policy, cache lifetimes) comes from environment
   variables on the function, so changing a shipping price is a console edit
   rather than a deploy.

   Two rules run through this file:

     1. Sandbox and production are never the same deployment. The secret says
        which one it is and the base URL is derived from that, so a sandbox
        token can never reach the production host or the other way round.
     2. A fulfillment method that has not been configured is UNAVAILABLE. It
        is never quietly treated as free, or as zero tax. An incomplete
        configuration makes an order impossible, not cheap.
   ========================================================================== */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const SECRET_ID = process.env.SECRET_ID;
const SQUARE_VERSION = process.env.SQUARE_VERSION || '2026-09-16';

const HOSTS = {
  sandbox: 'https://connect.squareupsandbox.com',
  production: 'https://connect.squareup.com'
};

export class ConfigError extends Error {
  constructor(message) { super(message); this.name = 'ConfigError'; }
}

/* ---------------------------------------------------------------- secrets */

const secrets = new SecretsManagerClient({});
let cached = null;

/* Deliberately not caching failures: a secret fixed in the console should
   take effect on the next request, not on the next cold start. */
export async function loadSecrets({ client = secrets } = {}) {
  if (cached) return cached;
  if (!SECRET_ID) throw new ConfigError('SECRET_ID is not set on the function.');

  const res = await client.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
  let parsed;
  try {
    parsed = JSON.parse(res.SecretString || '{}');
  } catch {
    throw new ConfigError('The secret is not valid JSON.');
  }

  const environment = parsed.SQUARE_ENVIRONMENT;
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new ConfigError(
      'SQUARE_ENVIRONMENT must be "sandbox" or "production", not ' + JSON.stringify(environment) + '.'
    );
  }
  if (!parsed.SQUARE_ACCESS_TOKEN) throw new ConfigError('SQUARE_ACCESS_TOKEN is missing from the secret.');
  if (!parsed.SQUARE_LOCATION_ID) throw new ConfigError('SQUARE_LOCATION_ID is missing from the secret.');

  /* A production token pasted into the sandbox secret, or vice versa, is the
     single most expensive mistake available here. Square prefixes sandbox
     tokens, so the mismatch is worth catching before any money moves. */
  const looksSandbox = String(parsed.SQUARE_ACCESS_TOKEN).startsWith('EAAAl') ||
                       String(parsed.SQUARE_ACCESS_TOKEN).includes('-sandbox-');
  if (environment === 'production' && looksSandbox) {
    throw new ConfigError('The secret says production but the access token looks like a sandbox token.');
  }

  cached = Object.freeze({
    environment,
    token: parsed.SQUARE_ACCESS_TOKEN,
    locationId: parsed.SQUARE_LOCATION_ID,
    /* Only needed by the webhook route. Its absence is reported there, not
       here, so the storefront keeps working while webhooks are being set up. */
    webhookSignatureKey: parsed.SQUARE_WEBHOOK_SIGNATURE_KEY || null,
    /* Guards POST /catalog/refresh. Without it that route is switched off. */
    adminKey: parsed.ADMIN_REFRESH_KEY || null,
    host: HOSTS[environment],
    squareVersion: SQUARE_VERSION
  });
  return cached;
}

export function resetSecretCache() { cached = null; }

/* --------------------------------------------------------------- settings */

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function list(name) {
  return (process.env[name] || '').split(',').map(s => s.trim()).filter(Boolean);
}

/* Shipping zones arrive as JSON on SHIPPING_RATES, e.g.
     [{"id":"us48","label":"United States","amount":1200,"currency":"USD",
       "states":["NY","NJ"],"freeOver":15000}]
   `states` empty means "any state in an allowed country". `freeOver` is a
   subtotal in cents above which the charge is zero; leave it out and there is
   no free threshold. Nothing here has a default rate, because guessing a
   shipping price is worse than refusing to ship. */
function shippingZones() {
  const raw = process.env.SHIPPING_RATES;
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    console.error('SHIPPING_RATES is not valid JSON; shipping stays switched off.');
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(z => z && typeof z.id === 'string' && Number.isInteger(z.amount) && z.amount >= 0)
    .map(z => ({
      id: z.id,
      label: typeof z.label === 'string' ? z.label : z.id,
      amount: z.amount,
      currency: typeof z.currency === 'string' ? z.currency : 'USD',
      countries: Array.isArray(z.countries) ? z.countries.map(String) : ['US'],
      states: Array.isArray(z.states) ? z.states.map(s => String(s).toUpperCase()) : [],
      freeOver: Number.isInteger(z.freeOver) ? z.freeOver : null
    }));
}

export function settings() {
  const zones = shippingZones();
  const pickupAddress = process.env.PICKUP_ADDRESS || '';
  const shippingServiceCharge = process.env.SHIPPING_SERVICE_CHARGE_NAME || 'Shipping';

  return {
    tableName: process.env.TABLE_NAME || '',
    allowedOrigins: list('ALLOWED_ORIGINS').length
      ? list('ALLOWED_ORIGINS')
      : ['https://bellmorewebdesign.github.io'],

    /* How long a cached catalog stays usable before it is refetched. Prices
       and stock are revalidated against Square at checkout regardless, so
       this only controls how stale the browsing experience can be. */
    catalogTtlSeconds: int('CATALOG_TTL_SECONDS', 600),
    catalogPageSize: int('CATALOG_PAGE_SIZE', 120),

    /* Square's own page sizes. Conservative on purpose; raise them only after
       checking the current documented maximums. */
    squareCatalogPageLimit: int('SQUARE_CATALOG_PAGE_LIMIT', 100),
    inventoryBatchSize: int('INVENTORY_BATCH_SIZE', 250),

    /* A variation Square is not counting is NOT treated as endless stock. By
       default it cannot be bought online at all; the storefront labels it
       "Availability unknown". Flip this on only if the shop is happy to sell
       items Square is not counting. */
    sellUntrackedVariations: bool('SELL_UNTRACKED_VARIATIONS', false),

    /* A soft hold is not a reservation. See lib/store.mjs. */
    holdSeconds: int('STOCK_HOLD_SECONDS', 900),
    holdsEnabled: bool('STOCK_HOLDS_ENABLED', true),

    /* How long after a hold's clock runs out before cleanup goes near it.
       The gap is deliberate: a customer on Square's page when the hold lapses
       should be allowed to finish rather than have the link pulled from under
       them. The stock stays held throughout. */
    cleanupGraceSeconds: int('CLEANUP_GRACE_SECONDS', 180),

    maxCartLines: int('MAX_CART_LINES', 40),
    maxLineQuantity: int('MAX_LINE_QUANTITY', 20),

    /* Fulfillment. Each method is available only once it is fully set up. */
    pickup: {
      enabled: bool('PICKUP_ENABLED', false) && pickupAddress.length > 0,
      address: pickupAddress,
      /* The agreed policy: staff tell the customer when it is ready, then
         they collect. No promised time, no appointment. */
      policy: process.env.PICKUP_POLICY ||
        'We will contact you when your order is ready to collect. Please wait for that message before coming to the store.',
      configured: pickupAddress.length > 0
    },
    shipping: {
      enabled: bool('SHIPPING_ENABLED', false) && zones.length > 0,
      zones,
      serviceChargeName: shippingServiceCharge,
      configured: zones.length > 0
    },

    /* Taxes. Square's catalog tax objects are applied when this is on. There
       is no hardcoded rate anywhere and no destination-based calculation. */
    applyCatalogTaxes: bool('APPLY_CATALOG_TAXES', true),

    orderRetentionDays: int('ORDER_RETENTION_DAYS', 90),
    currency: process.env.STORE_CURRENCY || 'USD',
    returnUrl: process.env.RETURN_URL || 'https://bellmorewebdesign.github.io/AllStarPlayers/order.html',
    storeName: process.env.STORE_NAME || 'All Star Players',
    storePhone: process.env.STORE_PHONE || '+17185051038'
  };
}

/* What the browser is allowed to know about the configuration. No secrets, no
   internal ids, no table names. */
export function publicConfig(cfg, s) {
  return {
    environment: cfg.environment,
    currency: s.currency,
    fulfillment: {
      pickup: {
        available: s.pickup.enabled,
        address: s.pickup.enabled ? s.pickup.address : null,
        policy: s.pickup.enabled ? s.pickup.policy : null
      },
      shipping: {
        available: s.shipping.enabled,
        zones: s.shipping.enabled
          ? s.shipping.zones.map(z => ({
              id: z.id, label: z.label, amount: z.amount, currency: z.currency,
              countries: z.countries, states: z.states, freeOver: z.freeOver
            }))
          : []
      }
    },
    limits: { maxCartLines: s.maxCartLines, maxLineQuantity: s.maxLineQuantity },
    storeName: s.storeName,
    storePhone: s.storePhone,
    /* So the storefront can say "tax is worked out by Square at checkout"
       rather than inventing a number. */
    taxesAppliedAtCheckout: s.applyCatalogTaxes
  };
}
