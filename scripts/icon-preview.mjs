// SPDX-License-Identifier: GPL-3.0-or-later
/* Renders a contact sheet of every icon variant on light and dark backgrounds: node scripts/icon-preview.mjs out.png */
import { iconSvg } from './icon-svg.mjs';
const out = process.argv[2] || 'icon-preview.png';
const { chromium } = await import('playwright');
const cells = [
  ['extension', 512], ['extension', 128], ['extension', 48], ['extension', 32], ['extension', 16],
  ['mac', 256], ['ios', 180], ['extension', 128, true], ['extension', 32, true], ['extension', 16, true],
];
const row = (bg, fg) => `<div style="display:flex;gap:28px;align-items:center;padding:24px;background:${bg};color:${fg};font:12px system-ui">
  ${cells.map(([variant, size, off]) => `<figure style="margin:0;text-align:center"><div style="width:${size}px;height:${size}px;${variant === 'ios' ? 'border-radius:40px;overflow:hidden' : ''}">${iconSvg({ size, variant, off })}</div>
  <figcaption>${variant} ${size}${off ? ' off' : ''}</figcaption></figure>`).join('')}</div>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 600 }, deviceScaleFactor: 1 });
await page.setContent(`<body style="margin:0">${row('#f5f3ee', '#333')}${row('#202124', '#ddd')}<div style="padding:24px;background:#dee1e6;display:flex;gap:12px;align-items:center">
  <span style="font:13px system-ui">Chrome toolbar (light):</span>${iconSvg({ size: 16 })}${iconSvg({ size: 16, off: true })}
  <span style="font:13px system-ui;margin-left:24px">at 2x:</span><div style="width:16px;height:16px">${iconSvg({ size: 32 }).replace(/width="32" height="32"/, 'width="16" height="16"')}</div></div></body>`);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
