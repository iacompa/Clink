// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * End-to-end test in real Firefox (the installed app), driven over WebDriver
 * BiDi — no extra dependencies. Skipped automatically if Firefox isn't installed.
 *   FIREFOX_BIN=/path/to/firefox npm run test:e2e
 *
 * BiDi won't navigate a tab to moz-extension:// pages, so the browser is started
 * with system access (MOZ_REMOTE_ALLOW_SYSTEM_ACCESS) and extension pages are
 * opened from the browser chrome with the system principal.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXT = path.join(ROOT, 'dist', 'firefox');
const SHOTS = path.join(ROOT, 'test', 'screenshots');
const FIREFOX = process.env.FIREFOX_BIN || findFirefox();
const HAVE_FIREFOX = !!FIREFOX && fs.existsSync(FIREFOX);
const SKIP = !HAVE_FIREFOX && 'Firefox not installed';
const UUID = 'c1a7c1a7-0000-4000-8000-c11c4c11c400';
const EXT_ORIGIN = `moz-extension://${UUID}`;
const HOSTS = ['shop.example.com', 'links.example.com', 'dest.example.com', 'www.google.com', 'guard.example.com',
  'loop.example.com', 'click.mailer.example.com', 'www.amazon.com', 'youtu.be', 'news.example.com', 'tracker.example.com',
  'pageguard.example.com', 'www.wguard.example.com', 'wguard.example.com'];

/** The installed Firefox: the macOS app, or `firefox` on the PATH (Linux, CI). */
function findFirefox() {
  if (process.platform === 'darwin') return '/Applications/Firefox.app/Contents/MacOS/firefox';
  try {
    return execFileSync('which', ['firefox'], { encoding: 'utf8' }).trim();
  } catch (_) {
    return '';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server, P, SP, proc, ws, profile;
let context; // the tab the tests browse in
let chromeWindow; // privileged browser-chrome realm
let probe; // an extension page used to inspect Clink's state
let msgId = 0;
const waiting = new Map();
const logErrors = [];

// ---------------------------------------------------------------------------
// Minimal WebDriver BiDi client
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((r) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => r(port));
    });
  });
}

function bidi(method, params = {}, timeout = 30000) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => waiting.delete(id) && reject(new Error(`${method} timed out`)), timeout);
    const done = (fn) => (v) => (clearTimeout(timer), fn(v));
    waiting.set(id, { resolve: done(resolve), reject: done(reject) });
  });
}

async function evaluate(ctx, expression) {
  const r = await bidi('script.evaluate', { expression, target: { context: ctx }, awaitPromise: true });
  if (r.type === 'exception') throw new Error(r.exceptionDetails.text);
  return r.result;
}
const evalIn = async (expression, ctx = context) => (await evaluate(ctx, expression)).value;
/** Evaluate inside an extension page, where `browser.*` is available. */
const inExt = (expression) => evalIn(expression, probe);

async function until(fn, what, timeout = 10000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

async function go(url, ctx = context) {
  try {
    await bidi('browsingContext.navigate', { context: ctx, url, wait: 'complete' });
  } catch (_) {
    /* error pages / aborted navigations are inspected by the caller */
  }
  return currentUrl(ctx);
}

async function currentUrl(ctx = context) {
  const tree = await bidi('browsingContext.getTree', { root: ctx });
  return tree.contexts[0].url;
}

const waitForUrl = (re, ctx = context) => until(async () => {
  const u = await currentUrl(ctx);
  return re.test(u) && u;
}, `URL ${re}`);

/** Open an extension page in a new tab and return its browsing context. */
async function openExtensionPage(pagePath) {
  const before = new Set((await bidi('browsingContext.getTree', {})).contexts.map((c) => c.context));
  const url = `${EXT_ORIGIN}/${pagePath}`;
  await evaluate(chromeWindow, `gBrowser.addTab(${JSON.stringify(url)}, {
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }) && true`);
  const ctx = await until(async () => {
    const { contexts } = await bidi('browsingContext.getTree', {});
    const c = contexts.find((x) => !before.has(x.context) && x.url.startsWith(EXT_ORIGIN));
    return c && c.context;
  }, `extension page ${pagePath}`);
  await until(() => evalIn(`document.readyState === 'complete'`, ctx), `${pagePath} to load`);
  return ctx;
}

/** A real mouse click (pointer down → up) on an element, like a user would. */
async function click(selectorExpr) {
  const node = await evaluate(context, selectorExpr);
  assert.ok(node.sharedId, `element ${selectorExpr} not found`);
  await bidi('input.performActions', {
    context,
    actions: [{
      type: 'pointer',
      id: 'mouse',
      parameters: { pointerType: 'mouse' },
      actions: [
        { type: 'pointerMove', x: 0, y: 0, origin: { type: 'element', element: { sharedId: node.sharedId } } },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 30 },
        { type: 'pointerUp', button: 0 },
      ],
    }],
  });
}

