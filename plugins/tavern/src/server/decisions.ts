import { AttentionSnapshot, DECIDED_FOR_YOU_SQL, decisionUndoProjection } from "./attention";
import type { Decision } from "../shared/schema";
import type { KeeperStore, Records } from "./keeper/store";

type Filter = { keeperThreadId?: string; boardQuestId?: string };
type AttentionFilter = Filter & { ids?: string[]; throughId?: string | null };
type MarkInput = { ids: string[] } | { all: true; keeperThreadId?: string; throughId?: string | null };
type Query = { sql: string; args: (string | number)[] };
type Row = { data: string };

export class DecisionViews {
  constructor(readonly store: KeeperStore) {}

  private attentionQuery(filter: AttentionFilter): Query {
    const terms = [
      "r.kind='decisions'",
      DECIDED_FOR_YOU_SQL,
      "json_extract(r.data,'$.reversible')=1",
      "json_extract(r.data,'$.undone')=0",
      "json_extract(r.data,'$.seenAt') IS NULL",
      "NOT EXISTS (SELECT 1 FROM tavern_records seen WHERE seen.kind='attentionSeen' AND seen.id=r.id)",
      `NOT EXISTS (SELECT 1 FROM tavern_records q WHERE q.kind='quests'
        AND q.id=json_extract(r.data,'$.boardQuestId') AND (q.archived_at IS NOT NULL OR json_extract(q.data,'$.deletedAt') IS NOT NULL))`,
    ];
    const args: Query["args"] = [];
    for (const field of ["keeperThreadId", "boardQuestId"] as const) {
      if (filter[field] !== undefined) {
        terms.push(`json_extract(r.data,'$.${field}')=?`);
        args.push(filter[field]);
      }
    }
    if (filter.ids) {
      terms.push(`r.id IN (${filter.ids.map(() => "?").join(",")})`);
      args.push(...filter.ids);
    }
    if (filter.throughId === null) terms.push("0");
    else if (filter.throughId !== undefined) {
      const boundary = this.store.db.prepare(
        "SELECT rowid AS ordinal FROM tavern_records WHERE kind='decisions' AND id=?",
      ).get(filter.throughId) as { ordinal: number } | undefined;
      if (!boundary) throw new Error("The decision list changed; refresh before marking all seen");
      terms.push("r.rowid<=?");
      args.push(boundary.ordinal);
    }
    return { sql: terms.join(" AND "), args };
  }

  private attentionRows(query: Query, limit: number): Decision[] {
    const rows = this.store.db.prepare(
      `SELECT r.data FROM tavern_records r WHERE ${query.sql} ORDER BY r.rowid DESC LIMIT ?`,
    ).all(...query.args, limit) as Row[];
    return rows.map(row => JSON.parse(row.data) as Decision);
  }

  attention(filter: Filter = {}) {
    return new AttentionSnapshot(this.store, filter).calls(filter, 100);
  }

  mark(input: MarkInput, at: number) {
    const token = this.store.id("seen");
    const changed: Decision[] = [];
    this.store.atomic(() => {
      const filter = "ids" in input ? { ids: [...new Set(input.ids)] } : input;
      const query = this.attentionQuery(filter);
      for (;;) {
        const page = this.attentionRows(query, 200);
        if (!page.length) break;
        for (const decision of page) {
          this.store.put("decisions", decision.id, { ...decision, seenAt: at });
          this.store.put("attentionSeen", decision.id, { token, seenAt: at });
          changed.push(decision);
        }
        if ("ids" in input) break;
      }
    });
    return {
      changed,
      result: {
        ok: true as const,
        ids: changed.map(decision => decision.id),
        undoToken: changed.length ? token : null,
      },
    };
  }

  unseen(token: string) {
    const changed: Decision[] = [];
    this.store.atomic(() => {
      for (;;) {
        const page = this.store.db.prepare(
          `SELECT id,data FROM tavern_records WHERE kind IN ('attentionSeen','decisionSeen')
            AND json_extract(data,'$.token')=? ORDER BY rowid LIMIT 200`,
        ).all(token) as (Row & { id: string })[];
        if (!page.length) break;
        for (const row of page) {
          const mark = JSON.parse(row.data) as Records["attentionSeen"];
          const decision = this.store.get("decisions", row.id);
          if (decision && decision.seenAt === mark.seenAt) {
            this.store.put("decisions", row.id, { ...decision, seenAt: null });
            changed.push(decision);
          }
          this.store.remove("attentionSeen", row.id);
          this.store.remove("decisionSeen", row.id);
        }
      }
    });
    return { changed, result: { ok: true as const, ids: changed.map(decision => decision.id) } };
  }

  history(filter: Filter & { keeperThreadId: string }, cursor: string | null = null, limit = 100) {
    const where = "kind='decisions' AND json_extract(data,'$.keeperThreadId')=?"
      + (filter.boardQuestId === undefined ? "" : " AND json_extract(data,'$.boardQuestId')=?");
    const args = [filter.keeperThreadId, ...(filter.boardQuestId === undefined ? [] : [filter.boardQuestId])];
    let before: number | null = null;
    if (cursor !== null) {
      try {
        if (cursor.length > 1024) throw new Error("Cursor too long");
        const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (!Array.isArray(value) || value.length !== 4 || value[0] !== filter.keeperThreadId
          || value[1] !== (filter.boardQuestId ?? null) || !Number.isSafeInteger(value[2])
          || value[2] < 1 || typeof value[3] !== "string") throw new Error("Cursor scope mismatch");
        const anchor = this.store.db.prepare(
          `SELECT id FROM tavern_records WHERE ${where} AND rowid=? AND id=?`,
        ).get(...args, value[2], value[3]);
        if (!anchor) throw new Error("Cursor anchor changed");
        before = value[2];
      } catch {
        throw new Error("Invalid decision history cursor; refresh this history");
      }
    }
    const rows = this.store.db.prepare(
      `SELECT rowid AS ordinal,id,data FROM tavern_records WHERE ${where}
        ${before === null ? "" : "AND rowid<?"} ORDER BY rowid DESC LIMIT ?`,
    ).all(...args, ...(before === null ? [] : [before]), limit + 1) as (Row & { id: string; ordinal: number })[];
    const count = this.store.db.prepare(
      `SELECT count(*) AS n FROM tavern_records WHERE ${where}`,
    ).get(...args) as { n: number };
    const page = rows.slice(0, limit), last = page.at(-1);
    return {
      decisions: page.map(row => JSON.parse(row.data) as Decision).map(decisionUndoProjection(this.store)),
      nextCursor: rows.length > limit && last
        ? Buffer.from(JSON.stringify([
            filter.keeperThreadId, filter.boardQuestId ?? null, last.ordinal, last.id,
          ])).toString("base64url")
        : null,
      total: count.n,
    };
  }
}
