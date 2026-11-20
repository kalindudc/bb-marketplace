import { preapprovalWords } from "../../shared/quest-authority";
import { z } from "zod";
import { placementPickSchema } from "../placement/picks";
import { localClock } from "../clock";
import { taleResultsSchema } from "../../shared/tale-results";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  askSchema,
  checkerHandoffHoldDraftSchema,
  briefSchema,
  decisionSchema,
  planInputSchema,
  settleWaypointSchema,
  reportSchema,
  ROUTE_KINDS,
  noteDraftSchema,
  summaryDraftSchema,
  gateInputSchema,
} from "../../shared/schema";
import type { TavernRuntime } from "../runtime";
import { LIMITS } from "../limits";
import { readStatus, statusInput } from "../status";
import { readRequestSources } from "../request-sources";
import { requestSourceReadSchema } from "../../shared/request-source";
import { scopeOverrideSchema } from "../../scope/schema";
import { sparseTunablesSchema } from "../../shared/settings";
import { DetectionApprovalRequired } from "../guard-hire";
import { PlacementHireBlocked } from "../placement/controller";
import { agentData } from "../agent-data";
import { registerReady } from "./ready";

const id = z.string().min(1).max(120);
const optionalQuest = id.nullish();
export function registerTools(bb: BbPluginApi, runtime: TavernRuntime) {
  const k = runtime.keeper;
  const register = <S extends z.ZodType>(
    name: string,
    label: string,
    description: string,
    parameters: S,
    action: (
      input: z.output<S>,
      threadId: string,
      projectId: string,
    ) => unknown | Promise<unknown>,
    role: "keeper" | "member" = "keeper",
  ) => {
    bb.agents.registerTool({
      name,
      description,
      parameters: z.toJSONSchema(parameters, { io: "input" }),
      presentation: { label: { pending: label, completed: label } },
      async execute(input, ctx) {
        if (ctx.signal.aborted)
          throw new Error(`${name} was cancelled or stopped before it began; no change was applied.`);
        k.require(ctx.threadId, role);
        let result: unknown;
        try {
          result = await action(parameters.parse(input), ctx.threadId, ctx.projectId);
        } catch (error) {
          if (ctx.signal.aborted)
            throw new Error(`${name} failed while its turn was cancelled or stopped; its outcome is not confirmed. Read tavern_status before retrying. Cause: ${String(error)}`, { cause: error });
          throw error;
        }
        const visible = agentData(result);
        const text =
          typeof visible === "string" ? visible : JSON.stringify(visible);
        return text.length <= 18000
          ? text
          : `${text.slice(0, 17800)}\nOutput truncated. Call tavern_status with a narrower section, reportId or page.`;
      },
    });
  };
  register(
    "tavern_tune",
    "Adjusted quest pacing",
    "Override staleMinutes and reportBatchSeconds for an active quest until it ends. Requires tuning mode apply and respects user pins. Change thread-wide pacing and memory in Settings, not here. The Ranger time-box ceiling is a user-only budget.",
    z.object({ boardQuestId: id, values: sparseTunablesSchema, why: z.string().trim().min(1).max(2000) }).strict(),
    (input, threadId) => {
      k.guard(threadId, input.boardQuestId);
      const quest = k.quest(input.boardQuestId);
      if (quest.endedAt !== null) throw new Error("Only an active quest may have a pacing override.");
      if (!runtime.settings) throw new Error("Tavern settings are not registered.");
      const decision = runtime.settings.override(quest.id, threadId, input.values, input.why);
      return { boardQuestId: quest.id, values: runtime.config(quest.id).knobs, decisionId: decision?.id ?? null, until: "Quest ends" };
    },
  );
  register(
    "tavern_route",
    "Read the user's message",
    "Record how the oldest unrouted user message was read. notes is REQUIRED on every route kind; use [] only after considering durable facts, commitments and waiting-on-user hand-backs. The goal itself is never a note: open a board quest for it, and record only separate facts, commitments or hand-backs as notes. A steer can name one boardQuestId or several boardQuestIds when the user means multiple goals. Asides and questions must not name quests. Route the user's own standing rule as rule. For a new quest, route first then open it with tavern_quest. Record an explicit checker-handoff hold with checkerHandoffHold: { reason }. It stays held until a user control releases it; a reporting promise never releases it. Route queued messages in order before quest writes. steer: apply the change to every named quest; if targets are unclear, ask one short question and change nothing. A still-applicable steer or new-quest route survives later questions, asides and queued messages until its following Keeper turn ends; never re-route a newer message to regain authority for it. question: answer from the ledger or knowledge and change nothing. aside: do quick work directly, otherwise hire an errand helper with errand:true, without a board quest or waypoint; never change board quests. new-quest: open the concrete goal with tavern_quest and scout; a greeting or class selection is not a goal. rule: save the user's standing rule verbatim with tavern_rule and source:message, active for this Keeper by default; global only when the user explicitly names all Keepers or all Tavern threads. Keeper proposals wait for ledger confirmation. Record commitments with dueAt or a condition and facts verbatim.",
    z.object({
      kind: z.enum(ROUTE_KINDS),
      boardQuestId: optionalQuest,
      boardQuestIds: z.array(id).max(8).default([]),
      summary: z.string().max(300),
      notes: z.array(noteDraftSchema).max(12),
      checkerHandoffHold: checkerHandoffHoldDraftSchema.optional(),
    }),
    (input, threadId) => k.route(threadId, input),
  );
  register(
    "tavern_summary",
    "Posted a Keeper summary",
    "Write only what the user would want to read later: finished work and its result, a decision and why, or something that needs them. Never post progress like “still working.” For an action, open and link the ask or hand-back. Include evidence; use results for figures. Put the returned directive on its own line in chat.",
    summaryDraftSchema,
    (input, threadId) => `Posted. Put this card on its own line in your reply:\n::tavern-summary{id="${k.postSummary(threadId, input).id}"}`,
  );
  register(
    "tavern_note",
    "Recorded Keeper memory",
    "Record a fact verbatim (validUntil optional), a commitment with dueAt or condition, or a waiting-on-user hand-back with a one-line action only the user can do and optional why. Use facts or summaries for information. Done and Reply resolve it; op done closes notes. Quest end closes promises and hand-backs. Do not make promises only in chat.",
    z.union([
      noteDraftSchema.safeExtend({ op: z.literal("add") }),
      z.object({ op: z.literal("done"), noteId: id }).strict(),
    ]),
    (input, threadId) => {
      if (input.op === "done") return k.memory.complete(threadId, input.noteId);
      const { op, ...draft } = input;
      return k.memory.note(threadId, draft);
    },
  );
  register(
    "tavern_gate",
    "Recorded outside-gate contact",
    "Record who was asked, when, by what means and any answer for an outside waypoint in the current plan. This only records actual contact; it never contacts a person, sends as the user, or grants approval for a consequential action. After greenlight, unasked outside gates repeat in ticks until actual contact is recorded; that repetition is not consent to contact anyone.",
    gateInputSchema,
    (input, threadId) => k.memory.gate(threadId, input),
  );
  register(
    "tavern_quest",
    "Opened a board quest",
    "Open a goal on the board in scout phase. Your own checklist is managed with journal.",
    z.object({
      title: z.string().min(1).max(200),
      short: z.string().min(1).max(40),
    }),
    (input, threadId) => k.openQuest(threadId, input.title, input.short),
  );
  register(
    "tavern_reopen",
    "Re-opened a board quest",
    "Re-open one of your returned or stopped board quests to do deviations and follow-up commits without opening a new quest. Cite messageId of the user’s uncancelled, unused routed message, newer than the last phase transition; its quoted text is the receipt. The quest's plan version and its greenlight are kept. It returns to build with a greenlit plan, or scout without one. Refused for a live quest, and for an archived quest: bring it up from the cellar first. A Warden still verifies the deviation work before the next wrap.",
    z.object({ boardQuestId: id, messageId: id }),
    (input, threadId) => {
      const quest = k.owned(threadId, input.boardQuestId);
      const reopened = k.reopenQuest(quest.id, { kind: "agent", threadId }, input.messageId);
      return `Re-opened ${reopened.title} for deviations; it is back in ${reopened.phase} at plan v${reopened.planVersion}.`;
    },
  );
  register(
    "tavern_placements",
    "Read a repo's placement choices",
    "Read the environment providers and input schemas bb offers for repo (a bb project id), New machine per thread information, earlier Tavern picks as rule ids, and the matching Settings rule as the recommendation. The placement choices are ready-to-pass rule ids that match this repo and class, or where the Keeper runs only for its own repo. Optional classId defaults to smith; boardQuestId includes that quest's rule matches. Consent, inputs, models and forge come only from the selected rule. Provider lists are information only. It allocates nothing.",
    z.object({ repo: id, classId: id.optional(), boardQuestId: optionalQuest }).strict(),
    (input, threadId) => runtime.placementChoices(threadId, input.repo, input.classId, input.boardQuestId),
  );
  register(
    "tavern_hire",
    "Hired a party member",
    "Hire with a bounded brief. title names the task, not the class or character; Tavern names the thread. Scope narrows class policy or requests named grants. Uncovered widening opens a consequential, never-timed scope ask; the brief stays queued and work cannot start until approval. The review budget is hard: only the user can allow one more review on the quest page. A reversible tavern_decide with exceeds: party or rangers permits one hire beyond that soft class limit, never keepers.partyMax. Scouts and errands may precede greenlight; staffing needs recorded greenlight, by default the user's explicit approval. A waypoint Warden needs a known maker journal entry; its brief includes the maker thread, entry ids, trusted maker worktree and explicit plan check commands. The checker preset allows standard test/check/lint/typecheck runners there without widening or a user-run blocker. Do not request commands as tool names. Use shell fences or inline command quotes for custom checks, not prose that invents permissions. Read its review posture: any class-model fallback is a same-family check (not independent), never an independent check. Scoped hires prefer Pi when it offers the model. Otherwise refuse by default; requestDetectionOnly:true asks without hiring. After the user approves, repeat with detectionOnlyAskId. Detection only is not prevention. Unknown class models refuse: change classes.<classId>.model in Tavern settings. Never silently choose a provider default. Tell the user any execution substitution in this turn. Every brief names outcome, mode, out-of-scope, re-runnable done-when and context paths; Ranger briefs also need numbered questions and a time box within the live Ranger-minute limit. Rangers return evidence, not the deliverable. Retain the returned review limitation verbatim. A missing maker root is a binding fault, not permission to weaken scope. Scoped local non-Pi hires are \"detection only (not prevented)\"; watchers and environment speed bumps are not pre-exec prevention. Never claim hooks or shims are installed. Remote posture is detection only. Obey the approved party and the replacement limit per slot per plan version; done, stopped and failed members free capacity unless an initial brief is pending, which must be retried or released first. Do not hire twice for a pending brief. Rangers and Wanderers may scout a linked quest within live budgets without a re-plan. Read Free hands in the ledger or tavern_status first; reuse is advisory. Each Warden slot checks one maker only, and its character and model apply at hire. Call tavern_placements with repo, classId and optional boardQuestId before picking. repo defaults to your own project; a Warden defaults to its maker's repo and cannot name another. placement is {ruleId} from those choices or {kind:\"current\"} for your own repo only. Consent, inputs, models and forge come from the rule; never supply or merge target inputs. A cross-repo hire carries only that repo's pushed default-branch tip, never the user's unpushed commits or uncommitted files. No pick: the repo's matching rule applies, otherwise your repo stays here. Leads take no automatic rule. Failed models refuse before allocation; set that class's rule model in Settings, Where work runs. There is no fallback model. The first line names the repo, rule or pick and target.",
    z.object({
      classId: id,
      brief: briefSchema,
      boardQuestId: optionalQuest,
      waypointId: id.nullish(),
      errand: z.boolean().default(false),
      characterId: id.nullish(),
      title: z.string().min(1).max(200),
      scope: scopeOverrideSchema.optional(),
      requestDetectionOnly: z.boolean().default(false),
      detectionOnlyAskId: id.optional(),
      placementRuleId: id.optional(),
      repo: id.optional(),
      placement: placementPickSchema.optional(),
    }),
    async (input, threadId, projectId) => {
      let m: Awaited<ReturnType<TavernRuntime["hire"]>>;
      try {
        m = await runtime.hire(threadId, projectId, input);
      } catch (error) {
        if (error instanceof PlacementHireBlocked && error.outcome === "unknown") return error.message;
        if (error instanceof PlacementHireBlocked && input.boardQuestId) {
          const ask = k.ask(threadId, { boardQuestId: input.boardQuestId, kind: "blocker", effect: { type: "placement-blocker" }, question: "Placement blocked this hire", why: error.message.slice(0, 200), options: [{ id: "retry", label: "Retry once", detail: "Repeat this exact hire without changing its placement.", recommended: false }, { id: "stop", label: "Stop the quest", detail: "Stop rather than bypass placement.", recommended: false }], meanwhile: "No alternate placement is approved.", holds: input.waypointId ? [input.waypointId] : [] }, {}, true);
          return `Not hired. ${error.message}\n::tavern-ask{id="${ask.id}"}`;
        }
        if (error instanceof PlacementHireBlocked)
          return `Not hired. ${error.message}\n${error.placement ? `Do not hire again; the user can press Retry on placement ${error.placement.placementId}.` : "Retry this exact hire after the blocker is resolved; no machine was allocated."}`;
        if (error instanceof DetectionApprovalRequired)
          return `Not hired. ${error.message}\nAsk the user, then repeat the exact hire with detectionOnlyAskId: "${error.askId}" only if approved.\n::tavern-ask{id="${error.askId}"}`;
        throw error;
      }
      const substitutions = m.executionNotes.filter(note => /^(?:provider|model|permission|reasoning) .+ -> /.test(note));
      const firstLine = m.placementSummary + (substitutions.length ? ` Execution substitutions: ${substitutions.join(" ")} Tell the user in this turn.` : "") + "\n";
      if (m.pendingScopeAsk)
        return `${firstLine}Created ${runtime.keeper.name(m)}: ${m.threadId}. Awaiting scope approval; the original brief is queued and the member has not started.\n::tavern-ask{id="${m.pendingScopeAsk}"}`;
      const adjustments = m.executionNotes.length
        ? `\nExecution adjustments:\n${m.executionNotes.map((note) => `- ${note}`).join("\n")}\n`
        : "\n";
      const reuse = m.restingCandidates.length ? `Free hands: ${m.restingCandidates.map(candidate => `${candidate.name} (${candidate.threadId})`).join(", ")} could take a bounded re-brief; this hire was allowed.` : null;
      return `${firstLine}Hired ${runtime.keeper.name(m)}: ${m.threadId}.${m.briefPending ? " Hired, brief pending; Tavern will retry delivery. Do not hire a second member for this slot." : ""}${adjustments}${reuse ? `${reuse}\n` : ""}Write on its own line:\n${m.errand ? `::tavern-errand{member="${m.threadId}"}` : `::tavern-party{quest="${m.boardQuestId}"}`}`;
    },
  );
  register(
    "tavern_keep",
    "Kept a resting member",
    "Keep a resting quest member. until is Unix milliseconds, within the Keep limit in Settings.",
    z.object({ member: id, until: z.number().int().nonnegative(), why: z.string().trim().min(1).max(500) }),
    (input, threadId) => { runtime.keep(threadId, input.member, input.until, input.why); return `Kept ${input.member} until ${localClock(input.until)}: ${input.why}`; },
  );
  register(
    "tavern_release",
    "Released a party member",
    "Stop a member of your own party and free its allocation once stopping is confirmed. memberThreadId accepts its unique live display name or thread id. Give the reason. The reversible release appears under Decided for you; replacements still obey their per-slot budget. Two stale strikes permit release and replacement or a re-plan. Released members retain history and credit for verified work; unfinished entries no longer own or hold open the waypoint.",
    z.object({ memberThreadId: id, reason: z.string().trim().min(1).max(500) }),
    async (input, threadId) => {
      const member = k.resolvePartyMember(threadId, input.memberThreadId);
      if (await runtime.release(threadId, member.threadId, input.reason)) {
        const placement = runtime.placements().store.byMember(member.threadId);
        if (placement && ["lost", "unknown", "unpreserved"].includes(placement.preservation.source))
          return `Released ${k.name(member)}; its work was not saved: ${placement.preservation.reason}`;
        if (placement?.preservation.source === "saved" && placement.preservation.artifacts === "unknown")
          return `Released ${k.name(member)}; its source was saved; declared artifacts are unknown: ${placement.preservation.reason?.replace(/^Declared artifacts are unknown\. /, "")}`;
        return `Released ${input.memberThreadId}; its allocation is free.${placement?.preservation.artifacts === "unpreserved" ? ` ${placement.preservation.reason}` : ""}`;
      }
      const blocker = k.store.runtime(member.threadId).archiveError;
      return blocker
        ? `Release pending for ${input.memberThreadId}: ${blocker} The thread and its allocation stay held. Retry release after resolving the blocker.`
        : `Stop requested for ${input.memberThreadId}; its allocation stays held until the stop is confirmed. Tavern will retry confirmation.`;
    },
  );
  register(
    "tavern_scope",
    "Updated a member scope",
    "Narrow or request a wider scope for one member of your own party. memberThreadId accepts its unique live display name or thread id. Give the reason. Temporary paths (/tmp, /private/tmp and the host TMPDIR) and the member’s own thread storage are already writable with native write/edit and inspected shell writers; do not request them. Only grants covered by the user-controlled repo policy apply without an ask. Other widening requires an explicit, never-timed scope answer; scope permission never approves a merge, deploy, delete, send or production action. tools.allow accepts tool names or valid patterns, not shell commands such as npm test or node --test: commands are governed by the preset and shell rules. A denied widening means no widening, not a new ban on commands already allowed. Narrowing applies immediately; initial briefs wait for their scope grant and new re-briefs wait while widening is pending. Never deliver dependent work through another channel. Only the user's explicit remember-for-this-repo choice persists approved shell grants.",
    z.object({
      memberThreadId: id,
      override: scopeOverrideSchema,
      reason: z.string().trim().min(1).max(500),
    }),
    (input, threadId) => {
      if (!runtime.scopes) throw new Error("Tavern scopes are not registered");
      return runtime.scopes.override(
        threadId,
        input.memberThreadId,
        input.override,
        input.reason,
      );
    },
  );
  register(
    "tavern_tell",
    "Member brief",
    "Re-brief one of your own members, including a member that already reported done. memberThreadId accepts its unique live display name or thread id. Start an idle thread or queue behind its active turn; never steer into a running tool. Stopped or released members cannot take new work. Read the result: delivered, queued awaiting dispatch, retrying after failure, or blocked after bounded attempts. Repeat the actual delivery outcome; never call a blocked or refused brief retrying. Read Free hands for the permitted follow-up; a Warden may only re-check its rejected waypoint.",
    z.object({ memberThreadId: id, text: z.string().min(1).max(8000) }),
    async (input, threadId) => {
      const delivery = await runtime.tell(threadId, input.memberThreadId, input.text);
      switch (delivery.status) {
        case "delivered":
          return `Brief delivered to ${delivery.memberName}.`;
        case "queued":
          return `Brief queued in bb for ${delivery.memberName}; delivery is not confirmed. Do not send it again.`;
        case "retrying":
          return `Brief delivery to ${delivery.memberName} failed on attempt ${delivery.attempts} of ${runtime.config().keepers.briefRetryAttempts}; Tavern will reconcile and retry it. Do not send it again.`;
        case "blocked":
          return `Brief delivery to ${delivery.memberName} failed after ${delivery.attempts} attempts. Automatic retries have stopped; answer the brief blocker to retry or release the member.`;
      }
    },
  );
  register("tavern_hold", "Held the quest", "Hold only by citing messageId of the user’s uncancelled, unused message routed to this quest, newer than its last phase transition; its quoted text is the receipt.", z.object({ boardQuestId: id, messageId: id }), (input, threadId) => runtime.setQuestHeld(input.boardQuestId, true, { kind: "agent", threadId }, input.messageId));
  register("tavern_resume", "Resumed the quest", "Resume only by citing messageId of the user’s uncancelled, unused message routed to this quest, newer than its last phase transition; its quoted text is the receipt.", z.object({ boardQuestId: id, messageId: id }), (input, threadId) => runtime.setQuestHeld(input.boardQuestId, false, { kind: "agent", threadId }, input.messageId));
  register(
    "tavern_plan",
    "Wrote the quest map",
    "Write a quest map with done-when, owners, dependencies, lead times, review load, party and at most three questions. Set reversible:true only for fully reversible work. For routine pre-approval, inventory acts: read and workspace-write need relative paths; check needs a recognised command. Each waypoint needs check: warden, keeper, or none for an agent; you for a mark in the Keeper's journal; keeper for an outside answer recorded with tavern_gate. Warden slots name waypointIds from one maker. Await explicit greenlight before staffing; by-size can approve one party slot without open asks, questions or user or outside gates. A larger party or weaker checks need a new greenlight. For a reversible check change, fromSteer cites the user's routed steer for this quest. Emit the exact returned quest-map directive.",
    planInputSchema,
    async (input, threadId) => {
      const plan = await runtime.plan(threadId, input);
      const quest = k.quest(plan.boardQuestId);
      const standing = k.store.query("asks", "boardQuestId", quest.id, 500).find(ask => ask.effect?.type === "greenlight" && ask.effect.planVersion === plan.version && ask.answer?.preapproval)?.answer?.preapproval;
      const approval = standing ? ` ${preapprovalWords(standing)}.` :
        quest.phase === "greenlight"
          ? " Await the user's explicit greenlight for this plan."
          : quest.greenlitVersion === plan.version
          ? " Automatically greenlit by the configured by-size policy; Undo is in Decided for you."
          : quest.greenlitVersion !== null
            ? ` Staffing remains within approved plan v${quest.greenlitVersion}.`
            : " Await the user’s explicit greenlight before staffing.";
      return `Plan v${plan.version} saved.${approval} Write on its own line:\n::tavern-questmap{quest="${plan.boardQuestId}" version="${plan.version}"}${plan.fromSteer ? `\n::tavern-ledger{quest="${plan.boardQuestId}" version="${plan.version}"}` : ""}`;
    },
  );
  register(
    "tavern_settle",
    "Recorded a waypoint decision",
    "Record why you accepted a Keeper check (reported work or an answered outside gate), skipped an unsettled optional waypoint, or reopened one you accepted or skipped. Set as to accepted, skipped, or open. The reason is visible and the user can undo the call. This never awards Warden credit.",
    settleWaypointSchema,
    (input, threadId) => k.settle(threadId, input),
  );
  register(
    "tavern_ask",
    "Opened an ask",
    "Record a non-blocking user ask. Only kind decision with explicit reversible: true may carry a timed default. Merges, deploys, deletes, sends and production changes are NEVER decisions. Merge, destructive, production, sends-as-you, credential, blocker and greenlight asks require an explicit answer. Sends-as-you requires the complete recipient and draft; an answer does not execute a send or production action. To confirm words that may release a checker-handoff hold, use kind blocker, boardQuestId and releaseCheckerHandoff:true. Tavern privately pins the current hold and supplies the exact release question and options; only the user's answer releases it. Include options, a recommendation, what continues meanwhile and the held waypoints. Use a decision ask without a timer for unresolved clarification. Scope grants and blockers never default. Never use a native question tool or infer approval from chat or a timer. An answer records a choice; it does not execute a merge, deploy, deletion, send, production write or supply credentials.",
    askSchema
      .pick({
        question: true,
        why: true,
        kind: true,
        options: true,
        meanwhile: true,
        holds: true,
      })
      .extend({
        boardQuestId: optionalQuest,
        releaseCheckerHandoff: z.literal(true).optional(),
        proceedInMinutes: z.number().int().min(1).max(10080).nullish(),
        reversible: z.boolean().optional(),
        unsure: z.boolean().optional(),
        target: askSchema.shape.target.optional(),
        draft: askSchema.shape.draft.optional(),
      }),
    (input, threadId) => {
      if (input.kind === "scope")
        throw new Error(
          "Scope asks are created by tavern_hire or tavern_scope and bind the exact requested grants or detection-only hire",
        );
      if (input.kind === "greenlight")
        throw new Error(
          "Greenlight asks are created by tavern_plan so they bind to a specific plan version",
        );
      const ask = k.ask(threadId, { ...input, effect: input.kind === "blocker" ? { type: "answer-blocker" } : { type: "decision" } });
      if (ask.kind === "blocker")
        void runtime.push(threadId, ask.question, ask.why);
      return `Ask recorded. Continue the work that does not depend on it. Write on its own line:\n::tavern-ask{id="${ask.id}"}`;
    },
  );
  register(
    "tavern_decide",
    "Recorded a decision",
    "Delegated asks arrive in your Keeper lane; answer with askId and optionId, recorded with Undo, or ask the user when unsure. Quest pre-approval answers matching routine asks in code and its receipt names the user record, not your decision. Record a reversible decision with its reason. Never claim the user's consent without an answered ask. source:user is not allowed; sourceRef must reference a real user-answered ask to attribute consent. exceeds: party or rangers permits one extra hire at that soft limit and is consumed once. The review budget and keepers.partyMax are hard limits only the user lifts.",
    decisionSchema
      .pick({
        text: true,
        why: true,
        reversible: true,
        source: true,
        exceeds: true,
        askId: true, optionId: true, kind: true,
      })
      .extend({ boardQuestId: optionalQuest, sourceRef: id.nullish() }),
    async (input, threadId) => { if (input.askId) await runtime.prepareActDecision(input.askId); return k.decide(threadId, input); },
  );
  register("tavern_act_verdict", "Verified an exact act", "An assigned Warden records a verdict for a delegated merge or production change from a verified maker journal entry whose review evidence names the exact commit or command.", z.object({ askId: id, entryId: id, target: askSchema.shape.target.unwrap() }), (input, threadId) => { k.authority.recordVerdict(threadId, input.askId, input.entryId, input.target); return "Exact act verdict recorded."; }, "member");
  register(
    "tavern_rule",
    "Proposed a standing rule",
    "Save a standing rule for this Keeper by default. source message copies a user-stated rule verbatim from an applicable rule route and is active immediately. Only choose global when the user explicitly names all Keepers or all Tavern threads; otherwise keep it local and let the user widen its route receipt. Your own proposals use keeper-proposed (the default) and stay inactive until the user confirms them in the ledger.",
    z.object({
      scope: z.enum(["global", "project", "keeper", "quest"]).default("keeper"),
      boardQuestId: optionalQuest,
      text: z.string().min(1).max(500),
      source: z.enum(["message", "keeper-proposed"]).default("keeper-proposed"),
    }),
    (input, threadId, projectId) => {
      const sourceRef =
        input.source === "message"
          ? k.messageRule(
              threadId,
              input.text,
              input.scope === "quest" ? input.boardQuestId : null,
            )
          : undefined;
      if (input.scope === "quest") {
        if (!input.boardQuestId)
          throw new Error("Quest rules require boardQuestId");
        k.owned(threadId, input.boardQuestId);
        if (input.source !== "message") k.guard(threadId, input.boardQuestId);
      }
      return k.addRule(
        {
          scope: input.scope,
          scopeId:
            input.scope === "global"
              ? null
              : input.scope === "project"
                ? projectId
                : input.scope === "keeper"
                  ? threadId
                  : input.boardQuestId!,
          text: input.text,
          source: input.source,
        },
        threadId,
        sourceRef,
      );
    },
  );
  register(
    "tavern_request_sources",
    "Read the user\'s exact request",
    "Read your own frozen user-request manifest. Use the manifestId from your brief; follow nextOffset on the same sourceIndex, then nextSourceIndex with offset 0. Read every source before editing or checking when the brief omitted inline sources. Missing sources are explicit, never a paraphrase. This read grants no tools or scope.",
    requestSourceReadSchema,
    (input, threadId) => readRequestSources(k, threadId, input),
    "member",
  );
  register(
    "tavern_unarchive",
    "Brought back a member",
    "Unarchive one member in your own party by its unique name or thread id. Deleted threads are refused. A released member stays released; this does not rehire or restart it.",
    z.object({ memberThreadId: id }),
    (input, threadId) => runtime.unarchiveMember(threadId, input.memberThreadId),
  );
  register(
    "tavern_status",
    "Read the party\'s status",
    "Read bounded board state and page through reports, answers, defaults, events or pending routes. section=archived lists archived party members; use tavern_unarchive to bring one back. Use reportId and character offset for a full report and its original brief. memberThreadId accepts a unique live display name or thread id from your own party. Use section=requests with memberThreadId to inspect that member's frozen user-source manifest; page with sourceIndex and character offset. Fetch remaining facts when a digest says more remain. Page omitted rules with section=rules and use section=placement for machine rules and slots. The highest ledger version wins, configure or tick; read the needed quests after a re-anchor before acting.",
    statusInput,
    (input, threadId) => readStatus(runtime, threadId, { ...input, ...(input.memberThreadId ? { memberThreadId: k.resolvePartyMember(threadId, input.memberThreadId).threadId } : {}) }),
  );
  register(
    "tavern_wrap",
    "Reported the final summary",
    "A quest NEVER concludes itself. Open a never-timed conclude ask: Conclude for a settled map, Close early otherwise. Give a reason for unfinished work and cite fromSteer if the user asked in chat. Tell what changed and what was proved in outcome; put remaining work in left and actions in next. Do not repeat the next list. Use results.figures and results.chart for a short summary. Check renderer blocks with check_ui and fix every error. If the check tool is absent, keep the block simple; do not ask the user for it. End with the ask directive. Do not write the tale directive or archive anyone before the user answers.",
    z.object({
      boardQuestId: id,
      outcome: z.string().min(1).max(4000),
      next: z.array(z.string().trim().min(1).max(200)).max(5),
      results: taleResultsSchema.optional(),
      left: z.string().max(4000),
      reason: z.string().trim().min(1).max(500).optional(),
      fromSteer: id.optional(),
    }).strict(),
    async (input, threadId) => {
      const result = await runtime.proposeWrap(
        threadId,
        input.boardQuestId,
        input.outcome,
        input.left,
        input.next,
        input.results,
        { reason: input.reason, fromSteer: input.fromSteer },
      );
      if (!result.askId)
        return `Retold the returned quest.${result.pendingArchives.length ? ` Archiving ${result.pendingArchives.length} member(s) remains pending and will retry automatically.` : ""} Keep results.figures and results.chart as the short summary. Rich visuals are welcome in the final message: check each renderer block with its check tool when available (for example check_ui), and fix every error before sending. If the check tool is absent, keep the block simple; do not ask the user for it. Your final message is only the tale: lead with the answer, use Markdown lists or tables if useful. Do not repeat the next list; Tavern shows What to do now. Include no notes about your process or tools, and end on its own line:\n::tavern-tale{quest="${input.boardQuestId}"}`;
      return `Summary recorded. The quest has NOT concluded.\nReport that summary and let the returned Conclude or Close early card carry the decision. Keep results.figures and results.chart as the short summary. Do not say the quest returned, do not archive the party and do not write the tale directive until the user answers the ask. Rich visuals are welcome: check each renderer block with its check tool when available (for example check_ui), and fix every error before sending. Lead with the answer, use Markdown lists or tables if useful, and end on its own line:\n::tavern-ask{id="${result.askId}"}`;
    },
  );
  register(
    "tavern_report",
    "Filed a report",
    "Write a report to the Keeper's mailbox and end your turn. Include headline: one plain sentence stating the answer, at most 160 characters. A Warden headline states the check result, never a claim of independence; leave room for the same-family label when applicable. Voice is dropped for blocked and needs-decision reports. Before a done report, mark every linked entry done with evidence (or have it verified). A Warden checks rather than owns its assigned waypoint. If its review posture is same-family check (not independent), retain that exact limitation in the verdict and never call the fallback independent.",
    reportSchema
      .pick({ status: true, outcome: true, headline: true, evidence: true, artifacts: true })
      .extend({
        confidence: reportSchema.shape.confidence.default(null),
        voice: reportSchema.shape.voice.default(null),
      }),
    async (input, threadId) => {
      const report = k.report(threadId, input);
      if (report.status === "blocked" && report.keeperThreadId)
        void runtime.push(
          report.keeperThreadId,
          "Party member blocked",
          report.outcome,
        );
      const member = k.member(threadId)!;
      if (member.classId === "ranger" && report.status === "done") {
        const state = k.store.runtime(threadId);
        if (state.initialBriefAt !== undefined) {
          const minutes = (report.createdAt - state.initialBriefAt) / 60_000, timebox = state.brief?.timeboxMinutes;
          if (minutes >= 0) runtime.record("ranger.completed", { memberThreadId: threadId, minutes, overrun: timebox !== undefined && timebox !== null && minutes > timebox }, member.keeperThreadId, member.boardQuestId, `ranger-completed:${threadId}`, report.createdAt);
        }
      }
      let archiveBlocker: string | null = null;
      if (member.errand && report.status === "done") {
        archiveBlocker = await runtime.archiveMember(threadId);
      }
      const warning = report.status === "done" ? await runtime.uncommittedWarning(threadId) : null;
      return `Report written. End your turn.\nReport id: ${report.id}${archiveBlocker ? `\nArchive pending: ${archiveBlocker} The thread and its allocation stay held. Tavern will retry preservation before cleanup.` : ""}${warning ? `\n${warning}` : ""}`;
    },
    "member",
  );
  registerReady(bb, runtime);
}
