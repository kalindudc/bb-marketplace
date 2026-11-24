import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

type Frame = Record<string, unknown>;
const record = (value: unknown): value is Frame => !!value && typeof value === "object" && !Array.isArray(value);
const MAX_FRAME_BYTES = 256 * 1024;

function assistantText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  const last = messages.slice().reverse().find((value: unknown) => record(value) && value.role === "assistant");
  if (!record(last) || !Array.isArray(last.content)) return null;
  if (last.stopReason === "error") throw new Error("Pi reported a failed reply");
  if (last.stopReason !== "stop" && last.stopReason !== "length") return null;
  return last.content.filter((value: unknown) => record(value) && value.type === "text" && typeof value.text === "string")
    .map(value => value.text as string).join("").trim() || null;
}

export class PiSpeechExtensionError extends Error {}
export class PiSpeechStartupError extends Error {}

export class PiSpeechRpc {
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<(frame: Frame) => void>();
  private readonly child;
  private readonly exited: Promise<void>;
  private buffer = "";
  private serial = 0;
  private started = false;
  private closing?: Promise<void>;

  constructor(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv | undefined, unexpectedExit: (reason: unknown) => void) {
    const child = this.child = spawn(file, args, { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let startupDiagnostic = "", diagnosticTail = "";
    this.exited = new Promise(resolve => child.once("close", () => {
      const firstLine = stripVTControlCharacters(startupDiagnostic).split(/[\r\n]/, 1)[0]?.replace(/\p{C}/gu, "").trim().slice(0, 160);
      const reason = !this.started && /(?:^|\n)Error: Failed to load extension /.test(diagnosticTail)
        ? new PiSpeechExtensionError("Pi could not load a speech extension")
        : !this.started && firstLine ? new PiSpeechStartupError("Pi refused to start: " + firstLine) : new Error("Pi exited");
      this.lifetime.abort(reason);
      if (!this.closing) unexpectedExit(reason);
      resolve();
    }));
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      try { this.receive(chunk); }
      catch (error) {
        this.lifetime.abort(error);
        if (error instanceof PiSpeechExtensionError && !this.closing) unexpectedExit(error);
        void this.close();
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (this.started) return;
      startupDiagnostic = (startupDiagnostic + chunk).slice(0, 2048);
      diagnosticTail = (diagnosticTail + chunk).slice(-2048);
    });
    const failed = (error: Error) => this.lifetime.abort(error);
    child.on("error", failed);
    // A startup exit can break stdin before its stderr has drained.
    child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (this.started || error.code !== "EPIPE") failed(error); });
    child.stdout.on("error", failed);
    child.stderr.on("error", failed);
  }

  private receive(chunk: string) {
    if (this.lifetime.signal.aborted) return;
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, end).replace(/\r$/, "");
      this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error("Pi RPC frame too large");
      const frame: unknown = JSON.parse(line);
      if (!record(frame) || typeof frame.type !== "string") throw new Error("Invalid Pi RPC frame");
      if (frame.type === "response") this.started = true;
      // A trusted extension can offer MCP registration while Pi is deliberately using --no-mcp.
      if (frame.type === "extension_error" && frame.event !== "register_mcp_server") throw new PiSpeechExtensionError("Pi could not load a speech extension");
      for (const listener of this.listeners) listener(frame);
    }
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) throw new Error("Pi RPC frame too large");
  }

  private wait<T>(signal: AbortSignal, accept: (frame: Frame) => T | undefined) {
    const active = AbortSignal.any([signal, this.lifetime.signal]);
    return new Promise<T>((resolve, reject) => {
      if (active.aborted) { reject(active.reason); return; }
      const cleanup = () => { this.listeners.delete(receive); active.removeEventListener("abort", abort); };
      const abort = () => { cleanup(); reject(active.reason); };
      const receive = (frame: Frame) => {
        try {
          const value = accept(frame);
          if (value !== undefined) { cleanup(); resolve(value); }
        } catch (error) { cleanup(); reject(error); }
      };
      this.listeners.add(receive);
      active.addEventListener("abort", abort, { once: true });
    });
  }

  private async command(type: "new_session" | "prompt" | "abort", signal: AbortSignal, data: Frame = {}) {
    signal.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    const id = String(++this.serial);
    const answer = this.wait(signal, frame => frame.type === "response" && frame.id === id ? frame : undefined);
    try { this.child.stdin.write(JSON.stringify({ ...data, type, id }) + "\n"); }
    catch (error) { this.lifetime.abort(error); }
    return answer.then(frame => {
      if (frame.command !== type || frame.success !== true) throw new Error("Pi refused an RPC command");
      return record(frame.data) ? frame.data : null;
    });
  }

  async reset(signal: AbortSignal) {
    const state = await this.command("new_session", signal);
    if (state?.cancelled !== false) throw new Error("Pi did not clear its session");
  }

  async reply(message: string, signal: AbortSignal) {
    let messages: unknown;
    const end = this.wait(signal, frame => {
      if (frame.type === "agent_end") messages = frame.messages;
      if (frame.type === "agent_settled") return frame.aborted === true ? null : assistantText(messages);
      return undefined;
    });
    const prompt = this.command("prompt", signal, { message }).then(data => {
      if (data?.disposition !== "started") throw new Error("Pi did not start the prompt");
    });
    const [, text] = await Promise.all([prompt, end]);
    return text;
  }

  async abort() {
    await this.command("abort", AbortSignal.timeout(1_000));
  }

  close() {
    if (this.closing) return this.closing;
    const kill = setTimeout(() => this.child.kill("SIGKILL"), 350);
    this.closing = this.exited.finally(() => clearTimeout(kill));
    this.lifetime.abort(new Error("Pi closed"));
    this.child.stdin.end();
    return this.closing;
  }
}
