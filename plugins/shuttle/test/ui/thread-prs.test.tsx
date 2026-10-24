import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { experimental_THREAD_INFO_SECTION_GROUPS, type ExperimentalThreadContextSegmentProps, type ExperimentalThreadInfoProps } from "@get-bb/plugin-sdk/app";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract, type PrView } from "../../src/contract";
import { agent, app, callsTo, handlers, link, mount, pr, unmountAll } from "./helpers";

afterEach(unmountAll);

const THREAD = "thr_1";
const SHUTTLE_TAB_OPEN = { surface: { kind: "current" }, tab: { id: "shuttle", context: { kind: "thread" }, availability: "action" }, params: { threadId: THREAD } };

const owned = pr({ number: 4411, mine: true, reasons: [], links: [link({ threadId: THREAD, role: "owner" })], agent: agent({ threadId: THREAD }), watch: "act" });
const failing = pr({ repo: "get-bb/bb", number: 4412, mine: true, reasons: [], checks: "failed", links: [link({ threadId: THREAD, role: "owner" })] });
const changes = pr({ repo: "get-bb/bb", number: 4413, mine: true, reasons: [], review: "changes", links: [link({ threadId: THREAD, role: "owner" })] });
const unsent = pr({ repo: "get-bb/bb", number: 4414, mine: true, reasons: [], pendingItems: 2, links: [link({ threadId: THREAD, role: "owner" })] });

describe("the thread Info tab's Pull requests", () => {
  async function info(prs: PrView[]) {
    const loaded = await app();
    const registration = loaded.threadInfoSections[0]!;
    expect(registration).toMatchObject({ id: "pull-requests", group: experimental_THREAD_INFO_SECTION_GROUPS.related });
    return mount<ExperimentalThreadInfoProps>(registration.component, { threadId: THREAD, projectId: "prj_bb", environment: null }, handlers({ threadPrs: () => ({ prs, sent: [] }) }));
  }

  it("lists every PR linked to the thread, with state and checks, and opens the Shuttle tab", async () => {
    const slot = await info([owned, failing]);
    const section = await slot.findByRole("region", { name: "Pull requests" });
    expect(within(section).getByRole("heading").textContent).toBe("Pull requests2");
    const rows = within(section).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("button")!.textContent)).toEqual(["get-bb/bb#4411", "get-bb/bb#4412"]);
    expect(rows[0]!.textContent).toContain("open");
    expect(rows[0]!.querySelector("[data-icon='Check']")).not.toBeNull();
    expect(rows[0]!.querySelector("[data-icon='Bot']")!.getAttribute("aria-label")).toBe("This thread is the agent");
    expect(rows[1]!.querySelector("[data-icon='Bot']")).toBeNull();
    expect(rows[1]!.textContent).toContain("open · checks failing");
    expect(rows[1]!.querySelector("[data-icon='X']")).not.toBeNull();
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "get-bb/bb#4412" }));
    expect(slot.inspection.experimental_tabOpenCalls).toEqual([SHUTTLE_TAB_OPEN]);
  });

  it("shows nothing when no PR is linked", async () => {
    const slot = await info([]);
    await waitFor(() => expect(callsTo(slot, "threadPrs")).toEqual([{ threadId: THREAD }]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(slot.container.innerHTML).toBe("");
  });
});

describe("the context segment beside the composer", () => {
  const props: ExperimentalThreadContextSegmentProps = {
    threadId: THREAD, projectId: "prj_bb", environment: null, segments: [{ key: "shuttle/pull-requests", pluginId: "shuttle" }], isExpanded: false, onToggle: () => {},
  };

  async function segment() {
    const loaded = await app();
    const registration = loaded.threadContextSegments[0]!;
    expect(registration).toMatchObject({ id: "pull-requests", group: "2_pullRequest" });
    expect(loaded.threadHeaderActions).toEqual([]);
    return registration;
  }
  async function summary(prs: PrView[]) {
    const registration = await segment();
    const slot = mount<ExperimentalThreadContextSegmentProps>(registration.summary, props, handlers({ threadPrs: () => ({ prs, sent: [] }) }));
    await waitFor(() => expect(callsTo(slot, "threadPrs")).toHaveLength(1));
    return slot;
  }

  it("shows one PR's key and state", async () => {
    const slot = await summary([owned]);
    const button = await slot.findByRole("button", { name: "Shuttle: get-bb/bb#4411, open" });
    expect(button.textContent).toBe("get-bb/bb#4411·open");
    expect(button.querySelector("[data-icon='shuttle/shuttle']")).not.toBeNull();
  });

  it("shows how many PRs and the worst state among them", async () => {
    const several = await summary([owned, unsent, failing, changes]);
    expect((await several.findByRole("button", { name: /^Shuttle: 4 linked PRs/u })).textContent).toBe("4 PRs·changes requested");
    several.lifecycle.unmount();
    const fine = await summary([owned, unsent, failing]);
    expect((await fine.findByRole("button", { name: /^Shuttle: 3 linked PRs/u })).textContent).toBe("3 PRs·checks failing");
    fine.lifecycle.unmount();
    const quiet = await summary([owned, pr({ number: 9, links: [link({ threadId: THREAD })] })]);
    expect((await quiet.findByRole("button", { name: /^Shuttle: 2 linked PRs/u })).textContent).toBe("2 PRs");
  });

  it("is visible only while the thread has a linked PR", async () => {
    const registration = await segment();
    const Probe = ({ threadId }: { threadId: string }) => <span>{registration.useVisible!({ threadId, projectId: "prj_bb", environment: null }) ? "visible" : "hidden"}</span>;
    let prs: PrView[] = [];
    const slot = renderSlot({ component: Probe }, { threadId: THREAD }, {
      pluginId: "shuttle", experimental_rpcContract: rpcContract, rpc: handlers({ threadPrs: () => ({ prs, sent: [] }) }),
    });
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    expect(slot.container.textContent).toBe("hidden");
    prs = [owned];
    await slot.behavior.experimental_invalidateRpc(["prs"], "shuttle");
    await slot.findByText("visible");
    slot.lifecycle.unmount();
  });

  it("lists each PR in its details and opens the Shuttle tab from them and from its action", async () => {
    const registration = await segment();
    const details = mount<ExperimentalThreadContextSegmentProps>(registration.details!, { ...props, isExpanded: true }, handlers({ threadPrs: () => ({ prs: [owned, changes], sent: [] }) }));
    const rows = await waitFor(() => {
      const found = [...details.container.querySelectorAll<HTMLElement>("[data-pr]")];
      if (found.length !== 2) throw new Error("no rows yet");
      return found;
    });
    expect(rows[1]!.textContent).toContain("changes requested");
    fireEvent.click(within(rows[0]!).getByRole("button"));
    expect(details.inspection.experimental_tabOpenCalls).toEqual([SHUTTLE_TAB_OPEN]);

    const action = mount<ExperimentalThreadContextSegmentProps>(registration.action!, props, handlers());
    fireEvent.click(action.getByRole("button", { name: "Open the Shuttle tab" }));
    expect(action.inspection.experimental_tabOpenCalls).toEqual([SHUTTLE_TAB_OPEN]);
  });
});
