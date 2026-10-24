import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import type { ExperimentalThreadActionTabProps, ExperimentalTabRegistration } from "@get-bb/plugin-sdk/app";
import type { PrView } from "../../src/contract";
import { agent, app, callsTo, event, handlers, link, mount, pr, unmountAll, type Handlers, type PullRequests } from "./helpers";

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), toasts) }));

afterEach(() => {
  unmountAll();
  toasts.error.mockReset();
  toasts.success.mockReset();
});

const THREAD = "thr_stack";
const base = pr({ repo: "kalindudc/bb-marketplace", number: 118, title: "Loom: the ticket page", mine: true, reasons: [], links: [link({ threadId: THREAD, title: "Loom work", role: "owner" })], agent: agent({ threadId: THREAD, title: "Loom work" }), watch: "act", pendingItems: 2 });
const middle = pr({ repo: "kalindudc/bb-marketplace", number: 119, title: "Loom: the side column", mine: true, reasons: [], links: [link({ threadId: THREAD, title: "Loom work", role: "owner" }), link({ threadId: "thr_review", title: "Review #119", role: "review" })], agent: agent({ threadId: "thr_other", title: "Loom: side column work" }) });
const top = pr({ repo: "kalindudc/bb-marketplace", number: 120, title: "Loom: notes", mine: true, reasons: [], links: [link({ threadId: THREAD, title: "Loom work", role: "reference" })], pendingItems: 1 });

async function tab(): Promise<ExperimentalTabRegistration> {
  const loaded = await app();
  return loaded.tabs[0]!;
}

/** A fake server that remembers agents, links and unlinks, as Shuttle's does. */
async function panel(rpc: Partial<Handlers> & { pullRequests?: PullRequests } = {}, sdk = {}) {
  const registration = await tab();
  let prs: PrView[] = [base, middle, top];
  const change = (key: string, update: (item: PrView) => PrView) => {
    prs = prs.map((item) => (item.key === key ? update(item) : item));
    return { pr: prs.find((item) => item.key === key)! };
  };
  return mount<ExperimentalThreadActionTabProps>(registration.component as never, { threadId: THREAD, params: { threadId: THREAD } }, {
    ...handlers({
      threadPrs: () => ({ prs, sent: [event({ id: 7, kind: "forwarded", text: "tomas approved: sent with the act prompt", key: base.key, threadId: THREAD })] }),
      setAgentMode: ({ key, mode }) => change(key, (item) => ({ ...item, agent: item.agent === null ? null : { ...item.agent, mode } })),
      setAgent: ({ key, target }) => ({ ...change(key, (item) => ({ ...item, agent: target.kind === "existing" ? agent({ threadId: target.threadId, title: "Loom work" }) : null })), threadId: THREAD }),
      link: ({ key, threadId, role }) => change(key, (item) => ({ ...item, links: item.links.map((entry) => (entry.threadId === threadId ? { ...entry, role: role! } : entry)) })),
      unlink: ({ key }) => {
        const out = { pr: { ...prs.find((item) => item.key === key)!, links: [] } };
        prs = prs.filter((item) => item.key !== key);
        return out;
      },
      ...rpc,
    }),
    ...(rpc.pullRequests ? { pullRequests: rpc.pullRequests } : {}),
  }, { sdk: { threads: { get: async () => ({ environmentId: null }) as never } }, ...sdk });
}

const card = (slot: Awaited<ReturnType<typeof panel>>, key: string) => slot.container.querySelector<HTMLElement>(`[data-pr="${key}"]`)!;
const modes = (slot: Awaited<ReturnType<typeof panel>>, key: string) => within(card(slot, key)).getByRole("radiogroup");
const mode = (slot: Awaited<ReturnType<typeof panel>>, key: string) => within(modes(slot, key)).getAllByRole("radio").find((radio) => radio.getAttribute("aria-checked") === "true")!.textContent;

