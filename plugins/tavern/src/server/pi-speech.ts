import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TavernSettings } from "../shared/settings";
import { SPEECH_REPLY_MS, validateDialogue, type SpeechContext } from "../shared/strip-scene";
import { PiSpeechExtensionError, PiSpeechRpc, PiSpeechStartupError } from "./pi-speech-rpc";
import { speechPrompt, speechSystemPrompt, type SpeechFacts } from "./pi-speech-prompt";

type Settings = TavernSettings["tavern"];
type Remark = {
  scene: SpeechContext; settings: Settings; signal: AbortSignal; deadline: number;
  reserve: () => boolean; current: () => boolean; resolve: (text: string | null) => void;
};
const UNAVAILABLE = "Pi is not executable at that path. Choose an absolute path to Pi or clear the setting to use PATH.";
const MISSING = "Pi was not found on PATH. Install Pi or enter its absolute path.";
const MODEL = "This model is not offered by Pi. Choose another speech model.";
const FAILED = "Pi could not use the speech model. Check that Pi is signed in on this machine and that it can use the selected model.";
const EXITED = "Pi stopped unexpectedly. Tavern will try again on a later remark.";
const EXTENSION_MISSING = "Tavern could not find a speech extension. Check the paths in Extensions for speech.";
const INSTRUCTIONS_PATH = "Enter text rather than a file path in Speech instructions.";
const EXTENSION_FAILED = "Pi could not load a speech extension. Check the entries in Extensions for speech.";
const key = (s: Settings) => JSON.stringify([s.piProgram, s.speechModel, s.speechReasoning, s.speechExtensions, s.speechInstructions, s.speechRecentMessages]);
const IDLE_MS = 600_000;
const RETRY_MS = 2_000;
const QUEUE_LIMIT = 2;
const SPEECH_PI_SETTINGS = JSON.stringify({ extensions: ["-builtin:mcp", "-builtin:codemode", "-builtin:tool-search", "-builtin:llama.cpp"] });

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

function probeExtensions(file: string, cwd: string, agentDir: string, signal: AbortSignal) {
  return new Promise<"accepted" | "refused" | "unknown">(resolve => {
    execFile(file, ["--no-extensions", "--version"], {
      cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, signal, timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024,
    }, (error, _stdout, stderr) => {
      if (!error) resolve("accepted");
      else if (typeof error.code === "number" && /\brefusing --no-extensions\b/i.test(stripVTControlCharacters(stderr))) resolve("refused");
      else resolve("unknown");
    });
  });
}

function speechArgs({ speechModel, speechReasoning, speechExtensions, speechInstructions }: Settings, isolated: boolean) {
  return ["--mode", "rpc", "--no-session", "--no-tools", "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates",
    ...(isolated ? [] : ["--no-extensions"]), "--offline",
    "--system-prompt", speechSystemPrompt(speechInstructions),
    "--model", speechModel, "--thinking", !speechReasoning || speechReasoning === "none" ? "off" : speechReasoning,
    ...speechExtensions.flatMap(path => ["-e", path])];
}

export class PiSpeech {
  private disposed = false;
  private watching = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private lastProblem?: { key: string; text: string };
  private checkedModel?: string;
  private configuration?: string;
  private launchProbe?: { file: string; configuration: string; agentDir?: string };
  private retryAt = 0;
  private worker?: PiSpeechRpc;
  private retiring?: Promise<void>;
  private running?: Promise<void>;
  private interrupt?: AbortController;
  private queue: Remark[] = [];

  constructor(private readonly bb: BbPluginApi, private readonly cwd: string, private readonly facts: (scene: SpeechContext) => SpeechFacts | null) {}

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

  complete(scene: SpeechContext, settings: Settings, signal: AbortSignal, reserve: () => boolean, current = () => true): Promise<string | null> {
    if (!settings.contextualSpeech || !this.watching || this.disposed || signal.aborted) return Promise.resolve(null);
    const now = Date.now();
    this.queue = this.queue.filter(job => {
      if (!job.signal.aborted && job.deadline > now) return true;
      job.resolve(null);
      return false;
    });
    if (this.queue.length >= QUEUE_LIMIT) return Promise.resolve(null);
    return new Promise(resolve => {
      this.queue.push({ scene, settings, signal, reserve, current, deadline: now + SPEECH_REPLY_MS, resolve });
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

  private clearLaunchProbe() {
    const directory = this.launchProbe?.agentDir;
    this.launchProbe = undefined;
    if (directory) rmSync(directory, { recursive: true, force: true });
  }

  private async speechAgentDir(file: string, configuration: string, signal: AbortSignal) {
    if (this.launchProbe?.file === file && this.launchProbe.configuration === configuration) return this.launchProbe.agentDir;
    this.clearLaunchProbe();
    const directory = mkdtempSync(join(this.cwd, "speech-pi-"));
    try {
      writeFileSync(join(directory, "settings.json"), SPEECH_PI_SETTINGS, { mode: 0o600, flag: "wx" });
      const result = await probeExtensions(file, this.cwd, directory, signal);
      signal.throwIfAborted();
      if (result === "refused") {
        const normalDir = process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=\/|$)/, () => homedir()) || join(homedir(), ".pi", "agent");
        for (const name of ["auth.json", "models.json"]) {
          const source = resolve(this.cwd, normalDir, name);
          if (existsSync(source)) symlinkSync(source, join(directory, name));
        }
        this.launchProbe = { file, configuration, agentDir: directory };
        return directory;
      }
      if (result === "accepted") this.launchProbe = { file, configuration };
    } finally {
      if (!this.launchProbe?.agentDir) rmSync(directory, { recursive: true, force: true });
    }
  }

  private async run(job: Remark, stop: AbortSignal): Promise<string | null> {
    const { scene, settings, reserve, current } = job;
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
        const agentDir = await this.speechAgentDir(file, configuration, signal);
        signal.throwIfAborted();
        if (!this.watching) return null;
        const env = agentDir ? { ...process.env, PI_CODING_AGENT_DIR: agentDir } : undefined;
        const started = new PiSpeechRpc(file, speechArgs(settings, !!agentDir), this.cwd, env, reason => {
          if (this.worker !== started) return;
          if (reason instanceof PiSpeechExtensionError) this.retire();
          else this.worker = undefined;
          this.retryAt = Date.now() + RETRY_MS;
          this.report(settings, reason instanceof PiSpeechExtensionError ? EXTENSION_FAILED :
            reason instanceof PiSpeechStartupError ? reason.message : EXITED);
        });
        this.worker = started;
      }
      worker = this.worker;
      await worker.reset(signal);
      signal.throwIfAborted();
      if (!this.watching || !reserve()) return null;
      const facts = this.facts(scene);
      if (!facts) return null;
      const count = settings.speechRecentMessages;
      const messages = count === 0 ? [] : (await this.bb.sdk.threads.conversationOutline({ threadId: scene.threadId, signal })).items.slice(-count);
      signal.throwIfAborted();
      if (!this.watching || !current()) return null;
      const text = await worker.reply(speechPrompt(scene, facts, messages), signal);
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
    this.clearLaunchProbe();
  }
}
