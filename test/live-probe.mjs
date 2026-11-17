/**
 * Live A/B proof (Windows only): does the create.before prefix actually make
 * Windows PowerShell emit UTF-8 bytes that OpenCode's `toString("utf8")` can
 * decode? This spawns the real powershell.exe twice and inspects raw stdout
 * bytes. Prints ASCII-only output so the surrounding OpenCode shell tool cannot
 * corrupt the evidence.
 *
 *   node test/live-probe.mjs
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepare, DEFAULTS } from "../src/fix.js";

if (process.platform !== "win32") {
  console.log("SKIP: live probe is Windows-only");
  process.exit(0);
}

const SHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
// ASCII-only command: Unicode is produced at runtime so the scanner accepts it.
const COMMAND =
  "Write-Output ([char]0x2014) ([char]0x2192) ([char]0x00E9) ([char]0x4E2D)([char]0x6587)";
const EXPECTED = ["—", "→", "é", "中", "文"];

function run(label, command) {
  const child = spawnSync(
    SHELL,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: null, windowsHide: true },
  );
  const bytes = Buffer.from(child.stdout ?? []);
  const file = path.join(os.tmpdir(), `oc-utf8-${label}.bin`);
  writeFileSync(file, bytes);
  const text = new TextDecoder("utf-8").decode(bytes);
  const replaced = (text.match(/\ufffd/g) ?? []).length;
  const missing = EXPECTED.filter((s) => !text.includes(s));
  const percent = (() => {
    const c = new TextDecoder("utf-8", { fatal: true });
    try {
      c.decode(bytes);
      return "100% valid UTF-8";
    } catch {
      return "invalid UTF-8 byte sequence";
    }
  })();
  console.log(`${label}: ${bytes.length} bytes | ${percent} | U+FFFD=${replaced} | missing=${JSON.stringify(missing)}`);
  console.log(`  first bytes: ${[...bytes.subarray(0, 24)].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
  console.log(`  raw file: ${file}`);
  return { replaced, missing };
}

console.log(`shell: ${SHELL}`);
console.log(`command: ${COMMAND}\n`);
const baseline = run("baseline", COMMAND);

const event = { shell: SHELL, command: COMMAND, env: {}, cwd: process.cwd(), timeout: 0 };
prepare(event, DEFAULTS, "win32");
const fixed = run("fixed", event.command);

console.log("\nRESULT:");
console.log(`  baseline decoded cleanly: ${baseline.replaced === 0 && baseline.missing.length === 0}`);
console.log(`  fixed decoded cleanly:    ${fixed.replaced === 0 && fixed.missing.length === 0}`);
if (fixed.replaced !== 0 || fixed.missing.length !== 0) process.exitCode = 1;
