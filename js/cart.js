/* ==========================================================================
   All Star Players / the cart
   --------------------------------------------------------------------------
   What is kept in the browser: variation ids and quantities. Nothing else.

   Not kept: prices, names, photographs or stock. Those all go stale, and a
   stale price in localStorage is exactly the thing an attacker would like to
   edit. Everything the cart displays is fetched back from the API, and the
   server prices the order again before anybody pays.

   The cart survives a refresh, is shared across tabs, and counts a variation
   once: adding the same size twice makes one line of two.
   ========================================================================== */
(function () {
  'use strict';

  var ASP = window.ASP || (window.ASP = {});

  var KEY = 'asp.cart.v1';
  var BUYNOW_KEY = 'asp.buynow.v1';
  var MAX_LINES = 40;
  var MAX_QTY = 20;

  var listeners = [];

  function read() {
    var raw = null;
    try { raw = window.localStorage.getItem(KEY); } catch (e) { /* private mode */ }
    if (!raw) return [];
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.lines)) return [];
      return parsed.lines
        .filter(function (l) {
          return l && typeof l.variationId === 'string' &&
                 /^[A-Za-z0-9_-]{1,64}$/.test(l.variationId) &&
                 Number.isInteger(l.quantity) && l.quantity > 0;
        })
        .slice(0, MAX_LINES)
        .map(function (l) {
          return { variationId: l.variationId, quantity: Math.min(l.quantity, MAX_QTY) };
        });
    } catch (e) {
      return [];
    }
  }

  function write(lines) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify({ v: 1, lines: lines }));
    } catch (e) { /* the cart still works for this page view */ }
    notify();
  }

  function notify() {
    var state = { lines: read(), count: count() };
    listeners.forEach(function (fn) { try { fn(state); } catch (e) { /* keep going */ } });
  }

  function count() {
    return read().reduce(function (n, l) { return n + l.quantity; }, 0);
  }

  /* ------------------------------------------------------------- actions */

  function add(variationId, quantity) {
    var qty = Math.max(1, Math.min(Number(quantity) || 1, MAX_QTY));
    var lines = read();
    var existing = null;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].variationId === variationId) { existing = lines[i]; break; }
    }
    if (existing) {
      /* Repeated additions of the same variation merge into one line. */
      existing.quantity = Math.min(existing.quantity + qty, MAX_QTY);
    } else {
      if (lines.length >= MAX_LINES) return { ok: false, reason: 'TOO_MANY_LINES' };
      lines.push({ variationId: variationId, quantity: qty });
    }
    write(lines);
    return { ok: true, quantity: existing ? existing.quantity : qty };
  }

  function setQuantity(variationId, quantity) {
    var qty = Math.max(0, Math.min(Number(quantity) || 0, MAX_QTY));
    var lines = read().filter(function (l) {
      return l.variationId !== variationId || qty > 0;
    });
    lines.forEach(function (l) { if (l.variationId === variationId) l.quantity = qty; });
    write(lines);
  }

  function remove(variationId) {
    write(read().filter(function (l) { return l.variationId !== variationId; }));
  }

  /* Only the lines that were actually paid for are cleared. A "buy now"
     purchase leaves everything else exactly where the customer left it. */
  function removeMany(variationIds) {
    var drop = {};
    (variationIds || []).forEach(function (id) { drop[id] = true; });
    write(read().filter(function (l) { return !drop[l.variationId]; }));
  }

  function clear() { write([]); }

  /* ------------------------------------------------------------- buy now */

  /* Buy now is a one-item checkout that does not touch the saved cart. It
     lives in sessionStorage so it dies with the tab rather than lingering. */
  function setBuyNow(variationId, quantity) {
    var payload = { variationId: variationId, quantity: Math.max(1, Math.min(Number(quantity) || 1, MAX_QTY)) };
    try { window.sessionStorage.setItem(BUYNOW_KEY, JSON.stringify(payload)); } catch (e) { /* ignore */ }
    return payload;
  }
  function getBuyNow() {
    try {
      var raw = window.sessionStorage.getItem(BUYNOW_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (!p || typeof p.variationId !== 'string' || !Number.isInteger(p.quantity)) return null;
      return p;
    } catch (e) { return null; }
  }
  function clearBuyNow() {
    try { window.sessionStorage.removeItem(BUYNOW_KEY); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------- checkout attempt */

  /* One id per visit to the checkout form. It is half of the idempotency key
     the backend builds, so pressing Pay twice is one order, while editing the
     cart and pressing Pay again is a new one. */
  var ATTEMPT_KEY = 'asp.attempt.v1';
  function attemptId() {
    var id = null;
    try { id = window.sessionStorage.getItem(ATTEMPT_KEY); } catch (e) { /* ignore */ }
    if (!id) {
      id = 'a' + (window.crypto && window.crypto.randomUUID
        ? window.crypto.randomUUID().replace(/-/g, '')
        : String(Date.now()) + Math.random().toString(36).slice(2, 10)).slice(0, 40);
      try { window.sessionStorage.setItem(ATTEMPT_KEY, id); } catch (e) { /* ignore */ }
    }
    return id;
  }
  function newAttempt() {
    try { window.sessionStorage.removeItem(ATTEMPT_KEY); } catch (e) { /* ignore */ }
    return attemptId();
  }

  /* ---------------------------------------------------------- the badge */

  /* Every page carries the same button, so it is wired up here rather than
     repeated. The count comes straight out of storage, so it is right before
     any network call finishes. */
  function mountBadge() {
    var buttons = document.querySelectorAll('[data-cart-button]');
    if (!buttons.length) return;
    function paint(state) {
      Array.prototype.forEach.call(buttons, function (btn) {
        var badge = btn.querySelector('[data-cart-count]');
        if (!badge) return;
        badge.textContent = state.count > 99 ? '99+' : String(state.count);
        badge.hidden = state.count === 0;
        btn.setAttribute('aria-label',
          state.count === 0 ? 'Cart, empty' : 'Cart, ' + state.count + (state.count === 1 ? ' item' : ' items'));
      });
    }
    subscribe(paint);
    paint({ count: count() });
  }

  function subscribe(fn) {
    listeners.push(fn);
    return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
  }

  /* A second tab changing the cart updates this one. */
  window.addEventListener('storage', function (e) {
    if (e.key === KEY) notify();
  });

  ASP.cart = {
    read: read, count: count, add: add, setQuantity: setQuantity,
    remove: remove, removeMany: removeMany, clear: clear,
    setBuyNow: setBuyNow, getBuyNow: getBuyNow, clearBuyNow: clearBuyNow,
    attemptId: attemptId, newAttempt: newAttempt,
    subscribe: subscribe, mountBadge: mountBadge,
    MAX_QTY: MAX_QTY, MAX_LINES: MAX_LINES
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountBadge);
  } else {
    mountBadge();
  }
})();
