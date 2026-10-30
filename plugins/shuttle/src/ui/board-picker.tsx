import { useState } from "react";
import { toast } from "sonner";
import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { BoardSummary, PrView } from "../contract";
import { BoardFormDialog } from "./boards";
import { PANEL_PATH } from "./constants";
import { messageOf, useShuttleMutation, useShuttleQuery } from "./data";
import { plural } from "./format";
import { Picker, PickerAction, PickerCheckbox, PickerFilter, PickerGroup, PickerSeparator } from "./picker";
import { formatRoute } from "./route";

export const CHIP = "inline-flex h-[22px] shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border border-border px-2 text-[11.5px] text-muted-foreground hover:bg-state-hover hover:text-foreground";
export const CHIP_ADD = `${CHIP} border-dashed`;

/** Every active board, ticked where the PR is; a tick adds it at once and an untick takes it out. */
function BoardChoices({ pr, onCreate }: { pr: PrView; onCreate(name: string): void }) {
  const all = useShuttleQuery("boards", { archived: "exclude" });
  const memberships = useShuttleQuery("boards", { archived: "include", key: pr.key });
  const membershipInput = { archived: "include" as const, key: pr.key };
  const add = useShuttleMutation("boardAdd", ({ id }, cache) => cache.update("boards", membershipInput, (current) => {
    const board = all.data?.boards.find((item) => item.id === id);
    return board === undefined || current.boards.some((item) => item.id === id) ? current : { boards: [...current.boards, board] };
  }));
  const remove = useShuttleMutation("boardRemove", ({ id }, cache) => cache.update("boards", membershipInput, (current) => ({ boards: current.boards.filter((item) => item.id !== id) })));
  const [filter, setFilter] = useState("");
  const member = new Set((memberships.data?.boards ?? []).map((board) => board.id));
  const archived = (memberships.data?.boards ?? []).filter((board) => board.archivedAt !== null);
  const needle = filter.trim().toLowerCase();
  const matches = (board: BoardSummary) => `${board.name} ${board.description}`.toLowerCase().includes(needle);
  const shown = (all.data?.boards ?? []).filter(matches);
  const busy = add.isPending || remove.isPending;

  const toggle = async (board: BoardSummary) => {
    if (member.has(board.id)) {
      if ((await remove.run({ id: board.id, prs: [pr.key] })) !== null) toast.success(`Took it off “${board.name}”.`);
    } else if ((await add.run({ id: board.id, prs: [pr.key] })) !== null) {
      toast.success(`Added it to “${board.name}”.`);
    }
  };

  return (
    <>
      <PickerFilter label="Find a board" value={filter} onChange={setFilter} />
      {all.error !== null && <div className="px-2.5 py-1.5 text-xs text-destructive-text">Could not load boards: {messageOf(all.error)}</div>}
      {all.data === undefined && all.error === null && <div className="px-2.5 py-1.5 text-xs text-muted-foreground">Loading boards…</div>}
      {shown.length > 0 && <PickerGroup>Boards</PickerGroup>}
      {shown.map((board) => (
        <PickerCheckbox key={board.id} checked={member.has(board.id)} disabled={busy} onToggle={() => void toggle(board)}>
          <Icon name="LayoutGrid" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{board.name}</span>
            <span className="block truncate text-xs text-muted-foreground">{plural(board.prCount, "PR")}{board.description && ` · ${board.description}`}</span>
          </span>
        </PickerCheckbox>
      ))}
      {archived.filter(matches).length > 0 && <PickerGroup>Archived</PickerGroup>}
      {archived.filter(matches).map((board) => (
        <PickerCheckbox key={board.id} checked disabled onToggle={() => {}}>
          <Icon name="Archive" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{board.name}</span>
            <span className="block truncate text-xs text-muted-foreground">Restore the board to change it</span>
          </span>
        </PickerCheckbox>
      ))}
      {all.data !== undefined && shown.length === 0 && <div className="px-2.5 py-1.5 text-xs text-muted-foreground">{needle === "" ? "No boards yet." : "No board by that name."}</div>}
      <PickerSeparator />
      <PickerAction onSelect={() => onCreate(filter.trim())}>
        <Icon name="Plus" className="size-3.5" aria-hidden />
        {filter.trim() === "" ? "New board with this PR…" : `New board “${filter.trim()}” with this PR…`}
      </PickerAction>
    </>
  );
}

/** The boards a PR is on, each opening its board, and a picker to put it on more or take it off. */
export function BoardChips({ pr, phone }: { pr: PrView; phone: boolean }) {
  const navigate = useBbNavigate();
  const memberships = useShuttleQuery("boards", { archived: "include", key: pr.key });
  const [creating, setCreating] = useState<string | null>(null);
  const boards = memberships.data?.boards ?? [];
  return (
    <>
      {boards.map((board) => (
        <button key={board.id} type="button" data-board-chip={board.id} className={CHIP} title={`Open the board “${board.name}”`}
          onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: formatRoute({ view: "board", id: board.id, key: null }) })}>
          <Icon name={board.archivedAt === null ? "LayoutGrid" : "Archive"} className="size-3" aria-hidden />
          {board.name}
          {board.archivedAt !== null && <span className="text-[10.5px]">· archived</span>}
        </button>
      ))}
      <Picker phone={phone} title="Boards" triggerLabel="Boards for this PR" triggerClassName={CHIP_ADD} align="start"
        trigger={<><Icon name="Plus" className="size-3" aria-hidden />{boards.length === 0 ? "Add to a board" : "Boards"}</>}>
        <BoardChoices pr={pr} onCreate={(name) => setCreating(name)} />
      </Picker>
      {creating !== null && <BoardFormDialog mode="create" prs={[pr.key]} stay initialName={creating} onClose={() => setCreating(null)} />}
    </>
  );
}
