import { memberDetails } from "../member-engagement";
import { wasReleased } from "../../shared/member-engagement";
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
  planInputSchema,
  settleWaypointSchema,
  reportSchema,
  ROUTE_KINDS,
  noteDraftSchema,
  summaryDraftSchema,
  gateInputSchema,
  questNamesSchema,
} from "../../shared/schema";
import type { TavernRuntime } from "../runtime";
import { LIMITS } from "../limits";
import { readStatus, statusInput } from "../status";
import { keeperRecoveryOptions } from "../ask-effects";
import { readRequestSources } from "../request-sources";
import { requestSourceReadSchema } from "../../shared/request-source";
import { scopeOverrideSchema } from "../../scope/schema";
import { sparseTunablesSchema } from "../../shared/settings";
import { DetectionApprovalRequired } from "../guard-hire";
import { PlacementHireBlocked } from "../placement/controller";
import { agentData } from "../agent-data";
import { registerReady } from "./ready";
import { managePullRequest, pullRequestActionSchema } from "../pull-request-rules";
import { refreshQuestPullRequests } from "../conclude-pull-requests";
import { memoryToolInput } from "../../shared/memory";
import { argumentError, decideInput, judgeInput, memberInput } from "./arguments";

const id = z.string().min(1).max(120);
const optionalQuest = id.nullish();
const noteExamples = [
  '{"op":"add","kind":"fact","text":"A fact verbatim"}',
  '{"op":"add","kind":"commitment","text":"Test it","dueAt":4102444800000}',
  '{"op":"add","kind":"waiting-on-user","text":"Access","action":"Approve access","need":"Approve access."}',
] as const;
const closeNoteExample = '{"op":"done","noteId":"ID"}';
const keeperCallAsk = (id: string) => `This kind now waits for the user. No decision has been applied. Write on its own line:\n::tavern-ask{id="${id}"}`;

