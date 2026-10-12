/* ==========================================================================
   All Star Players / HTTP plumbing
   --------------------------------------------------------------------------
   Routing, CORS and JSON replies.

   The stage prefix: API Gateway hands this function paths like
   `/default/catalog`, because the stage is named `default` rather than
   `$default`. Routes are matched on the bare path, so the same code works on
   either stage and the route keys in API Gateway stay readable.
   ========================================================================== */

export function methodOf(event) {
  return (event.requestContext?.http?.method || event.httpMethod || 'GET').toUpperCase();
}

export function routePath(event) {
  let p = event.rawPath || event.path || '/';
  const stage = event.requestContext?.stage;
  if (stage && stage !== '$default') {
    if (p === '/' + stage) p = '/';
    else if (p.startsWith('/' + stage + '/')) p = p.slice(stage.length + 1);
  }
  p = p.replace(/\/+$/, '');
  return p || '/';
}

export function rawBody(event) {
  if (!event.body) return '';
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

export function header(event, name) {
  const h = event.headers || {};
  const lower = name.toLowerCase();
  for (const key of Object.keys(h)) if (key.toLowerCase() === lower) return h[key];
  return undefined;
}

export function query(event, name) {
  const q = event.queryStringParameters || {};
  return q[name];
}

/* API Gateway's own CORS configuration takes precedence when it is set.
   These headers are the safety net for the case where it is not, and they
   never echo an origin that is not on the list. */
export function corsHeaders(event, allowedOrigins) {
  const origin = header(event, 'origin');
  if (!origin || !allowedOrigins.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  };
}

export function reply(status, event, payload, { allowedOrigins = [], cache = 'no-store' } = {}) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cache,
      ...corsHeaders(event, allowedOrigins)
    },
    body: JSON.stringify(payload)
  };
}

export function parseJsonBody(event) {
  const text = rawBody(event);
  if (!text) return { body: {} };
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { error: 'The request body must be a JSON object.' };
    }
    return { body };
  } catch {
    return { error: 'The request body is not valid JSON.' };
  }
}