/**
 * Screenshot of an extension page. BiDi refuses privileged (moz-extension)
 * contexts for setViewport/captureScreenshot, so draw it from the browser chrome.
 */
async function snapshotExtensionPage(ctx, file, width) {
  const href = await evalIn('location.href', ctx);
  await evaluate(chromeWindow, `(() => {
    gBrowser.selectedTab = gBrowser.tabs.find((t) => t.linkedBrowser.currentURI.spec === ${JSON.stringify(href)});
    window.resizeTo(${width} + window.outerWidth - gBrowser.selectedBrowser.clientWidth, 1000);
  })()`);
  await until(() => evalIn(`document.documentElement.clientWidth === ${width}`, ctx), `window width ${width}`, 3000)
    .catch(() => {}); // best effort — the screenshot is still useful
  const [w, h] = JSON.parse(await evalIn(`JSON.stringify([document.documentElement.clientWidth, document.documentElement.scrollHeight])`, ctx));
  // Snapshots are capped at ~4096px, so long pages are drawn at a smaller scale.
  const dataUrl = (await evaluate(chromeWindow, `(async () => {
    const bmp = await gBrowser.selectedBrowser.browsingContext.currentWindowGlobal.drawSnapshot(new DOMRect(0, 0, ${w}, ${h}), ${Math.min(2, 4000 / h).toFixed(3)}, 'white');
    const c = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    return c.toDataURL('image/png');
  })()`)).value;
  await fsp.writeFile(path.join(SHOTS, file), Buffer.from(dataUrl.split(',')[1], 'base64'));
}

const strip = (u) => u.replace(`:${P}`, '').replace(`:${SP}`, '');
const settings = () => inExt(`browser.storage.local.get('settings').then((r) => JSON.stringify(r.settings || {}))`).then(JSON.parse);

// ---------------------------------------------------------------------------

before(async () => {
  if (!HAVE_FIREFOX) return;
  server = await startServer();
  P = server.port;
  SP = server.httpsPort;
  profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'clink-ff-'));
  const prefs = {
    'network.dns.localDomains': HOSTS.join(','),
    'network.proxy.type': 0,
    'dom.security.https_first': false,
    'dom.security.https_only_mode': false,
    'browser.shell.checkDefaultBrowser': false,
    'datareporting.policy.dataSubmissionEnabled': false,
    'app.update.enabled': false,
    'browser.startup.homepage_override.mstone': 'ignore',
    'extensions.webextensions.uuids': JSON.stringify({ 'clink@clean-links': UUID }),
    'privacy.query_stripping.enabled': false, // make sure it's Clink doing the work, not Firefox
  };
  await fsp.writeFile(path.join(profile, 'user.js'),
    Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n'));

  const port = await freePort();
  proc = spawn(FIREFOX, ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', String(port)], {
    stdio: 'ignore',
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
  });
  for (let i = 0; i < 150; i++) {
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
      await new Promise((res, rej) => {
        ws.onopen = res;
        ws.onerror = rej;
      });
      break;
    } catch (_) {
      await sleep(200);
    }
  }
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.type === 'error') w.reject(new Error(`${m.error}: ${m.message}`));
      else w.resolve(m.result);
    } else if (m.method === 'log.entryAdded' && m.params.level === 'error') {
      logErrors.push({ url: m.params.source?.context, text: m.params.text });
    }
  };
  await bidi('session.new', { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } }, 60000);
  await bidi('session.subscribe', { events: ['log.entryAdded'] });
  const top = await bidi('browsingContext.getTree', {});
  context = top.contexts[0].context;
  await bidi('webExtension.install', { extensionData: { type: 'path', path: EXT } });

  const chrome = await bidi('browsingContext.getTree', { 'moz:scope': 'chrome' });
  chromeWindow = chrome.contexts.find((c) => c.url.includes('browser.xhtml')).context;
  probe = await openExtensionPage('options/options.html');
  // Wait until the background has applied its rules.
  await until(() => inExt(`browser.declarativeNetRequest.getEnabledRulesets().then((r) => r.length === 5)`), 'rulesets enabled');
  await fsp.mkdir(SHOTS, { recursive: true });
});

after(async () => {
  if (!HAVE_FIREFOX) return;
  try {
    await bidi('session.end', {}, 5000);
  } catch (_) {
    /* ignore */
  }
  ws?.close();
  proc?.kill();
  await server?.close();
  if (profile) await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
});

test('Firefox: host permission is granted on install', { skip: SKIP }, async () => {
  assert.equal(await inExt(`browser.permissions.contains({ origins: ['<all_urls>'] })`), true);
});

