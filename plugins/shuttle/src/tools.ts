// Agent tools. Names start with shuttle_ so they never collide with PR Desk's while both run.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { errText } from "./ctx";
import { boardDetailText, boardLine, boardList, prDetail, prList } from "./format";
import type { Shuttle } from "./shuttle";

const pr = z.string().min(3).max(500).describe("The PR: its link, or a Shuttle key such as github:owner/repo#123 or delta:shop/world#2261179.");

async function run(fn: () => Promise<string> | string) {
  try {
    return { content: [{ type: "text" as const, text: await fn() }] };
  } catch (error) {
    return { content: [{ type: "text" as const, text: `Shuttle: ${errText(error)}` }], isError: true };
  }
}

const boardId = z.string().trim().min(1).max(100).describe("The board id from shuttle_boards.");
const boardName = z.string().trim().min(1).max(80).describe("The board name.");
const boardDescription = z.string().trim().max(300).optional().describe("A short description of what belongs in the board.");
const boardPrs = z.array(pr).min(1).max(200);
const boardPrsOptional = z.array(pr).max(200).optional();
const boardKey = z.string().trim().min(3).max(400).optional().describe("A canonical PR key such as github:owner/repo#123; when set, only boards containing that PR are returned.");
const boardKeysLine = (label: string, keys: string[], empty: string) => {
  if (keys.length === 0) return `${label}: ${empty}`;
  const shown = keys.slice(0, 20);
  const more = keys.length > shown.length ? ` (+${keys.length - shown.length} more)` : "";
  return `${label}: ${shown.join(", ")}${more}`;
};

