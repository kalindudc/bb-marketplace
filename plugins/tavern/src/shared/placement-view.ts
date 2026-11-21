import { z } from "zod";
import type { ExecutionPosture } from "./placement";

export const POSTURE = {
  remote: "Detection only (remote)",
  linuxPi: "pre-exec checks only, no containment",
  linuxNoPi: "detection only, no containment",
  localPi: "Pi pre-exec guard and watcher",
} as const;

export type PlacementWhere =
  | { kind: "keeper"; label: string }
  | { kind: "pending"; label: string }
  | { kind: "host"; hostId: string; label: string };

export interface PlacementView {
  placementId: string;
  generation: number;
  where: PlacementWhere;
  rule: { id: string; label: string } | null;
  phase: string;
  hold: { kind: "maker-slot" | "checker-slot" | "transfer-slots" | "maker-busy"; message: string } | null;
  blocker: { stage: string; message: string; retryable: boolean } | null;
  posture: { label: string; detail: string | null };
  source: { includesUncommitted: boolean; from: string } | null;
  preservation: string;
  preservationReason: string | null;
}

export const placementViewSchema: z.ZodType<PlacementView> = z.object({
  placementId: z.string(), generation: z.number().int().positive(),
  where: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("keeper"), label: z.string() }),
    z.object({ kind: z.literal("pending"), label: z.string() }),
    z.object({ kind: z.literal("host"), hostId: z.string(), label: z.string() }),
  ]),
  rule: z.object({ id: z.string(), label: z.string() }).nullable(), phase: z.string(),
  hold: z.object({ kind: z.enum(["maker-slot", "checker-slot", "transfer-slots", "maker-busy"]), message: z.string() }).nullable(),
  blocker: z.object({ stage: z.string(), message: z.string(), retryable: z.boolean() }).nullable(),
  posture: z.object({ label: z.string(), detail: z.string().nullable() }),
  source: z.object({ includesUncommitted: z.boolean(), from: z.string() }).nullable(),
  preservation: z.string(), preservationReason: z.string().nullable(),
});

export function postureText(posture: ExecutionPosture): PlacementView["posture"] {
  const label = posture.aggregate === "remote-detection-only" ? POSTURE.remote
    : posture.aggregate === "local-pre-exec" ? POSTURE.localPi : "Detection only (local)";
  const cluster = posture.clusterWrites === false ? (posture.guard === "prepared" ? "Restart needed: cluster writes not prevented." : "Cluster writes not prevented.") : null;
  const check = ["pre-exec-no-containment", "detection-only-no-containment"].includes(posture.checker)
    ? posture.toolGate === "pi-observed" ? POSTURE.linuxPi : POSTURE.linuxNoPi : null;
  return { label, detail: [check, cluster].filter(Boolean).join(" ") || null };
}

export function placementLine(view: PlacementView, matchFacts?: string): string {
  const rule = view.rule ? `, rule ${JSON.stringify(view.rule.label)} (${view.rule.id})` : "";
  const posture = `${view.posture.label}${view.posture.detail ? `; ${view.posture.detail}` : ""}`;
  const blocked = view.hold ? ` ${view.hold.message}.` : view.blocker ? ` Blocked at ${view.blocker.stage}: ${view.blocker.message}` : "";
  const source = view.source?.includesUncommitted ? ` Includes uncommitted changes from ${view.source.from}.` : "";
  return `${view.where.label}${rule}${matchFacts ? `; matched ${matchFacts}` : ""}; setup ${view.phase}; ${posture}.${blocked}${source}`;
}
