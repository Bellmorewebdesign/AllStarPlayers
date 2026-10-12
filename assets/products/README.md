# Product photographs

The shop draws a product's picture in this order:

1. the photograph on the **variation** the customer picked, if Square has one
2. the photograph on the **product** in Square
3. a photograph **we sourced**, listed in `manifest.json` and keyed by the Square product id
4. nothing — a plain **"Photo unavailable"** card

Steps 1 and 2 are the ones that scale. A photograph uploaded to a Square item
appears on the website within one catalog refresh, with no code change and no
pull request. **That is the right place to put photographs of the stock on the
floor.** This folder exists for the cases Square cannot cover.

## Where the catalog stands

Run it yourself — the numbers come from the live API, never from this file:

```bash
node tools/product-images.mjs            # coverage
node tools/product-images.mjs --missing  # the products with no photograph, as CSV
node tools/product-images.mjs --check    # validate this folder; exits 1 on a problem
```

As of 13 October 2026: **844 products, 37 photographed by Square (4.4%), 807
showing "Photo unavailable"**, and none sourced here yet. Why none is below.

## Adding a photograph

1. Put the optimised file in this folder, named after the Square product id:
   `assets/products/<SQUARE_PRODUCT_ID>.jpg`. Aim for roughly 1000px on the
   long edge and under 200 KB; the cards are never bigger than that.
2. Add a row to `manifest.json` under `images`:

```json
"NA63N726SAL5CZCFFA3GVJFL": {
  "file": "assets/products/NA63N726SAL5CZCFFA3GVJFL.jpg",
  "alt": "Black hockey jersey with red shoulder stripes",
  "source": "Wikimedia Commons",
  "sourceUrl": "https://commons.wikimedia.org/wiki/File:Example.jpg",
  "license": "CC BY-SA 4.0",
  "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0/",
  "credit": "A. Photographer",
  "matchedOn": "same brand, model and colourway as the Square item",
  "addedAt": "2026-10-13"
}
```

3. Run `node tools/product-images.mjs --check`. It fails if the file is not
   here, if the product id is not in the catalog, or if the source, licence or
   match note is missing.

The site shows `credit` under the photograph automatically, which is what most
open licences ask for.

## The two rules that matter

**It must be the actual item.** Same brand, same model, same colour. A photo of
a different colourway of the same sneaker is a wrong answer, not a close one —
somebody is deciding what to buy from it. If the exact item cannot be matched,
leave it out: "Photo unavailable" is true, and a photograph of something else
is not.

**The licence must permit a commercial storefront**, and it must be recorded.
Brand and retailer product photography — Nike's, a sneaker site's, a reseller's
listing — is almost always ordinary copyright, and "it was on Google Images" is
not a licence. Stock libraries with machine-readable licences (Wikimedia
Commons, Openverse, Flickr CC) are the realistic places to look.

## Why nothing is sourced here yet

Two reasons, and the first one is the real one:

- **For most of these products no accurate photograph exists to find.** The
  catalog is largely the shop's own buys — `PUNK NOMAD` denim, `BLOWFISH TEE`,
  `777 CIRCLE HUDSON`. No stock library has a picture of that exact garment,
  and anything else would be a picture of a different product.
- Of the 807, a minority name a specific mass-market model (33 sneakers such as
  `AIR JORDAN 4 RETRO` or `NIKE DUNK LOW RETRO`, plus some branded
  accessories). An accurate photograph of those exists in the world, but the
  ones that turn up are brand and retailer images under ordinary copyright,
  which the licence rule above rules out. A search for freely licensed
  photography of specific colourways turned up nothing usable.

The fastest way to fill this in is not this folder: it is photographing the
rack and uploading to Square, where the photographs also serve the till, and
where they reach the website on the next refresh.
