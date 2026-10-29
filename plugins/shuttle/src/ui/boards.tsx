import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { BoardDetail, BoardSummary, PrView } from "../contract";
import { PANEL_PATH } from "./constants";
import { ago, clock, plural, shortKey } from "./format";
import { BUTTON, BUTTON_GHOST, BUTTON_PRIMARY, Dialog, ErrorNote, FIELD, PageHeading, SectionTitle } from "./common";
import { messageOf, undoToast, useShuttleMutation, useShuttleQuery } from "./data";
import { StatePill } from "./pills";
import { FoldAllButton, GroupHeader, MineRow, ReviewRow, type RowLayout } from "./row";
import { boardViews, useFolding } from "./prefs";
import { useStored } from "./remember";
import { BOARD_GROUP_LABELS, BOARD_SORT_LABELS, DEFAULT_BOARD_VIEW, groupBoardPrs, type BoardGrouping, type BoardSort, type BoardViewPrefs } from "./board-prs";
import { rowTime, sortPrs } from "./sort";
import { formatRoute, type Route } from "./route";

type BoardPreview = BoardSummary["preview"][number];


export function useSelectedKeys(initial: readonly string[] = []) {
  const [selected, setSelected] = useState<string[]>(() => [...initial]);
  const toggle = useCallback((key: string) => {
    setSelected((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));
  }, []);
  const clear = useCallback(() => setSelected([]), []);
  return { selected, setSelected, toggle, clear };
}

function splitBoardInputs(text: string): string[] {
  const seen = new Set<string>();
  const values: string[] =[];
  for (const token of text.split(/[\n,]+/u).map((part) => part.trim()).filter(Boolean)) {
    if (seen.has(token)) continue;
    seen.add(token);
    values.push(token);
  }
  return values;
}

function BoardCard({ board, onOpen }: { board: BoardSummary; onOpen(): void }) {
  const preview: readonly BoardPreview[] = board.preview.slice(0, 3);
  return (
    <button type="button" data-board-card onClick={onOpen}
      className={`flex min-h-56 cursor-pointer flex-col rounded-lg border border-border bg-card p-4 text-left transition hover:border-primary ${board.archivedAt !== null ? "opacity-90" : ""}`}>
      <div className="flex items-start gap-2">
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-primary" aria-hidden>
          <Icon name={board.archivedAt !== null ? "Archive" : "LayoutGrid"} className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <h3 className="min-w-0 flex-1 break-words text-sm font-semibold leading-snug">{board.name}</h3>
            {board.archivedAt !== null && <span className="inline-flex shrink-0 rounded-full border border-border px-2 py-0.5 text-[10.5px] text-muted-foreground">Archived</span>}
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{board.description || "No description yet."}</p>
        </div>
      </div>
      <div className="mt-3 flex-1 space-y-1.5 text-xs text-muted-foreground">
        {preview.length > 0 ? preview.map((item) => (
          <div key={item.key} className="flex items-center gap-1.5 overflow-hidden rounded-md border border-border/70 bg-background px-2 py-1.5">
            <StatePill state={item.state} />
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
          </div>
        )) : <div className="rounded-md border border-dashed border-border px-2 py-1.5">No PRs yet.</div>}
        {board.prCount > preview.length && <div className="pl-1 text-[11px]">+{Math.max(0, board.prCount - preview.length)} more</div>}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-2 text-[11px] text-muted-foreground">
        <span>{plural(board.prCount, "PR")}</span>
        {board.attention > 0 && <span className="rounded-full border border-border px-1.5 py-0.5 text-warning-text">{board.attention} {board.attention === 1 ? "needs" : "need"} attention</span>}
        {board.ready > 0 && <span className="rounded-full border border-border px-1.5 py-0.5 text-success">{board.ready} ready</span>}
        {board.merged > 0 && <span className="rounded-full border border-border px-1.5 py-0.5 text-primary">{board.merged} merged</span>}
        <span className="ml-auto truncate">Updated {ago(board.updatedAt)}</span>
      </div>
    </button>
  );
}

