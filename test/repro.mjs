// Visible-browser Firefox reproduction test for the Shorts wrong-video bug.
//
//   node test/repro.mjs [--mode extension|none|fallback|userscript] [--out DIR]
//   env: SHORTS_STEPS (default 13), SHORTS_FULLSCREEN=0, SHORTS_TRACE=1,
//        FF_BIDI_PORT (default 9557), FIREFOX_BIN, SHORTS_CHANNEL
//
//   --mode extension  load dist/extension (default; expected to PASS)
//   --mode none       no add-on (expected to FAIL: this is the bug)
//   --mode fallback   load dist/test-fallback-only, i.e. the primary fix off
//                     and only the watchdog on (expected to PASS)
//   --mode userscript load dist/test-userscript-isolated: the built
//                     dist/shorts-fix.user.js run as a Firefox isolated-world
//                     content script, the way a userscript manager runs it when
//                     YouTube's CSP blocks page injection (expected to PASS)
//
// Every run uses a brand-new throwaway Firefox profile (deleted afterwards),
// muted with media.volume_scale=0.0, in a normal visible window, driven over
// WebDriver BiDi on a dedicated port. It never touches an existing profile.
// Under WSL it drives the Windows Firefox; set FIREFOX_BIN to override.
//
// Scenario (from the investigation): channel Shorts grid, open Short A, run
// YouTube's fullscreen-change handler (re-arms the faulty branch, as any
// fullscreen toggle does), Back, open Short B, then 13 x ArrowDown and
// 13 x ArrowUp. After each step settles it asserts that the slot centred in
// #shorts-container is the slot holding the player (#reel-overlay-container),
// that the player's video is the URL's video, and that each key press moved
// the view exactly one slot.
// Exit code 0 = all checks passed, 1 = a check failed, 2 = harness error.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const MODE = opt('mode', 'extension');
const OUT = opt('out', null);
const PORT = Number(process.env.FF_BIDI_PORT || 9557);
const CHANNEL = process.env.SHORTS_CHANNEL || 'https://www.youtube.com/@MrBeast/shorts';
const STEPS = Number(process.env.SHORTS_STEPS || 13);
const TRACE = process.env.SHORTS_TRACE === '1'; // log the open-B phase every ~150 ms
const FULLSCREEN = process.env.SHORTS_FULLSCREEN !== '0'; // set 0 to skip the re-arm step on A
if (!['extension', 'none', 'fallback', 'userscript'].includes(MODE)) { console.error('bad --mode'); process.exit(2); }
if (PORT === 9333) { console.error('port 9333 is reserved'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIN_FF = '/mnt/c/Program Files/Mozilla Firefox/firefox.exe';
const isWsl = !process.env.FIREFOX_BIN && fs.existsSync(WIN_FF);
const FIREFOX = process.env.FIREFOX_BIN || (isWsl ? WIN_FF : 'firefox');
const toFf = (p) => (isWsl ? execFileSync('wslpath', ['-w', p]).toString().trim() : p);
const tmpBase = isWsl
  ? execFileSync('wslpath', ['-u', execFileSync('cmd.exe', ['/c', 'echo %TEMP%'], { cwd: '/mnt/c' }).toString().trim()]).toString().trim()
  : os.tmpdir();

const runDir = fs.mkdtempSync(path.join(tmpBase, 'shorts-fix-test-'));
const profile = path.join(runDir, 'profile');
fs.mkdirSync(profile);
fs.writeFileSync(path.join(profile, 'user.js'), [
  ['media.volume_scale', '"0.0"'],
  ['browser.shell.checkDefaultBrowser', 'false'],
  ['browser.aboutwelcome.enabled', 'false'],
  ['browser.startup.homepage_override.mstone', '"ignore"'],
  ['datareporting.policy.dataSubmissionEnabled', 'false'],
  ['toolkit.telemetry.reportingpolicy.firstRun', 'false'],
  ['app.update.disabledForTesting', 'true'],
  ['browser.tabs.warnOnClose', 'false'],
].map(([k, v]) => `user_pref("${k}", ${v});`).join('\n') + '\n');

const log = [];
const say = (...a) => { const line = a.join(' '); log.push(line); console.log(line); };

const SNAP = () => {
  const urlId = (location.pathname.match(/shorts\/([^/?]+)/) || [])[1] || null;
  const mp = document.querySelector('#shorts-player');
  let playerId = null;
  try { playerId = mp.getVideoData().video_id || null; } catch (e) {}
  const sc = document.querySelector('ytd-shorts #shorts-container');
  const slots = sc ? [...sc.querySelectorAll('.reel-video-in-sequence-new')] : [];
  const own = document.querySelector('#reel-overlay-container')?.closest('.reel-video-in-sequence-new');
  let vis = -1;
  if (sc) {
    const b = sc.getBoundingClientRect();
    const mid = b.top + b.height / 2;
    vis = slots.findIndex((s) => { const r = s.getBoundingClientRect(); return r.top <= mid && r.bottom >= mid; });
  }
  const thumb = (s) => ((s?.querySelector('.reel-video-in-sequence-thumbnail') || s)?.getAttribute('style') || '').match(/vi\/([^/]+)\//)?.[1] || null;
  return {
    urlId, playerId, visSlot: vis, playerSlot: own ? slots.indexOf(own) : -1,
    visSlotId: vis >= 0 ? slots[vis].id : null, visThumb: vis >= 0 ? thumb(slots[vis]) : null,
    scrollTop: sc ? Math.round(sc.scrollTop) : null, fixLoaded: !!window.__ytShortsFixLoaded,
    armed: document.querySelector('ytd-shorts')?.shouldUpdateItemHeight ?? null,
    corrections: window.__ytShortsFixCorrections ?? null,
    nSlots: slots.length,
    playerState: (() => { try { return mp.getPlayerState(); } catch (e) { return null; } })(),
    focus: document.activeElement ? document.activeElement.tagName.toLowerCase() + (document.activeElement.id ? '#' + document.activeElement.id : '') : null,
  };
};

let failures = 0;
let checks = 0;
// expectStep: +1 / -1 means the visible slot must have moved exactly one slot
// from the previous check (a skipped or stuck Short is a failure too).
let prevVis = null;
async function check(page, label, expectStep = null) {
  const s = await page.evaluate(SNAP);
  checks++;
  const stepOk = expectStep === null || prevVis === null || s.visSlot - prevVis === expectStep;
  prevVis = s.visSlot;
  const ok = stepOk && s.visSlot >= 0 && s.visSlot === s.playerSlot && s.urlId && s.urlId === s.playerId;
  if (!ok) failures++;
  say(`${ok ? 'PASS' : 'FAIL'} ${label.padEnd(12)} ${JSON.stringify(s)}${stepOk ? '' : ' (expected a one-slot move)'}`);
  if (!ok && OUT) await page.screenshot({ path: path.join(OUT, `${MODE}-fail-${checks}.png`) }).catch(() => {});
  return s;
}

let browser;
let ff;
let exitCode = 2;
try {
  if (OUT) fs.mkdirSync(OUT, { recursive: true });
  say(`mode=${MODE} firefox=${FIREFOX} profile=${toFf(profile)} port=${PORT}`);
  ff = spawn(FIREFOX, ['-no-remote', '-new-instance', '-profile', toFf(profile), '--remote-debugging-port', String(PORT), 'about:blank'],
    { stdio: 'ignore', detached: false });
  for (let i = 0; i < 60 && !browser; i++) {
    await sleep(1000);
    browser = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${PORT}/session`, protocol: 'webDriverBiDi', defaultViewport: null }).catch(() => null);
  }
  if (!browser) throw new Error('could not connect to Firefox over BiDi');
  say('firefox', await browser.version());

  if (MODE !== 'none') {
    const dir = { extension: 'extension', fallback: 'test-fallback-only', userscript: 'test-userscript-isolated' }[MODE];
    const src = path.join(root, 'dist', dir);
    if (!fs.existsSync(path.join(src, 'manifest.json'))) throw new Error(`missing ${src}; run npm run build`);
    const ext = path.join(runDir, 'extension');
    fs.cpSync(src, ext, { recursive: true });
    say('installed temporary add-on', await browser.installExtension(toFf(ext)));
  }

  const page = (await browser.pages())[0];
  await page.goto(CHANNEL, { waitUntil: 'load' });
  await sleep(5000);
  const click = (i) => page.evaluate((i) => {
    const vis = [...document.querySelectorAll('a[href*="/shorts/"]')].filter((a) => a.offsetParent);
    const hrefs = [...new Set(vis.map((a) => a.getAttribute('href')).filter((h) => /\/shorts\/[^/?&]+/.test(h)))];
    const a = vis.find((a) => a.getAttribute('href') === hrefs[i]);
    a.scrollIntoView({ block: 'center' });
    a.click();
    return hrefs[i];
  }, i);

  say('open A', await click(0));
  await sleep(4000);
  await check(page, 'A open');
  if (FULLSCREEN) {
    // Run YouTube's own fullscreen-change handler on A, which is what a real
    // fullscreen toggle does (automation cannot enter fullscreen without a
    // user gesture). It re-arms the faulty re-align branch, so the bug fires
    // reliably on open B; without this it fires on most, but not all, fresh
    // page loads, depending on whether the branch already ran harmlessly on A.
    say('fullscreen-change handler', await page.evaluate(() => {
      const el = document.querySelector('ytd-shorts');
      if (!el || typeof el.onFullscreenChange !== 'function') return 'missing';
      el.onFullscreenChange();
      return 'ran';
    }));
    await sleep(1000);
    await check(page, 'A re-armed');
  }
  await page.goBack();
  await sleep(4500);
  say('open B', await click(1));
  if (TRACE) {
    // Optional time-resolved trace of the open-B phase, for debugging.
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
      const x = await page.evaluate(SNAP);
      say(`  trace +${String(Date.now() - t0).padStart(4)}ms url=${x.urlId} vis=${x.visSlot} player=${x.playerSlot} top=${x.scrollTop} corr=${x.corrections} armed=${x.armed}`);
      await sleep(150);
    }
  } else await sleep(4000);
  const b = await check(page, 'B open');
  if (OUT) await page.screenshot({ path: path.join(OUT, `${MODE}-B-open.png`) }).catch(() => {});
  if (MODE !== 'none' && !b.fixLoaded) throw new Error('add-on script did not load in the page');

  for (let k = 1; k <= STEPS; k++) {
    await page.keyboard.press('ArrowDown');
    await sleep(2500);
    await check(page, `down ${k}`, +1);
  }
  for (let k = 1; k <= STEPS; k++) {
    await page.keyboard.press('ArrowUp');
    await sleep(2500);
    await check(page, `up ${k}`, -1);
  }
  say(`RESULT mode=${MODE}: ${checks - failures}/${checks} checks passed`);
  exitCode = failures ? 1 : 0;
} catch (e) {
  say('HARNESS ERROR', e?.stack || String(e));
  exitCode = 2;
} finally {
  if (OUT) fs.writeFileSync(path.join(OUT, `${MODE}.log`), log.join('\n') + '\n');
  if (browser) await browser.close().catch(() => {});
  await sleep(2000);
  if (ff && ff.exitCode === null) ff.kill();
  await sleep(1000);
  fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
}
process.exit(exitCode);
