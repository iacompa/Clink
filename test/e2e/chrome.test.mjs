// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * End-to-end test: loads dist/chrome into real Chromium and checks both
 * cleaning layers, the safety exceptions, Link Guard and the UI pages.
 * Every hostname is routed to a local test server, so "www.amazon.com" etc.
 * never touch the internet.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXT = path.join(ROOT, 'dist', 'chrome');
const SHOTS = path.join(ROOT, 'test', 'screenshots');

let server, ctx, sw, P, SP, extId;
let userDir;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (u) => u.replace(`:${P}`, '').replace(`:${SP}`, '');

async function waitForUrl(page, re, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (re.test(page.url())) {
      await page.waitForLoadState('load').catch(() => {});
      return;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${re}; at ${page.url()}`);
}

async function setSettings(patch) {
  await sw.evaluate(async (patch) => {
    const defaults = globalThis.ClinkSettings.DEFAULTS;
    await chrome.storage.local.set({ settings: Object.assign({}, defaults, patch) });
    await new Promise((r) => setTimeout(r, 50));
    // eslint-disable-next-line no-undef
    await applyChain;
  }, patch);
}

async function getSettings() {
  return sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
}

async function openTab(url) {
  const page = await ctx.newPage();
  if (url) await page.goto(url).catch(() => {});
  return page;
}

before(async () => {
  server = await startServer();
  P = server.port;
  SP = server.httpsPort;
  userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clink-e2e-'));
  ctx = await chromium.launchPersistentContext(userDir, {
    channel: 'chromium',
    headless: true,
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--host-resolver-rules=MAP * 127.0.0.1',
      '--disable-features=HttpsUpgrades',
      '--ignore-certificate-errors',
    ],
  });
  [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  extId = new URL(sw.url()).host;
  await sleep(500);
  // close the welcome tab opened on install
  for (const p of ctx.pages()) if (p.url().includes('options.html')) await p.close();
  await fs.mkdir(SHOTS, { recursive: true });
});

after(async () => {
  await ctx?.close();
  await server?.close();
  if (userDir) await fs.rm(userDir, { recursive: true, force: true }).catch(() => {});
});

test('network layer cleans typed/opened URLs before they reach the server', async () => {
  await setSettings({});
  const page = await openTab();
  const resp = await page.goto(`http://shop.example.com:${P}/p?utm_source=news&fbclid=IwAR&keep=1&q=a%20b+c`);
  assert.equal(strip(page.url()), 'http://shop.example.com/p?keep=1&q=a%20b+c');
  assert.equal(resp.status(), 200);
  const leaked = server.hits.filter((h) => h.host === 'shop.example.com' && /utm_|fbclid/.test(h.search));
  assert.equal(leaked.length, 0, 'the tracking parameters must never reach the server');
  await page.close();
});

test('links from email click-trackers are cleaned after the redirect, and counted', async () => {
  const page = await openTab();
  const before = server.hits.length;
  await page.goto(`http://click.mailer.example.com:${P}/click/abc123`);
  assert.equal(strip(page.url()), 'http://shop.example.com/sale?item=9');
  assert.equal(server.hits.slice(before).filter((h) => /utm_|mc_eid/.test(h.search)).length, 0);
  await sleep(300);
  const recent = await sw.evaluate(async () => (await chrome.storage.session.get('recent')).recent || []);
  const entry = recent.find((e) => e.host === 'shop.example.com' && e.kind === 'navigation');
  assert.ok(entry, 'navigation was logged');
  assert.deepEqual(entry.removed.sort(), ['mc_eid', 'utm_campaign', 'utm_source']);
  await page.close();
});

test('site rules: Amazon path + params + affiliate, YouTube keeps t, X strips t', async () => {
  const page = await openTab();
  await page.goto(`https://www.amazon.com:${SP}/Echo-Dot/dp/B09B8V1LZ3/ref=sr_1_1?crid=2X&keywords=echo&qid=170&sr=8-1&th=1&psc=1&tag=me-20`);
  assert.equal(strip(page.url()), 'https://www.amazon.com/Echo-Dot/dp/B09B8V1LZ3?keywords=echo&th=1&psc=1');

  await page.goto(`https://youtu.be:${SP}/dQw4w9WgXcQ?si=abc&t=42`);
  assert.equal(strip(page.url()), 'https://youtu.be/dQw4w9WgXcQ?t=42');

  await page.goto(`https://x.com:${SP}/u/status/1?s=20&t=abc`);
  assert.equal(strip(page.url()), 'https://x.com/u/status/1');

  await page.goto(`https://www.google.com:${SP}/search?q=clink&oq=clink&ved=0a&ei=1&ie=UTF-8`);
  assert.equal(strip(page.url()), 'https://www.google.com/search?q=clink&ie=UTF-8');

  await page.goto(`http://store.example.com:${P}/products/mug?_pos=1&_sid=a1&_ss=r&variant=4`);
  assert.equal(strip(page.url()), 'http://store.example.com/products/mug?variant=4');
  await page.close();
});

