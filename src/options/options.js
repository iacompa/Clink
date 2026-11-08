// SPDX-License-Identifier: GPL-3.0-or-later
(async () => {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const R = globalThis.ClinkRules;
  const S = globalThis.ClinkSettings;
  const $ = (id) => document.getElementById(id);

  let settings = await S.load();

  // Example parameters shown under each category
  const EXAMPLES = {
    trackers: ['fbclid', 'gclid', 'msclkid', 'ttclid', 'mc_eid', '_hsenc', 'mkt_tok'],
    campaign: ['utm_source', 'utm_medium', 'utm_campaign', 'pk_campaign'],
    sites: ['si (YouTube/Spotify)', 'pd_rd_* (Amazon)', 'ref_src (X)', 'trackingId (LinkedIn)'],
    affiliate: ['tag (Amazon)', 'cjevent', 'irclickid', 'aff_* (AliExpress)'],
    strict: ['cmpid', 'elq', 'gps_adid', 'af_adset', 'adjust_tracker'],
  };
  // Link Guard needs webRequest (not available in Safari)
  const HAS_LINK_GUARD = !!(api.webRequest && api.webRequest.onBeforeRedirect);

  // ---- category rows
  const catBox = $('categories');
  for (const [id, cat] of Object.entries(R.CATEGORIES)) {
    const row = document.createElement('div');
    row.className = 'row';
    const text = document.createElement('div');
    text.className = 'row-text';
    const title = document.createElement('div');
    title.className = 'row-title';
    title.textContent = cat.label;
    const desc = document.createElement('div');
    desc.className = 'row-desc';
    desc.textContent = cat.description;
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const ex of EXAMPLES[id] || []) {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = ex;
      chips.append(c);
    }
    desc.append(chips);
    if (cat.warning) {
      const warn = document.createElement('div');
      warn.className = 'warn small';
      warn.dataset.warning = id;
      warn.textContent = `${cat.warning} ${HAS_LINK_GUARD
        ? 'With Link Guard on, a link that breaks is reopened as the original and Clink stops cleaning that site.'
        : 'Safari can’t tell when a page breaks, so if one does, use “Reload with the original link” in Clink’s popup.'}`;
      desc.append(warn);
    }
    text.append(title, desc);
    const sw = document.createElement('input');
    sw.type = 'checkbox';
    sw.className = 'switch';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', cat.label);
    sw.dataset.category = id;
    row.append(text, sw);
    catBox.append(row);
  }

  function hostFromInput(v) {
    v = String(v || '').trim();
    if (!v) return null;
    try {
      const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : 'https://' + v);
      return /^[a-z0-9.-]+$/.test(u.hostname) && u.hostname.includes('.') ? S.siteKey(u.hostname) : null;
    } catch (_) {
      return null;
    }
  }

  function siteItem(host, why, onRemove) {
    const li = document.createElement('li');
    const h = document.createElement('div');
    h.className = 'host';
    h.textContent = host;
    if (why) {
      const w = document.createElement('span');
      w.className = 'why';
      w.textContent = why;
      h.append(w);
    }
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = 'Remove';
    b.addEventListener('click', onRemove);
    li.append(h, b);
    return li;
  }

  async function save(mutator) {
    settings = await S.update(mutator);
    render();
  }

  function render() {
    $('enabled').checked = settings.enabled;
    $('masterLabel').textContent = settings.enabled ? 'On' : 'Off';
    for (const sw of document.querySelectorAll('[data-category]')) {
      sw.checked = !!settings.categories[sw.dataset.category];
      sw.disabled = !settings.enabled;
    }
    for (const sw of document.querySelectorAll('[data-setting]')) {
      sw.checked = !!settings[sw.dataset.setting];
      sw.disabled = !settings.enabled;
    }

    const pl = $('pausedList');
    pl.replaceChildren();
    for (const host of settings.pausedSites) {
      pl.append(siteItem(host, '', () => save((s) => { s.pausedSites = s.pausedSites.filter((h) => h !== host); })));
    }
    $('pausedEmpty').classList.toggle('hidden', settings.pausedSites.length > 0);

    const gl = $('guardedList');
    gl.replaceChildren();
    for (const g of settings.guardedSites) {
      const when = g.added ? new Date(g.added).toLocaleDateString() : '';
      const why = `Needed ${(g.params || []).join(', ') || 'its parameters'}${g.reason ? ` (${g.reason})` : ''}${when ? ` · ${when}` : ''}`;
      gl.append(siteItem(g.host, why, () => save((s) => { s.guardedSites = s.guardedSites.filter((x) => x.host !== g.host); })));
    }
    $('guardedEmpty').classList.toggle('hidden', settings.guardedSites.length > 0);
  }

  async function renderStats() {
    const { stats } = await api.storage.local.get('stats');
    const s = stats || {};
    $('sClicks').textContent = ((s.clicks || 0) + (s.copies || 0)).toLocaleString();
    $('sParams').textContent = ((s.params || 0) + (s.unwrapped || 0)).toLocaleString();
    $('sUnwrapped').textContent = (s.unwrapped || 0).toLocaleString();
    $('sSince').textContent = s.since ? `Since ${new Date(s.since).toLocaleDateString()}` : '';
  }

  // ---- events
  $('enabled').addEventListener('change', (e) => save((s) => { s.enabled = e.target.checked; }));
  catBox.addEventListener('change', (e) => {
    const id = e.target.dataset.category;
    if (id) save((s) => { s.categories[id] = e.target.checked; });
  });
  for (const sw of document.querySelectorAll('[data-setting]')) {
    sw.addEventListener('change', (e) => save((s) => { s[sw.dataset.setting] = e.target.checked; }));
  }
  $('addPaused').addEventListener('submit', (e) => {
    e.preventDefault();
    const host = hostFromInput($('pausedInput').value);
    if (!host) {
      $('pausedInput').setCustomValidity('Enter a site like example.com');
      $('pausedInput').reportValidity();
      return;
    }
    $('pausedInput').setCustomValidity('');
    $('pausedInput').value = '';
    save((s) => { if (!s.pausedSites.includes(host)) s.pausedSites.push(host); });
  });
  $('pausedInput').addEventListener('input', () => $('pausedInput').setCustomValidity(''));
  $('resetStats').addEventListener('click', async () => {
    await api.storage.local.set({ stats: { clicks: 0, params: 0, unwrapped: 0, copies: 0, since: Date.now() } });
    renderStats();
  });

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      settings = S.normalize(changes.settings.newValue);
      render();
    }
    if (changes.stats) renderStats();
  });

  // ---- welcome + permissions
  if (location.hash === '#welcome') $('welcome').classList.remove('hidden');
  try {
    const ok = await api.permissions.contains({ origins: ['<all_urls>'] });
    if (!ok) {
      $('welcome').classList.remove('hidden');
      $('welcomePerm').classList.remove('hidden');
      $('grantBtn').addEventListener('click', async () => {
        const granted = await api.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
        if (granted) $('welcomePerm').classList.add('hidden');
      });
    }
  } catch (_) {
    /* ignore */
  }

  if (!HAS_LINK_GUARD) $('guardUnavailable').classList.remove('hidden');

  const version = api.runtime.getManifest().version.split('.').slice(0, 2).join('.').replace(/\.0$/, '');
  $('version').textContent = `Clink · Version ${version}`;
  render();
  renderStats();
})();
