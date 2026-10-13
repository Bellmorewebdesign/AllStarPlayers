# All Star Players

The website for **All Star Players**, a streetwear boutique at 96-03 37th Ave, Queens, NY 11368,
open since 2002.

Four static pages. No build step, no framework, no front-end dependencies.

| Page | File | What it is |
| --- | --- | --- |
| Home | `index.html` | Video header, what is on the floor, categories, the store, shop photos, authenticity, visit |
| Shop | `shop.html` | The live catalog from Square, with size and colour selection and a cart |
| Cart | `cart.html` | The cart, the delivery choice and the hand-off to Square |
| Order | `order.html` | Where Square sends people back, with a server-verified status |

---

## The video header

The home page opens with a clip of the store, encoded from
`assets/video/originals/store-tour-source.mov`. `js/main.js` drives it. What it does:

- starts on its own, **muted**, looping, and inline on phones (`playsinline`)
- sound is **off** until somebody presses the button, and the button turns it back off
- the still photograph (`assets/img/hero-poster-*`) is what you see first and it stays put if
  the file is slow or will not play at all
- nothing downloads on a data saver, a 2g connection, or for anyone whose system asks for
  reduced motion. Those visitors get a play button instead
- it stops when it scrolls out of sight or the tab goes to the background

Two files are shipped and picked at runtime: `store-tour-1280.mp4` (about 2.8 MB) for
desktops, `store-tour-854.mp4` (about 1.6 MB) for phones. Neither is fetched until the page
has finished loading, so the header photograph is what the page is measured on.

To change the clip, drop a new file at `assets/video/originals/store-tour-source.mov` and run
the media build (below). If you change its length, update the two `fade` times near the bottom
of `tools/build-media.sh` so the loop still turns over cleanly.

---

## The online store

The shop page is a real storefront. Products, prices, photographs and stock all
come from the shop's Square account, live, through an API of our own on AWS.
Customers can put things in a cart and pay on Square's hosted checkout,
collecting in store or having it shipped.

**There is no product data in this repository, and there must never be any.**
No spreadsheet, no export, no snapshot. If the API cannot be reached, the shop
page says so and offers to try again; it never shows a saved copy as though it
were current.

### How it fits together

```
shop.html    the grid              -> js/store.js + js/picker.js
cart.html    cart and checkout     -> js/cart-page.js
order.html   what Square decided   -> js/order-page.js
                      |
   js/store-api.js  --- the only place that knows the API URL
   js/cart.js       --- ids and quantities in localStorage, nothing else
                      |
            AWS Lambda  (backend/)
                      |
     Secrets Manager + DynamoDB + the Square API
```

### The rules this follows

- **The browser is never trusted with money.** It sends variation ids,
  quantities and the customer's own details. Prices come from Square's catalog,
  the shipping charge from the shop's configured zones, and tax from the shop's
  own Square tax rules. A price edited in localStorage changes nothing.
- **Browsing reads a snapshot; buying reads Square.** The product list is
  rebuilt by a scheduled background job — 844 products and 5,869 variations
  take minutes to page out of Square, far longer than any web request may
  last — and the shop page reads whatever that job last published, with its
  age shown. A checkout re-reads price and stock from Square for exactly the
  variations in that cart, every time, and refuses the sale outright if
  Square cannot answer.
- **One product list, never two stitched together.** Pages are pinned to the
  build they started on: the cursor names it, and the build is kept for fifteen
  minutes after a newer one goes live. If a shopper's build does go, the API
  says so (`409`) and the page reloads the list from the top rather than
  joining half of one catalog to half of another.
- **An empty shop is shown as an empty shop.** If the scheduled job reads
  Square completely and nothing is sellable, it publishes that, and the page
  says everything is sold out. A *failed* read does the opposite and keeps the
  last good list serving, so people are never sent after products that are
  not there.
- **Only ids and quantities are stored locally.** Anything else goes stale, and
  a stale price in storage is exactly what an attacker would like to edit.
- **Unknown stock is not unlimited stock.** A variation Square is not counting
  reads "availability unknown", and by default cannot be bought online at all.
- **A variable-price item never gets an invented price.** It is not sold
  online; the card says it is priced in store.
- **A payment link is not a payment.** Neither is a redirect. The order page
  asks our API, which asks Square, and says "checking" until it knows.
- **Two shoppers cannot be sold the same last unit.** Holds on a variation
  live in one row and are taken with a single conditional write, so the race
  is settled by DynamoDB rather than by luck.
- **Stock is never freed on a timer — at any age.** A Square payment link does
  not expire, so a hold that merely ran out of clock is not proof of anything.
  A scheduled sweep cancels the abandoned link first and re-asks Square whether
  it really died; only then does the unit go back on the website. A hold that
  cannot be settled stays held indefinitely and is flagged for a person
  (`backend/DEPLOY.md` §9c), because a silent release is the one failure
  nobody would ever find. What this still does *not* cover — a sale over the
  counter — is written down in §9 rather than glossed over.
