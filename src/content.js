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
  const isTop = window === window.top;

  let settings = null;
  let options = null;
  let active = false;
  let pageCleaned = 0;

  // element → { original, cleaned, removed, unwrapped }
  const records = new WeakMap();
  // element → number of times we've rewritten it (guards against fights with page scripts)
  const rewrites = new WeakMap();

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

  function computeActive() {
    if (!settings || !settings.enabled) return false;
    const hosts = [location.hostname, topHostname()].filter(Boolean);
    for (const h of hosts) {
      if (C.isQuietPage(h)) return false;
      if (C.isPausedHost(h, options.paused)) return false;
    }
    return true;
  }

  function applySettings(raw) {
    const wasActive = active;
    settings = S.normalize(raw);
    options = C.optionsFromSettings(settings);
    active = computeActive();
    if (active) {
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

  /** Clean one link element. Returns true if it was changed. */
  function processLink(el) {
    if (!active || !el || !el.getAttribute) return false;

    if (settings.removePing && el.hasAttribute('ping')) {
      el.removeAttribute('ping');
    }

    const href = hrefOf(el);
    if (!href || !C.mightNeedCleaning(href)) return false;

    const prev = records.get(el);
    if (prev && prev.cleaned === href) return false; // our own value

    const res = C.clean(href, options);
    if (!res.changed) return false;

    const n = (rewrites.get(el) || 0) + 1;
    if (n > 25) return false; // a page script keeps fighting us; let the network layer handle it
    rewrites.set(el, n);

    records.set(el, {
      original: href,
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

  function restoreAll() {
    const links = document.querySelectorAll(LINK_SELECTOR);
    for (const el of links) {
      const rec = records.get(el);
      if (rec && el.getAttribute('href') === rec.cleaned) el.setAttribute('href', rec.original);
      records.delete(el);
    }
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
      attributeFilter: ['href', 'ping'],
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

  function onInteract(e) {
    if (!active) return;
    const el = linkFromEvent(e);
    if (!el) return;
    processLink(el);
    if ((e.type === 'click' || e.type === 'auxclick') && records.has(el) && !activated.has(el)) {
      const rec = records.get(el);
      if (el.getAttribute('href') === rec.cleaned) {
        activated.add(el);
        report('clink:activated', {
          host: safeHost(rec.cleaned),
          removed: rec.removed,
          unwrapped: rec.unwrapped,
        });
      }
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
      state: !settings.enabled ? 'off' : active ? 'on' : C.isQuietPage(location.hostname) ? 'quiet' : 'paused',
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
