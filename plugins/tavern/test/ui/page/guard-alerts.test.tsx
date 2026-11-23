// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { useComposer } from "@get-bb/plugin-sdk/app";
import { useKeeperAlertDraft } from "../../../src/ui/kit/alert-action";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { useState } from "react";
import { Guardrails } from "../../../src/ui/page/record";
import { fixtureDetail, fixtureMember, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import type { BoardQuestDetail } from "../../../src/shared/contract";

afterEach(cleanup);

const scope = { threadId: "maker", scope: null, error: null, armed: false, pendingAskId: null, mode: "enforce" as const };
const row = (threadId: string, engagement: NonNullable<typeof fixtureMember.engagement>) => (
  { ...fixtureMember, threadId, role: "member" as const, displayName: threadId, engagement }
);
const members = new Map([row("maker", "active"), row("starting", "briefing"), row("left", "released"), row("old", "archived")].map(m => [m.threadId, m]));
const missing = { ...scope, guardCheckFailed: true };
const bind = { ...scope, armed: true, problems: ["The Smith runs as a Ranger until its worktree is bound."] };

function show(initial: NonNullable<BoardQuestDetail["scopes"]>, next = initial) {
  const recheck = vi.fn();
  function Surface() {
    const [scopes, setScopes] = useState(initial);
    const composer = useComposer();
    useKeeperAlertDraft("keeper-1", composer);
    return <><Guardrails compact detail={{ ...fixtureDetail, scopes }} registry={fixtureRegistry} members={members} recheck={() => { recheck(); setScopes(next); }} /><output>{composer.text}</output></>;
  }
  return { slot: renderSlot({ component: Surface }, {}, { composer: { scope: { kind: "thread", threadId: "fixture-other" }, text: "Existing draft" } }), recheck };
}

it("counts current alerts per live thread, not startup, old or duplicate members", () => {
  const { slot } = show([missing, missing, { ...scope, threadId: "starting" }, { ...bind, threadId: "left" }, { ...bind, threadId: "old" }]);
  expect(slot.getByText(/2 members · 1 need attention/)).toBeTruthy();
  expect(slot.getAllByRole("button", { name: "Done" })).toHaveLength(1);
  fireEvent.click(slot.getByRole("button", { name: "Show each member" }));
  expect(slot.queryByText("left", { exact: true })).toBeNull();
  expect(slot.queryByText("old", { exact: true })).toBeNull();
  expect(slot.getByText("starting", { exact: true })).toBeTruthy();
});

it("waits for a confirmed missing guard, then re-checks without changing scope", async () => {
  const { slot, recheck } = show([missing], [{ ...scope, armed: true }]);
  expect(slot.getByText(/Restart .*session/)).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Done" }));
  expect(recheck).toHaveBeenCalledOnce();
  await waitFor(() => expect(slot.queryByRole("button", { name: "Done" })).toBeNull());
});

it("drafts the worktree repair only in the Keeper’s composer, with a Copy fallback", async () => {
  const { slot } = show([bind]);
  const alert = slot.container.querySelector("[data-guard-alert]")!;
  const action = within(alert as HTMLElement).getByRole("button", { name: "Tell the Keeper" });
  expect(within(alert as HTMLElement).getByText(/Bind maker’s worktree/)).toBeTruthy();
  fireEvent.click(within(alert as HTMLElement).getByRole("button", { name: "Copy" }));
  await waitFor(() => expect(slot.inspection.experimental_clipboardWrites).toEqual([{ text: expect.stringMatching(/Bind maker’s worktree/) }]));
  fireEvent.click(action);
  expect(slot.inspection.navigateCalls).toHaveLength(1);
  expect(slot.getByText("Existing draft", { selector: "output" })).toBeTruthy();
  await slot.behavior.setComposerScope({ kind: "thread", threadId: "keeper-1" });
  expect(slot.getByText(/Existing draft.*Bind maker’s worktree/, { selector: "output" })).toBeTruthy();
});

it.each([
  [{ ...scope, error: "Invalid saved scope" }, "Tell the Keeper"],
  [{ ...scope, problems: ["The project policy could not be read"] }, "Tell the Keeper"],
  [{ ...scope, pendingAskId: "grant-1" }, "Review the ask"],
  [{ ...scope, armed: true, clusterGuard: "not-prevented" as const }, "Tell the Keeper"],
  [missing, "Done"],
  [bind, "Tell the Keeper"],
])("provides a single recommended action for each current guard alert (%j)", (alert, action) => {
  const { slot } = show([alert]);
  const rec = slot.container.querySelectorAll("[data-alert-action]");
  expect(rec).toHaveLength(1);
  expect(within(rec[0] as HTMLElement).getByRole("button", { name: action })).toBeTruthy();
});