test('Firefox: network layer cleans navigations before they reach the server', { skip: SKIP }, async () => {
  const u = await go(`http://shop.example.com:${P}/p?utm_source=news&fbclid=IwAR&keep=1`);
  assert.equal(strip(u), 'http://shop.example.com/p?keep=1');
  assert.equal(server.hits.filter((h) => /utm_|fbclid/.test(h.search) && h.host === 'shop.example.com').length, 0,
    'the tracker never reached the server');

  assert.equal(strip(await go(`https://www.amazon.com:${SP}/Echo/dp/B09B8V1LZ3/ref=sr_1_1?qid=1&th=1&tag=x-20`)),
    'https://www.amazon.com/Echo/dp/B09B8V1LZ3?th=1');
  assert.equal(strip(await go(`https://youtu.be:${SP}/abc?si=zzz&t=42`)), 'https://youtu.be/abc?t=42');
  // email click-tracker → redirect to a tagged URL → cleaned after the redirect
  assert.equal(strip(await go(`http://click.mailer.example.com:${P}/click/x`)), 'http://shop.example.com/sale?item=9');
  // protected: unsubscribe links keep their IDs
  const unsub = `http://news.example.com:${P}/unsubscribe?mc_eid=1&utm_source=x`;
  assert.equal(await go(unsub), unsub);
});

test('Firefox: page layer rewrites links, unwraps redirects, removes ping beacons', { skip: SKIP }, async () => {
  await go(`http://links.example.com:${P}/links`);
  await until(() => evalIn(`!!document.getElementById('late')`), 'the late link');
  const h = JSON.parse(await until(() => evalIn(`(() => {
    const get = (id) => document.getElementById(id).getAttribute('href');
    const late = get('late');
    return late.includes('mc_eid') ? '' : JSON.stringify({ plain: get('plain'), wrapped: get('wrapped'), late, keep: get('keep'),
      unsub: get('unsub'), relative: get('relative') });
  })()`), 'late link to be cleaned'));
  assert.equal(strip(h.plain), 'http://dest.example.com/article?id=7');
  assert.equal(strip(h.wrapped), 'http://dest.example.com/wrapped?k=1');
  assert.equal(strip(h.late), 'http://dest.example.com/late?ok=1');
  assert.equal(strip(h.keep), 'http://dest.example.com/keep?ref=friend&t=10&s=2');
  assert.equal(strip(h.unsub), 'http://dest.example.com/unsubscribe?mc_eid=abc&list=1');
  assert.equal(strip(h.relative), 'http://links.example.com/rel?page=2');
  assert.equal(await evalIn(`document.getElementById('ping').hasAttribute('ping')`), false);
});

test('Firefox: href swapped to a tracking redirect at click time is still skipped', { skip: SKIP }, async () => {
  await go(`http://links.example.com:${P}/links`);
  const hitsBefore = server.hits.length;
  await click(`document.getElementById('swapwrap')`);
  const u = await waitForUrl(/after-swap/);
  assert.equal(strip(u), 'http://dest.example.com/after-swap?ok=1');
  const newHits = server.hits.slice(hitsBefore);
  assert.equal(newHits.filter((x) => x.host === 'www.google.com').length, 0, 'the redirect wrapper was never contacted');
});

test('Firefox: links inside shadow DOM are cleaned at click time', { skip: SKIP }, async () => {
  await go(`http://links.example.com:${P}/links`);
  await click(`document.getElementById('host').shadowRoot.getElementById('shadow')`);
  assert.equal(strip(await waitForUrl(/from-shadow/)), 'http://dest.example.com/from-shadow');
});

test('Firefox: links inside rich-text editors are never rewritten', { skip: SKIP }, async () => {
  await go(`http://links.example.com:${P}/links`);
  await until(() => evalIn(`!!document.getElementById('edlate') && document.getElementById('plain').getAttribute('href').indexOf('utm_') < 0`), 'page scan');
  const get = (id) => evalIn(`document.getElementById('${id}').getAttribute('href')`).then(strip);
  assert.equal(await get('edlink'), 'http://dest.example.com/edited?utm_source=draft&x=1');
  assert.equal(await get('edlate'), 'http://dest.example.com/pasted?fbclid=x&p=1');
  assert.equal(await get('cmslink'), 'http://dest.example.com/cms?y=1');
  await evalIn(`document.getElementById('cms').setAttribute('contenteditable', 'true')`);
  await until(async () => (await get('cmslink')).includes('utm_source=cms'), 'editable region to get its link back');
});

test('Firefox: same-document #links are left alone', { skip: SKIP }, async () => {
  await go(`http://links.example.com:${P}/links`);
  const doc = `document.getElementById('frame').contentDocument`;
  await until(() => evalIn(`!!${doc}.getElementById('framelink') && !${doc}.getElementById('framelink').getAttribute('href').includes('utm_')`), 'frame scan');
  assert.equal(await evalIn(`${doc}.getElementById('hashlink').getAttribute('href')`), '#faq');
});