describe("Shuttle thread tab", () => {
  it("registers as a flush thread action tab that opens with the thread's id", async () => {
    const registration = await tab();
    expect(registration).toMatchObject({ id: "shuttle", title: "Shuttle", icon: "shuttle/shuttle", layout: "flush", availability: "action", context: { kind: "thread" } });
    const openPanel = vi.fn(() => true);
    // Narrowing the registration union by context.kind does not narrow run's parameter, so name the thread form.
    const run = registration.run as (context: { threadId: string; openPanel: typeof openPanel }) => Promise<void> | void;
    await run({ threadId: "thr_1", openPanel });
    expect(openPanel).toHaveBeenCalledWith({ params: { threadId: "thr_1" } });
  });

  it("lists every PR linked to the thread with its role, status and agent", async () => {
    const slot = await panel();
    await slot.findByText(top.title);
    expect(callsTo(slot, "threadPrs")).toContainEqual({ threadId: THREAD });
    const cards = [...slot.container.querySelectorAll("[data-pr]")].map((node) => node.getAttribute("data-pr"));
    expect(cards).toEqual([base.key, middle.key, top.key]);
    expect(card(slot, base.key).textContent).toContain("Agent");
    expect(card(slot, base.key).textContent).toContain("2 new items");
    expect(card(slot, base.key).textContent).toContain("This thread is the agent");
    expect(card(slot, middle.key).textContent).toContain("Also linked to 1 other thread");
    expect(card(slot, middle.key).textContent).toContain("Agent: Loom: side column work");
    expect(card(slot, top.key).textContent).toContain("Reference");
    expect(card(slot, top.key).textContent).toContain("No agent");
    expect(slot.getByText("tomas approved: sent with the act prompt")).toBeTruthy();
    expect(slot.getByRole("button", { name: "Send 3 unread items now" })).toBeTruthy();
  });

  it("switches what this thread does at once, before the server answers, with Undo", async () => {
    let release: () => void = () => {};
    let current: PrView = base;
    const slot = await panel({
      setAgentMode: ({ mode: next }) => new Promise((resolve) => {
        release = () => {
          current = { ...base, agent: { ...base.agent!, mode: next } };
          resolve({ pr: current });
        };
      }),
      threadPrs: () => ({ prs: [current], sent: [] }),
    });
    await slot.findByText(base.title);
    expect(mode(slot, base.key)).toBe("Fix it");
    fireEvent.click(within(modes(slot, base.key)).getByRole("radio", { name: "Off" }));
    await waitFor(() => expect(callsTo(slot, "setAgentMode")).toEqual([{ key: base.key, mode: "off" }]));
    expect(mode(slot, base.key)).toBe("Off");
    release();
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(1));
    expect(mode(slot, base.key)).toBe("Off");
    toasts.success.mock.calls[0]![1].action.onClick();
    await waitFor(() => expect(callsTo(slot, "setAgentMode")).toEqual([{ key: base.key, mode: "off" }, { key: base.key, mode: "fix" }]));
    release();
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(2));
  });

  it("puts the mode back and shows why when the server refuses", async () => {
    const slot = await panel({
      setAgentMode: () => { throw Object.assign(new Error("the agent's thread is archived"), { code: "invalid" }); },
    });
    await slot.findByText(base.title);
    fireEvent.click(within(modes(slot, base.key)).getByRole("radio", { name: "Just tell it" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("the agent's thread is archived"));
    expect(mode(slot, base.key)).toBe("Fix it");
  });

  it("makes this thread the agent of a PR another thread handles, or that has none", async () => {
    const slot = await panel();
    await slot.findByText(top.title);
    fireEvent.click(within(card(slot, middle.key)).getByRole("button", { name: "Make this thread the agent" }));
    await waitFor(() => expect(callsTo(slot, "setAgent")).toEqual([{ key: middle.key, target: { kind: "existing", threadId: THREAD } }]));
    await waitFor(() => expect(card(slot, middle.key).textContent).toContain("This thread is the agent"));
    fireEvent.click(within(card(slot, top.key)).getByRole("button", { name: "Make this thread the agent" }));
    await waitFor(() => expect(callsTo(slot, "setAgent")).toHaveLength(2));
    expect(callsTo(slot, "setAgent")[1]).toEqual({ key: top.key, target: { kind: "existing", threadId: THREAD } });
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(2));
  });

  it("unlinks one PR and keeps the others", async () => {
    const slot = await panel();
    await slot.findByText(top.title);
    fireEvent.click(within(card(slot, middle.key)).getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(slot.container.querySelectorAll("[data-pr]")).toHaveLength(2));
    expect(callsTo(slot, "unlink")).toEqual([{ key: middle.key, threadId: THREAD }]);
  });

  it("sends unread items now, even when none is known yet, since the server checks first", async () => {
    const slot = await panel({ threadPrs: () => ({ prs: [{ ...base, pendingItems: 0 }], sent: [] }), sendUnread: () => ({ sent: 0 }) });
    fireEvent.click(await slot.findByRole("button", { name: "Send unread now" }));
    await waitFor(() => expect(callsTo(slot, "sendUnread")).toEqual([{ threadId: THREAD }]));
  });

  it("looks up a pasted PR and links it to this thread as its owner", async () => {
    const found = pr({ repo: "shop/world", number: 2261179, server: "delta", serverName: "Delta" });
    const slot = await panel({
      lookup: () => ({ pr: found }),
      link: ({ key }) => ({ pr: { ...found, key } }),
    });
    await slot.findByText(top.title);
    const input = slot.getByRole("textbox", { name: "Link a pull request" });
    fireEvent.change(input, { target: { value: "https://delta.shopify.io/shop/world/pull/2261179" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(callsTo(slot, "link")).toEqual([{ key: found.key, threadId: THREAD, role: "owner" }]));
    expect(callsTo(slot, "lookup")).toEqual([{ query: "https://delta.shopify.io/shop/world/pull/2261179" }]);
  });

  it("says so when no PR is linked", async () => {
    const slot = await panel({ threadPrs: () => ({ prs: [], sent: [] }) });
    await slot.findByText(/No pull request is linked to this thread/u);
  });
});

describe("the branch's GitHub pull request", () => {
  const branchPr = { number: 512, title: "Retry budget per upstream cluster", url: "https://github.com/Shopify/edge-router/pull/512", state: "open" };

  it("offers to link the PR GitHub PR Status found for the thread's branch", async () => {
    const pullRequests = vi.fn<PullRequests>(({ keys }) => Object.fromEntries(keys.map((key) => [key, { outcome: "available", pullRequest: branchPr }])));
    const slot = await panel({ pullRequests, link: ({ key }) => ({ pr: pr({ url: key, repo: "Shopify/edge-router", number: 512 }) }) },
      { sdk: { threads: { get: async () => ({ environmentId: "env_branch_1" }) as never } } });
    const suggestion = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-branch-pr]") ?? Promise.reject(new Error("no suggestion")));
    expect(suggestion.textContent).toContain("This thread's branch has PR #512");
    expect(pullRequests).toHaveBeenCalledWith({ keys: ["env_branch_1"] });
    expect(slot.inspection.sdkCalls).toContainEqual({ method: "threads.get", args: [{ threadId: THREAD }] });
    fireEvent.click(within(suggestion).getByRole("button", { name: "Link" }));
    await waitFor(() => expect(callsTo(slot, "link")).toEqual([{ key: branchPr.url, threadId: THREAD, role: "owner" }]));
  });

  it("says nothing when that PR is already linked", async () => {
    const slot = await panel({
      threadPrs: () => ({ prs: [{ ...base, url: `${branchPr.url}/` }], sent: [] }),
      pullRequests: ({ keys }) => Object.fromEntries(keys.map((key) => [key, { outcome: "available", pullRequest: branchPr }])),
    }, { sdk: { threads: { get: async () => ({ environmentId: "env_branch_2" }) as never } } });
    await slot.findByText(base.title);
    await waitFor(() => expect(callsTo(slot, "pullRequests")).toHaveLength(1));
    expect(slot.container.querySelector("[data-branch-pr]")).toBeNull();
  });

  it("says nothing when the branch has no PR", async () => {
    const slot = await panel({ pullRequests: ({ keys }) => Object.fromEntries(keys.map((key) => [key, { outcome: "absent" }])) },
      { sdk: { threads: { get: async () => ({ environmentId: "env_branch_3" }) as never } } });
    await slot.findByText(base.title);
    await waitFor(() => expect(callsTo(slot, "pullRequests")).toHaveLength(1));
    expect(slot.container.querySelector("[data-branch-pr]")).toBeNull();
  });
});
