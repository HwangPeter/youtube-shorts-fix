// YouTube Shorts wrong-video fix. Runs in the page's own JavaScript world
// (extension content script with world "MAIN", or a userscript injected into
// the page), because it reads a property of YouTube's <ytd-shorts> element.
//
// The bug: YouTube's one-shot "re-align after fullscreen/resize" scroll
// correction (gated by ytd-shorts.shouldUpdateItemHeight) writes
//   scrollTop = index * itemHeight + 16
// and ignores the "previous" Shorts YouTube inserts above the current one.
// The view lands on a stale thumbnail slot while the real Short plays
// off-screen one slot below.
//
// Primary fix: keep shouldUpdateItemHeight false so the faulty branch never
// runs. Fallback: if the slot shown in the middle of #shorts-container is not
// the slot that holds the player, and the user is not scrolling, scroll the
// player's slot back into view, provided that slot holds the URL's Short.
//
// Guardrails: every YouTube property and selector is feature-detected; when
// one is missing the script does nothing. No network, no storage, no
// messages; nothing on the page is touched except that flag, the Shorts
// container's scroll position, and two properties on window: a marker
// (__ytShortsFixLoaded) that stops a second copy from running, and a count of
// watchdog corrections (__ytShortsFixCorrections) for verifying it works.
(() => {
  'use strict';
  const FLAG = 'shouldUpdateItemHeight';
  const PRIMARY = true; // build-time switch; false only in the fallback test build
  const SLOT = '.reel-video-in-sequence-new';
  const USER_QUIET_MS = 800;   // no wheel/key/touch/pointer input for this long
  const SCROLL_QUIET_MS = 400; // no scroll event for this long
  const STABLE_MS = 600;       // mismatch must persist this long before acting
  const CHECK_MS = 250;

  // Page-world view of an object: itself in the page world, its
  // wrappedJSObject in a Firefox isolated world.
  const pageView = (o) => (o && o.wrappedJSObject) || o;

  const pageWindow = pageView(window);
  if (pageWindow.__ytShortsFixLoaded) return; // already running (extension + userscript both installed)
  pageWindow.__ytShortsFixLoaded = true;
  pageWindow.__ytShortsFixCorrections = 0; // watchdog corrections so far (for verifying)

  const onShorts = () => location.pathname.startsWith('/shorts/');
  const shortsEl = () => document.querySelector('ytd-shorts');
  const container = () => document.querySelector('ytd-shorts #shorts-container');

  // ---- Primary fix -------------------------------------------------------
  const disarm = () => {
    if (!PRIMARY) return;
    const el = pageView(shortsEl());
    if (el && FLAG in el && el[FLAG] === true) el[FLAG] = false;
  };

  // The faulty branch only runs inside a requestAnimationFrame queued by
  // YouTube's scroll listener on #shorts-container. A capture-phase listener on
  // window runs before that listener, so clearing the flag here means the
  // branch always sees false. fullscreenchange re-arms the flag, so clear it
  // after that too (after YouTube's own handler).
  window.addEventListener('scroll', (e) => {
    if (e.target instanceof Element && e.target.id === 'shorts-container') disarm();
  }, { capture: true, passive: true });
  document.addEventListener('fullscreenchange', () => { disarm(); setTimeout(disarm, 0); });
  document.addEventListener('yt-navigate-finish', disarm);

  // ---- Fallback watchdog -------------------------------------------------
  let lastInput = 0;
  let lastScroll = 0;
  let mismatchSince = 0;
  const markInput = () => { lastInput = performance.now(); };
  for (const t of ['wheel', 'keydown', 'touchstart', 'touchmove', 'pointerdown']) {
    window.addEventListener(t, markInput, { capture: true, passive: true });
  }
  window.addEventListener('scroll', (e) => {
    if (e.target instanceof Element && e.target.id === 'shorts-container') lastScroll = performance.now();
  }, { capture: true, passive: true });

  // Returns {visible, own} slots, or null when the page does not look like the
  // Shorts layout this fix understands.
  const slots = () => {
    const sc = container();
    if (!sc) return null;
    const own = document.querySelector('#reel-overlay-container')?.closest(SLOT);
    if (!own || !sc.contains(own)) return null;
    const box = sc.getBoundingClientRect();
    if (box.height <= 0) return null;
    const mid = box.top + box.height / 2;
    let visible = null;
    for (const s of sc.querySelectorAll(SLOT)) {
      const r = s.getBoundingClientRect();
      if (r.top <= mid && r.bottom >= mid) { visible = s; break; }
    }
    return visible ? { visible, own } : null;
  };

  // The video id a slot belongs to, from its thumbnail (".../vi/<id>/..."),
  // or null when it cannot be read.
  const slotVideoId = (slot) => {
    const t = slot.querySelector('.reel-video-in-sequence-thumbnail') || slot;
    return (t.getAttribute('style') || '').match(/\/vi\/([^/]+)\//)?.[1] || null;
  };
  const playerVideoId = () => {
    try { return pageView(document.querySelector('#shorts-player'))?.getVideoData()?.video_id || null; } catch (e) { return null; }
  };

  // Only correct towards the slot that really holds the URL's Short. During a
  // normal move YouTube can scroll to the new Short a moment before it moves
  // the player out of the old slot; scrolling back to the old slot then would
  // make YouTube navigate back to the old Short.
  const safeTarget = (s) => {
    const urlId = location.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1];
    if (!urlId) return false;
    const ownId = slotVideoId(s.own);
    if (ownId ? ownId !== urlId : playerVideoId() !== urlId) return false;
    return slotVideoId(s.visible) !== urlId;
  };

  const check = () => {
    if (!onShorts() || document.hidden || document.fullscreenElement) { mismatchSince = 0; return; }
    disarm();
    const s = slots();
    const now = performance.now();
    if (!s || s.visible === s.own) { mismatchSince = 0; return; }
    if (!mismatchSince) { mismatchSince = now; return; }
    if (now - mismatchSince < STABLE_MS) return;
    if (now - lastInput < USER_QUIET_MS || now - lastScroll < SCROLL_QUIET_MS) return;
    if (!safeTarget(s)) return;
    mismatchSince = 0;
    pageWindow.__ytShortsFixCorrections += 1;
    s.own.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  };
  setInterval(check, CHECK_MS);
})();
