// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { ProjectView, SpecVersionView, rpcContract } from "../src/contract";
import { parseSpec, specSchema, type Spec } from "../src/spec";
import { specDiff } from "../src/spec-diff";
import { isUnder, pathNamesOf } from "../src/spec-paths";
import { labelOf } from "../src/ui/spec-review-kit";
import { SpecPage } from "../src/ui/spec-page";
import { reloadRemembered } from "../src/ui/remember";
import { overview, projectView, specVersionView } from "./fixtures";
import { phased } from "./phase-fixtures";
import { specToml, type Doc } from "./helpers";

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
type Slot = ReturnType<typeof renderSlot>;
const unexpected = (): never => {
  throw new Error("unexpected rpc call");
};
const FEEDBACK = ["pr-cli feedback \"$LOOM_URL\" \\", "  --checks \\", "  --reviews", "  --json"].join("\n");

/** Every setting added since Loom 0.24, and the ones before it: a pull request project over two repos, each with its own forge, environment, deploy and git settings, a deploy order, and a ticket with a full rollout. */
function everything(doc: Doc): void {
  doc.merge = {
    strategy: "pr",
    draft: false,
    describe: "loom",
    max_fix_rounds: 3,
    stack: false,
    refresh_behind: 50,
    git_network_timeout_seconds: 300,
    forge: {
      kind: "command",
      open: 'pr-cli open --head "$LOOM_HEAD"',
      state: 'pr-cli state "$LOOM_URL"',
      feedback: FEEDBACK,
      edit: "pr-cli edit",
      reply: "pr-cli reply",
      retarget: 'pr-cli retarget --base "$LOOM_BASE"',
      ready: 'pr-cli ready "$LOOM_PR_NUMBER"',
      after_open: ["ci-cli run"],
      after_push: ['ci-cli run --sha "$LOOM_SHA"', "pr-cli ready"],
      ignore_checks: ["Review Bot*", "* (advisory)"],
      bots: ["*@robots.example.com"],
      notes: "The review bot clears a finding once a push fixes it.",
      review_start: 'review-bot start "$LOOM_SHA"',
      review_read: 'review-bot read "$LOOM_SHA"',
      review_rounds: 2,
      merge: 'pr-cli comment "$LOOM_PR_NUMBER" --body /merge',
      request_reviews: 'pr-cli edit "$LOOM_PR_NUMBER" --add-reviewer "$LOOM_REVIEWERS"',
      auto_merge: { method: "command", mode: "auto", rejected: ["Merge failed*"], require_live: true, max_attempts: 2, final_review: {} },
      reviewers: [{ users: ["dana", "erin", "finn"], count: 2 }, { users: ["alice", "bob"], count: 1 }],
    },
  };
  doc.project = { ...doc.project, done_when: ["Orders export as CSV"], non_goals: ["Excel files"] };
  doc.agents = { max_workers: 3, max_reviewers: 1, ticket_timeout_minutes: 90, triage: false, worker: { provider: "claude", model: "sonnet", reasoning: "high", permission_mode: "auto" }, reviewer: { provider: "codex", model: "gpt", reasoning: "low" } };
  doc.review = { approvals: 2, max_rounds: 4, rubric: ["No new dependencies"] };
  doc.checks = { commands: ["npm test"], timeout_minutes: 20, ci: true };
  doc.scope = { protected: ["db/**"], enforce: "reject" };
  doc.budget = { max_tokens: 500000, deadline: "2026-12-31" };
  doc.environment = {
    provider: "git-worktree",
    inputs: { sparse: "src", depth: 1, dirs: ["src", "test"] },
    machine: { provider: "example-machines", inputs: { size: "large" } },
  };
  doc.repo = [
    {
      name: "web",
      project: "proj_web",
      checks: ["npm run web-test"],
      ci: false,
      protected: ["web.lock"],
      forge: {
        kind: "gh",
        after_push: ["ci-cli rerun"],
        ready: "pr-cli ready",
        ignore_checks: ["Lint*"],
        auto_merge: { method: "comment", mode: "manual", comment: "/merge", rejected: ["❌*"], require_live: false, max_attempts: 4, final_review: {} },
        reviewers: [{ users: ["gil", "hal"], count: 1 }, { users: ["carol"] }],
      },
      environment: { provider: "git-worktree", inputs: { sparse: "web" } },
      deploy: { on_merge: true, how: "The actuator applies on merge" },
      refresh_behind: 100,
      git_network_timeout_seconds: 240,
    },
    {
      name: "api",
      project: "proj_api",
      base: "trunk",
      remote: "upstream",
      ci: true,
      forge: {
        kind: "command",
        profile: "example",
        review_start: "api-review start",
        review_read: "api-review read",
        review_rounds: 4,
        bots: ["api-bot*"],
        notes: "Answer the bot once when you disagree.",
        open: "api-pr open",
        state: "api-pr state",
        feedback: "api-pr feedback",
        edit: "api-pr edit",
        reply: "api-pr reply",
        retarget: "api-pr retarget",
        after_open: ["api-ci run"],
        after_push: ["api-ci again"],
        ignore_checks: ["Bot*"],
        merge: "api-pr merge",
        request_reviews: "api-pr ask",
        auto_merge: { method: "command" },
        reviewers: [{ users: ["ivy", "jo"], count: 1 }],
      },
      environment: { provider: "example-world", inputs: { zone: "west" }, machine: { provider: "example-world", inputs: { pool: "big" } } },
      deploy: { how: "The deploy tool ships trunk" },
      refresh_behind: 20,
      git_network_timeout_seconds: 600,
    },
  ];
  doc.rollout = {
    deploy: { on_merge: false, how: "The pipeline ships main: canary, then production" },
    stage: [
      { name: "expand", goal: "The server takes both headers", soak: "1d" },
      { name: "contract", goal: "Only the new header is left" },
    ],
    milestone: [{ ref: "old-traffic-zero", title: "Old header traffic is zero", check: "metrics-cli zero old_header", stage: "contract" }],
    window: [{ title: "Holiday freeze", from: "2026-12-20", to: "2027-01-02", note: "No deploys over the holidays" }],
  };
  doc.hook = [
    { on: "project.started", tell: "Create a Shuttle board named after the project, unless one exists." },
    { on: "ticket.started", to: "worker", tell: "Name the ticket key in every commit message." },
  ];
  doc.ticket[0] = { ...doc.ticket[0], repo: "web", keep_draft: true, rollout: { stage: "expand", verify: "curl -fsS https://web.example.com/health" } };
  doc.ticket[1] = {
    ...doc.ticket[1],
    repo: "api",
    verify: ["npm run api-test"],
    merge_after: ["csv-model"],
    priority: 1,
    environment: { inputs: { sparse: "api/export" } },
    rollout: { stage: "contract", requires_live: ["csv-model", "old-traffic-zero"], release: "wave-1", dark: true, how: "Ships with the deploy tool", verify: "curl -fsS https://api.example.com/health", rollback: "Revert; nothing sends the new header yet" },
  };
}

