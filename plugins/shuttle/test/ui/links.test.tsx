import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { LinkCard } from "../../src/contract";
import { parseConfig } from "../../src/config";
import { parseGitLink } from "../../src/links";
import { app, callsTo, config, handlers, item, mine, mount, unmountAll, type Handlers } from "./helpers";
import { retryPr } from "./fixtures";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

const SERVERS = [{ id: "github", name: "GitHub", kind: "github" as const, enabled: true, sep: "#" as const, commands: {} }];
const PR_URL = "https://github.com/acme/checkout/pull/4821";
const ISSUE_URL = "https://github.com/acme/checkout/issues/40";
/** What the server says a link is: what it looks like, as Shuttle's server reads it. */
const kindOf = (url: string) => parseGitLink(url, parseConfig(config({ servers: SERVERS })).servers)?.kind ?? null;
const card = (overrides: Partial<LinkCard> = {}): LinkCard => ({
  kind: "pr", label: "acme/checkout#4821", server: "github", serverName: "GitHub", pr: retryPr, prKey: retryPr.key, tab: "overview",
  comment: null, review: null, commit: null, check: null, issue: null, note: null, ...overrides,
});

let disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  unmountAll();
});

/** The overlay and the page script, with a thread message holding `links`. */
async function thread(links: string[], rpc: Partial<Handlers> = {}) {
  const loaded = await app();
  const message = document.createElement("div");
  message.setAttribute("data-message-column", "");
  message.innerHTML = links.map((href, index) => `<p><a href="${href}" id="link${index}">${href}</a></p>`).join("");
  const chrome = document.createElement("nav");
  chrome.innerHTML = `<a href="${PR_URL}" id="chrome">sidebar chip</a>`;
  document.body.append(message, chrome);
  const overlay = loaded.appOverlays.find((entry) => entry.id === "link-cards")!;
  const slot = mount(overlay.component, {}, handlers({
    getConfig: () => ({ config: config({ servers: SERVERS }) }),
    linkStates: ({ urls }) => ({ links: urls.map((url) => ({ url, kind: kindOf(url), state: url.startsWith(PR_URL) ? "open" : null })) }),
    linkCard: () => card(),
    ...rpc,
  }));
  const script = loaded.contentScripts.find((entry) => entry.id === "git-links")!;
  const controller = new AbortController();
  const dispose = await script.mount({ pluginId: "shuttle", generation: 1, signal: controller.signal });
  disposers.push(() => {
    controller.abort();
    if (typeof dispose === "function") void dispose();
    message.remove();
    chrome.remove();
  });
  return {
    slot, message,
    link: (index: number) => document.getElementById(`link${index}`) as HTMLAnchorElement,
    stop: () => { for (const each of disposers.splice(disposers.length - 1, 1)) each(); },
  };
}

/** Lets the page script's next animation frame run. */
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

const hover = (el: Element) => fireEvent(el, new Event("pointerover", { bubbles: true }));

