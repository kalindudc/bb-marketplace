import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { BoardDetail, BoardSummary } from "../../src/contract";
import { formatRoute } from "../../src/ui/route";
import { reloadPrefs } from "../../src/ui/prefs";
import { app, callsTo, find, handlers, lastNavigation, mine, mount, overview, page, pr, server, setViewport, unmountAll, type Handlers } from "./helpers";

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), toasts) }));
afterEach(() => { unmountAll(); vi.clearAllMocks(); });

const activeBoard: BoardSummary = {
  id: "release",
  name: "October release",
  description: "The desktop and platform PRs we want to ship together.",
  createdAt: Date.now() - 3 * 24 * 60 * 60_000,
  updatedAt: Date.now() - 60 * 60_000,
  archivedAt: null,
  createdBy: "You",
  prCount: 2,
  attention: 1,
  ready: 1,
  merged: 0,
  preview: [
    { key: "github:acme/desktop#128", title: "Add saved workspaces to the sidebar", state: "open" },
    { key: "delta:shop/platform#482", title: "Roll out the new session routing contract", state: "draft" },
  ],
};

const archivedBoard: BoardSummary = {
  id: "handoff",
  name: "Review handoff",
  description: "A short list for the next review session.",
  createdAt: Date.now() - 5 * 24 * 60 * 60_000,
  updatedAt: Date.now() - 2 * 24 * 60 * 60_000,
  archivedAt: Date.now() - 24 * 60 * 60_000,
  createdBy: "You",
  prCount: 1,
  attention: 0,
  ready: 0,
  merged: 0,
  preview: [{ key: "github:acme/desktop#131", title: "Keep review comments attached after a rebase", state: "open" }],
};

function boardPage(subPath: string, rpc: Partial<Handlers> = {}) {
  return page(subPath, {
    overview: () => overview({ servers: [server()], counts: { inbox: 2, mine: 3, done: 1, reviews: 12 } }),
    list: ({ area }: { area: "mine" | "done" | "reviews" }) => ({ prs: area === "mine" ? [mine({ number: 1, title: "Retry 429s in the edge router" }), mine({ number: 2, title: "Edge cache keys" })] : [] }),
    detail: ({ key }: { key: string }) => ({ pr: mine({ number: key.endsWith("#1") ? 1 : 2, title: key.endsWith("#1") ? "Retry 429s in the edge router" : "Edge cache keys" }), events: [], body: "", draft: null }),
    search: () => ({ prs: [], total: 0 }),
    activity: () => ({ events: [] }),
    boards: ({ archived }: { archived?: "exclude" | "include" | "only" }) => ({
      boards: archived === "only" ? [archivedBoard] : archived === "include" ? [activeBoard, archivedBoard] : [activeBoard],
    }),
    board: ({ id }: { id: string }) => ({
      board: id === archivedBoard.id ? archivedBoard : activeBoard,
      prs: [],
      activity: [],
    }),
    boardCreate: ({ name, description = "", prs = [] }: { name: string; description?: string; prs?: string[] }) => ({
      board: {
        id: "launch",
        name,
        description,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        archivedAt: null,
        createdBy: "You",
        prCount: prs.length,
        attention: 0,
        ready: 0,
        merged: 0,
        preview: [],
      },
      prs: [],
      activity: [],
    }),
    ...rpc,
  });
}

describe("board overview", () => {
  it("shows active and archived boards, then opens one from the overview", async () => {
    const { slot } = await boardPage("boards", {
      boards: ({ archived }: { archived?: "exclude" | "include" | "only" }) => ({ boards: archived === "only" ? [archivedBoard] : archived === "include" ? [activeBoard, archivedBoard] : [activeBoard] }),
    });
    await find(slot.container, "[data-board-card]");
    expect(slot.getByRole("heading", { name: "Boards" })).toBeTruthy();
    expect(within(slot.container).getByRole("button", { name: /Active/u }).getAttribute("aria-pressed")).toBe("true");
    expect(within(slot.container).getByText("October release")).toBeTruthy();
    fireEvent.click(within(slot.container).getByRole("button", { name: /Archived/u }));
    await waitFor(() => expect(within(slot.container).getByText("Review handoff")).toBeTruthy());
    fireEvent.click(within(slot.container).getByRole("button", { name: /Active/u }));
    await waitFor(() => expect(within(slot.container).getByText("October release")).toBeTruthy());
    fireEvent.click(within(slot.container).getByRole("button", { name: /October release/u }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "board/release" } });
  });

  it.each(["inbox", "mine", "reviews", "insights", "search"])("uses an ordinary Boards navigation row without a submenu on %s", async (subPath) => {
    localStorage.setItem("bb-plugin-shuttle:boards-collapsed", "false");
    reloadPrefs();
    const loaded = await app();
    const slot = mount(loaded.navPanels[0]!.experimental_sidebar!, { subPath }, handlers({
      boards: () => ({ boards: [activeBoard] }),
    }));
    const nav = slot.getByRole("navigation", { name: "Shuttle areas" });
    const boards = within(nav).getByRole("button", { name: /^Boards/u });
    await waitFor(() => expect(boards.querySelector("[data-count]")?.textContent).toBe("1"));
    const other = within(nav).getByRole("button", { name: subPath === "insights" ? /^Inbox/u : "Insights" });
    expect(boards.className).toBe(other.className);
    expect(boards.parentElement).toBe(nav);
    expect(boards.getAttribute("aria-current")).toBeNull();
    expect(nav.querySelector("[aria-expanded]")).toBeNull();
    expect(within(nav).queryByText(activeBoard.name)).toBeNull();
    fireEvent.click(boards);
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "boards" } });
  });

  it.each(["boards", "boards/archived", "board/release"])("shows board links only while Boards is active on %s, ignoring the old collapse preference", async (subPath) => {
    localStorage.setItem("bb-plugin-shuttle:boards-collapsed", "true");
    reloadPrefs();
    const loaded = await app();
    const slot = mount(loaded.navPanels[0]!.experimental_sidebar!, { subPath }, handlers({
      boards: () => ({ boards: [activeBoard] }),
    }));
    const nav = slot.getByRole("navigation", { name: "Shuttle areas" });
    const member = await waitFor(() => within(nav).getByRole("button", { name: /October release/u }));
    const boards = within(nav).getByRole("button", { name: /^Boards/u });
    expect(boards.parentElement).toBe(nav);
    expect(boards.getAttribute("aria-current")).toBe("page");
    expect(member.getAttribute("aria-current")).toBe(subPath === "board/release" ? "page" : null);
    expect(nav.querySelector("[aria-expanded]")).toBeNull();
    expect(within(nav).queryByText(archivedBoard.name)).toBeNull();
    fireEvent.click(member);
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "board/release" } });
  });
});

