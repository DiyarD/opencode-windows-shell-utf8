/**
 * End-to-end proof runner (Windows only).
 *
 * Launches a private, headless OpenCode server in this repository (where
 * `.opencode/plugins/` is auto-loaded) and asks the agent to run one shell
 * command whose output contains non-ASCII characters. The command itself is
 * pure ASCII so OpenCode's shell scanner accepts it: the Unicode is produced
 * with [char] codes at runtime.
 *
 * Raw stdout/stderr are written to the opencode temp directory. Printed output
 * is ASCII-only so the surrounding shell tool cannot corrupt the evidence.
 *
 *   node test/e2e-run.mjs [label]
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const label = process.argv[2] ?? "fixed";
const scenarios = {
  confusables:
    "Use the shell tool exactly once with this command: Write-Output 'a—b'. " +
    "Then reply with ONLY the exact text the tool returned, no commentary.",
};
const prompt =
  scenarios[process.argv[3] ?? ""] ??
  process.env.E2E_PROMPT ??
  "Use the shell tool exactly once with this command (copy it exactly): " +
    "Write-Output ([char]0x2014) ([char]0x2192) ([char]0x00E9) ([char]0x4E2D)([char]0x6587). " +
    "Then reply with ONLY the exact text the tool returned, character for character, no commentary.";
const cwd = process.env.E2E_CWD ?? path.resolve(import.meta.dirname, "..");

const tmp = path.join(os.tmpdir(), "opencode");
const out = path.join(tmp, `e2e-${label}.json`);
const err = path.join(tmp, `e2e-${label}.err`);

const child = spawnSync(
  "opencode",
  [
    "run",
    "--standalone",
    "--auto",
    "--model",
    process.env.E2E_MODEL ?? "google/gemini-2.5-flash-lite",
    "--format",
    "json",
    prompt,
  ],
  {
    cwd,
    encoding: null,
    windowsHide: true,
    shell: true,
    maxBuffer: 32 * 1024 * 1024,
  },
);

const stdout = Buffer.from(child.stdout ?? []);
const stderr = Buffer.from(child.stderr ?? []);
writeFileSync(out, stdout);
writeFileSync(err, stderr);

console.log(`label: ${label}`);
if (child.error) console.log(`spawn error: ${child.error.message}`);
console.log(`exit: ${child.status ?? "unknown"} (signal ${child.signal ?? "none"})`);
console.log(`stdout: ${stdout.length} bytes -> ${out}`);
console.log(`stderr: ${stderr.length} bytes -> ${err}`);
console.log(`stdout first bytes: ${[...stdout.subarray(0, 40)].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
