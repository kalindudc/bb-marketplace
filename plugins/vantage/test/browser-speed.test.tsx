import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FileSidesOutput,
  Overview,
  OverviewInput,
  PatchOutput,
  PatchRequest,
  ReviewMarks,
  rpcContract,
} from "../src/contract";
import { clearLoadedCache } from "../src/loaded";
import { prefetchPatch } from "../src/file-card";
import { VantagePage } from "../src/page";
import { VantagePanel } from "../src/panel";
import { disposeSessions } from "../src/session";
import { useRowLines, useSegmentVisible } from "../src/thread-surfaces";
import { fileFolds, readerFiles, reloadUiState, setFoldAll } from "../src/ui-prefs";
import { readingKey } from "../src/reading-state";
import { fileChange, overview, sidebarThread, threadSummary, worktree } from "./fixtures";
import type { ComponentType } from "react";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
const tab = vi.hoisted(() => ({ visible: undefined as boolean | undefined }));
vi.mock(import("@get-bb/plugin-sdk/app"), async (original) => {
  const sdk = await original();
  return { ...sdk, experimental_useTabVisible: () => tab.visible ?? sdk.experimental_useTabVisible() };
});

const threads = [sidebarThread({ id: "thr_1" }), sidebarThread({ id: "thr_2", parentThreadId: "thr_1" })];
const checkout = worktree({ uncommitted: [fileChange()] });
const tree = overview({
  threads: [threadSummary(), threadSummary({ id: "thr_2", parentThreadId: "thr_1", depth: 1 })],
  worktrees: [checkout],
});
const outline = { ...tree, partial: true, worktrees: [{ ...checkout, state: "loading" as const, uncommitted: [] }] };
const PATCH = "@@ -1 +1 @@\n-a\n+b\n@@ -10 +10 @@\n-c\n+d\n";

