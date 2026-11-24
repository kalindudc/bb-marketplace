import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TavernSettings } from "../shared/settings";
import { SPEECH_REPLY_MS, validateDialogue, type SpeechContext } from "../shared/strip-scene";
import { PiSpeechExtensionError, PiSpeechRpc } from "./pi-speech-rpc";

type Settings = TavernSettings["tavern"];
type Remark = {
  scene: SpeechContext; settings: Settings; signal: AbortSignal; deadline: number;
  reserve: () => boolean; resolve: (text: string | null) => void;
};
const UNAVAILABLE = "Pi is not executable at that path. Choose an absolute path to Pi or clear the setting to use PATH.";
const MISSING = "Pi was not found on PATH. Install Pi or enter its absolute path.";
const MODEL = "This model is not offered by Pi. Choose another speech model.";
const FAILED = "Pi could not use the speech model. Check that Pi is signed in on this machine and that it can use the selected model.";
const EXITED = "Pi stopped unexpectedly. Tavern will try again on a later remark.";
const EXTENSION_MISSING = "Tavern could not find a speech extension. Check the paths in Extensions for speech.";
const INSTRUCTIONS_PATH = "Enter text rather than a file path in Speech instructions.";
const EXTENSION_FAILED = "Pi could not load a speech extension. Check the entries in Extensions for speech.";
const key = (s: Settings) => JSON.stringify([s.piProgram, s.speechModel, s.speechReasoning, s.speechExtensions, s.speechInstructions]);
const IDLE_MS = 600_000;
const RETRY_MS = 2_000;
const QUEUE_LIMIT = 2;

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

function extensionExists(path: string) {
  if (!isAbsolute(path)) return false;
  try {
    const stat = statSync(path);
    return stat.isFile() || stat.isDirectory();
  } catch { return false; }
}

function speechArgs({ speechModel, speechReasoning, speechExtensions, speechInstructions }: Settings) {
  return ["--mode", "rpc", "--no-session", "--no-tools", "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-extensions", "--offline",
    "--system-prompt", speechInstructions,
    "--model", speechModel, "--thinking", !speechReasoning || speechReasoning === "none" ? "off" : speechReasoning,
    ...speechExtensions.flatMap(path => ["-e", path])];
}

function speechPrompt({ role, stage, moment }: SpeechContext) {
  return `One cozy medieval remark in five simple words, then a period. Letters and single spaces only. No claims, names, commands or titles. Role: ${role}; stage: ${stage}; change: ${moment}.`;
}

export class PiSpeech {
  private disposed = false;
  private watching = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private lastProblem?: { key: string; text: string };
  private checkedModel?: string;
  private configuration?: string;
  private retryAt = 0;
  private worker?: PiSpeechRpc;
  private retiring?: Promise<void>;
  private running?: Promise<void>;
  private interrupt?: AbortController;
  private queue: Remark[] = [];

  constructor(private readonly bb: BbPluginApi, private readonly cwd: string) {}

  problem(settings: Settings): string | null {
    if ((settings.contextualSpeech || settings.piProgram) && !piFile(settings.piProgram)) return settings.piProgram ? UNAVAILABLE : MISSING;
    if (settings.speechExtensions.some(path => !extensionExists(path))) return EXTENSION_MISSING;
    if (existsSync(resolve(this.cwd, settings.speechInstructions))) return INSTRUCTIONS_PATH;
    return this.lastProblem?.key === key(settings) ? this.lastProblem.text : null;
  }

  private report(settings: Settings, text: string | null) {
    const current = key(settings);
    if ((this.lastProblem?.key === current ? this.lastProblem.text : null) === text) return;
    this.lastProblem = text ? { key: current, text } : undefined;
    this.bb.rpc.experimental_invalidate(["tavern:settings"]);
  }

  setWatching(watching: boolean) {
    if (this.disposed || this.watching === watching) return;
    this.watching = watching;
    clearTimeout(this.idleTimer);
    if (!watching) {
      this.idleTimer = setTimeout(() => { void this.stop(); }, IDLE_MS);
      this.idleTimer.unref();
    }
  }

