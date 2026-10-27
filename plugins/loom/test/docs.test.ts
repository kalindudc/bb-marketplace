import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCli } from "../src/cli";
import { parseSpec, proposalErrorsOf } from "../src/spec";
import { MACHINE_WORKER_TOOLS, ORDINARY_TOOLS, PLANNER_TOOLS, REVIEWER_TOOLS, SKILLS, SPEC_REVIEWER_TOOLS, WORKER_TOOLS } from "../src/tools";
import { makeHost } from "./helpers";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const host = makeHost();
const commands = createCli(host.projects, host.engine, host.store, Date.now).commands!.map((command) => command.name);
const tools = [...new Set([...ORDINARY_TOOLS, ...PLANNER_TOOLS, ...WORKER_TOOLS, ...REVIEWER_TOOLS, ...SPEC_REVIEWER_TOOLS])];

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

  it("the spec reference, the skills and README describe relying on CI, its ci key and the forge it needs", () => {
    const spec = read("skills/loom/references/spec.md");
    for (const phrase of ["| `ci` | boolean | `true` |", "| `ci` | boolean | `checks.ci` |", "### Relying on CI", "`ci = false`", "feedback = \'\'\'", "dt pr checks"]) expect(spec, phrase).toContain(phrase);
    for (const path of ["README.md", "skills/loom/SKILL.md", "skills/loom-plan/SKILL.md"]) {
      const text = read(path);
      for (const phrase of ["`ci = false`", "CI"]) expect(text, `${path}: ${phrase}`).toContain(phrase);
    }
  });

  it("the spec reference, the planner skill and README describe git_network_timeout_seconds for slow repositories", () => {
    const spec = read("skills/loom/references/spec.md");
    for (const phrase of ["| `git_network_timeout_seconds` | integer | `120` |", "| `git_network_timeout_seconds` | integer | `merge.git_network_timeout_seconds` |", "### Slow repositories", "git_network_timeout_seconds = 300"]) expect(spec, phrase).toContain(phrase);
    for (const path of ["README.md", "skills/loom-plan/SKILL.md"]) expect(read(path), path).toContain("git_network_timeout_seconds");
  });

  it("README and the loom skill describe the report and the done hook", () => {
    for (const path of ["README.md", "skills/loom/SKILL.md"]) {
      const text = read(path);
      for (const phrase of ["bb loom report", "done hook"]) expect(text, `${path}: ${phrase}`).toContain(phrase);
    }
    const readme = read("README.md");
    for (const phrase of ["doneHook", "doneRecord", "LOOM_PROJECT_SLUG", "LOOM_PROJECT_NAME", "LOOM_PROJECT_KEY", "LOOM_PROJECT_URL", "LOOM_RECORD"]) expect(readme, phrase).toContain(phrase);
  });

  it("names no notes tool outside the README: the done hook is the user's command", () => {
    const sources = readdirSync(new URL("../src/", import.meta.url), { recursive: true, encoding: "utf8" })
      .filter((path) => /\.tsx?$/.test(path))
      .map((path) => `src/${path}`);
    const skills = readdirSync(new URL("../skills/", import.meta.url), { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".md"))
      .map((path) => `skills/${path}`);
    for (const path of [...sources, ...skills, "server.ts", "host.ts", "app.tsx"]) expect(read(path), path).not.toMatch(/cortex/i);
  });

  it("README and the loom skill describe the spec review and its override, and the loom-plan skill waits for it", () => {
    for (const path of ["README.md", "skills/loom/SKILL.md"]) {
      const text = read(path);
      for (const phrase of ["spec review", "--skip-review", ...SPEC_REVIEWER_TOOLS]) expect(text, `${path}: ${phrase}`).toContain(phrase);
    }
    const plan = read("skills/loom-plan/SKILL.md");
    for (const phrase of ["spec review", "[loom] Spec review", "Hand over only after"]) expect(plan, phrase).toContain(phrase);
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

  it("README and the loom skill describe the Insights tab, and neither names a Feed or Metrics tab", () => {
    for (const path of ["README.md", "skills/loom/SKILL.md"]) {
      const text = read(path);
      for (const phrase of ["Insights", "Right now", "Every event", "Latest run", "pull request opens"]) expect(text.replace(/\s+/g, " "), `${path}: ${phrase}`).toContain(phrase === "pull request opens" && path.endsWith("SKILL.md") ? "times a ticket to its pull request" : phrase);
      expect(text, path).not.toMatch(/Feed tab|Metrics tab|a Feed of events|Agents, Feed and Metrics|day window for throughput/);
    }
    expect(read("PLUGIN_OVERVIEW.md")).toContain("Insights tab");
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

  it("README and the skills describe the spec page's files and versions, the Planner page and the planner's asks", () => {
    const readme = read("README.md");
    for (const phrase of ["Files", "Shared files", "+ note", "superseded", "What happened", "loom_ask_human", "R1, R2"]) expect(readme, phrase).toContain(phrase);
    const skill = read("skills/loom/SKILL.md");
    for (const phrase of ["Files", "Shared files", "superseded", "What happened", "loom_ask_human", "R1, R2"]) expect(skill, phrase).toContain(phrase);
    for (const text of [readme, skill, read("PLUGIN_OVERVIEW.md")]) expect(text).not.toContain("dashboard");
    expect(read("skills/loom-plan/SKILL.md")).toContain("loom_ask_human");
    for (const text of [readme, skill]) expect(text).not.toContain("Scope map");
    expect(read("skills/loom/references/spec.md")).toContain("older drafts are kept as superseded");
    expect(read("skills/loom-plan/SKILL.md")).toContain("[loom] The human reviewed spec");
    expect(read("PLUGIN_OVERVIEW.md")).toContain("+ note");
  });

  it("README and the loom skill describe the ticket page's stage tracker, attempts and Brief tab", () => {
    for (const path of ["README.md", "skills/loom/SKILL.md"]) for (const phrase of ["stage tracker", "Oldest first", "Brief tab"]) expect(read(path), `${path}: ${phrase}`).toContain(phrase);
  });

  it("README, the loom skill and the overview describe the direct land, and README and the skill the home page's search and Finished group", () => {
    for (const path of ["README.md", "skills/loom/SKILL.md"]) {
      expect(read(path), path).toContain("bb loom land <slug> --direct");
      expect(read(path), path).toContain("Finished");
    }
    expect(read("PLUGIN_OVERVIEW.md")).toContain("--direct");
  });

  it("README and the loom skill describe the Timeline and Back to now, and the overview the timeline", () => {
    for (const path of ["README.md", "skills/loom/SKILL.md"]) for (const phrase of ["Timeline", "Back to now"]) expect(read(path), `${path}: ${phrase}`).toContain(phrase);
    expect(read("PLUGIN_OVERVIEW.md")).toContain("A timeline on every project");
  });

  it("the spec reference documents [[repo]], ticket.repo and the repo errors, and every example spec parses", () => {
    const spec = read("skills/loom/references/spec.md");
    const table = spec.slice(spec.indexOf("### [[repo]]"), spec.indexOf("### [[ticket]]"));
    expect(table).toContain("### [[repo]]");
    for (const key of ["name", "project", "base", "remote", "checks", "after_merge", "protected"]) expect(table, key).toContain(`| \`${key}\` |`);
    expect(spec).toMatch(/^\| `repo` \| string \|/m);
    for (const phrase of ["the same `name`", "has no `repo`", "bb project source add <id> --clone --machine <host>", "removes or renames an approved repo"]) expect(spec, phrase).toContain(phrase);

    const examples = [...spec.matchAll(/```toml\n([\s\S]*?)```/g)].map((match) => parseSpec(match[1]!));
    expect(examples.length).toBeGreaterThanOrEqual(2);
    for (const example of examples) expect(example.errors).toEqual([]);
    // Planners copy these, so each one must be a spec loom_propose takes, summary included.
    for (const example of examples) expect(proposalErrorsOf(example.spec!)).toEqual([]);
    const multi = examples.find((example) => (example.spec?.repo?.length ?? 0) >= 2)!.spec!;
    const repoOf = new Map(multi.ticket.map((ticket) => [ticket.ref, ticket.repo]));
    expect(multi.ticket.some((ticket) => ticket.depends_on.some((ref) => repoOf.get(ref) !== ticket.repo))).toBe(true);
  });

  it("the spec reference, the skills and README describe threads on new machines, with their keys and tools", () => {
    const spec = read("skills/loom/references/spec.md");
    for (const phrase of ["| `machine` |", "### Threads on new machines", "`merge.stack = false`", "loom/<slug>/<key>-home", "refs/loom/<slug>/<key>/reviewed", "machine_provider_rejected", "machine_maintenance", "loom_resume", "loom_checkout", "#### Stacked pull requests on new machines", "#### Moving a running project onto machines, or off them", "conflict check"]) expect(spec, phrase).toContain(phrase);
    const example = [...spec.matchAll(/```toml\n([\s\S]*?)```/g)].map((match) => parseSpec(match[1]!).spec!).find((each) => each.environment?.machine !== undefined);
    expect(example?.environment?.machine).toBeDefined();
    for (const tool of [...MACHINE_WORKER_TOOLS, ...REVIEWER_TOOLS]) {
      expect(read("skills/loom/SKILL.md"), tool).toContain(tool);
      expect(read("README.md"), tool).toContain(tool);
    }
    const plan = read("skills/loom-plan/SKILL.md");
    for (const phrase of ["New machine per thread", "Earlier picks", "on every project", "confirm it with the human", "works on that machine"]) expect(plan, phrase).toContain(phrase);
  });

  it("the loom-plan skill says how to find repos, offers to clone a missing checkout, and splits cross-repo work per repo", () => {
    const plan = read("skills/loom-plan/SKILL.md");
    for (const phrase of ["bb project list", "bb project discover", "--clone", "bb project create --root <path> --machine <host>", "only after they agree", "one ticket per repo", "starting point, not a limit"]) {
      expect(plan, phrase).toContain(phrase);
    }
  });

  it("README and the loom skill describe multi-repo projects, landing one repo with --repo and the repo picker", () => {
    for (const path of ["README.md", "skills/loom/SKILL.md"]) {
      const text = read(path).replace(/\s+/g, " ");
      for (const phrase of ["## Multi-repo projects", "--repo", "one merge at a time per project", "repo picker", "every repo with merged work has landed"]) expect(text, `${path}: ${phrase}`).toContain(phrase);
    }
    expect(read("PLUGIN_OVERVIEW.md")).toContain("[[repo]]");
  });

  it("README and the loom skill describe the Changes tab's per-repo sections and the multi-repo done hook", () => {
    for (const path of ["README.md", "skills/loom/SKILL.md"]) {
      const text = read(path).replace(/\s+/g, " ");
      for (const phrase of ["one section per repo", "that repo's remote base", "lands that repo alone", "LOOM_PROJECT_URLS", "one per line"]) expect(text, `${path}: ${phrase}`).toContain(phrase);
    }
    const readme = read("README.md");
    const hook = readme.slice(readme.indexOf("## When a project finishes"), readme.indexOf("## Safety"));
    expect(hook).toContain("LOOM_PROJECT_URLS");
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
