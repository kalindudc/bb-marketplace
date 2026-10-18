import { describe, expect, it } from "vitest";
import {
  askSummary, backgroundLabels, changesLabel, changesSummary, childrenLabel, costLabel, modelLabel,
  outlineSummary, permissionLabel, rootThread, tokens, usageSummary,
  type Interactions, type Outline, type Usage, type WorkspaceStatus,
} from "../src/info-format";
import { sidebarThread } from "./fixtures";

const usage = (usedTokens: number, modelContextWindow: number, cost?: Usage["cost"]): Usage =>
  ({ usedTokens, modelContextWindow, estimated: false, ...(cost ? { cost } : {}) });

const interaction = (payload: unknown, status = "pending"): Interactions[number] =>
  ({ id: "i", threadId: "t", turnId: "u", createdAt: 1, status, statusReason: null, resolvedAt: null,
    resolution: null, providerId: "pi", providerRequestId: "r", providerThreadId: "p", payload }) as unknown as Interactions[number];
const approval = (subject: Record<string, unknown>) =>
  interaction({ kind: "approval", availableDecisions: ["allow_once", "deny"], reason: null, subject: { itemId: "x", ...subject } });

const outline = (items: { role: "user" | "assistant"; preview: string }[]): Outline =>
  ({ maxSeq: items.length, items: items.map((item, index) => ({ id: String(index), attachmentSummary: null, ...item })) });

const tree = { deletions: 0, fileCount: 0, files: [], hasUncommittedChanges: false, insertions: 0, lineStatsComplete: true, state: "clean" as const };
function status(mergeBase: { insertions: number; deletions: number; fileCount: number; aheadCount?: number; behindCount?: number } | null,
  workingTree: { insertions: number; deletions: number; fileCount: number } = { insertions: 0, deletions: 0, fileCount: 0 }): WorkspaceStatus {
  return { outcome: "available", workspace: {
    branch: { currentBranch: "b", defaultBranch: "main" },
    checkout: { kind: "branch", branchName: "b", headSha: null },
    mergeBase: mergeBase && { aheadCount: 0, behindCount: 0, baseRef: "abc", commits: [], files: [],
      hasCommittedUnmergedChanges: mergeBase.fileCount > 0, lineStatsComplete: true, mergeBaseBranch: "origin/main", ...mergeBase },
    workingTree: { ...tree, ...workingTree },
  } };
}

describe("tokens", () => {
  it("keeps small counts, rounds thousands and shortens millions", () => {
    expect(tokens(0)).toBe("0");
    expect(tokens(999)).toBe("999");
    expect(tokens(1_000)).toBe("1k");
    expect(tokens(109_400)).toBe("109k");
    expect(tokens(999_499)).toBe("999k");
    expect(tokens(999_500)).toBe("1M");
    expect(tokens(1_000_000)).toBe("1M");
    expect(tokens(1_200_000)).toBe("1.2M");
    expect(tokens(1_249_999)).toBe("1.2M");
  });
});

describe("usage", () => {
  it("reports used over window with a clamped, rounded percent", () => {
    expect(usageSummary(usage(109_000, 1_000_000))).toEqual({ percent: 11, text: "109k / 1M · 11%" });
    expect(usageSummary(usage(794, 1_000)).percent).toBe(79);
    expect(usageSummary(usage(795, 1_000)).percent).toBe(80);
    expect(usageSummary(usage(5_000, 1_000)).percent).toBe(100);
    expect(usageSummary(usage(-5, 1_000)).percent).toBe(0);
    expect(usageSummary(usage(10, 0)).percent).toBe(0);
  });

  it("formats a reported cost as currency and returns null without one", () => {
    expect(costLabel(usage(1, 10))).toBeNull();
    const expected = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(1.5);
    expect(costLabel(usage(1, 10, { amount: 1.5, currency: "USD" }))).toBe(expected);
  });
});

