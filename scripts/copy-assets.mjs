// Copies non-TS assets that tsc ignores into dist/.
import { mkdir, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const assets = [
  ['src/server/dashboard.html', 'dist/server/dashboard.html'],
];

for (const [from, to] of assets) {
  const src = resolve(root, from);
  const dst = resolve(root, to);
  await mkdir(dirname(dst), { recursive: true });
  await copyFile(src, dst);
  console.log(`copied ${from} -> ${to}`);
}
