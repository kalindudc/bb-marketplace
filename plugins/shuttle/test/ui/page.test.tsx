import { formatRoute } from "../../src/ui/route";
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { app, callsTo, event, handlers, link, mount, pr, unmountAll, type Handlers } from "./helpers";

afterEach(unmountAll);

const first = pr();
const second = pr({ repo: "Shopify/spy-v2", number: 88, title: "Add per-route sampling to the tracer", author: "mia-r", reasons: [{ reason: "team", teams: ["@Shopify/edge-routing"] }] });

async function page(subPath: string, rpc: Partial<Handlers> = {}) {
  const loaded = await app();
  const panel = loaded.navPanels[0]!;
  return mount<PluginNavPanelProps>(panel.component, { subPath }, handlers({
    list: () => ({ prs: [first, second] }),
    detail: ({ key }) => ({ pr: [first, second].find((item) => item.key === key)!, events: [] }),
    ...rpc,
  }));
}

const row = (slot: Awaited<ReturnType<typeof page>>, key: string) => slot.container.querySelector<HTMLElement>(`[data-pr="${key}"]`)!;

describe("Shuttle page", () => {
  it("lists the PRs of the section in its path and selects the one clicked", async () => {
    const slot = await page("requested");
    await slot.findByText(second.title);
    expect(callsTo(slot, "list")).toEqual([{ section: "requested" }]);
    expect(slot.getByRole("heading", { name: "Requested of me" })).toBeTruthy();
    expect(row(slot, first.key).textContent).toContain("get-bb/bb#4411");
    expect(row(slot, second.key).textContent).toContain("@Shopify/edge-routing");
    expect(slot.container.querySelector("[data-detail]")).toBeNull();
    fireEvent.click(row(slot, second.key));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toPluginPanel", path: "shuttle", options: { subPath: formatRoute({ view: "section", section: "requested", key: second.key }), replace: true } },
    ]);
  });

  it("opens the PR its path selects in the drawer, and closes it back to the section", async () => {
    const slot = await page(formatRoute({ view: "section", section: "requested", key: second.key }));
    await waitFor(() => expect(slot.container.querySelector(`[data-detail="${second.key}"]`)).not.toBeNull());
    expect(row(slot, second.key).getAttribute("aria-current")).toBe("true");
    expect(callsTo(slot, "detail")).toEqual([{ key: second.key }]);
    fireEvent.click(slot.getByRole("button", { name: "Close details" }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "shuttle", options: { subPath: "requested", replace: true } }]);
  });

  it("keeps the section nav out of the page: bb's sidebar holds it", async () => {
    const slot = await page("requested");
    await slot.findByText(first.title);
    expect(slot.queryByRole("navigation")).toBeNull();
  });

  it("filters by server and text", async () => {
    const delta = pr({ server: "delta", serverName: "Delta", repo: "shop/world", number: 2261179, title: "routing-events: cut Envoy CPU per request" });
    const slot = await page("requested", { list: () => ({ prs: [first, delta] }) });
    await slot.findByText(delta.title);
    fireEvent.click(slot.getByRole("button", { name: "Delta" }));
    expect(slot.queryByText(first.title)).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "All servers" }));
    fireEvent.change(slot.getByRole("textbox", { name: "Filter" }), { target: { value: "compact" } });
    expect(slot.queryByText(delta.title)).toBeNull();
    expect(slot.getAllByText(first.title).length).toBeGreaterThan(0);
  });

  it("shows every linked thread in the drawer with its role, and unlinks one", async () => {
    let linked = pr({
      links: [
        link({ threadId: "thr_a", title: "Autoresearch study: routing-events", role: "owner" }),
        link({ threadId: "thr_b", title: "PR Review #4411", role: "review" }),
        link({ threadId: "thr_c", title: "Old notes", role: "reference", archived: true }),
      ],
    });
    const slot = await page(formatRoute({ view: "section", section: "requested", key: linked.key }), {
      list: () => ({ prs: [linked] }),
      detail: () => ({ pr: linked, events: [event({ text: "tomas approved", threadId: "thr_a" })] }),
      unlink: ({ threadId }) => {
        linked = { ...linked, links: linked.links.filter((item) => item.threadId !== threadId) };
        return { pr: linked };
      },
    });
    const drawer = await waitFor(() => {
      const found = slot.container.querySelector<HTMLElement>(`[data-detail="${linked.key}"]`);
      if (found === null) throw new Error("no drawer yet");
      return found;
    });
    const links = [...drawer.querySelectorAll<HTMLElement>("[data-link]")];
    expect(links.map((item) => item.getAttribute("data-link"))).toEqual(["thr_a", "thr_b", "thr_c"]);
    expect((within(links[0]!).getByRole("combobox") as HTMLSelectElement).value).toBe("owner");
    expect((within(links[1]!).getByRole("combobox") as HTMLSelectElement).value).toBe("review");
    expect(links[2]!.textContent).toContain("(archived)");
    expect(within(drawer).getByText("tomas approved")).toBeTruthy();

    fireEvent.click(within(drawer).getByRole("button", { name: "PR Review #4411" }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_b" });

    fireEvent.click(within(drawer).getByRole("button", { name: "Unlink “PR Review #4411”" }));
    await waitFor(() => expect(drawer.querySelectorAll("[data-link]")).toHaveLength(2));
    expect(callsTo(slot, "unlink")).toEqual([{ key: linked.key, threadId: "thr_b" }]);
  });

  it("starts a review with the chosen preset and this run's overrides", async () => {
    const slot = await page("requested", { review: () => ({ threadId: "thr_review" }) });
    await slot.findByText(first.title);
    fireEvent.click(within(row(slot, first.key)).getByRole("button", { name: /Pick a preset/u }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Customize this run…" }));
    const dialog = await slot.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: /Standard review/u }));
    fireEvent.click(within(dialog).getByText("Change this run only"));
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Skill" }), { target: { value: "critique" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Model" }), { target: { value: "openai/gpt-5.2" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reasoning level" }), { target: { value: "xhigh" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply execution selection" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Note for the reviewer" }), { target: { value: "  focus on the SDK types " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start review" }));

    await waitFor(() => expect(callsTo(slot, "review")).toHaveLength(1));
    expect(callsTo(slot, "review")[0]).toEqual({
      key: first.key,
      presetId: "standard",
      skill: "critique",
      providerId: "pi",
      model: "openai/gpt-5.2",
      reasoningLevel: "xhigh",
      note: "focus on the SDK types",
      projectId: "prj_bb",
    });
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  });

  it("sends a review to a thread the PR is already linked to", async () => {
    const linked = pr({ links: [link({ threadId: "thr_a", title: "Owner thread", role: "owner" }), link({ threadId: "thr_b", title: "Second review", role: "review" })] });
    const slot = await page("requested", { list: () => ({ prs: [linked] }), detail: () => ({ pr: linked, events: [] }), review: () => ({ threadId: "thr_b" }) });
    await slot.findAllByText(linked.title);
    fireEvent.click(within(row(slot, linked.key)).getByRole("button", { name: /Pick a preset/u }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Customize this run…" }));
    const dialog = await slot.findByRole("dialog");
    const thread = within(dialog).getByRole("combobox", { name: "Thread" }) as HTMLSelectElement;
    expect([...thread.options].map((option) => option.textContent)).toEqual(["A new thread", "Reuse “Owner thread”", "Reuse “Second review”"]);
    fireEvent.change(thread, { target: { value: "thr_b" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start review" }));
    await waitFor(() => expect(callsTo(slot, "review")).toEqual([{ key: linked.key, presetId: "standard", threadId: "thr_b" }]));
  });

  it("changes how a watched PR's reviews arrive, and dismisses its Needs you entry", async () => {
    let watched = pr({ watch: "act", needs: "Auto review finished: choose what to post", links: [link({ role: "owner" })] });
    const slot = await page(formatRoute({ view: "section", section: "needs", key: watched.key }), {
      list: () => ({ prs: [watched] }),
      detail: () => ({ pr: watched, events: [] }),
      watch: ({ mode }) => {
        watched = { ...watched, watch: mode };
        return { pr: watched };
      },
      dismiss: () => {
        watched = { ...watched, needs: null };
        return { pr: watched };
      },
    });
    const drawer = await waitFor(() => slot.container.querySelector<HTMLElement>(`[data-detail="${watched.key}"]`) ?? Promise.reject(new Error("no drawer")));
    const mode = within(drawer).getByRole("combobox", { name: "When a review arrives" }) as HTMLSelectElement;
    fireEvent.change(mode, { target: { value: "forward" } });
    expect(mode.value).toBe("forward");
    await waitFor(() => expect(callsTo(slot, "watch")).toEqual([{ key: watched.key, mode: "forward" }]));
    fireEvent.click(within(drawer).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(drawer.querySelector("[data-needs]")).toBeNull());
    expect(callsTo(slot, "dismiss")).toEqual([{ key: watched.key }]);
  });

  it("runs a preset straight from the Review menu, with no overrides", async () => {
    const slot = await page("requested", { review: () => ({ threadId: "thr_review" }) });
    await slot.findByText(first.title);
    fireEvent.click(within(row(slot, first.key)).getByRole("button", { name: /Pick a preset/u }));
    fireEvent.click(slot.getByRole("menuitem", { name: /Quick skim/u }));
    await waitFor(() => expect(callsTo(slot, "review")).toEqual([{ key: first.key, presetId: "quick" }]));
  });

  it("links a PR to an existing thread with the chosen role", async () => {
    const slot = await page("requested", {
      threads: ({ query }) => ({
        threads: [
          { id: "thr_x", title: "Edge retry budget notes", projectId: "prj_bb", status: "idle", updatedAt: null },
          { id: "thr_y", title: "Loom ticket page", projectId: null, status: "idle", updatedAt: null },
        ].filter((thread) => query === undefined || thread.title.toLowerCase().includes(query.toLowerCase())),
      }),
      link: ({ key, threadId, role }) => ({ pr: { ...first, key, links: [link({ threadId, role: role! })] } }),
    });
    await slot.findByText(first.title);
    fireEvent.click(within(row(slot, first.key)).getByRole("button", { name: "Thread" }));
    const dialog = await slot.findByRole("dialog");
    await within(dialog).findByText("Edge retry budget notes");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Search threads" }), { target: { value: "loom" } });
    await waitFor(() => expect(callsTo(slot, "threads")).toContainEqual({ query: "loom" }));
    await waitFor(() => expect(within(dialog).queryByText("Edge retry budget notes")).toBeNull());
    fireEvent.click(await within(dialog).findByRole("radio", { name: /Loom ticket page/u }));
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Role" }), { target: { value: "reference" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Link" }));
    await waitFor(() => expect(callsTo(slot, "link")).toEqual([{ key: first.key, threadId: "thr_y", role: "reference" }]));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  });

  it("asks for an owner thread before watching a PR that has none, then watches it", async () => {
    const slot = await page("requested", {
      threads: () => ({ threads: [{ id: "thr_x", title: "Edge retry budget notes", projectId: null, status: "idle", updatedAt: null }] }),
      link: ({ key, threadId, role }) => ({ pr: { ...first, key, links: [link({ threadId, role: role! })] } }),
      watch: ({ mode }) => ({ pr: { ...first, watch: mode } }),
    });
    await slot.findByText(first.title);
    fireEvent.click(within(row(slot, first.key)).getByRole("button", { name: "Watch" }));
    const dialog = await slot.findByRole("dialog");
    expect(callsTo(slot, "watch")).toEqual([]);
    fireEvent.click(await within(dialog).findByRole("radio", { name: /Edge retry budget notes/u }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Link" }));
    await waitFor(() => expect(callsTo(slot, "watch")).toEqual([{ key: first.key, mode: "act" }]));
    expect(callsTo(slot, "link")).toEqual([{ key: first.key, threadId: "thr_x", role: "owner" }]);
  });

  it("starts a new thread for a PR from the drawer", async () => {
    const slot = await page(formatRoute({ view: "section", section: "requested", key: first.key }), { newThread: () => ({ threadId: "thr_new" }) });
    await waitFor(() => expect(slot.container.querySelector(`[data-detail="${first.key}"]`)).not.toBeNull());
    fireEvent.click(slot.getByRole("button", { name: "New thread" }));
    const dialog = await slot.findByRole("dialog");
    await waitFor(() => expect((within(dialog).getByRole("combobox", { name: "Project" }) as HTMLSelectElement).value).toBe("prj_bb"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Start thread" }));
    await waitFor(() => expect(callsTo(slot, "newThread")).toEqual([{ key: first.key, start: "review", projectId: "prj_bb" }]));
  });

  it("shows a looked-up PR from its path", async () => {
    const slot = await page(formatRoute({ view: "pr", key: second.key }));
    expect(await slot.findByRole("heading", { name: "Look up" })).toBeTruthy();
    await waitFor(() => expect(slot.container.querySelector(`[data-detail="${second.key}"]`)).not.toBeNull());
    expect(callsTo(slot, "list")).toEqual([]);
  });

  it("shows the server's refusal when a list fails to load", async () => {
    const slot = await page("team", { list: () => { throw new Error("gh: not logged in"); } });
    expect((await slot.findByRole("alert")).textContent).toContain("gh: not logged in");
  });

  it("refetches when the server invalidates its PR reads, as after a background sync", async () => {
    const slot = await page("requested");
    await slot.findByText(first.title);
    const before = callsTo(slot, "list").length;
    await slot.behavior.experimental_invalidateRpc(["prs"], "shuttle");
    await waitFor(() => expect(callsTo(slot, "list").length).toBeGreaterThan(before));
  });

  it("fetches a looked-up PR the server does not know yet when asked", async () => {
    let known = false;
    const slot = await page(formatRoute({ view: "pr", key: second.key }), {
      detail: ({ key }) => {
        if (!known) throw Object.assign(new Error(`no pull request ${key}`), { code: "not_found" });
        return { pr: second, events: [] };
      },
      lookup: () => {
        known = true;
        return { pr: second };
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Fetch it from its server" }));
    await waitFor(() => expect(slot.container.querySelector(`[data-detail="${second.key}"]`)).not.toBeNull());
    expect(callsTo(slot, "lookup")).toEqual([{ query: second.key }]);
  });
});
