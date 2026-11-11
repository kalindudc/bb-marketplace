import { describe, expect, it } from "vitest";
import type { ProjectView } from "../src/contract";
import { consequenceText } from "../src/ui/readiness";
import { doNextOf } from "../src/ui/ship-plan";
import { confirmHold, deployHoldsOf, readinessOf, shipConsequences, shipStepStatus, stepCanGo, readinessMap } from "../src/ui/ship-readiness";
import { csvShip, entry, laneHeld, laneOrder, laneRollout, laneShip, step } from "./ship-fixtures";

describe("Ship's one readiness calculation", () => {
  it("holds LANE-36, the rollout's next merge, on what the merge order holds it on, and offers LANE-35 first with why", () => {
    const view = laneShip();
    const lane36 = readinessOf("LANE-36", view.mergeOrder, view.rollout)!;
    expect(lane36.canMerge).toBe(false);
    expect(lane36.holds).toEqual(["stacked on LANE-35", "1 check failing"]);
    // Merging LANE-36 does not deploy it, so needing LANE-4 live holds its deploy, not its merge.
    expect(lane36.rolloutHolds).toEqual([]);
    const next = doNextOf(view)!;
    // LANE-35 needs review, so it cannot merge either: the rollout's step is held, with every hold named.
    expect(next.steps.some((step) => step.keys.includes("LANE-36"))).toBe(false);
    expect(next.lead).toBe("LANE-36 cannot merge yet: stacked on LANE-35 · 1 check failing");
  });

  it("offers the prerequisite in place of the rollout's step when the prerequisite can merge", () => {
    const view = laneShip({ mergeOrder: laneOrder((entries) => entries.map((one) => (one.key === "LANE-35" ? { ...one, verdict: "ready", review: "APPROVED", holds: [], prHolds: [] } : one))) });
    const next = doNextOf(view)!;
    expect(next.steps[0]).toMatchObject({ kind: "merge", keys: ["LANE-35"], first: "LANE-36 is stacked on it, and 1 check failing still holds it" });
    expect(next.lead).toMatch(/^Merge LANE-35 \(#35\) first: LANE-36 is stacked on it/);
  });

  it("never offers a merge the merge order holds, a freeze holds, or Loom makes itself", () => {
    const view = laneShip();
    const next = doNextOf(view)!;
    const offered = next.steps.flatMap((step) => step.keys);
    // LANE-26 deploys on merge during the payments freeze; LANE-12's final review is held; LANE-35 needs review; LANE-36 is stacked.
    for (const key of ["LANE-26", "LANE-12", "LANE-35", "LANE-36", "LANE-16", "LANE-30"]) expect(offered).not.toContain(key);
    for (const key of offered) {
      const readiness = readinessOf(key, view.mergeOrder, view.rollout);
      if (readiness !== null) expect(readiness.canMerge).toBe(true);
    }
    expect(readinessOf("LANE-26", view.mergeOrder, view.rollout)!.rolloutHolds).toEqual(["Payments freeze is on until Jan 13"]);
  });

  it("puts a merge something waits on in its own row, and the rest of the ready pull requests in one", () => {
    const next = doNextOf(laneShip())!;
    // LANE-4 merged and could go live, but the Payments freeze holds its deploy.
    expect(next.steps.map((step) => [step.kind, step.keys])).toEqual([
      ["merge", ["LANE-6"]],
      ["merge", ["LANE-7", "LANE-10", "LANE-11"]],
    ]);
    expect(next.steps[0]!.then).toBe("LANE-17 stops waiting on LANE-6 and is next to merge");
  });

  it("groups what holds the rest by reason, and keeps the merge order's later steps out", () => {
    const next = doNextOf(laneShip())!;
    // The freeze holds LANE-26's merge, which deploys it, and LANE-4's deploy after its merge, so they share a reason.
    expect(next.held).toEqual([
      { why: "Payments freeze is on until Jan 13", keys: ["LANE-4", "LANE-26"] },
      { why: "Expand is not all live · Payments freeze is on until Jan 13", keys: ["LANE-31", "LANE-32"] },
      { why: "final review held", keys: ["LANE-12"] },
      { why: "blocked", keys: ["LANE-16"] },
      { why: "needs review", keys: ["LANE-35"] },
      { why: "stacked on LANE-35 · 1 check failing", keys: ["LANE-36"] },
    ]);
  });

  it("offers marking a merged step live once what it needs is live, the stage before soaked and no freeze is on", () => {
    const open = laneShip({ rollout: laneRollout({ windows: [] }) });
    const live = doNextOf(open)!.steps.filter((step) => step.kind === "live");
    // LANE-31 and LANE-32 merged too, but Expand is not live yet.
    expect(live).toEqual([expect.objectContaining({ keys: ["LANE-4"], target: "LANE-4", facts: ["The pipeline deploys main", "LANE-33 and LANE-36 need it"] })]);
    const soaked = laneRollout({ windows: [] });
    soaked.stages[0] = { ...soaked.stages[0]!, steps: soaked.stages[0]!.steps.filter((step) => step.key === "LANE-4").map((step) => ({ ...step, live: { at: 0, by: "human", evidence: null } })), live: true, soaked: true, soakedAt: 0 };
    const next = doNextOf(laneShip({ rollout: soaked }))!;
    expect(next.steps.filter((step) => step.kind === "live").map((step) => step.keys[0])).toEqual(["LANE-31", "LANE-32"]);
  });

  it("asks for Confirm merge where the person confirms merges, and the release of a held draft", () => {
    const next = doNextOf(csvShip())!;
    expect(next.steps.map((step) => [step.kind, step.keys])).toEqual([
      ["confirm", ["CSV-12"]],
      ["release", ["CSV-3"]],
    ]);
    expect(next.steps[0]).toMatchObject({ facts: ["#418", "9f3c2e1", "checks 6/6", "approved"], then: "CSV-15 stops waiting on CSV-12, but 1 check failing still holds it · CSV-16 stops waiting on CSV-12 and is next to merge" });
  });

  it("names a rollout hold beside Confirm merge, as Do next holds it", () => {
    const view = laneShip();
    expect(confirmHold("LANE-26", view.rollout)).toBe("Hold off: merging deploys it, and Payments freeze is on until Jan 13.");
    expect(confirmHold("LANE-7", view.rollout)).toBeNull();
  });

  it("says nothing for a ticket the merge order does not list or that merged", () => {
    const view = laneShip();
    expect(readinessOf("LANE-4", view.mergeOrder, view.rollout)).toBeNull();
    expect(readinessOf("LANE-99", view.mergeOrder, view.rollout)).toBeNull();
    expect(readinessOf("X-1", { repos: [null], steps: 1, entries: [entry({ key: "X-1", verdict: "checks_pass", review: null })], counts: { open: 1, first: 1, ready: 0, wrong: 0 } }, null)!.canMerge).toBe(true);
  });

  describe("asked about the future, it keeps every hold the event does not remove", () => {
    it("holds each step for its own reason: LANE-35 in review, LANE-36 stacked, LANE-38 before LANE-4 is live, LANE-37 before Expand soaks", () => {
      const view = laneHeld({ freeze: false });
      const why = (key: string) => {
        const one = readinessOf(key, view.mergeOrder, view.rollout)!;
        return { canMerge: one.canMerge, holds: [...one.holds, ...one.rolloutHolds] };
      };
      expect(why("LANE-35")).toEqual({ canMerge: false, holds: ["needs review"] });
      expect(why("LANE-36")).toEqual({ canMerge: false, holds: ["stacked on LANE-35", "it needs LANE-4 live first"] });
      expect(why("LANE-38")).toEqual({ canMerge: false, holds: ["it needs LANE-4 live first"] });
      expect(why("LANE-37")).toEqual({ canMerge: false, holds: ["Expand has not soaked"] });
      expect(why("LANE-6")).toEqual({ canMerge: true, holds: [] });
      const held = laneHeld({ freeze: true });
      expect(readinessOf("LANE-38", held.mergeOrder, held.rollout)!.rolloutHolds).toEqual(["Payments freeze is on until Jan 13", "it needs LANE-4 live first"]);
    });

    it("says a merge frees a ticket only when nothing else holds it, a freeze, a live requirement or a held draft included", () => {
      const view = laneHeld({ freeze: true });
      const lane35 = shipConsequences("LANE-35", view.mergeOrder, view.board, view.rollout);
      expect(lane35.map((one) => [one.key, one.free, one.holds])).toEqual([["LANE-36", false, ["Payments freeze is on until Jan 13", "it needs LANE-4 live first"]]]);
      expect(consequenceText("LANE-35", lane35)).toBe("LANE-36 stops waiting on LANE-35, but Payments freeze is on until Jan 13 and it needs LANE-4 live first still hold it");
      // The review's case: LANE-36 waits only on LANE-35 and passes its checks, but merging it deploys it during the freeze.
      const only = laneRollout({ stages: laneRollout().stages.map((stage) => ({ ...stage, steps: stage.steps.map((one) => (one.key === "LANE-36" ? { ...one, onMerge: true, requires: [] } : one)) })) });
      const order = laneOrder((entries) => entries.map((one) => (one.key === "LANE-36" ? { ...one, checks: { passed: 3, failed: 0, pending: 0 }, prHolds: [] } : one)));
      const text = consequenceText("LANE-35", shipConsequences("LANE-35", order, laneShip().board, only));
      expect(text).toBe("LANE-36 stops waiting on LANE-35, but Payments freeze is on until Jan 13 still holds it");
      expect(text).not.toContain("can merge");
      // With the freeze over, the same merge frees it.
      expect(consequenceText("LANE-35", shipConsequences("LANE-35", order, laneShip().board, { ...only, windows: [] }))).toBe("LANE-36 stops waiting on LANE-35 and can merge");
      // A held draft and Loom's own merge stay named too.
      const draft = laneOrder((entries) => entries.map((one) => (one.key === "LANE-36" ? { ...one, prHolds: [], draftHold: "held" } : one)));
      expect(consequenceText("LANE-35", shipConsequences("LANE-35", draft, laneShip().board, null))).toBe("LANE-36 stops waiting on LANE-35, but held as a draft still holds it");
      const final = laneOrder((entries) => entries.map((one) => (one.key === "LANE-36" ? { ...one, prHolds: [], finalReview: { state: "waiting", reason: null } } : one)));
      expect(consequenceText("LANE-35", shipConsequences("LANE-35", final, laneShip().board, null))).toBe("LANE-36 stops waiting on LANE-35 and Loom merges it after a final review");
    });

    it("lets a step go after a soak or a requirement going live only when nothing else holds it", () => {
      const view = laneHeld({ freeze: false });
      const rollout = view.rollout!;
      expect(stepCanGo("LANE-6", view.mergeOrder, rollout)).toBe(true);
      for (const key of ["LANE-35", "LANE-36", "LANE-37", "LANE-38"]) expect(stepCanGo(key, view.mergeOrder, rollout), key).toBe(false);
      expect(stepCanGo("LANE-37", view.mergeOrder, rollout, { soaked: true })).toBe(true);
      expect(stepCanGo("LANE-38", view.mergeOrder, rollout, { live: ["LANE-4"] })).toBe(true);
      // LANE-36 still waits on LANE-35 once LANE-4 is live, and on LANE-4 once LANE-35 merges.
      expect(stepCanGo("LANE-36", view.mergeOrder, rollout, { live: ["LANE-4"] })).toBe(false);
      expect(stepCanGo("LANE-36", view.mergeOrder, rollout, { merged: "LANE-35" })).toBe(false);
      expect(stepCanGo("LANE-36", view.mergeOrder, rollout, { merged: "LANE-35", live: ["LANE-4"] })).toBe(true);
      const frozen = laneHeld({ freeze: true });
      expect(stepCanGo("LANE-37", frozen.mergeOrder, frozen.rollout!, { soaked: true })).toBe(false);
    });

    it("never labels a held step Merge now in the rollout's columns", () => {
      const view = laneHeld({ freeze: false });
      const rollout = view.rollout!;
      const readiness = readinessMap(view.mergeOrder, rollout);
      const status = (key: string) => shipStepStatus(rollout, rollout.stages.flatMap((stage) => stage.steps).find((one) => one.key === key)!, 0, readiness, view.mergeOrder);
      expect(status("LANE-35")).toMatchObject({ label: "Not yet", why: "needs review" });
      expect(status("LANE-6")).toMatchObject({ kind: "merge", label: "Merge, then deploy" });
      expect(status("LANE-38").label).toBe("Don't merge yet");
      expect(status("LANE-37").label).toBe("Merge after expand");
      const unlisted = step({ key: "LANE-99" });
      expect(shipStepStatus(rollout, unlisted, 0, readiness, view.mergeOrder).kind).toBe("merge");
    });

    const statusIn = (view: ProjectView, key: string) => {
      const rollout = view.rollout!;
      return shipStepStatus(rollout, rollout.stages.flatMap((stage) => stage.steps).find((one) => one.key === key)!, 0, readinessMap(view.mergeOrder, rollout), view.mergeOrder);
    };

    it("names a freeze that outlasts a stage's soak, and says Merge after expand only when the soak is all that holds it", () => {
      expect(statusIn(laneHeld({ freeze: false }), "LANE-37")).toEqual({ kind: "merge_after", tone: "warn", label: "Merge after expand", why: "merging deploys it" });
      expect(statusIn(laneHeld({ freeze: true }), "LANE-37")).toEqual({ kind: "merge_after", tone: "hold", label: "Not yet", why: "after expand, still held: Payments freeze is on until Jan 13" });
    });

    it("names a review still owed after a stage, and says Ready after expand only when the stage is all that holds it", () => {
      expect(statusIn(laneHeld({ freeze: false, reviewOwed: true }), "LANE-37")).toEqual({ kind: "ready_after", tone: "hold", label: "Not yet", why: "after expand, still held: needs review" });
      const approved = laneHeld({ freeze: false, reviewOwed: true });
      const free = { ...approved, mergeOrder: { ...approved.mergeOrder!, entries: approved.mergeOrder!.entries.map((one) => (one.key === "LANE-37" ? { ...one, verdict: "ready" as const, review: "APPROVED" as const, holds: [], prHolds: [] } : one)) } };
      expect(statusIn(free, "LANE-37")).toEqual({ kind: "ready_after", tone: "wait", label: "Ready after expand", why: null });
      const loom = { ...approved, mergeOrder: { ...free.mergeOrder, entries: free.mergeOrder.entries.map((one) => (one.key === "LANE-37" ? { ...one, finalReview: { state: "waiting" as const, reason: null } } : one)) } };
      expect(statusIn(loom, "LANE-37")).toMatchObject({ label: "Loom merges it", why: "after expand and a final review" });
    });

    it("names what still holds a step once what it needs is live", () => {
      expect(statusIn(laneHeld({ freeze: false }), "LANE-38")).toMatchObject({ label: "Don't merge yet", why: "merging deploys it; needs LANE-4" });
      expect(statusIn(laneHeld({ freeze: true }), "LANE-38")).toMatchObject({ label: "Don't merge yet", why: "merging deploys it; needs LANE-4, then still held: Payments freeze is on until Jan 13" });
    });

    it("holds a merged step's deploy while a freeze is on, on its status, what can go and Do next", () => {
      const open = laneRollout({ windows: [] });
      const frozen = laneRollout();
      const pending = step({ key: "LANE-9", merge: "merged", requires: [{ ...frozen.stages[0]!.steps.find((one) => one.key === "LANE-36")!.requires[0]!, target: "LANE-8" }] });
      const shipped = step({ key: "LANE-5", merge: "merged", onMerge: true });
      const withSteps = (rollout: typeof open) => ({ ...rollout, stages: [{ ...rollout.stages[0]!, steps: [...rollout.stages[0]!.steps, pending, shipped] }, ...rollout.stages.slice(1)] });
      const status = (rollout: typeof open, key: string) => shipStepStatus(rollout, rollout.stages.flatMap((stage) => stage.steps).find((one) => one.key === key)!, 0, readinessMap(laneShip().mergeOrder, rollout), laneShip().mergeOrder);
      // Deploy now, Deploy after its stage and Don't deploy yet, without and with the freeze.
      expect(status(withSteps(open), "LANE-4")).toMatchObject({ kind: "deploy", label: "Deploy now", why: null });
      expect(status(withSteps(frozen), "LANE-4")).toEqual({ kind: "waiting", tone: "hold", label: "Not yet", why: "Payments freeze is on until Jan 13" });
      expect(status(withSteps(open), "LANE-31")).toMatchObject({ kind: "deploy_after", label: "Deploy after expand", why: null });
      expect(status(withSteps(frozen), "LANE-31")).toMatchObject({ kind: "deploy_after", label: "Deploy after expand", why: "then still held: Payments freeze is on until Jan 13" });
      expect(status(withSteps(open), "LANE-9")).toMatchObject({ label: "Don't deploy yet", why: "needs LANE-8" });
      expect(status(withSteps(frozen), "LANE-9")).toMatchObject({ label: "Don't deploy yet", why: "needs LANE-8, then still held: Payments freeze is on until Jan 13" });
      // A step that deployed when it merged has no deploy left to hold; its mark stays an attestation.
      expect(deployHoldsOf(withSteps(frozen), "LANE-5")).toEqual([]);
      expect(status(withSteps(frozen), "LANE-5")).toMatchObject({ kind: "deploy", label: "Deploy now" });
      // What can go, which the rollout's "can go now" and "Then … can go" lines read.
      expect(stepCanGo("LANE-4", laneShip().mergeOrder, open)).toBe(true);
      expect(stepCanGo("LANE-4", laneShip().mergeOrder, frozen)).toBe(false);
      expect(stepCanGo("LANE-31", laneShip().mergeOrder, frozen, { soaked: true })).toBe(false);
      // Do next offers Mark live only with no freeze on, and otherwise names the freeze as what holds it.
      expect(doNextOf(laneShip({ rollout: open }))!.steps.filter((one) => one.kind === "live").map((one) => one.keys[0])).toEqual(["LANE-4"]);
      const held = doNextOf(laneShip({ rollout: frozen }))!;
      expect(held.steps.filter((one) => one.kind === "live")).toEqual([]);
      expect(held.held.find((group) => group.keys.includes("LANE-4"))!.why).toBe("Payments freeze is on until Jan 13");
    });

    it("promises no step after a stage or a requirement that another hold would still block", () => {
      const PROMISE = /^(Merge|Ready) after|^Merge now|^Merge, then deploy/;
      let promised = 0;
      for (const view of [laneHeld({ freeze: false }), laneHeld({ freeze: true }), laneHeld({ freeze: false, reviewOwed: true }), laneHeld({ freeze: true, reviewOwed: true })]) {
        const rollout = view.rollout!;
        for (const one of rollout.stages.flatMap((stage) => stage.steps)) {
          if (one.live !== null || one.merge === "merged") continue;
          const status = statusIn(view, one.key);
          const assume = { soaked: true, live: one.requires.map((need) => need.target) };
          if (!PROMISE.test(status.label)) continue;
          promised += 1;
          expect(stepCanGo(one.key, view.mergeOrder, rollout, assume), `${one.key}: ${status.label}`).toBe(true);
        }
      }
      // LANE-6 in each fixture and LANE-37 without a freeze or a review, so the check is not passing on silence.
      expect(promised).toBeGreaterThanOrEqual(5);
    });
  });
});

