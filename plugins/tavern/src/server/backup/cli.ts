import { cliCommand } from "@get-bb/plugin-sdk";
import { terminalUserAct } from "../authority";
import { KeeperStore } from "../keeper/store";
import { backupPartSchema } from "../../shared/backup";
import { FORGE_SETTINGS_PAGE_ONLY } from "../settings/forge-cli";
import { LIMITS } from "../limits";
import type { BackupService } from "./service";

const flags = { json: { type: "boolean", description: "Stable JSON output for scripts" } } as const;
const captureFlags = { ...flags, "with-data": { type: "boolean", description: "Include Tavern records; user-authored notes can be private" }, projects: { type: "boolean", description: "Include registered server-local project overrides" } } as const;
function emit(value: unknown, json: boolean, exitCode = 0, text?: string) { return { exitCode, stdout: text !== undefined && !json ? text : JSON.stringify(value, null, json ? undefined : 2) }; }
function failure(json: boolean, code: "invalid" | "error" | "forbidden", message: string, exitCode: number) {
  return json ? emit({ code, problem: message }, true, exitCode) : { exitCode, stdout: "", stderr: message + "\n" };
}
async function safely(json: boolean, action: () => Promise<ReturnType<typeof emit> | ReturnType<typeof failure>>) {
  try { return await action(); } catch (error) { return failure(json, "error", String(error).slice(0, 2000), 1); }
}
export function backupCommands(service: BackupService) {
  return {
    "backup save": cliCommand({
      summary: "Save a private managed backup and apply the configured retention policy",
      options: captureFlags,
      run: input => safely(input.options.json === true, async () => {
        const result = await service.save({ withData: input.options["with-data"], projects: input.options.projects });
        return emit(result, input.options.json === true, result.code === "ok" ? 0 : 1, result.code === "ok" ? `Saved ${result.path}\n${JSON.stringify(result.manifest, null, 2)}\n${result.problem ? `Warning: ${result.problem}\n` : ""}` : `Backup failed: ${result.problem}\n`);
      }),
    }),
    "backup export": cliCommand({
      summary: "Print one complete JSON bundle to stdout without truncation",
      options: { ...captureFlags, parts: { type: "string", description: "Comma-separated settings,classes,characters,scopes; defaults to all" } },
      run: input => safely(input.options.json === true, async () => {
        const parts = input.options.parts === undefined ? undefined : backupPartSchema.array().min(1).safeParse(input.options.parts.split(",").map(value => value.trim()));
        if (parts && !parts.success) return failure(input.options.json === true, "invalid", parts.error.message, 2);
        const result = await service.export({ withData: input.options["with-data"], projects: input.options.projects, ...(parts ? { parts: parts.data } : {}) }, LIMITS.backupCliBytes);
        if (result.code === "too-large") return emit(result, input.options.json === true, 2, `Export is ${result.bytes} bytes, above the ${result.limit}-byte stdout limit. Use backup save to keep it on disk.\n`);
        return { exitCode: 0, stdout: result.json + "\n" };
      }),
    }),
    "backup list": cliCommand({
      summary: "List saved backups and their counts, newest first",
      options: flags,
      run: input => safely(input.options.json === true, async () => { const result = service.list(); return emit(result, input.options.json === true, result.error ? 1 : 0); }),
    }),
    "backup show": cliCommand({
      summary: "Verify saved file hashes and show the backup manifest",
      positionals: [{ name: "name", description: "Managed backup name", required: true }], options: flags,
      run: input => safely(input.options.json === true, async () => emit(service.show(input.positionals.name), input.options.json === true)),
    }),
    "backup restore": cliCommand({
      summary: "Preview configuration and records; only --apply writes changes",
      positionals: [{ name: "name", description: "Managed backup name" }],
      options: { ...flags, bundle: { type: "string", description: 'JSON bundle, for example --bundle "$(< backup.json)"' }, apply: { type: "boolean", description: "Apply after a fresh preview; user terminal only" }, "preview-hash": { type: "string", description: "Apply only if this earlier preview still matches" } },
      run: (input, ctx) => safely(input.options.json === true, async () => {
        const json = input.options.json === true;
        if (input.options.apply && ctx.threadId) return failure(json, "forbidden", "Agents can save, export and preview backups, but cannot restore global configuration or data. Apply from an ordinary terminal or the settings page.", 2);
        if ((input.positionals.name !== undefined) === (input.options.bundle !== undefined)) return failure(json, "invalid", "Choose exactly one backup name or --bundle JSON.", 2);
        const from = input.positionals.name !== undefined ? { name: input.positionals.name } : { bundle: input.options.bundle! };
        const restore = (request: Parameters<BackupService["restore"]>[0]) => request.apply
          ? terminalUserAct(ctx, "backupRestore", new KeeperStore(service.options.settings.db), () => service.options.settings.now(), receipt => service.restore(request, receipt))
          : service.restore(request);
        let result;
        if (input.options.apply && input.options["preview-hash"]) result = await restore({ from, apply: true, previewHash: input.options["preview-hash"] });
        else {
          result = await service.restore({ from, apply: false });
          if (input.options.apply && result.code === "preview") result = await restore({ from, apply: true, previewHash: result.previewHash });
        }
        return emit({ ...result, notice: FORGE_SETTINGS_PAGE_ONLY }, json, result.code === "stale" ? 3 : result.code === "invalid" ? 2 : 0);
      }),
    }),
  };
}
