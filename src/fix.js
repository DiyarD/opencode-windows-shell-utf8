/**
 * Pure, side-effect-free helpers for the Windows shell encoding fix.
 *
 * OpenCode v2.3.0 captures a shell's combined stdout/stderr to a file and decodes
 * it with `bytes.toString("utf8")` (`packages/core/src/shell.ts`). On Windows the
 * default compatible shell is Windows PowerShell 5.1, which writes console output
 * in the active OEM/ANSI code page instead of UTF-8. That is why agents see
 * U+FFFD, `\x1a`, and cp1252 mojibake in tool output and misdiagnose it as broken
 * code.
 *
 * The fix has two independent parts:
 *
 *   1. `prepare()` runs in the `shell` `create.before` hook. It makes PowerShell
 *      emit UTF-8 and gives Python UTF-8 stdio, so the bytes OpenCode decodes are
 *      actually UTF-8. This is the real fix; it changes the producer.
 *
 *   2. `sanitizeText()` / `sanitizeResult()` run in the `tool` `execute.after`
 *      hook. They remove artifacts that cannot be fixed at the producer
 *      (ANSI color codes, a leading BOM) and optionally compact PowerShell's
 *      ErrorRecord decoration. This changes the consumer side only, and never
 *      rewrites non-ASCII content, so it cannot introduce mojibake.
 *
 * Everything here is a pure function over the hook event. The platform is an
 * argument so the logic is testable off Windows; on non-Windows platforms the
 * plugin is a complete no-op.
 */

export const DEFAULTS = Object.freeze({
  /** Add the UTF-8 output setup prefix to PowerShell/pwsh commands. */
  powershellEncoding: true,
  /** Set PYTHONUTF8 / PYTHONIOENCODING when the agent has not set them. */
  pythonEnv: true,
  /** Strip ANSI CSI/OSC escape sequences from shell tool text. */
  stripAnsi: true,
  /** Strip a leading UTF-8 BOM from shell tool text. */
  stripBom: true,
  /** Collapse the `At line:N char:N / + CategoryInfo / + FullyQualifiedErrorId` block. */
  compactErrors: false,
  /**
   * Rewrite the confusable Unicode that OpenCode's PowerShell scanner hard-rejects
   * (`scanPowerShell` in core/src/shell/scan.ts: /[\0\u0085\u2013-\u2015\u2018-\u201e\ufeff]/)
   * to the ASCII punctuation PowerShell would treat them as anyway. Without this,
   * a command containing an em dash or curly quote fails with
   * "Portable shell scanner cannot analyze command: invalid-structure".
   */
  normalizeConfusables: true,
});

/**
 * Characters the PowerShell scanner refuses to analyze, mapped to the ASCII
 * punctuation PowerShell normalizes them to. A valid command is strictly better
 * than a hard scanner failure; the trade-off (typographic dashes/quotes become
 * ASCII) is documented in the README and can be disabled with an option.
 */
const CONFUSABLES = [
  /[\u2013\u2014\u2015]/g, // en dash, em dash, horizontal bar -> hyphen
  /[\u2018\u2019\u201a]/g, // curly single quotes -> ASCII apostrophe
  /[\u201c\u201d\u201e]/g, // curly double quotes -> ASCII double quote
  /[\ufeff\u0000\u0085]/g, // BOM, NUL, NEL -> removed
];

/** Make a command analyzable by OpenCode's PowerShell scanner. */
export function normalizeConfusables(command) {
  if (typeof command !== "string") return command;
  return CONFUSABLES.reduce((text, pattern) => text.replace(pattern, (char) => {
    if (char === "\u2013" || char === "\u2014" || char === "\u2015") return "-";
    if (char === "\u2018" || char === "\u2019" || char === "\u201a") return "'";
    if (char === "\u201c" || char === "\u201d" || char === "\u201e") return '"';
    return ""; // \ufeff, \0, \u0085
  }), command);
}

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
const PREFIX = `${UTF8_LINES.join("\n")}\n`;
const MARKER = UTF8_LINES[0];

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

  if (kind === "powershell") {
    if (options.normalizeConfusables !== false) {
      // Must happen before OpenCode's create.before hook returns: ShellTool.prepare()
      // runs right after it and calls ShellParse.scan(), which hard-rejects these.
      const normalized = normalizeConfusables(event.command);
      if (normalized !== event.command) {
        event.command = normalized;
        changed = true;
      }
    }
    if (options.powershellEncoding !== false) {
      // A newline separator keeps here-strings and `#requires`-style commands valid,
      // and the marker keeps the operation idempotent under repeated hooks.
      if (!event.command.includes(MARKER)) {
        event.command = PREFIX + event.command;
        changed = true;
      }
    }
  }

  if (options.pythonEnv !== false) {
    if (setDefaultEnv(event.env, "PYTHONUTF8", "1")) changed = true;
    if (setDefaultEnv(event.env, "PYTHONIOENCODING", "utf-8")) changed = true;
  }

  return { changed, kind };
}

const ANSI_ESCAPE =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/**
 * Collapse only the decoration PowerShell adds when native stderr is redirected
 * with `2>&1`. Never rewrites the actual program output.
 */
export function compactPowerShellErrors(text) {
  if (typeof text !== "string") return text;
  if (!/At line:\d+ char:\d+/.test(text) || !/CategoryInfo|FullyQualifiedErrorId/.test(text)) {
    return text;
  }
  return text
    .split("\n")
    .filter((line) => {
      if (/^\s*At line:\d+ char:\d+\s*$/.test(line)) return false;
      if (/^\s*\+\s*[~^]+\s*$/.test(line)) return false;
      if (/^\s*\+\s*CategoryInfo\s*:/.test(line)) return false;
      if (/^\s*\+\s*FullyQualifiedErrorId\s*:/.test(line)) return false;
      return true;
    })
    .join("\n");
}

/** Remove producer-independent noise from one piece of agent-visible text. */
export function sanitizeText(text, options = DEFAULTS) {
  if (typeof text !== "string") return text;
  let result = text;
  if (options.stripAnsi !== false) result = result.replace(ANSI_ESCAPE, "");
  if (options.stripBom !== false && result.charCodeAt(0) === 0xfeff) result = result.slice(1);
  if (options.compactErrors === true) result = compactPowerShellErrors(result);
  return result;
}

/** Apply `sanitizeText` to the text items of a v2 `Tool.Result`. */
export function sanitizeResult(result, options = DEFAULTS) {
  if (!result || !Array.isArray(result.content)) return false;
  let changed = false;
  result.content = result.content.map((item) => {
    if (!item || item.type !== "text" || typeof item.text !== "string") return item;
    const text = sanitizeText(item.text, options);
    if (text === item.text) return item;
    changed = true;
    return { ...item, text };
  });
  return changed;
}
