import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { Overview, OverviewInput, PatchOutput, PatchRequest, RecordedEditsInput, RecordedEditsOutput, ShellInput, rpcContract } from "../src/contract";
import { clearFileCache } from "../src/file-row";
import { VIEW_STORAGE_KEY } from "../src/view-preference";
import {
  branchRepo, checkoutRepo, fileChange, overview as makeOverview, recordedRepo, repo, threadSummary,
} from "./fixtures";

type Slot = ReturnType<typeof renderSlot>;

const mounts: Slot[] = [];
afterEach(() => {
  for (const slot of mounts.splice(0)) slot.lifecycle.unmount();
  clearFileCache();
  document.body.replaceChildren();
  window.localStorage.clear();
});

const THREADS = [
  threadSummary({ id: "thr_1", title: "Parent thread" }),
  threadSummary({ id: "thr_2", title: "Archived child", parentThreadId: "thr_1", depth: 1, archived: true, environmentId: "env_2" }),
];

function sampleOverview(overrides: Partial<Overview> = {}): Overview {
  return makeOverview({
    threads: THREADS,
    repos: [
      repo({
        label: "Project", branch: "feature/work", threadIds: ["thr_1"],
        files: [fileChange({ path: "src/a.ts", additions: 2, deletions: 1 }), fileChange({ path: "docs/new.md", status: "added", additions: 4, deletions: 0 })],
      }),
      checkoutRepo({
        label: "cortex", threadIds: ["thr_1"],
        files: [fileChange({
          path: "skills/x.md", additions: 1, deletions: 0,
          edits: { threadIds: ["thr_1"], rawPaths: ["/code/cortex/skills/x.md"], count: 1 },
        })],
        otherFiles: [fileChange({ path: "unrelated.md", additions: 7, deletions: 7 })],
      }),
      branchRepo({ threadIds: ["thr_2"], files: [fileChange({ path: "lib/old.ts", additions: 5, deletions: 0, status: "added" })] }),
    ],
    ...overrides,
  });
}

interface Handlers {
  overview?: (input: OverviewInput) => Overview | Promise<Overview>;
  shell?: (input: ShellInput) => Overview | Promise<Overview>;
  patch?: (input: PatchRequest) => PatchOutput | Promise<PatchOutput>;
  recordedEdits?: (input: RecordedEditsInput) => RecordedEditsOutput | Promise<RecordedEditsOutput>;
}

async function mount(handlers: Handlers = {}) {
  window.localStorage.setItem(VIEW_STORAGE_KEY, "repositories");
  const app = await loadPluginApp(() => import("../app"));
  const overview = vi.fn(handlers.overview ?? (() => sampleOverview()));
  const shell = vi.fn(handlers.shell ?? (() => new Promise<Overview>(() => {})));
  const patch = vi.fn(handlers.patch ?? ((input: PatchRequest) => ({ patch: `+patch for ${input.path}`, truncated: false, binary: false })));
  const recordedEdits = vi.fn(handlers.recordedEdits ?? (() => ({ edits: [] })));
  const unsubscribed: string[] = [];
  const subscribe = vi.fn((args: { event: string }) => () => { unsubscribed.push(args.event); });
  const slot = renderSlot<PluginThreadPanelProps, typeof rpcContract>(app.threadPanelActions[0]!, { threadId: "thr_1", params: null }, {
    pluginId: "vantage",
    rpc: { shell, overview, patch, recordedEdits, commitFiles: () => ({ files: [] }) },
    sdk: { subscribe: subscribe as never },
  });
  mounts.push(slot);
  return { slot, overview, shell, patch, recordedEdits, subscribe, unsubscribed };
}

const row = (slot: Slot, path: string): HTMLElement => {
  const found = slot.container.querySelector<HTMLElement>(`[data-file-row="${path}"]`);
  if (found === null) throw new Error(`no row for ${path}`);
  return found;
};
const rowButton = (slot: Slot, path: string): HTMLButtonElement => row(slot, path).querySelector("button")!;
const diffs = (slot: Slot): string[] => [...slot.container.querySelectorAll('[data-testid="bb-diff"]')].map((node) => node.textContent ?? "");
const repoHeader = (slot: Slot, key: string): HTMLButtonElement => slot.container.querySelector<HTMLButtonElement>(`[data-repo="${key}"] > button`)!;

