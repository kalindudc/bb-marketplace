import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  registerScopes,
  scopeSchema,
  evaluate,
  type Scope,
  type ProjectContext,
  type ScopeOverride,
  type ScopeResolution,
  type ScopesDeps,
  type Violation,
} from "../scope";
import {
  ensureGuardInstalled,
  guardStatus,
  uninstallGuard,
} from "../scope/install";
import { gitWorktreeRoot, needsWorktree } from "../scope/worktree";
import { glob } from "../scope/paths";
import { normalizeRemote } from "../scope/remote";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Ask, Member } from "../shared/schema";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { SCOPE_DENIAL_TEXT } from "../shared/text";
import type { ScopeRequest } from "./keeper/store";
import type { TavernRuntime } from "./runtime";

export type BackendScopeOptions = Pick<
  ScopesDeps,
  "dataDir" | "installGuard" | "policyOptions" | "guard" | "mode"
>;
export class BackendScopes {
  readonly api: ReturnType<typeof registerScopes>;
  private resolvingProject: string | undefined;
  private resolvingClass: import("../shared/schema").ClassDef | undefined;
  private readonly cwd = new Map<string, string>();
  private readonly answering = new Map<string, Promise<void>>();
  constructor(
    readonly runtime: TavernRuntime,
    private readonly options: BackendScopeOptions = {},
  ) {
    this.api = registerScopes(runtime.bb, {
      ...options,
      pathsForThread: (threadId) => this.paths(threadId),
      hostTargetForThread: threadId => {
        const record = runtime.placements().store.byMember(threadId);
        return record ? { kind: "host", placementId: record.id, generation: record.generation } : undefined;
      },
      hostScopeForThread: threadId => {
        const state = runtime.placements().deliveries.forThread(threadId);
        return state?.kind === "ready" && state.templateDigest !== this.api.hostTemplate(threadId).templateDigest
          ? { kind: "unavailable", reason: "Scope update pending; detection paused until the host acknowledges the effective scope." } : state;
      },
      onHostTemplateChanged: threadId => {
        void runtime.placements().ready.reconcileForThread(threadId).catch(error => runtime.bb.log.warn(`Tavern scope delivery ${threadId}: ${String(error)}`));
        runtime.keeper.changed(threadId);
      },
      remoteForThread: threadId => {
        const services = runtime.placements();
        const placed = services.store.byMember(threadId) ? services.deliveries.observationForThread(threadId, services.host) : undefined;
        if (placed !== undefined) {
          if (placed.kind === "ready" && services.deliveries.get(placed.binding.placementId)?.templateDigest !== this.api.hostTemplate(threadId).templateDigest)
            return { kind: "unavailable", reason: "Scope update pending; detection paused until the host acknowledges the effective scope." };
          return placed;
        }
        return undefined;
      },
      narrowBoundScope: scope => runtime.away.narrowScope(scope),
      cwdForThread: (threadId) => this.cwd.get(threadId),
      projectForThread: (threadId) => this.context(threadId),
      classScope: (classId) => this.resolvingClass?.id === classId ? this.resolvingClass.scope :
        runtime
          .snapshot(this.resolvingProject)
          .classes.find((role) => role.id === classId)?.scope,
      onViolation: (violation) => this.violation(violation),
    });
  }
  async refreshPresets() {
    const runtime = this.runtime;
    for (const row of this.api.status().threads) {
      const member = runtime.keeper.member(row.threadId), state = runtime.keeper.store.runtime(row.threadId);
      try {
        if (await this.api.protectOpenPolicy(row.threadId)) {
          runtime.keeper.store.event(runtime.keeper.now(), member?.keeperThreadId ?? row.threadId, member?.boardQuestId ?? null,
            "scope.refreshed", "Protected the trusted scope policy in an open scope",
            { memberThreadId: row.threadId, deny: "~/.agents/tavern/scopes.yml" }, { kind: "tavern" });
          runtime.bb.log.info(`Tavern scope policy protection added ${row.threadId}: ~/.agents/tavern/scopes.yml`);
          if (member) runtime.keeper.changed(row.threadId, member.boardQuestId);
        }
        if (!member || state.archivedAt || state.deletedAt || state.released || (member.role === "keeper" && row.scope?.preset === "open")) continue;
        const result = member.role === "keeper"
          ? await this.api.openKeeperScope(row.threadId) ? "updated" : "skipped"
          : this.api.refreshPresetTools(row.threadId);
        if (result === "skipped") runtime.bb.log.info(`Tavern scope preset refresh skipped ${row.threadId}: allowlist is not an exact legacy preset`);
        if (result !== "updated") continue;
        runtime.keeper.store.event(runtime.keeper.now(), member.keeperThreadId ?? member.threadId, member.boardQuestId,
          "scope.refreshed", member.role === "keeper" ? "Keeper scope widened to open by Tavern 0.1.2" : "Added read-only renderer helpers from the current preset",
          { memberThreadId: row.threadId, ...(member.role === "keeper" ? { preset: "open" } : { tools: ["check_ui", "ui_examples"] }) }, { kind: "tavern" });
        runtime.keeper.changed(row.threadId, member.boardQuestId);
      } catch (error) { runtime.bb.log.warn(`Tavern scope preset refresh ${row.threadId}: ${String(error)}`); }
    }
  }
  context(threadId: string): ProjectContext {
    if (this.runtime.keeper.member(threadId)?.role === "keeper" && this.runtime.keeper.store.runtime(threadId).builtinKeeperFallback) return {};
    const projectId = this.runtime.keeper.store.runtime(threadId).projectId;
    if (!projectId)
      throw new Error("A scoped thread needs a trusted project binding");
    return this.runtime.scopeProjectContext(projectId);
  }
  async prepare(threadId: string) {
    const thread = await this.runtime.bb.sdk.threads.get({ threadId });
    await this.runtime.prepareRegistry(thread.projectId);
    return thread;
  }
  async paths(threadId: string) {
    const bb = this.runtime.bb;
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) {
      // Admission runs before provisioning; the session env contribution binds real paths later.
      this.cwd.delete(threadId);
      return {};
    }
    const config = await bb.sdk.system.config();
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
    });
    const placed = this.runtime.placements().store.byMember(threadId);
    if (placed) {
      if (placed.root) this.cwd.set(threadId, placed.root);
      else this.cwd.delete(threadId);
      return {};
    }
    if (environment && environment.hostId !== config.primaryHostId) {
      if (!environment.path)
        throw new Error("An unplaced scoped member on another host needs a machine rule; no controller-local scope paths can be used");
      const remoteOpen = { hostId: environment.hostId, cwd: environment.path };
      this.cwd.set(threadId, environment.path);
      return { remoteOpen };
    }
    const storage = await bb.sdk.threads.storageLocation({ threadId });
    if (storage.hostId !== config.primaryHostId)
      throw new Error("Tavern scopes require server-local thread storage");
    if (environment?.path) this.cwd.set(threadId, environment.path);
    else this.cwd.delete(threadId);
    return {
      worktree:
        environment?.isWorktree && environment.path
          ? environment.path
          : undefined,
      threadStorage: storage.storageRootPath,
    };
  }
  async resolve(classId: string, projectId?: string, override?: ScopeOverride, definition?: import("../shared/schema").ClassDef) {
    if (projectId) await this.runtime.prepareRegistry(projectId);
    // The scope callback has only a class id; resolution itself is synchronous and project-specific.
    this.resolvingProject = projectId;
    this.resolvingClass = definition;
    try {
      const result = this.api.resolve(classId, projectId ? this.runtime.scopeProjectContext(projectId) : {}, override);
      if (override) this.validateTools(override, result.scope);
      return result;
    } finally {
      this.resolvingProject = undefined;
      this.resolvingClass = undefined;
    }
  }
  async checkerChecks(environmentId: string | null, commands: string[]) {
    const checks: NonNullable<Scope["checks"]> = { commands };
    try {
      if (!environmentId) throw new Error("The maker has no ready environment");
      const environment = await this.runtime.bb.sdk.environments.get({ environmentId });
      if (!environment.isWorktree || !environment.path)
        throw new Error("The maker environment is not a linked Git worktree");
      const config = await this.runtime.bb.sdk.system.config();
      if (environment.hostId !== config.primaryHostId)
        throw new Error("The maker worktree is not on the server host");
      checks.worktree = gitWorktreeRoot(environment.path);
      return { checks, problems: [] as string[] };
    } catch (error) {
      const problem = `Maker worktree unavailable; checks are closed, ordinary reads remain available: ${String(error)}`;
      this.runtime.bb.log.warn(`Tavern checker binding: ${problem}`);
      return { checks, problems: [problem] };
    }
  }
  private validateTools(override: ScopeOverride, scope: Scope) {
    const known = new Set([
      "read", "Read", "write", "Write", "edit", "Edit", "MultiEdit", "multiedit", "apply_patch",
      "bash", "Bash", "shell", "shell_command", "exec_command", "write_stdin", "powershell", "PowerShell",
      "grep", "Grep", "find", "Glob", "ls", "codemode", "tool_search", "journal", "quest",
      "web_search", "web_fetch", "web_extract", "web_map", "git_blame", "git_diff_summary", "ast_query",
      ...this.runtime.toolNames,
      ...this.api.violations(scope.threadId).flatMap(violation => violation.call?.toolName ? [violation.call.toolName] : []),
    ]);
    const existing = [...scope.tools.allow, ...scope.tools.deny];
    const commands = new Set(["npm", "npx", "node", "pnpm", "yarn", "bun", "git", "gh", "cargo", "go", "python", "python3", "ruby", "bundle", "make"]);
    for (const name of Object.values(override.tools ?? {}).flatMap(names => names ?? [])) {
      if (/\s|[|;&<>`$]/.test(name) || commands.has(name)) {
        const cwd = scope.preset === "checker" ? scope.checks?.worktree : this.cwd.get(scope.threadId) ?? scope.expectedWorktree;
        const decision = cwd ? evaluate(scope, { kind: "bash", toolName: "bash", input: { command: name }, cwd }) : null;
        const label = this.runtime.snapshot(this.resolvingProject).classes.find(role => role.id === scope.role)?.label ?? scope.role;
        if (decision?.allow)
          throw new Error(`${name} is a shell command; the ${label} preset already allows it. No tool grant or scope ask is needed.`);
        throw new Error(`${name} is a shell command, not a tool name; ${decision && !decision.allow ? `blocked by ${decision.ruleId}: ${decision.reason}` : "commands are governed by the preset and shell rules, not tools.allow"}. No tool-name grant can authorize a shell command.`);
      }
      if (!known.has(name) && !existing.includes(name) && ![...known].some(tool => glob(name, tool)))
        throw new Error(`Tavern cannot verify tool name ${name}. Use a known built-in, a registered Tavern tool, an existing valid pattern, or the exact tool name from its scope violation. MCP and other-plugin names are not a complete discovered catalog.`);
    }
  }
  async pinWorktree(threadId: string) {
    const member = this.runtime.keeper.member(threadId);
    if (
      !this.api.shouldScope(
        member?.classId,
        member?.role === "member" ? "hire" : "direct",
      )
    )
      return;
    const scope = this.api
      .status()
      .threads.find((row) => row.threadId === threadId)?.scope;
    if (
      !scope ||
      scope.expectedWorktree ||
      (!needsWorktree(scope) && scope.writes.mode !== "worktree")
    )
      return;
    const paths = await this.paths(threadId);
    if (!paths.worktree) return;
    await this.api.rebindScope(threadId);
    this.runtime.keeper.changed(threadId, member?.boardQuestId);
  }
  private recordProblems(threadId: string, problems: string[]) {
    const bounded = problems.slice(0, 30);
    if (problems.length > bounded.length)
      bounded.push(`${problems.length - bounded.length} more policy problems`);
    this.runtime.keeper.store.patch(threadId, { scopeProblems: bounded });
    for (const problem of bounded)
      this.runtime.bb.log.warn(`Tavern scope policy ${threadId}: ${problem}`);
  }
  async ensure(member: Member) {
    if (
      !this.api.shouldScope(
        member.classId,
        member.role === "member" ? "hire" : "direct",
      )
    )
      return;
    const current = this.api
      .status()
      .threads.find((row) => row.threadId === member.threadId);
    const state = this.runtime.keeper.store.runtime(member.threadId);
    if (current?.scope && !(state.scopeKeeperFallback && !state.builtinKeeperFallback)) return this.pinWorktree(member.threadId);
    if (current?.error) throw new Error(current.error);
    const projectId = this.runtime.keeper.store.runtime(
      member.threadId,
    ).projectId;
    if (!projectId) throw new Error("Missing trusted project for scope");
    let resolution: ScopeResolution;
    if (state.builtinKeeperFallback) {
      if (member.role !== "keeper") throw new Error("Only a Keeper can use the built-in fallback scope");
      this.resolvingClass = this.runtime.builtinSnapshot().classes.find(role => role.id === "keeper");
      if (!this.resolvingClass) throw new Error("The built-in Keeper class is missing");
      try { resolution = this.api.resolve("keeper", {}); }
      finally { this.resolvingClass = undefined; }
    } else resolution = await this.resolve(member.classId, projectId);
    const checks = this.runtime.keeper.store.runtime(member.threadId).reviewTarget?.checks;
    if (resolution.scope.preset === "checker" && checks) resolution.scope.checks = checks;
    this.recordProblems(member.threadId, resolution.problems);
    await this.api.writeScope(member.threadId, resolution.scope);
    this.runtime.keeper.store.patch(member.threadId, { scopeKeeperFallback: !!state.builtinKeeperFallback });
    this.runtime.keeper.changed(member.threadId, member.boardQuestId);
  }
  pending(threadId: string) {
    const id = this.runtime.keeper.store.runtime(threadId).scopePending;
    return id ? this.runtime.keeper.store.get("scopeRequests", id) : null;
  }
  async hired(
    member: Member,
    resolution: ScopeResolution,
    override: ScopeOverride | undefined,
    brief: string,
    spawnInput = false,
  ) {
    const pending = this.pending(member.threadId);
    if (pending) return this.runtime.keeper.store.runtime(member.threadId).scopePending!;
    this.recordProblems(member.threadId, resolution.problems);
    await this.api.writeScope(member.threadId, resolution.scope);
    if (resolution.widenings.length) {
      const ask = this.request(
        member,
        override!,
        resolution.widenings,
        "The hired task requests a wider scope",
        brief,
        spawnInput,
      );
      return ask.id;
    }
    if (!spawnInput) await this.sendBrief(member.threadId, brief);
    return null;
  }
  private async sendBrief(threadId: string, text: string) {
    await this.runtime.sendInitialBrief(threadId, text);
  }
  async override(
    keeperThreadId: string,
    memberThreadId: string,
    override: ScopeOverride,
    reason: string,
  ) {
    const k = this.runtime.keeper;
    k.require(keeperThreadId, "keeper");
    memberThreadId = k.resolvePartyMember(keeperThreadId, memberThreadId).threadId;
    const member = k.member(memberThreadId);
    if (
      !member ||
      member.role !== "member" ||
      member.keeperThreadId !== keeperThreadId
    )
      throw new Error("Only change the scope of a member of your own party");
    if (member.boardQuestId) k.guard(keeperThreadId, member.boardQuestId);
    if (this.pending(memberThreadId))
      throw new Error("A scope request is already awaiting the user's answer");
    if (k.store.runtime(memberThreadId).released)
      throw new Error("This member has been released");
    await this.prepare(memberThreadId);
    await this.ensure(member);
    const current = this.api.status().threads.find(row => row.threadId === memberThreadId)?.scope;
    if (!current) throw new Error("No valid scope for this member");
    this.validateTools(override, current);
    const result = await this.api.applyOverride(memberThreadId, override);
    this.recordProblems(memberThreadId, result.problems);
    const ask = result.widenings.length
      ? this.request(member, override, result.widenings, reason, null)
      : null;
    k.store.event(
      k.now(),
      keeperThreadId,
      member.boardQuestId,
      "scope.changed",
      reason,
      {
        memberThreadId,
        override,
        widenings: result.widenings,
        askId: ask?.id ?? null,
      },
      { kind: "agent", threadId: keeperThreadId },
    );
    k.changed(memberThreadId, member.boardQuestId);
    return ask
      ? `Safe narrowing applied; awaiting scope approval.\n::tavern-ask{id="${ask.id}"}`
      : JSON.stringify(current) === JSON.stringify(result.scope) ? "No change: these are already in effect; no scope ask is needed." : "Scope updated within the user's policy.";
  }
  private request(
    member: Member,
    override: ScopeOverride,
    widenings: string[],
    reason: string,
    initialBrief: string | null,
    spawnInput = false,
  ) {
    const k = this.runtime.keeper;
    const context = this.context(member.threadId);
    const remotes = [...new Set((context.remotes ?? []).map(normalizeRemote))];
    const candidates = context.pushRemote
      ? remotes.filter(
          (remote) => remote === normalizeRemote(context.pushRemote!),
        )
      : remotes;
    const remember =
      widenings.every((id) => !id.includes(":")) &&
      candidates.length > 0 &&
      candidates.length <= 3;
    const rememberRemotes = remember
      ? Object.fromEntries(
          candidates.map((remote, index) => [
            candidates.length === 1
              ? "remember-repo"
              : `remember-repo-${index + 1}`,
            remote,
          ]),
        )
      : {};
    const ask = k.ask(
      member.keeperThreadId!,
      {
        boardQuestId: member.boardQuestId,
        kind: "scope",
        question: `Widen ${this.runtime.keeper.name(member)}'s scope?`,
        why: `${reason.slice(0, 90)}. Review the full grant request. This changes a guardrail, not approval to merge, deploy, delete, send or write to production.`.slice(
          0,
          200,
        ),
        scopeChange: {
          memberThreadId: member.threadId,
          override,
          widenings,
          reason,
          ...context,
        },
        options: [
          {
            id: "approve",
            label: "Allow once for this member",
            detail: "Apply only these exact grants",
            recommended: false,
          },
          ...Object.entries(rememberRemotes).map(([id, remote]) => ({
            id,
            label:
              candidates.length === 1
                ? "Allow and remember for this repo"
                : `Remember for ${remote}`.slice(0, 160),
            detail:
              `Save only these Git push grants in your global policy for ${remote}`.slice(
                0,
                300,
              ),
            recommended: false,
          })),
          {
            id: "deny",
            label: "No widening; keep the existing scope",
            detail: SCOPE_DENIAL_TEXT,
            recommended: true,
          },
        ],
        meanwhile:
          "Continue unrelated work. This task must not rely on an unapproved grant.",
        holds: member.waypointId ? [member.waypointId] : [],
      },
      { memberThreadId: member.threadId, override, widenings },
    );
    k.store.put("scopeRequests", ask.id, {
      keeperThreadId: member.keeperThreadId!,
      boardQuestId: member.boardQuestId,
      memberThreadId: member.threadId,
      classId: member.classId,
      context,
      override,
      widenings,
      reason,
      initialBrief,
      spawnInput,
      rememberRemotes,
      state: "pending",
    });
    k.store.patch(member.threadId, { scopePending: ask.id });
    k.changed(member.threadId, member.boardQuestId);
    return ask;
  }
  async answer(ask: Ask) {
    const previous = this.answering.get(ask.id);
    if (previous) return previous;
    const work = this.applyAnswer(ask);
    this.answering.set(ask.id, work);
    try {
      await work;
    } finally {
      this.answering.delete(ask.id);
    }
  }
  private async applyAnswer(ask: Ask) {
    const k = this.runtime.keeper;
    const request = k.store.get("scopeRequests", ask.id);
    if (
      !request ||
      request.state !== "pending" ||
      ask.state !== "answered" ||
      ask.answer?.by !== "user"
    )
      return;
    const member = k.member(request.memberThreadId);
    if (
      !member ||
      member.keeperThreadId !== request.keeperThreadId ||
      k.store.runtime(member.threadId).released
    )
      throw new Error(
        "The scope request no longer belongs to an active member",
      );
    if (ask.answer.optionId === "deny") {
      if (request.initialBrief)
        await this.runtime.release(
          request.keeperThreadId,
          member.threadId,
          "The user declined the task's required scope",
        );
      this.finish(ask, request, "declined");
      return;
    }
    const remembering = ask.answer.optionId.startsWith("remember-repo");
    const legacyRemote =
      request.context.pushRemote ??
      (request.context.remotes?.length === 1
        ? request.context.remotes[0]
        : undefined);
    const pushRemote =
      request.rememberRemotes?.[ask.answer.optionId] ??
      (ask.answer.optionId === "remember-repo" ? legacyRemote : undefined);
    if (ask.answer.optionId !== "approve" && (!remembering || !pushRemote))
      throw new Error(
        "Choose an offered trusted push destination or allow once",
      );
    await this.prepare(member.threadId);
    if (
      JSON.stringify(this.context(member.threadId)) !==
      JSON.stringify(request.context)
    )
      throw new Error(
        "The scope request's repository changed; request fresh approval",
      );
    const current = this.api.status().threads.find(row => row.threadId === member.threadId)?.scope;
    if (!current) throw new Error("No valid scope for this member");
    this.validateTools(request.override, current);
    await this.api.applyOverride(member.threadId, request.override, {
      approvedRuleIds: request.widenings,
    });
    if (remembering) {
      if (!request.widenings.every((id) => !id.includes(":")))
        throw new Error(
          "Tool and path grants cannot be remembered automatically",
        );
      this.api.rememberWidening(
        { ...request.context, pushRemote },
        request.classId,
        request.widenings,
      );
    }
    // Spawn input is already durable in core; approval only releases its queued row.
    if (request.initialBrief && !request.spawnInput)
      await this.sendBrief(member.threadId, request.initialBrief);
    this.finish(ask, request, "applied");
    if (request.initialBrief && !request.spawnInput)
      await this.sendBrief(member.threadId, request.initialBrief);
  }
  private finish(
    ask: Ask,
    request: ScopeRequest,
    state: "applied" | "declined",
  ) {
    const k = this.runtime.keeper;
    k.store.atomic(() => {
      k.store.put("scopeRequests", ask.id, { ...request, state });
      k.store.patch(request.memberThreadId, { scopePending: null });
      k.store.event(
        k.now(),
        ask.keeperThreadId,
        ask.boardQuestId,
        `scope.${state}`,
        state === "declined" ? `${SCOPE_DENIAL_TEXT} Member: ${request.memberThreadId}.` : `Applied scope grants for ${request.memberThreadId}: ${request.widenings.join(", ")}`,
        { askId: ask.id, ...request },
        { kind: "user" },
      );
    });
    k.changed(request.memberThreadId, request.boardQuestId);
    void this.runtime.bb.experimental_hooks
      .recheck("message.dispatch")
      .catch((error) =>
        this.runtime.bb.log.warn(`Tavern scope recheck: ${String(error)}`),
      );
  }
  async resume(keeperThreadId: string) {
    const k = this.runtime.keeper;
    for (const request of k.store.pendingScopeRequests(keeperThreadId)) {
      const ask = k.store.get("asks", request.id);
      if (ask?.state === "answered") {
        try {
          await this.answer(ask);
        } catch (error) {
          this.runtime.bb.log.warn(
            `Tavern scope approval ${ask.id}: ${String(error)}`,
          );
        }
      }
    }
  }
  async violation(violation: Violation) {
    const k = this.runtime.keeper;
    const member = k.member(violation.threadId);
    if (!member) return;
    const key = `${member.threadId}:${violation.eventId}`;
    if (k.store.get("scopeViolations", key)) return;
    const keeperThreadId =
      member.role === "keeper" ? member.threadId : member.keeperThreadId;
    k.store.put("scopeViolations", key, violation);
    k.activity(
      member.threadId,
      member.role === "keeper"
        ? "waiting"
        : violation.stopped
          ? "stopped"
          : "waiting",
    );
    this.runtime.bb.log.warn(
      `Tavern scope violation ${member.threadId}: ${violation.ruleId}; stopped=${violation.stopped}${violation.stopError ? `; ${violation.stopError}` : ""}`,
    );
    k.store.event(
      k.now(),
      keeperThreadId,
      member.boardQuestId,
      "scope.violation",
      `${this.runtime.keeper.name(member)}: ${violation.reason}${violation.stopError ? `; STOP FAILED: ${violation.stopError}` : ""}`,
      { ...violation },
      { kind: "tavern" },
    );
    if (keeperThreadId) {
      const open = k.store
        .openAsks(keeperThreadId)
        .find(
          (ask) =>
            ask.kind === "blocker" &&
            k.store.get("askMeta", ask.id)?.scopeThreadId === member.threadId,
        );
      if (!open) {
        const ask = k.ask(
          keeperThreadId,
          {
            boardQuestId: member.boardQuestId,
            kind: "blocker",
            question: `Scope blocked ${this.runtime.keeper.name(member)}`,
            why: `${violation.ruleId}: ${violation.reason}${violation.stopError ? `; stop failed: ${violation.stopError}` : ""}. Full evidence is in the ledger.`.slice(
              0,
              200,
            ),
            options: [
              {
                id: "review",
                label: "Review the blocked call",
                detail:
                  "Inspect the evidence and scope; this does not grant new permissions",
                recommended: true,
              },
            ],
            meanwhile:
              "Keep unrelated work moving. Do not retry the blocked call under another tool.",
            holds: member.waypointId ? [member.waypointId] : [],
          },
          { scopeThreadId: member.threadId },
          true,
        );
        k.store.put("askMeta", ask.id, {
          ...k.store.get("askMeta", ask.id),
          scopeThreadId: member.threadId,
        });
      }
      await this.runtime.push(
        keeperThreadId,
        violation.stopped
          ? "Tavern scope blocked a member"
          : "Urgent: Tavern could not stop a scope violation",
        violation.stopError ?? violation.reason,
      );
    }
    k.changed(member.threadId, member.boardQuestId);
  }
  clearScope(threadId: string) {
    this.api.clearScope(threadId);
    const k = this.runtime.keeper;
    const request = this.pending(threadId);
    if (!request) return;
    const askId = k.store.runtime(threadId).scopePending!;
    k.store.atomic(() => {
      k.store.put("scopeRequests", askId, { ...request, state: "declined" });
      const ask = k.store.get("asks", askId);
      if (ask?.state === "open")
        k.withdrawAsk(askId, "scope-cleared");
      k.store.patch(threadId, { scopePending: null });
    });
    k.changed(threadId, request.boardQuestId);
  }
  view(threadId: string) {
    const status = this.api.status();
    const row = status.threads.find((row) => row.threadId === threadId);
    if (!row) return null;
    const problems = [
      ...(this.runtime.keeper.store.runtime(threadId).scopeProblems ?? []),
    ];
    try {
      problems.push(...this.api.policy(this.context(threadId)).problems);
    } catch (error) {
      problems.push(`Policy read failed: ${String(error)}`);
    }
    const guardPosture = this.runtime.keeper.member(threadId)?.guardPosture;
    return row
      ? {
          threadId,
          mode: status.mode,
          guard: status.guard,
          problems: [...new Set(problems)].slice(0, 30),
          scope: row.scope,
          ...(guardPosture ? { guardPosture } : {}),
          error: row.error ?? null,
          armed: row.armed,
          pendingAskId:
            this.runtime.keeper.store.runtime(threadId).scopePending ?? null,
        }
      : null;
  }
  views(threadIds: string[]) {
    return threadIds.flatMap((threadId) => {
      const row = this.view(threadId);
      return row ? [row] : [];
    });
  }
  violations(threadIds: string[]) {
    if (!threadIds.length) return [];
    const ids = new Set(threadIds);
    const observations = this.api
      .violations(threadIds.length === 1 ? threadIds[0] : undefined)
      .filter((row) => ids.has(row.threadId));
    const rows = new Map(
      [
        ...this.runtime.keeper.store.scopeViolations(threadIds),
        ...observations,
      ].map((row) => [`${row.threadId}:${row.eventId}`, row]),
    );
    return [...rows.values()].sort((a, b) => a.at - b.at).slice(-100);
  }
  guard(action: "status" | "install" | "uninstall") {
    const candidates = [
      "../../adapters/pi/extension.ts",
      "../adapters/pi/extension.ts",
      "./adapters/pi/extension.ts",
    ].map((path) => fileURLToPath(new URL(path, import.meta.url)));
    const options = {
      entryPath: candidates.find((path) => existsSync(path)) ?? candidates[0],
      ...this.options.guard,
    };
    if (action === "install")
      return ensureGuardInstalled({
        ...options,
        entryPath: options.entryPath!,
      });
    if (action === "uninstall") uninstallGuard(options);
    return { ...guardStatus(options), mode: this.api.mode() };
  }
}

