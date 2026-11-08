// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Generates declarativeNetRequest rulesets from src/shared/rules.js.
 *
 * Key constraint (verified in Chromium): when several redirect rules match a
 * request, only the highest-priority one runs — and if its transform changes
 * nothing, NO other rule runs either. So every cleaning rule is "triggered":
 * it only matches when one of its own parameters is actually in the URL. Each
 * parameter in a group gets a trigger rule that removes the whole group, so a
 * URL is fully cleaned in one internal redirect per group (≤ ~5 hops, all
 * in-browser, no network round-trips).
 *
 * Parameters are matched as "?p=" / "&p=" — never "^p=", whose "^" would also
 * match a "/" and fire on a path like amazon.com/…/ref=x (a no-op redirect
 * that stops every other rule).
 *
 * flavor 'standard' → Chrome & Firefox (adds regex rules)
 * flavor 'safari'   → no regex, no
 *                     requestMethods/initiatorDomains (Safari's engine is
 *                     built on WebKit content blockers and is stricter).
 */
import '../src/shared/rules.js';

const R = globalThis.ClinkRules;

export const RULESET_IDS = ['trackers', 'campaign', 'sites', 'affiliate', 'strict', 'safety'];
// Strict sits below everything else, with its "keep" allow rules just above it:
// those block only Strict, so the other categories still clean the same URL first.
export const PRIORITY = {
  strict: 1, strictKeep: 2, campaign: 3, trackers: 4, affiliate: 5, sites: 6, siteAffiliate: 7, path: 8, safety: 100,
};
// Off until the user turns Strict on (the background worker enables it).
export const DISABLED_BY_DEFAULT = ['strict'];

const uniq = (a) => [...new Set(a)];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function dnrSafe(name, flavor) {
  if (!name || /[[\]\s#&=*|^%]/.test(name)) return false;
  if (flavor === 'safari' && /[$]/.test(name)) return false;
  return true;
}

export function generateRulesets(flavor) {
  const sets = Object.fromEntries(RULESET_IDS.map((id) => [id, []]));
  const ids = Object.fromEntries(RULESET_IDS.map((id) => [id, 1]));
  const push = (set, rule) => sets[set].push({ id: ids[set]++, ...rule });

  const base = () => (flavor === 'standard'
    ? { resourceTypes: ['main_frame'], requestMethods: ['get'] }
    : { resourceTypes: ['main_frame'] });

  function addGroup(set, priority, params, opts = {}) {
    const remove = uniq((params || []).filter((p) => dnrSafe(p, flavor)));
    if (!remove.length) return;
    const triggers = uniq((opts.triggers || params).filter((p) => dnrSafe(p, flavor)));
    const action = { type: 'redirect', redirect: { transform: { queryTransform: { removeParams: remove } } } };
    const domainCond = opts.domains ? { requestDomains: opts.domains } : {};

    for (const t of triggers) {
      if (opts.hostRe || opts.path) {
        if (flavor === 'safari') return; // needs a regex; the page layer still covers it
        const host = opts.hostRe || '[^/?#]+';
        const path = opts.path ? escapeRe(opts.path) : '[^?#]*';
        push(set, {
          priority,
          action,
          condition: {
            ...base(),
            ...domainCond,
            regexFilter: `^https?://${host}(?::\\d+)?${path}\\?(?:[^#]*&)?${escapeRe(t)}=`,
            isUrlFilterCaseSensitive: true,
          },
        });
      } else {
        for (const urlFilter of [`?${t}=`, `&${t}=`]) {
          push(set, { priority, action, condition: { ...base(), ...domainCond, urlFilter, isUrlFilterCaseSensitive: true } });
        }
      }
    }
  }

  // ---- global groups
  addGroup('campaign', PRIORITY.campaign, R.CAMPAIGN);
  addGroup('trackers', PRIORITY.trackers, R.TRACKERS);
  addGroup('affiliate', PRIORITY.affiliate, R.AFFILIATE);

  // ---- site groups
  for (const site of R.SITES) {
    const opts = { domains: site.domains, hostRe: site.hostRe, path: site.path };
    addGroup('sites', PRIORITY.sites, site.params, opts);
    addGroup('affiliate', PRIORITY.siteAffiliate, site.affiliate, opts);

    if (site.pathRule && flavor === 'standard') {
      // e.g. amazon.com/Name/dp/B0ABCDEFGH/ref=sr_1_1?x=1 → amazon.com/Name/dp/B0ABCDEFGH?x=1
      push('sites', {
        priority: PRIORITY.path,
        action: { type: 'redirect', redirect: { regexSubstitution: '\\1\\2' } },
        condition: {
          ...base(),
          requestDomains: site.domains,
          regexFilter: '^(https?://[^?#]*?/(?:dp|gp/product|gp/aw/d|d)/[A-Z0-9]{10})/ref=[^/?#]*((?:\\?[^#]*)?(?:#.*)?)$',
          isUrlFilterCaseSensitive: true,
        },
      });
    }
  }

  for (const c of R.CONDITIONAL) {
    addGroup(c.category, PRIORITY.sites, c.params, { triggers: c.when });
  }

  // ---- strict: one group per vendor, never on the URLs known to need them
  for (const g of R.STRICT) addGroup('strict', PRIORITY.strict, g.params);
  const keepOn = uniq(R.STRICT.flatMap((g) => g.keepOn || []));
  const strictKeep = (condition) => push('strict', {
    priority: PRIORITY.strictKeep,
    action: { type: 'allow' },
    condition: { resourceTypes: ['main_frame'], ...condition },
  });
  if (keepOn.length) strictKeep({ requestDomains: keepOn });
  for (const p of uniq(R.STRICT.flatMap((g) => g.keepPaths || []))) {
    strictKeep({ urlFilter: p, isUrlFilterCaseSensitive: false });
  }

  // ---- safety: allow rules outrank every cleaning rule
  const allow = (condition) => push('safety', {
    priority: PRIORITY.safety,
    action: { type: 'allow' },
    condition: { resourceTypes: ['main_frame'], ...condition },
  });

  allow({ requestDomains: uniq([...R.SAFETY.toolHosts, ...R.SAFETY.authHosts, ...R.SAFETY.localDomains]) });
  if (flavor === 'standard') allow({ initiatorDomains: R.SAFETY.toolHosts });

  for (const kw of R.SAFETY.urlKeywords) allow({ urlFilter: kw, isUrlFilterCaseSensitive: false });
  // Word-start keywords: preceded by a separator ("^" = anything but a letter,
  // digit, _ - . %) or by - _ . — matches the page layer's rule.
  for (const kw of R.SAFETY.urlWordStartKeywords) {
    for (const pre of ['^', '-', '_', '.']) allow({ urlFilter: pre + kw, isUrlFilterCaseSensitive: false });
  }

  for (const p of R.SAFETY.signatureParams) {
    for (const urlFilter of [`?${p}=`, `&${p}=`]) allow({ urlFilter, isUrlFilterCaseSensitive: false });
  }
  for (const p of R.SAFETY.redirectPaths) allow({ urlFilter: p, isUrlFilterCaseSensitive: false });

  if (flavor === 'standard') {
    allow({ regexFilter: '^https?://(?:\\d{1,3}\\.){3}\\d{1,3}(?::\\d+)?(?:[/?#]|$)' });
    allow({ regexFilter: '^https?://\\[' });
  } else {
    for (const pre of ['127.0.0.1', '192.168.', '10.', '[']) {
      allow({ urlFilter: `|http://${pre}` });
      allow({ urlFilter: `|https://${pre}` });
    }
  }

  return sets;
}
