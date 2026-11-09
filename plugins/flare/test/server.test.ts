// @vitest-environment node
import { readFileSync } from "node:fs";
import { createFakePluginHost, makeMessageDispatchHookContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../server";
import { TOOL_INSTRUCTIONS } from "../src/notes";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  bb: { branding: { experimental_icons: Record<string, string> } };
};
const ICONS = Object.keys(manifest.bb.branding.experimental_icons);

async function load(options: { settings?: Record<string, string | number | boolean>; callRpc?: () => Promise<unknown> } = {}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "flare",
    experimental_declaredIconNames: ICONS,
    settings: options.settings,
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, title: "Thread" }),
        experimental_listAncestors: async ({ threadIds }: { threadIds: readonly string[] }) => ({ threads: threadIds.map((threadId) => ({ threadId, ancestorIds: [] })) }),
        events: { list: async () => [] },
      },
      plugins: { callRpc: options.callRpc ?? (async () => ({ ok: true, channels: [] })) },
    },
  });
  await plugin(bb);
  return harness;
}

const text = (result: unknown): string => (typeof result === "string" ? result : JSON.stringify(result));

describe("the flare tool", () => {
  it("is registered with its own row and instructions short enough for bb", async () => {
    const harness = await load();
    const tools = harness.inspection.registrations.agentTools;
    const flare = tools.find((tool) => tool.name === "flare");
    expect(flare?.presentation).toMatchObject({ label: { pending: "Sending a flare", completed: "Sent a flare" }, icon: { glyph: "flare/flare" } });
    expect(tools.find((tool) => tool.name === "flare_list")?.presentation).toMatchObject({ suppress: true });
    expect(TOOL_INSTRUCTIONS.length).toBeLessThan(4096);
  });

  it("advertises a schema no provider can reject a call against", async () => {
    // pi validates arguments against the advertised schema before bb sees them, so an enum, a required list or a
    // bound would turn an odd value into a failed call.
    const harness = await load();
    for (const tool of harness.inspection.registrations.agentTools) {
      const schema = JSON.stringify(tool.inputSchema);
      expect(schema).toContain('"properties"');
      expect(schema).not.toMatch(/"enum"|"required"|"minimum"|"maximum"|"minLength"|"maxLength"/);
    }
  });

  it("asks for the evidence drawn, and says the final-message rule for blocks does not cover a flare", async () => {
    const harness = await load();
    const flare = harness.inspection.registrations.agentTools.find((tool) => tool.name === "flare");
    const body = JSON.stringify((flare?.inputSchema as { properties: { body: unknown } }).properties.body);
    expect(body).not.toContain("A few lines");
    expect(body).toMatch(/a table, a mermaid diagram, an image/);
    expect(TOOL_INSTRUCTIONS).toContain("does not cover a flare's body");
    expect(TOOL_INSTRUCTIONS).toContain('Load("$BB_THREAD_STORAGE/<path>")');
    expect(TOOL_INSTRUCTIONS).toContain("A body that is all prose is right only when there is nothing to see");
  });

  it("names the rendering plugins it draws, beside the Markdown forms that need none", async () => {
    const harness = await load();
    const flare = harness.inspection.registrations.agentTools.find((tool) => tool.name === "flare");
    const body = JSON.stringify((flare?.inputSchema as { properties: { body: unknown } }).properties.body);
    for (const text of [TOOL_INSTRUCTIONS, body]) expect(text).toMatch(/genui[\s\S]*inline-vis/);
    expect(TOOL_INSTRUCTIONS).toContain("Markdown tables, mermaid diagrams and images always");
    expect(TOOL_INSTRUCTIONS).toContain("without genui, use Markdown tables and mermaid");
  });

  it("ties flares to moments in the agent's own work, not to another plugin's tools", () => {
    expect(TOOL_INSTRUCTIONS).toContain("you finish a step of your plan or a phase of the work");
    expect(TOOL_INSTRUCTIONS).toContain("for a quick status it is the whole flare");
    expect(TOOL_INSTRUCTIONS).toContain("A turn of a few tool calls needs no flare");
    expect(TOOL_INSTRUCTIONS).not.toMatch(/\bquests?\b|minion|wake-?up/i);
  });

  it("adds the drawing hint to the result of a flare that is all text", async () => {
    const harness = await load();
    const body = "Agents loaded 202 of 6,525 injected hits, about 3%, across 1,727 lookups in 1,496 sessions. Child threads got 815 lookups and loaded 37 hits, 32 of them their parent's own streams. Wake-ups and Loom retries trigger most of the rest.";
    const result = text(await harness.behavior.callAgentTool("flare", { title: "Memory hits", body }, { threadId: "thr_a" }));
    expect(result).toMatch(/^Flare sent\. Keep working; nothing will reply\. This flare is all text\. .*Metric row/);
  });

  it("answers at once even while the push notification never finishes", async () => {
    const harness = await load({ callRpc: () => new Promise(() => undefined) });
    const result = await harness.behavior.callAgentTool("flare", { title: "Deploy blocked", kind: "blocker" }, { threadId: "thr_a", projectId: "p" });
    expect(result).toBe("Flare sent. Keep working; nothing will reply.");
  });

  it("reads arguments a provider stringified, instead of failing the call", async () => {
    const harness = await load();
    expect(await harness.behavior.callAgentTool("flare", { title: 42, notify: "true" }, { threadId: "thr_a" })).toBe("Flare sent. Keep working; nothing will reply.");
    expect(await harness.behavior.callAgentTool("flare", '{"title":"From a JSON string"}', { threadId: "thr_a" })).toBe("Flare sent. Keep working; nothing will reply.");
    expect(text(await harness.behavior.callAgentTool("flare_list", { limit: "2", children: "false" }, { threadId: "thr_a" }))).toMatch(/^2 flares/);
  });

  it("never fails a call: a missing title, an odd kind and a long title each come back as a note", async () => {
    const harness = await load();
    expect(await harness.behavior.callAgentTool("flare", {}, { threadId: "thr_a" })).toBe(
      "Nothing was sent: a flare needs a title. Carry on, and send it again with a title if it still matters.",
    );
    const odd = await harness.behavior.callAgentTool("flare", { title: "Hello", kind: "party" }, { threadId: "thr_a" });
    expect(text(odd)).toBe('Flare sent. Keep working; nothing will reply. "party" is not a kind, so it went as a finding.');
    const again = await harness.behavior.callAgentTool("flare", { title: "Hello", kind: "party" }, { threadId: "thr_a" });
    expect(again).toBe("That flare was already sent a moment ago, so it went only once. Keep working.");
  });

  it("reads the thread's flares back with flare_list", async () => {
    const harness = await load();
    await harness.behavior.callAgentTool("flare", { title: "Root cause found", body: "The cache key drops the locale." }, { threadId: "thr_a" });
    await harness.behavior.callAgentTool("flare", { title: "Patch ready", kind: "progress" }, { threadId: "thr_a" });
    const listed = text(await harness.behavior.callAgentTool("flare_list", {}, { threadId: "thr_a" }));
    expect(listed).toMatch(/^2 flares, newest first:\n- just now · Progress: Patch ready \(fl_\w+\)\n- just now · Finding: Root cause found \(fl_\w+\)\n    The cache key drops the locale\.\n$/);
  });
});