describe("board selection", () => {
  it("saves a selected PR set as a new board from My PRs", async () => {
    const created: Array<{ name: string; description?: string; prs?: string[] }> = [];
    const { slot } = await boardPage("mine", {
      boardCreate: (input: { name: string; description?: string; prs?: string[] }) => {
        created.push(input);
        return {
          board: {
            id: "launch",
            name: input.name,
            description: input.description ?? "",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            archivedAt: null,
            createdBy: "You",
            prCount: input.prs?.length ?? 0,
            attention: 0,
            ready: 0,
            merged: 0,
            preview: [],
          },
          prs: [],
          activity: [],
        };
      },
    });
    const first = await find(slot.container, `[data-pr="github:get-bb/bb#1"]`);
    const second = await find(slot.container, `[data-pr="github:get-bb/bb#2"]`);
    fireEvent.click(within(first).getByRole("checkbox"));
    fireEvent.click(within(second).getByRole("checkbox"));
    fireEvent.click(within(slot.container).getByRole("button", { name: /Save as new board/u }));
    const dialog = await slot.findByRole("dialog", { name: /Create board/u });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Board name/u }), { target: { value: "Release candidate" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create board/u }));
    await waitFor(() => expect(created).toEqual([{ name: "Release candidate", description: "", prs: ["github:get-bb/bb#1", "github:get-bb/bb#2"] }]));
    await waitFor(() => expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "board/launch" } }));
  });

  it("passes pasted raw links through unchanged", async () => {
    const raw = "https://ghe.example.com/acme/desktop/pull/128";
    const received: string[][] = [];
    const { slot } = await boardPage("board/release", {
      board: () => ({ board: { ...activeBoard, prCount: 0, preview: [] }, prs: [], activity: [] }),
      boardAdd: ({ prs }: { id: string; prs: string[] }) => {
        received.push(prs);
        return { board: { ...activeBoard, prCount: prs.length, preview: [] }, added: prs, alreadyPresent: [] };
      },
    });
    await slot.findByRole("button", { name: /Add PRs/u });
    fireEvent.click(within(slot.container).getByRole("button", { name: /Add PRs/u }));
    const dialog = await slot.findByRole("dialog", { name: /Add PRs/u });
    fireEvent.click(within(dialog).getByRole("button", { name: /Paste links/u }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: /PR links or keys/u }), { target: { value: raw } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Add 1/u }));
    await waitFor(() => expect(received).toEqual([[raw]]));
  });

  it("refreshes the board detail after a membership write", async () => {
    let boardDetail: BoardDetail = {
      board: { ...activeBoard, prCount: 0, attention: 0, ready: 0, merged: 0, preview: [] },
      prs: [],
      activity: [],
    };
    const { slot } = await boardPage("board/release", {
      board: () => boardDetail,
      boardAdd: ({ prs }: { id: string; prs: string[] }) => {
        boardDetail = {
          board: { ...boardDetail.board, prCount: boardDetail.prs.length + prs.length, updatedAt: Date.now(), preview: [{ key: prs[0]!, title: "Retry 429s in the edge router", state: "open" }] },
          prs: [mine({ number: 1, title: "Retry 429s in the edge router" })],
          activity: [],
        };
        return { board: boardDetail.board, added: prs, alreadyPresent: [] };
      },
    });
    await slot.findByRole("button", { name: /Add PRs/u });
    fireEvent.click(within(slot.container).getByRole("button", { name: /Add PRs/u }));
    const dialog = await slot.findByRole("dialog", { name: /Add PRs/u });
    fireEvent.click(within(dialog).getByRole("button", { name: /Paste links/u }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: /PR links or keys/u }), { target: { value: "github:get-bb/bb#1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Add 1/u }));
    await waitFor(() => expect(within(slot.container).getByText("Retry 429s in the edge router")).toBeTruthy());
    expect(within(slot.container).getByText("1 saved PR")).toBeTruthy();
  });
});

const member = mine({ number: 1, title: "Retry 429s in the edge router" });
const mergedMember = mine({ number: 2, title: "Edge cache keys", state: "merged" });
const populated = { board: { ...activeBoard, preview: [] }, prs: [member, mergedMember], activity: [] };

