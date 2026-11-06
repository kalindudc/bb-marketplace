// Loom writes commit subjects as a reviewer reads git history: the change's title, or a merge as git names one
// ("Merge origin/main into <branch>"). No ticket key at the start, and no "(Loom)" or "Loom:".
import { beforeEach, describe, expect, it } from "vitest";
import { templateText } from "../src/pr-text";
import { mergeSubject } from "../src/prompts";
import { blockTicket } from "../src/workers";
import { makeCtx, seedProject, startWorker, ticketOf, type EngineHarness } from "./helpers";

let h: EngineHarness;
beforeEach(() => {
  h = makeCtx();
});

describe("commit subjects Loom writes", () => {
  it("names a merge as git does, each source once, with no ticket key", () => {
    expect(mergeSubject(["origin/main"], "loom/csv/csv-1")).toBe("Merge origin/main into loom/csv/csv-1");
    expect(mergeSubject(["loom/csv/csv-1", "origin/main", "origin/main"], "loom/csv/csv-2")).toBe("Merge loom/csv/csv-1 and origin/main into loom/csv/csv-2");
  });

  it("commits a worker's unfinished work as WIP with the change's title, not its key", async () => {
    await seedProject(h);
    const row = await startWorker(h);
    h.host.worktree(`/wt/${row.environment_id}`).dirty = true;
    await blockTicket(h.ctx, ticketOf(h, "CSV-1"), { reason: "stuck", needs: "", actor: "human" });
    const wip = h.host.callsTo("commitAll").at(-1)!.message;
    expect(wip).toBe("WIP: Order rows");
  });

  it("gives the template's commits the title, and a fix round's commit a plain subject", async () => {
    await seedProject(h, (doc) => void (doc.merge = { strategy: "pr" }));
    const ticket = ticketOf(h, "CSV-1");
    h.store.updateTicket(ticket.id, { head_sha: "c1" });
    expect(templateText(ticketOf(h, "CSV-1"), null).commit).toBe("Order rows");
    h.store.updateTicket(ticket.id, { pr_branch: "loom/csv/csv-1", pushed_sha: "sq1", pr_rounds: 2 });
    expect(templateText(ticketOf(h, "CSV-1"), null).commit).toBe("Address review feedback");
  });
});
