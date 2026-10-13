# Product-image finder

A small program you run on your own computer. It reads the shop's catalog from
the public API, searches image providers for photographs of the products that
have none, shows you the candidates, and lets you decide. What you approve is
downloaded, optimised, and written into files the website understands.

**It publishes nothing.** No AWS resource, no price, no stock level and no page
on the live site is touched. Putting an exported photograph on the website is a
separate step you take by hand.

**No AI model is used at any point** — not Claude, not OpenAI, not anything
else, paid or free. The searches are built by ordinary string handling, and the
judgement about whether a photograph shows the right product is yours.

---

## Before you install: what the search providers cost

The program ships with four. Two are free and need nothing; two cost money and
are **switched off until you turn them on and set a budget**, so a wrong click
cannot spend anything.

| Provider | Key needed | Cost | Rights information |
| --- | --- | --- | --- |
| **Openverse** | no (optional token raises the rate limit) | **free** | **Publishes the licence** for every result — this is the one that can feed the website's manifest directly |
| **Wikimedia Commons** | no | **free** | **Publishes the licence** per file |
| **Google Programmable Search** (Custom Search JSON API) | API key **and** a search-engine id (cx) | 100 queries/day free, then about **US$5 per 1,000**, max 10,000/day | **None.** A `rights=` filter can be requested, but what comes back is a filter, not a licence |
| **Brave Search** (images) | subscription token | **No free tier for new accounts since early 2026.** A card is required, roughly US$5/month of credit, then about **US$5 per 1,000** requests | **None** |

Two warnings worth reading before you set anything up:

* **Google's Custom Search JSON API is closed to new customers**, and Google's
  own documentation lists discontinuation on **1 January 2027**. If you do not
  already have a key, it is probably not worth the setup.
* Figures above were checked in **October 2026** and these services change
  their pricing often. Confirm on the provider's page before enabling one.

You can run the whole program with **no key and no spending at all**, on
Openverse and Wikimedia alone. That is the default. Those two index openly
licensed photography, which is thin on current retail stock — so expect to
find less, and to upload your own photographs for most products.

Adding another provider (SerpApi, Zenserp, anything else) is one module in
`imagefinder/providers/` with a `search(query, limit)` method; nothing else in
the program needs to change.

### Where keys are kept

In `config.json` inside the work directory (`~/.all-star-image-finder` by
default), written readable by you only, or in environment variables
(`GOOGLE_CSE_API_KEY`, `GOOGLE_CSE_CX`, `BRAVE_API_KEY`, `OPENVERSE_API_KEY`).
Keys are never committed, never logged and never sent anywhere but to that
provider.

---

## Install

You need **Python 3.10 or newer**. Nothing else.

### Ubuntu

```bash
sudo apt update && sudo apt install -y python3 python3-venv python3-pip git

git clone https://github.com/Bellmorewebdesign/AllStarPlayers.git
cd AllStarPlayers/tools/image-finder

python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

python run.py
```

### Windows

Install Python from <https://www.python.org/downloads/windows/> — tick **"Add
python.exe to PATH"** in the installer. Then, in PowerShell:

```powershell
git clone https://github.com/Bellmorewebdesign/AllStarPlayers.git
cd AllStarPlayers\tools\image-finder

py -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt

py run.py
```

If PowerShell refuses to run the activate script, allow it for this session:
`Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned`.

Either way the program prints a link and opens
<http://127.0.0.1:8765/> in your browser. It listens on localhost only.

```
python run.py --port 9000     # a different port
python run.py --no-browser    # do not open a window
python run.py --import-only   # import the catalog and exit
python run.py --export        # write the export files and exit
python -m unittest discover -s tests -t .    # run the tests
```

Everything it stores lives in `~/.all-star-image-finder` (Windows:
`C:\Users\you\.all-star-image-finder`), or wherever `IMAGEFINDER_HOME` points:

```
imagefinder.sqlite3   products, queries, searches, candidates, your decisions
originals/            the files as downloaded
optimized/            web-sized copies
export/               what you can copy into the website
config.json           settings and keys
```

---

## How to use it

**1. Import.** On the dashboard, press *Import products*. It reads
`https://uf04sxkrfk.execute-api.us-east-1.amazonaws.com/default` page by page.
No Square token is involved: that lives in AWS and never leaves it. The import
follows the API's pinned cursors — each cursor belongs to one build of the
catalog, and if the catalog is rebuilt while the import is running the API says
so and the import starts again, rather than stitching two builds together.
Re-importing later is safe: products are matched on their Square id, so prices
and stock move with the catalog while your queries, candidates and decisions
stay put.

