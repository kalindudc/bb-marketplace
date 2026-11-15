// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fixtureDecor, fixtureLedger, fixtureMember, fixtureQuest, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { LedgerTab } from "../../../src/ui/thread/tabs";
import { PartyPicture, ruleScopeLabel, useWidenRule } from "../../../src/ui/kit";
import type { Rule } from "../../../src/shared/schema";
afterEach(cleanup);

const rule = (id: string, scope: Rule["scope"], text: string, extra: Partial<Rule> = {}): Rule => ({ id, scope, scopeId: scope === "global" ? null : scope === "quest" ? fixtureQuest.id : "keeper-1", text, source: "message", active: true, createdAt: Date.now() - 60_000, ...extra });

function Widen({ r, onWiden }: { r: Rule; onWiden?: () => Promise<unknown> }) {
  const { trigger, confirm } = useWidenRule({ rule: r, onWiden });
  return <div className="tavern">{trigger}{confirm}</div>;
}

describe("Rule scope words", () => {
  it("names who a rule reaches in plain words", () => {
    expect(ruleScopeLabel("keeper")).toBe("This Keeper");
    expect(ruleScopeLabel("quest", "Vault cutover")).toBe("This quest: Vault cutover");
    expect(ruleScopeLabel("global")).toBe("All Keepers");
  });
});

describe("Widen a rule", () => {
  it("confirms in place before widening, then leaves one receipt", async () => {
    const onWiden = vi.fn(() => Promise.resolve());
    const view = render(<Widen r={rule("r1", "keeper", "Keep PRs small")} onWiden={onWiden} />);
    const trigger = view.getByRole("button", { name: "Apply to all Keepers" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    const confirm = view.getByRole("group", { name: "Apply this rule to all Keepers" });
    expect(confirm.textContent).toContain("All Keepers and their parties, in every project, follow “Keep PRs small”");
    expect(onWiden).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Apply to all Keepers" }));
    await waitFor(() => expect(view.getByRole("status").textContent).toContain("Now applies to all Keepers"));
    expect(onWiden).toHaveBeenCalledTimes(1);
  });

  it("keeps the confirm open and shows the error when widening fails", async () => {
    const view = render(<Widen r={rule("r1", "keeper", "Keep PRs small")} onWiden={() => Promise.reject(new Error("Rule changed; reload the ledger"))} />);
    fireEvent.click(view.getByRole("button", { name: "Apply to all Keepers" }));
    fireEvent.click(within(view.getByRole("group")).getByRole("button", { name: "Apply to all Keepers" }));
    expect((await view.findByRole("alert")).textContent).toContain("Rule changed");
    expect(view.getByRole("group", { name: "Apply this rule to all Keepers" })).toBeTruthy();
  });

  it("offers nothing for a rule that is already global or turned off", () => {
    const onWiden = vi.fn(() => Promise.resolve());
    const view = render(<><Widen r={rule("g", "global", "No docs-only PRs")} onWiden={onWiden} /><Widen r={rule("o", "keeper", "Old rule", { active: false })} onWiden={onWiden} /></>);
    expect(view.queryByRole("button", { name: "Apply to all Keepers" })).toBeNull();
  });
});

describe("Ledger rule rows", () => {
  const rules = [rule("rk", "keeper", "Keep every Vault PR under 400 changed lines"), rule("rq", "quest", "Draft only; DNS cut needs an explicit go"), rule("rg", "global", "No docs-only PRs")];
  const renderLedger = (widenRule = vi.fn(() => ({ ok: true as const }))) => ({ widenRule, slot: renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: { ledger: () => ({ ...fixtureLedger, rules }), decor: () => fixtureDecor, registry: () => fixtureRegistry, widenRule } }) });

  it("shows each rule's scope and the rule in full, with widen only where it can widen", async () => {
    const { slot } = renderLedger();
    const list = await slot.findByRole("region", { name: "Standing rules" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map(r => r.querySelector(".src")!.textContent)).toEqual(["This Keeper", `This quest: ${fixtureQuest.title}`, "All Keepers"]);
    expect(within(rows[0]!).getByText("Keep every Vault PR under 400 changed lines").getAttribute("title")).toBeNull();
    expect(within(rows[0]!).getByRole("button", { name: "Apply to all Keepers" })).toBeTruthy();
    expect(within(rows[2]!).queryByRole("button", { name: "Apply to all Keepers" })).toBeNull();
    slot.lifecycle.unmount();
  });

  it("widens through widenRule to all Keepers after the inline confirm", async () => {
    const { slot } = renderLedger();
    const list = await slot.findByRole("region", { name: "Standing rules" });
    const row = within(list).getAllByRole("listitem")[0]!;
    fireEvent.click(within(row).getByRole("button", { name: "Apply to all Keepers" }));
    fireEvent.click(within(within(row).getByRole("group")).getByRole("button", { name: "Apply to all Keepers" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.find(c => c.method === "widenRule")?.input).toEqual({ ruleId: "rk", scope: "global" }));
    slot.lifecycle.unmount();
  });
});

describe("Same-family Warden", () => {
  const warden = (checkIndependence?: "independent" | "same-family") => ({ ...fixtureMember, threadId: "vex-1", role: "member" as const, classId: "warden", keeperThreadId: "keeper-1", boardQuestId: fixtureQuest.id, displayName: "Vex", place: "table" as const, state: "waiting" as const, ...(checkIndependence ? { checkIndependence } : {}) });
  const ledgerWith = (m: ReturnType<typeof warden>) => renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: { ledger: () => ({ ...fixtureLedger, boardQuests: [{ ...fixtureQuest, members: [m] }] }), decor: () => fixtureDecor, registry: () => fixtureRegistry } });

  it("labels the Ledger quest and the party with the exact words", async () => {
    const slot = ledgerWith(warden("same-family"));
    const quest = await slot.findByRole("region", { name: `Board quest: ${fixtureQuest.title}` });
    expect(within(quest).getByText("same-family check (not independent)").closest("p")!.textContent).toContain("Vex");
    slot.lifecycle.unmount();
    const view = render(<div className="tavern"><PartyPicture members={[warden("same-family")]} registry={fixtureRegistry} /></div>);
    expect(view.getByText("same-family check (not independent)")).toBeTruthy();
  });

  it("shows no label when the check is independent or the field is absent", async () => {
    for (const m of [warden("independent"), warden()]) {
      const slot = ledgerWith(m);
      await slot.findByRole("region", { name: `Board quest: ${fixtureQuest.title}` });
      expect(slot.queryByText(/same-family check/)).toBeNull();
      slot.lifecycle.unmount();
    }
  });
});

