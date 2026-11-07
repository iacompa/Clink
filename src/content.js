// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Clink page layer. Runs in every frame at document_start.
 *
 *  • Rewrites tracking links in the page to their clean form, so hovering,
 *    copying ("Copy link address"), dragging and clicking all use the clean URL.
 *  • Replaces redirect wrappers (google.com/url, l.facebook.com, …) with the
 *    real destination, so the tracking hop never happens.
 *  • Removes <a ping> click beacons.
 *  • Re-cleans a link the instant a page script swaps its href at click time
 *    (Gmail, Facebook and Google do this), before the browser follows it.
 *  • Optionally cleans URLs you copy from page text.
 *  • Tells Link Guard which link you opened, so a cleaned link that fails is
 *    restored just like a cleaned address.
 *
 * It never touches what you are editing (contenteditable / designMode), in-page
 * anchors (#section), local files or local dev sites.
 *
 * The network layer (declarativeNetRequest) independently cleans every
 * navigation, so anything this layer misses is still caught there.
 */
(() => {
  'use strict';
  if (globalThis.__clinkContentLoaded) return;
  globalThis.__clinkContentLoaded = true;

  const api = globalThis.browser || globalThis.chrome;
  const C = globalThis.ClinkCleaner;
  const S = globalThis.ClinkSettings;
  if (!api || !C || !S) return;

  const LINK_SELECTOR = 'a[href], area[href]';
  const EDITABLE = '[contenteditable]:not([contenteditable="false" i])';
  const isTop = window === window.top;

  let settings = null;
  let options = null;
  let active = false;
  let pageCleaned = 0;

  // element → { raw, original, target, cleaned, removed, unwrapped }
  const records = new WeakMap();
  // element → { href, n, t }: repeated rewrites of the same href (a page script fighting us)
  const rewrites = new WeakMap();
  let optionsKey = '';

  // -------------------------------------------------------------------------
  // Activation
  // -------------------------------------------------------------------------

  function topHostname() {
    if (isTop) return location.hostname;
    try {
      return window.top.location.hostname;
    } catch (_) {
      /* cross-origin */
    }
    const ao = location.ancestorOrigins;
    if (ao && ao.length) {
      try {
        return new URL(ao[ao.length - 1]).hostname;
      } catch (_) {
        /* ignore */
      }
    }
    return '';
  }

  /** This frame's host; about:blank / srcdoc frames inherit their creator's. */
  function ownHostname() {
    if (location.hostname) return location.hostname;
    try {
      return new URL(self.origin).hostname;
    } catch (_) {
      return ''; // opaque origin
    }
  }

  function pageHosts() {
    return [ownHostname(), topHostname()].filter(Boolean);
  }

  /** Local files, pages without a host, local dev sites and marketing tools. */
  function isQuietHere() {
    if (location.protocol === 'file:') return true;
    const hosts = pageHosts();
    return !hosts.length || hosts.some((h) => C.isQuietPage(h));
  }

  function computeActive() {
    if (!settings || !settings.enabled || isQuietHere()) return false;
    return !pageHosts().some((h) => C.isPausedHost(h, options.paused));
  }

  function applySettings(raw) {
    const wasActive = active;
    settings = S.normalize(raw);
    options = C.optionsFromSettings(settings);
    const key = JSON.stringify(options);
    const changed = key !== optionsKey;
    optionsKey = key;
    active = computeActive();
    if (active) {
      // Categories, paused or Link-Guarded sites changed: re-clean every link
      // from its original, so e.g. turning a category off brings its tags back.
      if (wasActive && changed) restoreAll();
      startObserver();
      scan(document);
    } else {
      stopObserver();
      if (wasActive) restoreAll();
    }
    if (isTop) hello();
  }

  // -------------------------------------------------------------------------
  // Link processing
  // -------------------------------------------------------------------------

  function hrefOf(el) {
    const raw = el.getAttribute('href');
    if (!raw) return null;
    if (typeof el.href === 'string') return el.href; // HTML <a>/<area>: already absolute
    try {
      return new URL(raw, document.baseURI).href; // SVG <a>
    } catch (_) {
      return null;
    }
  }

  /** Is this element part of something the user is editing (a draft, a CMS field)? */
  function inEditor(el) {
    if (el.ownerDocument && el.ownerDocument.designMode === 'on') return true;
    return !!(el.closest && el.closest(EDITABLE));
  }

  function documentUrlWithoutHash() {
    const u = document.URL;
    const i = u.indexOf('#');
    return i === -1 ? u : u.slice(0, i);
  }

  /** Clean one link element. Returns true if it was changed. */
  function processLink(el) {
    if (!active || !el || !el.getAttribute) return false;
    if (inEditor(el)) return false; // never rewrite the user's own content

    if (settings.removePing && el.hasAttribute('ping')) {
      el.removeAttribute('ping');
    }

    const href = hrefOf(el);
    if (!href || !C.mightNeedCleaning(href)) return false;

    // An in-page anchor (#faq) resolves against this page's own URL; "cleaning"
    // it would turn a jump within the page into a reload of a different URL.
    const hash = href.indexOf('#');
    if (hash !== -1 && href.slice(0, hash) === documentUrlWithoutHash()) return false;

    const prev = records.get(el);
    if (prev && prev.cleaned === href) return false; // our own value

    const res = C.clean(href, options);
    if (!res.changed) return false;

    // A page script that keeps putting the same tracking URL back is fighting
    // us: stop after a burst and let the network layer handle that link.
    // (Different URLs — an element recycled by a virtual list — never count.)
    const now = Date.now();
    const fight = rewrites.get(el);
    if (fight && fight.href === href && now - fight.t < 2000) {
      if (++fight.n > 25) return false;
      fight.t = now;
    } else {
      rewrites.set(el, { href, n: 1, t: now });
    }

    records.set(el, {
      raw: el.getAttribute('href'),
      original: href,
      target: res.target || href, // what Link Guard restores: the destination, with its parameters
      cleaned: res.url,
      removed: res.removed,
      unwrapped: res.unwrapped,
    });
    el.setAttribute('href', res.url);
    if (!prev) {
      pageCleaned++;
      scheduleReport();
    }
    return true;
  }

  function scan(rootNode) {
    if (!active || !rootNode) return;
    if (rootNode.nodeType === 1 && rootNode.matches(LINK_SELECTOR)) processLink(rootNode);
    if (rootNode.querySelectorAll) {
      const links = rootNode.querySelectorAll(LINK_SELECTOR);
      for (let i = 0; i < links.length; i++) processLink(links[i]);
    }
  }

  /** Put one link back exactly as the page wrote it. */
  function restoreLink(el) {
    const rec = records.get(el);
    if (!rec) return false;
    records.delete(el);
    rewrites.delete(el);
    if (el.getAttribute('href') === rec.cleaned) el.setAttribute('href', rec.raw);
    return true;
  }

  function restoreWithin(rootNode) {
    let n = 0;
    if (rootNode.matches && rootNode.matches(LINK_SELECTOR) && restoreLink(rootNode)) n++;
    if (rootNode.querySelectorAll) {
      for (const el of rootNode.querySelectorAll(LINK_SELECTOR)) if (restoreLink(el)) n++;
    }
    if (n) {
      pageCleaned = Math.max(0, pageCleaned - n);
      scheduleReport();
    }
  }

  function restoreAll() {
    for (const el of document.querySelectorAll(LINK_SELECTOR)) restoreLink(el);
    pageCleaned = 0;
    scheduleReport();
  }

  // -------------------------------------------------------------------------
  // DOM observation — synchronous, so a href swapped by a page's click handler
  // is cleaned in the same microtask checkpoint, before the browser navigates.
  // -------------------------------------------------------------------------

  let observer = null;

  function onMutations(mutations) {
    if (!active) return;
    for (const m of mutations) {
      if (m.type === 'attributes') {
        const t = m.target;
        if (m.attributeName === 'contenteditable') {
          // Editing starts: hand the author their links back untouched. Editing ends: clean again.
          if (inEditor(t)) restoreWithin(t);
          else scan(t);
          continue;
        }
        if (t.matches && t.matches(LINK_SELECTOR)) processLink(t);
        else if (m.attributeName === 'ping' && t.hasAttribute && t.hasAttribute('ping') && settings.removePing) {
          t.removeAttribute('ping');
        }
      } else {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches(LINK_SELECTOR)) processLink(node);
          if (node.firstElementChild) scan(node);
        }
      }
    }
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(onMutations);
    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['href', 'ping', 'contenteditable'],
    });
  }

  function stopObserver() {
    if (observer) observer.disconnect();
    observer = null;
  }

  // -------------------------------------------------------------------------
  // Interaction-time cleaning (covers shadow DOM and late href swaps)
  // -------------------------------------------------------------------------

  function linkFromEvent(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
    for (const n of path) {
      if (n && n.nodeType === 1 && (n.localName === 'a' || n.localName === 'area') && n.hasAttribute('href')) {
        return n;
      }
      if (n === document || n === window) break;
    }
    return null;
  }

  const activated = new WeakSet();
  // Ways a link gets opened: click, middle/modified click, context menu "Open in new tab", drag to tab bar.
  const OPEN_EVENTS = new Set(['click', 'auxclick', 'contextmenu', 'dragstart']);
  let lastExpect = { event: null, url: '' };

  function onInteract(e) {
    if (!active) return;
    const el = linkFromEvent(e);
    if (!el) return;
    processLink(el);
    const rec = records.get(el);
    if (!rec || el.getAttribute('href') !== rec.cleaned) return;

    if ((e.type === 'click' || e.type === 'auxclick') && !activated.has(el)) {
      activated.add(el);
      report('clink:activated', {
        host: safeHost(rec.cleaned),
        removed: rec.removed,
        unwrapped: rec.unwrapped,
      });
    }

    // Link Guard: if this cleaned link fails to load, the background re-opens
    // the destination with its parameters. (Once per event and URL — the click
    // listeners run twice, and a page script may swap the href in between.)
    if (OPEN_EVENTS.has(e.type) && settings.linkGuard && rec.removed.length &&
        !(lastExpect.event === e && lastExpect.url === rec.cleaned)) {
      lastExpect = { event: e, url: rec.cleaned };
      report('clink:expect', { cleaned: rec.cleaned, original: rec.target, removed: rec.removed });
    }
  }

  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'focusin', 'contextmenu', 'dragstart', 'click', 'auxclick']) {
    window.addEventListener(type, onInteract, { capture: true, passive: true });
  }
  // Bubble phase too: runs after the page's own handlers (which may have just
  // swapped the href) and right before the browser's default action.
  window.addEventListener('click', onInteract, { passive: true });
  window.addEventListener('auxclick', onInteract, { passive: true });

  // -------------------------------------------------------------------------
  // Clean URLs copied from page text
  // -------------------------------------------------------------------------

  document.addEventListener(
    'copy',
    (e) => {
      if (!active || !settings.cleanOnCopy || !e.clipboardData) return;
      let text = '';
      const ae = document.activeElement;
      if (ae && (ae.localName === 'textarea' || ae.localName === 'input') && typeof ae.selectionStart === 'number') {
        try {
          text = ae.value.slice(ae.selectionStart, ae.selectionEnd);
        } catch (_) {
          text = '';
        }
      } else {
        text = String(window.getSelection ? window.getSelection() : '');
      }
      const t = text.trim();
      if (!t || t.length > 32768 || !/^https?:\/\/\S+$/i.test(t)) return;
      const res = C.clean(t, options);
      if (!res.changed) return;
      e.clipboardData.setData('text/plain', res.url);
      e.preventDefault();
      report('clink:copied', { host: safeHost(res.url), removed: res.removed, unwrapped: res.unwrapped });
    },
    true
  );

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  function safeHost(u) {
    try {
      return new URL(u).hostname;
    } catch (_) {
      return '';
    }
  }

  function report(type, payload) {
    try {
      const p = api.runtime.sendMessage(Object.assign({ type }, payload || {}));
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {
      /* extension reloaded or context invalidated */
    }
  }

  let reportTimer = 0;
  function scheduleReport() {
    if (reportTimer) return;
    reportTimer = setTimeout(() => {
      reportTimer = 0;
      report('clink:count', { count: pageCleaned });
    }, 300);
  }

  function hello() {
    report('clink:hello', {
      url: location.href,
      state: !settings.enabled ? 'off' : active ? 'on' : isQuietHere() ? 'quiet' : 'paused',
    });
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  api.storage.local.get('settings').then(
    (data) => applySettings(data && data.settings),
    () => applySettings(undefined)
  );

  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) applySettings(changes.settings.newValue);
  });

  // Back/forward cache restores don't re-run content scripts.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && isTop && settings) {
      hello();
      report('clink:count', { count: pageCleaned });
    }
  });
})();
