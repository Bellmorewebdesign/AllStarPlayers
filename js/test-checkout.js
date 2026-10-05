/* ==========================================================================
   All Star Players / Square sandbox test checkout
   --------------------------------------------------------------------------
   Draws the one sandbox test product and runs its Buy button. Everything it
   shows comes from our own AWS endpoints — no Square token is ever in this
   file, and nothing here invents a product. If the API is down the block says
   so; it never falls back to made-up data.

     GET  <api>/products   the catalog, with prices in cents
     POST <api>/checkout   asks Square for a hosted checkout page

   Plain script, no dependencies, same as the rest of the site.
   ========================================================================== */
(function () {
  'use strict';

  var root = document.querySelector('[data-square-test]');
  if (!root) return;

  var CFG = {
    api:         root.getAttribute('data-api') || '',
    itemId:      root.getAttribute('data-item') || '',
    variationId: root.getAttribute('data-variation') || '',
    image:       root.getAttribute('data-image') || '',
    imageAlt:    root.getAttribute('data-image-alt') || ''
  };

  /* One key per checkout attempt. Square treats two requests carrying the
     same key as the same attempt, so a retry after a failure reuses it and
     cannot create a second order. It is thrown away once Square has given us
     a link, so the next visit starts a genuinely new attempt. */
  var KEY_NAME = 'asp.sq.idem.fulfillment-v1.' + CFG.variationId + '.';

  /* ---------------------------------------------------------------- utils */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* Square counts in the smallest unit of the currency. 10000 is $100.00. */
  function money(amount, currency) {
    var n = Number(amount);
    if (!isFinite(n)) return null;
    var code = currency || 'USD';
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(n / 100);
    } catch (e) {
      return '$' + (n / 100).toFixed(2);
    }
  }

  var memoKeys = {};
  function idempotencyKey(fulfillment) {
    if (memoKeys[fulfillment]) return memoKeys[fulfillment];
    var k = null;
    /* sessionStorage throws outright in some private-browsing modes, so the
       key is held in memory as well and that copy is what a retry reads. */
    try { k = window.sessionStorage.getItem(KEY_NAME + fulfillment); } catch (e) { /* no storage */ }
    if (!k) {
      var rand = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID()
        : String(Date.now()) + '-' + Math.random().toString(36).slice(2, 12);
      k = 'asp-' + rand;
      try { window.sessionStorage.setItem(KEY_NAME + fulfillment, k); } catch (e) { /* no storage */ }
    }
    memoKeys[fulfillment] = k;
    return k;
  }
  function forgetKey(fulfillment) {
    delete memoKeys[fulfillment];
    try { window.sessionStorage.removeItem(KEY_NAME + fulfillment); } catch (e) { /* nothing to do */ }
  }

  function json(url, options) {
    return fetch(url, options).then(function (res) {
      return res.text().then(function (text) {
        var body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
        return { ok: res.ok, status: res.status, body: body };
      });
    });
  }

  /* ---------------------------------------------------------------- shell */
  /* The photograph column is the same in every state, so the block never
     jumps about while the API is answering. */
  function shell(stateClass) {
    root.className = 'sqt ' + stateClass;
    root.innerHTML = '';

    var media = el('div', 'sqt__media');
    if (CFG.image) {
      var img = new Image();
      img.className = 'sqt__img';
      img.src = CFG.image;
      img.alt = CFG.imageAlt;
      img.decoding = 'async';
      media.appendChild(img);
    }
    media.appendChild(el('p', 'sqt__imgnote', 'Illustrative test image, not a photograph of the item'));

    var body = el('div', 'sqt__body');
    root.appendChild(media);
    root.appendChild(body);
    return body;
  }

  function flag(body) {
    body.appendChild(el('p', 'sqt__flag', 'Sandbox — checkout preview'));
  }

  /* --------------------------------------------------------------- states */
  function showLoading() {
    var body = shell('is-loading');
    flag(body);
    var p = el('p', 'sqt__status', 'Loading the test product from Square…');
    p.setAttribute('aria-live', 'polite');
    body.appendChild(p);
    body.appendChild(el('span', 'sqt__bar'));
  }

  function showProblem(headline, detail, onRetry) {
    var body = shell('is-error');
    flag(body);
    body.appendChild(el('h3', 'sqt__name', headline));
    var p = el('p', 'sqt__status', detail);
    p.setAttribute('role', 'status');
    body.appendChild(p);
    if (onRetry) {
      var again = el('button', 'btn btn--ghost btn--sm', 'Try Again');
      again.type = 'button';
      again.addEventListener('click', function () { load(); });
      body.appendChild(again);
    }
  }

  function showEmpty(detail) {
    var body = shell('is-empty');
    flag(body);
    body.appendChild(el('h3', 'sqt__name', 'No test product to show'));
    var p = el('p', 'sqt__status', detail);
    p.setAttribute('role', 'status');
    body.appendChild(p);
    var again = el('button', 'btn btn--ghost btn--sm', 'Check Again');
    again.type = 'button';
    again.addEventListener('click', function () { load(); });
    body.appendChild(again);
  }

  function showProduct(product, variation) {
    var body = shell('is-ready');
    flag(body);

    body.appendChild(el('h3', 'sqt__name', product.name || 'Untitled item'));

    var priced = money(variation.price.amount, variation.price.currency);
    var price = el('p', 'sqt__price');
    price.appendChild(el('span', 'sqt__amount', priced));
    price.appendChild(el('span', 'sqt__cur', variation.price.currency || 'USD'));
    body.appendChild(price);

    if (product.description) body.appendChild(el('p', 'sqt__desc', product.description));

    var meta = el('ul', 'sqt__meta');
    meta.appendChild(el('li', null, 'Variation: ' + (variation.name || 'Default')));
    meta.appendChild(el('li', null, 'Quantity: 1'));
    body.appendChild(meta);

    var fulfillment = 'shipping';
    var choices = el('fieldset', 'sqt__fulfillment');
    choices.appendChild(el('legend', null, 'How would you like to get it?'));
    var choiceRow = el('div', 'sqt__choices');
    ['shipping', 'pickup'].forEach(function (value) {
      var label = el('label', 'sqt__choice');
      var input = el('input');
      input.type = 'radio';
      input.name = 'sqt-fulfillment';
      input.value = value;
      input.checked = value === fulfillment;
      input.setAttribute('aria-describedby', 'sqt-fulfillment-detail');
      label.appendChild(input);
      label.appendChild(el('span', null, value === 'shipping' ? 'Ship to me' : 'Store pickup'));
      choiceRow.appendChild(label);
      input.addEventListener('change', function () {
        if (!input.checked) return;
        fulfillment = value;
        btn.textContent = value === 'shipping' ? 'Preview Shipping Checkout' : 'Preview Pickup Checkout';
        detail.textContent = fulfillmentDetail(value);
        err.hidden = true;
        err.textContent = '';
        status.textContent = '';
      });
    });
    choices.appendChild(choiceRow);
    body.appendChild(choices);

    var detail = el('p', 'sqt__fine', fulfillmentDetail(fulfillment));
    detail.id = 'sqt-fulfillment-detail';
    detail.setAttribute('aria-live', 'polite');
    body.appendChild(detail);

    var btn = el('button', 'btn btn--gold sqt__buy', 'Preview Shipping Checkout');
    btn.type = 'button';
    body.appendChild(btn);

    var status = el('p', 'sqt__status sqt__status--live');
    status.setAttribute('aria-live', 'polite');
    body.appendChild(status);

    var err = el('p', 'sqt__err');
    err.setAttribute('role', 'alert');
    err.hidden = true;
    body.appendChild(err);

    body.appendChild(el('p', 'sqt__fine',
      'Preview checkout hosted by Square. This sandbox preview cannot accept ' +
      'payments. Nothing ships and no pickup is booked.'));

    btn.addEventListener('click', function () {
      buy(btn, status, err, variation, fulfillment, choices);
    });
  }

  function fulfillmentDetail(fulfillment) {
    return fulfillment === 'pickup'
      ? 'Collect at the store. Any location or pickup time shown in this sandbox checkout is sample data.'
      : 'Delivery by mail or carrier. Shipping charges and delivery estimates are not yet set.';
  }

  /* -------------------------------------------------------------- loading */
  function load() {
    showLoading();

    json(CFG.api + '/products', { headers: { 'Accept': 'application/json' } })
      .then(function (res) {
        if (!res.ok || !res.body) {
          var why = res.body && res.body.message ? res.body.message : 'The server answered ' + res.status + '.';
          showProblem('Could not load the test product', why, true);
          return;
        }
        if (res.body.success !== true) {
          showProblem('Could not load the test product',
            res.body.message || 'The product service reported a problem.', true);
          return;
        }

        var list = res.body.products || [];
        var product = null;
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === CFG.itemId) { product = list[i]; break; }
        }
        if (!product) {
          showEmpty('The sandbox catalog came back without the test item in it.');
          return;
        }

        var variation = null;
        var vars = product.variations || [];
        for (var j = 0; j < vars.length; j++) {
          if (vars[j].id === CFG.variationId) { variation = vars[j]; break; }
        }
        if (!variation) {
          showEmpty('The test item is in the catalog, but the variation this page sells is not.');
          return;
        }
        if (!variation.price || variation.price.amount == null) {
          showEmpty('The test variation has no price set in Square, so there is nothing to charge.');
          return;
        }

        showProduct(product, variation);
      })
      .catch(function (e) {
        /* A blocked CORS preflight and a dropped connection both land here. */
        if (window.console) console.error('[square-test] product request failed', e);
        showProblem('Could not reach the product service',
          'The request to our API did not complete. Check the connection and try again.', true);
      });
  }

  /* ------------------------------------------------------------- checkout */
  function buy(btn, status, err, variation, fulfillment, choices) {
    btn.disabled = true;
    choices.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = 'Opening Square…';
    err.hidden = true;
    err.textContent = '';
    status.textContent = 'Asking Square for a checkout page…';

    var key = idempotencyKey(fulfillment);

    json(CFG.api + '/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        variationId: variation.id,
        quantity: 1,
        fulfillment: fulfillment,
        idempotencyKey: key
      })
    }).then(function (res) {
      var b = res.body;
      if (res.ok && b && b.success === true && b.checkoutUrl) {
        // An older Lambda ignores the choice and always creates shipping links.
        // Stop here until the matching backend has been deployed.
        if (b.fulfillment !== fulfillment || b.environment !== 'sandbox') {
          fail(btn, status, err, 'The checkout service needs an update before it can confirm your pickup or shipping choice.', choices);
          return;
        }
        /* This attempt is spent. Square owns the outcome from here: we are
           leaving the site, and nothing on this page claims a payment went
           through. */
        forgetKey(fulfillment);
        status.textContent = 'Taking you to Square’s sandbox checkout…';
        window.location.assign(b.checkoutUrl);
        return;
      }
      /* The key is deliberately kept, so pressing the button again is the
         same attempt rather than a second order. */
      fail(btn, status, err, messageFor(res), choices);
    }).catch(function (e) {
      if (window.console) console.error('[square-test] checkout request failed', e);
      fail(btn, status, err, 'The request to our checkout API did not complete. Check the connection and try again.', choices);
    });
  }

  function messageFor(res) {
    var b = res.body || {};
    if (b.error === 'VARIATION_NOT_ALLOWED' || b.error === 'QUANTITY_NOT_ALLOWED') {
      return 'This test only sells one unit of the sandbox variation.';
    }
    if (b.error === 'CONFIG_ERROR') {
      return 'The checkout service is not configured yet. ' + (b.message || '');
    }
    if (b.error === 'SQUARE_ERROR') {
      var d = b.details && b.details.length ? b.details[0] : null;
      return 'Square turned the request down' + (d && d.detail ? ': ' + d.detail : '.');
    }
    if (b.message) return b.message;
    return 'The checkout service answered ' + res.status + '.';
  }

  function fail(btn, status, err, message, choices) {
    btn.disabled = false;
    choices.disabled = false;
    btn.removeAttribute('aria-busy');
    btn.textContent = 'Try Checkout Again';
    status.textContent = '';
    err.textContent = message;
    err.hidden = false;
  }

  /* ------------------------------------------------------------------ go */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
