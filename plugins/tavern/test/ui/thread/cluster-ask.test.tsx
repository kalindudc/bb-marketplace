import { expect, it } from "vitest";
import { fireEvent, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { waitFor } from "@testing-library/react";
import { rpcContract } from "../../../src/shared/contract";
import { AskCard } from "../../../src/ui/kit/ask-card";
import { fixtureAsk, fixtureGreenlight, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { KeepersSection } from "../../../src/ui/page/settings";
import { settingsView } from "../../../src/ui/page/fixtures-insights";

it("offers a single Done button to check a restarted guard", async () => {
  const ask = { ...fixtureAsk, kind: "blocker" as const, effect: { type: "repair-guard" as const, memberThreadId: "member" },
    question: "Restart Robin’s Pi session on this machine", why: "Tavern’s guard did not load. Restart the session, then select Done so Tavern can check it.",
    draft: null, holds: [], meanwhile: "The blocked call stays refused. Unrelated work can continue.", options: [{ id: "done", label: "Done", detail: "", recommended: true }] };
  const calls: unknown[] = [];
  const slot = renderSlot({ component: AskCard }, { ask }, { experimental_rpcContract: rpcContract, rpc: {
    answerAsk: input => { calls.push(input); return { ok: true }; },
  } });
  try {
    expect(slot.queryByRole("radio")).toBeNull();
    if (process.env.TAVERN_LAYOUT_HARNESS === "1") process.stdout.write(`GUARD_REPAIR=${JSON.stringify(slot.container.innerHTML)}\n`);
    fireEvent.click(slot.getByRole("button", { name: "Done" }));
    await slot.findByText("Answered");
    expect(calls).toMatchObject([{ askId: ask.id, optionId: "done" }]);
  } finally { slot.lifecycle.unmount(); }
});

const command = "kubectl --context 'demo context' apply -f 'sample manifest.yaml' --namespace=tools";

const clusterAsk = { ...fixtureAsk, kind: "cluster-write" as const, draft: null, question: "Apply the sample change?", why: "You approve every cluster write.", target: { command }, clusterTargets: [{ context: "demo context", namespace: "tools" }, { context: "other", namespace: "apps" }], change: "Updates the sample deployment.", undo: "Restore the previous manifest." };

it("shows the exact cluster command, its target, effect and undo before answering", () => {
  const ask = clusterAsk;
  const slot = renderSlot({ component: AskCard }, { ask });
  try {
    expect(slot.getByText("Cluster write")).toBeTruthy();
    const details = within(slot.getByRole("region", { name: "Ask: Apply the sample change?" }));
    for (const text of [command, "demo context", "tools", "other", "apps", ask.change, ask.undo]) expect(details.getByText(text)).toBeTruthy();
  } finally { slot.lifecycle.unmount(); }
});

it.each(["production", "merge", "destructive", "credential", "sends-as-you"] as const)("shows optional undo instructions on %s asks", kind => {
  for (const undo of [undefined, "Cannot be undone."]) {
    const slot = renderSlot({ component: AskCard }, { ask: { ...fixtureAsk, kind, undo } });
    try {
      expect(Boolean(slot.queryByText("Undo"))).toBe(!!undo);
      if (undo) expect(slot.getByText(undo)).toBeTruthy();
    } finally { slot.lifecycle.unmount(); }
  }
});

it("shows both steps on one card and tells a detection-only thread not to run", async () => {
  const ask = { ...clusterAsk, runThreadId: "keeper-1", runThreadName: "Wren", options: [{ id: "approve", label: "Approve", detail: "", recommended: false }] };
  const approve = { ...ask, clusterApproval: { at: 1000, via: "page" as const, surface: "client (unattested)", note: null }, options: [{ id: "confirm-run", label: "Confirm this run", detail: "", recommended: false }] };
  const guarded = renderSlot({ component: AskCard }, { ask }, { experimental_rpcContract: rpcContract, rpc: { clusterRunStatus: () => ({ guarded: true }), answerAsk: (input: unknown) => rpcContract.answerAsk.input.parse(input).optionId === "approve" ? { ok: true, ask: approve } : { ok: true } } });
  try {
    const vote = await guarded.findByRole("radio", { name: "Approve" });
    await guarded.findByText("Wren");
    await waitFor(() => expect((vote as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(vote);
    fireEvent.click(await guarded.findByRole("button", { name: "Approve" }));
    await guarded.findByRole("heading", { name: "Run it now?" });
    expect(guarded.getByText(command)).toBeTruthy();
    fireEvent.click(guarded.getByRole("radio", { name: "Confirm this run" }));
    fireEvent.click(guarded.getByRole("button", { name: "Run it now" }));
    await guarded.findByText("Answered");
  } finally { guarded.lifecycle.unmount(); }
  const unguarded = renderSlot({ component: AskCard }, { ask }, { rpc: { clusterRunStatus: () => ({ guarded: false }) } });
  try {
    await unguarded.findByText(/This thread cannot be guarded/);
    expect((unguarded.getByRole("radio", { name: "Approve" }) as HTMLInputElement).disabled).toBe(true);
  } finally { unguarded.lifecycle.unmount(); }
});
const greenlight = () => renderSlot({ component: AskCard }, { ask: fixtureGreenlight }, { rpc: {
  registry: () => fixtureRegistry,
  questAuthority: () => ({ keeperName: "Wren", rows: [{ kind: "cluster-write", lane: "user" }], delegations: [], preapprovals: [], review: { used: 0, total: 3 }, spendBudget: null }),
} });

it("states the cluster write rule on both greenlight and delegation", async () => {
  const slot = greenlight();
  try {
    expect(slot.getByText("Cluster writes always ask you, even after you approve the quest map.")).toBeTruthy();
    await slot.findByRole("heading", { name: "Authority on this quest" });
    const delegation = slot.getByText("Let Wren decide for this quest").closest("details")!;
    expect(within(delegation).getByText("Cluster writes always ask you. Only you send messages.")).toBeTruthy();
  } finally { slot.lifecycle.unmount(); }
});

it.runIf(process.env.TAVERN_LAYOUT_HARNESS === "1")("renders the cluster ask, greenlight and settings fixtures", async () => {
  const { setup } = await import("../../server/runtime-fixture");
  const { requireUserAct } = await import("../../../src/server/authority");
  const { k } = setup({}, process.cwd());
  const ask = k.ask("lead", { ...clusterAsk, boardQuestId: null, effect: { type: "decision" }, target: { command: "kubectl --context 'demo context' apply -f ./deployment-with-a-long-unbroken-name-for-the-cluster-approval-fixture.yaml --namespace=tools && helm --kube-context other -n apps upgrade release ./chart" } });
  const renderAsk = (value: typeof ask) => renderSlot({ component: AskCard }, { ask: value, onFold: () => {} }, { rpc: { clusterRunStatus: () => ({ guarded: true }) } });
  const cluster = renderAsk(ask);
  k.answerAsk(ask.id, "approve", null, "page", "user", "client (unattested)", {}, requireUserAct({ experimental_caller: { kind: "client" } } as never, "answerAsk"));
  const second = renderAsk(k.store.get("asks", ask.id)!);
  const plan = greenlight();
  const settings = renderSlot({ component: KeepersSection }, {}, { rpc: { settings: () => settingsView } });
  try {
    await plan.findByRole("heading", { name: "Authority on this quest" });
    await settings.findByRole("group", { name: "Always ask" });
    await waitFor(() => {
      expect((cluster.getByRole("radio", { name: /^Approve/ }) as HTMLInputElement).disabled).toBe(false);
      expect((second.getByRole("radio", { name: /^Run it now/ }) as HTMLInputElement).disabled).toBe(false);
    });
    expect(within(second.container).getByRole("radio", { name: /^Decline/ })).toBeTruthy();
    plan.getByText("Let Wren decide for this quest").closest("details")!.open = true;
    process.stdout.write("LAYOUT_HARNESS=" + JSON.stringify(Object.fromEntries(Object.entries({ cluster, second, plan, settings }).map(([name, slot]) => [name, slot.container.innerHTML]))) + "\n");
  } finally { for (const slot of [cluster, second, plan, settings]) slot.lifecycle.unmount(); }
});
