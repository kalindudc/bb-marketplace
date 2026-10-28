import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { pullRequestContract, usePullRequest, type PullRequest } from "../src/pull-request";

export const pullRequest: PullRequest = { number: 12, title: "Card", url: "https://example.com/12", state: "open",
  checks: { state: "passing" }, review: { state: "approved" } };

type ViewProps = { environmentId?: string | null; copies?: number };
afterEach(cleanup);

function View({ environmentId, copies = 1 }: ViewProps) {
  return <>{Array.from({ length: copies }, (_, index) => <Reader key={index} environmentId={environmentId} />)}</>;
}
function Reader({ environmentId }: { environmentId?: string | null }) {
  const pr = usePullRequest(environmentId);
  return <output>{pr ? `#${pr.number} ${pr.state} ${pr.checks.state} ${pr.review.state}` : "No PR data"}</output>;
}
type Result = { outcome: "available"; pullRequest: PullRequest } | { outcome: "absent" } | { outcome: "unavailable"; message: string };
const available: Result = { outcome: "available", pullRequest };
function mount(environmentId: string | null | undefined, result: Result | (() => Promise<Record<string, Result>>) = available, copies = 1) {
  const handler = vi.fn(typeof result === "function" ? result : async ({ keys }: { keys: string[] }) =>
    Object.fromEntries(keys.map(key => [key, result])));
  const slot = renderSlot<ViewProps, typeof pullRequestContract>({ component: View }, { environmentId, copies }, {
    experimental_rpcContract: pullRequestContract, rpc: { pullRequests: handler },
  });
  return { slot, handler };
}

describe("environment-keyed pull requests", () => {
  it("reads the provider's current fields with an environment key, not a thread id", async () => {
    const { slot, handler } = mount("e");
    expect(await screen.findByText("#12 open passing approved")).toBeTruthy();
    expect(handler).toHaveBeenCalledWith({ keys: ["e"] });
    expect(slot.rpcCalls).toContainEqual(expect.objectContaining({ method: "pullRequests", input: { keys: ["e"] } }));
  });

  it.each([null, undefined, ""])("does not call the provider without an environment (%s)", async environmentId => {
    const { handler } = mount(environmentId);
    await waitFor(() => expect(screen.getByText("No PR data")).toBeTruthy());
    expect(handler).not.toHaveBeenCalled();
  });

  it.each<Result>([{ outcome: "absent" }, { outcome: "unavailable", message: "Provider offline" }])(
    "renders no badge for $outcome", async result => {
      const { handler } = mount("e", result);
      await waitFor(() => expect(handler).toHaveBeenCalledOnce());
      expect(screen.getByText("No PR data")).toBeTruthy();
    });

  it("survives a missing or disabled plugin", async () => {
    const { slot } = mount("e", async () => { throw new Error("Plugin is disabled"); });
    await waitFor(() => expect(slot.rpcCalls).toHaveLength(1));
    expect(screen.getByText("No PR data")).toBeTruthy();
  });

  it("shares a read between consumers in the same environment", async () => {
    const { handler } = mount("e", available, 2);
    await waitFor(() => expect(screen.getAllByText("#12 open passing approved")).toHaveLength(2));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("refreshes on the provider's environment tag and hides previously loaded data after failure", async () => {
    let failed = false;
    const { slot } = mount("e", async () => {
      if (failed) throw new Error("Provider disabled");
      return { e: available };
    });
    expect(await screen.findByText("#12 open passing approved")).toBeTruthy();
    failed = true;
    await slot.behavior.experimental_invalidateRpc(["environment:e"], "bb--github-pr-status");
    await waitFor(() => expect(screen.getByText("No PR data")).toBeTruthy());
    expect(slot.rpcCalls).toHaveLength(2);
  });

  it("does not show the previous environment's PR after an environment change", async () => {
    const { slot } = mount("e", async () => ({ e: available }));
    expect(await screen.findByText("#12 open passing approved")).toBeTruthy();
    slot.rerender(<View environmentId="other" />);
    expect(screen.getByText("No PR data")).toBeTruthy();
    slot.rerender(<View environmentId={null} />);
    expect(screen.getByText("No PR data")).toBeTruthy();
  });

  it("accepts the provider's additional fields without depending on them", () => {
    const output = pullRequestContract.pullRequests.output.parse({ e: { ...available,
      pullRequest: { ...pullRequest, autoMerge: false, attention: "ready_to_merge", checks: { ...pullRequest.checks, totalCount: 5 } } } });
    expect(output.e).toEqual(available);
  });
});
