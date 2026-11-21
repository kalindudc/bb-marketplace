import type { Ask } from "../shared/schema";

export const ACT_KINDS = ["merge", "publish", "ready", "close", "review", "deploy", "cluster-write", "send", "draft", "delete", "configure", "credential", "tavern-control", "allocate"] as const;
export type ActKind = typeof ACT_KINDS[number];

const actAsks: Partial<Record<ActKind, Ask["kind"]>> = {
  merge: "merge",
  publish: "decision",
  deploy: "production",
  "cluster-write": "cluster-write",
  send: "sends-as-you",
  draft: "drafts-as-you",
  delete: "destructive",
  configure: "decision",
  credential: "credential",
};

export const actAskKind = (act: ActKind): Ask["kind"] | undefined => actAsks[act];

export function watchActWords(observations: readonly { mode?: string; act?: ActKind }[]) {
  const counts = new Map<ActKind, number>();
  for (const { mode, act } of observations) if (mode === "watch" && act) counts.set(act, (counts.get(act) ?? 0) + 1);
  if (!counts.size) return null;
  return "would have needed a grant: " + [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([act, count]) => {
    const label = act === "configure" ? "configuration change" : act === "delete" ? "deletion" : act;
    return `${count} ${label}${count === 1 ? "" : act === "publish" ? "es" : "s"}`;
  }).join(", ");
}
