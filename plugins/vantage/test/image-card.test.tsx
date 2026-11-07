import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { FileCard, type FileCardProps, type FileLoaders } from "../src/file-card";
import { clearLoadedCache } from "../src/loaded";
import type { FileChange } from "../src/contract";

// A one-pixel PNG as base64, the way the host sends a side.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const fileChange = (overrides: Partial<FileChange> = {}): FileChange => ({
  path: "shots/after.png", previousPath: null, status: "modified", additions: null, deletions: null,
  binary: true, untracked: false, tooLarge: false, edits: null, ...overrides,
});

const repo = { key: "k", ref: { kind: "checkout" as const, hostId: "host_1", root: "/repo", base: "origin/main" } };

const mounts: Array<ReturnType<typeof renderSlot>> = [];
afterEach(() => {
  for (const slot of mounts.splice(0)) slot.lifecycle.unmount();
  clearLoadedCache();
});

const mount = (file: FileChange, overrides: Partial<FileCardProps> = {}, imageOutput?: { old: string | null; new: string | null; truncated: boolean }) => {
  const mock = vi.fn(async () => imageOutput ?? { old: PNG, new: null, truncated: false });
  const loaders: FileLoaders = {
    patch: vi.fn(async () => ({ patch: "", truncated: false, binary: true })),
    fileSides: vi.fn(async () => ({ old: null, new: null })),
    image: mock,
    recordedEdits: vi.fn(async () => ({ edits: [] })),
  };
  const props: FileCardProps = {
    repo, file, scope: "uncommitted", sha: null, cardKey: "c1", folded: false, onFold: () => {},
    view: "unified", threads: new Map(), loaders, ...overrides,
  };
  const slot = renderSlot({ component: (passed) => <FileCard {...passed} /> }, props);
  mounts.push(slot);
  return { view: slot, mock };
};

describe("the image card", () => {
  it("renders a changed image as a picture instead of a diff", async () => {
    const { view, mock } = mount(fileChange());
    await waitFor(() => expect(view.container.querySelector("img")).not.toBeNull());
    expect(mock).toHaveBeenCalledWith(expect.objectContaining({ path: "shots/after.png", scope: "uncommitted" }));
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(`data:image/png;base64,${PNG}`);
    expect(screen.queryByText("Binary file")).toBeNull();
  });

  it("labels the two sides of a modified image Before and After", async () => {
    const { view } = mount(fileChange(), {}, { old: PNG, new: PNG, truncated: false });
    await waitFor(() => expect(view.container.querySelectorAll("img")).toHaveLength(2));
    expect(screen.getByText("Before")).not.toBeNull();
    expect(screen.getByText("After")).not.toBeNull();
  });

  it("says when a side was too large to send", async () => {
    const { view } = mount(fileChange(), {}, { old: null, new: null, truncated: true });
    await waitFor(() => expect(screen.getByText("The image is too large to show here.")).not.toBeNull());
    expect(view.container.querySelector("img")).toBeNull();
  });

  it("shows a non-image binary file as text, as before", () => {
    mount(fileChange({ path: "assets/clip.bin" }));
    expect(screen.getByText("Binary file")).not.toBeNull();
  });

  it("still refuses a too-large file before asking for anything", () => {
    const { mock } = mount(fileChange({ tooLarge: true }));
    expect(screen.getByText("Too large to show here")).not.toBeNull();
    expect(mock).not.toHaveBeenCalled();
  });

  it("opens the picture full size when clicked", async () => {
    const { view } = mount(fileChange());
    await waitFor(() => expect(view.container.querySelector("img")).not.toBeNull());
    view.getByTitle("View the image full size").click();
    await waitFor(() => expect(view.container.querySelectorAll("img")).toHaveLength(2));
  });
});
