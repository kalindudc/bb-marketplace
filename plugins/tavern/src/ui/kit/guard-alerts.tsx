import { experimental_useRpcMutation, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import { memberScopeSchema, rpcContract, type ThreadDecor } from "../../shared/contract";
import { revealAsk } from "../thread/state";
import { WORKTREE_UNBOUND } from "../../shared/text";
import { AlertAction } from "./alert-action";

type Scope = z.infer<typeof memberScopeSchema>;

export function guardAlerts(scope: Scope) {
  const alerts: { kind: "worktree" | "policy" | "repair" | "ask" | "guard"; text: string; askId?: string; error?: boolean }[] = [];
  if (scope.live === false) return alerts;
  if (scope.problems?.includes(WORKTREE_UNBOUND) && !scope.scope?.expectedWorktree)
    alerts.push({ kind: "worktree", text: WORKTREE_UNBOUND });
  const problems = [scope.error, ...scope.problems?.filter(problem => problem !== WORKTREE_UNBOUND) ?? []].filter(Boolean);
  if (problems.length) alerts.push({ kind: "policy", text: problems.join(" "), error: !!scope.error });
  if (scope.pendingAskId) alerts.push({ kind: "ask", text: "A widening waits on your answer.", askId: scope.pendingAskId });
  if (scope.guardCheckFailed)
    alerts.push({ kind: "repair", text: "The guard is not armed yet.", askId: scope.repairAskId });
  else if (scope.restartNeeded || scope.armed && [scope.clusterGuard, scope.sendGuard].some(state => state === "restart" || state === "not-prevented"))
    alerts.push({ kind: "guard", text: scope.restartNeeded ?? "The guarded actions listed above are not all prevented." });
  return alerts;
}

export function scopeAlerts({ scope, violations, memberAsks }: Pick<ThreadDecor, "scope" | "violations" | "memberAsks">) {
  const visible = scope ? guardAlerts(scope).filter(alert => !alert.askId || !memberAsks?.some(ask => ask.id === alert.askId)).length : 0;
  return visible + (violations?.filter(violation => violation.mode !== "watch").length ?? 0);
}

export function GuardAlerts({ scope, name, keeperThreadId, recheck, local = false }: {
  scope: Scope; name: string; keeperThreadId: string | null; recheck?: () => unknown; local?: boolean;
}) {
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const show = experimental_useRpcMutation({ contract: rpcContract, method: "setHidden" });
  return guardAlerts(scope).map(alert => {
    const opener = keeperThreadId ?? scope.threadId;
    const openAsk = async () => {
      await show.mutate({ threadId: local ? scope.threadId : opener, hidden: false });
      revealAsk(local ? scope.threadId : opener, alert.askId!);
      if (!local) navigate.toThread(opener);
    };
    const tell = (text: string) => keeperThreadId
      ? { kind: "tell" as const, keeperThreadId, text }
      : { kind: "run" as const, label: "Open thread", run: () => navigate.toThread(scope.threadId) };
    const action = alert.askId ? { kind: "run" as const, label: "Review the ask", run: openAsk }
      : alert.kind === "repair" ? { kind: "check" as const, text: `Restart ${name}’s session, then select Done to check the guard. Do not rerun the blocked call.`, run: recheck ?? (async () => {
          const current = await rpc.call("decor", { threadId: scope.threadId });
          if (current.scope?.guardCheckFailed) throw new Error("The guard is still not armed.");
        }) }
      : alert.kind === "worktree" ? tell(`Bind ${name}’s worktree and re-arm the guard. Check that the thread has a linked worktree first.`)
      : tell(`Review ${name}’s guardrails and fix the reported protection problem before resuming the affected work.`);
    return <span className="tv-guard-alert" key={alert.kind} data-guard-alert={alert.kind}>
      <span className="tv-alert-msg" role={alert.error ? "alert" : undefined}>{alert.text}</span>
      <AlertAction action={action} />
    </span>;
  });
}
