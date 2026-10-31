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

  it("starts a new handoff when a sign-in lands on an access gateway", () => {
    const { advance } = setup();
    advance({ type: "form", visible: true, now: 0 });
    advance({ type: "tick", now: SETTLE_MS });
    expect(advance({ type: "synced", set: 0, now: SETTLE_MS + 100 }).episode).toMatchObject({ phase: { kind: "waiting" }, opened: true });
    const gateway = advance({ type: "url", onSignInPage: true, now: SETTLE_MS + 200 }, { gateway: true });
    expect(gateway.episode).toMatchObject({ phase: { kind: "settling" }, opened: false });
    expect(advance({ type: "tick", now: SETTLE_MS * 2 + 200 }, { gateway: true }).effects).toEqual([{ kind: "sync" }]);
  });

  it("keeps a gateway handoff through the application page a retry passes through", () => {
    const { advance } = setup();
    advance({ type: "url", onSignInPage: true, now: 0 }, { gateway: true });
    advance({ type: "tick", now: SETTLE_MS }, { gateway: true });
    advance({ type: "synced", set: 2, now: SETTLE_MS + 100 }, { gateway: true });
    const app = advance({ type: "url", onSignInPage: false, now: SETTLE_MS + 200 });
    expect(app).toMatchObject({ gateway: true, episode: { phase: { kind: "checking" } } });
    expect(advance({ type: "url", onSignInPage: true, now: SETTLE_MS + 400 }, { gateway: true }).episode.phase.kind).toBe("checking");
  });

  it("keeps the application the user approved, whatever page the tab moves to, until the user stops", () => {
    const { advance } = setup();
    const approved = "https://app-a.example.test/";
    advance({ type: "url", onSignInPage: true, now: 0 }, { gateway: true, targetUrl: approved });
    expect(advance({ type: "start", now: 100 }, { gateway: true, consentUrl: approved }).consentUrl).toBe(approved);
    expect(advance({ type: "url", onSignInPage: true, now: 200 }, { gateway: true, targetUrl: "https://app-b.example.test/" }).consentUrl).toBe(approved);
    expect(advance({ type: "synced", set: 0, now: 300 }, { gateway: true })).toMatchObject({ consentUrl: approved, effects: [{ kind: "open" }] });
    expect(advance({ type: "dismiss" }, { gateway: true }).consentUrl).toBeNull();
  });

  it("takes consent only from a gateway's Continue", () => {
    const { advance } = setup();
    advance({ type: "form", visible: true, now: 0 }, { gateway: false });
    expect(advance({ type: "start", now: 100 }, { gateway: false, consentUrl: "https://app.example.test/" }).consentUrl).toBeNull();
    const other = setup();
    other.advance({ type: "url", onSignInPage: true, now: 0 }, { gateway: true });
    expect(other.advance({ type: "tick", now: 100 }, { gateway: true, consentUrl: "https://app.example.test/" }).consentUrl).toBeNull();
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
    expect(rpcContract.handoff.input.parse({ ...input, gateway: true }).gateway).toBe(true);
    expect(() => rpcContract.handoff.input.parse({ ...input, consentUrl: "javascript:alert(1)" })).toThrow();
    expect(() => rpcContract.sync.input.parse({ mode: "full", reason: "sign-in", mirrorHosts: ["App.example.com:443"] })).toThrow();
  });
});
