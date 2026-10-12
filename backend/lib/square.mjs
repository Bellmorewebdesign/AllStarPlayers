/* ==========================================================================
   All Star Players / Square REST client
   --------------------------------------------------------------------------
   A thin wrapper, not an SDK. It exists to do four things consistently:

     - put the right host, token and Square-Version on every call
     - turn a Square error body into something we can hand a customer without
       ever leaking the token
     - retry the failures that are worth retrying (429 and 5xx) and nothing else
     - walk cursors, so a caller asks for "the catalog" and gets all of it

   Square's own error objects carry no credentials, so they are safe to pass
   on and they are what makes a failure debuggable.
   ========================================================================== */

const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.SQUARE_TIMEOUT_MS || '12000', 10);
const MAX_ATTEMPTS = Number.parseInt(process.env.SQUARE_MAX_ATTEMPTS || '3', 10);
/* A hard ceiling on cursor walking. A runaway loop against Square is both a
   cost problem and a rate-limit problem; stopping loudly is better. */
const MAX_PAGES = Number.parseInt(process.env.SQUARE_MAX_PAGES || '80', 10);

export class SquareError extends Error {
  constructor(message, status, errors, { retryable = false, authFailure = false } = {}) {
    super(message);
    this.name = 'SquareError';
    this.status = status;
    this.errors = errors || [];
    this.retryable = retryable;
    /* Square would not accept our credential for this host. That is never
       the shopper's problem and never worth retrying — it is a configuration
       fault, and it is reported as one. */
    this.authFailure = authFailure;
  }
  /* Shaped for a JSON response: codes and details, never anything secret. */
  toPublic() {
    return {
      message: this.message,
      details: this.errors.map(e => ({
        category: e.category, code: e.code, detail: e.detail, field: e.field
      }))
    };
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function createSquareClient(cfg, { fetchImpl = fetch } = {}) {
  async function once(path, { method = 'GET', body, idempotent }) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), DEFAULT_TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(cfg.host + path, {
        method,
        signal: ctl.signal,
        headers: {
          'Authorization': 'Bearer ' + cfg.token,
          'Square-Version': cfg.squareVersion,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (err) {
      clearTimeout(timer);
      const timedOut = err && err.name === 'AbortError';
      /* A timed-out write may still have been applied by Square. Retrying is
         only safe when the caller said the call carries an idempotency key. */
      throw new SquareError(
        timedOut ? 'Square did not answer in time.' : 'Could not reach Square.',
        504, [], { retryable: idempotent === true || method === 'GET' }
      );
    }
    clearTimeout(timer);

    const text = await res.text();
    let json = {};
    if (text) { try { json = JSON.parse(text); } catch { json = {}; } }

    if (!res.ok) {
      const errors = Array.isArray(json.errors) ? json.errors : [];
      const retryable = res.status === 429 || res.status >= 500;
      const authFailure = res.status === 401 || res.status === 403;

      console.error(authFailure ? 'square_auth_failed' : 'square_error', JSON.stringify({
        method, path, status: res.status,
        /* The host, so a credential pointed at the wrong Square is obvious
           from the log alone. Never the token. */
        host: cfg.host,
        codes: errors.map(e => e.code)
      }));

      throw new SquareError(
        authFailure
          ? 'Square would not accept our credentials for ' + cfg.host + '.'
          : res.status === 429 ? 'Square is rate limiting us.' : 'Square rejected the request.',
        res.status, errors, { retryable, authFailure }
      );
    }
    return json;
  }

  async function call(path, options = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await once(path, options);
      } catch (err) {
        lastErr = err;
        if (!(err instanceof SquareError) || !err.retryable || attempt === MAX_ATTEMPTS) break;
        /* Plain exponential backoff with a little jitter, so a cold start
           storm does not line every retry up on the same millisecond. */
        await sleep(Math.min(2000, 150 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 120));
      }
    }
    throw lastErr;
  }

  /* -------------------------------------------------------- cursor walking */

  /* Square paginates two ways: a `cursor` query parameter on GETs and a
     `cursor` field in the body on POST searches. Both end when the response
     comes back without one. `collect` pulls the pages a caller cares about
     out of each response. */
  async function paginateGet(path, { collect, query = {} }) {
    const out = [];
    let cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
      const qs = new URLSearchParams(query);
      if (cursor) qs.set('cursor', cursor);
      const str = qs.toString();
      const json = await call(path + (str ? '?' + str : ''));
      out.push(...collect(json));
      cursor = json.cursor;
      if (!cursor) return out;
    }
    throw new SquareError('Stopped walking Square pages after ' + MAX_PAGES + ' of them.', 502, []);
  }

  async function paginatePost(path, { collect, body = {} }) {
    const out = [];
    let cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
      const json = await call(path, { method: 'POST', body: { ...body, ...(cursor ? { cursor } : {}) } });
      out.push(...collect(json));
      cursor = json.cursor;
      if (!cursor) return out;
    }
    throw new SquareError('Stopped walking Square pages after ' + MAX_PAGES + ' of them.', 502, []);
  }

  return { call, paginateGet, paginatePost, host: cfg.host, locationId: cfg.locationId };
}

/* Square sends money amounts as integers in the smallest currency unit, but
   JSON numbers and strings both turn up in the wild depending on the field.
   Everything downstream wants a plain integer or null. */
export function cents(money) {
  if (!money || money.amount === undefined || money.amount === null) return null;
  const n = Number(money.amount);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/* Inventory quantities come back as decimal strings ("12", "0", "3.5"). */
export function quantity(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n);
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