/** The integration strategy's own settings, which the pull request strategy refuses: the after-merge checks. */
function integrationEverything(doc: Doc): void {
  doc.merge = { strategy: "integration", remote: "upstream", draft: false, git_network_timeout_seconds: 200, forge: { profile: "example", after_open: ["ci-cli run"] } };
  doc.checks = { commands: ["npm test"], after_merge: ["npm run e2e"] };
  doc.repo = [
    { name: "web", project: "proj_web", after_merge: ["npm run web-e2e"], git_network_timeout_seconds: 90 },
    { name: "api", project: "proj_api", base: "trunk", checks: [] },
  ];
  doc.ticket[0].repo = "web";
  doc.ticket[1].repo = "api";
  doc.ticket[1].verify = ["npm run api-test"];
}

// The api repo's forge names a profile; the spec's own keys beside it win, so the profile only needs to exist.
const PROFILES = { forgeProfile: (id: string) => (id === "example" ? { id, name: "Example", kind: "command" as const, open: "example open", state: "example state" } : null), forgeProfileIds: () => ["example"] };
const valid = (toml: string) => {
  const result = parseSpec(toml, PROFILES);
  expect(result.errors).toEqual([]);
  return result.spec!;
};
// A proposal with open questions is refused, so only an older spec has one; the page still draws them.
const full = (): Spec => {
  const spec = valid(specToml(everything));
  return { ...spec, project: { ...spec.project, open_questions: ["Which columns come first?"] } };
};
/** `everything` whose project-wide forge is gh, merging through a merge service's comment: the keys only a gh forge takes. */
function mergingEverything(doc: Doc): void {
  everything(doc);
  doc.merge.forge = { kind: "gh", auto_merge: { method: "comment", comment: "/merge please", rejected: ["Merge failed*"], max_attempts: 2, final_review: {} }, reviewers: [{ users: ["kim", "lee", "max"], count: 2 }] };
  doc.merge.draft = true;
  doc.merge.publish = { when: ["live"] };
  doc.repo[1].forge.ready = "api-pr ready";
}
const phasedSpec = () => valid(specToml((doc) => {
  phased(doc);
  doc.phase[0].outline = ["Ship a usable CSV"];
  doc.phase[0].report = "The download check passed on the merged work.";
}));

const FIXTURES = [
  ["a pull request", full],
  ["an integration", () => valid(specToml(integrationEverything))],
  ["a merging", () => valid(specToml(mergingEverything))],
] as const;

/**
 * `everything` as a version that drops what it can: forge commands, list entries and input keys, a repo's own settings
 * (web keeps none), a stage, the milestones and windows, and most of a ticket's rollout.
 */
