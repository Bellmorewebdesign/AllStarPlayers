/* ==========================================================================
   All Star Players / the size and colour picker
   --------------------------------------------------------------------------
   A dialog over the grid. Its whole job is to make sure the thing a customer
   puts in the cart is a real Square variation that is really for sale.

   The combination rules:

     - every option button corresponds to real variations, so a size that
       does not exist in the chosen colour is disabled rather than hidden
     - a combination that exists but is sold out is shown, disabled, and
       labelled "sold out", because that is more useful than it vanishing
     - "In stock" means Square counted it. "Availability unknown" means
       Square is not counting it. The two never read the same.
     - the quantity stepper will not go above what Square says is there

   Items without Square item options fall back to a plain list of variations.
   ========================================================================== */
(function () {
  'use strict';

  var ASP = window.ASP || (window.ASP = {});
  var money = ASP.money;

  var dialog, product, selection, quantity, lastFocus;

  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('div');
    dialog.className = 'pick';
    dialog.hidden = true;
    dialog.innerHTML =
      '<div class="pick__scrim" data-pick-close></div>' +
      '<div class="pick__panel" role="dialog" aria-modal="true" aria-labelledby="pick-title">' +
        '<button class="pick__close" type="button" data-pick-close aria-label="Close">' +
          '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.8" fill="none"/></svg>' +
        '</button>' +
        '<div class="pick__media" data-pick-media></div>' +
        '<div class="pick__body">' +
          '<h2 id="pick-title" data-pick-name></h2>' +
          '<p class="pick__price" data-pick-price></p>' +
          '<p class="pick__desc" data-pick-desc></p>' +
          '<div data-pick-options></div>' +
          '<p class="pick__stock" data-pick-stock aria-live="polite"></p>' +
          '<div class="pick__qty">' +
            '<span id="pick-qty-label">Quantity</span>' +
            '<div class="qty" role="group" aria-labelledby="pick-qty-label">' +
              '<button type="button" data-qty-down aria-label="One fewer">−</button>' +
              '<output data-qty-value>1</output>' +
              '<button type="button" data-qty-up aria-label="One more">+</button>' +
            '</div>' +
          '</div>' +
          '<div class="pick__actions">' +
            '<button class="btn btn--gold" type="button" data-pick-add>Add to Cart</button>' +
            '<button class="btn btn--ghost" type="button" data-pick-buy>Buy Now</button>' +
          '</div>' +
          '<p class="pick__msg" data-pick-msg role="status"></p>' +
          '<p class="pick__fine" data-pick-fine></p>' +
        '</div>' +
      '</div>';
    document.body.appendChild(dialog);

    dialog.querySelectorAll('[data-pick-close]').forEach(function (b) {
      b.addEventListener('click', close);
    });
    dialog.querySelector('[data-qty-down]').addEventListener('click', function () { bump(-1); });
    dialog.querySelector('[data-qty-up]').addEventListener('click', function () { bump(1); });
    dialog.querySelector('[data-pick-add]').addEventListener('click', function () { commit('add'); });
    dialog.querySelector('[data-pick-buy]').addEventListener('click', function () { commit('buy'); });
    document.addEventListener('keydown', onKey);
    return dialog;
  }

  function onKey(e) {
    if (dialog.hidden) return;
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Tab') return;
    var focusable = dialog.querySelectorAll('button:not([disabled]), [href], select, input');
    if (!focusable.length) return;
    var first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* ------------------------------------------------------- combinations */

  function valueOf(variation, optionId) {
    for (var i = 0; i < variation.options.length; i++) {
      if (variation.options[i].optionId === optionId) return variation.options[i].valueId;
    }
    return null;
  }

  /* Variations that agree with every axis except the one being asked about. */
  function candidates(exceptOptionId) {
    return product.variations.filter(function (v) {
      return product.optionAxes.every(function (axis) {
        if (axis.optionId === exceptOptionId) return true;
        var chosen = selection[axis.optionId];
        if (!chosen) return true;
        return valueOf(v, axis.optionId) === chosen;
      });
    });
  }

  function currentVariation() {
    if (!product.optionAxes.length) {
      return product.variations.find(function (v) { return v.id === selection.__single; }) || null;
    }
    var all = product.optionAxes.every(function (a) { return selection[a.optionId]; });
    if (!all) return null;
    return product.variations.find(function (v) {
      return product.optionAxes.every(function (a) { return valueOf(v, a.optionId) === selection[a.optionId]; });
    }) || null;
  }

  /* --------------------------------------------------------------- draw */

  function drawOptions() {
    var box = dialog.querySelector('[data-pick-options]');
    box.innerHTML = '';

    if (!product.optionAxes.length) {
      /* No Square item options on this item: one plain list of variations. */
      if (product.variations.length === 1) {
        selection.__single = product.variations[0].id;
        return;
      }
      var group = h('div', 'pick__axis');
      group.appendChild(h('span', 'pick__axis-name', 'Option'));
      var row = h('div', 'pick__values');
      product.variations.forEach(function (v) {
        row.appendChild(valueButton(v.name || 'Option', v.id, v.sellable, labelFor(v), function () {
          selection.__single = v.id; draw();
        }, selection.__single === v.id));
      });
      group.appendChild(row);
      box.appendChild(group);
      return;
    }

    product.optionAxes.forEach(function (axis) {
      var group = h('div', 'pick__axis');
      group.appendChild(h('span', 'pick__axis-name', axis.name));
      var row = h('div', 'pick__values');
      var pool = candidates(axis.optionId);

      axis.values.forEach(function (value) {
        var forThisValue = pool.filter(function (v) { return valueOf(v, axis.optionId) === value.valueId; });
        var sellable = forThisValue.some(function (v) { return v.sellable; });
        var exists = forThisValue.length > 0;
        var note = !exists ? 'not made in this combination'
          : !sellable ? 'sold out'
          : null;
        row.appendChild(valueButton(
          value.name, value.valueId, exists && sellable, note,
          function () { selection[axis.optionId] = value.valueId; draw(); },
          selection[axis.optionId] === value.valueId
        ));
      });
      group.appendChild(row);
      box.appendChild(group);
    });
  }

  function labelFor(v) {
    if (!v.sellable) {
      return v.unsellableReason === 'VARIABLE_PRICE' ? 'priced in store' : 'sold out';
    }
    return null;
  }

  function valueButton(label, id, enabled, note, onClick, selected) {
    var b = h('button', 'pick__value' + (selected ? ' is-selected' : '') + (enabled ? '' : ' is-unavailable'));
    b.type = 'button';
    b.disabled = !enabled;
    b.setAttribute('aria-pressed', selected ? 'true' : 'false');
    b.appendChild(h('span', null, label));
    if (note) {
      b.appendChild(h('small', null, note));
      b.setAttribute('aria-label', label + ', ' + note);
    }
    if (enabled) b.addEventListener('click', onClick);
    return b;
  }

  function maxQuantity(v) {
    if (!v) return 1;
    var cap = ASP.cart.MAX_QTY;
    if (v.inventory.state === 'IN_STOCK' && v.inventory.quantity != null) {
      return Math.max(1, Math.min(v.inventory.quantity, cap));
    }
    return cap;
  }

  function bump(by) {
    var v = currentVariation();
    quantity = Math.max(1, Math.min(quantity + by, maxQuantity(v)));
    draw();
  }

  /* What the shop can do right now, as the API reported it on page load.
     An unknown answer is treated as closed: offering a checkout that cannot
     finish is worse than not offering one. */
  function ordering() {
    var o = ASP.ordering;
    return { open: !!(o && o.open), phone: (o && o.phone) || null };
  }

  /* "Buy Now" goes straight to a checkout, so it only exists when a checkout
     exists. "Add to Cart" stays either way: with ordering closed the cart is
     a list to bring into the store, which the fine print says plainly. */
  function drawOrdering() {
    var o = ordering();
    var buy = dialog.querySelector('[data-pick-buy]');
    var fine = dialog.querySelector('[data-pick-fine]');
    buy.hidden = !o.open;
    fine.textContent = o.open
      ? 'Tax and any shipping are worked out at checkout.'
      : 'Online ordering is not open yet, so this builds a list rather than an order. ' +
        'Nothing is held for you until you buy it in store.';
  }

  /* Square may hold a photograph on the variation as well as on the product,
     so the picture follows the colour somebody picks. If it does not, the
     product's own photograph stands, then one we sourced, then nothing. */
  function drawMedia() {
    var media = dialog.querySelector('[data-pick-media]');
    if (!media || !product) return;
    var pic = ASP.images ? ASP.images.forProduct(product, currentVariation()) : null;
    /* Keyed on the product too, so two products sharing a photograph do not
       keep each other's alt text. */
    var key = product.id + '|' + (pic ? pic.src : '');
    if (media.getAttribute('data-shows') === key) return;
    media.setAttribute('data-shows', key);
    media.innerHTML = '';

    if (!pic) { media.appendChild(noPhoto()); return; }
    var img = new Image();
    img.src = pic.src;
    img.alt = pic.alt || product.name;
    img.addEventListener('error', function () {
      img.remove();
      media.setAttribute('data-shows', product.id + '|');
      media.appendChild(noPhoto());
    });
    media.appendChild(img);
    if (pic.credit) {
      media.appendChild(h('p', 'pick__credit',
        'Photo: ' + pic.credit + (pic.license ? ' (' + pic.license + ')' : '')));
    }
  }

  function draw() {
    drawOrdering();
    drawOptions();
    drawMedia();
    var v = currentVariation();
    var add = dialog.querySelector('[data-pick-add]');
    var buy = dialog.querySelector('[data-pick-buy]');
    var stock = dialog.querySelector('[data-pick-stock]');
    var price = dialog.querySelector('[data-pick-price]');

    if (v && v.sellable) {
      quantity = Math.min(quantity, maxQuantity(v));
      price.textContent = money(v.price.amount, v.price.currency);
      if (v.inventory.state === 'IN_STOCK') {
        stock.textContent = v.inventory.quantity != null && v.inventory.quantity <= 5
          ? 'In stock — only ' + v.inventory.quantity + ' left'
          : 'In stock';
        stock.className = 'pick__stock pick__stock--in';
      } else {
        /* Square is not counting this one. Said as it is. */
        stock.textContent = 'Availability unknown — we will confirm before it ships';
        stock.className = 'pick__stock pick__stock--unknown';
      }
      add.disabled = false; buy.disabled = false;
    } else {
      price.textContent = v ? '' : priceRange();
      stock.textContent = v ? 'That combination is not available.' : 'Choose an option to see the price.';
      stock.className = 'pick__stock' + (v ? ' pick__stock--out' : '');
      add.disabled = true; buy.disabled = true;
    }

    dialog.querySelector('[data-qty-value]').textContent = String(quantity);
    dialog.querySelector('[data-qty-down]').disabled = quantity <= 1;
    dialog.querySelector('[data-qty-up]').disabled = quantity >= maxQuantity(v);
  }

  function priceRange() {
    var r = product.priceRange;
    return r.min === r.max ? money(r.min, r.currency)
      : money(r.min, r.currency) + ' – ' + money(r.max, r.currency);
  }

  /* -------------------------------------------------------------- actions */

  function message(text, kind) {
    var el = dialog.querySelector('[data-pick-msg]');
    el.textContent = text || '';
    el.className = 'pick__msg' + (kind ? ' pick__msg--' + kind : '');
  }

  function commit(mode) {
    var v = currentVariation();
    if (!v || !v.sellable) return;
    /* Belt and braces: the button is hidden, and this refuses anyway. */
    if (mode === 'buy' && !ordering().open) return;

    var add = dialog.querySelector('[data-pick-add]');
    var buy = dialog.querySelector('[data-pick-buy]');
    add.disabled = true; buy.disabled = true;

    if (mode === 'buy') {
      /* Buy now does not touch the saved cart. */
      ASP.cart.setBuyNow(v.id, quantity);
      ASP.cart.newAttempt();
      window.location.href = 'cart.html?buynow=1';
      return;
    }

    var result = ASP.cart.add(v.id, quantity);
    if (!result.ok) {
      message('Your cart is full. Check out first, or remove something.', 'error');
      add.disabled = false; buy.disabled = false;
      return;
    }
    message(quantity + ' added. ' + result.quantity + ' now in your cart.', 'ok');
    add.disabled = false; buy.disabled = false;
  }

  /* ---------------------------------------------------------- open/close */

  function open(p) {
    ensureDialog();
    product = p;
    selection = {};
    quantity = 1;
    lastFocus = document.activeElement;

    /* Start on the first combination that can actually be bought, so the
       common case is one tap. */
    var firstSellable = p.variations.find(function (v) { return v.sellable; });
    if (firstSellable) {
      if (p.optionAxes.length) {
        p.optionAxes.forEach(function (axis) {
          selection[axis.optionId] = valueOf(firstSellable, axis.optionId);
        });
      } else {
        selection.__single = firstSellable.id;
      }
    }

    dialog.querySelector('[data-pick-name]').textContent = p.name;
    var desc = dialog.querySelector('[data-pick-desc]');
    desc.textContent = p.description || '';
    desc.hidden = !p.description;

    drawMedia();

    message('');
    draw();
    dialog.hidden = false;
    document.body.classList.add('pick-open');
    var focusTarget = dialog.querySelector('.pick__value:not([disabled])') || dialog.querySelector('[data-pick-add]');
    if (focusTarget) focusTarget.focus();
  }

  function noPhoto() {
    var box = h('div', 'pick__placeholder');
    box.innerHTML = '<svg viewBox="0 0 690.8 823.4" aria-hidden="true" focusable="false">' +
      '<path fill="currentColor" d="M690.8 823.4L430.0 628.7L148.5 810.9L261.7 501.9L0.0 306.1L336.7 305.6L457.8 0.0L657.5 688.5Z"/></svg>';
    box.appendChild(h('span', null, 'Photo unavailable'));
    return box;
  }

  function close() {
    if (!dialog || dialog.hidden) return;
    dialog.hidden = true;
    document.body.classList.remove('pick-open');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  ASP.picker = { open: open, close: close };
})();
