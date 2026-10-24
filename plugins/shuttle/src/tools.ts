// Agent tools. Names start with shuttle_ so they never collide with PR Desk's while both run.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { errText } from "./ctx";
import { prDetail, prList } from "./format";
import type { Shuttle } from "./shuttle";

const pr = z.string().min(3).max(500).describe("The PR: its link, or a Shuttle key such as github:owner/repo#123 or delta:shop/world#2261179.");

async function run(fn: () => Promise<string> | string) {
  try {
    return { content: [{ type: "text" as const, text: await fn() }] };
  } catch (error) {
    return { content: [{ type: "text" as const, text: `Shuttle: ${errText(error)}` }], isError: true };
  }
}

export function registerTools(bb: BbPluginApi, shuttle: Shuttle): void {
  bb.agents.registerTool({
    name: "shuttle_link",
    description:
      "Link a pull request to this thread in Shuttle, on any server Shuttle knows. A thread can own several PRs (link each one, for example every PR of a stack). As owner, the thread receives new reviews on the PR when it is watched; your own PRs are watched as soon as you link them, unless watch is false.",
    presentation: { label: { pending: "Linking pull request", completed: "Linked pull request" } },
    parameters: z.object({
      pr,
      role: z.enum(["owner", "reference"]).optional().describe("owner (default) receives watched reviews; reference only links it."),
      watch: z.boolean().optional().describe("Watch the PR (true) or not (false); left out, Shuttle's auto-watch setting decides."),
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
    description: "Shuttle's view of the pull requests linked to this thread (state, checks, review decision, watch, unsent review items), or of one PR in detail, fetched fresh from its server.",
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
}