- **The site only offers what the API says it can do.** `GET /config` decides
  whether there is a checkout at all. With pickup and shipping both switched
  off, as production runs today, there is no Buy Now, no checkout form and no
  Pay button anywhere — the cart is a list to bring into the store, and the
  page says that in those words. Switching a method on in AWS brings the
  checkout back with no change here.
- **A tab left open gets refreshed, not trusted.** Coming back to the page
  re-fetches the catalog if it is more than a minute old, quietly, keeping
  the filters, the search and the cart exactly as they were.
- **Buy Now never empties your cart**, even when you buy something that is
  already in it.
- **Nothing is promised that is not built.** No UPS rates, no tracking numbers,
  no automated pickup email, no guaranteed stock reservation. Where a
  limitation exists, the page says so.

### Browsing

Square keeps thirty-seven categories, and they are the store's own working
labels: `HAT` and `HATS` are separate, so are `TEE`, `T-SHIRTS` and
`LS TSHIRT`, and a fifth of the catalog has no category at all. The shop page
shows five choices instead — All Products, Clothing, Footwear, Accessories,
Care & Other — and the shelves inside one only once it is opened.

That grouping lives in `js/catalog-groups.js` and nowhere else. It is keyed on
**Square's category ids**, because a shop renames a category whenever it likes;
the names are kept only as a fallback for a category deleted and recreated
under a new id. Anything the map has never seen — a new Square category, or no
category at all — lands in *Care & Other · Not Sorted Yet* rather than
disappearing from the shop. Every count on screen is counted from the products
the API returned.

Only the search field is pinned while you scroll. Departments, shelves, the
count, the filter chips and the sort control all scroll away like the rest of
the page.

### Product photographs

In order: the photograph on the chosen **variation** in Square, then the one on
the **product** in Square, then one **we sourced** (`assets/products/`), then a
plain *"Photo unavailable"* card. A broken image falls back the same way.

Photographs uploaded to Square reach the website on the next catalog refresh
with no code change, which is why that is the right place to put them.
`assets/products/README.md` covers the alternative — a manifest keyed by Square
product id, carrying the source, licence and credit for each file — and the two
rules it enforces: the photograph must show the actual item, and its licence
must permit a storefront. `node tools/product-images.mjs` reports where the
catalog stands; `--check` validates the manifest.

`tools/image-finder/` is a local Python application for filling that manifest:
it imports the catalog from the public API, searches image providers, and shows
the candidates for a person to approve or reject. It uses no AI model, runs on
your own machine, and publishes nothing — read its README before setting up a
provider, because two of the four cost money.

### The cart

`js/cart.js` keeps `{variationId, quantity}` pairs in `localStorage` under
`asp.cart.v1`. Adding the same variation twice makes one line of two; two sizes
of the same shirt are two lines. The cart survives a refresh and is shared
between tabs. It is reconciled against the API every time it is displayed, and
again before payment.

"Buy now" is a one-item checkout kept in `sessionStorage`. It deliberately does
not touch the saved cart.

### Changing where the API lives

One line, at the top of `js/store-api.js`:

```js
var API_BASE = window.ASP_API_BASE ||
  'https://uf04sxkrfk.execute-api.us-east-1.amazonaws.com/default';
```

That is the production API: 844 products with live Square prices and stock.
Online ordering is not switched on — `GET /config` reports no pickup and no
shipping, and the site reads that answer and says so rather than offering a
checkout that cannot finish.

### The back end

`backend/` is one AWS Lambda. `backend/DEPLOY.md` is the run-book: the table,
the secrets, the IAM policy, the routes, CORS, webhooks, and the sandbox checks
to do before taking real money. Read it before touching the console.

```
backend/
  index.mjs            routing and the request handlers
  lib/config.mjs       secrets and settings; an unconfigured method is unavailable
  lib/square.mjs       the Square client, with retries and cursor walking
  lib/catalog.mjs      catalog + inventory -> what can actually be sold
  lib/store.mjs        DynamoDB: cache, idempotency, orders, holds, webhook de-dup
  lib/cart.mjs         reconciling a cart against live prices and stock
  lib/fulfillment.mjs  pickup and shipping validation, configured rates
  lib/checkout.mjs     building the Square order and the payment link
  lib/webhook.mjs      signature verification and event interpretation
  lib/cleanup.mjs      cancels abandoned payment links, then frees their stock
  lib/refresh.mjs      the scheduled catalog rebuild, and its atomic publish
  test/                197 checks against a fake Square and an in-memory DynamoDB
```

```bash
cd backend && npm install && npm test
```

### What the shop still has to supply

Listed in full at the top of `backend/DEPLOY.md`: the production token and
location, the webhook signature key, the shipping zones and rates, the pickup
address and policy, a decision on items Square is not counting, and a check
that the Square tax rules cover online orders. **Any fulfillment method that is
not configured is simply not offered.** Nothing falls back to free shipping or
to no tax.

---

## The media build

Everything in `assets/img/` and `assets/video/` is generated from the untouched originals in
`assets/img/originals/` and `assets/video/originals/` by one script:

