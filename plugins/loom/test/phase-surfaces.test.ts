import { describe, expect, it } from "vitest";
import type { ProjectView, TicketDetail } from "../src/contract";
import { registerRpc } from "../src/rpc";
import { createCli } from "../src/cli";
import { makeHost, specToml } from "./helpers";
import { phased } from "./phase-fixtures";

describe("phase surfaces", () => {
  async function setup() {
    const h = makeHost();
    registerRpc(h.bb, { projects: h.projects, engine: h.engine, store: h.store, now: Date.now });
    h.bb.cli.register(createCli(h.projects, h.engine, h.store, Date.now));
    await h.projects.propose({ toml: specToml(phased), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_env" });
    await h.projects.approve("csv", "human");
    return h;
  }
  it("returns phases, ticket phase, and next-step text through RPC", async () => {
    const h = await setup();
    const call = () => h.harness.behavior.callRpc("project", { slug: "csv" }) as Promise<ProjectView>;
    const view = await call();
    expect(view.phases).toMatchObject([{ ref: "skeleton", state: "active", tickets: { total: 2, open: 2 } }, { ref: "polish", state: "planned", maxTickets: 8 }, { ref: "launch", state: "planned" }]);
    expect(view.board[0].phase).toBe("skeleton");
    expect(view.spec.summary.tickets[0].phase).toBe("skeleton");
    const detail = await h.harness.behavior.callRpc("ticket", { key: "CSV-1" }) as TicketDetail;
    expect(detail.phase).toBe("skeleton");
    const p = h.store.projectBySlug("csv")!;
    h.store.setProjectState(p.id, "running", "human");
    h.store.tickets(p.id).forEach((t) => h.store.updateTicket(t.id, { state: "done" }));
    expect((await call()).next).toMatchObject({ action: null, text: "Phase 1 of 3, Skeleton, is done. The planner is planning phase 2." });
    await h.projects.propose({ toml: specToml((d) => { phased(d); d.phase[0].report = "Download checked against the merged work."; d.ticket.push({ ...d.ticket[1], ref: "stream", phase: "polish" }); }), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_env" });
    expect((await call()).next?.text).toContain("Approve v2 to start phase 2, Polish: 1 ticket.");
  });
  it("prints phase lines and filters the tickets command", async () => {
    const h = await setup();
    const show = await h.harness.runCli(["show", "csv"]);
    expect(show.stdout).toContain("1. Skeleton · active · 0 done, 0 cancelled, 2 open / 2 tickets");
    expect(show.stdout).toContain("2. Polish · planned");
    const all = await h.harness.runCli(["tickets", "csv", "--phase", "skeleton", "--json"]);
    expect(all.exitCode).toBe(0);
    expect(JSON.parse(all.stdout)).toHaveLength(2);
    const empty = await h.harness.runCli(["tickets", "csv", "--phase", "polish"]);
    expect(empty.stdout).toBe("No tickets.\n");
  });
});
