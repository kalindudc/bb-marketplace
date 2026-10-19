import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import agentCommands from "../server";

let home: string;
const realHome = process.env.HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-commands-home-"));
  process.env.HOME = home;
  mkdirSync(join(home, ".agents", "commands"), { recursive: true });
  writeFileSync(
    join(home, ".agents", "commands", "commit.md"),
    '---\ndescription: Write a commit message\nargument-hint: "[focus]"\n---\nCommit the staged changes. Focus: $ARGUMENTS\n',
  );
});

afterEach(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "agent-commands" });
  agentCommands(bb);
  return harness;
}

const configure = (harness: ReturnType<typeof setup>, providerId: string) =>
  harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ provider: { id: providerId } }));

describe("Agent Commands server", () => {
  it("offers the commands folder under the ! trigger", async () => {
    const [provider] = setup().inspection.registrations.mentionProviders;
    expect(provider).toMatchObject({ id: "commands", label: "Commands", triggers: ["!"] });
    const items = await provider.search({ trigger: "!", query: "com", projectId: null, threadId: null });
    expect(items).toEqual([{ id: "commit", title: "commit", subtitle: "[focus] · Write a commit message" }]);
  });

  it("reads a command again at send time and attaches its body", async () => {
    const [provider] = setup().inspection.registrations.mentionProviders;
    writeFileSync(join(home, ".agents", "commands", "commit.md"), "Edited after the menu opened. $ARGUMENTS");
    const { context } = await provider.resolve("commit");
    expect(context).toContain('The user ran the command "commit" from ~/.agents/commands/commit.md.');
    expect(context).toContain('<command name="commit">\nEdited after the menu opened. $ARGUMENTS\n</command>');
  });

  it("blocks the send when the picked command was deleted", async () => {
    const [provider] = setup().inspection.registrations.mentionProviders;
    rmSync(join(home, ".agents", "commands", "commit.md"));
    await expect(async () => provider.resolve("commit")).rejects.toThrow('The command "commit" no longer exists');
  });

  it("teaches non-pi agents to run typed /name commands", async () => {
    const { instructions, tools, skills } = await configure(setup(), "codex");
    expect(instructions).toContain("- /commit: Write a commit message");
    expect(tools).toEqual([]);
    expect(skills).toEqual([]);
  });

  it("leaves pi alone when pi already loads the folder as prompt templates", async () => {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    symlinkSync("../../.agents/commands", join(home, ".pi", "agent", "prompts"));
    expect((await configure(setup(), "pi")).instructions).toBeNull();
  });

  it("teaches pi too when its prompts folder is somewhere else", async () => {
    expect((await configure(setup(), "pi")).instructions).toContain("- /commit:");
  });
});
