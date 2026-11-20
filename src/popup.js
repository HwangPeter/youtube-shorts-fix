// Settings popup (also the add-on's options page): the refresh threshold.
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
  Object.assign(slider, { min: core.MIN_THRESHOLD, max: core.MAX_THRESHOLD, step: core.STEP });

  const show = ({ enabled: on, threshold }) => {
    enabled.checked = on;
    slider.value = threshold;
    slider.disabled = !on;
    value.textContent = on ? String(threshold) : 'Off';
    document.body.classList.toggle('off', !on);
    hint.textContent = on
      ? `After ${threshold} videos, the next video opens in a fresh page. YouTube's memory use grows with every video until the page is reloaded.`
      : 'YouTube is never reloaded.';
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
})();