function trimmed(doc: Doc): void {
  everything(doc);
  doc.merge = { strategy: "pr", refresh_behind: 50, git_network_timeout_seconds: 300, forge: { kind: "command", open: doc.merge.forge.open, state: doc.merge.forge.state, feedback: FEEDBACK, after_push: ["pr-cli ready"], ignore_checks: ["Review Bot*"] } };
  doc.checks = { commands: ["npm test"] };
  doc.environment = { provider: "git-worktree", inputs: { sparse: "src" } };
  doc.repo = [
    { name: "web", project: "proj_web", checks: ["npm run web-test"] },
    { name: "api", project: "proj_api", environment: { provider: "example-world", inputs: { zone: "west" }, machine: { provider: "example-world" } } },
  ];
  doc.rollout = { deploy: { on_merge: false }, stage: [{ name: "expand", goal: "The server takes both headers" }] };
  doc.hook = [{ on: "project.started", tell: "Create the board." }];
  doc.ticket[0].rollout = { stage: "expand" };
  doc.ticket[1] = { ...doc.ticket[1], verify: [], merge_after: undefined, environment: undefined, rollout: { rollback: "Revert; nothing sends the new header yet" } };
}
/** `everything` with a third repo, docs, that `trimmed` removes. */
function withDocs(doc: Doc): void {
  everything(doc);
  doc.repo.push({ name: "docs", project: "proj_docs", forge: { kind: "gh", after_push: ["docs-ci run"] }, deploy: { on_merge: true } });
}

/** Every key path the spec schema allows, lists and listed tables as `[]`, tickets as `ticket[]` and the inputs tables as `.*`. */
function keyPaths(schema: unknown, path = "", out: string[] = []): string[] {
  const def = (schema as { _zod: { def: Record<string, unknown> & { type: string } } })._zod.def;
  const unwrap = (node: unknown): { _zod: { def: { type: string } } } => {
    let one = node as { _zod: { def: Record<string, unknown> & { type: string } } };
    while (["optional", "default", "prefault", "pipe"].includes(one._zod.def.type)) one = (one._zod.def.innerType ?? one._zod.def.out) as typeof one;
    return one;
  };
  switch (def.type) {
    case "optional":
    case "default":
    case "prefault":
      return keyPaths(def.innerType, path, out);
    case "pipe":
      return keyPaths(def.out, path, out);
    case "object":
      for (const [key, child] of Object.entries(def.shape as Record<string, unknown>)) keyPaths(child, path === "" ? key : `${path}.${key}`, out);
      return out;
    case "array":
      // specDiff reports a list of strings as one change at the list's path, and walks a list of tables entry by entry.
      return ["object", "array", "record"].includes(unwrap(def.element)._zod.def.type) ? keyPaths(def.element, `${path}[]`, out) : (out.push(path), out);
    case "record":
      // Inputs are the provider's own: each key gets a target, whatever its value holds.
      return (out.push(`${path}.*`), out);
    default:
      return (out.push(path), out);
  }
}
/** A part's path as a key path: ticket[csv-model].scope as ticket[].scope, repo[1].forge.kind as repo[].forge.kind, environment.inputs.sparse as environment.inputs.*. */
const keyPathOf = (path: string, records: readonly string[]) => {
  const generic = path.replace(/^ticket\[[^\]]+\]/, "ticket[]").replace(/\[\d+\]/g, "[]");
  return records.find((record) => generic.startsWith(record.slice(0, -1))) ?? generic;
};
/** A spec with nothing but its tickets' refs: compared with it, every part of `spec` counts as changed. */
const skeleton = (spec: Spec) => ({ ticket: spec.ticket.map((ticket) => ({ ref: ticket.ref })) }) as unknown as Spec;

const handlers = (over: Partial<Handlers>): Handlers => ({
  projects: unexpected,
  home: unexpected,
  badge: () => ({ needsYou: 0, blocked: false, threadIds: [] }),
  project: unexpected,
  ticket: unexpected,
  runOutput: unexpected,
  insights: unexpected,
  timeline: unexpected,
  insightsAll: unexpected,
  threadInfo: () => null,
  threadInfos: () => ({}),
  homeFeed: () => ({ rows: [], counts: { shipped: 0, sentBack: 0, blocked: 0, asks: 0, phase: 0, you: 0 }, matched: 0, partial: [] }),
  reply: unexpected,
  ticketAction: unexpected,
  confirmMerge: unexpected,
  releaseDraft: unexpected,
  control: unexpected,
  startPlanning: unexpected,
  bbProjects: () => [],
  planning: () => [],
  planningSession: () => null,
  plannerView: () => null,
  messagePlanner: unexpected,
  dismissAsk: unexpected,
  askStepDone: unexpected,
  ackBadge: unexpected,
  syncPullRequests: unexpected,
  markLive: unexpected,
  specVersion: unexpected,
  sendNotes: unexpected,
  changes: unexpected,
  changePatch: unexpected,
  forgeProfiles: () => [],
  saveForgeProfile: unexpected,
  deleteForgeProfile: unexpected,
  testForgeProfile: unexpected,
  exportForgeProfiles: () => ({ toml: "" }),
  importForgeProfiles: unexpected,
  ...over,
});

