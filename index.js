/**
 * opencode-windows-shell-utf8
 *
 * Fixes OpenCode v2.3.0's Windows shell output encoding. See README.md.
 *
 * Uses two documented plugin hooks, no source patching:
 *   - `shell` `create.before`  -> make PowerShell/Python emit real UTF-8 bytes
 *   - `tool`  `execute.after`  -> strip ANSI + BOM from shell tool results
 */
import { Plugin } from "@opencode/plugin";
import { prepare, resolveOptions, sanitizeResult } from "./src/fix.js";

export default Plugin.define({
  id: "opencode.windows-shell-utf8",

  /** @param {import("@opencode/plugin").Context} ctx */
  async setup(ctx) {
    const options = resolveOptions(ctx.options);

    await ctx.shell.hook("create.before", (event) => {
      // No-op on mac/linux and for non-Windows shells.
      prepare(event, options);
    });

    await ctx.tool.hook("execute.after", (event) => {
      // Only shell results; leave read/grep/webfetch/execute (Code Mode) alone.
      if (event.tool !== "shell" && event.tool !== "bash") return;
      if (event.status !== "completed") return;
      sanitizeResult(event.result, options);
    });

    if (options.log) {
      console.log(`[windows-shell-utf8] loaded in OpenCode ${ctx.app.version}`);
    }
  },
});
