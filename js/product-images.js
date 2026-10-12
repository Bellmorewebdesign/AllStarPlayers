/* ==========================================================================
   All Star Players / product photography
   --------------------------------------------------------------------------
   Where a product's picture comes from, in order:

     1. the image on the variation the customer has chosen, if Square has one
     2. the image on the product in Square
     3. a photograph we sourced ourselves, listed in
        assets/products/manifest.json and keyed by the Square product id
     4. nothing — an honest "Photo unavailable" card

   The manifest is data, not code: a file name, where the photograph came
   from, and what licence it carries. Adding photographs is dropping files in
   and adding rows to it. No prices, no stock, no product names live there —
   those always come from the API.

   A sourced photograph must show the actual item. A generic picture of some
   other sneaker is worse than no picture, because it is a claim about what
   somebody is buying.
   ========================================================================== */
(function () {
  'use strict';

  var ASP = window.ASP || (window.ASP = {});
  var MANIFEST_URL = 'assets/products/manifest.json';

  var entries = {};
  var loaded = null;

  /* Fetched once per page load. A missing or broken manifest is not an
     error worth showing anybody: the shop just has fewer photographs. */
  function load() {
    if (loaded) return loaded;
    loaded = fetch(MANIFEST_URL, { cache: 'no-cache' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        var images = (data && data.images) || {};
        Object.keys(images).forEach(function (id) {
          var row = images[id];
          if (row && typeof row.file === 'string' && row.file) entries[id] = row;
        });
        return entries;
      })
      .catch(function () { return entries; });
    return loaded;
  }

  /* What to draw for this product, given which variation is selected.
     `credit` is set only for a photograph we sourced; Square's own images
     are the shop's own and need no line under them. */
  function forProduct(product, variation) {
    if (!product) return null;

    if (variation && variation.imageUrls && variation.imageUrls.length) {
      return { src: variation.imageUrls[0], alt: product.name, fromSquare: true, credit: null };
    }
    if (product.imageUrls && product.imageUrls.length) {
      return { src: product.imageUrls[0], alt: product.name, fromSquare: true, credit: null };
    }
    var row = entries[product.id];
    if (row) {
      return {
        src: row.file,
        alt: row.alt || product.name,
        fromSquare: false,
        credit: row.credit || null,
        license: row.license || null,
        source: row.source || null,
        sourceUrl: row.sourceUrl || null
      };
    }
    return null;
  }

  /* Does this product have a picture at all? Used for counting, and by the
     tests, without caring where it came from. */
  function has(product) { return !!forProduct(product); }

  ASP.images = { load: load, forProduct: forProduct, has: has, manifest: entries, url: MANIFEST_URL };
})();
