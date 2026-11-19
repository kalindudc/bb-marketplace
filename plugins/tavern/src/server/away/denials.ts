import { createHash } from "node:crypto";
import type { registerScopes } from "../../scope";
import type { Member } from "../../shared/schema";
import type { Scope, ShellRule } from "../../scope/schema";
import { awaySelectionRule } from "../../scope/away-policy";
import { AWAY_STOP_LABELS, AWAY_STOP_LIST, windowStopKinds, type AwayStopKind, type AwayWindow } from "../../shared/away";

const toolKinds: Record<string, AwayStopKind> = {
  "*merge*": "merge", "*deploy*": "deploy", "*delete*": "delete", "*remove*": "delete",
  "*send*": "sends-as-you", "*post*": "other-writes",
  "*publish*": "other-writes", "*push*": "other-writes", "*create*": "other-writes", "*update*": "other-writes", "*_*write*": "other-writes", apply_patch: "other-writes",
};
const ruleKinds: Record<string, AwayStopKind> = {
  merge: "merge", push: "other-writes", github: "other-writes", deploy: "deploy", cluster: "production",
  send: "sends-as-you", "http-write": "other-writes", delete: "delete", "find-delete": "delete", "git-delete": "delete",
};
const policyKey = (window: AwayWindow) => createHash("sha256").update(JSON.stringify([window.id, window.version])).digest("hex");
const selected = windowStopKinds;
const tools = (window: AwayWindow) => Object.keys(toolKinds).filter(tool => selected(window).includes(toolKinds[tool]!));
function rules(window: AwayWindow): ShellRule[] {
  const prefix = `away:${policyKey(window)}:`;
  const why = "Closing time: merges, deployments, production work, sends-as-you and deletion wait for your return";
  const all: ShellRule[] = [
    { id: prefix + "merge", argv: ["git", "merge"], why },
    { id: prefix + "push", argv: ["git", "push"], why },
    { id: prefix + "github", regex: "\\bgh\\b[\\s\\S]*\\b(create|edit|merge|close|reopen|delete|comment|upload|publish|ready|review|dispatch)\\b", why },
    { id: prefix + "deploy", regex: "\\b((dev|dt|kapp|fly|vercel|netlify|wrangler)\\s+(deploy|publish)|terraform\\s+(apply|destroy|import)|helm\\s+(install|upgrade|uninstall))\\b", why },
    { id: prefix + "cluster", regex: "\\bkubectl\\b[\\s\\S]*\\b(apply|create|replace|patch|edit|delete|scale|annotate|label|set|cordon|uncordon|drain|taint|exec|cp)\\b", why },
    { id: prefix + "send", regex: "\\b(slack|hermes|gog)\\b[\\s\\S]*\\b(send|post|publish|create|update|delete)\\b|\\b(mail|sendmail)\\b", why },
    { id: prefix + "http-write", regex: "\\b(curl|wget)\\b[\\s\\S]*(--data|--json|--form|--upload-file|--post|--body|\\s-[dFT]|-X\\s*(POST|PUT|PATCH|DELETE)|--request[=\\s]+(POST|PUT|PATCH|DELETE))", why },
    { id: prefix + "delete", argv: [["rm", "rmdir", "unlink"]], why },
    { id: prefix + "find-delete", regex: "\\bfind\\b[\\s\\S]*\\s-delete\\b", why },
    { id: prefix + "git-delete", regex: "\\bgit\\b[\\s\\S]*\\b(clean|rm)\\b", why },
  ];
  const items = selected(window);
  if (items.length === AWAY_STOP_LIST.length) return all;
  if (!items.length) return [];
  const subset = all.flatMap(rule => {
    const suffix = rule.id.slice(prefix.length);
    const kind = ruleKinds[suffix]!;
    if (!items.includes(kind) || suffix === "push") return [];
    const regex = suffix === "github" ? "\\bgh\\b(?![^;\\n]*\\bpr\\s+merge\\b)[\\s\\S]*\\b(create|edit|close|reopen|delete|comment|upload|publish|ready|review|dispatch)\\b" : rule.regex;
    return [{ ...rule, ...(regex ? { regex } : {}), why: `Closing time: ${AWAY_STOP_LABELS[kind]} waits for your return` }];
  });
  if (items.includes("merge")) subset.push({ id: prefix + "github-merge", regex: "\\bgh\\b[^;\\n]*\\bpr\\s+merge\\b", why: "Closing time: merge waits for your return" });
  return [...subset, awaySelectionRule(policyKey(window), items)];
}
export function narrowAwayScope(scope: Scope, window: AwayWindow | null): Scope {
  if (window === null || window.returnedAt !== null || !window.stopList.length) return scope;
  return { ...scope, tools: { ...scope.tools, deny: [...scope.tools.deny, ...tools(window)] }, shell: { ...scope.shell, deny: [...scope.shell.deny, ...rules(window)] } };
}
export function localAwayPrevention(status: ReturnType<ReturnType<typeof registerScopes>["status"]> | null, member: Member | null, window: AwayWindow | null): boolean {
  if (!status || status.mode !== "enforce" || !status.guard.installed || status.guard.stale || member?.guardPosture?.providerId !== "pi" || member.guardPosture.mode !== "pre-exec") return false;
  const row = status.threads.find(row => row.threadId === member.threadId);
  if (!row?.scope || row.error || row.binding !== undefined || row.hostScope !== undefined || row.scope.mode !== "enforce" || row.scope.preset === "open") return false;
  return window === null || window.returnedAt !== null || hasAwayDenials(row.scope, window);
}
export function hasAwayDenials(scope: Scope, window: AwayWindow): boolean {
  const required = rules(window);
  const installed = scope.shell.deny.filter(rule => rule.id.startsWith("away:"));
  return installed.length === required.length &&
    tools(window).every(tool => scope.tools.deny.includes(tool)) && required.every(rule =>
      installed.some(actual => JSON.stringify(actual) === JSON.stringify(rule)) && !scope.shell.allow.some(grant => grant.id === rule.id));
}
