import { cliCommand, PluginCliError, type BbPluginApi, type PluginCliContext } from "@get-bb/plugin-sdk";
import { posix, win32 } from "node:path";
import { exportToml } from "./toml";
import { importSettings } from "./files";
import type { SettingsStore } from "./store";
import { LIMITS } from "../limits";
import { importSummary } from "../../shared/settings";

export function settingsCommands(bb: BbPluginApi, store: SettingsStore) {
  async function fileHost(host: string | undefined, ctx: PluginCliContext) {
    if (host) return host;
    if (ctx.threadId) {
      const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
      if (thread.environmentId) return (await bb.sdk.environments.get({ environmentId: thread.environmentId })).hostId;
    }
    throw new PluginCliError("File operations need --host <host-id>; bb does not forward the invoking machine to plugin commands.", { hint: "Use an absolute path on that host. Export without --file needs no host." });
  }
  function absolute(path: string) {
    if (!posix.isAbsolute(path) && !win32.isAbsolute(path)) throw new PluginCliError("Use an absolute file path on the selected host.");
    return path;
  }
  function user(ctx: PluginCliContext) {
    if (ctx.threadId) throw new PluginCliError("Agents cannot change global Tavern settings or write the settings file. A Keeper can use tavern_tune for a bounded per-quest override.");
  }
  return {
    "settings export": cliCommand({
      summary: "Export explicit settings and pins as TOML; machine tuning is opt-in",
      options: {
        file: { type: "string", description: "Write to this absolute path (requires --host)" },
        host: { type: "string", description: "Host id containing --file" },
        "with-tuned": { type: "boolean", description: "Include machine state under [tuned]" },
        overwrite: { type: "boolean", description: "Explicitly replace an existing export file" },
      },
      async run(input, ctx) {
        const toml = exportToml(store.snapshot(), input.options["with-tuned"]);
        if (!input.options.file) return { exitCode: 0, stdout: toml };
        user(ctx);
        const hostId = await fileHost(input.options.host, ctx);
        await bb.sdk.files.write({ hostId, path: absolute(input.options.file), content: toml, contentEncoding: "utf8",
          createParents: true, mode: 0o600, ...(input.options.overwrite ? {} : { expectedSha256: null }) });
        return { exitCode: 0, stdout: `Exported settings to ${input.options.file} on ${hostId}.` };
      },
    }),
    "settings import": cliCommand({
      summary: "Preview a TOML import; --apply explicitly changes settings",
      positionals: [{ name: "path", description: "Absolute path to settings TOML", required: false }],
      options: { json: { type: "boolean", description: "Print one JSON document with the import summary" }, apply: { type: "boolean", description: "Apply the displayed changes" }, host: { type: "string", description: "Host id containing the file" },
        toml: { type: "string", stdin: true, description: 'TOML content; use --toml "$(< settings.toml)" without a host' },
        stdin: { type: "boolean", description: "Explain the bb raw-stdin limitation" } },
      async run(input, ctx) {
        if (input.options.apply) user(ctx);
        if (input.options.stdin || input.positionals.path === "-")
          throw new PluginCliError('bb does not forward raw stdin to plugin commands. Use --toml "$(< settings.toml)" for multiline TOML, or bb\'s --toml-stdin adapter for a single-line value.');
        if (input.options.toml !== undefined && input.positionals.path)
          throw new PluginCliError("Choose either --toml content or a file path, not both.");
        let source = input.options.toml;
        if (source === undefined) {
          if (!input.positionals.path) throw new PluginCliError("Provide --toml content or an absolute file path with --host.");
          const hostId = await fileHost(input.options.host, ctx);
          const file = await bb.sdk.files.read({ hostId, path: absolute(input.positionals.path), ...(ctx.signal ? { signal: ctx.signal } : {}) });
          if (file.sizeBytes > LIMITS.tomlBytes) throw new PluginCliError(`Settings files must be at most ${LIMITS.tomlBytes} UTF-8 bytes.`);
          source = file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
        }
        const result = importSettings(store, source, input.options.apply === true, store.snapshot().revision, "Imported settings through the CLI");
        const summary = result.code === "invalid" ? "Import was not applied: fix the reported problems."
          : result.code === "stale" ? "Settings changed: refresh the preview before applying. Nothing was applied."
          : importSummary(result.changes, result.applied);
        return { exitCode: result.code === "invalid" || result.code === "stale" ? 1 : 0,
          stdout: input.options.json ? JSON.stringify({ summary, ...result }, null, 2) : `${summary}\n${JSON.stringify(result, null, 2)}` };
      },
    }),
  };
}
