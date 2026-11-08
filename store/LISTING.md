# Clink — store listing copy

One source for the Chrome Web Store, Firefox Add-ons and App Store listings (and the
iacompa.com app page). Artwork is in this folder; regenerate it with `npm run assets`.

- **Publisher:** IA COMPA LLC · https://iacompa.com
- **Website:** https://iacompa.com/apps/clink
- **Support:** https://iacompa.com/apps/clink/support · apps@iacompa.com
- **Privacy policy:** https://iacompa.com/apps/clink/privacy
- **Source code:** https://github.com/iacompa/Clink · License: GPL-3.0-or-later
- **Price:** Free. No in-app purchases, no ads.

## Name

- Extension name: **Clink — Clean Links**
- App Store name: **Clink — Clean Links** (fallback if taken: **Clink: Clean Links**)
- App Store subtitle (≤30): **Clean links, never broken**

## Short description

Chrome summary (≤132 characters):

> Removes tracking tags (utm, fbclid, gclid…) from the links you open and skips redirect trackers, without breaking links.

Firefox summary (≤250 characters):

> Removes tracking tags like utm_source, fbclid and gclid from every link you open and skips click-tracking redirects. If a site needs a tag, Clink notices and restores it, so links never break. Private, free and open source.

App Store promotional text (≤170):

> Every link you open, without the tracking tags. Clink removes utm_, fbclid, gclid and hundreds more, and keeps everything a link needs to work.

## Description

Clink removes the tracking junk from the links you open: utm_source and the other campaign
tags, Facebook's fbclid, Google's gclid, email trackers like mc_eid, Amazon's ref= and
pd_rd_ tags, YouTube's si, and hundreds more. It also skips click-tracking redirects such as
google.com/url and l.facebook.com, so you go straight to the page.

It's built to never break a link:

• Only known trackers are removed. Search terms, product options, timestamps, gift links and
  invite codes stay.
• Unsubscribe links, sign-in and checkout pages, signed download links and local sites are
  never touched.
• Link Guard (Chrome and Firefox): if a cleaned link fails to load, Clink reopens the original
  right away and remembers that site.
• You stay in control: pause Clink on any site, choose which kinds of tags to remove, and keep
  affiliate codes for creators you support.

Clink works on links you click, links you type or paste, links that open from other apps and
email, and URLs you copy from a page. A popup shows details about links cleaned on the current
page. Chrome and Firefox also show tags removed from the page address, with a one-click
"reload with the original link".

Private by design: Clink runs entirely in your browser. It has no account, no analytics and no
ads, and it never sends your browsing anywhere. Its counters stay on your device.

Free and open source under the GNU GPL v3: https://github.com/iacompa/Clink

## What's new in 1.1 (release notes)

For App Store "What's New in This Version" and Firefox Add-ons "Release notes". The Chrome
Web Store has no release-notes field.

> • Removes 74 more tracking tags, mostly from email newsletters and ad networks.
> • New Strict setting, off by default: it also removes trackers that a few sites need, and
>   still skips the sites known to need them.
> • Email click links sent with Oracle Eloqua are now left whole, so they always open the right
>   page.

## Categories

- Chrome Web Store: **Privacy & Security** (fallback: Tools)
- Firefox Add-ons: **Privacy & Security**
- App Store: primary **Utilities**, secondary **Productivity**
- Mac App Store category key in the app: `public.app-category.productivity`

## App Store keywords (≤100 characters, comma-separated)

`tracking,privacy,utm,fbclid,clean url,link cleaner,safari extension,redirect,gclid,tracker`

## Chrome Web Store: privacy practices

**Single purpose:** Clink removes tracking parameters and click-tracking redirects from the
links the user opens, without breaking those links.

**Permission justifications**

- `declarativeNetRequest`: rewrites top-level navigations inside the browser to drop known
  tracking parameters before the request is sent. The rules are static lists shipped with the
  extension.
- `webRequest`: Link Guard observes the outcome (status code, redirects) of navigations that
  Clink cleaned, so it can restore the original link if a cleaned page fails to load. It never
  blocks or modifies requests and never reads page content.
- `storage`: saves the user's settings, paused sites, sites remembered by Link Guard, and local
  counters.
- Host permission `<all_urls>`: needed to clean links on every site the user visits and to
  rewrite navigations to any site. Clink has no server and sends nothing anywhere.

**Remote code:** No. All code is in the package.

**Data usage:** Clink does not collect or use any user data. Certify all three: not sold to
third parties, not used for unrelated purposes, not used for creditworthiness or lending.

## Firefox Add-ons

- Add-on ID: `clink@iacompa.com`
- Data collection permissions: none (`data_collection_permissions.required = ["none"]`)
- Source code: the network rules in `rules/*.json` are generated by `scripts/dnr.mjs` from
  `src/shared/rules.js`. Upload the source archive with: `git archive -o clink-source.zip HEAD`.
  Build instructions for reviewers: Node 22+, `npm ci`, `npm run build` → `dist/firefox`.
- Notes to reviewer: no minified or remote code. The extension is the unmodified output of
  `npm run build`; the tests (`npm test`, `npm run test:e2e`) cover every feature.

## App Store

- Bundle ID: `com.iacompa.clink` (extension `com.iacompa.clink.Extension`), team L98358T6WZ
- SKU: `clink-1`
- Platforms: iOS (iPhone and iPad) and macOS, universal purchase
- Age rating: 4+ (no objectionable content)
- App Privacy: **Data Not Collected**
- Copyright: © 2026 IA COMPA LLC
- Export compliance: uses no non-exempt encryption (`ITSAppUsesNonExemptEncryption = NO`)
- Screenshots: `apple/iphone` (6.9"), `apple/ipad` (13"), `apple/mac` (2560×1600)

**Notes for App Review**

Clink is a Safari web extension that removes tracking parameters (such as utm_source and
fbclid) from links. To try it: open the Settings app → Apps → Safari → Extensions → Clink, turn
it on and allow it on all websites (on a Mac: Safari → Settings → Extensions → Clink, Always
Allow on Every Website). Then open a link such as
https://example.com/?utm_source=review&fbclid=test&id=1 in Safari — it loads as
https://example.com/?id=1. Safari does not show removed tags for typed or pasted page addresses.
The Clink button shows details about links cleaned within a page. No account or sign-in is needed.