```bash
bash tools/build-media.sh
```

It needs `ffmpeg`, ImageMagick and `cwebp`:

```bash
sudo apt-get install ffmpeg imagemagick webp
```

**You do not need to run it to work on the site.** Every generated file is committed. Run it
only when you add or replace a source photo or the store video, then commit what it writes.

The script crops each photograph to a named size, writes a WebP and a JPEG at two or three
widths, pulls the still frames it needs out of the video, and encodes the two MP4s. The phone
shoots in HLG HDR, so every frame and every encode is tone mapped to normal colour first.
Without that step the web copies come out grey.

To move a crop, edit its one line in the `make` table and rerun.

---

## What is where

```
index.html              Home
shop.html               Shop, the live catalog
cart.html               Cart and checkout
order.html              Order status after Square sends people back
css/
  base.css              Tokens, type, header, footer, buttons, motion
  catalog.css           Cards, badges, the grid
  home.css              The video header and every section on the home page
  shop.css              Shop header, filters, sorting, the phone drawer
  store.css             Cart button, stock labels, the picker, cart and order pages
js/
  store-api.js          the only file that knows the API URL
  cart.js               the cart: ids and quantities, the badge, buy-now
  store.js              the shop grid, search and department filters
  catalog-groups.js     Square's 37 categories grouped into five departments
  product-images.js     where a product's photograph comes from, in order
  picker.js             the size and colour dialog
  cart-page.js          the cart page and the checkout form
  order-page.js         the server-verified order status page
  products.js           floor photographs for the home page row (not listings)
  catalog.js            draws those home page cards
  main.js               sticky header, phone menu, scroll reveals, the video
tools/
  build-media.sh        Regenerates assets/img and assets/video from the originals
  product-images.mjs    Photograph coverage, and validates assets/products
  image-finder/         A local Python app for sourcing the missing photographs
backend/
  index.mjs             The store API Lambda
  lib/                  Its modules
  test/                 Its tests
  DEPLOY.md             <- read this before touching AWS
assets/
  brand/                Vector logo, favicons, web manifest, social share image
  products/             Photographs we sourced, with their licences (see its README)
  fonts/                Self-hosted Boldonse + Instrument Sans (SIL OFL, licences included)
  img/                  Generated WebP + JPEG crops used across the site
  img/originals/        The six original photographs, untouched
                        (product photos come from Square, not from here)
  video/                The two encoded MP4s
  video/originals/      The original store clip, untouched
```

### The logo

`assets/brand/asp-mark.svg` is a clean vector of the star-and-P monogram, traced from the gold
foil business card in `assets/img/originals/IMG_0592.jpeg`. The same artwork runs the header,
the footer, the favicons and the star-shaped image reveals. It inherits `currentColor`, so it
can be dropped anywhere and coloured in CSS.

### The photographs

| Original | Used for |
| --- | --- |
| `IMG_0589.jpeg` storefront | Visit Us panel, the final call to action background |
| `IMG_0592.jpeg` business cards | The authenticity section, and the source of the vector logo |
| `IMG_0596.jpeg` interior | The store section, several category tiles and shop cards |
| `IMG_0669.jpeg` caps and tees | The tee and cap cards on the home row and the shop |
| `IMG_0670.jpeg` accessories | The Accessories tile and both accessories cards |
| `IMG_0673.jpeg` bottoms rack | The Shorts tile and the shorts cards |
| `store-tour-source.mov` | The video header, its poster, the hat tile, the shop band |

---

## Editing the copy

Store details appear in the same three places on each page: the menu, the Visit block
(home only) and the footer. Search for `718-505-1038` or `96-03 37th Ave` to find them all.

Three notes for whoever edits next:

- The locality is written as **Queens, NY 11368** everywhere. The business card says *Corona*
  and the written brief said *Flushing*. The street address and ZIP are the same either way,
  so the copy stays with the borough until the store says which neighbourhood name it wants.
- There are **no store hours and no email address** anywhere on the site, because none were
  given. When they arrive, add hours to the Visit block in `index.html` and to the
  `openingHoursSpecification` of the `ClothingStore` JSON-LD block in the `<head>`.
- The home page row is **photographs of the racks**, from `js/products.js`. They are not
  listings and carry no price. Everything that is actually for sale is on the shop page
  and comes from Square.

---

## Publishing on GitHub Pages

Repository, then **Settings > Pages**

| Setting | Value |
| --- | --- |
| Source | **Deploy from a branch** |
| Branch | **`main`** |
| Folder | **`/ (root)`** |

Save, wait about a minute, and the site is live at
`https://<user-or-org>.github.io/<repository>/`.

Nothing else is needed: no workflow, no build command, no `.nojekyll`. Every path in the site
is relative, so it works the same at a domain root or inside a project subdirectory.

### Social preview image

`assets/brand/og-image.jpg` (1200 x 630) is referenced by relative path on both pages. Once the
final domain is set, change the `og:image` and `twitter:image` values in each page to the full
`https://...` URL. Some social networks will not resolve a relative one.
