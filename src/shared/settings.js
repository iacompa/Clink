// SPDX-License-Identifier: GPL-3.0-or-later
/* Clink settings: defaults, normalisation and storage helpers. */
(function (root) {
  'use strict';

  const api = root.browser || root.chrome;

  const DEFAULTS = Object.freeze({
    enabled: true,
    categories: Object.freeze({ trackers: true, campaign: true, sites: true, affiliate: true, strict: false }),
    unwrapRedirects: true, // skip google.com/url, l.facebook.com … hops
    removePing: true, // strip <a ping> click beacons
    cleanOnCopy: true, // clean URLs you copy from page text
    linkGuard: true, // auto-restore a link if the cleaned version fails to load
    showBadge: true,
    pausedSites: [], // hostnames the user paused
    guardedSites: [], // [{ host, params, added }] auto-paused by Link Guard
  });

  function normalize(stored) {
    const s = stored && typeof stored === 'object' ? stored : {};
    const out = {};
    for (const key of Object.keys(DEFAULTS)) {
      out[key] = key in s ? s[key] : DEFAULTS[key];
    }
    out.categories = Object.assign({}, DEFAULTS.categories, s.categories || {});
    out.pausedSites = Array.isArray(out.pausedSites) ? out.pausedSites.filter(Boolean) : [];
    out.guardedSites = Array.isArray(out.guardedSites) ? out.guardedSites.filter((g) => g && g.host) : [];
    return out;
  }

  async function load() {
    const data = await api.storage.local.get('settings');
    return normalize(data && data.settings);
  }

  async function save(settings) {
    const s = normalize(settings);
    await api.storage.local.set({ settings: s });
    return s;
  }

  async function update(mutator) {
    const s = await load();
    const next = (await mutator(s)) || s;
    return save(next);
  }

  /** "www.example.com" → "example.com" — the unit users pause. */
  function siteKey(hostname) {
    let h = String(hostname || '').toLowerCase();
    if (h.endsWith('.')) h = h.slice(0, -1);
    return h.replace(/^www\d?\./, '');
  }

  root.ClinkSettings = Object.freeze({ DEFAULTS, normalize, load, save, update, siteKey });
})(globalThis);
