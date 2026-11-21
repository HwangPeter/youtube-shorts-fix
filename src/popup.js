// Settings popup (also the add-on's options page): the refresh threshold, and
// a button that starts a fresh session in the active YouTube tab at once.
// Changes are saved to extension storage as they are made; open YouTube tabs
// pick them up at once (see createSettingsStore in refresh-core.js).
(() => {
  'use strict';
  const core = globalThis.YtRefreshCore;
  const api = globalThis.browser || globalThis.chrome;
  const local = api.storage.local;
  const enabled = document.getElementById('enabled');
  const slider = document.getElementById('threshold');
  const value = document.getElementById('value');
  const hint = document.getElementById('hint');
  const refreshNow = document.getElementById('refresh-now');
  const refreshNote = document.getElementById('refresh-note');
  Object.assign(slider, { min: core.MIN_THRESHOLD, max: core.MAX_THRESHOLD, step: core.STEP });

  const show = ({ enabled: on, threshold }) => {
    enabled.checked = on;
    slider.value = threshold;
    slider.disabled = !on;
    value.textContent = on ? String(threshold) : 'Off';
    document.body.classList.toggle('off', !on);
    hint.textContent = core.hintText({ enabled: on, threshold });
  };
  const current = () => ({ enabled: enabled.checked, threshold: Number(slider.value) });
  const save = () => {
    const s = core.normalizeSettings({ [core.KEYS.enabled]: current().enabled, [core.KEYS.threshold]: current().threshold });
    show(s);
    local.set({ [core.KEYS.enabled]: s.enabled, [core.KEYS.threshold]: s.threshold });
  };

  show(core.normalizeSettings({}));
  Promise.resolve(local.get([core.KEYS.enabled, core.KEYS.threshold]))
    .then((got) => show(core.normalizeSettings(got)));
  slider.addEventListener('input', save);
  enabled.addEventListener('change', save);

  // "Start fresh session now": only for an active tab that runs the add-on's
  // content script, which answers a ping. Other tabs (and the options page in
  // about:addons) have no listener, so sendMessage rejects there.
  let tabId = null;
  const noTab = () => {
    tabId = null;
    refreshNow.disabled = true;
    refreshNote.hidden = false;
    refreshNote.textContent = 'Open a YouTube tab to start a fresh session.';
  };
  refreshNow.disabled = true;
  Promise.resolve(api.tabs?.query({ active: true, currentWindow: true }))
    .then(async (tabs) => {
      const id = tabs?.[0]?.id;
      if (id === undefined) return noTab();
      await api.tabs.sendMessage(id, { type: core.MESSAGES.ping });
      tabId = id;
      refreshNow.disabled = false;
      refreshNote.hidden = true;
    })
    .catch(noTab);
  refreshNow.addEventListener('click', () => {
    if (tabId === null) return;
    refreshNow.disabled = true;
    Promise.resolve(api.tabs.sendMessage(tabId, { type: core.MESSAGES.refreshNow }))
      .then(() => globalThis.close?.(), noTab);
  });
})();