  async refresh(settings: Settings) {
    if (!settings.contextualSpeech || (this.configuration !== undefined && this.configuration !== key(settings))) {
      this.retryAt = 0;
      await this.stop();
    }
  }

  complete(scene: SpeechContext, settings: Settings, signal: AbortSignal, reserve: () => boolean): Promise<string | null> {
    if (!settings.contextualSpeech || !this.watching || this.disposed || signal.aborted) return Promise.resolve(null);
    const now = Date.now();
    this.queue = this.queue.filter(job => {
      if (!job.signal.aborted && job.deadline > now) return true;
      job.resolve(null);
      return false;
    });
    if (this.queue.length >= QUEUE_LIMIT) return Promise.resolve(null);
    return new Promise(resolve => {
      this.queue.push({ scene, settings, signal, reserve, deadline: now + SPEECH_REPLY_MS, resolve });
      this.pump();
    });
  }

  private pump() {
    if (this.running || this.disposed) return;
    const job = this.queue.shift();
    if (!job) return;
    this.interrupt = new AbortController();
    this.running = this.run(job, this.interrupt.signal).then(job.resolve, () => job.resolve(null)).finally(() => {
      this.running = undefined;
      this.interrupt = undefined;
      this.pump();
    });
  }

  private retire() {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) this.retiring = worker.close();
    return this.retiring;
  }

  private async run(job: Remark, stop: AbortSignal): Promise<string | null> {
    const { scene, settings, reserve } = job;
    const remaining = job.deadline - Date.now(), configuration = key(settings);
    if (remaining <= 0 || job.signal.aborted || !this.watching) return null;
    if (this.configuration !== configuration) {
      this.configuration = configuration;
      this.retryAt = 0;
      this.retire();
    }
    if (Date.now() < this.retryAt) return null;
    const signal = AbortSignal.any([job.signal, stop, AbortSignal.timeout(remaining)]);
    let worker: PiSpeechRpc | undefined;
    try {
      if (this.checkedModel !== settings.speechModel) {
        const catalog = await this.bb.sdk.providers.models({ providerId: "pi", signal });
        signal.throwIfAborted();
        if (!catalog.models.some(model => model.model === settings.speechModel)) {
          this.report(settings, MODEL);
          return null;
        }
        this.checkedModel = settings.speechModel;
      }
      await this.retiring;
      signal.throwIfAborted();
      if (!this.watching) return null;
      if (!this.worker) {
        const file = piFile(settings.piProgram);
        if (!file || settings.speechExtensions.some(path => !extensionExists(path)) || existsSync(resolve(this.cwd, settings.speechInstructions))) return null;
        const started = new PiSpeechRpc(file, speechArgs(settings), this.cwd, reason => {
          if (this.worker !== started) return;
          if (reason instanceof PiSpeechExtensionError) this.retire();
          else this.worker = undefined;
          this.retryAt = Date.now() + RETRY_MS;
          this.report(settings, reason instanceof PiSpeechExtensionError ? EXTENSION_FAILED : EXITED);
        });
        this.worker = started;
      }
      worker = this.worker;
      await worker.reset(signal);
      signal.throwIfAborted();
      if (!this.watching || !reserve()) return null;
      const text = await worker.reply(speechPrompt(scene), signal);
      signal.throwIfAborted();
      this.report(settings, null);
      return validateDialogue(text);
    } catch (error) {
      if (signal.aborted) {
        if (worker && this.worker === worker) {
          try { await worker.abort(); }
          catch { await this.retire(); }
        }
      } else {
        this.checkedModel = undefined;
        if (worker && this.worker === worker) await this.retire();
        if (this.retryAt <= Date.now()) {
          this.retryAt = Date.now() + RETRY_MS;
          this.report(settings, error instanceof PiSpeechExtensionError ? EXTENSION_FAILED : FAILED);
        }
      }
      return null;
    }
  }

  async stop() {
    this.interrupt?.abort();
    for (const job of this.queue.splice(0)) job.resolve(null);
    await this.retire();
    await this.running;
  }

  async dispose() {
    this.disposed = true;
    clearTimeout(this.idleTimer);
    await this.stop();
  }
}
