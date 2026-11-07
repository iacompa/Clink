/*
 * Clink tracking-parameter database.
 *
 * This single file is the source of truth for BOTH cleaning layers:
 *   1. The network layer (declarativeNetRequest rules, generated at build time
 *      by scripts/build.mjs) — cleans every navigation, however it started.
 *   2. The page layer (content script + popup) — cleans link hrefs before you
 *      click/copy them and unwraps redirect wrappers like google.com/url.
 *
 * Design rule: only list parameters that are *pure tracking*. If a parameter
 * can ever change what page you land on (a product variant, a search term, a
 * gift-article code, an invite code), it does not belong here. When in doubt,
 * leave it out — a missed tracker is a small loss, a broken link is a big one.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Domain lists
  // ---------------------------------------------------------------------------

  const AMAZON = [
    'amazon.com', 'amazon.ca', 'amazon.com.mx', 'amazon.com.br', 'amazon.co.uk',
    'amazon.de', 'amazon.fr', 'amazon.it', 'amazon.es', 'amazon.nl', 'amazon.se',
    'amazon.pl', 'amazon.com.be', 'amazon.com.tr', 'amazon.ae', 'amazon.sa',
    'amazon.eg', 'amazon.in', 'amazon.co.jp', 'amazon.sg', 'amazon.com.au',
    'amazon.co.za', 'amazon.cn',
  ];

  const EBAY = [
    'ebay.com', 'ebay.co.uk', 'ebay.de', 'ebay.fr', 'ebay.it', 'ebay.es', 'ebay.ca',
    'ebay.com.au', 'ebay.at', 'ebay.ch', 'ebay.ie', 'ebay.nl', 'ebay.be', 'ebay.pl',
    'ebay.com.sg', 'ebay.com.my', 'ebay.ph', 'ebay.com.hk',
  ];

  const AIRBNB = [
    'airbnb.com', 'airbnb.co.uk', 'airbnb.ca', 'airbnb.com.au', 'airbnb.de', 'airbnb.fr',
    'airbnb.es', 'airbnb.it', 'airbnb.nl', 'airbnb.ie', 'airbnb.mx', 'airbnb.com.br',
    'airbnb.co.nz', 'airbnb.jp', 'airbnb.co.in',
  ];

  // Matches google.com, www.google.co.uk, google.com.au, www.google.de …
  const GOOGLE_HOST_RE = '(?:www\\.)?google\\.[a-z]{2,3}(?:\\.[a-z]{2})?';

  // ---------------------------------------------------------------------------
  // Global parameters — stripped from every URL on every site.
  // Names are matched case-insensitively by the page layer.
  // ---------------------------------------------------------------------------

  const TRACKERS = [
    // Google Ads / Analytics click + linker IDs
    'gclid', 'gclsrc', 'gbraid', 'wbraid', 'dclid', 'gad_source', 'gad_campaignid',
    'srsltid', '_ga', '_gl', '_gac',
    // Microsoft Ads
    'msclkid',
    // Meta (Facebook / Instagram)
    'fbclid', 'mibextid', 'igshid', 'igsh', 'fb_action_ids', 'fb_action_types',
    'fb_ref', 'fb_source', 'action_object_map', 'action_type_map', 'action_ref_map',
    // X / Twitter
    'twclid', '__twitter_impression',
    // TikTok, LinkedIn, Pinterest, Snapchat, Reddit, Quora
    'ttclid', 'li_fat_id', 'epik', 'sccid', 'ScCid', 'rdt_cid', 'qclid',
    // Yandex
    'yclid', 'ysclid', '_openstat',
    // Adobe
    's_kwcid', 'ef_id',
    // Outbrain / Taboola / Zalo
    'dicbo', 'obOrigUrl', 'tblci', 'gidzl',
    // Branch deep links
    '_branch_match_id', '_branch_referrer',
    // Email & marketing-automation subscriber IDs (these identify *you*)
    'mc_cid', 'mc_eid',                                       // Mailchimp
    '_hsenc', '_hsmi', '__hssc', '__hstc', '__hsfp', 'hsCtaTracking', // HubSpot
    'mkt_tok',                                                // Marketo
    'oly_anon_id', 'oly_enc_id',                              // Omeda
    'vero_id', 'vero_conv',                                   // Vero
    '__s',                                                    // Drip
    '_kx',                                                    // Klaviyo
    'ml_subscriber', 'ml_subscriber_hash',                    // MailerLite
    'ck_subscriber_id',                                       // Kit (ConvertKit)
    '_bta_tid', '_bta_c',                                     // Bronto
    'trk_contact', 'trk_msg', 'trk_module', 'trk_sid',        // Listrak
    'bsft_aaid', 'bsft_clkid', 'bsft_eid', 'bsft_ek', 'bsft_lx', 'bsft_mid',
    'bsft_mime_type', 'bsft_tv', 'bsft_uid',                  // Blueshift
    'elqTrackId', 'elqTrack', 'elqaid', 'elqat', 'elqCampaignId', // Oracle Eloqua
    'spJobID', 'spMailingID', 'spReportId', 'spUserID',       // Salesforce / Silverpop
    'et_cid', 'et_rid',                                       // ExactTarget
    'vgo_ee',                                                 // ActiveCampaign
    'nr_email_referer', 'wickedid', 'rb_clickid', '_bhlid',
    // Shopify product-recommendation tracking
    'pr_prod_strat', 'pr_rec_id', 'pr_rec_pid', 'pr_ref_pid', 'pr_seq',
  ];

  const CAMPAIGN = [
    // Google Analytics campaign tags (the page layer also strips any other utm_*)
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
    'utm_name', 'utm_cid', 'utm_reader', 'utm_referrer', 'utm_social', 'utm_social-type',
    'utm_place', 'utm_pubreferrer', 'utm_swu', 'utm_viz_id', 'utm_brand', 'utm_int',
    'utm_keyword', 'utm_campaignid', 'utm_campaign_id', 'utm_adgroup', 'utm_adgroupid',
    'utm_ad', 'utm_adid', 'utm_creative', 'utm_device', 'utm_network', 'utm_placement',
    'utm_matchtype', 'utm_marketing_tactic', 'utm_source_platform', 'utm_creative_format',
    'utm_emcid', 'utm_emmid', 'utm_mailing', 'utm_userid', 'utm_audience', 'utm_type',
    'utm_channel', 'utm_target', 'utm_label', 'utm_page', 'utm_position', 'utm_affiliate',
    'utm_partner', 'utm_platform', 'utm_hp_ref', 'utm_tag', 'utm_org', 'utm_feed',
    'utm_date', 'utm_section', 'utm_kxconfid', 'utm_umguk',
    // Matomo / Piwik
    'pk_campaign', 'pk_kwd', 'pk_keyword', 'pk_source', 'pk_medium', 'pk_content',
    'pk_cid', 'pk_vid', 'mtm_campaign', 'mtm_kwd', 'mtm_keyword', 'mtm_source',
    'mtm_medium', 'mtm_content', 'mtm_cid', 'mtm_group', 'mtm_placement',
    'matomo_campaign', 'matomo_kwd', 'matomo_keyword', 'matomo_source', 'matomo_medium',
    'matomo_content', 'matomo_cid', 'matomo_group', 'matomo_placement',
    'piwik_campaign', 'piwik_kwd', 'piwik_keyword',
    // HubSpot ads
    'hsa_acc', 'hsa_cam', 'hsa_grp', 'hsa_ad', 'hsa_src', 'hsa_tgt', 'hsa_kw', 'hsa_mt',
    'hsa_net', 'hsa_ver', 'hsa_la', 'hsa_ol',
    // Piano / AT Internet
    'at_medium', 'at_campaign', 'at_custom1', 'at_custom2', 'at_custom3', 'at_custom4',
    'at_ptr_name', 'at_link_id', 'at_link_origin', 'at_link_type', 'at_bbc_team',
    'at_campaign_type', 'at_format', 'at_objective', 'at_platform', 'at_creation',
    'at_variant', 'at_send_date', 'at_recipient_id', 'at_recipient_list', 'at_emailtype',
    // Misc campaign tagging schemes
    'itm_source', 'itm_medium', 'itm_campaign', 'itm_content', 'itm_term',
    'stm_source', 'stm_medium', 'stm_campaign', 'stm_content', 'stm_term',
    's_cid', 'cm_mmc', 'cm_ven', 'cm_cat', 'cm_pla', 'cm_ite', 'cm_lm',
    'WT.mc_id', 'WT.mc_ev', 'WT.srch', 'wt_mc', 'wt_zmc',
  ];

  // Affiliate-network click IDs (only network-specific names; never generic "ref"/"aff").
  const AFFILIATE = [
    'cjevent', 'cjdata', 'irclickid', 'irgwc', 'ranMID', 'ranEAID', 'ranSiteID',
  ];

  // ---------------------------------------------------------------------------
  // Site-specific parameters. `domains` match the domain and all subdomains.
  // `hostRe` + `path` restrict a rule to an exact host pattern and path.
  // `params` → "sites" category, `affiliate` → "affiliate" category.
  // `prefixes` are page-layer only (the network layer can't match prefixes).
  // ---------------------------------------------------------------------------

  const SITES = [
    {
      name: 'Amazon',
      domains: AMAZON,
      params: [
        'pd_rd_w', 'pd_rd_wg', 'pd_rd_r', 'pd_rd_i', 'pd_rd_p', 'pd_rd_plhdr',
        'pf_rd_p', 'pf_rd_r', 'pf_rd_s', 'pf_rd_t', 'pf_rd_i', 'pf_rd_m',
        'ref', 'ref_', '_encoding', 'qid', 'sr', 'sprefix', 'crid', 'content-id',
        'dib', 'dib_tag', 'social_share', 'starsLeft', 'skipTwisterOG', 'spIA', 'ms3_c',
        'refRID', 'sbo', 'aaxitk', 'hsa_cr_id', 'dchild', 'plattr',
        'cv_ct_cx', 'cv_ct_id', 'cv_ct_pg', 'cv_ct_we', 'cv_ct_wn',
      ],
      // Deliberately kept: th, psc (selected variant), smid/m (seller), k/keywords/
      // field-* (search terms), ie and __mk_* (character-set hints for searches).
      affiliate: ['tag', 'ascsubtag', 'linkCode', 'linkId', 'creative', 'creativeASIN',
        'camp', 'asc_campaign', 'asc_refurl', 'asc_source'],
      // /dp/B0ABCDEFGH/ref=sr_1_1  →  /dp/B0ABCDEFGH  (product pages only)
      pathRule: {
        re: '^(.*/(?:dp|gp/product|gp/aw/d|d)/[A-Z0-9]{10})/ref=[^/]*$',
        replace: '$1',
        label: 'ref (path)',
      },
    },
    {
      name: 'Google Search',
      hostRe: GOOGLE_HOST_RE,
      path: '/search',
      params: [
        'ved', 'ei', 'sxsrf', 'sca_esv', 'sca_upv', 'gs_lcp', 'gs_lcrp', 'gs_ssp', 'gs_lp',
        'gs_l', 'gs_gbg', 'gs_mss', 'gs_rn', 'gs_ri', 'aqs', 'sourceid', 'uact', 'oq', 'bih',
        'biw', 'iflsig', 'rlz', 'sclient', 'dpr', 'sa', 'sei', 'lei', 'cshid', 'fbs', 'ictx',
        'source', 'mstk', 'csui', 'atyp', 'prmd',
      ],
    },
    { name: 'Google Docs & Drive', domains: ['docs.google.com', 'drive.google.com'], params: ['usp'] },
    { name: 'Google Play', domains: ['play.google.com'], params: ['pcampaignid', 'referrer'] },
    {
      name: 'YouTube',
      domains: ['youtube.com', 'youtu.be'],
      params: ['si', 'feature', 'pp', 'embeds_referring_euri', 'embeds_referring_origin',
        'source_ve_path', 'ab_channel'],
    },
    { name: 'Spotify', domains: ['open.spotify.com'], params: ['si', 'dlsi'] },
    {
      name: 'Facebook',
      domains: ['facebook.com', 'fb.com', 'fb.watch', 'messenger.com'],
      params: ['__tn__', 'fref', 'hc_ref', 'hc_location', 'rdid', 'sfnsn', 'paipv', 'extid',
        'eav', 'refsrc', 'comment_tracking', 'acontext', 'wtsid', 'ref'],
      prefixes: ['__cft__', '__xts__'],
    },
    { name: 'Threads', domains: ['threads.net', 'threads.com'], params: ['xmt', 'slof'] },
    {
      name: 'X (Twitter)',
      domains: ['x.com', 'twitter.com'],
      params: ['s', 't', 'ref_src', 'ref_url', 'src', 'cn', 'refsrc'],
    },
    {
      name: 'TikTok',
      domains: ['tiktok.com'],
      params: ['_t', '_r', 'is_from_webapp', 'sender_device', 'is_copy_url', 'share_app_id',
        'share_link_id', 'share_item_id', 'share_author_id', 'share_region', 'tt_from',
        'u_code', 'timestamp', 'user_id', 'sec_user_id', 'social_sharing', 'sender_web_id',
        'refer', 'enter_from', 'enter_method', 'web_id', 'checksum'],
    },
    {
      name: 'Reddit',
      domains: ['reddit.com', 'redd.it'],
      params: ['share_id', 'ref', 'ref_source', 'ref_campaign', 'rdt', 'correlation_id',
        'post_index', '$deep_link', '$3p'],
      // Deliberately kept: context (shows parent comments).
    },
    {
      name: 'LinkedIn',
      domains: ['linkedin.com'],
      params: ['trk', 'trkInfo', 'trackingId', 'refId', 'lipi', 'trkEmail', 'lici'],
      // Deliberately kept: currentJobId, position, otpToken (sign-in from email).
    },
    {
      name: 'eBay',
      domains: EBAY,
      params: ['_trkparms', '_trksid', '_from', 'amdata', 'mkevt', 'mkcid', 'mkrid', 'mkpid',
        'ul_noapp', 'itmprp', 'itmmeta', 'ssspo', 'sssrc', 'ssuid', 'widget_ver', 'emsid'],
      affiliate: ['campid', 'customid', 'toolid'],
      // Deliberately kept: var (variant), epid, hash.
    },
    {
      name: 'AliExpress / Alibaba',
      domains: ['aliexpress.com', 'aliexpress.us', 'aliexpress.ru', 'alibaba.com',
        'taobao.com', 'tmall.com'],
      params: ['spm', 'scm', 'scm_id', 'scm-url', 'pvid', 'algo_expid', 'algo_pvid', 'btsid',
        'ws_ab_test', 'pdp_ext_f', 'pdp_npi', 'sourceType', 'gps-id', 'curPageLogUid',
        'utparam', 'mall_affr'],
      affiliate: ['aff_fcid', 'aff_fsk', 'aff_platform', 'aff_trace_key', 'sk',
        'afSmartRedirect', 'terminal_id'],
      // Deliberately kept: gatewayAdapt, _randl_* (region redirects — stripping can loop).
    },
    {
      name: 'Etsy',
      domains: ['etsy.com'],
      params: ['click_key', 'click_sum', 'ref', 'pro', 'frs', 'sts', 'organic_search_click',
        'plkey', 'content_source', 'logging_key', 'ga_order', 'ga_search_type',
        'ga_view_type', 'ga_search_query', 'sr_prefetch', 'pf_from'],
    },
    {
      name: 'Walmart',
      domains: ['walmart.com', 'walmart.ca'],
      params: ['athcpid', 'athpgid', 'athznid', 'athieid', 'athstid', 'athguid', 'athwpid',
        'athtvid', 'athcgid', 'athena', 'athbdg', 'athancid', 'athrk', 'athsid', 'athposb'],
      affiliate: ['wmlspartner', 'sourceid', 'veh', 'wl13', 'affiliates_ad_id'],
    },
    {
      name: 'Bing',
      hostRe: '(?:www\\.|cn\\.)?bing\\.com',
      path: '/search',
      params: ['form', 'cvid', 'pq', 'sc', 'qs', 'sk', 'sp', 'ghc', 'lq', 'ghsh', 'ghacc',
        'ghpl', 'refig'],
    },
    { name: 'MSN', domains: ['msn.com'], params: ['ocid', 'cvid', 'ei'] },
    {
      name: 'Yahoo / AOL',
      domains: ['yahoo.com', 'aol.com', 'engadget.com', 'techcrunch.com'],
      params: ['guce_referrer', 'guce_referrer_sig', 'ncid', 'soc_src', 'soc_trk', 'tsrc'],
      // Deliberately kept: guccounter (consent flow — stripping it can loop).
    },
    {
      name: 'News sites',
      domains: ['nytimes.com'],
      params: ['smid', 'smtyp', 'sgrp', 'partner', 'referringSource'],
      // Deliberately kept: unlocked_article_code (gift links).
    },
    { name: 'Washington Post', domains: ['washingtonpost.com'], params: ['itid', 'wpisrc', 'wpmk', 'wpmm'] },
    { name: 'The Guardian', domains: ['theguardian.com'], params: ['CMP'] },
    {
      name: 'Apple media',
      domains: ['apps.apple.com', 'music.apple.com', 'podcasts.apple.com', 'books.apple.com',
        'tv.apple.com', 'itunes.apple.com'],
      params: ['uo', 'itscg', 'itsct', 'ign-mpt', 'ign-itscg', 'ign-itsct'],
      affiliate: ['at', 'ct', 'pt'],
    },
    { name: 'Twitch', domains: ['twitch.tv'], params: ['tt_medium', 'tt_content'] },
    { name: 'Quora', domains: ['quora.com'], params: ['ch', 'oid', 'share', 'srid', 'target_type'] },
    { name: 'SoundCloud', domains: ['soundcloud.com'], params: ['si', 'ref'] },
    { name: 'Medium', domains: ['medium.com'], params: ['source'] },
    {
      name: 'Substack',
      domains: ['substack.com'],
      params: ['s', 'showWelcomeOnShare', 'publication_id', 'post_id', 'isFreemail'],
      affiliate: ['r'],
      // Deliberately kept: triedRedirect, token.
    },
    {
      name: 'Booking.com',
      domains: ['booking.com'],
      params: ['label', 'sid', 'srpvid', 'srepoch', 'ucfs', 'arphpl', 'hpos', 'hapos'],
      affiliate: ['aid'],
    },
    {
      name: 'Airbnb',
      domains: AIRBNB,
      params: ['source_impression_id', 'previous_page_section_name', 'federated_search_id',
        '_set_bev_on_new_domain', 'unique_share_id', 'viralityEntryPoint', 's'],
      affiliate: ['sharer_id'],
    },
    { name: 'Wikipedia', domains: ['wikipedia.org', 'wikimedia.org', 'wiktionary.org'], params: ['wprov'] },
    { name: 'Mailchimp archive', domains: ['mailchi.mp', 'campaign-archive.com'], params: ['e'] },
    { name: 'Temu', domains: ['temu.com'], params: ['_x_vst_scene', '_x_sessn_id', 'refer_page_name', 'refer_page_id', 'refer_page_sn'], prefixes: ['_x_', 'refer_page_'] },
  ];

  // Groups that only fire when a "signature" parameter shows the platform.
  // e.g. Shopify search links: /products/x?_pos=1&_sid=ab12&_ss=r
  const CONDITIONAL = [
    {
      name: 'Shopify search',
      category: 'sites',
      when: ['_ss', '_psq'],
      params: ['_pos', '_sid', '_ss', '_psq', '_fid', '_v'],
    },
  ];

  // ---------------------------------------------------------------------------
  // Redirect wrappers — "click here" hops that exist only to log your click.
  // The page layer replaces them with their destination (then cleans that).
  //
  // Intentionally NOT included: Microsoft Safe Links, Proofpoint, Mimecast and
  // other corporate security scanners (bypassing them can violate IT policy),
  // and opaque shorteners (t.co, lnkd.in, bit.ly) whose target isn't in the URL.
  // ---------------------------------------------------------------------------

  const REDIRECTORS = [
    { name: 'Google', hostRe: GOOGLE_HOST_RE, path: '/url', params: ['url', 'q'] },
    { name: 'Google Scholar', hostRe: 'scholar\\.google\\.[a-z.]+', path: '/scholar_url', params: ['url'] },
    { name: 'Google Ads', hosts: ['www.googleadservices.com', 'googleadservices.com'], path: '/pagead/aclk', params: ['adurl'] },
    { name: 'Google Ads', hostRe: GOOGLE_HOST_RE, path: '/aclk', params: ['adurl'] },
    { name: 'Facebook', hosts: ['l.facebook.com', 'lm.facebook.com', 'l.messenger.com', 'www.facebook.com', 'm.facebook.com'], path: '/l.php', params: ['u'] },
    { name: 'Facebook', hosts: ['www.facebook.com', 'm.facebook.com', 'facebook.com'], pathPrefix: '/flx/warn', params: ['u'] },
    { name: 'Instagram', hosts: ['l.instagram.com'], params: ['u'] },
    { name: 'Threads', hosts: ['l.threads.net', 'l.threads.com'], params: ['u'] },
    { name: 'WhatsApp', hosts: ['l.wl.co'], path: '/l', params: ['u'] },
    { name: 'YouTube', hosts: ['www.youtube.com', 'm.youtube.com', 'youtube.com'], path: '/redirect', params: ['q'] },
    { name: 'YouTube', hosts: ['www.youtube.com', 'm.youtube.com', 'youtube.com'], path: '/attribution_link', params: ['u'], allowRelative: true },
    { name: 'Reddit', hosts: ['out.reddit.com'], params: ['url'] },
    { name: 'LinkedIn', hosts: ['www.linkedin.com', 'linkedin.com'], path: '/redir/redirect', params: ['url'] },
    { name: 'LinkedIn', hosts: ['www.linkedin.com', 'linkedin.com'], path: '/safety/go', params: ['url'] },
    { name: 'Steam', hosts: ['steamcommunity.com'], pathPrefix: '/linkfilter', params: ['u', 'url'] },
    { name: 'VK', hosts: ['vk.com', 'm.vk.com', 'away.vk.com'], path: '/away.php', params: ['to'] },
    { name: 'Tumblr', hosts: ['t.umblr.com'], path: '/redirect', params: ['z'] },
    { name: 'DuckDuckGo', hosts: ['duckduckgo.com'], pathPrefix: '/l/', params: ['uddg'] },
    { name: 'Slack', hosts: ['slack-redir.net'], path: '/link', params: ['url'] },
    { name: 'Medium', hosts: ['medium.com'], pathPrefix: '/r/', params: ['url'] },
    { name: 'Bing', hosts: ['www.bing.com', 'bing.com'], path: '/ck/a', params: ['u'], decode: 'bing' },
    { name: 'Yahoo', hosts: ['r.search.yahoo.com'], decode: 'yahoo' },
    { name: 'Pocket', hosts: ['getpocket.com'], path: '/redirect', params: ['url'] },
    { name: 'GMX / Web.de', hosts: ['deref-gmx.net', 'deref-gmx.com', 'deref-web.de', 'deref-web-02.de', 'deref-mail.com', 'deref-1und1.de'], pathPrefix: '/mail/client/', params: ['redirectUrl'] },
    { name: 'Zhihu', hosts: ['link.zhihu.com'], params: ['target'] },
    { name: 'TikTok', hosts: ['www.tiktok.com'], path: '/link/v2', params: ['target'] },
    { name: 'SoundCloud', hosts: ['exit.sc'], params: ['url'] },
    { name: 'href.li', hosts: ['href.li'], decode: 'rawQuery' },
    { name: 'Disqus', hosts: ['disq.us'], path: '/url', params: ['url'], stripSuffix: ':[A-Za-z0-9_-]{16,}$' },
    // Affiliate redirectors (also need the "Affiliate codes" category on)
    { name: 'Rakuten', category: 'affiliate', hosts: ['click.linksynergy.com'], params: ['murl'] },
    { name: 'Awin', category: 'affiliate', hosts: ['www.awin1.com', 'awin1.com'], path: '/cread.php', params: ['ued'] },
    { name: 'Skimlinks', category: 'affiliate', hosts: ['go.skimresources.com', 'go.redirectingat.com'], params: ['url'] },
    { name: 'eBay Partner', category: 'affiliate', hosts: ['rover.ebay.com'], params: ['mpre'] },
    { name: 'CJ', category: 'affiliate', domains: ['anrdoezrs.net', 'jdoqocy.com', 'tkqlhce.com', 'dpbolvw.net', 'kqzyfj.com'], params: ['url'] },
  ];

  // ---------------------------------------------------------------------------
  // Safety — places where Clink must never change anything.
  // ---------------------------------------------------------------------------

  const SAFETY = {
    // Marketing tools: tracking parameters ARE the content here (campaign
    // builders, ad dashboards). Neither URLs on them nor links clicked from
    // them are touched.
    toolHosts: [
      'analytics.google.com', 'tagassistant.google.com', 'tagmanager.google.com',
      'ga-dev-tools.google', 'ads.google.com', 'marketingplatform.google.com',
      'search.google.com', 'business.facebook.com', 'adsmanager.facebook.com',
      'developers.facebook.com', 'ads.tiktok.com', 'business.tiktok.com',
      'app.hubspot.com', 'admin.mailchimp.com', 'login.mailchimp.com',
      'ads.microsoft.com', 'ui.ads.microsoft.com', 'ads.x.com', 'ads.twitter.com',
      'ads.pinterest.com', 'ads.reddit.com', 'ads.snapchat.com', 'app.klaviyo.com',
      'app.kit.com', 'app.convertkit.com',
    ],
    // Sign-in and payment flows: never rewrite anything going to these.
    authHosts: [
      'accounts.google.com', 'login.microsoftonline.com', 'login.live.com',
      'appleid.apple.com', 'idmsa.apple.com', 'okta.com', 'auth0.com', 'paypal.com',
      'checkout.stripe.com', 'pay.google.com', 'checkout.shopify.com', 'shop.app',
    ],
    // Local development hosts — developers test their own tracking here.
    localDomains: ['localhost', 'test', 'local', 'internal', 'lan', 'home.arpa', 'invalid'],
    // If the URL mentions any of these, it's probably an unsubscribe / email-
    // preference / double-opt-in link that relies on the "tracking" IDs to know
    // who you are. Leave it alone so unsubscribing always works.
    urlKeywords: [
      'unsubscribe', 'optout', 'opt-out', 'opt_out', 'optin', 'opt-in', 'double-opt',
      'manage-preferences', 'managepreferences', 'email-preferences', 'emailpreferences',
      'preference-center', 'preferences-center', 'preferencecenter', 'subscription-center',
      'subscriptioncenter', 'confirm-subscription', 'confirmsubscription',
      'subscribe/confirm',
    ],
    // Signed URLs: changing ANY query parameter invalidates the signature (403).
    signatureParams: [
      'x-amz-signature', 'x-amz-credential', 'x-goog-signature', 'x-goog-credential',
      'signature', 'sig', 'hmac', 'x-signature', 'key-pair-id', 'googleaccessid',
    ],
  };

  const CATEGORIES = {
    trackers: {
      label: 'Ad & email trackers',
      description: 'Click IDs and subscriber IDs that identify you personally (fbclid, gclid, msclkid, mc_eid, _hsenc…).',
    },
    campaign: {
      label: 'Campaign tags',
      description: 'Marketing labels that report where you came from (utm_source, utm_campaign, pk_campaign…).',
    },
    sites: {
      label: 'Site-specific trackers',
      description: 'Junk added by Amazon, YouTube, Google, X, TikTok, Reddit, LinkedIn, eBay and others (si=, pd_rd_, ref_src…).',
    },
    affiliate: {
      label: 'Affiliate & referral codes',
      description: 'Commission codes like Amazon tag=. Turn off if you want creators to get credit for your purchases.',
    },
  };

  root.ClinkRules = Object.freeze({
    version: 1,
    CATEGORIES,
    TRACKERS,
    CAMPAIGN,
    AFFILIATE,
    // page-layer only: any parameter starting with these is a campaign tag
    CAMPAIGN_PREFIXES: ['utm_', 'mtm_', 'matomo_', 'hsa_'],
    TRACKER_PREFIXES: ['bsft_'],
    SITES,
    CONDITIONAL,
    REDIRECTORS,
    SAFETY,
  });
})(globalThis);
