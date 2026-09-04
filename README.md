# All Star Players

The website for **All Star Players**, a streetwear boutique at 96-03 37th Ave, Queens, NY 11368,
open since 2002.

Two static pages. No build step, no framework, no dependencies.

| Page | File | What it is |
| --- | --- | --- |
| Home | `index.html` | Video header, what is on the floor, categories, the store, shop photos, authenticity, visit |
| Shop | `shop.html` | The whole floor with search, category filters and sorting |

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

## Adding products, the only file you need

**Everything that looks like a product on this site comes from
[`js/products.js`](js/products.js).** The row on the home page and the whole shop page both
read that one array, so a product is only ever entered once.

### 1. Add the photographs

Put them in `assets/img/products/`. Portrait crops around **1000 x 1250** (4:5) look best,
because that is the shape of the card. Anything else gets cropped to fit.

### 2. Add the entry

Open `js/products.js` and copy the template at the top of the file into the `ASP.items` array:

```js
{
  id:            'asp-0001',                   // unique, never reused
  name:          'Product name',
  brand:         'Brand name',
  category:      't-shirts',                   // a slug from ASP.categories
  categories:    ['t-shirts','hats'],          // optional, if it fits more than one
  price:         120,                          // leave it out and the card says "Ask in store"
  originalPrice: 160,                          // optional, draws a strike-through
  image:         'assets/img/products/x.jpg',
  images:        ['assets/img/products/x-2.jpg'],  // first extra shot is the hover photo
  alt:           'What the photograph shows',
  description:   'A line or two.',
  featured:      true,        // puts it in the row on the home page
  bestSeller:    false,       // badge + the Best Sellers filter
  newArrival:    true,        // badge + the New Arrivals filter
  limited:       false,       // badge
  sizes:         ['S','M','L','XL'],
  colors:        [{ name:'Black', hex:'#101010' }, { name:'Bone', hex:'#F1EDE4' }],
  soldOut:       false,       // greys the photo and stamps SOLD OUT
  sortOrder:     10,          // low numbers come first under "Featured"
  url:           ''           // optional link. Empty means the card is not clickable.
}
```

Save the file and refresh. There is nothing to install and nothing to compile.

### 3. Clear the floor photos

The site currently ships **fourteen floor photos** instead of listings. They are real
photographs of the store, tagged with the category they show. They invent nothing: no brand,
no product name, no size, no price. Every one carries `floor: true` and they all sit together
between two markers in `js/products.js`:

```
/* ===== FLOOR PHOTOS. DELETE THIS BLOCK WHEN THE REAL CATALOG LANDS ===== */
...
/* ===== END OF FLOOR PHOTOS ===== */
```

Delete that block in one go. The two "Photos, not listings" notices, on the home page and on
the shop page, hide themselves the moment one real product exists.

### Categories

`ASP.categories` in the same file controls the filters on the shop page and the order they
appear in. The seven that ship are the ones there are real photographs for:

```
t-shirts   hoodies-sweatshirts   pants   shorts   sneakers   hats   accessories
```

**New Arrivals** and **Best Sellers** are written into that list and commented off. They are
*smart* categories: a product joins them through its `newArrival` / `bestSeller` flag rather
than through `category`, so a tee can be a T-Shirt and a New Arrival at the same time. They
are switched off today because a photograph of a rack cannot honestly claim to be either one.
Uncomment those two lines as soon as real products start carrying the flags. **Jackets** is not
in the list for the same reason: there is no jacket photograph yet, and a category link that
lands on an empty page reads as broken. Add the line back with a photo.

Category links use a query string and work from anywhere:
`shop.html?category=t-shirts`, `shop.html?category=accessories`, `shop.html?q=cap&sort=name-asc`.

The sort menu prunes itself. Price sorting only appears once something has a price, and Newest
only once something has a `dateAdded`, so no control on the page does nothing.

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
js/
  products.js           <- the catalog. Add products here.
  catalog.js            Draws the cards, runs search, filters and sorting
  main.js               Sticky header, phone menu, scroll reveals, the video
tools/
  build-media.sh        Regenerates assets/img and assets/video from the originals
assets/
  brand/                Vector logo, favicons, web manifest, social share image
  fonts/                Self-hosted Boldonse + Instrument Sans (SIL OFL, licences included)
  img/                  Generated WebP + JPEG crops used across the site
  img/originals/        The six original photographs, untouched
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
- Nothing on the site quotes a price, and no page offers to sell anything, because there is no
  checkout. Every "how much" route sends people to the phone number or the door.

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
