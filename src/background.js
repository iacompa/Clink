// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Clink background worker (Chrome service worker / Firefox & Safari event page).
 *
 *  • Keeps the declarativeNetRequest rulesets in sync with the user's settings
 *    (category toggles, master switch, paused sites).
 *  • Link Guard: watches navigations Clink cleaned — addresses cleaned by the
 *    network rules and links cleaned on the page. If the cleaned URL fails
 *    (HTTP 4xx/500 or a redirect loop) it reloads the ORIGINAL link once with
 *    Clink bypassed for that site in that tab; if the original works, the site
 *    is remembered so Clink never breaks it again.
 *  • Per-tab badge counts, lifetime stats and a short "recent activity" log
 *    (host + parameter names only — never full URLs).
 */
'use strict';

if (typeof importScripts === 'function' && !globalThis.ClinkCleaner) {
  importScripts('shared/rules.js', 'shared/cleaner.js', 'shared/settings.js');
}

const api = globalThis.browser || globalThis.chrome;
const C = globalThis.ClinkCleaner;
const S = globalThis.ClinkSettings;
const dnr = api.declarativeNetRequest;

const CATEGORY_RULESETS = ['trackers', 'campaign', 'sites', 'affiliate', 'strict'];
const SAFETY_RULESET = 'safety';
const PAUSE_PRIORITY = 200;
const TRIAL_PRIORITY = 300;
const HAS_WEBREQUEST = !!(api.webRequest && api.webRequest.onBeforeRedirect);
const session = api.storage && api.storage.session ? api.storage.session : null;

const ICONS_ON = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png' };
const ICONS_OFF = { 16: 'icons/icon-16-off.png', 32: 'icons/icon-32-off.png', 48: 'icons/icon-48-off.png' };

const swallow = () => {};

// ---------------------------------------------------------------------------
// Settings → network rules
// ---------------------------------------------------------------------------

let settingsCache = null;
async function getSettings() {
  if (!settingsCache) settingsCache = await S.load();
  return settingsCache;
}

let applyChain = Promise.resolve();
function scheduleApply() {
  applyChain = applyChain.then(applyRules, applyRules).catch((e) => console.warn('[Clink] apply failed', e));
  return applyChain;
}

async function applyRules() {
  const s = await getSettings();

  const want = new Set([SAFETY_RULESET]);
  if (s.enabled) {
    for (const id of CATEGORY_RULESETS) if (s.categories[id]) want.add(id);
  }
  const current = new Set(await dnr.getEnabledRulesets());
  const enableRulesetIds = [...want].filter((id) => !current.has(id));
  const disableRulesetIds = [...CATEGORY_RULESETS, SAFETY_RULESET].filter((id) => current.has(id) && !want.has(id));
  if (enableRulesetIds.length || disableRulesetIds.length) {
    await dnr.updateEnabledRulesets({ enableRulesetIds, disableRulesetIds });
  }

  // Paused + Link-Guarded sites: an allow rule outranks every cleaning rule.
  const hosts = [...new Set(C.optionsFromSettings(s).paused)].filter((h) => /^[a-z0-9.-]+$/.test(h));
  const existing = await dnr.getDynamicRules();
  const addRules = hosts.length
    ? [{
        id: 1,
        priority: PAUSE_PRIORITY,
        action: { type: 'allow' },
        condition: { requestDomains: hosts, resourceTypes: ['main_frame'] },
      }]
    : [];
  await dnr.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id), addRules });

  await api.action.setIcon({ path: s.enabled ? ICONS_ON : ICONS_OFF }).catch(swallow);
  for (const tabId of tabs.keys()) updateBadge(tabId);
}

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    settingsCache = S.normalize(changes.settings.newValue);
    scheduleApply();
  }
});

// ---------------------------------------------------------------------------
// Per-tab state & badge
// ---------------------------------------------------------------------------

/** tabId → { url, state, frames: {frameId: count}, nav: {original, cleaned, removed, time} | null } */
const tabs = new Map();
let tabsRestored = null;

