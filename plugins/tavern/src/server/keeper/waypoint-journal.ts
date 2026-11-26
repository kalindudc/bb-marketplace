import type { JournalEntry, Waypoint } from "../../shared/schema";
import type { WaypointReceipt } from "../ports";
import { waypointCheck } from "../../shared/waypoint";

export function blockingNoteLine(note: string | null | undefined) {
  const lines = note?.split("\n").map(line => line.trim().replace(/^\d\d:\d\d\s+/, "")).filter(Boolean).reverse() ?? [];
  const prefix = "Blocked: ";
  return lines.find(line => line.startsWith(prefix))?.slice(prefix.length).trim() ?? lines[0] ?? null;
}

export function waypointProof(waypoint: Waypoint, entry: JournalEntry, acceptance?: JournalEntry) {
  const { review, status } = entry;
  if (status !== "done" && status !== "verified") return null;
  if (review?.kind === "waiver" && review.actor.kind === "user") return "waiver";
  if (review?.kind === "skip" && waypoint.optional) return "skip";
  const check = waypointCheck(waypoint);
  if (check === "you") return entry.doneBy?.kind === "user" ? "done" : null;
  if (!entry.evidence.length) return null;
  if (check === "none") return "done";
  if (check === "keeper") {
    if (review?.kind === "keeper" || review?.kind === "keeper-waypoint") return "accepted";
    if (acceptance?.review && (entry.doneAt ?? entry.createdAt) <= acceptance.review.at &&
      entry.evidence.every(item => acceptance.evidence.some(saved => JSON.stringify(saved) === JSON.stringify(item)))) return "accepted";
  }
  if (check === "warden" && status === "verified" && !review?.kind) return "verified";
  return null;
}

export function stampWaypoint(entry: JournalEntry, { kind, at, actor, ref, reason, evidence }: WaypointReceipt) {
  if (kind === "reopen" || kind === "invalidate") {
    if (entry.review?.kind === "skip" || entry.review?.kind === "answer" || entry.review?.kind === "outside" || entry.review?.kind === "keeper-waypoint") {
      entry.status = "todo"; entry.doneAt = null; entry.doneBy = null;
    }
    if (entry.review?.kind) entry.review = null;
  } else {
    if (kind === "keeper" && (!(entry.status === "done" || entry.status === "verified") || !entry.evidence.length))
      throw new Error("A Keeper check needs a submitted journal entry with evidence.");
    const writesEvidence = kind === "answer" || kind === "outside" || kind === "keeper-waypoint";
    entry.review = { kind, at, actor, ref, reason, evidence: writesEvidence ? [] : evidence ?? [], previousNote: entry.note, memberEvidenceAt: null };
    if (writesEvidence) {
      const merged = [...entry.evidence, ...(evidence ?? [])];
      entry.evidence = merged.filter((item, i) => merged.findIndex(other => JSON.stringify(other) === JSON.stringify(item)) === i);
      entry.status = "done"; entry.doneAt = at; entry.doneBy = actor;
    } else {
      if (entry.status !== "done" && entry.status !== "verified") { entry.doneAt = at; entry.doneBy = actor; }
      entry.status = "done";
    }
  }
  entry.updatedAt = at; entry.updatedBy = actor; entry.report = null;
}
