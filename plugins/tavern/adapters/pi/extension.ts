import { readFileSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { authorityDecision, evaluate, blocked, toolAllowed } from "../../src/scope/engine";
import { scopeFileSchema, scopeRenderedFileSchema, type Scope } from "../../src/scope/schema";
import { armedFile, armScope, type NativeScopeReceipt } from "../../src/scope/store";
import { prepareCall } from "../../src/scope/prepare";
import { claimPullRequestGrant, pullRequestGrantAvailable, pullRequestReceiptLine } from "../../src/scope/pr-grants";
import { armShellGrantCapability, claimShellGrant, oldScopeEnvironment, readShellGrants } from "../../src/scope/shell-grants";
import { realPath } from "../../src/scope/paths";
import { sandboxCommand } from "../../src/scope/sandbox";
import { bindChecks } from "../../src/scope/checker";
import { bindWorktree, gitWorktreeRoot, needsWorktree, readerFallback } from "../../src/scope/worktree";

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
  const containmentNotes = new Map<string, string>();
  const pullRequestReceipts = new Map<string, string>();
  const shellReceipts = new Map<string, string>();
  let localArm: { issuedAt: number; at: number } | undefined;
  const legacyEnv = oldScopeEnvironment(process.env);
  const arm = (scope: Scope) => {
    if (nativeReceipt) return armScope(file, scope, nativeReceipt);
    if (localArm?.issuedAt !== scope.issuedAt) {
      const at = Date.now();
      armShellGrantCapability(file, scope, at, legacyEnv);
      localArm = { issuedAt: scope.issuedAt, at };
    }
    armScope(file, scope, undefined, localArm.at);
  };
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
      const { bindingTemplate: _template, bindingError, controllerBinding, presetProvenance: _provenance, ...bound } = scopeFileSchema.parse(raw);
      if (controllerBinding) throw new Error("This host-bound controller template is not an acknowledged native scope");
      if (bindingError) throw new Error(bindingError);
      scope = bound;
    }
    mode = scope.mode;
    if (process.env.BB_THREAD_ID && scope.threadId !== process.env.BB_THREAD_ID) throw new Error("Scope belongs to another thread");
    if (mode === "off") return scope;
    if (needsWorktree(scope) || scope.writes.mode === "worktree") {
      if (worktreeKind !== scope.workspaceKind) { worktree = undefined; worktreeKind = scope.workspaceKind; }
      try { worktree ??= gitWorktreeRoot(undefined, scope.workspaceKind); }
      catch (error) { if (!nativeReceipt && needsWorktree(scope)) scope = readerFallback(scope); else throw error; }
      if (worktree && !needsWorktree(scope) && scope.preset === "worktree" && realPath(scope.expectedWorktree ?? scope.writes.allow[0]) !== worktree) throw new Error("Scope root differs from the provisioned linked worktree");
      if (worktree) scope = bindWorktree(scope, worktree);
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
    try { scope = load(); } catch { rmSync(armedFile(file), { force: true }); hide(null); return; }
    hide(scope);
    arm(scope);
  };
  pi.on("session_start", () => { worktree = undefined; localArm = undefined; refresh(); });
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
    const authority = authorityDecision(scope, { kind: "tool", toolName: name, input: event.input ?? {}, cwd: ctx.cwd });
    if (authority && !authority.allow) return { block: true, reason: authority.reason };
    if (mode !== "enforce") return;
    const switched = previousMode === "off";
    try {
      arm(scope);
      const contained = !nativeReceipt && process.platform === "darwin" && scope.sandbox && ["bash", "Bash"].includes(name);
      const call = prepareCall({ kind: "tool", toolName: name, input: event.input ?? {}, cwd: ctx.cwd, containment: contained ? "sandbox" : undefined }, { scope });
      const shellGrants = !nativeReceipt && !legacyEnv.length && event.toolCallId && ["bash", "Bash"].includes(name) ? readShellGrants(file, scope) : undefined;
      const decision = evaluate(scope, { ...call, shellGrants, prGrantAvailable: id => !!event.toolCallId && pullRequestGrantAvailable(file, id) });
      if (!decision.allow) return { block: true, reason: decision.reason +
        (decision.act ? "\nWorking directory: " + JSON.stringify(ctx.cwd) : "") + (switched ? "\n" + modeNote : "") };
      if (decision.prGrant) {
        const receipt = randomUUID();
        if (!claimPullRequestGrant(file, decision.prGrant, receipt))
          return { block: true, reason: "[Tavern scope blocked] This pull request exception was already used." };
        pullRequestReceipts.set(event.toolCallId!, receipt);
      }
      const source = name.toLowerCase() === "bash" && typeof event.input?.command === "string" ? event.input.command : undefined;
      const wrapped = source === undefined ? undefined : sandboxCommand(scope, source, decision.check === true, call.fetchWriteRoots);
      if (decision.shellGrant) {
        const receipt = randomUUID();
        if (source === undefined || wrapped === undefined || !claimShellGrant(file, scope, decision.shellGrant, receipt, [source, wrapped])) return { block: true, reason: "[Tavern scope blocked] This shell grant has ended or was already used. Nothing was done." };
        shellReceipts.set(event.toolCallId!, `Tavern shell grant receipt: ${decision.shellGrant} ${receipt}`);
      }
      if (switched) enforcementNotes.add(event.toolCallId ?? name);
      if (event.input && wrapped !== undefined) event.input.command = wrapped;
      if (!nativeReceipt && process.platform === "darwin" && scope.sandbox && name.toLowerCase() === "bash") containmentNotes.set(event.toolCallId ?? name, `Tavern: a ${scope.preset === "worktree" ? "Smith writes only to its worktree, " : scope.preset === "checker" ? "Warden writes only to " : "Ranger writes only to "}$BB_THREAD_STORAGE and temp. Save there instead.`);
    } catch (error) {
      if (emergency.includes(name)) return;
      const decision = blocked("tool " + name, "guard-error", "the guard could not safely check this call: " + String(error));
      return { block: true, reason: !decision.allow ? decision.reason : "" };
    }
  });
  pi.on("tool_result", event => {
    const key = event.toolCallId ?? event.toolName ?? "unknown";
    const hint = containmentNotes.get(key); containmentNotes.delete(key);
    const notes: string[] = [];
    const receipt = pullRequestReceipts.get(key); pullRequestReceipts.delete(key);
    if (receipt) notes.push(pullRequestReceiptLine(receipt));
    const shellReceipt = shellReceipts.get(key); shellReceipts.delete(key);
    if (shellReceipt) notes.push(shellReceipt);
    if (hint && (event.content ?? []).some(part => typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" && part.text.includes("Operation not permitted"))) notes.push(hint);
    if (enforcementNotes.delete(key)) notes.push(modeNote);
    if (!notes.length) return;
    return { content: [...event.content ?? [], ...notes.map(text => ({ type: "text", text }))], ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }) };
  });
}
