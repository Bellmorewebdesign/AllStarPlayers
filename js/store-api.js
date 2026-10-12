/* ==========================================================================
   All Star Players / store API client
   --------------------------------------------------------------------------
   Every page talks to AWS through this one file. There is no Square token
   here and there never can be: the browser only ever sends variation ids,
   quantities and the customer's own details.

   To point the site at a different deployment, change API_BASE below, or set
   window.ASP_API_BASE before this script loads.
   ========================================================================== */
(function () {
  'use strict';

  var API_BASE = window.ASP_API_BASE ||
    'https://n9ecaydkv4.execute-api.us-east-1.amazonaws.com/default';

  var ASP = window.ASP || (window.ASP = {});

  function request(path, options) {
    var opts = options || {};
    var init = {
      method: opts.method || 'GET',
      headers: { 'Accept': 'application/json' }
    };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(API_BASE + path, init).then(function (res) {
      return res.text().then(function (text) {
        var body = null;
        if (text) { try { body = JSON.parse(text); } catch (e) { /* not JSON */ } }
        if (res.ok) return body;
        /* A failure carries the server's own code and message so the page can
           say something specific rather than "something went wrong". */
        var err = new Error((body && body.message) || ('The server answered ' + res.status + '.'));
        err.status = res.status;
        err.code = (body && body.error) || 'HTTP_' + res.status;
        err.body = body;
        /* The server tells us how long to leave it when something is still
           warming up, so the page does not have to guess. */
        err.retryAfterSeconds = body && Number(body.retryAfterSeconds) > 0
          ? Number(body.retryAfterSeconds) : null;
        throw err;
      });
    }, function (networkError) {
      if (window.console) console.error('[store-api] request failed', path, networkError);
      var err = new Error('We could not reach the store. Check your connection and try again.');
      err.code = 'NETWORK';
      throw err;
    });
  }

  /* ------------------------------------------------------------- catalog */

  /* The catalog arrives a page at a time. The first page comes back quickly so
     the grid can draw, and the rest follow in the background, so the whole
     catalog ends up searchable rather than just the first screen of it. */
  /* Walks every page of the catalog.

     Pages are pinned server-side to one build of the catalog, and the cursor
     carries that build. If a refresh lands while we are part-way through, the
     build we started on eventually goes away and the server answers 409
     CATALOG_CURSOR_EXPIRED rather than handing us a page from the new one.
     The only correct response is to throw away what we have and walk again
     from the top: half of one catalog plus half of another is a list with
     products missing and products repeated. */
  function fetchCatalog(onPage) {
    var RESTART_LIMIT = 3;

    function walk(restarts) {
      var all = [];
      var meta = null;

      function page(cursor) {
        var qs = cursor ? '?cursor=' + encodeURIComponent(cursor) : '';
        return request('/catalog' + qs).then(function (data) {
          if (!data || data.success !== true) throw new Error('The catalog service reported a problem.');
          if (!meta) {
            meta = {
              total: data.total, categories: data.categories || [],
              fetchedAt: data.fetchedAt, stale: data.stale === true,
              ageSeconds: typeof data.ageSeconds === 'number' ? data.ageSeconds : null,
              buildId: data.buildId || null,
              environment: data.environment
            };
          }
          all = all.concat(data.products || []);
          if (onPage) onPage({ products: all, meta: meta, done: !data.cursor });
          if (data.cursor) return page(data.cursor);
          return { products: all, meta: meta };
        }, function (err) {
          if (err && err.code === 'CATALOG_CURSOR_EXPIRED' && restarts < RESTART_LIMIT) {
            /* Start over, and hand the caller the clean slate so a partly
               drawn grid is not left with the old build's products in it. */
            if (onPage) onPage({ products: [], meta: null, done: false, restarted: true });
            return walk(restarts + 1);
          }
          throw err;
        });
      }
      return page(null);
    }
    return walk(0);
  }

  ASP.api = {
    base: API_BASE,
    config: function () { return request('/config'); },
    catalog: fetchCatalog,
    validateCart: function (lines) {
      return request('/cart/validate', { method: 'POST', body: { lines: lines } });
    },
    checkout: function (payload) {
      return request('/checkout', { method: 'POST', body: payload });
    },
    orderStatus: function (token) {
      return request('/order?t=' + encodeURIComponent(token));
    }
  };

  /* Prices travel as integers in the smallest currency unit. 4500 is $45.00.
     This is the only place the site turns one into the other. */
  ASP.money = function (amount, currency) {
    var n = Number(amount);
    if (!isFinite(n)) return '';
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency', currency: currency || 'USD'
      }).format(n / 100);
    } catch (e) {
      return '$' + (n / 100).toFixed(2);
    }
  };
})();
