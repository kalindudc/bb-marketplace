// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { eventMoments, MOMENT_CARD_BYTES, parseKeeperCards, renderKeeperCards } from "../../src/server/keeper/cards";
import type { TavernEvent } from "../../src/shared/schema";
import { setup } from "./runtime-fixture";
import { planInput, seedQuest } from "./support";

const raw = readFileSync(new URL("../../skills/tavern-keeper/SKILL.md", import.meta.url), "utf8");
const label = "Reference from your skill (quoted)";
const actor = { kind: "tavern" as const };
const databases: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

async function fixture() {
  const f = setup({}, undefined, parseKeeperCards(raw)); databases.push(f.k.store.db);
  const q = await seedQuest(f.k, "lead", "Handle the parser", "Parser");
  f.k.endTurn("lead");
  f.k.plan("lead", planInput(q.id));
  f.k.store.patch("lead", { cursor: f.k.store.eventSequence("lead"), userAt: null, reanchor: null });
  const send = vi.spyOn(f.bb.sdk.threads, "send");
  const tick = async () => {
    f.advance(180_000);
    await f.runtime.tick("lead");
    const input = send.mock.calls.at(-1)?.[0].input;
    return input?.[0]?.type === "text" ? input[0].text : "";
  };
  const held = (questId = q.id) => f.k.store.event(f.time(), "lead", questId, "scope.act-held", "Held staging act", { act: "deploy" }, actor);
  return { ...f, q, tick, held, send };
}

it("boot validation names a missing required heading", () => {
  expect(() => parseKeeperCards(raw.replace("## Scout\n", "## Not Scout\n"))).toThrow(/missing.*Scout/i);
  expect(() => parseKeeperCards(raw)).not.toThrow();
});

it("quotes the exact shipped section on a held act, only once per quest in an anchor generation", async () => {
  const f = await fixture();
  f.held();
  const text = await f.tick();
  expect(text).toContain("Held staging act");
  expect(text).toContain(`${label}`);
  const section = raw.match(/^## Decide a member's request\n[\s\S]+?(?=^## )/m)![0].trimEnd();
  expect(text).toContain(`\`\`\`text\n${section}\n\`\`\``);
  f.held();
  expect(await f.tick()).not.toContain(label);
  const another = await seedQuest(f.k, "lead", "Check a different parser", "Different");
  f.k.store.patch("lead", { cursor: f.k.store.eventSequence("lead"), userAt: null });
  f.held(another.id);
  expect(await f.tick()).toContain("## Decide a member's request");
  f.k.reanchor("lead", "after compaction");
  expect(await f.tick()).toMatch(/Reference from your skill \(quoted\)[\s\S]*## Recover after compaction/);
  f.held();
  expect(await f.tick()).toContain("## Decide a member's request");
});

it("does not consume a card when its queued tick is cancelled", async () => {
  const f = await fixture();
  f.send.mockResolvedValueOnce({ delivery: "queued" } as never);
  f.held();
  const queued = await f.tick();
  expect(queued).toContain("## Decide a member's request");
  f.runtime.cancelTick(queued);
  expect(await f.tick()).toContain("## Decide a member's request");
});

it("uses the ledger allowance for cards without clipping facts or either fence", async () => {
  const f = await fixture();
  const ledgerCap = f.k.settings().keepers.restatementBytes;
  const ledger = f.k.ledger("lead");
  vi.spyOn(f.k, "ledger").mockReturnValue({ ...ledger, text: "é".repeat(ledgerCap / 2) });
  f.held();
  const tick = await f.tick();
  const quoted = tick.slice(tick.indexOf(label), tick.indexOf("\n\nWhat to do next:"));
  expect(quoted).toContain("[Truncated;");
  expect(quoted).toMatch(/```text[\s\S]*## Decide a member's request[\s\S]*```[\s\S]*```text[\s\S]*```/);
  expect(Buffer.byteLength(quoted)).toBeLessThanOrEqual(ledgerCap);
  expect(tick).toContain("Held staging act");
});

it("selects guidance from quest and waypoint receipts", async () => {
  const f = await fixture();
  const skill = parseKeeperCards(raw);
  const reference = (type: string, data: TavernEvent["data"] = {}, progress = { any: false, all: false }) =>
    renderKeeperCards(skill, eventMoments(f.k, { id: 1, at: f.time(), keeperThreadId: "lead", boardQuestId: f.q.id, actor, type, text: "", data }, () => progress));
  expect(reference("quest.opened")).toBe("");
  expect(reference("plan.proposed", { phase: { from: "scout", to: "greenlight" } })).toContain("## Tell the user");
  const ask = f.k.store.openAsks("lead", f.q.id).find(a => a.kind === "greenlight")!;
  f.k.answerAsk(ask.id, "approve", null, "page", "user");
  const staffing = reference("ask.answered", { askId: ask.id });
  expect(staffing).toMatch(/## Staff the work[\s\S]*## Write a brief/);
  expect(Buffer.byteLength(staffing)).toBeLessThanOrEqual(MOMENT_CARD_BYTES);
  f.k.receiveUser("lead", "Check the slow edge case too");
  const steer = f.k.route("lead", { kind: "steer", boardQuestId: f.q.id, summary: "Slow edge", notes: [] });
  expect(reference("route.recorded", { routeId: steer.id })).toContain("## Handle a steer");
  expect(reference("waypoint.review-round", { verdict: "verified" }, { any: true, all: false })).toContain("## Tell the user");
  expect(reference("waypoint.review-round", { verdict: "verified" }, { any: true, all: true })).toContain("## Close a quest");
  expect(reference("quest.wrapped")).toContain("## Learn from a quest");
  expect(reference("quest.stopped")).toContain("## Learn from a quest");
});

it("does not defer news into an extra tick when card references cannot fit together", async () => {
  const f = await fixture();
  f.held();
  f.k.store.event(f.time(), "lead", f.q.id, "member.failed", "Maker failed", {}, actor);
  const first = await f.tick();
  expect(first).toContain("## Decide a member's request");
  expect(first).toContain("Maker failed");
  await f.tick();
  expect(f.send).toHaveBeenCalledTimes(1);
  f.held();
  expect(await f.tick()).toContain("## Track progress");
});

it("does not schedule a tick after the Keeper opens or plans a quest, and only carries live moments", async () => {
  const f = setup({}, undefined, parseKeeperCards(raw)); databases.push(f.k.store.db);
  const q = await seedQuest(f.k, "lead", "Handle the parser", "Parser");
  f.k.store.patch("lead", { userAt: null, reanchor: null });
  f.k.endTurn("lead");
  const send = vi.spyOn(f.bb.sdk.threads, "send");
  const tick = async () => { f.advance(180_000); await f.runtime.tick("lead"); };
  await tick();
  expect(send).not.toHaveBeenCalled();
  f.k.plan("lead", planInput(q.id));
  f.k.endTurn("lead");
  await tick();
  expect(send).not.toHaveBeenCalled();
  f.k.store.event(f.time(), "lead", q.id, "rules.changed", "Rules changed", {}, actor);
  await tick();
  expect(send).toHaveBeenCalledTimes(1);
  const input = send.mock.calls[0]?.[0].input;
  const text = input?.[0]?.type === "text" ? input[0].text : "";
  expect(text).toContain("Rules changed");
  expect(text).toContain("## Tell the user");
  expect(text).not.toContain("## Take a thin goal");
});