test('protected URLs are never modified', async () => {
  const page = await openTab();
  const keep = [
    `http://news.example.com:${P}/unsubscribe?mc_eid=1&utm_source=x`,
    `http://files.example.com:${P}/f.pdf?X-Amz-Signature=abc&utm_source=x`,
    `http://dev.test:${P}/?utm_source=x`,
    `https://github.com:${SP}/o/r/blob/main/a.js?ref=v2`,
    `https://www.youtube.com:${SP}/watch?v=abc&t=42s`,
    `https://accounts.google.com:${SP}/signin?utm_source=x&continue=1`,
  ];
  for (const url of keep) {
    await page.goto(url);
    assert.equal(page.url(), url);
  }
  await page.close();
});

test('page layer rewrites links, unwraps redirects, removes ping beacons', async () => {
  const page = await openTab(`http://links.example.com:${P}/links`);
  await page.waitForSelector('#late');
  await sleep(150);
  const href = (sel) => page.$eval(sel, (a) => a.getAttribute('href'));
  assert.equal(strip(await href('#plain')), 'http://dest.example.com/article?id=7');
  assert.equal(strip(await href('#wrapped')), 'http://dest.example.com/wrapped?k=1');
  assert.equal(strip(await href('#late')), 'http://dest.example.com/late?ok=1');
  assert.equal(strip(await href('#relative')), 'http://links.example.com/rel?page=2');
  assert.equal(strip(await href('#keep')), 'http://dest.example.com/keep?ref=friend&t=10&s=2');
  assert.equal(strip(await href('#unsub')), 'http://dest.example.com/unsubscribe?mc_eid=abc&list=1');
  assert.equal(await page.$eval('#ping', (a) => a.hasAttribute('ping')), false);

  // Badge shows how many links were cleaned on this page
  await sleep(500);
  const badge = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url && x.url.includes('links.example.com'));
    return chrome.action.getBadgeText({ tabId: t.id });
  });
  assert.ok(Number(badge) >= 4, `badge was "${badge}"`);
  await page.screenshot({ path: path.join(SHOTS, 'links-page.png') });
  await page.close();
});

test('href swapped to a tracking redirect at click time is still skipped', async () => {
  const page = await openTab(`http://links.example.com:${P}/links`);
  const before = server.hits.length;
  await Promise.all([page.waitForURL(/after-swap/), page.click('#swapwrap')]);
  assert.equal(strip(page.url()), 'http://dest.example.com/after-swap?ok=1');
  const wrapperHits = server.hits.slice(before).filter((h) => h.path === '/url');
  assert.equal(wrapperHits.length, 0, 'the google.com/url tracking hop must be skipped');
  await page.close();
});

test('links inside shadow DOM are cleaned at click time', async () => {
  const page = await openTab(`http://links.example.com:${P}/links`);
  const before = server.hits.length;
  await Promise.all([page.waitForURL(/from-shadow/), page.locator('#host >> #shadow').click()]);
  assert.equal(strip(page.url()), 'http://dest.example.com/from-shadow');
  assert.equal(server.hits.slice(before).filter((h) => h.path === '/url').length, 0);
  await page.close();
});

test('copying a URL from page text copies the clean version', async () => {
  const page = await openTab(`http://links.example.com:${P}/links`);
  const copied = await page.evaluate(() => {
    const p = document.getElementById('copytext');
    const r = document.createRange();
    r.selectNodeContents(p);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    const dt = new DataTransfer();
    const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    return { text: dt.getData('text/plain'), prevented: ev.defaultPrevented };
  });
  assert.equal(copied.prevented, true);
  assert.equal(strip(copied.text), 'http://dest.example.com/copied?x=1');
  await page.close();
});

test('Link Guard: a link that 404s without its parameter is restored and remembered', async () => {
  await setSettings({});
  const page = await openTab();
  await page.goto(`http://guard.example.com:${P}/needs-utm?utm_source=promo&a=1`).catch(() => {});
  await waitForUrl(page, /utm_source=promo/);
  assert.match(await page.textContent('body'), /needs-utm ok/);
  let s;
  for (let i = 0; i < 20; i++) {
    s = await getSettings();
    if (s.guardedSites.length) break;
    await sleep(100);
  }
  assert.deepEqual(s.guardedSites.map((g) => g.host), ['guard.example.com']);
  assert.deepEqual(s.guardedSites[0].params, ['utm_source']);
  await sleep(200);
  // From now on links to that site keep their parameters
  await page.goto(`http://guard.example.com:${P}/needs-utm?utm_source=again`);
  assert.match(page.url(), /utm_source=again/);
  // …but other sites are still cleaned
  await page.goto(`http://other.example.com:${P}/x?utm_source=a&ok=1`);
  assert.equal(strip(page.url()), 'http://other.example.com/x?ok=1');
  await page.close();
});

