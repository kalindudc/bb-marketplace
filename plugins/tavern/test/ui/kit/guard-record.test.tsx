// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { GuardPosture, blockedWhat, guardRecordWords, localTime } from "../../../src/ui/kit";
import live from "./live-iszeroduration-guards.json";

afterEach(cleanup);
type Scope = Parameters<typeof guardRecordWords>[0];
type Violations = Parameters<typeof guardRecordWords>[1];
const scopes = live.scopes as unknown as Scope[];
const violations = live.violations as unknown as Violations;
const vex = scopes.find(s => s.threadId === "thr_test000054")!;
const otto = scopes.find(s => s.threadId === "thr_test000058")!;
// A day after the run, so times read with their date; the words take the caller's clock, never the render's.
const NOW = violations[0]!.at + 24 * 3600_000;

describe("a finished member's guardrail (isZeroDuration, captured live)", () => {
  it("keeps Vex's request, the run's evidence with its time, and the state now apart", () => {
    const w = guardRecordWords(vex, violations, { now: NOW });
    expect(w.declared).toBe("Scope asked for: checker\u00a0· writes\u00a0none\u00a0· network\u00a0any\u00a0· GitHub\u00a0read\u00a0· enforce");
    expect(w.declared).not.toMatch(/ ·/);
    expect(w.evidence).toMatchObject({ tone: "done", text: `Guard blocked 1 call at ${localTime(violations[0]!.at, NOW)} (od -c)` });
    expect(w.now).toBe("Not armed: the member's thread has ended");
  });
  it("says no evidence was recorded for a member nothing tripped, never that the guard held", () => {
    const w = guardRecordWords(otto, violations, { now: NOW });
    expect(w.evidence).toMatchObject({ tone: "none", text: "No guard evidence recorded" });
    expect(w.evidence.title).toMatch(/not proof the guard held, or that it failed/);
    expect(JSON.stringify(w)).not.toMatch(/ yet|protected|held\b(?!, or)/);
  });
  it("says an archived member's thread is archived, and nothing when the guard is still armed", () => {
    expect(guardRecordWords(vex, violations, { archived: true, now: NOW }).now).toBe("Not armed: the member's thread is archived");
    expect(guardRecordWords({ ...vex, armed: true }, violations, { now: NOW }).now).toBeNull();
  });
  it("counts a call prevented before it ran as a block, not a failed stop", () => {
    const v = violations[0]!;
    const w = guardRecordWords(vex, [{ ...v, prevented: true, stopped: false }], { now: NOW });
    expect(w.evidence).toMatchObject({ tone: "done", text: expect.stringContaining("Guard blocked 1 call") });
  });
  it("counts watched breaks and failed stops apart from blocks", () => {
    const v = violations[0]!;
    const w = guardRecordWords(vex, [{ ...v, mode: "watch" }, { ...v, seq: 2, stopped: false, at: v.at + 60_000 }], { now: NOW });
    expect(w.evidence.tone).toBe("bad");
    expect(w.evidence.text).toMatch(/^Tripped a rule once at .+, and the stop failed; Recorded 1 rule break at .+, not stopped$/);
  });
  it("names the blocked command only when the reason names one", () => {
    expect(blockedWhat("[Tavern scope blocked] Blocked git push origin de1128a:refs/heads/main: pushes to main")).toBe("git push origin de1128a:refs/heads/main");
    expect(blockedWhat("[Tavern scope blocked] Blocked tool call: the provisioned worktree could not be resolved")).toBeNull();
  });
});

describe("GuardPosture", () => {
  const watched = { guardPosture: { providerId: "codex", mode: "detection-only" as const, label: "detection only (not prevented)", approvalAskId: null } };
  it("speaks of the run on a finished record", () => {
    const { container } = render(<><GuardPosture member={watched} /><GuardPosture member={watched} finished /></>);
    const [now, run] = [...container.querySelectorAll(".guard-detect")];
    expect(now!.textContent).toBe("detection only (not prevented)");
    expect(run!.textContent).toBe("detection only (not prevented) · during the run");
    expect(run!.getAttribute("title")).toMatch(/^During the run/);
  });
});
