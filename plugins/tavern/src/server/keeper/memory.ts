import { createHash } from "node:crypto";
import {
  noteDraftSchema,
  gateInputSchema,
  type KeeperNote,
  type NoteDraft,
  type GateRecord,
  type Rule,
  type Route,
} from "../../shared/schema";
import type { Keeper } from "./service";
import { messageKey } from "../../shared/text";
import { isOpenQuest } from "../liveness";
import { settled } from "../../shared/waypoint";

export class KeeperMemory {
  review = () => ({ waiting: 0, budget: 3 });
  constructor(private k: Keeper) {}

  private noteWhere =
    "r.kind='notes' AND json_extract(r.data,'$.keeperThreadId')=? AND json_extract(r.data,'$.state')='open' AND (json_extract(r.data,'$.validUntil') IS NULL OR json_extract(r.data,'$.validUntil')>?) AND NOT EXISTS (SELECT 1 FROM tavern_records q WHERE q.kind='quests' AND q.id=json_extract(r.data,'$.boardQuestId') AND q.archived_at IS NOT NULL)";
  private olderPromiseWhere() {
    return `(json_extract(r.data,'$.kind')='commitment' AND json_extract(r.data,'$.boardQuestId') IS NULL AND ((json_extract(r.data,'$.dueAt') IS NOT NULL AND json_extract(r.data,'$.dueAt')<${this.k.now() - 86400_000}) OR (json_extract(r.data,'$.dueAt') IS NULL AND json_extract(r.data,'$.createdAt')<${this.k.now() - 3 * 86400_000})))`;
  }
  private currentNoteWhere() {
    return `${this.noteWhere} AND NOT ${this.olderPromiseWhere()}`;
  }
  olderPromiseCount(threadId: string) {
    return (
      this.k.store.db
        .prepare(
          `SELECT count(*) AS n FROM tavern_records r WHERE ${this.noteWhere} AND ${this.olderPromiseWhere()}`,
        )
        .get(threadId, this.k.now()) as { n: number }
    ).n;
  }
  lastReply(threadId: string, text?: string | null) {
    if (this.k.member(threadId)?.role !== "keeper" || !text?.trim()) return;
    this.k.store.patch(threadId, {
      lastReply: { text: text.trim().slice(0, 400), at: this.k.now() },
    });
    this.k.changed(threadId);
  }
  notes(
    threadId: string,
    limit = 100,
    offset = 0,
    questId?: string | null,
    includeOlder = false,
  ): KeeperNote[] {
    const rows = this.k.store.db
      .prepare(
        `SELECT r.data FROM tavern_records r WHERE ${includeOlder ? this.noteWhere : this.currentNoteWhere()} ${questId ? "AND json_extract(r.data,\'$.boardQuestId\')=?" : ""}
      ORDER BY CASE WHEN json_extract(r.data,'$.kind')='commitment' AND json_extract(r.data,'$.dueAt')<=${this.k.now() + 600_000} THEN 0 WHEN json_extract(r.data,'$.kind')='waiting-on-user' THEN 1 ELSE 2 END,
      json_extract(r.data,'$.updatedAt') DESC, r.rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(
        threadId,
        this.k.now(),
        ...(questId ? [questId] : []),
        limit,
        offset,
      ) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as KeeperNote);
  }
  noteCount(threadId: string, questId?: string | null, includeOlder = false) {
    return (
      this.k.store.db
        .prepare(
          `SELECT count(*) AS n FROM tavern_records r WHERE ${includeOlder ? this.noteWhere : this.currentNoteWhere()} ${questId ? "AND json_extract(r.data,\'$.boardQuestId\')=?" : ""}`,
        )
        .get(threadId, this.k.now(), ...(questId ? [questId] : [])) as {
        n: number;
      }
    ).n;
  }
  note(
    threadId: string,
    input: NoteDraft,
    source?: { sourceMessageId: string | null; routeId: string },
  ) {
    this.k.require(threadId, "keeper");
    const draft = noteDraftSchema.parse(input);
    if (draft.boardQuestId) {
      this.k.liveQuest(threadId, draft.boardQuestId);
      this.k.guard(threadId, draft.boardQuestId);
    }
    const note: KeeperNote = {
      id: this.k.store.id("note"),
      keeperThreadId: threadId,
      boardQuestId: draft.boardQuestId ?? null,
      kind: draft.kind,
      text: draft.text,
      ...(draft.action ? { action: draft.action } : {}),
      ...(draft.kind === "waiting-on-user" ? { need: draft.need } : {}),
      ...(draft.why ? { why: draft.why } : {}),
      dueAt: draft.dueAt ?? null,
      condition: draft.condition ?? null,
      validUntil: draft.validUntil ?? null,
      sourceMessageId: source?.sourceMessageId ?? null,
      routeId: source?.routeId ?? null,
      state: "open",
      createdAt: this.k.now(),
      updatedAt: this.k.now(),
      doneAt: null,
      dueNotifiedAt: null,
    };
    this.k.store.atomic(() => {
      this.k.store.put("notes", note.id, note);
      this.k.store.event(
        this.k.now(),
        threadId,
        note.boardQuestId,
        "note.recorded",
        note.text,
        { noteId: note.id },
        { kind: "agent", threadId },
      );
    });
    this.k.changed(threadId, note.boardQuestId);
    return note;
  }
  resolveByUser(id: string, how: "done" | "replied", reply?: string) {
    const note = this.k.store.get("notes", id);
    if (!note || note.kind !== "waiting-on-user") throw new Error("This hand-back does not exist.");
    if (note.state === "done") return { note, changed: false };
    const at = this.k.now();
    const done: KeeperNote = { ...note, state: "done", doneAt: at, updatedAt: at, resolution: { by: "user", how, at, ...(reply ? { reply } : {}) } };
    this.k.store.atomic(() => {
      this.k.store.put("notes", id, done);
      this.k.store.event(at, note.keeperThreadId, note.boardQuestId, "handback.resolved",
        `You ${how === "done" ? "marked" : "replied to"} '${note.action ?? note.text}'${how === "done" ? " done" : ""}`,
        { noteId: id, by: "user", how, ...(reply ? { reply } : {}) }, { kind: "user" });
    });
    this.k.changed(note.keeperThreadId, note.boardQuestId);
    return { note: done, changed: true };
  }
  complete(threadId: string, id: string) {
    this.k.require(threadId, "keeper");
    const note = this.k.store.get("notes", id);
    if (!note || note.keeperThreadId !== threadId)
      throw new Error("Only complete notes of your own Keeper");
    if (note.state === "done") return note;
    const done = {
      ...note,
      state: "done" as const,
      doneAt: this.k.now(),
      updatedAt: this.k.now(),
    };
    this.k.store.atomic(() => {
      this.k.store.put("notes", id, done);
      this.k.store.event(
        this.k.now(),
        threadId,
        note.boardQuestId,
        "note.completed",
        note.text,
        { noteId: id },
        { kind: "agent", threadId },
      );
    });
    this.k.changed(threadId, note.boardQuestId);
    return done;
  }
  closeQuest(threadId: string, questId: string) {
    const result = this.k.store.db
      .prepare(
        "UPDATE tavern_records SET data=json_set(data,\'$.state\',\'done\',\'$.doneAt\',?,\'$.updatedAt\',?) WHERE kind=\'notes\' AND json_extract(data,\'$.keeperThreadId\')=? AND json_extract(data,\'$.boardQuestId\')=? AND json_extract(data,\'$.state\')=\'open\' AND json_extract(data,\'$.kind\')<>\'fact\'",
      )
      .run(this.k.now(), this.k.now(), threadId, questId);
    if (result.changes)
      this.k.store.event(
        this.k.now(),
        threadId,
        questId,
        "note.closed-quest",
        `Closed ${result.changes} promises and hand-backs as the quest ended`,
        { count: result.changes },
        { kind: "agent", threadId },
      );
  }
  due(threadId: string) {
    const rows = this.k.store.db
      .prepare(
        `SELECT r.data FROM tavern_records r WHERE ${this.currentNoteWhere()}
      AND json_extract(r.data,'$.kind')='commitment' AND json_extract(r.data,'$.dueAt')<=? AND json_extract(r.data,'$.dueNotifiedAt') IS NULL LIMIT 100`,
      )
      .all(threadId, this.k.now(), this.k.now()) as { data: string }[];
    for (const row of rows)
      this.k.store.atomic(() => {
        const note = JSON.parse(row.data) as KeeperNote;
        this.k.store.put("notes", note.id, {
          ...note,
          dueNotifiedAt: this.k.now(),
        });
        this.k.store.event(
          this.k.now(),
          threadId,
          note.boardQuestId,
          "promise.due",
          `Promise due: ${note.text}`,
          { noteId: note.id, dueAt: note.dueAt },
        );
      });
    if (rows.length) this.k.changed(threadId);
  }
  gate(threadId: string, input: Parameters<typeof gateInputSchema.parse>[0]) {
    this.k.require(threadId, "keeper");
    const draft = gateInputSchema.parse(input);
    const q = this.k.liveQuest(threadId, draft.boardQuestId);
    this.k.guard(threadId, q.id);
    const waypoint = this.k.store
      .get("plans", `${q.id}:${q.planVersion}`)
      ?.waypoints.find((w) => w.id === draft.waypointId);
    if (!waypoint || waypoint.actor !== "outside")
      throw new Error(
        "Gate contact must name an outside waypoint in the current plan",
      );
    const previous = this.gateFor(q.id, q.planVersion, draft.waypointId);
    const askedAt = draft.askedAt ?? previous?.askedAt ?? this.k.now();
    const answer = draft.answer ?? previous?.answer ?? null;
    const answeredAt =
      draft.answeredAt ??
      (draft.answer ? this.k.now() : (previous?.answeredAt ?? null));
    if (
      askedAt > this.k.now() ||
      (answeredAt !== null &&
        (answeredAt < askedAt || answeredAt > this.k.now()))
    )
      throw new Error("Gate contact times must describe past contact in order");
    const gate: GateRecord = {
      ...draft,
      keeperThreadId: threadId,
      planVersion: q.planVersion,
      identity: this.gateIdentity(waypoint),
      askedAt,
      answer,
      answeredAt,
    };
    this.k.store.atomic(() => {
      this.k.store.put(
        "gates",
        `${q.id}:${draft.waypointId}:${gate.identity}`,
        gate,
      );
      this.k.store.event(
        this.k.now(),
        threadId,
        q.id,
        "gate.recorded",
        `Outside gate ${waypoint.title}: asked ${draft.askedWho} via ${draft.via}`,
        { ...gate },
        { kind: "agent", threadId },
      );
    });
    this.k.changed(threadId, q.id);
    return gate;
  }
  gateFor(questId: string, version: number, waypointId: string) {
    const waypoint = this.k.store
      .get("plans", `${questId}:${version}`)
      ?.waypoints.find((w) => w.id === waypointId);
    if (!waypoint || waypoint.actor !== "outside") return null;
    const identity = this.gateIdentity(waypoint);
    const current = this.k.store.get(
      "gates",
      `${questId}:${waypointId}:${identity}`,
    );
    if (current) return current;
    const legacy = this.k.store.db
      .prepare(
        `SELECT g.data FROM tavern_records g JOIN tavern_records p ON p.kind='plans' AND p.id=? || ':' || json_extract(g.data,'$.planVersion') JOIN json_each(p.data,'$.waypoints') w WHERE g.kind='gates' AND json_extract(g.data,'$.boardQuestId')=? AND json_extract(g.data,'$.waypointId')=? AND json_extract(w.value,'$.id')=? AND json_extract(w.value,'$.owner') IS ? AND json_extract(w.value,'$.title')=? AND json_extract(w.value,'$.doneWhen') IS ? ORDER BY g.rowid DESC LIMIT 1`,
      )
      .get(
        questId,
        questId,
        waypointId,
        waypointId,
        waypoint.owner,
        waypoint.title,
        waypoint.doneWhen,
      ) as { data: string } | undefined;
    return legacy ? (JSON.parse(legacy.data) as GateRecord) : null;
  }
  gates(threadId: string) {
    return this.k.store
      .visibleRecords("quests", threadId, 100)
      .flatMap((q) =>
        (
          this.k.store.get("plans", `${q.id}:${q.planVersion}`)?.waypoints ?? []
        ).flatMap((w) => {
          const gate = this.gateFor(q.id, q.planVersion, w.id);
          return gate ? [gate] : [];
        }),
      )
      .slice(0, 200);
  }
  unaskedGateEntries(threadId: string) {
    return this.k.store.visibleRecords("quests", threadId, 100).flatMap((q) => {
      if (q.greenlitVersion === null || !isOpenQuest(q))
        return [];
      const waypoints = this.k.summary(q.id).waypoints;
      return waypoints
        .filter(
          (w) =>
            w.actor === "outside" &&
            !w.gate &&
            !settled(w),
        )
        .map((w) => ({
          boardQuestId: q.id,
          key: `${q.id}:${w.id}:${this.gateIdentity(w)}`,
          ready: w.dependsOn.every((id) =>
            waypoints.some(
              (parent) =>
                parent.id === id &&
                settled(parent),
            ),
          ),
          text: `Outside gate ${w.title} not asked yet (lead time ${w.leadTime ?? "not stated"}); owner ${w.owner ?? "unassigned"}; ${q.id}/${w.id}`,
        }));
    });
  }
  unaskedGates(threadId: string) {
    return this.unaskedGateEntries(threadId).map((gate) => gate.text);
  }
  readyGateReminders(threadId: string) {
    return this.unaskedGateEntries(threadId)
      .filter(
        (gate) => gate.ready && !this.k.store.get("gateReminders", gate.key),
      )
      .map((gate) => gate.key);
  }
  private gateIdentity(waypoint: {
    owner: string | null;
    title: string;
    doneWhen: string | null;
  }) {
    return createHash("sha256")
      .update(
        JSON.stringify([waypoint.owner, waypoint.title, waypoint.doneWhen]),
      )
      .digest("hex");
  }
  rules(
    threadId: string,
    limit = 100,
    offset = 0,
    active?: boolean,
    boardQuestId?: string,
  ) {
    const projectId = this.k.store.runtime(threadId).projectId;
    const where = `r.kind=\'rules\' AND (${active === undefined ? "1" : "json_extract(r.data,\'$.active\')=?"}) AND (
      json_extract(r.data,\'$.scope\')=\'global\' OR (json_extract(r.data,\'$.scope\')=\'project\' AND json_extract(r.data,\'$.scopeId\')=?)
      OR (json_extract(r.data,\'$.scope\')=\'keeper\' AND json_extract(r.data,\'$.scopeId\')=?)
      OR (json_extract(r.data,\'$.scope\')=\'quest\' AND json_extract(r.data,\'$.scopeId\') IN
        (SELECT id FROM tavern_records WHERE kind=\'quests\' AND archived_at IS NULL AND json_extract(data,\'$.keeperThreadId\')=? ${boardQuestId ? "AND id=?" : ""})))`;
    const args = [
      ...(active === undefined ? [] : [Number(active)]),
      projectId,
      threadId,
      threadId,
      ...(boardQuestId ? [boardQuestId] : []),
    ];
    const rows = this.k.store.db
      .prepare(
        `SELECT r.data FROM tavern_records r WHERE ${where} ORDER BY json_extract(r.data,\'$.createdAt\') DESC,r.rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as { data: string }[];
    const total = (
      this.k.store.db
        .prepare(`SELECT count(*) AS n FROM tavern_records r WHERE ${where}`)
        .get(...args) as { n: number }
    ).n;
    return { rules: rows.map((row) => JSON.parse(row.data) as Rule), total };
  }
  steers(threadId: string, questId: string): Route[] {
    const rows = this.k.store.db
      .prepare(
        `SELECT r.data FROM tavern_records r WHERE r.kind=\'routes\' AND json_extract(r.data,\'$.keeperThreadId\')=?
      AND json_extract(r.data,\'$.kind\')=\'steer\' AND (json_extract(r.data,\'$.boardQuestId\')=? OR EXISTS(SELECT 1 FROM json_each(r.data,\'$.boardQuestIds\') WHERE value=?)) ORDER BY r.rowid DESC LIMIT 3`,
      )
      .all(threadId, questId, questId) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as Route);
  }
  userWords(route: Route) {
    if (route.userText !== undefined) return route.userText;
    if (route.sourceMessageId)
      return (
        this.k.store.messageText(route.sourceMessageId) ?? route.summary
      ).slice(0, 200);
    const messages = this.k.store.db
      .prepare(
        "SELECT text FROM tavern_messages WHERE thread_id=? AND at=? ORDER BY rowid LIMIT 20",
      )
      .all(route.keeperThreadId, route.messageAt) as { text: string }[];
    return (
      messages.find((row) => messageKey(row.text) === route.messageKey)?.text ??
      route.summary
    ).slice(0, 200);
  }

  snapshot(threadId: string, text: string) {
    const hash = createHash("sha256").update(text).digest("hex");
    const previous = this.k.store.runtime(threadId).ledger;
    const ledger =
      previous?.hash === hash
        ? previous
        : { hash, version: (previous?.version ?? 0) + 1, asOf: this.k.now() };
    if (ledger !== previous) this.k.store.patch(threadId, { ledger });
    return { ...ledger, text };
  }
}
