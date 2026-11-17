/**
 * Which "agent writes a file via the shell" paths are safe with this plugin?
 * Spawns real powershell.exe with the plugin's prepare() applied and inspects
 * the raw bytes of the resulting files. ASCII-only console output.
 *
 *   node test/file-write-probe.mjs
 */
import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepare, DEFAULTS } from "../src/fix.js";

if (process.platform !== "win32") {
  console.log("SKIP: Windows-only");
  process.exit(0);
}

const SHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const PS_VALUE = "$v = [string][char]0x2014 + [string][char]0x00E9 + [string][char]0x4E2D; ";
const EXPECTED = ["—", "é", "中"];
const tmp = path.join(os.tmpdir(), "opencode");

function check(label, body) {
  const file = path.join(tmp, `oc-write-${label}.txt`);
  try {
    unlinkSync(file);
  } catch {}
  const event = {
    shell: SHELL,
    cwd: tmp,
    timeout: 0,
    env: { ...process.env },
    command: (body.includes("$v") ? PS_VALUE : "") + body.replace(/<FILE>/g, file),
  };
  prepare(event, DEFAULTS, "win32");
  const child = spawnSync(SHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", event.command], {
    encoding: null,
    windowsHide: true,
    env: event.env,
    cwd: tmp,
  });
  let report;
  try {
    const bytes = readFileSync(file);
    const text = new TextDecoder("utf-8").decode(bytes);
    const replaced = (text.match(/\ufffd/g) ?? []).length;
    let valid = true;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      valid = false;
    }
    const missing = EXPECTED.filter((c) => !text.includes(c));
    report = `bytes=${bytes.length} validUTF8=${valid} U+FFFD=${replaced} missing=${JSON.stringify(missing)}`;
  } catch (e) {
    report = `no file: ${e.message}`;
  }
  const stderr = Buffer.from(child.stderr ?? []).toString("utf8").trim().replace(/\s+/g, " ").slice(0, 140);
  console.log(`${label.padEnd(14)} ${report}${stderr ? ` | stderr: ${stderr}` : ""}`);
}

console.log(`shell: ${SHELL}\n`);
check("Set-Content", "Set-Content -LiteralPath '<FILE>' -Value $v");
check("Out-File", "$v | Out-File -LiteralPath '<FILE>'");
check("Out-File-utf8", "$v | Out-File -LiteralPath '<FILE>' -Encoding utf8");
check("redirection", "$v > '<FILE>'");
check("python", 'python -c "open(r\'<FILE>\',\'w\').write(chr(0x2014)+chr(0xE9)+chr(0x4E2D))"');
