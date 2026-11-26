// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { captureRequestSources, requestSourcePacket, readRequestSources } from "../../src/server/request-sources";
import { setup } from "./runtime-fixture";
import { planInput, seedLegacyQuest } from "./support";

const databases: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const brief = { outcome: "Return unknown items", mode: "make-it-work" as const, outOfScope: "Publish", doneWhen: "Tests pass", context: [], questions: [], timeboxMinutes: null };
async function fixture(text = 'For NaN return exactly "unknown".') {
  const f = setup(); databases.push(f.k.store.db);
  f.k.receiveUser("lead", text); f.k.route("lead", { kind: "new-quest", summary: "Format counts", notes: [] });
  const q = await f.k.openQuest("lead", "Format counts", "Exact wording"); f.k.plan("lead", planInput(q.id));
  const manifest = captureRequestSources(f.k, "lead", q.id);
  for (const [threadId, classId] of [["maker", "smith"], ["checker", "warden"]]) f.k.bind(threadId!, classId!, null, "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: "w1", title: "Work", errand: false, brief, requestSources: manifest });
  return { ...f, q, manifest };
}

describe("server-owned request source packets", () => {
  it("uses the full stored opening request, never the Keeper summary or the 200-character preview", async () => {
    const text = `${"Context ".repeat(35)}For NaN return exactly "unknown".\nKeep \'quoted\' strings, π and 🦊.\n\`\`\`\nraw fence\n\`\`\``;
    const f = await fixture(text), packet = requestSourcePacket(f.k, f.manifest);
    expect(f.k.store.all("routes")[0]!.userText).not.toContain('"unknown"');
    expect(packet).toContain(text); expect(packet).toContain("User request, verbatim");
    expect(packet).not.toContain("unknown items"); expect(packet.length).toBeLessThanOrEqual(4000);
    expect(readRequestSources(f.k, "maker", { manifestId: f.manifest.id })).toMatchObject({ text, nextOffset: null, nextSourceIndex: null });
  });
  it("retains the opening request and every applicable steer in order, not unrelated messages", async () => {
    const f = await fixture();
    for (const [kind, text] of [["steer", 'Change "unknown" to "missing".'], ["aside", "Private unrelated discussion."], ["steer", "Also trim spaces."]] as const) {
      f.advance(1); f.k.receiveUser("lead", text); f.k.route("lead", { kind, ...(kind === "steer" ? { boardQuestId: f.q.id } : {}), summary: "Keeper paraphrase", notes: [] });
    }
    const manifest = captureRequestSources(f.k, "lead", f.q.id), packet = requestSourcePacket(f.k, manifest);
    expect(manifest.sources).toHaveLength(3);
    expect(packet).toContain('For NaN return exactly "unknown".'); expect(packet).toContain('Change "unknown" to "missing".'); expect(packet).toContain("Also trim spaces.");
    expect(packet).not.toContain("Private unrelated discussion"); expect(packet).not.toContain("Keeper paraphrase");
    expect(packet.indexOf('Change "unknown"')).toBeGreaterThan(packet.indexOf('For NaN'));
  });
  it("freezes the source set while a later capture can include a new steer", async () => {
    const f = await fixture(), packet = requestSourcePacket(f.k, f.manifest);
    f.k.receiveUser("lead", "Use another string now."); f.k.route("lead", { kind: "steer", boardQuestId: f.q.id, summary: "Changed", notes: [] });
    expect(requestSourcePacket(f.k, f.manifest)).toBe(packet);
    expect(captureRequestSources(f.k, "lead", f.q.id).id).not.toBe(f.manifest.id);
    expect(readRequestSources(f.k, "maker", { manifestId: f.manifest.id }).totalSources).toBe(1);
  });
  it("never inlines a partial message and pages the full overflow source without changing its text", async () => {
    const text = `${"x".repeat(3990)}\nThe last line says exactly unknown, not unknown items.\n${"\u0000\"\\🦊".repeat(1300)}`;
    const f = await fixture(text), packet = requestSourcePacket(f.k, f.manifest);
    expect(packet.length).toBeLessThanOrEqual(4000); expect(packet).toContain("tavern_request_sources"); expect(packet).not.toContain("x".repeat(100));
    let offset = 0, restored = "";
    do {
      const page = readRequestSources(f.k, "maker", { manifestId: f.manifest.id, offset });
      expect(JSON.stringify(page).length).toBeLessThan(18000);
      restored += page.text; offset = page.nextOffset ?? -1;
    } while (offset !== -1);
    expect(restored).toBe(text);
  });
  it("counts packet framing against the inline budget and never hides an omitted middle steer", async () => {
    const f = await fixture("a".repeat(3800));
    f.k.receiveUser("lead", "End exactly with unknown."); f.k.route("lead", { kind: "steer", boardQuestId: f.q.id, summary: "New ending", notes: [] });
    const manifest = captureRequestSources(f.k, "lead", f.q.id), packet = requestSourcePacket(f.k, manifest);
    expect(packet.length).toBeLessThanOrEqual(4000); expect(packet).toContain("tavern_request_sources");
    expect(packet).not.toContain("a".repeat(100));
  });
  it("allows the Warden and owning Keeper to read that member's frozen source, not another quest", async () => {
    const f = await fixture(), own = { manifestId: f.manifest.id };
    expect(readRequestSources(f.k, "checker", own).text).toContain('"unknown"');
    expect(readRequestSources(f.k, "lead", { ...own, memberThreadId: "maker" }).text).toContain('"unknown"');
    const q2 = seedLegacyQuest(f.k, "lead", "Other", "Other quest");
    f.k.bind("other", "smith", null, "project", { keeperThreadId: "lead", boardQuestId: q2.id, waypointId: null, title: "Other", errand: false, brief });
    expect(() => readRequestSources(f.k, "other", own)).toThrow(/manifest/i);
    expect(() => readRequestSources(f.k, "maker", { ...own, memberThreadId: "other" })).toThrow(/own/i);
    f.k.bind("stranger", "keeper", null, "project");
    expect(() => readRequestSources(f.k, "stranger", { ...own, memberThreadId: "maker" })).toThrow(/own/i);
    f.k.store.patch("other", { requestSources: f.manifest });
    expect(() => readRequestSources(f.k, "other", own)).toThrow(/quest/i);
  });
  it("does not substitute a changed or deleted receipt or treat an excerpt as the full original", async () => {
    const f = await fixture(), source = f.manifest.sources[0]!;
    f.k.store.db.prepare("UPDATE tavern_messages SET text=? WHERE id=?").run("Changed text", source.sourceMessageId);
    expect(() => readRequestSources(f.k, "maker", { manifestId: f.manifest.id })).toThrow(/changed/i);
    f.k.store.db.prepare("DELETE FROM tavern_messages WHERE id=?").run(source.sourceMessageId);
    expect(readRequestSources(f.k, "maker", { manifestId: f.manifest.id })).toMatchObject({ text: null, available: false });
    const legacy = captureRequestSources(f.k, "lead", f.q.id), packet = requestSourcePacket(f.k, legacy);
    expect(packet).toContain("unavailable"); expect(packet).not.toContain('For NaN return exactly "unknown".');
  });
  it("marks a missing original honestly, even when a later steer is available", async () => {
    const f = await fixture(); f.k.store.db.prepare("DELETE FROM tavern_records WHERE kind='routes'").run();
    f.k.receiveUser("lead", "Also trim spaces."); f.k.route("lead", { kind: "steer", boardQuestId: f.q.id, summary: "Trim", notes: [] });
    const manifest = captureRequestSources(f.k, "lead", f.q.id);
    expect(manifest.openingMissing).toBe(true); expect(requestSourcePacket(f.k, manifest)).toContain("opening user request is unavailable");
  });
  it("honestly carries both currently routed questions for an errand without a producing-route identity", async () => {
    const f = await fixture();
    for (const text of ["What is the current version?", "How many tests ran?"]) {
      f.k.receiveUser("lead", text); f.k.route("lead", { kind: "question", summary: "Question", notes: [] });
    }
    const manifest = captureRequestSources(f.k, "lead", null), packet = requestSourcePacket(f.k, manifest);
    expect(manifest.sources).toHaveLength(2); expect(manifest.openingMissing).toBe(false);
    expect(packet).toContain("What is the current version?"); expect(packet).toContain("How many tests ran?");
    expect(packet).not.toContain('For NaN return exactly "unknown".');
  });
  it("rejects out-of-range pages, wrong manifests and incomplete member calls", async () => {
    const f = await fixture();
    expect(() => readRequestSources(f.k, "maker", { manifestId: "other" })).toThrow(/manifest/i);
    expect(() => readRequestSources(f.k, "maker", {})).toThrow(/manifest/i);
    expect(() => readRequestSources(f.k, "maker", { manifestId: f.manifest.id, offset: 5000 })).toThrow(/offset/i);
    expect(() => readRequestSources(f.k, "maker", { manifestId: f.manifest.id, sourceIndex: 1 })).toThrow(/source/i);
  });
});
