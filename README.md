# opencode-windows-shell-utf8

A small OpenCode **v2** plugin that fixes the Windows shell tool's encoding and PowerShell-quirk problems. No source patching: it uses two documented plugin hooks.

Tested against **OpenCode v2.3.0** on Windows with Windows PowerShell 5.1 (`powershell.exe`), the default compatible shell when `pwsh` is absent.

## The problem (v2.3.0 source)

OpenCode captures a command's combined stdout/stderr to a file and decodes it unconditionally:

```ts
// packages/core/src/shell.ts
output: bytes.toString("utf8")
```

On Windows, PowerShell 5.1 writes console output in the active OEM/ANSI code page, not UTF-8. Agents therefore receive `—` as `\x1a`, `é` as U+FFFD, CJK as `??`, and misdiagnose their own code as broken.

Two further Windows-specific issues:

- `packages/core/src/shell/select.ts` invokes PowerShell as `-NoLogo -NoProfile -NonInteractive -Command <string>` — no `-EncodedCommand`, no `[Console]::OutputEncoding`, no `PYTHONUTF8`.
- `packages/core/src/shell/scan.ts`, `scanPowerShell()` hard-rejects confusable characters **in the command**:
  ```ts
  if (/[\0\u0085\u2013-\u2015\u2018-\u201e\ufeff]/.test(input))
    return { kind: "opaque", reason: "invalid-structure" }
  ```
  So a command containing an em dash or curly quote fails with `Portable shell scanner cannot analyze command: invalid-structure` before it ever runs. **This is a deliberate safety guard, and this plugin intentionally leaves it alone** — PowerShell normalizes those characters differently than the permission scanner does, so rewriting them could defeat permission analysis.

## What this plugin does

`shell` → `create.before` (runs **before** OpenCode's own `ShellParse.scan`):

1. For `powershell`/`pwsh`, prepends a UTF-8 setup header so the bytes OpenCode decodes really are UTF-8:
   ```powershell
   [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
   $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
   ```
2. Sets `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8` **only when the agent has not already set them**.
3. Sets PowerShell's file defaults so `Set-Content`, `Out-File`, `Add-Content` and `>` write UTF-8. A command can still pass `-Encoding` explicitly.

`tool` → `execute.after` (shell/bash results only):

4. Strips ANSI CSI/OSC escape codes and a leading BOM from the agent-visible text. This is consumer-side only; it never rewrites non-ASCII content, so it cannot introduce mojibake.
5. Optionally compacts PowerShell's `At line:N char:N / + CategoryInfo / + FullyQualifiedErrorId` decoration (`compactErrors`, default **false**).

On non-Windows platforms the plugin is a complete no-op. `cmd.exe` and bash commands are not rewritten; only their Python env defaults are set.

## Options

Pass options with the object form in `opencode.json(c)`:

```jsonc
{
  "plugins": [
    {
      "package": "file:///C:/dev/oc-fix-windows-shell",
      "options": {
        "compactErrors": true
      }
    }
  ]
}
```

| Option | Default | Meaning |
|---|---|---|
| `powershellEncoding` | `true` | Add the UTF-8 output header to PowerShell commands |
| `pythonEnv` | `true` | Set `PYTHONUTF8` / `PYTHONIOENCODING` when unset |
| `psUtf8Files` | `true` | Make PowerShell file writes UTF-8 by default |
| `stripAnsi` | `true` | Strip ANSI color/control sequences from shell results |
| `stripBom` | `true` | Strip a leading BOM from shell results |
| `compactErrors` | `false` | Collapse PowerShell ErrorRecord decoration |
| `log` | `false` | Log a line when the plugin loads |

## Verification

```bat
npm test                 :: 16 unit tests (platform-independent)
node test/live-probe.mjs :: real powershell.exe byte-level A/B
node test/file-write-probe.mjs :: file-write encoding check (all 5 paths clean)
```

Measured byte-level A/B for `Write-Output ([char]0x2014) ([char]0x2192) ([char]0x00E9) ([char]0x4E2D)([char]0x6587)`:

| | bytes | UTF-8 | U+FFFD | decoded chars |
|---|---:|---|---:|---|
| baseline | 15 | invalid | 1 | `-`, `\x1a`, U+FFFD, `?`, `?` |
| with plugin | 24 | valid | 0 | `—`, `→`, `é`, `中`, `文` |

End-to-end headless sessions (`test/e2e-run.mjs`, private server) confirmed the real tool result:

- **without** plugin: `"output":"-\r\n\u001a\r\n\ufffd\r\n?\r\n?\r\n"`
- **with** plugin: `"output":"—\r\n→\r\né\r\n中\r\n文\r\n"`
- regression, normal command: `"output":"alpha\r\nbeta\r\n"`, `exit: 0`

## Caveats

- The plugin does **not** bypass OpenCode's PowerShell scanner guard. Commands containing em/en dashes, curly quotes, BOM, NUL or NEL still fail with `invalid-structure` exactly as in stock OpenCode. That guard exists for permission-analysis safety; use ASCII or `[char]0x2014`-style escapes in commands instead.
- File **writing** is now UTF-8 by default. File **reading** with `Get-Content` in PowerShell 5.1 still defaults to ANSI, so use `-Encoding UTF8` for UTF-8 files. `write`/`edit` tools are unaffected.
- A command that deliberately needs UTF-16 or ANSI must pass `-Encoding` explicitly. Set `psUtf8Files: false` to turn the file defaults off.
- Built for the OpenCode v2 plugin API (`Plugin.define` + `ctx.shell.hook` + `ctx.tool.hook`). Verify compatibility when upgrading OpenCode.

## License

MIT
