/*
 * Clink URL cleaner — pure functions shared by the content script, popup,
 * options page, background worker and the Node test-suite.
 *
 *   ClinkCleaner.clean(url, options) → {
 *     url,        // cleaned URL (identical string to the input when unchanged)
 *     changed,    // true when url !== input
 *     removed,    // parameter names that were stripped
 *     unwrapped,  // names of redirect wrappers that were skipped
 *     skipped,    // why the URL was left alone ('paused' | 'local' | 'tool' | …)
 *   }
 *
 * Guarantees that keep links working:
 *   • Only exact, known tracking parameters are removed. Everything else in the
 *     query string is kept byte-for-byte (order, encoding, "+" vs "%20").
 *   • The path, host and #fragment are never altered (except Amazon's
 *     "/ref=…" path suffix on product pages, which Amazon itself ignores).
 *   • Signed URLs, unsubscribe/preference links, sign-in & payment hosts,
 *     marketing dashboards and local dev hosts are never modified.
 *   • Redirect wrappers are only unwrapped when the destination is a valid
 *     absolute http(s) URL.
 */
(function (root) {
  'use strict';

  const R = root.ClinkRules;
  if (!R) throw new Error('ClinkRules must load before ClinkCleaner');

  const lower = (list) => list.map((s) => s.toLowerCase());
  const toSet = (list) => new Set(lower(list || []));

  const GLOBAL = {
    trackers: toSet(R.TRACKERS),
    campaign: toSet(R.CAMPAIGN),
    affiliate: toSet(R.AFFILIATE),
  };
  const CAMPAIGN_PREFIXES = lower(R.CAMPAIGN_PREFIXES);
  const TRACKER_PREFIXES = lower(R.TRACKER_PREFIXES);

  function hostIn(host, domains) {
    for (const d of domains) {
      if (host === d || host.endsWith('.' + d)) return true;
    }
    return false;
  }

  function hostMatcher(entry) {
    if (entry.hostRe) {
      const re = new RegExp('^' + entry.hostRe + '$', 'i');
      return (h) => re.test(h);
    }
    if (entry.hosts) {
      const set = new Set(entry.hosts);
      return (h) => set.has(h);
    }
    if (entry.domains) {
      const domains = entry.domains;
      return (h) => hostIn(h, domains);
    }
    return () => true;
  }

  function pathMatcher(entry) {
    if (entry.path) {
      const p = entry.path;
      return (path) => path === p || path === p + '/';
    }
    if (entry.pathPrefix) {
      const p = entry.pathPrefix;
      return (path) => path.startsWith(p);
    }
    return () => true;
  }

  const SITES = R.SITES.map((s) => ({
    name: s.name,
    matchHost: hostMatcher(s),
    matchPath: pathMatcher(s),
    params: toSet(s.params),
    affiliate: toSet(s.affiliate),
    prefixes: lower(s.prefixes || []),
    pathRule: s.pathRule
      ? { re: new RegExp(s.pathRule.re), replace: s.pathRule.replace, label: s.pathRule.label }
      : null,
  }));

  const CONDITIONAL = R.CONDITIONAL.map((c) => ({
    name: c.name,
    category: c.category,
    matchHost: hostMatcher(c),
    when: toSet(c.when),
    params: toSet(c.params),
  }));

  const REDIRECTORS = R.REDIRECTORS.map((r) => ({
    name: r.name,
    category: r.category || null,
    matchHost: hostMatcher(r),
    matchPath: pathMatcher(r),
    params: r.params || [],
    decode: r.decode || null,
    allowRelative: !!r.allowRelative,
    stripSuffix: r.stripSuffix ? new RegExp(r.stripSuffix) : null,
  }));

  const SAFETY = {
    toolHosts: R.SAFETY.toolHosts,
    authHosts: R.SAFETY.authHosts,
    localDomains: R.SAFETY.localDomains,
    urlKeywords: lower(R.SAFETY.urlKeywords),
    signatureParams: toSet(R.SAFETY.signatureParams),
  };

  const ALL_ON = Object.freeze({ trackers: true, campaign: true, sites: true, affiliate: true });
  const DEFAULT_OPTIONS = Object.freeze({ enabled: true, categories: ALL_ON, unwrap: true, paused: [] });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function safeDecode(s) {
    try {
      return decodeURIComponent(s.replace(/\+/g, ' '));
    } catch (_) {
      return s;
    }
  }

  function normHost(hostname) {
    let h = String(hostname || '').toLowerCase();
    if (h.endsWith('.')) h = h.slice(0, -1);
    return h;
  }

  function isIpHost(host) {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
  }

  function isLocalHost(host) {
    return isIpHost(host) || hostIn(host, SAFETY.localDomains);
  }

  /** Pages where the page layer should stay completely quiet. */
  function isQuietPage(hostname) {
    const host = normHost(hostname);
    return !host || isLocalHost(host) || hostIn(host, SAFETY.toolHosts);
  }

  function isPausedHost(hostname, paused) {
    if (!paused || !paused.length) return false;
    return hostIn(normHost(hostname), paused);
  }

  function queryKeys(search) {
    if (!search || search.length < 2) return [];
    return search.slice(1).split('&').map((seg) => {
      const i = seg.indexOf('=');
      return safeDecode(i < 0 ? seg : seg.slice(0, i));
    });
  }

  /** Why this URL must not be modified, or null when it's fine to clean. */
  function protectedReason(u, host) {
    if (isLocalHost(host)) return 'local';
    if (hostIn(host, SAFETY.toolHosts)) return 'tool';
    if (hostIn(host, SAFETY.authHosts)) return 'auth';
    const haystack = (host + u.pathname + u.search).toLowerCase();
    for (const kw of SAFETY.urlKeywords) {
      if (haystack.includes(kw)) return 'preferences';
    }
    for (const k of queryKeys(u.search)) {
      if (SAFETY.signatureParams.has(k.toLowerCase())) return 'signed';
    }
    return null;
  }

  function sitesFor(host, path) {
    return SITES.filter((s) => s.matchHost(host) && s.matchPath(path));
  }

  /** Category of a (lower-cased) parameter name on this site, or null. */
  function classify(lk, sites, conds) {
    if (GLOBAL.trackers.has(lk) || TRACKER_PREFIXES.some((p) => lk.startsWith(p))) return 'trackers';
    if (GLOBAL.campaign.has(lk) || CAMPAIGN_PREFIXES.some((p) => lk.startsWith(p))) return 'campaign';
    if (GLOBAL.affiliate.has(lk)) return 'affiliate';
    for (const s of sites) {
      if (s.params.has(lk) || s.prefixes.some((p) => lk.startsWith(p))) return 'sites';
      if (s.affiliate.has(lk)) return 'affiliate';
    }
    for (const c of conds) {
      if (c.params.has(lk)) return c.category;
    }
    return null;
  }

  /** Public helper: is `key` a tracker Clink knows about for this URL? */
  function trackerCategory(key, url) {
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      return null;
    }
    const host = normHost(u.hostname);
    const keys = new Set(queryKeys(u.search).map((k) => k.toLowerCase()));
    const conds = CONDITIONAL.filter((c) => c.matchHost(host) && [...c.when].some((w) => keys.has(w)));
    return classify(String(key).toLowerCase(), sitesFor(host, u.pathname), conds);
  }

  // ---------------------------------------------------------------------------
  // Parameter stripping
  // ---------------------------------------------------------------------------

  function stripParams(u, host, cats, removed) {
    const search = u.search;
    if (search.length < 2) return false;

    const segments = search.slice(1).split('&');
    const keys = segments.map((seg) => {
      const i = seg.indexOf('=');
      return safeDecode(i < 0 ? seg : seg.slice(0, i));
    });
    const lowerKeys = keys.map((k) => k.toLowerCase());
    const present = new Set(lowerKeys);

    const sites = sitesFor(host, u.pathname);
    const conds = CONDITIONAL.filter(
      (c) => c.matchHost(host) && [...c.when].some((w) => present.has(w))
    );

    const kept = [];
    let changed = false;
    for (let i = 0; i < segments.length; i++) {
      const lk = lowerKeys[i];
      const cat = lk ? classify(lk, sites, conds) : null;
      if (cat && cats[cat]) {
        changed = true;
        if (!removed.includes(keys[i])) removed.push(keys[i]);
      } else {
        kept.push(segments[i]);
      }
    }
    if (!changed) return false;

    // We're rewriting anyway, so drop empty segments ("?a=1&&b=2").
    const tidy = kept.filter((s) => s !== '');
    u.search = tidy.length ? '?' + tidy.join('&') : '';
    return true;
  }

  function applyPathRules(u, host, cats, removed) {
    if (!cats.sites) return false;
    let changed = false;
    for (const s of sitesFor(host, u.pathname)) {
      if (!s.pathRule) continue;
      const next = u.pathname.replace(s.pathRule.re, s.pathRule.replace);
      if (next !== u.pathname) {
        u.pathname = next;
        removed.push(s.pathRule.label);
        changed = true;
      }
    }
    return changed;
  }

  // ---------------------------------------------------------------------------
  // Redirect unwrapping
  // ---------------------------------------------------------------------------

  function decodeBing(v) {
    if (!v || !v.startsWith('a1')) return null;
    let b64 = v.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    try {
      const bin = atob(b64);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch (_) {
      return null;
    }
  }

  function extractTarget(r, u) {
    const candidates = [];
    if (r.decode === 'yahoo') {
      const m = u.pathname.match(/\/RU=([^/]+)\//);
      if (m) candidates.push(safeDecode(m[1]));
    } else if (r.decode === 'rawQuery') {
      if (u.search.length > 1) candidates.push(u.search.slice(1));
    } else {
      for (const p of r.params) {
        const v = u.searchParams.get(p);
        if (v) candidates.push(r.decode === 'bing' ? decodeBing(v) : v);
      }
    }

    for (let c of candidates) {
      if (!c) continue;
      c = c.trim();
      if (/^https?%3A/i.test(c)) c = safeDecode(c); // double-encoded
      if (r.allowRelative && c.startsWith('/') && !c.startsWith('//')) {
        c = u.origin + c;
      }
      if (r.stripSuffix) {
        if (!r.stripSuffix.test(c)) continue; // unexpected format: don't guess
        c = c.replace(r.stripSuffix, '');
      }
      if (!/^https?:\/\/[^/]/i.test(c)) continue;
      try {
        const t = new URL(c);
        if ((t.protocol === 'http:' || t.protocol === 'https:') && t.href !== u.href) return t;
      } catch (_) {
        /* not a URL — try the next candidate */
      }
    }
    return null;
  }

  function unwrapOnce(u, host, opts) {
    for (const r of REDIRECTORS) {
      if (r.category === 'affiliate' && !opts.categories.affiliate) continue;
      if (!r.matchHost(host) || !r.matchPath(u.pathname)) continue;
      const target = extractTarget(r, u);
      if (target) return { target, name: r.name };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function clean(input, options) {
    const opts = options || DEFAULT_OPTIONS;
    const cats = opts.categories || ALL_ON;
    const res = { url: input, changed: false, removed: [], unwrapped: [], skipped: null };

    if (opts.enabled === false) return res;
    if (typeof input !== 'string' || input.length > 32768 || !/^https?:/i.test(input)) return res;

    let u;
    try {
      u = new URL(input);
    } catch (_) {
      return res;
    }

    let changed = false;

    if (opts.unwrap !== false) {
      for (let depth = 0; depth < 5; depth++) {
        const host = normHost(u.hostname);
        if (isPausedHost(host, opts.paused)) break;
        const w = unwrapOnce(u, host, opts);
        if (!w) break;
        res.unwrapped.push(w.name);
        u = w.target;
        changed = true;
      }
    }

    const host = normHost(u.hostname);
    const reason = isPausedHost(host, opts.paused) ? 'paused' : protectedReason(u, host);
    if (reason) {
      res.skipped = reason;
    } else {
      if (stripParams(u, host, cats, res.removed)) changed = true;
      if (applyPathRules(u, host, cats, res.removed)) changed = true;
    }

    if (changed) {
      const out = u.href;
      if (out !== input) {
        res.url = out;
        res.changed = true;
      }
    }
    return res;
  }

  /** Cheap pre-filter: can this absolute URL possibly need cleaning? */
  function mightNeedCleaning(href) {
    return (
      typeof href === 'string' &&
      (href.indexOf('?') !== -1 || href.indexOf('/ref=') !== -1 || href.indexOf('/RU=') !== -1)
    );
  }

  /** Convert stored settings into cleaner options. */
  function optionsFromSettings(settings) {
    const s = settings || {};
    const paused = []
      .concat(s.pausedSites || [])
      .concat((s.guardedSites || []).map((g) => (typeof g === 'string' ? g : g.host)))
      .filter(Boolean)
      .map(normHost);
    return {
      enabled: s.enabled !== false,
      categories: Object.assign({}, ALL_ON, s.categories || {}),
      unwrap: s.unwrapRedirects !== false,
      paused,
    };
  }

  root.ClinkCleaner = Object.freeze({
    clean,
    mightNeedCleaning,
    optionsFromSettings,
    trackerCategory,
    isQuietPage,
    isPausedHost,
    normHost,
    hostIn,
    queryKeys,
    DEFAULT_OPTIONS,
  });
})(globalThis);
