// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../src/shared/rules.js';
import '../../src/shared/cleaner.js';

const C = globalThis.ClinkCleaner;
const b64url = (s) => Buffer.from(s).toString('base64url');

// [input, expected] — URLs Clink MUST clean.
const MUST_CLEAN = [
  // ---- global trackers & campaign tags
  ['https://example.com/page?utm_source=newsletter&utm_medium=email&id=42', 'https://example.com/page?id=42'],
  ['https://example.com/?fbclid=IwAR3abc', 'https://example.com/'],
  ['https://shop.example.com/p?gclid=abc&color=red#reviews', 'https://shop.example.com/p?color=red#reviews'],
  ['https://example.com/s?q=a%20b+c&utm_campaign=x&e=%2F', 'https://example.com/s?q=a%20b+c&e=%2F'],
  ['https://example.com/?UTM_SOURCE=x&Fbclid=y&a=1', 'https://example.com/?a=1'],
  ['https://example.com/?utm_whatever_new=1&b=2', 'https://example.com/?b=2'],
  ['https://example.com/?utm%5Fsource=x&a=1', 'https://example.com/?a=1'],
  ['https://example.com/?a=1&&utm_source=x&', 'https://example.com/?a=1'],
  ['https://example.com/?utm_source=x#top', 'https://example.com/#top'],
  ['https://example.com/page?utm_source=x#:~:text=hello', 'https://example.com/page#:~:text=hello'],
  ['https://blog.example.com/post?_hsenc=p2AN&_hsmi=123&__hstc=1&page=2', 'https://blog.example.com/post?page=2'],
  ['https://example.com/?mc_cid=abc&mc_eid=def', 'https://example.com/'],
  ['https://example.com/x?msclkid=1&ttclid=2&twclid=3&li_fat_id=4&srsltid=5', 'https://example.com/x'],
  ['https://example.com/share?url=https%3A%2F%2Fother.com%2F%3Futm_source%3Dx&utm_medium=social',
    'https://example.com/share?url=https%3A%2F%2Fother.com%2F%3Futm_source%3Dx'],
  ['https://example.com/?_ga=2.1234.5678-9&_gl=1*abc*_ga*MTIz', 'https://example.com/'],

  // ---- site-specific
  ['https://www.amazon.com/Echo-Dot/dp/B09B8V1LZ3/ref=sr_1_1?crid=2X&keywords=echo+dot&qid=1700000000&sprefix=echo%2Caps%2C150&sr=8-1&th=1&psc=1&tag=affil-20',
    'https://www.amazon.com/Echo-Dot/dp/B09B8V1LZ3?keywords=echo+dot&th=1&psc=1'],
  ['https://www.amazon.co.uk/s?k=headphones&crid=ABC&sprefix=head%2Caps&ref=nb_sb_noss', 'https://www.amazon.co.uk/s?k=headphones'],
  ['https://www.amazon.de/dp/B000000001?pd_rd_w=a&pf_rd_p=b&pd_rd_r=c&smid=SELLER', 'https://www.amazon.de/dp/B000000001?smid=SELLER'],
  ['https://youtu.be/dQw4w9WgXcQ?si=abcDEF&t=42', 'https://youtu.be/dQw4w9WgXcQ?t=42'],
  ['https://www.youtube.com/watch?v=abc&pp=ygUFaGVsbG8%3D&feature=shared', 'https://www.youtube.com/watch?v=abc'],
  ['https://x.com/user/status/123?s=20&t=abcXYZ', 'https://x.com/user/status/123'],
  ['https://twitter.com/user/status/123?ref_src=twsrc%5Etfw', 'https://twitter.com/user/status/123'],
  ['https://open.spotify.com/track/abc?si=123&context=spotify%3Aalbum%3Axyz', 'https://open.spotify.com/track/abc?context=spotify%3Aalbum%3Axyz'],
  ['https://www.instagram.com/p/Cabc/?igsh=MWQ1ZGUxMzBkMA==&img_index=2', 'https://www.instagram.com/p/Cabc/?img_index=2'],
  ['https://www.google.com/search?q=clink&oq=clink&gs_lcrp=EgZ&sourceid=chrome&ie=UTF-8&ved=0ahU&ei=abc',
    'https://www.google.com/search?q=clink&ie=UTF-8'],
  ['https://www.google.co.uk/search?q=x&sca_esv=1&sxsrf=2', 'https://www.google.co.uk/search?q=x'],
  ['https://docs.google.com/document/d/abc/edit?usp=sharing', 'https://docs.google.com/document/d/abc/edit'],
  ['https://www.facebook.com/groups/123/posts/456/?__cft__[0]=AZW&__tn__=%2CO%2CP-R', 'https://www.facebook.com/groups/123/posts/456/'],
  ['https://medium.com/@user/story-123?sk=abc&source=friends_link', 'https://medium.com/@user/story-123?sk=abc'],
  ['https://name.substack.com/p/post?r=abc&utm_campaign=post&utm_medium=web&showWelcomeOnShare=true&triedRedirect=true',
    'https://name.substack.com/p/post?triedRedirect=true'],
  ['https://www.tiktok.com/@user/video/123?is_from_webapp=1&sender_device=pc&web_id=999', 'https://www.tiktok.com/@user/video/123'],
  ['https://www.linkedin.com/jobs/view/123/?trackingId=abc&refId=xyz&trk=public_jobs', 'https://www.linkedin.com/jobs/view/123/'],
  ['https://www.ebay.com/itm/1234567?_trkparms=abc&_trksid=p123&var=55&hash=item1', 'https://www.ebay.com/itm/1234567?var=55&hash=item1'],
  ['https://www.reddit.com/r/x/comments/abc/title/?share_id=123&utm_content=1&utm_medium=ios_app&context=3',
    'https://www.reddit.com/r/x/comments/abc/title/?context=3'],
  ['https://en.wikipedia.org/wiki/Link?wprov=sfla1', 'https://en.wikipedia.org/wiki/Link'],
  ['https://www.nytimes.com/2024/01/01/a.html?unlocked_article_code=1.abc&smid=url-share',
    'https://www.nytimes.com/2024/01/01/a.html?unlocked_article_code=1.abc'],
  ['https://www.booking.com/hotel/x.html?aid=304142&label=gen173&sid=abc&checkin=2026-12-01&checkout=2026-12-03',
    'https://www.booking.com/hotel/x.html?checkin=2026-12-01&checkout=2026-12-03'],
  ['https://shop.example.com/products/mug?_pos=1&_sid=abc123&_ss=r&variant=42', 'https://shop.example.com/products/mug?variant=42'],
  ['https://apps.apple.com/us/app/x/id123?uo=4&at=10l&ct=campaign&mt=8', 'https://apps.apple.com/us/app/x/id123?mt=8'],

  // ---- redirect wrappers
  ['https://www.google.com/url?q=https://example.com/article%3Futm_source%3Dgoogle%26id%3D5&sa=D&source=docs&ust=123&usg=AOv',
    'https://example.com/article?id=5'],
  ['https://www.google.com/url?sa=t&url=https%3A%2F%2Fexample.com%2Fa&ved=2ah&usg=AOv', 'https://example.com/a'],
  ['https://l.facebook.com/l.php?u=https%3A%2F%2Fnews.example.org%2Fstory%3Ffbclid%3DIwAR0&h=AT0abc', 'https://news.example.org/story'],
  ['https://www.youtube.com/redirect?event=video_description&redir_token=QUFF&q=https%3A%2F%2Fexample.com%2Fshop&v=abc', 'https://example.com/shop'],
  ['https://www.youtube.com/attribution_link?u=%2Fwatch%3Fv%3Dabc%26feature%3Dshare', 'https://www.youtube.com/watch?v=abc'],
  ['https://out.reddit.com/t3_abc?url=https%3A%2F%2Fexample.com%2F&token=AQ&app_name=web2x', 'https://example.com/'],
  ['https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc', 'https://example.com/page'],
  [`https://www.bing.com/ck/a?!&&p=abc&u=a1${b64url('https://example.com/page?utm_source=bing')}&ntb=1`, 'https://example.com/page'],
  ['https://r.search.yahoo.com/_ylt=Awr/RV=2/RE=1700000000/RO=10/RU=https%3a%2f%2fexample.com%2fpage%3futm_source%3dyahoo/RK=2/RS=abc-',
    'https://example.com/page'],
  ['https://steamcommunity.com/linkfilter/?u=https%3A%2F%2Fexample.com%2F', 'https://example.com/'],
  ['https://www.linkedin.com/safety/go?url=https%3A%2F%2Fexample.com%2Fx%3Ftrk%3Dabc&trk=flagship', 'https://example.com/x?trk=abc'],
  ['https://href.li/?https://example.com/page', 'https://example.com/page'],
  ['https://disq.us/url?url=https%3A%2F%2Fexample.com%2Fpage%3AkfR3abcdefghijklmnopqrstu&cuid=1', 'https://example.com/page'],
  // nested: Google → Facebook → destination
  ['https://www.google.com/url?q=' + encodeURIComponent('https://l.facebook.com/l.php?u=' + encodeURIComponent('https://example.com/x?fbclid=1&ok=1')),
    'https://example.com/x?ok=1'],
  // double-encoded target
  ['https://out.reddit.com/x?url=https%253A%252F%252Fexample.com%252F', 'https://example.com/'],
];

