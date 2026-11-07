// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Store artwork: screenshots and promo tiles for the Chrome Web Store, Firefox
 * Add-ons and the App Store, plus the README images. Run: node scripts/store-assets.mjs
 *
 * The popup and settings shown are real: Clink is loaded into Chromium, a few
 * tracking links are opened (on local test sites), and the extension pages are
 * captured. Those captures are then laid out with captions at each store's size.
 *
 *   store/chrome/      1280×800 screenshots, 440×280 small tile, 1400×560 marquee
 *   store/firefox/     1280×800 screenshots
 *   store/apple/mac/   2560×1600     store/apple/iphone/  1320×2868 (6.9")
 *   store/apple/ipad/  2064×2752 (13")
 *   docs/              popup-light.png, popup-dark.png (README)
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../test/e2e/server.mjs';
import { iconSvg } from './icon-svg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'dist', 'chrome');
const OUT = path.join(ROOT, 'store');
const CAP = path.join(os.tmpdir(), `clink-captures-${process.pid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1. Real captures
// ---------------------------------------------------------------------------

async function capture() {
  await fs.mkdir(CAP, { recursive: true });
  const server = await startServer();
  const P = server.port;
  const userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clink-assets-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP * 127.0.0.1'],
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const extId = new URL(sw.url()).host;
    await sleep(800);
    for (const p of ctx.pages()) if (p.url().includes('options.html')) await p.close();

    // Browse a little, so the popup has real numbers and history.
    const tab = await ctx.newPage();
    for (const url of [
      `http://shop.example.com:${P}/sale?utm_source=newsletter&utm_campaign=black_friday&mc_eid=8f2a1c&item=9`,
      `http://video.example.com:${P}/watch?v=x7Kq2&gclid=Cj0KCQiA&utm_medium=cpc`,
      `http://recipes.example.com:${P}/soup?fbclid=IwAR2xQ9&utm_source=facebook`,
      `http://links.example.com:${P}/links`,
      `http://news.example.com:${P}/story/42?utm_source=twitter&utm_medium=social&utm_campaign=launch&fbclid=IwAR0z&id=3`,
    ]) {
      await tab.goto(url).catch(() => {});
      await sleep(250);
    }
    await sleep(800);
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url && t.url.includes('news.example.com')).id);

    for (const scheme of ['light', 'dark']) {
      const popup = await ctx.newPage({});
      await popup.emulateMedia({ colorScheme: scheme });
      await popup.setViewportSize({ width: 360, height: 900 });
      await popup.goto(`chrome-extension://${extId}/popup/popup.html?tab=${tabId}`);
      await popup.waitForSelector('body[data-ready]');
      await popup.fill('#cleanInput', 'https://shop.example.com/p/headphones?utm_source=newsletter&utm_campaign=bf&fbclid=IwAR2x&color=black');
      await sleep(200);
      const h = await popup.evaluate(() => document.documentElement.scrollHeight);
      await popup.setViewportSize({ width: 360, height: h });
      // Device scale 2 for crisp captures.
      const cdp = await ctx.newCDPSession(popup);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: h, deviceScaleFactor: 2, mobile: false });
      await sleep(100);
      await popup.locator('body').screenshot({ path: path.join(CAP, `popup-${scheme}.png`) });
      await popup.close();
    }

    const opts = await ctx.newPage();
    await opts.goto(`chrome-extension://${extId}/options/options.html`);
    await opts.waitForSelector('[data-category="trackers"]');
    const cdp = await ctx.newCDPSession(opts);
    // Exactly the settings column (680px + the page's 16px side padding).
    await opts.setViewportSize({ width: 712, height: 1000 });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 712, height: 1000, deviceScaleFactor: 2, mobile: false });
    await sleep(300);
    await opts.screenshot({ path: path.join(CAP, 'options.png') });
    await opts.close();
  } finally {
    await ctx.close();
    await server.close();
    await fs.rm(userDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 2. Layouts
// ---------------------------------------------------------------------------

const img = async (name) => `data:image/png;base64,${(await fs.readFile(path.join(CAP, name))).toString('base64')}`;
const appPage = async () => {
  const dir = path.join(ROOT, 'safari', 'app');
  const css = await fs.readFile(path.join(dir, 'Style.css'), 'utf8');
  const html = (await fs.readFile(path.join(dir, 'Main.html'), 'utf8'))
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]+>/, '') // allow the inline icon below
    .replace(/<link[^>]+>/, '').replace(/<script[^>]+><\/script>/, '')
    .replace('<body>', '<body class="platform-ios">')
    .replace('src="../Icon.png"', `src="data:image/svg+xml;base64,${Buffer.from(iconSvg({ size: 96, variant: 'mac' })).toString('base64')}"`);
  return { css, html };
};

const FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&family=Newsreader:opsz,wght@6..72,400;6..72,500&display=block" rel="stylesheet">';
const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; }
  :root { --page: #f5f3ee; --ink: #1d1c1a; --muted: #5f5c55; --blue: #2f6bf0; --orange: #ff8a4c; --card: #fff; --line: rgba(29,28,26,.1); }
  html, body { width: 100%; height: 100%; }
  body { background: var(--page); color: var(--ink); font-family: 'Hanken Grotesk', -apple-system, system-ui, sans-serif; overflow: hidden; }
  h1 { font-family: 'Newsreader', Georgia, serif; font-weight: 400; letter-spacing: -0.02em; line-height: 1.02; }
  .brand { display: flex; align-items: center; gap: 12px; font-weight: 600; font-size: 22px; letter-spacing: -0.01em; }
  .brand svg { width: 44px; height: 44px; }
  .lead { color: var(--muted); line-height: 1.4; }
  .shot { border-radius: 18px; box-shadow: 0 30px 60px -20px rgba(11,26,58,.35), 0 0 0 1px rgba(29,28,26,.08); background: #fff; }
  .url { font: 500 15px/1.5 ui-monospace, 'SF Mono', Menlo, monospace; padding: 14px 18px; border-radius: 14px; background: var(--card); border: 1px solid var(--line); word-break: break-all; }
  .url .lbl { display: block; font: 600 11px 'Hanken Grotesk', system-ui; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin-bottom: 4px; }
  .x { color: #c2410c; text-decoration: line-through; text-decoration-thickness: 2px; background: #fff1e8; border-radius: 4px; }
  .ok { color: var(--blue); }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 10px; }
  .pill { display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 999px; background: var(--card); border: 1px solid var(--line); font-weight: 500; }
`;

function desktopScene({ title, lead, visual, flip = false, dark = false }) {
  return `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>${BASE_CSS}
    body { display: grid; grid-template-columns: ${flip ? '1.1fr 1fr' : '1fr 1.1fr'}; align-items: center; gap: 56px; padding: 0 84px; ${dark ? '--page:#1f1e1d; --ink:#faf9f5; --muted:#b5b1a8; --card:#2a2927; --line:rgba(250,249,245,.1);' : ''} }
    .copy { ${flip ? 'order: 2;' : ''} display: flex; flex-direction: column; gap: 22px; }
    h1 { font-size: 64px; }
    .lead { font-size: 22px; max-width: 30ch; }
    .visual { display: flex; justify-content: center; align-items: center; }
  </style></head><body>
    <div class="copy"><div class="brand">${iconSvg({ size: 44, variant: 'glyph' })}Clink</div><h1>${title}</h1><p class="lead">${lead}</p></div>
    <div class="visual">${visual}</div>
  </body></html>`;
}

function phoneScene({ title, screen, w, h, dark = false }) {
  return `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>${BASE_CSS}
    body { display: flex; flex-direction: column; align-items: center; padding: ${h * 0.06}px ${w * 0.07}px 0; gap: ${h * 0.035}px; ${dark ? '--page:#1f1e1d; --ink:#faf9f5;' : ''} }
    h1 { font-size: ${w * 0.085}px; text-align: center; }
    .screen { flex: 1; width: 100%; border-radius: ${w * 0.09}px ${w * 0.09}px 0 0; overflow: hidden; border: ${w * 0.02}px solid #1d1c1a; border-bottom: 0; background: #fff; box-shadow: 0 30px 80px -30px rgba(11,26,58,.45); }
    .screen iframe { width: 100%; height: 100%; border: 0; display: block; }
  </style></head><body><h1>${title}</h1><div class="screen">${screen}</div></body></html>`;
}

async function render(page, html, file, w, h, scale = 1) {
  await page.setViewportSize({ width: w, height: h });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: scale, mobile: false });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file });
  await cdp.detach();
}

async function main() {
  await capture();
  const popupLight = await img('popup-light.png');
  const popupDark = await img('popup-dark.png');
  const options = await img('options.png');
  const app = await appPage();

  const dirty = `https://shop.example.com/sale?<span class="x">utm_source=newsletter</span>&amp;<span class="x">utm_campaign=bf</span>&amp;<span class="x">fbclid=IwAR2x9Qk</span>&amp;item=9`;
  const desktop = [
    ['1-clean-links', desktopScene({
      title: 'Clean links.<br>Never broken ones.',
      lead: 'Clink removes the tracking tags from every link you open, and keeps everything the link needs to work.',
      visual: `<img class="shot" src="${popupLight}" style="height:700px;width:auto">`,
    })],
    ['2-before-after', desktopScene({
      title: 'Only the tracking goes.',
      lead: 'utm_, fbclid, gclid, mc_eid, Amazon’s ref= and hundreds more, removed before the page even loads. Search terms, sizes and timestamps stay.',
      visual: `<div style="display:flex;flex-direction:column;gap:18px;width:100%">
        <div class="url"><span class="lbl">Before</span>${dirty}</div>
        <div class="url"><span class="lbl">After</span><span class="ok">https://shop.example.com/sale?item=9</span></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px">
          ${['utm_source', 'fbclid', 'gclid', 'mc_eid', 'si', 'igshid', 'ref=', 'msclkid'].map((p, i) => `<span class="pill"><span class="dot" style="background:${i % 2 ? 'var(--orange)' : 'var(--blue)'}"></span>${p}</span>`).join('')}
        </div></div>`,
    })],
    ['3-redirects', desktopScene({
      flip: true,
      title: 'Straight to the page.',
      lead: 'Links wrapped in click-trackers from search results, social networks and chat apps open their real destination directly.',
      visual: `<div style="display:flex;flex-direction:column;gap:16px;width:100%">
        <div class="url"><span class="lbl">The link you click</span><span class="x">https://www.google.com/url?q=</span>https://recipes.example.com/soup<span class="x">&amp;sa=D&amp;usg=AOvVaw2</span></div>
        <div style="text-align:center;font-size:30px;color:var(--orange)">↓</div>
        <div class="url"><span class="lbl">Where you go</span><span class="ok">https://recipes.example.com/soup</span></div>
      </div>`,
    })],
    ['4-link-guard', desktopScene({
      title: 'If a link needs a tag, it keeps it.',
      lead: 'Link Guard watches every link Clink cleans. If a page fails to load, the original opens instantly and Clink remembers that site.',
      visual: `<div style="display:flex;flex-direction:column;gap:14px;width:100%;font-size:18px">
        <div class="url" style="font-family:inherit"><span class="lbl">1 · Cleaned link</span><span style="color:#c2410c;font-weight:600">404 Not Found</span> on promo.example.com</div>
        <div class="url" style="font-family:inherit"><span class="lbl">2 · Link Guard</span>Reopens the original link, tags included</div>
        <div class="url" style="font-family:inherit"><span class="lbl">3 · Result</span><span class="ok" style="font-weight:600">Page loads ✓</span> · promo.example.com is remembered</div>
      </div>`,
    })],
    ['5-settings', desktopScene({
      flip: true,
      title: 'You’re in control.',
      lead: 'Pause Clink on any site, choose which kinds of tags to remove, and keep affiliate codes for creators you want to support.',
      visual: `<div class="shot" style="width:600px;height:640px;overflow:hidden;background:#f5f3ee;padding:0"><img src="${options}" style="width:100%;display:block"></div>`,
    })],
    ['6-private', desktopScene({
      dark: true,
      title: 'Private by design.',
      lead: 'Clink runs entirely in your browser: no account, no analytics, nothing sent anywhere. Free and open source under the GNU GPL v3.',
      visual: `<img class="shot" src="${popupDark}" style="height:700px;width:auto">`,
    })],
  ];

  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [name, html] of desktop) {
    await render(page, html, path.join(OUT, 'chrome', `${name}.png`), 1280, 800, 1);
    await fs.copyFile(path.join(OUT, 'chrome', `${name}.png`), path.join(await mk(OUT, 'firefox'), `${name}.png`));
    await render(page, html, path.join(OUT, 'apple', 'mac', `${name}.png`), 1280, 800, 2);
    console.log('  desktop', name);
  }

  // Promo tiles (Chrome Web Store)
  const tile = (w, h, big) => `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>${BASE_CSS}
    body { display: flex; align-items: center; justify-content: center; gap: ${big ? 48 : 22}px; background: linear-gradient(135deg, #ffffff, #eef1f7); }
    .t h1 { font-size: ${big ? 92 : 46}px; } .t p { font-size: ${big ? 30 : 17}px; color: var(--muted); margin-top: ${big ? 10 : 6}px; }
    .i svg { width: ${big ? 260 : 130}px; height: ${big ? 260 : 130}px; display: block; }
  </style></head><body><div class="i">${iconSvg({ size: 512, variant: 'mac' })}</div><div class="t"><h1>Clink</h1><p>Clean links.<br>Never broken ones.</p></div></body></html>`;
  await render(page, tile(440, 280, false), path.join(OUT, 'chrome', 'promo-small-440x280.png'), 440, 280);
  await render(page, tile(1400, 560, true), path.join(OUT, 'chrome', 'promo-marquee-1400x560.png'), 1400, 560);

  // iPhone 6.9" (440×956 pt @3x) and iPad 13" (1032×1376 pt @2x)
  const popupFrame = (src, bg) => `<div style="height:100%;background:${bg};display:flex;justify-content:center;padding-top:24px"><img src="${src}" style="width:92%;align-self:flex-start;border-radius:14px"></div>`;
  const appFrame = `<iframe srcdoc="${(`<style>${app.css}</style>` + app.html).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe>`;
  const mobile = [
    ['1-clean-links', 'Clean links.<br>Never broken ones.', popupFrame(popupLight, '#f5f3ee'), false],
    ['2-turn-on', 'Turn it on once.<br>Every link, cleaned.', appFrame, false],
    ['3-private', 'Private by design.<br>Free and open source.', popupFrame(popupDark, '#1f1e1d'), true],
  ];
  for (const [name, title, screen, dark] of mobile) {
    await render(page, phoneScene({ title, screen, w: 440, h: 956, dark }), path.join(OUT, 'apple', 'iphone', `${name}.png`), 440, 956, 3);
    await render(page, phoneScene({ title, screen, w: 1032, h: 1376, dark }), path.join(OUT, 'apple', 'ipad', `${name}.png`), 1032, 1376, 2);
    console.log('  mobile', name);
  }
  await browser.close();

  await fs.copyFile(path.join(CAP, 'popup-light.png'), path.join(ROOT, 'docs', 'popup-light.png'));
  await fs.copyFile(path.join(CAP, 'popup-dark.png'), path.join(ROOT, 'docs', 'popup-dark.png'));
  await fs.rm(CAP, { recursive: true, force: true });
  console.log('Store artwork written to store/ and docs/.');
}

async function mk(...p) {
  const d = path.join(...p);
  await fs.mkdir(d, { recursive: true });
  return d;
}

await main();
