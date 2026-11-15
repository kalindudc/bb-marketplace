// @vitest-environment node
import { seedQuest } from "./support";
import { describe, expect, it } from "vitest";
import { setup } from "./runtime-fixture";
import { planInput } from "./support";
import { registerTools } from "../../src/server/tools";
import { registerRpc } from "../../src/server/rpc";
import { readStatus, statusInput } from "../../src/server/status";

async function goal() {
  const f = setup();
  const q = await seedQuest(f.k,"lead", "Vault cutover", "Vault");
  return { ...f, q };
}
describe("durable Keeper memory", () => {
  it("requires notes consideration on every agent route and records route notes with the original user source", async () => {
    const f = await goal();
    registerTools(f.bb, f.runtime);
    f.k.receiveUser("lead", "Luc is available until five");
    await expect(
      f.harness.behavior.invokeAgentTool(
        "tavern_route",
        { kind: "question", summary: "Clarify availability" },
        { threadId: "lead" },
      ),
    ).rejects.toThrow("notes");
    await f.harness.behavior.invokeAgentTool(
      "tavern_route",
      {
        kind: "question",
        summary: "Clarify availability",
        notes: [{ kind: "fact", text: "Luc is available until five" }],
      },
      { threadId: "lead" },
    );
    const note = f.k.memory.notes("lead")[0]!;
    expect(note.text).toBe("Luc is available until five");
    expect(note.sourceMessageId).toBeTruthy();
    expect(f.k.store.messageText(note.sourceMessageId!)).toBe(
      "Luc is available until five",
    );
  });
  it("requires a time or condition for commitments and emits one durable due event", async () => {
    const f = await goal();
    registerTools(f.bb, f.runtime);
    await expect(
      f.harness.behavior.invokeAgentTool(
        "tavern_note",
        { op: "add", kind: "commitment", text: "I will return" },
        { threadId: "lead" },
      ),
    ).rejects.toThrow();
    const note = f.k.memory.note("lead", {
      kind: "commitment",
      text: "Check totals",
      boardQuestId: f.q.id,
      dueAt: f.time() + 600_000,
    });
    expect(f.k.restatement("lead")).toContain("Check totals");
    f.k.memory.due("lead");
    expect(
      f.k.store.events("lead").filter((e) => e.type === "promise.due"),
    ).toHaveLength(0);
    f.advance(600_001);
    f.k.memory.due("lead");
    f.k.memory.due("lead");
    expect(
      f.k.store.events("lead").filter((e) => e.type === "promise.due"),
    ).toHaveLength(1);
    f.k.memory.complete("lead", note.id);
    expect(f.k.memory.notes("lead")).toHaveLength(0);
  });
  it("restores a fact and waiting-on-user hand-back after compaction and exposes them in the Ledger", async () => {
    const f = await goal();
    registerRpc(f.bb, f.runtime);
    f.k.memory.note("lead", {
      kind: "fact",
      text: "The release train leaves Thursday",
      boardQuestId: f.q.id,
    });
    f.k.memory.note("lead", {
      kind: "waiting-on-user",
      text: "Send the missing-plugins acceptance line",
    });
    f.advance(61_000);
    f.k.reanchor("lead", "thread/compacted");
    await f.runtime.tick("lead");
    const send = f.harness.inspection.sdk.callsTo("threads.send")[0]!
      .args[0] as { input: { text: string }[] };
    expect(send.input[0]!.text).toContain("The release train leaves Thursday");
    expect(send.input[0]!.text).toContain(
      "Send the missing-plugins acceptance line",
    );
    expect(
      await f.harness.invokeRpc("ledger", { threadId: "lead" }),
    ).toMatchObject({
      notes: expect.arrayContaining([
        expect.objectContaining({ kind: "fact" }),
        expect.objectContaining({ kind: "waiting-on-user" }),
      ]),
    });
  });
  it("expires facts and rejects cross-Keeper note completion without changing the record", async () => {
    const f = await goal();
    f.k.bind("other", "keeper", "moss", "project");
    const note = f.k.memory.note("lead", {
      kind: "fact",
      text: "Luc is online",
      validUntil: f.time() + 100,
    });
    expect(() => f.k.memory.complete("other", note.id)).toThrow("own");
    expect(f.k.memory.notes("lead")).toHaveLength(1);
    f.advance(101);
    expect(f.k.memory.notes("lead")).toHaveLength(0);
    expect(f.k.store.get("notes", note.id)?.text).toBe("Luc is online");
  });
  it("records outside-gate contact and repeats unasked gates after greenlight until asked", async () => {
    const f = await goal();
    f.k.plan("lead", {
      ...planInput(f.q.id),
      waypoints: [
        {
          ...planInput(f.q.id).waypoints[0]!,
          actor: "outside",
          owner: "Luc",
          title: "Approval",
          leadTime: "Thursday 10:00",
        },
      ],
    });
    f.k.answerAsk(f.k.asks("lead")[0]!.id, "approve", null, "page");
    expect(f.k.memory.unaskedGates("lead")).toContainEqual(
      expect.stringContaining(
        "Outside gate Approval not asked yet (lead time Thursday 10:00)",
      ),
    );
    expect(f.k.memory.unaskedGates("lead")).toHaveLength(1);
    f.k.memory.gate("lead", {
      boardQuestId: f.q.id,
      waypointId: "w1",
      askedWho: "Luc",
      via: "User supplied the question",
      answer: "Approved",
    });
    expect(f.k.memory.unaskedGates("lead")).toHaveLength(0);
    expect(f.k.summary(f.q.id).waypoints[0]!.gate).toMatchObject({
      askedWho: "Luc",
      answer: "Approved",
      askedAt: f.time(),
      answeredAt: f.time(),
    });
    expect(f.k.restatement("lead")).toContain("User supplied the question");
  });
  it("supports clarification asks without a default", async () => {
    const f = await goal();
    const ask = f.k.ask("lead", {
      kind: "decision",
      question: "What should become faster?",
      why: "The target is ambiguous",
      options: [{ id: "a", label: "Startup", detail: "", recommended: true }],
      meanwhile: "Continue independent work",
      holds: [],
    });
    expect(ask.proceedAt).toBeNull();
    expect(f.k.restatement("lead")).toContain("waits for you");
  });
  it("places newest rules first and exposes all omitted rules through status paging", async () => {
    const f = await goal();
    for (let i = 0; i < 12; i++) {
      f.advance(1);
      f.k.addRule(
        {
          scope: "keeper",
          scopeId: "lead",
          text: `RULE-${i} ${"x".repeat(290)}`,
          source: "user",
        },
        "lead",
      );
    }
    f.k.addRule(
      {
        scope: "keeper",
        scopeId: "lead",
        text: "Rangers under eight minutes",
        source: "keeper-proposed",
      },
      "lead",
    );
    const text = f.k.restatement("lead");
    expect(text.startsWith("Standing rules:")).toBe(true);
    expect(text.indexOf("RULE-11 ")).toBeLessThan(text.indexOf("RULE-10 "));
    expect(text).toContain("Proposed, waiting for the user");
    expect(text).toContain("Rangers under eight minutes");
    expect(text).toMatch(/older rules; call tavern_status section=rules/);
    const page = readStatus(
      f.runtime,
      "lead",
      statusInput.parse({ section: "rules", limit: 10, offset: 10 }),
    );
    expect(JSON.stringify(page)).toContain("RULE-0 ");
  });
});
