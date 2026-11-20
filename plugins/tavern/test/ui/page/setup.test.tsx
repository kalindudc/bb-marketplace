import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, it, vi } from "vitest";
import { SetupSettings, SetupDirective } from "../../../src/ui/page/setup";
import { setupPrompt, type SetupProposal } from "../../../src/shared/setup";

afterEach(cleanup);

const proposal = {
  id: "96e9502e-fca5-4e74-8368-135da4a589a3", threadId: "thr_review", classId: "smith", proposedAt: 1795143990000, conflicts: [], revision: 12, state: "pending", decisionId: null, forgeProbe: true,
  changes: [
    { key: "machines.forges", from: [{ id: "old", name: "Old forge", kind: "github" }], to: [{ id: "review-drafts", name: "Draft review", kind: "command", open: "/home/operator/.local/bin/open-review-draft", enabled: true }], kind: "set", reason: "Open pull requests from your source machine." },
    { key: "machines.rules", from: [], to: [{ id: "dedicated-review", label: "Dedicated review", enabled: true, match: { projectIds: ["platform"] }, target: { kind: "provider", workspace: "dedicated-machine", environmentProviderId: "checkout", machine: { type: "new", machineProviderId: "isolated" } }, classModels: { warden: { model: "elm/checker" } }, consent: { guardInstall: true, remoteDetectionOnly: true, linuxUncontainedChecks: true }, pullRequests: { at: "home", profile: "review-drafts" } }], kind: "set", reason: "Give the review its own checkout." },
    { key: "classes.smith.model", from: "builder-small", to: "oak/builder-long-context", kind: "set", reason: "Use a model with room for the repository." },
    { key: "classes.warden.model", from: null, to: "elm/checker", kind: "set", reason: "Use an independent model for checks." },
  ],
  preflight: [{ key: "machines.forges.0.open", status: "fail", message: "Script does not exist." },
    { key: "machines.rules.0.target", status: "pass", message: "bb offers checkout for this target." },
    { key: "machines.rules.0.classModels.warden", status: "unchecked", message: "No machine exists for this rule." }],
} satisfies SetupProposal & { classId: string; proposedAt: number; conflicts: unknown[] };
function directive(p: SetupProposal, apply = vi.fn()) {
  return renderSlot({ component: SetupDirective }, { attributes: { id: p.id }, message: { threadId: p.threadId! } } as never, {
    rpc: { setupProposal: () => p, setupApply: apply, setupDismiss: () => ({ ...p, state: "dismissed" }) },
  });
}
it("renders reasons, failed and unchecked preflight, and keeps Apply unavailable when checking fails", async () => {
  const s = directive(proposal);
  expect(await s.findByText("Give the review its own checkout.")).toBeTruthy();
  expect(s.getByText("Needs a fix")).toBeTruthy();
  expect(s.getByText("Not checked yet")).toBeTruthy();
  expect(s.getByText("Uses the gh CLI on this machine")).toBeTruthy();
  expect(s.getByText("Lets members run Linux checks outside containment")).toBeTruthy();
  expect(s.getByText("Draft review, open script")).toBeTruthy();
  fireEvent.click(s.getByRole("button", { name: "@thr_review" }));
  expect(s.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_review" });
  expect(s.getAllByText("Agent's reason:")).toHaveLength(4);
  expect(s.getAllByText("Guardrail")).toHaveLength(2);
  expect(s.getAllByText("Show as settings JSON")).toHaveLength(2);
  expect(s.getByRole("button", { name: "Apply" }).getAttribute("aria-describedby")).toBeTruthy();
  expect((s.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(s.getByRole("button", { name: "Dismiss" }));
  expect(await s.findByText("Dismissed.")).toBeTruthy();
});
it("applies a ready proposal from the card and reports the result", async () => {
  const p = { ...proposal, preflight: proposal.preflight.filter(line => line.status !== "fail") };
  const apply = vi.fn(() => ({ ...p, state: "applied", decisionId: "receipt" }));
  const s = directive(p, apply);
  fireEvent.click(await s.findByRole("button", { name: "Apply" }));
  expect(await s.findByText("Applied. See Settings history for the receipt.")).toBeTruthy();
  expect(apply).toHaveBeenCalledWith({ id: p.id });
});
it("expands at most one proposal and seeds the composer with the chosen project and words", async () => {
  const s = renderSlot({ component: SetupSettings }, {}, { rpc: {
    setupPending: () => [proposal, { ...proposal, id: "86e9502e-fca5-4e74-8368-135da4a589a3", threadId: "thr_second" }], setupProjects: () => [{ id: "platform", name: "Platform" }],
  } });
  const first = await s.findByRole("button", { name: /review proposal from @thr_review/i });
  const second = s.getByRole("button", { name: /review proposal from @thr_second/i });
  fireEvent.click(first);
  expect(await s.findByText("Use an independent model for checks.")).toBeTruthy();
  fireEvent.click(second);
  expect(first.getAttribute("aria-expanded")).toBe("false");
  expect(second.getAttribute("aria-expanded")).toBe("true");
  expect(s.getAllByText("Use an independent model for checks.")).toHaveLength(1);
  fireEvent.change(s.getByLabelText("Project"), { target: { value: "platform" } });
  fireEvent.change(s.getByLabelText("What should Tavern be set up for?"), { target: { value: "Use a dedicated checkout for reviews." } });
  fireEvent.click(s.getByRole("button", { name: "Set up with an agent" }));
  await waitFor(() => expect(s.inspection.navigateCalls).toContainEqual({ method: "toCompose", options: { projectId: "platform", focusPrompt: true, initialPrompt: setupPrompt("Use a dedicated checkout for reviews.") } }));
});
it("tells the user to ask for a fresh proposal when settings changed", async () => {
  const s = directive({ ...proposal, state: "stale", conflicts: [{ key: "machines.rules", at: 1795143990000 }] });
  expect(await s.findByText("Settings changed. Ask the agent for a fresh proposal.")).toBeTruthy();
  expect(s.getByText(/Machine rules \(machines.rules\) changed on/).querySelector("time")).toBeTruthy();
  expect(s.queryByRole("button", { name: "Apply" })).toBeNull();
});

it.runIf(process.env.TAVERN_LAYOUT_HARNESS === "1")("exports both setup card surfaces for browser measurements", async () => {
  const thread = directive(proposal);
  const settings = renderSlot({ component: SetupSettings }, {}, { rpc: {
    setupPending: () => [proposal], setupProjects: () => [{ id: "platform", name: "Platform" }],
  } });
  fireEvent.click(await within(settings.container).findByRole("button", { name: /review proposal from @thr_review/i }));
  for (const slot of [thread, settings]) await within(slot.container).findByText("Use an independent model for checks.");
  process.stdout.write("SETUP_HARNESS=" + JSON.stringify({ thread: thread.container.innerHTML, settings: settings.container.innerHTML }) + "\n");
});
