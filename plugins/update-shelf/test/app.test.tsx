import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Changelog, PendingUpdate, UpdateJob } from "../src/contract";
import { checkedAgo, UpdatesGroup, ordinal } from "../src/group";
import { IDLE_REFRESH_MS } from "../src/overlay";
import { renderInstalledPage } from "./dom";

const update = (id: string, name: string, extra: Partial<PendingUpdate> = {}): PendingUpdate => ({
  id,
  name,
  icon: "Puzzle",
  imageUrl: null,
  installed: { version: `${id}-old`, label: "0.1.0" },
  candidate: { version: `${id}-new`, label: "0.2.0" },
  updateAvailable: true,
  lastFailure: null,
  job: null,
  ...extra,
});

const job = (state: UpdateJob["state"], extra: Partial<UpdateJob> = {}): UpdateJob => ({
  id: `job-${state}-${Math.random()}`,
  state,
  phase: null,
  queuePosition: null,
  outcome: null,
  error: null,
  ...extra,
});

const CHANGELOG: Changelog = {
  toVersion: "0.2.0",
  notes: [{ version: "0.2.0", title: "0.2.0 (2026-10-28)", body: "- Trusted file directories." }],
  commits: [],
  moreCommits: 0,
  commitsCapped: false,
  changelogError: null,
  commitsError: null,
  compareUrl: "https://github.com/o/r/compare/a...b",
  unavailable: null,
};

beforeEach(() => {
  window.history.replaceState(null, "", "/plugins?view=installed");
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

async function mountOverlay(updates: PendingUpdate[]) {
  const app = await loadPluginApp(() => import("../app"));
  renderInstalledPage();
  const calls: Array<{ method: string; input: unknown }> = [];
  const slot = renderSlot(
    app.appOverlays[0]!,
    {},
    {
      pluginId: "update-shelf",
      rpc: {
        list: () => {
          calls.push({ method: "list", input: null });
          return { updates };
        },
        changelog: (input: unknown) => {
          calls.push({ method: "changelog", input });
          return CHANGELOG;
        },
        update: (input: unknown) => {
          calls.push({ method: "update", input });
          return { started: (input as { ids: string[] }).ids, failed: [] };
        },
      },
    },
  );
  const group = await screen.findByRole("region", { name: "Plugin updates" });
  return { slot, calls, group };
}

/** The group alone, for states the overlay reaches only after bb has moved a job along. */
async function renderGroup(updates: PendingUpdate[], props: Partial<Parameters<typeof UpdatesGroup>[0]> = {}) {
  await loadPluginApp(() => import("../app"));
  const onUpdate = vi.fn();
  const onClear = vi.fn();
  const view = render(
    <UpdatesGroup
      updates={updates}
      starting={new Set()}
      dismissed={new Set()}
      onUpdate={onUpdate}
      onClear={onClear}
      loadChangelog={async () => CHANGELOG}
      {...props}
    />,
  );
  return { ...view, group: screen.getByRole("region", { name: "Plugin updates" }), onUpdate, onClear };
}

describe("plugin app", () => {
  it("registers one app overlay and nothing else", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.appOverlays.map((overlay) => overlay.id)).toEqual(["installed-updates"]);
    expect(app.navPanels).toHaveLength(0);
    expect(app.contentScripts).toHaveLength(0);
  });

  it("groups the waiting updates above the Installed page's cards", async () => {
    const { group, slot } = await mountOverlay([update("burn", "Burn"), update("genui", "Generative UI")]);
    expect(within(group).getByText("2 plugins have updates")).toBeTruthy();
    expect(within(group).getByText("Generative UI")).toBeTruthy();
    expect(within(group).getAllByText("0.1.0 → 0.2.0")).toHaveLength(2);
    const host = group.closest("[data-update-shelf]")!;
    expect(host.nextElementSibling?.querySelector('[data-testid="plugin-row-genui"]')).not.toBeNull();
    slot.lifecycle.unmount();
  });

  it("updates one plugin from its row", async () => {
    const { group, calls, slot } = await mountOverlay([update("burn", "Burn"), update("genui", "Generative UI")]);
    fireEvent.click(within(group).getByRole("button", { name: "Update Generative UI to 0.2.0" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "update")).toEqual([{ method: "update", input: { ids: ["genui"] } }]));
    slot.lifecycle.unmount();
  });

  it("asks once before updating every plugin", async () => {
    const { group, calls, slot } = await mountOverlay([update("burn", "Burn"), update("genui", "Generative UI")]);
    fireEvent.click(within(group).getByRole("button", { name: "Update all" }));
    expect(within(group).getByText("Update 2 plugins?")).toBeTruthy();
    expect(calls.some((call) => call.method === "update")).toBe(false);
    fireEvent.click(within(group).getByRole("button", { name: "Update all" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "update")).toEqual([{ method: "update", input: { ids: ["burn", "genui"] } }]));
    slot.lifecycle.unmount();
  });

  it("reads the changelog only when asked, and shows its entries", async () => {
    const { group, calls, slot } = await mountOverlay([update("genui", "Generative UI")]);
    expect(calls.some((call) => call.method === "changelog")).toBe(false);
    fireEvent.click(within(group).getByRole("button", { name: /What’s new/u }));
    expect(await within(group).findByText("0.2.0 (2026-10-28)")).toBeTruthy();
    expect(calls.filter((call) => call.method === "changelog")).toEqual([{ method: "changelog", input: { id: "genui" } }]);
    expect(within(group).getByRole("link", { name: /View on GitHub/u }).getAttribute("href")).toBe(CHANGELOG.compareUrl);
    slot.lifecycle.unmount();
  });

  it("says the page was read when no plugin has an update or a recent one", async () => {
    const app = await loadPluginApp(() => import("../app"));
    renderInstalledPage();
    const slot = renderSlot(app.appOverlays[0]!, {}, { pluginId: "update-shelf", rpc: { list: () => ({ updates: [] }) } });
    await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
    const group = await screen.findByRole("region", { name: "Plugin updates" });
    expect(within(group).getByText("No plugin has an update waiting")).toBeTruthy();
    expect(within(group).getByText("checked just now")).toBeTruthy();
    expect(group.querySelectorAll("li")).toHaveLength(0);
    slot.lifecycle.unmount();
  });

  it("draws placeholders until the first read answers, and none when it answers at once", async () => {
    const app = await loadPluginApp(() => import("../app"));
    renderInstalledPage();
    const slot = renderSlot(app.appOverlays[0]!, {}, { pluginId: "update-shelf", rpc: { list: () => new Promise(() => {}) } });
    expect(screen.queryByRole("region", { name: "Checking for plugin updates" })).toBeNull();
    const skeleton = await screen.findByRole("region", { name: "Checking for plugin updates" });
    expect(skeleton.getAttribute("aria-busy")).toBe("true");
    expect(within(skeleton).getByText("Checking plugins for updates…")).toBeTruthy();
    expect(skeleton.querySelectorAll("li")).toHaveLength(3);
    slot.lifecycle.unmount();
  });

  it("waits for each read to answer before the next, so a busy server never gets overlapping reads", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const app = await loadPluginApp(() => import("../app"));
    renderInstalledPage();
    let answer: (value: { updates: PendingUpdate[] }) => void = () => {};
    let reads = 0;
    const slot = renderSlot(
      app.appOverlays[0]!,
      {},
      {
        pluginId: "update-shelf",
        rpc: {
          list: () => {
            reads += 1;
            return new Promise((resolve) => {
              answer = resolve;
            });
          },
        },
      },
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(IDLE_REFRESH_MS * 3);
    expect(reads).toBe(1);
    await act(async () => answer({ updates: [update("genui", "Generative UI")] }));
    await vi.advanceTimersByTimeAsync(IDLE_REFRESH_MS + 500);
    expect(reads).toBe(2);
    slot.lifecycle.unmount();
  });
});