const mounts: Slot[] = [];
const scrolled: Element[] = [];
beforeEach(() => {
  localStorage.clear();
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
});
afterEach(() => {
  for (const slot of mounts.splice(0)) slot.lifecycle.unmount();
  cleanup();
  document.body.replaceChildren();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  localStorage.clear();
  reloadRemembered();
});

const draft = (): ProjectView => {
  const view = projectView({ overview: overview({ state: "draft", approvedVersion: null, ticketCount: 0, ticketCounts: {} }), board: [], next: null });
  return { ...view, spec: { ...view.spec, version: 2 } };
};

async function openSpec(spec: SpecVersionView) {
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot<PluginNavPanelProps, typeof rpcContract>({ component: app.navPanels[0]!.component }, { subPath: "csv" }, { pluginId: "loom", rpc: handlers({ project: () => draft(), specVersion: () => spec }) });
  mounts.push(slot);
  fireEvent.click(await slot.findByRole("tab", { name: "Spec" }));
  await waitFor(() => expect(slot.container.querySelector("[data-spec-page]")).not.toBeNull());
  return slot;
}
const page = (slot: Slot) => slot.container.querySelector<HTMLElement>("[data-spec-page]")!;
const section = (slot: Slot, name: string) => page(slot).querySelector<HTMLElement>(`[data-spec-section="${name}"]`)!;
const target = (slot: Slot, path: string) => page(slot).querySelector<HTMLElement>(`[data-comment-target="${path}"]`);
const entire = (slot: Slot) => fireEvent.click(within(within(page(slot)).getByRole("group", { name: "What to show" })).getByRole("button", { name: "The entire spec" }));
/** Whether a part the human can comment on shows `path` itself or a part inside it, not only the table it sits in. */
const shows = (element: Element | undefined, path: string) => (element?.getAttribute("data-comment-paths") ?? "").split(" ").some((one) => one === path || isUnder(one, path));
/** Each of `paths` that a click on its What changed row does not take to a part showing it or a part inside it. */
function missedJumps(slot: Slot, paths: readonly string[]): string[] {
  const missed: string[] = [];
  for (const path of paths) {
    scrolled.length = 0;
    fireEvent.click(page(slot).querySelector(`[data-change="${path}"] button`)!);
    if (!shows(scrolled.at(-1), path)) missed.push(`${path} → ${scrolled.at(-1)?.getAttribute("data-comment-paths") ?? scrolled.at(-1)?.getAttribute("data-anchor") ?? "nothing"}`);
  }
  return missed;
}
const versionOf = (spec: Spec, compared: Spec): SpecVersionView => specVersionView({ spec, toml: "", compared: { version: 1, status: "superseded", spec: compared }, changes: null });
const walkPaths = (spec: Spec) => specDiff(skeleton(spec), spec).filter((change) => change.kind !== "list" || change.steps.length > 0).map((change) => change.path);
const walkSection = (path: string) => {
  const [table, field] = path.split(".");
  return field === "forge" ? `${table}.forge` : table!;
};

