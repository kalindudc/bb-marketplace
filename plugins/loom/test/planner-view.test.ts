import { beforeEach, describe, expect, it } from "vitest";
import { recordAsk } from "../src/asks";
import { plannerView, type PlannerStep } from "../src/planner-view";
import { ensureSpecReview, specVerdict } from "../src/spec-review";
import { maybeSendTriage } from "../src/triage";
import { requeueTicket } from "../src/workers";
import { makeEngine, specToml, type Doc } from "./helpers";

let h: ReturnType<typeof makeEngine>;

beforeEach(() => {
  h = makeEngine();
});

const project = () => h.store.projectBySlug("csv")!;
const view = (threadId = "thr_plan") => plannerView({ store: h.store, projects: h.projects }, threadId, h.clock.now())!;
const propose = (edit?: (doc: Doc) => void) => h.projects.propose({ toml: specToml(edit), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_1" });
const idle = async (text: string) => {
  h.clock.advance(1000);
  await h.engine.onThreadIdle("thr_plan", text);
};
const kinds = (steps: PlannerStep[]) => steps.map((step) => step.kind);
const human = (data: object) => h.store.event(project().id, null, "human.action", "human", { slug: "csv", ...data });

describe("the planner view", () => {
  it("groups the planner's proposals into the turn that ended with its words, between reviews, comments and approval", async () => {
    await propose();
    await ensureSpecReview(h.ctx, "csv");
    await idle("I proposed v1. Loom's spec review is running.");
    h.clock.advance(1000);
    await specVerdict(h.ctx, h.store.specReviews(project().id)[0]!.thread_id!, [{ path: "ticket[csv-export]", title: "Too wide", detail: "Split it." }], "One ticket is too wide.");
    h.clock.advance(1000);
    await propose((doc) => doc.ticket.pop());
    await idle("I took out csv-export.");
    h.clock.advance(1000);
    human({ action: "notes", notes: [{ version: 2, paths: ["ticket[csv-model]"], body: "Name the rows." }] });
    h.clock.advance(1000);
    await h.engine.approve("csv", "human", undefined, { skipReview: true });
    human({ action: "approve", pending: false, skipReview: true });

    const { steps, versions, slug, projectState } = view();
    expect({ slug, projectState }).toEqual({ slug: "csv", projectState: "ready" });
    expect(kinds(steps)).toEqual(["started", "turn", "review", "turn", "notes", "control"]);
    expect(steps[0]).toMatchObject({ kind: "started", text: "CSV export" });
    expect(steps[1]).toMatchObject({ kind: "turn", text: "I proposed v1. Loom's spec review is running.", actions: [{ kind: "proposed", version: 1, tickets: 2, change: null }] });
    expect(steps[2]).toMatchObject({ kind: "review", version: 1, round: 1, state: "changes_requested", findings: [{ path: "ticket[csv-export]", title: "Too wide" }] });
    expect(steps[3]).toMatchObject({ kind: "turn", actions: [{ kind: "proposed", version: 2, tickets: 1, change: { removed: ["csv-export"], added: [] } }] });
    expect(steps[4]).toMatchObject({ kind: "notes", version: 2, notes: [{ body: "Name the rows." }] });
    expect(steps[5]).toMatchObject({ kind: "control", action: "approve", version: 2, skipReview: true });
    expect(versions.map((row) => [row.version, row.status, row.tickets, row.review?.state ?? null])).toEqual([
      [1, "superseded", 2, "changes_requested"],
      [2, "approved", 1, null],
    ]);
  });

  it("answers a triage round with the planner's board changes, its asks and its words", async () => {
    await propose();
    await h.engine.approve("csv", "human");
    h.store.setProjectState(project().id, "running", "human");
    const ticket = h.store.ticketByKey("CSV-1")!;
    h.store.setTicketState(ticket.id, "blocked", "thr_w", { reason: "The check crashes." });
    h.store.updateTicket(ticket.id, { blocked_reason: "The check crashes." });
    h.store.updateProject(project().id, { triage_pending: 1 });
    expect(await maybeSendTriage(h.ctx, project())).toBe(true);
    h.clock.advance(1000);
    h.projects.post("CSV-1", { body: "Fixed in the check; try again.", author: "planner", threadId: "thr_plan" });
    await requeueTicket(h.ctx, "CSV-1", { note: "", actor: "thr_plan", author: "planner", threadId: "thr_plan" });
    recordAsk(h.store, project(), "thr_plan", { why: "So you can follow along.", steps: [{ action: "other", text: "Watch CSV-1." }] });
    await idle("I requeued CSV-1.");

    const triage = view().steps.at(-1)!;
    expect(triage).toMatchObject({ kind: "triage", round: 1, blocked: [{ key: "CSV-1", title: "Order rows", reason: "The check crashes." }] });
    expect(triage.kind === "triage" && triage.response).toMatchObject({
      text: "I requeued CSV-1.",
      actions: [{ kind: "post", key: "CSV-1", text: "Fixed in the check; try again.", reply: false }, { kind: "requeue", key: "CSV-1" }, { kind: "ask", steps: [{ action: "other", text: "Watch CSV-1." }] }],
    });
    expect(view().ask).toMatchObject({ open: true, steps: [{ text: "Watch CSV-1.", done: false }] });
  });

  it("gives each proposed version its own turn when no turn was recorded between them, as in an older project", async () => {
    await propose();
    h.clock.advance(1000);
    await propose((doc) => doc.ticket.pop());
    const turns = view().steps.filter((step) => step.kind === "turn");
    expect(turns.map((step) => step.kind === "turn" && step.actions.map((action) => action.kind === "proposed" && action.version))).toEqual([[1], [2]]);
  });

  it("sends the human's message from the page to the planner and keeps it, and refuses a thread that is not a live planner", async () => {
    await propose();
    await h.engine.messagePlanner("thr_plan", "  Keep it to one ticket.  ");
    expect(h.bb.sent("thr_plan").at(-1)).toBe("Keep it to one ticket.");
    expect(view().steps.at(-1)).toMatchObject({ kind: "message", text: "Keep it to one ticket." });
    await expect(h.engine.messagePlanner("thr_other", "hi")).rejects.toThrow("not a live Loom planner");
  });

  it("tells a planning conversation before it proposes from its planning row, and is null for any other thread", async () => {
    h.store.addPlanning({ thread_id: "thr_new", bb_project_id: "proj_1", title: "Export orders as CSV" });
    await h.engine.onThreadIdle("thr_new", "Which columns should the file have?");
    await h.engine.onThreadIdle("thr_new", "   ");
    const planning = view("thr_new");
    expect(planning).toMatchObject({ slug: null, projectState: null, title: "Export orders as CSV", versions: [], ask: null, review: { kind: "none" } });
    expect(planning.steps).toMatchObject([{ kind: "started", text: "Export orders as CSV" }, { kind: "turn", text: "Which columns should the file have?", actions: [] }]);
    expect(plannerView({ store: h.store, projects: h.projects }, "thr_nobody", h.clock.now())).toBeNull();
  });
});
