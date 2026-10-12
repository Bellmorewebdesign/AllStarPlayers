/* ==========================================================================
   All Star Players / the shop's category structure
   --------------------------------------------------------------------------
   Square has thirty-seven categories, and they are the store's own working
   labels: HAT and HATS are separate, so are TEE, T-SHIRTS and LS TSHIRT, and
   a fifth of the catalog has no category at all. Putting all of that on the
   shop page as a wall of buttons is a view of a database, not a shop.

   So the shop shows five choices, each opening its own short list. The
   grouping lives here, in one place, and nothing else in the site knows the
   Square names.

   Two rules this follows:

   - Square's category ids are what the grouping is keyed on, because a shop
     can rename a category any afternoon. The names are kept only as a
     fallback for a category that was deleted and made again under a new id.

   - Every product is reachable. Anything whose category is not in this map —
     a new Square category, or none at all — lands in "Care & Other ·
     Everything else" rather than disappearing from the shop.

   Counts are never written here. They are counted from whatever the API
   returned, every time the page draws.
   ========================================================================== */
(function () {
  'use strict';

  var ASP = window.ASP || (window.ASP = {});

  /* id: Square's category id. name: what it was called when this was
     written, used only if the id is gone. */
  function c(id, name) { return { id: id, name: name }; }

  var GROUPS = [
    {
      id: 'clothing',
      label: 'Clothing',
      subs: [
        { id: 'tees', label: 'Shirts & T-Shirts', cats: [
          c('B5XNOUHOUIUM7IHAOYQ6P3BQ', 'T-SHIRTS'), c('D2GY5W73G2HZYVSCDBHMK5TI', 'TEE'),
          c('GOF33RPANIDSXYF564EZJ7TU', 'LS TSHIRT'), c('B3VAT3U42RE7EB72UCCEFH3X', 'TANK TOP'),
          c('M6HUDLQ7SZ2YLX6YF4BZJNOR', 'SHIRTS'), c('JBSOLBYYJ25W72RSC6WTN6DF', 'POLO'),
          c('AO26AIA7PBVOTSRKL7VHGA7U', 'FLANNEL')
        ] },
        { id: 'fleece', label: 'Hoodies & Sweats', cats: [
          c('6G2JKGTGXFDKKQN4USXCAABN', 'HOODY'), c('KAVJ7RVEBB2GRD6GBW2N7M4V', 'SWEATER'),
          c('YLMMEPJC62HIGOHIX3LLCSQE', 'CREW'), c('GYJUBJWOSC6EVHCEZYAFNCWI', 'SWEATSUIT'),
          c('A2XPH47LTYMJ5S4OZSHLO6LS', 'THERMALS')
        ] },
        { id: 'bottoms', label: 'Jeans & Pants', cats: [
          c('3MZQE2FSG367777JKLCSUOYC', 'DENIM'), c('KEUOAQHK3Z3J5IZJLBBTAFMI', 'SWEAT PANTS'),
          c('ZQKXX2NDUKAF7CF2K2I7QOZJ', 'CARGO'), c('Z4AKPH5S6VNMLDM5Y5RZE7UD', 'PANTS')
        ] },
        { id: 'shorts', label: 'Shorts', cats: [
          c('J7RTJ4W25QOD45ODYVBTXXEV', 'SHORTS'), c('UWAQ3OT4WVQJVICAMF2AKFSP', 'DENIM SHORTS'),
          c('HS6SENXFSHWK4EKSHMA2LHKF', 'SWIMMING TRUNKS')
        ] },
        { id: 'outerwear', label: 'Jackets & Outerwear', cats: [
          c('IG5G2G7TSANTQO4UEWI4ME76', 'JACKETS'), c('4UODSKMNXU7VUYP2EKSX3J4Q', 'LEATHER JACKET'),
          c('Q27QJ5BOCYC5SZU34ZQFZPAQ', 'COAT'), c('ZU2LCMU52YNXEFVWVSEK5MVB', 'VEST')
        ] },
        { id: 'jerseys', label: 'Jerseys', cats: [
          c('S5HMERSCV5HOXFTS5UHSQSUD', 'JERSEY')
        ] },
        { id: 'base', label: 'Underwear & Socks', cats: [
          c('DD7HMART3CMQDYKH5VTDUDYS', 'BOXER'), c('4CXXLKZAYZULUVJYWJTZ5NMS', 'UNDERWEAR'),
          c('RUMFN3GQSHPGWJAP2BREXGVH', 'SOCKS')
        ] }
      ]
    },
    {
      id: 'footwear',
      label: 'Footwear',
      subs: [
        { id: 'sneakers', label: 'Sneakers', cats: [c('HO226OZLYGARO6PH44JB7XCH', 'SNEAKERS')] },
        { id: 'slides', label: 'Slides', cats: [c('JC3PRK2VW2266WMZHS2ZIA4D', 'SLIDES')] }
      ]
    },
    {
      id: 'accessories',
      label: 'Accessories',
      subs: [
        { id: 'hats', label: 'Hats & Caps', cats: [
          c('F6U5R3FUH6IV64YHAWNFXYRV', 'HATS'), c('WFUN76GWCX7ZJAW6CDHJKLZO', 'HAT'),
          c('2RAOO2KIZ3C3EISZX4BNOFWE', 'BUCKET')
        ] },
        { id: 'beanies', label: 'Beanies & Masks', cats: [
          c('EEZRFVWDLDRA4457CJ3NOICU', 'BEANIE'), c('RL6WXO7PU5MHSBBIIIPA2GWU', 'SKI MASK')
        ] },
        { id: 'bags', label: 'Bags', cats: [c('2JW7OOKWI2G3IPPIADPTZYJQ', 'BAG')] },
        { id: 'smallgoods', label: 'Everything Else', cats: [
          c('EKTUSNKQKIUYIKUZOBG6MYVM', 'ACCESSORIES')
        ] }
      ]
    },
    {
      id: 'other',
      label: 'Care & Other',
      subs: [
        { id: 'care', label: 'Cleaning & Care', cats: [c('EVKIWKOW5XKNJUEKNYFNDTJM', 'CLEANING SUPPLY')] },
        /* The catch-all. No cats: it takes whatever no other group claimed,
           which today is the part of the catalog Square has no category for. */
        { id: 'unsorted', label: 'Not Sorted Yet', cats: [], catchAll: true }
      ]
    }
  ];

  var norm = function (s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim(); };

  /* Works out, for the catalog actually in hand, which Square category ids
     belong to each subcategory and how many products are in each. Returns a
     fresh structure every time; nothing is cached, because the catalog can
     be replaced underneath us by a background refresh. */
  function build(categories, products) {
    var byId = {}, byName = {};
    (categories || []).forEach(function (cat) {
      byId[cat.id] = cat;
      byName[norm(cat.name)] = cat;
    });

    var claimed = {};
    var tree = GROUPS.map(function (g) {
      return {
        id: g.id, label: g.label,
        subs: g.subs.map(function (sub) {
          var ids = [];
          sub.cats.forEach(function (want) {
            /* The id is the truth. The name is only consulted when that id
               is no longer in the catalog, which is what happens if somebody
               deletes a category and makes it again. */
            var found = byId[want.id] || byName[norm(want.name)];
            if (found && ids.indexOf(found.id) === -1) { ids.push(found.id); claimed[found.id] = true; }
          });
          return { id: sub.id, label: sub.label, categoryIds: ids, catchAll: !!sub.catchAll, count: 0 };
        }),
        count: 0
      };
    });

    /* Counting, from the products the API sent and nothing else. */
    var lookup = {};
    tree.forEach(function (g) {
      g.subs.forEach(function (sub) {
        sub.categoryIds.forEach(function (id) { lookup[id] = { group: g, sub: sub }; });
      });
    });
    var spare = null;
    tree.forEach(function (g) {
      g.subs.forEach(function (sub) { if (sub.catchAll && !spare) spare = { group: g, sub: sub }; });
    });

    (products || []).forEach(function (p) {
      var ids = p.categoryIds || [];
      var seen = {};
      var placed = false;
      for (var i = 0; i < ids.length; i++) {
        var hit = lookup[ids[i]];
        if (!hit) continue;
        placed = true;
        if (!seen['s' + hit.sub.id]) { seen['s' + hit.sub.id] = true; hit.sub.count++; }
        if (!seen['g' + hit.group.id]) { seen['g' + hit.group.id] = true; hit.group.count++; }
      }
      /* Not in any group: a category this file has never heard of, or no
         category at all. It still has to be somewhere a shopper can find. */
      if (!placed && spare) { spare.sub.count++; spare.group.count++; p.__unsorted = true; }
    });

    return tree;
  }

  /* Does this product belong in that subcategory? The catch-all answers for
     everything no group claimed. */
  function matches(product, sub, tree) {
    if (!sub) return true;
    if (sub.catchAll) return !claimedBy(product, tree);
    var ids = product.categoryIds || [];
    for (var i = 0; i < ids.length; i++) {
      if (sub.categoryIds.indexOf(ids[i]) > -1) return true;
    }
    return false;
  }

  function claimedBy(product, tree) {
    var ids = product.categoryIds || [];
    for (var g = 0; g < tree.length; g++) {
      for (var s = 0; s < tree[g].subs.length; s++) {
        var sub = tree[g].subs[s];
        for (var i = 0; i < ids.length; i++) {
          if (sub.categoryIds.indexOf(ids[i]) > -1) return true;
        }
      }
    }
    return false;
  }

  function inGroup(product, group, tree) {
    for (var i = 0; i < group.subs.length; i++) {
      if (matches(product, group.subs[i], tree)) return true;
    }
    return false;
  }

  /* For shop.html?category=hats and the tiles on the home page. Matches a
     slug against a group id, a subcategory id, or a Square category name. */
  function findBySlug(tree, categories, slug) {
    var want = norm(String(slug || '').replace(/-/g, ' '));
    if (!want) return null;
    var hit = null;
    tree.forEach(function (g) {
      if (!hit && norm(g.id) === want) hit = { group: g, sub: null };
      g.subs.forEach(function (sub) {
        if (!hit && (norm(sub.id) === want || norm(sub.label) === want)) hit = { group: g, sub: sub };
      });
    });
    if (hit) return hit;

    var cat = (categories || []).find(function (x) { return norm(x.name) === want; });
    if (!cat) return null;
    tree.forEach(function (g) {
      g.subs.forEach(function (sub) {
        if (!hit && sub.categoryIds.indexOf(cat.id) > -1) hit = { group: g, sub: sub };
      });
    });
    return hit;
  }

  ASP.groups = { build: build, matches: matches, inGroup: inGroup, findBySlug: findBySlug, definition: GROUPS };
})();