describe("the renderer provider", () => {
  it("registers Flare's renderer as a provider with one model and one reasoning level", async () => {
    const harness = await load();
    const [provider] = harness.inspection.registrations.providerRegistrations;
    expect(provider).toMatchObject({ id: "flare", displayName: "Flare", completedTurnDisplay: "flat" });
  });
});

describe("the frontend reads", () => {
  it("serves the banner and feed, and a dismissal clears the banner", async () => {
    const harness = await load();
    await harness.behavior.callAgentTool("flare", { title: "Found it" }, { threadId: "thr_a" });
    const banner = (await harness.behavior.callRpc("banner", { threadId: "thr_a" })) as { flare: { title: string; createdAt: number } };
    expect(banner.flare.title).toBe("Found it");
    await harness.behavior.callRpc("dismiss", { threadId: "thr_a", through: banner.flare.createdAt });
    expect(await harness.behavior.callRpc("banner", { threadId: "thr_a" })).toMatchObject({ flare: null, count: 0 });
    expect(await harness.behavior.callRpc("feed", { threadId: "thr_a", children: true })).toMatchObject({ flares: [{ title: "Found it" }] });
  });
});

describe("thread events", () => {
  it("tracks turns from bb's thread events", async () => {
    const harness = await load();
    const thread = makeThreadResponse({ id: "thr_a", status: "active" });
    await harness.behavior.emitThreadEvent("thread.active", { thread });
    await harness.behavior.callAgentTool("flare", { title: "Mid-turn" }, { threadId: "thr_a" });
    await harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "thr_a", status: "error" }), error: "boom" });
    expect(await harness.behavior.callRpc("banner", { threadId: "thr_a" })).toMatchObject({ flare: { title: "Mid-turn" }, run: { outcome: "failed", error: "boom" } });
  });
});

