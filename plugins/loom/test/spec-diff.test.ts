import { describe, expect, it } from "vitest";
import { parseSpec } from "../src/spec";
import { listSteps, operationalChanges, sectionOf, specDiff, textSteps, touches, type SpecChange } from "../src/spec-diff";
import { specChanges } from "../src/spec-paths";
import { specToml, type Doc } from "./helpers";

const spec = (edit?: (doc: Doc) => void) => parseSpec(specToml(edit)).spec!;
const base = spec();
const brief = (change: SpecChange) => ({ path: change.path, kind: change.kind });

describe("specDiff", () => {
  it("finds nothing between equal specs, or when only the tickets' order changed", () => {
    expect(specDiff(base, spec())).toEqual([]);
    expect(specDiff(base, spec((doc) => doc.ticket.reverse()))).toEqual([]);
  });

  it("gives a changed setting its old and new value, and a setting that was not set as undefined", () => {
    expect(specDiff(base, spec((doc) => (doc.agents.max_workers = 4)))).toEqual([{ path: "agents.max_workers", section: "settings", ref: null, kind: "value", before: 2, after: 4 }]);
    expect(specDiff(base, spec((doc) => (doc.budget = { deadline: "2026-12-31" })))).toEqual([{ path: "budget.deadline", section: "settings", ref: null, kind: "value", before: undefined, after: "2026-12-31" }]);
  });

  it("diffs a list of strings item by item, a rewritten item as a removal before its replacement", () => {
    const [change] = specDiff(base, spec((doc) => (doc.ticket[1].acceptance[1] = "WHEN there are no orders THE SYSTEM SHALL return an empty file")));
    expect(change).toMatchObject({ path: "ticket[csv-export].acceptance", section: "tickets", ref: "csv-export", kind: "list", added: 1, removed: 1 });
    expect(change!.kind === "list" && change.steps.map((step) => [step.op, step.index])).toEqual([
      ["same", 0],
      ["removed", 1],
      ["added", 1],
    ]);
  });

  it("counts the items added to and removed from a list", () => {
    expect(listSteps(["a", "b", "c"], ["b", "c", "d", "e"])).toEqual([
      { op: "removed", value: "a", index: 0 },
      { op: "same", value: "b", index: 0 },
      { op: "same", value: "c", index: 1 },
      { op: "added", value: "d", index: 2 },
      { op: "added", value: "e", index: 3 },
    ]);
    const [change] = specDiff(base, spec((doc) => (doc.checks.commands = ["npm ci", "npm test", "npm run lint"])));
    expect(change).toMatchObject({ path: "checks.commands", kind: "list", added: 2, removed: 0 });
  });

  it("diffs a brief and the goal word by word, whatever their length", () => {
    const changes = specDiff(base, spec((doc) => ((doc.ticket[0].body = "Build the order row mapper."), (doc.project.goal = "Let people export their orders as a CSV file from the orders page."))));
    expect(changes.map(brief)).toEqual([
      { path: "ticket[csv-model].body", kind: "text" },
      { path: "project.goal", kind: "text" },
    ]);
    expect(changes.map((change) => change.section)).toEqual(["tickets", "guardrails"]);
    expect(textSteps("Build the row mapper.", "Build the order row mapper.")).toEqual([
      { op: "same", text: "Build the " },
      { op: "added", text: "order " },
      { op: "same", text: "row mapper." },
    ]);
  });

  it("falls back to lines for texts too long to diff word by word", () => {
    const long = (word: string) => Array.from({ length: 2100 }, (_, index) => (index % 20 === 19 ? `${word}\n` : `${word} `)).join("");
    const steps = textSteps(long("a"), `${long("a")}one more line\n`);
    expect(steps).toEqual([
      { op: "same", text: long("a") },
      { op: "added", text: "one more line\n" },
    ]);
  });

  it("lists a new ticket once, with the removed tickets it takes files over from, and a removed ticket with the tickets that share its files", () => {
    const after = spec((doc) => {
      doc.ticket[1] = { ...doc.ticket[1], ref: "csv-stream", title: "Stream the export" };
      doc.ticket.push({ ref: "csv-docs", title: "Docs", body: "Write the docs.", acceptance: ["WHEN read THE DOCS SHALL explain the export"], scope: ["docs/**"] });
    });
    expect(specDiff(base, after)).toEqual([
      { path: "ticket[csv-stream]", section: "tickets", ref: "csv-stream", kind: "ticket-added", from: ["csv-export"] },
      { path: "ticket[csv-docs]", section: "tickets", ref: "csv-docs", kind: "ticket-added", from: [] },
      { path: "ticket[csv-export]", section: "tickets", ref: "csv-export", kind: "ticket-removed", into: ["csv-stream"] },
    ]);
  });

  it("does not pair tickets of different repos that list the same path", () => {
    const repos = (doc: Doc) => {
      doc.repo = [
        { name: "web", project: "proj_web" },
        { name: "api", project: "proj_api" },
      ];
      doc.ticket[0].repo = "web";
      doc.ticket[1].repo = "api";
      doc.ticket[1].scope = ["src/model/**"];
    };
    const after = spec((doc) => {
      repos(doc);
      doc.ticket[1] = { ...doc.ticket[1], ref: "csv-api", depends_on: ["csv-web"] };
      doc.ticket[0] = { ...doc.ticket[0], ref: "csv-web" };
    });
    const changes = specDiff(spec(repos), after);
    expect(changes.filter((change) => change.kind === "ticket-added")).toEqual([
      { path: "ticket[csv-web]", section: "tickets", ref: "csv-web", kind: "ticket-added", from: ["csv-model"] },
      { path: "ticket[csv-api]", section: "tickets", ref: "csv-api", kind: "ticket-added", from: ["csv-export"] },
    ]);
  });

  it("orders the settings, then the tickets, then the goal and guardrails", () => {
    const after = spec((doc) => {
      doc.project.non_goals = ["No PDF export"];
      doc.ticket[0].title = "Order row mapper";
      doc.review = { max_rounds: 5 };
    });
    expect(specDiff(base, after).map((change) => [change.section, change.path])).toEqual([
      ["settings", "review.max_rounds"],
      ["tickets", "ticket[csv-model].title"],
      ["guardrails", "project.non_goals"],
    ]);
  });

  it("covers every path specChanges names, and names nothing it does not", () => {
    const edits: Array<(doc: Doc) => void> = [
      (doc) => (doc.agents.worker.model = "opus"),
      (doc) => (doc.ticket[1].acceptance = [doc.ticket[1].acceptance[0]]),
      (doc) => doc.ticket.pop(),
      (doc) => doc.ticket.push({ ref: "csv-docs", title: "Docs", body: "Write the docs.", acceptance: ["WHEN read THE DOCS SHALL explain the export"], scope: ["docs/**"], depends_on: ["csv-export"] }),
      (doc) => ((doc.checks.after_merge = ["npm run e2e"]), (doc.scope = { protected: ["package-lock.json"], enforce: "reject" })),
      (doc) => ((doc.repo = [{ name: "web", project: "proj_web", checks: ["npm test"] }]), doc.ticket.forEach((ticket: Doc) => (ticket.repo = "web"))),
      (doc) => ((doc.project.goal = "Let people export every order as a CSV file from the admin page, filtered by date."), (doc.ticket[0].priority = 0)),
    ];
    for (const edit of edits) {
      const after = spec(edit);
      const changes = specDiff(base, after);
      const { changed, removed } = specChanges(base, after);
      for (const path of changed) expect(changes.some((change) => touches(change, path)), path).toBe(true);
      for (const ref of removed) expect(changes.some((change) => change.kind === "ticket-removed" && change.ref === ref), ref).toBe(true);
      for (const change of changes) expect(change.kind === "ticket-removed" || changed.some((path) => touches(change, path)), change.path).toBe(true);
    }
  });
});

