/* ==========================================================================
   All Star Players / the catalog
   --------------------------------------------------------------------------
   Everything on the site that looks like a product comes from this one file.
   The row on the home page and the whole Shop page are both drawn from
   ASP.items by js/catalog.js, so nothing is ever typed twice.

   Right now ASP.items holds FLOOR PHOTOS, not listings. They are real
   photographs of the store with the category written on them, and they carry
   no product name, no price and no sizes, because none of that has been
   supplied yet. Every category link on the site lands on at least one of
   them, so nothing on the site is a dead end.

   ── ADDING A REAL PRODUCT ───────────────────────────────────────────────
   1. Put the photos in  assets/img/products/  (portrait, about 1000 x 1250).
   2. Copy this template into ASP.items and fill it in.
   3. Save and refresh. No build step, nothing to install.

   {
     id:            'asp-0001',                   // unique, never reused
     name:          'Product name',
     brand:         'Brand name',                 // sits above the name
     category:      't-shirts',                   // a slug from ASP.categories
     categories:    ['t-shirts','hats'],          // optional, if it fits more
                                                  // than one filter
     price:         120,                          // number. Leave it out and
                                                  // the card says "Ask in store"
     originalPrice: 160,                          // optional, draws a strike
     image:         'assets/img/products/x.jpg',
     imageWebp:     'assets/img/products/x.webp', // optional, served first
     images:        ['assets/img/products/x-2.jpg'],  // first one is the
                                                      // hover photo
     alt:           'What the photograph shows',
     description:   'A line or two.',
     featured:      true,        // puts it in the row on the home page
     bestSeller:    false,       // badge + the Best Sellers filter
     newArrival:    true,        // badge + the New Arrivals filter
     limited:       false,       // badge
     sizes:         ['S','M','L','XL'],
     colors:        [{name:'Black',hex:'#101010'},{name:'Bone',hex:'#F1EDE4'}],
     soldOut:       false,       // greys the photo, stamps SOLD OUT
     sortOrder:     10,          // low numbers come first under "Featured"
     url:           ''           // optional link. Empty means the card is not
                                 // clickable, which is right until there is
                                 // somewhere real to send people.
   }

   ── CLEARING THE FLOOR PHOTOS ───────────────────────────────────────────
   They all sit between the two markers near the bottom of this file and all
   carry `floor: true`. Delete that block in one go once the real catalog is
   in. The "these are photos, not listings" notices on the home and shop
   pages hide themselves as soon as one real product exists.
   ========================================================================== */

window.ASP = window.ASP || {};
var ASP = window.ASP;

ASP.settings = {
  currency: 'USD',
  currencySymbol: '$',
  instagram: 'allstarplayers'
};

/* The filters on the shop page and the tiles on the home page both read this
   list, in this order.

   Add a category by adding a line. Two kinds exist:
     plain   the product's `category` (or `categories`) has to match the slug
     smart   the product joins through a flag, so a tee can be a T-Shirt and a
             New Arrival at once

   New Arrivals and Best Sellers are written out below and commented off,
   because a floor photo cannot honestly claim to be either one. Put them back
   the day real products start carrying `newArrival` / `bestSeller`. */
ASP.categories = [
  /* { slug: 'new-arrivals', name: 'New Arrivals', smart: 'newArrival' }, */
  /* { slug: 'best-sellers', name: 'Best Sellers', smart: 'bestSeller' }, */
  { slug: 't-shirts',            name: 'T-Shirts' },
  { slug: 'hoodies-sweatshirts', name: 'Hoodies & Sweatshirts' },
  { slug: 'pants',               name: 'Pants' },
  { slug: 'shorts',              name: 'Shorts' },
  { slug: 'sneakers',            name: 'Sneakers' },
  { slug: 'hats',                name: 'Hats' },
  { slug: 'accessories',         name: 'Accessories' }
];

