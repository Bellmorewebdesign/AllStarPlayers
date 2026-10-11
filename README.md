# All Star Players

The website for **All Star Players**, a streetwear boutique at 96-03 37th Ave, Queens, NY 11368,
open since 2002.

Two static pages. No build step, no framework, no dependencies.

| Page | File | What it is |
| --- | --- | --- |
| Home | `index.html` | Video header, what is on the floor, categories, the store, shop photos, authenticity, visit |
| Shop | `shop.html` | In-stock snapshot, search, categories, prices and variation details |

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

## In-stock browsing catalog

`shop.html` loads `js/stock-products.js`, a public snapshot of the October 11, 2026
Square export for ALLSTAR PLAYERS: **870 product-name groups and 1,786 sellable
variations with positive stock**. Two additional positive-stock variations were explicitly
marked not sellable and are excluded. Zero, negative, blank and unknown quantities are
excluded. A group can include only its in-stock sizes/colors; other variations do not appear.

This is **browsing only**, not live Square inventory. The page and product dialogs show the
snapshot date and ask customers to call to confirm stock. There is no cart or checkout on
these real product cards. The separate sandbox checkout preview still uses the existing AWS
API and test item. This change requires no Lambda deployment.

The shop supports search (names, descriptions and available options), category filters,
name/price sorting, 36 cards at a time with Show More, and a keyboard-accessible details
dialog containing the exported variation choices and their own prices. Prices in this
static file are **USD dollars**, not Square API cents. A variable price appears as “Ask in
store”; mixed known and variable prices show “From” on the card. No dates were present in
the export, so Newest/New Arrivals are not offered.

### Refreshing the snapshot

Keep the original export outside this repository. It contains supplier costs and other
internal data and must not be published. The importer reads it without editing it and
writes only a whitelist of public retail fields. It does not copy vendor names, unit costs,
SKUs, exact quantities, merchant credentials or account details into the website.

From the repository root, using Python with `openpyxl` installed:

```bash
python tools/import-square-catalog.py /path/to/catalog.xlsx --date 2026-10-11
python -m unittest discover -s tools -p 'test_*.py'
```

Use the actual export date, and `--location "LOCATION NAME"` if the stock-column suffix
changes. Then update the date/product-count notice in `shop.html` and commit the generated
`js/stock-products.js`. Do not edit that generated file directly. Sorting/grouping uses the
trimmed Item Name because the export has variation IDs, not parent item IDs. These website
group IDs are not Square catalog IDs. Each variation keeps its real catalog variation ID
for a future production integration; never submit these to the sandbox checkout endpoint.

The importer maps the export's categories into the filter groups and inherits categories
from other rows of the same item when a size row is blank. Unmapped/uncategorized items go
under Other. Review Other when refreshing; add mappings in `CATEGORY_GROUPS` as needed.
Existing home-page category links still work.

### Adding real product photos

The export has no photos. Cards honestly say “Photo coming soon”; no rack or stock photo
is presented as a photograph of a specific product. Add a verified product photo under
`assets/img/products/`, find its stable `stock-...` ID in `js/stock-products.js`, and add it
to `data/catalog-images.json`:

```json
{
  "stock-REPLACE_WITH_PRODUCT_ID": {
    "image": "assets/img/products/verified-product.jpg",
    "alt": "Description of the actual product photograph"
  }
}
```

Run the importer again with the same export and date. It checks that each mapped photo is
an existing product asset. Do not guess photo-to-product matches. Production Square
Catalog image retrieval and live stock sync are follow-up work requiring the client's
production credentials and location. Before enabling real checkout, stock and price must
be verified on the server at order time.

### Homepage floor photos

`js/products.js` still holds the fourteen verified store/rack photos used on `index.html`.
The shop overrides that array with the snapshot, so these photographs are not confused
with real product listings. Edit homepage photos in `products.js` as before. Their existing
“Photos, not listings” notice remains.

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
shop.html               Shop
css/
  base.css              Tokens, type, header, footer, buttons, motion
  catalog.css           Cards, badges, the grid, the "photos not listings" note
  home.css              The video header and every section on the home page
  shop.css              Shop header, filters, sorting, the phone drawer
  test-checkout.css     The Square sandbox test block on the shop page
js/
  products.js           Homepage floor photographs and shared settings
  stock-products.js     Generated public in-stock inventory snapshot
  stock-catalog.js      Browsing-only variation details dialog
  catalog.js            Draws the cards, runs search, filters and sorting
  main.js               Sticky header, phone menu, scroll reveals, the video
  test-checkout.js      Fetches the one sandbox product and runs its Buy button
backend/
  index.mjs             The AWS Lambda behind both API endpoints
  DEPLOY.md             <- how to get it on AWS. Read this before touching AWS.