// URLs Clink must leave EXACTLY as they are.
const MUST_NOT_CHANGE = [
  'https://example.com/path',
  'https://example.com/?a=1&b=2',
  'HTTPS://Example.COM/a?b=1',
  'https://github.com/o/r/blob/main/x.js?ref=v2',
  'https://gitlab.com/g/p/-/blob/main/f?ref_type=heads',
  'https://example.com/signup?ref=friend123',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL1&index=3',
  'https://example.com/?s=search+term',
  'https://example.com/?t=123',
  'https://example.com/?si=keep',
  'https://example.com/?source=keep&feature=keep',
  'https://info.example.com/hs/manage-preferences/unsubscribe?_hsenc=abc&utm_source=hs_email',
  'https://go.example.com/UnsubscribePage.html?mkt_unsubscribe=1&mkt_tok=MTIz',
  'https://news.example.com/email-preferences?mc_eid=abc&utm_campaign=x',
  'https://bucket.s3.amazonaws.com/file.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc&utm_source=x',
  'https://acct.blob.core.windows.net/c/f.zip?sv=2022&sig=abc%3D&utm_source=x',
  'http://localhost:3000/?utm_source=test',
  'http://127.0.0.1:8080/?fbclid=1',
  'http://myapp.test/?gclid=1',
  'http://192.168.1.10/?utm_source=x',
  'https://ga-dev-tools.google/campaign-url-builder/?utm_source=x',
  'https://accounts.google.com/o/oauth2/auth?client_id=1&state=abc&utm_source=x',
  'mailto:a@b.com?subject=hi&utm_source=x',
  'javascript:void(0)',
  'https://www.google.com/url?q=not-a-url',
  'https://www.google.com/url?q=javascript:alert(1)',
  'https://disq.us/url?url=https%3A%2F%2Fexample.com%2Fpage',
  'https://www.amazon.com/dp/B000000001?th=1&psc=1&smid=A1B2',
  'https://www.amazon.com/gp/help/customer/display.html/ref=hp_left?nodeId=123',
  'https://www.amazon.com/s?k=%E3%83%86%E3%82%B9%E3%83%88&__mk_ja_JP=%E3%82%AB&ie=UTF8',
  'https://www.google.com/maps/place/x?ved=1',
  'https://play.google.com/store/search?q=x&ved=1',
  'https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexample.com&data=abc',
  'https://example.com/#/route?utm_source=x',
  'https://example.com/products/mug?_sid=abc&_pos=2',
  'https://www.pinterest.com/user/board/?invite_code=abc',
  'https://www.reddit.com/r/x/comments/abc/title/?context=3',
];

