import { beforeEach, describe, expect, it } from "vitest";
import { settleChecks, submit } from "../src/checks";
import { Store } from "../src/db/store";
import type { HostInput, HostOutput } from "../src/host-contract";
import { settleMerges } from "../src/merge";
import type { SpawnArgs } from "../src/ports";
import { approve, settleReviews } from "../src/review";
import { followRollout, markLiveByHuman, settleRolloutChecks } from "../src/rollout-live";
import { editTicket } from "../src/triage";
import { checkOutHead, makeEngine, seedProject, specToml, ticketOf, type Doc } from "./helpers";

let h: ReturnType<typeof makeEngine>;
beforeEach(() => {
  h = makeEngine();
});

const project = () => h.store.projectBySlug("csv")!;
const marks = () => h.store.rolloutMarks(project().id);
const rolloutEvents = () => h.store.events(project().id).filter((event) => event.kind.startsWith("rollout.")).map((event) => [event.kind, JSON.parse(event.data_json)]);
const execs = () => h.host.callsTo("exec");
const follow = async () => {
  followRollout(h.ctx, project());
  await settleRolloutChecks(h.ctx);
};
const merged = (key: string) => {
  h.store.updateTicket(ticketOf(h, key).id, { state: "done", state_at: h.clock.now(), pr_url: `https://github.com/acme/shop/pull/${key.slice(4)}` });
};

// CSV-1 verifies itself; CSV-2 needs CSV-1 live and a milestone that a command checks.
const rollout = (doc: Doc) => {
  doc.merge = { strategy: "pr", describe: "loom", squash: false, max_fix_rounds: 0 };
  doc.rollout = { deploy: { how: "Shipit deploys main" }, milestone: [{ ref: "traffic-low", title: "Old traffic is near zero", check: "./traffic-low.sh" }] };
  doc.ticket[0].rollout = { verify: "curl -f https://shop.example.com/health" };
  doc.ticket[1].rollout = { requires_live: ["csv-model", "traffic-low"] };
};

