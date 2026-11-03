import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { gitStatusContract, resetGitStatus, useGitStatus, type GitStatus } from "../src/git-status";

const available: GitStatus = { outcome: "available", workspace: {
  workingTree: { insertions: 1, deletions: 0, fileCount: 1 },
  mergeBase: { insertions: 9, deletions: 2, fileCount: 3, aheadCount: 1, behindCount: 0, mergeBaseBranch: "origin/main" },
} };

function View({ environmentId }: { environmentId: string | null }) {
  const status = useGitStatus(environmentId);
  return <output>{status === null ? "none" : status.status === "ready" ? `ready ${status.value.outcome}` : status.status}</output>;
}

function mount(environmentId: string | null, handler: (input: { keys: string[] }) => Promise<Record<string, GitStatus>>) {
  const status = vi.fn(handler);
  const slot = renderSlot<{ environmentId: string | null }, typeof gitStatusContract>({ component: View }, { environmentId }, {
    experimental_rpcContract: gitStatusContract, rpc: { status },
  });
  return { slot, status };
}
const rows = (row: GitStatus) => async ({ keys }: { keys: string[] }) => Object.fromEntries(keys.map((key) => [key, row]));

afterEach(() => { cleanup(); resetGitStatus(); vi.useRealTimers(); });

describe("git status from bb's Git plugin", () => {
  it("waits 250 ms, then reads the environment's keyed status", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { slot, status } = mount("e", rows(available));
    expect(screen.getByRole("status").textContent).toBe("loading");
    await act(async () => { vi.advanceTimersByTime(249); });
    expect(status).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("ready available"));
    expect(slot.inspection.rpcCalls).toContainEqual(expect.objectContaining({ method: "status", input: { keys: ["e"] } }));
  });

  it("reads an environment it has already read without waiting again", async () => {
    const first = mount("e", rows(available));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("ready available"));
    first.slot.unmount();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const second = mount("e", rows(available));
    await act(async () => { await Promise.resolve(); });
    expect(second.status).toHaveBeenCalled();
  });

  it("marks a failed row and a failed read unavailable", async () => {
    const failed = mount("e", rows({ outcome: "failed", message: "git crashed" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("error"));
    failed.slot.unmount();
    resetGitStatus();
    mount("e", async () => { throw new Error("bb--git is disabled"); });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("error"));
  });

  it("reads nothing for a thread without an environment", async () => {
    const { status } = mount(null, rows(available));
    expect(screen.getByRole("status").textContent).toBe("none");
    await new Promise((done) => setTimeout(done, 300));
    expect(status).not.toHaveBeenCalled();
  });
});
