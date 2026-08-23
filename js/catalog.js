/* ==========================================================================
   All Star Players — catalog engine
   Renders every product card on the site (home Featured + Shop) from the data
   in js/products.js, and drives the shop search / filter / sort controls.
   Plain script, no build step, no dependencies.
   ========================================================================== */
(function () {
  'use strict';

  var ASP = window.ASP || (window.ASP = {});
  var PRODUCTS = ASP.products || [];
  var CATEGORIES = ASP.categories || [];
  var SETTINGS = ASP.settings || { currencySymbol: '$' };

  /* the star from the All Star Players monogram, used as the empty-photo mark */
  var STAR_PATH = 'M690.8 823.4L430.0 628.7L148.5 810.9L261.7 501.9L0.0 306.1L336.7 305.6L457.8 0.0L657.5 688.5Z';

  /* ---------------------------------------------------------------- utils */
  function h(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function categoryName(slug) {
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].slug === slug) return CATEGORIES[i].name;
    }
    return '';
  }
  function money(v) {
    if (v == null || isNaN(v)) return '';
    var n = Number(v);
    return SETTINGS.currencySymbol + n.toLocaleString('en-US', {
      minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2
    });
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  ASP.money = money;

  /* --------------------------------------------------------------- images */
  function pictureFor(p, cls, alt) {
    var wrap;
    if (p.imageWebp) {
      wrap = h('picture');
      var src = document.createElement('source');
      src.type = 'image/webp';
      src.srcset = p.imageWebp;
      wrap.appendChild(src);
      wrap.appendChild(imgFor(p.image, cls, alt));
      return wrap;
    }
    return imgFor(p.image, cls, alt);
  }
  /* The card's media box is a fixed 4:5 aspect ratio in CSS, so these nominal
     dimensions only exist to stop any layout shift before the file arrives. */
  function imgFor(src, cls, alt) {
    var img = new Image(800, 1000);
    img.className = cls;
    img.src = src;
    img.alt = alt || '';
    img.loading = 'lazy';
    img.decoding = 'async';
    return img;
  }

  /* ----------------------------------------------------------------- card */
  /* Builds one product card. Every state the real catalog will need is
     supported here: hover image, badges, colours, sizes, sale price and the
     sold-out treatment. Quick view can be wired later by listening for a click
     on [data-product-id] — the card already carries the id. */
  ASP.createCard = function (p) {
    var isPreview = !!p.preview;
    var card = h('article', 'card' + (isPreview ? ' card--preview' : '') + (p.soldOut ? ' is-soldout' : ''));
    card.setAttribute('data-product-id', p.id || '');
    card.setAttribute('data-category', p.category || '');

    /* ---- media ---- */
    var media = h('div', 'card__media');

    var badges = h('div', 'card__badges');
    if (isPreview) badges.appendChild(h('span', 'badge badge--preview', 'Preview'));
    if (p.soldOut) badges.appendChild(h('span', 'badge badge--soldout', 'Sold Out'));
    if (p.newArrival && !p.soldOut) badges.appendChild(h('span', 'badge badge--new', 'New'));
    if (p.bestSeller) badges.appendChild(h('span', 'badge badge--best', 'Best Seller'));
    if (p.limited) badges.appendChild(h('span', 'badge badge--limited', 'Limited'));
    if (p.originalPrice && p.price && p.originalPrice > p.price) {
      badges.appendChild(h('span', 'badge badge--sale', 'Sale'));
    }
    if (badges.childNodes.length) media.appendChild(badges);

    if (p.image) {
      var hoverSrc = p.images && p.images.length ? p.images[0] : null;
      var main = pictureFor(p, 'card__img card__img--main' + (hoverSrc ? ' has-alt' : ''), p.alt || p.name || '');
      media.appendChild(main);
      if (hoverSrc) {
        var alt = imgFor(hoverSrc, 'card__img card__img--alt', '');
        alt.setAttribute('aria-hidden', 'true');
        media.appendChild(alt);
      }
    } else {
      media.appendChild(h('div', 'card__placeholder',
        '<svg viewBox="0 0 690.8 823.4" aria-hidden="true" focusable="false"><path fill="currentColor" d="' + STAR_PATH + '"/></svg>'));
    }
    if (p.soldOut) media.appendChild(h('div', 'card__soldout', '<span>Sold Out</span>'));
    card.appendChild(media);

    /* ---- body ---- */
    var body = h('div', 'card__body');

    var brandLine = isPreview ? categoryName(p.category) : p.brand;
    if (brandLine) body.appendChild(h('p', 'card__brand', esc(brandLine)));

    var name = h('h3', 'card__name');
    if (isPreview) {
      name.textContent = 'Product details coming soon';
    } else if (p.url) {
      name.innerHTML = '<a href="' + esc(p.url) + '">' + esc(p.name) + '</a>';
    } else {
      name.textContent = p.name || '';
    }
    body.appendChild(name);

    if (!isPreview && p.description) body.appendChild(h('p', 'card__note', esc(p.description)));

    if (!isPreview && p.colors && p.colors.length) {
      var colors = h('div', 'card__colors');
      colors.setAttribute('aria-label', 'Available colours: ' + p.colors.map(function (c) { return c.name; }).join(', '));
      p.colors.slice(0, 5).forEach(function (c) {
        var sw = h('span', 'card__swatch');
        sw.style.background = c.hex || '#333';
        sw.title = c.name || '';
        colors.appendChild(sw);
      });
      if (p.colors.length > 5) colors.appendChild(h('span', 'card__more', '+' + (p.colors.length - 5)));
      body.appendChild(colors);
    }

    /* Preview entries get no price row at all — nothing about them is a
       real listing, so nothing on the card should read like one. */
    var foot = h('div', 'card__foot');
    var price = h('p', 'card__price');
    if (isPreview) {
      price = null;
    } else if (p.price == null) {
      price.className = 'card__price card__price--tbd';
      price.textContent = 'Ask in store';
    } else if (p.originalPrice && p.originalPrice > p.price) {
      price.innerHTML = '<s>' + money(p.originalPrice) + '</s>' + money(p.price);
    } else {
      price.textContent = money(p.price);
    }
    if (price) foot.appendChild(price);

    if (!isPreview && p.sizes && p.sizes.length) {
      var sizes = h('div', 'card__sizes');
      p.sizes.slice(0, 4).forEach(function (s) { sizes.appendChild(h('span', 'card__size', esc(s))); });
      if (p.sizes.length > 4) sizes.appendChild(h('span', 'card__size', '+' + (p.sizes.length - 4)));
      foot.appendChild(sizes);
    }
    if (foot.childNodes.length) body.appendChild(foot);
    card.appendChild(body);
    return card;
  };

  /* --------------------------------------------------- filtering + sorting */
  function inCategory(p, slug) {
    if (!slug || slug === 'all') return true;
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].slug === slug && CATEGORIES[i].smart) {
        if (p[CATEGORIES[i].smart]) return true;
      }
    }
    return p.category === slug;
  }
  function matchesQuery(p, q) {
    if (!q) return true;
    var hay = [p.name, p.brand, p.description, categoryName(p.category),
      (p.sizes || []).join(' '), (p.colors || []).map(function (c) { return c.name; }).join(' ')]
      .join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).every(function (t) { return hay.indexOf(t) > -1; });
  }
  var SORTS = {
    featured: function (a, b) { return num(a.sortOrder) - num(b.sortOrder) || byName(a, b); },
    newest: function (a, b) {
      var d = (b.dateAdded || '').localeCompare(a.dateAdded || '');
      if (d) return d;
      return num(b.sortOrder) - num(a.sortOrder) || byName(a, b);
    },
    'price-asc': function (a, b) { return price(a, 1) - price(b, 1) || byName(a, b); },
    'price-desc': function (a, b) { return price(b, -1) - price(a, -1) || byName(a, b); },
    'name-asc': byName
  };
  function num(v) { return typeof v === 'number' ? v : 9999; }
  function price(p, dir) { return p.price == null ? dir * Infinity : p.price; }
  function byName(a, b) { return String(a.name || '').localeCompare(String(b.name || '')); }

  ASP.query = function (state) {
    var list = PRODUCTS.filter(function (p) {
      return inCategory(p, state.category) && matchesQuery(p, state.q);
    });
    return list.sort(SORTS[state.sort] || SORTS.featured);
  };

  /* ------------------------------------------------------- render helpers */
  function paint(grid, list) {
    grid.innerHTML = '';
    var frag = document.createDocumentFragment();
    list.forEach(function (p) { frag.appendChild(ASP.createCard(p)); });
    grid.appendChild(frag);
    spotlight(grid);
  }

  /* restrained gold pool of light that tracks the pointer across a card */
  function spotlight(scope) {
    if (!window.matchMedia || !window.matchMedia('(hover:hover) and (pointer:fine)').matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    scope.querySelectorAll('.card').forEach(function (card) {
      card.addEventListener('pointermove', function (e) {
        var r = card.getBoundingClientRect();
        card.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%');
        card.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100).toFixed(1) + '%');
      });
    });
  }

  ASP.hasRealProducts = function () {
    return PRODUCTS.some(function (p) { return !p.preview; });
  };

  /* ------------------------------------------------------- home: featured */
  function initFeatured() {
    var grid = document.querySelector('[data-featured-grid]');
    if (!grid) return;
    var limit = parseInt(grid.getAttribute('data-limit'), 10) || 4;
    var list = PRODUCTS.filter(function (p) { return p.featured; });
    if (!list.length) list = PRODUCTS.slice(0);
    list = list.sort(SORTS.featured).slice(0, limit);
    paint(grid, list);

    var note = document.querySelector('[data-featured-note]');
    if (note && ASP.hasRealProducts()) note.hidden = true;
  }

  /* ------------------------------------------------------------ shop page */
  function initShop() {
    var grid = document.querySelector('[data-shop-grid]');
    if (!grid) return;

    var form = document.querySelector('[data-controls]');
    var searchInput = document.getElementById('shop-search');
    var searchClear = document.querySelector('[data-search-clear]');
    var sortSelect = document.getElementById('shop-sort');
    var chipWraps = document.querySelectorAll('[data-chips]');
    var countEl = document.querySelector('[data-count]');
    var activeEl = document.querySelector('[data-active-filters]');
    var clearBtns = document.querySelectorAll('[data-clear-filters]');
    var noResults = document.querySelector('[data-no-results]');
    var previewFlag = document.querySelector('[data-preview-flag]');
    var catalogNote = document.querySelector('[data-catalog-note]');
    var filterBtn = document.querySelector('[data-filter-open]');

    var params = new URLSearchParams(window.location.search);
    var state = {
      q: (params.get('q') || '').trim(),
      category: params.get('category') || 'all',
      sort: params.get('sort') || 'featured'
    };
    if (!CATEGORIES.some(function (c) { return c.slug === state.category; })) {
      if (state.category !== 'all') state.category = 'all';
    }
    if (!SORTS[state.sort]) state.sort = 'featured';

    /* --- build the category chips (desktop bar + mobile drawer) --- */
    chipWraps.forEach(function (wrap) {
      var frag = document.createDocumentFragment();
      frag.appendChild(chip({ slug: 'all', name: 'All' }));
      CATEGORIES.forEach(function (c) { frag.appendChild(chip(c)); });
      wrap.appendChild(frag);
    });
    function chip(c) {
      var b = h('button', 'chip');
      b.type = 'button';
      b.setAttribute('data-category', c.slug);
      b.setAttribute('aria-pressed', 'false');
      b.innerHTML = '<span>' + esc(c.name) + '</span><span class="chip__count" aria-hidden="true"></span>';
      b.addEventListener('click', function () {
        state.category = (state.category === c.slug && c.slug !== 'all') ? 'all' : c.slug;
        render(true);
        closeDrawer();
      });
      return b;
    }

    /* --- controls --- */
    if (searchInput) {
      searchInput.value = state.q;
      var t;
      searchInput.addEventListener('input', function () {
        clearTimeout(t);
        t = setTimeout(function () { state.q = searchInput.value.trim(); render(true); }, 180);
      });
    }
    if (searchClear) {
      searchClear.addEventListener('click', function () {
        state.q = '';
        if (searchInput) { searchInput.value = ''; searchInput.focus(); }
        render(true);
      });
    }
    if (sortSelect) {
      sortSelect.value = state.sort;
      sortSelect.addEventListener('change', function () { state.sort = sortSelect.value; render(true); });
    }
    Array.prototype.forEach.call(clearBtns, function (btn) {
      btn.addEventListener('click', function () {
        state.q = ''; state.category = 'all'; state.sort = 'featured';
        if (searchInput) searchInput.value = '';
        if (sortSelect) sortSelect.value = 'featured';
        render(true);
        closeDrawer();
      });
    });
    if (form) form.addEventListener('submit', function (e) { e.preventDefault(); });

    /* --- mobile drawer --- */
    var drawer = document.querySelector('[data-drawer]');
    function openDrawer() {
      if (!drawer) return;
      drawer.classList.add('is-open');
      document.body.classList.add('drawer-open');
      if (filterBtn) filterBtn.setAttribute('aria-expanded', 'true');
      var first = drawer.querySelector('.chip');
      if (first) first.focus();
      document.addEventListener('keydown', onDrawerKey);
    }
    function closeDrawer() {
      if (!drawer || !drawer.classList.contains('is-open')) return;
      drawer.classList.remove('is-open');
      document.body.classList.remove('drawer-open');
      if (filterBtn) { filterBtn.setAttribute('aria-expanded', 'false'); filterBtn.focus(); }
      document.removeEventListener('keydown', onDrawerKey);
    }
    function onDrawerKey(e) {
      if (e.key === 'Escape') { closeDrawer(); return; }
      if (e.key !== 'Tab' || !drawer) return;
      var f = drawer.querySelectorAll('button, [href], select, input');
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    if (filterBtn) filterBtn.addEventListener('click', openDrawer);
    document.querySelectorAll('[data-drawer-close]').forEach(function (b) {
      b.addEventListener('click', closeDrawer);
    });

    /* --- render --- */
    function render(animate) {
      var list = ASP.query(state);

      if (animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        grid.classList.add('is-swapping');
        window.setTimeout(function () { commit(list); }, 170);
      } else {
        commit(list);
      }

      /* chips: pressed state + live counts */
      document.querySelectorAll('.chip').forEach(function (b) {
        var slug = b.getAttribute('data-category');
        var on = slug === state.category;
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        var c = b.querySelector('.chip__count');
        if (c) {
          var n = PRODUCTS.filter(function (p) { return inCategory(p, slug) && matchesQuery(p, state.q); }).length;
          c.textContent = n ? n : '';
        }
      });

      /* active filter pills */
      if (activeEl) {
        activeEl.innerHTML = '';
        if (state.category !== 'all') activeEl.appendChild(pill(categoryName(state.category), function () {
          state.category = 'all'; render(true);
        }));
        if (state.q) activeEl.appendChild(pill('“' + state.q + '”', function () {
          state.q = ''; if (searchInput) searchInput.value = ''; render(true);
        }));
      }
      var pristine = (state.category === 'all' && !state.q && state.sort === 'featured');
      Array.prototype.forEach.call(clearBtns, function (b) { b.hidden = pristine; });
      if (filterBtn) filterBtn.classList.toggle('has-active', state.category !== 'all');
      if (searchClear) searchClear.classList.toggle('is-visible', !!state.q);

      if (countEl) {
        var noun = ASP.hasRealProducts() ? 'products' : 'preview entries';
        countEl.innerHTML = list.length
          ? 'Showing <b>' + list.length + '</b> of ' + PRODUCTS.length + ' ' + noun
          : 'No matches';
      }
      if (noResults) noResults.hidden = list.length > 0;
      if (previewFlag) previewFlag.hidden = !list.some(function (p) { return p.preview; });

      syncUrl();
    }

    function commit(list) {
      paint(grid, list);
      grid.classList.remove('is-swapping');
    }

    function pill(label, onRemove) {
      var el = h('span', 'pill', '<span>' + esc(label) + '</span>');
      var b = h('button', null, '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>');
      b.type = 'button';
      b.setAttribute('aria-label', 'Remove filter: ' + label);
      b.addEventListener('click', onRemove);
      el.appendChild(b);
      return el;
    }

    function syncUrl() {
      if (!window.history || !window.history.replaceState) return;
      var url = new URL(window.location.href);
      var s = url.searchParams;
      state.category !== 'all' ? s.set('category', state.category) : s.delete('category');
      state.q ? s.set('q', state.q) : s.delete('q');
      state.sort !== 'featured' ? s.set('sort', state.sort) : s.delete('sort');
      window.history.replaceState(null, '', url.pathname + (s.toString() ? '?' + s.toString() : '') + url.hash);
    }

    if (catalogNote && ASP.hasRealProducts()) catalogNote.hidden = true;
    render(false);
  }

  /* ---------------------------------------------------------------- boot */
  function boot() { initFeatured(); initShop(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else { boot(); }
})();
