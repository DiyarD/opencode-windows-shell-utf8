/**
 * Pure helpers for the Windows shell encoding fix.
 *
 * OpenCode v2.3.0 captures a shell's combined stdout/stderr to a file and decodes
 * it with `bytes.toString("utf8")` (`packages/core/src/shell.ts`). On Windows the
 * default compatible shell is Windows PowerShell 5.1, which writes console output
 * in the active OEM/ANSI code page instead of UTF-8. That is why agents see
 * U+FFFD, `\x1a`, and cp1252 mojibake in tool output and misdiagnose it as broken
 * code.
 *
 * The only thing this plugin does is change the producer in `shell` `create.before`:
 * PowerShell emits UTF-8, Python gets UTF-8 stdio, and PowerShell file writes
 * default to UTF-8. Nothing in the tool output is hidden, stripped or rewritten.
 *
 * It deliberately does NOT touch the command text beyond that ASCII-only prefix.
 * `scanPowerShell()` hard-rejects confusables such as U+2013-U+2015 and
 * U+2018-U+201E because PowerShell normalizes them differently than the permission
 * scanner does; rewriting them would defeat that safety guard.
 *
 * Pure functions over the hook event, with platform as an argument so the logic
 * is testable off Windows. On non-Windows platforms the plugin is a no-op.
 */

export const DEFAULTS = Object.freeze({
  /** Add the UTF-8 output setup prefix to PowerShell/pwsh commands. */
  powershellEncoding: true,
  /** Set PYTHONUTF8 / PYTHONIOENCODING when the agent has not set them. */
  pythonEnv: true,
  /** Make PowerShell's Set-Content / Out-File / Add-Content / > write UTF-8 by default. */
  psUtf8Files: true,
});

export function resolveOptions(raw = {}) {
  return { ...DEFAULTS, ...raw };
}

/** Filename of a shell path, without extension, lowercased. */
export function shellBase(shell) {
  if (typeof shell !== "string" || shell.trim() === "") return "";
  const match = shell.trim().match(/([^\\/]+?)(?:\.[^.\\/]+)?$/);
  return (match ? match[1] : shell).toLowerCase();
}

/** Which family of shell OpenCode selected for this command. */
export function shellKind(shell) {
  const base = shellBase(shell);
  if (base === "powershell" || base === "pwsh") return "powershell";
  if (base === "cmd") return "cmd";
  return "other";
}

const UTF8_LINES = [
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "$OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
];
// PS 5.1 defaults Set-Content/Out-File to cp1252 and `>` to UTF-16LE. These
// defaults make all four write UTF-8; a command can still pass -Encoding explicitly.
const FILE_ENCODING_LINES = [
  "$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'",
  "$PSDefaultParameterValues['Set-Content:Encoding'] = 'utf8'",
  "$PSDefaultParameterValues['Add-Content:Encoding'] = 'utf8'",
];
const MARKER = UTF8_LINES[0];

function buildPrefix(options) {
  const lines = [...UTF8_LINES];
  if (options.psUtf8Files !== false) lines.push(...FILE_ENCODING_LINES);
  return `${lines.join("\n")}\n`;
}

function setDefaultEnv(env, key, value) {
  if (!env) return false;
  // Never override an explicit agent choice.
  if (env[key] !== undefined && env[key] !== "") return false;
  env[key] = value;
  return true;
}

/**
 * Mutate a `ShellCreateBefore` event so its output is UTF-8 when it reaches
 * OpenCode's `Buffer.toString("utf8")` decoder.
 *
 * @returns {{changed: boolean, kind: string, reason?: string}}
 */
export function prepare(event, options = DEFAULTS, platform = process.platform) {
  if (platform !== "win32") return { changed: false, kind: "other", reason: "not-windows" };
  if (!event || typeof event.command !== "string") {
    return { changed: false, kind: "other", reason: "no-command" };
  }

  const kind = shellKind(event.shell);
  let changed = false;

  if (kind === "powershell" && options.powershellEncoding !== false) {
    // A newline separator keeps here-strings and `#requires`-style commands valid,
    // and the marker keeps the operation idempotent under repeated hooks.
    if (!event.command.includes(MARKER)) {
      event.command = buildPrefix(options) + event.command;
      changed = true;
    }
  }

  if (options.pythonEnv !== false) {
    if (setDefaultEnv(event.env, "PYTHONUTF8", "1")) changed = true;
    if (setDefaultEnv(event.env, "PYTHONIOENCODING", "utf-8")) changed = true;
  }

  return { changed, kind };
}
