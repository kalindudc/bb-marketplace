import { randomUUID } from "node:crypto";
import type { BoardActivity, BoardArchived, BoardDetail, BoardSummary, PrView } from "./contract";
import { NotFoundError, ShuttleError, type Ctx } from "./ctx";
import type { BoardRow, PrRow } from "./db/store";
import { parseKey, prKey, resolveQuery } from "./keys";
import { lookup } from "./prs";
import { toView } from "./views";

const PREVIEW_LIMIT = 3;
const ACTIVITY_LIMIT = 50;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const normalizeName = (name: string) => name.trim().toLowerCase();
const cleanName = (name: string) => {
  const cleaned = name.trim();
  if (!cleaned) throw new ShuttleError("Give the board a name.");
  return cleaned;
};
const cleanDescription = (description: string | undefined) => description?.trim() ?? "";
const boardId = () => `board_${randomUUID()}`;
const needsAttention = (pr: PrView) => pr.next.inbox && pr.next.kind !== "ready_to_merge";
const isReady = (pr: PrView) => pr.next.kind === "ready_to_merge";

function requireBoardRow(ctx: Ctx, id: string): BoardRow {
  const board = ctx.store.board(id);
  if (!board) throw new NotFoundError(`board ${id} was not found`);
  return board;
}

function requireMutableBoard(ctx: Ctx, id: string): BoardRow {
  const board = requireBoardRow(ctx, id);
  if (board.archived_at !== null) throw new ShuttleError(`board ${board.name} is archived; restore it before changing its membership`);
  return board;
}

function ensureUniqueName(ctx: Ctx, name: string, exceptId?: string): void {
  const existing = ctx.store.boardByNameKey(normalizeName(name));
  if (existing && existing.id !== exceptId) throw new ShuttleError(`A board called “${existing.name}” already exists, including in Archived.`);
}

function boardActivity(row: { id: number; at: number; text: string; thread_id: string | null }): BoardActivity {
  return { id: row.id, at: row.at, text: row.text, threadId: row.thread_id };
}

function boardSummary(row: BoardRow, prs: PrView[]): BoardSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    createdBy: row.created_by,
    prCount: prs.length,
    attention: prs.filter(needsAttention).length,
    ready: prs.filter(isReady).length,
    merged: prs.filter((pr) => pr.state === "merged").length,
    preview: prs.slice(0, PREVIEW_LIMIT).map((pr) => ({ key: pr.key, title: pr.title, state: pr.state })),
  };
}

function boardViews(ctx: Ctx, boardId: string): PrView[] {
  return ctx.store.boardPrs(boardId).map((pr) => toView(ctx, pr));
}

function boardRow(ctx: Ctx, id: string): BoardSummary {
  const row = requireBoardRow(ctx, id);
  return boardSummary(row, boardViews(ctx, id));
}

async function resolveBoardPrs(ctx: Ctx, queries: readonly string[]): Promise<PrRow[]> {
  const prs: PrRow[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    const pr = await lookup(ctx, query);
    if (seen.has(pr.key)) continue;
    seen.add(pr.key);
    prs.push(pr);
  }
  return prs;
}