export function registerTools(bb: BbPluginApi, shuttle: Shuttle): void {
  bb.agents.registerTool({
    name: "shuttle_link",
    description:
      "Link a pull request to this thread in Shuttle, on any server Shuttle knows. A thread can own several PRs (link each one, for example every PR of a stack). As owner, the thread becomes the PR's agent: Shuttle sends it the PR's new reviews, comments and failed checks (on the user's own PRs from the moment you link it, unless watch is false). A PR has one agent, so an earlier owner stays linked for reference.",
    presentation: { label: { pending: "Linking pull request", completed: "Linked pull request" } },
    parameters: z.object({
      pr,
      role: z.enum(["owner", "reference"]).optional().describe("owner (default) makes this thread the PR's agent; reference only links it."),
      watch: z.boolean().optional().describe("Send this thread the PR's new feedback (true) or not yet (false); left out, Shuttle's settings decide."),
    }),
    execute: ({ pr: query, role, watch }, tool) => run(async () => prDetail(await shuttle.link(query, tool.threadId, role ?? "owner", watch))),
  });
  bb.agents.registerTool({
    name: "shuttle_unlink",
    description: "Remove a pull request's link to this thread in Shuttle. The thread stops receiving its reviews.",
    presentation: { label: { pending: "Unlinking pull request", completed: "Unlinked pull request" } },
    parameters: z.object({ pr }),
    execute: ({ pr: query }, tool) => run(async () => prDetail(await shuttle.unlink(query, tool.threadId))),
  });
  bb.agents.registerTool({
    name: "shuttle_prs",
    description: "Shuttle's view of the pull requests linked to this thread (state, checks, review decision, agent, what happens next, unsent review items), or of one PR in detail, fetched fresh from its server.",
    presentation: { label: { pending: "Checking pull requests", completed: "Checked pull requests" } },
    parameters: z.object({ pr: pr.optional() }),
    execute: ({ pr: query }, tool) =>
      run(async () => {
        if (query) {
          const view = await shuttle.lookup(query);
          return prDetail(view, shuttle.detail(view.key).events);
        }
        return prList(shuttle.threadPrs(tool.threadId).prs, "No pull request is linked to this thread. Link one with shuttle_link.");
      }),
  });
  bb.agents.registerTool({
    name: "shuttle_boards",
    description: "Find Shuttle boards by name, optionally including archived boards or filtering by a member PR key.",
    presentation: { label: { pending: "Checking boards", completed: "Checked boards" } },
    parameters: z.object({ query: z.string().max(200).optional(), archived: z.enum(["exclude", "include", "only"]).optional(), key: boardKey }),
    execute: ({ query, archived, key }) => run(() => boardList(shuttle.boards({ query, archived, key }).boards.slice(0, 50), "No board matches that filter.")),
  });
  bb.agents.registerTool({
    name: "shuttle_board",
    description: "Inspect one Shuttle board: its summary, saved PRs with live status, and recent board activity.",
    presentation: { label: { pending: "Checking board", completed: "Checked board" } },
    parameters: z.object({ id: boardId }),
    execute: ({ id }) => run(() => boardDetailText(shuttle.board(id), { prLimit: 20, activityLimit: 10 })),
  });
  bb.agents.registerTool({
    name: "shuttle_board_create",
    description: "Create a Shuttle board, optionally seeding it with explicit PR links or keys. This does not claim PR ownership, change agents or alter feedback delivery.",
    presentation: { label: { pending: "Creating board", completed: "Created board" } },
    parameters: z.object({ name: boardName, description: boardDescription, prs: boardPrsOptional }),
    execute: ({ name, description, prs }, tool) => run(async () => boardDetailText(await shuttle.boardCreate({ name, description, prs }, tool.threadId), { prLimit: 10, activityLimit: 5 })),
  });
  bb.agents.registerTool({
    name: "shuttle_board_update",
    description: "Rename, describe, archive or restore a Shuttle board by id.",
    presentation: { label: { pending: "Updating board", completed: "Updated board" } },
    parameters: z.object({ id: boardId, name: boardName.optional(), description: boardDescription, archived: z.boolean().optional() }),
    execute: ({ id, name, description, archived }, tool) => run(() => boardLine(shuttle.boardUpdate({ id, name, description, archived }, tool.threadId).board)),
  });
  bb.agents.registerTool({
    name: "shuttle_board_add",
    description: "Add explicit PR links or keys to a Shuttle board by id. Adding is idempotent, and it never changes PR ownership, agents or feedback delivery.",
    presentation: { label: { pending: "Adding pull requests to board", completed: "Added pull requests to board" } },
    parameters: z.object({ id: boardId, prs: boardPrs }),
    execute: ({ id, prs }, tool) =>
      run(async () => {
        const out = await shuttle.boardAdd({ id, prs }, tool.threadId);
        return [boardLine(out.board), boardKeysLine("Added", out.added, "none"), boardKeysLine("Already present", out.alreadyPresent, "none")].join("\n");
      }),
  });
  bb.agents.registerTool({
    name: "shuttle_board_remove",
    description: "Remove explicit PR links or keys from a Shuttle board by id. Removing is idempotent and does not affect the PR anywhere else.",
    presentation: { label: { pending: "Removing pull requests from board", completed: "Removed pull requests from board" } },
    parameters: z.object({ id: boardId, prs: boardPrs }),
    execute: ({ id, prs }, tool) =>
      run(() => {
        const out = shuttle.boardRemove({ id, prs }, tool.threadId);
        return [boardLine(out.board), boardKeysLine("Removed", out.removed, "none")].join("\n");
      }),
  });
  bb.agents.registerTool({
    name: "shuttle_review_draft",
    description:
      "Hand your finished review of someone else's pull request to Shuttle as a draft: a summary, the verdict you suggest and each finding with its file and line. The user reads it in Shuttle, picks what to post and posts it as themselves; nothing is posted by this tool. Call it again to replace the draft.",
    presentation: { label: { pending: "Saving review draft", completed: "Saved review draft" } },
    parameters: z.object({
      pr,
      summary: z.string().trim().min(1).max(20_000).describe("The review's opening comment, as it would be posted."),
      verdict: z.enum(["comment", "approve", "changes"]).describe("The verdict you suggest; the user decides."),
      findings: z
        .array(
          z.object({
            severity: z.enum(["high", "medium", "low", "nit"]),
            path: z.string().trim().min(1).max(1000).describe("The file, relative to the repository root."),
            line: z.number().int().positive().nullable().optional().describe("The line in the new version of the file; leave out for the whole file."),
            body: z.string().trim().min(1).max(20_000).describe("The comment, as it would be posted."),
          }),
        )
        .max(100),
    }),
    execute: ({ pr: query, summary, verdict, findings }, tool) =>
      run(async () => {
        const out = await shuttle.saveDraft(tool.threadId, query, { summary, verdict, findings });
        return `Saved a draft of ${out.findings} finding${out.findings === 1 ? "" : "s"} for ${out.pr.key}. The user chooses what to post from Shuttle; do not post it yourself.`;
      }),
  });
  bb.agents.registerTool({
    name: "shuttle_feedback_done",
    description:
      "Tell Shuttle what you did with review feedback it sent you on a pull request, by the [ref …] on each item: fixed (give the commit), replied, declined, or question when you need the user's decision. The user sees it beside each comment in Shuttle.",
    presentation: { label: { pending: "Reporting on feedback", completed: "Reported on feedback" } },
    parameters: z.object({
      pr,
      items: z
        .array(
          z.object({
            ref: z.string().trim().min(4).max(20).describe("The ref Shuttle gave the item, such as 3f2a9c1d."),
            outcome: z.enum(["fixed", "replied", "declined", "question"]),
            note: z.string().max(2000).optional().describe("One line on what you did or what you need."),
            commit: z.string().max(64).optional().describe("The commit that fixed it."),
          }),
        )
        .min(1)
        .max(100),
    }),
    execute: ({ pr: query, items }, tool) =>
      run(async () => {
        const out = await shuttle.recordOutcomes(tool.threadId, query, items);
        const unknown = out.unknown.length ? ` Unknown refs: ${out.unknown.join(", ")}.` : "";
        return `Recorded ${out.recorded} of ${items.length} item${items.length === 1 ? "" : "s"} on ${out.pr.key}.${unknown}`;
      }),
  });
}
