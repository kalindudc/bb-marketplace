import { boardQuestDetailSchema } from "../../../src/shared/contract";
import { keeperNoteSchema } from "../../../src/shared/schema";
import { scopeSchema } from "../../../src/scope/schema";
import * as scenes from "./scenes";

const presets = { smith: "worktree", ranger: "readonly", warden: "checker", wanderer: "open" } as const;

export const railDetail = boardQuestDetailSchema.parse({
  ...scenes.richDetails.vault,
  decisions: Array.from({ length: 11 }, (_, i) => ({ ...scenes.richDetails.vault!.decisions[0]!, id: `rail-decision-${i}`, text: `${["Keep the staging check independent", "Draft the cutover note before the review", "Keep the DNS cut behind your explicit go"][i % 3]} (${i + 1})`, createdAt: scenes.min(i + 1) })),
  decisionsTotal: 11,
  notes: ["commitment", "fact"].map((kind, i) => keeperNoteSchema.parse({ id: `rail-note-${i}`, keeperThreadId: "thr-wren", boardQuestId: "vault", kind, text: i ? "Luc reviews the envoy manifest; the cutover still needs your go." : "Keep the production change in the agreed comms slot.", dueAt: i ? null : scenes.min(-30), condition: null, validUntil: null, sourceMessageId: null, routeId: null, state: "open", createdAt: scenes.min(i + 1), updatedAt: scenes.min(i + 1), doneAt: null, dueNotifiedAt: null })),
  scopes: scenes.vault.members.map(m => {
    const preset = presets[m.classId as keyof typeof presets];
    return { threadId: m.threadId, scope: scopeSchema.parse({
      v: 1, threadId: m.threadId, role: m.role, preset, issuedAt: scenes.min(90), failClosed: true,
      writes: { mode: preset === "open" ? "any" : preset === "worktree" ? "worktree" : "none", allow: preset === "open" ? [] : ["${tmp}", "${threadStorage}", ...(preset === "worktree" ? ["${worktree}"] : [])], deny: ["~/.ssh", "${scopesDir}"] },
      tools: { allow: preset === "open" || preset === "worktree" ? ["*"] : ["read", "grep", "bash"], deny: [], hide: preset !== "open" },
      shell: { deny: [], allow: [] }, network: "any", github: preset === "open" || preset === "worktree" ? "draft-pr-only" : "read",
      env: { poisonGh: true, blockGitPush: preset !== "open" && preset !== "worktree" }, sandbox: preset !== "open", onViolation: "block",
    }), error: null, armed: true, pendingAskId: null, mode: "enforce", problems: [] };
  }),
  violations: [],
});
