// Runs the reproduction in every mode and checks each gives the expected result:
//   none      -> must FAIL (proves the test catches the bug)
//   extension -> must PASS (the shipped add-on)
//   fallback  -> must PASS (watchdog alone, primary fix switched off)
//   userscript-> must PASS (built userscript in Firefox's isolated world)
//   none, entry (channel open/Back with the race forced) -> must FAIL
//   extension, entry -> must PASS
// The long randomized channel loop (--scenario channel) is not run here: it
// fails only intermittently without a fix and takes a long time; run it by hand.
// Usage: node test/proof.mjs [--out DIR] [--repeat N]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const out = opt('out', null);
const repeat = Number(opt('repeat', 1));
const runs = [
  { mode: 'none', scenario: 'fullscreen', want: 1 },
  { mode: 'extension', scenario: 'fullscreen', want: 0 },
  { mode: 'fallback', scenario: 'fullscreen', want: 0 },
  { mode: 'userscript', scenario: 'fullscreen', want: 0 },
  { mode: 'none', scenario: 'entry', want: 1 },
  { mode: 'extension', scenario: 'entry', want: 0 },
];
const rows = [];
for (let r = 1; r <= repeat; r++) {
  for (const { mode, scenario, want } of runs) {
    const extra = out ? ['--out', path.join(out, `round${r}`)] : [];
    const res = spawnSync(process.execPath, [path.join(here, 'repro.mjs'), '--mode', mode, '--scenario', scenario, ...extra], { stdio: 'inherit' });
    rows.push({ round: r, mode, scenario, want, exit: res.status, ok: res.status === want });
  }
}
console.log('\nPROOF SUMMARY');
for (const x of rows) console.log(`${x.ok ? 'ok  ' : 'BAD '} round ${x.round} ${x.mode.padEnd(10)} ${x.scenario.padEnd(10)} exit=${x.exit} (want ${x.want})`);
process.exit(rows.every((x) => x.ok) ? 0 : 1);
