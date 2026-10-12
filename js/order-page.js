/* ==========================================================================
   All Star Players / the page Square sends people back to
   --------------------------------------------------------------------------
   Landing here means the customer came back from Square's checkout. It does
   NOT mean they paid. The redirect is just a redirect, and the query string
   is whatever the browser was handed.

   So this page asks our API, which asks Square, and reports what Square
   actually said. Until that answer arrives it says "checking", not "thank
   you for your order".

   The cart is only emptied of lines that a verified payment covered. A
   cancelled or failed payment leaves it exactly as it was.
   ========================================================================== */
(function () {
  'use strict';

  var ASP = window.ASP || (window.ASP = {});
  var root = document.querySelector('[data-order-page]');
  if (!root) return;

  var money = ASP.money;
  var token = new URLSearchParams(window.location.search).get('t') || '';
  var pollTimer = null;
  var polls = 0;

  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var STATES = {
    checking: {
      cls: 'checking', title: 'Checking with Square…',
      body: 'Hold on while we confirm what happened to your payment.'
    },
    paid: {
      cls: 'paid', title: 'Payment confirmed',
      body: 'Square has confirmed your payment. Here is what you bought.'
    },
    pending: {
      cls: 'pending', title: 'Payment not confirmed yet',
      body: 'Square has not confirmed a completed payment for this order. ' +
            'If you have just paid, this page will update on its own. ' +
            'Nothing has been taken from your cart yet.'
    },
    canceled: {
      cls: 'canceled', title: 'Payment cancelled',
      body: 'This order was cancelled, so nothing has been charged. ' +
            'Your cart has been kept exactly as it was.'
    },
    failed: {
      cls: 'failed', title: 'Payment did not go through',
      body: 'Square could not take the payment. Nothing has been charged and your cart has been kept.'
    },
    unknown: {
      cls: 'pending', title: 'We could not confirm this order',
      body: 'We could not reach Square to check. Your cart has been kept. ' +
            'Please call the store before trying again, so you are not charged twice.'
    }
  };

  function render(status, data) {
    var shape = STATES[status] || STATES.unknown;
    root.innerHTML = '';
    root.className = 'order order--' + shape.cls;

    root.appendChild(h('p', 'order__eyebrow', 'Your order'));
    root.appendChild(h('h1', 'order__title', shape.title));
    root.appendChild(h('p', 'order__body', shape.body));

    if (status === 'checking') {
      root.appendChild(h('span', 'order__bar'));
      return;
    }

    if (data && data.order) {
      var o = data.order;
      if (o.lines && o.lines.length) {
        var list = h('ul', 'order__lines');
        o.lines.forEach(function (l) {
          var li = h('li');
          li.appendChild(h('span', null, l.quantity + ' × ' + (l.name || 'Item') +
            (l.variationName ? ' (' + l.variationName + ')' : '')));
          li.appendChild(h('b', null, money(l.total, l.currency)));
          list.appendChild(li);
        });
        root.appendChild(list);
      }
      if (o.totals) {
        var t = h('div', 'order__totals');
        if (o.totals.serviceCharge) t.appendChild(totalRow('Shipping', o.totals.serviceCharge, o.totals.currency));
        if (o.totals.tax) t.appendChild(totalRow('Tax', o.totals.tax, o.totals.currency));
        t.appendChild(totalRow('Total', o.totals.total, o.totals.currency, true));
        root.appendChild(t);
      }
    }

    if (status === 'paid' && data) {
      if (data.fulfillmentType === 'pickup') {
        var box = h('div', 'order__fulfil');
        box.appendChild(h('b', null, 'Collecting from the store'));
        if (data.pickupAddress) box.appendChild(h('p', null, data.pickupAddress));
        box.appendChild(h('p', null, data.pickupPolicy ||
          'We will contact you when your order is ready to collect.'));
        /* No automated email exists. Saying so beats implying one. */
        box.appendChild(h('small', null,
          'A member of staff will get in touch using the contact details you gave. ' +
          'There is no automatic ready-for-collection email yet.'));
        root.appendChild(box);
      } else if (data.fulfillmentType === 'shipping') {
        var ship = h('div', 'order__fulfil');
        ship.appendChild(h('b', null, 'Shipping'));
        ship.appendChild(h('p', null, 'Your parcel will be sent to the address you gave at checkout.'));
        ship.appendChild(h('small', null,
          'Tracking is added by staff once the parcel goes out; it is not automatic.'));
        root.appendChild(ship);
      }
    }

    if (!data || !data.verified) {
      root.appendChild(h('p', 'order__caveat',
        'This status could not be confirmed with Square just now.'));
    }

    var actions = h('div', 'order__actions');
    var shop = h('a', 'btn btn--gold', 'Keep Shopping');
    shop.href = 'shop.html';
    actions.appendChild(shop);

    if (status !== 'paid') {
      var cart = h('a', 'btn btn--ghost', 'Back to Your Cart');
      cart.href = 'cart.html';
      actions.appendChild(cart);
    }
    if (status === 'pending' || status === 'unknown') {
      var again = h('button', 'btn btn--ghost', 'Check Again');
      again.type = 'button';
      again.addEventListener('click', function () { check(true); });
      actions.appendChild(again);
    }
    var call = h('a', 'btn btn--ghost', 'Call the Store');
    call.href = 'tel:+17185051038';
    actions.appendChild(call);
    root.appendChild(actions);
  }

  function totalRow(label, amount, currency, strong) {
    var row = h('div', 'order__total-row' + (strong ? ' is-total' : ''));
    row.appendChild(h('span', null, label));
    row.appendChild(h('b', null, money(amount, currency)));
    return row;
  }

  function check(manual) {
    if (!token) {
      render('unknown', null);
      return;
    }
    if (manual) render('checking', null);

    ASP.api.orderStatus(token).then(function (data) {
      if (data.status === 'paid') {
        /* Only now, and only for a cart checkout.

           A Buy Now purchase never touched the saved cart, and the thing it
           bought may well also be sitting in that cart — somebody who has a
           shirt in their bag and then buys the same shirt outright still
           wants the one in their bag. So nothing is removed. */
        if (data.purchaseSource !== 'buynow' &&
            data.purchasedVariationIds && data.purchasedVariationIds.length) {
          ASP.cart.removeMany(data.purchasedVariationIds);
        }
        ASP.cart.clearBuyNow();
        ASP.cart.newAttempt();
        stopPolling();
      }
      if (data.status === 'canceled' || data.status === 'failed') {
        /* The cart is deliberately untouched. */
        ASP.cart.clearBuyNow();
        stopPolling();
      }
      render(data.status, data);
    }).catch(function (err) {
      if (err.status === 404) { render('unknown', null); stopPolling(); return; }
      render('unknown', null);
    });
  }

  /* Square's webhook usually lands within a second or two of the redirect,
     but not always. A few polls, then stop and offer a button, rather than
     hammering the API forever. */
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(function () {
      polls++;
      if (polls > 10) { stopPolling(); return; }
      check(false);
    }, 3000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  render('checking', null);
  check(false);
  startPolling();
  window.addEventListener('beforeunload', stopPolling);
})();
