#!/usr/bin/env node
/* ==========================================================================
   Product photography: what the shop has, what it is missing
   --------------------------------------------------------------------------
   Reads the live catalog and assets/products/manifest.json, then:

     node tools/product-images.mjs            how many products have a photo
     node tools/product-images.mjs --missing  the ones that do not, as CSV
     node tools/product-images.mjs --check    validate the manifest, exit 1 on error

   --check is the one to run before committing photographs. It refuses a
   manifest row whose file is not in the repository, whose product id is not
   in the catalog, or which is missing its source and licence — because an
   image with no recorded licence is one nobody can defend later.
   ========================================================================== */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.ASP_API_BASE
  || 'https://uf04sxkrfk.execute-api.us-east-1.amazonaws.com/default';

const REQUIRED = ['file', 'source', 'sourceUrl', 'license', 'matchedOn'];

async function catalog() {
  const products = [];
  let cursor = null;
  for (;;) {
    const url = `${API}/catalog?limit=300${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET /catalog answered ${res.status}`);
    const data = await res.json();
    if (data.success !== true) throw new Error('the catalog service reported a problem');
    products.push(...data.products);
    cursor = data.cursor;
    if (!cursor) break;
  }
  return products;
}

async function manifest() {
  const raw = await readFile(path.join(ROOT, 'assets/products/manifest.json'), 'utf8');
  return JSON.parse(raw);
}

const squarePhoto = (p) =>
  (p.imageUrls && p.imageUrls.length > 0) ||
  (p.variations || []).some(v => v.imageUrls && v.imageUrls.length > 0);

async function main() {
  const mode = process.argv[2] || '--count';
  const [products, file] = await Promise.all([catalog(), manifest()]);
  const images = file.images || {};

  if (mode === '--check') {
    const ids = new Set(products.map(p => p.id));
    const problems = [];
    for (const [id, row] of Object.entries(images)) {
      if (!ids.has(id)) problems.push(`${id}: no product with this id in the catalog`);
      for (const field of REQUIRED) {
        if (!row?.[field]) problems.push(`${id}: missing "${field}"`);
      }
      if (row?.file) {
        if (row.file.startsWith('http')) problems.push(`${id}: file must be committed here, not hotlinked`);
        else {
          try { await stat(path.join(ROOT, row.file)); }
          catch { problems.push(`${id}: ${row.file} is not in the repository`); }
        }
      }
    }
    if (problems.length) {
      console.error('manifest problems:\n  ' + problems.join('\n  '));
      process.exit(1);
    }
    console.log(`manifest ok: ${Object.keys(images).length} photographs, every row checked`);
    return;
  }

  const fromSquare = products.filter(squarePhoto);
  const sourced = products.filter(p => !squarePhoto(p) && images[p.id]);
  const missing = products.filter(p => !squarePhoto(p) && !images[p.id]);

  if (mode === '--missing') {
    console.log('square_id,name,category_ids,variations');
    for (const p of missing) {
      console.log([p.id, JSON.stringify(p.name.trim()), (p.categoryIds || []).join(' '), p.variations.length].join(','));
    }
    return;
  }

  const pct = (n) => ((n / products.length) * 100).toFixed(1) + '%';
  console.log(`products in the catalog      ${products.length}`);
  console.log(`  photographed by Square     ${fromSquare.length}  (${pct(fromSquare.length)})`);
  console.log(`  photograph sourced by us   ${sourced.length}  (${pct(sourced.length)})`);
  console.log(`  "Photo unavailable"        ${missing.length}  (${pct(missing.length)})`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