describe("git links in a thread", () => {
  it("marks the links Shuttle can read by kind and their PR's state, and leaves the rest alone", async () => {
    const { slot, link } = await thread([PR_URL, `${PR_URL}#issuecomment-9`, "https://github.com/acme/checkout/commit/1a2b3c4", "https://github.com/acme/checkout/actions/runs/8", "https://github.com/acme/checkout/issues/3", "https://example.com/a"]);
    await waitFor(() => expect(link(0).dataset.shuttleState).toBe("open"));
    expect([0, 1, 2, 3, 4, 5].map((index) => link(index).dataset.shuttleLink ?? null)).toEqual(["pr", "comment", "commit", "check", "issue", null]);
    expect(link(1).dataset.shuttleState).toBe("open");
    expect(document.getElementById("chrome")!.dataset.shuttleLink).toBeUndefined();
    expect(callsTo(slot, "linkStates")).toHaveLength(1);
  });

  it("opens the card after a short rest on a link, and opens the PR in Shuttle on the tab the link is about", async () => {
    const { slot, link } = await thread([`${PR_URL}#discussion_r5`], {
      linkCard: () => card({ kind: "comment", tab: "conversation", comment: { item: item({ author: "sam-rivera", body: "Retry only on 504s.", path: "src/payments/gateway.ts", line: 142, url: `${PR_URL}#discussion_r5` }), replies: 1, resolved: false } }),
    });
    await waitFor(() => expect(link(0).dataset.shuttleLink).toBe("comment"));
    hover(link(0));
    const shown = await screen.findByRole("dialog", { name: `About ${PR_URL}#discussion_r5` }, { timeout: 2000 });
    await waitFor(() => expect(shown.textContent).toContain("Retry card authorization when the payment gateway times out"));
    expect(shown.textContent).toContain("Retry only on 504s.");
    expect(shown.textContent).toContain("src/payments/gateway.ts:142");
    expect(shown.textContent).toContain("Thread still open · 1 other comment in it");
    expect(link(0).dataset.shuttleOpen).toBe("");
    expect(callsTo(slot, "linkCard")).toEqual([{ url: `${PR_URL}#discussion_r5` }]);
    fireEvent.click(within(shown).getByRole("button", { name: "Open in Shuttle" }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "pr/github/acme/checkout/4821" } });
    const states = JSON.parse(window.sessionStorage.getItem("bb-plugin-shuttle:pr-state")!);
    expect(states[JSON.stringify([retryPr.key, ""])].tab).toBe("conversation");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("offers to look up a PR Shuttle has not seen, and never fetches it on a hover", async () => {
    const { slot, link } = await thread([PR_URL], { linkCard: () => card({ pr: null, note: "Shuttle hasn't seen acme/checkout#4821 yet." }) });
    await waitFor(() => expect(link(0).dataset.shuttleLink).toBe("pr"));
    hover(link(0));
    const shown = await screen.findByRole("dialog", {}, { timeout: 2000 });
    await waitFor(() => expect(shown.textContent).toContain("Shuttle hasn't seen acme/checkout#4821 yet."));
    expect(within(shown).getByRole("button", { name: "Look it up in Shuttle" })).toBeTruthy();
    fireEvent.click(within(shown).getByRole("button", { name: "Open on GitHub" }));
    expect(callsTo(slot, "lookup")).toEqual([]);
  });

  it("closes on Escape and when the pointer leaves", async () => {
    const { link } = await thread([PR_URL]);
    await waitFor(() => expect(link(0).dataset.shuttleLink).toBe("pr"));
    hover(link(0));
    await screen.findByRole("dialog", {}, { timeout: 2000 });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent(link(0), new Event("pointerout", { bubbles: true }));
    hover(link(0));
    await screen.findByRole("dialog", {}, { timeout: 2000 });
    fireEvent(link(0), new Event("pointerout", { bubbles: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 2000 });
  });

  it("opens a sheet on a tap instead of following the link", async () => {
    const { link } = await thread([PR_URL], { linkCard: () => card({ pr: mine({ ...retryPr }) }) });
    await waitFor(() => expect(link(0).dataset.shuttleLink).toBe("pr"));
    const down = new Event("pointerdown", { bubbles: true });
    Object.assign(down, { pointerType: "touch" });
    fireEvent(link(0), down);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link(0).dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    const sheet = await screen.findByRole("dialog", { name: "acme/checkout#4821" });
    expect(within(sheet).getByRole("button", { name: "Open on GitHub" })).toBeTruthy();
  });

  it("undoes its marks when it stops", async () => {
    const { link } = await thread([PR_URL]);
    await waitFor(() => expect(link(0).dataset.shuttleLink).toBe("pr"));
    const href = link(0);
    for (const dispose of disposers.splice(0, 1)) {
      // The cleanup removes the message too, so look at the anchor itself before it goes.
      const before = href.dataset.shuttleLink;
      dispose();
      expect(before).toBe("pr");
      expect(href.dataset.shuttleLink).toBeUndefined();
    }
  });

  it("marks a link a streamed message adds after it started, follows an href that changes, and stops when it stops", async () => {
    const { message, stop } = await thread([]);
    message.insertAdjacentHTML("beforeend", `<p><a id="late" href="${PR_URL}">late</a></p>`);
    const late = document.getElementById("late") as HTMLAnchorElement;
    await waitFor(() => expect(late.dataset.shuttleLink).toBe("pr"));
    late.setAttribute("href", "https://github.com/acme/checkout/commit/1a2b3c4");
    await waitFor(() => expect(late.dataset.shuttleLink).toBe("commit"));
    late.setAttribute("href", "https://example.com/elsewhere");
    await waitFor(() => expect(late.dataset.shuttleLink).toBeUndefined());
    late.setAttribute("href", PR_URL);
    await waitFor(() => expect(late.dataset.shuttleLink).toBe("pr"));
    stop();
    expect(late.dataset.shuttleLink).toBeUndefined();
    document.body.insertAdjacentHTML("beforeend", `<div data-message-column><a id="after" href="${PR_URL}">after</a></div>`);
    await frame();
    await frame();
    expect(document.getElementById("after")!.dataset.shuttleLink).toBeUndefined();
  });

  it("does not ask again after a failed lookup each time the page changes, and never sends an overlong link", async () => {
    const long = `${PR_URL}#${"x".repeat(2100)}`;
    let fail = true;
    const { slot, message, link } = await thread([PR_URL, long], {
      linkStates: ({ urls }) => {
        if (fail) throw new Error("restarting");
        return { links: urls.map((url) => ({ url, kind: "pr", state: "open" })) };
      },
    });
    await waitFor(() => expect(callsTo(slot, "linkStates")).toHaveLength(1));
    expect((callsTo(slot, "linkStates")[0] as { urls: string[] }).urls).toEqual([PR_URL]);
    fail = false;
    for (let i = 0; i < 3; i++) {
      message.insertAdjacentHTML("beforeend", `<p>more text ${i}</p>`);
      await frame();
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(callsTo(slot, "linkStates")).toHaveLength(1);
    expect(link(0).dataset.shuttleState).toBeUndefined();
    expect(link(1).dataset.shuttleLink).toBe("pr");
  });

  it("lets a keyboard reach the card's buttons with Down, and Tab, Shift+Tab and Escape go back to the link", async () => {
    const { link } = await thread([PR_URL]);
    await waitFor(() => expect(link(0).dataset.shuttleLink).toBe("pr"));
    link(0).focus();
    const shown = await screen.findByRole("dialog", {}, { timeout: 2000 });
    await waitFor(() => expect(within(shown).getAllByRole("button").length).toBeGreaterThan(1));
    const buttons = within(shown).getAllByRole("button");
    const down = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    link(0).dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(buttons[0]);
    // Focus moving from the link into the card keeps it open.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.getByRole("dialog")).toBe(shown);
    fireEvent.keyDown(buttons[0]!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(link(0));
    link(0).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    buttons.at(-1)!.focus();
    fireEvent.keyDown(buttons.at(-1)!, { key: "Tab" });
    expect(document.activeElement).toBe(link(0));
    link(0).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.activeElement).toBe(link(0));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Going back to the link does not open its card again.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByRole("dialog")).toBeNull();
    // Nor does Escape on the link itself while a card is about to open for it.
    link(0).blur();
    link(0).focus();
    await screen.findByRole("dialog", {}, { timeout: 2000 });
    const again = within(screen.getByRole("dialog")).getAllByRole("button");
    link(0).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    again.at(-1)!.focus();
    fireEvent.keyDown(again.at(-1)!, { key: "Tab" });
    expect(document.activeElement).toBe(link(0));
    fireEvent.keyDown(window, { key: "Escape" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the card while keyboard focus is in it, whatever the pointer does, and a click on its text", async () => {
    const { link } = await thread([PR_URL]);
    await waitFor(() => expect(link(0).dataset.shuttleLink).toBe("pr"));
    link(0).focus();
    const shown = await screen.findByRole("dialog", {}, { timeout: 2000 });
    await waitFor(() => expect(within(shown).getAllByRole("button").length).toBeGreaterThan(1));
    link(0).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    const first = within(shown).getAllByRole("button")[0]!;
    expect(document.activeElement).toBe(first);
    fireEvent.pointerEnter(shown);
    fireEvent.pointerLeave(shown);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.getByRole("dialog")).toBe(shown);
    expect(document.activeElement).toBe(first);
    // A click on the card's text takes focus to nowhere while the pointer is on the card.
    fireEvent.pointerEnter(shown);
    fireEvent.blur(first, { relatedTarget: null });
    fireEvent.focusOut(first, { relatedTarget: null });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.getByRole("dialog")).toBe(shown);
  });

  it("shows an issue's card, colours its links once the card has read it, and opens a PR that closes it in Shuttle", async () => {
    const issue: NonNullable<LinkCard["issue"]> = {
      number: 40, title: "Retries hide gateway outages", state: "completed", author: "sam-rivera", createdAt: Date.now() - 3 * 86_400_000, closedAt: Date.now() - 3_600_000,
      body: "When the gateway is down, the retries make it look slow instead.", labels: [{ name: "bug", color: "d73a4a" }], assignees: ["kalindudc"], comments: 2,
      closedBy: [
        { repo: "acme/checkout", number: 4821, title: "Retry card authorization when the payment gateway times out", state: "merged", url: PR_URL, key: retryPr.key },
        { repo: "acme/docs", number: 3, title: "Document the retry budget", state: "open", url: "https://github.com/acme/docs/pull/3", key: null },
      ],
    };
    const { slot, link } = await thread([ISSUE_URL, `${ISSUE_URL}#issuecomment-1`], {
      linkCard: () => card({ kind: "issue", label: "acme/checkout#40", pr: null, prKey: null, issue }),
    });
    await waitFor(() => expect(link(0).dataset.shuttleLink).toBe("issue"));
    expect(link(0).dataset.shuttleState).toBeUndefined();
    hover(link(0));
    const shown = await screen.findByRole("dialog", {}, { timeout: 2000 });
    await waitFor(() => expect(shown.textContent).toContain("Retries hide gateway outages"));
    expect(shown.querySelector('[data-pill="completed"]')!.textContent).toBe("Closed");
    expect(shown.textContent).toContain("sam-rivera opened it 3d ago");
    expect(shown.textContent).toContain("When the gateway is down");
    expect(shown.querySelector('[data-label="bug"]')).not.toBeNull();
    expect(shown.textContent).toContain("Assigned to kalindudc");
    expect(shown.textContent).toContain("Closed by");
    expect(within(shown).queryByRole("button", { name: /Shuttle/u })).toBeNull();
    // Both links to the issue take its colour from the card's read.
    await waitFor(() => expect(link(0).dataset.shuttleState).toBe("completed"));
    expect(link(1).dataset.shuttleState).toBe("completed");
    fireEvent.click(within(shown).getByRole("button", { name: /#4821/u }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "pr/github/acme/checkout/4821" } });
  });

  it("marks an issue link as a PR when Shuttle knows the number is one", async () => {
    const { link } = await thread([ISSUE_URL], {
      linkStates: ({ urls }) => ({ links: urls.map((url) => ({ url, kind: "pr", state: "merged" })) }),
    });
    await waitFor(() => expect(link(0).dataset.shuttleState).toBe("merged"));
    expect(link(0).dataset.shuttleLink).toBe("pr");
    // A later pass over the page keeps what it turned out to be.
    link(0).parentElement!.insertAdjacentHTML("beforeend", "<span> more</span>");
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(link(0).dataset.shuttleLink).toBe("pr");
  });
});
