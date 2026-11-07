import { beforeEach, describe, expect, it } from "vitest";
import { dismissAsk, markStepDone, plannerAsk, recordAsk, type AskStep } from "../src/asks";
import { markLiveByHuman } from "../src/rollout-live";
import { requeueTicket } from "../src/requeue";
import { makeCtx, seedProject, seedRepoProject, specToml, type EngineHarness } from "./helpers";

let h: EngineHarness;

beforeEach(() => {
  h = makeCtx();
});

const project = () => h.store.projectBySlug("csv")!;
const ask = (steps: AskStep[], why = "Both tickets fail the same check.") => recordAsk(h.store, project(), "thr_plan", { why, steps });
const block = (key: string) => {
  const ticket = h.store.ticketByKey(key)!;
  h.store.setTicketState(ticket.id, "blocked", "thr_w", { reason: "check crashes" });
  h.store.updateTicket(ticket.id, { blocked_reason: "check crashes" });
};
const proposeV2 = () => h.projects.propose({ toml: specToml((doc) => (doc.checks.commands = ["LANG=C.UTF-8 npm test"])), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_1" });

describe("the planner's asks", () => {
  it("records the steps, marks each done from the events that follow, and closes once every step is done", async () => {
    await seedProject(h);
    block("CSV-1");
    await proposeV2();
    ask([
      { action: "approve", version: 2, text: "Approve v2: it runs the check with a UTF-8 locale." },
      { action: "requeue", key: "CSV-1", text: "Then requeue CSV-1." },
    ]);
    expect(plannerAsk(h.store, project())).toMatchObject({ why: "Both tickets fail the same check.", open: true, steps: [{ action: "approve", version: 2, done: false }, { action: "requeue", key: "CSV-1", done: false }] });

    await h.projects.approve("csv", "human", 2);
    expect(plannerAsk(h.store, project())!.steps.map((step) => step.done)).toEqual([true, false]);
    await requeueTicket(h.ctx, "CSV-1", { note: "", actor: "human", author: "human" });
    expect(plannerAsk(h.store, project())).toMatchObject({ open: false, steps: [{ done: true }, { done: true }] });
  });

  it("refuses steps the human could not take, and records nothing", async () => {
    await seedProject(h);
    expect(() => ask([{ action: "approve", version: 1, text: "Approve v1." }])).toThrow("steps[0]: no spec version of csv waits for approval");
    expect(() => ask([{ action: "requeue", key: "OTHER-1", text: "Requeue it." }])).toThrow("steps[0]: csv has no ticket OTHER-1");
    expect(() => ask([{ action: "resume", text: "Resume." }])).toThrow("steps[0]: csv is running, not paused.");
    expect(() => ask([{ action: "start", text: "Start." }])).toThrow("csv is running, so there is nothing to start.");
    await proposeV2();
    expect(() => ask([{ action: "approve", version: 1, text: "Approve v1." }])).toThrow("steps[0]: v1 does not wait for approval; v2 does.");
    expect(plannerAsk(h.store, project())).toBeNull();
  });

  it("replaces earlier asks, clears with no steps, and hides asks the human dismissed", async () => {
    await seedProject(h);
    ask([{ action: "other", text: "Rotate the API token in 1Password." }]);
    const first = plannerAsk(h.store, project())!;
    expect(first).toMatchObject({ open: true, steps: [{ action: "other", done: false }] });
    ask([{ action: "reply", key: "CSV-2", text: "Tell CSV-2 which delimiter to use." }]);
    expect(plannerAsk(h.store, project())!.steps).toMatchObject([{ action: "reply", key: "CSV-2" }]);
    expect(() => dismissAsk(h.store, project(), first.id)).toThrow("no longer the planner's newest");

    const second = plannerAsk(h.store, project())!;
    h.projects.post("CSV-2", { body: "Use a semicolon.", author: "human" });
    expect(plannerAsk(h.store, project())).toMatchObject({ open: false });
    dismissAsk(h.store, project(), second.id);
    h.store.event(project().id, null, "human.action", "human", { action: "dismissAsk", ask: second.id, slug: "csv" });
    expect(plannerAsk(h.store, project())).toBeNull();

    ask([{ action: "other", text: "Check the alert in Observe." }]);
    expect(plannerAsk(h.store, project())).not.toBeNull();
    ask([]);
    expect(plannerAsk(h.store, project())).toBeNull();
  });

  it("keeps a resume done when the project is paused again, and a start done once it ran", async () => {
    await seedProject(h, undefined, "paused");
    ask([{ action: "resume", text: "Resume once v2 is approved." }]);
    await h.projects.resume("csv", "human");
    expect(plannerAsk(h.store, project())!.steps[0]!.done).toBe(true);
    await h.projects.pause("csv", "human");
    expect(plannerAsk(h.store, project())!.steps[0]!.done).toBe(true);
  });

  it("leaves a land open while a repo of a multi-repo project still has work to land", async () => {
    await seedRepoProject(h);
    for (const key of ["CSV-1", "CSV-2"]) h.store.updateTicket(h.store.ticketByKey(key)!.id, { state: "done", state_at: h.clock.now() });
    ask([{ action: "land", text: "Land both repos." }]);
    h.clock.advance(1000);
    h.store.event(project().id, null, "project.landed", "human", { repo: "web", url: "https://example.com/web/1" });
    expect(plannerAsk(h.store, project())!.steps[0]!.done).toBe(false);
    h.store.event(project().id, null, "project.landed", "human", { repo: "api", url: "https://example.com/api/1" });
    expect(plannerAsk(h.store, project())).toMatchObject({ open: false, steps: [{ done: true }] });
  });

  it("marks a live step done once its ticket or milestone is live, and keeps it done after an undo", async () => {
    await seedProject(h, (doc) => {
      doc.merge = { strategy: "pr", describe: "loom", max_fix_rounds: 0 };
      doc.rollout = { deploy: { how: "The pipeline deploys main" }, milestone: [{ ref: "traffic-low", title: "Old traffic is near zero" }] };
    });
    expect(() => ask([{ action: "live", text: "Mark it live." }])).toThrow("steps[0]: live needs the ticket key or milestone ref.");
    expect(() => ask([{ action: "live", key: "traffic-high", text: "Mark it live." }])).toThrow('steps[0]: "traffic-high" is neither a ticket of csv nor a milestone of its spec. Its milestones: traffic-low.');
    ask([
      { action: "live", key: "traffic-low", text: "Mark traffic-low live once old traffic is near zero." },
      { action: "live", key: "CSV-1", text: "Mark CSV-1 live once the pipeline deployed it." },
    ]);
    expect(plannerAsk(h.store, project())!.steps.map((step) => step.done)).toEqual([false, false]);
    markLiveByHuman(h.ctx, "csv", "traffic-low", {}, "human");
    expect(plannerAsk(h.store, project())!.steps.map((step) => step.done)).toEqual([true, false]);
    markLiveByHuman(h.ctx, "csv", "CSV-1", {}, "human");
    markLiveByHuman(h.ctx, "csv", "CSV-1", { undo: true }, "human");
    expect(plannerAsk(h.store, project())).toMatchObject({ open: false, steps: [{ done: true }, { done: true }] });
  });

  it("keeps an ask written before live existed valid, and refuses live on a draft or a project without a rollout", async () => {
    await h.projects.propose({ toml: specToml(), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_1" });
    expect(() => ask([{ action: "live", key: "CSV-1", text: "Mark CSV-1 live." }])).toThrow("steps[0]: csv is draft, so nothing of it goes live.");
    await h.projects.approve("csv", "human");
    expect(() => ask([{ action: "live", key: "CSV-1", text: "Mark CSV-1 live." }])).toThrow("steps[0]: csv has no rollout, so nothing is marked live");
    // An ask recorded by an older Loom has the same shape: no field was added or renamed.
    h.store.event(project().id, null, "planner.asked", "thr_plan", { why: "Old ask.", steps: [{ action: "other", text: "Check the dashboard." }] });
    expect(plannerAsk(h.store, project())).toMatchObject({ why: "Old ask.", open: true, steps: [{ action: "other", done: false }] });
  });

  it("lets the human mark any step done by hand, recorded as an event, and refuses a stale, missing or finished step", async () => {
    await seedProject(h);
    ask([
      { action: "other", text: "Rotate the API token in 1Password." },
      { action: "reply", key: "CSV-2", text: "Tell CSV-2 which delimiter to use." },
    ]);
    const current = plannerAsk(h.store, project())!;
    expect(() => markStepDone(h.store, project(), current.id, 2)).toThrow("The planner's asks have no step 3.");
    markStepDone(h.store, project(), current.id, 0);
    h.store.event(project().id, null, "human.action", "human", { action: "askStepDone", ask: current.id, step: 0, slug: "csv" });
    expect(plannerAsk(h.store, project())).toMatchObject({ open: true, steps: [{ action: "other", done: true }, { action: "reply", done: false }] });
    expect(() => markStepDone(h.store, project(), current.id, 0)).toThrow("Step 1 is done already.");
    h.store.event(project().id, null, "human.action", "human", { action: "askStepDone", ask: current.id, step: 1, slug: "csv" });
    expect(plannerAsk(h.store, project())).toMatchObject({ open: false, steps: [{ done: true }, { done: true }] });

    // A mark belongs to its ask: the planner's next ask starts with every step open.
    ask([{ action: "other", text: "Rotate the API token in 1Password." }]);
    expect(plannerAsk(h.store, project())!.steps[0]!.done).toBe(false);
    expect(() => markStepDone(h.store, project(), current.id, 0)).toThrow("no longer the planner's newest");
  });
});
