// @vitest-environment node
import { expect, it, vi } from "vitest";
import { rpcHandlers } from "../../src/server/rpc";
import { planInput, seedQuest } from "./support";
import { setup } from "./runtime-fixture";

const client = { experimental_caller: { kind: "client" } } as never;

it("RVB probe: a pending proposal stays approvable when the Keeper revises the plan during greenlight", async () => {
  const f = setup({ plugins: { callRpc: vi.fn().mockResolvedValue({ report: null }) } });
  const q = await seedQuest(f.k, "lead", "Budget", "Budget");
  const rpc = rpcHandlers(f.runtime);
  f.k.plan("lead", { ...planInput(q.id), spendBudgetCents: 150 });
  f.k.plan("lead", { ...planInput(q.id), spendBudgetCents: 150, changeNote: "Revised during greenlight" });
  const ask = f.k.store.openAsks("lead", q.id).find(a => a.kind === "greenlight")!;
  expect(ask).toBeTruthy();
  const authority = await rpc.questAuthority({ boardQuestId: q.id });
  await rpc.answerAsk({ askId: ask.id, optionId: "approve", note: null, via: "page", pullRequestChoices: [] }, client);
  const view = await f.runtime.spend.refresh(q.id);
  expect({ cardProposal: (authority as { spendProposal?: number }).spendProposal, budgetCents: view.budgetCents }).toEqual({ cardProposal: 150, budgetCents: 150 });
});
