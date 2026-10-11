/* ==========================================================================
   All Star Players / the shop page
   --------------------------------------------------------------------------
   Draws the catalog that comes back from AWS, runs the search and the
   category filters over it, and opens the picker where a customer chooses a
   size and colour and puts it in the cart.

   Nothing here is hardcoded. If the API is unreachable the page says so and
   offers to try again; it never falls back to a stored copy of the catalog,
   because a stored copy would be a price and a stock level that nobody has
   checked.
   ========================================================================== */
(function () {
  'use strict';

  var ASP = window.ASP || (window.ASP = {});
  var grid = document.querySelector('[data-shop-grid]');
  if (!grid) return;

  var money = ASP.money;
  var state = {
    products: [], categories: [], q: '', category: 'all',
    sort: 'name-asc', loaded: false, meta: null, shown: 60
  };

  var els = {
    count: document.querySelector('[data-count]'),
    chipWraps: document.querySelectorAll('[data-chips]'),
    search: document.getElementById('shop-search'),
    searchClear: document.querySelector('[data-search-clear]'),
    sort: document.getElementById('shop-sort'),
    noResults: document.querySelector('[data-no-results]'),
    status: document.querySelector('[data-catalog-status]'),
    more: document.querySelector('[data-load-more]'),
    activeFilters: document.querySelector('[data-active-filters]'),
    clearButtons: document.querySelectorAll('[data-clear-filters]'),
    filterBtn: document.querySelector('[data-filter-open]'),
    drawer: document.querySelector('[data-drawer]')
  };

  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ----------------------------------------------------------- loading */

  function setStatus(kind, headline, detail, onRetry) {
    if (!els.status) return;
    els.status.innerHTML = '';
    els.status.hidden = false;
    els.status.className = 'catalog-status catalog-status--' + kind;
    if (headline) els.status.appendChild(h('b', null, headline));
    if (detail) els.status.appendChild(h('span', null, detail));
    if (onRetry) {
      var btn = h('button', 'btn btn--ghost btn--sm', 'Try Again');
      btn.type = 'button';
      btn.addEventListener('click', onRetry);
      els.status.appendChild(btn);
    }
  }
  function clearStatus() { if (els.status) els.status.hidden = true; }

  function skeleton(n) {
    grid.innerHTML = '';
    for (var i = 0; i < n; i++) {
      var card = h('article', 'card card--skeleton');
      card.appendChild(h('div', 'card__media'));
      var body = h('div', 'card__body');
      body.appendChild(h('span', 'skel skel--line'));
      body.appendChild(h('span', 'skel skel--short'));
      card.appendChild(body);
      grid.appendChild(card);
    }
  }

  function load() {
    clearStatus();
    skeleton(8);
    if (els.count) els.count.textContent = 'Loading the shop…';

    ASP.api.catalog(function (progress) {
      state.products = progress.products;
      state.meta = progress.meta;
      if (!state.loaded) {
        state.loaded = true;
        state.categories = progress.meta.categories;
        buildChips();
      }
      render();
      if (!progress.done && els.count) {
        els.count.textContent = 'Showing ' + state.products.length + ' of ' + progress.meta.total + ' products…';
      }
    }).then(function (result) {
      state.products = result.products;
      state.meta = result.meta;
      render();
      if (result.meta.stale) {
        setStatus('warn', 'Showing a saved copy',
          'We could not reach our catalog service just now, so prices and stock may be out of date. ' +
          'Everything is checked again before you pay.', load);
      }
    }).catch(function (err) {
      grid.innerHTML = '';
      if (els.count) els.count.textContent = '';
      setStatus('error', 'The shop would not load', err.message, load);
    });
  }

  /* ------------------------------------------------------------- filters */

  function buildChips() {
    Array.prototype.forEach.call(els.chipWraps, function (wrap) {
      wrap.innerHTML = '';
      var frag = document.createDocumentFragment();
      frag.appendChild(chip({ id: 'all', name: 'Everything' }));
      state.categories.forEach(function (c) { frag.appendChild(chip(c)); });
      wrap.appendChild(frag);
    });
  }

  function chip(c) {
    var b = h('button', 'chip');
    b.type = 'button';
    b.setAttribute('data-category', c.id);
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = '<span></span><span class="chip__count" aria-hidden="true"></span>';
    b.firstChild.textContent = c.name;
    b.addEventListener('click', function () {
      state.category = (state.category === c.id && c.id !== 'all') ? 'all' : c.id;
      state.shown = 60;
      render();
      closeDrawer();
    });
    return b;
  }

  function matches(p) {
    if (state.category !== 'all' && p.categoryIds.indexOf(state.category) === -1) return false;
    if (!state.q) return true;
    var hay = (p.name + ' ' + p.description + ' ' +
      p.variations.map(function (v) { return (v.name || '') + ' ' + (v.sku || ''); }).join(' ')).toLowerCase();
    return state.q.toLowerCase().split(/\s+/).every(function (t) { return hay.indexOf(t) > -1; });
  }

  var SORTS = {
    'name-asc': function (a, b) { return a.name.localeCompare(b.name, 'en'); },
    'price-asc': function (a, b) { return a.priceRange.min - b.priceRange.min; },
    'price-desc': function (a, b) { return b.priceRange.max - a.priceRange.max; }
  };

  /* --------------------------------------------------------------- cards */

  function stockLabel(product) {
    var sellable = product.variations.filter(function (v) { return v.sellable; });
    var known = sellable.filter(function (v) { return v.inventory.state === 'IN_STOCK'; });
    if (known.length) return { text: 'In stock', cls: 'in' };
    if (sellable.length) return { text: 'Availability unknown', cls: 'unknown' };
    return { text: 'Out of stock', cls: 'out' };
  }

  function priceLabel(p) {
    if (p.priceRange.min === p.priceRange.max) return money(p.priceRange.min, p.priceRange.currency);
    return money(p.priceRange.min, p.priceRange.currency) + ' – ' + money(p.priceRange.max, p.priceRange.currency);
  }

  function card(p) {
    var el = h('article', 'card card--buyable');
    el.setAttribute('data-product-id', p.id);

    var media = h('div', 'card__media');
    if (p.imageUrls.length) {
      var img = new Image();
      img.className = 'card__img';
      img.src = p.imageUrls[0];
      img.alt = p.name;
      img.loading = 'lazy';
      img.decoding = 'async';
      /* A photo Square has but cannot serve falls back to the honest
         placeholder rather than a broken image icon. */
      img.addEventListener('error', function () {
        img.remove();
        media.appendChild(placeholder());
      });
      media.appendChild(img);
    } else {
      media.appendChild(placeholder());
    }
    var stock = stockLabel(p);
    var badge = h('span', 'stock-pill stock-pill--' + stock.cls, stock.text);
    media.appendChild(badge);
    el.appendChild(media);

    var body = h('div', 'card__body');
    body.appendChild(h('h3', 'card__name', p.name));
    body.appendChild(h('p', 'card__price', priceLabel(p)));
    if (p.hasUnpriceableVariations) {
      body.appendChild(h('p', 'card__note', 'Some options are priced in store.'));
    }
    var open = h('button', 'btn btn--gold btn--sm card__cta', 'Choose Options');
    open.type = 'button';
    open.addEventListener('click', function () { openPicker(p); });
    body.appendChild(open);
    el.appendChild(body);

    el.addEventListener('click', function (e) {
      if (e.target.closest('button')) return;
      openPicker(p);
    });
    return el;
  }

  /* Said plainly: there is no photograph, rather than a stock image standing
     in for one. */
  function placeholder() {
    var box = h('div', 'card__placeholder');
    box.innerHTML = '<svg viewBox="0 0 690.8 823.4" aria-hidden="true" focusable="false">' +
      '<path fill="currentColor" d="M690.8 823.4L430.0 628.7L148.5 810.9L261.7 501.9L0.0 306.1L336.7 305.6L457.8 0.0L657.5 688.5Z"/></svg>';
    box.appendChild(h('span', null, 'No photo yet'));
    return box;
  }

  /* --------------------------------------------------------------- render */

  function render() {
    var list = state.products.filter(matches).sort(SORTS[state.sort] || SORTS['name-asc']);
    var page = list.slice(0, state.shown);

    grid.innerHTML = '';
    var frag = document.createDocumentFragment();
    page.forEach(function (p) { frag.appendChild(card(p)); });
    grid.appendChild(frag);

    if (els.more) {
      els.more.hidden = list.length <= state.shown;
      els.more.textContent = 'Show more products (' + (list.length - state.shown) + ' left)';
    }
    if (els.noResults) els.noResults.hidden = list.length > 0;
    if (els.count && state.loaded) {
      els.count.innerHTML = list.length
        ? 'Showing <b>' + page.length + '</b> of ' + list.length + ' products'
        : 'Nothing matches';
    }

    document.querySelectorAll('.chip').forEach(function (b) {
      var id = b.getAttribute('data-category');
      b.setAttribute('aria-pressed', id === state.category ? 'true' : 'false');
      var c = b.querySelector('.chip__count');
      if (c) {
        var n = state.products.filter(function (p) {
          return (id === 'all' || p.categoryIds.indexOf(id) > -1) &&
                 (!state.q || matches(Object.assign({}, p, { categoryIds: [id === 'all' ? '' : id] })) || matchesQueryOnly(p));
        }).length;
        c.textContent = n ? n : '';
      }
    });

    if (els.activeFilters) {
      els.activeFilters.innerHTML = '';
      if (state.category !== 'all') {
        var cat = state.categories.find(function (c) { return c.id === state.category; });
        els.activeFilters.appendChild(pill(cat ? cat.name : state.category, function () {
          state.category = 'all'; render();
        }));
      }
      if (state.q) {
        els.activeFilters.appendChild(pill('“' + state.q + '”', function () {
          state.q = ''; if (els.search) els.search.value = ''; render();
        }));
      }
    }
    var pristine = state.category === 'all' && !state.q;
    Array.prototype.forEach.call(els.clearButtons, function (b) { b.hidden = pristine; });
    if (els.filterBtn) els.filterBtn.classList.toggle('has-active', state.category !== 'all');
    if (els.searchClear) els.searchClear.classList.toggle('is-visible', !!state.q);
  }

  function matchesQueryOnly(p) {
    if (!state.q) return true;
    return (p.name + ' ' + p.description).toLowerCase().indexOf(state.q.toLowerCase()) > -1;
  }

  function pill(label, onRemove) {
    var el = h('span', 'pill');
    el.appendChild(h('span', null, label));
    var b = h('button');
    b.type = 'button';
    b.setAttribute('aria-label', 'Remove filter: ' + label);
    b.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>';
    b.addEventListener('click', onRemove);
    el.appendChild(b);
    return el;
  }

  /* --------------------------------------------------------- the picker */

  /* Looked up when it is needed, not at load time, so the two scripts can
     appear in either order. */
  function openPicker(product) { if (ASP.picker) ASP.picker.open(product); }

  /* -------------------------------------------------------------- wiring */

  if (els.search) {
    var t;
    els.search.addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () { state.q = els.search.value.trim(); state.shown = 60; render(); }, 180);
    });
  }
  if (els.searchClear) {
    els.searchClear.addEventListener('click', function () {
      state.q = ''; if (els.search) { els.search.value = ''; els.search.focus(); } render();
    });
  }
  if (els.sort) {
    els.sort.addEventListener('change', function () { state.sort = els.sort.value; render(); });
  }
  if (els.more) {
    els.more.addEventListener('click', function () { state.shown += 60; render(); });
  }
  Array.prototype.forEach.call(els.clearButtons, function (b) {
    b.addEventListener('click', function () {
      state.q = ''; state.category = 'all'; state.shown = 60;
      if (els.search) els.search.value = '';
      render(); closeDrawer();
    });
  });

  function closeDrawer() {
    if (!els.drawer || !els.drawer.classList.contains('is-open')) return;
    els.drawer.classList.remove('is-open');
    document.body.classList.remove('drawer-open');
    if (els.filterBtn) { els.filterBtn.setAttribute('aria-expanded', 'false'); els.filterBtn.focus(); }
  }
  if (els.filterBtn) {
    els.filterBtn.addEventListener('click', function () {
      els.drawer.classList.add('is-open');
      document.body.classList.add('drawer-open');
      els.filterBtn.setAttribute('aria-expanded', 'true');
      var first = els.drawer.querySelector('.chip');
      if (first) first.focus();
    });
  }
  document.querySelectorAll('[data-drawer-close]').forEach(function (b) {
    b.addEventListener('click', closeDrawer);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });

  ASP.shop = { reload: load, state: state };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
  else load();
})();
