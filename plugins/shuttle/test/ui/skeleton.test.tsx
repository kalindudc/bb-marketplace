import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import type { ExperimentalThreadActionTabProps } from "@get-bb/plugin-sdk/app";
import type { InboxView } from "../../src/contract";
import { formatRoute } from "../../src/ui/route";
import { app, find, handlers, inbox, lastNavigation, mount, next, page, pr, unmountAll, type Handlers } from "./helpers";

afterEach(unmountAll);

/** A read the server has not answered yet. */
const pending = () => new Promise<never>(() => {});

const asked = pr({ next: next({ kind: "new_request", label: "New review request", inbox: true }) });
const detailOf = (body: string | null = "## Why\n\nIt samples per route.") => () => ({ pr: asked, events: [], body, draft: null, drafts: 0 });

describe("Shuttle while its server has not answered", () => {
  it.each<[string, Partial<Handlers>, string]>([
    ["inbox", { inbox: pending }, "Loading the Inbox"],
    ["mine", { list: pending }, "Loading your PRs"],
    ["done", { list: pending }, "Loading your merged and closed PRs"],
    ["reviews", { list: pending }, "Loading the PRs to review"],
    ["boards", { boards: pending }, "Loading boards"],
    ["board/release", { board: pending }, "Loading the board"],
    ["insights", { insights: pending }, "Loading Insights"],
    ["insights/log", { activity: pending }, "Loading the automation log"],
    ["insights/sync", { overview: pending }, "Loading the sync history"],
  ])("draws the shape of %s instead of a line of text", async (subPath, rpc, label) => {
    const { slot } = await page(subPath, rpc);
    const skeleton = await slot.findByRole("status", { name: label });
    expect(skeleton.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    expect(slot.queryByText("Loading…")).toBeNull();
  });

  it("gives way to the list once it lands", async () => {
    let answer: (value: InboxView) => void = () => {};
    const { slot } = await page("inbox", { inbox: () => new Promise<InboxView>((resolve) => { answer = resolve; }) });
    await slot.findByRole("status", { name: "Loading the Inbox" });
    answer(inbox({ prs: [asked] }));
    await find(slot.container, `[data-row="${asked.key}"]`);
    expect(slot.queryByRole("status", { name: "Loading the Inbox" })).toBeNull();
  });

  it("draws a PR's shape beside its list, and it can be closed before it lands", async () => {
    const { slot } = await page(formatRoute({ view: "reviews", source: "all", key: asked.key }), { list: () => ({ prs: [asked] }), detail: pending });
    const panel = await find(slot.container, "[data-panel]");
    await within(panel).findByRole("status", { name: "Loading the pull request" });
    expect(within(panel).queryByText("Loading…")).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Close details" }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "reviews", replace: true } });
  });

  it("draws a PR's shape on its own page, not the look-up page", async () => {
    const { slot } = await page(formatRoute({ view: "pr", key: asked.key }), { detail: pending });
    await slot.findByRole("status", { name: "Loading the pull request" });
    expect(slot.queryByRole("heading", { name: "Look up" })).toBeNull();
  });

  it("keeps the look-up page for a PR its server could not find", async () => {
    const { slot } = await page(formatRoute({ view: "pr", key: asked.key }), { detail: ({ key }) => { throw Object.assign(new Error(`no pull request ${key}`), { code: "not_found" }); } });
    await slot.findByRole("button", { name: "Fetch it from its server" });
    expect(slot.getByRole("heading", { name: "Look up" })).toBeTruthy();
    expect(slot.queryByRole("status", { name: "Loading the pull request" })).toBeNull();
  });

  it("draws the description, the conversation and the changes while the server reads them", async () => {
    const { slot } = await page(formatRoute({ view: "pr", key: asked.key }), { detail: detailOf(null), conversation: pending });
    await slot.findByRole("status", { name: "Loading the description" });
    fireEvent.click(slot.getByRole("tab", { name: /Conversation/u }));
    await slot.findByRole("status", { name: "Loading the conversation" });
    fireEvent.click(slot.getByRole("tab", { name: /Changes/u }));
    await slot.findByRole("status", { name: "Loading the changes" });
    expect(slot.queryByText(/^Loading the/u)).toBeNull();
  });

  it("draws a linked PR's card in a thread's Shuttle tab", async () => {
    const loaded = await app();
    const slot = mount<ExperimentalThreadActionTabProps>(loaded.tabs[0]!.component as never, { threadId: "thr_1", environment: null, params: { threadId: "thr_1" } }, handlers({ threadPrs: pending }), {
      sdk: { threads: { get: async () => ({ environmentId: null }) as never } },
    });
    await slot.findByRole("status", { name: "Loading this thread's pull requests" });
    expect(slot.queryByText("Loading…")).toBeNull();
    // Linking another PR does not wait for the list.
    await waitFor(() => expect(slot.getByRole("textbox", { name: "Link a pull request" })).toBeTruthy());
  });
});
