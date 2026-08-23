# All Star Players

The website for **All Star Players** — a streetwear boutique at 96-03 37th Ave, Queens, NY 11368,
open since 2002.

Two static pages, no build step, no dependencies:

| Page | File | What it is |
| --- | --- | --- |
| Home | `index.html` | Hero, featured products, categories, story, authenticity, visit us |
| Shop | `shop.html` | The full catalog with search, category filters and sorting |

---

## Adding products — the only file you need

**Everything that looks like a product on this site comes from [`js/products.js`](js/products.js).**
The Featured row on the home page and the entire Shop page both read from that one array, so a
product is only ever entered once.

### 1. Add the photographs

Drop them in `assets/img/products/`. Portrait crops around **1000 × 1250** (4:5) look best — the
cards are built for that shape and will crop anything else to fit.

### 2. Add the entry

Open `js/products.js` and copy the template at the top of the file into the `ASP.products` array:

```js
{
  id:            'asp-0001',                       // unique, never reused
  name:          'Product name',
  brand:         'Brand name',
  category:      't-shirts',                       // a slug from ASP.categories
  price:         120,
  originalPrice: 160,                              // optional — draws a strike-through
  image:         'assets/img/products/x.jpg',
  images:        ['assets/img/products/x-2.jpg'],  // first extra shot = hover image
  alt:           'Short description of the photograph',
  description:   'One or two lines of copy.',
  featured:      true,        // shows in the Featured row on the home page
  bestSeller:    false,       // BEST SELLER badge + Best Sellers filter
  newArrival:    true,        // NEW badge + New Arrivals filter
  limited:       false,       // LIMITED badge
  sizes:         ['S','M','L','XL'],
  colors:        [{ name:'Black', hex:'#101010' }, { name:'Bone', hex:'#F1EDE4' }],
  inStock:       true,
  soldOut:       false,       // greys the photo and shows the SOLD OUT overlay
  sortOrder:     10,          // lower numbers come first under "Featured"
  url:           ''           // optional link. Leave empty and the card isn't clickable.
}
```

Save the file and refresh. There is nothing to install or compile, and nothing to do beyond
committing the change.

### 3. Remove the placeholders

The site ships with six **placeholder entries** so you can see the layout, filters and sorting
working before the real catalog lands. They invent nothing: no brand, no product name, no price.
The photography is cropped from the supplied shop interior photo. All six sit together between
two markers in `js/products.js`:

```
/* ===== TEMPORARY PREVIEW ENTRIES — DELETE THIS BLOCK … */
…
/* ===== END OF TEMPORARY PREVIEW ENTRIES ===== */
```

Delete everything between those markers in one step. Every placeholder notice on the site goes
with them: the PREVIEW badges, the *Placeholder* note under the home page Featured row, the
*Placeholders* bar on the shop page and the *"The online collection is being loaded"* panel. They
all hide themselves the moment one real product exists.

### Categories

Edit `ASP.categories` in the same file to rename or reorder the filters. `new-arrivals` and
`best-sellers` are smart categories: a product joins them through its `newArrival` / `bestSeller`
flag, so a t-shirt can be a T-Shirt *and* a New Arrival at the same time.

Category links use a query string and work from anywhere:
`shop.html?category=t-shirts`, `shop.html?category=sneakers`, `shop.html?q=hoodie&sort=price-asc`.

---

## Publishing on GitHub Pages

Repository → **Settings → Pages**

| Setting | Value |
| --- | --- |
| Source | **Deploy from a branch** |
| Branch | **`main`** |
| Folder | **`/ (root)`** |

Save, wait about a minute, and the site is live at
`https://<user-or-org>.github.io/<repository>/`.

Nothing else is required: no workflow, no build command, no `.nojekyll`, no framework. Every path
in the site is relative, so it works identically at a domain root or inside a project
subdirectory.

---

## What's where

```
index.html              Home
shop.html               Shop
css/
  base.css              Design tokens, typography, header, footer, buttons, motion
  catalog.css           Product cards, badges, grid, preview + empty states
  home.css              Home-page sections
  shop.css              Shop header, filters, sort, mobile filter drawer
js/
  products.js           ← the catalog. Add products here.
  catalog.js            Renders the cards; runs search, filters and sorting
  main.js               Sticky header, mobile menu, scroll reveals, hero animation
assets/
  brand/                Vector logo, favicons, web manifest, social share image
  fonts/                Self-hosted Boldonse + Instrument Sans (SIL OFL, licences included)
  img/                  Optimised WebP + JPEG crops used across the site
  img/originals/        The three original photographs, untouched
```

### The logo

`assets/brand/asp-mark.svg` is a clean vector of the star-and-P monogram, traced from the gold
foil business card in `assets/img/originals/IMG_0592.jpeg`. It is the same artwork used in the
header, the footer, the favicons and the star-shaped image reveals. It inherits `currentColor`,
so it can be dropped anywhere and coloured with CSS.

### The photographs

The three supplied photographs are preserved untouched in `assets/img/originals/`. Everything in
`assets/img/` is generated from them — cropped and resized, never stretched or filtered.

| Original | Used for |
| --- | --- |
| `IMG_0589.jpeg` storefront | Hero panel, Visit Us, final call-to-action, social share image |
| `IMG_0592.jpeg` business cards | Authenticity section, and the source of the vector logo |
| `IMG_0596.jpeg` interior | About section, category tiles, preview card photography |

---

## Editing the site copy

Business details appear in three places per page — the header menu, the Visit Us block
(home only) and the footer. Search for `718-505-1038` or `96-03 37th Ave` to find them all.

Two notes for whoever edits next:

- The locality is written as **Queens, NY 11368** everywhere. The business card says *Corona* and
  the written brief says *Flushing*; the street address and ZIP are identical either way, so the
  copy stays with the borough until the store confirms which neighbourhood name it wants.
- There are **no store hours and no email address** anywhere on the site, because none were
  supplied. When they are, add hours to the Visit Us block in `index.html` and to the
  `ClothingStore` JSON-LD block in the `<head>` (`openingHoursSpecification`).

## Social preview image

`assets/brand/og-image.jpg` (1200 × 630) is referenced by relative path in both pages. Once the
final domain is set, change the two `og:image` / `twitter:image` values in each page to the full
`https://…` URL — some social networks will not resolve a relative one.