function restoreTabs() {
  if (!tabsRestored) {
    tabsRestored = (session ? session.get('tabs') : Promise.resolve({}))
      .then((data) => {
        const saved = (data && data.tabs) || {};
        for (const [id, t] of Object.entries(saved)) if (!tabs.has(+id)) tabs.set(+id, t);
      })
      .catch(swallow);
  }
  return tabsRestored;
}

let persistTimer = 0;
function persistTabs() {
  if (!session || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = 0;
    session.set({ tabs: Object.fromEntries(tabs) }).catch(swallow);
  }, 250);
}

function tabState(tabId) {
  let t = tabs.get(tabId);
  if (!t) {
    t = { url: '', state: 'on', frames: {}, nav: null };
    tabs.set(tabId, t);
  }
  return t;
}

function tabCount(t) {
  let n = t.nav ? 1 : 0;
  for (const v of Object.values(t.frames)) n += v;
  return n;
}

async function updateBadge(tabId) {
  if (tabId < 0) return;
  const s = await getSettings();
  const t = tabs.get(tabId);
  const n = t ? tabCount(t) : 0;
  const text = s.enabled && s.showBadge && n ? (n > 999 ? '999+' : String(n)) : '';
  api.action.setBadgeText({ tabId, text }).catch(swallow);
  const paused = t && t.state === 'paused';
  api.action.setIcon({ tabId, path: s.enabled && !paused ? ICONS_ON : ICONS_OFF }).catch(swallow);
}

function withoutHash(u) {
  const s = String(u || '');
  const i = s.indexOf('#');
  return i === -1 ? s : s.slice(0, i);
}

/** Same document? (Request URLs never carry the #fragment; tab URLs may.) */
function sameDoc(a, b) {
  return withoutHash(a) === withoutHash(b);
}

function newPage(t, url) {
  if (sameDoc(t.url, url)) {
    t.url = url; // a jump to #section is not a new page
    return;
  }
  t.url = url;
  t.frames = {};
  if (t.nav && !sameDoc(t.nav.cleaned, url)) t.nav = null;
}

api.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  trials.delete(tabId);
  persistTabs();
});

