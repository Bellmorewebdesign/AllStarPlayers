/* ==========================================================================
   All Star Players — PRODUCT CATALOG (single source of truth)
   --------------------------------------------------------------------------
   Everything on the site that looks like a product — the Featured row on the
   home page and the whole Shop page — is rendered from the ASP.products array
   below by js/catalog.js. Nothing is hard-coded into the HTML, so a product
   only ever has to be added in one place: this file.

   ── HOW TO ADD A PRODUCT ────────────────────────────────────────────────
   1. Drop the photographs into  assets/img/products/
      (roughly 4:5 / portrait crops look best — e.g. 1000 x 1250).
   2. Copy the template below, paste it into ASP.products, fill it in.
   3. Save. That's it — no build step, no install, nothing to compile.

   {
     id:            'asp-0001',                  // unique, never reused
     name:          'Product name',              // required
     brand:         'Brand name',                // shown above the name
     category:      't-shirts',                  // one slug from ASP.categories
     price:         120,                         // number, USD. null = not shown
     originalPrice: 160,                         // optional — draws a strike-through
     image:         'assets/img/products/x.jpg', // main photograph
     images:        ['assets/img/products/x-2.jpg'], // extra shots; the first one
                                                 // becomes the hover image
     alt:           'Short description of the photograph',   // accessibility
     description:   'One or two lines of copy.',
     featured:      true,      // shows in the Featured row on the home page
     bestSeller:    false,     // adds the BEST SELLER badge + Best Sellers filter
     newArrival:    true,      // adds the NEW badge + New Arrivals filter
     limited:       false,     // adds the LIMITED badge
     sizes:         ['S','M','L','XL'],
     colors:        [{name:'Black',hex:'#101010'},{name:'Bone',hex:'#F1EDE4'}],
     inStock:       true,
     soldOut:       false,     // greys the photo + shows the SOLD OUT overlay
     sortOrder:     10,        // lower numbers come first in "Featured"
     url:           ''         // optional link (e.g. an Instagram post). Leave
                               // empty and the card simply isn't clickable —
                               // never point it at a checkout that isn't live.
   }

   ── REMOVING THE PLACEHOLDERS ───────────────────────────────────────────
   The entries currently in ASP.products are TEMPORARY PREVIEW ENTRIES. They
   exist only so the layout, filters and sorting can be seen working before the
   real catalog arrives. They carry `preview: true`, they invent no brand, no
   product name and no price, and they are all kept together between the two
   markers below. Delete everything between the markers in one step, add the
   real products, and every "preview" notice on the site disappears by itself.
   ========================================================================== */

window.ASP = window.ASP || {};
var ASP = window.ASP;

/* Store-wide catalog settings. */
ASP.settings = {
  currency: 'USD',
  currencySymbol: '$',
  instagram: 'allstarplayers'
};

/* The categories used by the shop filters and the home-page tiles.
   `new-arrivals` and `best-sellers` are smart categories: a product joins them
   through its `newArrival` / `bestSeller` flag, so a t-shirt can be both a
   T-Shirt and a New Arrival. */
ASP.categories = [
  { slug: 'new-arrivals',        name: 'New Arrivals',          smart: 'newArrival' },
  { slug: 'best-sellers',        name: 'Best Sellers',          smart: 'bestSeller' },
  { slug: 't-shirts',            name: 'T-Shirts' },
  { slug: 'hoodies-sweatshirts', name: 'Hoodies & Sweatshirts' },
  { slug: 'jackets',             name: 'Jackets' },
  { slug: 'pants',               name: 'Pants' },
  { slug: 'shorts',              name: 'Shorts' },
  { slug: 'sneakers',            name: 'Sneakers' },
  { slug: 'hats',                name: 'Hats' },
  { slug: 'accessories',         name: 'Accessories' }
];

ASP.products = [

  /* ===== TEMPORARY PREVIEW ENTRIES — DELETE THIS BLOCK WHEN THE REAL
     ===== CATALOG IS ADDED. Photographs are in-store crops of IMG_0596,
     ===== not product shots, and no name, brand or price is invented. */

  {
    id: 'preview-tees',
    preview: true,
    category: 't-shirts',
    image: 'assets/img/cat-tees-780.jpg',
    imageWebp: 'assets/img/cat-tees-780.webp',
    alt: 'Graphic t-shirts hanging on the wall inside the All Star Players store',
    featured: true,
    sortOrder: 10
  },
  {
    id: 'preview-hoodies',
    preview: true,
    category: 'hoodies-sweatshirts',
    image: 'assets/img/cat-stacks-840.jpg',
    imageWebp: 'assets/img/cat-stacks-840.webp',
    alt: 'Folded sweatshirts and fleece stacked on the shop shelves',
    featured: true,
    sortOrder: 20
  },
  {
    id: 'preview-sneakers',
    preview: true,
    category: 'sneakers',
    image: 'assets/img/prev-sneakers-420.jpg',
    imageWebp: 'assets/img/prev-sneakers-420.webp',
    alt: 'Sneakers displayed on a wooden shelf inside the store',
    featured: true,
    sortOrder: 30
  },
  {
    id: 'preview-new',
    preview: true,
    category: 'new-arrivals',
    newArrival: true,
    image: 'assets/img/cat-rack-430.jpg',
    imageWebp: 'assets/img/cat-rack-430.webp',
    alt: 'A rack of tees and jackets on the shop floor',
    featured: true,
    sortOrder: 40
  },
  { id: 'preview-hats',        preview: true, category: 'hats',        sortOrder: 50 },
  { id: 'preview-accessories', preview: true, category: 'accessories', sortOrder: 60 }

  /* ===== END OF TEMPORARY PREVIEW ENTRIES ===== */

  /* Real products go here — see the template at the top of this file.
     Remember the comma after the entry above once you start adding them. */

];
