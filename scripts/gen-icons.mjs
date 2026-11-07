// SPDX-License-Identifier: GPL-3.0-or-later
/* Renders the Clink extension icons (SVG → PNG) with headless Chromium. Run: node scripts/gen-icons.mjs */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { iconSvg, renderPngs } from './icon-svg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'icons');
await fs.mkdir(OUT, { recursive: true });

const jobs = [];
for (const size of [16, 32, 48, 128, 512]) jobs.push({ size, off: false });
for (const size of [16, 32, 48, 128]) jobs.push({ size, off: true });

await renderPngs(jobs.map(({ size, off }) => ({
  size,
  svg: iconSvg({ size, off }),
  file: path.join(OUT, `icon-${size}${off ? '-off' : ''}.png`),
})));
for (const { size, off } of jobs) console.log('wrote', `src/icons/icon-${size}${off ? '-off' : ''}.png`);
await fs.writeFile(path.join(OUT, 'icon.svg'), iconSvg({ size: 128 }));
