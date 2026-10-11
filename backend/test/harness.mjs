/* Loads the handler with its two network edges swapped for doubles. Node has
   no built-in module interception that is stable across versions, so the
   handler's imports are rewritten on the way in. The logic under test is
   byte-for-byte the file that gets deployed. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function makeHandler({ configMod, squareMod, storeMod, stamp }) {
  const source = await readFile(path.join(here, '..', 'index.mjs'), 'utf8');
  const base = pathToFileURL(path.join(here, '..', 'index.mjs')).href;

  /* Replace the three module specifiers the doubles stand in for with global
     lookups, and leave every other import alone. */
  const patched = source
    .replace(/import \{[^}]*\} from '\.\/lib\/config\.mjs';/,
      'const { loadSecrets, settings, publicConfig, ConfigError } = globalThis.__configMod;')
    .replace(/import \{[^}]*\} from '\.\/lib\/square\.mjs';/,
      'const { createSquareClient, SquareError } = globalThis.__squareMod;')
    .replace(/import \{[^}]*\} from '\.\/lib\/store\.mjs';/,
      'const { createStore, sha256, newToken, StoreError } = globalThis.__storeMod;')
    .replace(/from '\.\/lib\//g, "from '" + new URL('./lib/', base).href);

  globalThis.__configMod = configMod;
  globalThis.__squareMod = squareMod;
  globalThis.__storeMod = storeMod;

  const url = 'data:text/javascript;base64,' + Buffer.from(patched).toString('base64') + stamp.replace('?', '#');
  const mod = await import(url);
  return mod.handler;
}
