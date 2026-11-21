import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { JournalEdit } from "../shared/contract";
import type { Actor, BoardQuest, JournalEntry, Journal, JournalProgress, WaypointLink } from "../shared/schema";

type HookContext = Parameters<Parameters<BbPluginApi["experimental_hooks"]["on"]>[1]>[0];
export type Database = ReturnType<BbPluginApi["storage"]["database"]>;

export type BoardQuestMirror = Pick<BoardQuest, "id" | "title" | "phase" | "updatedAt" | "endedAt" | "outcome" | "waivers">;

export interface JournalPort {
  // added by Builder A: board phase changes refresh the Keeper's read-only checklist mirrors.
  syncBoardQuests(threadId: string): void;
  // added by Builder A: finish legacy reads/reservations before synchronous writes can allocate an id.
  prepare(threadId: string): Promise<void>;
  /** Also imports a pi-quests log on first touch. */
  get(threadId: string): Journal;
  progress(threadId: string): JournalProgress & { lastEvidenceAt?: number };
  /** User edits from the UI. */
  edit(threadId: string, edit: JournalEdit, actor: Actor): { message: string };
  /** Create or update a waypoint entry, honouring the supplied owner. Await prepare before any allocating write. */
  linkWaypoint(memberThreadId: string, link: WaypointLink, description: string, owner: string, actor: Actor): string;
  /** Every entry linked to a board quest, across threads, for the waypoint roll-up. */
  linkedEntries(boardQuestId: string): JournalEntry[];
  /** Open entries as a few lines, for re-anchoring text. */
  openSummary(threadId: string, limit: number): string;
  /** The journal as Markdown, grouped as the panel's tracker; read-only, so a thread without a journal gets none. */
  exportMarkdown(threadId: string): Promise<string>;
  /** A follow-up brief (version) reached this member: reopen its finished entries linked to the quest, and move their evidence to the note. */
  rebriefed(memberThreadId: string, boardQuestId: string, version: number): void;
  /** Instructions block for configure: the tool's rules, plus a snapshot of open entries. */
  instructions(threadId: string): string;
  /** Called first in the plugin's single message.dispatch handler: a reject message for a Tavern note that would start a turn, else null. */
  dispatchCheck(ctx: HookContext): string | null;
  /** A listener may return further tags the change makes stale; the journal sends them in its one signal. */
  onChange(listener: (threadId: string, entryIds: string[]) => string[] | void): () => void;
}

export type JournalReview = { before: JournalEntry; after: JournalEntry; sequence: number; undone?: boolean };

export interface JournalDeps {
  assertWritable?(threadId: string): void;
  isRetired?(threadId: string): boolean;
  beforeVerdict?(callerThreadId: string, targetThreadId: string, entryIds: string[]): Promise<(() => string | void) | void>;
  /** Private proof receipt, inside the review transaction; never an agent-visible event. */
  reviewed?(review: JournalReview): void;
  verdictSubmitted?(actor: Actor, entries: JournalEntry[]): void;
  /** A verified entry is about to reopen for a newer brief: its receipt no longer proves the maker's waypoint, though the Warden keeps the check. Inside the journal transaction; must not throw. */
  superseded?(input: { entry: JournalEntry; version: number; at: number }): void;
  settings?(): { journalReminders: boolean; journalQuietMinutes: number; remindEveryMinutes?: number; reportGraceMinutes?: number };
  // added by Builder A: the Keeper store is authoritative for board-mirror phases, including old unmarked entries.
  boardQuestsOf?(threadId: string): readonly BoardQuestMirror[];
  /** The caller's Tavern role, from the members table (never from metadata). */
  // added by Builder A: a present checker list is the current-plan assignment; an empty list grants no review permission.
  roleOf(threadId: string): { classId: string; role: "keeper" | "member" | "solo"; waypointId: string | null; boardQuestId: string | null; checkerWaypointIds?: readonly string[] } | null;
  invalidate(tags: string[]): void;
  /** A Tavern member's character name for a thread, so delegated entries name their owner; null for other threads. */
  nameOf?(threadId: string): string | null;
}

export type RegisterJournal = (bb: BbPluginApi, db: Database, deps: JournalDeps) => JournalPort;