api.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) {
    restoreTabs().then(() => {
      const t = tabState(tabId);
      if (!sameDoc(t.url, info.url) && !(t.nav && sameDoc(t.nav.cleaned, info.url))) {
        newPage(t, info.url);
        updateBadge(tabId);
        persistTabs();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Stats & recent activity
// ---------------------------------------------------------------------------

let statsQueue = null;
function bumpStats(delta) {
  if (!statsQueue) {
    statsQueue = { clicks: 0, params: 0, unwrapped: 0, copies: 0 };
    setTimeout(async () => {
      const d = statsQueue;
      statsQueue = null;
      const { stats } = await api.storage.local.get('stats');
      const s = Object.assign({ clicks: 0, params: 0, unwrapped: 0, copies: 0, since: Date.now() }, stats || {});
      for (const k of Object.keys(d)) s[k] += d[k];
      await api.storage.local.set({ stats: s });
    }, 500);
  }
  for (const k of Object.keys(delta)) statsQueue[k] += delta[k] || 0;
}

let recentMemory = [];
async function logRecent(entry) {
  const e = Object.assign({ t: Date.now() }, entry);
  if (session) {
    const { recent } = await session.get('recent').catch(() => ({}));
    const list = [e].concat(recent || []).slice(0, 30);
    await session.set({ recent: list }).catch(swallow);
  } else {
    recentMemory = [e].concat(recentMemory).slice(0, 30);
  }
}

async function getRecent() {
  if (!session) return recentMemory;
  const { recent } = await session.get('recent').catch(() => ({}));
  return recent || [];
}

// ---------------------------------------------------------------------------
// Network-layer observation + Link Guard (Chrome & Firefox; Safari lacks webRequest)
// ---------------------------------------------------------------------------

/** requestId → { tabId, dirty, started, … }: the last URL in a navigation chain that Clink would clean. */
const pending = new Map();
/** tabId → { host, original, removed, ruleId, started, requestId, manual } */
const trials = new Map();
const recentRecoveries = new Map();
let nextTrialRuleId = 1;
/** requestId → { url, time }: where each top-level navigation started. */
const firstUrls = new Map();
/** cleaned URL (no #) → { original, removed, time }: links the page layer cleaned that the user just opened. */
const expectations = new Map();
/** first URL (no #) → failed navigation not (yet) matched with an expectation (the message can arrive late). */
const failures = new Map();

/** Drop expired entries (oldest first) and keep the map small. */
function prune(map, ttl, max) {
  const now = Date.now();
  for (const [k, v] of map) {
    if (map.size > max || now - v.time > ttl) map.delete(k);
    else break;
  }
}

function remember(map, key, value, ttl, max) {
  map.delete(key); // re-insert at the end (newest)
  map.set(key, Object.assign({ time: Date.now() }, value));
  prune(map, ttl, max);
}

function take(map, key, ttl) {
  const v = map.get(key);
  if (!v) return null;
  map.delete(key);
  return Date.now() - v.time <= ttl ? v : null;
}

const EXPECT_TTL = 60000;
const FAILURE_TTL = 10000;

/** If `to` is `from` minus known tracking parameters, return the names removed. */
function diffRedirect(from, to) {
  let a, b;
  try {
    a = new URL(from);
    b = new URL(to);
  } catch (_) {
    return null;
  }
  if (a.origin !== b.origin) return null;
  const removed = [];
  if (a.pathname !== b.pathname) {
    if (b.pathname !== a.pathname.replace(/\/ref=[^/]*$/, '')) return null;
    removed.push('ref (path)');
  }
  const left = new Map();
  for (const k of C.queryKeys(b.search)) left.set(k, (left.get(k) || 0) + 1);
  for (const k of C.queryKeys(a.search)) {
    const n = left.get(k);
    if (n) left.set(k, n - 1);
    else removed.push(k);
  }
  for (const n of left.values()) if (n > 0) return null; // target gained a param: not us
  if (!removed.length) return null;
  for (const k of removed) {
    if (k !== 'ref (path)' && !C.trackerCategory(k, from)) return null;
  }
  return [...new Set(removed)];
}

function shouldRecover(code) {
  return (code >= 400 && code < 500 && ![401, 407, 408, 429].includes(code)) || code === 500;
}

/**
 * Re-open `original` (the URL before cleaning) in the tab, with Clink's rules
 * bypassed for that site in that tab, and watch whether it loads.
 * `fromRequestId` is the request that failed: it may still be in flight (a
 * redirect loop) and must never be mistaken for the retry.
 */
async function recover(tabId, original, removed, reason, manual, fromRequestId = null) {
  if (trials.has(tabId)) return false;
  let host;
  try {
    host = new URL(original).hostname;
  } catch (_) {
    return false;
  }
  const last = recentRecoveries.get(original);
  if (!manual && last && Date.now() - last < 60000) return false; // never ping-pong
  recentRecoveries.set(original, Date.now());

  const ruleId = nextTrialRuleId++;
  // The whole site (www. or not), like the permanent rule: sites often redirect between them.
  const condition = { requestDomains: [S.siteKey(host)], tabIds: [tabId], resourceTypes: ['main_frame'] };
  try {
    await dnr.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [{ id: ruleId, priority: TRIAL_PRIORITY, action: { type: 'allow' }, condition }],
    });
  } catch (e) {
    console.warn('[Clink] could not add bypass rule', e);
    return false;
  }
  const trial = { host, original, removed, ruleId, started: Date.now(), requestId: null, fromRequestId, manual: !!manual, reason };
  trials.set(tabId, trial);
  // Only ever end *this* trial: a later one in the same tab has its own timer.
  const giveUp = () => trials.get(tabId) === trial && endTrial(tabId, null);
  setTimeout(giveUp, 30000);
  await api.tabs.update(tabId, { url: original }).catch(giveUp);
  return true;
}

async function endTrial(tabId, ok) {
  const trial = trials.get(tabId);
  if (!trial) return;
  trials.delete(tabId);
  const dropBypass = () => dnr.updateSessionRules({ removeRuleIds: [trial.ruleId] }).catch(swallow);

  if (ok === true && !trial.manual) {
    const host = S.siteKey(trial.host);
    try {
      settingsCache = await S.update((s) => {
        if (!s.guardedSites.some((g) => g.host === host)) {
          s.guardedSites.push({ host, params: trial.removed, added: Date.now(), reason: trial.reason });
        }
      });
      // Install the permanent allow rule *before* dropping the temporary one,
      // so there is no window in which the site gets cleaned (and broken) again.
      await scheduleApply();
    } finally {
      dropBypass();
    }
    logRecent({ kind: 'guard', host, removed: trial.removed, reason: trial.reason });
    return;
  }
  dropBypass();
  if (ok === false && !trial.manual) {
    logRecent({ kind: 'deadlink', host: trial.host, reason: trial.reason });
  }
}

/** Would Clink's network rules rewrite this URL? */
function wouldClean(url) {
  const opts = C.optionsFromSettings(settingsCache || S.DEFAULTS);
  opts.unwrap = false; // the network layer never unwraps redirectors
  const r = C.clean(url, opts);
  return r.changed ? r : null;
}

function track(requestId, tabId, url) {
  if (tabId < 0 || !wouldClean(url)) return null;
  let p = pending.get(requestId);
  if (!p) {
    p = { tabId, dirty: url, started: Date.now(), seen: new Map(), looped: false };
    pending.set(requestId, p);
    if (pending.size > 200) {
      for (const [id, v] of pending) if (Date.now() - v.started > 120000) pending.delete(id);
    }
  }
  // Keep the original if this URL is just one of our own cleaning steps of it.
  if (p.dirty !== url && !diffRedirect(p.dirty, url)) {
    p.dirty = url;
    p.removed = null;
  }
  p.seen.set(url, (p.seen.get(url) || 0) + 1);
  return p;
}

/*
 * Chrome doesn't always report its own declarativeNetRequest rewrites (e.g. when
 * the tracking URL came from a server redirect), so instead of relying on that we
 * remember the last "dirty" URL of each navigation and compare it with the URL
 * that actually loaded.
 */
if (HAS_WEBREQUEST) {
  const filter = { urls: ['<all_urls>'], types: ['main_frame'] };

  api.webRequest.onBeforeRequest.addListener((d) => {
    if (d.tabId >= 0 && !firstUrls.has(d.requestId)) {
      firstUrls.set(d.requestId, { url: d.url, time: Date.now() });
      if (firstUrls.size > 200) prune(firstUrls, 120000, 200);
    }
    const trial = trials.get(d.tabId);
    if (trial && !trial.requestId && d.url === trial.original && d.requestId !== trial.fromRequestId) {
      trial.requestId = d.requestId;
      return;
    }
    track(d.requestId, d.tabId, d.url);
  }, filter);

  // Server redirects that land on a tracking URL: email click-trackers, link
  // shorteners, or a site that re-adds a tracker (→ possible redirect loop).
  api.webRequest.onBeforeRedirect.addListener(async (d) => {
    const trial = trials.get(d.tabId);
    if (trial && trial.requestId === d.requestId) return;
    // The cleaned URL was requested and the server sent us on (www → bare host,
    // added slash, …): remember what was removed, in case the end of the chain fails.
    const p0 = pending.get(d.requestId);
    if (p0 && !p0.removed && d.url !== p0.dirty) p0.removed = diffRedirect(p0.dirty, d.url);
    const p = track(d.requestId, d.tabId, d.redirectUrl);
    // The server keeps sending us back to the URL we just cleaned → it's a loop.
    // Don't wait for the browser to give up after 20 hops; restore the link now.
    if (p && !p.looped && p.seen.get(d.redirectUrl) >= 3) {
      p.looped = true;
      const s = await getSettings();
      if (s.linkGuard) {
        const w = wouldClean(p.dirty);
        recover(p.tabId, p.dirty, w ? w.removed : [], 'redirect loop', false, d.requestId);
      }
    }
  }, filter);

  api.webRequest.onCompleted.addListener(async (d) => {
    const first = firstUrls.get(d.requestId);
    firstUrls.delete(d.requestId);
    const trial = trials.get(d.tabId);
    if (trial && trial.requestId === d.requestId) {
      pending.delete(d.requestId);
      endTrial(d.tabId, d.statusCode < 400);
      return;
    }
    const p = pending.get(d.requestId);
    if (!p) {
      onPageLinkCompleted(d, first ? first.url : d.url);
      return;
    }
    pending.delete(d.requestId);
    const removed = diffRedirect(p.dirty, d.url) || p.removed;
    if (!removed) return; // Clink left it alone (paused, protected, …)

    await restoreTabs();
    const t = tabState(p.tabId);
    t.nav = { original: p.dirty, cleaned: d.url, removed, time: Date.now() };
    updateBadge(p.tabId);
    persistTabs();
    bumpStats({ clicks: 1, params: removed.length });
    logRecent({ kind: 'navigation', host: safeHost(d.url), removed });

    const s = await getSettings();
    if (s.linkGuard && d.method === 'GET' && shouldRecover(d.statusCode)) {
      recover(p.tabId, p.dirty, removed, 'HTTP ' + d.statusCode, false, d.requestId);
    }
  }, filter);

  api.webRequest.onErrorOccurred.addListener(async (d) => {
    firstUrls.delete(d.requestId);
    const trial = trials.get(d.tabId);
    if (trial && trial.requestId === d.requestId) {
      pending.delete(d.requestId);
      // Aborted = superseded or stopped by the user: inconclusive, not a failure.
      endTrial(d.tabId, /ABORTED/i.test(d.error || '') ? null : false);
      return;
    }
    const p = pending.get(d.requestId);
    if (!p) return;
    pending.delete(d.requestId);
    const s = await getSettings();
    if (s.linkGuard && !p.looped && /TOO_MANY_REDIRECTS|REDIRECT_LOOP/i.test(d.error || '')) {
      const w = wouldClean(p.dirty);
      recover(p.tabId, p.dirty, w ? w.removed : [], 'redirect loop', false, d.requestId);
    }
  }, filter);
}

/**
 * A navigation the network rules didn't touch finished. If it is a link the
 * page layer cleaned (the content script told us when it was opened), give it
 * the same Link Guard protection as a cleaned address.
 */
function onPageLinkCompleted(d, firstUrl) {
  if (d.tabId < 0) return;
  const nav = { tabId: d.tabId, url: d.url, status: d.statusCode, method: d.method, requestId: d.requestId };
  const key = withoutHash(firstUrl);
  const e = take(expectations, key, EXPECT_TTL) || take(expectations, withoutHash(d.url), EXPECT_TTL);
  if (e) {
    guardPageLink(e, nav);
  } else if (d.method === 'GET' && shouldRecover(d.statusCode)) {
    remember(failures, key, nav, FAILURE_TTL, 50);
  }
}

async function guardPageLink(e, nav) {
  await restoreTabs();
  const t = tabState(nav.tabId);
  t.nav = { original: e.original, cleaned: nav.url, removed: e.removed, time: Date.now() };
  updateBadge(nav.tabId);
  persistTabs();
  const s = await getSettings();
  if (s.linkGuard && nav.method === 'GET' && shouldRecover(nav.status)) {
    recover(nav.tabId, e.original, e.removed, 'HTTP ' + nav.status, false, nav.requestId);
  }
}

function safeHost(u) {
  try {
    return new URL(u).hostname;
  } catch (_) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Messages from content scripts and the popup
// ---------------------------------------------------------------------------

const handlers = {
  async 'clink:hello'(msg, sender) {
    const tabId = sender.tab ? sender.tab.id : -1;
    if (tabId < 0 || sender.frameId) return;
    await restoreTabs();
    const t = tabState(tabId);
    newPage(t, msg.url);
    t.state = msg.state;
    updateBadge(tabId);
    persistTabs();
  },

  async 'clink:count'(msg, sender) {
    const tabId = sender.tab ? sender.tab.id : -1;
    if (tabId < 0) return;
    await restoreTabs();
    const t = tabState(tabId);
    t.frames[sender.frameId || 0] = Math.max(0, msg.count | 0);
    updateBadge(tabId);
    persistTabs();
  },

  async 'clink:activated'(msg) {
    const removed = Array.isArray(msg.removed) ? msg.removed.slice(0, 50) : [];
    const unwrapped = Array.isArray(msg.unwrapped) ? msg.unwrapped.slice(0, 10) : [];
    bumpStats({ clicks: 1, params: removed.length, unwrapped: unwrapped.length });
    logRecent({ kind: 'link', host: String(msg.host || ''), removed, unwrapped });
  },

  /** The user opened a link the page layer cleaned (see onPageLinkCompleted). */
  async 'clink:expect'(msg, sender) {
    if (!HAS_WEBREQUEST || !sender.tab) return;
    const str = (v) => (typeof v === 'string' && v.length <= 16384 ? v : '');
    const cleaned = withoutHash(str(msg.cleaned));
    const original = str(msg.original);
    const removed = Array.isArray(msg.removed) ? msg.removed.filter((k) => typeof k === 'string').slice(0, 50) : [];
    let a, b;
    try {
      a = new URL(cleaned);
      b = new URL(original);
    } catch (_) {
      return;
    }
    // Only ever "restore" the same site, over the web.
    if (!removed.length || a.origin !== b.origin || !/^https?:$/.test(a.protocol)) return;
    const e = { original, removed };
    const failed = take(failures, cleaned, FAILURE_TTL);
    if (failed) guardPageLink(e, failed); // the navigation finished before this message arrived
    else remember(expectations, cleaned, e, EXPECT_TTL, 100);
  },

  async 'clink:copied'(msg) {
    const removed = Array.isArray(msg.removed) ? msg.removed.slice(0, 50) : [];
    bumpStats({ copies: 1, params: removed.length });
    logRecent({ kind: 'copy', host: String(msg.host || ''), removed, unwrapped: msg.unwrapped || [] });
  },

  async 'clink:popup'(msg) {
    await restoreTabs();
    const t = tabs.get(msg.tabId) || null;
    const [{ stats }, recent] = await Promise.all([api.storage.local.get('stats'), getRecent()]);
    return {
      tab: t ? { state: t.state, count: tabCount(t), links: tabCount(t) - (t.nav ? 1 : 0), nav: t.nav } : null,
      stats: stats || null,
      recent,
      linkGuardAvailable: HAS_WEBREQUEST,
    };
  },

  async 'clink:restore'(msg) {
    await restoreTabs();
    const t = tabs.get(msg.tabId);
    if (!t || !t.nav) return { ok: false };
    const ok = await recover(msg.tabId, t.nav.original, t.nav.removed, 'manual', true);
    return { ok };
  },

  async 'clink:clearRecent'() {
    recentMemory = [];
    if (session) await session.set({ recent: [] });
  },
};

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && typeof msg.type === 'string' && handlers[msg.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then((r) => sendResponse(r === undefined ? null : r), (e) => sendResponse({ error: String(e) }));
  return true;
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

api.runtime.onInstalled.addListener((details) => {
  scheduleApply();
  if (details.reason === 'install') {
    api.tabs.create({ url: api.runtime.getURL('options/options.html#welcome') }).catch(swallow);
  }
});

if (api.runtime.onStartup) api.runtime.onStartup.addListener(() => scheduleApply());

(async function boot() {
  api.action.setBadgeBackgroundColor({ color: '#2f6bf0' }).catch(swallow);
  if (api.action.setBadgeTextColor) api.action.setBadgeTextColor({ color: '#ffffff' }).catch(swallow);
  // Session bypass rules from a previous worker lifetime are stale.
  try {
    const stale = await dnr.getSessionRules();
    if (stale.length) await dnr.updateSessionRules({ removeRuleIds: stale.map((r) => r.id) });
  } catch (_) {
    /* not supported */
  }
  restoreTabs();
  scheduleApply();
})();
