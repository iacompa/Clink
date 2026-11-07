// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * The Clink icon as SVG — one source for the extension icons (gen-icons.mjs),
 * the Safari app icons (safari.mjs) and the store artwork.
 *
 * Two glossy, interlocking chain links in the IA Compa colours — blue
 * (#2f6bf0 / #4f83ff) and orange (#ff8a4c) — lit from the top left, on a soft
 * porcelain tile.
 *
 *   variant 'extension'  tile with transparent padding (store / extensions page);
 *                        at 32px and below just the links, bold, so they read in a toolbar
 *   variant 'mac'        tile inset to Apple's macOS grid (824 of 1024) with a soft shadow
 *   variant 'ios'        full-bleed opaque square — iOS applies its own mask
 *   variant 'glyph'      the links alone, any size (web, docs)
 *   off: true            greyscale (Clink paused)
 */

const PALETTE = {
  on: {
    blue: { light: '#8fb0ff', main: '#4f83ff', mid: '#2f6bf0', dark: '#1a46b8', edge: '#12357f' },
    orange: { light: '#ffc49c', main: '#ff9a62', mid: '#ff8a4c', dark: '#e0622a', edge: '#a8441a' },
  },
  off: {
    blue: { light: '#c9ccd3', main: '#a3a8b2', mid: '#8b919c', dark: '#6b717c', edge: '#4d525b' },
    orange: { light: '#dcdee2', main: '#bfc3ca', mid: '#aab0b8', dark: '#8a9099', edge: '#686d75' },
  },
};

let uid = 0;

/**
 * The two links, drawn in a 128×128 box. `k` scales the tube thickness
 * (bolder for tiny toolbar sizes); `shadow` adds the soft shadow they cast.
 */
function links({ off, bold, shadow = true }) {
  const id = `c${++uid}`;
  const P = off ? PALETTE.off : PALETTE.on;
  const w = bold ? 15 : 12.5; // tube thickness
  // Each link is a capsule (stroke centre line), rotated -45° about the centre.
  // Left link spans x 20…72, right link 56…108: they cross near x = 64.
  const y = 46, h = 36, r = 18;
  const A = `M ${20 + r} ${y} H ${72 - r} A ${r} ${r} 0 0 1 ${72 - r} ${y + h} H ${20 + r} A ${r} ${r} 0 0 1 ${20 + r} ${y} Z`;
  const B = `M ${56 + r} ${y} H ${108 - r} A ${r} ${r} 0 0 1 ${108 - r} ${y + h} H ${56 + r} A ${r} ${r} 0 0 1 ${56 + r} ${y} Z`;

  const tube = (d, c, name) => `
    <path d="${d}" fill="none" stroke="${c.edge}" stroke-width="${w}" stroke-linejoin="round"/>
    <path d="${d}" fill="none" stroke="url(#${id}-${name})" stroke-width="${w - 2}" stroke-linejoin="round"/>
    <path d="${d}" fill="none" stroke="${c.dark}" stroke-opacity="0.55" stroke-width="${w * 0.42}" transform="translate(0 ${w * 0.2})" filter="url(#${id}-soft)"/>
    <path d="${d}" fill="none" stroke="${c.light}" stroke-width="${w * 0.4}" transform="translate(0 ${-w * 0.16})" filter="url(#${id}-soft)"/>
    <path d="${d}" fill="none" stroke="#fff" stroke-opacity="0.9" stroke-width="${w * 0.13}" stroke-linecap="round"
      stroke-dasharray="${bold ? '22 9 5 200' : '26 10 6 200'}" stroke-dashoffset="${bold ? -4 : -6}" transform="translate(0 ${-w * 0.22})" filter="url(#${id}-spec)"/>`;
  const grad = (name, c) => `
    <linearGradient id="${id}-${name}" gradientUnits="userSpaceOnUse" x1="0" y1="${y - w / 2}" x2="0" y2="${y + h + w / 2}">
      <stop offset="0" stop-color="${c.main}"/><stop offset="0.5" stop-color="${c.mid}"/><stop offset="1" stop-color="${c.dark}"/>
    </linearGradient>`;

  // The orange link passes over the blue one at the lower crossing; the blue one
  // is on top at the upper crossing. Each casts a soft shadow onto the link
  // beneath it (masked to that link, so nothing spills onto the background).
  const region = (name, top) =>
    // A mask, not a clip-path: the piece is composited as one layer, so its edge leaves no seam.
    `<mask id="${id}-${name}" maskUnits="userSpaceOnUse" x="-64" y="-64" width="256" height="256"><rect x="46" y="${top ? y - h : y + h / 2 + 2}" width="36" height="${h + h / 2 - 2}" fill="#fff"/></mask>`;
  const onto = (name, d) =>
    `<mask id="${id}-on${name}" maskUnits="userSpaceOnUse" x="-64" y="-64" width="256" height="256"><path d="${d}" fill="none" stroke="#fff" stroke-width="${w}"/></mask>`;
  const cast = (d, name, dx, dy) =>
    `<g mask="url(#${id}-on${name})"><path d="${d}" fill="none" stroke="#0b1a3a" stroke-opacity="${off ? 0.25 : 0.4}" stroke-width="${w}" transform="translate(${dx} ${dy})" filter="url(#${id}-cast)"/></g>`;

  return {
    defs: `
    ${grad('a', P.blue)}${grad('b', P.orange)}${region('upper', true)}${region('lower', false)}${onto('A', A)}${onto('B', B)}
    <filter id="${id}-soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${bold ? 0.9 : 1.2}"/></filter>
    <filter id="${id}-spec" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="0.45"/></filter>
    <filter id="${id}-cast" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="1.6"/></filter>
    <filter id="${id}-drop" x="-25%" y="-25%" width="150%" height="150%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="${bold ? 1.2 : 2.6}"/>
      <feOffset dx="0" dy="${bold ? 1.2 : 3.2}" result="b"/>
      <feFlood flood-color="#0b1a3a" flood-opacity="${off ? 0.18 : 0.26}"/>
      <feComposite in2="b" operator="in"/>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>`,
    body: `
    <g ${shadow ? `filter="url(#${id}-drop)"` : ''}>
      <g transform="rotate(-45 64 64)">
        <g>${tube(B, P.orange, 'b')}</g>
        <g mask="url(#${id}-upper)">${cast(A, 'B', -1.2, 2.2)}</g>
        <g>${tube(A, P.blue, 'a')}</g>
        <g mask="url(#${id}-lower)">
          ${cast(B, 'A', -1.2, 2.2)}
          ${tube(B, P.orange, 'b')}
        </g>
      </g>
    </g>`,
  };
}

/** A porcelain tile with a gentle top light, in a 128 box at (x, y, size). */
function tile(id, { x, y, s, rx, off, flat = false }) {
  const top = off ? '#f4f5f7' : '#ffffff';
  const bottom = off ? '#dcdfe4' : '#e6ebf5';
  return {
    defs: `
    <linearGradient id="${id}-tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/>
    </linearGradient>
    <radialGradient id="${id}-sheen" cx="0.3" cy="0.12" r="0.9">
      <stop offset="0" stop-color="#fff" stop-opacity="0.9"/><stop offset="0.6" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="${id}-rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="1"/><stop offset="0.5" stop-color="#fff" stop-opacity="0"/>
      <stop offset="1" stop-color="#0b1a3a" stop-opacity="0.10"/>
    </linearGradient>
    <filter id="${id}-tileshadow" x="-20%" y="-20%" width="140%" height="150%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="${s / 40}"/>
      <feOffset dy="${s / 50}" result="b"/>
      <feFlood flood-color="#0b1a3a" flood-opacity="0.22"/>
      <feComposite in2="b" operator="in"/>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>`,
    body: `
    <g ${flat ? '' : `filter="url(#${id}-tileshadow)"`}>
      <rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${rx}" fill="url(#${id}-tile)"/>
      <rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${rx}" fill="url(#${id}-sheen)"/>
      ${flat ? '' : `<rect x="${x + 0.6}" y="${y + 0.6}" width="${s - 1.2}" height="${s - 1.2}" rx="${rx - 0.6}" fill="none" stroke="url(#${id}-rim)" stroke-width="1.2"/>`}
    </g>`,
  };
}

export function iconSvg({ size, off = false, variant = 'extension' }) {
  const svg = (viewBox, inner) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}">${inner}\n</svg>`;
  const id = `t${++uid}`;

  if (variant === 'glyph' || (variant === 'extension' && size <= 32)) {
    const g = links({ off, bold: size <= 32, shadow: size > 32 });
    // Tiny sizes: zoom in so the links fill the square.
    const vb = size <= 32 ? '17 17 94 94' : '0 0 128 128';
    return svg(vb, `<defs>${g.defs}</defs>${g.body}`);
  }

  if (variant === 'ios') {
    const t = tile(id, { x: 0, y: 0, s: 128, rx: 0, off, flat: true });
    const g = links({ off });
    return svg('0 0 128 128', `<defs>${t.defs}${g.defs}</defs>${t.body}<g transform="translate(64 64) scale(0.94) translate(-64 -64)">${g.body}</g>`);
  }

  if (variant === 'mac') {
    // The tile spans 4…124 (120 units); Apple's grid puts it at 824/1024 of the canvas.
    const canvas = 120 / (824 / 1024);
    const o = 64 - canvas / 2;
    const t = tile(id, { x: 4, y: 4, s: 120, rx: 27, off });
    const g = links({ off });
    return svg(`${o} ${o} ${canvas} ${canvas}`, `<defs>${t.defs}${g.defs}</defs>${t.body}<g transform="translate(64 64) scale(0.9) translate(-64 -64)">${g.body}</g>`);
  }

  // Extension / store icon: Chrome asks for ~96px of artwork inside 128 with transparent padding.
  const t = tile(id, { x: 12, y: 10, s: 104, rx: 24, off });
  const g = links({ off });
  return svg('0 0 128 128', `<defs>${t.defs}${g.defs}</defs>${t.body}<g transform="translate(64 62) scale(0.8) translate(-64 -64)">${g.body}</g>`);
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
