// @vitest-environment node
import { describe, expect, it } from "vitest";
import { HOST_LIST_LIMIT, IDLE, SETTLE_MS, WAIT_LIMIT_MS, concernsPages, isSignInPage, parsePattern, signInPatterns, step, type Effect, type Episode, type SignInEvent, type SignInMode } from "../src/signin";

describe("sign-in pages", () => {
  const patterns = signInPatterns("intranet.example.com/login\n# a comment\n*.corp.test");

  it("matches the built-in identity providers and the user's own pages", () => {
    for (const url of [
      "https://shopify.okta.com/oauth2/v1/authorize?client_id=x",
      "https://okta.com/",
      "https://login.microsoftonline.com/common/oauth2",
      "https://accounts.google.com/v3/signin/identifier",
      "https://github.com/login?return_to=%2F",
      "https://github.com/sessions/two-factor",
      "https://intranet.example.com/login/sso",
      "https://sso.corp.test/",
    ]) expect(isSignInPage(url, patterns), url).toBe(true);
  });

  it("leaves other pages alone", () => {
    for (const url of [
      "https://github.com/kalindudc",
      "https://intranet.example.com/home",
      "https://notokta.com/",
      "https://okta.com.evil.test/",
      "about:blank",
      "not a url",
    ]) expect(isSignInPage(url, patterns), url).toBe(false);
  });

  it("refuses lines that are not a host", () => {
    expect(parsePattern("https://Login.Example.com/SSO/")).toEqual({ host: "login.example.com", subdomains: false, path: "/sso" });
    expect(parsePattern("not a host!")).toBeNull();
    expect(parsePattern("*.")).toBeNull();
  });
});

describe("concernsPages", () => {
  it("relates a cookie's site to the page's site, its parents and its subdomains", () => {
    const pages = ["https://shopify.okta.com/oauth2/v1/authorize", "https://admin.example.com/orders"];
    expect(concernsPages(["okta.com"], pages)).toBe(true);
    expect(concernsPages(["example.com"], pages)).toBe(true);
    expect(concernsPages(["eu.admin.example.com"], pages)).toBe(true);
    expect(concernsPages(["analytics.test", "ample.com"], pages)).toBe(false);
    expect(concernsPages(Array.from({ length: HOST_LIST_LIMIT }, (_, index) => `site${index}.test`), pages)).toBe(true);
  });
});

function run(events: SignInEvent[], mode: SignInMode = "automatic", start: Episode = IDLE) {
  let episode = start;
  const effects: Effect["kind"][] = [];
  for (const event of events) {
    const result = step(episode, event, mode);
    episode = result.episode;
    effects.push(...result.effects.map((effect) => effect.kind));
  }
  return { episode, effects };
}

describe("the handoff", () => {
  it("lets a quick SSO redirect pass without doing anything", () => {
    const { episode, effects } = run([
      { type: "url", onSignInPage: true, now: 0 },
      { type: "tick", now: SETTLE_MS - 1 },
      { type: "url", onSignInPage: false, now: SETTLE_MS },
    ]);
    expect(episode).toEqual(IDLE);
    expect(effects).toEqual([]);
  });

  it("first tries the real browser's current session, which is enough when it is already signed in", () => {
    const { episode, effects } = run([
      { type: "url", onSignInPage: true, now: 0 },
      { type: "tick", now: SETTLE_MS },
      { type: "synced", set: 4, now: SETTLE_MS + 100 },
      { type: "url", onSignInPage: false, now: SETTLE_MS + 900 },
    ]);
    expect(effects).toEqual(["sync", "reload"]);
    expect(episode).toEqual(IDLE);
  });

  it("opens the sign-in in the real browser once, then reloads on each sync until the page is gone", () => {
    const { episode, effects } = run([
      { type: "url", onSignInPage: true, now: 0 },
      { type: "tick", now: SETTLE_MS },
      { type: "synced", set: 0, now: SETTLE_MS + 100 },
      { type: "synced", set: 2, now: 40_000 },
      { type: "tick", now: 40_000 + SETTLE_MS },
      { type: "synced", set: 3, now: 70_000 },
      { type: "url", onSignInPage: false, now: 71_000 },
    ]);
    expect(effects).toEqual(["sync", "open", "reload", "reload"]);
    expect(episode).toEqual(IDLE);
  });

  it("still hands off when the sync fails, and gives up after the wait limit", () => {
    const { episode, effects } = run([
      { type: "url", onSignInPage: true, now: 0 },
      { type: "tick", now: SETTLE_MS },
      { type: "syncFailed", now: SETTLE_MS + 10 },
      { type: "tick", now: SETTLE_MS + 10 + WAIT_LIMIT_MS },
    ]);
    expect(effects).toEqual(["sync", "open"]);
    expect(episode.phase).toEqual({ kind: "stalled" });
  });

  it("only offers in ask mode, starts on request, and stays out of the way when off", () => {
    const asked = run([{ type: "url", onSignInPage: true, now: 0 }, { type: "tick", now: SETTLE_MS * 2 }], "ask");
    expect(asked.episode.phase).toEqual({ kind: "offer" });
    expect(asked.effects).toEqual([]);
    expect(run([{ type: "start" }], "ask", asked.episode).effects).toEqual(["sync"]);
    expect(run([{ type: "url", onSignInPage: true, now: 0 }, { type: "tick", now: SETTLE_MS }], "off")).toEqual({ episode: IDLE, effects: [] });
  });

  it("turns a dismissed wait back into an offer", () => {
    const waiting = run([{ type: "url", onSignInPage: true, now: 0 }, { type: "tick", now: SETTLE_MS }, { type: "synced", set: 0, now: SETTLE_MS }]).episode;
    expect(run([{ type: "dismiss" }], "automatic", waiting).episode).toEqual({ phase: { kind: "offer" }, opened: false });
  });
});
