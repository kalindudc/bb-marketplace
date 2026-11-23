import { readFileSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { authorityDecision, communicationAct, evaluate, blocked, BLOCK_MARKER, toolAllowed, clusterWriteBlock, hasClusterWrite, mergeBlock, type ScopeCall } from "../../src/scope/engine";
import { scopeFileSchema, scopeRenderedFileSchema, type Scope } from "../../src/scope/schema";
import { armedFile, armScope, MessagePolicyError, readMessagePolicy, type NativeScopeReceipt } from "../../src/scope/store";
import { prepareCall } from "../../src/scope/prepare";
import { communicationCallDigest, namedCommunication, sendRulesDigest } from "../../src/scope/communication";
import { claimCommunicationReceipt, holdCommunication, usedCommunicationReceipt } from "../../src/scope/communication-holds";
import { scopeForClass } from "../../src/scope/presets";
import { claimPullRequestGrant, pullRequestGrantAvailable, pullRequestReceiptLine } from "../../src/scope/pr-grants";
import { armShellGrantCapability, claimShellGrant, oldScopeEnvironment, readShellGrants } from "../../src/scope/shell-grants";
import { actReceiptLine, availableActGrant, claimActGrant, mergeGrantContext, revokeActGrant } from "../../src/scope/act-grants";
import { realPath } from "../../src/scope/paths";
import { sandboxCommand } from "../../src/scope/sandbox";
import { bindChecks } from "../../src/scope/checker";
import { bindWorktree, gitWorktreeRoot, needsWorktree, readerFallback } from "../../src/scope/worktree";
import { receiveSpend, type SpendSession } from "./spend";

// Structural API keeps the installed shim independent of a second copy of pi.
interface PiContext { cwd: string; sessionManager?: SpendSession }
interface PiEvent { toolName?: string; toolCallId?: string; input?: Record<string, unknown>; content?: unknown[]; structuredContent?: unknown; messageEntryId?: string }
export interface PiGuardApi {
  on(name: "session_start" | "before_agent_start" | "tool_call" | "tool_result" | "turn_end", handler: (event: PiEvent, ctx: PiContext) => unknown): unknown;
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
  let messagePolicyProblem: MessagePolicyError | undefined;
  const enforcementNotes = new Set<string>();
  const containmentNotes = new Map<string, string>();
  const pullRequestReceipts = new Map<string, string>();
  const shellReceipts = new Map<string, string>();
  let localArm: { issuedAt: number; at: number } | undefined;
  const legacyEnv = oldScopeEnvironment(process.env);
  const arm = (scope: Scope) => {
    if (nativeReceipt) return armScope(file, scope, nativeReceipt, Date.now(), messagePolicyProblem?.message);
    if (localArm?.issuedAt !== scope.issuedAt) {
      const at = Date.now();
      armShellGrantCapability(file, scope, at, legacyEnv);
      localArm = { issuedAt: scope.issuedAt, at };
    }
    armScope(file, scope, undefined, localArm.at, messagePolicyProblem?.message, true);
  };
  const actReceipts = new Map<string, string>();
  const draftReceipts = new Map<string, string>();
  let lastReadableScope: Scope | undefined;
  const modeNote = "[Tavern scope] Enforcement enabled; this call and subsequent calls use the current scope. Earlier calls made while off were not enforced.";
  let mode: Scope["mode"] = process.env.TAVERN_SCOPE_MODE === "off" ? "off" : process.env.TAVERN_SCOPE_MODE === "watch" ? "watch" : "enforce";
  const load = (): Scope => {
    nativeReceipt = undefined;
    messagePolicyProblem = undefined;
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
    try {
      scope = readMessagePolicy(file, scope, nativeReceipt?.hostBinding.scopeDigest);
      lastReadableScope = scope;
    } catch (error) {
      if (!(error instanceof MessagePolicyError)) throw error;
      messagePolicyProblem = error;
      delete scope.communicationAuthority;
    }
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
  const spend = receiveSpend(file);
  pi.on("session_start", (_event, ctx) => {
    worktree = undefined;
    localArm = undefined;
    refresh();
    if (ctx?.sessionManager) spend.backfill(ctx.sessionManager);
  });
  pi.on("turn_end", (event, ctx) => {
    if (ctx.sessionManager && event.messageEntryId) spend.turn(ctx.sessionManager, event.messageEntryId);
  });
  pi.on("before_agent_start", refresh);
  pi.on("tool_call", (event, ctx) => {
    const name = event.toolName ?? "unknown";
    const previousMode = mode;
    const wasMismatched = !!messagePolicyProblem;
    let scope: Scope;
    const input: ScopeCall = { kind: "tool", toolName: name, input: event.input ?? {}, cwd: ctx.cwd };
    const source = input.input.command ?? input.input.cmd;
    try { scope = load(); } catch (error) {
      if (typeof source === "string" && hasClusterWrite(source, ctx.cwd)) return { block: true, reason: clusterWriteBlock(source).reason };
      const fallback = lastReadableScope ?? scopeForClass("keeper");
      if (!communicationAct(fallback, input) && (mode !== "enforce" || emergency.includes(name))) return;
      const decision = blocked("tool " + name, "scope-invalid", "the scope file is missing, invalid or its worktree cannot be resolved: " + String(error) + "; ask the Keeper to repair it");
      return { block: true, reason: !decision.allow ? `${decision.reason}\nTavern scope rule: ${decision.ruleId}` : "" };
    }
    if (nativeReceipt) input.merge = null;
    const switched = previousMode === "off";
    try {
      const contained = !nativeReceipt && process.platform === "darwin" && scope.sandbox && ["bash", "Bash"].includes(name);
      const named = namedCommunication(scope.sendTools, input);
      const initial = communicationAct(scope, input);
      const inspected = !named && initial?.tool.endsWith(" pull request") && (scope.role === "smith" || scope.pullRequestPolicy?.owned.length)
        ? prepareCall({ ...input, ...(contained ? { containment: "sandbox" } : {}) }, { scope }) : input;
      const preview = inspected === input ? initial : communicationAct(scope, inspected);
      const mismatch = messagePolicyProblem;
      if (wasMismatched !== !!mismatch || mismatch) arm(scope);
      if (mismatch && (preview || [mismatch.sendTools, lastReadableScope?.sendTools].some(sendTools =>
        sendTools?.length && communicationAct({ ...scope, sendTools }, inspected))))
        return { block: true, reason: mismatch.message + " Nothing was sent or drafted." };
      const policy = scope.communicationAuthority;
      const closing = scope.shell.deny.some(rule => rule.id.startsWith("away:")) || scope.shell.deny.some(rule => rule.id === "cluster-write-while-away");
      const draftReceipt = preview?.act === "draft" && event.toolCallId && !closing && policy?.active
        ? policy.receipts.find(receipt => receipt.scopeIssuedAt === scope.issuedAt && receipt.rulesDigest === sendRulesDigest(scope.sendTools) &&
            receipt.callDigest === communicationCallDigest(input) && (!receipt.delegationId || policy.delegationIds.includes(receipt.delegationId)) && !usedCommunicationReceipt(file, receipt.askId))
        : undefined;
      const refuse = (reason: string) => {
        if (!preview) return { block: true, reason };
        try { holdCommunication(file, scope, input, preview); }
        catch { return { block: true, reason: reason + " Tavern could not record the held call." }; }
        return { block: true, reason: preview.act === "draft" ? reason + " Tavern recorded this for the Keeper. Repeat the exact call only after approval." : reason };
      };
      const callAuthority = { ...inspected, draftApproved: !!draftReceipt };
      const authority = authorityDecision(scope, callAuthority);
      const grant = authority && !authority.allow && authority.ruleId === "cluster-write" && name.toLowerCase() === "bash" && event.toolCallId
        ? availableActGrant(file, scope.threadId, "cluster-write", source) : undefined;
      if (authority && !authority.allow && !grant) return authority.ruleId === "send-guard" || authority.ruleId === "draft-guard" ? refuse(authority.reason) : { block: true, reason: authority.reason.startsWith(BLOCK_MARKER) ? `${authority.reason}\nTavern scope rule: ${authority.ruleId}` : authority.reason };
      if (grant) {
        const remaining = authorityDecision(scope, { ...callAuthority, clusterWriteApproved: true });
        if (remaining && !remaining.allow) return { block: true, reason: remaining.reason };
      }
      const claim = () => {
        if (!grant) return true;
        const observation = randomUUID();
        if (!claimActGrant(file, grant, observation)) return false;
        actReceipts.set(event.toolCallId!, actReceiptLine(grant.askId, observation));
        return true;
      };
      const claimDraft = () => {
        if (!draftReceipt) return true;
        const observation = randomUUID();
        if (!claimCommunicationReceipt(file, draftReceipt.askId, draftReceipt.callDigest, observation)) return false;
        draftReceipts.set(event.toolCallId!, `Tavern draft receipt: ${draftReceipt.askId} ${observation}`);
        return true;
      };
      const draftUsed = () => ({ block: true, reason: "[Tavern scope blocked] The draft approval was already used. Request a new approval. Nothing was drafted." });
      if (mode !== "enforce") {
        if (!claimDraft()) return draftUsed();
        if (!claim()) return { block: true, reason: clusterWriteBlock(grant!.target, false, scope.role).reason };
        return;
      }
      arm(scope);
      const mergeGrant = !nativeReceipt && scope.role === "keeper" && event.toolCallId && name.toLowerCase() === "bash"
        ? availableActGrant(file, scope.threadId, "merge", source) : undefined;
      const call = inspected === input || mergeGrant ? prepareCall({ ...input, containment: contained ? "sandbox" : undefined }, { scope, mergeTarget: mergeGrant?.mergeTarget }) : inspected;
      if (call.mergeHeadChanged && mergeGrant) revokeActGrant(file, mergeGrant.askId);
      const shellGrants = !nativeReceipt && !legacyEnv.length && event.toolCallId && ["bash", "Bash"].includes(name) ? readShellGrants(file, scope) : undefined;
      const decision = evaluate(scope, { ...call, draftApproved: !!draftReceipt, clusterWriteApproved: !!grant, shellGrants, prGrantAvailable: id => !!event.toolCallId && pullRequestGrantAvailable(file, id) });
      if (!decision.allow) {
        if (decision.ruleId === "send-guard" || decision.ruleId === "draft-guard") return refuse(decision.reason);
        const context = decision.ruleId === "merge-approval" && call.merge ? mergeGrantContext(file, scope.threadId, source) : undefined;
        const reason = context ? mergeBlock(call.merge!, context.target, context.staleVerdict).reason : decision.reason;
        return { block: true, reason: reason + (decision.act ? "\nWorking directory: " + JSON.stringify(ctx.cwd) : "") +
          (switched ? "\n" + modeNote : "") + "\nTavern scope rule: " + decision.ruleId };
      }
      if (decision.prGrant) {
        const receipt = randomUUID();
        if (!claimPullRequestGrant(file, decision.prGrant, receipt))
          return { block: true, reason: "[Tavern scope blocked] This pull request exception was already used." };
        pullRequestReceipts.set(event.toolCallId!, receipt);
      }
      const shellSource = name.toLowerCase() === "bash" && typeof event.input?.command === "string" ? event.input.command : undefined;
      const wrapped = shellSource === undefined ? undefined : sandboxCommand(scope, shellSource, decision.check === true, call.fetchWriteRoots);
      if (decision.shellGrant) {
        const receipt = randomUUID();
        if (shellSource === undefined || wrapped === undefined || !claimShellGrant(file, scope, decision.shellGrant, receipt, [shellSource, wrapped])) return { block: true, reason: "[Tavern scope blocked] This shell grant has ended or was already used. Nothing was done." };
        shellReceipts.set(event.toolCallId!, `Tavern shell grant receipt: ${decision.shellGrant} ${receipt}`);
      }
      if (!claimDraft()) return draftUsed();
      if (!claim()) return { block: true, reason: clusterWriteBlock(grant!.target, false, scope.role).reason };
      if (call.mergeMatches && mergeGrant) {
        const observation = randomUUID();
        if (!claimActGrant(file, mergeGrant, observation)) return { block: true, reason: mergeBlock(call.merge!, mergeGrant.mergeTarget).reason + "\nTavern scope rule: merge-approval" };
        actReceipts.set(event.toolCallId!, actReceiptLine(mergeGrant.askId, observation));
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
    const act = actReceipts.get(key); actReceipts.delete(key);
    if (act) notes.push(act);
    const draft = draftReceipts.get(key); draftReceipts.delete(key);
    if (draft) notes.push(draft);
    if (hint && (event.content ?? []).some(part => typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" && part.text.includes("Operation not permitted"))) notes.push(hint);
    if (enforcementNotes.delete(key)) notes.push(modeNote);
    if (!notes.length) return;
    return { content: [...event.content ?? [], ...notes.map(text => ({ type: "text", text }))], ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }) };
  });
}
