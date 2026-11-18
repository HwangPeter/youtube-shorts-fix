// Builds every distributable from the single source file src/shorts-fix.js:
//   dist/extension/              unpacked WebExtension (load or package this)
//   dist/shorts-fix.user.js      userscript for Violentmonkey / Tampermonkey
//   dist/test-fallback-only/     test-only extension with the primary fix off,
//                                used to prove the fallback watchdog alone works
//   dist/test-userscript-isolated/ test-only extension that runs the built
//                                userscript in Firefox's isolated content-script
//                                world (a userscript manager's CSP fallback mode)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const src = fs.readFileSync(path.join(root, 'src/shorts-fix.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) throw new Error(`version mismatch: manifest ${manifest.version} vs package.json ${pkg.version}`);

const PRIMARY_LINE = 'const PRIMARY = true;';
if (!src.includes(PRIMARY_LINE)) throw new Error('PRIMARY switch not found in src/shorts-fix.js');

fs.rmSync(dist, { recursive: true, force: true });

function writeExtension(dir, code, nameSuffix = '', world = 'MAIN') {
  fs.mkdirSync(dir, { recursive: true });
  const m = structuredClone(manifest);
  if (nameSuffix) {
    m.name += nameSuffix;
    m.browser_specific_settings.gecko.id = m.browser_specific_settings.gecko.id.replace('@', '-test@');
  }
  if (world !== 'MAIN') m.content_scripts[0].world = world;
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'shorts-fix.js'), code);
}

writeExtension(path.join(dist, 'extension'), src);
writeExtension(path.join(dist, 'test-fallback-only'),
  src.replace(PRIMARY_LINE, 'const PRIMARY = false;'), ' (TEST: fallback only)');

const header = `// ==UserScript==
// @name         ${manifest.name}
// @namespace    ${manifest.browser_specific_settings.gecko.id}
// @version      ${manifest.version}
// @description  ${manifest.description}
// @license      MIT
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @run-at       document-start
// @inject-into  auto
// @grant        none
// @noframes
// ==/UserScript==
`;
const userscript = header + '\n' + src;
fs.writeFileSync(path.join(dist, 'shorts-fix.user.js'), userscript);
writeExtension(path.join(dist, 'test-userscript-isolated'), userscript, ' (TEST: userscript, isolated world)', 'ISOLATED');
console.log('built', path.relative(root, dist));