describe("spec settings", () => {
  it("sets every key the spec schema has in one of the fixtures, so the walk below reaches every setting", () => {
    const keys = keyPaths(specSchema);
    const records = keys.filter((key) => key.endsWith(".*"));
    const set = new Set([...FIXTURES.map(([, spec]) => spec), phasedSpec].flatMap((spec) => specDiff(skeleton(spec()), spec()).map((change) => keyPathOf(change.path, records))));
    // A ticket is known by its ref, so a new ref reads as a new ticket, never as a changed ref.
    const exceptions = ["ticket[].ref"];
    expect(keys.length).toBeGreaterThan(120);
    expect(keys.filter((key) => !set.has(key) && !exceptions.includes(key))).toEqual([]);
  });

  it("draws every phase field and ticket phase as a commentable part", async () => {
    const spec = phasedSpec();
    const paths = specDiff(skeleton(spec), spec).map((change) => change.path).filter((path) => path.startsWith("phase[") || path.endsWith(".phase"));
    const before = { ...spec, ticket: spec.ticket.map(({ phase, ...ticket }) => ticket) };
    delete before.phase;
    expect(specDiff(before, spec).map((change) => change.path)).toEqual(paths);
    const slot = renderSlot<Parameters<typeof SpecPage>[0], typeof rpcContract>({ component: SpecPage }, { slug: "csv" }, { pluginId: "loom", rpc: handlers({ specVersion: () => versionOf(spec, before) }) });
    mounts.push(slot);
    await waitFor(() => expect(page(slot)).not.toBeNull());
    expect(missedJumps(slot, paths)).toEqual([]);
  });

  for (const [strategy, fixture] of FIXTURES) {
    const allPaths = walkPaths(fixture());
    const sections = [...new Set(allPaths.map(walkSection))].map((section) => ({ section, count: allPaths.filter((path) => walkSection(path) === section).length }));
    describe(`${strategy} spec's commentable sections`, () => {
      it("covers every changed path exactly once and includes every expected setting", () => {
        const paths = walkPaths(fixture());
        const expected = strategy === "a merging" ? ["merge.publish.when", "merge.forge.auto_merge.method", "merge.forge.auto_merge.comment", "merge.forge.auto_merge.rejected", "merge.forge.reviewers[0].users", "repo[0].forge.auto_merge.comment", "repo[1].forge.merge"] : strategy === "an integration" ? ["merge.remote", "checks.after_merge", "repo[0].after_merge"] : ["merge.forge.retarget", "merge.forge.merge", "merge.forge.auto_merge.require_live", "merge.forge.reviewers[1].users", "repo[0].forge.auto_merge.max_attempts", "repo[1].forge.reviewers[0].count", "merge.forge.after_push", "merge.refresh_behind", "merge.git_network_timeout_seconds", "checks.ci", "environment.machine.inputs.size", "repo[1].forge.after_push", "repo[0].deploy.on_merge", "repo[1].git_network_timeout_seconds", "rollout.stage[0].soak", "rollout.milestone[0].check", "rollout.window[0].note", "ticket[csv-export].rollout.requires_live", "ticket[csv-export].environment.inputs.sparse"];
        for (const path of expected) {
          expect(paths).toContain(path);
        }
        expect(sections.flatMap(({ section }) => paths.filter((path) => walkSection(path) === section)).sort()).toEqual([...paths].sort());
      });

      it.each(sections)("draws every part of $section ($count changes), so What changed reaches a commentable part", async ({ section, count }) => {
        const spec = fixture();
        const paths = walkPaths(spec).filter((path) => walkSection(path) === section);
        expect(paths).toHaveLength(count);
        const slot = renderSlot<Parameters<typeof SpecPage>[0], typeof rpcContract>({ component: SpecPage }, { slug: "csv" }, { pluginId: "loom", rpc: handlers({ specVersion: () => versionOf(spec, skeleton(spec)) }) });
        mounts.push(slot);
        await waitFor(() => expect(page(slot)).not.toBeNull());
        entire(slot);
        expect(missedJumps(slot, paths)).toEqual([]);
      });
    });
  }

  it("shows ci left unset as what the forge gives: relied on with gh, ignored on a command forge without feedback", async () => {
    const onForge = (forge: Record<string, unknown>) => valid(specToml((doc) => void (doc.merge = { strategy: "pr", forge })));
    const text = async (spec: Spec) => {
      const slot = await openSpec(versionOf(spec, spec));
      entire(slot);
      return section(slot, "settings").textContent ?? "";
    };
    expect(await text(onForge({ kind: "gh" }))).toContain("The pull request's CI runs every other test, from the forge");
    expect(await text(onForge({ kind: "command", open: "o", state: "s" }))).toContain("Loom ignores the pull request's CI: its own checks are the whole bar, from the forge");
  });

  it("shows a final review turned on with an empty table, in What changed and while only what changed is shown", async () => {
    const gh = (auto: Record<string, unknown>) =>
      valid(
        specToml((doc) => {
          everything(doc);
          doc.merge.forge = { kind: "gh", auto_merge: auto };
        }),
      );
    const before = gh({ method: "squash" });
    const after = gh({ method: "squash", final_review: {} });
    const paths = specDiff(before, after).map((change) => change.path);
    expect(paths).toEqual(["merge.forge.auto_merge.final_review"]);
    const slot = await openSpec(versionOf(after, before));
    const part = page(slot).querySelector<HTMLElement>('[data-final-review="merge.forge.auto_merge.final_review"]');
    expect(part?.textContent).toContain("A final review before each merge, of what changed since approval, by the reviewer's agent at low reasoning within 10 minutes");
    expect(page(slot).querySelector('[data-change="merge.forge.auto_merge.final_review"]')?.textContent).toContain("on, with its defaults");
    expect(missedJumps(slot, paths)).toEqual([]);
  });

  it("draws a stored reviewers rule that names only a team as one Loom no longer reads, instead of failing", async () => {
    const spec = valid(specToml((doc) => void (doc.merge = { strategy: "pr", forge: { kind: "gh", reviewers: [{ users: ["zoe"] }] } })));
    const stored = { ...spec, merge: { ...spec.merge, forge: { kind: "gh", reviewers: [{ team: "acme/platform", count: 2 }, { users: ["zoe"] }] } } } as unknown as Spec;
    const slot = await openSpec(versionOf(stored, stored));
    entire(slot);
    const text = section(slot, "settings").textContent ?? "";
    expect(text).toContain("acme/platform, a team: Loom no longer reads team rules; list the people to ask in users");
    expect(text).toContain("zoe");
  });

  it("draws a stored hook that has only run, which Loom no longer reads, as one with nothing to tell", async () => {
    const spec = { ...full(), hook: [{ on: "project.started", run: "board-cli create" }] } as unknown as Spec;
    const slot = await openSpec(versionOf(spec, spec));
    entire(slot);
    const card = page(slot).querySelector<HTMLElement>('[data-settings-card="hooks"]')!;
    expect(card.querySelector("[data-hook]")!.textContent).toContain("nothing to tell");
  });

  it("draws each hook with its event, what it tells and to whom", async () => {
    const slot = await openSpec(versionOf(full(), full()));
    entire(slot);
    const card = page(slot).querySelector<HTMLElement>('[data-settings-card="hooks"]')!;
    expect(card.getAttribute("aria-label")).toBe("Hooks · 2");
    const [first, second] = [...card.querySelectorAll<HTMLElement>("[data-hook]")];
    expect(first!.textContent).toContain("When the human starts the project");
    expect(first!.textContent).toContain("Create a Shuttle board named after the project, unless one exists.");
    expect(first!.querySelector('[aria-current="true"]')!.textContent).toBe("The planner, when it happens");
    expect(second!.textContent).toContain("When a worker starts on a ticket");
    expect(second!.querySelector('[aria-current="true"]')!.textContent).toBe("Each worker, in its brief");
  });

  it("draws what a version removes, each removal with a target of its own that What changed goes to", async () => {
    const before = valid(specToml(withDocs));
    const after = valid(specToml(trimmed));
    const paths = specDiff(before, after).map((change) => change.path);
    for (const path of ["merge.forge.after_open", "merge.forge.after_push", "merge.forge.ignore_checks", "merge.forge.edit", "environment.inputs.depth", "repo[0].forge.kind", "repo[0].environment.inputs.sparse", "repo[1].environment.machine.inputs.pool", "repo[2].name", "rollout.stage[1].goal", "rollout.milestone[0].check", "rollout.window[0].from", "ticket[csv-export].verify", "ticket[csv-export].environment.inputs.sparse"]) {
      expect(paths).toContain(path);
    }
    const slot = await openSpec(versionOf(after, before));
    entire(slot);
    expect(missedJumps(slot, paths)).toEqual([]);
    const settings = section(slot, "settings");
    expect(settings.querySelector('[data-removed-row="rollout.stage[1]"]')!.textContent).toContain("contract");
    expect(settings.querySelector('[data-removed-row="rollout.milestone[0]"]')!.textContent).toContain("old-traffic-zero");
    expect(settings.querySelector('[data-removed-row="rollout.window[0]"]')!.textContent).toContain("Holiday freeze");
    expect(settings.querySelector('[data-removed-row="repo[2]"]')!.textContent).toContain("docs");
    expect(target(slot, "environment.inputs.depth")!.querySelector("del")!.textContent).toContain("depth");
  }, 30_000);

  it("says a repo whose own refresh_behind or git time limit a version removes now follows the project's", async () => {
    const slot = await openSpec(versionOf(valid(specToml(trimmed)), valid(specToml(everything))));
    entire(slot);
    const refresh = target(slot, "repo[0].refresh_behind")!;
    expect(refresh.textContent).toContain("50 commits behind, from the project");
    expect(refresh.querySelector("[data-was]")!.textContent).toBe("was 100");
    const git = target(slot, "repo[0].git_network_timeout_seconds")!;
    expect(git.textContent).toContain("300 s, from the project");
    expect(git.querySelector("[data-was]")!.textContent).toBe("was 240");
  });

  it("folds a changed or removed command of many lines too, with its whole text one click away", async () => {
    const long = Array.from({ length: 20 }, (_, index) => `step-${index + 1} \\`).join("\n");
    const before = valid(specToml((doc) => (everything(doc), (doc.merge.forge.feedback = long), (doc.merge.forge.edit = long))));
    const after = valid(specToml((doc) => (everything(doc), (doc.merge.forge.feedback = long.replace("step-12 ", "step-twelve ")), delete doc.merge.forge.edit)));
    const slot = await openSpec(versionOf(after, before));
    const feedback = target(slot, "merge.forge.feedback")!;
    expect(feedback.textContent).toContain("step-1 ");
    expect(feedback.querySelector("ins")!.textContent).toBe("step-twelve");
    expect(feedback.textContent).not.toContain("step-5 ");
    fireEvent.click(within(feedback.parentElement!).getByRole("button", { name: "+18 lines" }));
    expect(target(slot, "merge.forge.feedback")!.textContent).toContain("step-5 ");
    const edit = target(slot, "merge.forge.edit")!;
    expect(edit.querySelector("del")!.textContent).toContain("step-1 ");
    expect(edit.textContent).not.toContain("step-20");
    fireEvent.click(within(edit.parentElement!).getByRole("button", { name: "+19 lines" }));
    expect(target(slot, "merge.forge.edit")!.textContent).toContain("step-20");
  });

  it("lets a long old value wrap, so it never runs off a narrow screen", async () => {
    const provider = `p${"x".repeat(98)}`;
    const before = valid(specToml((doc) => (everything(doc), (doc.environment.provider = provider))));
    const slot = await openSpec(versionOf(valid(specToml(everything)), before));
    const was = target(slot, "environment.provider")!.querySelector<HTMLElement>("[data-was]")!;
    expect(was.textContent).toBe(`was ${provider}`);
    expect(was.className).not.toContain("whitespace-nowrap");
    expect(was.className).toContain("[overflow-wrap:anywhere]");
  });

  it("shows the old and new text of a forge command a version changes, and goes to it from What changed", async () => {
    const before = valid(specToml(everything));
    const after = valid(specToml((doc) => (everything(doc), (doc.merge.forge.edit = "pr-cli edit --title"), (doc.merge.forge.feedback = FEEDBACK.replace("--reviews", "--threads")))));
    const slot = await openSpec(versionOf(after, before));
    expect([...page(slot).querySelectorAll("[data-change]")].map((row) => row.getAttribute("data-change"))).toEqual(["merge.forge.feedback", "merge.forge.edit"]);
    expect(page(slot).querySelector('[data-change="merge.forge.edit"] button')!.textContent).toBe("Forge › editpr-cli edit → pr-cli edit --title");
    expect([...section(slot, "settings").querySelectorAll("[data-settings-card]")].map((card) => card.getAttribute("data-settings-card"))).toEqual(["merge"]);
    const edit = target(slot, "merge.forge.edit")!;
    expect(edit.querySelector("ins")!.textContent).toBe(" --title");
    expect(edit.textContent).toContain("pr-cli edit");
    const feedback = target(slot, "merge.forge.feedback")!;
    expect(feedback.querySelector("del")!.textContent).toBe("--reviews");
    expect(feedback.querySelector("ins")!.textContent).toBe("--threads");
    // The commands the version left alone stay out of the way while only what changed is shown.
    expect(target(slot, "merge.forge.open")!.closest("[data-faded]")).not.toBeNull();
    fireEvent.click(page(slot).querySelector('[data-change="merge.forge.edit"] button')!);
    expect(scrolled.at(-1)).toBe(edit);
  });

  it("folds a long command to its first line, with the rest one click away", async () => {
    const spec = full();
    const slot = await openSpec(versionOf(spec, spec));
    entire(slot);
    const feedback = target(slot, "merge.forge.feedback")!;
    expect(feedback.textContent).toContain('pr-cli feedback "$LOOM_URL" \\');
    expect(feedback.textContent).not.toContain("--json");
    fireEvent.click(within(feedback.parentElement!).getByRole("button", { name: "+3 lines" }));
    expect(target(slot, "merge.forge.feedback")!.textContent).toContain("--json");
  });

  it("keeps a repo with only defaults to one line, and opens the settings of a repo a version changed", async () => {
    const spec = valid(
      specToml((doc) => {
        everything(doc);
        doc.repo.push({ name: "docs", project: "proj_docs" });
      }),
    );
    const before = valid(
      specToml((doc) => {
        everything(doc);
        doc.repo.push({ name: "docs", project: "proj_docs" });
        doc.repo[1].refresh_behind = 10;
      }),
    );
    const slot = await openSpec(versionOf(spec, before));
    entire(slot);
    const settings = (name: string) => section(slot, "settings").querySelector<HTMLDetailsElement>(`[data-repo-settings="${name}"]`)!;
    expect(settings("docs").querySelector("summary")!.textContent).toBe("Settings · all from the project");
    expect(settings("docs").open).toBe(false);
    expect(settings("web").querySelector("summary")!.textContent).toBe("Settings · its own forge, environment, CI, deploy, fresh pull requests and git time limit");
    expect(settings("web").open).toBe(false);
    expect(settings("api").open).toBe(true);
    expect(target(slot, "repo[1].refresh_behind")!.textContent).toContain("was 10");
    expect(target(slot, "repo[2].forge")!.textContent).toContain("the spec's own commands, from the project");
  });

  it("draws the deploy order once, says it is advice, and counts each stage's tickets", async () => {
    const spec = full();
    const slot = await openSpec(versionOf(spec, spec));
    entire(slot);
    const card = section(slot, "settings").querySelector<HTMLElement>('[data-settings-card="deploy"]')!;
    expect(card.textContent).toContain("Deploy order is advice for you");
    expect([...card.querySelectorAll("[data-stage]")].map((stage) => [stage.getAttribute("data-stage"), stage.querySelector("[data-stage-tickets]")!.textContent])).toEqual([
      ["expand", "1 ticket"],
      ["contract", "1 ticket"],
    ]);
    expect(target(slot, "rollout.stage[0].soak")!.textContent).toContain("soaks 1d");
    expect(target(slot, "rollout.milestone[0].stage")!.textContent).toContain("gates contract");
    expect(target(slot, "rollout.window[0].from")!.textContent).toContain("2026-12-20");
    expect(target(slot, "repo[0].deploy.on_merge")!.textContent).toContain("deploys on merge");

    const none = valid(specToml());
    slot.lifecycle.unmount();
    const plain = await openSpec(versionOf(none, none));
    entire(plain);
    expect(section(plain, "settings").querySelector('[data-settings-card="deploy"]')).toBeNull();
  });

  it("shows a ticket's rollout, with chips that open the ticket it needs live or name the milestone", async () => {
    const spec = full();
    const slot = await openSpec(versionOf(spec, spec));
    entire(slot);
    fireEvent.click(section(slot, "tickets").querySelector('[data-ticket-row="csv-export"]')!);
    const rollout = section(slot, "tickets").querySelector<HTMLElement>("[data-ticket-rollout]")!;
    expect(rollout.textContent).toContain("stage contract");
    expect(rollout.textContent).toContain("ships dark");
    expect(within(rollout).getByTitle("Milestone: Old header traffic is zero").textContent).toBe("old-traffic-zero milestone");
    expect(section(slot, "tickets").querySelector("[data-ticket-environment]")!.textContent).toContain("api/export");
    fireEvent.click(within(rollout).getByRole("button", { name: "csv-model" }));
    expect(section(slot, "tickets").querySelector("[data-ticket-detail]")!.getAttribute("data-ticket-detail")).toBe("csv-model");
  });

  it("names the new settings in What changed by their stage, milestone, window and repo", () => {
    const names = pathNamesOf(full());
    const label = (path: string) => labelOf(path, names);
    expect(label("repo[1].forge.after_push")).toBe("api › forge › after push");
    expect(label("merge.forge.after_push[1]")).toBe("Forge › after push › command 2");
    expect(label("repo[0].forge.after_push[0]")).toBe("web › forge › after push › command 1");
    expect(label("rollout.stage[0].soak")).toBe("Deploy stage expand › soak");
    expect(label("rollout.stage[1]")).toBe("Deploy stage contract");
    expect(label("rollout.milestone[0].check")).toBe("Milestone old-traffic-zero › check");
    expect(label("rollout.window[0].from")).toBe("Deploy window Holiday freeze › from");
    expect(label("rollout.stage[5].goal")).toBe("Deploy stage 6 › goal");
    expect(label("rollout.deploy.how")).toBe("How changes reach traffic");
    expect(label("merge.refresh_behind")).toBe("Keep pull requests fresh");
    expect(label("ticket[csv-export].rollout.requires_live")).toBe("csv-export › rollout › requires live");
    expect(labelOf("repo[0].checks", ["web"])).toBe("web › checks");
  });
});

