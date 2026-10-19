import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commandsDir,
  fallbackInstructions,
  listCommands,
  parseCommand,
  piExpandsCommands,
  readCommand,
  searchCommands,
  type Command,
} from "../src/commands";

let home: string;
let dir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-commands-"));
  dir = commandsDir(home);
  mkdirSync(dir, { recursive: true });
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const command = (name: string, description: string): Command => ({ name, description, argumentHint: null, body: "" });

describe("parseCommand", () => {
  it("reads the description, the argument hint and the body", () => {
    const parsed = parseCommand("pickup", '---\ndescription: Resume a handover\nargument-hint: "<task-id>"\n---\n\nResume task $1.\n');
    expect(parsed).toEqual({ name: "pickup", description: "Resume a handover", argumentHint: "<task-id>", body: "Resume task $1." });
  });

  it("falls back to the first body line, cut to 60 characters like pi", () => {
    const parsed = parseCommand("long", `\n${"x".repeat(80)}\nmore`);
    expect(parsed.description).toBe(`${"x".repeat(59)}…`);
    expect(parsed.argumentHint).toBeNull();
  });
});

describe("listCommands", () => {
  it("lists top-level Markdown files by name, following symlinks", () => {
    writeFileSync(join(dir, "commit.md"), "---\ndescription: Commit\n---\nCommit it.");
    writeFileSync(join(home, "outside.md"), "Linked command");
    symlinkSync(join(home, "outside.md"), join(dir, "linked.md"));
    writeFileSync(join(dir, "notes.txt"), "not a command");
    writeFileSync(join(dir, ".gitkeep"), "");
    writeFileSync(join(dir, "bad:name.md"), "colon");
    mkdirSync(join(dir, "folder.md"));
    expect(listCommands(dir).map((c) => c.name)).toEqual(["commit", "linked"]);
  });

  it("returns nothing when the folder does not exist", () => {
    expect(listCommands(join(home, "missing"))).toEqual([]);
  });
});

describe("readCommand", () => {
  it("names the missing file when a picked command was deleted", () => {
    expect(() => readCommand(dir, "gone")).toThrow(`The command "gone" no longer exists: ${join(dir, "gone.md")} is missing`);
  });

  it("refuses names that could leave the folder", () => {
    expect(() => readCommand(dir, "../secret")).toThrow('"../secret" is not a command name');
  });
});

describe("searchCommands", () => {
  const commands = [command("commit", "Write a commit"), command("pr-desc", "Describe a PR"), command("recommit", "Redo a commit"), command("plan", "Plan the commit work")];

  it("ranks name prefixes, then name matches, then description matches", () => {
    expect(searchCommands(commands, "commit").map((c) => c.name)).toEqual(["commit", "recommit", "plan"]);
  });

  it("returns every command for an empty query", () => {
    expect(searchCommands(commands, " ").map((c) => c.name)).toEqual(["commit", "pr-desc", "recommit", "plan"]);
  });
});

describe("fallbackInstructions", () => {
  it("lists each command as /name with its description", () => {
    const text = fallbackInstructions([command("commit", "Write a commit")]);
    expect(text).toContain("read ~/.agents/commands/<name>.md");
    expect(text).toContain("- /commit: Write a commit");
  });

  it("stays within bb's 4096-character limit and says how many were left out", () => {
    const many = Array.from({ length: 200 }, (_, i) => command(`command-${i}`, "d".repeat(100)));
    const text = fallbackInstructions(many) ?? "";
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toMatch(/- …and \d+ more in ~\/\.agents\/commands$/);
  });

  it("contributes nothing without commands", () => {
    expect(fallbackInstructions([])).toBeNull();
  });
});

describe("piExpandsCommands", () => {
  it("is true when ~/.pi/agent/prompts links to the commands folder", () => {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    symlinkSync("../../.agents/commands", join(home, ".pi", "agent", "prompts"));
    expect(piExpandsCommands(home)).toBe(true);
  });

  it("is false when pi has its own prompts folder or none", () => {
    expect(piExpandsCommands(home)).toBe(false);
    mkdirSync(join(home, ".pi", "agent", "prompts"), { recursive: true });
    expect(piExpandsCommands(home)).toBe(false);
  });
});