test('cleans tracking junk', () => {
  for (const [input, expected] of MUST_CLEAN) {
    const r = C.clean(input);
    assert.equal(r.url, expected, `\n  input: ${input}`);
    assert.equal(r.changed, true, `changed flag for ${input}`);
  }
});

test('never touches URLs that must keep working', () => {
  for (const input of MUST_NOT_CHANGE) {
    const r = C.clean(input);
    assert.equal(r.url, input, `\n  input: ${input}\n  got:   ${r.url}`);
    assert.equal(r.changed, false, input);
  }
});

test('cleaning is idempotent', () => {
  for (const [input] of MUST_CLEAN) {
    const once = C.clean(input).url;
    assert.equal(C.clean(once).url, once, `not idempotent for ${input}`);
  }
});

test('reports what was removed', () => {
  const r = C.clean('https://example.com/?utm_source=a&fbclid=b&keep=1');
  assert.deepEqual(r.removed, ['utm_source', 'fbclid']);
  const w = C.clean('https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2F');
  assert.deepEqual(w.unwrapped, ['Facebook']);
});

test('category toggles are respected', () => {
  const url = 'https://www.amazon.com/dp/B000000001?tag=me-20&utm_source=x&fbclid=1&pd_rd_w=z';
  const opts = (cats) => ({ enabled: true, unwrap: true, paused: [], categories: { trackers: true, campaign: true, sites: true, affiliate: true, ...cats } });
  assert.equal(C.clean(url, opts({ affiliate: false })).url, 'https://www.amazon.com/dp/B000000001?tag=me-20');
  assert.equal(C.clean(url, opts({ campaign: false })).url, 'https://www.amazon.com/dp/B000000001?utm_source=x');
  assert.equal(C.clean(url, opts({ sites: false })).url, 'https://www.amazon.com/dp/B000000001?pd_rd_w=z');
  assert.equal(C.clean(url, opts({ trackers: false })).url, 'https://www.amazon.com/dp/B000000001?fbclid=1');
});