describe("model and permission", () => {
  it("drops a vendor prefix from the model id", () => {
    expect(modelLabel("anthropic/claude-opus-5")).toBe("claude-opus-5");
    expect(modelLabel("a/b/gpt-6")).toBe("gpt-6");
    expect(modelLabel("gpt-6")).toBe("gpt-6");
  });

  it("uses bb's own permission labels", () => {
    expect(permissionLabel("accept-edits")).toBe("Accept Edits");
    expect(permissionLabel("auto")).toBe("Approve for me");
    expect(permissionLabel("full")).toBe("Full Access");
  });
});

describe("outline", () => {
  it("takes the first prompt and the latest reply, without markdown, and counts both", () => {
    expect(outlineSummary(outline([
      { role: "user", preview: "Add a **hover**   card\nwith `stats`" },
      { role: "assistant", preview: "First" },
      { role: "user", preview: "Second ask" },
      { role: "assistant", preview: "Done: __all__ green." },
    ]))).toEqual({ asked: "Add a hover card with stats", latest: "Done: all green.", prompts: 2, replies: 2 });
  });

  it("returns nulls and zeros for an empty outline", () => {
    expect(outlineSummary(outline([]))).toEqual({ asked: null, latest: null, prompts: 0, replies: 0 });
    expect(outlineSummary(outline([{ role: "user", preview: "Only a prompt" }])))
      .toEqual({ asked: "Only a prompt", latest: null, prompts: 1, replies: 0 });
  });
});

describe("waiting line", () => {
  it("describes each kind of pending interaction", () => {
    expect(askSummary([approval({ kind: "command", command: "terraform plan", cwd: null, actions: [], sessionGrant: null })]))
      .toBe("Approve command: terraform plan");
    expect(askSummary([approval({ kind: "file_change", sessionGrant: null, writeScope: null })])).toBe("Approve file changes");
    expect(askSummary([approval({ kind: "permission_grant", permissions: {}, toolName: "bash" })])).toBe("Grant permissions for bash");
    expect(askSummary([approval({ kind: "permission_grant", permissions: {}, toolName: null })])).toBe("Grant permissions");
    expect(askSummary([approval({ kind: "plan", plan: "1. Do it", planFilePath: null })])).toBe("Approve the plan");
    const presentation = { icon: { glyph: "x" }, label: { pending: "Running deploy", completed: "Ran deploy" } };
    expect(askSummary([approval({ kind: "tool_use", tool: "deploy", presentation })])).toBe("Running deploy");
    expect(askSummary([approval({ kind: "tool_use", tool: "deploy", presentation: { ...presentation, title: "Deploy to prod" } })]))
      .toBe("Deploy to prod");
    const question = (prompt: string) => ({ id: prompt, prompt, allowFreeText: true, multiSelect: false });
    expect(askSummary([interaction({ kind: "user_question", questions: [question("Which branch?")] })])).toBe("Which branch?");
    expect(askSummary([interaction({ kind: "user_question", questions: [question("Which branch?"), question("A"), question("B")] })]))
      .toBe("Which branch? (+2 more)");
    expect(askSummary([interaction({ kind: "plugin", title: "Pick a colour", data: null })])).toBe("Pick a colour");
    expect(askSummary([interaction({ kind: "acme/review", title: "Review the diff", data: null })])).toBe("Review the diff");
  });

  it("uses the first pending interaction and returns null without one", () => {
    expect(askSummary([])).toBeNull();
    expect(askSummary([approval({ kind: "file_change", sessionGrant: null, writeScope: null })].map((entry) => ({ ...entry, status: "resolved" as const })))).toBeNull();
    expect(askSummary([
      interaction({ kind: "plugin", title: "Old", data: null }, "resolved"),
      interaction({ kind: "plugin", title: "Current", data: null }),
      interaction({ kind: "plugin", title: "Later", data: null }),
    ])).toBe("Current");
  });
});

