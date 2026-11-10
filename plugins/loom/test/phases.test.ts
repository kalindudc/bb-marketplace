import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSpec, specHash, ticketSpecSchema } from "../src/spec";
import { addTickets } from "../src/triage";
import { finishIfComplete } from "../src/land";
import { phaseDoneText, specReviewerBrief } from "../src/prompts";
import { phaseMergeCommits, phasesOf } from "../src/phases";
import { specOf } from "../src/ctx";
import { followHooks } from "../src/hooks";
import { followPhases } from "../src/phase-engine";
import { plannerView } from "../src/planner-view";
import { projectTimeline, rowsOf } from "../src/replay";
import { sectionOf } from "../src/spec-diff";
import { makeEngine, seedProject, specToml, type Doc } from "./helpers";

import { phased } from "./phase-fixtures";
const parsed = (edit?: (doc: Doc) => void) => parseSpec(specToml((d) => { phased(d); edit?.(d); }));
const propose = (h: ReturnType<typeof makeEngine>, edit?: (doc: Doc) => void) => h.projects.propose({ toml: specToml((d) => { phased(d); edit?.(d); }), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_1" });
const next = (d: Doc) => {
  d.phase[0].report = "CSV-1 and CSV-2 landed; the download check passed. No work was cancelled.";
  d.ticket.push({ ...d.ticket[1], ref: "stream", phase: "polish", depends_on: ["csv-export"] });
};

describe("phase spec", () => {
  it("accepts the documented phased example without warnings", () => {
    const doc = readFileSync(new URL("../skills/loom/references/spec.md", import.meta.url), "utf8").split("## Example: a phased project")[1]!;
    const result = parseSpec(/```toml\n([\s\S]*?)```/.exec(doc)![1]!);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.spec!.phase).toHaveLength(2);
  });
  it("keeps unphased parsed shapes and hashes unchanged", () => {
    const a = parseSpec(specToml()).spec!;
    expect(a).not.toHaveProperty("phase");
    expect(a.ticket[0]).not.toHaveProperty("phase");
    expect(specHash(a)).toBe(specHash(JSON.parse(JSON.stringify(a))));
  });
  it("accepts the roadmap without inserting defaults", () => {
    const result = parsed();
    expect(result.errors).toEqual([]);
    expect(result.spec!.phase![1]).not.toHaveProperty("max_tickets");
  });
  it.each([
    ["phase count", (d: Doc) => d.phase.splice(1), "phase"],
    ["phase maximum", (d: Doc) => d.phase.push(...Array.from({ length: 6 }, (_, i) => ({ ...d.phase[1], ref: `extra-${i}` }))), "phase"],
    ["ref", (d: Doc) => (d.phase[0].ref = "Bad"), "ref"],
    ["title", (d: Doc) => (d.phase[0].title = ""), "title"],
    ["goal", (d: Doc) => (d.phase[0].goal = "short"), "goal"],
    ["checks", (d: Doc) => (d.phase[0].done_when = []), "done_when"],
    ["outline", (d: Doc) => (d.phase[1].outline = Array(21).fill("work")), "outline"],
    ["cap", (d: Doc) => (d.phase[0].max_tickets = 13), "max_tickets"],
    ["duplicate", (d: Doc) => (d.phase[1].ref = "skeleton"), "unique"],
    ["missing ticket phase", (d: Doc) => delete d.ticket[0].phase, "phase"],
    ["unknown ticket phase", (d: Doc) => (d.ticket[0].phase = "unknown"), "phase"],
    ["prefix", (d: Doc) => (d.ticket[1].phase = "launch"), "prefix"],
    ["count", (d: Doc) => (d.phase[0].max_tickets = 1), "max_tickets"],
    ["long title", (d: Doc) => (d.phase[0].title = "x".repeat(81)), "title"],
    ["long ref", (d: Doc) => (d.phase[0].ref = "x".repeat(41)), "ref"],
    ["long goal", (d: Doc) => (d.phase[0].goal = "x".repeat(1001)), "goal"],
    ["long check", (d: Doc) => (d.phase[0].done_when = ["x".repeat(301)]), "done_when"],
    ["empty check", (d: Doc) => (d.phase[0].done_when = [""]), "done_when"],
    ["too many checks", (d: Doc) => (d.phase[0].done_when = Array(8).fill("check")), "done_when"],
    ["long outline", (d: Doc) => (d.phase[1].outline = ["x".repeat(301)]), "outline"],
    ["zero cap", (d: Doc) => (d.phase[0].max_tickets = 0), "max_tickets"],
    ["fractional cap", (d: Doc) => (d.phase[0].max_tickets = 2.5), "max_tickets"],
    ["empty report", (d: Doc) => (d.phase[0].report = ""), "report"],
    ["long report", (d: Doc) => (d.phase[0].report = "x".repeat(4001)), "report"],
    ["unplanned report", (d: Doc) => (d.phase[1].report = "Not done"), "report"],
    ["later dependency", (d: Doc) => { d.ticket[1].phase = "polish"; d.ticket[1].depends_on = []; d.ticket[0].depends_on = ["csv-export"]; }, "later phase"],
    ["later merge order", (d: Doc) => { d.ticket[1].phase = "polish"; d.ticket[1].depends_on = []; d.ticket[0].merge_after = ["csv-export"]; }, "later phase"],
  ])("rejects %s", (_name, edit, error) => expect(parsed(edit as (d: Doc) => void).errors.join("\n")).toContain(error));
  it("refuses a ticket phase without a roadmap", () => expect(parseSpec(specToml((d) => (d.ticket[0].phase = "skeleton"))).errors.join("\n")).toContain("without"));
  it("uses a default budget of eight", () => expect(parsed((d) => { delete d.phase[0].max_tickets; d.ticket = Array.from({ length: 9 }, (_, i) => ({ ...d.ticket[0], ref: `t-${i}` })); }).errors.join("\n")).toContain("max_tickets"));
});

describe("phase evidence", () => {
  it("gives reviewers the roadmap rubric and finished-ticket facts without changing the unphased rubric", async () => {
    const h = makeEngine(); const p = await seedProject(h, phased);
    const spec = specOf(h.store, p);
    h.store.updateTicket(h.store.tickets(p.id)[0]!.id, { state: "done", head_sha: "head-only" });
    const args = { project: p, toml: specToml(phased), version: 2, round: 1, earlier: [], spec, tickets: h.store.tickets(p.id), inForce: { version: 1, spec } };
    const brief = specReviewerBrief(args);
    expect(brief).toContain("walking skeleton");
    expect(brief).toContain("phase gate");
    expect(brief).toContain("CSV-1: Order rows; done");
    expect(brief).toContain("head commit: head-only; merge commit: unknown");
    expect(brief).not.toContain("ticket changes in the spec are a record, not new work");
    const plain = parseSpec(specToml()).spec!;
    expect(specReviewerBrief({ ...args, spec: plain, inForce: { version: 1, spec: plain } })).toContain("ticket changes in the spec are a record, not new work");
    expect(sectionOf("phase[1].report")).toBe("tickets");
  });
  it("uses known completion commits in the planner's evidence and delivers phase hooks", async () => {
    const h = makeEngine(); const p = await seedProject(h, (d) => { phased(d); d.hook = [{ on: "phase.done", tell: "Tell the team this phase finished." }]; });
    h.store.tickets(p.id).forEach((t) => {
      h.store.updateTicket(t.id, { state: "done", head_sha: "head-only" });
      h.store.event(p.id, t.id, "ticket.state", "loom", { from: "pr_open", to: "done", sha: "known-merge" });
    });
    const tickets = h.store.tickets(p.id);
    const phases = phasesOf(specOf(h.store, p), tickets)!;
    const text = phaseDoneText(p, phases[0]!, phases[1]!, tickets, phaseMergeCommits(h.store, tickets));
    expect(text).toContain("merge commit: known-merge");
    expect(text).toContain("reserving one or two for fixes");
    await followPhases(h.ctx, p);
    await followHooks(h.ctx);
    expect(h.store.eventsOfKind(p.id, "hook.told")).toHaveLength(1);
    expect(JSON.stringify(h.bb.callsTo("send"))).toContain("Tell the team this phase finished.");
    expect(plannerView({ store: h.store, projects: h.projects }, "thr_plan", h.clock.now())!.steps.some((step) => step.kind === "message" && step.text.includes("is done"))).toBe(true);
    expect(projectTimeline(rowsOf(h.store, h.store.project(p.id)!), h.clock.now()).moments.some((moment) => moment.lines.some((line) => line.text.includes("Phase Skeleton is done")))).toBe(true);
  });
});

describe("phase gates", () => {
  it("refuses next-phase dependencies on record-only tickets that do not exist on the board", async () => {
    const h = makeEngine(); const p = await seedProject(h, phased);
    h.store.tickets(p.id).forEach((t) => h.store.updateTicket(t.id, { state: "done" }));
    await expect(propose(h, (d) => {
      next(d);
      d.ticket.push({ ...d.ticket[0], ref: "record-only" });
      d.ticket[2].depends_on = ["record-only"];
    })).rejects.toThrow(/record-only.*board/);
    await expect(propose(h, (d) => {
      next(d);
      d.ticket.push({ ...d.ticket[0], ref: "record-only" });
      d.ticket[2].merge_after = ["record-only"];
    })).rejects.toThrow(/record-only.*board/);
  });
  it("wakes the planner for the current roadmap if the old next phase was removed", async () => {
    const h = makeEngine(); const p = await seedProject(h, phased);
    h.store.tickets(p.id).forEach((t) => h.store.updateTicket(t.id, { state: "done" }));
    h.bb.threads.get("thr_plan")!.status = "running";
    await followPhases(h.ctx, p);
    await propose(h, (d) => d.phase.splice(1, 1));
    await h.projects.approve("csv", "human");
    h.bb.threads.get("thr_plan")!.status = "idle";
    await followPhases(h.ctx, h.store.project(p.id)!);
    expect(h.store.eventsOfKind(p.id, "phase.told")).toHaveLength(1);
    expect(h.bb.callsTo("send")[0]![1]).toMatchObject({ summary: expect.stringContaining("Plan Launch") });
  });
  it("rechecks the gate at approval if earlier work reopened", async () => {
    const h = makeEngine(); const p = await seedProject(h, phased);
    h.store.tickets(p.id).forEach((t) => h.store.updateTicket(t.id, { state: "done" }));
    await propose(h, next);
    h.store.updateTicket(h.store.tickets(p.id)[0]!.id, { state: "working" });
    await expect(h.projects.approve("csv", "human")).rejects.toThrow(/still running/);
    expect(h.store.tickets(p.id)).toHaveLength(2);
    expect(h.store.project(p.id)!.approved_version).toBe(1);
  });
  it("numbers from the live board and resolves dependencies in both batches", async () => {
    const h = makeEngine(); const p = await seedProject(h, phased);
    addTickets(h.ctx, p.id, [ticketSpecSchema.parse({ ref: "fix", title: "Fix", body: "Fix", acceptance: ["Works"], scope: ["src/fix/**"] })], "thr_plan");
    h.store.tickets(p.id).forEach((t) => h.store.updateTicket(t.id, { state: "done" }));
    await propose(h, (d) => { next(d); d.ticket.push({ ...d.ticket[1], ref: "stream-check", phase: "polish", depends_on: ["stream"], merge_after: ["csv-export"] }); });
    expect(await h.projects.approve("csv", "human")).toMatchObject({ tickets: ["CSV-4", "CSV-5"] });
    expect(h.store.ticketByKey("CSV-5")).toMatchObject({ deps_json: '["CSV-4"]', merge_after_json: '["CSV-2"]' });
  });
  it("refuses more than one newly filled phase and allows planned roadmap edits", async () => {
    const h = makeEngine(); const p = await seedProject(h, phased);
    h.store.tickets(p.id).forEach((t) => h.store.updateTicket(t.id, { state: "cancelled" }));
    await expect(propose(h, (d) => { next(d); d.ticket.push({ ...d.ticket[1], ref: "launch", phase: "launch" }); })).rejects.toThrow(/first planned phase/);
    await expect(propose(h, (d) => { [d.phase[1], d.phase[2]] = [d.phase[2], d.phase[1]]; d.phase[0].report = "All cancelled; the revised slice replaces them."; d.ticket.push({ ...d.ticket[1], ref: "launch", phase: "launch" }); })).resolves.toMatchObject({ pending: true });
  });
  it("finishes after the last phase and survives a missing planner", async () => {
    const h = makeEngine(); const p = await seedProject(h, (d) => { phased(d); d.phase.pop(); });
    h.store.tickets(p.id).forEach((t) => h.store.updateTicket(t.id, { state: "done" }));
    h.bb.threads.delete("thr_plan");
    await h.engine.tick(); await h.engine.tick();
    expect(h.store.eventsOfKind(p.id, "phase.done")).toHaveLength(1);
    expect(h.store.eventsOfKind(p.id, "phase.told")).toHaveLength(0);
    await propose(h, (d) => { next(d); d.phase.pop(); });
    await h.projects.approve("csv", "human");
    h.store.tickets(p.id).forEach((t) => h.store.updateTicket(t.id, { state: "done" }));
    expect(finishIfComplete(h.ctx, h.store.project(p.id)!)).toBe(true);
    expect(h.store.project(p.id)!.state).toBe("done");
  });
  it("refuses filling later phases in the first proposal", async () => {
    const h = makeEngine();
    await expect(propose(h, next)).rejects.toThrow(/first phase/);
  });
  it("refuses early fills, requires the report, and creates only the next batch on approval", async () => {
    const h = makeEngine();
    const p = await seedProject(h, phased);
    expect(h.store.tickets(p.id).map((t) => t.phase)).toEqual(["skeleton", "skeleton"]);
    await expect(propose(h, next)).rejects.toThrow(/Skeleton.*still running/);
    h.store.tickets(p.id).forEach((t) => h.store.updateTicket(t.id, { state: "done" }));
    await expect(propose(h, (d) => { next(d); delete d.phase[0].report; })).rejects.toThrow(/report/);
    await propose(h, next);
    expect(h.store.tickets(p.id)).toHaveLength(2);
    expect(await h.projects.approve("csv", "human")).toMatchObject({ tickets: ["CSV-3"] });
    expect(h.store.ticketByKey("CSV-3")).toMatchObject({ phase: "polish", deps_json: '["CSV-2"]' });
    expect(h.store.posts(h.store.ticketByKey("CSV-3")!.id)[0].kind).toBe("brief");
    expect(h.store.events(p.id).filter((e) => e.kind === "phase.started")).toHaveLength(2);
    await expect(h.projects.approve("csv", "human")).rejects.toThrow(/no spec version/);
  });
  it("locks started phase identity and order but lets planned phases change", async () => {
    const h = makeEngine(); await seedProject(h, phased);
    await expect(propose(h, (d) => d.phase.reverse())).rejects.toThrow(/phase/);
    await expect(propose(h, (d) => { d.phase[0].ref = "new"; d.ticket.forEach((t: Doc) => (t.phase = "new")); })).rejects.toThrow(/phase/);
    await expect(propose(h, (d) => { d.phase.pop(); d.phase[1].outline = ["Different approach"]; })).resolves.toMatchObject({ pending: true });
  });
  it("adds to the active phase within its budget, and refuses additions between phases", async () => {
    const h = makeEngine(); const p = await seedProject(h, phased);
    const ticket = ticketSpecSchema.parse({ ref: "fix", title: "Fix", body: "Fix CSV", acceptance: ["Works"], scope: ["src/fix/**"] });
    expect(addTickets(h.ctx, p.id, [ticket], "thr_plan")[0].phase).toBe("skeleton");
    expect(() => addTickets(h.ctx, p.id, [{ ...ticket, ref: "fix-two" }], "thr_plan")).toThrow(/later phase.*outline/);
    h.store.tickets(p.id).forEach((t) => h.store.updateTicket(t.id, { state: "cancelled" }));
    expect(() => addTickets(h.ctx, p.id, [{ ...ticket, ref: "fix-three" }], "thr_plan")).toThrow(/propose the next phase/i);
  });
  it.each(["running", "paused"] as const)("does not finish between phases; records once and tells once when idle (%s)", async (state) => {
    const h = makeEngine(); const p = await seedProject(h, phased, state);
    h.store.tickets(p.id).forEach((t) => h.store.updateTicket(t.id, { state: "done", pr_url: "https://example.test/pr/1", head_sha: "merged-sha" }));
    expect(finishIfComplete(h.ctx, p)).toBe(false);
    h.bb.threads.get("thr_plan")!.status = "running";
    await h.engine.tick();
    expect(h.store.events(p.id).filter((e) => e.kind === "phase.done")).toHaveLength(1);
    expect(h.bb.callsTo("send")).toHaveLength(0);
    h.bb.threads.get("thr_plan")!.status = "idle";
    await h.engine.tick(); await h.engine.tick();
    expect(h.store.project(p.id)!.state).toBe(state);
    expect(h.store.events(p.id).filter((e) => e.kind === "phase.told")).toHaveLength(1);
    expect(JSON.stringify(h.bb.callsTo("send"))).toContain("merged-sha");
    expect(JSON.stringify(h.bb.callsTo("send"))).toContain("report");
    expect(h.bb.callsTo("send")).toHaveLength(1);
  });
  it("holds the phase wake-up while a pending version waits on the human", async () => {
    const h = makeEngine(); const p = await seedProject(h, phased, "running");
    h.store.tickets(p.id).forEach((t) => h.store.updateTicket(t.id, { state: "done" }));
    h.store.updateProject(p.id, { pending_version: 2 });
    await h.engine.tick();
    expect(h.store.events(p.id).filter((e) => e.kind === "phase.done")).toHaveLength(1);
    expect(h.bb.callsTo("send")).toHaveLength(0);
    h.store.updateProject(p.id, { pending_version: null });
    await h.engine.tick();
    expect(h.store.events(p.id).filter((e) => e.kind === "phase.told")).toHaveLength(1);
  });
});