**2. Pick a product.** The list defaults to the ones with no photograph in
Square; the dropdown switches to all products. Every row shows how many
candidates it has and whether a main image is chosen.

**3. Check the searches.** Each product gets a few, built from its name, the
brand if the name carries one, a manufacturer style code if the shop recorded
one, and the first colour. They are editable — a name made of generic words is
flagged, because "BLACK TEE" finds a thousand unrelated shirts.

Two things the generator deliberately does *not* do: it does not search for a
UPC barcode (most of this catalog's SKUs are barcodes, and no photograph is
captioned with one), and it does not bolt a colour from one variation onto a
name that already states a different colourway.

**4. Find candidates.** Five to ten images, with thumbnail, dimensions, a link
to the page they came from, and whatever the provider says about the licence.
Results from a web search say **usage rights unknown**, because that is the
truth: a search ranking is not evidence of anything, and finding an image is
not permission to use it.

**5. Decide.** Approve, reject, skip the product, or upload your own
photograph. To approve you must tick that you opened the source and it is the
**same item — brand, model and colour** — and write a line saying how you
checked. That line travels with the photograph into the manifest. Several
photographs can be approved per product; one is the main image and the rest go
to a gallery file.

Approving downloads the file and writes an optimised copy. The three ways that
can end are told apart: **downloaded**, **download blocked** (the host refused
us) and **download failed** (a timeout, a 404, or something that is not an
image).

**6. Export.** The export page writes, into `export/`:

* `manifest.json` — main images, in the same shape as the website's
  `assets/products/manifest.json`, keyed by Square product id, carrying
  `file`, `alt`, `source`, `sourceUrl`, `license`, `licenseUrl`, `credit`,
  `matchedOn` and `addedAt`.
* `gallery.json` — the other approved photographs, for a gallery the website
  does not have yet.
* `pending-rights.json` — approved photographs whose rights are unknown. These
  are **not** in the manifest. The website's manifest requires a licence, and
  an image nobody has established the rights for is not publishable.
* `images/` — the optimised files.

To put them on the site: copy `images/*` into the repository's
`assets/products/`, merge the `images` object of `export/manifest.json` into
`assets/products/manifest.json`, run `node tools/product-images.mjs --check`,
look at the shop page, and commit.

---

## Stopping, resuming and not spending twice

Everything is in SQLite as you go, so closing the window loses nothing.

* **Searches are cached** by provider and query. Re-opening a product, or
  restarting the program, re-uses what was already fetched. The tick box
  *ignore the cache* forces a fresh search when you want one.
* A query another product already paid for is **re-used for free**.
* **Budgets** are per provider, per day. A billable provider with a budget of
  zero is never called at all. Failed calls count too, because a provider may
  bill for them.
* Each provider has its own **minimum interval** between calls, and a 429 or a
  5xx is retried with a growing wait rather than hammered.
* A failure on a **free** provider is retried next time — it cost nothing, and
  an outage an hour ago is not an answer about this product. A failure on a
  **billable** one stays cached.
* The product list distinguishes **no matches** (the providers answered and had
  nothing), **search failed** (the search itself broke) and **skipped**.

---

## What was tested, and what was not

Run `python -m unittest discover -s tests -t .` — 63 tests.

**Tested against the real production API.** The catalog import was run against
`https://uf04sxkrfk.execute-api.us-east-1.amazonaws.com/default`: 844 products,
37 with a Square photograph, 807 without, over three pinned-cursor pages. The
whole review workflow was then driven through the browser interface on that
real data.

**Tested over real HTTP, against a local stand-in.** The provider classes, the
catalog walker and the downloader all run against a small server in `tests/`
that answers in each provider's documented response shape, including the
awkward cases: an expired catalog cursor mid-import, a 429 with `Retry-After`,
a 500, a 403 on an image, and an HTML login page where a JPEG should be.

**NOT tested against a live search provider.** The machine this was written on
has no outbound access to `api.openverse.org`, `commons.wikimedia.org`,
`www.googleapis.com` or `api.search.brave.com` — every one is refused by its
network policy. So the parsing of each provider's *real* payload is written
from its documentation and exercised only against the stand-in. The first thing
to do on a machine with normal internet access is open one product, press
*Find candidates*, and check that Openverse and Wikimedia come back with
sensible results; if a field is missing or named differently, it will show up
there immediately and the fix is in one small module.

Also untested for the same reason: the real providers' rate limits and error
bodies, and downloading an image from a real host.