describe("following the rollout", () => {
  it("runs a merged ticket's verify in its repo's checkout every 15 minutes, with a 2-minute timeout, until it exits 0", async () => {
    await seedProject(h, rollout);
    h.host.execResults = [{ exitCode: 1, output: "curl: (22) 503" }, { exitCode: 1, output: "curl: (22) 503" }];
    await follow();
    // Neither ticket merged yet; the milestone's check runs from when the project runs.
    expect(execs().map((call) => call.command)).toEqual(["./traffic-low.sh"]);

    merged("CSV-1");
    await follow();
    expect(execs().at(-1)).toEqual({ cwd: "/repo", command: "curl -f https://shop.example.com/health", timeoutMs: 120_000 });
    expect(h.store.rolloutMark(project().id, "CSV-1")).toMatchObject({ live_at: null, checked_at: h.clock.now(), check_exit: 1, check_output: "curl: (22) 503" });
    expect(rolloutEvents()).toEqual([]);

    h.clock.advance(14 * 60_000);
    await follow();
    expect(execs()).toHaveLength(2);
    h.clock.advance(60_000);
    h.host.execResults = [{ exitCode: 0, output: "\u001b[32mok\u001b[0m 200" }, { exitCode: 1 }];
    await follow();
    expect(h.store.rolloutMark(project().id, "CSV-1")).toMatchObject({ live_at: h.clock.now(), live_by: "verify", evidence: "ok 200", check_exit: 0 });
    expect(rolloutEvents()).toEqual([["rollout.live", { target: "CSV-1", by: "verify", evidence: "ok 200" }]]);

    h.clock.advance(15 * 60_000);
    await follow();
    expect(execs().slice(4).map((call) => call.command)).toEqual(["./traffic-low.sh"]);
  });

  it("marks a merged ticket of a deploy-on-merge repo live at its merge, once, and not again after the human undid it", async () => {
    await seedProject(h, (doc) => {
      rollout(doc);
      doc.rollout.deploy = { on_merge: true, how: "The actuator applies on merge" };
      delete doc.ticket[0].rollout;
    });
    h.host.execResults = [{ exitCode: 1 }];
    const at = h.clock.now();
    merged("CSV-1");
    h.clock.advance(60_000);
    await follow();
    await follow();
    expect(h.store.rolloutMark(project().id, "CSV-1")).toMatchObject({ live_at: at, live_by: "merge", evidence: "https://github.com/acme/shop/pull/1" });
    expect(rolloutEvents()).toEqual([["rollout.live", { target: "CSV-1", by: "merge", liveAt: at, evidence: "https://github.com/acme/shop/pull/1" }]]);
    markLiveByHuman(h.ctx, "csv", "CSV-1", { undo: true, note: "The apply failed" }, "human");
    await follow();
    expect(h.store.rolloutMark(project().id, "CSV-1")).toMatchObject({ live_at: null, undone_at: h.clock.now() });
    expect(rolloutEvents().at(-1)).toEqual(["rollout.unlive", { target: "CSV-1", note: "The apply failed" }]);
  });

  it("marks a milestone live when its check exits 0, and records a run Loom could not make without pausing the project", async () => {
    await seedProject(h, rollout);
    h.host.execResults = [new Error("host plugin call exec exceeded its deadline")];
    await follow();
    expect(h.store.rolloutMark(project().id, "traffic-low")).toMatchObject({ live_at: null, check_exit: null, check_output: "Loom could not run it: host plugin call exec exceeded its deadline" });
    expect(project().state).toBe("running");
    h.clock.advance(15 * 60_000);
    h.host.execResults = [{ exitCode: null, timedOut: true, output: "waiting" }];
    await follow();
    expect(h.store.rolloutMark(project().id, "traffic-low")).toMatchObject({ check_exit: null, check_output: "It timed out after 2 minutes.\nwaiting" });
    h.clock.advance(15 * 60_000);
    await follow();
    expect(h.store.rolloutMark(project().id, "traffic-low")).toMatchObject({ live_by: "check", check_exit: 0, evidence: null });
    expect(rolloutEvents()).toEqual([["rollout.live", { target: "traffic-low", by: "check" }]]);
    expect(project().state).toBe("running");
  });

  it("runs nothing for a ticket with neither verify nor a deploy on merge: it waits for the human", async () => {
    await seedProject(h, (doc) => {
      rollout(doc);
      delete doc.rollout.milestone[0].check;
    });
    merged("CSV-2");
    await follow();
    expect(execs()).toEqual([]);
    expect(marks()).toEqual([]);
  });

  it("keeps following a done project's rollout in the engine's pass", async () => {
    await seedProject(h, rollout);
    merged("CSV-1");
    merged("CSV-2");
    h.host.execResults = [{ exitCode: 1 }, { exitCode: 1 }];
    await h.engine.tick();
    await settleRolloutChecks(h.ctx);
    expect(project().state).toBe("done");
    expect(execs().map((call) => call.command).sort()).toEqual(["./traffic-low.sh", "curl -f https://shop.example.com/health"]);
    h.clock.advance(15 * 60_000);
    await h.engine.tick();
    await settleRolloutChecks(h.ctx);
    expect(h.store.rolloutMark(project().id, "CSV-1")).toMatchObject({ live_by: "verify" });
  });
});

