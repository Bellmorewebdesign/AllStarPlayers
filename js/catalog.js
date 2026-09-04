/* ==========================================================================
   All Star Players / catalog engine
   Draws every card on the site from js/products.js, and runs the search,
   filters and sorting on the shop page. Plain script, no dependencies.
   ========================================================================== */
(function () {
  'use strict';

  var ASP = window.ASP || (window.ASP = {});
  var ITEMS = ASP.items || ASP.products || [];
  var CATEGORIES = ASP.categories || [];
  var SETTINGS = ASP.settings || { currencySymbol: '$' };

  /* the star from the monogram, used where a photo is missing */
  var STAR = 'M690.8 823.4L430.0 628.7L148.5 810.9L261.7 501.9L0.0 306.1L336.7 305.6L457.8 0.0L657.5 688.5Z';

  /* how wide a card photo actually renders, so the browser can pick a file */
  var CARD_SIZES = '(max-width: 400px) 92vw, (max-width: 700px) 46vw, (max-width: 1080px) 30vw, 310px';

  /* ---------------------------------------------------------------- utils */
  function h(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function categoryName(slug) {
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].slug === slug) return CATEGORIES[i].name;
    }
    return '';
  }
  /* every category slug an item belongs to */
  function slugsOf(p) {
    if (p.categories && p.categories.length) return p.categories;
    return p.category ? [p.category] : [];
  }
  function money(v) {
    if (v == null || isNaN(v)) return '';
    var n = Number(v);
    return SETTINGS.currencySymbol + n.toLocaleString('en-US', {
      minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2
    });
  }
  ASP.money = money;

  ASP.hasRealProducts = function () {
    return ITEMS.some(function (p) { return !p.floor && !p.preview; });
  };

  /* --------------------------------------------------------------- images */
  /* Two widths per photo where a small crop exists, so phones do not pull
     down the big file. The card box is a fixed 4:5 in CSS and the photo is
     object-fit: cover, so nothing shifts while it loads. */
  function srcsetFor(p, key, keySmall) {
    var big = p[key], small = p[keySmall];
    if (!big) return null;
    if (!small) return { src: big, srcset: '' };
    var bw = widthFromName(big), sw = widthFromName(small);
    if (!bw || !sw || bw === sw) return { src: big, srcset: '' };
    return { src: big, srcset: small + ' ' + sw + 'w, ' + big + ' ' + bw + 'w' };
  }
  function widthFromName(path) {
    var m = /-(\d+)\.(jpg|jpeg|png|webp)$/i.exec(path || '');
    return m ? parseInt(m[1], 10) : 0;
  }

  function pictureFor(p, cls, alt) {
    var jpg = srcsetFor(p, 'image', 'imageSmall');
    if (!jpg) return null;
    var webp = srcsetFor(p, 'imageWebp', 'imageSmallWebp');

    var img = new Image();
    img.className = cls;
    img.src = jpg.src;
    if (jpg.srcset) { img.srcset = jpg.srcset; img.sizes = CARD_SIZES; }
    img.alt = alt || '';
    img.loading = 'lazy';
    img.decoding = 'async';

    if (!webp) return img;

    var pic = h('picture');
    var source = document.createElement('source');
    source.type = 'image/webp';
    source.srcset = webp.srcset || webp.src;
    if (webp.srcset) source.sizes = CARD_SIZES;
    pic.appendChild(source);
    pic.appendChild(img);
    return pic;
  }

  /* ----------------------------------------------------------------- card */
  /* One card. Floor photos and real products share the layout: a floor photo
     simply has no price, no sizes and no link, because it is a photograph of
     the shop rather than a listing. */
  ASP.createCard = function (p) {
    var isFloor = !!(p.floor || p.preview);
    var card = h('article', 'card' + (isFloor ? ' card--floor' : '') + (p.soldOut ? ' is-soldout' : ''));
    card.setAttribute('data-item-id', p.id || '');

    /* ---- photo ---- */
    var media = h('div', 'card__media');

    var badges = h('div', 'card__badges');
    if (p.soldOut) badges.appendChild(h('span', 'badge badge--soldout', 'Sold Out'));
    if (p.newArrival && !p.soldOut) badges.appendChild(h('span', 'badge badge--new', 'New'));
    if (p.bestSeller) badges.appendChild(h('span', 'badge badge--best', 'Best Seller'));
    if (p.limited) badges.appendChild(h('span', 'badge badge--limited', 'Limited'));
    if (p.originalPrice && p.price && p.originalPrice > p.price) {
      badges.appendChild(h('span', 'badge badge--sale', 'Sale'));
    }
    if (badges.childNodes.length) media.appendChild(badges);

    var shot = pictureFor(p, 'card__img card__img--main', p.alt || p.name || '');
    if (shot) {
      var hover = p.images && p.images.length ? p.images[0] : null;
      if (hover) {
        var mainImg = shot.tagName === 'PICTURE' ? shot.querySelector('img') : shot;
        mainImg.className += ' has-alt';
      }
      media.appendChild(shot);
      if (hover) {
        var alt = new Image();
        alt.className = 'card__img card__img--alt';
        alt.src = hover;
        alt.alt = '';
        alt.loading = 'lazy';
        alt.decoding = 'async';
        alt.setAttribute('aria-hidden', 'true');
        media.appendChild(alt);
      }
    } else {
      media.appendChild(h('div', 'card__placeholder',
        '<svg viewBox="0 0 690.8 823.4" aria-hidden="true" focusable="false"><path fill="currentColor" d="' + STAR + '"/></svg>'));
    }
    if (p.soldOut) media.appendChild(h('div', 'card__soldout', '<span>Sold Out</span>'));
    card.appendChild(media);

    /* ---- words ---- */
    var body = h('div', 'card__body');

    /* A floor photo can honestly sit in more than one rack, so name them all
       rather than picking one and looking wrong under the other filter. */
    var top = isFloor
      ? slugsOf(p).map(categoryName).filter(Boolean).join(' · ')
      : p.brand;
    if (top) body.appendChild(h('p', 'card__brand', esc(top)));

    var name = h('h3', 'card__name');
    if (!isFloor && p.url) {
      name.innerHTML = '<a href="' + esc(p.url) + '">' + esc(p.name) + '</a>';
    } else {
      name.textContent = p.name || '';
    }
    body.appendChild(name);

    if (p.description) body.appendChild(h('p', 'card__note', esc(p.description)));

    if (p.colors && p.colors.length) {
      var colors = h('div', 'card__colors');
      colors.setAttribute('aria-label', 'Colors: ' + p.colors.map(function (c) { return c.name; }).join(', '));
      p.colors.slice(0, 5).forEach(function (c) {
        var sw = h('span', 'card__swatch');
        sw.style.background = c.hex || '#333';
        sw.title = c.name || '';
        colors.appendChild(sw);
      });
      if (p.colors.length > 5) colors.appendChild(h('span', 'card__more', '+' + (p.colors.length - 5)));
      body.appendChild(colors);
    }

    var foot = h('div', 'card__foot');
    if (isFloor) {
      foot.appendChild(h('p', 'card__tag', 'In store'));
    } else if (p.price == null) {
      foot.appendChild(h('p', 'card__price card__price--tbd', 'Ask in store'));
    } else if (p.originalPrice && p.originalPrice > p.price) {
      foot.appendChild(h('p', 'card__price', '<s>' + money(p.originalPrice) + '</s>' + money(p.price)));
    } else {
      foot.appendChild(h('p', 'card__price', money(p.price)));
    }

    if (p.sizes && p.sizes.length) {
      var sizes = h('div', 'card__sizes');
      p.sizes.slice(0, 4).forEach(function (s) { sizes.appendChild(h('span', 'card__size', esc(s))); });
      if (p.sizes.length > 4) sizes.appendChild(h('span', 'card__size', '+' + (p.sizes.length - 4)));
      foot.appendChild(sizes);
    }
    body.appendChild(foot);
    card.appendChild(body);
    return card;
  };

  /* --------------------------------------------------- filtering, sorting */
  function inCategory(p, slug) {
    if (!slug || slug === 'all') return true;
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].slug === slug && CATEGORIES[i].smart) return !!p[CATEGORIES[i].smart];
    }
    return slugsOf(p).indexOf(slug) > -1;
  }
  function matchesQuery(p, q) {
    if (!q) return true;
    var hay = [p.name, p.brand, p.description, p.alt,
      slugsOf(p).map(categoryName).join(' '),
      (p.sizes || []).join(' '),
      (p.colors || []).map(function (c) { return c.name; }).join(' ')]
      .join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).every(function (t) { return hay.indexOf(t) > -1; });
  }

  function num(v) { return typeof v === 'number' ? v : 9999; }
  function byName(a, b) { return String(a.name || '').localeCompare(String(b.name || '')); }
  function priceOf(p, dir) { return p.price == null ? dir * Infinity : p.price; }

  var SORTS = {
    featured: function (a, b) { return num(a.sortOrder) - num(b.sortOrder) || byName(a, b); },
    newest: function (a, b) {
      var d = (b.dateAdded || '').localeCompare(a.dateAdded || '');
      return d || num(b.sortOrder) - num(a.sortOrder) || byName(a, b);
    },
    'price-asc': function (a, b) { return priceOf(a, 1) - priceOf(b, 1) || byName(a, b); },
    'price-desc': function (a, b) { return priceOf(b, -1) - priceOf(a, -1) || byName(a, b); },
    'name-asc': byName
  };

  ASP.query = function (state) {
    return ITEMS.filter(function (p) {
      return inCategory(p, state.category) && matchesQuery(p, state.q);
    }).sort(SORTS[state.sort] || SORTS.featured);
  };

  /* ------------------------------------------------------- render helpers */
  function paint(grid, list) {
    grid.innerHTML = '';
    var frag = document.createDocumentFragment();
    list.forEach(function (p) { frag.appendChild(ASP.createCard(p)); });
    grid.appendChild(frag);
    spotlight(grid);
  }

  /* a small pool of gold light that follows the pointer across a card */
  function spotlight(scope) {
    if (!window.matchMedia) return;
    if (!window.matchMedia('(hover:hover) and (pointer:fine)').matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    scope.querySelectorAll('.card').forEach(function (card) {
      card.addEventListener('pointermove', function (e) {
        var r = card.getBoundingClientRect();
        card.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%');
        card.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100).toFixed(1) + '%');
      });
    });
  }

  /* --------------------------------------------------- home: the row of 4 */
  function initFeatured() {
    var grid = document.querySelector('[data-featured-grid]');
    if (!grid) return;
    var limit = parseInt(grid.getAttribute('data-limit'), 10) || 4;
    var list = ITEMS.filter(function (p) { return p.featured; });
    if (!list.length) list = ITEMS.slice(0);
    paint(grid, list.sort(SORTS.featured).slice(0, limit));

    var note = document.querySelector('[data-floor-note]');
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
    var floorFlag = document.querySelector('[data-floor-note]');
    var filterBtn = document.querySelector('[data-filter-open]');

    /* Drop the sort options that cannot do anything yet. A control that looks
       live but changes nothing is worse than no control. */
    if (sortSelect) {
      var hasPrices = ITEMS.some(function (p) { return typeof p.price === 'number'; });
      var hasDates = ITEMS.some(function (p) { return !!p.dateAdded; });
      Array.prototype.slice.call(sortSelect.options).forEach(function (o) {
        var priceSort = o.value.indexOf('price') === 0;
        if ((priceSort && !hasPrices) || (o.value === 'newest' && !hasDates)) o.remove();
      });
    }

    var params = new URLSearchParams(window.location.search);
    var state = {
      q: (params.get('q') || '').trim(),
      category: params.get('category') || 'all',
      sort: params.get('sort') || 'featured'
    };
    if (!CATEGORIES.some(function (c) { return c.slug === state.category; })) state.category = 'all';
    if (!SORTS[state.sort] || (sortSelect && !sortSelect.querySelector('[value="' + state.sort + '"]'))) {
      state.sort = 'featured';
    }

    /* --- category chips, on the bar and inside the phone drawer --- */
    chipWraps.forEach(function (wrap) {
      var frag = document.createDocumentFragment();
      frag.appendChild(chip({ slug: 'all', name: 'Everything' }));
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

    /* --- the filter drawer on phones --- */
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

    /* --- draw --- */
    function render(animate) {
      var list = ASP.query(state);

      if (animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        grid.classList.add('is-swapping');
        window.setTimeout(function () { commit(list); }, 170);
      } else {
        commit(list);
      }

      document.querySelectorAll('.chip').forEach(function (b) {
        var slug = b.getAttribute('data-category');
        b.setAttribute('aria-pressed', slug === state.category ? 'true' : 'false');
        var c = b.querySelector('.chip__count');
        if (c) {
          var n = ITEMS.filter(function (p) { return inCategory(p, slug) && matchesQuery(p, state.q); }).length;
          c.textContent = n ? n : '';
        }
      });

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
        var noun = ASP.hasRealProducts() ? 'products' : 'photos';
        countEl.innerHTML = list.length
          ? 'Showing <b>' + list.length + '</b> of ' + ITEMS.length + ' ' + noun
          : 'Nothing matches';
      }
      if (noResults) noResults.hidden = list.length > 0;
      if (floorFlag) floorFlag.hidden = !list.some(function (p) { return p.floor || p.preview; });

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

    render(false);
  }

  /* ---------------------------------------------------------------- boot */
  function boot() { initFeatured(); initShop(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else { boot(); }
})();