describe("Spec's value picker", () => {
  it("gives a touch screen the one 44 px version picker at any width, and a mouse the row of versions", async () => {
    const fine = await openSpec(specVersionView());
    expect(page(fine).querySelector("[data-version-select]")).toBeNull();
    expect(within(page(fine)).getByRole("group", { name: "Spec versions" })).toBeTruthy();
    fine.lifecycle.unmount();
    mounts.splice(mounts.indexOf(fine), 1);
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: coarse)", media: query, addEventListener() {}, removeEventListener() {} }));
    try {
      const coarse = await openSpec(specVersionView());
      expect(page(coarse).querySelector("[data-version-select]")).not.toBeNull();
      expect(within(page(coarse)).queryByRole("group", { name: "Spec versions" })).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lists every value a section takes a comment on, each a row of its own, and opens the same comment box as the value", async () => {
    const slot = await openSpec(specVersionView());
    entire(slot);
    const settings = section(slot, "settings");
    const values = [...settings.querySelectorAll<HTMLElement>("[data-comment-target]")];
    expect(values.length).toBeGreaterThan(10);
    const pickers = [...settings.querySelectorAll<HTMLElement>("[data-value-picker]")];
    expect(pickers.map((picker) => picker.dataset.placement)).toEqual(["header", "bar"]);
    fireEvent.click(pickers[1]!);
    const sheet = await slot.findByRole("dialog", { name: /^Comment on a value in / });
    const rows = [...sheet.querySelectorAll<HTMLElement>("[data-pick]")];
    expect(rows.map((row) => row.dataset.pick)).toEqual(values.map((value) => value.dataset.commentTarget));
    const find = within(sheet).getByRole("textbox", { name: /^Find a value in / });
    fireEvent.change(find, { target: { value: "zzz-no-such-value" } });
    expect(within(sheet).getByRole("status").textContent).toContain("No value matches");
    fireEvent.change(find, { target: { value: "" } });
    const chosen = values[3]!;
    fireEvent.click(sheet.querySelector<HTMLElement>(`[data-pick="${chosen.dataset.commentTarget}"]`)!);
    await waitFor(() => expect(page(slot).querySelector("[data-comment-box]")).not.toBeNull());
    const box = page(slot).querySelector<HTMLElement>("[data-comment-box]")!;
    expect(box.getAttribute("aria-label")).toBe(chosen.title);
    expect(slot.queryByRole("dialog", { name: /^Comment on a value in / })).toBeNull();
    // Escape closes the box and hands focus back to the value, not to bb's composer.
    const reached: string[] = [];
    const host = (event: KeyboardEvent) => reached.push(event.key);
    document.addEventListener("keydown", host);
    fireEvent.keyDown(box, { key: "Escape" });
    document.removeEventListener("keydown", host);
    await waitFor(() => expect(page(slot).querySelector("[data-comment-box]")).toBeNull());
    expect(document.activeElement).toBe(chosen);
    expect(reached).toEqual([]);
  });
});
