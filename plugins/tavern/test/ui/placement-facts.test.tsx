import { renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlacementView } from "../../src/shared/placement-view";
import { rpcContract } from "../../src/shared/contract";
import { placementContract, placementPreviewInputSchema } from "../../src/shared/placement-rpc";
import { settingsContract, settingsViewSchema } from "../../src/shared/settings";
import { pendingPlacement, readyPlacement, blockedPlacement, placementHolds } from "./fixtures/placement";
import { detail, registry, room } from "../../src/ui/page/fixtures";
import { settingsView } from "../../src/ui/page/fixtures-insights";
import { machineVolumes, machinesCatalog, previewFixture } from "./fixtures/machines";
import { PartyPicture, SideQuests } from "../../src/ui/page/room";
import { QuestPage } from "../../src/ui/page/quest";
import { MemberPanel } from "../../src/ui/thread/member-brief";
import { ThreadWidget } from "../../src/ui/thread/composer";
import { DirectiveCard } from "../../src/ui/thread/cards";
import { fixtureDecor } from "../../src/ui/thread/fixtures";
import { MachinesPage } from "../../src/ui/page/machines";
import { PlacementFacts } from "../../src/ui/kit/placement";
import { placementHandlers } from "../../src/server/placement/rpc";
import type { TavernRuntime } from "../../src/server/runtime";

const contract = { ...rpcContract, ...placementContract, ...settingsContract };
const slots: RenderedSlot[] = [];
beforeEach(() => window.localStorage.clear());
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); });

function placed(placement: PlacementView | null) {
  const member = { ...detail.quest.members.find(m => m.classId === "smith")!, displayName: "Juno", placement };
  const quest = { ...detail.quest, members: [member], waypoints: detail.quest.waypoints.map(w => ({ ...w, ownerMember: null })) };
  const questDetail = { ...detail, quest };
  const currentRoom = { ...room, keepers: [{ ...room.keepers[0]!, boardQuests: [quest], errands: [{ ...member, errand: true, boardQuestId: null }] }], solos: [] };
  const decor = { ...fixtureDecor, threadId: member.threadId, member, keeperView: null, boardQuest: quest, brief: "Build the parser.", briefFields: null };
  return { member, quest, questDetail, currentRoom, decor };
}
const surfaces = ["room party", "side quests", "quest party", "returned quest", "member panel", "thread widget", "party card", "settings members"] as const;
type Retry = (input: { placementId: string; generation: number }) => Promise<{ ok: true; message: null } | { ok: false; message: string }>;
function mount(surface: typeof surfaces[number], placement: PlacementView | null, retry: Retry = vi.fn<Retry>(async () => ({ ok: true, message: null }))) {
  const f = placed(placement);
  const settings = settingsViewSchema.parse(settingsView);
  const Component = () => surface === "room party" ? <PartyPicture members={[f.member]} registry={registry} quests={[f.quest]} />
    : surface === "side quests" ? <SideQuests room={f.currentRoom} registry={registry} />
    : surface === "quest party" || surface === "returned quest" ? <QuestPage detail={surface === "returned quest" ? { ...f.questDetail, quest: { ...f.quest, phase: "done" } } : f.questDetail} registry={registry} />
    : surface === "member panel" ? <MemberPanel data={f.decor} registry={registry} scopeDetails={null} onQuest={() => {}} />
    : surface === "thread widget" ? <ThreadWidget threadId={f.member.threadId} />
    : surface === "party card" ? <DirectiveCard kind="tavern-party" attributes={{ quest: f.quest.id }} source="tavern-party" message={{ id: "party-message", threadId: f.member.keeperThreadId!, turnId: null, projectId: null }} openWorkspaceFile={null} />
    : <MachinesPage />;
  const slot = renderSlot({ component: Component }, {}, { pluginId: "tavern", experimental_rpcContract: contract, rpc: {
    decor: () => f.decor, registry: () => registry, room: () => f.currentRoom, boardQuest: () => f.questDetail,
    settings: () => settings, placementCatalog: () => machinesCatalog,
    placementPreview: input => previewFixture(settings.effective.machines, placementPreviewInputSchema.parse(input)), placementRetry: input => retry(placementContract.placementRetry.input.parse(input)),
  } });
  slots.push(slot);
  return slot;
}