describe("changes", () => {
  it("labels committed, uncommitted, both and no changes", () => {
    const both = changesSummary(status({ insertions: 2621, deletions: 71, fileCount: 21, aheadCount: 1, behindCount: 4 },
      { insertions: 5, deletions: 1, fileCount: 2 }))!;
    expect(both).toEqual({ committed: { insertions: 2621, deletions: 71, files: 21 }, uncommitted: { insertions: 5, deletions: 1, files: 2 },
      ahead: 1, behind: 4, base: "origin/main" });
    expect(changesLabel(both)).toBe(`+${(2621).toLocaleString()} −71 · 21 files · 2 uncommitted`);
    const committed = changesSummary(status({ insertions: 3, deletions: 0, fileCount: 1 }))!;
    expect(changesLabel(committed)).toBe("+3 −0 · 1 file");
    const uncommitted = changesSummary(status({ insertions: 0, deletions: 0, fileCount: 0 }, { insertions: 9, deletions: 2, fileCount: 3 }))!;
    expect(uncommitted.committed).toBeNull();
    expect(changesLabel(uncommitted)).toBe("+9 −2 · 3 files uncommitted");
    const clean = changesSummary(status(null))!;
    expect(clean).toEqual({ committed: null, uncommitted: null, ahead: 0, behind: 0, base: null });
    expect(changesLabel(clean)).toBe("No changes");
  });

  it("returns null when git status is not available", () => {
    expect(changesSummary({ outcome: "not_applicable", reason: "non_git_environment", message: "No git" })).toBeNull();
    expect(changesSummary({ outcome: "unavailable", failure: { code: "path_not_found", message: "Gone", workspacePath: "/x" } })).toBeNull();
  });
});

describe("background and children", () => {
  it("lists background work and queued messages", () => {
    expect(backgroundLabels(sidebarThread())).toEqual([]);
    expect(backgroundLabels(sidebarThread({
      activity: { backgroundAgents: 1, backgroundCommands: 2, workflows: 1, planMode: 1, goals: 1 }, queuedWork: "waiting",
    }))).toEqual(["1 agent", "2 commands", "1 workflow", "Plan mode", "Goal", "Message queued"]);
    expect(backgroundLabels(sidebarThread({
      activity: { backgroundAgents: 3, backgroundCommands: 0, workflows: 2, planMode: 0, goals: 0 }, queuedWork: "failed",
    }))).toEqual(["3 agents", "2 workflows", "Queued message failed"]);
  });

  it("counts visible direct children and their non-idle states", () => {
    const threads = [
      sidebarThread({ id: "p" }),
      sidebarThread({ id: "a", parentThreadId: "p", status: "active" }),
      sidebarThread({ id: "b", parentThreadId: "p", status: "error" }),
      sidebarThread({ id: "c", parentThreadId: "p" }),
      sidebarThread({ id: "d", parentThreadId: "p", isArchived: true, status: "active" }),
      sidebarThread({ id: "e", parentThreadId: "p", isHidden: true }),
      sidebarThread({ id: "f", parentThreadId: "a", status: "active" }),
    ];
    expect(childrenLabel(threads, "p")).toBe("3 children · 1 failed · 1 running");
    expect(childrenLabel(threads, "a")).toBe("1 child · 1 running");
    expect(childrenLabel(threads, "c")).toBeNull();
  });

  it("finds the root whose section the list shows a child under", () => {
    const root = sidebarThread({ id: "r", sectionId: "s" });
    const child = sidebarThread({ id: "c", parentThreadId: "r" });
    const grandchild = sidebarThread({ id: "g", parentThreadId: "c" });
    const orphan = sidebarThread({ id: "o", parentThreadId: "gone" });
    const underHidden = sidebarThread({ id: "u", parentThreadId: "h" });
    const hidden = sidebarThread({ id: "h", parentThreadId: "r", isHidden: true });
    const loopA = sidebarThread({ id: "x", parentThreadId: "y" });
    const loopB = sidebarThread({ id: "y", parentThreadId: "x" });
    const threads = [root, child, grandchild, orphan, underHidden, hidden, loopA, loopB];
    expect(rootThread(threads, grandchild).id).toBe("r");
    expect(rootThread(threads, child).id).toBe("r");
    expect(rootThread(threads, root).id).toBe("r");
    expect(rootThread(threads, orphan).id).toBe("o");
    expect(rootThread(threads, underHidden).id).toBe("u");
    expect(["x", "y"]).toContain(rootThread(threads, loopA).id);
  });
});
