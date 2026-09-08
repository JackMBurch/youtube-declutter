// ==UserScript==
// @name         YouTube Declutter
// @namespace    local.yt-declutter
// @version      1.1.0
// @description  Declutter YouTube on mobile and desktop. Customisable sidebar, yoodle replacement, Shorts and community post hiding, backup and restore.
// @license      MIT
// @copyright    2026, Jack Burch
// @author       JackMBurch
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://youtube.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const APP = 'yt-declutter';
  const VERSION = '1.1.0';

  const SCHEMA = 1;
  const STORE = 'ytdc.settings';

  // =================================================================
  // RECOVERY
  //
  // If the footer buttons vanish there is no way back in, so these
  // hashes work without any UI. Append one to the URL and reload:
  //   m.youtube.com/#ytdc-reset   wipe all settings
  //   m.youtube.com/#ytdc-show    unhide every sidebar entry
  //   m.youtube.com/#ytdc-safe    disable sidebar features this session
  // =================================================================
  // YouTube redirects m.youtube.com/#ytdc-safe to /?ra=m and drops the
  // hash, so the flag has to survive that. Reading it writes a short
  // lived marker that the post-redirect load picks up.
  const SAFE_KEY = 'ytdc.safeUntil';
  const RAW = ((location.hash || '') + (location.search || '')).toLowerCase();
  function armSafe() {
    try { localStorage.setItem(SAFE_KEY, String(Date.now() + 5 * 60 * 1000)); } catch (e) {}
  }
  function safeArmed() {
    try {
      const v = Number(localStorage.getItem(SAFE_KEY) || 0);
      if (v && Date.now() < v) return true;
      if (v) localStorage.removeItem(SAFE_KEY);
    } catch (e) {}
    return false;
  }
  if (RAW.includes('ytdc-safe') || RAW.includes('ytdc=safe')) armSafe();
  const SAFE_MODE = safeArmed();
  const HASH = RAW;
  const PANIC = false;

  // =================================================================
  // LOG
  //
  // This script runs on a phone and is read from a desktop, so the console is the only
  // window into it (dev/serve.py serves it there; scripts/ios-log.mjs reads it back).
  //
  // Deliberately quiet: one boot line and real faults, nothing per-frame. Every message
  // crosses a USB debug bridge, and a chatty page is what makes a remote inspector crawl -
  // YouTube's own blocked-request spam already proves the point. The [ytdc] prefix is what
  // makes these findable among it.
  // =================================================================
  const LOG = (...a) => { try { console.info('[ytdc]', ...a); } catch (e) {} };
  const WARN = (...a) => { try { console.warn('[ytdc]', ...a); } catch (e) {} };

  // YouTube sets require-trusted-types-for 'script', which covers innerHTML as well as
  // eval: assigning a plain string throws "This assignment requires a TrustedHTML" and
  // every icon in this file is an inline SVG string. Route them through a policy that
  // returns the markup unchanged - the same thing the page does for its own templates.
  //
  // This is not cosmetic. The throw happened inside the observer that reacts to YouTube's
  // DOM churn, so it fired repeatedly, and Stay reacted by abandoning its page-world
  // injection and falling back to a content-world one - which is why the script appeared
  // to run twice.
  let htmlPolicy;
  const setHTML = (el, html) => {
    try {
      if (htmlPolicy === undefined) {
        htmlPolicy = (window.trustedTypes && window.trustedTypes.createPolicy)
          ? window.trustedTypes.createPolicy('ytdc-html', { createHTML: (s) => s })
          : null;
      }
    } catch (e) { htmlPolicy = null; WARN('no TrustedHTML policy:', e && e.message); }
    try {
      el.innerHTML = htmlPolicy ? htmlPolicy.createHTML(html) : html
    } catch (e) { WARN('setHTML failed:', e && e.message); }
  };

  // =================================================================
  // SETTINGS
  // =================================================================
  const DEFAULTS = {
    app: APP,
    schema: SCHEMA,
    features: {
      hideShortsNav: true,
      hideShortsShelves: true,
      hideCommunityPosts: true,
      hideHomeBanners: true,
      replaceYoodle: true,
      customiseSidebar: true,
      addExtraItems: true,
      backgroundPlay: false,
      pipButton: false,
      stopPreviews: false,
      feedMode: 'off',
    },
    logo: null,
    sidebar: { hidden: [], order: [], hrefs: {}, seeded: false },
    drawer: null,
    checks: { sponsorblock: null, checkedAt: null },
  };

  const FEATURE_INFO = {
    hideShortsNav: ['Hide Shorts button',
      'Removes Shorts from the bottom bar on mobile and the sidebar on desktop.'],
    hideShortsShelves: ['Hide Shorts rows',
      'Removes Shorts shelves wherever they appear in feeds and search.'],
    hideCommunityPosts: ['Hide community posts',
      'Removes text and poll posts from feeds. Also catches some news shelves, since YouTube renders both as rich sections.'],
    hideHomeBanners: ['Hide promo banners',
      'Removes the large "YouTube featured" cards at the top of the home feed.'],
    replaceYoodle: ['Replace yoodles',
      'Swaps holiday and campaign logos for the normal logo, lifted from your own sidebar.'],
    customiseSidebar: ['Customise sidebar',
      'Enables the editor for hiding and reordering sidebar entries.'],
    addExtraItems: ['Add extra sidebar items',
      'Adds Subscriptions, Watch later and Playlists to the sidebar.'],
    backgroundPlay: ['Keep playing in background tabs',
      'Stops YouTube pausing when you switch tabs inside the browser. Takes effect on the '
      + 'next page load. It cannot help when you leave the browser or lock the screen: iOS '
      + 'suspends the page, and only Picture in Picture survives that.'],
    stopPreviews: ['Stop video previews',
      'Stops thumbnails playing a silent preview. On a phone these mostly start by accident '
      + 'while scrolling, and they cost data and battery. The video you actually open is '
      + 'never affected. Off by default: turn it on and check the player still plays.'],
    pipButton: ['Picture in Picture button',
      'Adds a PiP button to the player. iOS only allows PiP from a real tap, so this cannot '
      + 'be automatic - tap it before leaving the app, and audio keeps going.'],
  };
  const FEED_INFO = ['Home feed', {
    off: 'Leave the home feed alone.',
    items: 'Hide recommended videos, keep the category chips.',
    grid: 'Hide the whole home feed including chips.',
  }];
  const EXTRAS = [
    { label: 'Subscriptions', href: '/feed/subscriptions', icon: 'subs' },
    { label: 'Watch later', href: '/playlist?list=WL', icon: 'clock' },
    { label: 'Playlists', href: '/feed/playlists', icon: 'list' },
  ];
  const ICONS = {
    subs: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M7 4h10v1.4H7zM5 7h14v1.4H5zM3.5 10.5h17V20h-17zM10 12.6v4.8l4.4-2.4z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="8.6"/><path d="M12 6.8v5.5l3.7 2.2" stroke-linecap="round"/></svg>',
    list: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3 6.5h13M3 11.5h13M3 16.5h8"/><path d="M17 12.6l5.2 3-5.2 3z" fill="currentColor" stroke="none"/></svg>',
    gear: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 8.6A3.4 3.4 0 1 0 12 15.4 3.4 3.4 0 0 0 12 8.6zm8.2 4.6l1.9 1.5-1.9 3.2-2.3-.9a7.6 7.6 0 0 1-1.9 1.1l-.3 2.4h-3.8l-.3-2.4a7.6 7.6 0 0 1-1.9-1.1l-2.3.9-1.9-3.2 1.9-1.5a7.4 7.4 0 0 1 0-2.4L1.6 9.3l1.9-3.2 2.3.9a7.6 7.6 0 0 1 1.9-1.1l.3-2.4h3.8l.3 2.4c.7.26 1.32.63 1.9 1.1l2.3-.9 1.9 3.2-1.9 1.5c.06.4.09.8.09 1.2s-.03.8-.09 1.2z"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
    bug: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M20 8h-2.8a5 5 0 0 0-1.2-1.5l1.6-1.7-1.4-1.4-1.9 1.9a5.3 5.3 0 0 0-4.6 0L7.8 3.4 6.4 4.8 8 6.5A5 5 0 0 0 6.8 8H4v2h2.1v1.5H4v2h2.1V15H4v2h2.8a5.2 5.2 0 0 0 10.4 0H20v-2h-2.1v-1.5H20v-2h-2.1V10H20V8zm-6 9h-4v-2h4v2zm0-4h-4v-2h4v2z"/></svg>',
    pip: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2.6" y="4.6" width="18.8" height="14.8" rx="2.2"/><rect x="12.4" y="11.4" width="7.6" height="6.4" rx="1.4" fill="currentColor" stroke="none"/></svg>',
    grip: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
  };

  // =================================================================
  // STORAGE
  // =================================================================
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function merge(base, over) {
    const out = clone(base);
    if (!over || typeof over !== 'object') return out;
    for (const k of Object.keys(over)) {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && out[k]) out[k] = merge(out[k], over[k]);
      else if (over[k] !== undefined) out[k] = over[k];
    }
    return out;
  }
  const uniq = (a) => [...new Set(Array.isArray(a) ? a : [])];
  const migrate = (raw) => {
    if (!raw || typeof raw !== 'object') return clone(DEFAULTS);
    raw.schema = SCHEMA;
    const out = merge(DEFAULTS, raw);
    // Duplicates in order made CSS pick the last occurrence, which
    // dragged the affected entries to the bottom. Repair on load so
    // an already corrupted store fixes itself.
    out.sidebar.order = uniq(out.sidebar.order);
    out.sidebar.hidden = uniq(out.sidebar.hidden);
    return out;
  };
  let S = clone(DEFAULTS);
  function load() {
    try {
      const raw = localStorage.getItem(STORE);
      S = migrate(raw ? JSON.parse(raw) : null);
    } catch (e) { S = clone(DEFAULTS); }
  }
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) {} };
  load();

  let recoveryNote = '';
  if (HASH.includes('ytdc-reset') || HASH.includes('ytdc=reset')) {
    S = clone(DEFAULTS); save();
    recoveryNote = 'Settings were reset.';
  } else if (HASH.includes('ytdc-show') || HASH.includes('ytdc=show')) {
    S.sidebar.hidden = []; save();
    recoveryNote = 'All sidebar items unhidden.';
  }
  if (SAFE_MODE) recoveryNote += ' Safe mode is active (sidebar features off).';

  // =================================================================
  // PLAYBACK
  //
  // Two separate problems, and only one of them is ours to solve.
  //
  // Switching tabs inside the browser: YouTube pauses because it watches
  // document.hidden and visibilitychange. Lying about both keeps playback going. The
  // technique is the one in Greasy Fork script 560972 (CC-BY-4.0), reimplemented here
  // rather than copied - it is about thirty lines and this file is MIT.
  //
  // Leaving the browser, or locking the screen: not fixable this way. iOS suspends the
  // page, and no amount of lying about visibility prevents suspension. Only Picture in
  // Picture keeps audio alive, and iOS grants PiP only from a real tap - a scripted call
  // is refused silently, returning normally while the mode stays 'inline' (verified on
  // device). Hence a button rather than anything automatic.
  // =================================================================
  const VIDEO_SEL = '#movie_player video, ytm-player video, ytd-player video, video';
  const mainVideo = () => document.querySelector(VIDEO_SEL);

  if (S.features.backgroundPlay) {
    // Define over the prototype's getter rather than the instance so that reads through
    // Document.prototype see it too, and swallow the events at capture so YouTube's own
    // listeners never run.
    const lie = (obj, prop, value) => {
      try {
        Object.defineProperty(obj, prop, { configurable: true, get: () => value });
      } catch (e) { WARN('could not mask', prop, e && e.message); }
    };
    lie(Document.prototype, 'hidden', false);
    lie(Document.prototype, 'webkitHidden', false);
    lie(Document.prototype, 'visibilityState', 'visible');
    lie(Document.prototype, 'webkitVisibilityState', 'visible');

    const swallow = (e) => { e.stopImmediatePropagation(); e.stopPropagation(); };
    for (const type of ['visibilitychange', 'webkitvisibilitychange']) {
      window.addEventListener(type, swallow, true);
      document.addEventListener(type, swallow, true);
    }

    // Deliberately NOT resuming the pause iOS performs when the app backgrounds.
    //
    // It was tried, with guards, and it made things worse. Calling play() from the pause
    // handler does resume - for a fraction of a second - and then iOS pauses again,
    // because background audio is granted by user intent carried through the media
    // session, not by a media element asking. Worse, after the attempts the element was
    // left paused in a state YouTube's foreground logic no longer undoes, so returning to
    // the app came back paused where it had previously resumed on its own.
    //
    // Leave the pause alone. Tapping play on the lock screen works, and so does entering
    // PiP before leaving - both carry the intent iOS is looking for.
  }

  // Run the rest once per document.
  //
  // Stay injects this script twice on one load - its own console says "Run script" twice -
  // and the two copies get separate JavaScript contexts, so a flag on `window` is invisible
  // to the other. The DOM is the only thing they share, so the marker lives there.
  //
  // Deliberately placed *after* the visibility patch above. Only a copy running in the
  // page's own world can hide document.hidden from YouTube's code, and there is no way to
  // tell from in here which world this is - so both copies patch, and whichever arrives
  // first takes the observers and the UI. Everything above this point is read-only or
  // idempotent, so running it twice costs nothing.
  const RAN = 'data-ytdc';
  if (document.documentElement.hasAttribute(RAN)) {
    LOG('second copy stood down; already initialised by', document.documentElement.getAttribute(RAN));
    return;
  }
  document.documentElement.setAttribute(RAN, VERSION);

  // Enough to identify which build is running and in what state, so "it stopped working"
  // can be checked rather than guessed at. Stringified, not an object: an object argument
  // reaches a remote inspector as its class name with the contents dropped.
  LOG('boot', VERSION, JSON.stringify({
    path: location.pathname,
    safeMode: SAFE_MODE,
    feed: S.features.feedMode,
    on: Object.keys(S.features).filter((k) => S.features[k] === true).join(','),
    hidden: S.sidebar.hidden.length,
    recovery: recoveryNote.trim() || undefined,
  }));

  // =================================================================
  // PREVIEWS
  //
  // Thumbnails play a silent preview when they think you are interested. On a phone that
  // mostly happens by accident while scrolling, and it costs data and battery.
  //
  // Matched by structure rather than by class name: YouTube renames its classes often, and
  // this had to be written without a device to check against. A preview is any video that
  // starts playing while it is not inside a real player container - which stays true
  // however the markup is spelled. Anything unexpected is treated as the main player and
  // left alone, so the failure mode is "does nothing", never "breaks playback".
  // =================================================================
  const PLAYER_HOSTS = '#movie_player, ytm-player, ytd-player, ytm-watch, #player, ' +
    '.html5-video-player, ytd-watch-flexy, #player-container';
  let previewsStopped = 0;

  const isMainPlayer = (v) => {
    try { return !v.closest || !!v.closest(PLAYER_HOSTS); } catch (e) { return true; }
  };

  const stopPreview = (v) => {
    if (!S.features.stopPreviews || !(v instanceof HTMLMediaElement)) return;
    if (isMainPlayer(v)) return;
    try {
      v.autoplay = false;
      v.preload = 'none';
      if (!v.paused) v.pause();
      previewsStopped++;
      // Only the first few: every line crosses a USB debug bridge, and a feed can produce
      // these continuously while scrolling.
      if (previewsStopped <= 3) {
        LOG('preview stopped (' + previewsStopped + ')',
          (v.parentElement && v.parentElement.tagName || '?').toLowerCase());
      }
    } catch (e) { WARN('could not stop a preview:', e && e.message); }
  };

  document.addEventListener('play', (e) => stopPreview(e.target), true);
  document.addEventListener('playing', (e) => stopPreview(e.target), true);

  // Catch anything already rolling when the setting is switched on mid-session.
  const sweepPreviews = () => {
    if (!S.features.stopPreviews) return;
    for (const v of document.querySelectorAll('video')) if (!v.paused) stopPreview(v);
  };

  function togglePip() {
    const v = mainVideo();
    if (!v) { WARN('pip: no video element on', location.pathname); return; }
    try { v.disablePictureInPicture = false; } catch (e) {}
    try {
      if (typeof v.webkitSetPresentationMode === 'function') {
        // The iOS spelling. Toggles, so a second tap returns the video inline.
        v.webkitSetPresentationMode(
          v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
      } else if (document.pictureInPictureElement) {
        document.exitPictureInPicture();
      } else if (typeof v.requestPictureInPicture === 'function') {
        v.requestPictureInPicture();
      } else {
        WARN('pip: no API on this browser');
        return;
      }
    } catch (e) { WARN('pip threw:', e && e.message); return; }

    // Report what actually happened. WebKit refuses without user activation by doing
    // nothing at all, so "it did not throw" says nothing about whether it worked.
    setTimeout(() => {
      const now = mainVideo();
      const mode = now && now.webkitPresentationMode;
      const btn = document.getElementById('ytdc-pip');
      if (btn && mode) btn.setAttribute('data-mode', mode);
      LOG('pip', mode || (document.pictureInPictureElement ? 'picture-in-picture' : 'unknown'));
    }, 700);
  }

  function mountPip() {
    if (!S.features.pipButton || PANIC) return;
    const onWatch = location.pathname === '/watch';
    const existing = document.getElementById('ytdc-pip');
    if (!onWatch || !mainVideo()) { if (existing) existing.remove(); return; }
    if (existing) return;
    const b = document.createElement('button');
    b.id = 'ytdc-pip';
    b.className = 'ytdc-pip';
    b.type = 'button';
    b.setAttribute('aria-label', 'Picture in picture');
    setHTML(b, ICONS.pip)
    // A listener on a real tap, which is the only way iOS will grant PiP.
    b.addEventListener('click', togglePip);
    document.body.appendChild(b);
  }

  // =================================================================
  // PAGE RULES
  // =================================================================
  const pivot = (...cs) => cs.map((c) => `ytm-pivot-bar-item-renderer:has(.${c})`);
  const RULES = {
    hideShortsNav: ['ytd-guide-entry-renderer:has(a[href^="/shorts"])',
      'ytd-mini-guide-entry-renderer:has(a[href^="/shorts"])', ...pivot('pivot-shorts')],
    hideShortsShelves: ['ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])',
      'ytd-reel-shelf-renderer', 'ytm-reel-shelf-renderer',
      'ytm-rich-section-renderer:has(ytm-shorts-lockup-view-model)',
      'ytm-rich-item-renderer:has(ytm-shorts-lockup-view-model)'],
    hideCommunityPosts: ['.rich-section-content',
      'ytd-rich-section-renderer:has(ytd-post-renderer)',
      'ytd-rich-section-renderer:has(ytd-backstage-post-thread-renderer)'],
    hideHomeBanners: ['ytm-statement-banner-renderer', 'ytd-statement-banner-renderer'],
  };
  const FEED_RULES = {
    items: ['ytd-browse[page-subtype="home"] ytd-rich-item-renderer', 'ytm-rich-item-renderer',
      'ytm-rich-section-renderer', 'ytm-continuation-item-renderer'],
    grid: ['ytd-browse[page-subtype="home"] ytd-rich-grid-renderer', 'ytm-rich-grid-renderer'],
  };
  const HOME_SCOPED = new Set(['hideHomeBanners']);

  // =================================================================
  // LOGO
  // =================================================================
  const LOGO_TARGETS = ['ytm-logo-entity img', 'ytm-home-logo img', 'img.mobile-topbar-logo',
    'img.ytmLogoEntityLogo', 'ytd-yoodle-renderer img'].join(',');
  const SIDEBAR_LOGO_SELECTORS = ['.ytSpecMoreDrawerViewModelMoreDrawerHeaderLogo svg',
    'div.navigationLayoutNsHeaderIconWrapper svg'];
  const LOGO_COLOR = '#ffffff';
  const LOGO_HEIGHT = 24;

  function sanitizeSvg(html) {
    let s = html;
    if (!/xmlns=/.test(s)) s = s.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    s = s.replace(/currentColor/g, LOGO_COLOR).replace(/\sclass="[^"]*"/g, '')
      .replace(/\sid="[^"]*"/g, '').replace(/<!--[\s\S]*?-->/g, '');
    s = s.replace(/<path\b([^>]*?)(\/?)>/g, (m, a, sl) =>
      /fill\s*=/.test(a) ? m : `<path${a} fill="${LOGO_COLOR}"${sl}>`);
    return s.trim();
  }
  function logoCss() {
    if (!S.features.replaceYoodle || !S.logo || S.logo.type !== 'svg') return '';
    const uri = 'data:image/svg+xml;utf8,' + encodeURIComponent(sanitizeSvg(S.logo.html));
    return `${LOGO_TARGETS}{content:url("${uri}")!important;width:auto!important;` +
      `height:${LOGO_HEIGHT}px!important;max-width:none!important;object-fit:contain!important}`;
  }
  function autoCaptureLogo() {
    if (!S.features.replaceYoodle || S.logo) return;
    for (const sel of SIDEBAR_LOGO_SELECTORS) {
      let el = null;
      try { el = document.querySelector(sel); } catch (e) {}
      if (!el || el.tagName.toLowerCase() !== 'svg' || el.outerHTML.length < 800) continue;
      S.logo = { type: 'svg', html: el.outerHTML.slice(0, 30000), via: sel };
      save(); restyle();
      return;
    }
  }

  // =================================================================
  // STYLE
  // =================================================================
  const STYLE_ID = 'ytdc-style';
  const cssEsc = (v) => String(v).replace(/["\\]/g, '\\$&');
  const hrefRule = (h) => `navigation-item-view-model:has(a[href="${cssEsc(h)}"])`;
  const extraRule = (l) => `[data-ytdc-extra="${cssEsc(l)}"]`;
  const sidebarOn = () => S.features.customiseSidebar && !SAFE_MODE;

  function sidebarCss() {
    if (!sidebarOn()) return '';
    const out = [];
    out.push('div.navigationLayoutNsContent{display:flex!important;flex-direction:column!important}');
    out.push('div.navigationLayoutNsContent>*{min-width:0;max-width:100%;box-sizing:border-box}');
    out.push('divider-view-model{order:800}');
    // While editing, every entry must be visible and the live drag
    // preview drives order through inline styles. Emitting the hide
    // and order rules here would out-specify both.
    if (editing) return out.join('\n');
    for (const label of uniq(S.sidebar.hidden)) {
      const h = S.sidebar.hrefs[label];
      if (h) out.push(`${hrefRule(h)}{display:none!important}`);
      out.push(`${extraRule(label)}{display:none!important}`);
    }
    uniq(S.sidebar.order).forEach((label, i) => {
      const h = S.sidebar.hrefs[label];
      if (h) out.push(`${hrefRule(h)}{order:${i + 1}!important}`);
      out.push(`${extraRule(label)}{order:${i + 1}!important}`);
    });
    return out.join('\n');
  }

  function uiCss() {
    return [
      '[data-ytdc-hide="1"]{display:none!important}',
      '.ytdc-foot{position:absolute;left:0;right:0;bottom:0;z-index:6;display:flex;gap:12px;',
      '  align-items:center;justify-content:center;padding:10px 14px}',
      '.ytdc-btn{flex:1 1 0;padding:12px 8px;border:0;border-radius:24px;',
      '  font:600 15px Roboto,system-ui;background:rgba(128,128,128,.24);color:inherit}',
      '.ytdc-btn.primary{background:#f00;color:#fff}',
      '.ytdc-icon-btn{width:44px;height:44px;flex:0 0 auto;border:0;border-radius:50%;',
      '  background:rgba(128,128,128,.24);color:inherit;display:flex;align-items:center;',
      '  justify-content:center;padding:0}',
      // Long press was selecting the label text instead of starting a
      // drag. Selection and the iOS callout are both off while editing.
      '.ytdc-editing,.ytdc-editing *{-webkit-user-select:none!important;user-select:none!important;',
      '  -webkit-touch-callout:none!important}',
      '.ytdc-editing navigation-item-view-model,.ytdc-editing [data-ytdc-extra]{',
      '  display:flex!important;align-items:center;gap:10px;padding-left:10px;padding-right:4px}',
      '.ytdc-editing navigation-item-view-model>:not(.ytdc-cb):not(.ytdc-grip),',
      '.ytdc-editing [data-ytdc-extra]>:not(.ytdc-cb):not(.ytdc-grip){flex:1 1 auto;min-width:0}',
      '.ytdc-cb{flex:0 0 auto;width:22px;height:22px;margin:0;accent-color:#f00}',
      '.ytdc-grip{flex:0 0 auto;opacity:.5;touch-action:none!important;padding:12px 6px;',
      '  display:flex;align-items:center}',
      '.ytdc-dragging{opacity:.45}',
      '.ytdc-sheet{position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.55);',
      '  display:flex;align-items:flex-end}',
      '.ytdc-card{width:100%;max-height:88vh;overflow:auto;border-radius:16px 16px 0 0;',
      '  padding:16px 16px 28px;font:14px Roboto,system-ui}',
      '.ytdc-h{font:700 17px Roboto,system-ui;margin:4px 0 14px}',
      '.ytdc-h2{font:700 13px Roboto,system-ui;text-transform:uppercase;letter-spacing:.5px;',
      '  opacity:.6;margin:22px 0 8px}',
      '.ytdc-opt{display:flex;gap:12px;padding:11px 0;border-bottom:1px solid rgba(128,128,128,.18)}',
      '.ytdc-opt input{width:20px;height:20px;flex:0 0 auto;margin-top:2px;accent-color:#f00}',
      '.ytdc-opt .t{font-weight:600}',
      '.ytdc-opt .d{opacity:.65;font-size:12.5px;line-height:1.45;margin-top:3px}',
      '.ytdc-note{font-size:12.5px;line-height:1.5;opacity:.78;margin:8px 0}',
      '.ytdc-ok{color:#3ddc84;font-weight:600}.ytdc-no{color:#ff6b6b;font-weight:600}',
      '.ytdc-warn{color:#ffd60a;font-weight:600}',
      '.ytdc-ta{width:100%;min-height:90px;margin-top:8px;padding:8px;border-radius:8px;',
      '  border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;',
      '  font:11px ui-monospace,monospace}',
      '.ytdc-pre{white-space:pre-wrap;font:10px/1.45 ui-monospace,monospace;opacity:.85;',
      '  max-height:52vh;overflow:auto;margin-top:8px}',
      '.ytdc-sel{width:100%;padding:10px;border-radius:8px;background:transparent;color:inherit;',
      '  border:1px solid rgba(128,128,128,.4);font:14px Roboto,system-ui}',
      // Floating rather than injected into the player controls: YouTube rebuilds those
      // constantly and renames their classes, and a control that vanishes mid-video is
      // worse than one that sits beside them.
      '.ytdc-pip{position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));',
      '  z-index:2147483644;width:44px;height:44px;border:0;border-radius:50%;',
      '  display:flex;align-items:center;justify-content:center;color:#fff;',
      '  background:rgba(0,0,0,.62);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);',
      '  box-shadow:0 2px 10px rgba(0,0,0,.35)}',
      '.ytdc-pip:active{transform:scale(.92)}',
      '.ytdc-pip[data-mode="picture-in-picture"]{background:rgba(255,0,0,.8)}',
    ].join('');
  }

  function buildCss() {
    if (PANIC) return '';
    const out = [];
    const push = (sels, home) => sels.forEach((s) =>
      out.push(`${home ? 'html[data-ytdc-home] ' : ''}${s}{display:none!important}`));
    for (const k of Object.keys(RULES)) if (S.features[k]) push(RULES[k], HOME_SCOPED.has(k));
    if (FEED_RULES[S.features.feedMode]) push(FEED_RULES[S.features.feedMode], true);
    out.push(logoCss(), sidebarCss(), uiCss());
    return out.filter(Boolean).join('\n');
  }
  function restyle() {
    const old = document.getElementById(STYLE_ID);
    if (old) old.remove();
    const root = document.head || document.documentElement;
    if (!root) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = buildCss();
    root.appendChild(el);
  }
  function syncHome() {
    const home = location.pathname === '/' || location.pathname === '';
    if (home) document.documentElement.dataset.ytdcHome = '1';
    else delete document.documentElement.dataset.ytdcHome;
  }

  // =================================================================
  // DRAWER
  // =================================================================
  const DRAWER_ROOTS = ['div.navigationLayoutNsContent', 'ytm-drawer-renderer', '#drawer'];
  const ROW_SEL = 'navigation-item-view-model';
  const HOST_SEL = 'div.navigationLayoutNsHost';
  const MIN_SEED_ROWS = 6;         // do not seed off a partial render
  const MAX_APPLIES = 400;

  let applies = 0, bailed = false, editing = false, pending = null, editRoot = null;
  let lastOrderApplied = '';

  // Presence only. The old version required height > 80, which
  // deadlocked: hiding every entry collapsed the container to zero
  // height, findDrawer returned null, and the repair code that would
  // have unhidden them never got to run.
  function findDrawer() {
    const list = S.drawer && S.drawer.containerSel
      ? [S.drawer.containerSel, ...DRAWER_ROOTS] : DRAWER_ROOTS;
    for (const s of list) {
      let el = null;
      try { el = document.querySelector(s); } catch (e) {}
      if (el && el.isConnected) return el;
    }
    return null;
  }

  // Openness is measured on the host, which holds the header and so
  // keeps its height even when every entry is hidden.
  function drawerVisible(root) {
    const host = root.closest(HOST_SEL) || root.parentElement;
    if (!host) return false;
    return host.getBoundingClientRect().height > 80;
  }
  const labelOf = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ');

  function allRows(root) {
    const out = [], seen = new Set();
    for (const el of root.querySelectorAll(ROW_SEL)) {
      if (el.closest('.ytdc-foot')) continue;
      const extra = el.getAttribute('data-ytdc-extra');
      const label = extra || labelOf(el);
      if (!label || label.length > 32 || seen.has(label)) continue;
      seen.add(label);
      out.push({ label, el, extra: !!extra });
    }
    return out;
  }

  function captureHrefs(rows) {
    let changed = false;
    for (const { label, el, extra } of rows) {
      if (extra) continue;
      const a = el.querySelector('a[href]');
      if (!a) continue;
      const href = a.getAttribute('href');
      if (S.sidebar.hrefs[label] !== href) { S.sidebar.hrefs[label] = href; changed = true; }
    }
    if (changed) { save(); restyle(); }
  }

  // Seeding once off a half-rendered drawer was marking everything
  // hidden and then latching, so it now needs a plausible row count.
  function seedDefaults(rows) {
    if (S.sidebar.seeded) return;
    const native = rows.filter((r) => !r.extra);
    if (native.length < MIN_SEED_ROWS) return;
    const keep = new Set(['music', 'live', 'gaming', ...EXTRAS.map((e) => e.label.toLowerCase())]);
    const hide = rows.map((r) => r.label).filter((l) => !keep.has(l.toLowerCase()));
    // Refuse to seed a state with nothing left visible.
    if (hide.length >= rows.length) return;
    S.sidebar.hidden = uniq(hide);
    S.sidebar.order = uniq(rows.map((r) => r.label));
    S.sidebar.seeded = true;
    save(); restyle();
  }

  // Cause-agnostic safety net. Whatever the reason, an entirely empty
  // sidebar is never a state the user asked for, so undo the hiding
  // and record it rather than leaving them stranded.
  let healed = '';
  function selfHeal(root) {
    const rows = allRows(root);
    if (rows.length < 3) return;                  // still rendering
    const visible = rows.filter((r) => r.el.getBoundingClientRect().height > 4);
    if (visible.length > 0) return;
    healed = `unhid ${S.sidebar.hidden.length} entries at ` +
      new Date().toTimeString().slice(0, 8) + ' (sidebar rendered empty)';
    S.sidebar.hidden = [];
    save(); restyle();
    lastOrderApplied = '';
  }

  // Outside edit mode the generated CSS owns ordering, which is what
  // removes the delay: the rules exist before the drawer renders.
  // This pass only clears leftover inline values from an edit session
  // so the two mechanisms can never disagree again.
  function applyOrder(root) {
    const rows = allRows(root);
    const sig = rows.map((r) => r.label).join('|') + '::' + S.sidebar.order.join('|');
    if (sig === lastOrderApplied) return;
    lastOrderApplied = sig;
    rows.forEach(({ el }) => { if (el.style.order) el.style.order = ''; });
  }

  function addExtras(root) {
    if (!S.features.addExtraItems || !sidebarOn()) return;
    const template = root.querySelector(`${ROW_SEL}:not([data-ytdc-extra])`);
    if (!template) return;
    for (const spec of EXTRAS) {
      if (root.querySelector(extraRule(spec.label))) continue;
      const node = template.cloneNode(true);
      node.setAttribute('data-ytdc-extra', spec.label);
      node.removeAttribute('data-ytdc-hide');
      const a = node.querySelector('a[href]');
      if (a) { a.setAttribute('href', spec.href); a.removeAttribute('aria-label'); }
      const icon = node.querySelector('c3-icon, svg');
      if (icon) {
        const holder = icon.tagName.toLowerCase() === 'svg' ? icon.parentElement : icon;
        if (holder) setHTML(holder, ICONS[spec.icon])
      }
      const lab = node.querySelector('.navigationItemShapeNavigationItemLabel') || node.querySelector('span');
      if (lab) lab.textContent = spec.label;
      root.appendChild(node);
      lastOrderApplied = '';
    }
  }

  function applyDivider(root) {
    const kids = [...root.children].filter((c) => !c.classList.contains('ytdc-foot'));
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.tagName.toLowerCase() !== 'divider-view-model') continue;
      let orphan = true;
      for (let j = i + 1; j < kids.length; j++) {
        const k = kids[j];
        if (!k.matches(ROW_SEL)) continue;
        if (k.getBoundingClientRect().height > 4) { orphan = false; break; }
      }
      if (orphan) c.setAttribute('data-ytdc-hide', '1');
      else c.removeAttribute('data-ytdc-hide');
    }
  }

  function applyDrawer() {
    if (PANIC) return;
    const root = findDrawer();
    if (!root) return;
    if (!drawerVisible(root)) return;        // closed, nothing to measure
    if (editing && (!editRoot || !editRoot.isConnected)) {
      editing = false; pending = null; editRoot = null;
    }
    // Say so once, on the transition. Bailing is silent otherwise, and a silently
    // disabled script looks identical to a broken one.
    if (++applies > MAX_APPLIES && !bailed) {
      bailed = true;
      WARN('bailed after', MAX_APPLIES, 'applies on', location.pathname,
        '- the drawer kept changing, so sidebar rules are now off for this page');
    }

    autoCaptureLogo();
    // Both of these run before any feature gate so a bad state can
    // always be seen and undone.
    selfHeal(root);
    mountFooter(root);
    if (editing || bailed || !sidebarOn()) return;

    addExtras(root);
    const rows = allRows(root);
    if (!rows.length) return;
    captureHrefs(rows);
    seedDefaults(rows);
    applyOrder(root);
    applyDivider(root);
    selfHeal(root);
  }

  // =================================================================
  // FOOTER + EDITOR
  // =================================================================
  const drawerHost = (root) => root.closest(HOST_SEL) || root.parentElement || root;
  function sampleBg(el) {
    let cur = el;
    for (let i = 0; i < 6 && cur; i++) {
      const bg = getComputedStyle(cur).backgroundColor;
      if (bg && !/rgba?\(0,\s*0,\s*0,\s*0\)|transparent/.test(bg)) return bg;
      cur = cur.parentElement;
    }
    return '#0f0f0f';
  }
  function mountFooter(root) {
    const host = drawerHost(root);
    if (!host) return;
    const existing = host.querySelector(':scope > .ytdc-foot');
    if (existing && existing.isConnected) return;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const bar = document.createElement('div');
    bar.className = 'ytdc-foot';
    bar.style.background = sampleBg(root);
    renderFooter(bar, root);
    host.appendChild(bar);
    root.style.paddingBottom = '72px';
  }
  function mkBtn(text, cls, fn) {
    const b = document.createElement('button');
    b.className = 'ytdc-btn' + (cls ? ' ' + cls : '');
    b.textContent = text;
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
    return b;
  }
  function mkIcon(name, label, fn) {
    const b = document.createElement('button');
    b.className = 'ytdc-icon-btn';
    setHTML(b, ICONS[name])
    b.setAttribute('aria-label', label);
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
    return b;
  }
  function renderFooter(bar, root) {
    setHTML(bar, '')
    if (!editing) {
      bar.appendChild(mkIcon('pencil', 'Edit sidebar items', () => startEdit(root, bar)));
      bar.appendChild(mkIcon('gear', 'Script settings', openSettings));
      bar.appendChild(mkIcon('bug', 'Debug', openDebug));
    } else {
      bar.appendChild(mkBtn('Cancel', '', () => endEdit(root, bar, false)));
      bar.appendChild(mkBtn('Save', 'primary', () => endEdit(root, bar, true)));
    }
  }

  function startEdit(root, bar) {
    editing = true;
    editRoot = root;
    const live = uniq(allRows(root).map((r) => r.label));
    const saved = uniq(S.sidebar.order).filter((l) => live.includes(l));
    pending = {
      hidden: new Set(uniq(S.sidebar.hidden)),
      order: uniq([...saved, ...live.filter((l) => !saved.includes(l))]),
    };
    root.classList.add('ytdc-editing');
    restyle();                 // drops the hide and order rules
    decorate(root);
    renderFooter(bar, root);
  }

  function decorate(root) {
    allRows(root).forEach(({ label, el }) => {
      el.style.display = 'flex';
      el.style.order = String(pending.order.indexOf(label) + 1);
      if (el.querySelector(':scope > .ytdc-cb')) return;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'ytdc-cb';
      cb.checked = !pending.hidden.has(label);
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        if (cb.checked) pending.hidden.delete(label); else pending.hidden.add(label);
      });
      const grip = document.createElement('span');
      grip.className = 'ytdc-grip';
      setHTML(grip, ICONS.grip)
      attachDrag(grip, el, label, root);
      el.insertBefore(cb, el.firstChild);
      el.appendChild(grip);
    });
  }

  function attachDrag(grip, rowEl, label, root) {
    let timer = 0, active = false, startY = 0;
    const move = (e) => {
      if (!active) return;
      e.preventDefault();
      const y = e.clientY;
      if (Math.abs(y - startY) < 6) return;
      const list = allRows(root)
        .map((r) => ({ ...r, idx: pending.order.indexOf(r.label) }))
        .sort((a, b) => a.idx - b.idx);
      let target = pending.order.indexOf(label);
      for (let i = 0; i < list.length; i++) {
        const r = list[i].el.getBoundingClientRect();
        if (y > r.top && y < r.bottom) { target = i; break; }
      }
      const cur = pending.order.indexOf(label);
      if (target !== cur && target >= 0) {
        pending.order.splice(cur, 1);
        pending.order.splice(target, 0, label);
        allRows(root).forEach(({ label: l, el }) => {
          el.style.order = String(pending.order.indexOf(l) + 1);
        });
        startY = y;
      }
    };
    const up = () => {
      clearTimeout(timer);
      active = false;
      rowEl.classList.remove('ytdc-dragging');
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
    };
    const down = (e) => {
      e.preventDefault(); e.stopPropagation();
      startY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0].clientY) || 0;
      timer = setTimeout(() => {
        active = true;
        rowEl.classList.add('ytdc-dragging');
        if (navigator.vibrate) navigator.vibrate(15);
      }, 320);
      document.addEventListener('pointermove', move, true);
      document.addEventListener('pointerup', up, true);
      document.addEventListener('pointercancel', up, true);
    };
    grip.addEventListener('pointerdown', down, true);
    // Safari fires touchstart before pointerdown for the long-press
    // selection gesture, so cancel it there too.
    grip.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    grip.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function endEdit(root, bar, commit) {
    if (commit && pending) {
      S.sidebar.hidden = uniq([...pending.hidden]);
      S.sidebar.order = uniq(pending.order);
      save();
    }
    editing = false; pending = null; editRoot = null;
    root.classList.remove('ytdc-editing');
    root.querySelectorAll('.ytdc-cb,.ytdc-grip').forEach((n) => n.remove());
    allRows(root).forEach(({ el }) => { el.style.display = ''; el.style.order = ''; });
    restyle();
    lastOrderApplied = '';
    applies = 0; bailed = false;
    renderFooter(bar, root);
    applyDivider(root);
  }

  // =================================================================
  // SHEETS
  // =================================================================
  const SB_SELECTORS = ['#sponsorBlockPlayerControls', '.sponsorSkipObject',
    '#sponsorSkipNoticeContainer', '#sbSubmitButton', '[class*="sponsorBlock"]', '#previewbar'];
  function checkSponsorBlock() {
    for (const sel of SB_SELECTORS) {
      try { if (document.querySelector(sel)) return 'yes'; } catch (e) {}
    }
    return /\/watch|\/shorts/.test(location.pathname) ? 'no' : 'unknown';
  }
  function optRow(checked, title, desc, onChange) {
    const w = document.createElement('label');
    w.className = 'ytdc-opt';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = checked;
    cb.addEventListener('change', () => onChange(cb.checked));
    const t = document.createElement('div');
    const a = document.createElement('div'); a.className = 't'; a.textContent = title;
    const b = document.createElement('div'); b.className = 'd'; b.textContent = desc;
    t.appendChild(a); t.appendChild(b);
    w.appendChild(cb); w.appendChild(t);
    return w;
  }
  const backupObject = () => ({
    app: APP, version: VERSION, schema: SCHEMA,
    exportedAt: new Date().toISOString(), settings: S,
  });
  function restoreFrom(text) {
    let o;
    try { o = JSON.parse(text); } catch (e) { return 'Not valid JSON.'; }
    if (!o || o.app !== APP) return 'That backup is not from this script.';
    if (typeof o.schema !== 'number') return 'Backup has no schema version.';
    if (o.schema > SCHEMA) return `Backup is schema ${o.schema}, this build reads ${SCHEMA}.`;
    S = migrate(o.settings);
    save(); restyle(); lastOrderApplied = '';
    return null;
  }
  function sheet(build) {
    if (document.getElementById('ytdc-sheet')) return;
    const wrap = document.createElement('div');
    wrap.id = 'ytdc-sheet'; wrap.className = 'ytdc-sheet';
    const card = document.createElement('div');
    card.className = 'ytdc-card';
    card.style.background = sampleBg(document.querySelector(HOST_SEL) || document.body);
    card.style.color = getComputedStyle(document.body).color || '#fff';
    wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
    card.addEventListener('click', (e) => e.stopPropagation());
    build(card, () => wrap.remove());
    wrap.appendChild(card);
    document.body.appendChild(wrap);
  }

  function openSettings() {
    sheet((card, close) => {
      const h = document.createElement('div');
      h.className = 'ytdc-h'; h.textContent = 'YouTube Declutter ' + VERSION;
      card.appendChild(h);
      if (recoveryNote) {
        const r = document.createElement('div');
        r.className = 'ytdc-note'; setHTML(r, '<span class="ytdc-warn">' + recoveryNote + '</span>')
        card.appendChild(r);
      }
      const s1 = document.createElement('div');
      s1.className = 'ytdc-h2'; s1.textContent = 'Features';
      card.appendChild(s1);
      for (const key of Object.keys(FEATURE_INFO)) {
        const [t, d] = FEATURE_INFO[key];
        card.appendChild(optRow(!!S.features[key], t, d, (v) => {
          S.features[key] = v; save(); restyle(); lastOrderApplied = '';
          // Both of these are imperative rather than CSS, so they need telling.
          mountPip();
          sweepPreviews();
        }));
      }
      const s2 = document.createElement('div');
      s2.className = 'ytdc-h2'; s2.textContent = FEED_INFO[0];
      card.appendChild(s2);
      const sel = document.createElement('select');
      sel.className = 'ytdc-sel';
      for (const k of ['off', 'items', 'grid']) {
        const o = document.createElement('option');
        o.value = k; o.textContent = FEED_INFO[1][k];
        if (S.features.feedMode === k) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => { S.features.feedMode = sel.value; save(); restyle(); });
      card.appendChild(sel);

      const s3 = document.createElement('div');
      s3.className = 'ytdc-h2'; s3.textContent = 'Companion extensions';
      card.appendChild(s3);
      const sb = checkSponsorBlock();
      S.checks = { sponsorblock: sb, checkedAt: Date.now() }; save();
      const sbb = document.createElement('div');
      sbb.className = 'ytdc-note';
      setHTML(sbb, 'SponsorBlock: ' + (sb === 'yes' ? '<span class="ytdc-ok">detected</span>'
        : sb === 'no' ? '<span class="ytdc-no">not detected</span>'
          : '<span class="ytdc-warn">open a video to check</span>') +
        '<br><br>Edge on iOS: new tab, <b>edge://flags</b>, search <b>Extension</b>, set ' +
        '<b>Edge iOS Web Extension</b> to Enabled, restart Edge. Then menu, <b>Extensions</b>, ' +
        'add <b>SponsorBlock for YouTube</b>.')
      card.appendChild(sbb);
      const ub = document.createElement('div');
      ub.className = 'ytdc-note';
      setHTML(ub, 'uBlock Origin Lite: <span class="ytdc-warn">cannot be detected</span>. ' +
        'It filters at the network layer and leaves nothing in the page to probe, so any status ' +
        'here would be a guess. Install it from the same <b>Extensions</b> menu.')
      card.appendChild(ub);

      const s4 = document.createElement('div');
      s4.className = 'ytdc-h2'; s4.textContent = 'Backup and restore';
      card.appendChild(s4);
      const status = document.createElement('div');
      status.className = 'ytdc-note';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px';
      row.appendChild(mkBtn('Copy', '', () => {
        const t = JSON.stringify(backupObject(), null, 2);
        if (navigator.clipboard) navigator.clipboard.writeText(t)
          .then(() => { status.textContent = 'Copied to clipboard.'; },
            () => { status.textContent = 'Clipboard blocked. Use Download.'; });
      }));
      row.appendChild(mkBtn('Download', '', () => {
        const blob = new Blob([JSON.stringify(backupObject(), null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `yt-declutter-${VERSION}-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        status.textContent = 'Saved.';
      }));
      card.appendChild(row);
      const file = document.createElement('input');
      file.type = 'file'; file.accept = 'application/json,.json';
      file.style.marginTop = '10px';
      file.addEventListener('change', () => {
        const f = file.files && file.files[0];
        if (f) f.text().then((t) => { status.textContent = restoreFrom(t) || 'Restored.'; });
      });
      card.appendChild(file);
      const ta = document.createElement('textarea');
      ta.className = 'ytdc-ta';
      ta.placeholder = 'Or paste a backup here, then tap Restore';
      card.appendChild(ta);

      const s5 = document.createElement('div');
      s5.className = 'ytdc-h2'; s5.textContent = 'Recovery';
      card.appendChild(s5);
      const rec = document.createElement('div');
      rec.className = 'ytdc-note';
      setHTML(rec, 'If the footer buttons ever disappear, add one of these to the URL and ' +
        'reload:<br><b>#ytdc-show</b> unhide everything<br><b>#ytdc-safe</b> disable sidebar ' +
        'features for one session<br><b>#ytdc-reset</b> wipe all settings')
      card.appendChild(rec);
      const row2 = document.createElement('div');
      row2.style.cssText = 'display:flex;gap:8px;margin-top:8px';
      row2.appendChild(mkBtn('Restore', 'primary', () => {
        status.textContent = restoreFrom(ta.value.trim()) || 'Restored.';
      }));
      row2.appendChild(mkBtn('Show all', '', () => {
        S.sidebar.hidden = []; save(); restyle(); lastOrderApplied = '';
        status.textContent = 'All sidebar items shown.';
      }));
      row2.appendChild(mkBtn('Exit safe', '', () => {
        try { localStorage.removeItem(SAFE_KEY); } catch (e) {}
        status.textContent = 'Safe mode cleared. Reload to apply.';
      }));
      row2.appendChild(mkBtn('Reset all', '', () => {
        S = clone(DEFAULTS); save(); restyle(); lastOrderApplied = '';
        status.textContent = 'Reset. Reopen the sidebar.';
      }));
      card.appendChild(row2);
      card.appendChild(status);
      card.appendChild(mkBtn('Close', '', close));
    });
  }

  function report() {
    const L = [];
    const root = findDrawer();
    L.push(`${APP} ${VERSION}  schema ${S.schema}`);
    L.push(`path ${location.pathname}  applies ${applies}/${MAX_APPLIES}${bailed ? ' BAILED' : ''}`);
    L.push(`previews stopped ${previewsStopped}  stopPreviews ${S.features.stopPreviews}`);
    L.push(`editing ${editing}  safeMode ${SAFE_MODE}  seeded ${S.sidebar.seeded}`);
    L.push(`logo ${S.logo ? S.logo.html.length + 'ch' : 'none'}  sponsorblock ${S.checks.sponsorblock}`);
    L.push(`hidden(${S.sidebar.hidden.length}) ${JSON.stringify(S.sidebar.hidden)}`);
    L.push(`order(${S.sidebar.order.length}) ${JSON.stringify(S.sidebar.order)}`);
    L.push(`selfHeal ${healed || 'not triggered'}`);
    const sc = sidebarCss();
    L.push(`sidebarCss ${sc ? sc.split('\n').length + ' rules' : 'DISABLED'}`);
    L.push(`styleTag ${document.getElementById(STYLE_ID) ? 'present' : 'MISSING'}`);
    L.push('');
    if (!root) { L.push('DRAWER closed. Open it, then Refresh.'); return L.join('\n'); }
    const cs = getComputedStyle(root);
    const host = root.closest(HOST_SEL) || root.parentElement;
    L.push('--- CONTAINER ---');
    L.push(`display ${cs.display} ${/flex|grid/.test(cs.display) ? 'OK' : 'NOT flex/grid, order INERT'}`);
    L.push(`content ${Math.round(root.getBoundingClientRect().width)}x` +
      `${Math.round(root.getBoundingClientRect().height)}`);
    L.push(`host    ${host ? Math.round(host.getBoundingClientRect().height) : '?'}px  ` +
      `open=${drawerVisible(root)}`);
    L.push(`footer mounted ${!!drawerHost(root).querySelector(':scope > .ytdc-foot')}`);
    L.push('');
    L.push('--- ROWS ---');
    const rows = allRows(root);
    rows.forEach(({ label, el, extra }) => {
      const a = el.querySelector('a[href]');
      const live = a ? a.getAttribute('href') : '(none)';
      const stored = S.sidebar.hrefs[label] || (extra ? '(extra)' : '(none)');
      const match = extra ? 'extra' : (stored === live ? 'ok' : 'MISMATCH');
      let hits = '-';
      const rule = extra ? extraRule(label) : (S.sidebar.hrefs[label] ? hrefRule(S.sidebar.hrefs[label]) : null);
      if (rule) { try { hits = document.querySelectorAll(rule).length; } catch (e) { hits = 'ERR'; } }
      L.push(`  [${S.sidebar.hidden.includes(label) ? 'x' : ' '}] ${label.padEnd(16).slice(0, 16)} ` +
        `${String(match).padEnd(9)} hits=${hits} inline=${el.style.order || '-'} ` +
        `comp=${getComputedStyle(el).order} h=${Math.round(el.getBoundingClientRect().height)}`);
      if (match === 'MISMATCH') { L.push(`      stored ${stored}`); L.push(`      live   ${live}`); }
      // If a row is collapsed but we did not mark it hidden, name what
      // actually did it so we stop guessing.
      const h = Math.round(el.getBoundingClientRect().height);
      if (h <= 4 && !S.sidebar.hidden.includes(label)) {
        const st = getComputedStyle(el);
        L.push(`      COLLAPSED display=${st.display} vis=${st.visibility} ` +
          `maxH=${st.maxHeight} attr=${el.getAttribute('data-ytdc-hide') || '-'}`);
      }
    });
    L.push('');
    L.push('--- VISUAL ORDER ---');
    [...rows].filter((r) => r.el.getBoundingClientRect().height > 4)
      .sort((a, b) => a.el.getBoundingClientRect().top - b.el.getBoundingClientRect().top)
      .forEach((r, i) => L.push(`  ${i + 1}. ${r.label}`));
    L.push('');
    L.push('--- PAGE RULES ---');
    for (const k of Object.keys(RULES)) {
      if (!S.features[k]) continue;
      let n = 0;
      for (const q of RULES[k]) { try { n += document.querySelectorAll(q).length; } catch (e) {} }
      L.push(`  ${k} = ${n}`);
    }
    return L.join('\n');
  }

  function openDebug() {
    sheet((card, close) => {
      const h = document.createElement('div');
      h.className = 'ytdc-h'; h.textContent = 'Debug';
      card.appendChild(h);
      const pre = document.createElement('div');
      pre.className = 'ytdc-pre';
      pre.textContent = report();
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;margin-bottom:8px';
      row.appendChild(mkBtn('Refresh', '', () => { pre.textContent = report(); }));
      const copy = mkBtn('Copy', '', () => {
        if (navigator.clipboard) navigator.clipboard.writeText(pre.textContent)
          .then(() => { copy.textContent = 'Copied'; });
      });
      row.appendChild(copy);
      row.appendChild(mkBtn('Close', '', close));
      card.appendChild(row);
      card.appendChild(pre);
    });
  }

  // =================================================================
  // BOOT
  // =================================================================
  const update = () => {
    if (!document.getElementById(STYLE_ID)) restyle();
    syncHome();
    mountPip();
    sweepPreviews();
    // Navigation resets the guards so nothing latches across pages.
    applies = 0; bailed = false; lastOrderApplied = '';
    if (editing && (!editRoot || !editRoot.isConnected)) {
      editing = false; pending = null; editRoot = null;
    }
  };
  update();
  if (!document.getElementById(STYLE_ID)) {
    document.addEventListener('DOMContentLoaded', update, { once: true });
  }
  let t = 0;
  function watch() {
    if (PANIC || !document.body) return;
    new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => { applyDrawer(); mountPip(); }, 400);
    }).observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { applyDrawer(); mountPip(); }, 1200);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watch, { once: true });
  } else watch();

  window.addEventListener('yt-navigate-finish', update, true);
  window.addEventListener('state-navigateend', update, true);
  window.addEventListener('popstate', update, true);
  const wrapH = (ty) => {
    const raw = history[ty];
    history[ty] = function () { const r = raw.apply(this, arguments); update(); return r; };
  };
  wrapH('pushState'); wrapH('replaceState');
})();
