// @vitest-environment jsdom
import { fireEvent, waitFor, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect, it, vi } from "vitest";
import { QuestMapCard } from "../../../src/ui/thread/cards";
import { ThreadWidget } from "../../../src/ui/thread/composer";
import { LedgerTab } from "../../../src/ui/thread/tabs";
import { fixtureDecor, fixtureDetail, fixtureLedger, fixtureMember, fixturePlan, fixtureRegistry } from "../../../src/ui/thread/fixtures";

const why = "Check the signal every hour";
const permanent = { why, decisionId: "watch", closingExemption: { why: "Cover the night shift", decisionId: "shift" } };
const plan = { ...fixturePlan, party: [{ classId: "smith", characterId: null, model: null, purpose: "Monitor", waypointIds: ["w1"], permanent: { why: permanent.why, decisionId: permanent.decisionId } }] };
const member = { ...fixtureMember, threadId: "watcher", role: "member" as const, keeperThreadId: "keeper-1", boardQuestId: fixtureDetail.quest.id, permanent };
const quest = { ...fixtureDetail.quest, plan, members: [member] };
const decision = { keeperThreadId: "keeper-1", boardQuestId: quest.id, id: permanent.decisionId,
  text: "Keep the watcher as a permanent member", why, source: "keeper" as const, sourceRef: null, permanentChange: { memberThreadId: member.threadId }, reversible: true, undone: false, createdAt: Date.now() };

it("shows the reason on the plan's party before greenlight", async () => {
  const detail = { ...fixtureDetail, plans: [plan], quest: { ...quest, greenlitVersion: null } };
  const slot = renderSlot({ component: () => <QuestMapCard detail={detail} version={plan.version} /> }, {}, {
    composer: { scope: { kind: "thread", threadId: "keeper-1" } }, rpc: { registry: () => fixtureRegistry },
  });
  try {
    expect(await slot.findByText(`Permanent: ${why}`)).toBeTruthy();
    expect(await slot.findByRole("button", { name: /Form the party/ })).toBeTruthy();
  } finally { slot.lifecycle.unmount(); }
});

it("shows the permanent member on its banner and the reasons and Undo in the Ledger", async () => {
  const undoDecision = vi.fn((_input: unknown) => ({ ok: true }));
  const slot = renderSlot({
    component: () => <><ThreadWidget threadId={member.threadId} /><LedgerTab threadId="keeper-1" environment={null} params={null} /></>,
  }, {}, {
    composer: { scope: { kind: "thread", threadId: member.threadId } },
    rpc: {
      decor: (input: unknown) => (input as { threadId: string }).threadId === member.threadId
        ? { ...fixtureDecor, threadId: member.threadId, member, keeper: fixtureMember, boardQuest: quest, keeperView: null }
        : fixtureDecor,
      registry: () => fixtureRegistry, ledger: () => ({ ...fixtureLedger, boardQuests: [quest], decisions: [decision] }), undoDecision,
    },
  });
  try {
    expect(await slot.findByText("Permanent", { exact: true })).toBeTruthy();
    expect(await slot.findByText(/Closing time pause exempt \(guard required\): Cover the night shift/)).toBeTruthy();
    const history = (await slot.findByText("All decisions")).closest("details")!;
    fireEvent.click(history.querySelector("summary")!);
    fireEvent.click(await within(history).findByRole("button", { name: `Undo: ${decision.text}` }));
    await waitFor(() => expect(undoDecision.mock.calls[0]?.[0]).toMatchObject({ decisionId: decision.id }));
  } finally { slot.lifecycle.unmount(); }
});
