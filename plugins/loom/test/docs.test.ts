import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCli } from "../src/cli";
import { ORDINARY_TOOLS, PLANNER_TOOLS, REVIEWER_TOOLS, SKILLS, WORKER_TOOLS } from "../src/tools";
import { makeHost } from "./helpers";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const host = makeHost();
const commands = createCli(host.projects, host.engine, host.store, Date.now).commands!.map((command) => command.name);
const tools = [...new Set([...ORDINARY_TOOLS, ...PLANNER_TOOLS, ...WORKER_TOOLS, ...REVIEWER_TOOLS])];

describe("the plugin's own documents", () => {
  it("declares skill roots the way bb reads them, so configure() can select every skill", () => {
    // bb reads each manifest skills entry as a directory of skill directories; a skill directory itself loads nothing.
    const roots: string[] = JSON.parse(read("package.json")).bb.skills;
    const found = roots.flatMap((root) =>
      readdirSync(new URL(`../${root}/`, import.meta.url), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(new URL(`../${root}/${entry.name}/SKILL.md`, import.meta.url)))
        .map((entry) => entry.name),
    );
    for (const id of Object.values(SKILLS)) expect(found, id).toContain(id);
  });

  it("README names every bb loom command and every agent tool", () => {
    const readme = read("README.md");
    expect(commands.length).toBeGreaterThanOrEqual(17);
    for (const command of commands) expect(readme, command).toContain(`bb loom ${command}`);
    for (const tool of tools) expect(readme, tool).toContain(tool);
  });

  it("README describes the page, the metrics and the safety rules", () => {
    const readme = read("README.md");
    for (const heading of ["## The page", "## Metrics", "## Safety"]) expect(readme, heading).toContain(heading);
    expect(readme).not.toMatch(/last step|third of four|comes in the last/);
  });

  it("PLUGIN_OVERVIEW is under 4000 characters and has no title", () => {
    const overview = read("PLUGIN_OVERVIEW.md");
    expect(overview.length).toBeLessThan(4000);
    expect(overview).not.toMatch(/^# /m);
    expect(overview).toContain("git");
    expect(overview).toContain("gh");
  });

  it("the skill names every command, says what the page and the metrics are, and forbids calling Loom's RPC", () => {
    const skill = read("skills/loom/SKILL.md");
    for (const command of commands) expect(skill, command).toContain(`bb loom ${command}`);
    for (const heading of ["## The Loom page", "## Metrics"]) expect(skill, heading).toContain(heading);
    expect(skill).toMatch(/NEVER call Loom's RPC/);
    expect(skill).toContain("bb plugin rpc");
  });
});
