import { fireEvent } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect, it, vi } from "vitest";
import { AskCard } from "../../../src/ui/kit/ask-card";
import type { Ask } from "../../../src/shared/schema";
import { fixtureGreenlight } from "../../../src/ui/thread/fixtures";

const approved = { members: 2, rangers: 0, depth: 1, check: "warden" as const, acts: [] };
const requested = { ...approved, members: 4, rangers: 1, acts: [{ kind: "read", path: "docs/service-migration/permissions-and-rollback-notes.md" }] };
const ask: Ask = { ...fixtureGreenlight, createdAt: 0, question: "Approve service migration, plan v2?", why: "The lead is asking to change the parent-approved limits.",
  meanwhile: "The lead can prepare but cannot staff this plan.", options: [
    { id: "approve", label: "Change limits and approve this plan", detail: "Record these changes and approve only this plan version.", recommended: false },
    { id: "revise", label: "Ask for a revision", detail: "Keep the current limits. Do not start staffing.", recommended: false },
  ], effect: { type: "lead-plan", request: { version: 2, childQuestId: "child", parentQuestId: "parent", parentWaypointId: "w1", parentTitle: "Coordinated service migration", approved, requested, why: "The lead is asking to change the parent-approved limits.", planChanges: { fromVersion: 1, fields: ["party"], addedWaypoints: [], removedWaypoints: [], changedWaypoints: ["Service check"], orderChanged: false }, changes: [{ linkId: "lead", questTitle: "Coordinated service migration", approved, requested }] } } };

it("shows the current and requested limits before sending one explicit answer", async () => {
  const answerAsk = vi.fn(() => ({ ok: true }));
  const slot = renderSlot({ component: AskCard }, { ask }, { rpc: { answerAsk } });
  try {
    expect(slot.getByText("Approved")).toBeTruthy();
    expect(slot.container.querySelector("time")).toBeNull();
    expect(slot.getByText("Requested")).toBeTruthy();
    expect(slot.getByText(/2 members, 0 Rangers, depth 1/)).toBeTruthy();
    expect(slot.getByText(/4 members \(was 2\), 1 Ranger \(was 0\), depth 1/)).toBeTruthy();
    expect(slot.getByText("New scope act: read")).toBeTruthy();
    expect(slot.getByText("Changes since plan v1")).toBeTruthy();
    expect(slot.getByText(/Changed waypoint: Service check/)).toBeTruthy();
    expect(slot.getByText(requested.acts[0]!.path)).toBeTruthy();
    expect((slot.getByRole("button", { name: "Send answer" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(slot.getByRole("radio", { name: /change limits and approve this plan/i }));
    fireEvent.click(slot.getByRole("button", { name: "Change limits and approve this plan" }));
    await slot.findByRole("status", { name: `Ask answered: ${ask.question}` });
    expect(answerAsk.mock.calls).toHaveLength(1);
  } finally { slot.lifecycle.unmount(); }
});

it.runIf(process.env.TAVERN_LAYOUT_HARNESS === "1")("renders the envelope ask for measured layout", () => {
  const slot = renderSlot({ component: AskCard }, { ask, onFold: () => {} });
  try {
    process.stdout.write("CH2_LAYOUT=" + JSON.stringify(slot.container.innerHTML) + "\n");
  } finally { slot.lifecycle.unmount(); }
});
