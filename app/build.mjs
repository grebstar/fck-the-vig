// Copies the website (../docs) into www/ for the iPhone app.
// The odds files in docs/data are left out: the app loads them live from https://www.fckvig.com/data/
// (see DATA_BASE in docs/js/main.js), so the app always shows the same odds as the site.
import { cpSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'docs');
const out = join(here, 'www');
const SKIP = new Set(['data', 'CNAME', '.nojekyll']);

if (!existsSync(join(src, 'index.html'))) throw new Error(`Can't find the site at ${src}`);
rmSync(out, { recursive: true, force: true });
cpSync(src, out, {
  recursive: true,
  filter: p => {
    const rel = relative(src, p);
    return rel === '' || !SKIP.has(rel.split(sep)[0]);
  },
});
console.log(`Copied the site into ${out} (odds data is loaded live from fckvig.com).`);