export function registerTools(bb: BbPluginApi, runtime: TavernRuntime) {
  const k = runtime.keeper;
  const sourceReads = new Map<string, number>();
  const register = <S extends z.ZodType>(
    name: string,
    label: string,
    description: string,
    parameters: S,
    action: (
      input: z.output<S>,
      threadId: string,
      projectId: string,
      signal: AbortSignal,
    ) => unknown | Promise<unknown>,
    role: "keeper" | "member" | ((input: z.output<S>, threadId: string) => void) = "keeper",
    inputError?: (error: z.ZodError, input: unknown) => Error,
  ) => {
    bb.agents.registerTool({
      name,
      description,
      parameters: z.toJSONSchema(parameters, { io: "input" }),
      presentation: { label: { pending: label, completed: label } },
      async execute(input, ctx) {
        if (ctx.signal.aborted)
          throw new Error(`${name} was cancelled or stopped before it began; no change was applied.`);
        if (typeof role === "string") k.require(ctx.threadId, role);
        const done = runtime.succession.track(ctx.threadId);
        let result: unknown;
        try {
          const parsed = parameters.safeParse(input);
          if (!parsed.success) throw inputError?.(parsed.error, input) ?? parsed.error;
          if (typeof role === "function") role(parsed.data, ctx.threadId);
          result = await action(parsed.data, ctx.threadId, ctx.projectId, ctx.signal);
        } catch (error) {
          if (ctx.signal.aborted)
            throw new Error(`${name} failed while its turn was cancelled or stopped; its outcome is not confirmed. Read tavern_status before retrying. Cause: ${String(error)}`, { cause: error });
          throw error;
        } finally { done(); }
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
    "tavern_memory",
    "Used durable memory",
    "Find or save project notes as data. Keepers: use unreviewed, read and curate. Never use raw shell.",
    memoryToolInput,
    (input, thread, project, signal) => runtime.memory.tool(input, thread, project, signal),
    () => {},
  );
  register(
    "tavern_refresh_keeper",
    "Requested Keeper refresh",
    "Carry your charge into a fresh Keeper. Request this only as your last tool call, after outstanding effects settle.",
    z.object({ why: z.string().trim().min(1).max(500) }).strict(),
    ({ why }, threadId) => {
      runtime.succession.request(threadId, { kind: "agent", threadId }, why);
      return "Keeper refresh requested. This charge stays here until it can move safely. The Ledger will show the result. End this turn without more tool calls.";
    },
  );
  register(
    "tavern_tune",
    "Adjusted quest pacing",
    "Override staleMinutes and reportBatchSeconds for an active quest until it ends. Requires tuning mode apply and respects user pins. Change thread-wide pacing and memory in Settings, not here. The Ranger check-in interval is a user-only budget.",
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
    "Record how the oldest unrouted user message was read. notes is REQUIRED on every route kind: separate facts, promises and hand-backs with need (see tavern_note), or []. The goal itself is never a note: open a quest for it. A steer can name one boardQuestId or several boardQuestIds when the user means multiple goals. Asides and questions must not name quests. Route the user's own standing rule as rule. Record an explicit checker-handoff hold with checkerHandoffHold: { reason }. It stays held until a user control releases it; a reporting promise never releases it. Route queued messages before quest writes. steer: apply to every named quest; ask and change nothing if targets are unclear. A still-applicable steer or new-quest route survives later messages until its following Keeper turn ends; never re-route to regain it. question: answer from the ledger or knowledge and change nothing. aside: do quick work directly, otherwise hire an errand helper with errand:true, without a board quest or waypoint; never change board quests. new-quest: open the concrete goal with tavern_quest and scout; a greeting or class selection is not a goal. rule: save the user's standing rule verbatim with tavern_rule and source:message, active for this Keeper by default; global only when the user explicitly names all Keepers or all Tavern threads. Keeper proposals wait for ledger confirmation. Promises need dueAt in Unix milliseconds.",
    z.object({
      kind: z.enum(ROUTE_KINDS),
      boardQuestId: optionalQuest,
      boardQuestIds: z.array(id).max(8).default([]),
      summary: z.string().max(300),
      notes: z.array(noteDraftSchema).max(12),
      checkerHandoffHold: checkerHandoffHoldDraftSchema.optional(),
    }),
    async (input, threadId) => {
      const route = k.route(threadId, input);
      const quests = [...new Set(input.notes.flatMap(note => note.kind === "waiting-on-user" && note.boardQuestId ? [note.boardQuestId] : []))];
      await Promise.all(quests.map(id => refreshQuestPullRequests(runtime, id)));
      return route;
    },
    "keeper", argumentError,
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
    `Add flat JSON: ${noteExamples.join("; ")}. need ≤120 chars. ${closeNoteExample} closes. Do not make promises only in chat.`,
    z.discriminatedUnion("op", [
      z.discriminatedUnion("kind", [
        noteDraftSchema.options[0].safeExtend({ op: z.literal("add") }),
        noteDraftSchema.options[1].safeExtend({ op: z.literal("add"), dueAt: noteDraftSchema.options[1].shape.dueAt.unwrap().unwrap() }),
        noteDraftSchema.options[2].safeExtend({ op: z.literal("add"), action: noteDraftSchema.options[2].shape.action.unwrap() }),
      ]),
      z.object({ op: z.literal("done"), noteId: id }).strict(),
    ]).meta({ type: "object" }),
    async (input, threadId) => {
      if (input.op === "done") return k.memory.complete(threadId, input.noteId);
      const { op, ...draft } = input;
      const note = k.memory.note(threadId, draft);
      if (note.kind !== "waiting-on-user" || !note.boardQuestId) return note;
      await refreshQuestPullRequests(runtime, note.boardQuestId);
      return { ...note, pullRequests: k.store.pullRequestsForQuest(note.boardQuestId) };
    },
    "keeper",
    (error, input) => {
      const fields = input && typeof input === "object" ? input as Record<string, unknown> : {};
      const example = fields.op === "done" ? closeNoteExample : noteExamples[fields.kind === "commitment" ? 1 : fields.kind === "waiting-on-user" ? 2 : 0];
      const detail = error.issues[0];
      const message = fields.kind === "commitment" && detail.path[0] === "dueAt" && fields.dueAt == null
        ? "A commitment needs a deadline (dueAt)" : detail.message.replace(/\.$/, "");
      return new Error(`tavern_note: ${detail.path.length ? detail.path.join(".") + ": " : ""}${message}. Use ${example}.`);
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
    "Named a board quest",
    "Open a routed goal in scout phase (op: open, the default). To rename your own unarchived quest, pass op: rename, boardQuestId, title and short. Use journal for your checklist.",
    questNamesSchema.extend({ op: z.enum(["open", "rename"]).default("open"), boardQuestId: id.optional() }).strict()
      .refine(input => (input.op === "rename") === (input.boardQuestId !== undefined), {
        path: ["boardQuestId"], message: "Pass boardQuestId only when renaming an existing quest.",
      }),
    (input, threadId) => input.boardQuestId !== undefined
      ? runtime.renameKeeperQuest(threadId, input.boardQuestId, input)
      : k.openQuest(threadId, input.title, input.short),
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
    "For repo (a bb project id), read provider input schemas, New machine per thread information, earlier Tavern picks and the matching rule recommendation. Pass a matching rule id or the Keeper's location for its own repo only. classId defaults to smith; boardQuestId includes quest rules. Consent, inputs, models and forge come from that rule. This allocates nothing.",
    z.object({ repo: id, classId: id.optional(), boardQuestId: optionalQuest }).strict(),
    (input, threadId) => runtime.placementChoices(threadId, input.repo, input.classId, input.boardQuestId),
  );
  register(
    "tavern_hire",
    "Hired a party member",
    "Hire with a bounded brief. title names the task; Tavern names the thread. Include brief.outcome (2,000 characters max), mode, out-of-scope, re-runnable done-when and context paths. Rangers need numbered questions and a check-in interval; return evidence, not the deliverable. Widening scope opens a never-timed scope ask; the brief stays queued until approval. Only the user can lift the review budget on the quest page. A reversible tavern_decide with exceeds: party or rangers allows one hire, never beyond keepers.partyMax. Scouts and errands may precede greenlight; staffing needs recorded greenlight, by default the user's explicit approval. A waypoint Warden needs a known maker journal entry. Give the maker, entries, trusted worktree and explicit check commands. The checker preset allows standard check runners there. Do not request commands as tool names; quote custom commands. One maker per Warden slot. Repeat the returned review limitation verbatim. A missing maker root must not widen scope. Prefer Pi for scoped hires. Otherwise requestDetectionOnly:true asks without hiring. After the user approves, repeat with detectionOnlyAskId. Remote and scoped local non-Pi hires detect only, not prevent; never claim hooks are installed. Unknown models refuse before allocation; set classes.<classId>.model or the rule model in Where work runs. Report execution substitutions now. Obey the approved party and replacements per slot per plan version. Resting, released and stopped members free slots. Retry or release failed or unbriefed members before replacing. Scouts need no re-plan. Call tavern_placements with repo, classId and optional boardQuestId. repo defaults to your own project, or the Warden's maker repo for a Warden. placement is {ruleId} or {kind:\"current\"} for your repo only. Only the rule sets consent, inputs, models and forge. No pick uses the matching rule or stays here for your own repo; leads take no automatic rule. Cross-repo hires carry only the pushed default-branch tip. There is no fallback model. The first line names the repo, rule or pick and target.",
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
          return `Not hired. ${error.message}\nRecovery ${ask.id} is in tavern_status. Fix placement before retrying; ask the user only for a decision you cannot make.`;
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
      return `${firstLine}Hired ${runtime.keeper.name(m)}: ${m.threadId}.${m.briefPending ? " Hired, brief pending; Tavern will retry delivery. Do not hire a second member for this slot." : ""}${adjustments}Write on its own line:\n${m.errand ? `::tavern-errand{member="${m.threadId}"}` : `::tavern-party{quest="${m.boardQuestId}"}`}`;
    },
    "keeper", argumentError,
  );
  register(
    "tavern_keep",
    "Kept a resting member",
    "Keep a resting quest member by name or id. until is Unix milliseconds, within the Keep limit in Settings.",
    memberInput({ until: z.number().int().nonnegative(), why: z.string().trim().min(1).max(500) }),
    (input, threadId) => { runtime.keep(threadId, input.member, input.until, input.why); return `Kept ${input.member} until ${localClock(input.until)}: ${input.why}`; },
  );
  register(
    "tavern_release",
    "Released a party member",
    "Release one member of your own party with member (name or id) and reason. replace:true rehires for the same waypoint. Undo a reversible release in Decided for you. Limits and credit stay. Leads call confirmRetirement:true after releasing their party and handing off PRs, then end the turn.",
    z.union([memberInput({ reason: z.string().trim().min(1).max(500), replace: z.boolean().optional() }), z.object({ confirmRetirement: z.literal(true) }).strict()]),
    async (input, threadId, projectId) => {
      if ("confirmRetirement" in input) {
        runtime.confirmLeadRetirement(threadId);
        return "Retirement confirmed. End your turn; Tavern will free the seat after cleanup.";
      }
      const member = k.resolvePartyMember(threadId, input.member);
      if (member.leadLinkId) {
        if (input.replace) throw new Error("A lead must retire before its seat can be filled. Request retirement without replace:true.");
        const state = runtime.requestLeadRetirement(threadId, member, input.reason);
        return state === "retired" ? "This lead has retired." : "Retirement requested. Tavern waits for the lead's own confirmation.";
      }
      const alreadyReleased = wasReleased(member);
      const replacement = input.replace ? await runtime.replaceMember(threadId, projectId, member.threadId, input.reason) : null;
      const released = replacement ? replacement.state !== "releasing" : await runtime.release(threadId, member.threadId, input.reason);
      if (released) {
        const { preservation } = runtime.placements().store.byMember(member.threadId) ?? {};
        const loss = preservation && ["lost", "unknown", "unpreserved"].includes(preservation.source)
          ? `its work was not saved: ${preservation.reason}`
          : preservation?.source === "saved" && preservation.artifacts === "unknown"
            ? `its source was saved; declared artifacts are unknown: ${preservation.reason?.replace(/^Declared artifacts are unknown\. /, "")}`
            : null;
        const work = loss ? `; ${loss}` : preservation?.artifacts === "unpreserved" ? `. ${preservation.reason}` : ".";
        if (replacement?.state === "replaced")
          return `Replaced ${k.name(member)} with ${replacement.threadId}${work}${replacement.briefPending ? " Check tavern_status for brief delivery." : ""}`;
        if (replacement?.state === "hiring") return `Released ${member.threadId}${work} The replacement hire is pending. Do not hire another for this slot.`;
        if (replacement?.state === "blocked") return `Released ${member.threadId}${work} Replacement not confirmed: ${replacement.message} Read tavern_status before retrying with replace:true and the same thread id.`;
        if (alreadyReleased && k.member(member.threadId)?.engagement === "archived")
          return `${member.engagement === "archived" ? "Already archived:" : "Archived"} ${k.name(member)}${work}`;
        return loss ? `Released ${k.name(member)}${work}` : `Released ${input.member}; its allocation is free${work}`;
      }
      const blocker = memberDetails(k.store, member.threadId).operation?.error;
      const pending = k.member(member.threadId)?.engagement === "archiving"
        ? `Archive pending for ${input.member}${blocker ? `: ${blocker}` : ""}. The allocation is free. Tavern will retry the archive.`
        : blocker
          ? `Release pending for ${input.member}: ${blocker} The thread and its allocation stay held. Retry release after resolving the blocker.`
          : `Stop requested for ${input.member}; its allocation stays held until the stop is confirmed. Tavern will retry confirmation.`;
      return replacement ? `${pending} Retry with replace:true and thread id ${member.threadId}; no replacement was hired yet.` : pending;
    },
    (input, threadId) => { if ("member" in input) k.require(threadId, "keeper"); },
    (error, input) => input && typeof input === "object" && "confirmRetirement" in input
      ? argumentError(error) : new Error("Give member (name or thread id) and reason, or confirmRetirement:true."),
  );
  register(
    "tavern_scope",
    "Updated a member scope",
    "Narrow or request scope for your own member with member (name or id) and reason. Temporary paths and the member’s own thread storage already allow native write/edit and inspected shell writers; do not request them. Only grants covered by the user-controlled repo policy apply without an ask. Other widening requires an explicit, never-timed scope answer; scope permission never approves a merge, deploy, delete, send or production action. tools.allow accepts tool names or valid patterns, not shell commands such as npm test or node --test: commands are governed by the preset and shell rules. A denied widening means no widening, not a new ban on commands already allowed. Narrowing applies immediately; initial briefs wait for their scope grant and new re-briefs wait while widening is pending. Never deliver dependent work through another channel. Only the user's remember-for-this-repo choice persists grants. Handle scope blocks yourself: inspect tavern_status, redirect, request scope, or release. Use repairGuard:true only if a local Pi guard needs the user to restart it.",
    z.union([
      memberInput({ override: scopeOverrideSchema, reason: z.string().trim().min(1).max(500) }),
      memberInput({ repairGuard: z.literal(true) }),
    ]).meta({ type: "object" }),
    (input, threadId) => {
      if (!runtime.scopes) throw new Error("Tavern scopes are not registered");
      if ("repairGuard" in input) {
        const ask = runtime.scopes.requestGuardRepair(threadId, input.member);
        return `Only the user can restart the Pi session.\n::tavern-ask{id="${ask.id}"}`;
      }
      return runtime.scopes.override(
        threadId,
        input.member,
        input.override,
        input.reason,
      );
    },
  );
  register(
    "tavern_tell",
    "Member brief",
    "Brief your own members using member (name or id); never steer into a running tool. Report the actual result: delivered, queued, unconfirmed, retrying, blocked or cancelled. Read Free hands for follow-up limits; a Warden may only re-check its rejected waypoint. For a correction, pass supersedeBriefId from tavern_status to replace only that unconfirmed brief.",
    memberInput({ text: z.string().min(1).max(8000), supersedeBriefId: id.optional() }),
    async (input, threadId) => {
      const delivery = await runtime.tell(threadId, input.member, input.text, input.supersedeBriefId);
      switch (delivery.status) {
        case "delivered":
          return `Brief delivered to ${delivery.memberName}.`;
        case "queued":
          return `Brief queued in bb for ${delivery.memberName}; delivery is not confirmed. Do not send it again.`;
        case "retrying":
          return `Brief delivery to ${delivery.memberName} failed on attempt ${delivery.attempts} of ${runtime.config().keepers.briefRetryAttempts}; Tavern will reconcile and retry it. Do not send it again.`;
        case "blocked":
          return `Brief delivery to ${delivery.memberName} is blocked. Automatic retries have stopped; answer the brief blocker to retry or release the member, or explicitly replace the pending brief.`;
        case "unconfirmed":
          return `bb has not confirmed the brief for ${delivery.memberName}; Tavern will check for a receipt. Do not send it again.`;
        case "pending":
          return `Brief is pending in Tavern for ${delivery.memberName}; delivery is not confirmed. Do not send it again.`;
        case "cancelled":
          return `The pending brief for ${delivery.memberName} was cleared before Tavern could confirm delivery. Read tavern_status before sending fresh work.`;
      }
    },
    "keeper", argumentError,
  );
  register(
    "tavern_judge",
    "Judged a Ranger report",
    "Use reportId and action: accept, or continue with minutes, reason and optional questionNumbers. Stop or replace with tavern_release.",
    judgeInput,
    (input, threadId) => input.action === "accept" ? runtime.acceptRangerReport(threadId, input.reportId, input.reason)
      : runtime.continueRangerReport(threadId, input.reportId, input.minutes, input.reason, input.questionNumbers),
    "keeper", argumentError,
  );
  register("tavern_hold", "Held the quest", "Hold only by citing messageId of the user’s uncancelled, unused message routed to this quest, newer than its last phase transition; its quoted text is the receipt.", z.object({ boardQuestId: id, messageId: id }), (input, threadId) => runtime.setQuestHeld(input.boardQuestId, true, { kind: "agent", threadId }, input.messageId));
  register("tavern_resume", "Resumed the quest", "Resume only by citing messageId of the user’s uncancelled, unused message routed to this quest, newer than its last phase transition; its quoted text is the receipt.", z.object({ boardQuestId: id, messageId: id }), (input, threadId) => runtime.setQuestHeld(input.boardQuestId, false, { kind: "agent", threadId }, input.messageId));
  register(
    "tavern_plan",
    "Wrote the quest map",
    "Write a quest map with done-when, owners, dependencies, lead times, review load, party and at most three questions. Set reversible:true only for fully reversible work. For routine pre-approval, inventory acts: read and workspace-write need relative paths; check needs a recognised command. Each waypoint needs check: warden, keeper, or none for an agent; you for a mark in the Keeper's journal; keeper for an outside answer recorded with tavern_gate. Warden slots name waypointIds from one maker. Await explicit greenlight before staffing; by-size can approve one party slot without open asks, questions or user or outside gates. A larger party or weaker checks need a new greenlight. For a reversible check change, fromSteer cites the user's routed steer for this quest. Limit waypoint titles to 200 and changeNote to 500 characters. Emit the returned quest-map directive.",
    planInputSchema,
    async (input, threadId) => {
      const plan = await runtime.plan(threadId, input);
      const quest = k.quest(plan.boardQuestId);
      const standing = k.store.query("asks", "boardQuestId", quest.id, 500).find(ask => ask.effect?.type === "greenlight" && ask.effect.planVersion === plan.version && ask.answer?.preapproval)?.answer?.preapproval;
      const lead = k.store.get("leadPlans", `${quest.id}:${plan.version}`);
      const approval = lead ? lead.lane === "keeper" ? " The hiring Keeper decides on this exact version. Do not staff it yet." : " This exact plan waits for the user's answer." :
        standing ? ` ${preapprovalWords(standing)}.` :
        quest.phase === "greenlight"
          ? " Await the user's explicit greenlight for this plan."
          : quest.greenlitVersion === plan.version
          ? " Automatically greenlit by the configured by-size policy; Undo is in Decided for you."
          : quest.greenlitVersion !== null
            ? ` Staffing remains within approved plan v${quest.greenlitVersion}.`
            : " Await the user’s explicit greenlight before staffing.";
      return `Plan v${plan.version} saved.${approval} Write on its own line:\n::tavern-questmap{quest="${plan.boardQuestId}" version="${plan.version}"}${plan.fromSteer ? `\n::tavern-ledger{quest="${plan.boardQuestId}" version="${plan.version}"}` : ""}`;
    },
    "keeper", argumentError,
  );
  register(
    "tavern_settle",
    "Recorded a waypoint decision",
    "Record why you accepted a Keeper check (reported work or an answered outside gate), skipped an unsettled optional waypoint, or reopened one you accepted or skipped. Set as to accepted, skipped, or open. The reason is visible and the user can undo the call. This never awards Warden credit.",
    settleWaypointSchema,
    (input, threadId) => { const result = k.settle(threadId, input); return "question" in result ? keeperCallAsk(result.id) : result; },
  );
  register(
    "tavern_ask",
    "Opened an ask",
    "Ask only when the user must choose. Only kind decision with explicit reversible: true may carry a timed default. Merge, destructive, production, sends-as-you, credential, blocker, greenlight and cluster-write asks require an explicit answer. Cluster writes need target.command, change, known undo and runThreadId for a member. Approve and confirm each run on its card. Use shellGrant.heldEventId for held shell acts or heldCommunicationAskId for held messages (dismiss:true to discard). Give the full sends-as-you draft and recipient. For checker handoff, use blocker, boardQuestId and releaseCheckerHandoff:true. Include options, recommendation, what continues and held waypoints. For an existing merge, give mergeAskId, action ask-user or withdraw, and reason. Chat and timers give no approval. Never use native question tools. Answers do not execute acts or supply credentials.",
    z.union([askSchema
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
        target: askSchema.shape.target,
        change: askSchema.shape.change,
        runThreadId: askSchema.shape.runThreadId,
        undo: askSchema.shape.undo,
        draft: askSchema.shape.draft.optional(),
        shellGrant: z.union([
          z.object({ heldEventId: z.string().min(1).max(420) }).strict(),
          z.object({ memberThreadId: z.string().min(1).max(200), command: z.string().min(1).max(8000) }).strict(),
        ]).optional(),
      }).strict(),
      z.object({ heldCommunicationAskId: id, dismiss: z.literal(true).optional() }).strict(),
      z.object({ mergeAskId: id, action: z.enum(["ask-user", "withdraw"]), reason: z.string().trim().min(1).max(500) }).strict(),
    ]).meta({ type: "object" }),
    (input, threadId) => {
      if ("mergeAskId" in input) {
        const ask = k.changeMergeAsk(threadId, input.mergeAskId, input.action, input.reason);
        return input.action === "withdraw" ? `Merge ask ${ask.id} withdrawn; no run is authorized.` : `Merge ask ${ask.id} now waits for the user.\n::tavern-ask{id="${ask.id}"}`;
      }
      if ("heldCommunicationAskId" in input) {
        const ask = k.reviewHeldCommunication(threadId, input.heldCommunicationAskId, input.dismiss);
        if (!ask) return "Held message dismissed. Nothing was sent or drafted.";
        return ask.lane === "user" ? `Held message reviewed.\n::tavern-ask{id="${ask.id}"}` : "Held message reviewed; use tavern_decide in your delegated lane.";
      }
      if (input.shellGrant) {
        if (!runtime.scopes) throw new Error("Shell grants are unavailable.");
        if (input.proceedInMinutes != null) throw new Error("Shell grant asks never default.");
        const ask = runtime.scopes.askAct(threadId, { ...input.shellGrant, why: input.why, unsure: input.unsure, draft: input.draft });
        return `Ask recorded. Continue unrelated work. Write on its own line:\n::tavern-ask{id="${ask.id}"}`;
      }
      if (input.kind === "scope")
        throw new Error(
          "Scope asks are created by tavern_hire or tavern_scope and bind the exact requested grants or detection-only hire",
        );
      if (input.kind === "greenlight")
        throw new Error(
          "Greenlight asks are created by tavern_plan so they bind to a specific plan version",
        );
      if (input.kind === "blocker" && !input.releaseCheckerHandoff)
        throw new Error("Handle the block first. If only the user can decide, use an untimed decision with the choices that would unblock it.");
      const ask = k.ask(threadId, { ...input, effect: { type: "decision" } });
      if (ask.kind === "merge" && ask.lane === "keeper")
        return `Merge ask ${ask.id} is in the Keeper lane, not shown to the user. Use tavern_decide with source keeper after the Warden verdict, or hand it to the user with tavern_ask: mergeAskId "${ask.id}", action "ask-user", and reason.`;
      return `Ask recorded. Continue the work that does not depend on it. Write on its own line:\n::tavern-ask{id="${ask.id}"}`;
    },
  );
  register(
    "tavern_decide",
    "Recorded a decision",
    "Record a reversible decision with Undo. Give text, why, reversible, unsure:false, change, audience and undo. For a plain call give options and coverageKind: route, rule or answer with coverageId, or plan with planVersion and waypointId. For answers use askId and optionId instead; source keeper answers your lane, source ask records the user's exact answer. Never claim the user's consent without an answered ask. Use leadPlan for a linked plan; exceeds: party or rangers permits one hire within hard limits.",
    decideInput,
    async (input, threadId) => {
      if (input.askId && input.optionId !== undefined && input.source === "keeper") {
        const ask = k.store.get("asks", input.askId), effect = ask?.effect;
        if (ask && effect && keeperRecoveryOptions(effect)) {
          if (input.source !== "keeper" || input.unsure || !input.reversible || ask.boardQuestId !== (input.boardQuestId ?? null) || (input.kind && input.kind !== ask.kind))
            throw new Error("Keeper recovery needs the exact quest and option, source keeper, reversible:true and unsure:false.");
          await runtime.resolveKeeperBlocker(threadId, input.askId, input.optionId, input.why);
          return "Keeper recovery recorded. Check tavern_status for the outcome.";
        }
        if (effect?.type === "conclude" && effect.draft.lead) {
          if (input.source !== "keeper") throw new Error("The hiring Keeper receives the child outcome as its own call.");
          return runtime.answerLeadConclude(threadId, input.askId, input.boardQuestId, input.optionId, input.why, input.consequence, input.unsure);
        }
        if (!input.unsure) await runtime.prepareActDecision(input.askId);
      }
      const result = k.decideOrAsk(threadId, input);
      return "question" in result ? keeperCallAsk(result.id) : result;
    },
    "keeper", argumentError,
  );
  register("tavern_act_verdict", "Verified an exact act", "An assigned Warden records a verdict for a delegated merge or production change from a verified maker journal entry whose review evidence names the exact commit or command.", z.object({ askId: id, entryId: id, target: askSchema.shape.target.unwrap() }), (input, threadId) => { k.authority.recordVerdict(threadId, input.askId, input.entryId, input.target); return "Exact act verdict recorded."; }, "member");
  register(
    "tavern_rule",
    "Proposed a standing rule",
    "A source message rule is active immediately. Copy the user verbatim from a rule route or cite a party user.told-member receiptId as sourceMessageId. For a correction give supersedesRuleId in the same scope. Default to this Keeper; global requires explicit words covering all Keepers or Tavern threads. Proposals stay inactive until the user confirms.",
    z.object({
      scope: z.enum(["global", "project", "keeper", "quest"]).default("keeper"),
      boardQuestId: optionalQuest,
      text: z.string().min(1).max(500),
      source: z.enum(["message", "keeper-proposed"]).default("keeper-proposed"),
      sourceMessageId: id.optional(),
      supersedesRuleId: id.optional(),
    }).strict(),
    (input, threadId, projectId) => {
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
        { sourceMessageId: input.sourceMessageId, supersedesRuleId: input.supersedesRuleId },
      );
    },
  );
  register(
    "tavern_request_sources",
    "Read the user\'s exact request",
    "Read your own frozen user-request manifest. Use the manifestId from your brief; follow nextOffset on the same sourceIndex, then nextSourceIndex with offset 0. Read every source before editing or checking when the brief omitted inline sources. Missing sources are explicit, never a paraphrase. This read grants no tools or scope.",
    requestSourceReadSchema,
    (input, threadId) => {
      const key = JSON.stringify([threadId, input.manifestId, input.sourceIndex, input.offset]), now = k.now();
      const last = sourceReads.get(key);
      if (last !== undefined && now - last < 60_000)
        throw new Error(`Request ${input.manifestId} sourceIndex=${input.sourceIndex} offset=${input.offset} was already read or refused. Use the previous result instead of repeating this request.`);
      sourceReads.delete(key);
      if (sourceReads.size >= 512) sourceReads.delete(sourceReads.keys().next().value!);
      sourceReads.set(key, now);
      return readRequestSources(k, threadId, input);
    },
    "member",
  );
  register(
    "tavern_unarchive",
    "Brought back a member",
    "Unarchive one member in your own party using member (name or id). Deleted threads are refused. A released member stays released; this does not rehire or restart it.",
    memberInput({}),
    (input, threadId) => runtime.unarchiveMember(threadId, input.member),
  );
  register(
    "tavern_status",
    "Read the party\'s status",
    "Read bounded board state. section=pending shows unrouted messages and pending member briefs. Page reports, asks, events or rules. Use reportId and character offset for the full report and brief. The summary lists released threads you can archive with tavern_release. member accepts a unique live name or thread ID. section=requests shows that member's frozen sources; page by sourceIndex and offset. section=placement shows machine rules and slots. Fetch omitted facts and re-read affected quests after a re-anchor.",
    statusInput,
    ({ member, memberThreadId, ...input }, threadId) => {
      const reference = member ?? memberThreadId;
      return readStatus(runtime, threadId, { ...input, memberThreadId: reference ? k.resolvePartyMember(threadId, reference).threadId : null });
    },
    "keeper", argumentError,
  );
  register("tavern_pull_request", "Recorded a pull request action",
    "Manage a quest PR by id: ready (optional reviewers) needs the Warden’s full commit in journal review evidence; Undo returns it to draft. Close records why; comment replies on your quest’s PR. For others, draft the URL, operation and full text; in your lane, give the quest and the literal gh or dt command with full URL, allowed once. unsure:true asks the user.",
    pullRequestActionSchema, (input, threadId) => managePullRequest(runtime, threadId, input),
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
      if ("hiringKeeper" in result && result.hiringKeeper) return "Summary recorded. The hiring Keeper has the child’s conclusion request. Do not tell the tale or archive the party before it answers.";
      return `Summary recorded. The quest has NOT concluded.\nReport that summary and let the returned Conclude or Close early card carry the decision. Keep results.figures and results.chart as the short summary. Do not say the quest returned, do not archive the party and do not write the tale directive until the user answers the ask. Rich visuals are welcome: check each renderer block with its check tool when available (for example check_ui), and fix every error before sending. Lead with the answer, use Markdown lists or tables if useful, and end on its own line:\n::tavern-ask{id="${result.askId}"}`;
    },
  );
  register(
    "tavern_report",
    "Filed a report",
    "Write a report to the Keeper's mailbox and end your turn. Give a headline of at most 160 characters. A Warden headline states the result, never a claim of independence; keep the same-family check (not independent) label. Before done, mark every linked entry done with evidence or have it verified. Use wait with condition and dueAt for a reminder. Ranger: at check-in, report checkpoint with numbered answers, evidence and checkpoint {left, moreMinutes}. Checkpoint and done wait for your Keeper.",
    reportSchema
      .pick({ status: true, outcome: true, headline: true, evidence: true, artifacts: true, wait: true, checkpoint: true })
      .extend({
        confidence: reportSchema.shape.confidence.default(null),
      }),
    async (input, threadId) => {
      const report = k.report(threadId, input);
      const member = k.member(threadId)!;
      if (member.rangerCheckpointReportId === report.id)
        return `Report written. End your turn and wait for the Keeper to accept, continue or release you.\nReport id: ${report.id}`;
      let archiveBlocker: string | null = null;
      if (member.errand && member.classId !== "ranger" && report.status === "done") {
        archiveBlocker = await runtime.archiveMember(threadId, report.id);
      }
      const warning = report.status === "done" ? await runtime.uncommittedWarning(threadId) : null;
      return `Report written. End your turn.\nReport id: ${report.id}${archiveBlocker ? `\nArchive pending: ${archiveBlocker} The thread and its allocation stay held. Tavern will retry preservation before cleanup.` : ""}${warning ? `\n${warning}` : ""}`;
    },
    "member",
  );
  registerReady(bb, runtime);
}
