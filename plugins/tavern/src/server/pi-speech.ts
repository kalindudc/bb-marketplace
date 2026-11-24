import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TavernSettings } from "../shared/settings";
import { validateDialogue, type StripScene } from "../shared/strip-scene";

type Settings = TavernSettings["tavern"];
type Context = Pick<StripScene, "role" | "stage" | "moment">;
const UNAVAILABLE = "Pi is not executable at that path. Choose an absolute path to Pi or clear the setting to use PATH.";
const MISSING = "Pi was not found on PATH. Install Pi or enter its absolute path.";
const MODEL = "This model is not offered by Pi. Choose another speech model.";
const FAILED = "Pi could not use the speech model. Check that Pi is signed in on this machine and that it can use the selected model.";
const key = (s: Settings) => JSON.stringify([s.piProgram, s.speechModel, s.speechReasoning]);

function piFile(path: string) {
  const files = path ? [path] : (process.env.PATH ?? "").split(delimiter)
    .filter(isAbsolute).map(dir => join(dir, process.platform === "win32" ? "pi.exe" : "pi"));
  return files.find(file => {
    if (!isAbsolute(file)) return false;
    try {
      if (!statSync(file).isFile()) return false;
      accessSync(file, constants.X_OK);
      return true;
    } catch { return false; }
  });
}

export function speechArgs({ role, stage, moment }: Context, model: string, reasoning: string | null) {
  return ["-p", "--no-session", "--no-tools", "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates", "--offline",
    "--system-prompt", "Write only a brief in-character remark. Do not use tools.",
    "--model", model, "--thinking", !reasoning || reasoning === "none" ? "off" : reasoning, "--",
    `One cozy medieval remark in five simple words, then a period. Letters and single spaces only. No claims, names, commands or titles. Role: ${role}; stage: ${stage}; change: ${moment}.`];
}

export class PiSpeech {
  private readonly shutdown = new AbortController();
  private running?: Promise<string | null>;
  private lastProblem?: { key: string; text: string };
  private checkedModel?: string;

  constructor(private readonly bb: BbPluginApi, private readonly cwd: string) {}

  problem(settings: Settings): string | null {
    if ((settings.contextualSpeech || settings.piProgram) && !piFile(settings.piProgram)) return settings.piProgram ? UNAVAILABLE : MISSING;
    return this.lastProblem?.key === key(settings) ? this.lastProblem.text : null;
  }

  private report(settings: Settings, text: string | null) {
    const current = key(settings);
    if ((this.lastProblem?.key === current ? this.lastProblem.text : null) === text) return;
    this.lastProblem = text ? { key: current, text } : undefined;
    this.bb.rpc.experimental_invalidate(["tavern:settings"]);
  }

  async complete(scene: Context, settings: Settings, signal: AbortSignal, reserve: () => boolean) {
    if (!settings.contextualSpeech || this.running || this.shutdown.signal.aborted || signal.aborted) return null;
    const active = AbortSignal.any([signal, this.shutdown.signal]);
    const running = this.running = this.run(scene, settings, active, reserve);
    try { return await running; }
    finally { this.running = undefined; }
  }

  private async run(scene: Context, settings: Settings, signal: AbortSignal, reserve: () => boolean) {
    const { speechModel, speechReasoning } = settings;
    const file = piFile(settings.piProgram);
    if (!file) return null;
    try {
      if (this.checkedModel !== speechModel) {
        const catalog = await this.bb.sdk.providers.models({ providerId: "pi", signal });
        signal.throwIfAborted();
        if (!catalog.models.some(model => model.model === speechModel)) {
          this.report(settings, MODEL);
          return null;
        }
        this.checkedModel = speechModel;
      }
      if (signal.aborted || !reserve()) return null;
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = execFile(file, speechArgs(scene, speechModel, speechReasoning), {
          cwd: this.cwd, shell: false, signal, timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 16_384, encoding: "utf8",
        }, (error, stdout) => error ? reject(error) : resolve(stdout));
        child.stdin?.end();
      });
      signal.throwIfAborted();
      this.report(settings, null);
      return validateDialogue(stdout.trim());
    } catch {
      if (!signal.aborted) {
        this.checkedModel = undefined;
        this.report(settings, FAILED);
      }
      return null;
    }
  }

  async dispose() {
    this.shutdown.abort();
    await this.running;
  }
}
