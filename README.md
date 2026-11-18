# Shorts Wrong-Video Fix

A small private Firefox add-on, also built as a userscript, that fixes YouTube Shorts showing the wrong video. Normal Shorts scrolling is unchanged.

## What it fixes

You open a Short from a channel's Shorts grid, press Back, then open a different Short. The address bar, the player and the audio are all on the new Short (B). The screen stays on a still frame of the previous Short (A), with no title or buttons. B is playing off-screen, one slot below. Pressing Down then skips B.

- **Firefox:** breaks as soon as the second Short opens.
- **Chrome:** breaks on the first Down key after that.

### Cause

This is a bug in YouTube's Shorts code, not in Firefox. YouTube has a one-time "re-align after fullscreen/resize" scroll correction, gated by the `shouldUpdateItemHeight` property of the `<ytd-shorts>` element. It writes:

```js
scrollTop = index * itemHeight + 16
```

That formula ignores the "previous" Shorts YouTube inserts above the current one when you re-enter Shorts. So the correction scrolls one or more slots too high, onto a slot that only holds a thumbnail.

The investigation report has the evidence: `firstmate/data/yt-shorts-wrong-video/report.md`.

## How it works

The script is a single file, `src/shorts-fix.js`. It runs in the page's own JavaScript context on `youtube.com`.

1. **Primary fix: prevents the bug.** It keeps `<ytd-shorts>.shouldUpdateItemHeight` false, so the faulty branch never runs.
   - The faulty branch only runs in an animation frame queued by YouTube's scroll listener on `#shorts-container`.
   - The script clears the flag in a capture-phase `scroll` listener, which runs before YouTube's listener.
   - It clears the flag again after `fullscreenchange`, where YouTube re-arms it, and on `yt-navigate-finish`.
   - YouTube's separate resize handler still re-aligns the view, and does it correctly.
2. **Fallback watchdog: repairs the view if a YouTube update gets past the primary fix.**
   - Every 250 ms on `/shorts/` pages, it compares two slots: the slot centred in `#shorts-container`, and the slot holding the player (`#reel-overlay-container`).
   - It acts only when all of these hold:
     - The two slots have differed for 600 ms.
     - There has been no wheel, key, touch or pointer input for 800 ms.
     - There has been no scroll for 400 ms.
     - The page is not in fullscreen.
     - The player's slot holds the Short named in the URL (checked by its thumbnail's video id).
   - It then scrolls the player's slot back into view. It never touches the player.
   - **Why the URL check matters:** during a normal move, YouTube can scroll to the new Short a moment before it moves the player out of the old slot. Scrolling back to the old slot would make YouTube navigate back to the old Short.
3. **Guardrails.**
   - Every YouTube property and selector is feature-detected. If anything is missing, the script does nothing.
   - It changes only the one flag and the Shorts container's scroll position.
   - It sets two properties on the page's `window`:
     - `__ytShortsFixLoaded` makes it run only once when both the add-on and the userscript are installed.
     - `__ytShortsFixCorrections` counts watchdog corrections. You can read it in the console to see whether the watchdog has acted.

### Privacy and permissions

- No network requests, storage, messaging, analytics or data collection.
- The manifest asks for no permissions. Its only host access is the content-script match for `https://www.youtube.com/*` and `https://m.youtube.com/*`.
- The manifest declares `data_collection_permissions: none`.

## Layout

```
src/shorts-fix.js          the only source of the fix
extension/manifest.json    MV3 manifest (Firefox 140+; also valid MV3 for Chrome)
scripts/build.mjs          builds dist/extension, dist/shorts-fix.user.js and the two test-only builds
test/repro.mjs             visible-browser Firefox reproduction test
test/proof.mjs             runs every test mode and checks each gives the expected result
```

Build with `npm install && npm run build` (Node 18+). The built files go in `dist/`, which is not committed.

## Install privately (for the captain)

Firefox release builds only install signed add-ons permanently. There are three private options. Nothing here publishes the add-on or lists it anywhere.

### Option A: userscript in Violentmonkey (simplest, no account, recommended to start)

1. In Firefox, install Violentmonkey from its add-ons page: https://addons.mozilla.org/firefox/addon/violentmonkey/
2. Build the userscript: `npm install && npm run build`. This writes `dist/shorts-fix.user.js`.
3. Click the Violentmonkey toolbar icon, open the Dashboard, click **+**, then **New**.
4. Replace the editor contents with the whole of `dist/shorts-fix.user.js`.
5. Press **Ctrl+S**, then close the editor.
   - From Windows, the file is at `\\wsl.localhost\<distro>\...\dist\shorts-fix.user.js`, or copy it somewhere first.
6. Reload any open YouTube tab.

This lasts across restarts and needs no account. To update, repeat steps 2 to 5.

### Option B: the real add-on, signed as "unlisted" by Mozilla (persistent, needs your own AMO account)

Unlisted signing gives you a signed `.xpi` that only you have. It is not listed or searchable on addons.mozilla.org (AMO). Signing is automated and usually takes a few minutes.

1. Sign in to https://addons.mozilla.org with your Firefox account.
2. Create API credentials at https://addons.mozilla.org/developers/addon/api/key/
3. Build and sign:
   ```sh
   npm install && npm run build
   npx --yes web-ext@8 sign --source-dir dist/extension --channel unlisted \
     --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET" --artifacts-dir dist
   ```
