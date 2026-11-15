import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { evaluate, blocked, toolAllowed } from "../../src/scope/engine";
import { scopeFileSchema, scopeRenderedFileSchema, type Scope } from "../../src/scope/schema";
import { armScope, type NativeScopeReceipt } from "../../src/scope/store";
import { prepareCall } from "../../src/scope/prepare";
import { realPath } from "../../src/scope/paths";
import { sandboxCommand } from "../../src/scope/sandbox";
import { bindChecks } from "../../src/scope/checker";
import { bindWorktree, gitWorktreeRoot, needsWorktree } from "../../src/scope/worktree";

// Structural API keeps the installed shim independent of a second copy of pi.
interface PiContext { cwd: string }
interface PiEvent { toolName?: string; toolCallId?: string; input?: Record<string, unknown>; content?: unknown[]; structuredContent?: unknown }
export interface PiGuardApi {
  on(name: "session_start" | "before_agent_start" | "tool_call" | "tool_result", handler: (event: PiEvent, ctx: PiContext) => unknown): unknown;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}
export default function tavernGuard(pi: PiGuardApi): void {
  const file = process.env.TAVERN_SCOPE_FILE;
  if (!file) return;
  const emergency = ["tavern_report", "journal", "quest", "tavern_ready"];
  let worktree: string | undefined;
  let worktreeKind: Scope["workspaceKind"];
  let nativeReceipt: NativeScopeReceipt | undefined;
  const enforcementNotes = new Set<string>();
  const modeNote = "[Tavern scope] Enforcement enabled; this call and subsequent calls use the current scope. Earlier calls made while off were not enforced.";
  let mode: Scope["mode"] = process.env.TAVERN_SCOPE_MODE === "off" ? "off" : process.env.TAVERN_SCOPE_MODE === "watch" ? "watch" : "enforce";
  const load = (): Scope => {
    nativeReceipt = undefined;
    const json = readFileSync(file, "utf8"), raw = JSON.parse(json);
    if (["enforce", "watch", "off"].includes(raw?.mode)) mode = raw.mode;
    let scope: Scope;
    if (raw?.hostBinding !== undefined) {
      const { bindingTemplate: _template, hostBinding, ...bound } = scopeRenderedFileSchema.parse(raw);
      scope = bound; nativeReceipt = { hostBinding, renderedDigest: createHash("sha256").update(json, "utf8").digest("hex") };
    } else {
      const { bindingTemplate: _template, bindingError, controllerBinding, ...bound } = scopeFileSchema.parse(raw);
      if (controllerBinding) throw new Error("This host-bound controller template is not an acknowledged native scope");
      if (bindingError) throw new Error(bindingError);
      scope = bound;
    }
    mode = scope.mode;
    if (process.env.BB_THREAD_ID && scope.threadId !== process.env.BB_THREAD_ID) throw new Error("Scope belongs to another thread");
    if (mode === "off") return scope;
    if (needsWorktree(scope) || scope.writes.mode === "worktree") {
      if (worktreeKind !== scope.workspaceKind) { worktree = undefined; worktreeKind = scope.workspaceKind; }
      worktree ??= gitWorktreeRoot(undefined, scope.workspaceKind);
      if (!needsWorktree(scope) && realPath(scope.expectedWorktree ?? scope.writes.allow[0]) !== worktree) throw new Error("Scope root differs from the provisioned linked worktree");
      scope = bindWorktree(scope, worktree);
    }
    scope = bindChecks(scope);
    if ([...scope.writes.allow, ...scope.writes.deny].some(path => path.includes("${"))) throw new Error("Unbound scope paths");
    return scope;
  };
  const hidden = new Set<string>();
  const hide = (scope: Scope | null) => {
    const current = pi.getActiveTools();
    const candidates = [...new Set([...current, ...hidden])];
    const active = candidates.filter(name => mode !== "enforce" || (scope ? !scope.tools.hide || toolAllowed(scope, name) : emergency.includes(name)));
    hidden.clear();
    for (const name of candidates) if (!active.includes(name)) hidden.add(name);
    if (current.join("\0") !== active.join("\0")) pi.setActiveTools(active);
  };
  const refresh = () => {
    let scope: Scope;
    try { scope = load(); } catch { hide(null); return; }
    hide(scope);
    armScope(file, scope, nativeReceipt);
  };
  pi.on("session_start", () => { worktree = undefined; refresh(); });
  pi.on("before_agent_start", refresh);
  pi.on("tool_call", (event, ctx) => {
    const name = event.toolName ?? "unknown";
    const previousMode = mode;
    let scope: Scope;
    try { scope = load(); } catch (error) {
      if (mode !== "enforce" || emergency.includes(name)) return;
      const decision = blocked("tool " + name, "scope-invalid", "the scope file is missing, invalid or its worktree cannot be resolved: " + String(error) + "; ask the Keeper to repair it");
      return { block: true, reason: !decision.allow ? decision.reason : "" };
    }
    if (mode !== "enforce") return;
    const switched = previousMode === "off";
    try {
      armScope(file, scope, nativeReceipt);
      const call = prepareCall({ kind: "tool", toolName: name, input: event.input ?? {}, cwd: ctx.cwd }, { scope });
      const decision = evaluate(scope, call);
      if (!decision.allow) return { block: true, reason: decision.reason + (switched ? "\n" + modeNote : "") };
      if (switched) enforcementNotes.add(event.toolCallId ?? name);
      if (name.toLowerCase() === "bash" && typeof event.input?.command === "string") event.input.command = sandboxCommand(scope, event.input.command, decision.check === true);
    } catch (error) {
      if (emergency.includes(name)) return;
      const decision = blocked("tool " + name, "guard-error", "the guard could not safely check this call: " + String(error));
      return { block: true, reason: !decision.allow ? decision.reason : "" };
    }
  });
  pi.on("tool_result", event => {
    if (!enforcementNotes.delete(event.toolCallId ?? event.toolName ?? "unknown")) return;
    return { content: [...event.content ?? [], { type: "text", text: modeNote }], ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }) };
  });
}