describe("Guard posture", () => {
  const smith = (mode?: "pre-exec" | "detection-only") => ({ ...fixtureMember, threadId: "juno-1", role: "member" as const, classId: "smith", keeperThreadId: "keeper-1", boardQuestId: fixtureQuest.id, displayName: "Juno", place: "road" as const, state: "working" as const, ...(mode ? { guardPosture: { providerId: "codex", mode, label: mode === "detection-only" ? "detection only (not prevented)" : "Pi pre-exec guard and watcher", approvalAskId: null } } : {}) });
  const ledgerWith = (m: ReturnType<typeof smith>) => renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: { ledger: () => ({ ...fixtureLedger, boardQuests: [{ ...fixtureQuest, members: [m] }] }), decor: () => fixtureDecor, registry: () => fixtureRegistry } });

  it("shows the server's exact words for a detection-only member in the Ledger, the party and the crest tooltip", async () => {
    const slot = ledgerWith(smith("detection-only"));
    const quest = await slot.findByRole("region", { name: `Board quest: ${fixtureQuest.title}` });
    expect(within(quest).getByText("detection only (not prevented)").closest("p")!.textContent).toContain("Juno");
    expect(within(quest).getByRole("button", { name: /detection only \(not prevented\)/ })).toBeTruthy();
    slot.lifecycle.unmount();
    const view = render(<div className="tavern"><PartyPicture members={[smith("detection-only")]} registry={fixtureRegistry} /></div>);
    expect(view.getByText("detection only (not prevented)").className).toContain("guard-detect");
  });

  it("keeps a pre-exec guard to the tooltip and shows nothing without a posture", async () => {
    const view = render(<div className="tavern"><PartyPicture members={[smith("pre-exec")]} registry={fixtureRegistry} onOpen={() => {}} /></div>);
    expect(view.queryByText("Pi pre-exec guard and watcher")).toBeNull();
    expect(view.getByRole("button", { name: /Pi pre-exec guard and watcher/ })).toBeTruthy();
    cleanup();
    const slot = ledgerWith(smith());
    await slot.findByRole("region", { name: `Board quest: ${fixtureQuest.title}` });
    expect(slot.queryByText(/detection only/)).toBeNull();
    slot.lifecycle.unmount();
  });
});
