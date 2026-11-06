// A stored value that does not match its schema stays on its own ticket: the engine blocks that ticket and says why, once,
// every other ticket keeps moving, and the project page renders with the problem on the ticket's card.
import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectView, TicketDetail } from "../src/contract";
import { registerRpc } from "../src/rpc";
import { readSub, shown } from "../src/sub-state";
import { FakePort, makeEngine, makeHost, reachApproved, seedProject, ticketOf } from "./helpers";

const BAD_HANDBACK = '{"thread":"orphan","text":{"summary":"old message"},"waiting":0}';
const BAD_META = '{"at":1,"review":null,"base":null}';

let h: ReturnType<typeof makeEngine>;
beforeEach(() => {
  h = makeEngine();
});

const project = () => h.store.projectBySlug("csv")!;
const unreadablePosts = (key: string) => h.store.posts(ticketOf(h, key).id).filter((post) => (JSON.parse(post.data_json) as { unreadable?: string }).unreadable !== undefined);
const warnings = (column: string) => h.bb.callsTo("log").filter(([level, message]) => level === "warn" && String(message).includes(column));
const independent = (doc: Record<string, any>) => (doc.ticket[1].depends_on = []);

describe("a malformed sub-state on one ticket", () => {
  it("on a blocked ticket, leaves every other ticket moving, and says so once on that ticket", async () => {
    await seedProject(h, independent);
    h.store.setTicketState(ticketOf(h, "CSV-2").id, "blocked", "human");
    h.store.updateTicket(ticketOf(h, "CSV-2").id, { handback_json: BAD_HANDBACK });
    await h.engine.tick();
    await h.engine.tick();
    expect(ticketOf(h, "CSV-1").state).toBe("working");
    expect(project().state).toBe("running");
    expect(ticketOf(h, "CSV-2")).toMatchObject({ state: "blocked", handback_json: BAD_HANDBACK });
    expect(unreadablePosts("CSV-2")).toHaveLength(1);
    expect(unreadablePosts("CSV-2")[0]!.body).toContain("handback_json");
    expect(warnings("handback_json")).toHaveLength(1);
  });

  it("on a ticket at work, blocks that ticket with a post naming the column, keeps its value, and starts the others", async () => {
    await seedProject(h, independent);
    const bad = '{"role":"worker","tries":"one"}';
    h.store.updateTicket(ticketOf(h, "CSV-2").id, { start_wait_json: bad });
    await h.engine.tick();
    await h.engine.tick();
    expect(ticketOf(h, "CSV-1").state).toBe("working");
    expect(ticketOf(h, "CSV-2")).toMatchObject({ state: "blocked", start_wait_json: bad });
    expect(ticketOf(h, "CSV-2").blocked_reason).toContain("start_wait_json");
    expect(unreadablePosts("CSV-2")).toHaveLength(1);
    expect(project().state).toBe("running");
    // The block is triage's to hear of, as every block Loom makes is.
    expect(project().triage_pending === 1 || project().triage_round > 0).toBe(true);
    expect(warnings("start_wait_json")).toHaveLength(1);
  });

  it("on a ticket the merge queue takes, blocks that ticket instead of pausing the project", async () => {
    await seedProject(h, (doc) => {
      independent(doc);
      doc.merge = { strategy: "pr" };
    });
    await reachApproved(h, "CSV-1");
    h.store.updateTicket(ticketOf(h, "CSV-1").id, { pr_text_json: '{"head":1}' });
    await h.engine.tick();
    await h.engine.tick();
    expect(project().state).toBe("running");
    expect(ticketOf(h, "CSV-1").state).toBe("blocked");
    expect(ticketOf(h, "CSV-1").blocked_reason).toContain("pr_text_json");
    expect(ticketOf(h, "CSV-2").state).toBe("working");
  });
});

describe("a read that only displays", () => {
  it("reads a malformed value as absent and reports it, instead of throwing", () => {
    const row = { id: 7, key: "CSV-7", state: "pr_open", pr_meta_json: BAD_META };
    expect(() => readSub(row, "pr_meta_json")).toThrow(/pr_meta_json of ticket CSV-7/u);
    const read = shown(() => readSub(row, "pr_meta_json"));
    expect(read.value).toBeNull();
    expect(read.unreadable.map((problem) => [problem.key, problem.column])).toEqual([["CSV-7", "pr_meta_json"]]);
  });

  it("lets the project page and the ticket render, with the problem on the ticket's card", async () => {
    const fake = new FakePort();
    const host = makeHost({ port: fake });
    registerRpc(host.bb, { projects: host.projects, engine: host.engine, store: host.store, now: Date.now });
    const call = <T>(method: string, input?: unknown) => host.harness.behavior.callRpc(method, input) as Promise<T>;
    await host.projects.propose({ toml: (await import("./helpers")).specToml((doc) => (doc.merge = { strategy: "pr" })), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_env" });
    await host.projects.approve("csv", "human");
    const csv2 = host.store.ticketByKey("CSV-2")!;
    host.store.setTicketState(csv2.id, "blocked", "human");
    host.store.updateTicket(csv2.id, { pr_meta_json: BAD_META });
    host.store.updateTicket(host.store.ticketByKey("CSV-1")!.id, { pr_meta_json: BAD_META });
    const view = await call<ProjectView>("project", { slug: "csv" });
    const card = (key: string) => view.board.find((each) => each.key === key)!;
    expect(card("CSV-1").unreadable).toContain("pr_meta_json");
    expect(card("CSV-2").unreadable).toContain("pr_meta_json");
    await expect(call<TicketDetail>("ticket", { key: "CSV-1" })).resolves.toMatchObject({ key: "CSV-1" });
  });
});
