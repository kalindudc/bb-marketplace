import { cliCommand, PluginCliError, type BbPluginApi, type PluginCliContext } from "@get-bb/plugin-sdk";
import { posix, win32 } from "node:path";
import { exportToml, previewToml } from "./toml";
import { importSettings } from "./files";
import type { SettingsStore } from "./store";
import { LIMITS } from "../limits";
import { settingsPatchSchema, importSummary, isGuardrailSetting } from "../../shared/settings";

import { FORGE_SETTINGS_PAGE_ONLY, withoutForgeCommands } from "./forge-cli";
import { KeeperStore } from "../keeper/store";

function settingKeys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => settingKeys(child, prefix ? `${prefix}.${key}` : key));
}

export function settingsCommands(bb: BbPluginApi, store: SettingsStore) {
  const keepers = new KeeperStore(store.db);
  function guardrails(ctx: PluginCliContext, keys: string[]) {
    if (!ctx.threadId || !keepers.get("members", ctx.threadId)) return;
    const blocked = [...new Set(keys.filter(isGuardrailSetting))].sort();
    if (blocked.length) throw new PluginCliError(`Tavern-managed threads cannot change guardrail settings: ${blocked.join(", ")}. Change these on Tavern's Settings page, or ask from a plain thread.`);
  }
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
  function settingsAccess(ctx: PluginCliContext) {
    if (ctx.threadId && !store.read().tavern.agentsMayChangeSettings) throw new PluginCliError('The user turned off "Agents may change settings". Preview settings and ask the user to enable it before applying.');
  }
  return {
    "settings get": cliCommand({
      summary: "Read effective settings, optionally one dotted key",
      positionals: [{ name: "key", description: "Dotted settings key", required: false }],
      async run(input) {
        let value: unknown = store.read();
        for (const key of input.positionals.key?.split(".") ?? []) {
          if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, key)) throw new PluginCliError("Unknown settings key");
          value = (value as Record<string, unknown>)[key];
        }
        return { exitCode: 0, stdout: JSON.stringify(value, null, 2) };
      },
    }),
    "settings set": cliCommand({
      summary: "Preview dotted key=value settings; --apply writes",
      positionals: [{ name: "assignments", description: "Dotted key=value pairs", required: true, variadic: true }],
      options: { apply: { type: "boolean", description: "Apply these changes" } },
      async run(input, ctx) {
        if (input.options.apply) settingsAccess(ctx);
        const patch: Record<string, unknown> = {};
        for (const assignment of input.positionals.assignments ?? []) {
          const at = assignment.indexOf("=");
          if (at < 1) throw new PluginCliError("Use key=value");
          const keys = assignment.slice(0, at).split(".");
          if (keys.some(k => !k || ["__proto__", "constructor", "prototype"].includes(k))) throw new PluginCliError("Invalid settings key");
          const raw = assignment.slice(at + 1);
          let value: unknown;
          try { value = JSON.parse(raw); } catch { value = raw; }
          let target = patch;
          for (const key of keys.slice(0, -1)) {
            if (target[key] === undefined) target[key] = {};
            if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) throw new PluginCliError("Overlapping settings keys");
            target = target[key] as Record<string, unknown>;
          }
          target[keys.at(-1)!] = value;
        }
        if (input.options.apply && settingKeys(patch).some(key => key === "machines.forges" || key.startsWith("machines.forges."))) throw new PluginCliError(FORGE_SETTINGS_PAGE_ONLY);
        const checked = settingsPatchSchema.safeParse(patch);
        if (!checked.success) throw new PluginCliError(checked.error.message);
        const parsed = checked.data;
        if (parsed.tavern?.ambientMotion !== undefined) parsed.tavern.hearthFlicker = parsed.tavern.ambientMotion !== "off";
        const snapshot = store.snapshot();
        for (const [id, value] of Object.entries(parsed.classes ?? {})) parsed.classes![id] = { ...snapshot.user.classes?.[id], ...value };
        if (input.options.apply) guardrails(ctx, settingKeys(parsed));
        if (input.options.apply) store.update({ revision: snapshot.revision, patch: parsed, why: "Changed settings through the CLI" }, ctx.threadId ?? null);
        return { exitCode: 0, stdout: JSON.stringify({ applied: !!input.options.apply, patch: parsed }, null, 2) };
      },
    }),
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
        if (input.options.apply) settingsAccess(ctx);
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
        const filtered = withoutForgeCommands(source, store.snapshot());
        source = filtered.toml;
        if (input.options.apply) {
          const preview = previewToml(source, store.snapshot());
          guardrails(ctx, [...settingKeys(preview.user), ...settingKeys(preview.pinned, "pinned"), ...settingKeys(preview.tuned, "tuned"), ...preview.changes.map(c => c.key)].filter(key => key !== "machines.forges" && !key.startsWith("machines.forges.")));
        }
        const result = importSettings(store, source, input.options.apply === true, store.snapshot().revision, "Imported settings through the CLI", ctx.threadId ?? null);
        const summary = result.code === "invalid" ? "Import was not applied: fix the reported problems."
          : result.code === "stale" ? "Settings changed: refresh the preview before applying. Nothing was applied."
          : importSummary(result.changes, result.applied);
        return { exitCode: result.code === "invalid" || result.code === "stale" ? 1 : 0,
          stdout: input.options.json ? JSON.stringify({ summary, ...result, skippedForgeProfiles: filtered.skipped, keptForgeProfiles: filtered.kept, notice: FORGE_SETTINGS_PAGE_ONLY }, null, 2) : `${summary}\n${FORGE_SETTINGS_PAGE_ONLY}\nSkipped forge profiles: ${filtered.skipped.join(", ") || "none"}.\nKept forge profiles: ${filtered.kept.join(", ") || "none"}.\n${JSON.stringify(result, null, 2)}` };
      },
    }),
  };
}
