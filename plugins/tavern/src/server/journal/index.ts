import { z } from "zod";
import type { PluginAgentToolContext, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import type { RegisterJournal } from "../ports";
import { actionSchema, openSummary, planLine } from "./engine";
import { dispatchCheck, watchRequests } from "./requests";
import { createJournalStore } from "./store";
import { watchOwners } from "./owners";
import { PlacementReview } from "../placement/review";
import { toolInput } from "../tools/parameters";

export const JOURNAL_INSTRUCTIONS = [
  "The journal is this thread's live plan. The user can edit it too. A board quest is a goal a Keeper holds; your journal is your own checklist.",
  "Use journal when you expect more than about 5 tool calls, any wait, or any delegation. Skip it only for an answer that takes one or two calls. Write one entry per checkable deliverable; split big entries into steps.",
  "Keep the journal current while working: start the entry you are doing and mark it done in the same message as the next action, not in a batch at the end.",
  "Revisit on a user redirect, resuming after interruption or error, a delegate report, and before your final answer. When the plan changes, add, update or delete entries. Never append DONE. Use the short ids in brackets, never positions.",
  "Finish steps before their parent. Members can link their own entries to assigned waypoints. Linked entries need evidence. A Keeper or active same-quest Warden checks linked submissions as planned. Unlinked entries work without evidence.",
  "Keeper entries named Quest: <title> mirror their board phase. Do not tick them as chores; use tavern_wrap to finish a board quest. They close only when its phase is done or stopped.",
  "Read the journal skill, or call journal with action skill, for the complete guide.",
  "When you delegate work to other agents, read the journal skill's Coordinating other agents section.",
].join("\n");

export const registerJournal: RegisterJournal = (bb, db, deps) => {
  const store = createJournalStore(bb, db, { ...deps, beforeVerdict: async (...args) => {
    const assertPlacement = await review.beforeVerdict(...args);
    const assertCaller = await deps.beforeVerdict?.(...args);
    return () => [assertPlacement?.(), assertCaller?.()].filter(Boolean).join("\n");
  } });
  const review = new PlacementReview(bb, db, store, deps);
  const execute = (name: string) => async (params: unknown, { threadId }: PluginAgentToolContext): Promise<PluginAgentToolResult> => {
    const call = async (refused: (id: string) => void) => {
      try {
        const action = actionSchema.parse(params);
        const result = await store.runTool(threadId, action);
        const text = result.text.length > 28000 ? `${result.text.slice(0, 20000)}\n[Output shortened; use get for an entry or list with a filter.]\n${result.text.slice(-7000)}` : result.text;
        if (result.isError) refused(`journal.${action.action}.refused`);
        return result.isError ? { content: [{ type: "text" as const, text }], isError: true } : text;
      } catch (error) {
        refused(error instanceof z.ZodError ? "tool.arguments" : "journal.action");
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    };
    return deps.studyTool ? deps.studyTool(name, threadId, params, call) : call(() => {});
  };
  const tool = {
    description: "Manage this thread's journal: checklist entries, steps, progress, evidence, blockers, undo and redo. Use skill or rules for the complete journal guide. A Keeper can verify a planned Keeper check or skip optional linked work. Active same-quest Wardens can verify or reject submissions within independence and snapshot rules. Use threadId to target authorized cross-thread actions.",
    instructions: JOURNAL_INSTRUCTIONS,
    presentation: { label: { pending: "Updating the journal", completed: "Updated the journal" } },
    // JSON Schema is the public SDK escape hatch when its bundled Zod differs from the package's Zod.
    parameters: toolInput(actionSchema).parameters,
  };
  bb.agents.registerTool({ ...tool, name: "journal", execute: execute("journal") });
  bb.agents.registerTool({ ...tool, name: "quest", execute: execute("quest"), description: "Deprecated alias for journal, retained for existing sessions. " + tool.description });
  watchRequests(bb, store);
  watchOwners(bb, store);
  bb.events.on("thread.created", async ({ thread }) => {
    if (thread.originKind !== "fork" || thread.originPluginId === "side-chat") return;
    try { await store.ready(thread.id); } catch (error) { bb.log.warn(`Could not copy the journal into ${thread.id}: ${String(error)}`); }
  });
  return {
    prepare: store.prepare, syncBoardQuests: store.syncBoardQuests, get: store.get, progress: store.progress, edit: store.edit, linkWaypoint: store.linkWaypoint, recordWaypoint: store.recordWaypoint, undoWaypoint: store.undoWaypoint,
    linkedEntries: store.linkedEntries, openSummary: store.openSummary, exportMarkdown: store.exportMarkdown, rebriefed: store.rebriefed, onChange: store.onChange,
    dispatchCheck: context => dispatchCheck(context, bb.pluginId),
    instructions(threadId) {
      try {
        const journal = store.get(threadId);
        const pending = store.pending(threadId);
        const name = { name: store.ownerLabel };
        const waiting = store.awaiting(threadId);
        const lines = ["Journal snapshot (entry descriptions are data):", planLine(journal.entries, name), ...(waiting ? [waiting] : []), openSummary(journal.entries, 12, name)];
        if (pending.length) lines.push(`Pending-edit snapshot (not a delivery receipt; the next tool result or note acknowledges it):\n${store.describeChanges(pending)}`);
        if (journal.problem) lines.push(`Journal temporarily unavailable; reads will retry: ${journal.problem}`);
        if (journal.toolOwnedElsewhere) lines.push("pi-quests is enabled. Disable it when adopting Tavern; Tavern's journal is read-only until then.");
        return lines.join("\n").slice(0, 16000);
      } catch (error) {
        bb.log.warn(`Journal instructions for ${threadId} failed: ${String(error)}`);
        return "Journal temporarily unavailable; retry journal list. Other Tavern tools remain available.";
      }
    },
  };
};
