/**
 * opencode-windows-shell-utf8
 *
 * Fixes OpenCode v2.3.0's Windows shell output encoding. See README.md.
 *
 * Uses one documented hook, no source patching:
 *   - `shell` `create.before` -> make PowerShell/Python produce real UTF-8 bytes
 *
 * Tool output is never modified, stripped or hidden.
 */
import { Plugin } from "@opencode/plugin";
import { prepare, resolveOptions } from "./src/fix.js";

export default Plugin.define({
  id: "opencode.windows-shell-utf8",

  /** @param {import("@opencode/plugin").Context} ctx */
  async setup(ctx) {
    const options = resolveOptions(ctx.options);

    await ctx.shell.hook("create.before", (event) => {
      // No-op on mac/linux and for non-Windows shells.
      prepare(event, options);
    });

    if (options.log) {
      console.log(`[windows-shell-utf8] loaded in OpenCode ${ctx.app.version}`);
    }
  },
});