describe.each(surfaces)("%s placement facts", surface => {
  async function surfaceMount(placement: PlacementView | null, retry?: Retry) {
    const slot = mount(surface, placement, retry);
    if (surface === "returned quest") fireEvent.click(await slot.findByRole("button", { name: /The party.*1 member/ }));
    return slot;
  }
  it("shows the provider while starting, without inventing a host", async () => {
    const slot = await surfaceMount(pendingPlacement);
    await slot.findByText("Vendor sandbox, starting");
    expect(slot.queryByText("Builder machine 17")).toBeNull();
  });
  it("shows the real host, rule link and truthful remote posture", async () => {
    const slot = await surfaceMount(readyPlacement);
    await slot.findByText("Builder machine 17");
    const link = slot.getByRole("link", { name: "Project on a machine" });
    expect(link.getAttribute("href")).toBe("/plugins/tavern/tavern/machines/project-remote");
    expect(slot.getByText("Detection only (remote)")).toBeTruthy();
    expect(slot.getByText("pre-exec checks only, no containment")).toBeTruthy();
  });
  it("shows the exact blocker and retries this placement generation", async () => {
    const retry = vi.fn<Retry>(async () => ({ ok: true, message: null }));
    const slot = await surfaceMount(blockedPlacement, retry);
    const message = await slot.findByText(blockedPlacement.blocker!.message);
    expect(message.closest('[role="status"]')!.textContent).toContain(`Blocked: ${blockedPlacement.blocker!.message}`);
    expect(slot.getByRole("group", { name: "Where Juno runs" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Retry placement for Juno" }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith({ placementId: "placement-juno", generation: 3 }));
    expect(slot.container.querySelector("button button")).toBeNull();
  });
  it("shows unsupported Git as a lasting blocker with no Retry control", async () => {
    const message = "This machine's Git can't carry Tavern's work (git --list-cmds=builtins: unknown option). Members can't be placed on it yet.";
    const slot = await surfaceMount({ ...blockedPlacement, blocker: { stage: "bind", message, retryable: false } });
    await slot.findByText(message);
    expect(slot.queryByRole("button", { name: /Retry placement/ })).toBeNull();
  });
  it.each(placementHolds)("shows $kind as a hold, not an error", async hold => {
    const slot = await surfaceMount({ ...pendingPlacement, phase: "blocked", hold });
    const text = await slot.findByText(hold.message);
    expect(text.closest('[role="status"]')).not.toBeNull();
    expect(text.closest('[role="alert"], .problem, .tv-problem')).toBeNull();
    if (hold.kind === "transfer-slots") expect(slot.getByRole("button", { name: "Retry placement for Juno" })).toBeTruthy();
  });
  it("shows uncommitted source only when the view records it", async () => {
    const source = { includesUncommitted: true, from: "/keeper/project" };
    let slot = await surfaceMount({ ...readyPlacement, source });
    await slot.findByText("Started from uncommitted changes in /keeper/project.");
    slot.lifecycle.unmount();
    slot = await surfaceMount({ ...readyPlacement, source: { ...source, includesUncommitted: false } });
    await slot.findByText("Builder machine 17");
    expect(slot.queryByText(/Started from uncommitted changes/)).toBeNull();
  });
  it("adds no placement facts for an unplaced member", async () => {
    const slot = await surfaceMount(null);
    await waitFor(() => expect(slot.container.textContent).toContain(surface === "settings members" ? "Where work runs" : "Juno"));
    expect(slot.container.querySelector('[data-part="PlacementFacts"]')).toBeNull();
    expect(slot.queryByRole("button", { name: "Retry placement for Juno" })).toBeNull();
  });
});

it("shows the exact refusal from a Retry", async () => {
  const retry = vi.fn<Retry>(async () => ({ ok: false, message: "This placement changed. Refresh before retrying." }));
  const slot = mount("member panel", blockedPlacement, retry);
  fireEvent.click(await slot.findByRole("button", { name: "Retry placement for Juno" }));
  expect((await slot.findByRole("alert")).textContent).toBe("This placement changed. Refresh before retrying.");
});
function previewPage(unsupported = false) {
  const rule = { ...machineVolumes.many.rules[1]!, match: {} };
  if (unsupported && rule.target.kind === "provider") rule.target = { ...rule.target, machine: { type: "keeper" }, workspace: "linked-worktree" };
  const machines = { ...machineVolumes.many, rules: [rule] };
  const settings = settingsViewSchema.parse({ ...settingsView, effective: { ...settingsView.effective, machines }, placementPolicy: { state: "valid", revision: 0, settings: machines } });
  const spawn = vi.fn();
  const runtime = { settings: { placementPolicy: () => ({ state: "valid", revision: 0, settings: machines }), hasUser: () => false }, config: () => settings.effective, snapshot: () => registry, keeper: { member: () => null }, bb: { sdk: { threads: { spawn } } } } as unknown as TavernRuntime;
  const preview = placementHandlers(runtime).placementPreview;
  const slot = renderSlot({ component: MachinesPage }, {}, { pluginId: "tavern", experimental_rpcContract: contract, rpc: {
    settings: () => settings, registry: () => registry, room: () => room, placementCatalog: () => machinesCatalog,
    placementPreview: input => preview({ ...placementPreviewInputSchema.parse(input), projectId: null, keeperThreadId: null }),
  } });
  slots.push(slot);
  return { slot, spawn };
}
it("shows the real unsupported-target refusal without allocating", async () => {
  const { slot, spawn } = previewPage(true);
  const message = await slot.findByText("This rule's target isn't supported in this version.");
  expect(message.closest('[data-verdict="blocked"]')).not.toBeNull();
  expect(slot.queryByText(/Today it waits.*can't run work yet/)).toBeNull();
  expect(spawn).not.toHaveBeenCalled();
});
it("previews a supported shop/world-style rule as remote without allocating", async () => {
  const { slot, spawn } = previewPage();
  await waitFor(() => expect(slot.container.querySelector('[data-verdict]')?.getAttribute('data-verdict')).toBe("caught"));
  const verdict = slot.container.querySelector('[data-verdict]')!;
  expect(verdict.textContent).toContain("Runs on a new Aquifer World sandbox");
  expect(verdict.textContent).toContain("Preview only: nothing is created.");
  expect(verdict.textContent).toContain("Detection only (remote)");
  expect(verdict.textContent).not.toMatch(/Blocked|waits with a blocker|When it runs/);
  expect(spawn).not.toHaveBeenCalled();
});
it("keeps the Settings page honest about enabled machine rules", async () => {
  const slot = mount("settings members", null);
  await slot.findByRole("heading", { name: /Where work runs/ });
  expect(slot.queryByRole("status", { name: "Preview" })).toBeNull();
  await waitFor(() => expect(slot.container.textContent).toContain("Keepers stay where you run them"));
});
it.each(["row", "card"] as const)("shows preservation, phases and remote checker detail in the %s form", async variant => {
  const component = ({ placement }: { placement: PlacementView }) => <PlacementFacts placement={placement} memberName="Juno" variant={variant} />;
  const draw = (placement: PlacementView) => {
    const slot = renderSlot({ component }, { placement });
    slots.push(slot);
    return slot;
  };
  let slot = draw({ ...blockedPlacement, blocker: { ...blockedPlacement.blocker!, stage: "preserve" }, preservation: "unpreserved", preservationReason: "Home transfer refused." });
  expect(slot.getByText("Work save failed; machine kept: Home transfer refused.")).toBeTruthy();
  for (const [preservation, text] of [["pending", "Saving work"], ["saved", "Work saved"], ["unpreserved", "Work not saved"], ["lost", "Work not saved"], ["unknown", "Work not saved"]]) {
    slot.lifecycle.unmount();
    slot = draw({ ...readyPlacement, preservation: preservation! });
    expect(slot.getByText(text!)).toBeTruthy();
    if (["unpreserved", "lost", "unknown"].includes(preservation!)) expect(slot.queryByText(/machine kept/)).toBeNull();
  }
  for (const [phase, text] of [["reserved", "Reserved"], ["provisioning", "Starting the machine"], ["binding", "Setting up"], ["carrying", "Carrying the work in"], ["ready", "Ready"], ["running", "Running"], ["preserving", "Saving its work"], ["releasing", "Releasing"], ["released", "Released"]]) {
    slot.lifecycle.unmount();
    slot = draw({ ...readyPlacement, phase: phase! });
    expect(slot.getByText(text!).closest('[role="status"]')).not.toBeNull();
  }
  slot.lifecycle.unmount();
  slot = draw({ ...readyPlacement, posture: { ...readyPlacement.posture, detail: "detection only, no containment" } });
  expect(slot.getByText("detection only, no containment")).toBeTruthy();
  slot.lifecycle.unmount();
  slot = draw({ ...blockedPlacement, blocker: { ...blockedPlacement.blocker!, retryable: false } });
  expect(slot.queryByRole("button", { name: "Retry placement for Juno" })).toBeNull();
});
