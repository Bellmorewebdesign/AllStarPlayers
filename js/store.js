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
    sort: 'name-asc', loaded: false, meta: null, shown: 60, loadedAt: 0
  };

  var els = {
    count: document.querySelector('[data-count]'),
    chipWraps: document.querySelectorAll('[data-chips]'),
    search: document.getElementById('shop-search'),
    searchClear: document.querySelector('[data-search-clear]'),
    sort: document.getElementById('shop-sort'),
    noResults: document.querySelector('[data-no-results]'),
    noResultsTitle: document.querySelector('[data-no-results-title]'),
    noResultsBody: document.querySelector('[data-no-results-body]'),
    status: document.querySelector('[data-catalog-status]'),
    more: document.querySelector('[data-load-more]'),
    activeFilters: document.querySelector('[data-active-filters]'),
    clearButtons: document.querySelectorAll('[data-clear-filters]'),
    filterBtn: document.querySelector('[data-filter-open]'),
    drawer: document.querySelector('[data-drawer]'),
    ordering: document.querySelector('[data-ordering-notice]')
  };

  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* --------------------------------------------- what the shop can do */

  /* Checkout is only as open as the API says it is. Both fulfillment methods
     are off in production today, so there is no way to complete an order
     online — and the page says that plainly rather than leading somebody
     through a form that cannot finish. The day pickup or shipping is
     switched on in AWS, /config starts saying so and this all turns itself
     back on with no change here. */
  function applyConfig(config) {
    var f = (config && config.fulfillment) || {};
    var open = !!((f.pickup && f.pickup.available) || (f.shipping && f.shipping.available));
    ASP.ordering = { open: open, phone: (config && config.storePhone) || null };

    if (!els.ordering) return;
    els.ordering.innerHTML = '';
    els.ordering.hidden = open;
    if (open) return;

    els.ordering.appendChild(h('b', null, 'Online ordering is not open yet'));
    els.ordering.appendChild(h('span', null,
      'Everything below is live from our store system — real prices, real sizes, ' +
      'real stock. You cannot check out online yet, so the cart here is a list ' +
      'you can bring in or read to us. Nothing is held until you buy it in store.'));
    if (ASP.ordering.phone) {
      var a = document.createElement('a');
      a.className = 'btn btn--ghost btn--sm';
      a.href = 'tel:' + ASP.ordering.phone.replace(/[^+\d]/g, '');
      a.textContent = 'Call the store';
      els.ordering.appendChild(a);
    }
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
  function clearStatus() {
    if (!els.status) return;
    els.status.hidden = true;
    /* Drop the state class too: a hidden element still carrying
       --warm or --error is a lie waiting to be read. */
    els.status.className = 'catalog-status';
    els.status.innerHTML = '';
  }

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

  /* The catalog is rebuilt in the background, not during a request. Right
     after a deploy — or if a rebuild is running for the very first time —
     there may be no snapshot yet, and the API says so with a 503 and a
     suggested wait. That is a "nearly ready", not a failure, so the page
     waits and tries again by itself. */
  var warmAttempts = 0;
  var warmTimer = null;

  function stopWarming() {
    if (warmTimer) { clearTimeout(warmTimer); warmTimer = null; }
  }

  function showWarming(err) {
    var wait = err.retryAfterSeconds || 15;
    warmAttempts++;
    grid.innerHTML = '';
    skeleton(8);
    if (els.count) els.count.textContent = '';

    var keepTrying = warmAttempts <= 10;
    setStatus('warm', 'Getting the shop ready',
      err.code === 'CATALOG_UNAVAILABLE'
        ? 'We are rebuilding the product list. This usually takes a minute or two.'
        : 'We are loading the latest products and stock from the store. This usually takes a minute or two.' +
          (keepTrying ? ' This page will refresh itself.' : ''),
      keepTrying ? null : load);

    if (keepTrying) {
      stopWarming();
      warmTimer = setTimeout(load, wait * 1000);
    }
  }

  /* Square's names carry whatever whitespace somebody typed into the point
     of sale. Trimming here keeps the cards and the A-to-Z sort tidy without
     pretending the catalog says something it does not. */
  function tidy(products) {
    products.forEach(function (p) {
      if (typeof p.name === 'string') p.name = p.name.trim();
      if (typeof p.description === 'string') p.description = p.description.trim();
    });
    return products;
  }

  function adopt(result) {
    state.products = tidy(result.products);
    state.meta = result.meta;
    state.loadedAt = Date.now();
    if (result.meta && result.meta.categories && result.meta.categories.length) {
      state.categories = result.meta.categories;
    }
  }

  function staleNote(meta) {
    setStatus('warn', 'Last updated ' + describeAge(meta.ageSeconds),
      ASP.ordering && ASP.ordering.open
        ? 'Prices and stock are checked again at checkout.'
        : 'The list is rebuilt from the store system every few minutes.',
      load);
  }

  function load() {
    stopWarming();
    clearStatus();
    skeleton(8);
    if (els.count) els.count.textContent = 'Loading the shop…';

    /* Asked for alongside the catalog rather than after it, so the page never
       shows a buyable-looking shop for a moment before admitting it is not.
       A failure here is not fatal: the catalog still draws, and the picker
       treats an unknown state as closed. */
    ASP.api.configOnce().then(applyConfig, function (err) {
      if (window.console) console.warn('[shop] could not read /config', err && err.message);
      ASP.ordering = { open: false, phone: null };
    });

    ASP.api.catalog(function (progress) {
      /* The product list was rebuilt while we were paging through it, so the
         client starts again from the first page. Clear what we drew rather
         than leaving half of the old catalog on screen beside the new one. */
      if (progress.restarted) {
        state.products = [];
        state.meta = null;
        state.loaded = false;
        skeleton(8);
        if (els.count) els.count.textContent = 'The shop was just updated. Loading it again…';
        return;
      }
      state.products = tidy(progress.products);
      state.meta = progress.meta;
      if (!state.loaded) {
        state.loaded = true;
        state.categories = progress.meta.categories;
        buildChips();
        applyDeepLink();
      }
      render();
      if (!progress.done && els.count) {
        els.count.textContent = 'Showing ' + state.products.length + ' of ' + progress.meta.total + ' products…';
      }
    }).then(function (result) {
      warmAttempts = 0;
      adopt(result);
      render();
      if (result.meta.stale) {
        /* Not an error. The product list is rebuilt on a schedule, so it can
           be a little behind. */
        staleNote(result.meta);
      }
    }).catch(function (err) {
      if (err.code === 'CATALOG_WARMING' || err.code === 'CATALOG_UNAVAILABLE') {
        showWarming(err);
        return;
      }
      stopWarming();
      grid.innerHTML = '';
      if (els.count) els.count.textContent = '';
      setStatus('error', 'The shop would not load', err.message, load);
    });
  }

  /* ------------------------------------------- coming back to the tab */

  /* The catalog is rebuilt on a schedule, so a tab left open for an hour is
     showing an hour-old shop. Coming back to it fetches the list again in
     the background: no skeleton, no scroll jump, and the filters, the search
     and the cart are left exactly as they were — the cart lives in
     localStorage and nothing here writes to it. */
  var REVISIT_AFTER_MS = 60000;
  var refreshing = false;

  function refreshQuietly() {
    if (refreshing || !state.loaded) return;
    if (Date.now() - state.loadedAt < REVISIT_AFTER_MS) return;
    /* Not while somebody is choosing a size: replacing the catalog under an
       open picker would move the ground beneath them. */
    if (document.querySelector('.pick:not([hidden])')) return;

    refreshing = true;
    var wasBuild = state.meta && state.meta.buildId;

    ASP.api.catalog(null).then(function (result) {
      refreshing = false;
      var changed = !wasBuild || (result.meta && result.meta.buildId !== wasBuild);
      adopt(result);
      /* Redraw either way — stock moves within a build's lifetime too — but
         only mention it when the shop really is a different list. */
      render();
      if (result.meta.stale) staleNote(result.meta);
      else if (changed) clearStatus();
    }).catch(function (err) {
      refreshing = false;
      /* Whatever is on screen was true a few minutes ago, which beats
         replacing a working shop with an error because a background refresh
         did not land. The next visit tries again. */
      if (window.console) console.warn('[shop] background refresh failed', err && err.message);
    });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refreshQuietly();
  });
  /* Coming back with the browser's Back button, where the page is restored
     from cache and visibilitychange never fires. */
  window.addEventListener('pageshow', function (e) { if (e.persisted) refreshQuietly(); });

  /* ------------------------------------------------------- deep links */

  var slug = function (text) {
    return String(text || '').toLowerCase().replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  };

  /* The home page tiles link to shop.html?category=hats. Categories come from
     Square and the shop renames them whenever it likes, so the link is
     matched against the live names rather than a list kept in here. A link
     that matches nothing becomes a search, which is a better answer than
     silently showing all 844 products. */
  function applyDeepLink() {
    var params;
    try { params = new URLSearchParams(window.location.search); } catch (e) { return; }
    var wanted = params.get('category');
    var query = params.get('q');

    if (wanted) {
      var match = state.categories.find(function (c) { return slug(c.name) === slug(wanted); });
      if (match) state.category = match.id;
      else if (!query) query = wanted.replace(/-/g, ' ');
    }
    if (query) {
      state.q = query;
      if (els.search) els.search.value = query;
    }
  }

  /* ------------------------------------------------------------- filters */

  function describeAge(seconds) {
    if (!seconds && seconds !== 0) return 'recently';
    if (seconds < 120) return 'a moment ago';
    if (seconds < 5400) return Math.round(seconds / 60) + ' minutes ago';
    var hours = Math.round(seconds / 3600);
    if (hours < 36) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    return Math.round(hours / 24) + ' days ago';
  }

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
        media.classList.add('card__media--empty');
        media.appendChild(placeholder());
      });
      media.appendChild(img);
    } else {
      media.classList.add('card__media--empty');
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
    if (els.noResults) {
      els.noResults.hidden = list.length > 0;
      /* An empty shop is not a failed search. Telling somebody to clear
         filters they never set, when there is genuinely nothing in stock,
         just sends them round in a circle. */
      var emptyShop = state.products.length === 0;
      if (els.noResultsTitle) {
        els.noResultsTitle.textContent = emptyShop
          ? 'Everything is sold out right now.'
          : 'Nothing matches that.';
      }
      if (els.noResultsBody) {
        els.noResultsBody.textContent = emptyShop
          ? 'New stock is added regularly — check back soon, or come see us in the shop.'
          : 'Try another category, or clear the filters to see the whole catalog.';
      }
    }
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
    Array.prototype.forEach.call(els.clearButtons, function (b) {
      b.hidden = pristine || state.products.length === 0;
    });
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