test('paused sites and master switch', () => {
  const o = C.optionsFromSettings({ pausedSites: ['example.com'], guardedSites: [{ host: 'guarded.org' }] });
  const r = C.clean('https://www.example.com/?utm_source=x', o);
  assert.equal(r.changed, false);
  assert.equal(r.skipped, 'paused');
  assert.equal(C.clean('https://guarded.org/?fbclid=1', o).changed, false);
  assert.equal(C.clean('https://other.org/?fbclid=1', o).url, 'https://other.org/');
  // unwrapping a wrapper that points at a paused site still skips the hop but keeps params
  assert.equal(C.clean('https://l.facebook.com/l.php?u=' + encodeURIComponent('https://example.com/?fbclid=1'), o).url,
    'https://example.com/?fbclid=1');
  assert.equal(C.clean('https://other.org/?fbclid=1', { ...o, enabled: false }).changed, false);
  // unwrap toggle
  assert.equal(C.clean('https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.org%2F', { ...o, unwrap: false }).changed, false);
});

test('trackerCategory helper', () => {
  assert.equal(C.trackerCategory('fbclid', 'https://a.com/'), 'trackers');
  assert.equal(C.trackerCategory('utm_source', 'https://a.com/'), 'campaign');
  assert.equal(C.trackerCategory('si', 'https://youtu.be/x'), 'sites');
  assert.equal(C.trackerCategory('si', 'https://a.com/'), null);
  assert.equal(C.trackerCategory('tag', 'https://www.amazon.com/dp/B000000001'), 'affiliate');
});

test('quiet pages', () => {
  assert.equal(C.isQuietPage('localhost'), true);
  assert.equal(C.isQuietPage('analytics.google.com'), true);
  assert.equal(C.isQuietPage('www.example.com'), false);
});