export async function registerScopeSettings(
  bb: BbPluginApi,
  runtime: TavernRuntime,
  options: BackendScopeOptions = {},
) {
  const settings = bb.settings.define({
    scopes: {
      type: "select",
      label: "Scopes",
      options: ["enforce", "watch", "off"],
      default: DEFAULT_SETTINGS.scopes.mode,
      experimental_optionLabels: {
        enforce: "Enforce guardrails",
        watch: "Watch only (no blocking)",
        off: "Off (retain scopes)",
      },
    },
  });
  const legacy = scopeSchema.shape.mode.parse((await settings.get()).scopes);
  if (runtime.settings && !runtime.settings.hasUser("scopes.mode") && legacy !== DEFAULT_SETTINGS.scopes.mode)
    runtime.settings.update({ revision: runtime.settings.snapshot().revision, patch: { scopes: { mode: legacy } }, why: "Preserved the existing bb scope setting" });
  runtime.enableScopes({ ...options, mode: runtime.settings ? runtime.config().scopes.mode : legacy });
  if (runtime.settings) {
    runtime.syncLegacyScopes = async mode => {
      if ((await settings.get()).scopes !== mode) await settings.experimental_set({ scopes: mode });
    };
    await runtime.syncLegacyScopes(runtime.config().scopes.mode);
  }
  settings.onChange((next, previous) => {
    if (next.scopes === previous.scopes) return;
    const mode = scopeSchema.shape.mode.parse(next.scopes);
    if (runtime.settings) {
      if (runtime.config().scopes.mode === mode) return;
      runtime.settings.update({ revision: runtime.settings.snapshot().revision, patch: { scopes: { mode } }, why: "Changed the legacy bb scope control" });
      runtime.settingsChanged();
    } else {
      runtime.scopes!.api.setMode(mode);
      runtime.keeper.invalidateAll(false);
    }
    bb.log.info(
      `Tavern scopes mode=${mode}; restart provider sessions to refresh environment speed bumps`,
    );
  });
}
