// Refresh-after-N-videos: the logic, with no DOM or browser access, shared by
// the content script (src/refresh.js), the settings popup (src/popup.js) and
// the unit tests (test/refresh-core.test.mjs). A plain script: it defines one
// global, YtRefreshCore.
//
// Why: a long YouTube session grows the tab's memory by roughly 80 MB per
// video watched (YouTube's single-page app keeps state from every video), and
// only a real page load releases it. So after a set number of distinct videos
// the add-on loads the current video again in a fresh page.
//
// When: on the navigation to the first new video after the count reaches the
// threshold, so the reload lands between videos. If that moment is unsafe
// (typing in a box, tab hidden, fullscreen), it waits for the next new video.
// Fullscreen only defers up to 1.5 x the threshold, so a long fullscreen
// session still gets its memory back.
var YtRefreshCore = (() => {
  'use strict';
  const DEFAULT_THRESHOLD = 40;
  const MIN_THRESHOLD = 10;
  const MAX_THRESHOLD = 100;
  const STEP = 5;
  const FULLSCREEN_GRACE = 1.5;
  const KEYS = { enabled: 'refreshEnabled', threshold: 'refreshThreshold' };
  // Messages from the popup to the content script in the active tab.
  const MESSAGES = { ping: 'ytRefreshPing', refreshNow: 'ytRefreshNow' };

  // The video id in a /watch?v=<id> or /shorts/<id> URL, else null.
  const videoIdFromUrl = (href) => {
    let u;
    try { u = new URL(href); } catch (e) { return null; }
    if (u.pathname === '/watch') return u.searchParams.get('v') || null;
    return u.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1] || null;
  };

  // The URL to load: the same URL, with t=<seconds>s on /watch pages when the
  // player is at least 1 s in, so playback resumes where it was.
  const buildRefreshUrl = (href, currentTime) => {
    const u = new URL(href);
    if (u.pathname === '/watch' && Number.isFinite(currentTime) && currentTime >= 1) {
      u.searchParams.set('t', `${Math.floor(currentTime)}s`);
    }
    return u.toString();
  };

  const normalizeSettings = (raw) => {
    const r = raw || {};
    let t = Number(r[KEYS.threshold]);
    if (!Number.isFinite(t)) t = DEFAULT_THRESHOLD;
    t = Math.round(t / STEP) * STEP;
    t = Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, t));
    return { enabled: r[KEYS.enabled] !== false, threshold: t };
  };

  // The popup's explanation of the setting.
  const hintText = ({ enabled, threshold }) => (enabled
    ? `After ${threshold} videos, the next video opens in a fresh session. YouTube's memory use grows with every video until the page is reloaded.`
    : 'YouTube is never reloaded.');

  // Current settings from extension storage, kept up to date as the popup
  // changes them. api: the browser/chrome extension namespace, or undefined.
  const createSettingsStore = (api) => {
    const raw = {};
    let settings = normalizeSettings(raw);
    const local = api?.storage?.local;
    const ready = local
      ? Promise.resolve(local.get([KEYS.enabled, KEYS.threshold]))
        .then((got) => { Object.assign(raw, got); settings = normalizeSettings(raw); })
        .catch(() => {})
      : Promise.resolve();
    api?.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'local') return;
      for (const k of Object.values(KEYS)) if (k in changes) raw[k] = changes[k].newValue;
      settings = normalizeSettings(raw);
    });
    return { get: () => settings, ready };
  };

  // env: getSettings() -> {enabled, threshold}; isUnsafe() -> null or
  // 'typing' | 'hidden' | 'fullscreen'; getCurrentTime() -> seconds;
  // refresh(url, { now }) loads url in a fresh page; now: at once, with no
  // wait for the video to settle.
  // onUrl(href) returns 'ignored' (not a video), 'seen', 'counted',
  // 'deferred' or 'refreshed'.
  // refreshNow(href) is the popup's "Start fresh session now": it reloads
  // href at once, whatever the count, setting or safety checks, and starts
  // the count again.
  const createRefresher = (env) => {
    let seen = new Set();
    const onUrl = (href) => {
      const id = videoIdFromUrl(href);
      if (!id) return 'ignored';
      if (seen.has(id)) return 'seen';
      seen.add(id);
      const { enabled, threshold } = env.getSettings();
      if (!enabled || seen.size <= threshold) return 'counted';
      const unsafe = env.isUnsafe();
      if (unsafe && !(unsafe === 'fullscreen' && seen.size > threshold * FULLSCREEN_GRACE)) return 'deferred';
      const url = buildRefreshUrl(href, env.getCurrentTime());
      seen = new Set();
      env.refresh(url);
      return 'refreshed';
    };
    const refreshNow = (href) => {
      const url = buildRefreshUrl(href, videoIdFromUrl(href) ? env.getCurrentTime() : 0);
      seen = new Set();
      env.refresh(url, { now: true });
      return 'refreshed';
    };
    return { onUrl, refreshNow, count: () => seen.size };
  };

  return {
    DEFAULT_THRESHOLD, MIN_THRESHOLD, MAX_THRESHOLD, STEP, KEYS, MESSAGES,
    videoIdFromUrl, buildRefreshUrl, normalizeSettings, hintText, createSettingsStore, createRefresher,
  };
})();
