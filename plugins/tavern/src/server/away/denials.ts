import { createHash } from "node:crypto";
import type { registerScopes } from "../../scope";
import type { Member } from "../../shared/schema";
import type { Scope, ShellRule } from "../../scope/schema";
import type { AwayWindow } from "../../shared/away";

const tools = ["*merge*", "*deploy*", "*delete*", "*remove*", "*send*", "*post*", "*publish*", "*push*", "*create*", "*update*", "*_*write*", "apply_patch"];
function rules(window: AwayWindow): ShellRule[] {
  const prefix = `away:${createHash("sha256").update(JSON.stringify([window.id, window.version])).digest("hex")}:`;
  const why = "Closing time: merges, deployments, production work, sends-as-you and deletion wait for your return";
  return [
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
}
export function narrowAwayScope(scope: Scope, window: AwayWindow | null): Scope {
  if (window === null || window.returnedAt !== null) return scope;
  return { ...scope, tools: { ...scope.tools, deny: [...scope.tools.deny, ...tools] }, shell: { ...scope.shell, deny: [...scope.shell.deny, ...rules(window)] } };
}
export function localAwayPrevention(status: ReturnType<ReturnType<typeof registerScopes>["status"]> | null, member: Member | null, window: AwayWindow | null): boolean {
  if (!status || status.mode !== "enforce" || !status.guard.installed || status.guard.stale || member?.guardPosture?.providerId !== "pi" || member.guardPosture.mode !== "pre-exec") return false;
  const row = status.threads.find(row => row.threadId === member.threadId);
  if (!row?.scope || row.error || row.binding !== undefined || row.hostScope !== undefined || row.scope.mode !== "enforce" || row.scope.preset === "open") return false;
  return window === null || window.returnedAt !== null || hasAwayDenials(row.scope, window);
}
export function hasAwayDenials(scope: Scope, window: AwayWindow): boolean {
  const required = rules(window);
  return tools.every(tool => scope.tools.deny.includes(tool)) && required.every(rule =>
    scope.shell.deny.some(actual => JSON.stringify(actual) === JSON.stringify(rule)) && !scope.shell.allow.some(grant => grant.id === rule.id));
}