export function BoardFormDialog({ mode, board, prs = [], onClose }: { mode: "create" | "edit" | "duplicate"; board?: BoardSummary; prs?: readonly string[]; onClose(): void }) {
  const navigate = useBbNavigate();
  const create = useShuttleMutation("boardCreate");
  const update = useShuttleMutation("boardUpdate");
  const [name, setName] = useState(mode === "duplicate" ? `${(board?.name ?? "").slice(0, 80 - " (copy)".length).trimEnd()} (copy)` : board?.name ?? "");
  const [description, setDescription] = useState(board?.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const busy = create.isPending || update.isPending;
  const formId = useId();

  const submit = async () => {
    if (busy) return;
    const trimmed = name.trim();
    if (trimmed === "") {
      setError("Board name is required.");
      return;
    }
    setError(null);
    if (mode === "edit") {
      if (board === undefined) return;
      const out = await update.run({ id: board.id, name: trimmed, description: description.trim() });
      if (out === null) return;
      toast.success("Saved board changes.");
      onClose();
      return;
    }
    const out = await create.run({
      name: trimmed,
      description: description.trim(),
      ...(prs.length === 0 ? {} : { prs: [...prs] }),
    });
    if (out === null) return;
    toast.success(mode === "duplicate" ? "Duplicated board." : "Created board.");
    onClose();
    navigate.toPluginPanel(PANEL_PATH, { subPath: formatRoute({ view: "board", id: out.board.id, key: null }) });
  };

  return (
    <Dialog
      title={mode === "edit" ? "Edit board" : mode === "duplicate" ? "Duplicate board" : "Create board"}
      subtitle={mode === "edit" ? "Rename it or change its description. Its PR set stays the same." : mode === "duplicate" ? "Make a separate board with the same PRs. Future changes are independent." : prs.length > 0 ? `${plural(prs.length, "selected PR")} will be saved to this board.` : "Start with an empty board and add PRs later."}
      onClose={onClose}
      footer={(
        <>
          <span className="mr-auto text-xs text-muted-foreground">
            {mode === "edit" ? "Renaming keeps the board ID stable." : prs.length > 0 ? "The selected PRs are copied into the new board." : "Boards save membership, not a frozen status report."}
          </span>
          <button type="button" className={BUTTON} onClick={onClose}>Cancel</button>
          <button type="submit" form={formId} className={BUTTON_PRIMARY} disabled={busy}>
            {mode === "edit" ? "Save changes" : mode === "duplicate" ? "Duplicate board" : "Create board"}
          </button>
        </>
      )}
      wide
    >
      <form id={formId} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label className="mb-3 block text-sm font-medium text-foreground">
        Board name
        <input aria-label="Board name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoFocus className={`${FIELD} mt-1.5 w-full`} />
      </label>
      <label className="block text-sm font-medium text-foreground">
        Description <span className="text-muted-foreground">(optional)</span>
        <textarea aria-label="Board description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={300} className={`${FIELD} mt-1.5 min-h-24 w-full resize-y`} />
      </label>
      {error !== null && <div role="alert" className="mt-3 text-sm text-destructive">{error}</div>}
      </form>
    </Dialog>
  );
}

export function BoardChooserDialog({ prs, onClose, onCreateBoard }: { prs: readonly string[]; onClose(): void; onCreateBoard(): void }) {
  const boards = useShuttleQuery("boards", { archived: "exclude" });
  const add = useShuttleMutation("boardAdd");
  const remove = useShuttleMutation("boardRemove");
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const list = (boards.data?.boards ?? []).filter((board) => `${board.name} ${board.description}`.toLowerCase().includes(needle));

  const addTo = async (board: BoardSummary) => {
    if (prs.length === 0) return;
    const out = await add.run({ id: board.id, prs: [...prs] });
    if (out === null) return;
    if (out.added.length === 0) {
      toast.success(`Those PRs were already on “${board.name}”.`);
      return;
    }
    undoToast(`Added ${plural(out.added.length, "PR")} to “${board.name}”.`, () => void remove.run({ id: board.id, prs: out.added }));
  };

  return (
    <Dialog
      title="Add to a board"
      subtitle={prs.length === 1 ? "This PR can belong to more than one board." : `${prs.length} selected PRs can be added to more than one board.`}
      onClose={onClose}
      wide
      footer={(
        <>
          <span className="mr-auto text-xs text-muted-foreground">Choose a board, or create a new one with the same selection.</span>
          <button type="button" className={BUTTON} onClick={onClose}>Done</button>
        </>
      )}
    >
      <button type="button" className={`${BUTTON_GHOST} mb-3`} onClick={onCreateBoard}>
        <Icon name="Plus" className="size-3.5" aria-hidden />Create a new board
      </button>
      <input aria-label="Find destination board" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a board…" autoFocus className={`${FIELD} mb-3 w-full`} />
      {boards.error !== null && <ErrorNote>Could not load boards: {messageOf(boards.error)}</ErrorNote>}
      {boards.data === undefined && boards.error === null && <div className="py-4 text-sm text-muted-foreground">Loading boards…</div>}
      {boards.data !== undefined && list.length === 0 && <div className="py-4 text-sm text-muted-foreground">{needle === "" ? "No active boards yet." : "No matching boards."}</div>}
      <div className="flex max-h-[24rem] flex-col gap-2 overflow-y-auto">
        {list.map((board) => (
          <div key={board.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{board.name}</span>
                {board.archivedAt !== null && <span className="rounded-full border border-border px-1.5 py-0.5 text-[10.5px] text-muted-foreground">Archived</span>}
              </div>
              <div className="truncate text-xs text-muted-foreground">{board.prCount} saved PRs</div>
            </div>
            <button type="button" className={BUTTON_PRIMARY} disabled={add.isPending} onClick={() => void addTo(board)}>
              <Icon name="Plus" className="size-3.5" aria-hidden />Add {prs.length}
            </button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

export function BoardAddDialog({ board, existingKeys, onClose }: { board: BoardSummary; existingKeys: readonly string[]; onClose(): void }) {
  const add = useShuttleMutation("boardAdd");
  const remove = useShuttleMutation("boardRemove");
  const [tab, setTab] = useState<"search" | "links">("search");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [links, setLinks] = useState("");
  const [error, setError] = useState<string | null>(null);
  const existing = useMemo(() => new Set(existingKeys), [existingKeys]);
  const searchResults = useShuttleQuery("search", { query: query.trim() }, tab === "search" && query.trim() !== "");
  const candidates = searchResults.data?.prs ?? [];

  useEffect(() => {
    if (tab === "search") setError(null);
  }, [tab]);

  const selected = tab === "search" ? picked.filter((key) => !existing.has(key)) : splitBoardInputs(links);

  const submit = async () => {
    const keys = selected;
    if (keys.length === 0) {
      setError(tab === "search" ? "Pick at least one PR." : "Paste at least one PR link or key.");
      return;
    }
    const out = await add.run({ id: board.id, prs: keys });
    if (out === null) return;
    if (out.added.length === 0) {
      toast.success(`Those PRs were already on “${board.name}”.`);
      onClose();
      return;
    }
    undoToast(`Added ${plural(out.added.length, "PR")} to “${board.name}”.`, () => void remove.run({ id: board.id, prs: out.added }));
    onClose();
  };

  return (
    <Dialog
      title="Add PRs"
      subtitle={`Save PRs to “${board.name}”. Nothing changes on the server.`}
      onClose={onClose}
      wide
      footer={(
        <>
          <span className="mr-auto text-xs text-muted-foreground">Already saved PRs are skipped.</span>
          <button type="button" className={BUTTON} onClick={onClose}>Cancel</button>
          <button type="button" className={BUTTON_PRIMARY} disabled={selected.length === 0 || add.isPending} onClick={() => void submit()}>
            Add {selected.length}
          </button>
        </>
      )}
    >
      <div className="mb-3 flex gap-2">
        <button type="button" aria-pressed={tab === "search"} className={`${BUTTON} ${tab === "search" ? "border-primary text-primary" : ""}`} onClick={() => setTab("search")}>Search Shuttle</button>
        <button type="button" aria-pressed={tab === "links"} className={`${BUTTON} ${tab === "links" ? "border-primary text-primary" : ""}`} onClick={() => setTab("links")}>Paste links</button>
      </div>
      {tab === "search" ? (
        <>
          <label className="mb-3 block text-sm font-medium text-foreground">
            Search PRs
            <input aria-label="Search PRs" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, repo, author, or number…" className={`${FIELD} mt-1.5 w-full`} autoFocus />
          </label>
          {searchResults.error !== null && <ErrorNote>Could not search Shuttle: {messageOf(searchResults.error)}</ErrorNote>}
          {query.trim() !== "" && searchResults.data === undefined && searchResults.error === null && <div className="py-4 text-sm text-muted-foreground">Searching…</div>}
          <div className="flex max-h-[22rem] flex-col gap-2 overflow-y-auto">
            {candidates.map((pr) => {
              const checked = picked.includes(pr.key) || existing.has(pr.key);
              return (
                <label key={pr.key} className={`flex items-start gap-3 rounded-lg border border-border px-3 py-2 ${existing.has(pr.key) ? "opacity-60" : "cursor-pointer hover:bg-accent"}`}>
                  <input type="checkbox" checked={checked} disabled={existing.has(pr.key)} onChange={() => setPicked((current) => (current.includes(pr.key) ? current.filter((item) => item !== pr.key) : [...current, pr.key]))} className="mt-1 size-4 shrink-0 cursor-pointer accent-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{pr.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">{shortKey(pr)} · {pr.serverName}</span>
                  </span>
                  <StatePill state={pr.state} />
                  {existing.has(pr.key) && <span className="rounded-full border border-border px-1.5 py-0.5 text-[10.5px] text-muted-foreground">Already added</span>}
                </label>
              );
            })}
            {query.trim() !== "" && searchResults.data !== undefined && candidates.length === 0 && <div className="py-4 text-sm text-muted-foreground">No PRs matched.</div>}
          </div>
        </>
      ) : (
        <label className="block text-sm font-medium text-foreground">
          PR links or keys
          <textarea aria-label="PR links or keys" value={links} onChange={(event) => { setLinks(event.target.value); setError(null); }} placeholder={"github:acme/desktop#128\nhttps://github.com/acme/desktop/pull/131"} className={`${FIELD} mt-1.5 min-h-32 w-full resize-y font-mono text-sm`} autoFocus />
        </label>
      )}
      {error !== null && <div role="alert" className="mt-3 text-sm text-destructive">{error}</div>}
    </Dialog>
  );
}

function BoardToolsDialog({ board, onClose }: { board: BoardSummary; onClose(): void }) {
  return (
    <Dialog
      title="Thread tools"
      subtitle="These are the live board tools. They act on the real data, not a simulator."
      onClose={onClose}
      footer={<button type="button" className={BUTTON_PRIMARY} onClick={onClose}>Done</button>}
    >
      <pre className="whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-3 font-mono text-xs leading-6 text-foreground">{[
        'shuttle_boards({"archived":"exclude"})',
        `shuttle_board(${JSON.stringify({ id: board.id })})`,
        'shuttle_board_create({"name":"Release candidate","prs":["github:owner/repo#123"]})',
        `shuttle_board_add(${JSON.stringify({ id: board.id, prs: ["github:owner/repo#123"] })})`,
        `shuttle_board_remove(${JSON.stringify({ id: board.id, prs: ["github:owner/repo#123"] })})`,
        `shuttle_board_update(${JSON.stringify({ id: board.id, archived: true })})`,
      ].join("\n")}</pre>
      <p className="mt-3 text-sm text-muted-foreground">Ask a thread to call these tools, replacing the example PR keys with yours. These operations never assign PR agents or change review tracking.</p>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-muted-foreground">CLI equivalents</summary>
        <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs leading-6">{`bb shuttle board list
bb shuttle board show <id>
bb shuttle board create <name> [prs...] [--description <text>]
bb shuttle board add <id> <prs...>
bb shuttle board remove <id> <prs...>
bb shuttle board update <id> [--name <text>] [--description <text>] [--archive|--restore]`}</pre>
      </details>
    </Dialog>
  );
}

function BoardArchiveDialog({ board, onClose, onArchive }: { board: BoardSummary; onClose(): void; onArchive(): void }) {
  return (
    <Dialog
      title="Archive this board?"
      subtitle={board.name}
      onClose={onClose}
      footer={(
        <>
          <span className="mr-auto text-xs text-muted-foreground">Archived boards stay in the archive and reject membership changes until restored.</span>
          <button type="button" className={BUTTON} onClick={onClose}>Cancel</button>
          <button type="button" className={BUTTON_PRIMARY} onClick={onArchive}>Archive board</button>
        </>
      )}
    >
      <p className="text-sm text-muted-foreground">The board stays intact, but it leaves active navigation. PRs keep their current status and agents.</p>
    </Dialog>
  );
}

export function BoardsView({ tab, onGo }: { tab: "active" | "archived"; onGo(next: Route): void }) {
  const [currentTab, setCurrentTab] = useState(tab);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<null | { kind: "create" }>(null);
  useEffect(() => setCurrentTab(tab), [tab]);
  const boards = useShuttleQuery("boards", { archived: currentTab === "archived" ? "only" : "exclude", ...(query.trim() === "" ? {} : { query: query.trim() }) });
  const items = boards.data?.boards ?? [];
  const showEmpty = boards.data !== undefined && items.length === 0;

  return (
    <div className={"@container w-full px-4 pb-10 pt-4 sm:px-5"}>
      <PageHeading title="Boards" description="Keep a specific set of PRs together, across repositories and servers." >
        <button type="button" className={BUTTON_PRIMARY} onClick={() => setDialog({ kind: "create" })}>New board</button>
      </PageHeading>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" aria-pressed={currentTab === "active"} className={`${BUTTON} ${currentTab === "active" ? "border-primary text-primary" : ""}`} onClick={() => { setCurrentTab("active"); onGo({ view: "boards", tab: "active" }); }}>Active</button>
        <button type="button" aria-pressed={currentTab === "archived"} className={`${BUTTON} ${currentTab === "archived" ? "border-primary text-primary" : ""}`} onClick={() => { setCurrentTab("archived"); onGo({ view: "boards", tab: "archived" }); }}>Archived</button>
        <label className="ml-auto flex min-w-[14rem] flex-1 items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-muted-foreground sm:max-w-md">
          <Icon name="Search" className="size-4 shrink-0" aria-hidden />
          <input aria-label="Search boards" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a board…" className="min-w-0 flex-1 bg-transparent outline-none" />
        </label>
      </div>
      {currentTab === "archived" && <div className="mb-3 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">Archived boards stay here. Restore one to add or remove PRs again.</div>}
      {boards.error !== null && <ErrorNote>Could not load boards: {messageOf(boards.error)}</ErrorNote>}
      {boards.data === undefined && boards.error === null && <div className="py-6 text-sm text-muted-foreground">Loading boards…</div>}
      {showEmpty && (
        <div className="py-10 text-center text-sm text-muted-foreground">
          <div className="mx-auto mb-2 size-10 rounded-full border border-border bg-card p-2 text-primary"><Icon name={currentTab === "archived" ? "Archive" : "LayoutGrid"} className="size-6" aria-hidden /></div>
          <div className="font-medium text-foreground">{query.trim() === "" ? currentTab === "archived" ? "No archived boards yet." : "Your first board starts here." : "No matching boards."}</div>
          <div className="mt-1">{query.trim() === "" ? currentTab === "archived" ? "When you archive a board, it will stay here until restored." : "Create a board to save an explicit set of PRs." : "Try another search."}</div>
          {currentTab !== "archived" && query.trim() === "" && <button type="button" className={`${BUTTON_PRIMARY} mt-4`} onClick={() => setDialog({ kind: "create" })}>Create board</button>}
        </div>
      )}
      {items.length > 0 && <div className="grid gap-3 @xl:grid-cols-2 @5xl:grid-cols-3">{items.map((board) => <BoardCard key={board.id} board={board} onOpen={() => onGo({ view: "board", id: board.id, key: null })} />)}</div>}
      {dialog?.kind === "create" && <BoardFormDialog mode="create" onClose={() => setDialog(null)} prs={[]} />}
    </div>
  );
}

type BoardStatus = "all" | "attention" | "ready" | "waiting" | "draft" | "merged" | "closed";

function boardFiltersVisible(pr: PrView, query: string, status: BoardStatus) {
  const matchesStatus = status === "all" || (status === "attention" ? pr.next.inbox && pr.next.kind !== "ready_to_merge"
    : status === "ready" ? pr.next.kind === "ready_to_merge"
    : status === "waiting" ? pr.next.kind === "waiting_review"
    : pr.state === status);
  if (!matchesStatus) return false;
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return `${pr.title} ${pr.repo} ${pr.number} ${pr.author} ${pr.key} ${shortKey(pr)} ${pr.serverName}`.toLowerCase().includes(needle);
}

function BoardBulkBar({ count, onRemove, onClear, onCreate, onAdd, archived }: { count: number; onRemove(): void; onClear(): void; onCreate(): void; onAdd(): void; archived: boolean }) {
  if (count === 0 || archived) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
      <b>{count} selected</b>
      <span className="flex-1" />
      <button type="button" className={BUTTON_PRIMARY} onClick={onCreate}>Save as new board</button>
      <button type="button" className={BUTTON} onClick={onAdd}>Add to board</button>
      <button type="button" className={`${BUTTON} border-destructive/40 text-destructive`} onClick={onRemove}>Remove selected</button>
      <button type="button" className={BUTTON_GHOST} onClick={onClear}>Clear selection</button>
    </div>
  );
}

export function BoardDetailView({ id, layout, onGo }: { id: string; layout: RowLayout; onGo(next: Route): void }) {
  const boardQuery = useShuttleQuery("board", { id });
  const views = useStored(boardViews);
  const view = Object.hasOwn(views, id) ? views[id]! : DEFAULT_BOARD_VIEW;
  const setView = (next: Partial<BoardViewPrefs>) => boardViews.set({ ...boardViews.get(), [id]: { ...view, ...next } });
  const groupFolding = useFolding(`board/${id}/groups/${view.group}`);
  const folding = useFolding(`board/${id}`);
  const activityFolded = folding.folded("Activity");
  const update = useShuttleMutation("boardUpdate");
  const remove = useShuttleMutation("boardRemove");
  const addBack = useShuttleMutation("boardAdd");
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<null | { kind: "edit" | "duplicate" | "add" | "archive" | "tools" | "remove" | "create" | "choose" }>(null);
  const [status, setStatus] = useState<BoardStatus>("all");
  const selection = useSelectedKeys();
  useEffect(() => {
    selection.clear();
    setQuery("");
    setStatus("all");
    setDialog(null);
  }, [id, selection.clear]);
  const navigate = useBbNavigate();
  const detail: BoardDetail | undefined = boardQuery.data;
  const selected = useMemo(() => new Set(selection.selected), [selection.selected]);
  const toggleSelected = useCallback((key: string) => selection.toggle(key), [selection]);

  if (boardQuery.error !== null) {
    return (
      <div className="@container w-full px-4 pb-10 pt-4 sm:px-5">
        <PageHeading title="Board" description="Loading the saved PR set." />
        <ErrorNote>{messageOf(boardQuery.error)}</ErrorNote>
      </div>
    );
  }

  if (detail === undefined) {
    return <div className="@container w-full px-4 pb-10 pt-4 sm:px-5"><PageHeading title="Board" description="Loading the saved PR set." /><div className="py-6 text-sm text-muted-foreground">Loading…</div></div>;
  }

  const board = detail.board;
  const archived = board.archivedAt !== null;
  const prs = detail.prs;
  const filtered = prs.filter((pr) => boardFiltersVisible(pr, query, status));
  const visible = view.sort === "saved" ? filtered : sortPrs(filtered, view.sort);
  const sections = groupBoardPrs(visible, view.group);
  const removeSelected = async () => {
    if (selection.selected.length === 0) return;
    const out = await remove.run({ id: board.id, prs: selection.selected });
    if (out === null) return;
    selection.clear();
    setDialog(null);
    if (out.removed.length === 0) {
      toast.success("Those PRs were already removed.");
      return;
    }
    undoToast(`Removed ${plural(out.removed.length, "PR")} from “${board.name}”.`, () => void (async () => {
      const restored = await addBack.run({ id: board.id, prs: out.removed });
      if (restored !== null) toast.success(`Restored ${plural(restored.added.length || out.removed.length, "PR")} to “${board.name}”.`);
    })());
  };
  const openPr = (key: string) => onGo({ view: "board", id, key });
  const row = (pr: PrView) => {
    const rowLayout: RowLayout = {
      ...layout,
      selection: archived ? undefined : { checked: selected.has(pr.key), onToggle: () => toggleSelected(pr.key) },
      onSelect: openPr,
    };
    return pr.mine ? <MineRow key={pr.key} pr={pr} layout={rowLayout} time={view.sort === "saved" ? undefined : rowTime(pr, view.sort)} /> : <ReviewRow key={pr.key} pr={pr} layout={rowLayout} />;
  };

  const header = (
    <>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold">{board.name}</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">{board.description || "Saved PRs that stay live."}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><Icon name={archived ? "Archive" : "LayoutGrid"} className="size-3.5" aria-hidden />{board.archivedAt === null ? "Live board" : "Archived board"}</span>
            <span>Created {ago(board.createdAt)}</span>
            <span>Updated {ago(board.updatedAt)}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {!archived && <button type="button" className={BUTTON_PRIMARY} onClick={() => setDialog({ kind: "add" })}><Icon name="Plus" className="size-3.5" aria-hidden />Add PRs</button>}
          <button type="button" className={BUTTON} onClick={() => setDialog({ kind: "edit" })}>Edit board</button>
          <button type="button" className={BUTTON} onClick={() => setDialog({ kind: "duplicate" })}>Duplicate</button>
          {!archived ? <button type="button" className={`${BUTTON} text-destructive`} onClick={() => setDialog({ kind: "archive" })}>Archive board</button> : <button type="button" className={BUTTON} onClick={() => void (async () => {
            const out = await update.run({ id: board.id, archived: false });
            if (out === null) return;
            undoToast(`Restored “${board.name}”.`, () => void update.run({ id: board.id, archived: true }));
            navigate.toPluginPanel(PANEL_PATH, { subPath: formatRoute({ view: "board", id: board.id, key: null }) });
          })()}>Restore board</button>}
          <button type="button" className={BUTTON_GHOST} onClick={() => setDialog({ kind: "tools" })}>Thread tools</button>
        </div>
      </div>
    </>
  );

  return (
    <div className="@container w-full px-4 pb-10 pt-4 sm:px-5">
      <PageHeading title="Boards" description="Keep a specific set of PRs together, across repositories and servers." />
      {header}
      <div className="mt-4 grid gap-3 border-y border-border py-4 text-sm sm:grid-cols-4">
        <div><b className="block text-base">{plural(board.prCount, "saved PR")}</b><span className="text-muted-foreground">Live membership</span></div>
        <div><b className="block text-base text-warning-text">{board.attention} {board.attention === 1 ? "needs" : "need"} attention</b><span className="text-muted-foreground">Checks or reviews need work</span></div>
        <div><b className="block text-base text-success">{board.ready} ready to merge</b><span className="text-muted-foreground">Already in good shape</span></div>
        <div><b className="block text-base text-primary">{board.merged} merged</b><span className="text-muted-foreground">Still saved until removed</span></div>
      </div>
      {archived && <div className="mt-4 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">This board is archived. Restore it to add or remove PRs.</div>}
      <div className="mb-5 mt-4 flex flex-wrap items-center gap-2">
        <label className="flex min-w-[14rem] flex-1 items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-muted-foreground sm:max-w-md">
          <Icon name="Search" className="size-4 shrink-0" aria-hidden />
          <input aria-label="Filter board PRs" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter PRs in this board…" className="min-w-0 flex-1 bg-transparent outline-none" />
        </label>
        <select aria-label="Board status" value={status} onChange={(event) => setStatus(event.target.value as BoardStatus)} className={FIELD}>
          <option value="all">All statuses</option>
          <option value="attention">Needs attention</option>
          <option value="ready">Ready to merge</option>
          <option value="waiting">Awaiting review</option>
          <option value="draft">Draft</option>
          <option value="merged">Merged</option>
          <option value="closed">Closed</option>
        </select>
        <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          Sort by
          <select aria-label="Sort by" value={view.sort} onChange={(event) => setView({ sort: event.target.value as BoardSort })} className={FIELD}>
            {Object.entries(BOARD_SORT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          Group by
          <select aria-label="Group by" value={view.group} onChange={(event) => setView({ group: event.target.value as BoardGrouping })} className={FIELD}>
            {Object.entries(BOARD_GROUP_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        {sections.length > 0 && <span className="ml-auto"><FoldAllButton titles={sections.map((section) => section.key)} folding={groupFolding} /></span>}
      </div>
      <BoardBulkBar count={selection.selected.length} onRemove={() => setDialog({ kind: "remove" })} onClear={selection.clear} onCreate={() => setDialog({ kind: "create" })} onAdd={() => setDialog({ kind: "choose" })} archived={archived} />
      {visible.length === 0 && (
        <div className="py-10 text-center text-sm text-muted-foreground">{prs.length === 0 ? "This board is empty." : "No matching PRs."}</div>
      )}
      {visible.length > 0 && view.group === "none" && (
        <ul aria-label="Board PRs" className="overflow-hidden rounded-lg border border-border bg-card">{visible.map(row)}</ul>
      )}
      {sections.map((section) => {
        const folded = groupFolding.folded(section.key);
        return (
          <section key={section.key} aria-label={section.title} data-group={section.title} data-folded={folded ? "" : undefined}>
            <GroupHeader title={section.title} count={section.prs.length} layout={layout} folded={folded} onFold={() => groupFolding.toggle(section.key)} />
            {!folded && <ul className="overflow-hidden rounded-lg border border-border bg-card">{section.prs.map(row)}</ul>}
          </section>
        );
      })}
      <section aria-label="Board activity" data-folded={activityFolded ? "" : undefined} className="mt-6">
        <GroupHeader title="Activity" count={detail.activity.length} layout={layout} folded={activityFolded} onFold={() => folding.toggle("Activity")} />
        {!activityFolded && (detail.activity.length === 0 ? <p className="text-xs text-muted-foreground">No activity yet.</p> : (
          <ol aria-label="Board activity log" className="font-mono text-xs leading-5">
            {detail.activity.map((item) => (
              <li key={item.id} title={item.threadId === null ? undefined : `Thread: ${item.threadId}`} className="flex items-baseline gap-3 py-px">
                <time dateTime={new Date(item.at).toISOString()} title={new Date(item.at).toLocaleString()} className="shrink-0 whitespace-nowrap text-muted-foreground">{clock(item.at)}</time>
                <span className="min-w-0 break-words">{item.text}</span>
              </li>
            ))}
          </ol>
        ))}
      </section>
      {dialog?.kind === "edit" && <BoardFormDialog mode="edit" board={board} onClose={() => setDialog(null)} />}
      {dialog?.kind === "duplicate" && <BoardFormDialog mode="duplicate" board={board} prs={prs.map((pr) => pr.key)} onClose={() => setDialog(null)} />}
      {dialog?.kind === "add" && <BoardAddDialog board={board} existingKeys={prs.map((pr) => pr.key)} onClose={() => setDialog(null)} />}
      {dialog?.kind === "archive" && <BoardArchiveDialog board={board} onClose={() => setDialog(null)} onArchive={() => void (async () => {
        const out = await update.run({ id: board.id, archived: true });
        if (out === null) return;
        setDialog(null);
        undoToast(`Archived “${board.name}”.`, () => void update.run({ id: board.id, archived: false }));
        onGo({ view: "boards", tab: "archived" });
      })()} />}
      {dialog?.kind === "remove" && !archived && <Dialog
        title="Remove PRs from this board?"
        subtitle={`${plural(selection.selected.length, "PR")} will leave “${board.name}”.`}
        onClose={() => setDialog(null)}
        footer={<><button type="button" className={BUTTON} onClick={() => setDialog(null)}>Cancel</button><button type="button" className={BUTTON_PRIMARY} disabled={remove.isPending} onClick={() => void removeSelected()}>Remove {plural(selection.selected.length, "PR")}</button></>}
      ><p className="text-sm text-muted-foreground">They stay on their server and in other boards. Their agents and review tracking do not change. You can undo this removal.</p></Dialog>}
      {dialog?.kind === "create" && <BoardFormDialog mode="create" prs={selection.selected} onClose={() => setDialog(null)} />}
      {dialog?.kind === "choose" && <BoardChooserDialog prs={selection.selected} onClose={() => setDialog(null)} onCreateBoard={() => setDialog({ kind: "create" })} />}
      {dialog?.kind === "tools" && <BoardToolsDialog board={board} onClose={() => setDialog(null)} />}
    </div>
  );
}

export function BoardMemberships({ pr }: { pr: PrView }) {
  const memberships = useShuttleQuery("boards", { archived: "include", key: pr.key });
  const navigate = useBbNavigate();
  const [dialog, setDialog] = useState<null | "choose" | "create">(null);

  const boards = memberships.data?.boards ?? [];

  return (
    <section aria-label="Boards" className="mx-4 mt-4">
      <div className="mb-2 flex items-center gap-2">
        <SectionTitle icon="LayoutGrid">Boards</SectionTitle>
        <span className="text-xs text-muted-foreground">· {boards.length}</span>
        <span className="flex-1" />
        <button type="button" className={BUTTON_GHOST} onClick={() => setDialog("choose")}>Add to board</button>
      </div>
      {memberships.error !== null && <ErrorNote>Could not load boards: {messageOf(memberships.error)}</ErrorNote>}
      {memberships.data === undefined && memberships.error === null && <p className="text-sm text-muted-foreground">Loading board memberships…</p>}
      {memberships.data !== undefined && boards.length === 0 && <p className="text-sm text-muted-foreground">Not saved to any board.</p>}
      {boards.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {boards.map((board) => (
            <button key={board.id} type="button" className={BUTTON} onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: formatRoute({ view: "board", id: board.id, key: null }) })}>
              <Icon name={board.archivedAt === null ? "LayoutGrid" : "Archive"} className="size-3.5" aria-hidden />
              {board.name}
              {board.archivedAt !== null && <span className="rounded-full border border-border px-1.5 py-0.5 text-[10.5px] text-muted-foreground">Archived</span>}
            </button>
          ))}
        </div>
      )}
      {dialog === "choose" && <BoardChooserDialog prs={[pr.key]} onClose={() => setDialog(null)} onCreateBoard={() => setDialog("create")} />}
      {dialog === "create" && <BoardFormDialog mode="create" prs={[pr.key]} onClose={() => setDialog(null)} />}
    </section>
  );
}

export function BoardSelectionToolbar({ selected, onCreate, onAdd, onClear }: { selected: readonly string[]; onCreate(): void; onAdd(): void; onClear(): void }) {
  if (selected.length === 0) {
    return (
      <div className="mb-3 rounded-lg border border-dashed border-border bg-card px-3 py-2 text-sm text-muted-foreground">
        Select PRs to save a set as a new board or add them to an existing one.
      </div>
    );
  }
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
      <b>{selected.length} selected</b>
      <span className="flex-1" />
      <button type="button" className={BUTTON_PRIMARY} onClick={onCreate}>Save as new board</button>
      <button type="button" className={BUTTON} onClick={onAdd}>Add to board</button>
      <button type="button" className={BUTTON_GHOST} onClick={onClear}>Clear selection</button>
    </div>
  );
}

export function useBoardSelection() {
  return useSelectedKeys();
}

export function BoardSearchAddDialog({ board, onClose, existingKeys }: { board: BoardSummary; onClose(): void; existingKeys: readonly string[] }) {
  return <BoardAddDialog board={board} existingKeys={existingKeys} onClose={onClose} />;
}

export function BoardPickerDialog({ prs, onClose, onCreateBoard }: { prs: readonly string[]; onClose(): void; onCreateBoard(): void }) {
  return <BoardChooserDialog prs={prs} onClose={onClose} onCreateBoard={onCreateBoard} />;
}