test('Firefox: Link Guard also covers links the page layer cleaned', { skip: SKIP }, async () => {
  await go(`http://links.example.com:${P}/links`);
  await until(() => evalIn(`document.getElementById('guardlink').getAttribute('href').indexOf('utm_') < 0`), 'guardlink cleaned');
  await click(`document.getElementById('guardlink')`);
  await waitForUrl(/pageguard\.example\.com.*utm_source=promo/);
  await until(async () => /needs-utm ok/.test(await evalIn(`document.body ? document.body.textContent : ''`)), 'restored page');
  await until(async () => ((await settings()).guardedSites || []).some((g) => g.host === 'pageguard.example.com'), 'pageguard remembered');

  await go(`http://links.example.com:${P}/links`);
  await until(() => evalIn(`document.getElementById('plain').getAttribute('href').indexOf('utm_') < 0`), 'page scan');
  await click(`document.getElementById('wguardlink')`);
  await waitForUrl(/\/\/wguard\.example\.com.*utm_source=promo/);
  await until(async () => /needs-utm ok/.test(await evalIn(`document.body ? document.body.textContent : ''`)), 'restored page');
});

test('Firefox: Link Guard restores a link that 404s and remembers the site', { skip: SKIP }, async () => {
  await go(`http://guard.example.com:${P}/needs-utm?utm_source=promo&a=1`);
  await waitForUrl(/utm_source=promo/);
  assert.match(await evalIn(`document.body.textContent`), /needs-utm ok/, 'the restored page works');
  const s = await until(async () => {
    const st = await settings();
    return (st.guardedSites || []).some((g) => g.host === 'guard.example.com') && st;
  }, 'guard.example.com to be remembered');
  assert.deepEqual(s.guardedSites.find((g) => g.host === 'guard.example.com').params, ['utm_source']);
  // Remembered: the next link to that site is left alone right away.
  assert.match(await go(`http://guard.example.com:${P}/needs-utm?utm_source=again`), /utm_source=again/);
});

test('Firefox: Link Guard recovers a redirect loop caused by stripping', { skip: SKIP }, async () => {
  await go(`http://loop.example.com:${P}/loop`);
  await waitForUrl(/loop\?fbclid=server-added/);
  assert.match(await evalIn(`document.body.textContent`), /loop ok/);
});

test('Firefox: popup and settings pages render without errors', { skip: SKIP }, async () => {
  await go(`http://news.example.com:${P}/story?utm_source=twitter&fbclid=abc&id=3`);
  const tabId = await until(() => inExt(`browser.tabs.query({}).then((ts) => {
    const t = ts.find((x) => x.url && x.url.startsWith('http') && new URL(x.url).hostname === 'news.example.com' && new URL(x.url).pathname === '/story');
    return t ? t.id : 0;
  })`), 'the news tab');
  const errorsBefore = logErrors.length;

  const popup = await openExtensionPage(`popup/popup.html?tab=${tabId}`);
  await until(() => evalIn(`document.body.dataset.ready === '1'`, popup), 'popup to render');
  assert.equal(await evalIn(`document.getElementById('siteHost').textContent`, popup), 'news.example.com');
  assert.equal(await evalIn(`!document.getElementById('navClean').classList.contains('hidden')`, popup), true,
    'shows that the page address was cleaned');
  const chips = JSON.parse(await evalIn(`JSON.stringify([...document.querySelectorAll('#navChips .chip')].map((e) => e.textContent))`, popup));
  assert.deepEqual(chips.sort(), ['fbclid', 'utm_source']);
  assert.equal(await evalIn(`(() => {
    const i = document.getElementById('cleanInput');
    i.value = 'https://www.amazon.com/dp/B000000001/ref=x?tag=a-20&pd_rd_w=1&th=1';
    i.dispatchEvent(new Event('input'));
    return document.getElementById('cleanUrl').textContent;
  })()`, popup), 'https://www.amazon.com/dp/B000000001?th=1');
  await snapshotExtensionPage(popup, 'firefox-popup.png', 388);

  // Settings page: all four categories, and the site Link Guard learned is listed.
  await evalIn(`setTimeout(() => location.reload(), 0), true`, probe);
  await sleep(300);
  await until(() => evalIn(`document.readyState === 'complete' && document.querySelectorAll('[data-category]').length === 4`, probe), 'categories');
  await until(() => evalIn(`document.body.textContent.includes('guard.example.com')`, probe), 'Link Guard list');
  await snapshotExtensionPage(probe, 'firefox-options.png', 860);

  const pageErrors = logErrors.slice(errorsBefore).filter((e) => e.url === popup || e.url === probe);
  assert.deepEqual(pageErrors, []);
});