tools/
  build-media.sh        Regenerates store assets from the originals
  import-square-catalog.py  Generates the public retail snapshot from a private export
  test_import_square_catalog.py  Import selection/privacy checks
data/
  catalog-images.json   Verified product-photo mappings
assets/
  brand/                Vector logo, favicons, web manifest, social share image
  fonts/                Self-hosted Boldonse + Instrument Sans (SIL OFL, licences included)
  img/                  Generated WebP + JPEG crops used across the site
  img/originals/        The six original photographs, untouched
  img/products/         Product artwork. Only the sandbox test placeholder so far.
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
- Nothing in `js/products.js` quotes a price, and none of those cards offers to sell anything,
  because those are homepage rack photographs. The shop's `js/stock-products.js` quotes
  real exported retail prices but remains browsing-only with a call-the-store action.
  The separate Square sandbox preview is the only checkout integration. See below.

---

## The Square sandbox test

The expandable sandbox section below the catalog opens a Square **sandbox hosted checkout preview** for one test product.
Choose **Ship to me** or **Store pickup** before opening Square. Shipping collects
an address; pickup creates a `PICKUP` fulfillment at the sandbox location. The
preview cannot accept payments; nothing ships and no pickup is booked. Pickup
says “We’ll notify you when your order is ready. Collect during store hours.”
There is no fixed pickup estimate or appointment. Ready notifications are not
automated: staff must contact buyers when orders are ready before this policy is
used in production. Sandbox previews send no messages. Shipping charges, carrier rates, labels and
delivery estimates are not configured. Confirm shipping areas/rates and pickup
location/hours/readiness with the client before preparing production checkout.

### How it hangs together

```
shop.html  #test-checkout          the block, and the ids it reads
  -> js/test-checkout.js           draws it, runs the button
     -> GET  <api>/default/products   what to show and what it costs
     -> POST <api>/default/checkout   asks Square for a checkout page
        -> backend/index.mjs (AWS Lambda)
           -> Secrets Manager     the Square token, which never leaves AWS
           -> Square sandbox      creates the payment link
     -> the browser goes to Square's own hosted checkout page
```

**No Square token is anywhere in this repository, and there must never be one.** The static
site only ever talks to our own AWS endpoints. Everything secret lives in the AWS secret
`all-star-players/square/sandbox`.

### The rules it plays by

- The price comes from Square, in cents, and is formatted in the browser. The browser never
  sends a price, and the backend would ignore it if it did.
- Only the one test variation, only one unit. Anything else is refused before Square is called.
- If the API is down the block says so. It never falls back to invented product data.
- Nothing on the page ever says a payment succeeded. A payment link is not a payment, and a
  redirect is not a payment. Square's own confirmation page is what tells you.
- Hosted sandbox payment links are previews with disabled payment fields. Do not try to
  complete a test-card payment on this preview. Link creation does not verify payment.
- Shipping-address collection is enabled only for shipping. Pickup uses an explicit
  Square `PICKUP` fulfillment with shipping-address collection disabled.
- No `shipping_fee` is sent while rates are undecided; this is not a free-shipping policy.
- Retries preserve the key per fulfillment mode; changing modes cannot reuse a link
  for the other mode. The frontend verifies the backend confirms the chosen mode
  and the notify-when-ready pickup policy.

### The picture

`assets/img/products/test-sneaker.svg` is a **drawing**, not a photograph — an original
illustration in the site's own black, bone and gold, made for this repository, so there is no
stock licence to worry about. The caption under it says as much.

To swap in a real photograph: drop it in `assets/img/products/`, then point the block at it by
editing one attribute in `shop.html`:

```html
data-image="assets/img/products/your-photo.jpg"
data-image-alt="What the photograph shows"
```

Nothing else needs to change. If you buy or licence a stock photo, keep the licence file next
to it the way the fonts do.

### Changing the endpoints

The API base URL and the two Square ids are attributes on the block in `shop.html`, not
constants buried in the JavaScript:

```html
data-api="https://n9ecaydkv4.execute-api.us-east-1.amazonaws.com/default"
data-item="E5LVW7ULD463KVCQKLV7SN63"
data-variation="T2APLGR5UFWGFELNUHGVNVI2"
```

### Taking it off the site

Delete the `<section id="test-checkout">` block from `shop.html`. The two file references in
the `<head>` and before `</body>` can go with it. Nothing else on the site depends on it.

### The AWS side

`backend/index.mjs` is the whole function and `backend/DEPLOY.md` is the runbook: replacing the
code, adding the `POST /checkout` route, checking the Lambda invoke permission, turning on
CORS, and checking both pickup and shipping previews. Read it before touching the console.

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
