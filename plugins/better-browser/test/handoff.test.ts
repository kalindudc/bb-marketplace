// @vitest-environment node
import { describe, expect, it } from "vitest";
import { HANDOFF_SESSION_LIMIT, HANDOFF_SESSION_TTL_MS, createHandoffSessions, type HandoffInput } from "../src/handoff";
import { rpcContract } from "../src/rpc";
import { IDLE, SETTLE_MS, WAIT_LIMIT_MS, type SignInEvent } from "../src/signin";

function setup() {
  let now = 0;
  const sessions = createHandoffSessions(() => now);
  return {
    sessions,
    advance(event: SignInEvent, extra: Partial<Omit<HandoffInput, "event">> = {}) {
      return sessions.advance({ threadId: "thr_1", tabId: "tab_1", mode: "automatic", targetUrl: null, ...extra, event });
    },
    elapse(ms: number) { now += ms; },
  };
}

describe("tab-scoped handoff progress", () => {
  it("resumes after a toolbar disappears without replaying effects", () => {
    const { advance } = setup();
    advance({ type: "form", visible: true, now: 0 });
    expect(advance({ type: "tick", now: SETTLE_MS }).effects).toEqual([{ kind: "sync" }]);
    expect(advance({ type: "synced", set: 2, now: SETTLE_MS + 100 }).effects).toEqual([{ kind: "reload" }]);
    const resumed = advance({ type: "form", visible: true, now: SETTLE_MS + 200 });
    expect(resumed.episode.phase.kind).toBe("checking");
    expect(resumed.effects).toEqual([]);
    expect(advance({ type: "tick", now: SETTLE_MS * 2 + 100 }).effects).toEqual([{ kind: "open" }]);
    expect(advance({ type: "tick", now: SETTLE_MS * 3 }).effects).toEqual([]);
  });

  it("offers a retry if a sync effect reply is lost before the toolbar can execute it", () => {
    const { advance, elapse } = setup();
    advance({ type: "form", visible: true, now: 0 });
    expect(advance({ type: "tick", now: SETTLE_MS }).effects).toEqual([{ kind: "sync" }]);
    elapse(WAIT_LIMIT_MS);
    const recovered = advance({ type: "tick", now: SETTLE_MS + WAIT_LIMIT_MS });
    expect(recovered.episode.phase.kind).toBe("stalled");
    expect(recovered.effects).toEqual([]);
    expect(advance({ type: "start", now: SETTLE_MS + WAIT_LIMIT_MS + 1 }).effects).toEqual([{ kind: "sync" }]);
  });

  it("isolates different tabs and different owning threads", () => {
    const { advance } = setup();
    advance({ type: "form", visible: true, now: 0 });
    advance({ type: "tick", now: SETTLE_MS });
    advance({ type: "synced", set: 0, now: SETTLE_MS });
    for (const extra of [{ tabId: "tab_2" }, { threadId: "thr_2" }]) {
      const fresh = advance({ type: "form", visible: true, now: SETTLE_MS }, extra);
      expect(fresh.episode.phase.kind).toBe("settling");
      expect(fresh.episode.opened).toBe(false);
    }
    expect(advance({ type: "form", visible: true, now: SETTLE_MS + 100 }).episode.phase.kind).toBe("waiting");
  });

  it("keeps the original application URL across toolbar instances", () => {
    const { advance } = setup();
    const targetUrl = "https://app.example.test/orders";
    advance({ type: "url", onSignInPage: false, now: 0 }, { targetUrl });
    expect(advance({ type: "form", visible: true, now: 100 }).targetUrl).toBe(targetUrl);
  });

  it("does not allocate sessions for hidden blank helper tabs", () => {
    const { advance } = setup();
    for (let i = 0; i < HANDOFF_SESSION_LIMIT * 2; i += 1) {
      expect(advance({ type: "url", onSignInPage: false, now: 0 }, { tabId: `helper_${i}` }).episode).toEqual(IDLE);
    }
    expect(advance({ type: "form", visible: true, now: 0 }).episode.phase.kind).toBe("settling");
  });

  it("bounds retained sessions and expires abandoned tabs", () => {
    const { advance, elapse } = setup();
    for (let i = 0; i < HANDOFF_SESSION_LIMIT; i += 1) {
      advance({ type: "form", visible: true, now: 0 }, { tabId: `tab_${i}` });
    }
    expect(() => advance({ type: "form", visible: true, now: 0 }, { tabId: "overflow" })).toThrow("Too many active sign-in handoffs");
    elapse(HANDOFF_SESSION_TTL_MS);
    expect(advance({ type: "form", visible: true, now: HANDOFF_SESSION_TTL_MS }, { tabId: "overflow" }).episode.phase.kind).toBe("settling");
  });

  it("discards progress when the plugin is disposed", () => {
    const { sessions, advance } = setup();
    advance({ type: "form", visible: true, now: 0 });
    advance({ type: "tick", now: SETTLE_MS });
    sessions.clear();
    expect(advance({ type: "form", visible: true, now: SETTLE_MS + 100 }).episode.phase.kind).toBe("settling");
  });
});

describe("handoff RPC boundary", () => {
  it("round-trips valid state and rejects unknown fields and non-web targets", () => {
    const input = { threadId: "thr_1", tabId: "tab_1", mode: "automatic", targetUrl: null, event: { type: "form", visible: true, now: 0 } };
    const parsed = rpcContract.handoff.input.parse(input);
    const result = createHandoffSessions(() => 0).advance(parsed);
    expect(rpcContract.handoff.output.parse(result)).toEqual(result);
    expect(() => rpcContract.handoff.input.parse({ ...input, password: "not-accepted" })).toThrow();
    expect(() => rpcContract.handoff.input.parse({ ...input, targetUrl: "javascript:alert(1)" })).toThrow();
  });
});
