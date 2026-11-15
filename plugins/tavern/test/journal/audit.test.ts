// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(["tavern.quest", "tavern.journal", "mcp__tavern__journal"])("audits legacy and current checklist calls from %s", tool => {
  const dir = mkdtempSync(join(tmpdir(), "tavern-audit-"));
  const call = (action: string, result: string, extra = {}) => ({ type: "item/completed", data: { item: { type: "toolCall", tool, arguments: { action, ...extra }, result } } });
  const work = () => ({ type: "item/completed", data: { item: { type: "commandExecution" } } });
  const request = () => ({ type: "client/turn/requested", data: { initiator: "user", originPluginId: null, senderThreadId: null, input: [{ type: "text", text: "continue" }] } });
  const events = [request(), call("add", "0 of 1 done. Next: [g0] Build (todo).", { descriptions: ["Build"] }),
    ...Array.from({ length: 10 }, work), request(),
    { ...request(), data: { ...request().data, originPluginId: "shuttle" } },
    { ...request(), data: { ...request().data, senderThreadId: "other-agent" } },
    { ...request(), data: { ...request().data, input: [{ type: "text", text: "[Tavern tick] facts", visibility: "agent-only" }] } },
    { ...request(), data: { ...request().data, retryOfRequestId: "retry" } },
    call("list", "[g0] Build (doing)"),
    ...Array.from({ length: 10 }, work), call("done", tool === "tavern.quest" ? "1 of 1 done. Every quest is done." : "1 of 1 done. Journal closed.", { id: "g0", evidence: [{ kind: "command", ref: "npm test" }] }),
    call("verify", "1 of 1 done. Journal closed.", { id: "g0", evidence: [{ kind: "command", ref: "npm test" }] })];
  try {
    writeFileSync(join(dir, "thread.json"), JSON.stringify(events));
    const script = fileURLToPath(new URL("../../src/server/journal/journal-audit.mjs", import.meta.url));
    const report = JSON.parse(execFileSync(process.execPath, [script, "--logs", dir, "--json"], { encoding: "utf8" }));
    expect(report.summary.all).toMatchObject({ adoption: { count: 1, of: 1 }, closedMostlyAtEnd: { count: 1, of: 1 }, silentForHalfOrMore: { count: 1, of: 1 }, medianLongestSilentStretch: 20, followUpsTouchingJournal: { count: 1, of: 1 }, evidence: { reportedWithEvidence: 1, doneWithoutEvidence: 0 }, verdicts: { verified: 1 } });
  } finally { rmSync(dir, { recursive: true }); }
});

it("counts only state changes as keeping the journal current, and measures rewrites, starts, gaps and reminders", () => {
  const dir = mkdtempSync(join(tmpdir(), "tavern-audit-"));
  const min = 60_000;
  let clock = 0;
  const at = (minutes: number) => { clock = minutes * min; };
  const ev = (type: string, data: unknown) => ({ type, createdAt: clock, data });
  const call = (action: string, result: string, extra = {}) => ev("item/completed", { item: { type: "toolCall", tool: "tavern.journal", arguments: { action, ...extra }, result } });
  const work = (n: number) => Array.from({ length: n }, () => ev("item/completed", { item: { type: "commandExecution" } }));
  const inbound = (sender: string | null) => ev("client/turn/requested", { initiator: sender ? "agent" : "user", originPluginId: null, senderThreadId: sender, input: [{ type: "text", text: "SOURCE SETTLED" }] });
  const reminder = (plugin = "tavern", text = "[Journal] 0 of 2 done. You have not updated the journal entries since the user's previous message.") => ev("client/turn/requested", { initiator: "user", originPluginId: plugin, senderThreadId: null, input: [{ type: "text", text, visibility: "agent-only" }] });
  const events: unknown[] = [];
  at(0); events.push(inbound(null), call("add", "0 of 2 done. Next: [00] Build (todo).", { descriptions: ["Build", "Check"] }));
  at(1); events.push(call("start", "0 of 2 done. Next: [00] Build (doing).", { id: "00" }), ...work(10));
  // Three rewrites and a note: activity, but not a state change, so the silent stretch keeps running.
  at(10); events.push(call("update", "0 of 2 done. Next: [00] Build (doing).", { id: "00", description: "Build, live since 10:00" }), ...work(10));
  at(20); events.push(call("update", "0 of 2 done. Next: [00] Build (doing).", { id: "00", description: "Build, settled" }), inbound("thr_builder"), inbound("thr_builder"), ...work(10));
  at(30); events.push(call("note", "0 of 2 done. Next: [00] Build (doing).", { id: "00", note: "waiting" }), reminder(), ...work(10));
  at(40); events.push(call("update", "0 of 2 done. Next: [00] Build (doing).", { id: "00", description: "Build" }));
  at(127); events.push(reminder("pi-quests", "[Quests] 0 of 2 done. You have not updated the quests since the user's previous message."));
  at(130); events.push(call("done", "1 of 2 done. Next: [01] Check (todo).", { id: "00" }), ...work(5));
  at(140); events.push(call("done", "2 of 2 done. Journal closed.", { id: "01" }));
  try {
    writeFileSync(join(dir, "thread.json"), JSON.stringify(events));
    const script = fileURLToPath(new URL("../../src/server/journal/journal-audit.mjs", import.meta.url));
    const report = JSON.parse(execFileSync(process.execPath, [script, "--logs", dir, "--json"], { encoding: "utf8" }));
    const row = report.threads[0];
    // Work actions between the start (at 0 work) and the first close (after 40 work): updates and the note no longer end the stretch.
    expect(row.maxSilentStretch).toBe(40);
    expect(row.currency).toEqual({
      stateChanges: 4, rewrites: 3, notes: 1, rewriteShare: 3 / 8, updatesPerClose: 1.5,
      entriesAdded: 2, starts: 1, startUsage: 0.5,
      longestHoursWithoutClose: 2.17, inbound: 3, reminders: 2, remindersPer100Inbound: 66.7, reminderPrecision: { count: 1, of: 2 },
    });
    expect(report.summary.all.currency).toMatchObject({ rewriteShare: 3 / 8, startUsage: 0.5, remindersPer100Inbound: 66.7 });
  } finally { rmSync(dir, { recursive: true }); }
});
