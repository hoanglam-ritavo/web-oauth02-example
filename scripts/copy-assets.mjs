import { cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const root = new URL('../', import.meta.url);
await mkdir(new URL('dist/views/', root), { recursive: true });
await cp(new URL('src/views/page.ejs', root), new URL('dist/views/page.ejs', root));
await cp(new URL('src/public/', root), new URL('dist/public/', root), { recursive: true });
await cp(join(dirname(createRequire(import.meta.url).resolve('axios/package.json')), 'dist/axios.min.js'), new URL('dist/public/axios.min.js', root));
