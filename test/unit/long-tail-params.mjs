// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Long-tail tracking parameters added in 1.0.1, shared by the cleaner and
 * ruleset tests. Each was vetted: set by a known tracking vendor, a distinctive
 * name, and no breakage reported against it in AdGuard's URL-tracking allowlist.
 */

// Removed on every site, by category.
export const GLOBAL = {
  trackers: [
    'clckid', 'ym_tracking_id', 'adobe_mc_ref', 'adobe_mc_sdid', 'tgclid', 'pjclid',
    'adsterra_clid', 'adsterra_placement_id', 'ldtag_cl', 'line_uid', '_ly_c', '_ly_r', 'yj_r',
    'mt_click_id', 'mt_link_id', 'cx_click', 'cx_recsOrder', 'cx_recsWidget', 'sfmc_id', 'dm_i',
    'ems_dl', 'emcs_t', 'mindbox-click-id', 'mindbox-message-key', 'tw_profile_id', 'sms_click',
    'sms_uph', 'redirect_mongo_id', 'redirect_log_mongo_id',
  ],
  campaign: [
    'xtor', 'int_source', 'int_medium', 'int_campaign', 'int_content', 'int_term', 'cm_me', 'cm_cr',
    'dpg_source', 'dpg_medium', 'dpg_campaign', 'dpg_content', '_sgm_campaign', '_sgm_source',
    '_sgm_action', '_sgm_term', '_sgm_pinned', 'tw_source', 'tw_medium', 'mt_network', 'mt_campaign',
    'mt_adset', 'mt_creative', 'mt_medium', 'mt_sub1', 'mt_sub2', 'mt_sub3', 'mt_sub4', 'mt_sub5',
    'sfmc_activityid', 'sms_source', 'spot_im_redirect_source',
  ],
  affiliate: ['ir_campaignid', 'ir_adid', 'ir_partnerid', 'awc', 'zanpid', 'sscid', 'admitad_uid'],
};

// Removed only on these sites: [url on the site, the same parameter on another site].
export const SITE_ONLY = [
  ['https://techcrunch.com/2026/01/01/story/?sr_share=twitter&p=2', 'https://example.com/?sr_share=twitter&p=2'],
  ['https://www.wired.com/story/x/?mbid=social_twitter', 'https://musicbrainz.org/ws/2/artist/?mbid=5b11f4ce'],
  ['https://www.newyorker.com/news/x?mbid=nl_daily', 'https://example.com/?mbid=1'],
  ['https://www.humblebundle.com/games/x?hmb_source=email&hmb_medium=newsletter&hmb_campaign=y',
    'https://example.com/?hmb_source=email'],
  ['https://usa.kaspersky.com/antivirus?icid=hero', 'https://example.com/shop?icid=promo'],
  ['https://notebooklm.google.com/?icid=home_maincta', 'https://example.com/?icid=1'],
];

// Considered and deliberately left alone (functional elsewhere, or no evidence it is a tracker).
export const NOT_ADDED = [
  'cmpid', 'tduid', 'elq', 'km_source', 'sb_referer_host', 'af_adset', 'adjust_tracker', 'fb_comment_id',
];