test('Link Guard: a redirect loop caused by stripping is recovered', async () => {
  await setSettings({});
  const page = await openTab();
  await page.goto(`http://loop.example.com:${P}/loop`).catch(() => {});
  await waitForUrl(page, /loop\?fbclid=server-added/);
  assert.match(await page.textContent('body'), /loop ok/);
  let s;
  for (let i = 0; i < 30 && !s?.guardedSites.some((g) => g.host === 'loop.example.com'); i++) {
    if (i) await sleep(100);
    s = await getSettings();
  }
  assert.deepEqual(s.guardedSites.map((g) => [g.host, g.reason]), [['loop.example.com', 'redirect loop']]);
  // Remembered: going back to the site later works straight away.
  await page.goto(`http://loop.example.com:${P}/loop`);
  assert.match(strip(page.url()), /^http:\/\/loop\.example\.com\/loop\?fbclid=server-added$/);
  await page.close();
});

test('settings: pause a site, toggle categories, master switch', async () => {
  const page = await openTab();

  await setSettings({ pausedSites: ['paused.example.com'] });
  await page.goto(`http://www.paused.example.com:${P}/x?utm_source=a&fbclid=b`);
  assert.match(page.url(), /utm_source=a&fbclid=b/);
  await page.goto(`http://links.example.com:${P}/links`);
  assert.equal(strip(await page.$eval('#plain', (a) => a.getAttribute('href'))), 'http://dest.example.com/article?id=7');

  await setSettings({ categories: { trackers: true, campaign: false, sites: true, affiliate: true } });
  await page.goto(`http://cat.example.com:${P}/x?utm_source=a&fbclid=b`);
  assert.equal(strip(page.url()), 'http://cat.example.com/x?utm_source=a');

  await setSettings({ enabled: false });
  await page.goto(`http://off.example.com:${P}/x?utm_source=a&fbclid=b`);
  assert.equal(strip(page.url()), 'http://off.example.com/x?utm_source=a&fbclid=b');
  await page.goto(`http://links.example.com:${P}/links`);
  assert.match(await page.$eval('#plain', (a) => a.getAttribute('href')), /utm_source/);

  // Turning a paused site back on cleans its links without a reload
  await setSettings({ pausedSites: ['links.example.com'] });
  await page.goto(`http://links.example.com:${P}/links`);
  assert.match(await page.$eval('#plain', (a) => a.getAttribute('href')), /utm_source/);
  await setSettings({});
  await sleep(200);
  assert.equal(strip(await page.$eval('#plain', (a) => a.getAttribute('href'))), 'http://dest.example.com/article?id=7');
  await page.close();
});

test('popup and settings pages render without errors', async () => {
  await setSettings({});
  const site = await openTab(`http://links.example.com:${P}/links`);
  await site.goto(`http://news.example.com:${P}/story?utm_source=twitter&fbclid=abc&id=3`);
  await sleep(400);
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url && t.url.includes('news.example.com')).id);

  const errors = [];
  const popup = await ctx.newPage();
  popup.on('pageerror', (e) => errors.push(e.message));
  popup.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await popup.setViewportSize({ width: 360, height: 640 });
  await popup.goto(`chrome-extension://${extId}/popup/popup.html?tab=${tabId}`);
  await popup.waitForSelector('body[data-ready]');
  assert.equal(await popup.textContent('#siteHost'), 'news.example.com');
  assert.equal(await popup.isVisible('#navClean'), true, 'shows that the page address was cleaned');
  assert.deepEqual((await popup.$$eval('#navChips .chip', (els) => els.map((e) => e.textContent))).sort(), ['fbclid', 'utm_source']);
  await popup.fill('#cleanInput', 'https://www.amazon.com/dp/B000000001/ref=x?tag=a-20&pd_rd_w=1&th=1');
  assert.equal(await popup.textContent('#cleanUrl'), 'https://www.amazon.com/dp/B000000001?th=1');
  await popup.screenshot({ path: path.join(SHOTS, 'popup.png'), fullPage: true });

  const opts = await ctx.newPage();
  opts.on('pageerror', (e) => errors.push(e.message));
  await opts.setViewportSize({ width: 900, height: 1200 });
  await opts.goto(`chrome-extension://${extId}/options/options.html#welcome`);
  await opts.waitForSelector('[data-category="trackers"]');
  await opts.screenshot({ path: path.join(SHOTS, 'options.png'), fullPage: true });

  assert.deepEqual(errors, []);
  await popup.close();
  await opts.close();
  await site.close();
});
