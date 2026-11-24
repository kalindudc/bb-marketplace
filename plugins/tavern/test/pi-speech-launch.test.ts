// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PiSpeech } from "../src/server/pi-speech";
import { DEFAULT_SETTINGS } from "../src/shared/settings";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.unstubAllEnvs();
});

function fixture(mode: "accept" | "refuse" | "broken" | "silent") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tavern-speech-launch-")));
  const data = join(root, "data"), normal = join(root, "normal"), launches = join(root, "launches");
  mkdirSync(data);
  mkdirSync(join(normal, "extensions"), { recursive: true });
  for (const name of ["auth.json", "models.json", "settings.json", "extensions/ordinary.js"]) writeFileSync(join(normal, name), "{}");
  vi.stubEnv("PI_CODING_AGENT_DIR", normal);
  const pi = (name: string) => {
    const file = join(root, name);
    writeFileSync(file, `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(launches)}, JSON.stringify({ file: process.argv[1], args, cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR }) + '\\n');
const mode = ${JSON.stringify(mode)};
if (mode === 'silent' && args.includes('--version')) {
  setInterval(() => {}, 1_000);
} else if (mode === 'broken' || (mode === 'refuse' && args.includes('--no-extensions'))) {
  const reason = mode === 'refuse' ? 'Refusing --no-extensions: this device requires an extension.' : 'The launcher could not start. ' + 'x'.repeat(200);
  process.stderr.write('\\x1b[31m' + reason + '\\x1b[0m\\r\\nDo not display this second line.\\n');
  process.exitCode = 1;
} else if (args.includes('--version')) {
  process.stdout.write('1.0.0\\n');
} else {
  const send = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
  createInterface({ input: process.stdin }).on('line', line => {
    const { id, type } = JSON.parse(line);
    send({ id, type: 'response', command: type, success: true, data: type === 'new_session' ? { cancelled: false } : { disposition: 'started' } });
    if (type !== 'prompt') return;
    send({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'The hearth still warms us.' }] }] });
    send({ type: 'agent_settled', aborted: false });
  });
}
`, { mode: 0o700 });
    return file;
  };
  const settings = { ...DEFAULT_SETTINGS.tavern, contextualSpeech: true, piProgram: pi("pi") };
  const invalidate = vi.fn();
  const bb = { sdk: { providers: { models: async () => ({ models: [{ model: settings.speechModel }] }) } },
    rpc: { experimental_invalidate: invalidate } } as unknown as BbPluginApi;
  const voice = new PiSpeech(bb, data);
  cleanup.push(async () => { await voice.dispose(); rmSync(root, { recursive: true, force: true }); });
  const calls = (): { file: string; args: string[]; cwd: string; agentDir: string }[] =>
    readFileSync(launches, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const scene = { role: "keeper", stage: "work", moment: "click" } as const;
  const say = (config = settings, signal = new AbortController().signal, reserve = () => true) => voice.complete(scene, config, signal, reserve);
  voice.setWatching(true);
  return { voice, root, data, normal, settings, invalidate, say, calls, pi };
}

it("probes once for a worker configuration and keeps the ordinary Pi launch unchanged", async () => {
  const { voice, say, settings, calls, normal, data, pi } = fixture("accept");
  expect(await say()).toBe("The hearth still warms us.");
  await voice.stop();
  expect(await say()).toBe("The hearth still warms us.");
  let launched = calls();
  expect(launched).toHaveLength(3);
  expect(launched[0]).toMatchObject({ file: settings.piProgram, args: ["--no-extensions", "--version"], cwd: data });
  expect(launched.slice(1)).toEqual(Array(2).fill(expect.objectContaining({ file: settings.piProgram, cwd: data, agentDir: normal,
    args: expect.arrayContaining(["--mode", "rpc", "--no-session", "--no-tools", "--no-mcp", "--no-extensions"]) })));
  const changed = { ...settings, speechReasoning: "high" as const };
  expect(await say(changed)).toBe("The hearth still warms us.");
  expect(await say({ ...changed, piProgram: pi("other-pi") })).toBe("The hearth still warms us.");
  launched = calls();
  expect(launched.filter(call => call.args.includes("--version")).map(call => call.file)).toEqual([settings.piProgram, settings.piProgram, join(normal, "..", "other-pi")]);
});

