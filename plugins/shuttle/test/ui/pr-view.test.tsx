import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ConversationItem, PrView, ReviewDraft } from "../../src/contract";
import { formatRoute } from "../../src/ui/route";
import { agent, CAN_ALL, callsTo, draft, find, item, link, mergeOptions, mine, next, page, pr, unmountAll, type Handlers } from "./helpers";

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), toasts) }));

afterEach(() => {
  unmountAll();
  toasts.error.mockReset();
  toasts.success.mockReset();
});

const own = mine({
  repo: "Shopify/infra-central", number: 29278, title: "Retry WAF rule deletes that failed for a transient reason", headRef: "kalindudc/cftoken-2-retry-waf-thr_cbektskwyj",
  checks: "failed", checkCounts: { passed: 8, failed: 1, pending: 0, total: 9 }, review: "changes", can: CAN_ALL, actions: ["draft", "close", "labels", "reviewers"],
  reviewers: [{ login: "chrisd3r", team: false, state: "changes" }, { login: "dakmcinnis", team: false, state: "requested" }], labels: [],
  agent: agent({ lastSent: { at: Date.now() - 35 * 60_000, text: "Sent 3 comments and 1 failed check" }, auto: true }),
  links: [link({ threadId: "thr_agent", title: "CF token containment 2: retry WAF deletes", role: "owner" }), link({ threadId: "thr_notes", title: "Edge notes", role: "reference" })],
  next: next({ kind: "agent_on_it", tone: "info", label: "The agent is on it", why: "“CF token containment 2” is fixing 4 items: changes requested by chrisd3r and rspec (shard 3) failing.", more: [{ id: "open_agent", label: "Open the thread" }] }),
});
const theirs = pr({
  repo: "shop/world", server: "delta", serverName: "Delta", number: 2311622, title: "Run contract-test Envoys natively when Docker is missing", author: "elvin", can: CAN_ALL,
  additions: 212, deletions: 40, files: 6, next: next({ kind: "new_request", tone: "info", label: "New review request", why: "elvin asked you 5h ago · M change, 6 files.", inbox: true, primary: { id: "review", label: "Start AI review" } }),
});
const ITEMS: ConversationItem[] = [
  item({ id: "c1", author: "chrisd3r", body: "The retry should back off.", thread: "PRRT_1", delivery: "sent", at: Date.now() - 40 * 60_000 }),
  item({ id: "c2", kind: "check", author: null, body: "rspec (shard 3) failed", path: null, line: null, thread: null, url: "https://github.com/logs/1", at: Date.now() - 35 * 60_000 }),
  item({ id: "c3", kind: "review", author: "pascal", state: "approved", body: "LGTM.", path: null, line: null, thread: null, at: Date.now() - 2 * 60 * 60_000 }),
  item({ id: "c4", author: "binks", bot: true, body: "Log the token id.", thread: "PRRT_2", outcome: { outcome: "fixed", note: null, commit: "7c41d2e9", at: Date.now() }, at: Date.now() - 20 * 60 * 60_000 }),
];

/** A server that remembers what the PR view changes, so confirmed reads agree with its predictions. */
function prPage(start: PrView, rpc: Partial<Handlers> = {}, extra: { draft?: ReviewDraft | null; items?: ConversationItem[]; error?: string | null } = {}) {
  let current = start;
  const area = start.mine ? "mine" : "reviews";
  const route = start.mine ? formatRoute({ view: "mine", key: start.key }) : formatRoute({ view: "reviews", source: "all", key: start.key });
  return page(route, {
    list: ({ area: asked }) => ({ prs: asked === area ? [current] : [] }),
    detail: () => ({ pr: current, events: [], body: "## What changes\n\nRetries **5xx** deletes.", draft: extra.draft ?? null }),
    conversation: () => ({ items: extra.items ?? [], error: extra.error ?? null, fetchedAt: Date.now() }),
    setAgentMode: ({ mode }) => {
      current = { ...current, agent: current.agent === null ? null : { ...current.agent, mode } };
      return { pr: current };
    },
    track: ({ on }) => {
      current = { ...current, tracked: on };
      return { pr: current };
    },
    ...rpc,
  }).then((out) => ({ ...out, view: () => find(out.slot.container, `[data-detail="${start.key}"]`) }));
}

