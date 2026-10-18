import { spawn } from "node:child_process";
import type { BbPluginApi, PluginAiServiceDeclaration, PluginStorage } from "@get-bb/plugin-sdk";
import {
  DEFAULT_SETTINGS,
  SETTINGS_KV_KEY,
  type PiServicesSettings,
} from "./settings";

export interface PiServicesContext {
  bb: BbPluginApi;
  settings: PiSettingsStore;
}

/** Settings persisted in the plugin's own KV storage (single source of truth). */
export interface PiSettingsStore {
  get(): Promise<PiServicesSettings>;
  set(values: Partial<PiServicesSettings>): Promise<PiServicesSettings>;
}

export function createSettingsStore(storage: PluginStorage): PiSettingsStore {
  return {
    async get() {
      const stored = await storage.kv.get<PiServicesSettings>(SETTINGS_KV_KEY);
      return { ...DEFAULT_SETTINGS, ...stored };
    },
    async set(values) {
      const next = { ...(await this.get()), ...values };
      await storage.kv.set(SETTINGS_KV_KEY, next);
      return next;
    },
  };
}

/** Splits an executable setting ("pi", "/usr/bin/pi", "pi --verbose") into a command and its leading arguments. */
export function splitExecutable(executable: string): [string, ...string[]] {
  const parts = executable.trim().split(/\s+/).filter(Boolean);
  return parts.length > 0 ? (parts as [string, ...string[]]) : ["pi"];
}

/** Runs the pi CLI in one-shot print mode and returns the generated text. */
export async function piComplete(
  ctx: PiServicesContext,
  prompt: string,
  signal: AbortSignal,
  timeoutMs = 4500,
): Promise<string> {
  const values = await ctx.settings.get();
  const [cmd, ...cmdArgs] = splitExecutable(values.executable);
  const args = [...cmdArgs, "--print", "--no-session", "--no-tools"];
  if (values.model) args.push("--model", values.model);
  args.push(prompt);

  return new Promise<string>((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      signal,
      timeout: timeoutMs,
    });
    let out = "";
    let err = "";
    proc.stdout?.on("data", (c: Buffer) => {
      out += c.toString();
    });
    proc.stderr?.on("data", (c: Buffer) => {
      err += c.toString();
    });
    proc.on("error", (e: Error) => reject(new Error(`pi failed to start: ${e.message}`)));
    proc.on("close", (code: number | null, timedOut: boolean) => {
      if (signal.aborted) return reject(new Error("aborted"));
      if (timedOut) return reject(new Error(`pi timed out after ${timeoutMs}ms`));
      if (code !== 0) return reject(new Error(`pi exited ${code}: ${err.trim()}`));
      resolve(out.trim());
    });
  });
}

export interface PiModel {
  id: string;
  provider: string;
  model: string;
  context: string;
  thinking: boolean;
  images: boolean;
}

/** Lists the models the pi CLI offers, parsed from `pi --list-models`. */
export async function piListModels(
  ctx: PiServicesContext,
  signal: AbortSignal,
  timeoutMs = 10_000,
): Promise<PiModel[]> {
  const { executable } = await ctx.settings.get();
  const [cmd, ...cmdArgs] = splitExecutable(executable);
  const proc = spawn(cmd, [...cmdArgs, "--list-models"], {
    stdio: ["ignore", "pipe", "pipe"],
    signal,
    timeout: timeoutMs,
  });
  let out = "";
  let err = "";
  proc.stdout?.on("data", (c: Buffer) => {
    out += c.toString();
  });
  proc.stderr?.on("data", (c: Buffer) => {
    err += c.toString();
  });

  return new Promise<PiModel[]>((resolve, reject) => {
    proc.on("error", (e: Error) => reject(new Error(`pi failed to start: ${e.message}`)));
    proc.on("close", (code: number | null, timedOut: boolean) => {
      if (signal.aborted) return reject(new Error("aborted"));
      if (timedOut) return reject(new Error(`pi timed out after ${timeoutMs}ms`));
      if (code !== 0) return reject(new Error(`pi exited ${code}: ${err.trim()}`));

      const lines = out.split("\n").slice(1); // skip the header row
      const models: PiModel[] = [];
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 6) continue;
        const [provider, model, , , thinking, images] = parts;
        models.push({
          id: `${provider}/${model}`,
          provider,
          model,
          context: parts[2] ?? "",
          thinking: thinking === "yes",
          images: images === "yes",
        });
      }
      resolve(models);
    });
  });
}

export function createAiService(ctx: PiServicesContext): PluginAiServiceDeclaration {
  return {
    id: "pi",
    displayName: "Pi CLI",
    complete: (prompt, { signal }) => piComplete(ctx, prompt, signal),
    status: async () => {
      const values = await ctx.settings.get();
      const executable = values.executable || "pi";
      const [cmd, ...cmdArgs] = splitExecutable(executable);
      const ready = await new Promise<boolean>((resolve) => {
        try {
          const proc = spawn(cmd, [...cmdArgs, "--version"], {
            stdio: "ignore",
            signal: AbortSignal.timeout(1500),
          });
          proc.on("error", () => resolve(false));
          proc.on("close", (code) => resolve(code === 0));
        } catch {
          resolve(false);
        }
      });
      return ready
        ? { ready: true }
        : { ready: false, message: `pi CLI (${executable}) not runnable on the bb server machine` };
    },
  };
}
