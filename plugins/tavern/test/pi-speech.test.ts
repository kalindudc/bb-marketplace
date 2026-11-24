// @vitest-environment node
import { execFile } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import { PiSpeech } from "../src/server/pi-speech";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
const exec = vi.mocked(execFile);
const settings = { ...DEFAULT_SETTINGS.tavern, contextualSpeech: true, piProgram: process.execPath };
const scene = { role: "smith", stage: "work", moment: "assignment", revision: "private thread title", report: "private report" } as const;
const signal = new AbortController().signal;
const setup = (models = [{ model: "openai/gpt-5-nano" }]) => {
  const list = vi.fn(async () => ({ models }));
  const invalidate = vi.fn();
  const bb = { sdk: { providers: { models: list } }, rpc: { experimental_invalidate: invalidate } } as unknown as BbPluginApi;
  return { voice: new PiSpeech(bb, process.cwd()), list, invalidate };
};
function reply(stdout: string, error?: Error) {
  exec.mockImplementationOnce(((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
    callback(error ?? null, stdout);
    return { stdin: { end: vi.fn() } };
  }) as unknown as typeof execFile);
}
afterEach(() => vi.resetAllMocks());

it("uses only safe argv flags, the chosen model and enums, and accepts only validated stdout", async () => {
  const { voice, list } = setup();
  reply("The hearth still warms us.\n");
  expect(await voice.complete(scene, settings, signal, () => true)).toBe("The hearth still warms us.");
  expect(list).toHaveBeenCalledWith(expect.objectContaining({ providerId: "pi" }));
  const [file, args, options] = exec.mock.calls[0]!;
  expect(file).toBe(process.execPath);
  expect(args).toEqual(["-p", "--no-session", "--no-tools", "--no-mcp", "--no-skills", "--no-context-files",
    "--no-prompt-templates", "--offline", "--system-prompt", expect.any(String),
    "--model", "openai/gpt-5-nano", "--thinking", "low", "--",
    expect.stringMatching(/Role: smith; stage: work; change: assignment\.$/)]);
  expect(JSON.stringify(args)).not.toMatch(/private/);
  expect(options).toMatchObject({ shell: false, timeout: 10_000, killSignal: "SIGKILL" });
  reply("I deployed the patch.");
  expect(await voice.complete(scene, settings, signal, () => true)).toBeNull();
  expect(list).toHaveBeenCalledTimes(1);
});

it("falls back without starting Pi for an off, missing, unknown, or over-quota setting", async () => {
  const { voice } = setup();
  expect(await voice.complete(scene, { ...settings, contextualSpeech: false }, signal, () => true)).toBeNull();
  expect(await voice.complete(scene, { ...settings, piProgram: "/nonexistent/example/pi" }, signal, () => true)).toBeNull();
  expect(voice.problem({ ...settings, piProgram: "/nonexistent/example/pi" })).toMatch(/not found|not executable/);
  expect(await voice.complete(scene, { ...settings, speechModel: "vendor/missing" }, signal, () => true)).toBeNull();
  expect(voice.problem({ ...settings, speechModel: "vendor/missing" })).toMatch(/not offered/);
  expect(await voice.complete(scene, settings, signal, () => false)).toBeNull();
  expect(exec).not.toHaveBeenCalled();
});

it("surfaces a safe sign-in or model problem without revealing stderr and clears it on success", async () => {
  const { voice, invalidate } = setup();
  reply("Unwanted output.", new Error("private credential error"));
  expect(await voice.complete(scene, settings, signal, () => true)).toBeNull();
  expect(voice.problem(settings)).toMatch(/signed in/i);
  expect(voice.problem(settings)).not.toContain("private");
  expect(invalidate).toHaveBeenCalled();
  reply("The hearth still warms us.");
  expect(await voice.complete(scene, settings, signal, () => true)).toBe("The hearth still warms us.");
  expect(voice.problem(settings)).toBeNull();
});

it("aborts the subprocess on disposal without publishing its reply", async () => {
  const { voice } = setup();
  exec.mockImplementationOnce(((_file: string, _args: string[], options: { signal: AbortSignal }, callback: (error: Error) => void) => {
    options.signal.addEventListener("abort", () => callback(new Error("Aborted")), { once: true });
    return { stdin: { end: vi.fn() } };
  }) as unknown as typeof execFile);
  const pending = voice.complete(scene, settings, signal, () => true);
  await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
  await voice.dispose();
  expect(await pending).toBeNull();
  expect(voice.problem(settings)).toBeNull();
});
