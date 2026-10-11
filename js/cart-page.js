/* ==========================================================================
   All Star Players / the cart and checkout page
   --------------------------------------------------------------------------
   Two jobs on one page.

   First, show the cart. The browser only stores variation ids and
   quantities, so the page asks the API what those actually are — name,
   photograph, price, how many are left. That same call is the reconciliation
   step: if the shop has sold out of something, or a price has moved, the
   answer says so and the customer is told before they go any further.

   Second, take the delivery details and ask for a checkout page. The order is
   priced by the server. Nothing on this page can change what is charged.

   `?buynow=1` checks out a single item without touching the saved cart.
   ========================================================================== */
(function () {
  'use strict';

  var ASP = window.ASP || (window.ASP = {});
  var root = document.querySelector('[data-cart-page]');
  if (!root) return;

  var money = ASP.money;
  var buyNowMode = new URLSearchParams(window.location.search).get('buynow') === '1';

  var els = {
    status: root.querySelector('[data-cart-status]'),
    lines: root.querySelector('[data-cart-lines]'),
    summary: root.querySelector('[data-cart-summary]'),
    empty: root.querySelector('[data-cart-empty]'),
    notices: root.querySelector('[data-cart-notices]'),
    form: root.querySelector('[data-checkout-form]'),
    methods: root.querySelector('[data-fulfillment-methods]'),
    shippingFields: root.querySelector('[data-shipping-fields]'),
    pickupNote: root.querySelector('[data-pickup-note]'),
    pay: root.querySelector('[data-pay]'),
    payMsg: root.querySelector('[data-pay-message]'),
    mode: root.querySelector('[data-cart-mode]')
  };

  var state = { cart: null, config: null, busy: false, method: null };

  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function linesForRequest() {
    if (buyNowMode) {
      var b = ASP.cart.getBuyNow();
      return b ? [{ variationId: b.variationId, quantity: b.quantity }] : [];
    }
    return ASP.cart.read();
  }

  function setBusy(on) {
    state.busy = on;
    root.classList.toggle('is-busy', on);
    root.querySelectorAll('button, input, select').forEach(function (el) {
      if (el.hasAttribute('data-always-enabled')) return;
      el.disabled = on;
    });
  }

  /* --------------------------------------------------------------- load */

  function load() {
    var lines = linesForRequest();
    showStatus('loading', 'Checking prices and stock…');
    if (els.lines) els.lines.innerHTML = '';
    if (els.summary) els.summary.hidden = true;
    if (els.form) els.form.hidden = true;
    if (els.empty) els.empty.hidden = true;

    if (!lines.length) {
      clearStatus();
      if (els.empty) els.empty.hidden = false;
      if (els.mode) els.mode.hidden = true;
      return;
    }

    Promise.all([
      ASP.api.validateCart(lines),
      state.config ? Promise.resolve({ config: state.config }) : ASP.api.config()
    ]).then(function (results) {
      state.cart = results[0].cart;
      state.config = results[1].config;
      clearStatus();
      renderLines();
      renderNotices();
      renderForm();
    }).catch(function (err) {
      showStatus('error', err.message, load);
    });
  }

  function showStatus(kind, text, onRetry) {
    if (!els.status) return;
    els.status.hidden = false;
    els.status.className = 'cart-status cart-status--' + kind;
    els.status.innerHTML = '';
    els.status.appendChild(h('span', null, text));
    if (onRetry) {
      var b = h('button', 'btn btn--ghost btn--sm', 'Try Again');
      b.type = 'button';
      b.setAttribute('data-always-enabled', '');
      b.addEventListener('click', load);
      els.status.appendChild(b);
    }
  }
  function clearStatus() { if (els.status) els.status.hidden = true; }

  /* -------------------------------------------------------------- lines */

  function renderLines() {
    els.lines.innerHTML = '';
    if (els.mode) {
      els.mode.hidden = !buyNowMode;
      if (buyNowMode) {
        els.mode.innerHTML = '';
        els.mode.appendChild(h('b', null, 'Buying one item'));
        els.mode.appendChild(h('span', null,
          'This is a direct purchase. Your saved cart (' + ASP.cart.count() + ' item' +
          (ASP.cart.count() === 1 ? '' : 's') + ') is untouched.'));
        var link = h('a', null, 'Go to your cart instead');
        link.href = 'cart.html';
        els.mode.appendChild(link);
      }
    }

    state.cart.lines.forEach(function (line) {
      els.lines.appendChild(lineRow(line));
    });

    var t = state.cart.totals;
    els.summary.hidden = false;
    els.summary.innerHTML = '';
    var row = h('div', 'sum__row');
    row.appendChild(h('span', null, 'Subtotal (' + t.itemCount + ' item' + (t.itemCount === 1 ? '' : 's') + ')'));
    row.appendChild(h('b', null, money(t.subtotal, t.currency)));
    els.summary.appendChild(row);
    /* Said plainly rather than shown as a zero. */
    els.summary.appendChild(h('p', 'sum__note',
      'Shipping is added when you choose it below. Sales tax is worked out by Square on the payment page.'));
  }

  function lineRow(line) {
    var row = h('div', 'cline' + (line.removed ? ' cline--removed' : ''));

    var media = h('div', 'cline__media');
    if (line.imageUrl) {
      var img = new Image();
      img.src = line.imageUrl;
      img.alt = line.productName || '';
      img.loading = 'lazy';
      img.addEventListener('error', function () { img.remove(); media.appendChild(h('span', 'cline__nophoto', 'No photo')); });
      media.appendChild(img);
    } else {
      media.appendChild(h('span', 'cline__nophoto', 'No photo'));
    }
    row.appendChild(media);

    var body = h('div', 'cline__body');
    body.appendChild(h('p', 'cline__name', line.productName || 'This item is no longer available'));
    if (line.options && line.options.length) {
      body.appendChild(h('p', 'cline__opts',
        line.options.map(function (o) { return o.name + ': ' + o.value; }).join(' · ')));
    } else if (line.name) {
      body.appendChild(h('p', 'cline__opts', line.name));
    }
    if (line.sku) body.appendChild(h('p', 'cline__sku', 'SKU ' + line.sku));

    if (line.removed) {
      body.appendChild(h('p', 'cline__gone', 'Not available — it will not be charged for.'));
    } else if (line.inventoryState === 'UNKNOWN') {
      body.appendChild(h('p', 'cline__unknown', 'Availability unknown'));
    } else if (line.available != null && line.available <= 3) {
      body.appendChild(h('p', 'cline__low', 'Only ' + line.available + ' left'));
    }
    row.appendChild(body);

    var side = h('div', 'cline__side');
    if (!line.removed) {
      side.appendChild(h('p', 'cline__price', money(line.unitPrice * line.quantity, line.currency)));
      if (line.quantity > 1) {
        side.appendChild(h('p', 'cline__each', money(line.unitPrice, line.currency) + ' each'));
      }
    }

    /* In buy-now mode the quantity belongs to the one-off purchase, not the
       saved cart, so changing it must not write to the cart. */
    var qty = h('div', 'qty');
    var down = h('button', null, '−');
    down.type = 'button';
    down.setAttribute('aria-label', 'One fewer ' + (line.productName || 'item'));
    down.disabled = line.removed || line.quantity <= 1;
    down.addEventListener('click', function () { changeQuantity(line, line.quantity - 1); });
    var out = h('output', null, String(line.quantity));
    var up = h('button', null, '+');
    up.type = 'button';
    up.setAttribute('aria-label', 'One more ' + (line.productName || 'item'));
    up.disabled = line.removed || (line.available != null && line.quantity >= line.available) ||
                  line.quantity >= ASP.cart.MAX_QTY;
    up.addEventListener('click', function () { changeQuantity(line, line.quantity + 1); });
    qty.appendChild(down); qty.appendChild(out); qty.appendChild(up);
    side.appendChild(qty);

    var del = h('button', 'cline__remove', 'Remove');
    del.type = 'button';
    del.addEventListener('click', function () {
      if (buyNowMode) { ASP.cart.clearBuyNow(); window.location.href = 'cart.html'; return; }
      ASP.cart.remove(line.variationId);
      load();
    });
    side.appendChild(del);
    row.appendChild(side);
    return row;
  }

  function changeQuantity(line, next) {
    if (state.busy) return;
    setBusy(true);
    if (buyNowMode) ASP.cart.setBuyNow(line.variationId, next);
    else ASP.cart.setQuantity(line.variationId, next);
    /* Changing the cart starts a new checkout attempt, so the old attempt's
       idempotency key cannot be reused for different contents. */
    ASP.cart.newAttempt();
    load();
    setBusy(false);
  }

  /* ------------------------------------------------------------ notices */

  function renderNotices() {
    els.notices.innerHTML = '';
    if (!state.cart.problems.length) { els.notices.hidden = true; return; }
    els.notices.hidden = false;
    var box = h('div', 'notice notice--warn');
    box.appendChild(h('b', null, 'Your cart changed'));
    var ul = h('ul');
    state.cart.problems.forEach(function (p) { ul.appendChild(h('li', null, p.message)); });
    box.appendChild(ul);
    box.appendChild(h('p', null, 'Check it over, then carry on.'));
    els.notices.appendChild(box);
  }

  /* --------------------------------------------------------------- form */

  function renderForm() {
    if (!state.cart.payableLines.length) {
      els.form.hidden = true;
      return;
    }
    els.form.hidden = false;
    var f = state.config.fulfillment;

    els.methods.innerHTML = '';
    var available = [];
    if (f.pickup.available) available.push(['pickup', 'Collect from the store', f.pickup.address]);
    if (f.shipping.available) available.push(['shipping', 'Ship it to me', 'Parcel delivery by carrier']);

    if (!available.length) {
      els.methods.appendChild(notice('error', 'Online ordering is not open yet',
        'Neither pickup nor shipping has been switched on. Call ' + (state.config.storePhone || 'the store') + ' to buy these.'));
      els.pay.disabled = true;
      return;
    }

    available.forEach(function (opt) {
      var id = 'ff-' + opt[0];
      var label = h('label', 'method');
      var input = document.createElement('input');
      input.type = 'radio'; input.name = 'fulfillment'; input.value = opt[0]; input.id = id;
      input.checked = state.method ? state.method === opt[0] : available[0][0] === opt[0];
      if (input.checked) state.method = opt[0];
      input.addEventListener('change', function () { state.method = opt[0]; syncMethod(); });
      label.appendChild(input);
      var text = h('span', 'method__text');
      text.appendChild(h('b', null, opt[1]));
      text.appendChild(h('small', null, opt[2] || ''));
      label.appendChild(text);
      els.methods.appendChild(label);
    });

    syncMethod();
  }

  function syncMethod() {
    var shipping = state.method === 'shipping';
    els.shippingFields.hidden = !shipping;
    els.shippingFields.querySelectorAll('input, select').forEach(function (el) {
      if (el.hasAttribute('data-optional')) return;
      el.required = shipping;
    });

    els.pickupNote.hidden = shipping;
    if (!shipping && state.config.fulfillment.pickup.available) {
      els.pickupNote.innerHTML = '';
      els.pickupNote.appendChild(h('b', null, 'Collect in store'));
      els.pickupNote.appendChild(h('p', null, state.config.fulfillment.pickup.address));
      els.pickupNote.appendChild(h('p', null, state.config.fulfillment.pickup.policy));
    }

    renderShippingEstimate();
  }

  /* The rate the shop configured for the address as typed so far. It is a
     preview of the server's own number, not a separate calculation: the
     server works it out again and that is the one that gets charged. */
  function renderShippingEstimate() {
    var box = root.querySelector('[data-shipping-estimate]');
    if (!box) return;
    if (state.method !== 'shipping') { box.hidden = true; return; }
    var zones = state.config.fulfillment.shipping.zones;
    var countryEl = root.querySelector('[name="country"]');
    var stateEl = root.querySelector('[name="state"]');
    var country = (countryEl && countryEl.value || 'US').toUpperCase();
    var region = (stateEl && stateEl.value || '').toUpperCase();

    var inCountry = zones.filter(function (z) { return z.countries.indexOf(country) > -1; });
    var withState = inCountry.filter(function (z) { return z.states.length && z.states.indexOf(region) > -1; });
    var zone = withState[0] || inCountry.filter(function (z) { return !z.states.length; })[0];

    box.hidden = false;
    box.innerHTML = '';
    if (!zone) {
      box.appendChild(h('span', null, 'We do not have a shipping rate for that address.'));
      return;
    }
    var subtotal = state.cart.totals.subtotal;
    var free = zone.freeOver != null && subtotal >= zone.freeOver;
    box.appendChild(h('span', null,
      free ? zone.label + ' shipping: free on this order'
           : zone.label + ' shipping: ' + money(zone.amount, zone.currency)));
    if (!free && zone.freeOver != null) {
      box.appendChild(h('small', null,
        'Free over ' + money(zone.freeOver, zone.currency) + '. Confirmed on the payment page.'));
    }
  }

  function notice(kind, title, text) {
    var box = h('div', 'notice notice--' + kind);
    if (title) box.appendChild(h('b', null, title));
    if (text) box.appendChild(h('p', null, text));
    return box;
  }

  /* ------------------------------------------------------------- paying */

  function fieldValue(name) {
    var el = root.querySelector('[name="' + name + '"]');
    return el ? el.value.trim() : '';
  }

  function payload() {
    var contact = {
      firstName: fieldValue('firstName'),
      lastName: fieldValue('lastName'),
      email: fieldValue('email'),
      phone: fieldValue('phone')
    };
    var fulfillment = { type: state.method, contact: contact };
    if (state.method === 'shipping') {
      fulfillment.address = {
        line1: fieldValue('line1'), line2: fieldValue('line2'),
        city: fieldValue('city'), state: fieldValue('state'),
        postalCode: fieldValue('postalCode'), country: fieldValue('country') || 'US'
      };
    }
    return {
      attemptId: ASP.cart.attemptId(),
      /* Ids and quantities only. The server prices it. */
      lines: state.cart.payableLines.map(function (l) {
        return { variationId: l.variationId, quantity: l.quantity };
      }),
      fulfillment: fulfillment
    };
  }

  function clearFieldErrors() {
    root.querySelectorAll('.field--error').forEach(function (el) { el.classList.remove('field--error'); });
    root.querySelectorAll('[data-field-error]').forEach(function (el) { el.remove(); });
  }

  function showFieldErrors(errors) {
    clearFieldErrors();
    var first = null;
    (errors || []).forEach(function (e) {
      var name = e.field.split('.').pop();
      var input = root.querySelector('[name="' + name + '"]');
      if (!input) return;
      var wrap = input.closest('.field') || input.parentElement;
      wrap.classList.add('field--error');
      var msg = h('small', null, e.message);
      msg.setAttribute('data-field-error', '');
      wrap.appendChild(msg);
      if (!first) first = input;
    });
    if (first) first.focus();
  }

  function pay(e) {
    if (e) e.preventDefault();
    if (state.busy) return;
    clearFieldErrors();
    els.payMsg.textContent = '';
    els.payMsg.className = 'pay-msg';
    setBusy(true);
    els.pay.textContent = 'Setting up payment…';

    ASP.api.checkout(payload()).then(function (res) {
      if (!res || !res.checkoutUrl) throw new Error('The checkout service did not return a payment page.');
      /* Nothing here says "paid". Square's page is next, and only Square can
         say whether the payment went through. */
      els.pay.textContent = 'Taking you to Square…';
      window.location.assign(res.checkoutUrl);
    }).catch(function (err) {
      setBusy(false);
      els.pay.textContent = 'Pay with Square';

      if (err.code === 'CART_CHANGED' || err.code === 'CART_EMPTY_AFTER_REVIEW') {
        /* The server sent the corrected cart back. Show it and let them look
           before anything is charged. */
        state.cart = err.body.cart;
        renderLines();
        renderNotices();
        renderForm();
        els.payMsg.textContent = 'Your cart changed. Please check it over, then try again.';
        els.payMsg.className = 'pay-msg pay-msg--warn';
        if (els.notices) els.notices.scrollIntoView({ behavior: 'smooth', block: 'center' });
        ASP.cart.newAttempt();
        return;
      }
      if (err.code === 'FULFILLMENT_INVALID' && err.body && err.body.fieldErrors) {
        showFieldErrors(err.body.fieldErrors);
        els.payMsg.textContent = 'Check the highlighted details.';
        els.payMsg.className = 'pay-msg pay-msg--error';
        return;
      }
      if (err.code === 'CHECKOUT_IN_PROGRESS') {
        els.payMsg.textContent = err.message;
        els.payMsg.className = 'pay-msg pay-msg--warn';
        return;
      }
      els.payMsg.textContent = err.message;
      els.payMsg.className = 'pay-msg pay-msg--error';
    });
  }

  if (els.form) els.form.addEventListener('submit', pay);
  root.addEventListener('input', function (e) {
    if (e.target.name === 'state' || e.target.name === 'country') renderShippingEstimate();
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
  else load();
})();
