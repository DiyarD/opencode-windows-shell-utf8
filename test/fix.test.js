import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULTS,
  compactPowerShellErrors,
  normalizeConfusables,
  prepare,
  resolveOptions,
  sanitizeResult,
  sanitizeText,
  shellBase,
  shellKind,
} from "../src/fix.js";

const event = (shell, command, env = {}) => ({ shell, command, env, cwd: "C:\\dev", timeout: 0 });
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

test("shellBase strips directories and extensions, case-insensitively", () => {
  assert.equal(shellBase(PS), "powershell");
  assert.equal(shellBase("/usr/bin/pwsh"), "pwsh");
  assert.equal(shellBase("C:\\Windows\\System32\\cmd.exe"), "cmd");
  assert.equal(shellBase("bash"), "bash");
  assert.equal(shellBase(undefined), "");
});

test("shellKind classifies powershell, pwsh, cmd and others", () => {
  assert.equal(shellKind(PS), "powershell");
  assert.equal(shellKind("pwsh.exe"), "powershell");
  assert.equal(shellKind("cmd"), "cmd");
  assert.equal(shellKind("C:\\Program Files\\Git\\bin\\bash.exe"), "other");
});

test("prepare is a complete no-op off Windows", () => {
  const e = event(PS, "Write-Output '—'");
  const r = prepare(e, DEFAULTS, "linux");
  assert.equal(r.changed, false);
  assert.equal(r.reason, "not-windows");
  assert.deepEqual(e, event(PS, "Write-Output '—'"));
});

test("prepare prefixes a PowerShell command with a UTF-8 setup header", () => {
  const e = event(PS, "Get-Content notes.md");
  const r = prepare(e, DEFAULTS, "win32");
  assert.equal(r.kind, "powershell");
  assert.equal(r.changed, true);
  assert.ok(e.command.startsWith("[Console]::OutputEncoding ="));
  assert.ok(e.command.includes("$OutputEncoding ="));
  assert.ok(e.command.endsWith("\nGet-Content notes.md"));
});

test("prepare is idempotent: repeated calls never double-prefix", () => {
  const e = event("pwsh", "Get-Content notes.md");
  prepare(e, DEFAULTS, "win32");
  const once = e.command;
  const second = prepare(e, DEFAULTS, "win32");
  assert.equal(second.changed, false);
  assert.equal(e.command, once);
});

test("prepare sets Python UTF-8 env only when unset", () => {
  const e = event(PS, "python -c \"print('café')\"", { PATH: "C:\\Python" });
  prepare(e, DEFAULTS, "win32");
  assert.equal(e.env.PYTHONUTF8, "1");
  assert.equal(e.env.PYTHONIOENCODING, "utf-8");
  assert.equal(e.env.PATH, "C:\\Python");

  const explicit = event(PS, "python x.py", { PYTHONIOENCODING: "latin-1" });
  prepare(explicit, DEFAULTS, "win32");
  assert.equal(explicit.env.PYTHONIOENCODING, "latin-1", "explicit agent choice must win");
});

test("prepare leaves cmd and bash commands untouched but still sets Python env", () => {
  for (const shell of ["cmd.exe", "bash.exe"]) {
    const e = event(shell, "echo hi");
    const r = prepare(e, DEFAULTS, "win32");
    assert.equal(r.changed, true, "env was set");
    assert.equal(e.command, "echo hi", "command must not be rewritten");
    assert.equal(e.env.PYTHONUTF8, "1");
  }
});

test("prepare options can disable each behaviour", () => {
  const opts = resolveOptions({ powershellEncoding: false, pythonEnv: false });
  const e = event(PS, "echo hi");
  const r = prepare(e, opts, "win32");
  assert.equal(r.changed, false);
  assert.equal(e.command, "echo hi");
  assert.deepEqual(e.env, {});
});

test("normalizeConfusables maps the scanner-rejected characters to ASCII", () => {
  const rejected = "Write-Output 'a—b–c “q” ‘s’ \ufeff'";
  const clean = normalizeConfusables(rejected);
  assert.equal(clean, 'Write-Output \'a-b-c "q" \'s\' \'');
  assert.ok(!/[\0\u0085\u2013-\u2015\u2018-\u201e\ufeff]/.test(clean), "scanner guard must pass");
  assert.equal(normalizeConfusables("plain ascii"), "plain ascii");
  assert.equal(normalizeConfusables(undefined), undefined);
});

test("prepare normalizes confusables before the scanner sees a PowerShell command", () => {
  const e = event(PS, "Write-Output 'a—b'");
  prepare(e, DEFAULTS, "win32");
  assert.ok(e.command.includes("Write-Output 'a-b'"));
  assert.ok(!e.command.includes("—"));
});

test("normalizeConfusables can be disabled by option", () => {
  const e = event(PS, "Write-Output 'a—b'");
  prepare(e, resolveOptions({ normalizeConfusables: false, powershellEncoding: false, pythonEnv: false }), "win32");
  assert.ok(e.command.includes("—"));
});

test("sanitizeText strips ANSI CSI and OSC sequences but keeps Unicode", () => {
  const dirty = "\u001b[32m✓ built\u001b[0m — café \u001b]8;;http://x\u0007link\u001b]8;;\u0007";
  const clean = sanitizeText(dirty, DEFAULTS);
  assert.equal(clean, "✓ built — café link");
});

test("sanitizeText strips a leading BOM without touching other text", () => {
  assert.equal(sanitizeText("\ufeff\n\"\"\"docstring\"\"\""), "\n\"\"\"docstring\"\"\"");
  assert.equal(sanitizeText("already clean"), "already clean");
});

test("sanitizeText only compacts real PowerShell error records when enabled", () => {
  const err =
    "python : Traceback (most recent call last)\r\n" +
    "At line:1 char:1\r\n" +
    "+ python -c \"...\" 2>&1 | ...\r\n" +
    "+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~\r\n" +
    "    + CategoryInfo          : NotSpecified: (...) [], RemoteException\r\n" +
    "    + FullyQualifiedErrorId : NativeCommandError\r\n";

  assert.equal(sanitizeText(err, DEFAULTS), err, "compaction is opt-in");
  const compacted = sanitizeText(err, resolveOptions({ compactErrors: true }));
  assert.ok(compacted.includes("python : Traceback"));
  assert.ok(compacted.includes("+ python -c"));
  assert.ok(!compacted.includes("At line:1"));
  assert.ok(!compacted.includes("CategoryInfo"));
  assert.ok(!compacted.includes("FullyQualifiedErrorId"));
  assert.ok(!compacted.includes("~~~~"));

  // A normal diff must never be compacted.
  const diff = "--- a\n+++ b\n+ added line\n+ another\n";
  assert.equal(sanitizeText(diff, resolveOptions({ compactErrors: true })), diff);
});

test("sanitizeResult mutates only text content items and reports changes", () => {
  const result = {
    content: [
      { type: "text", text: "\u001b[31mred\u001b[0m — ok" },
      { type: "text", text: "clean" },
      { type: "image", data: "..." },
    ],
  };
  assert.equal(sanitizeResult(result, DEFAULTS), true);
  assert.equal(result.content[0].text, "red — ok");
  assert.equal(result.content[1].text, "clean");
  assert.deepEqual(result.content[2], { type: "image", data: "..." });
  assert.equal(sanitizeResult(result, DEFAULTS), false, "second pass is a no-op");
});

test("sanitizeResult tolerates malformed results", () => {
  assert.equal(sanitizeResult(undefined), false);
  assert.equal(sanitizeResult({ content: null }), false);
});