/** Holds every exec of `command` until the returned release is called with its result. */
function holdExec(command: string): (result: Partial<HostOutput<"exec">>) => void {
  let release!: (result: Partial<HostOutput<"exec">>) => void;
  const gate = new Promise<Partial<HostOutput<"exec">>>((resolve) => (release = resolve));
  const call = h.host.call.bind(h.host);
  h.host.call = (async (hostId: string, method: string, input: unknown) => {
    if (method !== "exec" || (input as HostInput<"exec">).command !== command) return call(hostId, method as never, input as never);
    h.host.calls.push({ hostId, method, input });
    return { exitCode: 0, timedOut: false, durationMs: 1, output: "", ...(await gate) };
  }) as typeof h.host.call;
  return release;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a run that something overtook", () => {
  it("writes nothing once the engine is disposed, and a store opened over the same database starts no second run until the claim expires", async () => {
    await seedProject(h, rollout);
    const release = holdExec("./traffic-low.sh");
    followRollout(h.ctx, project());
    await flush();
    expect(execs().map((call) => call.command)).toEqual(["./traffic-low.sh"]);
    await h.engine.dispose();

    const reloaded = { ...h.ctx, store: new Store(h.db, h.clock.now) };
    followRollout(reloaded, reloaded.store.projectBySlug("csv")!);
    await flush();
    expect(execs()).toHaveLength(1);
    release({ exitCode: 0, output: "near zero" });
    await settleRolloutChecks(h.ctx);
    expect(h.store.rolloutMark(project().id, "traffic-low")).toMatchObject({ live_at: null, checked_at: null, run_token: expect.any(String) });
    expect(rolloutEvents()).toEqual([]);

    h.clock.advance(5 * 60_000 + 1000);
    followRollout(reloaded, reloaded.store.projectBySlug("csv")!);
    await settleRolloutChecks(reloaded);
    expect(execs()).toHaveLength(2);
    expect(h.store.rolloutMark(project().id, "traffic-low")).toMatchObject({ live_by: "check", evidence: "near zero", run_token: null });
  });

  it("runs no command for a project archived while Loom looked for the checkout", async () => {
    await seedProject(h, rollout);
    let found!: (path: string | null) => void;
    const lookup = h.bb.projectCheckout.bind(h.bb);
    h.bb.projectCheckout = (bbProjectId: string, hostId: string) => {
      void lookup(bbProjectId, hostId);
      return new Promise((resolve) => (found = resolve));
    };
    followRollout(h.ctx, project());
    await flush();
    await h.engine.archive("csv", "human");
    found("/repo");
    await settleRolloutChecks(h.ctx);
    expect(execs()).toEqual([]);
    expect(h.store.rolloutMark(project().id, "traffic-low")).toMatchObject({ live_at: null, checked_at: null, run_token: null });
  });

  it("keeps no result of a command that finished after the project was archived", async () => {
    await seedProject(h, rollout);
    const release = holdExec("./traffic-low.sh");
    followRollout(h.ctx, project());
    await flush();
    await h.engine.archive("csv", "human");
    release({ exitCode: 0, output: "near zero" });
    await settleRolloutChecks(h.ctx);
    expect(h.store.rolloutMark(project().id, "traffic-low")).toMatchObject({ live_at: null, checked_at: null, run_token: null });
    expect(rolloutEvents()).toEqual([]);
  });

  it("keeps no result of a verify the planner replaced while it ran, and runs the new one next", async () => {
    await seedProject(h, (doc) => {
      rollout(doc);
      delete doc.rollout.milestone[0].check;
      doc.ticket[0].rollout = { verify: "old-health-check" };
    });
    merged("CSV-1");
    const release = holdExec("old-health-check");
    followRollout(h.ctx, project());
    await flush();
    editTicket(h.ctx, "CSV-1", { rollout: { verify: "different-health-check" } }, "thr_plan");
    release({ exitCode: 0 });
    await settleRolloutChecks(h.ctx);
    expect(h.store.rolloutMark(project().id, "CSV-1")).toMatchObject({ live_at: null, checked_at: null, run_token: null });
    h.host.execResults = [{ exitCode: 1, output: "503" }];
    await follow();
    expect(execs().map((call) => call.command)).toEqual(["old-health-check", "different-health-check"]);
    expect(h.store.rolloutMark(project().id, "CSV-1")).toMatchObject({ live_at: null, check_exit: 1, check_output: "503" });
  });

  it("keeps no result of a milestone check that a new spec version changed while it ran", async () => {
    await seedProject(h, rollout);
    const release = holdExec("./traffic-low.sh");
    followRollout(h.ctx, project());
    await flush();
    await h.projects.propose({ toml: specToml((doc) => ((rollout(doc), (doc.rollout.milestone[0].check = "./traffic-low.sh --strict")))), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_1" });
    await h.projects.approve("csv", "human");
    release({ exitCode: 0 });
    await settleRolloutChecks(h.ctx);
    expect(h.store.rolloutMark(project().id, "traffic-low")).toMatchObject({ live_at: null, checked_at: null, run_token: null });
    await follow();
    expect(execs().map((call) => call.command)).toEqual(["./traffic-low.sh", "./traffic-low.sh --strict"]);
    expect(h.store.rolloutMark(project().id, "traffic-low")).toMatchObject({ live_by: "check" });
  });
});

describe("the human's Mark live", () => {
  it("marks a ticket or a milestone live with the note as evidence, refuses it twice, and undoes it", async () => {
    await seedProject(h, rollout);
    expect(markLiveByHuman(h.ctx, "csv", "traffic-low", { note: "Dashboard shows 0.1%" }, "human")).toMatchObject({ live_by: "human", evidence: "Dashboard shows 0.1%" });
    expect(() => markLiveByHuman(h.ctx, "csv", "traffic-low", {}, "human")).toThrow(/traffic-low is already live: marked by human at Jan \d+ \d\d:\d\d UTC/);
    markLiveByHuman(h.ctx, "csv", "CSV-2", {}, "human");
    expect(() => markLiveByHuman(h.ctx, "csv", "CSV-1", { undo: true }, "human")).toThrow(/CSV-1 is not live, so there is nothing to undo/);
    expect(() => markLiveByHuman(h.ctx, "csv", "nope", {}, "human")).toThrow(/"nope" is neither a ticket of csv nor a milestone of its spec/);
    markLiveByHuman(h.ctx, "csv", "traffic-low", { undo: true }, "human");
    expect(marks().map((mark) => [mark.target, mark.live_by])).toEqual([
      ["CSV-2", "human"],
      ["traffic-low", null],
    ]);
    const onTicket = h.store.events(project().id).filter((event) => event.kind === "rollout.live" && event.ticket_id === ticketOf(h, "CSV-2").id);
    expect(onTicket).toHaveLength(1);
  });

  it("refuses a project without a rollout", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr" }));
    expect(() => markLiveByHuman(h.ctx, "csv", "CSV-1", {}, "human")).toThrow(/Project csv has no rollout/);
  });
});