it("on refusal links only auth and models and disables only Pi's built-in extensions", async () => {
  const { voice, say, settings, calls, normal, data } = fixture("refuse");
  const extension = join(normal, "extensions", "ordinary.js");
  const configured = { ...settings, speechExtensions: [extension] };
  expect(await say(configured)).toBe("The hearth still warms us.");
  const [probe, worker] = calls();
  expect(probe?.args).toEqual(["--no-extensions", "--version"]);
  expect(worker).toMatchObject({ file: settings.piProgram, cwd: data });
  expect(worker!.args).not.toContain("--no-extensions");
  expect(worker!.args).toEqual(["--mode", "rpc", "--no-session", "--no-tools", "--no-mcp", "--no-skills", "--no-context-files",
    "--no-prompt-templates", "--offline", "--system-prompt", settings.speechInstructions, "--model", settings.speechModel,
    "--thinking", "low", "-e", extension]);
  expect(worker!.agentDir.startsWith(data + "/")).toBe(true);
  expect(readdirSync(worker!.agentDir).sort()).toEqual(["auth.json", "models.json", "settings.json"]);
  expect(JSON.parse(readFileSync(join(worker!.agentDir, "settings.json"), "utf8"))).toEqual({
    extensions: ["-builtin:mcp", "-builtin:codemode", "-builtin:tool-search", "-builtin:llama.cpp"],
  });
  expect(readlinkSync(join(worker!.agentDir, "auth.json"))).toBe(join(normal, "auth.json"));
  expect(readlinkSync(join(worker!.agentDir, "models.json"))).toBe(join(normal, "models.json"));
  await voice.stop();
  expect(await say(configured)).toBe("The hearth still warms us.");
  expect(calls().slice(2)).toEqual([worker]);
  await voice.dispose();
  expect(existsSync(worker!.agentDir)).toBe(false);
  expect(readFileSync(join(normal, "auth.json"), "utf8")).toBe("{}");
});

it("uses the default Pi config location and skips a missing optional file", async () => {
  const { say, calls, root } = fixture("refuse");
  const defaultDir = join(root, ".pi", "agent");
  mkdirSync(defaultDir, { recursive: true });
  writeFileSync(join(defaultDir, "auth.json"), "{}");
  vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
  vi.stubEnv("HOME", root);
  expect(await say()).toBe("The hearth still warms us.");
  const directory = calls()[1]!.agentDir;
  expect(readdirSync(directory).sort()).toEqual(["auth.json", "settings.json"]);
  expect(readlinkSync(join(directory, "auth.json"))).toBe(join(defaultDir, "auth.json"));
});

it("does not loosen extension isolation after an unrelated probe failure and reports the first startup stderr line", async () => {
  const { voice, say, settings, calls, invalidate } = fixture("broken");
  const reserve = vi.fn(() => true);
  expect(await say(settings, undefined, reserve)).toBeNull();
  expect(reserve).not.toHaveBeenCalled();
  expect(calls()).toHaveLength(2);
  expect(calls()[1]?.args).toContain("--no-extensions");
  const message = voice.problem(settings)!;
  expect(message).toMatch(/^Pi refused to start: The launcher could not start\. x+$/);
  expect(message.length).toBeLessThanOrEqual(181);
  expect(invalidate).toHaveBeenCalledWith(["tavern:settings"]);
});

it("bounds an unresponsive version probe and does not treat that as an extension refusal", async () => {
  const { say, calls, normal } = fixture("silent");
  expect(await say()).toBe("The hearth still warms us.");
  expect(calls()).toHaveLength(2);
  expect(calls()[0]?.args).toContain("--version");
  expect(calls()[1]?.args).toContain("--no-extensions");
  expect(calls()[1]?.agentDir).toBe(normal);
}, 6_000);
