// Tests for the "Start fresh session now" button: the popup (src/popup.js)
// and the content script's side (src/refresh.js), each run in a vm context
// with fake DOM and extension APIs.
//   node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, 'src', f), 'utf8');
const flush = () => new Promise((r) => setTimeout(r, 0));

// A fake element: enough of the DOM for popup.js.
const element = (id) => {
  const listeners = {};
  return {
    id, value: '', checked: false, disabled: false, hidden: false, textContent: '',
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    fire: async (type) => { for (const fn of listeners[type] || []) await fn({ type }); },
  };
};

// Runs popup.html's scripts against fake elements and a fake browser API.
// youtubeTab: whether the active tab runs the add-on's content script (it
// answers the ping); otherwise sendMessage rejects, as it does for tabs
// without a listener.
const openPopup = async ({ youtubeTab = true, stored = {} } = {}) => {
  const html = read('popup.html');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const els = Object.fromEntries(ids.map((id) => [id, element(id)]));
  const sent = [];
  const api = {
    storage: { local: { get: async () => ({ ...stored }), set: async () => {} } },
    tabs: {
      query: async (q) => { assert.deepEqual({ ...q }, { active: true, currentWindow: true }); return [{ id: 7 }]; },
      sendMessage: async (tabId, msg) => {
        sent.push({ tabId, msg: { ...msg } });
        if (!youtubeTab) throw new Error('Could not establish connection. Receiving end does not exist.');
        return { ok: true };
      },
    },
  };
  const ctx = {
    URL, Promise, console,
    browser: api,
    document: {
      getElementById: (id) => els[id] || null,
      body: { classList: { toggle: () => {} } },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(read('refresh-core.js'), ctx);
  vm.runInContext(read('popup.js'), ctx);
  await flush();
  await flush();
  return { els, sent, ctx };
};

test('popup: says the next video opens in a fresh session', async () => {
  const { els } = await openPopup({ stored: { refreshThreshold: 25 } });
  assert.equal(els.hint.textContent,
    "After 25 videos, the next video opens in a fresh session. YouTube's memory use grows with every video until the page is reloaded.");
  assert.doesNotMatch(els.hint.textContent, /fresh page/);
});

test('popup: has a "Start fresh session now" button that asks the YouTube tab to reload now', async () => {
  const { els, sent, ctx } = await openPopup();
  const btn = els['refresh-now'];
  assert.ok(btn, 'popup.html has a #refresh-now button');
  assert.match(read('popup.html'), /<button[^>]*id="refresh-now"[^>]*>Start fresh session now<\/button>/);
  assert.equal(btn.disabled, false);
  assert.equal(els['refresh-note'].hidden, true);
  sent.length = 0;
  await btn.fire('click');
  await flush();
  assert.deepEqual(sent, [{ tabId: 7, msg: { type: ctx.YtRefreshCore.MESSAGES.refreshNow } }]);
});

test('popup: button disabled with a note when the active tab is not YouTube', async () => {
  const { els, sent } = await openPopup({ youtubeTab: false });
  const btn = els['refresh-now'];
  assert.equal(btn.disabled, true);
  assert.equal(els['refresh-note'].hidden, false);
  assert.match(els['refresh-note'].textContent, /YouTube tab/);
  sent.length = 0;
  await btn.fire('click');
  await flush();
  assert.deepEqual(sent, []);
});

// Runs refresh.js (after refresh-core.js) in a fake YouTube page.
const loadContentScript = (href) => {
  let onMessage;
  const docListeners = {};
  const location = {
    href,
    replaced: [],
    replace(url) { this.replaced.push(url); },
  };
  const video = { currentTime: 0 };
  const ctx = {
    URL, Promise, console: { info: () => {}, log: () => {} },
    location,
    setInterval: () => 0,
    setTimeout: (fn) => { ctx.timers.push(fn); return ctx.timers.length; },
    clearTimeout: () => {},
    timers: [],
    window: { addEventListener: () => {} },
    document: {
      hidden: false, fullscreenElement: null, activeElement: null,
      addEventListener: (type, fn) => { (docListeners[type] ||= []).push(fn); },
      querySelector: (sel) => {
        if (sel === 'ytd-watch-flexy') return { getAttribute: () => new URL(location.href).searchParams.get('v') };
        if (sel === '#movie_player.ad-showing') return null;
        if (sel.includes('video')) return video;
        return null;
      },
    },
    browser: {
      storage: {
        local: { get: async () => ({ refreshThreshold: 40 }) },
        onChanged: { addListener: () => {} },
      },
      runtime: { onMessage: { addListener: (fn) => { onMessage = fn; } } },
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('refresh-core.js'), ctx);
  vm.runInContext(read('refresh.js'), ctx);
  const navigate = (to) => {
    location.href = to;
    for (const fn of docListeners['yt-navigate-finish'] || []) fn();
  };
  // The listener's reply (through sendResponse), or undefined if none.
  const send = (msg) => { let reply; onMessage(msg, {}, (r) => { reply = r; }); return reply; };
  return { ctx, location, video, navigate, send };
};

test('content script: the refresh-now message reloads the current video at once and resets the count', async () => {
  const W = (id) => `https://www.youtube.com/watch?v=${id}`;
  const { ctx, location, video, navigate, send } = loadContentScript(W('a'));
  await flush();
  navigate(W('b'));
  navigate(W('c'));
  video.currentTime = 95.5;
  const reply = send({ type: ctx.YtRefreshCore.MESSAGES.refreshNow });
  assert.deepEqual({ ...reply }, { ok: true });
  assert.deepEqual(location.replaced, ['https://www.youtube.com/watch?v=c&t=95s']); // no 1 s wait
});

test('content script: answers the popup\'s ping and ignores other messages', async () => {
  const { ctx, location, send } = loadContentScript('https://www.youtube.com/');
  await flush();
  assert.deepEqual({ ...send({ type: ctx.YtRefreshCore.MESSAGES.ping }) }, { ok: true });
  assert.equal(send({ type: 'something-else' }), undefined);
  assert.deepEqual(location.replaced, []);
});
