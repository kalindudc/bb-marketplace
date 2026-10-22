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

  it("README and the loom skill describe New project on the page, and the loom-plan skill knows a thread can start there", () => {
    expect(read("README.md")).toContain("New project");
    expect(read("skills/loom/SKILL.md")).toContain("New project");
    const plan = read("skills/loom-plan/SKILL.md");
    expect(plan).toContain("## When the Loom page started this thread");
    expect(plan).toContain("Loom page");
    expect(plan.indexOf("## When the Loom page started this thread")).toBeLessThan(plan.indexOf("## 1. Interview"));
  });

  it("README and the loom skill describe the home overview, the Agents tab and the metrics window", () => {
    const readme = read("README.md");
    for (const phrase of ["Needs you", "Agents", "--days", "flow efficiency"]) expect(readme, phrase).toContain(phrase);
    const skill = read("skills/loom/SKILL.md");
    for (const field of ["timeInState", "checksByCommand", "scopeFlags", "findings", "tokensByTicket", "reliability", "--days"]) expect(skill, field).toContain(field);
  });

  it("README and the loom skill describe the Planning chip, questions on the page and the rail count", () => {
    for (const path of ["README.md", "skills/loom/SKILL.md"]) {
      const text = read(path);
      for (const phrase of ["Planning", "Ask User Question", "rail"]) expect(text, `${path}: ${phrase}`).toContain(phrase);
    }
    expect(read("PLUGIN_OVERVIEW.md")).toContain("Ask User Question");
  });

  it("README and the loom skill describe the refusal and approval requeue, and the next-step bar", () => {
    for (const path of ["README.md", "skills/loom/SKILL.md"]) {
      const text = read(path);
      for (const phrase of ["never started", "next-step bar"]) expect(text, `${path}: ${phrase}`).toContain(phrase);
    }
    expect(read("README.md")).toContain("Click again to");
  });

  it("README and the loom skill say a reply on a blocked ticket reaches the planner, providers are checked, and approval sends a refused reviewer's ticket back to review", () => {
    for (const path of ["README.md", "skills/loom/SKILL.md"]) {
      const text = read(path).replace(/\s+/g, " ");
      for (const phrase of ["reply on a blocked ticket", "back to review", "bb provider id"]) expect(text, `${path}: ${phrase}`).toContain(phrase);
    }
    for (const path of ["skills/loom/references/spec.md", "skills/loom-plan/SKILL.md"]) expect(read(path), path).toContain("claude-code");
  });

  it("README and the skills describe the spec dashboard, its versions and notes for the planner", () => {
    const readme = read("README.md");
    for (const phrase of ["Files", "Shared files", "+ note", "superseded"]) expect(readme, phrase).toContain(phrase);
    const skill = read("skills/loom/SKILL.md");
    for (const phrase of ["Files", "Shared files", "superseded"]) expect(skill, phrase).toContain(phrase);
    for (const text of [readme, skill]) expect(text).not.toContain("Scope map");
    expect(read("skills/loom/references/spec.md")).toContain("older drafts are kept as superseded");
    expect(read("skills/loom-plan/SKILL.md")).toContain("[loom] The human reviewed spec");
    expect(read("PLUGIN_OVERVIEW.md")).toContain("+ note");
  });

  it("README and the loom skill describe the ticket page's stage tracker, attempts and Brief tab", () => {
    for (const path of ["README.md", "skills/loom/SKILL.md"]) for (const phrase of ["stage tracker", "Oldest first", "Brief tab"]) expect(read(path), `${path}: ${phrase}`).toContain(phrase);
  });

  it("README, the loom skill and the overview describe the direct land, and README and the skill the home page's search and switch", () => {
    for (const path of ["README.md", "skills/loom/SKILL.md"]) {
      expect(read(path), path).toContain("bb loom land <slug> --direct");
      expect(read(path), path).toContain("Hide done and archived");
    }
    expect(read("PLUGIN_OVERVIEW.md")).toContain("--direct");
  });

  it("README and the loom skill describe the Timeline and Back to now, and the overview the timeline", () => {
    for (const path of ["README.md", "skills/loom/SKILL.md"]) for (const phrase of ["Timeline", "Back to now"]) expect(read(path), `${path}: ${phrase}`).toContain(phrase);
    expect(read("PLUGIN_OVERVIEW.md")).toContain("A timeline on every project");
  });

  it("the README's safety rules name the default permission mode", () => {
    expect(read("README.md")).toMatch(/## Safety[\s\S]*full permission mode[\s\S]*## How it works/);
  });

  it("the skill names every command, says what the page and the metrics are, and forbids calling Loom's RPC", () => {
    const skill = read("skills/loom/SKILL.md");
    for (const command of commands) expect(skill, command).toContain(`bb loom ${command}`);
    for (const heading of ["## The Loom page", "## Metrics"]) expect(skill, heading).toContain(heading);
    expect(skill).toMatch(/NEVER call Loom's RPC/);
    expect(skill).toContain("bb plugin rpc");
  });
});