const mounts: Array<ReturnType<typeof renderSlot>> = [];
afterEach(() => {
  for (const slot of mounts.splice(0)) slot.lifecycle.unmount();
  disposeSessions();
  clearLoadedCache();
  localStorage.clear();
  reloadUiState();
  tab.visible = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mount(
  component: ComponentType,
  options: {
    overview?: (input: OverviewInput) => Overview | Promise<Overview>;
    shell?: Overview;
    patch?: string;
    patchResponse?: (input: PatchRequest) => PatchOutput | Promise<PatchOutput>;
    sidesResponse?: (input: PatchRequest) => Promise<FileSidesOutput>;
    reviewed?: Promise<Record<string, ReviewMarks>>;
    fileSides?: { old: string | null; new: string | null };
    marks?: ReviewMarks;
    tabVisible?: boolean;
  } = {},
) {
  const threadChanges = new Set<(event: unknown) => void>();
  const slot = renderSlot<object, typeof rpcContract>(
    { component },
    {},
    {
      pluginId: "vantage",
      tabVisible: options.tabVisible ?? true,
      sidebarThreads: { status: "ready", threads },
      rpc: {
        shell: () => options.shell ?? outline,
        overview: options.overview ?? (() => tree),
        patch: options.patchResponse ?? (() => ({ patch: options.patch ?? PATCH, binary: false, truncated: false })),
        fileSides:
          options.sidesResponse ??
          (() =>
            options.fileSides ?? {
              old: ["a", ...Array<string>(8).fill("x"), "c"].join("\n"),
              new: ["b", ...Array<string>(8).fill("x"), "d"].join("\n"),
            }),
        image: () => ({ old: null, new: null, truncated: false }),
        commitFiles: () => ({ files: [] }),
        recordedEdits: () => ({ edits: [] }),
        reviewed: ({ keys }) => options.reviewed ?? Object.fromEntries(keys.map((key) => [key, options.marks ?? {}])),
        setReviewed: () => ({}),
        setWhole: () => ({ ok: true }),
      },
      sdk: {
        subscribe: (({ event, callback }: { event: string; callback: (value: unknown) => void }) => {
          if (event === "thread:changed") threadChanges.add(callback);
          return () => {
            threadChanges.delete(callback);
          };
        }) as never,
      },
    },
  );
  mounts.push(slot);
  return {
    ...slot,
    emitFileChange() {
      for (const callback of threadChanges)
        callback({
          entity: "thread",
          type: "changed",
          id: "thr_1",
          changes: ["events-appended"],
          metadata: { eventTypes: ["item/completed"] },
        });
    },
  };
}

const Panel = () => <VantagePanel threadId="thr_1" />;
const Page = () => <VantagePage subPath="tree/thr_1" />;
const never = () => new Promise<Overview>(() => {});

function deferredOverview() {
  let resolve!: (value: Overview) => void;
  const promise = new Promise<Overview>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

function Rows({ needed = true }: { needed?: boolean }) {
  const lines = useRowLines({ threads: needed ? threads : [] });
  return <output aria-label="Sidebar additions">{lines.get("thr_1")?.additions ?? "Waiting"}</output>;
}

const reads = (slot: ReturnType<typeof mount>) =>
  slot.inspection.rpcCalls.filter(({ method }) => method === "shell" || method === "overview");

describe("overview loading", () => {
  it("shares one shell and overview between the open panel and its thread surfaces", async () => {
    function ComposerSegment() {
      useSegmentVisible({ threadId: "thr_1" });
      return null;
    }
    const slot = mount(
      () => (
        <>
          <ComposerSegment />
          <Panel />
        </>
      ),
      { overview: never },
    );
    await within(slot.container).findByRole("navigation", { name: "Thread trail" });
    expect(reads(slot).map(({ method }) => method)).toEqual(["shell", "overview"]);
  });

  it("loads sidebar counts without an open thread or an active panel", async () => {
    const slot = mount(
      () => (
        <>
          <Rows />
          <Panel />
        </>
      ),
      { tabVisible: false, overview: ({ target }) => ({ ...tree, target }) },
    );
    await waitFor(() =>
      expect(within(slot.container).getByRole("status", { name: "Sidebar additions" }).textContent).toBe("2"),
    );
    expect(reads(slot).map(({ method, input }) => [method, (input as OverviewInput).target.kind])).toEqual([
      ["overview", "all"],
    ]);
  });

  it("loads sidebar counts when the thread overview fails after its shell arrives", async () => {
    let reject!: (error: Error) => void;
    const failing = new Promise<Overview>((_, fail) => {
      reject = fail;
    });
    const slot = mount(
      () => (
        <>
          <Rows />
          <Panel />
        </>
      ),
      {
        overview: ({ target }) => (target.kind === "tree" ? failing : { ...tree, target }),
      },
    );
    await within(slot.container).findByRole("navigation", { name: "Thread trail" });
    expect(reads(slot)).toHaveLength(2);
    await act(async () => reject(new Error("host lost")));
    await waitFor(() =>
      expect(within(slot.container).getByRole("status", { name: "Sidebar additions" }).textContent).toBe("2"),
    );
  });

  it("keeps refreshing sidebar counts after the user leaves a thread", async () => {
    vi.useFakeTimers();
    const slot = mount(
      () => (
        <>
          <Rows />
          <Panel />
        </>
      ),
      { overview: ({ target }) => ({ ...tree, target }) },
    );
    const allReads = () => reads(slot).filter(({ input }) => (input as OverviewInput).target.kind === "all");
    await act(async () => vi.advanceTimersByTimeAsync(32));
    expect(allReads()).toHaveLength(1);
    slot.lifecycle.rerender(<Rows />);
    await act(async () => vi.advanceTimersByTimeAsync(59_999));
    expect(allReads()).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(allReads()).toHaveLength(2);
  });

  it("catches up once when the Vantage tab returns while the composer still shares its store", async () => {
    function WithComposer() {
      useSegmentVisible({ threadId: "thr_1" });
      return <Panel />;
    }
    tab.visible = true;
    const slot = mount(WithComposer);
    await within(slot.container).findByRole("region", { name: "src/a.ts" });
    const count = reads(slot).length;
    tab.visible = false;
    slot.lifecycle.rerender(<WithComposer />);
    await act(async () => {});
    expect(reads(slot)).toHaveLength(count);
    tab.visible = true;
    slot.lifecycle.rerender(<WithComposer />);
    await act(async () => {});
    expect(reads(slot)).toHaveLength(count + 1);
  });

  it("preserves a comment being typed when the panel tab is hidden and shown again", async () => {
    tab.visible = true;
    const slot = mount(Panel);
    const view = within(slot.container);
    fireEvent.click(await view.findByRole("button", { name: "Comment on src/a.ts" }));
    const text = "Keep the draft across tabs.";
    fireEvent.change(view.getByRole("textbox", { name: "Comment" }), { target: { value: text } });
    tab.visible = false;
    slot.lifecycle.rerender(<Panel />);
    tab.visible = true;
    slot.lifecycle.rerender(<Panel />);
    expect((view.getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement).value).toBe(text);
  });

  it("does not ask for an all-threads overview when no sidebar row needs it", async () => {
    const slot = mount(() => (
      <>
        <Rows needed={false} />
        <Panel />
      </>
    ));
    await act(async () => {});
    expect(reads(slot)).toHaveLength(2);
  });

  it("waits for the tree overview before asking for row counts, then waits 60 seconds and skips hidden windows", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const first = deferredOverview();
    const slot = mount(
      () => (
        <>
          <Rows />
          <Panel />
        </>
      ),
      { overview: ({ target }) => (target.kind === "tree" ? first.promise : { ...tree, target }) },
    );
    const allCalls = () =>
      slot.inspection.rpcCalls.filter(
        ({ method, input }) => method === "overview" && (input as OverviewInput).target.kind === "all",
      );
    await act(async () => {});
    expect(allCalls()).toHaveLength(0);
    await act(async () => first.resolve(tree));
    await act(async () => vi.advanceTimersByTimeAsync(32));
    expect(allCalls()).toHaveLength(1);
    expect(within(slot.container).getByRole("status", { name: "Sidebar additions" }).textContent).toBe("2");
    await slot.behavior.emitRealtime("vantage:settings", {});
    await slot.behavior.emitRealtime("vantage:overview", {});
    await act(async () => vi.advanceTimersByTimeAsync(59_999));
    expect(allCalls()).toHaveLength(1);
    visibility.mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(allCalls()).toHaveLength(1);
    visibility.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(allCalls()).toHaveLength(2);
  });

  it("draws the panel's Trail from the shell before the overview returns", async () => {
    const slot = mount(Panel, { overview: never });
    const trail = await within(slot.container).findByRole("navigation", { name: "Thread trail" });
    expect(trail.querySelectorAll("[data-trail-thread]")).toHaveLength(2);
  });

  it("draws the page reader from the shell and applies its review marks when the overview returns", async () => {
    const first = deferredOverview();
    const slot = mount(Page, { overview: () => first.promise, marks: { "uncommitted\0src/a.ts": "modified:2:1:" } });
    const view = within(slot.container);
    await view.findByLabelText("Reading this worktree's git status…");
    expect(slot.inspection.navigateCalls).toHaveLength(0);
    await act(async () => first.resolve(tree));
    await view.findByRole("button", { name: "Show src/a.ts" });
  });

  it("shares one read between the panel and the full page when archive options match", async () => {
    localStorage.setItem("bb-plugin-vantage:page-archived", "true");
    const slot = mount(
      () => (
        <>
          <Panel />
          <Page />
        </>
      ),
      { overview: never },
    );
    await waitFor(() => expect(reads(slot).map(({ method }) => method)).toEqual(["shell", "overview"]));
  });

  it("uses the completed overview on remount without another cold load", async () => {
    vi.useFakeTimers();
    const slot = mount(Panel);
    await act(async () => {});
    expect(within(slot.container).getByRole("region", { name: "src/a.ts" })).toBeTruthy();
    slot.lifecycle.rerender(<></>);
    await act(async () => vi.advanceTimersByTimeAsync(31_000));
    slot.lifecycle.rerender(<Panel />);
    expect(within(slot.container).getByRole("region", { name: "src/a.ts" })).toBeTruthy();
    expect(reads(slot)).toHaveLength(2);
  });

  it("ignores 20 file events on a working tree and fetches once for its overview signal", async () => {
    vi.useFakeTimers();
    const slot = mount(Panel, { overview: () => ({ ...tree, threads: [threadSummary({ status: "active" })] }) });
    await act(async () => {});
    const count = () => reads(slot).filter(({ method }) => method === "overview").length;
    expect(count()).toBe(1);
    await act(async () => {
      for (let index = 0; index < 20; index++) {
        slot.emitFileChange();
        await vi.advanceTimersByTimeAsync(1000);
      }
    });
    expect(count()).toBe(1);
    await slot.behavior.emitRealtime("vantage:overview", {
      key: JSON.stringify(["tree", "thr_1", "uncommitted", true]),
    });
    expect(count()).toBe(2);
    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(count()).toBe(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(count()).toBe(3);
  });

  it("refetches the visible overview once on the realtime signal, without a hard refresh", async () => {
    localStorage.setItem("bb-plugin-vantage:page-archived", "true");
    const slot = mount(() => (
      <>
        <Panel />
        <Page />
      </>
    ));
    await waitFor(() => expect(within(slot.container).getAllByRole("region", { name: "src/a.ts" })).toHaveLength(2));
    const before = reads(slot).length;
    await slot.behavior.emitRealtime("vantage:overview", {
      key: JSON.stringify(["tree", "thr_1", "uncommitted", true]),
    });
    expect(reads(slot)).toHaveLength(before + 1);
    expect(reads(slot).at(-1)).toMatchObject({ method: "overview", input: { target: tree.target } });
    expect(reads(slot).at(-1)?.input).not.toHaveProperty("refresh");
  });

  it("refetches only a store whose target, scope and archived choice match the realtime key", async () => {
    const slot = mount(() => (
      <>
        <Panel />
        <Page />
      </>
    ));
    await waitFor(() => expect(within(slot.container).getAllByRole("region", { name: "src/a.ts" })).toHaveLength(2));
    const before = reads(slot).length;
    await slot.behavior.emitRealtime("vantage:overview", {});
    await slot.behavior.emitRealtime("vantage:overview", {
      key: JSON.stringify(["tree", "thr_other", "uncommitted", true]),
    });
    await slot.behavior.emitRealtime("vantage:overview", { key: JSON.stringify(["tree", "thr_1", "branch", true]) });
    expect(reads(slot)).toHaveLength(before);
    await slot.behavior.emitRealtime("vantage:overview", {
      key: JSON.stringify(["tree", "thr_1", "uncommitted", true]),
    });
    expect(reads(slot)).toHaveLength(before + 1);
    expect(reads(slot).at(-1)?.input).toMatchObject({ includeArchived: true });
    await slot.behavior.emitRealtime("vantage:overview", {
      key: JSON.stringify(["tree", "thr_1", "uncommitted", false]),
    });
    expect(reads(slot)).toHaveLength(before + 2);
    expect(reads(slot).at(-1)?.input).toMatchObject({ includeArchived: false });
  });
});

const numberedFiles = (count: number) => ({
  ...tree,
  worktrees: [
    {
      ...checkout,
      uncommitted: Array.from({ length: count }, (_, index) =>
        fileChange({ path: `src/${String(index + 1).padStart(2, "0")}.ts` }),
      ),
    },
  ],
});

function mockViewport() {
  type Intersects = (path: string, nearby: boolean, margin: string) => boolean;
  const observers = new Set<(intersects: Intersects) => void>();
  let last: Intersects | undefined;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      readonly elements = new Set<HTMLElement>();
      readonly dispatch: (intersects: Intersects) => void;
      constructor(
        callback: (entries: Array<{ target: HTMLElement; isIntersecting: boolean }>) => void,
        options?: IntersectionObserverInit,
      ) {
        this.dispatch = (intersects) =>
          callback(
            [...this.elements].map((target) => ({
              target,
              isIntersecting: intersects(
                target.dataset.fileCard!,
                options?.rootMargin !== "0px",
                options?.rootMargin ?? "0px",
              ),
            })),
          );
        observers.add(this.dispatch);
      }
      observe(target: HTMLElement) {
        this.elements.add(target);
        queueMicrotask(() => {
          if (last !== undefined && observers.has(this.dispatch) && this.elements.has(target)) this.dispatch(last);
        });
      }
      unobserve(target: HTMLElement) {
        this.elements.delete(target);
      }
      disconnect() {
        observers.delete(this.dispatch);
      }
    },
  );
  return (intersects: Intersects) => {
    last = intersects;
    for (const observe of observers) observe(intersects);
  };
}

describe("first and large diffs", () => {
  it("prioritizes the first screen's patches, then one context read at a time, then nearby patches", async () => {
    const inViewport = mockViewport();
    const releases = new Map<string, () => void>();
    const calls: string[] = [];
    let releasing = false;
    const pause =
      <T,>(method: string, value: T) =>
      ({ path }: PatchRequest) =>
        new Promise<T>((resolve) => {
          if (releasing) return resolve(value);
          const key = `${method}:${path}`;
          calls.push(key);
          releases.set(key, () => resolve(value));
        });
    mount(Panel, {
      overview: () => numberedFiles(6),
      patchResponse: pause("patch", { patch: PATCH, binary: false, truncated: false }),
      sidesResponse: pause("sides", { old: "a", new: "b" }),
    });
    try {
      await waitFor(() => expect(calls).toHaveLength(2));
      await act(async () => inViewport((path, nearby) => nearby || /\/0[12]\.ts$/.test(path)));
      const first = ["patch:src/01.ts", "patch:src/02.ts"];
      expect(calls).toEqual(first);
      await act(async () => releases.get(first[0]!)!());
      expect(calls).toEqual(first);
      await act(async () => releases.get(first[1]!)!());
      expect(calls).toEqual([...first, "sides:src/01.ts"]);
      await act(async () => releases.get("sides:src/01.ts")!());
      expect(calls).toEqual([...first, "sides:src/01.ts", "sides:src/02.ts"]);
      await act(async () => releases.get("sides:src/02.ts")!());
      await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(6));
      expect(calls.slice(4, 6)).toEqual(["patch:src/03.ts", "patch:src/04.ts"]);
    } finally {
      releasing = true;
      await act(async () => {
        for (const release of releases.values()) release();
      });
    }
  });
  it("does not prefetch a changed patch while the panel is hidden", async () => {
    mockViewport();
    let current = tree;
    function WithComposer() {
      useSegmentVisible({ threadId: "thr_1" });
      return <Panel />;
    }
    const slot = mount(WithComposer, { overview: () => current });
    const patches = () => slot.inspection.rpcCalls.filter(({ method }) => method === "patch");
    await waitFor(() => expect(patches()).toHaveLength(1));
    tab.visible = false;
    slot.lifecycle.rerender(<WithComposer />);
    current = {
      ...tree,
      generatedAt: tree.generatedAt + 1,
      worktrees: [{ ...checkout, uncommitted: [fileChange({ additions: 7 })] }],
    };
    await slot.behavior.emitRealtime("vantage:overview", {
      key: JSON.stringify(["tree", "thr_1", "uncommitted", true]),
    });
    await act(async () => {});
    expect(patches()).toHaveLength(1);
  });

  it("keeps every card and the unsent comment mounted when an all-folded review opens an uncached diff", async () => {
    setFoldAll(true);
    const next = numberedFiles(3);
    next.worktrees[0]!.uncommitted[0] = fileChange({ path: "src/01.ts", status: "clean" });
    const slot = mount(Panel, { overview: () => next });
    const view = within(slot.container);
    const clean = await view.findByRole("region", { name: "src/01.ts" });
    const card = view.getByRole("region", { name: "src/02.ts" });
    const third = view.getByRole("region", { name: "src/03.ts" });
    expect(within(clean).getByRole("button", { name: "Show src/01.ts" })).toBeTruthy();
    expect(slot.inspection.rpcCalls.filter(({ method }) => method === "patch")).toHaveLength(0);
    fireEvent.click(within(clean).getByRole("button", { name: "Comment on src/01.ts" }));
    const original = within(clean).getByRole<HTMLTextAreaElement>("textbox", { name: "Comment" });
    fireEvent.change(original, { target: { value: "Keep this unsent draft." } });
    fireEvent.click(within(card).getByRole("button", { name: "Show src/02.ts" }));
    await within(view.getByRole("region", { name: "src/02.ts" })).findByTestId("bb-diff");
    expect(view.getByRole("region", { name: "src/01.ts" })).toBe(clean);
    expect(view.getByRole("region", { name: "src/02.ts" })).toBe(card);
    expect(view.getByRole("region", { name: "src/03.ts" })).toBe(third);
    expect(within(clean).getByRole("textbox", { name: "Comment" })).toBe(original);
    expect(original.value).toBe("Keep this unsent draft.");
  });

  it("retries a failed early patch when its deferred card later mounts", async () => {
    const viewport = mockViewport();
    const subject = { threadId: "thr_1", source: "checkout", worktreeKey: checkout.key } as const;
    readerFiles.set(readingKey("panel:thr_1", subject), {
      scope: "all",
      anchor: { file: "src/01.ts", part: "uncommitted", offset: 0 },
    });
    const next = numberedFiles(3);
    next.worktrees[0]!.uncommitted[0] = fileChange({ path: "src/01.ts", binary: true });
    const patchResponse = vi.fn(async ({ path }: PatchRequest) => {
      if (path === "src/03.ts" && patchResponse.mock.calls.filter(([request]) => request.path === path).length === 1)
        throw new Error("Host was restarting");
      return { patch: PATCH, binary: false, truncated: false };
    });
    const slot = mount(Panel, { overview: () => next, patchResponse });
    const view = within(slot.container);
    await waitFor(() => expect(patchResponse.mock.calls.map(([{ path }]) => path)).toEqual(["src/02.ts", "src/03.ts"]));
    const deferred = view.getByRole("region", { name: "src/03.ts" });
    expect(deferred.querySelector("[data-card-body]")).toBeNull();
    await act(async () => viewport(() => true));
    await within(deferred).findByTestId("bb-diff");
    expect(patchResponse.mock.calls.map(([{ path }]) => path)).toEqual(["src/02.ts", "src/03.ts", "src/03.ts"]);
  });

  it("does not queue early patches for recorded-only evidence", async () => {
    const patch = vi.fn(async () => ({ patch: PATCH, binary: false, truncated: false }));
    const prioritizePatch = vi.fn(() => () => {});
    prefetchPatch({ key: "recorded:env", ref: { kind: "recorded" } }, fileChange(), "uncommitted", null, {
      patch,
      prioritizePatch,
      fileSides: vi.fn(),
      image: vi.fn(),
      recordedEdits: vi.fn(),
    });
    await act(async () => {});
    expect(patch).not.toHaveBeenCalled();
    expect(prioritizePatch).not.toHaveBeenCalled();
  });

  it("requests eligible resume patches in the overview task before mounting any cards, once each", async () => {
    vi.useFakeTimers();
    mockViewport();
    const subject = { threadId: "thr_1", source: "checkout", worktreeKey: checkout.key } as const;
    readerFiles.set(readingKey("panel:thr_1", subject), {
      scope: "all",
      anchor: { file: "src/40.ts", part: "uncommitted", offset: 0 },
    });
    fileFolds.set(`review\0${checkout.key}\0uncommitted\0src/41.ts`, true);
    const next = numberedFiles(47);
    next.worktrees[0]!.uncommitted.splice(
      39,
      5,
      fileChange({ path: "src/40.ts", binary: true }),
      fileChange({ path: "src/41.ts" }),
      fileChange({ path: "src/42.ts", tooLarge: true }),
      fileChange({ path: "src/43.png" }),
      fileChange({ path: "src/44.ts" }),
    );
    const loading = deferredOverview();
    const requested: Array<{ path: string; cards: number; time: number }> = [];
    const slot = mount(Panel, {
      overview: () => loading.promise,
      patchResponse: ({ path }) => {
        requested.push({ path, cards: slot.container.querySelectorAll("[data-file-card]").length, time: Date.now() });
        return { patch: PATCH, binary: false, truncated: false };
      },
    });
    await act(async () => {});
    const arrival = Date.now();
    await act(async () => loading.resolve(next));
    expect(requested).toEqual([
      { path: "src/44.ts", cards: 0, time: arrival },
      { path: "src/45.ts", cards: 0, time: arrival },
    ]);
    expect(within(slot.container).getByRole("region", { name: "src/40.ts" }).textContent).toContain("Binary file");
    expect(within(slot.container).getByRole("region", { name: "src/41.ts" }).textContent).not.toContain("Loading diff");
    await act(async () => vi.advanceTimersByTimeAsync(80));
    expect(requested.map(({ path }) => path)).toEqual(["src/44.ts", "src/45.ts"]);
  });

  it("mounts at most two bodies until a diff paints, then admits the nearest near body once per frame", async () => {
    vi.useFakeTimers();
    const inViewport = mockViewport();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const file = this.dataset.fileCard;
      const top = file === undefined ? 0 : Number(file.slice(4, 6)) * 100;
      return { top, bottom: top + (file === undefined ? 650 : 68) } as DOMRect;
    });
    let release!: (value: PatchOutput) => void;
    const patch = new Promise<PatchOutput>((resolve) => {
      release = resolve;
    });
    const slot = mount(Panel, { overview: () => numberedFiles(60), patchResponse: () => patch });
    const cards = () => slot.container.querySelectorAll("[data-file-card]").length;
    const bodies = () =>
      [...slot.container.querySelectorAll<HTMLElement>("[data-file-card] > div.overflow-hidden")].map(
        (node) => node.parentElement?.dataset.fileCard,
      );
    await act(async () => {});
    expect(cards()).toBe(6);
    expect(bodies()).toEqual(["src/01.ts", "src/02.ts"]);
    const frame = () =>
      act(async () => {
        vi.advanceTimersToNextFrame();
      });
    await frame();
    expect(cards()).toBe(60);
    act(() => inViewport((path, near, margin) => (near && margin !== "600px 0px" ? /\/0[378]\.ts$/.test(path) : true)));
    await frame();
    expect(bodies()).toEqual(["src/01.ts", "src/02.ts"]);
    await act(async () => release({ patch: PATCH, binary: false, truncated: false }));
    expect(within(slot.container).getAllByTestId("bb-diff")).toHaveLength(2);
    let count = 2;
    for (let i = 0; i < 5; i++) {
      await frame();
      const mounted = bodies().length;
      expect(mounted - count).toBeLessThanOrEqual(1);
      count = mounted;
      if (mounted >= 3) expect(bodies()).toContain("src/03.ts");
      if (mounted === 4) expect(bodies()).toContain("src/07.ts");
    }
    expect(bodies()).toEqual(["src/01.ts", "src/02.ts", "src/03.ts", "src/07.ts", "src/08.ts"]);
  });

  it("resumes mounting one body per frame at the one-second deadline when no diff paints", async () => {
    vi.useFakeTimers();
    const viewport = mockViewport();
    let release!: (value: PatchOutput) => void;
    const pending = new Promise<PatchOutput>((done) => {
      release = done;
    });
    const slot = mount(Panel, { overview: () => numberedFiles(4), patchResponse: () => pending });
    const bodies = () => slot.container.querySelectorAll("[data-card-body]").length;
    try {
      await act(async () => {});
      act(() => viewport(() => true));
      await act(async () => vi.advanceTimersByTimeAsync(999));
      expect(bodies()).toBe(2);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      await act(async () => {
        vi.advanceTimersToNextFrame();
      });
      expect(bodies()).toBe(3);
      await act(async () => {
        vi.advanceTimersToNextFrame();
      });
      expect(bodies()).toBe(4);
    } finally {
      await act(async () => release({ patch: PATCH, binary: false, truncated: false }));
    }
  });

  it("mounts and scrolls to file 40 when the reader jumps before the remaining headers mount", async () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    mockViewport();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const top = this.dataset.fileCard === "src/40.ts" ? 3000 : 0;
      return { top, bottom: top + 300 } as DOMRect;
    });
    const slot = mount(Panel, { overview: () => numberedFiles(60) });
    const files = await within(slot.container).findByRole("navigation", { name: "Files" });
    const findTarget = () => slot.container.querySelector<HTMLElement>('[data-file-card="src/40.ts"]');
    expect(findTarget()).toBeNull();
    fireEvent.click(within(files).getByTitle("src/40.ts"));
    const selected = findTarget();
    expect(selected).not.toBeNull();
    const card = within(selected!);
    await card.findByTestId("bb-diff");
    expect(slot.container.querySelector("[data-diff-stream]")?.scrollTop).toBe(3000);
    expect(slot.container.querySelectorAll("[data-file-card] > div.overflow-hidden").length).toBeLessThanOrEqual(3);
    const controls = within(slot.container.querySelector<HTMLElement>("[data-review-bar]")!);
    fireEvent.click(controls.getByRole("button", { name: "Collapse all diffs" }));
    expect(card.getByRole("button", { name: "Show src/40.ts" })).toBeTruthy();
    fireEvent.click(controls.getByRole("button", { name: "Expand all diffs" }));
    expect(card.getByRole("button", { name: "Hide src/40.ts" })).toBeTruthy();
    fireEvent.click(controls.getByRole("button", { name: "Focus on diffs" }));
    expect(card.getByTestId("bb-diff")).toBeTruthy();
  });

  it("starts a known patch before the full overview and review marks settle", async () => {
    const slot = mount(Panel, {
      shell: { ...tree, partial: true },
      overview: never,
      reviewed: new Promise(() => {}),
    });
    await within(slot.container).findByTestId("bb-diff");
    expect(slot.inspection.rpcCalls.map(({ method }) => method)).toEqual(expect.arrayContaining(["patch", "reviewed"]));
  });

  it("starts a patch from the warm thread overview while review marks are pending", async () => {
    function WithComposer() {
      useSegmentVisible({ threadId: "thr_1" });
      return <Panel />;
    }
    tab.visible = false;
    const slot = mount(WithComposer, { reviewed: new Promise(() => {}) });
    const methods = () => slot.inspection.rpcCalls.map(({ method }) => method);
    await waitFor(() => expect(methods()).toContain("reviewed"));
    expect(methods()).not.toContain("patch");
    tab.visible = true;
    slot.lifecycle.rerender(<WithComposer />);
    await within(slot.container).findByTestId("bb-diff");
    expect(methods()).toContain("patch");
  });

  it("lets the visible first diff paint before starting the sidebar overview", async () => {
    let release!: (value: PatchOutput) => void;
    const patch = new Promise<PatchOutput>((resolve) => {
      release = resolve;
    });
    const slot = mount(
      () => (
        <>
          <Rows />
          <Panel />
        </>
      ),
      {
        overview: ({ target }) => ({ ...tree, target }),
        patchResponse: () => patch,
      },
    );
    await within(slot.container).findByRole("region", { name: "src/a.ts" });
    const all = () => reads(slot).filter(({ input }) => (input as OverviewInput).target.kind === "all");
    expect(all()).toHaveLength(0);
    await act(async () => release({ patch: PATCH, binary: false, truncated: false }));
    await within(slot.container).findByTestId("bb-diff");
    await waitFor(() => expect(all()).toHaveLength(1));
  });

  it("does not request sides when the patch says one side is too large", async () => {
    const slot = mount(Panel, {
      patchResponse: async () => ({ patch: PATCH, binary: false, truncated: false, largeSides: true }),
    });
    await within(slot.container).findByText("Unchanged lines aren't available for large files");
    expect(within(slot.container).queryByRole("button", { name: "Expand context" })).toBeNull();
    expect(slot.inspection.rpcCalls.some(({ method }) => method === "fileSides")).toBe(false);
  });

  it("starts the first patch without waiting for viewport observation and reads sides once the card is on screen", async () => {
    const inViewport = mockViewport();
    const slot = mount(Panel);
    const card = await within(slot.container).findByRole("region", { name: "src/a.ts" });
    const methods = () => slot.inspection.rpcCalls.map(({ method }) => method);
    await waitFor(() => expect(methods()).toContain("patch"));
    const view = within(card);
    const diff = await view.findByTestId("bb-diff");
    expect(methods()).not.toContain("fileSides");
    expect(diff.getAttribute("data-has-full-file-contents")).toBe("false");
    expect(view.queryByRole("button", { name: "Expand context" })).toBeNull();
    act(() => inViewport(() => true));
    await waitFor(() => expect(diff.getAttribute("data-has-full-file-contents")).toBe("true"));
    expect(methods().filter((method) => method === "fileSides")).toHaveLength(1);
  });

  it.each(["added", "untracked", "deleted", "modified"] as const)(
    "only explains unavailable unchanged lines when both sides of a %s file were expected",
    async (status) => {
      const slot = mount(Panel, {
        overview: () => ({ ...tree, worktrees: [{ ...checkout, uncommitted: [fileChange({ status })] }] }),
        fileSides: { old: status === "deleted" ? "old" : null, new: status === "deleted" ? null : "new" },
      });
      const card = within(await within(slot.container).findByRole("region", { name: "src/a.ts" }));
      await card.findByTestId("bb-diff");
      await waitFor(() => expect(slot.inspection.rpcCalls.some(({ method }) => method === "fileSides")).toBe(true));
      await act(async () => {});
      expect(card.queryByText("Unchanged lines aren’t available for this diff.") !== null).toBe(status === "modified");
    },
  );

  it("requires Show diff for a 1,300-line patch over 48 KiB", async () => {
    const patch = `@@ -0,0 +1,1299 @@\n${`+${"x".repeat(44)}\n`.repeat(1299)}`;
    const slot = mount(Panel, { patch });
    const card = within(await within(slot.container).findByRole("region", { name: "src/a.ts" }));
    const show = await card.findByRole("button", { name: "Show diff" });
    expect(card.queryByTestId("bb-diff")).toBeNull();
    expect(slot.inspection.rpcCalls.some(({ method }) => method === "fileSides")).toBe(false);
    fireEvent.click(show);
    await card.findByTestId("bb-diff");
  });

  it("requires an explicit Show diff click before drawing a patch longer than 2,000 lines", async () => {
    const patch = `@@ -1 +1,2101 @@\n a\n${"+extra\n".repeat(2100)}`;
    const slot = mount(Panel, { patch });
    const card = await within(slot.container).findByRole("region", { name: "src/a.ts" });
    const show = await within(card).findByRole("button", { name: "Show diff" });
    expect(card.textContent).not.toContain("+extra");
    fireEvent.click(show);
    await waitFor(() => expect(card.textContent).toContain("extra"));
  });
});