describe("VantagePanel", () => {
  it("summarises the repositories, files, line counts and threads on a line of its own, outside the toolbar", async () => {
    const { slot } = await mount();
    await slot.findByText("cortex");
    const toolbar = slot.container.querySelector("section > div")!;
    expect(toolbar.textContent).not.toContain("3 repos");
    expect(slot.container.querySelector("[data-repo-summary]")!.textContent).toContain("3 repos · 4 files · +12 −1 · 2 threads");
  });

  it("lets the toolbar wrap, so the scope switch and the archived toggle are never clipped in a narrow panel", async () => {
    const { slot } = await mount();
    await slot.findByText("cortex");
    expect(slot.container.querySelector("[data-vantage-panel] > div")!.className).toContain("flex-wrap");
  });

  it("shows one section for each repository with its label, caption, branch and thread chips", async () => {
    const { slot } = await mount();
    await slot.findByText("cortex");
    const sections = [...slot.container.querySelectorAll("[data-repo]")];
    expect(sections).toHaveLength(3);
    const [workspace, checkout, branch] = sections as HTMLElement[];
    expect(workspace!.textContent).toContain("Project");
    expect(workspace!.textContent).toContain("Thread workspace");
    expect(workspace!.textContent).toContain("feature/work");
    expect(workspace!.textContent).toContain("2 files");
    expect(checkout!.textContent).toContain("Edited by path");
    expect(branch!.textContent).toContain("Archived branch · 3 commits");
    expect(branch!.textContent).toContain("feature/old");
    expect(workspace!.querySelector("[data-icon='FolderGit']")).not.toBeNull();
    expect(checkout!.querySelector("[data-icon='Folder']")).not.toBeNull();
    expect(branch!.querySelector("[data-icon='Archive']")).not.toBeNull();
  });

  it("marks an archived thread's chip and opens a thread in a split when its chip is clicked", async () => {
    const { slot } = await mount();
    await slot.findByText("cortex");
    for (const chip of slot.getAllByTitle("Open Parent thread")) expect(chip.querySelector("[data-icon='Archive']")).toBeNull();
    const archived = slot.getByTitle("Open Archived child");
    expect(archived.querySelector("[data-icon='Archive']")).not.toBeNull();
    fireEvent.click(archived);
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_2", options: { split: true } }]);
  });

  it("shows the machine only when the overview spans more than one", async () => {
    const single = await mount();
    await single.slot.findByText("cortex");
    expect(single.slot.container.textContent).not.toContain("Laptop");
    single.slot.lifecycle.unmount();
    const { slot } = await mount({
      overview: () => sampleOverview({ repos: [repo({ hostId: "host_1", hostName: "Laptop" }), checkoutRepo({ hostId: "host_2", hostName: "Dev box" })] }),
    });
    await slot.findByText("Dev box");
    expect(slot.container.textContent).toContain("Laptop");
  });

  it("loads a file's patch once, on first expand, and renders it in bb's diff viewer", async () => {
    const { slot, patch } = await mount();
    await slot.findByText("cortex");
    expect(diffs(slot)).toEqual([]);
    fireEvent.click(rowButton(slot, "src/a.ts"));
    await waitFor(() => expect(diffs(slot)).toEqual(["+patch for src/a.ts"]));
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]?.[0]).toEqual({
      ref: { kind: "workspace", environmentId: "env_1", base: "origin/main" },
      path: "src/a.ts", previousPath: null, untracked: false, scope: "uncommitted",
    });
    expect(slot.container.querySelector('[data-testid="bb-diff"]')?.getAttribute("data-path")).toBe("src/a.ts");

    fireEvent.click(rowButton(slot, "src/a.ts"));
    expect(diffs(slot)).toEqual([]);
    fireEvent.click(rowButton(slot, "src/a.ts"));
    await waitFor(() => expect(diffs(slot)).toEqual(["+patch for src/a.ts"]));
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("loads a fresh patch when the file's counts changed since it was cached", async () => {
    let additions = 2;
    const { slot, patch, overview } = await mount({
      overview: () => sampleOverview({
        repos: [repo({ files: [fileChange({ path: "src/a.ts", additions, deletions: 1 })] })],
      }),
    });
    await slot.findByText("src/a.ts".split("/")[1]!);
    fireEvent.click(rowButton(slot, "src/a.ts"));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    additions = 3;
    fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(overview).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
  });

  it("sends an untracked file and a renamed file's old path with the patch request", async () => {
    const { slot, patch } = await mount({
      overview: () => sampleOverview({
        repos: [checkoutRepo({
          files: [
            fileChange({ path: "new.md", status: "untracked", untracked: true, additions: 3, deletions: 0 }),
            fileChange({ path: "b.ts", previousPath: "a.ts", status: "renamed", additions: 0, deletions: 0 }),
          ],
        })],
      }),
    });
    await slot.findByText("cortex");
    fireEvent.click(rowButton(slot, "new.md"));
    fireEvent.click(rowButton(slot, "b.ts"));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch.mock.calls.map(([input]) => [input.path, input.previousPath, input.untracked, input.ref.kind])).toEqual([
      ["new.md", null, true, "checkout"], ["b.ts", "a.ts", false, "checkout"],
    ]);
  });

  it("shows notes for a binary file, a file that is too large and a cut patch without loading what it cannot show", async () => {
    const { slot, patch } = await mount({
      overview: () => sampleOverview({
        repos: [repo({
          files: [
            fileChange({ path: "pic.png", binary: true, additions: null, deletions: null }),
            fileChange({ path: "huge.json", tooLarge: true }),
            fileChange({ path: "long.ts" }),
            fileChange({ path: "swapped.png" }),
          ],
        })],
      }),
      patch: (input) => input.path === "swapped.png"
        ? { patch: "Binary files a/swapped.png and b/swapped.png differ", truncated: false, binary: true }
        : { patch: "+line", truncated: true, binary: false },
    });
    await slot.findByText("pic.png");
    for (const path of ["pic.png", "huge.json", "long.ts", "swapped.png"]) fireEvent.click(rowButton(slot, path));
    await waitFor(() => expect(row(slot, "long.ts").textContent).toContain("The diff was cut"));
    expect(row(slot, "pic.png").textContent).toContain("Binary file");
    expect(row(slot, "huge.json").textContent).toContain("Too large to show here");
    expect(row(slot, "swapped.png").textContent).toContain("Binary file");
    expect(patch.mock.calls.map(([input]) => input.path).sort()).toEqual(["long.ts", "swapped.png"]);
  });

  it("shows a load failure with a Retry that tries again", async () => {
    let attempts = 0;
    const { slot, patch } = await mount({
      patch: () => {
        attempts++;
        if (attempts === 1) throw new Error("git exploded");
        return { patch: "+ok", truncated: false, binary: false };
      },
    });
    await slot.findByText("cortex");
    fireEvent.click(rowButton(slot, "src/a.ts"));
    await waitFor(() => expect(row(slot, "src/a.ts").textContent).toContain("Could not load this diff: git exploded"));
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(diffs(slot)).toEqual(["+ok"]));
    expect(patch).toHaveBeenCalledTimes(2);
  });

  it("folds a checkout's other changes until the row is opened", async () => {
    const { slot } = await mount();
    await slot.findByText("cortex");
    expect(slot.container.querySelector('[data-file-row="unrelated.md"]')).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "1 other change in this repo" }));
    expect(row(slot, "unrelated.md")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "1 other change in this repo" }));
    expect(slot.container.querySelector('[data-file-row="unrelated.md"]')).toBeNull();
  });

  it("loads the recorded edits of a clean file and shows each one's diff under its thread and time", async () => {
    const edit = { threadId: "thr_2", at: Date.UTC(2026, 0, 5, 12, 30), kind: "update" as const, diff: "+recorded line", truncated: false };
    const { slot, recordedEdits, patch } = await mount({
      overview: () => sampleOverview({
        repos: [repo({
          files: [fileChange({
            path: "src/done.ts", status: "clean", additions: null, deletions: null,
            edits: { threadIds: ["thr_2"], rawPaths: ["/work/one/src/done.ts"], count: 1 },
          })],
        })],
      }),
      recordedEdits: () => ({ edits: [edit, { ...edit, at: edit.at + 1000, diff: null }] }),
    });
    await slot.findByText("done.ts");
    fireEvent.click(rowButton(slot, "src/done.ts"));
    await waitFor(() => expect(diffs(slot)).toEqual(["+recorded line"]));
    expect(recordedEdits.mock.calls[0]?.[0]).toEqual({ threadIds: ["thr_2"], rawPaths: ["/work/one/src/done.ts"] });
    expect(patch).not.toHaveBeenCalled();
    expect(row(slot, "src/done.ts").textContent).toContain("Archived child ·");
    expect(row(slot, "src/done.ts").textContent).toContain("No diff recorded for this edit.");
    expect(row(slot, "src/done.ts").textContent).toContain("unchanged");
  });

  it("shows recorded repositories and other files from their recorded edits", async () => {
    const { slot, recordedEdits, patch } = await mount({
      overview: () => sampleOverview({
        repos: [recordedRepo({ files: [fileChange({ path: "gone.ts", status: "added", edits: { threadIds: ["thr_2"], rawPaths: ["gone.ts"], count: 2 } })] })],
        otherFiles: [fileChange({ path: "/tmp/notes.md", status: "added", edits: { threadIds: ["thr_1"], rawPaths: ["/tmp/notes.md"], count: 1 } })],
      }),
      recordedEdits: (input) => ({ edits: [{ threadId: input.threadIds[0]!, at: 1, kind: "add", diff: `+from ${input.rawPaths[0]}`, truncated: false }] }),
    });
    await slot.findByText("Other files");
    expect(slot.container.textContent).toContain("Recorded edits only");
    fireEvent.click(rowButton(slot, "gone.ts"));
    fireEvent.click(rowButton(slot, "/tmp/notes.md"));
    await waitFor(() => expect(diffs(slot)).toEqual(["+from gone.ts", "+from /tmp/notes.md"]));
    expect(recordedEdits).toHaveBeenCalledTimes(2);
    expect(patch).not.toHaveBeenCalled();
  });

  it("marks files that agents edited and links live files to bb's file viewer", async () => {
    const { slot } = await mount();
    await slot.findByText("cortex");
    const edited = row(slot, "skills/x.md");
    expect(edited.querySelector("[data-icon='EditFile']")?.parentElement?.getAttribute("title")).toBe("Edited by Parent thread");
    expect(row(slot, "src/a.ts").querySelector("[data-icon='EditFile']")).toBeNull();
    fireEvent.click(slot.getByRole("link", { name: "Open src/a.ts" }));
    fireEvent.click(slot.getByRole("link", { name: "Open skills/x.md" }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "experimental_openFilePreview", options: { target: { kind: "workspace", environmentId: "env_1", path: "src/a.ts" }, location: null } },
      { method: "experimental_openFilePreview", options: { target: { kind: "host", hostId: "host_1", path: "/code/cortex/skills/x.md" }, location: null } },
    ]);
    expect(slot.queryByRole("link", { name: "Open lib/old.ts" })).toBeNull();
  });

  it("collapses and expands a repository from its header", async () => {
    const { slot } = await mount();
    await slot.findByText("cortex");
    expect(slot.container.querySelector('[data-file-row="src/a.ts"]')).toBeTruthy();
    fireEvent.click(repoHeader(slot, "host_1:/work/one"));
    expect(slot.container.querySelector('[data-file-row="src/a.ts"]')).toBeNull();
    expect(repoHeader(slot, "host_1:/work/one").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(repoHeader(slot, "host_1:/work/one"));
    expect(slot.container.querySelector('[data-file-row="src/a.ts"]')).toBeTruthy();
  });

  it("expands every repository and file at once, then collapses them again", async () => {
    const { slot, patch } = await mount();
    await slot.findByText("cortex");
    fireEvent.click(slot.getByRole("button", { name: "Expand all" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(4));
    expect(slot.getByRole("button", { name: "Collapse all" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Collapse all" }));
    expect(slot.container.querySelector('[data-file-row="src/a.ts"]')).toBeNull();
    expect(slot.container.querySelectorAll('[aria-expanded="true"]')).toHaveLength(0);
    fireEvent.click(slot.getByRole("button", { name: "Expand all" }));
    expect(slot.container.querySelector('[data-file-row="src/a.ts"]')).toBeTruthy();
  });

  it("reloads with the branch scope when Branch is chosen", async () => {
    const { slot, overview } = await mount({
      overview: (input) => sampleOverview({ scope: input.scope, warnings: [`scope ${input.scope}`] }),
    });
    await slot.findByText("scope uncommitted");
    expect(slot.getByRole("button", { name: "Uncommitted" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(slot.getByRole("button", { name: "Branch" }));
    await slot.findByText("scope branch");
    expect(overview.mock.calls.map(([input]) => input)).toEqual([
      { target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true },
      { target: { kind: "tree", threadId: "thr_1" }, scope: "branch", includeArchived: true },
    ]);
    expect(slot.getByRole("button", { name: "Branch" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("asks the server to forget its cache when Refresh is pressed", async () => {
    const { slot, overview } = await mount();
    await slot.findByText("cortex");
    fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(overview).toHaveBeenCalledTimes(2));
    expect(overview.mock.calls[1]?.[0]).toEqual({ target: { kind: "tree", threadId: "thr_1" }, scope: "uncommitted", includeArchived: true, refresh: true });
  });

  it("says Updating… while a refresh runs and keeps the repositories visible", async () => {
    let release: (value: Overview) => void = () => {};
    let calls = 0;
    const { slot } = await mount({
      overview: () => {
        calls++;
        return calls === 1 ? sampleOverview() : new Promise<Overview>((resolve) => { release = resolve; });
      },
    });
    await slot.findByText("cortex");
    fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
    await slot.findByText("Updating…");
    expect(slot.getByText("cortex")).toBeTruthy();
    release(sampleOverview({ warnings: ["done"] }));
    await slot.findByText("done");
    expect(slot.queryByText("Updating…")).toBeNull();
  });

  it("shows an unavailable repository's message and not its files", async () => {
    const { slot } = await mount({
      overview: () => sampleOverview({
        repos: [repo({ label: "Offline", state: "unavailable", message: "Dev box is not connected", files: [] }), checkoutRepo()],
      }),
    });
    const message = await slot.findByText("Dev box is not connected");
    expect(message.className).toContain("text-destructive-text");
    expect(slot.getByText("cortex")).toBeTruthy();
  });

  it("shows warnings, including a cut thread tree", async () => {
    const { slot } = await mount({
      overview: () => sampleOverview({ warnings: ["Could not reach Dev box: offline"], truncatedThreads: true }),
    });
    await slot.findByText("Could not reach Dev box: offline");
    expect(slot.getByText("Only the first 200 threads of this tree were read.")).toBeTruthy();
  });

  it("says when there are no changes", async () => {
    const { slot } = await mount({ overview: () => makeOverview({ threads: THREADS }) });
    await slot.findByText("No changes in this thread or its child threads yet.");
  });

  it("shows a load error with a Retry that loads again", async () => {
    let calls = 0;
    const { slot, overview } = await mount({
      overview: () => {
        calls++;
        if (calls === 1) throw new Error("bb is down");
        return sampleOverview();
      },
    });
    await slot.findByText(/Could not load changes: bb is down/);
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    await slot.findByText("cortex");
    expect(overview).toHaveBeenCalledTimes(2);
    expect(overview.mock.calls[1]?.[0]).toMatchObject({ refresh: true });
  });

  it("subscribes to realtime events for the thread tree and unsubscribes when it goes away", async () => {
    const { slot, subscribe, unsubscribed } = await mount();
    await slot.findByText("cortex");
    expect(subscribe.mock.calls.map(([args]) => args.event).sort()).toEqual(["environment:changed", "realtime:connection", "thread:changed"]);
    slot.lifecycle.unmount();
    expect(unsubscribed.sort()).toEqual(["environment:changed", "realtime:connection", "thread:changed"]);
  });
});
