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

  /* Secrets get pasted into consoles, and a console loves to bring a newline
     with it. A token with a trailing \n produces an Authorization header
     Square rejects, which looks exactly like a wrong token and wastes an
     afternoon. Trim everything on the way in. */
  const trimmed = (key) => {
    const value = parsed[key];
    return typeof value === 'string' ? value.trim() : value;
  };

  const environment = trimmed('SQUARE_ENVIRONMENT');
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new ConfigError(
      'SQUARE_ENVIRONMENT must be "sandbox" or "production", not ' + JSON.stringify(environment) + '.'
    );
  }

  const token = trimmed('SQUARE_ACCESS_TOKEN');
  const locationId = trimmed('SQUARE_LOCATION_ID');
  if (!token) throw new ConfigError('SQUARE_ACCESS_TOKEN is missing from the secret.');
  if (!locationId) throw new ConfigError('SQUARE_LOCATION_ID is missing from the secret.');

  /* There is deliberately no check on what the token LOOKS like.

     An earlier version guessed at the environment from the token's prefix and
     refused anything starting "EAAAl" in a production secret. Production
     tokens start "EAAA" too, so that rejected perfectly good production
     credentials and blocked a deployment. Square does not document a stable
     prefix that distinguishes the two, and inventing one from memory was the
     mistake.

     What actually separates the environments is the host, and that is derived
     from SQUARE_ENVIRONMENT below rather than sniffed from the credential. A
     sandbox token therefore cannot reach the production host: it will be sent
     there and Square will refuse it. Square's own authentication response is
     the authority on whether a credential is valid for a host, and
     lib/square.mjs reports a 401 or 403 as exactly that. */

  cached = Object.freeze({
    environment,
    token,
    locationId,
    /* Only needed by the webhook route. Its absence is reported there, not
       here, so the storefront keeps working while webhooks are being set up. */
    webhookSignatureKey: trimmed('SQUARE_WEBHOOK_SIGNATURE_KEY') || null,
    /* Guards the admin routes. Without it they are switched off. */
    adminKey: trimmed('ADMIN_REFRESH_KEY') || null,
    /* The one thing that decides which Square the service talks to. */
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
    /* How old a snapshot may be before the storefront is told it is stale.
       It is still served either way: a shop window a few minutes behind is
       fine, and nothing it shows is what gets charged. */
    catalogTtlSeconds: int('CATALOG_TTL_SECONDS', 900),
    catalogPageSize: int('CATALOG_PAGE_SIZE', 120),

    /* How long a build that has been replaced is kept before deletion.
       A browsing request reads the pointer and the chunks as two separate
       calls, so deleting the old build the instant the new one lands strands
       anybody in between. Must comfortably exceed the slowest such read. */
    buildRetentionSeconds: int('BUILD_RETENTION_SECONDS', 900),

    /* How long the refresh lease lasts. It MUST be longer than the Lambda's
       own timeout, or a slow refresh would lose the lease while still
       running and a second one could start on top of it. */
    refreshLeaseSeconds: int('REFRESH_LEASE_SECONDS', 600),

    /* What a browsing request is told to wait before asking again while the
       very first snapshot is still being built. */
    catalogWarmRetrySeconds: int('CATALOG_WARM_RETRY_SECONDS', 15),

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
