import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULTS,
  prepare,
  resolveOptions,
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
  assert.ok(e.command.includes("$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'"));
  assert.ok(e.command.includes("$PSDefaultParameterValues['Set-Content:Encoding'] = 'utf8'"));
  assert.ok(e.command.includes("$PSDefaultParameterValues['Add-Content:Encoding'] = 'utf8'"));
  assert.ok(e.command.endsWith("\nGet-Content notes.md"));
});

test("psUtf8Files option can disable the file-encoding defaults", () => {
  const e = event(PS, "Get-Content notes.md", { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" });
  prepare(e, resolveOptions({ psUtf8Files: false }), "win32");
  assert.ok(e.command.includes("[Console]::OutputEncoding ="));
  assert.ok(!e.command.includes("PSDefaultParameterValues"));
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

test("prepare leaves scanner-rejected confusables untouched (safety guard is not bypassed)", () => {
  const original = "Write-Output 'a—b'";
  const e = event(PS, original, { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" });
  prepare(e, DEFAULTS, "win32");
  assert.ok(e.command.includes(original), "the em dash must survive unchanged");
  assert.ok(/[\u2013\u2014\u2015]/.test(e.command), "scanPowerShell must still reject this command");
});