ASP.items = [

  /* ===== FLOOR PHOTOS. DELETE THIS BLOCK WHEN THE REAL CATALOG LANDS =====
     ===== Every photo below was taken in the store. Nothing here invents a
     ===== brand, a product name, a size or a price. ===================== */

  {
    id: 'floor-tees-flat', floor: true, category: 't-shirts',
    name: 'Horseshoe graphic tee, gold on black',
    image: 'assets/img/floor-tees-flat-592.jpg',
    imageWebp: 'assets/img/floor-tees-flat-592.webp',
    imageSmall: 'assets/img/floor-tees-flat-400.jpg',
    imageSmallWebp: 'assets/img/floor-tees-flat-400.webp',
    alt: 'A black tee laid out flat with a large gold horseshoe graphic across the front',
    featured: true, sortOrder: 10
  },
  {
    id: 'floor-caps-flat', floor: true, categories: ['hats', 't-shirts'],
    name: 'Trucker and snapback caps',
    image: 'assets/img/floor-caps-flat-800.jpg',
    imageWebp: 'assets/img/floor-caps-flat-800.webp',
    imageSmall: 'assets/img/floor-caps-flat-400.jpg',
    imageSmallWebp: 'assets/img/floor-caps-flat-400.webp',
    alt: 'Two caps on display heads above a pair of graphic tees laid out on the counter',
    featured: true, sortOrder: 20
  },
  {
    id: 'floor-acc-flat', floor: true, category: 'accessories',
    name: 'Wall clock, insulated bottle, stickers',
    image: 'assets/img/floor-acc-flat-880.jpg',
    imageWebp: 'assets/img/floor-acc-flat-880.webp',
    imageSmall: 'assets/img/floor-acc-flat-400.jpg',
    imageSmallWebp: 'assets/img/floor-acc-flat-400.webp',
    alt: 'A branded wall clock, a red insulated bottle and a stack of red stickers on a white surface',
    featured: true, sortOrder: 30
  },
  {
    id: 'floor-shorts-rack', floor: true, category: 'shorts',
    name: 'Shorts on the rack',
    image: 'assets/img/floor-shorts-rack-700.jpg',
    imageWebp: 'assets/img/floor-shorts-rack-700.webp',
    imageSmall: 'assets/img/floor-shorts-rack-400.jpg',
    imageSmallWebp: 'assets/img/floor-shorts-rack-400.webp',
    alt: 'Shorts hanging on a wooden rack: red side stripe, green leaf print, grey fleece and plain black',
    featured: true, sortOrder: 40
  },
  {
    id: 'floor-hats-wall', floor: true, category: 'hats',
    name: 'The hat wall',
    image: 'assets/img/floor-hats-wall-864.jpg',
    imageWebp: 'assets/img/floor-hats-wall-864.webp',
    imageSmall: 'assets/img/floor-hats-wall-400.jpg',
    imageSmallWebp: 'assets/img/floor-hats-wall-400.webp',
    alt: 'Rows of caps racked on the wall, mesh trucker backs and embroidered fronts',
    sortOrder: 50
  },
  {
    id: 'floor-tees-wall', floor: true, categories: ['t-shirts', 'sneakers'],
    name: 'Graphic tees on the wall',
    image: 'assets/img/floor-tees-wall-800.jpg',
    imageWebp: 'assets/img/floor-tees-wall-800.webp',
    imageSmall: 'assets/img/floor-tees-wall-400.jpg',
    imageSmallWebp: 'assets/img/floor-tees-wall-400.webp',
    alt: 'Two oversized graphic tees hanging on the shop wall above a shelf of sneakers',
    sortOrder: 60
  },
  {
    id: 'floor-tees-rail', floor: true, category: 't-shirts',
    name: 'Tee rail under the shelf lights',
    image: 'assets/img/floor-tees-rail-620.jpg',
    imageWebp: 'assets/img/floor-tees-rail-620.webp',
    imageSmall: 'assets/img/floor-tees-rail-400.jpg',
    imageSmallWebp: 'assets/img/floor-tees-rail-400.webp',
    alt: 'A lit rail of graphic tees and jerseys hanging under a shelf inside the store',
    sortOrder: 70
  },
  {
    id: 'floor-fleece-shelf', floor: true, category: 'hoodies-sweatshirts',
    name: 'Fleece folded on the shelves',
    image: 'assets/img/floor-fleece-shelf-700.jpg',
    imageWebp: 'assets/img/floor-fleece-shelf-700.webp',
    imageSmall: 'assets/img/floor-fleece-shelf-400.jpg',
    imageSmallWebp: 'assets/img/floor-fleece-shelf-400.webp',
    alt: 'Folded hoodies and sweatshirts stacked on the wooden shelves',
    sortOrder: 80
  },
  {
    id: 'floor-fleece-rack', floor: true, category: 'hoodies-sweatshirts',
    name: 'Crewnecks on the rack',
    image: 'assets/img/floor-fleece-rack-560.jpg',
    imageWebp: 'assets/img/floor-fleece-rack-560.webp',
    imageSmall: 'assets/img/floor-fleece-rack-400.jpg',
    imageSmallWebp: 'assets/img/floor-fleece-rack-400.webp',
    alt: 'A rack of grey, red and black crewnecks and long sleeves hanging under a shelf of folded stock',
    sortOrder: 85
  },
  {
    id: 'floor-pants-rack', floor: true, category: 'pants',
    name: 'Track pants and printed bottoms',
    image: 'assets/img/floor-pants-rack-620.jpg',
    imageWebp: 'assets/img/floor-pants-rack-620.webp',
    imageSmall: 'assets/img/floor-pants-rack-400.jpg',
    imageSmallWebp: 'assets/img/floor-pants-rack-400.webp',
    alt: 'Hanging bottoms: leopard print, red track pants with white side stripes and a leaf print pair',
    sortOrder: 90
  },
  {
    id: 'floor-pants-fold', floor: true, category: 'pants',
    name: 'Folded bottoms, back shelf',
    image: 'assets/img/floor-pants-fold-620.jpg',
    imageWebp: 'assets/img/floor-pants-fold-620.webp',
    imageSmall: 'assets/img/floor-pants-fold-400.jpg',
    imageSmallWebp: 'assets/img/floor-pants-fold-400.webp',
    alt: 'Folded track pants and sweatpants stacked on the back shelves',
    sortOrder: 100
  },
  {
    id: 'floor-shorts-star', floor: true, category: 'shorts',
    name: 'Star and P sweat shorts',
    image: 'assets/img/floor-shorts-star-560.jpg',
    imageWebp: 'assets/img/floor-shorts-star-560.webp',
    imageSmall: 'assets/img/floor-shorts-star-400.jpg',
    imageSmallWebp: 'assets/img/floor-shorts-star-400.webp',
    alt: 'Black fleece shorts on a hanger with the All Star Players star and P embroidered on the leg',
    sortOrder: 110
  },
  {
    id: 'floor-sneakers', floor: true, category: 'sneakers',
    name: 'Sneakers on the shelf',
    image: 'assets/img/floor-sneakers-560.jpg',
    imageWebp: 'assets/img/floor-sneakers-560.webp',
    imageSmall: 'assets/img/floor-sneakers-400.jpg',
    imageSmallWebp: 'assets/img/floor-sneakers-400.webp',
    alt: 'A white pair and a printed pair of sneakers displayed on a wooden shelf below hanging tees',
    sortOrder: 120
  },
  {
    id: 'floor-acc-detail', floor: true, category: 'accessories',
    name: 'Stickers, playing cards, small stuff',
    image: 'assets/img/floor-acc-detail-560.jpg',
    imageWebp: 'assets/img/floor-acc-detail-560.webp',
    imageSmall: 'assets/img/floor-acc-detail-400.jpg',
    imageSmallWebp: 'assets/img/floor-acc-detail-400.webp',
    alt: 'Red box-logo stickers, a slim pocket knife, a deck of playing cards and the edge of a wall clock',
    sortOrder: 130
  }

  /* ===== END OF FLOOR PHOTOS ===== */

  /* Real products go below here. Remember the comma after the entry above
     once you start adding them. */

];

/* Older copies of the site called this list ASP.products. Keep the old name
   pointing at the same array so nothing breaks if something still uses it. */
ASP.products = ASP.items;
