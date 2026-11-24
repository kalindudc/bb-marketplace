// @vitest-environment node
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import { PiSpeech } from "../src/server/pi-speech";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const start = vi.mocked(spawn);
const settings = { ...DEFAULT_SETTINGS.tavern, contextualSpeech: true, piProgram: process.execPath };
const scene = { role: "smith", stage: "work", moment: "assignment", revision: "private thread title", report: "private report" } as const;
const signal = new AbortController().signal;
const voices: PiSpeech[] = [];

function worker(autoReply = true) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { child.emit("close", null, "SIGKILL"); return true; }),
  });
  const frames: { type: string; id: string; message?: string }[] = [];
  const transmit = (value: object) => { child.stdout.write(JSON.stringify(value) + "\n"); };
  const answer = (text = "The hearth still warms us.") => {
    transmit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] }] });
    transmit({ type: "agent_settled", aborted: false });
  };
  child.stdin.on("data", chunk => {
    const frame = JSON.parse(chunk.toString()) as typeof frames[number];
    frames.push(frame);
    transmit({ id: frame.id, type: "response", command: frame.type, success: true,
      data: frame.type === "new_session" ? { cancelled: false } : frame.type === "prompt" ? { disposition: "started" } : undefined });
    if (frame.type === "prompt" && autoReply) answer();
  });
  child.stdin.on("finish", () => child.emit("close", 0, null));
  start.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  return { child, frames, transmit, answer };
}

function setup(models = [{ model: "openai/gpt-5-nano" }]) {
  const list = vi.fn(async () => ({ models }));
  const invalidate = vi.fn();
  const bb = { sdk: { providers: { models: list } }, rpc: { experimental_invalidate: invalidate } } as unknown as BbPluginApi;
  const voice = new PiSpeech(bb, process.cwd());
  voices.push(voice);
  const say = (context: Parameters<PiSpeech["complete"]>[0] = scene, cancel = signal, reserve = () => true) =>
    voice.complete(context, settings, cancel, reserve);
  return { voice, list, invalidate, say };
}