describe("board sorting and grouping", () => {
  const older = mine({ number: 11, title: "Older change", repo: "acme/zebra", author: "zoe", createdAt: 100, updatedAt: 400, closedAt: null, additions: 2, deletions: 1 });
  const newer = pr({ number: 12, title: "Newer change", repo: "acme/alpha", author: "alice", createdAt: 300, updatedAt: 200, closedAt: 500, state: "merged", additions: 20, deletions: 10 });
  const prs = [older, newer];
  const rpc = { board: () => ({ ...populated, prs }) };
  const keysIn = (root: ParentNode) => [...root.querySelectorAll("[data-pr]")].map((row) => row.getAttribute("data-pr"));
  const change = (slot: Awaited<ReturnType<typeof boardPage>>["slot"], name: string, value: string) => fireEvent.change(slot.getByRole("combobox", { name }), { target: { value } });

  it("defaults to the saved order without groups", async () => {
    const { slot } = await boardPage("board/release", rpc);
    await find(slot.container, "[data-pr]");
    expect((slot.getByRole("combobox", { name: "Sort by" }) as HTMLSelectElement).value).toBe("saved");
    expect((slot.getByRole("combobox", { name: "Group by" }) as HTMLSelectElement).value).toBe("none");
    expect(keysIn(slot.getByRole("list", { name: "Board PRs" }))).toEqual(prs.map((pr) => pr.key));
    expect(slot.container.querySelector("[data-group]")).toBeNull();
  });

  it.each([
    ["updated", [older.key, newer.key]],
    ["newest", [newer.key, older.key]],
    ["oldest", [older.key, newer.key]],
    ["closed", [newer.key, older.key]],
    ["repo", [newer.key, older.key]],
    ["size", [newer.key, older.key]],
  ])("sorts board PRs by %s and can return to saved order", async (sort, expected) => {
    const { slot } = await boardPage("board/release", rpc);
    await find(slot.container, "[data-pr]");
    change(slot, "Sort by", sort as string);
    expect(keysIn(slot.container)).toEqual(expected);
    change(slot, "Sort by", "saved");
    expect(keysIn(slot.container)).toEqual(prs.map((pr) => pr.key));
    for (const method of ["boardUpdate", "boardAdd", "boardRemove"]) expect(callsTo(slot, method)).toEqual([]);
  });

  it.each([
    ["status", ["Open", "Merged"]],
    ["repo", ["acme/alpha · GitHub", "acme/zebra · GitHub"]],
    ["author", ["alice", "zoe"]],
    ["server", ["GitHub"]],
  ])("groups board PRs by %s", async (group, titles) => {
    const { slot } = await boardPage("board/release", rpc);
    await find(slot.container, "[data-pr]");
    change(slot, "Group by", group as string);
    expect([...slot.container.querySelectorAll("[data-group]")].map((section) => section.getAttribute("data-group"))).toEqual(titles);
    expect(keysIn(slot.container).sort()).toEqual(prs.map((pr) => pr.key).sort());
    change(slot, "Group by", "none");
    expect(keysIn(slot.getByRole("list", { name: "Board PRs" }))).toEqual(prs.map((pr) => pr.key));
  });

  it("sorts inside groups and applies filters before grouping and counting", async () => {
    const openNewer = { ...newer, state: "open" as const };
    const { slot } = await boardPage("board/release", { board: () => ({ ...populated, prs: [older, openNewer] }) });
    await find(slot.container, "[data-pr]");
    change(slot, "Group by", "status");
    change(slot, "Sort by", "newest");
    const section = slot.getByRole("region", { name: "Open" });
    expect(keysIn(section)).toEqual([newer.key, older.key]);
    expect(within(section).getByRole("button", { name: /^Open\s*2$/u })).toBeTruthy();
    fireEvent.change(slot.getByRole("textbox", { name: "Filter board PRs" }), { target: { value: "Older" } });
    expect(keysIn(section)).toEqual([older.key]);
    expect(within(section).getByRole("button", { name: /^Open\s*1$/u })).toBeTruthy();
    change(slot, "Board status", "merged");
    expect(slot.container.querySelector("[data-group]")).toBeNull();
    expect(slot.getByText("No matching PRs.")).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Collapse all" })).toBeNull();
  });

  it("keeps selection and PR navigation working across grouping and sorting", async () => {
    const { slot } = await boardPage("board/release", rpc);
    fireEvent.click(within(await find(slot.container, `[data-pr="${older.key}"]`)).getByRole("checkbox"));
    change(slot, "Sort by", "newest");
    change(slot, "Group by", "status");
    expect((within(slot.getByRole("region", { name: "Open" })).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect(slot.getByText("1 selected")).toBeTruthy();
    fireEvent.click(await find(slot.container, `[data-pr="${newer.key}"]`));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: formatRoute({ view: "board", id: "release", key: newer.key }) } });
  });

  it("remembers choices and folded groups per board without folding activity", async () => {
    const handlers = { board: ({ id }: { id: string }) => ({ ...populated, board: { ...activeBoard, id, name: id }, prs }) };
    const first = await boardPage("board/release", handlers);
    await find(first.slot.container, "[data-pr]");
    change(first.slot, "Sort by", "newest");
    change(first.slot, "Group by", "status");
    fireEvent.click(within(first.slot.getByRole("region", { name: "Open" })).getByRole("button", { name: /^Open\s*1$/u }));
    first.route("board/other");
    await first.slot.findByRole("heading", { name: "other" });
    expect((first.slot.getByRole("combobox", { name: "Sort by" }) as HTMLSelectElement).value).toBe("saved");
    expect((first.slot.getByRole("combobox", { name: "Group by" }) as HTMLSelectElement).value).toBe("none");
    change(first.slot, "Group by", "status");
    expect(keysIn(first.slot.getByRole("region", { name: "Open" }))).toEqual([older.key]);
    first.slot.lifecycle.unmount();
    reloadPrefs();

    const { slot } = await boardPage("board/release", handlers);
    await slot.findByRole("heading", { name: "release" });
    expect((slot.getByRole("combobox", { name: "Sort by" }) as HTMLSelectElement).value).toBe("newest");
    expect((slot.getByRole("combobox", { name: "Group by" }) as HTMLSelectElement).value).toBe("status");
    expect(keysIn(slot.getByRole("region", { name: "Open" }))).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Collapse all" }));
    expect(keysIn(slot.container)).toEqual([]);
    expect(slot.getByRole("button", { name: /^Activity/u }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(slot.getByRole("button", { name: "Expand all" }));
    expect(keysIn(slot.container)).toEqual([older.key, newer.key]);
  });

  it("keeps repositories, servers, and authors separate across servers with the same display name", async () => {
    const delta = { ...older, key: `delta:${older.repo}#11`, server: "delta" };
    const { slot } = await boardPage("board/release", { board: () => ({ ...populated, prs: [older, delta] }) });
    await find(slot.container, "[data-pr]");
    for (const group of ["repo", "server", "author"]) {
      change(slot, "Group by", group);
      const sections = [...slot.container.querySelectorAll("[data-group]")];
      expect(sections).toHaveLength(2);
      expect(keysIn(sections[0]!)).toHaveLength(1);
      expect(keysIn(sections[1]!)).toHaveLength(1);
      fireEvent.click(within(sections[0]! as HTMLElement).getByRole("button"));
      expect(keysIn(sections[0]!)).toEqual([]);
      expect(keysIn(sections[1]!)).toHaveLength(1);
    }
  });

  it("allows sorting and grouping archived boards without enabling membership edits", async () => {
    const { slot } = await boardPage("board/handoff", { board: () => ({ ...populated, board: archivedBoard, prs }) });
    await find(slot.container, "[data-pr]");
    change(slot, "Sort by", "newest");
    change(slot, "Group by", "server");
    expect(keysIn(slot.getByRole("region", { name: "GitHub" }))).toEqual([newer.key, older.key]);
    expect(slot.queryByRole("checkbox")).toBeNull();
    expect(slot.queryByRole("button", { name: "Add PRs" })).toBeNull();
  });

  it("ignores invalid saved preferences without discarding another board's choices", async () => {
    localStorage.setItem("bb-plugin-shuttle:board-views", JSON.stringify({ release: { sort: "missing", group: [] }, other: { sort: "newest", group: "status" } }));
    reloadPrefs();
    const { slot, route } = await boardPage("board/release", {
      board: ({ id }: { id: string }) => ({ ...populated, board: { ...activeBoard, id, name: id }, prs }),
    });
    await find(slot.container, "[data-pr]");
    expect((slot.getByRole("combobox", { name: "Sort by" }) as HTMLSelectElement).value).toBe("saved");
    expect((slot.getByRole("combobox", { name: "Group by" }) as HTMLSelectElement).value).toBe("none");
    route("board/other");
    await slot.findByRole("heading", { name: "other" });
    expect((slot.getByRole("combobox", { name: "Sort by" }) as HTMLSelectElement).value).toBe("newest");
    expect((slot.getByRole("combobox", { name: "Group by" }) as HTMLSelectElement).value).toBe("status");
  });
});

describe("board layout and activity", () => {
  const activity: BoardDetail["activity"] = [
    { id: 2, at: Date.now(), text: "Added 1 PR.", threadId: null },
    { id: 1, at: Date.now() - 60_000, text: "Created the board with 2 PRs.", threadId: "thr_creator" },
  ];

  it("separates the filters from the PR list", async () => {
    const { slot } = await boardPage("board/release", { board: () => populated });
    await find(slot.container, `[data-pr="${member.key}"]`);
    expect(slot.getByRole("combobox", { name: "Board status" }).parentElement!.classList.contains("mb-5")).toBe(true);
  });

  it("renders activity as compact timestamped log lines instead of cards", async () => {
    const { slot } = await boardPage("board/release", { board: () => ({ ...populated, activity }) });
    const log = await slot.findByRole("list", { name: "Board activity log" });
    expect(log.classList.contains("font-mono")).toBe(true);
    const lines = within(log).getAllByRole("listitem");
    expect(lines).toHaveLength(2);
    for (const [index, line] of lines.entries()) {
      expect(line.textContent).toContain(activity[index]!.text);
      expect(line.querySelector("time")?.getAttribute("datetime")).toBe(new Date(activity[index]!.at).toISOString());
      expect(line.classList.contains("flex")).toBe(true);
      expect(line.className).not.toContain("rounded");
      expect(line.className).not.toContain("border");
    }
    expect(lines[1]!.title).toContain("thr_creator");
  });

  it("hides activity, remembers the fold, and restores it without changing the PR set", async () => {
    const rpc = { board: () => ({ ...populated, activity }) };
    const first = await boardPage("board/release", rpc);
    const toggle = await first.slot.findByRole("button", { name: /^Activity/u });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(first.slot.queryByRole("list", { name: "Board activity log" })).toBeNull();
    expect(within(first.slot.getByRole("list", { name: "Board PRs" })).getAllByRole("listitem")).toHaveLength(2);
    first.slot.lifecycle.unmount();

    const { slot } = await boardPage("board/release", rpc);
    const remembered = await slot.findByRole("button", { name: /^Activity/u });
    expect(remembered.getAttribute("aria-expanded")).toBe("false");
    expect(slot.queryByRole("list", { name: "Board activity log" })).toBeNull();
    fireEvent.click(remembered);
    expect(remembered.getAttribute("aria-expanded")).toBe("true");
    expect(within(slot.getByRole("list", { name: "Board activity log" })).getAllByRole("listitem")).toHaveLength(2);
    for (const mounted of [first.slot, slot]) {
      for (const method of ["boardCreate", "boardUpdate", "boardAdd", "boardRemove"]) expect(callsTo(mounted, method)).toEqual([]);
    }
  });

  it("remembers the activity fold separately for each board", async () => {
    const { slot, route } = await boardPage("board/release", {
      board: ({ id }: { id: string }) => ({ ...populated, board: { ...populated.board, id, name: id === "other" ? "Other board" : activeBoard.name }, activity }),
    });
    fireEvent.click(await slot.findByRole("button", { name: /^Activity/u }));
    route("board/other");
    await slot.findByRole("heading", { name: "Other board" });
    expect(slot.getByRole("button", { name: /^Activity/u }).getAttribute("aria-expanded")).toBe("true");
    expect(slot.getByRole("list", { name: "Board activity log" })).toBeTruthy();
    route("board/release");
    await slot.findByRole("heading", { name: activeBoard.name });
    expect(slot.getByRole("button", { name: /^Activity/u }).getAttribute("aria-expanded")).toBe("false");
    expect(slot.queryByRole("list", { name: "Board activity log" })).toBeNull();
  });

  it("can hide and reveal the empty activity message", async () => {
    const { slot } = await boardPage("board/release", { board: () => populated });
    const toggle = await slot.findByRole("button", { name: /^Activity/u });
    expect(slot.getByText("No activity yet.")).toBeTruthy();
    fireEvent.click(toggle);
    expect(slot.queryByText("No activity yet.")).toBeNull();
    fireEvent.click(toggle);
    expect(slot.getByText("No activity yet.")).toBeTruthy();
  });
});

describe("board management safeguards", () => {
  it("clears selection, filters, and dialogs when navigating to another board", async () => {
    const { slot, route } = await boardPage("board/release", {
      board: ({ id }: { id: string }) => ({ ...populated, board: { ...populated.board, id, name: id === "other" ? "Other board" : activeBoard.name } }),
    });
    const first = await find(slot.container, `[data-pr="${member.key}"]`);
    fireEvent.click(within(first).getByRole("checkbox"));
    fireEvent.change(slot.getByRole("textbox", { name: "Filter board PRs" }), { target: { value: "Retry" } });
    fireEvent.click(slot.getByRole("button", { name: "Add PRs" }));
    expect(await slot.findByRole("dialog", { name: "Add PRs" })).toBeTruthy();
    route("board/other");
    await slot.findByRole("heading", { name: "Other board" });
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect((slot.getByRole("textbox", { name: "Filter board PRs" }) as HTMLInputElement).value).toBe("");
    expect((within(await find(slot.container, `[data-pr="${member.key}"]`)).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(slot.queryByText("1 selected")).toBeNull();
  });

  it("confirms removal and undoes only the members actually removed", async () => {
    const { slot } = await boardPage("board/release", {
      board: () => populated,
      boardRemove: () => ({ board: populated.board, removed: [member.key] }),
      boardAdd: () => ({ board: populated.board, added: [member.key], alreadyPresent: [] }),
    });
    fireEvent.click(within(await find(slot.container, `[data-pr="${member.key}"]`)).getByRole("checkbox"));
    fireEvent.click(slot.getByRole("button", { name: "Remove selected" }));
    expect(callsTo(slot, "boardRemove")).toEqual([]);
    const dialog = await slot.findByRole("dialog", { name: "Remove PRs from this board?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(callsTo(slot, "boardRemove")).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Remove selected" }));
    fireEvent.click(within(await slot.findByRole("dialog")).getByRole("button", { name: "Remove 1 PR" }));
    await waitFor(() => expect(callsTo(slot, "boardRemove")).toEqual([{ id: "release", prs: [member.key] }]));
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    toasts.success.mock.calls.at(-1)![1].action.onClick();
    await waitFor(() => expect(callsTo(slot, "boardAdd")).toEqual([{ id: "release", prs: [member.key] }]));
  });

  it("can save or add a board's selection to another board", async () => {
    const other = { ...populated.board, id: "other", name: "Other board" };
    const { slot } = await boardPage("board/release", {
      board: () => populated,
      boards: () => ({ boards: [other] }),
      boardAdd: () => ({ board: other, added: [member.key], alreadyPresent: [] }),
    });
    fireEvent.click(within(await find(slot.container, `[data-pr="${member.key}"]`)).getByRole("checkbox"));
    fireEvent.click(slot.getByRole("button", { name: "Save as new board" }));
    const create = await slot.findByRole("dialog", { name: "Create board" });
    expect(within(create).getByText("1 selected PR will be saved to this board.")).toBeTruthy();
    fireEvent.click(within(create).getByRole("button", { name: "Cancel" }));
    fireEvent.click(slot.getByRole("button", { name: "Add to board" }));
    const chooser = await slot.findByRole("dialog", { name: "Add to a board" });
    fireEvent.click(await within(chooser).findByRole("button", { name: "Add 1" }));
    await waitFor(() => expect(callsTo(slot, "boardAdd")).toEqual([{ id: "other", prs: [member.key] }]));
  });

  it.each([0, 1, 2])("renders %i status counts without pluralizing status phrases", async (count) => {
    const { slot } = await boardPage("board/release", { board: () => ({ ...populated, board: { ...populated.board, attention: count, ready: count, merged: count } }) });
    expect(await slot.findByText(`${count} ${count === 1 ? "needs" : "need"} attention`)).toBeTruthy();
    expect(slot.getByText(`${count} ready to merge`)).toBeTruthy();
    expect(slot.getByText(`${count} merged`)).toBeTruthy();
  });

  it("filters live PR states without changing saved membership", async () => {
    const { slot } = await boardPage("board/release", { board: () => populated });
    await find(slot.container, `[data-pr="${member.key}"]`);
    fireEvent.change(slot.getByRole("combobox", { name: "Board status" }), { target: { value: "merged" } });
    expect(slot.container.querySelector(`[data-pr="${member.key}"]`)).toBeNull();
    expect(slot.container.querySelector(`[data-pr="${mergedMember.key}"]`)).toBeTruthy();
    expect(slot.getByText("2 saved PRs")).toBeTruthy();
    expect(callsTo(slot, "boardRemove")).toEqual([]);
  });

  it("keeps ready-to-merge PRs out of the needs-attention filter, matching board counts", async () => {
    const ready = mine({ number: 3, next: { ...member.next, kind: "ready_to_merge", inbox: true } });
    const attention = { ...member, next: { ...member.next, inbox: true } };
    const { slot } = await boardPage("board/release", { board: () => ({ ...populated, prs: [ready, attention] }) });
    await find(slot.container, `[data-pr="${ready.key}"]`);
    fireEvent.change(slot.getByRole("combobox", { name: "Board status" }), { target: { value: "attention" } });
    expect(slot.container.querySelector(`[data-pr="${ready.key}"]`)).toBeNull();
    expect(slot.container.querySelector(`[data-pr="${attention.key}"]`)).toBeTruthy();
  });

  it.each(["#1", "bb#1", "get-bb/bb#1", "github:get-bb/bb#1", "GitHub"])("filters board PRs by identifier or server %s", async (query) => {
    const { slot } = await boardPage("board/release", { board: () => populated });
    await find(slot.container, `[data-pr="${member.key}"]`);
    fireEvent.change(slot.getByRole("textbox", { name: "Filter board PRs" }), { target: { value: query } });
    expect(slot.container.querySelector(`[data-pr="${member.key}"]`)).toBeTruthy();
  });

  it.each([74, 80])("duplicates a valid %i-character name with a valid default", async (length) => {
    const name = "R".repeat(length);
    const { slot } = await boardPage("board/release", { board: () => ({ ...populated, board: { ...populated.board, name } }) });
    fireEvent.click(await slot.findByRole("button", { name: "Duplicate" }));
    const dialog = await slot.findByRole("dialog", { name: "Duplicate board" });
    const input = within(dialog).getByRole("textbox", { name: "Board name" }) as HTMLInputElement;
    expect(input.value.length).toBeLessThanOrEqual(80);
    expect(input.value.endsWith(" (copy)")).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Duplicate board" }));
    await waitFor(() => expect(callsTo(slot, "boardCreate")).toHaveLength(1));
    expect(callsTo(slot, "boardCreate")[0]).toMatchObject({ name: input.value, prs: [member.key, mergedMember.key] });
  });

  it("explains pasted keys that are already present instead of silently disabling Add", async () => {
    const { slot } = await boardPage("board/release", {
      board: () => populated,
      boardAdd: () => ({ board: activeBoard, added: [], alreadyPresent: [member.key] }),
    });
    fireEvent.click(await slot.findByRole("button", { name: "Add PRs" }));
    const dialog = await slot.findByRole("dialog", { name: "Add PRs" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Paste links" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "PR links or keys" }), { target: { value: member.key } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add 1" }));
    await waitFor(() => expect(callsTo(slot, "boardAdd")).toEqual([{ id: activeBoard.id, prs: [member.key] }]));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(`Those PRs were already on “${activeBoard.name}”.`));
  });

  it("finds destination boards by name or description and shows an unmatched search", async () => {
    const other = { ...activeBoard, id: "other", name: "Infrastructure", description: "Edge cache" };
    const { slot } = await boardPage("mine", { boards: () => ({ boards: [activeBoard, other] }) });
    fireEvent.click(within(await find(slot.container, `[data-pr="${member.key}"]`)).getByRole("checkbox"));
    fireEvent.click(slot.getByRole("button", { name: "Add to board" }));
    const dialog = await slot.findByRole("dialog", { name: "Add to a board" });
    await within(dialog).findByText(other.name);
    const input = within(dialog).getByRole("textbox", { name: "Find destination board" });
    fireEvent.change(input, { target: { value: "  CACHE  " } });
    expect(within(dialog).getByText(other.name)).toBeTruthy();
    expect(within(dialog).queryByText(activeBoard.name)).toBeNull();
    fireEvent.change(input, { target: { value: "not a board" } });
    expect(within(dialog).getByText("No matching boards.")).toBeTruthy();
    fireEvent.change(input, { target: { value: "" } });
    expect(within(dialog).getByText(activeBoard.name)).toBeTruthy();
  });

  it.each(["mine", "reviews", "search", "search/none"])("does not show selection instructions without available PRs in %s", async (path) => {
    const { slot } = await boardPage(path, { list: () => ({ prs: [] }), search: () => ({ prs: [], total: 0 }) });
    expect(slot.queryByText("Select PRs to save a set as a new board or add them to an existing one.")).toBeNull();
  });

  it("offers Add PRs for an empty board without a misleading filtered-empty message", async () => {
    const { slot } = await boardPage("board/release", { board: () => ({ ...populated, board: { ...populated.board, prCount: 0 }, prs: [] }) });
    await slot.findByRole("button", { name: "Add PRs" });
    expect(slot.getByText("This board is empty.")).toBeTruthy();
    expect(slot.getByText("0 saved PRs")).toBeTruthy();
    expect(slot.queryByText("No matching PRs.")).toBeNull();
  });

  it("supports native form submission from the board-name field", async () => {
    const { slot } = await boardPage("boards");
    fireEvent.click(slot.getByRole("button", { name: "New board" }));
    const dialog = await slot.findByRole("dialog", { name: "Create board" });
    const name = within(dialog).getByRole("textbox", { name: "Board name" });
    fireEvent.change(name, { target: { value: "Keyboard board" } });
    const form = name.closest("form");
    expect(form).not.toBeNull();
    expect(within(dialog).getByRole("button", { name: "Create board" }).getAttribute("type")).toBe("submit");
    fireEvent.submit(form!);
    await waitFor(() => expect(callsTo(slot, "boardCreate")).toEqual([{ name: "Keyboard board", description: "" }]));
  });

  it("shows native thread tools with the stable board ID and correct CLI syntax", async () => {
    const { slot } = await boardPage("board/release");
    fireEvent.click(await slot.findByRole("button", { name: "Thread tools" }));
    const dialog = await slot.findByRole("dialog", { name: "Thread tools" });
    expect(dialog.textContent).toContain('shuttle_board_add');
    expect(dialog.textContent).toContain('"id":"release"');
    expect(dialog.textContent).not.toContain("--prs");
  });

  it("archives only after confirmation and requires restore before membership edits", async () => {
    let current = populated;
    const { slot, route } = await boardPage("board/release", {
      board: () => current,
      boardUpdate: ({ archived }) => {
        current = { ...current, board: { ...current.board, archivedAt: archived ? Date.now() : null } };
        return { board: current.board };
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Archive board" }));
    expect(callsTo(slot, "boardUpdate")).toEqual([]);
    const dialog = await slot.findByRole("dialog", { name: "Archive this board?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive board" }));
    await waitFor(() => expect(callsTo(slot, "boardUpdate")).toEqual([{ id: "release", archived: true }]));
    route("board/release");
    await slot.findByRole("button", { name: "Restore board" });
    expect(slot.queryByRole("button", { name: "Add PRs" })).toBeNull();
    expect(slot.queryByRole("checkbox")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Restore board" }));
    await waitFor(() => expect(callsTo(slot, "boardUpdate")).toEqual([{ id: "release", archived: true }, { id: "release", archived: false }]));
    await slot.findByRole("button", { name: "Add PRs" });
  });

  it("edits metadata without replacing membership and duplicates the exact set", async () => {
    const { slot } = await boardPage("board/release", {
      board: () => populated,
      boardUpdate: () => ({ board: populated.board }),
    });
    fireEvent.click(await slot.findByRole("button", { name: "Edit board" }));
    const edit = await slot.findByRole("dialog", { name: "Edit board" });
    fireEvent.change(within(edit).getByRole("textbox", { name: "Board name" }), { target: { value: "Renamed board" } });
    fireEvent.click(within(edit).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(callsTo(slot, "boardUpdate")).toEqual([{ id: "release", name: "Renamed board", description: activeBoard.description }]));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    fireEvent.click(slot.getByRole("button", { name: "Duplicate" }));
    const duplicate = await slot.findByRole("dialog", { name: "Duplicate board" });
    fireEvent.click(within(duplicate).getByRole("button", { name: "Duplicate board" }));
    await waitFor(() => expect(callsTo(slot, "boardCreate")).toEqual([{ name: `${activeBoard.name} (copy)`, description: activeBoard.description, prs: [member.key, mergedMember.key] }]));
    expect(callsTo(slot, "boardRemove")).toEqual([]);
  });

  it.each(["reviews", "search/edge"])("saves explicit selection from %s", async (path) => {
    const reviews = [pr({ number: 3, title: "Edge routing" }), pr({ number: 4, title: "Edge metrics" })];
    const keys = reviews.map((item) => item.key);
    const { slot } = await boardPage(path, {
      list: () => ({ prs: reviews }), search: () => ({ prs: reviews, total: 2 }),
      boardAdd: () => ({ board: activeBoard, added: keys, alreadyPresent: [] }),
    });
    for (const key of keys) fireEvent.click(within(await find(slot.container, `[data-pr="${key}"]`)).getByRole("checkbox"));
    fireEvent.click(slot.getByRole("button", { name: "Add to board" }));
    const chooser = await slot.findByRole("dialog", { name: "Add to a board" });
    fireEvent.click(await within(chooser).findByRole("button", { name: "Add 2" }));
    await waitFor(() => expect(callsTo(slot, "boardAdd")).toEqual([{ id: activeBoard.id, prs: keys }]));
    fireEvent.click(within(chooser).getByRole("button", { name: "Done" }));
    fireEvent.click(slot.getByRole("button", { name: "Save as new board" }));
    const dialog = await slot.findByRole("dialog", { name: "Create board" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Board name" }), { target: { value: "Selected work" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create board" }));
    await waitFor(() => expect(callsTo(slot, "boardCreate")).toEqual([{ name: "Selected work", description: "", prs: keys }]));
  });

  it("shows the boards a PR is on in its view, and puts it on more boards or takes it off", async () => {
    const other: BoardSummary = { ...activeBoard, id: "edge", name: "Edge work", description: "", preview: [] };
    let on = [activeBoard, archivedBoard];
    const { slot } = await boardPage(formatRoute({ view: "pr", key: member.key }), {
      detail: () => ({ pr: member, events: [], body: "", draft: null }),
      boards: ({ key, archived }) => ({ boards: key === member.key ? on : archived === "exclude" ? [activeBoard, other] : [] }),
      boardAdd: ({ id }) => {
        const board = [activeBoard, other].find((item) => item.id === id)!;
        on = [...on, board];
        return { board, added: [member.key], alreadyPresent: [] };
      },
      boardRemove: ({ id }) => {
        on = on.filter((item) => item.id !== id);
        return { board: activeBoard, removed: [member.key] };
      },
    });
    const chip = await find(slot.container, `[data-board-chip="${activeBoard.id}"]`);
    expect(chip.textContent).toContain(activeBoard.name);
    expect(slot.container.querySelector(`[data-board-chip="${archivedBoard.id}"]`)!.textContent).toContain("archived");
    expect(callsTo(slot, "boards")).toContainEqual({ archived: "include", key: member.key });
    fireEvent.click(chip);
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "board/release" } });

    fireEvent.keyDown(slot.getByRole("button", { name: "Boards for this PR" }), { key: "Enter" });
    const menu = await screen.findByRole("menu", { name: "Boards for this PR" });
    const edge = await within(menu).findByRole("menuitemcheckbox", { name: /Edge work/u });
    expect(edge.getAttribute("aria-checked")).toBe("false");
    expect(within(menu).getByRole("menuitemcheckbox", { name: /October release/u }).getAttribute("aria-checked")).toBe("true");
    expect(within(menu).getByRole("menuitemcheckbox", { name: /Review handoff/u }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(edge);
    await waitFor(() => expect(callsTo(slot, "boardAdd")).toEqual([{ id: "edge", prs: [member.key] }]));
    await waitFor(() => expect(within(menu).getByRole("menuitemcheckbox", { name: /Edge work/u }).getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: /October release/u }));
    await waitFor(() => expect(callsTo(slot, "boardRemove")).toEqual([{ id: activeBoard.id, prs: [member.key] }]));
    await waitFor(() => expect(slot.container.querySelector(`[data-board-chip="${activeBoard.id}"]`)).toBeNull());
    expect(toasts.success.mock.calls.map(([message]) => message)).toEqual(["Added it to “Edge work”.", "Took it off “October release”."]);
  });

  it("starts a board with the PR from its view, and stays on the PR", async () => {
    const { slot } = await boardPage(formatRoute({ view: "pr", key: member.key }), {
      detail: () => ({ pr: member, events: [], body: "", draft: null }),
      boards: () => ({ boards: [] }),
    });
    fireEvent.keyDown(await slot.findByRole("button", { name: "Boards for this PR" }), { key: "Enter" });
    const menu = await screen.findByRole("menu", { name: "Boards for this PR" });
    fireEvent.change(within(menu).getByRole("textbox", { name: "Find a board" }), { target: { value: "Launch" } });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "New board “Launch” with this PR…" }));
    const dialog = await slot.findByRole("dialog", { name: "Create board" });
    expect((within(dialog).getByRole("textbox", { name: "Board name" }) as HTMLInputElement).value).toBe("Launch");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create board" }));
    await waitFor(() => expect(callsTo(slot, "boardCreate")).toEqual([{ name: "Launch", description: "", prs: [member.key] }]));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect(slot.inspection.navigateCalls.filter((call) => call.method === "toPluginPanel")).toEqual([]);
    expect(toasts.success).toHaveBeenCalledWith("Created “Launch” with this PR.");
  });

  it("keeps a refused create open without discarding the entered name", async () => {
    const { slot } = await boardPage("boards", { boardCreate: () => { throw new Error("A board called that already exists, including in Archived."); } });
    fireEvent.click(slot.getByRole("button", { name: "New board" }));
    const dialog = await slot.findByRole("dialog", { name: "Create board" });
    const name = within(dialog).getByRole("textbox", { name: "Board name" }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: activeBoard.name } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create board" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(slot.getByRole("dialog", { name: "Create board" })).toBeTruthy();
    expect(name.value).toBe(activeBoard.name);
    expect(lastNavigation(slot)).toBeUndefined();
  });

  it("shows a missing-board error rather than offering mutations", async () => {
    const { slot } = await boardPage("board/missing", { board: () => { throw new Error("Board does not exist"); } });
    expect(await slot.findByText(/Board does not exist/u)).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Add PRs" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Archive board" })).toBeNull();
  });

  it("undoes only newly added memberships, not ones already present", async () => {
    const { slot } = await boardPage("mine", {
      boardAdd: () => ({ board: activeBoard, added: [mergedMember.key], alreadyPresent: [member.key] }),
      boardRemove: () => ({ board: activeBoard, removed: [mergedMember.key] }),
    });
    for (const key of [member.key, mergedMember.key]) fireEvent.click(within(await find(slot.container, `[data-pr="${key}"]`)).getByRole("checkbox"));
    fireEvent.click(slot.getByRole("button", { name: "Add to board" }));
    const dialog = await slot.findByRole("dialog", { name: "Add to a board" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Add 2" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    toasts.success.mock.calls.at(-1)![1].action.onClick();
    await waitFor(() => expect(callsTo(slot, "boardRemove")).toEqual([{ id: activeBoard.id, prs: [mergedMember.key] }]));
  });

  it("adds selected known PRs from search and disables existing members", async () => {
    const { slot } = await boardPage("board/release", {
      board: () => ({ ...populated, prs: [member] }),
      search: () => ({ prs: [member, mergedMember], total: 2 }),
      boardAdd: () => ({ board: activeBoard, added: [mergedMember.key], alreadyPresent: [] }),
    });
    fireEvent.click(await slot.findByRole("button", { name: "Add PRs" }));
    const dialog = await slot.findByRole("dialog", { name: "Add PRs" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Search PRs" }), { target: { value: "edge" } });
    const boxes = await within(dialog).findAllByRole("checkbox");
    expect((boxes[0] as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(boxes[1]!);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add 1" }));
    await waitFor(() => expect(callsTo(slot, "boardAdd")).toEqual([{ id: activeBoard.id, prs: [mergedMember.key] }]));
  });
});

describe("boards on a phone", () => {
  it("keeps board cards inside the screen, one column, without the desktop's tall minimum", async () => {
    setViewport(390);
    const { slot } = await boardPage("boards");
    const card = await find(slot.container, "[data-board-card]");
    expect(card.parentElement!.className).toContain("grid-cols-1");
    expect(card.className).toContain("min-w-0");
    expect(card.className).not.toMatch(/(^| )min-h-56/u);
  });

  it("gives a board a way back, its main action, and the rest in a sheet", async () => {
    setViewport(390);
    const { slot } = await boardPage("board/release", { board: () => populated });
    await find(slot.container, "[data-pr]");
    expect(slot.queryByRole("heading", { name: "Boards" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Edit board" })).toBeNull();
    expect(slot.getByRole("button", { name: "Add PRs" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Back to Boards" }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "boards" } });
    fireEvent.click(slot.getByRole("button", { name: "More for October release" }));
    const sheet = await screen.findByRole("menu", { name: "October release" });
    expect(within(sheet).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Edit board", "Duplicate", "Thread tools", "Archive board"]);
    fireEvent.click(within(sheet).getByRole("menuitem", { name: "Edit board" }));
    expect(await screen.findByRole("dialog", { name: "Edit board" })).toBeTruthy();
  });

  it("offers Restore as an archived board's main action", async () => {
    setViewport(390);
    const { slot } = await boardPage("board/handoff", { board: () => ({ board: archivedBoard, prs: [member], activity: [] }) });
    await find(slot.container, "[data-pr]");
    expect(slot.getByRole("button", { name: "Restore board" })).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Add PRs" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "More for Review handoff" }));
    const sheet = await screen.findByRole("menu", { name: "Review handoff" });
    expect(within(sheet).queryByRole("menuitem", { name: "Archive board" })).toBeNull();
  });

  it("puts the three filters in one row under their names", async () => {
    setViewport(390);
    const { slot } = await boardPage("board/release", { board: () => populated });
    await find(slot.container, "[data-pr]");
    const status = slot.getByRole("combobox", { name: "Board status" }) as HTMLSelectElement;
    expect(status.options[0]!.textContent).toBe("All");
    // The toolbar's small field, not the form field with extra classes that lose to it.
    expect(status.className.split(" ")).toEqual(expect.arrayContaining(["h-7", "py-0", "text-xs"]));
    expect(status.className.split(" ")).not.toContain("py-1.5");
    const row = status.closest("label")!.parentElement!;
    expect(row.className).toContain("grid-cols-3");
    expect([...row.querySelectorAll("label")].map((label) => label.firstChild?.textContent)).toEqual(["Status", "Sort by", "Group by"]);
  });

  it("keeps the selection's actions at the top while the list scrolls, and they still act", async () => {
    setViewport(390);
    const { slot } = await boardPage("board/release", { board: () => populated });
    await find(slot.container, "[data-pr]");
    fireEvent.click(slot.getByRole("checkbox", { name: `Select ${member.title}` }));
    const bar = await find(slot.container, "[data-selection-bar]");
    expect(bar.className).toContain("sticky");
    expect(within(bar).getByText("1 selected")).toBeTruthy();
    fireEvent.click(within(bar).getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("dialog", { name: "Remove PRs from this board?" })).toBeTruthy();
  });

  it("leaves out the selection hint on My PRs until something is selected", async () => {
    setViewport(390);
    const { slot } = await boardPage("mine");
    await find(slot.container, "[data-pr]");
    expect(slot.queryByText(/Select PRs to save a set/u)).toBeNull();
    fireEvent.click(slot.getAllByRole("checkbox")[0]!);
    const bar = await find(slot.container, "[data-selection-bar]");
    expect(within(bar).getByRole("button", { name: "New board" })).toBeTruthy();
    expect(within(bar).queryByRole("button", { name: "Remove" })).toBeNull();
  });
});
