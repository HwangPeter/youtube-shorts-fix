// Refresh-after-N-videos content script. Runs in the extension's isolated
// world (it needs extension storage for the popup's setting), after
// refresh-core.js. See refresh-core.js for what it does and why.
//
// It reads only the page URL, the focused element, fullscreen and visibility
// state, ytd-watch-flexy's video-id attribute and the <video>'s current time.
// The only thing it changes is the page address, when it reloads.
(() => {
  'use strict';
  const core = globalThis.YtRefreshCore;
  if (!core || globalThis.__ytRefreshLoaded) return;
  globalThis.__ytRefreshLoaded = true;

  const SETTLE_MS = 1000; // let the new video load before reading its time and reloading

  const api = globalThis.browser || globalThis.chrome;
  const store = core.createSettingsStore(api);

  // The focused element, looking inside shadow roots.
  const focused = () => {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  };
  const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);
  const typing = () => {
    const el = focused();
    if (!el) return false;
    if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && TEXT_INPUTS.has((el.type || 'text').toLowerCase());
  };
  const isUnsafe = () => {
    if (typing()) return 'typing';
    if (document.hidden) return 'hidden';
    if (document.fullscreenElement) return 'fullscreen';
    return null;
  };

  // The main player's time, only once the watch page shows this video (so the
  // previous video's time is never carried over) and no ad is playing, else 0.
  const currentTimeFor = (id) => {
    if (!id || document.querySelector('ytd-watch-flexy')?.getAttribute('video-id') !== id) return 0;
    if (document.querySelector('#movie_player.ad-showing')) return 0;
    const v = document.querySelector('#movie_player video') || document.querySelector('video.html5-main-video');
    return v && Number.isFinite(v.currentTime) ? v.currentTime : 0;
  };

  let pending = 0;
  const refresher = core.createRefresher({
    getSettings: store.get,
    isUnsafe,
    getCurrentTime: () => currentTimeFor(core.videoIdFromUrl(location.href)),
    refresh: () => {
      if (pending) return;
      pending = setTimeout(() => {
        // Recompute at the last moment: the time has moved on, and the user may
        // have moved to yet another video.
        const id = core.videoIdFromUrl(location.href);
        if (!id) { pending = 0; return; } // left the video page: skip; the count has started again
        const url = core.buildRefreshUrl(location.href, currentTimeFor(id));
        console.info('[shorts-fix] reloading YouTube in a fresh page to free memory:', url);
        location.replace(url);
      }, SETTLE_MS);
    },
  });

  let lastHref = '';
  const onNav = () => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    refresher.onUrl(location.href);
  };
  document.addEventListener('yt-navigate-finish', onNav);
  window.addEventListener('popstate', onNav);
  setInterval(onNav, 1000); // in case YouTube changes the URL without the event
  store.ready.then(onNav);
})();
