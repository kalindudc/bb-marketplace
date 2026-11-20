import { expect, it } from "vitest";
import { within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { AskCard } from "../../../src/ui/kit/ask-card";
import { fixtureAsk, fixtureGreenlight, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { KeepersSection } from "../../../src/ui/page/settings";
import { settingsView } from "../../../src/ui/page/fixtures-insights";

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

const greenlight = () => renderSlot({ component: AskCard }, { ask: fixtureGreenlight }, { rpc: {
  registry: () => fixtureRegistry,
  questAuthority: () => ({ keeperName: "Wren", rows: [{ kind: "cluster-write", lane: "user" }], delegations: [], preapprovals: [], review: { used: 0, total: 3 }, spendBudget: null }),
} });

it("states the cluster write rule on both greenlight and delegation", async () => {
  const slot = greenlight();
  try {
    expect(slot.getByText("Cluster writes always ask you, even after you approve the quest map.")).toBeTruthy();
    await slot.findByRole("heading", { name: "Authority on this quest" });
    const delegation = slot.getByText("Let Wren decide for this quest");
    expect(within(delegation.parentElement!).getByText("Cluster writes always ask you and cannot be delegated.")).toBeTruthy();
  } finally { slot.lifecycle.unmount(); }
});

it.runIf(process.env.TAVERN_LAYOUT_HARNESS === "1")("renders the cluster ask, greenlight and settings fixtures", async () => {
  const cluster = renderSlot({ component: AskCard }, { ask: { ...clusterAsk, options: [{ id: "approve", label: "Approve the act", detail: "Approve one run of this exact command. A changed command or another run needs a new ask.", recommended: false }, { id: "deny", label: "Decline the act", detail: "Do not authorize this act.", recommended: false }], target: { command: "kubectl --context 'demo context' apply -f ./deployment-with-a-long-unbroken-name-for-the-cluster-approval-fixture.yaml --namespace=tools && helm --kube-context other -n apps upgrade release ./chart" } }, onFold: () => {} });
  const plan = greenlight();
  const settings = renderSlot({ component: KeepersSection }, {}, { rpc: { settings: () => settingsView } });
  try {
    await plan.findByRole("heading", { name: "Authority on this quest" });
    await settings.findByRole("group", { name: "Always ask" });
    plan.getByText("Let Wren decide for this quest").parentElement!.setAttribute("open", "");
    process.stdout.write("LAYOUT_HARNESS=" + JSON.stringify(Object.fromEntries(Object.entries({ cluster, plan, settings }).map(([name, slot]) => [name, slot.container.innerHTML]))) + "\n");
  } finally { for (const slot of [cluster, plan, settings]) slot.lifecycle.unmount(); }
});