afterEach(async () => {
  await Promise.all(voices.splice(0).map(voice => voice.dispose()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it("starts lazily with no tools or session files, reuses one Pi, and resets before each enum-only prompt", async () => {
  const { voice, list, say } = setup();
  expect(await say()).toBeNull();
  voice.setWatching(true);
  expect(start).not.toHaveBeenCalled();
  const w = worker();
  for (const moment of ["assignment", "click", "ambient"] as const)
    expect(await say({ ...scene, moment })).toBe("The hearth still warms us.");
  expect(start).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledWith(process.execPath, ["--mode", "rpc", "--no-session", "--no-tools", "--no-mcp", "--no-skills", "--no-context-files",
    "--no-prompt-templates", "--no-extensions", "--offline", "--system-prompt", expect.any(String), "--model", "openai/gpt-5-nano", "--thinking", "low"],
    expect.objectContaining({ shell: false, stdio: ["pipe", "pipe", "pipe"] }));
  expect(list).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ providerId: "pi" }));
  expect(w.frames.map(frame => frame.type)).toEqual(["new_session", "prompt", "new_session", "prompt", "new_session", "prompt"]);
  expect(w.frames.filter(frame => frame.message).map(frame => frame.message)).toEqual(["assignment", "click", "ambient"].map(kind =>
    expect.stringMatching(new RegExp(`Role: smith; stage: work; change: ${kind}\\.$`))));
  expect(JSON.stringify(w.frames)).not.toMatch(/private/);
});

it("loads only the selected extensions and keeps the system instructions out of the bubble request", async () => {
  const { voice } = setup();
  const first = worker();
  voice.setWatching(true);
  const settingsWithExtension = { ...settings, speechExtensions: [process.execPath], speechInstructions: "Only mention the hearth." };
  expect(await voice.complete(scene, settingsWithExtension, signal, () => true)).not.toBeNull();
  const args = start.mock.calls[0]![1] as string[];
  expect(args.filter(arg => arg === "-e")).toHaveLength(1);
  expect(args.slice(args.indexOf("-e"), args.indexOf("-e") + 2)).toEqual(["-e", process.execPath]);
  expect(args[args.indexOf("--system-prompt") + 1]).toBe(settingsWithExtension.speechInstructions);
  expect(JSON.stringify(first.frames)).not.toMatch(/Only mention the hearth|private/);
  await voice.refresh({ ...settingsWithExtension, speechInstructions: "Different instructions." });
  expect(first.child.stdin.writableEnded).toBe(true);
  const second = worker();
  await voice.complete(scene, settingsWithExtension, signal, () => true);
  await voice.refresh({ ...settingsWithExtension, speechExtensions: [] });
  expect(second.child.stdin.writableEnded).toBe(true);
});

it("never lets Pi interpret editable speech instructions as a file to read", async () => {
  const { voice } = setup();
  voice.setWatching(true);
  const configured = { ...settings, speechInstructions: process.execPath };
  expect(await voice.complete(scene, configured, signal, () => true)).toBeNull();
  expect(start).not.toHaveBeenCalled();
  expect(voice.problem(configured)).toMatch(/enter text rather than a file path/i);
});

it("keeps canned speech with a missing path or an extension load error", async () => {
  const { voice } = setup();
  voice.setWatching(true);
  const missing = { ...settings, speechExtensions: ["/nonexistent/example/sign-in.ts"] };
  expect(await voice.complete(scene, missing, signal, () => true)).toBeNull();
  expect(start).not.toHaveBeenCalled();
  expect(voice.problem(missing)).toMatch(/could not find a speech extension/i);
  const configured = { ...settings, speechExtensions: [process.execPath] };
  const w = worker(false);
  w.child.stdin.prependListener("data", () => w.transmit({ type: "extension_error", extensionPath: "private", error: "private" }));
  expect(await voice.complete(scene, configured, signal, () => true)).toBeNull();
  expect(w.frames.map(f => f.type)).toEqual(["new_session"]);
  expect(voice.problem(configured)).toMatch(/could not load a speech extension/i);
  expect(voice.problem(configured)).not.toContain("private");
});

it("keeps MCP disabled without treating an extension registration notice as a load failure", async () => {
  const { voice, say } = setup();
  voice.setWatching(true);
  const w = worker();
  w.child.stdin.prependListener("data", () => w.transmit({ type: "extension_error", event: "register_mcp_server" }));
  expect(await say()).toBe("The hearth still warms us.");
  expect(voice.problem(settings)).toBeNull();
});

it("reports an extension that prevents the RPC worker from starting", async () => {
  const { voice, say } = setup();
  voice.setWatching(true);
  const w = worker(false);
  w.child.stdin.removeAllListeners("data");
  w.child.stdin.on("data", () => {
    w.child.stderr.write('Error: Failed to load extension "private/path": private error');
    w.child.emit("close", 1, null);
  });
  expect(await say()).toBeNull();
  expect(voice.problem(settings)).toMatch(/could not load a speech extension/i);
  expect(voice.problem(settings)).not.toContain("private");
});

it("frames RPC on LF even with Unicode separators, waits for settle, and discards unsupported claims", async () => {
  const { voice, say } = setup();
  voice.setWatching(true);
  const w = worker(false);
  const pending = say();
  await vi.waitFor(() => expect(w.frames).toHaveLength(2));
  const next = say();
  w.child.stdout.write('{"type":"extension","text":"split\u2028line');
  w.child.stdout.write('\u2029again"}\r\n');
  w.transmit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "I deployed the patch." }] }] });
  expect(w.frames).toHaveLength(2);
  w.transmit({ type: "agent_settled", aborted: false });
  expect(await pending).toBeNull();
  await vi.waitFor(() => expect(w.frames).toHaveLength(4));
  w.answer();
  expect(await next).toBe("The hearth still warms us.");
});

