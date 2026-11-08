// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Validates the generated declarativeNetRequest rulesets and runs them through
 * a small simulator of Chrome's matching semantics (highest priority wins, one
 * action per request, allow rules block lower priorities, a no-op redirect
 * stops evaluation). The network layer must agree with the page-layer cleaner.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateRulesets, RULESET_IDS, DISABLED_BY_DEFAULT } from '../../scripts/dnr.mjs';
import '../../src/shared/cleaner.js';
import { GLOBAL as LONG_TAIL, SITE_ONLY, NOT_ADDED, STRICT_KEEP, ELOQUA_REDIRECT } from './long-tail-params.mjs';

const C = globalThis.ClinkCleaner;

function urlFilterToRegExp(filter, caseSensitive) {
  let f = filter;
  let prefix = '';
  if (f.startsWith('||')) {
    prefix = '^[a-z]+://(?:[^/?#]*\\.)?';
    f = f.slice(2);
  } else if (f.startsWith('|')) {
    prefix = '^';
    f = f.slice(1);
  }
  let src = '';
  for (const ch of f) {
    if (ch === '*') src += '.*';
    else if (ch === '^') src += '(?:[^A-Za-z0-9_\\-.%]|$)';
    else src += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(prefix + src, caseSensitive === false ? 'i' : '');
}

function hostMatchesDomains(host, domains) {
  return domains.some((d) => host === d || host.endsWith('.' + d));
}

function ruleMatches(rule, url) {
  const c = rule.condition;
  const u = new URL(url);
  if (c.requestDomains && !hostMatchesDomains(u.hostname, c.requestDomains)) return false;
  if (c.initiatorDomains) return false; // simulated requests are browser-initiated
  if (c.urlFilter && !urlFilterToRegExp(c.urlFilter, c.isUrlFilterCaseSensitive).test(url)) return false;
  if (c.regexFilter && !new RegExp(c.regexFilter, c.isUrlFilterCaseSensitive === false ? 'i' : '').test(url)) return false;
  return true;
}

function applyRule(rule, url) {
  const r = rule.action.redirect;
  if (r.regexSubstitution) {
    const re = new RegExp(rule.condition.regexFilter);
    return url.replace(re, r.regexSubstitution.replace(/\\(\d)/g, '$$$1'));
  }
  const remove = new Set(r.transform.queryTransform.removeParams);
  const u = new URL(url);
  if (u.search.length < 2) return url;
  const kept = u.search.slice(1).split('&').filter((seg) => !remove.has(seg.split('=')[0]));
  u.search = kept.length ? '?' + kept.join('&') : '';
  return u.href;
}

function simulate(rules, url) {
  for (let hop = 0; hop < 20; hop++) {
    const matching = rules.filter((r) => ruleMatches(r, url));
    if (!matching.length) return url;
    const top = Math.max(...matching.map((r) => r.priority));
    const best = matching.filter((r) => r.priority === top);
    if (best.some((r) => r.action.type === 'allow')) return url;
    const next = applyRule(best[0], url);
    if (next === url) return url; // no-op: Chrome stops here
    url = next;
  }
  throw new Error('redirect loop for ' + url);
}

const standard = generateRulesets('standard');
const safari = generateRulesets('safari');
// What a fresh install runs (Strict is off), and everything with Strict on.
const DEFAULT_IDS = RULESET_IDS.filter((id) => !DISABLED_BY_DEFAULT.includes(id));
const allStandard = DEFAULT_IDS.flatMap((id) => standard[id]);
const allSafari = DEFAULT_IDS.flatMap((id) => safari[id]);
const strictStandard = RULESET_IDS.flatMap((id) => standard[id]);
const strictSafari = RULESET_IDS.flatMap((id) => safari[id]);

test('rulesets are structurally valid', () => {
  for (const [name, sets] of [['standard', standard], ['safari', safari]]) {
    for (const id of RULESET_IDS) {
      const ids = new Set();
      for (const r of sets[id]) {
        assert.ok(Number.isInteger(r.id) && r.id > 0, `${name}/${id} bad id`);
        assert.ok(!ids.has(r.id), `${name}/${id} duplicate id ${r.id}`);
        ids.add(r.id);
        assert.deepEqual(r.condition.resourceTypes, ['main_frame'], `${name}/${id}#${r.id} must only touch top-level navigations`);
        assert.ok(r.priority >= 1);
        if (r.condition.regexFilter) new RegExp(r.condition.regexFilter); // compiles
        if (r.condition.requestDomains) {
          for (const d of r.condition.requestDomains) assert.match(d, /^[a-z0-9.-]+$/, `domain ${d}`);
        }
      }
    }
  }
  const regexCount = strictStandard.filter((r) => r.condition.regexFilter).length;
  assert.ok(regexCount < 1000, `Chrome allows 1000 regex rules, have ${regexCount}`);
  assert.ok(strictStandard.length < 30000 && strictSafari.length < 30000);
  // Safari flavor must not use features its engine lacks
  for (const r of strictSafari) {
    assert.ok(!r.condition.regexFilter, 'no regex in Safari rules');
    assert.ok(!r.condition.requestMethods, 'no requestMethods in Safari rules');
    assert.ok(!r.condition.initiatorDomains, 'no initiatorDomains in Safari rules');
    assert.ok(!r.action.redirect || !r.action.redirect.regexSubstitution);
  }
});

// URLs where the network layer should produce exactly what the page layer does.
const AGREE = [
  ELOQUA_REDIRECT,
  'https://example.com/e/error?elqTrackId=abc&id=1',
  // a /ref= *path* segment must not stop the query trackers from being removed
  'https://www.amazon.com/gp/bestsellers/electronics/ref=zg_bs_nav_0?fbclid=IwAR123&utm_source=fb',
  'https://www.amazon.com/s/ref=nb_sb_noss?url=search-alias%3Daps&field-keywords=x&gclid=abc',
  'https://substack.com/app-link/post?publication_id=1&post_id=137200077&utm_source=post-email-title&isFreemail=true',
  'https://example.com/adopting-a-dog?utm_source=x&page=2',
  'https://news.example.com/opting-out?mc_eid=abc&utm_source=x',
  'https://lists.example.com/newsletter-optin/confirm?mc_eid=1&utm_source=x',
  'https://example.com/page?utm_source=newsletter&utm_medium=email&id=42',
  'https://example.com/?fbclid=IwAR3abc',
  'https://shop.example.com/p?gclid=abc&color=red',
  'https://example.com/s?q=a%20b+c&utm_campaign=x&e=%2F',
  'https://blog.example.com/post?_hsenc=p2AN&_hsmi=123&__hstc=1&page=2',
  'https://example.com/x?msclkid=1&ttclid=2&twclid=3&li_fat_id=4&srsltid=5&utm_source=z&mc_eid=q',
  'https://www.amazon.com/Echo-Dot/dp/B09B8V1LZ3/ref=sr_1_1?crid=2X&keywords=echo+dot&qid=1700000000&sprefix=echo%2Caps%2C150&sr=8-1&th=1&psc=1&tag=affil-20',
  'https://www.amazon.co.uk/s?k=headphones&crid=ABC&sprefix=head%2Caps&ref=nb_sb_noss',
  'https://youtu.be/dQw4w9WgXcQ?si=abcDEF&t=42',
  'https://x.com/user/status/123?s=20&t=abcXYZ',
  'https://www.google.com/search?q=clink&oq=clink&gs_lcrp=EgZ&sourceid=chrome&ie=UTF-8&ved=0ahU&ei=abc',
  'https://www.google.co.uk/search?q=x&sca_esv=1&sxsrf=2',
  'https://www.tiktok.com/@user/video/123?is_from_webapp=1&sender_device=pc&web_id=999',
  'https://www.linkedin.com/jobs/view/123/?trackingId=abc&refId=xyz&trk=public_jobs',
  'https://www.ebay.com/itm/1234567?_trkparms=abc&_trksid=p123&var=55&hash=item1&campid=5',
  'https://www.reddit.com/r/x/comments/abc/title/?share_id=123&utm_content=1&utm_medium=ios_app&context=3',
  'https://shop.example.com/products/mug?_pos=1&_sid=abc123&_ss=r&variant=42',
  'https://www.booking.com/hotel/x.html?aid=304142&label=gen173&sid=abc&checkin=2026-12-01',
  // must-not-change cases
  'https://github.com/o/r/blob/main/x.js?ref=v2',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL1&index=3',
  'https://example.com/?s=search+term&t=1&si=2',
  'https://info.example.com/hs/manage-preferences/unsubscribe?_hsenc=abc&utm_source=hs_email',
  'https://go.example.com/UnsubscribePage.html?mkt_unsubscribe=1&mkt_tok=MTIz',
  'https://bucket.s3.amazonaws.com/file.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc&utm_source=x',
  'http://localhost:3000/?utm_source=test',
  'http://127.0.0.1:8080/?fbclid=1',
  'http://myapp.test/?gclid=1',
  'https://ga-dev-tools.google/campaign-url-builder/?utm_source=x',
  'https://accounts.google.com/o/oauth2/auth?client_id=1&utm_source=x',
  'https://www.amazon.com/dp/B000000001?th=1&psc=1&smid=A1B2',
  'https://www.google.com/maps/place/x?ved=1',
  'https://www.google.com/url?q=https://example.com/&ved=1&usg=x',
];

test('network layer agrees with the page layer (Chrome/Firefox rules)', () => {
  for (const url of AGREE) {
    assert.equal(simulate(allStandard, url), C.clean(url, Object.assign({}, C.DEFAULT_OPTIONS, { unwrap: false })).url, url);
  }
});

test('Safari rules clean the common cases and never break the protected ones', () => {
  const opts = Object.assign({}, C.DEFAULT_OPTIONS, { unwrap: false });
  for (const url of AGREE) {
    const out = simulate(allSafari, url);
    const page = C.clean(url, opts);
    if (!page.changed) assert.equal(out, url, `Safari changed a protected URL: ${url}`);
    // Safari may clean slightly less (no regex/path rules), but never something the page layer keeps
    const kept = new Set(C.queryKeys(new URL(page.url).search));
    for (const k of C.queryKeys(new URL(url).search)) {
      if (kept.has(k)) assert.ok(C.queryKeys(new URL(out).search).includes(k), `Safari removed ${k} from ${url}`);
    }
  }
  assert.equal(simulate(allSafari, 'https://example.com/?utm_source=a&fbclid=b&x=1'), 'https://example.com/?x=1');
});

test('network rules remove each long-tail tracker in Chrome, Firefox and Safari', () => {
  const opts = Object.assign({}, C.DEFAULT_OPTIONS, { unwrap: false });
  for (const p of Object.values(LONG_TAIL).flat()) {
    const url = `https://shop.example.com/p/1?id=42&${p}=abc123`;
    assert.equal(simulate(allStandard, url), 'https://shop.example.com/p/1?id=42', `Chrome/Firefox: ${p}`);
    assert.equal(simulate(allSafari, url), 'https://shop.example.com/p/1?id=42', `Safari: ${p}`);
  }
  for (const [onSite, elsewhere] of SITE_ONLY) {
    assert.equal(simulate(allStandard, onSite), C.clean(onSite, opts).url, onSite);
    assert.equal(simulate(allSafari, onSite), C.clean(onSite, opts).url, `Safari: ${onSite}`);
    assert.equal(simulate(allStandard, elsewhere), elsewhere, elsewhere);
    assert.equal(simulate(allSafari, elsewhere), elsewhere, `Safari: ${elsewhere}`);
  }
});

test('category rulesets are independent (toggling one keeps the others working)', () => {
  const url = 'https://www.amazon.com/dp/B000000001?tag=me-20&utm_source=x&fbclid=1&pd_rd_w=z';
  const only = (...ids) => ids.flatMap((id) => standard[id]).concat(standard.safety);
  assert.equal(simulate(only('trackers', 'campaign', 'sites'), url), 'https://www.amazon.com/dp/B000000001?tag=me-20');
  assert.equal(simulate(only('trackers', 'sites', 'affiliate'), url), 'https://www.amazon.com/dp/B000000001?utm_source=x');
  assert.equal(simulate(only('campaign'), url), 'https://www.amazon.com/dp/B000000001?tag=me-20&fbclid=1&pd_rd_w=z');
});

test('Strict network rules are off by default and match the page layer when on', () => {
  const strictOn = Object.assign({}, C.DEFAULT_OPTIONS, {
    unwrap: false,
    categories: Object.assign({}, C.DEFAULT_OPTIONS.categories, { strict: true }),
  });
  for (const p of NOT_ADDED) {
    const url = `https://shop.example.com/p/1?id=42&${p}=abc123`;
    assert.equal(simulate(allStandard, url), url, `default Chrome/Firefox: ${p}`);
    assert.equal(simulate(allSafari, url), url, `default Safari: ${p}`);
  }
  for (const g of globalThis.ClinkRules.STRICT) {
    for (const p of g.params) {
      const url = `https://shop.example.com/p/1?id=42&${p}=abc123`;
      assert.equal(simulate(allStandard, url), url, `default: ${p}`);
      assert.equal(simulate(strictStandard, url), 'https://shop.example.com/p/1?id=42', `Strict Chrome/Firefox: ${p}`);
      assert.equal(simulate(strictSafari, url), 'https://shop.example.com/p/1?id=42', `Strict Safari: ${p}`);
    }
  }
  for (const [url, expected] of STRICT_KEEP) {
    assert.equal(C.clean(url, strictOn).url, expected, url);
    assert.equal(simulate(strictStandard, url), expected, `Chrome/Firefox: ${url}`);
    assert.equal(simulate(strictSafari, url), expected, `Safari: ${url}`);
  }
  for (const url of AGREE) {
    assert.equal(simulate(strictStandard, url), C.clean(url, strictOn).url, `Strict: ${url}`);
  }
  // Strict on its own removes only its own trackers
  const only = (...ids) => ids.flatMap((id) => standard[id]).concat(standard.safety);
  assert.equal(simulate(only('strict'), 'https://a.example.com/?utm_source=x&gps_adid=1&cmpid=2'), 'https://a.example.com/?utm_source=x');
});
