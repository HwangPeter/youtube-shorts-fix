// Unit tests for the refresh-after-N-videos logic in src/refresh-core.js.
//   node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// refresh-core.js is a plain script (content scripts and the popup load it as
// such), so evaluate it in a fresh context and read the global it defines.
const loadCore = () => {
  const ctx = { URL };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'src/refresh-core.js'), 'utf8'), ctx);
  return ctx.YtRefreshCore;
};
const core = loadCore();
// Objects made in the vm context have its prototypes; compare them as plain data.
const plain = (o) => JSON.parse(JSON.stringify(o));

const W = (id, extra = '') => `https://www.youtube.com/watch?v=${id}${extra}`;
const S = (id) => `https://www.youtube.com/shorts/${id}`;

// A refresher wired to fakes. unsafe: what isUnsafe() returns; time: what
// the player's current time is.
const make = (settings = { enabled: true, threshold: 3 }, env = {}) => {
  const state = { refreshes: [], unsafe: null, time: 0, settings };
  const r = core.createRefresher({
    getSettings: () => state.settings,
    isUnsafe: () => state.unsafe,
    getCurrentTime: () => state.time,
    refresh: (url) => state.refreshes.push(url),
    ...env,
  });
  return { r, state };
};

test('videoIdFromUrl reads /watch?v= and /shorts/<id>', () => {
  assert.equal(core.videoIdFromUrl(W('abc123')), 'abc123');
  assert.equal(core.videoIdFromUrl(W('abc123', '&list=PL1&t=30s')), 'abc123');
  assert.equal(core.videoIdFromUrl('https://www.youtube.com/watch?list=PL1&v=xyz'), 'xyz');
  assert.equal(core.videoIdFromUrl(S('sh0rt')), 'sh0rt');
  assert.equal(core.videoIdFromUrl('https://m.youtube.com/shorts/sh0rt?feature=share'), 'sh0rt');
  assert.equal(core.videoIdFromUrl('https://www.youtube.com/'), null);
  assert.equal(core.videoIdFromUrl('https://www.youtube.com/@MrBeast/shorts'), null);
  assert.equal(core.videoIdFromUrl('https://www.youtube.com/results?search_query=v'), null);
  assert.equal(core.videoIdFromUrl('https://www.youtube.com/watch'), null);
});

test('counts each distinct video once, across both URL shapes', () => {
  const { r } = make({ enabled: true, threshold: 40 });
  assert.equal(r.onUrl(W('a')), 'counted');
  assert.equal(r.onUrl(W('a', '&t=10s')), 'seen');
  assert.equal(r.onUrl(S('b')), 'counted');
  assert.equal(r.onUrl(S('b')), 'seen');
  assert.equal(r.onUrl('https://www.youtube.com/'), 'ignored');
  assert.equal(r.onUrl(W('a')), 'seen');
  assert.equal(r.onUrl(S('c')), 'counted');
  assert.equal(r.count(), 3);
});

test('refreshes on the first new video after the threshold, not at it', () => {
  const { r, state } = make({ enabled: true, threshold: 3 });
  r.onUrl(W('a'));
  r.onUrl(S('b'));
  assert.equal(r.onUrl(W('c')), 'counted'); // 3rd video: threshold reached, keep watching
  assert.equal(r.onUrl(W('c')), 'seen');    // repeat events for the same video do nothing
  assert.deepEqual(state.refreshes, []);
  assert.equal(r.onUrl(S('d')), 'refreshed'); // lands between videos
  assert.deepEqual(state.refreshes, [S('d')]);
});

test('resets the count after a refresh', () => {
  const { r, state } = make({ enabled: true, threshold: 2 });
  for (const id of ['a', 'b', 'c']) r.onUrl(W(id));
  assert.equal(state.refreshes.length, 1);
  assert.equal(r.count(), 0);
  // the old ids count again in the new session
  assert.equal(r.onUrl(W('a')), 'counted');
  assert.equal(r.onUrl(W('b')), 'counted');
  assert.equal(r.onUrl(W('c')), 'refreshed');
  assert.equal(state.refreshes.length, 2);
});

test('preserves the current /watch timestamp with t= and keeps other params', () => {
  const { r, state } = make({ enabled: true, threshold: 1 });
  r.onUrl(W('a'));
  state.time = 83.7;
  r.onUrl(W('b', '&list=PL1&index=4'));
  assert.equal(state.refreshes.length, 1);
  const u = new URL(state.refreshes[0]);
  assert.equal(u.pathname, '/watch');
  assert.equal(u.searchParams.get('v'), 'b');
  assert.equal(u.searchParams.get('list'), 'PL1');
  assert.equal(u.searchParams.get('index'), '4');
  assert.equal(u.searchParams.get('t'), '83s');
});