function resolveBoardKeys(ctx: Ctx, queries: readonly string[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    const direct = parseKey(query);
    const key = prKey(direct ?? resolveQuery(query, ctx.config().servers));
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

export function boards(ctx: Ctx, input: { query?: string; archived?: BoardArchived; key?: string } = {}): { boards: BoardSummary[] } {
  const query = input.query?.trim().toLowerCase();
  let prId: number | undefined;
  if (input.key !== undefined) {
    const ref = parseKey(input.key);
    if (ref === null) throw new ShuttleError("Pass a canonical PR key such as github:owner/repo#123.");
    const pr = ctx.store.prByRef(ref);
    if (pr === null) return { boards: [] };
    prId = pr.id;
  }
  const rows = ctx.store.boards({ archived: input.archived ?? "exclude", ...(prId === undefined ? {} : { prId }) });
  return {
    boards: rows
      .filter((row) => !query || `${row.name} ${row.description}`.toLowerCase().includes(query))
      .map((row) => boardSummary(row, boardViews(ctx, row.id))),
  };
}

export function board(ctx: Ctx, id: string): BoardDetail {
  const row = requireBoardRow(ctx, id);
  const prs = boardViews(ctx, id);
  return {
    board: boardSummary(row, prs),
    prs,
    activity: ctx.store.boardActivity(id, ACTIVITY_LIMIT).map(boardActivity),
  };
}

export async function boardCreate(
  ctx: Ctx,
  input: { name: string; description?: string; prs?: string[] },
  actorThreadId?: string,
): Promise<BoardDetail> {
  const name = cleanName(input.name);
  const description = cleanDescription(input.description);
  ensureUniqueName(ctx, name);
  const prs = await resolveBoardPrs(ctx, input.prs ?? []);
  const id = boardId();
  ctx.store.tx(() => {
    ensureUniqueName(ctx, name);
    const now = ctx.now();
    ctx.store.addBoard({ id, name, name_key: normalizeName(name), description, created_at: now, updated_at: now, archived_at: null, created_by: actorThreadId ?? null });
    let position = 1;
    for (const pr of prs) ctx.store.addBoardMember(id, pr.id, position++);
    ctx.store.addBoardActivity(id, prs.length > 0 ? `Created the board with ${plural(prs.length, "PR")}.` : "Created the board.", actorThreadId ?? null);
  });
  ctx.port.publish(["boards"]);
  return board(ctx, id);
}

export function boardUpdate(
  ctx: Ctx,
  input: { id: string; name?: string; description?: string; archived?: boolean },
  actorThreadId?: string,
): { board: BoardSummary } {
  let changed = false;
  ctx.store.tx(() => {
    const current = requireBoardRow(ctx, input.id);
    const nextName = input.name === undefined ? current.name : cleanName(input.name);
    const nextDescription = input.description === undefined ? current.description : cleanDescription(input.description);
    const nextArchivedAt = input.archived === undefined ? current.archived_at : input.archived ? current.archived_at ?? ctx.now() : null;
    const detailsChanged = nextName !== current.name || nextDescription !== current.description;
    const archivedChanged = nextArchivedAt !== current.archived_at;
    if (!detailsChanged && !archivedChanged) return;
    if (nextName !== current.name) ensureUniqueName(ctx, nextName, current.id);
    ctx.store.saveBoard({ ...current, name: nextName, name_key: normalizeName(nextName), description: nextDescription, updated_at: ctx.now(), archived_at: nextArchivedAt });
    if (detailsChanged) ctx.store.addBoardActivity(current.id, "Updated the board details.", actorThreadId ?? null);
    if (archivedChanged) ctx.store.addBoardActivity(current.id, nextArchivedAt === null ? "Restored the board." : "Archived the board.", actorThreadId ?? null);
    changed = true;
  });
  if (changed) ctx.port.publish(["boards"]);
  return { board: boardRow(ctx, input.id) };
}

export async function boardAdd(
  ctx: Ctx,
  input: { id: string; prs: string[] },
  actorThreadId?: string,
): Promise<{ board: BoardSummary; added: string[]; alreadyPresent: string[] }> {
  requireMutableBoard(ctx, input.id);
  const prs = await resolveBoardPrs(ctx, input.prs);
  const out = ctx.store.tx(() => {
    const current = requireMutableBoard(ctx, input.id);
    const existing = new Set(ctx.store.boardPrIds(current.id));
    const added: string[] = [];
    const alreadyPresent: string[] = [];
    let position = ctx.store.maxBoardPosition(current.id) + 1;
    for (const pr of prs) {
      if (existing.has(pr.id)) {
        alreadyPresent.push(pr.key);
        continue;
      }
      ctx.store.addBoardMember(current.id, pr.id, position++);
      existing.add(pr.id);
      added.push(pr.key);
    }
    if (added.length > 0) {
      ctx.store.saveBoard({ ...current, updated_at: ctx.now() });
      ctx.store.addBoardActivity(current.id, `Added ${plural(added.length, "PR")}.`, actorThreadId ?? null);
    }
    return { added, alreadyPresent, changed: added.length > 0 };
  });
  if (out.changed) ctx.port.publish(["boards"]);
  return { board: boardRow(ctx, input.id), added: out.added, alreadyPresent: out.alreadyPresent };
}

export function boardRemove(
  ctx: Ctx,
  input: { id: string; prs: string[] },
  actorThreadId?: string,
): { board: BoardSummary; removed: string[] } {
  const keys = resolveBoardKeys(ctx, input.prs);
  const out = ctx.store.tx(() => {
    const current = requireMutableBoard(ctx, input.id);
    const removed: string[] = [];
    for (const key of keys) {
      const pr = ctx.store.prByKey(key);
      if (!pr) continue;
      if (ctx.store.removeBoardMember(current.id, pr.id)) removed.push(pr.key);
    }
    if (removed.length > 0) {
      ctx.store.saveBoard({ ...current, updated_at: ctx.now() });
      ctx.store.addBoardActivity(current.id, `Removed ${plural(removed.length, "PR")}.`, actorThreadId ?? null);
    }
    return { removed, changed: removed.length > 0 };
  });
  if (out.changed) ctx.port.publish(["boards"]);
  return { board: boardRow(ctx, input.id), removed: out.removed };
}
