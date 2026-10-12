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
  function fetchCatalog(onPage) {
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
            environment: data.environment
          };
        }
        all = all.concat(data.products || []);
        if (onPage) onPage({ products: all, meta: meta, done: !data.cursor });
        if (data.cursor) return page(data.cursor);
        return { products: all, meta: meta };
      });
    }
    return page(null);
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
