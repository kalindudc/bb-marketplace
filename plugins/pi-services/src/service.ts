import { spawn } from "node:child_process";
import type {
  BbPluginApi,
  PluginAiServiceDeclaration,
  PluginSettingsHandle,
} from "@get-bb/plugin-sdk";
import { SETTING_DESCRIPTORS } from "./settings";

export interface PiServicesContext {
  bb: BbPluginApi;
  settings: PluginSettingsHandle<typeof SETTING_DESCRIPTORS>;
}

/** Runs the pi CLI in one-shot print mode and returns the generated text. */
export async function piComplete(
  ctx: PiServicesContext,
  prompt: string,
  signal: AbortSignal,
  timeoutMs = 4500,
): Promise<string> {
  const values = await ctx.settings.get();
  const executable = values.executable || "pi";
  const args = ["--print", "--no-session", "--no-tools"];
  if (values.model) args.push("--model", values.model);
  args.push(prompt);

  return new Promise<string>((resolve, reject) => {
    const proc = spawn(executable, args, {
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

export function createAiService(ctx: PiServicesContext): PluginAiServiceDeclaration {
  return {
    id: "pi",
    displayName: "Pi CLI",
    complete: (prompt, { signal }) => piComplete(ctx, prompt, signal),
    status: async () => {
      const values = await ctx.settings.get();
      const executable = values.executable || "pi";
      const ready = await new Promise<boolean>((resolve) => {
        try {
          const proc = spawn(executable, ["--version"], {
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
