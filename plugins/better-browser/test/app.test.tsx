import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ExperimentalPluginBrowserPage, JsonValue } from "@get-bb/plugin-sdk/app";
import { rpcContract, type Status } from "../src/rpc";
import { SETTLE_MS } from "../src/signin";
import { createHandoffSessions } from "../src/handoff";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const status = (overrides: Partial<Status> = {}): Status => ({
  supported: true, browser: { id: "chrome", name: "Google Chrome", syncable: true }, profile: "Default", syncing: false,
  lastSync: null, error: null, ...overrides,
});

function fakePage(answers: { signInForm?: boolean | null; onReload?: () => void } = {}) {
  const listeners = new Set<(data: JsonValue) => void>();
  const expressions: string[] = [];
  const page: ExperimentalPluginBrowserPage = {
    evaluate: vi.fn(async (expression: string) => {
      expressions.push(expression);
      if (expression.includes("okta-sign-in")) return answers.signInForm === null ? null : answers.signInForm === true;
      if (expression.includes("location.")) answers.onReload?.();
      return true;
    }),
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { page, expressions, send: (data: JsonValue) => listeners.forEach((listener) => listener(data)) };
}

const rpc = (overrides: Record<string, (input: never) => unknown> = {}) => {
  const handoffs = createHandoffSessions(() => Date.now());
  return {
    heartbeat: () => status(),
    handoff: (input: unknown) => handoffs.advance(rpcContract.handoff.input.parse(input)),
    openExternal: () => ({ ok: true, browser: "Google Chrome" }),
    sync: () => status({ lastSync: { at: Date.now(), status: "synced", set: 2, removed: 0, rejected: 0, cookies: 9, undecryptable: 0, hosts: ["example.com"], reason: "manual" } }),
    ...overrides,
  };
};

/** Advance fake time in small steps, each in its own act, so effects scheduled by one step run before the next. */
async function elapse(ms: number) {
  for (let spent = 0; spent < ms; spent += 250) await act(async () => vi.advanceTimersByTimeAsync(250));
}

async function toolbar(url: string, page: ExperimentalPluginBrowserPage | null, options: { settings?: Record<string, string | boolean>; handlers?: ReturnType<typeof rpc> } = {}) {
  const app = await loadPluginApp(() => import("../app"));
  return renderSlot(app.browserToolbarActions[0]!, { threadId: "thr_1", tabId: "tab_1", url, isCompactViewport: false, experimental_page: page }, {
    pluginId: "better-browser", rpc: options.handlers ?? rpc(), settings: { signIn: "automatic", signInPages: "", modifierClick: true, sync: true, ...options.settings },
  });
}

describe("plugin app", () => {
  it("registers the Browser toolbar control and the settings section", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.browserToolbarActions.map(({ id, title }) => ({ id, title }))).toEqual([{ id: "better-browser", title: "Better Browser" }]);
    expect(app.settingsSections.map(({ id }) => id)).toEqual(["better-browser"]);
  });

  it("reports the tab, installs the Cmd+click handler and opens what it reports in the real browser", async () => {
    const { page, expressions, send } = fakePage();
    const slot = await toolbar("https://example.com/", page);
    await waitFor(() => expect(expressions.some((expression) => expression.includes("__betterBrowserLinksUntil ="))).toBe(true));
    await waitFor(() => expect(slot.inspection.rpcCalls.find(({ method }) => method === "heartbeat")).toEqual({ method: "heartbeat", input: { threadId: "thr_1", tabId: "tab_1", focused: true } }));
    await act(async () => send({ type: "better-browser:open", url: "https://example.com/next" }));
    await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "openExternal", input: { url: "https://example.com/next" } }));
    slot.lifecycle.unmount();
  });

  it("switches interception off when the setting is off", async () => {
    const { page, expressions } = fakePage();
    const slot = await toolbar("https://example.com/", page, { settings: { modifierClick: false } });
    await waitFor(() => expect(expressions).toContain("(window.__betterBrowserLinksUntil = 0, true)"));
    expect(expressions.some((expression) => expression.includes("addEventListener"))).toBe(false);
    slot.lifecycle.unmount();
  });

  it("adds only the sync button, leaving opening the page externally to bb's own button", async () => {
    const slot = await toolbar("https://example.com/page", fakePage().page);
    const view = within(slot.container);
    await waitFor(() => expect(view.getByRole("button", { name: /Sync sessions from Google Chrome/ })).toBeTruthy());
    expect(view.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(view.getByRole("button", { name: /Sync sessions from Google Chrome/ }));
    await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "sync", input: { threadId: "thr_1", mode: "full", reason: "manual" } }));
    expect(slot.inspection.rpcCalls.map(({ method }) => method)).not.toContain("openExternal");
    slot.lifecycle.unmount();
  });

  it("hands a sign-in page that stays put to the real browser", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { page } = fakePage({ signInForm: true });
    const handlers = rpc({ sync: () => status({ lastSync: { at: Date.now(), status: "synced", set: 0, removed: 0, rejected: 0, cookies: 9, undecryptable: 0, hosts: [], reason: "sign-in" } }) });
    const slot = await toolbar("https://shopify.okta.com/oauth2/v1/authorize?x=1", page, { handlers });
    await elapse(SETTLE_MS + 1_500);
    await waitFor(() => expect(slot.inspection.rpcCalls.map(({ method }) => method)).toEqual(expect.arrayContaining(["sync", "openExternal"])));
    expect(slot.inspection.rpcCalls.find(({ method }) => method === "sync")?.input).toEqual({ threadId: "thr_1", mode: "full", reason: "sign-in" });
    await waitFor(() => expect(within(slot.container).getByRole("status").textContent).toContain("Finish signing in in Google Chrome"));

    const reloads = () => vi.mocked(page.evaluate).mock.calls.filter(([expression]) => expression.includes("location.")).length;
    const synced = (hosts: string[]) => status({ lastSync: { at: Date.now() + 1_000, status: "synced", set: 3, removed: 0, rejected: 0, cookies: 9, undecryptable: 0, hosts, reason: "watch" } });
    await slot.behavior.emitRealtime("status", synced(["analytics.test"]));
    expect(reloads()).toBe(0);
    await slot.behavior.emitRealtime("status", synced(["okta.com"]));
    await waitFor(() => expect(reloads()).toBe(1));
    slot.lifecycle.unmount();
  });

  it("keeps the application return URL when a new toolbar sees the sign-in redirect", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const openExternal = vi.fn(() => ({ ok: true, browser: "Google Chrome" }));
    const handlers = rpc({ openExternal, sync: () => status({ lastSync: { at: Date.now(), status: "synced", set: 0, removed: 0, rejected: 0, cookies: 9, undecryptable: 0, hosts: [], reason: "sign-in" } }) });
    const application = await toolbar("https://app.example.test/orders", fakePage().page, { handlers });
    await elapse(500);
    application.lifecycle.unmount();
    const redirected = await toolbar("https://shopify.okta.com/user/verify_idx_credentials", fakePage({ signInForm: true }).page, { handlers });
    try {
      await elapse(SETTLE_MS + 1_500);
      // The sign-in page is what opens, not the URL another page planted as the return address.
      expect(openExternal).toHaveBeenCalledExactlyOnceWith({ url: "https://shopify.okta.com/user/verify_idx_credentials" });
    } finally {
      redirected.lifecycle.unmount();
    }
  });

  it("resumes the same tab when the sync helper unmounts its toolbar", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let finishSync!: (value: Status) => void;
    const sync = vi.fn(() => new Promise<Status>((resolve) => { finishSync = resolve; }));
    const openExternal = vi.fn(() => ({ ok: true, browser: "Google Chrome" }));
    const handlers = rpc({ sync, openExternal });
    const { page, expressions } = fakePage({ signInForm: true });
    const first = await toolbar("https://shopify.okta.com/user/verify_idx_credentials", page, { handlers });
    await elapse(SETTLE_MS + 500);
    expect(sync).toHaveBeenCalledTimes(1);
    first.lifecycle.unmount();
    await act(async () => finishSync(status({ lastSync: { at: Date.now(), status: "synced", set: 2, removed: 0, rejected: 0, cookies: 9, undecryptable: 0, hosts: ["okta.com"], reason: "sign-in" } })));
    const resumed = await toolbar("https://shopify.okta.com/user/verify_idx_credentials", page, { handlers });
    try {
      await elapse(10_000);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(openExternal).toHaveBeenCalledTimes(1);
      expect(expressions.filter((expression) => expression.includes("location."))).toHaveLength(1);
    } finally {
      resumed.lifecycle.unmount();
    }
  });

  it("keeps the handoff through a reload that briefly hides the form", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const answers = {
      signInForm: true,
      onReload: (): void => {
        answers.signInForm = false;
        setTimeout(() => { answers.signInForm = true; }, 1_500);
      },
    };
    const handlers = rpc({ sync: () => status({ lastSync: { at: Date.now(), status: "synced", set: 2, removed: 0, rejected: 0, cookies: 9, undecryptable: 0, hosts: ["okta.com"], reason: "sign-in" } }) });
    const { page, expressions } = fakePage(answers);
    const slot = await toolbar("https://shopify.okta.com/user/verify_idx_credentials", page, { handlers });
    try {
      await elapse(15_000);
      const calls = slot.inspection.rpcCalls.map(({ method }) => method);
      expect(calls.filter((method) => method === "sync")).toHaveLength(1);
      expect(calls.filter((method) => method === "openExternal")).toHaveLength(1);
      expect(expressions.filter((expression) => expression.includes("location."))).toHaveLength(1);
      expect(within(slot.container).getByRole("status").textContent).toContain("Finish signing in in Google Chrome");
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("keeps the handoff while a slow reloaded document is still loading", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const answers: { signInForm: boolean | null; onReload: () => void } = {
      signInForm: true,
      onReload: () => {
        answers.signInForm = null;
        setTimeout(() => { answers.signInForm = true; }, 5_000);
      },
    };
    const handlers = rpc({ sync: () => status({ lastSync: { at: Date.now(), status: "synced", set: 2, removed: 0, rejected: 0, cookies: 9, undecryptable: 0, hosts: ["okta.com"], reason: "sign-in" } }) });
    const slot = await toolbar("https://shopify.okta.com/user/verify_idx_credentials", fakePage(answers).page, { handlers });
    try {
      await elapse(6_000);
      expect(slot.inspection.rpcCalls.map(({ method }) => method)).not.toContain("openExternal");
      await elapse(9_000);
      expect(slot.inspection.rpcCalls.filter(({ method }) => method === "sync")).toHaveLength(1);
      expect(slot.inspection.rpcCalls.filter(({ method }) => method === "openExternal")).toHaveLength(1);
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("finishes without opening Chrome when the form stays gone after a session refresh", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const answers = { signInForm: true, onReload: (): void => { answers.signInForm = false; } };
    const handlers = rpc({ sync: () => status({ lastSync: { at: Date.now(), status: "synced", set: 2, removed: 0, rejected: 0, cookies: 9, undecryptable: 0, hosts: ["okta.com"], reason: "sign-in" } }) });
    const slot = await toolbar("https://shopify.okta.com/user/verify_idx_credentials", fakePage(answers).page, { handlers });
    try {
      await elapse(10_000);
      expect(slot.inspection.rpcCalls.filter(({ method }) => method === "sync")).toHaveLength(1);
      expect(slot.inspection.rpcCalls.map(({ method }) => method)).not.toContain("openExternal");
      expect(within(slot.container).queryByRole("status")).toBeNull();
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("does not repeat the sync or Chrome open when a waiting form briefly disappears", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const answers = { signInForm: true };
    const handlers = rpc({ sync: () => status({ lastSync: { at: Date.now(), status: "synced", set: 0, removed: 0, rejected: 0, cookies: 9, undecryptable: 0, hosts: [], reason: "sign-in" } }) });
    const slot = await toolbar("https://shopify.okta.com/user/verify_idx_credentials", fakePage(answers).page, { handlers });
    try {
      await elapse(SETTLE_MS + 1_500);
      answers.signInForm = false;
      await elapse(1_500);
      answers.signInForm = true;
      await elapse(7_500);
      expect(slot.inspection.rpcCalls.filter(({ method }) => method === "sync")).toHaveLength(1);
      expect(slot.inspection.rpcCalls.filter(({ method }) => method === "openExternal")).toHaveLength(1);
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("refreshes an access gateway's site, then opens the page it returns to only after the button", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const openExternal = vi.fn(() => ({ ok: true, browser: "Google Chrome" }));
    const sync = vi.fn(() => status({ lastSync: { at: Date.now(), status: "synced", set: 0, removed: 0, rejected: 0, cookies: 9, undecryptable: 0, hosts: [], reason: "sign-in" } }));
    const handlers = rpc({ openExternal, sync });
    const { page, expressions } = fakePage();
    const gateway = "https://gateway.example.test/auth?request=abc&rd=https://app.example.test%2Forders";
    const slot = await toolbar(gateway, page, { handlers, settings: { gatewayPages: "gateway.example.test/auth" } });
    try {
      await elapse(SETTLE_MS + 1_500);
      expect(slot.inspection.rpcCalls.find(({ method }) => method === "sync")?.input).toEqual({
        threadId: "thr_1", mode: "full", reason: "sign-in", mirrorHosts: ["app.example.test"],
      });
      expect(openExternal).not.toHaveBeenCalled();
      const button = within(slot.container).getByRole("button", { name: /Continue in Google Chrome/ });
      expect(button.getAttribute("title")).toContain("Open app.example.test in Google Chrome");

      fireEvent.click(button);
      await elapse(1_000);
      expect(sync).toHaveBeenCalledTimes(2);
      // The page the gateway returns to opens, not the gateway URL with its pending request id.
      expect(openExternal).toHaveBeenCalledExactlyOnceWith({ url: "https://app.example.test/orders" });

      await slot.behavior.emitRealtime("status", status({ lastSync: { at: Date.now() + 1_000, status: "synced", set: 2, removed: 0, rejected: 0, cookies: 9, undecryptable: 0, hosts: ["app.example.test"], reason: "watch" } }));
      // The session that arrived is copied once more with the app's site mirrored, then the app is retried, even
      // though that last copy changed nothing.
      await waitFor(() => expect(expressions).toContain('(location.assign("https://app.example.test/orders"), true)'));
      expect(sync).toHaveBeenCalledTimes(3);
      expect(slot.inspection.rpcCalls.filter(({ method }) => method === "sync").at(-1)?.input).toMatchObject({ mirrorHosts: ["app.example.test"] });
      expect(openExternal).toHaveBeenCalledTimes(1);
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("follows a session that reaches bb while the gateway's Continue button shows", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const openExternal = vi.fn(() => ({ ok: true, browser: "Google Chrome" }));
    const sync = vi.fn(() => status({ lastSync: { at: Date.now(), status: "synced", set: 0, removed: 0, rejected: 0, cookies: 9, undecryptable: 0, hosts: [], reason: "sign-in" } }));
    const { page, expressions } = fakePage();
    const slot = await toolbar("https://gateway.example.test/auth?request=abc&rd=https://app.example.test%2F", page, { handlers: rpc({ openExternal, sync }), settings: { gatewayPages: "gateway.example.test/auth" } });
    try {
      await elapse(SETTLE_MS + 1_500);
      await waitFor(() => expect(within(slot.container).getByRole("button", { name: /Continue in Google Chrome/ })).toBeTruthy());
      await slot.behavior.emitRealtime("status", status({ lastSync: { at: Date.now() + 1_000, status: "synced", set: 3, removed: 0, rejected: 0, cookies: 9, undecryptable: 0, hosts: ["app.example.test"], reason: "watch" } }));
      await waitFor(() => expect(expressions).toContain('(location.assign("https://app.example.test/"), true)'));
      expect(sync).toHaveBeenCalledTimes(2);
      expect(openExternal).not.toHaveBeenCalled();
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("opens only the application Continue named, even if the tab moves to another gateway before the open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const openExternal = vi.fn(() => ({ ok: true, browser: "Google Chrome" }));
    const idle = () => status({ lastSync: { at: Date.now(), status: "synced", set: 0, removed: 0, rejected: 0, cookies: 9, undecryptable: 0, hosts: [], reason: "sign-in" } });
    let finish: (() => void) | null = null;
    const sync = vi.fn()
      .mockImplementationOnce(idle)
      .mockImplementationOnce(() => new Promise<Status>((resolve) => { finish = () => resolve(idle()); }));
    const app = await loadPluginApp(() => import("../app"));
    const action = app.browserToolbarActions[0]!;
    const Toolbar = action.component;
    const props = { threadId: "thr_1", tabId: "tab_1", isCompactViewport: false, experimental_page: fakePage().page };
    const slot = renderSlot(action, { ...props, url: "https://gateway.example.test/auth?rd=https://app-a.example.test%2F" }, {
      pluginId: "better-browser", rpc: rpc({ openExternal, sync }),
      settings: { signIn: "automatic", signInPages: "", gatewayPages: "gateway.example.test/auth", modifierClick: true, sync: true },
    });
    try {
      await elapse(SETTLE_MS + 1_500);
      fireEvent.click(within(slot.container).getByRole("button", { name: /Continue in Google Chrome/ }));
      await waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
      slot.lifecycle.rerender(<Toolbar {...props} url="https://gateway.example.test/auth?rd=https://app-b.example.test%2F" />);
      await elapse(500);
      await act(async () => finish?.());
      await elapse(1_000);
      expect(openExternal).toHaveBeenCalledExactlyOnceWith({ url: "https://app-a.example.test/" });
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("leaves a gateway page alone when it names no application, so the gateway URL never opens", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const openExternal = vi.fn(() => ({ ok: true, browser: "Google Chrome" }));
    const slot = await toolbar("https://gateway.example.test/auth?request=abc&rd=%2Forders", fakePage().page, { handlers: rpc({ openExternal }), settings: { gatewayPages: "gateway.example.test/auth" } });
    try {
      await elapse(SETTLE_MS * 3);
      expect(slot.inspection.rpcCalls.map(({ method }) => method)).not.toContain("sync");
      expect(openExternal).not.toHaveBeenCalled();
      expect(within(slot.container).queryByRole("button", { name: /Continue/ })).toBeNull();
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("returns to the application without the real browser when the refresh clears bb's own cookie there", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const openExternal = vi.fn(() => ({ ok: true, browser: "Google Chrome" }));
    const handlers = rpc({ openExternal, sync: () => status({ lastSync: { at: Date.now(), status: "synced", set: 0, removed: 1, rejected: 0, cookies: 9, undecryptable: 0, hosts: ["app.example.test"], reason: "sign-in" } }) });
    const { page, expressions } = fakePage();
    const slot = await toolbar("https://gateway.example.test/auth?rd=https://app.example.test%2F", page, { handlers, settings: { gatewayPages: "gateway.example.test/auth" } });
    try {
      await elapse(SETTLE_MS + 1_500);
      expect(expressions).toContain('(location.assign("https://app.example.test/"), true)');
      expect(openExternal).not.toHaveBeenCalled();
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("leaves a sign-in host alone while it shows no sign-in form", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const slot = await toolbar("https://shopify.okta.com/app/UserHome", fakePage({ signInForm: false }).page);
    await elapse(SETTLE_MS * 2);
    expect(slot.inspection.rpcCalls.map(({ method }) => method)).not.toContain("sync");
    slot.lifecycle.unmount();
  });
});
