// YouTube Shorts wrong-video fix. Runs in the page's own JavaScript world
// (extension content script with world "MAIN", or a userscript injected into
// the page), because it reads properties of YouTube's <ytd-shorts> element.
//
// YouTube decides which Short to load from the scroll position of
// #shorts-container. When you open a Short from a channel's Shorts grid it
// puts the channel's earlier Shorts ("previous" slots) above the one you
// clicked. Two bugs follow:
//
// 1. Stale thumbnail. YouTube's one-shot "re-align after fullscreen/resize"
//    scroll correction (gated by ytd-shorts.shouldUpdateItemHeight) writes
//      scrollTop = index * itemHeight + 16
//    and ignores the previous slots. The view lands on a stale thumbnail slot
//    while the real Short plays off-screen.
// 2. Wrong video. On every scroll event YouTube computes
//      round((scrollTop - 16) / itemHeight) - <number of previous slots>
//    and, if that is not the current Short, loads that Short. When the
//    previous slots appear while the list is still at the top (before YouTube
//    has scrolled to the clicked Short, which happens intermittently after
//    Back to the grid), a scroll event in that window makes YouTube navigate
//    to the first previous Short instead of the one you clicked.
//
// Primary fix (1): keep shouldUpdateItemHeight false so the faulty branch
// never runs. Entry guard (2): for a few seconds after a Short is opened from
// a page that is not Shorts, and until the user scrolls, swipes or presses a
// key, if a scroll event leaves the list at a position from which YouTube's
// formula would load a Short other than the current one, set the position
// the formula maps to the current Short, before YouTube reads it.
// Fallback (1): if the slot shown in the middle of #shorts-container is not
// the slot that holds the player, and the user is not scrolling, scroll the
// player's slot back into view, provided that slot holds the URL's Short.
//
// Guardrails: every YouTube property and selector is feature-detected; when
// one is missing the script does nothing. No network, no storage, no
// messages; nothing on the page is touched except that flag, the Shorts
// container's scroll position, and three properties on window: a marker
// (__ytShortsFixLoaded) that stops a second copy from running, and counts of
// watchdog corrections (__ytShortsFixCorrections) and entry-guard corrections
// (__ytShortsFixEntryCorrections) for verifying it works.
(() => {
  'use strict';
  const FLAG = 'shouldUpdateItemHeight';
  const PRIMARY = true; // build-time switch; false only in the fallback test build
  const SLOT = '.reel-video-in-sequence-new';
  const USER_QUIET_MS = 800;   // no wheel/key/touch/pointer input for this long
  const SCROLL_QUIET_MS = 400; // no scroll event for this long
  const STABLE_MS = 600;       // mismatch must persist this long before acting
  const CHECK_MS = 250;
  const ENTRY_MAX_MS = 10000;     // the entry guard stops this long after a Short is opened
  const ENTRY_SETTLED_MS = 1500;  // ...or once the current Short has been centred this long

  // Page-world view of an object: itself in the page world, its
  // wrappedJSObject in a Firefox isolated world.
  const pageView = (o) => (o && o.wrappedJSObject) || o;

  const pageWindow = pageView(window);
  if (pageWindow.__ytShortsFixLoaded) return; // already running (extension + userscript both installed)
  pageWindow.__ytShortsFixLoaded = true;
  pageWindow.__ytShortsFixCorrections = 0; // watchdog corrections so far (for verifying)
  pageWindow.__ytShortsFixEntryCorrections = 0; // entry-guard corrections so far (for verifying)

  const onShorts = () => location.pathname.startsWith('/shorts/');
  const shortsEl = () => document.querySelector('ytd-shorts');
  const container = () => document.querySelector('ytd-shorts #shorts-container');
  const urlVideoId = () => location.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1] || null;
  const isShortsContainer = (e) => e.target instanceof Element && e.target.id === 'shorts-container';

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
    if (isShortsContainer(e)) disarm();
  }, { capture: true, passive: true });
  document.addEventListener('fullscreenchange', () => { disarm(); setTimeout(disarm, 0); });
  document.addEventListener('yt-navigate-finish', disarm);

  // ---- Shared helpers ----------------------------------------------------
  let lastInput = 0;
  let lastScroll = 0;
  const markInput = () => { lastInput = performance.now(); };
  for (const t of ['wheel', 'keydown', 'touchstart', 'touchmove', 'pointerdown']) {
    window.addEventListener(t, markInput, { capture: true, passive: true });
  }

  // The slot centred in #shorts-container, or null.
  const centredSlot = (sc) => {
    const box = sc.getBoundingClientRect();
    if (box.height <= 0) return null;
    const mid = box.top + box.height / 2;
    for (const s of sc.querySelectorAll(SLOT)) {
      const r = s.getBoundingClientRect();
      if (r.top <= mid && r.bottom >= mid) return s;
    }
    return null;
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

  // ---- Entry guard -------------------------------------------------------
  // entryStart: when a navigation started from a page that is not Shorts
  // (normally a click on a grid Short); 0 when the guard is off.
  let entryStart = 0;
  let entryCentredSince = 0;
  let lastNavWasShorts = onShorts();
  const startEntry = () => { entryStart = performance.now(); entryCentredSince = 0; };
  document.addEventListener('yt-navigate-start', () => { if (!onShorts()) startEntry(); });
  document.addEventListener('yt-navigate-finish', () => {
    const now = onShorts();
    if (now && !lastNavWasShorts && !entryStart) startEntry(); // in case yt-navigate-start was missed
    if (!now) entryStart = 0;
    lastNavWasShorts = now;
  });

  const entryActive = () => {
    if (!entryStart) return false;
    const now = performance.now();
    if (lastInput > entryStart || now - entryStart > ENTRY_MAX_MS) { entryStart = 0; return false; }
    return onShorts();
  };

  // YouTube's current index, or null unless its slot exists and holds the
  // URL's Short.
  const currentIndex = (el, sc) => {
    const idx = el?.index;
    if (!Number.isInteger(idx)) return null;
    const slot = sc.querySelector(`${SLOT}[id="${idx}"]`);
    const urlId = urlVideoId();
    if (!slot || !urlId || slotVideoId(slot) !== urlId) return null;
    return idx;
  };

  // The number of previous slots, as YouTube counts them, or null.
  const previousCount = (el) => {
    const prev = el.shortsProcessedPrevSequence;
    if (prev === undefined || prev === null) return 0;
    return Number.isInteger(prev.length) ? prev.length : null;
  };

  // YouTube's scroll listener queues an animation frame that reads the scroll
  // position and, if this formula does not give its current index, loads the
  // Short it does give:
  //   round((scrollTop - 16) / itemHeight) - previousCount
  // This capture-phase listener runs first, so its animation frame runs just
  // before YouTube's, with the same itemHeight YouTube will use. The formula is
  // used rather than the slot positions because the two disagree while the
  // player is still in YouTube's initial container.
  const guardEntry = (sc) => {
    if (!entryActive()) return;
    const el = pageView(shortsEl());
    if (!el) return;
    // With the flag on, YouTube's frame re-aligns instead of loading a Short.
    // That is bug 1, for the primary fix and the watchdog, not this guard.
    if (el[FLAG] === true) return;
    const ih = el.itemHeight;
    if (typeof ih !== 'number' || !(ih > 0)) return; // not measured yet: YouTube's frame only measures it
    const prev = previousCount(el);
    const idx = currentIndex(el, sc);
    if (prev === null || idx === null) return;
    if (Math.round((sc.scrollTop - 16) / ih) - prev === idx) return;
    pageWindow.__ytShortsFixEntryCorrections += 1;
    sc.scrollTop = (idx + prev) * ih + 16;
  };
  window.addEventListener('scroll', (e) => {
    if (!isShortsContainer(e) || !entryActive()) return;
    const sc = e.target;
    requestAnimationFrame(() => guardEntry(sc));
  }, { capture: true, passive: true });

  // Ends the guard once the current Short has stayed centred, with the
  // player in its slot, for a while.
  const checkEntry = () => {
    if (!entryActive()) return;
    const sc = container();
    const own = document.querySelector('#reel-overlay-container')?.closest(SLOT);
    const idx = sc && currentIndex(pageView(shortsEl()), sc);
    if (idx === null || !own || own.id !== String(idx) || centredSlot(sc) !== own) { entryCentredSince = 0; return; }
    const now = performance.now();
    if (!entryCentredSince) entryCentredSince = now;
    else if (now - entryCentredSince >= ENTRY_SETTLED_MS) entryStart = 0;
  };

  // ---- Fallback watchdog -------------------------------------------------
  let mismatchSince = 0;
  window.addEventListener('scroll', (e) => {
    if (isShortsContainer(e)) lastScroll = performance.now();
  }, { capture: true, passive: true });

  // Returns {visible, own} slots, or null when the page does not look like the
  // Shorts layout this fix understands.
  const slots = () => {
    const sc = container();
    if (!sc) return null;
    const own = document.querySelector('#reel-overlay-container')?.closest(SLOT);
    if (!own || !sc.contains(own)) return null;
    const visible = centredSlot(sc);
    return visible ? { visible, own } : null;
  };

  // Only correct towards the slot that really holds the URL's Short. During a
  // normal move YouTube can scroll to the new Short a moment before it moves
  // the player out of the old slot; scrolling back to the old slot then would
  // make YouTube navigate back to the old Short.
  const safeTarget = (s) => {
    const urlId = urlVideoId();
    if (!urlId) return false;
    const ownId = slotVideoId(s.own);
    if (ownId ? ownId !== urlId : playerVideoId() !== urlId) return false;
    return slotVideoId(s.visible) !== urlId;
  };

  const check = () => {
    checkEntry();
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