it("bounds its queue and drops expired or cancelled bubbles without counting them", async () => {
  const { voice, say } = setup();
  voice.setWatching(true);
  const w = worker(false), startTime = Date.now();
  const first = say();
  await vi.waitFor(() => expect(w.frames).toHaveLength(2));
  const reserve = vi.fn(() => true);
  const abort = new AbortController();
  const cancelled = say(scene, abort.signal, reserve), expired = say(scene, signal, reserve);
  expect(await say()).toBeNull();
  abort.abort();
  vi.spyOn(Date, "now").mockReturnValue(startTime + 10_100);
  w.answer();
  expect(await cancelled).toBeNull();
  expect(await expired).toBeNull();
  expect(await first).toBe("The hearth still warms us.");
  expect(w.frames).toHaveLength(2);
  expect(reserve).not.toHaveBeenCalled();
});

it("reports an unexpected exit without stderr, backs off, and restarts on the next eligible request", async () => {
  const { voice, say, invalidate } = setup();
  voice.setWatching(true);
  const w = worker();
  expect(await say()).not.toBeNull();
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  w.child.stderr.write("private credential error");
  w.child.emit("close", 1, null);
  expect(voice.problem(settings)).toMatch(/Pi stopped/i);
  expect(voice.problem(settings)).not.toContain("private");
  expect(invalidate).toHaveBeenCalled();
  expect(await say()).toBeNull();
  expect(start).toHaveBeenCalledTimes(1);
  vi.mocked(Date.now).mockReturnValue(now + 5_000);
  worker();
  expect(await say()).not.toBeNull();
  expect(start).toHaveBeenCalledTimes(2);
  expect(voice.problem(settings)).toBeNull();
});

it("closes the worker when speech is turned off or thinking changes and idles out without watchers", async () => {
  const { voice, say } = setup();
  voice.setWatching(true);
  const first = worker();
  await say();
  const changed = { ...settings, speechReasoning: "off" as const };
  await voice.refresh(changed);
  expect(first.child.stdin.writableEnded).toBe(true);
  const second = worker();
  expect(await voice.complete(scene, changed, signal, () => true)).not.toBeNull();
  expect(start.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(["--thinking", "off"]));
  await voice.refresh({ ...changed, contextualSpeech: false });
  expect(second.child.stdin.writableEnded).toBe(true);
  const third = worker();
  await say();
  await voice.stop();
  expect(third.child.stdin.writableEnded).toBe(true);
  const fourth = worker();
  await say();
  vi.useFakeTimers();
  voice.setWatching(false);
  await vi.advanceTimersByTimeAsync(599_999);
  expect(fourth.child.stdin.writableEnded).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(fourth.child.stdin.writableEnded).toBe(true);
});

it("unloads an actual stubborn child, including one with a request still in progress", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { voice, say } = setup();
  voice.setWatching(true);
  start.mockImplementationOnce((() => actual.spawn(process.execPath, ["-e",
    "process.stdin.resume(); process.stdout.write(JSON.stringify({type:'started'})+'\\n'); setInterval(() => {}, 1000);"],
    { stdio: "pipe" })) as unknown as typeof spawn);
  const pending = say();
  await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  const child = start.mock.results[0]!.value;
  const exited = once(child, "close");
  await voice.dispose();
  expect(await pending).toBeNull();
  expect(await exited).toEqual([null, "SIGKILL"]);
  expect(await say()).toBeNull();
});

it("falls back without starting Pi for off, missing or unknown model settings", async () => {
  const { voice } = setup();
  voice.setWatching(true);
  expect(await voice.complete(scene, { ...settings, contextualSpeech: false }, signal, () => true)).toBeNull();
  expect(await voice.complete(scene, { ...settings, piProgram: "/nonexistent/example/pi" }, signal, () => true)).toBeNull();
  expect(voice.problem({ ...settings, piProgram: "/nonexistent/example/pi" })).toMatch(/not executable/);
  expect(await voice.complete(scene, { ...settings, speechModel: "vendor/missing" }, signal, () => true)).toBeNull();
  expect(voice.problem({ ...settings, speechModel: "vendor/missing" })).toMatch(/not offered/);
  expect(start).not.toHaveBeenCalled();
});