describe("the dispatch hook", () => {
  it("never lets one of Flare's notes start a turn, and lets everything else through", async () => {
    const harness = await load();
    const hook = harness.inspection.registrations.hooks["message.dispatch"]!;
    const decide = (attempt: "start-turn" | "join-turn", text: string, initiator: "user" | "system" | "agent" = "system") =>
      hook(makeMessageDispatchHookContext({ attempt, initiator, originPluginId: null, input: { text } }));
    expect(await decide("start-turn", "[Flare reminder] This turn has run for 12 minutes")).toMatchObject({ action: "reject" });
    expect(await decide("start-turn", "[Flare from a child thread] x", "agent")).toMatchObject({ action: "reject" });
    expect(await decide("join-turn", "[Flare reminder] This turn has run for 12 minutes")).toEqual({ action: "proceed" });
    expect(await decide("start-turn", "Please fix the build", "user")).toEqual({ action: "proceed" });
    // A person pasting a note back is never refused.
    expect(await decide("start-turn", "[Flare reminder] why did you send me this?", "user")).toEqual({ action: "proceed" });
  });

  it("decides a queued group by each row, and lets a note ride along with the user's message", async () => {
    const harness = await load();
    const hook = harness.inspection.registrations.hooks["message.dispatch"]!;
    const row = (text: string, initiator: "user" | "system", originPluginId: string | null) => ({
      content: [{ type: "text" as const, text, mentions: [] }],
      initiator,
      originPluginId,
    });
    const group = (...rows: ReturnType<typeof row>[]) =>
      hook(makeMessageDispatchHookContext({ attempt: "start-turn", initiator: "mixed", queuedMessages: rows as never, input: { text: "combined" } }));
    expect(await group(row("[Flare reminder] quiet", "user", "flare"))).toMatchObject({ action: "reject" });
    expect(await group(row("Please also check the logs", "user", null), row("[Flare reminder] quiet", "system", "flare"))).toEqual({ action: "proceed" });
    expect(await group(row("[Flare reminder] quiet", "system", "flare"), row("Please also check the logs", "user", null))).toEqual({ action: "proceed" });
  });
});

describe("bb flare", () => {
  it("sends to the thread it runs in and lists its flares", async () => {
    const harness = await load();
    const sent = await harness.behavior.runCli(["send", "Tests", "pass", "--kind", "progress", "--body", "142 of 142"], { threadId: "thr_a" });
    expect(sent).toMatchObject({ exitCode: 0, stdout: "Flare sent. Keep working; nothing will reply.\n" });
    const listed = await harness.behavior.runCli(["list", "--full"], { threadId: "thr_a" });
    expect(listed.stdout).toMatch(/^1 flare, newest first:\n- just now · Progress: Tests pass \(fl_\w+\)\n    142 of 142\n$/);
    const json = JSON.parse((await harness.behavior.runCli(["list", "--json"], { threadId: "thr_a" })).stdout) as { flares: unknown[] };
    expect(json.flares).toHaveLength(1);
  });

  it("shows how to send a body with fenced blocks", async () => {
    // The bb CLI's --<name>-stdin takes exactly one line, so a multi-line body goes through a file instead.
    const harness = await load();
    const help = await harness.behavior.runCli(["send", "--help"], { threadId: "thr_a" });
    expect(help.stdout).toContain('--body "$(cat body.md)"');
    expect(help.stdout).not.toContain("A few lines");
  });

  it("keeps a multi-line body with a fenced block whole", async () => {
    const harness = await load();
    const body = 'One sentence first.\n\n```ui\nCard("Run", [Metric("Passed", "105")])\n```';
    const sent = await harness.behavior.runCli(["send", "Drawn", "--body", body, "--json"], { threadId: "thr_a" });
    expect(JSON.parse(sent.stdout)).toMatchObject({ status: "sent", notes: [] });
    const listed = JSON.parse((await harness.behavior.runCli(["list", "--json"], { threadId: "thr_a" })).stdout) as { flares: { body: string }[] };
    expect(listed.flares[0]?.body).toBe(body);
  });

  it("names the flag to add when it runs outside a thread, and refuses an empty flare", async () => {
    const harness = await load();
    const outside = await harness.behavior.runCli(["send", "Hello"], {});
    expect(outside.exitCode).toBe(2);
    expect(outside.stderr).toContain("--thread <thread-id>");
    const empty = await harness.behavior.runCli(["send", "--thread", "thr_a"], {});
    expect(empty).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("a flare needs a title") });
  });
});