describe("the PR view of your own PR", () => {
  it("shows where it stands, the next step in the server's words, its agent, and the rest below", async () => {
    const { view } = await prPage(own, {}, { items: ITEMS });
    const panel = await view();
    expect(panel.textContent).toContain("Shopify/infra-central#29278");
    expect(panel.textContent).toContain("kalindudc/cftoken-2-retry-waf… → main");
    const cells = [...panel.querySelectorAll<HTMLElement>("[data-cell]")];
    expect(cells.map((cell) => cell.getAttribute("data-cell"))).toEqual(["Checks", "Reviews", "Agent"]);
    await waitFor(() => expect(cells[0]!.textContent).toBe("Checks1 failingrspec (shard 3)"));
    expect(cells[1]!.textContent).toBe("ReviewsChangesby chrisd3r");
    expect(cells[2]!.textContent).toBe("AgentFixesidle");
    const banner = panel.querySelector<HTMLElement>("[data-banner]")!;
    expect(banner.textContent).toContain("The agent is on it");
    expect(banner.textContent).toContain("“CF token containment 2” is fixing 4 items");
    expect([...panel.querySelectorAll("section[aria-label]")].map((node) => node.getAttribute("aria-label"))).toEqual(["Boards", "Agent", "Description", "Conversation", "Checks", "Details", "Threads"]);
    expect(panel.querySelector("[data-your-review]")).toBeNull();
    const card = panel.querySelector<HTMLElement>("[data-agent-card]")!;
    expect(card.textContent).toContain("CF token containment 2: retry WAF deletes");
    expect(card.textContent).toContain("Last: Sent 3 comments and 1 failed check, 35m ago · picked automatically");
    expect(within(panel).queryByRole("button", { name: "Track" })).toBeNull();
  });

  it("switches the agent's mode at once, and Undo sends the mode before", async () => {
    let release: () => void = () => {};
    const { slot, view } = await prPage(own, {
      setAgentMode: ({ mode }) => new Promise((resolve) => {
        release = () => resolve({ pr: { ...own, agent: { ...own.agent!, mode } } });
      }),
    });
    const card = await find(await view(), "[data-agent-card]");
    fireEvent.click(within(card).getByRole("radio", { name: "Just tell it" }));
    await waitFor(() => expect(callsTo(slot, "setAgentMode")).toEqual([{ key: own.key, mode: "notify" }]));
    expect(within(card).getByRole("radio", { name: "Just tell it" }).getAttribute("aria-checked")).toBe("true");
    expect(card.textContent).toContain("It is not asked to act.");
    release();
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(1));
    expect(toasts.success.mock.calls[0]![0]).toBe("The agent is now told about new feedback, and not asked to fix it.");
    toasts.success.mock.calls[0]![1].action.onClick();
    await waitFor(() => expect(callsTo(slot, "setAgentMode")).toEqual([{ key: own.key, mode: "notify" }, { key: own.key, mode: "fix" }]));
    release();
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(2));
  });

  it("gives a PR without an agent the thread picked in the agent dialog, or its suggested one", async () => {
    const bare = { ...own, agent: null, suggestedAgent: { threadId: "thr_open", title: "CF token containment 2", why: "Opened this PR: its id is in the branch name" } };
    const { slot, view } = await prPage(bare, {
      threads: () => ({ threads: [{ id: "thr_recent", title: "Edge capacity scenes", projectId: null, status: "idle", updatedAt: null }] }),
      setAgent: ({ target }) => ({ pr: { ...bare, agent: agent({ threadId: target.kind === "existing" ? target.threadId : "thr_new", title: "Edge capacity scenes" }) }, threadId: "thr_recent" }),
    });
    const card = await find(await view(), "[data-agent-card]");
    expect(card.textContent).toContain("No agent. New feedback on this PR waits in your Inbox.");
    fireEvent.click(within(card).getByRole("button", { name: "Pick a thread…" }));
    const dialog = await slot.findByRole("dialog", { name: "Who handles feedback on infra-central#29278?" });
    expect(within(dialog).getByRole("radio", { name: /CF token containment 2/u }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(await within(dialog).findByRole("radio", { name: /Edge capacity scenes/u }));
    fireEvent.click(within(within(dialog).getByRole("radiogroup", { name: "What it does" })).getByRole("radio", { name: "Just tell it" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Give it this agent" }));
    await waitFor(() => expect(callsTo(slot, "setAgent")).toEqual([{ key: own.key, target: { kind: "existing", threadId: "thr_recent" }, mode: "notify" }]));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(1));
    toasts.success.mock.calls[0]![1].action.onClick();
    await waitFor(() => expect(callsTo(slot, "setAgent")[1]).toEqual({ key: own.key, target: { kind: "none" } }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(2));

    fireEvent.click(within(card).getByRole("button", { name: "Use it" }));
    await waitFor(() => expect(callsTo(slot, "setAgent")[2]).toEqual({ key: own.key, target: { kind: "existing", threadId: "thr_open" } }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(3));
  });

  it("starts a new thread as the agent from New thread for this PR", async () => {
    const bare = { ...own, agent: null };
    const { slot, view } = await prPage(bare, { setAgent: () => ({ pr: { ...bare, agent: agent({ title: "infra-central#29278: fix feedback" }) }, threadId: "thr_new" }) });
    fireEvent.click(within(await find(await view(), "[data-agent-card]")).getByRole("button", { name: "New thread for this PR" }));
    const dialog = await slot.findByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: /A new thread for this PR/u }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(dialog).getByRole("button", { name: "Give it this agent" }));
    await waitFor(() => expect(callsTo(slot, "setAgent")).toEqual([{ key: own.key, target: { kind: "new" }, mode: "fix" }]));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(1));
    expect(toasts.success.mock.calls[0]![1]).toBeUndefined();
  });

  it("lists failing checks by name from the conversation, and tags what happened to each item", async () => {
    const { view } = await prPage(own, {}, { items: ITEMS });
    const panel = await view();
    const checks = within(panel).getByRole("region", { name: "Checks" });
    await waitFor(() => expect(checks.querySelector("[data-failing-check]")!.textContent).toContain("rspec (shard 3)"));
    expect(checks.textContent).toContain("8 of 9 pass");
    expect(checks.textContent).toContain("8 passed");
    const conversation = within(panel).getByRole("region", { name: "Conversation" });
    const order = [...conversation.querySelectorAll("[data-item]")].map((node) => node.getAttribute("data-item"));
    expect(order).toEqual(["c2", "c1", "c3", "c4"]);
    const tag = (id: string) => conversation.querySelector(`[data-item="${id}"] [data-tag]`)?.textContent ?? null;
    expect(tag("c1")).toBe("Sent to agent");
    expect(tag("c4")).toBe("Fixed in 7c41d2e");
    expect(tag("c3")).toBeNull();
  });

  it("marks unsent feedback when the PR has no agent, and offers to send it to one", async () => {
    const bare = { ...own, agent: null };
    const { slot, view } = await prPage(bare, {}, { items: [item({ id: "x", author: "chrisd3r", delivery: null })] });
    const conversation = within(await view()).getByRole("region", { name: "Conversation" });
    await waitFor(() => expect(conversation.querySelector("[data-tag]")!.textContent).toBe("Not sent · no agent"));
    fireEvent.click(within(conversation).getByRole("button", { name: "Send to an agent" }));
    expect(await slot.findByRole("dialog", { name: /Who handles feedback/u })).toBeTruthy();
  });

  it("asks the agent from the composer instead of commenting", async () => {
    const { slot, view } = await prPage(own, { askAgent: () => ({ ok: true }) });
    const composer = await find(await view(), "[data-composer]");
    expect(within(composer).queryByRole("radiogroup")).toBeNull();
    fireEvent.change(within(composer).getByRole("textbox"), { target: { value: "Keep the kill switch one more release." } });
    fireEvent.click(within(composer).getByRole("button", { name: "Ask the agent" }));
    await waitFor(() => expect(callsTo(slot, "askAgent")).toEqual([{ key: own.key, text: "Keep the kill switch one more release." }]));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Sent to “CF token containment 2: retry WAF deletes”. Nothing was posted on the PR."));
    expect((within(composer).getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    expect(callsTo(slot, "comment")).toEqual([]);
  });

  it("shows the description above the conversation, and keeps Details closed until asked", async () => {
    const { view } = await prPage(own);
    const panel = await view();
    const description = within(panel).getByRole("region", { name: "Description" });
    await waitFor(() => expect(description.querySelector("[data-description]")!.textContent).toContain("Retries **5xx** deletes."));
    const details = within(panel).getByRole("region", { name: "Details" });
    expect(details.querySelector("[data-manage]")).toBeNull();
    fireEvent.click(within(details).getByRole("button", { name: /Details/u }));
    expect(details.querySelector("[data-manage]")).not.toBeNull();
    expect(details.querySelector("[data-description]")).toBeNull();
  });

  it("lists its threads with their roles and unlinks one", async () => {
    let current = own;
    const { slot, view } = await prPage(own, {
      list: () => ({ prs: [current] }),
      detail: () => ({ pr: current, events: [], body: "", draft: null }),
      unlink: ({ threadId }) => {
        current = { ...current, links: current.links.filter((entry) => entry.threadId !== threadId) };
        return { pr: current };
      },
    });
    const threads = within(await view()).getByRole("region", { name: "Threads" });
    expect([...threads.querySelectorAll("[data-link]")].map((node) => node.textContent)).toEqual(["CF token containment 2: retry WAF deletesAgent", "Edge notesReference"]);
    fireEvent.click(within(threads).getByRole("button", { name: "Edge notes" }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_notes" });
    fireEvent.click(within(threads).getByRole("button", { name: "Unlink “Edge notes”" }));
    await waitFor(() => expect(threads.querySelectorAll("[data-link]")).toHaveLength(1));
    expect(callsTo(slot, "unlink")).toEqual([{ key: own.key, threadId: "thr_notes" }]);
  });
});

describe("the merge dialog", () => {
  const ready = mine({
    ...own, checks: "passed", checkCounts: { passed: 12, failed: 0, pending: 0, total: 12 }, review: "approved",
    reviewers: [{ login: "pascal", team: false, state: "approved" }, { login: "keisku", team: false, state: "requested" }, { login: "Shopify/app-infra", team: true, state: "requested" }],
    next: next({ kind: "ready_to_merge", tone: "ok", label: "Ready to merge", why: "Approved by pascal.", primary: { id: "merge", label: "Merge…" } }),
  });

  async function open(options = mergeOptions(), rpc: Partial<Handlers> = {}) {
    const { slot, view } = await prPage(ready, { mergeOptions: () => options, merge: ({ auto }) => ({ pr: { ...ready, state: auto ? "open" : "merged" }, merged: !auto }), ...rpc });
    fireEvent.click(within(await find(await view(), "[data-banner]")).getByRole("button", { name: "Merge…" }));
    const dialog = await slot.findByRole("dialog", { name: "Merge infra-central#29278" });
    await within(dialog).findByRole("radiogroup", { name: "How" });
    return { slot, dialog };
  }

  it("merges with the PR's head and the chosen method", async () => {
    const { slot, dialog } = await open();
    expect(dialog.textContent).toContain("All 12 checks pass");
    expect(dialog.textContent).toContain("Approved by pascal");
    expect(dialog.textContent).toContain("1 requested reviewer has not reviewed.");
    expect(dialog.textContent).toContain("Merges only if nobody pushed since you looked (head 4be81d0).");
    const rebase = within(dialog).getByRole("radio", { name: /Rebase and merge/u });
    expect(rebase.getAttribute("aria-disabled")).toBe("true");
    expect(rebase.textContent).toContain("Not allowed in this repository");
    expect((within(dialog).getByRole("textbox", { name: "Commit title" }) as HTMLInputElement).value).toBe("Retry WAF rule deletes that failed for a transient reason (#29278)");
    expect((within(dialog).getByRole("checkbox", { name: "Delete the branch after merging" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole("radio", { name: /Create a merge commit/u }));
    expect(within(dialog).queryByRole("textbox", { name: "Commit title" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Delete the branch after merging" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(callsTo(slot, "merge")).toEqual([{ key: ready.key, method: "merge", head: "4be81d0aa", auto: false, deleteBranch: false }]));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Merged infra-central#29278 on GitHub (merge)."));
    expect(toasts.success.mock.calls[0]![1]).toBeUndefined();
  });

  it("sends the commit title with a squash", async () => {
    const { slot, dialog } = await open();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Commit title" }), { target: { value: "Retry WAF deletes (#29278)" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(callsTo(slot, "merge")).toEqual([{ key: ready.key, method: "squash", head: "4be81d0aa", auto: false, deleteBranch: true, subject: "Retry WAF deletes (#29278)" }]));
  });

  it("turns on auto-merge when the PR cannot merge yet but can by itself", async () => {
    const { slot, dialog } = await open(mergeOptions({ state: "pending", detail: "2 checks are still running." }));
    expect(dialog.textContent).toContain("When it can merge");
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on auto-merge" }));
    await waitFor(() => expect(callsTo(slot, "merge")).toEqual([expect.objectContaining({ auto: true, head: "4be81d0aa" })]));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Auto-merge is on for infra-central#29278: it merges once GitHub lets it."));
  });

  it("only merges at once when the server says it can, or cannot tell", async () => {
    const behind = await open(mergeOptions({ state: "behind", canAuto: false, detail: null }));
    expect(within(behind.dialog).getByRole("alert").textContent).toBe("The base branch moved on: update the branch first.");
    expect((within(behind.dialog).getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(true);
    unmountAll();
    const unknown = await open(mergeOptions({ state: "unknown", canAuto: false, detail: null }));
    expect(unknown.dialog.textContent).toContain("doesn't say whether it can merge");
    expect((within(unknown.dialog).getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables Merge and says why when the PR is blocked and cannot merge by itself", async () => {
    const { dialog } = await open(mergeOptions({ state: "blocked", canAuto: false, detail: "A required review from Shopify/app-infra is missing." }));
    expect(within(dialog).getByRole("alert").textContent).toBe("A required review from Shopify/app-infra is missing.");
    expect((within(dialog).getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the PR view of someone else's PR", () => {
  it("shows its size, checks and your review, the Your review card, and Track", async () => {
    const { slot, view } = await prPage(theirs);
    const panel = await view();
    expect([...panel.querySelectorAll<HTMLElement>("[data-cell]")].map((cell) => cell.textContent)).toEqual(["SizeM · 6 files+212 −40", "ChecksAll passall green", "Your reviewNot startedasked 5h ago"]);
    const card = panel.querySelector<HTMLElement>("[data-your-review]")!;
    expect(card.textContent).toContain("New review request");
    expect(card.textContent).toContain("elvin asked you 5h ago · M change, 6 files.");
    expect(within(card).getAllByRole("button").map((button) => button.textContent)).toEqual(["Start AI review", "Not now", "Approve…", "Comment"]);
    expect(panel.querySelector("[data-agent-card]")).toBeNull();
    expect(panel.querySelector("[data-banner]")).toBeNull();
    const track = within(panel).getByRole("button", { name: "Track" });
    fireEvent.click(track);
    await waitFor(() => expect(callsTo(slot, "track")).toEqual([{ key: theirs.key, on: true }]));
    await waitFor(() => expect(within(panel).getByRole("button", { name: "Tracked" }).getAttribute("aria-pressed")).toBe("true"));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(1));
    toasts.success.mock.calls[0]![1].action.onClick();
    await waitFor(() => expect(callsTo(slot, "track")).toEqual([{ key: theirs.key, on: true }, { key: theirs.key, on: false }]));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(2));
  });

  it("posts only the ticked findings, as edited, with the draft's id", async () => {
    const posted = { ...theirs, draft: { id: 7, findings: 3, at: Date.now() }, next: next({ kind: "post", tone: "info", label: "AI review ready: choose what to post", why: "3 findings." }) };
    const { slot, view } = await prPage(posted, { submitReview: () => ({ pr: posted, placed: 1, inBody: 1 }) }, { draft: draft() });
    const card = await find(await view(), "[data-draft]");
    expect(card.textContent).toContain("Findings · 2 of 3 will post");
    const box = (name: RegExp) => within(card).getByRole("checkbox", { name }) as HTMLInputElement;
    expect(box(/nit finding/u).checked).toBe(false);
    fireEvent.click(box(/medium finding/u));
    fireEvent.click(box(/nit finding/u));
    fireEvent.change(within(card).getByRole("textbox", { name: "Text of the finding at header/README.md" }), { target: { value: "  The README names the old prop.  " } });
    fireEvent.change(within(card).getByRole("textbox", { name: "Summary" }), { target: { value: "Two things." } });
    fireEvent.click(within(within(card).getByRole("radiogroup", { name: "Post as" })).getByRole("radio", { name: "Comment" }));
    fireEvent.click(within(card).getByRole("button", { name: "Post review · 2 comments" }));
    await waitFor(() => expect(callsTo(slot, "submitReview")).toEqual([{
      key: theirs.key, verdict: "comment", body: "Two things.", draftId: 7,
      findings: [
        { path: "src/header/actions.tsx", line: 88, body: "The compact prop never reaches the overflow menu." },
        { path: "src/header/README.md", line: null, body: "The README names the old prop." },
      ],
    }]));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Posted your review on Delta: 1 inline, 1 in the body."));
  });

  it("says a server without a review command needs one in Settings, instead of offering to post", async () => {
    const posted = { ...theirs, can: { ...theirs.can, review: false }, draft: { id: 7, findings: 3, at: Date.now() }, next: next({ kind: "post", tone: "info", label: "AI review ready: choose what to post", why: "3 findings." }) };
    const { view } = await prPage(posted, {}, { draft: draft() });
    const card = await find(await view(), "[data-draft]");
    expect(within(card).queryByRole("button", { name: /Post review/u })).toBeNull();
    const note = card.querySelector<HTMLElement>("[data-no-review-command]")!;
    expect(note.textContent).toBe("Shuttle can't post this yet: Delta has no review command in Settings › Servers. Add one there (Shuttle's Delta adapter, delta.sh, has it), or post it from the review thread.");
    expect(within(note).getByRole("link", { name: "Settings › Servers" }).getAttribute("href")).toBe("/settings/plugins/shuttle");
  });

  it("warns about a draft of an older head, offers no Approve, and posts only once confirmed", async () => {
    const posted = { ...theirs, head: "9f00aaa11", draft: { id: 7, findings: 3, at: Date.now() }, next: next({ kind: "post", tone: "info", label: "AI review ready" }) };
    const { slot, view } = await prPage(posted, { submitReview: () => ({ pr: posted, placed: 2, inBody: 0 }) }, { draft: draft({ verdict: "approve" }) });
    const card = await find(await view(), "[data-draft]");
    expect(within(card).getByRole("alert").textContent).toContain("you can't approve from it");
    const verdicts = within(within(card).getByRole("radiogroup", { name: "Post as" })).getAllByRole("radio").map((radio) => radio.textContent);
    expect(verdicts).toEqual(["Comment", "Request changes"]);
    const post = within(card).getByRole("button", { name: /Post review/u }) as HTMLButtonElement;
    expect(post.disabled).toBe(true);
    fireEvent.click(within(card).getByRole("checkbox", { name: "Post it anyway" }));
    expect(post.disabled).toBe(false);
    fireEvent.click(post);
    await waitFor(() => expect(callsTo(slot, "submitReview")).toEqual([expect.objectContaining({ verdict: "comment", draftId: 7, staleOk: true })]));
  });

  it("discards a draft at once, and Undo restores it", async () => {
    const posted = { ...theirs, draft: { id: 7, findings: 3, at: Date.now() }, next: next({ kind: "post", tone: "info", label: "AI review ready" }) };
    const { slot, view } = await prPage(posted, {
      discardDraft: () => ({ pr: { ...posted, draft: null } }),
      restoreDraft: () => ({ pr: posted }),
    }, { draft: draft() });
    const panel = await view();
    const card = await find(panel, "[data-draft]");
    fireEvent.click(within(card).getByRole("button", { name: "Discard draft" }));
    await waitFor(() => expect(callsTo(slot, "discardDraft")).toEqual([{ key: theirs.key, draftId: 7 }]));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(1));
    expect(toasts.success.mock.calls[0]![0]).toBe("Discarded the draft. Nothing was posted.");
    toasts.success.mock.calls[0]![1].action.onClick();
    await waitFor(() => expect(callsTo(slot, "restoreDraft")).toEqual([{ key: theirs.key, draftId: 7 }]));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("The draft is back."));
  });

  it("comments, approves or requests changes from the composer", async () => {
    const { slot, view } = await prPage(theirs, {
      comment: () => ({ pr: theirs }),
      submitReview: () => ({ pr: theirs, placed: 0, inBody: 0 }),
    });
    const composer = await find(await view(), "[data-composer]");
    const box = within(composer).getByRole("textbox");
    fireEvent.change(box, { target: { value: "Nice." } });
    fireEvent.click(within(composer).getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(callsTo(slot, "comment")).toEqual([{ key: theirs.key, body: "Nice." }]));
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(""));
    fireEvent.click(within(within(composer).getByRole("radiogroup", { name: "Post as" })).getByRole("radio", { name: "Approve" }));
    fireEvent.change(box, { target: { value: "Ship it." } });
    fireEvent.click(within(composer).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(callsTo(slot, "submitReview")).toEqual([{ key: theirs.key, verdict: "approve", body: "Ship it.", findings: [] }]));
    expect(toasts.success.mock.calls.every(([, options]) => options === undefined)).toBe(true);
  });

  it("shows only what the server allows", async () => {
    const commentOnly = { ...theirs, can: { ...theirs.can, review: false, reply: false, resolve: false } };
    const { view } = await prPage(commentOnly, {}, { items: [item()] });
    const panel = await view();
    const composer = await find(panel, "[data-composer]");
    expect(within(composer).queryByRole("radiogroup")).toBeNull();
    await waitFor(() => expect(panel.querySelector("[data-item='c1']")).not.toBeNull());
    expect(within(panel).queryByRole("button", { name: "Reply" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(within(panel.querySelector<HTMLElement>("[data-your-review]")!).queryByRole("button", { name: "Approve…" })).toBeNull();
  });

  it("replies in a review thread", async () => {
    const { slot, view } = await prPage(theirs, { reply: () => ({ ok: true }) }, { items: [item()] });
    const entry = await find(await view(), "[data-item='c1']");
    fireEvent.click(within(entry).getByRole("button", { name: "Reply" }));
    fireEvent.change(within(entry).getByRole("textbox", { name: "Reply to alice-w" }), { target: { value: "Backed off in the next push." } });
    fireEvent.click(within(entry).getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(callsTo(slot, "reply")).toEqual([{ key: theirs.key, thread: "PRRT_1", body: "Backed off in the next push." }]));
    await waitFor(() => expect(within(entry).queryByRole("textbox")).toBeNull());
  });

  it("resolves a thread at once, and Undo reopens it", async () => {
    const { slot, view } = await prPage(theirs, { resolve: () => ({ ok: true }) }, { items: [item()] });
    const entry = await find(await view(), "[data-item='c1']");
    fireEvent.click(within(entry).getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(callsTo(slot, "resolve")).toEqual([{ key: theirs.key, thread: "PRRT_1", resolved: true }]));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(1));
    expect(toasts.success.mock.calls[0]![0]).toBe("Resolved the conversation.");
    toasts.success.mock.calls[0]![1].action.onClick();
    await waitFor(() => expect(callsTo(slot, "resolve")).toEqual([{ key: theirs.key, thread: "PRRT_1", resolved: true }, { key: theirs.key, thread: "PRRT_1", resolved: false }]));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Reopened the conversation."));
  });

  it("shows the conversation's error as a quiet note", async () => {
    const { view } = await prPage(theirs, {}, { error: "dt exited 1: rate limited" });
    const conversation = within(await view()).getByRole("region", { name: "Conversation" });
    await waitFor(() => expect(conversation.textContent).toContain("dt exited 1: rate limited"));
    expect(within(conversation).queryByRole("alert")).toBeNull();
  });

  it("re-reviews in the thread of the last review, and offers Approve…", async () => {
    const updated = {
      ...theirs, myReview: { verdict: "changes" as const, at: Date.now() - 2 * 24 * 60 * 60_000, head: "abc1234" },
      lastReview: { threadId: "thr_last", title: "Review shop/world#2311622", state: "done" as const, preset: "Standard review", trigger: "manual" as const, head: "abc1234", at: Date.now() },
      next: next({ kind: "rereview", tone: "warn", label: "Updated after your review", why: "3 commits and a reply from elvin since your review 2 days ago.", inbox: true, primary: { id: "review", label: "Re-review…" } }),
    };
    const { slot, view } = await prPage(updated, { review: () => ({ threadId: "thr_last", revived: false }), submitReview: () => ({ pr: updated, placed: 0, inBody: 0 }) });
    const card = await find(await view(), "[data-your-review]");
    expect(card.textContent).toContain("You requested changes 2d ago");
    expect(card.textContent).toContain("3 commits and a reply from elvin since your review 2 days ago.");
    fireEvent.click(within(card).getByRole("button", { name: "Re-review with AI" }));
    const dialog = await slot.findByRole("dialog", { name: "Re-review world#2311622" });
    expect(dialog.textContent).toContain("Goes to the same thread, “Review shop/world#2311622”");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Note for the reviewer" }), { target: { value: " Check that the fallback is fixed. " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(callsTo(slot, "review")).toEqual([{ key: theirs.key, presetId: "standard", threadId: "thr_last", note: "Check that the fallback is fixed." }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(within(card).getByRole("button", { name: "Approve…" }));
    const approve = await slot.findByRole("dialog", { name: "Approve world#2311622" });
    fireEvent.change(within(approve).getByRole("textbox", { name: "Optional comment" }), { target: { value: "Thanks for the fixes." } });
    fireEvent.click(within(approve).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(callsTo(slot, "submitReview")).toEqual([{ key: theirs.key, verdict: "approve", body: "Thanks for the fixes.", findings: [] }]));
  });

  it.each([
    { preset: "Standard review", presetId: "standard", text: "  Focus on filters.\nCheck the fallback too.  ", note: "Focus on filters.\nCheck the fallback too." },
    { preset: "Quick skim", presetId: "quick", text: " Focus on filters. ", note: "Focus on filters." },
    { preset: "Standard review", presetId: "standard", text: " \n ", note: undefined },
  ])("starts $preset with an optional reviewer note ($note)", async ({ preset, presetId, text, note }) => {
    const { slot, view } = await prPage(theirs, { review: () => ({ threadId: "thr_review", revived: false }) });
    fireEvent.click(within(await find(await view(), "[data-your-review]")).getByRole("button", { name: "Start AI review" }));
    const dialog = await slot.findByRole("dialog", { name: "Start an AI review of world#2311622" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Note for the reviewer" }), { target: { value: text } });
    fireEvent.click(within(dialog).getByRole("radio", { name: new RegExp(preset, "u") }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(callsTo(slot, "review")).toEqual([{ key: theirs.key, presetId, ...(note === undefined ? {} : { note }) }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("carries the reviewer note into the per-run review dialog and lets it be edited", async () => {
    const { slot, view } = await prPage(theirs, { review: () => ({ threadId: "thr_review", revived: false }) });
    fireEvent.click(within(await find(await view(), "[data-your-review]")).getByRole("button", { name: "Start AI review" }));
    const presets = await slot.findByRole("dialog");
    fireEvent.change(within(presets).getByRole("textbox", { name: "Note for the reviewer" }), { target: { value: " Focus on filters. " } });
    fireEvent.click(within(presets).getByRole("button", { name: "Change for this run…" }));
    const dialog = await slot.findByRole("dialog", { name: "Review shop/world#2311622" });
    const note = within(dialog).getByRole("textbox", { name: "Note for the reviewer" }) as HTMLTextAreaElement;
    expect(note.value).toBe(" Focus on filters. ");
    fireEvent.change(note, { target: { value: " Focus on filters and the fallback. " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start review" }));
    await waitFor(() => expect(callsTo(slot, "review")).toEqual([{ key: theirs.key, presetId: "standard", note: "Focus on filters and the fallback.", projectId: "prj_bb" }]));
  });

  it("opens the per-run review dialog from the preset dialog", async () => {
    const { slot, view } = await prPage(theirs, { review: () => ({ threadId: "thr_review", revived: false }) });
    fireEvent.click(within(await find(await view(), "[data-your-review]")).getByRole("button", { name: "Start AI review" }));
    fireEvent.click(within(await slot.findByRole("dialog")).getByRole("button", { name: "Change for this run…" }));
    const dialog = await slot.findByRole("dialog", { name: "Review shop/world#2311622" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Note for the reviewer" }), { target: { value: " focus on the fallback " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start review" }));
    await waitFor(() => expect(callsTo(slot, "review")).toEqual([{ key: theirs.key, presetId: "standard", note: "focus on the fallback", projectId: "prj_bb" }]));
  });

  it("sends the next review to its archived review thread, says so, and still offers a new thread", async () => {
    const back = { ...theirs, reviewThread: { threadId: "thr_old", title: "Review shop/world#2311622", archived: true } };
    const { slot, view } = await prPage(back, { review: () => ({ threadId: "thr_old", revived: true }) });
    fireEvent.click(within(await find(await view(), "[data-your-review]")).getByRole("button", { name: "Start AI review" }));
    const presets = await slot.findByRole("dialog");
    expect(presets.querySelector("[data-review-thread]")!.textContent).toBe("Goes to its review thread, \u201cReview shop/world#2311622\u201d, brought back from the archive.");
    fireEvent.click(within(presets).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(callsTo(slot, "review")).toEqual([{ key: theirs.key, presetId: "standard" }]));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Standard review started in its review thread, brought back from the archive. Its findings land on the PR.", expect.anything()));

    fireEvent.click(within(await find(await view(), "[data-your-review]")).getByRole("button", { name: "Start AI review" }));
    fireEvent.click(within(await slot.findByRole("dialog")).getByRole("button", { name: "Change for this run…" }));
    const dialog = await slot.findByRole("dialog", { name: "Review shop/world#2311622" });
    const select = within(dialog).getByRole("combobox", { name: "Thread" }) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(["Its review thread, \u201cReview shop/world#2311622\u201d (brought back from the archive)", "A new thread"]);
    expect(select.value).toBe("thr_old");
    fireEvent.change(select, { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start review" }));
    await waitFor(() => expect(callsTo(slot, "review")[1]).toEqual({ key: theirs.key, presetId: "standard", newThread: true, projectId: "prj_bb" }));
  });

  it("links a thread for reference from Threads", async () => {
    const { slot, view } = await prPage(theirs, {
      threads: () => ({ threads: [{ id: "thr_x", title: "Edge retry budget notes", projectId: "prj_bb", status: "idle", updatedAt: null }] }),
      link: ({ key, threadId, role }) => ({ pr: { ...theirs, key, links: [link({ threadId, role: role! })] } }),
    });
    fireEvent.click(within(within(await view()).getByRole("region", { name: "Threads" })).getByRole("button", { name: "Link a thread" }));
    const dialog = await slot.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("radio", { name: /Edge retry budget notes/u }));
    expect([...(within(dialog).getByRole("combobox", { name: "Role" }) as HTMLSelectElement).options].map((option) => option.value)).toEqual(["review", "reference"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Link" }));
    await waitFor(() => expect(callsTo(slot, "link")).toEqual([{ key: theirs.key, threadId: "thr_x", role: "reference" }]));
  });
});
