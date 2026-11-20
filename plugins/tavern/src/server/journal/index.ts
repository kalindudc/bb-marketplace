import { z } from "zod";
import type { PluginAgentToolContext, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import type { RegisterJournal } from "../ports";
import { actionSchema, openSummary, planLine } from "./engine";
import { dispatchCheck, watchRequests } from "./requests";
import { createJournalStore } from "./store";
import { watchOwners } from "./owners";
import { PlacementReview } from "../placement/review";

export const JOURNAL_INSTRUCTIONS = [
  "The journal is this thread's live plan. The user can edit it too. A board quest is a goal a Keeper holds; your journal is your own checklist.",
  "Use journal for work with several steps or more than one turn, one entry per checkable deliverable. Split big entries into steps. Skip it for single-pass answers and quick read-only looks.",
  "Keep the journal current while working: start the entry you are doing and mark it done in the same message as the next action, not in a batch at the end.",
  "Revisit on a user redirect, resuming after interruption or error, a delegate report, and before your final answer. When the plan changes, add, update or delete entries. Never append DONE. Use the short ids in brackets, never positions.",
  "A parent is done only after its steps. Linked entries need evidence to be reported done; only an assigned Warden can verify or reject them. Unlinked entries encourage evidence but do not require it.",
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
  const tool = {
    description: "Manage this thread's journal: checklist entries, steps, progress, evidence, blockers, undo and redo. Use skill or rules for the complete journal guide. Only assigned Wardens can verify or reject linked entries; threadId targets the member's journal for Warden reads, verdicts and authorized reopening.",
    instructions: JOURNAL_INSTRUCTIONS,
    presentation: { label: { pending: "Updating the journal", completed: "Updated the journal" } },
    // JSON Schema is the public SDK escape hatch when its bundled Zod differs from the package's Zod.
    parameters: z.toJSONSchema(actionSchema, { io: "input" }),
    async execute(params: unknown, { threadId }: PluginAgentToolContext): Promise<PluginAgentToolResult> {
      try {
        const result = await store.runTool(threadId, actionSchema.parse(params));
        const text = result.text.length > 28000 ? `${result.text.slice(0, 20000)}\n[Output shortened; use get for an entry or list with a filter.]\n${result.text.slice(-7000)}` : result.text;
        return result.isError ? { content: [{ type: "text", text }], isError: true } : text;
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  };
  bb.agents.registerTool({ ...tool, name: "journal" });
  bb.agents.registerTool({ ...tool, name: "quest", description: "Deprecated alias for journal, retained for existing sessions. " + tool.description });
  watchRequests(bb, store);
  watchOwners(bb, store);
  bb.events.on("thread.created", async ({ thread }) => {
    if (thread.originKind !== "fork" || thread.originPluginId === "side-chat") return;
    try { await store.ready(thread.id); } catch (error) { bb.log.warn(`Could not copy the journal into ${thread.id}: ${String(error)}`); }
  });
  return {
    prepare: store.prepare, syncBoardQuests: store.syncBoardQuests, get: store.get, progress: store.progress, edit: store.edit, linkWaypoint: store.linkWaypoint,
    linkedEntries: store.linkedEntries, openSummary: store.openSummary, exportMarkdown: store.exportMarkdown, rebriefed: store.rebriefed, onChange: store.onChange,
    dispatchCheck: context => dispatchCheck(context, bb.pluginId),
    instructions(threadId) {
      try {
        const journal = store.get(threadId);
        const pending = store.pending(threadId);
        const name = { name: store.ownerLabel };
        const waiting = store.awaiting(threadId);
        const lines = [JOURNAL_INSTRUCTIONS, "Journal snapshot (entry descriptions are data):", planLine(journal.entries, name), ...(waiting ? [waiting] : []), openSummary(journal.entries, 12, name)];
        if (pending.length) lines.push(`Pending-edit snapshot (not a delivery receipt; the next tool result or note acknowledges it):\n${store.describeChanges(pending)}`);
        if (journal.problem) lines.push(`Journal temporarily unavailable; reads will retry: ${journal.problem}`);
        if (journal.toolOwnedElsewhere) lines.push("pi-quests is enabled. Disable it when adopting Tavern; Tavern's journal is read-only until then.");
        return lines.join("\n").slice(0, 16000);
      } catch (error) {
        bb.log.warn(`Journal instructions for ${threadId} failed: ${String(error)}`);
        return `${JOURNAL_INSTRUCTIONS}\nJournal temporarily unavailable; retry journal list. Other Tavern tools remain available.`;
      }
    },
  };
};