describe("sectionOf", () => {
  it("puts tickets, the goal and guardrails, and everything else in their sections", () => {
    expect(["ticket[a].scope[0]", "project.goal", "project.non_goals[2]", "review.rubric", "project.base", "review.approvals", "merge.strategy"].map(sectionOf)).toEqual(["tickets", "guardrails", "guardrails", "guardrails", "settings", "settings", "settings"]);
  });
});

describe("operationalChanges", () => {
  const repos = (doc: Doc) => {
    doc.merge = { strategy: "pr" };
    doc.repo = [
      { name: "web", project: "proj_web" },
      { name: "api", project: "proj_api", base: "trunk" },
    ];
    doc.ticket[0].repo = "web";
    doc.ticket[1].repo = "api";
    doc.ticket[1].depends_on = [];
  };
  const multi = spec(repos);
  const onPr = (doc: Doc) => {
    doc.merge = { strategy: "pr" };
    doc.environment = { provider: "example-env", inputs: { size: "small" } };
  };
  const prBase = spec(onPr);
  const changed = (edit: (doc: Doc) => void, from = base, setup?: (doc: Doc) => void) =>
    operationalChanges(
      from,
      spec((doc) => {
        setup?.(doc);
        edit(doc);
      }),
    );

  it("lists the paths of a version that changes only forge, environments, agents, budget, merge settings other than the strategy, branch and remote, the checks' timeout and CI", () => {
    expect(changed((doc) => (doc.merge.forge = { kind: "command", open: "open.sh", state: "state.sh", feedback: "feedback.sh" }))).toEqual(["merge.forge.kind", "merge.forge.open", "merge.forge.state", "merge.forge.feedback"]);
    expect(changed((doc) => Object.assign(doc.agents, { max_workers: 4, worker: { provider: "pi", model: "m" } }))).toEqual(["agents.max_workers", "agents.worker.provider", "agents.worker.model"]);
    expect(changed((doc) => (doc.budget = { max_tokens: 9_000_000, deadline: "2030-01-01" }))).toEqual(["budget.max_tokens", "budget.deadline"]);
    expect(changed((doc) => (doc.environment = { provider: "git-worktree", inputs: { size: "large" } }))).toEqual(["environment.provider", "environment.inputs.size"]);
    expect(changed((doc) => Object.assign(doc.merge, { draft: false, max_fix_rounds: 8, checks_queued_minutes: 10 }), prBase, onPr)).toEqual(["merge.draft", "merge.max_fix_rounds", "merge.checks_queued_minutes"]);
    expect(changed((doc) => (doc.merge.worktree = { command: "prepare.sh" }))).toEqual(["merge.worktree.command"]);
    expect(changed((doc) => Object.assign(doc.checks, { timeout_minutes: 25, ci: false }), prBase, onPr)).toEqual(["checks.timeout_minutes", "checks.ci"]);
    expect(changed((doc) => (doc.ticket[1].environment = { inputs: { size: "large" } }), prBase, onPr)).toEqual(["ticket[csv-export].environment.inputs.size"]);
    expect(changed((doc) => Object.assign(doc.repo[1], { forge: { kind: "gh" }, ci: false, environment: { provider: "git-worktree" } }), multi, repos)).toEqual(["repo[1].ci", "repo[1].forge.kind", "repo[1].environment.provider"]);
    expect(changed((doc) => Object.assign(doc.merge, { refresh_behind: 5000 }), multi, repos)).toEqual(["merge.refresh_behind"]);
    expect(changed((doc) => (doc.repo[0].refresh_behind = 200), multi, repos)).toEqual(["repo[0].refresh_behind"]);
    expect(changed((doc) => (doc.merge.git_network_timeout_seconds = 300))).toEqual(["merge.git_network_timeout_seconds"]);
    expect(changed((doc) => (doc.repo[1].git_network_timeout_seconds = 300), multi, repos)).toEqual(["repo[1].git_network_timeout_seconds"]);
  });

  it("is null when anything else changed, or nothing did", () => {
    expect(operationalChanges(base, base)).toBeNull();
    for (const edit of [
      (doc: Doc) => (doc.merge.strategy = "pr"),
      (doc: Doc) => (doc.merge.branch = "loom/other"),
      (doc: Doc) => (doc.merge.remote = "upstream"),
      (doc: Doc) => (doc.project.goal = "Let people export their orders as a CSV file, and more."),
      (doc: Doc) => (doc.project.done_when = ["The export works"]),
      (doc: Doc) => (doc.checks.commands = ["npm run lint"]),
      (doc: Doc) => (doc.checks.after_merge = ["npm test"]),
      (doc: Doc) => (doc.scope = { protected: ["db/**"] }),
      (doc: Doc) => (doc.review = { approvals: 2 }),
      (doc: Doc) => (doc.ticket[0].title = "Rows"),
      (doc: Doc) => doc.ticket.push({ ref: "csv-docs", title: "Docs", body: "Write them.", acceptance: ["WHEN built THE SYSTEM SHALL list it"], scope: ["docs/**"] }),
      (doc: Doc) => {
        doc.agents.max_workers = 4;
        doc.ticket[0].priority = 0;
      },
    ]) {
      expect(changed(edit), edit.toString()).toBeNull();
    }
    for (const edit of [
      (doc: Doc) => (doc.repo[1].base = "main"),
      (doc: Doc) => (doc.repo[1].project = "proj_other"),
      (doc: Doc) => (doc.repo[1].checks = ["make test"]),
      (doc: Doc) => (doc.repo[1].protected = ["vendor/**"]),
      (doc: Doc) => doc.repo.push({ name: "docs", project: "proj_docs" }),
      (doc: Doc) => doc.repo.reverse(),
    ]) {
      expect(changed(edit, multi, repos), edit.toString()).toBeNull();
    }
  });
});
