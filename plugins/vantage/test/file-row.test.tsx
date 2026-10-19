import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PatchRequest } from "../src/contract";
import { FileRow, clearFileCache, fileKey, fileTarget, type FileRowProps } from "../src/file-row";
import { fileChange } from "./fixtures";

type Slot = ReturnType<typeof renderSlot>;

const mounts: Slot[] = [];
afterEach(() => {
  for (const slot of mounts.splice(0)) slot.lifecycle.unmount();
  clearFileCache();
  document.body.replaceChildren();
});

const REPO = { key: "host_1:/work/one", ref: { kind: "workspace", environmentId: "env_1", base: "origin/main" } } as const;

function mount(props: Partial<FileRowProps> = {}) {
  const patch = vi.fn(async (input: PatchRequest) => ({ patch: `+patch ${input.scope} ${input.sha ?? "-"}`, truncated: false, binary: false }));
  const loaders = { patch, recordedEdits: vi.fn(async () => ({ edits: [] })) };
  const row = (extra: Partial<FileRowProps> = {}) => (
    <FileRow repo={REPO} file={fileChange({ path: "src/a.ts" })} scope="uncommitted" threads={new Map()} expanded onToggle={() => {}}
      loaders={loaders} {...props} {...extra} />
  );
  const slot = renderSlot({ component: () => row() }, {}, {});
  mounts.push(slot);
  return { slot, patch };
}

describe("fileKey", () => {
  it("keeps the key of a row without a sha as it was, and adds the sha when there is one", () => {
    expect(fileKey(REPO, "a.ts", "uncommitted")).toBe("host_1:/work/one\0a.ts\0uncommitted");
    expect(fileKey(REPO, "a.ts", "committed", null)).toBe("host_1:/work/one\0a.ts\0committed");
    expect(fileKey(REPO, "a.ts", "committed", "abc1234")).toBe("host_1:/work/one\0a.ts\0committed\0abc1234");
    expect(fileKey(REPO, "a.ts", "committed", "abc1234")).not.toBe(fileKey(REPO, "a.ts", "committed", "def5678"));
  });
});

describe("fileTarget", () => {
  it("opens a workspace file through bb, and the file of a workspace read with git by its path from the repository root", () => {
    expect(fileTarget(REPO, fileChange({ path: "src/a.ts" }))).toEqual({ kind: "workspace", environmentId: "env_1", path: "src/a.ts" });
    const sub = { key: "host_1:/repos/mono", ref: { kind: "workspace", environmentId: "env_sub", base: "origin/main", root: "/repos/mono", hostId: "host_1" } } as const;
    expect(fileTarget(sub, fileChange({ path: "services/api/a.rb" }))).toEqual({ kind: "host", hostId: "host_1", path: "/repos/mono/services/api/a.rb" });
  });
});

describe("FileRow patch", () => {
  it("asks for the patch of the row's scope, with no sha, exactly as before", async () => {
    const { slot, patch } = mount({ scope: "branch" });
    await slot.findByText("+patch branch -");
    expect(patch.mock.calls[0]?.[0]).toEqual({
      ref: REPO.ref, path: "src/a.ts", previousPath: null, untracked: false, scope: "branch",
    });
  });

  it("asks for the committed patch, or for one commit's patch, when told to", async () => {
    const committed = mount({ patchScope: "committed" });
    await committed.slot.findByText("+patch committed -");
    expect(committed.patch.mock.calls[0]?.[0]).toMatchObject({ scope: "committed" });
    committed.slot.lifecycle.unmount();
    const one = mount({ patchScope: "committed", sha: "abc1234" });
    await one.slot.findByText("+patch committed abc1234");
    expect(one.patch.mock.calls[0]?.[0]).toEqual({
      ref: REPO.ref, path: "src/a.ts", previousPath: null, untracked: false, scope: "committed", sha: "abc1234",
    });
  });

  it("loads the same file's patch again for another commit instead of reusing the first", async () => {
    const first = mount({ patchScope: "committed", sha: "abc1234" });
    await first.slot.findByText("+patch committed abc1234");
    const second = mount({ patchScope: "committed", sha: "def5678" });
    await second.slot.findByText("+patch committed def5678");
    expect(second.patch).toHaveBeenCalledTimes(1);
  });
});

describe("FileRow shared badge", () => {
  it("names the other worktrees that changed the file, in the warning colour", async () => {
    const { slot } = mount({ expanded: false, sharedWith: ["Child A", "Child B"] });
    const badge = await waitFor(() => slot.getByText("also in Child A, Child B"));
    expect(badge.closest("[class*='text-warning-text']")).not.toBeNull();
    expect(slot.container.querySelector("[data-icon='AlertTriangle']")).not.toBeNull();
  });

  it("shows no badge when nothing is shared", async () => {
    for (const sharedWith of [undefined, null, []] as const) {
      const { slot } = mount({ expanded: false, sharedWith });
      await waitFor(() => slot.getByText("a.ts"));
      expect(slot.container.textContent).not.toContain("also in");
      slot.lifecycle.unmount();
    }
  });
});