4. In Firefox, open `about:addons`, click the gear icon, choose **Install Add-on From File…**, and pick the signed `.xpi` in `dist/`.

Before each re-sign, bump `version` in both `extension/manifest.json` and `package.json`. The build refuses to run if they differ.

Keep the userscript or the add-on, not both. If both are installed, the marker property makes the second copy do nothing.

### Option C: try it for one session (no signing)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `dist/extension/manifest.json`.

It is removed when Firefox restarts. Firefox Developer Edition, Nightly and ESR can also install unsigned builds permanently if you set `xpinstall.signatures.required=false`. Release Firefox ignores that pref.

## How to verify

### Manually

1. Open https://www.youtube.com/@MrBeast/shorts (any channel's Shorts tab works).
2. Click the first Short, press Back, then click the second Short.
   - **Without the fix:** on most fresh page loads, Firefox shows the first Short's still image while the second one plays. Toggling fullscreen on the first Short before pressing Back makes it happen every time.
   - **With the fix:** the second Short is on screen, with its title and buttons.
3. Press Down and Up a few times. Each press moves exactly one Short.

### Automated

The test opens a new, visible Firefox window with a fresh throwaway profile, which it deletes afterwards. Audio is muted with `media.volume_scale=0.0`. It is driven over WebDriver BiDi on port 9557 (`FF_BIDI_PORT` overrides this). Under WSL it uses the Windows Firefox. Set `FIREFOX_BIN` to use another Firefox.

It performs the repro, then 13 × Down and 13 × Up.

On Short A, before pressing Back, it calls YouTube's own `ytd-shorts.onFullscreenChange()`. A real fullscreen toggle runs the same handler, and automation cannot enter fullscreen without a user gesture. This re-arms the faulty branch.
- **Why:** without this step the bug fired on most fresh page loads, but not all. Whether it fires depends on whether the one-shot branch already ran harmlessly while A was open.
- **Effect:** the test reproduces the bug every time without the fix.
- **Side benefit:** it also covers the fix's handling of a fullscreen re-arm.
- **To skip it:** set `SHORTS_FULLSCREEN=0`.

After each step it checks three things:
- The centred slot is the player's slot.
- The player's video is the URL's video.
- The view moved exactly one slot.

```sh
npm run test:repro                    # with the add-on: expect all checks to pass
node test/repro.mjs --mode none       # no add-on: expect FAIL (exit 1), which is the bug
node test/repro.mjs --mode fallback   # watchdog only, primary fix off: expect pass
node test/repro.mjs --mode userscript # the userscript build: expect pass
npm run test:proof -- --repeat 2      # all four modes, checked against the expected results
```

`--mode userscript` runs the built `dist/shorts-fix.user.js` as a Firefox isolated-world content script. That is how a userscript manager runs it when YouTube's strict Content-Security-Policy blocks injecting it into the page. In page mode it behaves the same as the add-on, which `--mode extension` tests.

The full Violentmonkey install could not be automated, because WebDriver BiDi does not allow opening extension pages. After installing with Option A, confirm it by hand with the manual check above.

## Known limits

- **Browsers:** tested in Firefox 160 on Windows, logged out, on one channel's Shorts grid (MrBeast). Not tested in Chrome, signed in, or on mobile (`m.youtube.com`).
- **Real fullscreen:** a real fullscreen toggle was not exercised; the test calls YouTube's fullscreen handler instead.
  - The primary fix turns off YouTube's one-time re-align after fullscreen.
  - YouTube's resize handler still re-aligns the view after a size change, and the watchdog catches a wrong slot.
  - Watch for a view that is a few pixels off after leaving fullscreen.
- **Violentmonkey:** the install path itself was not automated; see "How to verify".
- **Occasional ignored Up key in testing:** during development, in 4 of about 22 test runs with a fix build, one Up press after the 13th Down did not move the view. The view and the player stayed matched, so this was not the wrong-video bug.
  - In those runs the watchdog made no correction, and no mechanism linking it to the fix was found.
  - It did not recur in the 12 runs after that: 3 with diagnostics plus the final 9 with a fix build.
  - If you ever see a key press ignored with the add-on but never without it, report it.
- **YouTube changes:** YouTube changes its front end often. If it renames the flag, the selectors or the slot layout, the script stops doing anything rather than breaking the page. The automated test will show that as the bug returning.

## Packaging for a later public release

1. Choose a license (see `LICENSE`) and add the `LICENSE` text.
2. Bump the version in `extension/manifest.json` and `package.json`.
3. `npm run package` builds a `.zip` in `dist/` (named from the add-on name and version) with `web-ext build`. Run `npx web-ext lint --source-dir dist/extension` first.
4. Firefox: submit the zip on AMO as a listed add-on, or run `web-ext sign --channel listed`.
   - The extension ID (`browser_specific_settings.gecko.id`) is permanent once used for signing. Change it before the first signing if you want a different one.
   - AMO may ask for the source. `src/` plus `scripts/build.mjs` is enough, because the build is a plain copy with no minification.
5. Chrome Web Store (optional): the same `dist/extension` is a valid MV3 extension. Chrome warns about, and ignores, `browser_specific_settings`. It has not been tested in Chrome.
6. Userscript: `dist/shorts-fix.user.js` can be posted to Greasy Fork or a GitHub release.
