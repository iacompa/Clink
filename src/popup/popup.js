// SPDX-License-Identifier: GPL-3.0-or-later
(async () => {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const C = globalThis.ClinkCleaner;
  const S = globalThis.ClinkSettings;
  const $ = (id) => document.getElementById(id);

  const send = (msg) => api.runtime.sendMessage(msg).catch(() => null);
  const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

  let settings = await S.load();
  // ?tab=<id> lets the settings page / tests show the popup for a specific tab.
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  const [tab] = forced
    ? [await api.tabs.get(forced)]
    : await api.tabs.query({ active: true, currentWindow: true });
  let pageUrl = null;
  try {
    const u = new URL(tab && tab.url);
    if (u.protocol === 'http:' || u.protocol === 'https:') pageUrl = u;
  } catch (_) {
    /* browser page */
  }
  let info = (tab && (await send({ type: 'clink:popup', tabId: tab.id }))) || {};

  // Public versions always have exactly one decimal point: 1.0, 1.1, 2.0 (never 1 or 1.0.0).
  const [major, minor = '0'] = api.runtime.getManifest().version.split('.');
  const version = `${major}.${minor}`;
  $('version').textContent = `Version ${version}`;

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function chip(text, cls) {
    const el = document.createElement('span');
    el.className = 'chip' + (cls ? ' ' + cls : '');
    el.textContent = text;
    el.title = text;
    return el;
  }

  function fillChips(container, removed, unwrapped) {
    container.replaceChildren();
    for (const u of unwrapped || []) container.append(chip(`skipped ${u} redirect`, 'unwrap'));
    for (const r of removed || []) container.append(chip(r));
  }

  function siteState() {
    if (!pageUrl) return { kind: 'browser' };
    const host = pageUrl.hostname;
    if (C.isQuietPage(host)) return { kind: 'quiet', host };
    const guard = settings.guardedSites.find((g) => C.isPausedHost(host, [g.host]));
    if (guard) return { kind: 'guarded', host, guard };
    if (C.isPausedHost(host, settings.pausedSites)) return { kind: 'paused', host };
    return { kind: 'on', host };
  }

  function render() {
    document.body.classList.toggle('off', !settings.enabled);
    $('masterSwitch').checked = settings.enabled;
    $('masterStatus').textContent = settings.enabled ? 'Cleaning links automatically' : 'Off — links are not being cleaned';

    // ---- current site
    const st = siteState();
    const sw = $('siteSwitch');
    $('siteToggleWrap').classList.toggle('hidden', st.kind === 'browser' || st.kind === 'quiet');
    sw.checked = st.kind === 'on';
    sw.disabled = !settings.enabled;

    const sub = $('siteSub');
    sub.replaceChildren();
    if (st.kind === 'browser') {
      $('siteHost').textContent = 'This page';
      sub.textContent = "Clink doesn’t run on browser pages.";
    } else {
      $('siteHost').textContent = st.host.replace(/^www\./, '');
      const count = (info.tab && info.tab.links) || 0;
      if (!settings.enabled) sub.textContent = 'Clink is turned off.';
      else if (st.kind === 'quiet') sub.textContent = 'Clink stays out of the way on marketing tools and local dev sites.';
      else if (st.kind === 'guarded') sub.textContent = 'Paused by Link Guard';
      else if (st.kind === 'paused') sub.textContent = "Paused — links to this site aren’t cleaned";
      else if (count) {
        const strong = document.createElement('strong');
        strong.textContent = plural(count, 'link');
        sub.append(strong, ' cleaned on this page');
      } else if (info.tab && info.tab.nav) sub.textContent = 'Tracking removed from this page’s address';
      else sub.textContent = 'No tracking links found on this page';
    }

    // ---- page address cleaned by the network layer
    const nav = info.tab && info.tab.nav;
    const showNav = !!(nav && settings.enabled && st.kind !== 'browser');
    $('navClean').classList.toggle('hidden', !showNav);
    if (showNav) {
      fillChips($('navChips'), nav.removed, []);
      $('restoreBtn').classList.toggle('hidden', !info.linkGuardAvailable);
    }

    // ---- Link Guard note
    const note = $('guardNote');
    note.classList.toggle('hidden', st.kind !== 'guarded');
    if (st.kind === 'guarded') {
      note.replaceChildren();
      const params = (st.guard.params || []).join(', ') || 'its parameters';
      note.append(`Link Guard turned Clink off here because a link to this site stopped working without ${params}. `);
      const resume = document.createElement('button');
      resume.className = 'btn link';
      resume.textContent = 'Clean it anyway';
      resume.addEventListener('click', () => setSitePaused(st.host, false));
      note.append(resume);
    }

    // ---- stats
    const stats = info.stats || {};
    $('statClicks').textContent = ((stats.clicks || 0) + (stats.copies || 0)).toLocaleString();
    $('statParams').textContent = ((stats.params || 0) + (stats.unwrapped || 0)).toLocaleString();

    // ---- recent
    const list = $('recent');
    list.replaceChildren();
    const LABEL = { navigation: 'address cleaned', link: 'link clicked', copy: 'link copied', guard: 'Link Guard restored a link' };
    const items = (info.recent || []).filter((e) => LABEL[e.kind]);
    for (const e of items.slice(0, 15)) {
      const li = document.createElement('li');
      if (e.kind === 'guard') li.className = 'guard';
      const host = document.createElement('div');
      host.className = 'r-host';
      host.textContent = (e.host || '').replace(/^www\./, '') + ' ';
      const kind = document.createElement('span');
      kind.className = 'r-kind';
      kind.textContent = '· ' + LABEL[e.kind];
      host.append(kind);
      const time = document.createElement('div');
      time.className = 'r-time';
      time.textContent = ago(e.t);
      const chips = document.createElement('div');
      chips.className = 'chips';
      fillChips(chips, e.removed, e.unwrapped);
      li.append(host, time, chips);
      list.append(li);
    }
    $('recentEmpty').classList.toggle('hidden', items.length > 0);
    $('clearRecent').classList.toggle('hidden', items.length === 0);
    document.body.dataset.ready = '1';
  }

  function ago(t) {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async function setSitePaused(host, paused) {
    const key = S.siteKey(host);
    settings = await S.update((s) => {
      s.pausedSites = s.pausedSites.filter((h) => !C.isPausedHost(host, [h]));
      s.guardedSites = s.guardedSites.filter((g) => !C.isPausedHost(host, [g.host]));
      if (paused) s.pausedSites.push(key);
    });
    render();
  }

  $('masterSwitch').addEventListener('change', async (e) => {
    settings = await S.update((s) => {
      s.enabled = e.target.checked;
    });
    render();
  });

  $('siteSwitch').addEventListener('change', (e) => {
    if (pageUrl) setSitePaused(pageUrl.hostname, !e.target.checked);
  });

  $('restoreBtn').addEventListener('click', async () => {
    await send({ type: 'clink:restore', tabId: tab.id });
    window.close();
  });

  $('clearRecent').addEventListener('click', async () => {
    await send({ type: 'clink:clearRecent' });
    info.recent = [];
    render();
  });

  $('openSettings').addEventListener('click', (e) => {
    e.preventDefault();
    api.runtime.openOptionsPage();
    window.close();
  });

  // ---- Clean a link
  const SKIP_REASON = {
    signed: 'Left as-is: this is a signed link — changing it would break it.',
    redirect: 'Left as-is: this email redirect needs its IDs to find the page. Clink cleans the page it opens.',
    preferences: 'Left as-is: looks like an unsubscribe or email-preferences link, which needs its IDs.',
    auth: 'Left as-is: sign-in and payment links are never modified.',
    tool: 'Left as-is: marketing-tool links keep their tags.',
    local: 'Left as-is: local development address.',
  };
  let lastClean = '';
  function updateClean() {
    const raw = $('cleanInput').value.trim();
    const out = $('cleanOut');
    if (!raw) {
      out.classList.add('hidden');
      return;
    }
    const opts = C.optionsFromSettings(Object.assign({}, settings, { enabled: true, pausedSites: [], guardedSites: [] }));
    const res = C.clean(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw, opts);
    lastClean = res.url;
    out.classList.remove('hidden');
    out.classList.toggle('same', !res.changed);
    $('cleanUrl').textContent = res.changed ? res.url : (SKIP_REASON[res.skipped] || 'Already clean — no trackers found.');
    fillChips($('cleanChips'), res.removed, res.unwrapped);
    $('copyBtn').classList.toggle('hidden', !res.changed);
    $('copyBtn').textContent = 'Copy';
  }
  $('cleanInput').addEventListener('input', updateClean);
  $('copyBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(lastClean);
      $('copyBtn').textContent = 'Copied ✓';
    } catch (_) {
      $('copyBtn').textContent = 'Press ⌘/Ctrl+C';
      const r = document.createRange();
      r.selectNodeContents($('cleanUrl'));
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    }
  });

  // ---- host permission (Firefox / Safari can withhold it)
  try {
    const ok = await api.permissions.contains({ origins: ['<all_urls>'] });
    if (!ok) {
      $('permBanner').classList.remove('hidden');
      $('grantBtn').addEventListener('click', async () => {
        const granted = await api.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
        if (granted) $('permBanner').classList.add('hidden');
      });
    }
  } catch (_) {
    /* permissions API unavailable */
  }

  render();
})();