test('buildRefreshUrl: replaces t, skips t under 1 s and for Shorts', () => {
  assert.equal(new URL(core.buildRefreshUrl(W('a', '&t=5s'), 120.2)).searchParams.get('t'), '120s');
  assert.equal(new URL(core.buildRefreshUrl(W('a', '&t=5s'), 0.4)).searchParams.get('t'), '5s');
  assert.equal(new URL(core.buildRefreshUrl(W('a'), 0)).searchParams.has('t'), false);
  assert.equal(new URL(core.buildRefreshUrl(W('a'), NaN)).searchParams.has('t'), false);
  assert.equal(core.buildRefreshUrl(S('b'), 42), S('b'));
});

test('defers while typing or hidden, then refreshes at the next new video', () => {
  const { r, state } = make({ enabled: true, threshold: 1 });
  r.onUrl(W('a'));
  state.unsafe = 'typing';
  assert.equal(r.onUrl(W('b')), 'deferred');
  state.unsafe = 'hidden';
  for (const id of ['c', 'd', 'e', 'f', 'g']) assert.equal(r.onUrl(W(id)), 'deferred');
  assert.deepEqual(state.refreshes, []);
  state.unsafe = null;
  assert.equal(r.onUrl(W('h')), 'refreshed');
  assert.deepEqual(state.refreshes, [W('h')]);
});

test('defers in fullscreen, but not forever', () => {
  const { r, state } = make({ enabled: true, threshold: 10 });
  for (let i = 0; i < 10; i++) r.onUrl(S('v' + i));
  state.unsafe = 'fullscreen';
  for (let i = 10; i < 15; i++) assert.equal(r.onUrl(S('v' + i)), 'deferred');
  assert.equal(r.onUrl(S('v15')), 'refreshed'); // 16 > 1.5 x 10
});

test('does not refresh when off, and the setting applies live', () => {
  const { r, state } = make({ enabled: false, threshold: 2 });
  for (const id of ['a', 'b', 'c', 'd']) assert.equal(r.onUrl(W(id)), 'counted');
  assert.deepEqual(state.refreshes, []);
  state.settings = { enabled: true, threshold: 2 }; // turned on with 4 already watched
  assert.equal(r.onUrl(W('e')), 'refreshed');
  state.settings = { enabled: true, threshold: 50 };
  for (let i = 0; i < 50; i++) r.onUrl(W('x' + i));
  assert.equal(state.refreshes.length, 1);
  state.settings = { enabled: true, threshold: 10 }; // lowered below the count
  assert.equal(r.onUrl(W('y')), 'refreshed');
});

test('normalizeSettings: defaults, range and step', () => {
  const n = core.normalizeSettings;
  assert.deepEqual(plain(n(undefined)), { enabled: true, threshold: 40 });
  assert.deepEqual(plain(n({})), { enabled: true, threshold: 40 });
  assert.deepEqual(plain(n({ refreshEnabled: false, refreshThreshold: 25 })), { enabled: false, threshold: 25 });
  assert.deepEqual(plain(n({ refreshThreshold: 3 })), { enabled: true, threshold: 10 });
  assert.deepEqual(plain(n({ refreshThreshold: 1000 })), { enabled: true, threshold: 100 });
  assert.deepEqual(plain(n({ refreshThreshold: 42 })), { enabled: true, threshold: 40 });
  assert.deepEqual(plain(n({ refreshThreshold: 'x' })), { enabled: true, threshold: 40 });
  assert.equal(core.DEFAULT_THRESHOLD, 40);
  assert.deepEqual([core.MIN_THRESHOLD, core.MAX_THRESHOLD, core.STEP], [10, 100, 5]);
});

test('settings store: reads storage, then follows changes live', async () => {
  let listener;
  const area = { refreshThreshold: 30 };
  const api = {
    storage: {
      local: { get: async () => ({ ...area }) },
      onChanged: { addListener: (fn) => { listener = fn; } },
    },
  };
  const store = core.createSettingsStore(api);
  assert.deepEqual(plain(store.get()), { enabled: true, threshold: 40 }); // default until storage answers
  await store.ready;
  assert.deepEqual(plain(store.get()), { enabled: true, threshold: 30 });
  listener({ refreshThreshold: { newValue: 15 } }, 'local');
  assert.deepEqual(plain(store.get()), { enabled: true, threshold: 15 });
  listener({ refreshEnabled: { newValue: false } }, 'local');
  assert.deepEqual(plain(store.get()), { enabled: false, threshold: 15 });
  listener({ refreshThreshold: { newValue: 90 } }, 'sync'); // other areas ignored
  assert.deepEqual(plain(store.get()), { enabled: false, threshold: 15 });
});

test('settings store: works without a storage API', () => {
  const store = core.createSettingsStore(undefined);
  assert.deepEqual(plain(store.get()), { enabled: true, threshold: 40 });
});
