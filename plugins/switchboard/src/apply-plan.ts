import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { CoreWrite, DropPlan, TreeIndex } from "./drop-plan";
import type { LayoutApi } from "./use-layout";

export interface ApplyDeps {
  sdk: { threads: Pick<PluginBrowserBbSdk["threads"], "update" | "pin" | "unpin" | "reorderPinned"> };
  layout: Pick<LayoutApi, "setOrder" | "setCollapsed" | "refetch">;
  index: TreeIndex;
  announce(message: string): void;
  onApplied?(): void;
}

const failureMessage = (cause: unknown): string =>
  cause instanceof Error && cause.message ? cause.message : "Switchboard could not move that thread";

async function writeCore(write: CoreWrite, sdk: ApplyDeps["sdk"]): Promise<void> {
  switch (write.kind) {
    case "update": {
      const { kind: _kind, ...input } = write;
      await sdk.threads.update(input);
      break;
    }
    case "pin": await sdk.threads.pin({ threadId: write.threadId }); break;
    case "unpin": await sdk.threads.unpin({ threadId: write.threadId }); break;
    case "reorderPinned": {
      const { kind: _kind, ...input } = write;
      await sdk.threads.reorderPinned(input);
      break;
    }
  }
}

export async function applyPlan(plan: Extract<DropPlan, { ok: true }>, deps: ApplyDeps): Promise<void> {
  const oldOrders = plan.orders.map(({ container }) => ({ container, ids: deps.index.containers.get(container) ?? [] }));
  const previousPinned = deps.index.containers.get("pinned") ?? [];
  const inverse: CoreWrite[] = [];
  for (const move of plan.moves) {
    const old = deps.index.byId.get(move.threadId);
    if (!old) continue;
    const update = plan.writes.find((write) => write.kind === "update" && write.threadId === move.threadId);
    if (update?.kind === "update") {
      const restore: Extract<CoreWrite, { kind: "update" }> = { kind: "update", threadId: move.threadId };
      if ("parentThreadId" in update) restore.parentThreadId = old.parentId;
      if ("sectionId" in update) restore.sectionId = old.node.thread.sectionId;
      inverse.push(restore);
    }
    if (plan.writes.some((write) => write.kind === "pin" && write.threadId === move.threadId))
      inverse.push({ kind: "unpin", threadId: move.threadId });
    if (plan.writes.some((write) => write.kind === "unpin" && write.threadId === move.threadId))
      inverse.push({ kind: "pin", threadId: move.threadId });
    if (old.node.thread.isPinned && plan.writes.some((write) => write.kind === "reorderPinned" && write.threadId === move.threadId)) {
      const position = previousPinned.indexOf(move.threadId);
      inverse.push({ kind: "reorderPinned", threadId: move.threadId,
        previousThreadId: previousPinned[position - 1] ?? null, nextThreadId: previousPinned[position + 1] ?? null });
    }
  }
  const run = async (writes: readonly CoreWrite[]): Promise<void> => {
    for (const write of writes.filter((entry) => entry.kind === "update")) await writeCore(write, deps.sdk);
    for (const write of writes.filter((entry) => entry.kind === "unpin")) await writeCore(write, deps.sdk);
    for (const write of writes.filter((entry) => entry.kind === "pin")) await writeCore(write, deps.sdk);
    for (const write of writes.filter((entry) => entry.kind === "reorderPinned")) await writeCore(write, deps.sdk);
  };
  for (const key of plan.expand) deps.layout.setCollapsed(key, false);
  for (const { container, ids } of plan.orders) deps.layout.setOrder(container, ids);
  try {
    await run(plan.writes);
  } catch (cause) {
    toast.error(failureMessage(cause));
    deps.layout.refetch();
    return;
  }
  deps.onApplied?.();
  let undone = false;
  const onClick = () => {
    if (undone) return;
    undone = true;
    void (async () => {
      for (const { container, ids } of oldOrders) deps.layout.setOrder(container, ids);
      await run(inverse);
      deps.announce("Move undone");
    })().catch((cause: unknown) => {
      toast.error(failureMessage(cause));
      deps.layout.refetch();
    });
  };
  toast(plan.summary, {
    description: plan.moves.some((move) => move.fromParent !== move.toParent) ?
      "bb tells the parent's agent about this in 2 seconds. Undo before then and nothing is sent." : undefined,
    action: { label: "Undo", onClick },
  });
  deps.announce(plan.summary);
}