describe("rollout order is advice only", () => {
  it("starts, reviews and opens the pull request of a ticket whose prerequisites are not live, and starts the ticket that needs it live", async () => {
    await seedProject(h, (doc) => {
      rollout(doc);
      // CSV-1 needs a milestone that never holds; CSV-2 needs CSV-1 live.
      doc.ticket[0].rollout = { requires_live: ["traffic-low"] };
    });
    h.host.onExec = (input) => {
      if (input.command === "./traffic-low.sh") h.host.execResults.unshift({ exitCode: 1, output: "still high" });
    };
    const roles = () => h.bb.callsTo("spawnThread").map(([args]) => `${(args as SpawnArgs).metadata.role}:${(args as SpawnArgs).metadata.ticket}`);

    await h.engine.tick();
    await settleRolloutChecks(h.ctx);
    expect(roles()).toEqual(["worker:CSV-1"]);
    const brief = (index: number) => {
      const args = h.bb.callsTo("spawnThread")[index]![0] as SpawnArgs;
      return `${args.prompt}\n${args.detail ?? ""}`;
    };
    expect(brief(0)).toContain("## Rollout\nLoom writes the rollout order in the pull request's Rollout section; do not write deploy order or prerequisites into the description.\nStage: none.\nLive first:\n- traffic-low: Old traffic is near zero.\n");
    h.host.worktree("/wt/env_1").dirty = true;
    submit(h.ctx, "thr_w1", "Mapped orders");
    await settleChecks(h.ctx);
    await h.engine.tick();
    expect(roles()).toEqual(["worker:CSV-1", "reviewer:CSV-1"]);
    expect(brief(1)).toContain("Loom tracks the rollout order and shows it in the pull request's Rollout section. Do not request changes to keep the pull request a draft or to describe the deploy order. Never call loom_request_changes for the rollout order: it is advice for the human. If the rollout order in the spec looks wrong, say so with loom_note or in your verdict's summary.");
    checkOutHead(h, h.store.threads({ ticketId: ticketOf(h, "CSV-1").id, role: "reviewer" })[0]!);
    await approve(h.ctx, "thr_w2", "Every criterion holds");
    await settleReviews(h.ctx);
    await h.engine.tick();
    await settleMerges(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("pr_open");
    expect(h.host.callsTo("prCreate")).toHaveLength(1);
    expect(h.host.callsTo("prCreate")[0]!.body).toContain("## Rollout\n\nStage: none.\nLive first:\n- traffic-low: Old traffic is near zero. It does not hold yet.\nDeploys: Shipit deploys main. Merging does not deploy it.\n\nLoom tracks this order on the project's Rollout tab. It is advice: Loom holds no merge or deploy for it.\n\nOpened by Loom for CSV-1.");
    await h.engine.tick();
    expect(roles()).toContain("worker:CSV-2");
    expect(h.store.rolloutMark(project().id, "traffic-low")).toMatchObject({ live_at: null, check_exit: 1 });
  });
});
