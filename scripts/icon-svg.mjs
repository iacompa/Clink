/*
 * The Clink icon as SVG — one source for the extension icons (gen-icons.mjs)
 * and the Safari app icons (safari.mjs).
 *
 *   variant 'extension'  rounded tile with a small margin (toolbar / store icon)
 *   variant 'mac'        tile inset to Apple's macOS grid (824 of 1024) with a soft shadow
 *   variant 'ios'        full-bleed opaque square — iOS applies its own mask
 */
export function iconSvg({ size, off = false, variant = 'extension' }) {
  const [a, b] = off ? ['#a1a1aa', '#71717a'] : ['#2dd4bf', '#0f766e'];
  const small = variant === 'extension' && size <= 32; // bolder glyph, no sparkle when tiny
  const stroke = small ? 15 : 11;
  const sparkle = small
    ? ''
    : '<path d="M33 15 L36.6 27.4 L49 31 L36.6 34.6 L33 47 L29.4 34.6 L17 31 L29.4 27.4 Z" fill="#fff" opacity="0.95"/>';
  const glyph = `<g transform="rotate(-45 64 64)" fill="none" stroke="#fff" stroke-width="${stroke}" stroke-linecap="round">
    <rect x="${small ? 18 : 22}" y="${small ? 46 : 48}" width="${small ? 52 : 48}" height="${small ? 36 : 32}" rx="${small ? 18 : 16}"/>
    <rect x="58" y="${small ? 46 : 48}" width="${small ? 52 : 48}" height="${small ? 36 : 32}" rx="${small ? 18 : 16}"/>
  </g>
  ${sparkle}`;
  const gradient = `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/>
    </linearGradient>`;

  if (variant === 'ios') {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <defs>${gradient}</defs>
  <rect width="128" height="128" fill="url(#g)"/>
  ${glyph}
</svg>`;
  }

  if (variant === 'mac') {
    // The tile spans 4…124 (120 units); Apple's grid puts it at 824/1024 of the canvas.
    const canvas = 120 / (824 / 1024);
    const o = 64 - canvas / 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${o} ${o} ${canvas} ${canvas}">
  <defs>${gradient}
    <filter id="s" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="1.6" stdDeviation="2.2" flood-color="#000" flood-opacity="0.28"/>
    </filter>
  </defs>
  <rect x="4" y="4" width="120" height="120" rx="27" fill="url(#g)" filter="url(#s)"/>
  ${glyph}
</svg>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <defs>${gradient}</defs>
  <rect x="${small ? 0 : 4}" y="${small ? 0 : 4}" width="${small ? 128 : 120}" height="${small ? 128 : 120}" rx="${small ? 30 : 28}" fill="url(#g)"/>
  ${glyph}
</svg>`;
}

/** Render SVG strings to PNG files with headless Chromium (Playwright). */
export async function renderPngs(jobs) {
  const { chromium } = await import('playwright');
  const fs = await import('node:fs/promises');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const { svg, size, file, opaque } of jobs) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
      const buf = await page.screenshot({ omitBackground: !opaque, clip: { x: 0, y: 0, width: size, height: size } });
      await fs.writeFile(file, buf);
    }
  } finally {
    await browser.close();
  }
}