describe("feedback while it reads", () => {
  it("says when the page was last read, and that a read is out now", async () => {
    await loadPluginApp(() => import("../app"));
    const at = 1_000_000;
    const props = { updates: [update("genui", "Generative UI")], starting: new Set<string>(), dismissed: new Set<string>(), onUpdate: () => {}, onClear: () => {}, loadChangelog: async () => CHANGELOG };
    const view = render(<UpdatesGroup {...props} checkedAt={at - 12_000} now={() => at} />);
    expect(screen.getByText("checked 12 s ago")).toBeTruthy();
    view.rerender(<UpdatesGroup {...props} checking checkedAt={at} now={() => at} />);
    expect(await screen.findByText("Checking…")).toBeTruthy();
  });

  it("says how long ago it checked", () => {
    expect([0, 1_500, 12_400, 60_000, 185_000, 7_200_000].map(checkedAgo)).toEqual([
      "checked just now",
      "checked just now",
      "checked 12 s ago",
      "checked 1 min ago",
      "checked 3 min ago",
      "checked 2 h ago",
    ]);
  });
});

describe("update progress", () => {
  it("shows the batch's progress, the running phase with its time, and each queued update's place", async () => {
    let now = 1_000_000;
    const { group } = await renderGroup(
      [
        update("pi-minions", "Minions", { updateAvailable: false, job: job("running", { id: "j2", phase: "checking" }) }),
        update("pr-desk", "PR Desk", { job: job("queued", { queuePosition: 1 }) }),
        update("world-tree", "World tree", { job: job("queued", { queuePosition: 2 }) }),
        update("genui", "Generative UI", { updateAvailable: false, job: job("completed", { outcome: "updated" }) }),
      ],
      { now: () => now },
    );
    expect(within(group).getByText("Updating plugins · 1 of 4 done")).toBeTruthy();
    expect(within(group).getByRole("progressbar", { name: "Plugins updated" }).getAttribute("aria-valuenow")).toBe("1");
    expect(within(group).getByText(/watches it for 30 seconds/u)).toBeTruthy();
    const row = (id: string) => group.querySelector<HTMLElement>(`li[data-plugin-update="${id}"]`)!;
    expect(within(row("pi-minions")).getByRole("status").textContent).toBe("Checking the new version · 0 of 30 s");
    expect(within(row("pr-desk")).getByRole("status").textContent).toBe("Queued · next");
    expect(within(row("world-tree")).getByRole("status").textContent).toBe("Queued · 2nd in line");
    expect(within(row("genui")).getByRole("status").textContent).toBe("Updated");
    expect(within(row("pr-desk")).queryByRole("button", { name: /^Update /u })).toBeNull();

    now += 12_000;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    });
    expect(within(row("pi-minions")).getByRole("status").textContent).toBe("Checking the new version · 12 of 30 s");
  });

  it("leaves queued and running updates out of Update all", async () => {
    const { group, onUpdate } = await renderGroup([
      update("burn", "Burn", { job: job("running", { phase: "preparing" }) }),
      update("calm", "Calm"),
      update("genui", "Generative UI"),
    ]);
    fireEvent.click(within(group).getByRole("button", { name: "Update all" }));
    fireEvent.click(within(group).getByRole("button", { name: "Update all" }));
    expect(onUpdate).toHaveBeenCalledWith(["calm", "genui"]);
  });

  it("offers a retry with the reason after a failed or rolled-back update", async () => {
    const { group } = await renderGroup([
      update("genui", "Generative UI", { job: job("failed", { error: "npm install failed" }) }),
      update("calm", "Calm", { job: job("completed", { outcome: "rolled-back", error: "plugin failed to load" }) }),
    ]);
    expect(within(group).getByText("npm install failed")).toBeTruthy();
    expect(within(group).getByText("plugin failed to load")).toBeTruthy();
    expect(within(group).getByRole("button", { name: "Retry updating Generative UI to 0.2.0" })).toBeTruthy();
    expect(within(group).getByRole("button", { name: "Retry updating Calm to 0.2.0" })).toBeTruthy();
  });

  it("clears finished updates when asked, and hides the ones already cleared", async () => {
    const done = job("completed", { id: "j9", outcome: "updated" });
    const { group, onClear, rerender } = await renderGroup([update("genui", "Generative UI", { updateAvailable: false, job: done })]);
    expect(within(group).getByText("Recently updated")).toBeTruthy();
    fireEvent.click(within(group).getByRole("button", { name: "Clear finished" }));
    expect(onClear).toHaveBeenCalledWith(["j9"]);
    rerender(
      <UpdatesGroup
        updates={[update("genui", "Generative UI", { updateAvailable: false, job: done })]}
        starting={new Set()}
        dismissed={new Set(["j9"])}
        onUpdate={() => {}}
        onClear={() => {}}
        loadChangelog={async () => CHANGELOG}
      />,
    );
    const empty = screen.getByRole("region", { name: "Plugin updates" });
    expect(within(empty).getByText("No plugin has an update waiting")).toBeTruthy();
  });

  it("reads the changelog again when bb offers a newer version while it is open", async () => {
    // Review finding: an open What's new kept the first candidate's notes after bb found a newer release.
    await loadPluginApp(() => import("../app"));
    const load = vi.fn(async () => CHANGELOG);
    let setUpdates: (updates: PendingUpdate[]) => void = () => {};
    function Harness() {
      const [updates, set] = useState<PendingUpdate[]>([update("genui", "Generative UI")]);
      setUpdates = set;
      return (
        <UpdatesGroup updates={updates} starting={new Set()} dismissed={new Set()} onUpdate={() => {}} onClear={() => {}} loadChangelog={load} />
      );
    }
    const slot = renderSlot({ component: Harness }, {}, { pluginId: "update-shelf" });
    fireEvent.click(screen.getByRole("button", { name: /What’s new/u }));
    await screen.findByText("0.2.0 (2026-10-28)");
    expect(load).toHaveBeenCalledTimes(1);
    act(() => setUpdates([update("genui", "Generative UI", { candidate: { version: "genui-newer", label: "0.3.0" } })]));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: /What’s new/u }).getAttribute("aria-expanded")).toBe("true");
    slot.lifecycle.unmount();
  });

  it("offers Try again when part of the changelog couldn't be read", async () => {
    await loadPluginApp(() => import("../app"));
    const partial: Changelog = { ...CHANGELOG, notes: [], commits: [{ sha: "c".repeat(40), title: "Fix it", url: "https://github.com/o/r/commit/c" }], changelogError: "rate limited" };
    const load = vi.fn(async () => partial);
    const slot = renderSlot(
      {
        component: () => (
          <UpdatesGroup updates={[update("genui", "Generative UI")]} starting={new Set()} dismissed={new Set()} onUpdate={() => {}} onClear={() => {}} loadChangelog={load} />
        ),
      },
      {},
      { pluginId: "update-shelf" },
    );
    fireEvent.click(screen.getByRole("button", { name: /What’s new/u }));
    expect(await screen.findByText(/Couldn’t read the changelog: rate limited Commits that changed this plugin:/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    slot.lifecycle.unmount();
  });

  it("says where each update is in line", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual([
      "next",
      "2nd in line",
      "3rd in line",
      "4th in line",
      "11th in line",
      "12th in line",
      "13th in line",
      "21st in line",
      "22nd in line",
    ]);
  });
});
